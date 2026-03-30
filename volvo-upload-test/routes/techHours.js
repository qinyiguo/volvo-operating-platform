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
  hourly_rate:           2150,
  hourly_rates: {
    engine:   2150,
    bodywork: 1450,
    paint:    1450,
    beauty:   2150,
  },
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

// ────────────────────────────────────────────
// buildOriginalExpr   = wage / hourlyRate  (折扣後直接換算，未還原)
// buildRestoreExpr    = (wage/discount) / hourlyRate  (還原折扣後的真實工時)
// buildRestoreWageExpr = 只還原折扣，不除以時薪（讓 JS 端按科別各自除）
// ────────────────────────────────────────────
function buildOriginalExpr(hourlyRate) {
  return `ROUND((wage / ${hourlyRate})::numeric, 4)`;
}

function buildRestoreExpr(hourlyRate) {
  return `
    ROUND((
      CASE
        WHEN discount IS NOT NULL AND discount > 0 AND discount < 1
          THEN (wage / NULLIF(discount, 0)) / ${hourlyRate}
        WHEN discount IS NOT NULL AND discount >= 1 AND discount < 100
          THEN (wage / NULLIF(discount / 100.0, 0)) / ${hourlyRate}
        ELSE wage / ${hourlyRate}
      END
    )::numeric, 4)
  `;
}

// 只還原折扣 → 回傳還原後的工資（不除時薪），讓 JS 依科別各自換算工時
function buildRestoreWageExpr() {
  return `
    ROUND((
      CASE
        WHEN discount IS NOT NULL AND discount > 0 AND discount < 1
          THEN wage / NULLIF(discount, 0)
        WHEN discount IS NOT NULL AND discount >= 1 AND discount < 100
          THEN wage / NULLIF(discount / 100.0, 0)
        ELSE wage
      END
    )::numeric, 2)
  `;
}

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
      const merged = { ...DEFAULT_CONFIG, ...saved };
      // 升級舊設定：補充 hourly_rates
      if (!merged.hourly_rates) {
        const fallback = parseFloat(merged.hourly_rate) || 2150;
        merged.hourly_rates = {
          engine:   fallback,
          bodywork: 1450,
          paint:    1450,
          beauty:   fallback,
        };
      }
      return merged;
    }
  } catch(e) {}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function splitTechName(rawName) {
  if (!rawName) return [];
  return rawName.split(/[-\/、,，\s]+/).map(s => s.trim()).filter(Boolean);
}

// buildActualMap 現在儲存還原折扣後的工資（非工時），讓 findActualHours 按科別時薪換算
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

