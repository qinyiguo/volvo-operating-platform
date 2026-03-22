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
  beauty: {
    '美容技師': 1.0,
    '領班':     0,
    'default':  1.0,
  },
};

const DEFAULT_CONFIG = {
  utilization_rates:     DEFAULT_RATES,
  resigned_count_target: false,
  hourly_rate:           2150,   // ← 每小時工資（元），用於 wage 回推工時
};

// ── 部門偵測：dept_name 含關鍵字 → dept type ──
const DEPT_PATTERNS = {
  engine:   ['引擎'],
  bodywork: ['鈑金'],
  paint:    ['烤漆', '噴漆'],
  beauty:   ['美容'],
};
const DEPT_LABELS = {
  engine:   '引擎維護科',
  bodywork: '鈑金科',
  paint:    '烤漆科',
  beauty:   '美容部',
};

const ALL_FACTORIES  = ['AMA', 'AMC', 'AMD', '聯合', '鈑烤'];
const STD_BRANCHES   = new Set(['AMA', 'AMC', 'AMD']);
const BEAUTY_FACTORY = '聯合';
const AMAB_FACTORY   = '鈑烤';
const AMAB_NAMES     = ['AMAB', 'AMAE', 'AMAP'];

// ── 用 wage 反推回推工時的 SQL 表達式（需帶入時薪）──
// 邏輯：先把折扣還原得到「滿額工資」，再除以時薪得到工時
//   discount < 1    → 小數格式（0.93）
//   discount 1~100  → 百分比格式（93.xx）
//   其餘（無折扣）  → 直接用 wage / hourly_rate
function buildRestoreExpr(hourlyRate) {
  return `
    CASE
      WHEN discount IS NOT NULL AND discount > 0 AND discount < 1
        THEN (wage / NULLIF(discount, 0)) / ${hourlyRate}
      WHEN discount IS NOT NULL AND discount >= 1 AND discount < 100
        THEN (wage / NULLIF(discount / 100.0, 0)) / ${hourlyRate}
      ELSE wage / ${hourlyRate}
    END
  `;
}

// 是否有折扣（用於查核 modal 標記）
const WAS_DISCOUNTED_EXPR = `
  CASE
    WHEN (discount IS NOT NULL AND discount > 0 AND discount < 1)
      OR  (discount IS NOT NULL AND discount >= 1 AND discount < 100)
      THEN true
    ELSE false
  END
`;

function detectDeptType(deptName) {
  if (!deptName) return null;
  for (const [type, patterns] of Object.entries(DEPT_PATTERNS)) {
    if (patterns.some(p => deptName.includes(p))) return type;
  }
  return null;
}

