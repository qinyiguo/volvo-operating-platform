const router = require('express').Router();
const pool   = require('../db/pool');

// ── 預設產能利用率 ──
const DEFAULT_RATES = {
  engine: {
    '領班':   0,    '副領班': 0.5,
    'L4技師': 0.8,  'L3技師': 0.8,
    'L2技師': 0.7,  'L1技師': 0.5,
    'L0技師': 0.2,  '實習生': 0.1,
    'default': 0.8,
  },
  bodywork: {
    '領班':   1.0,  '副領班': 1.0,
    'L4技師': 1.8,  'L3技師': 1.8,
    'L2技師': 1.5,  'L1技師': 1.2,
    'L0技師': 0.8,  '實習生': 0.5,
    'default': 1.0,
  },
  paint: {
    '領班':   1.0,  '副領班': 1.0,
    'L4技師': 1.8,  'L3技師': 1.8,
    'L2技師': 1.5,  'L1技師': 1.2,
    'L0技師': 0.8,  '實習生': 0.5,
    'default': 1.0,
  },
};

const DEPT_PATTERNS = {
  engine:   ['引擎'],
  bodywork: ['鈑金'],
  paint:    ['烤漆', '噴漆'],
};

const DEPT_LABELS = { engine:'引擎維護', bodywork:'鈑金', paint:'烤漆' };

function detectDeptType(deptName) {
  for (const [type, patterns] of Object.entries(DEPT_PATTERNS)) {
    if (patterns.some(p => (deptName || '').includes(p))) return type;
  }
  return null;
}