// hourlyRate 為科別對應的時薪，將工資換算為工時
function findActualHours(empName, actualMap, matchedSet) {
  if (!empName) return 0;
  const name = empName.trim();
  if (actualMap[name] !== undefined) { matchedSet.add(actualMap[name].rawName); return Math.round(actualMap[name].hours * 10) / 10; }
  for (const [key, val] of Object.entries(actualMap)) {
    if (key.includes(name)) { matchedSet.add(val.rawName); return Math.round(val.hours * 10) / 10; }
  }
  for (const [key, val] of Object.entries(actualMap)) {
    if (key.length >= 2 && name.includes(key)) { matchedSet.add(val.rawName); return Math.round(val.hours * 10) / 10; }
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
    const hourlyRates         = config.hourly_rates || { engine: hourlyRate, bodywork: 1450, paint: 1450, beauty: hourlyRate };
    const RESTORE_WAGE_EXPR   = buildRestoreWageExpr();

    const rosterPeriodRes = await pool.query(
      `SELECT DISTINCT period FROM staff_roster ORDER BY period DESC LIMIT 1`
    );
    const rosterPeriod = rosterPeriodRes.rows[0]?.period;
    if (!rosterPeriod) return res.json({ branches: {}, rosterPeriod: null });

    const BRANCHES = branch && ALL_FACTORIES.includes(branch)
      ? [branch]
      : ALL_FACTORIES;

    // ── 美容 DMS 工時（不限 branch）──
    const beautyRate    = parseFloat(hourlyRates.beauty || hourlyRate);
const beautyDmsRes  = await pool.query(
  `SELECT tech_name_clean,
          SUM(standard_hours) AS actual_hours
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
    const bodyworkRate  = parseFloat(hourlyRates.bodywork || hourlyRate);
const amabDmsRes    = await pool.query(
  `SELECT tech_name_clean,
          SUM(standard_hours) AS actual_hours
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

      // 4. 實際工時（工資反推，折扣還原 → 儲存還原後工資，JS 端按科別時薪換算）
      let actualRes;
      if (STD_BRANCHES.has(br)) {
        actualRes = await pool.query(
          `SELECT tech_name_clean,
SUM(standard_hours) AS actual_hours
           FROM tech_performance
           WHERE period=$1 AND branch=$2
           GROUP BY tech_name_clean`,
          [period, br]
        );
      } else {
        actualRes = await pool.query(
          `SELECT tech_name_clean,
SUM(standard_hours) AS actual_hours
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
        const typeRates      = rates[deptType] || {};
        const deptHourlyRate = parseFloat(hourlyRates[deptType] || hourlyRate);
        branchResult.dept_types[deptType] = {
          label:        DEPT_LABELS[deptType] || deptType,
          hourly_rate:  deptHourlyRate,
          techs: techs.map(t => {
            const rate          = typeRates[t.job_title] !== undefined ? typeRates[t.job_title] : (typeRates.default ?? 1.0);
            const isResigned    = t.status === '離職';
            const effectiveRate = (isResigned && !resignedCountTarget) ? 0 : rate;
            const targetHours   = Math.round(workingDays * 8 * effectiveRate * 10) / 10;
            const actualHours = findActualHours(t.emp_name, actualMap, matchedSet);
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
            branchResult.dept_types['beauty'] = { label: DEPT_LABELS['beauty'], hourly_rate: beautyRate, techs: [] };
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
            branchResult.dept_types['bodywork'] = { label: DEPT_LABELS['bodywork'], hourly_rate: bodyworkRate, techs: [] };
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
      hourly_rates:          hourlyRates,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// GET /api/stats/tech-hours-raw  — 折扣查核明細
// ══════════════════════════════════════════════
router.get('/stats/tech-hours-raw', async (req, res) => {
  const { period, branch, emp_name, dept_type } = req.query;
  if (!period || !emp_name) {
    return res.status(400).json({ error: 'period / emp_name 為必填' });
  }
  try {
    const config         = await getConfig();
    const hourlyRate     = parseFloat(config.hourly_rate) || 2150;
    const hourlyRates    = config.hourly_rates || { engine: hourlyRate, bodywork: 1450, paint: 1450, beauty: hourlyRate };
    // 依科別選取對應時薪
    const deptRate       = dept_type && hourlyRates[dept_type]
      ? parseFloat(hourlyRates[dept_type])
      : hourlyRate;
wage,
standard_hours        AS original_hours,
standard_hours        AS restored_hours,
(${WAS_DISCOUNTED_EXPR}) AS was_discounted
         FROM tech_performance
         WHERE period=$1 AND tech_name_clean=$2
         ORDER BY branch, dispatch_date, work_order`,
        [period, emp_name]
      );
    } else {
      if (!branch) return res.status(400).json({ error: 'branch 為必填' });

      const allRes = await pool.query(
        `SELECT DISTINCT tech_name_clean FROM tech_performance WHERE period=$1`,
        [period]
      );
      matchedNames = allRes.rows
        .map(r => r.tech_name_clean)
        .filter(n => {
          if (!n) return false;
          const segs = n.split(/[-\/、,，\s]+/).map(s => s.trim()).filter(Boolean);
          return n.includes(emp_name) || segs.some(s => s === emp_name || emp_name.includes(s));
        });

      if (!matchedNames.length) {
        return res.json({
          emp_name,
          matched_names:  [],
          rows:           [],
          summary:        null,
          hourly_rate:    deptRate,
          dept_type:      dept_type || null,
        });
      }

      rawRes = await pool.query(
        `SELECT
           dispatch_date,
           work_order,
           work_code,
           task_content,
           account_type,
           discount,
           wage,
           standard_hours        AS original_hours,
           standard_hours        AS restored_hours,
           (${WAS_DISCOUNTED_EXPR}) AS was_discounted
         FROM tech_performance
         WHERE period=$1 AND tech_name_clean = ANY($2)
         ORDER BY dispatch_date, work_order`,
        [period, matchedNames]
      );
    }

    const rows    = rawRes.rows;
    const sumOrig = rows.reduce((s, r) => s + parseFloat(r.original_hours || 0), 0);
    const sumRest = sumOrig;   // 直接用 standard_hours，無折扣差異
    const sumWage = rows.reduce((s, r) => s + parseFloat(r.wage            || 0), 0);

    res.json({
      emp_name,
      matched_names:  matchedNames,
      hourly_rate:    deptRate,
      dept_type:      dept_type || null,
      rows,
      summary: {
        total_rows:         rows.length,
        discounted_rows:    rows.filter(r => r.was_discounted).length,
        sum_wage:           Math.round(sumWage),
        sum_original_hours: Math.round(sumOrig * 100) / 100,
        sum_restored_hours: Math.round(sumRest * 100) / 100,
        difference:         Math.round((sumRest - sumOrig) * 100) / 100,
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

// ══════════════════════════════════════════════
// GET /api/stats/tech-turnover
// ══════════════════════════════════════════════

router.get('/stats/tech-turnover', async (req, res) => {
  const { period, branch } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const rosterRes = await pool.query(
      `SELECT DISTINCT period FROM staff_roster ORDER BY period DESC LIMIT 1`
    );
    const rosterPeriod = rosterRes.rows[0]?.period || null;
    const BRANCHES = branch && STD_BRANCHES.has(branch) ? [branch] : ['AMA','AMC','AMD'];

    const bayConfigRes = await pool.query(`SELECT value FROM app_settings WHERE key='service_bays'`);
    const bayConfig = bayConfigRes.rows[0] ? JSON.parse(bayConfigRes.rows[0].value) : {};
    const result = {};

    for (const br of BRANCHES) {
      let workingDays = 0;
      const wdRes = await pool.query(
        `SELECT work_dates FROM working_days_config WHERE branch=$1 AND period=$2`,
        [br, period]
      );
      if (wdRes.rows[0]?.work_dates?.length) {
        workingDays = wdRes.rows[0].work_dates.length;
      } else {
        const r = await pool.query(
          `SELECT COUNT(DISTINCT open_time::date) AS cnt
           FROM business_query WHERE period=$1 AND branch=$2 AND open_time IS NOT NULL`,
          [period, br]
        );
        workingDays = parseInt(r.rows[0]?.cnt || 0);
      }

      const nowTW = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const todayStr = nowTW.toISOString().slice(0, 10);
      const currentPeriod = `${nowTW.getFullYear()}${String(nowTW.getMonth()+1).padStart(2,'0')}`;
      const isCurrentMonth = period === currentPeriod;
      let elapsedDays = workingDays;

      if (isCurrentMonth) {
        const wdRow = await pool.query(
          `SELECT work_dates FROM working_days_config WHERE branch=$1 AND period=$2`,
          [br, period]
        );
        const configured = wdRow.rows[0]?.work_dates || null;
        if (configured && configured.length > 0) {
          elapsedDays = configured.filter(d => d <= todayStr).length;
        } else {
          const y = parseInt(period.slice(0, 4));
          const mo = parseInt(period.slice(4)) - 1;
          const monthStart = new Date(Date.UTC(y, mo, 1));
          const todayUTC = new Date(todayStr + 'T00:00:00Z');
          let cnt = 0;
          const d = new Date(monthStart);
          while (d <= todayUTC) {
            const dow = d.getUTCDay();
            if (dow !== 0 && dow !== 6) cnt++;
            d.setUTCDate(d.getUTCDate() + 1);
          }
          elapsedDays = cnt;
        }
      }

      let techNames = [];
      if (rosterPeriod) {
        const periodStart = `${period.slice(0,4)}-${period.slice(4,6)}-01`;
        const r = await pool.query(`
          SELECT emp_name, job_title, status FROM staff_roster
          WHERE period=$1 AND factory=$2
            AND dept_name ILIKE '%引擎%'
            AND job_title NOT ILIKE '%領班%'
            AND COALESCE(job_category,'') NOT ILIKE '%計時%'
            AND (status='在職' OR status='留職停薪'
                 OR (status='離職' AND resign_date IS NOT NULL AND resign_date >= $3::date))
          ORDER BY job_title, emp_name
        `, [rosterPeriod, br, periodStart]);
        techNames = r.rows;
      }
      const techCount = techNames.length;

      const visitsRes = await pool.query(`
        SELECT COUNT(*) AS total_visits FROM (
          SELECT DISTINCT plate_no, open_time::date
          FROM business_query
          WHERE period=$1 AND branch=$2
            AND COALESCE(plate_no,'') != ''
            AND open_time IS NOT NULL
            AND COALESCE(repair_type,'') NOT IN ('PDI','鈑噴','事故保險')
        ) sub
      `, [period, br]);
      const totalVisits = parseInt(visitsRes.rows[0]?.total_visits || 0);

      const dailyRes = await pool.query(`
        SELECT open_time::date AS work_date, COUNT(DISTINCT plate_no) AS vehicle_count
        FROM business_query
        WHERE period=$1 AND branch=$2
          AND open_time IS NOT NULL
          AND COALESCE(plate_no,'') != ''
          AND COALESCE(repair_type,'') NOT IN ('PDI','鈑噴','事故保險')
        GROUP BY open_time::date ORDER BY open_time::date
      `, [period, br]);

      const dailyAvg = elapsedDays > 0 ? Math.round(totalVisits / elapsedDays * 10) / 10 : 0;
      const turnoverRate = (techCount > 0 && elapsedDays > 0)
        ? Math.round(totalVisits / techCount / elapsedDays * 100) / 100 : null;

      const brBays = bayConfig[br] || {};
      const engineBays = parseInt(brBays.engine || 0);
      const engineBayRate = (engineBays > 0 && elapsedDays > 0)
        ? Math.round(totalVisits / engineBays / elapsedDays * 100) / 100 : null;

      result[br] = {
        branch: br,
        working_days: workingDays,
        elapsed_days: elapsedDays,
        tech_count: techCount,
        tech_names: techNames,
        total_visits: totalVisits,
        daily_avg: dailyAvg,
        turnover_rate: turnoverRate,
        daily: dailyRes.rows,
        bays: { engine: engineBays },
        bay_rates: { engine: engineBayRate },
      };
    }

    // ── 集團鈑烤周轉率 ──
    const bwGlobalRes = await pool.query(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT DISTINCT plate_no, open_time::date
        FROM business_query
        WHERE period=$1
          AND COALESCE(plate_no,'') != ''
          AND open_time IS NOT NULL
          AND repair_type IN ('鈑噴','事故保險')
      ) sub
    `, [period]);
    const bwTotalVisits = parseInt(bwGlobalRes.rows[0]?.cnt || 0);

    const bwDailyRes = await pool.query(`
      SELECT open_time::date AS work_date, COUNT(DISTINCT plate_no) AS vehicle_count
      FROM business_query
      WHERE period=$1
        AND open_time IS NOT NULL
        AND COALESCE(plate_no,'') != ''
        AND repair_type IN ('鈑噴','事故保險')
      GROUP BY open_time::date ORDER BY open_time::date
    `, [period]);

    let bwTechNames = [];
    if (rosterPeriod) {
      const pStart = `${period.slice(0,4)}-${period.slice(4,6)}-01`;
      const r = await pool.query(`
        SELECT emp_name, job_title, dept_name, status FROM staff_roster
        WHERE period=$1 AND factory='鈑烤'
          AND (dept_name ILIKE '%鈑金%' OR dept_name ILIKE '%烤漆%')
          AND COALESCE(job_category,'') NOT ILIKE '%計時%'
          AND (status='在職' OR status='留職停薪'
               OR (status='離職' AND resign_date IS NOT NULL AND resign_date >= $2::date))
        ORDER BY dept_name, emp_name
      `, [rosterPeriod, pStart]);
      bwTechNames = r.rows;
    }
    const bwTechCount = bwTechNames.length;
    const bwRef = result['AMA'] || Object.values(result)[0] || {};
    const bwElapsedDays = bwRef.elapsed_days || 0;
    const bwWorkingDays = bwRef.working_days || 0;

    const amaBaysCfg = bayConfig['AMA'] || {};
    const bwBays = parseInt(amaBaysCfg.bodywork || 0) + parseInt(amaBaysCfg.paint || 0);
    const bwDailyAvg = bwElapsedDays > 0 ? Math.round(bwTotalVisits / bwElapsedDays * 10) / 10 : 0;
    const bwTurnoverRate = (bwTechCount > 0 && bwElapsedDays > 0)
      ? Math.round(bwTotalVisits / bwTechCount / bwElapsedDays * 100) / 100 : null;
    const bwBayRate = (bwBays > 0 && bwElapsedDays > 0)
      ? Math.round(bwTotalVisits / bwBays / bwElapsedDays * 100) / 100 : null;

    const bodywork = {
      total_visits: bwTotalVisits,
      tech_count:   bwTechCount,
      tech_names:   bwTechNames,
      daily_avg:    bwDailyAvg,
      working_days: bwWorkingDays,
      elapsed_days: bwElapsedDays,
      turnover_rate: bwTurnoverRate,
      daily:        bwDailyRes.rows,
      bays:         bwBays,
      bay_rate:     bwBayRate,
    };

    res.json({ branches: result, bodywork, rosterPeriod, period });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 工位設定 ──
router.get('/tech-bay-config', async (req, res) => {
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key='service_bays'`);
    res.json(r.rows[0] ? JSON.parse(r.rows[0].value) : {});
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/tech-bay-config', async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO app_settings (key, value) VALUES ('service_bays', $1)
      ON CONFLICT (key) DO UPDATE SET value=$1
    `, [JSON.stringify(req.body)]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
