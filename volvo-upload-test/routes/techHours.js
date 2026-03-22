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

// ── GET /api/stats/tech-hours ──
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
        // 從 business_query 自動偵測
        const autoWd = await pool.query(
          `SELECT COUNT(DISTINCT open_time::date) AS cnt
           FROM business_query WHERE period=$1 AND branch=$2 AND open_time IS NOT NULL`,
          [period, br]
        );
        workingDays = parseInt(autoWd.rows[0]?.cnt || 0);
      }

      // 2. 技師名單（依部門名稱判斷類型）
      const rosterRes = await pool.query(
        `SELECT emp_id, emp_name, job_title, dept_code, dept_name, factory
         FROM staff_roster
         WHERE period=$1 AND (factory=$2 OR (factory IS NULL AND dept_name ILIKE $3))
           AND status='在職'
           AND COALESCE(job_category,'') NOT ILIKE '%計時%'
         ORDER BY dept_code, emp_id`,
        [rosterPeriod, br, `%${br}%`]
      );

      // 按 deptType 分組
      const deptTypeMap = {};
      rosterRes.rows.forEach(r => {
        const dt = detectDeptType(r.dept_name);
        if (!dt) return;
        if (!deptTypeMap[dt]) deptTypeMap[dt] = [];
        deptTypeMap[dt].push(r);
      });

      // 3. 實際工時
      const actualRes = await pool.query(
        `SELECT tech_name_clean, SUM(standard_hours) AS actual_hours
         FROM tech_performance WHERE period=$1 AND branch=$2
         GROUP BY tech_name_clean`,
        [period, br]
      );
      const actualMap = {};
      actualRes.rows.forEach(r => {
        actualMap[r.tech_name_clean] = parseFloat(r.actual_hours || 0);
      });

      // 4. 組合結果
      const branchResult = { working_days: workingDays, dept_types: {} };

      for (const [deptType, techs] of Object.entries(deptTypeMap)) {
        const typeRates = rates[deptType] || {};
        branchResult.dept_types[deptType] = {
          label: DEPT_LABELS[deptType] || deptType,
          techs: techs.map(t => {
            const rate = typeRates[t.job_title] !== undefined
              ? typeRates[t.job_title] : (typeRates.default || 1.0);
            const targetHours = Math.round(workingDays * 8 * rate * 10) / 10;
            const actualHours = actualMap[t.emp_name] || 0;
            const achieveRate = targetHours > 0
              ? Math.round(actualHours / targetHours * 1000) / 10 : null;
            return {
              emp_name:     t.emp_name,
              job_title:    t.job_title || '—',
              dept_name:    t.dept_name,
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

// ── GET/PUT /api/tech-capacity-config ──
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