async function getConfig() {
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key='tech_capacity_config'`);
    if (r.rows.length && r.rows[0].value) return JSON.parse(r.rows[0].value);
  } catch(e) {}
  return { utilization_rates: DEFAULT_RATES };
}

// ══════════════════════════════════════════════
// 姓名模糊比對：tech_name_clean 可能是「吳開健-KCW」「林新祐/張○○」等
// 名冊的 emp_name 是「吳開健」「林新祐」
// 規則：取 tech_name_clean 以「-/、,，空格」分割後的第一段，
//        若 emp_name 與任一段完全相符 → 匹配
// ══════════════════════════════════════════════
function splitTechName(rawName) {
  if (!rawName) return [];
  return rawName
    .split(/[-\/、,，\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function buildActualMap(rows) {
  // key: 每個分割後的名字片段 → 累加工時
  // 同時也保留原始 key
  const map = {};
  rows.forEach(r => {
    const name = (r.tech_name_clean || '').trim();
    const hours = parseFloat(r.actual_hours || 0);
    if (!name) return;
    // 原始 key
    map[name] = (map[name] || 0) + hours;
    // 分割後各片段
    splitTechName(name).forEach(seg => {
      if (seg && seg !== name) {
        map[seg] = (map[seg] || 0) + hours;
      }
    });
  });
  return map;
}

function findActualHours(empName, actualMap) {
  if (!empName) return 0;
  const name = empName.trim();
  // 1. 精確匹配
  if (actualMap[name] !== undefined) return actualMap[name];
  // 2. actualMap 的 key 包含 empName（如 key="吳開健-KCW" ⊇ empName="吳開健"）
  for (const [key, val] of Object.entries(actualMap)) {
    if (key.includes(name)) return val;
  }
  // 3. empName 包含某個 key（反向）
  for (const [key, val] of Object.entries(actualMap)) {
    if (key.length >= 2 && name.includes(key)) return val;
  }
  return 0;
}

// ══════════════════════════════════════════════
// GET /api/stats/tech-hours
// ══════════════════════════════════════════════
router.get('/stats/tech-hours', async (req, res) => {
  const { period, branch } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });

  try {
    const config = await getConfig();
    const rates  = config.utilization_rates || DEFAULT_RATES;

    // 最新名冊期間
    const rosterPeriodRes = await pool.query(
      `SELECT DISTINCT period FROM staff_roster ORDER BY period DESC LIMIT 1`
    );
    const rosterPeriod = rosterPeriodRes.rows[0]?.period;
    if (!rosterPeriod) return res.json({ branches: {}, rosterPeriod: null });

    const BRANCHES = branch && ['AMA','AMC','AMD'].includes(branch)
      ? [branch] : ['AMA','AMC','AMD'];

    const result = {};

    for (const br of BRANCHES) {
      // 1. 工作天數
      let workingDays = 0;
      const wdRes = await pool.query(
        `SELECT work_dates FROM working_days_config WHERE branch=$1 AND period=$2`,
        [br, period]
      );
      if (wdRes.rows[0]?.work_dates?.length) {
        workingDays = wdRes.rows[0].work_dates.length;
      } else {
        const autoWd = await pool.query(
          `SELECT COUNT(DISTINCT open_time::date) AS cnt
           FROM business_query WHERE period=$1 AND branch=$2 AND open_time IS NOT NULL`,
          [period, br]
        );
        workingDays = parseInt(autoWd.rows[0]?.cnt || 0);
      }

      // 2. 技師名單（依部門名稱判斷類型）
      //    納入條件：在職 OR 留職停薪 OR 當月離職（resign_date >= 該月1日）
      //    這樣 3月中離職的技師，3月報表仍會顯示其目標與實績
      const periodStart = `${period.slice(0,4)}-${period.slice(4,6)}-01`;
      const rosterRes = await pool.query(
        `SELECT emp_id, emp_name, job_title, dept_code, dept_name, factory,
                status, resign_date
         FROM staff_roster
         WHERE period=$1
           AND (factory=$2 OR (factory IS NULL AND dept_name ILIKE $3))
           AND COALESCE(job_category,'') NOT ILIKE '%計時%'
           AND (
             status = '在職'
             OR status = '留職停薪'
             OR (
               status = '離職'
               AND resign_date IS NOT NULL
               AND resign_date >= $4::date
             )
           )
         ORDER BY dept_code,
           CASE status WHEN '在職' THEN 0 WHEN '留職停薪' THEN 1 ELSE 2 END,
           emp_id`,
        [rosterPeriod, br, `%${br}%`, periodStart]
      );

      // 按 deptType 分組
      const deptTypeMap = {};
      rosterRes.rows.forEach(r => {
        const dt = detectDeptType(r.dept_name);
        if (!dt) return;
        if (!deptTypeMap[dt]) deptTypeMap[dt] = [];
        deptTypeMap[dt].push(r);
      });

      // 3. 實際工時 — 從 tech_performance.standard_hours 抓，依 branch + period
      //    tech_name_clean 可能含後綴（-KCW 等），用 buildActualMap 處理
      const actualRes = await pool.query(
        `SELECT tech_name_clean,
                SUM(standard_hours) AS actual_hours
         FROM tech_performance
         WHERE period=$1 AND branch=$2
         GROUP BY tech_name_clean`,
        [period, br]
      );
      const actualMap = buildActualMap(actualRes.rows);

      // 4. 組合結果
      const branchResult = { working_days: workingDays, dept_types: {} };

      for (const [deptType, techs] of Object.entries(deptTypeMap)) {
        const typeRates = rates[deptType] || {};
        branchResult.dept_types[deptType] = {
          label: DEPT_LABELS[deptType] || deptType,
          techs: techs.map(t => {
            const rate = typeRates[t.job_title] !== undefined
              ? typeRates[t.job_title] : (typeRates.default ?? 1.0);
            const targetHours = Math.round(workingDays * 8 * rate * 10) / 10;
            const actualHours = findActualHours(t.emp_name, actualMap);
            const achieveRate = targetHours > 0
              ? Math.round(actualHours / targetHours * 1000) / 10 : null;
            return {
              emp_name:     t.emp_name,
              job_title:    t.job_title || '—',
              dept_name:    t.dept_name,
              status:       t.status || '在職',
              resign_date:  t.resign_date ? t.resign_date.toISOString().slice(0,10) : null,
              utilization:  rate,
              target_hours: targetHours,
              actual_hours: Math.round(actualHours * 10) / 10,
              achieve_rate: achieveRate,
            };
          }),
        };
      }

      result[br] = branchResult;
    }

    res.json({ branches: result, rosterPeriod });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// GET /api/tech-capacity-config  — 取得產能設定
// PUT /api/tech-capacity-config  — 儲存產能設定
// GET /api/tech-capacity-config/default — 取得預設值（供前端 reset 用）
// ══════════════════════════════════════════════
router.get('/tech-capacity-config/default', (req, res) => {
  res.json({ utilization_rates: DEFAULT_RATES });
});

router.get('/tech-capacity-config', async (req, res) => {
  try { res.json(await getConfig()); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/tech-capacity-config', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('tech_capacity_config', $1)
       ON CONFLICT (key) DO UPDATE SET value=$1`,
      [JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