async function getConfig() {
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key='tech_capacity_config'`);
    if (r.rows.length && r.rows[0].value) {
      const saved = JSON.parse(r.rows[0].value);
      // 補上新欄位 hourly_rate 的預設值（舊版設定升級相容）
      return { ...DEFAULT_CONFIG, ...saved };
    }
  } catch(e) {}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function splitTechName(rawName) {
  if (!rawName) return [];
  return rawName.split(/[-\/、,，\s]+/).map(s => s.trim()).filter(Boolean);
}

function buildActualMap(rows) {
  const map = {};
  rows.forEach(r => {
    const name  = (r.tech_name_clean || '').trim();
    const hours = parseFloat(r.actual_hours || 0);
    if (!name) return;
    if (!map[name]) map[name] = { hours: 0, rawName: name };
    map[name].hours += hours;
    splitTechName(name).forEach(seg => {
      if (seg && seg !== name) {
        if (!map[seg]) map[seg] = { hours: 0, rawName: name };
        map[seg].hours += hours;
      }
    });
  });
  return map;
}

function findActualHours(empName, actualMap, matchedSet) {
  if (!empName) return 0;
  const name = empName.trim();
  if (actualMap[name] !== undefined) { matchedSet.add(actualMap[name].rawName); return actualMap[name].hours; }
  for (const [key, val] of Object.entries(actualMap)) {
    if (key.includes(name)) { matchedSet.add(val.rawName); return val.hours; }
  }
  for (const [key, val] of Object.entries(actualMap)) {
    if (key.length >= 2 && name.includes(key)) { matchedSet.add(val.rawName); return val.hours; }
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
    const config              = await getConfig();
    const rates               = config.utilization_rates    || DEFAULT_RATES;
    const resignedCountTarget = config.resigned_count_target === true;
    const hourlyRate          = parseFloat(config.hourly_rate) || 2150;

    const RESTORE_HOURS_EXPR = buildRestoreExpr(hourlyRate);

    const rosterPeriodRes = await pool.query(
      `SELECT DISTINCT period FROM staff_roster ORDER BY period DESC LIMIT 1`
    );
    const rosterPeriod = rosterPeriodRes.rows[0]?.period;
    if (!rosterPeriod) return res.json({ branches: {}, rosterPeriod: null });

    const BRANCHES = branch && ALL_FACTORIES.includes(branch)
      ? [branch]
      : ALL_FACTORIES;

    // ── 美容 DMS 工時（不限 branch）──
    const beautyDmsRes = await pool.query(
      `SELECT tech_name_clean,
              SUM(${RESTORE_HOURS_EXPR}) AS actual_hours
       FROM tech_performance
       WHERE period=$1 AND tech_name_clean ~ '美容'
       GROUP BY tech_name_clean`,
      [period]
    );
    const beautyDmsMap = {};
    beautyDmsRes.rows.forEach(r => {
      beautyDmsMap[r.tech_name_clean] = Math.round(parseFloat(r.actual_hours || 0) * 10) / 10;
    });

    // ── AMAB/AMAE/AMAP DMS 工時（不限 branch）──
    const amabDmsRes = await pool.query(
      `SELECT tech_name_clean,
              SUM(${RESTORE_HOURS_EXPR}) AS actual_hours
       FROM tech_performance
       WHERE period=$1 AND tech_name_clean = ANY($2)
       GROUP BY tech_name_clean`,
      [period, AMAB_NAMES]
    );
    const amabDmsMap = {};
    amabDmsRes.rows.forEach(r => {
      amabDmsMap[r.tech_name_clean] = Math.round(parseFloat(r.actual_hours || 0) * 10) / 10;
    });

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
      } else if (STD_BRANCHES.has(br)) {
        const r2 = await pool.query(
          `SELECT COUNT(DISTINCT open_time::date) AS cnt
           FROM business_query WHERE period=$1 AND branch=$2 AND open_time IS NOT NULL`,
          [period, br]
        );
        workingDays = parseInt(r2.rows[0]?.cnt || 0);
      } else {
        const r2 = await pool.query(
          `SELECT COUNT(DISTINCT dispatch_date) AS cnt
           FROM tech_performance WHERE period=$1 AND branch=$2 AND dispatch_date IS NOT NULL`,
          [period, br]
        );
        workingDays = parseInt(r2.rows[0]?.cnt || 0);
        if (!workingDays) {
          const r3 = await pool.query(
            `SELECT MAX(cnt) AS cnt FROM (
               SELECT COUNT(DISTINCT open_time::date) AS cnt
               FROM business_query WHERE period=$1 AND open_time IS NOT NULL
               GROUP BY branch
             ) sub`,
            [period]
          );
          workingDays = parseInt(r3.rows[0]?.cnt || 0);
        }
      }

      // 2. 名冊查詢
      const periodStart = `${period.slice(0,4)}-${period.slice(4,6)}-01`;
      let rosterRows;
      if (STD_BRANCHES.has(br)) {
        const r2 = await pool.query(
          `SELECT emp_id, emp_name, job_title, dept_code, dept_name, factory, status, resign_date
           FROM staff_roster
           WHERE period=$1
             AND (factory=$2 OR (factory IS NULL AND dept_name ILIKE $3))
             AND COALESCE(job_category,'') NOT ILIKE '%計時%'
             AND (status='在職' OR status='留職停薪'
                  OR (status='離職' AND resign_date IS NOT NULL AND resign_date >= $4::date))
           ORDER BY dept_code, CASE status WHEN '在職' THEN 0 WHEN '留職停薪' THEN 1 ELSE 2 END, emp_id`,
          [rosterPeriod, br, `%${br}%`, periodStart]
        );
        rosterRows = r2.rows;
      } else {
        const r2 = await pool.query(
          `SELECT emp_id, emp_name, job_title, dept_code, dept_name, factory, status, resign_date
           FROM staff_roster
           WHERE period=$1
             AND factory=$2
             AND COALESCE(job_category,'') NOT ILIKE '%計時%'
             AND (status='在職' OR status='留職停薪'
                  OR (status='離職' AND resign_date IS NOT NULL AND resign_date >= $3::date))
           ORDER BY dept_code, CASE status WHEN '在職' THEN 0 WHEN '留職停薪' THEN 1 ELSE 2 END, emp_id`,
          [rosterPeriod, br, periodStart]
        );
        rosterRows = r2.rows;
      }

      // 3. 依 dept_type 分組
      const deptTypeMap = {};
      rosterRows.forEach(r => {
        const dt = detectDeptType(r.dept_name);
        if (!dt) return;
        if (!deptTypeMap[dt]) deptTypeMap[dt] = [];
        deptTypeMap[dt].push(r);
      });

      // 4. 實際工時（工資反推，折扣還原）
      let actualRes;
      if (STD_BRANCHES.has(br)) {
        actualRes = await pool.query(
          `SELECT tech_name_clean,
                  SUM(${RESTORE_HOURS_EXPR}) AS actual_hours
           FROM tech_performance
           WHERE period=$1 AND branch=$2
           GROUP BY tech_name_clean`,
          [period, br]
        );
      } else {
        actualRes = await pool.query(
          `SELECT tech_name_clean,
                  SUM(${RESTORE_HOURS_EXPR}) AS actual_hours
           FROM tech_performance
           WHERE period=$1
           GROUP BY tech_name_clean`,
          [period]
        );
      }
      const actualMap  = buildActualMap(actualRes.rows);
      const matchedSet = new Set();

      // 5. 組合名冊技師
      const branchResult = { working_days: workingDays, dept_types: {} };

      for (const [deptType, techs] of Object.entries(deptTypeMap)) {
        const typeRates = rates[deptType] || {};
        branchResult.dept_types[deptType] = {
          label: DEPT_LABELS[deptType] || deptType,
          techs: techs.map(t => {
            const rate          = typeRates[t.job_title] !== undefined ? typeRates[t.job_title] : (typeRates.default ?? 1.0);
            const isResigned    = t.status === '離職';
            const effectiveRate = (isResigned && !resignedCountTarget) ? 0 : rate;
            const targetHours   = Math.round(workingDays * 8 * effectiveRate * 10) / 10;
            const actualHours   = findActualHours(t.emp_name, actualMap, matchedSet);
            const achieveRate   = targetHours > 0 ? Math.round(actualHours / targetHours * 1000) / 10 : null;
            return {
              emp_name:        t.emp_name,
              job_title:       t.job_title || '—',
              dept_name:       t.dept_name,
              status:          t.status || '在職',
              resign_date:     t.resign_date ? t.resign_date.toISOString().slice(0,10) : null,
              utilization:     rate,
              target_hours:    targetHours,
              actual_hours:    Math.round(actualHours * 10) / 10,
              achieve_rate:    achieveRate,
              target_excluded: isResigned && !resignedCountTarget,
              is_dms_only:     false,
            };
          }),
        };
      }

      // 6. 美容 DMS → 聯合服務中心
      if (br === BEAUTY_FACTORY) {
        const beautyDmsEntries = Object.entries(beautyDmsMap)
          .filter(([name]) => !matchedSet.has(name))
          .map(([name, hours]) => ({
            emp_name:        name,
            job_title:       '（DMS 彙總）',
            dept_name:       '美容部',
            status:          '在職',
            resign_date:     null,
            utilization:     0,
            target_hours:    0,
            actual_hours:    hours,
            achieve_rate:    null,
            target_excluded: true,
            is_dms_only:     true,
          }))
          .filter(e => e.actual_hours > 0);

        if (beautyDmsEntries.length) {
          if (!branchResult.dept_types['beauty']) {
            branchResult.dept_types['beauty'] = { label: DEPT_LABELS['beauty'], techs: [] };
          }
          branchResult.dept_types['beauty'].techs.push(...beautyDmsEntries);
        }
      }

      // 7. AMAB/AMAE/AMAP DMS → 鈑烤廠
      if (br === AMAB_FACTORY) {
        const amabEntries = Object.entries(amabDmsMap)
          .map(([name, hours]) => ({
            emp_name:        name,
            job_title:       '（DMS 彙總）',
            dept_name:       '鈑烤維修',
            status:          '在職',
            resign_date:     null,
            utilization:     0,
            target_hours:    0,
            actual_hours:    hours,
            achieve_rate:    null,
            target_excluded: true,
            is_dms_only:     true,
          }))
          .filter(e => e.actual_hours > 0);

        if (amabEntries.length) {
          if (!branchResult.dept_types['bodywork']) {
            branchResult.dept_types['bodywork'] = { label: DEPT_LABELS['bodywork'], techs: [] };
          }
          branchResult.dept_types['bodywork'].techs.push(...amabEntries);
        }
      }

      result[br] = branchResult;
    }

    res.json({
      branches:              result,
      rosterPeriod,
      resigned_count_target: resignedCountTarget,
      hourly_rate:           hourlyRate,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// GET /api/stats/tech-hours-raw  — 折扣查核明細
// ══════════════════════════════════════════════
router.get('/stats/tech-hours-raw', async (req, res) => {
  const { period, branch, emp_name } = req.query;
  if (!period || !emp_name) {
    return res.status(400).json({ error: 'period / emp_name 為必填' });
  }
  try {
    const config     = await getConfig();
    const hourlyRate = parseFloat(config.hourly_rate) || 2150;
    const RESTORE_HOURS_EXPR = buildRestoreExpr(hourlyRate);

    const isBeautyDms = /美容/.test(emp_name);
    const isAmabDms   = AMAB_NAMES.includes(emp_name);
    let rawRes;

    if (isBeautyDms || isAmabDms) {
      rawRes = await pool.query(
        `SELECT branch, dispatch_date, work_order, work_code, task_content, account_type,
                discount, wage,
                wage                                            AS original_hours_wage,
                ROUND((${RESTORE_HOURS_EXPR})::numeric, 4)     AS restored_hours,
                (${WAS_DISCOUNTED_EXPR})                       AS was_discounted
         FROM tech_performance
         WHERE period=$1 AND tech_name_clean=$2
         ORDER BY branch, dispatch_date, work_order`,
        [period, emp_name]
      );
    } else {
      if (!branch) return res.status(400).json({ error: 'branch 為必填（非 DMS 彙總技師）' });
      const allRes = await pool.query(
        `SELECT DISTINCT tech_name_clean FROM tech_performance WHERE period=$1`,
        [period]
      );
      const matchedNames = allRes.rows
        .map(r => r.tech_name_clean)
        .filter(n => {
          if (!n) return false;
          const segs = n.split(/[-\/、,，\s]+/).map(s => s.trim()).filter(Boolean);
          return n.includes(emp_name) || segs.some(s => s === emp_name || emp_name.includes(s));
        });

      if (!matchedNames.length) return res.json({ emp_name, matched_names: [], rows: [], summary: null });

      rawRes = await pool.query(
        `SELECT dispatch_date, work_order, work_code, task_content, account_type,
                discount, wage,
                wage                                            AS original_hours_wage,
                ROUND((${RESTORE_HOURS_EXPR})::numeric, 4)     AS restored_hours,
                (${WAS_DISCOUNTED_EXPR})                       AS was_discounted
         FROM tech_performance
         WHERE period=$1 AND tech_name_clean = ANY($2)
         ORDER BY dispatch_date, work_order`,
        [period, matchedNames]
      );

      // 回填 matched_names
      res._matchedNames = matchedNames;
    }

    const rows    = rawRes.rows;
    const sumWage = rows.reduce((s, r) => s + parseFloat(r.wage || 0), 0);
    const sumRest = rows.reduce((s, r) => s + parseFloat(r.restored_hours || 0), 0);
    const sumOrigH = sumWage / hourlyRate;   // 未折扣還原的「原始工資折算工時」

    res.json({
      emp_name,
      matched_names: (isBeautyDms || isAmabDms) ? [emp_name] : (res._matchedNames || []),
      hourly_rate:   hourlyRate,
      rows,
      summary: {
        total_rows:         rows.length,
        discounted_rows:    rows.filter(r => r.was_discounted).length,
        sum_wage:           Math.round(sumWage),
        sum_original_hours: Math.round(sumOrigH * 100) / 100,   // wage/hourly_rate（未還原）
        sum_restored_hours: Math.round(sumRest * 100) / 100,    // 還原折扣後
        difference:         Math.round((sumRest - sumOrigH) * 100) / 100,
      },
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Config CRUD ──
router.get('/tech-capacity-config/default', (req, res) => {
  res.json(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
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
