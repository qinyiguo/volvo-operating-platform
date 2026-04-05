const router = require('express').Router();
const pool   = require('../db/pool');

// ── 維修收入 ──
router.get('/stats/repair', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    const [summary, bySA, totals] = await Promise.all([
      pool.query(`SELECT branch,account_type,COUNT(*) AS work_order_count,SUM(total_untaxed) AS total_untaxed,SUM(parts_income) AS parts_income,SUM(accessories_income) AS accessories_income,SUM(boutique_income) AS boutique_income,SUM(engine_wage) AS engine_wage,SUM(bodywork_income+paint_income) AS bodywork_income,SUM(parts_cost) AS parts_cost FROM repair_income ${where} GROUP BY branch,account_type ORDER BY branch,total_untaxed DESC`,params),
      pool.query(`SELECT branch,service_advisor,COUNT(DISTINCT work_order) AS car_count,SUM(total_untaxed) AS total_untaxed,SUM(engine_wage) AS engine_wage,SUM(parts_income) AS parts_income FROM repair_income ${where} GROUP BY branch,service_advisor HAVING service_advisor IS NOT NULL AND service_advisor!='' ORDER BY total_untaxed DESC`,params),
      pool.query(`SELECT branch,COUNT(DISTINCT work_order) AS car_count,SUM(total_untaxed) AS total_untaxed,SUM(engine_wage) AS engine_wage,SUM(parts_income) AS parts_income,SUM(accessories_income) AS accessories_income,SUM(boutique_income) AS boutique_income,SUM(bodywork_income+paint_income) AS bodywork_income,SUM(parts_cost) AS parts_cost FROM repair_income ${where} GROUP BY branch ORDER BY branch`,params),
    ]);
    res.json({ summary:summary.rows, bySA:bySA.rows, totals:totals.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 收入分類明細 ──
router.get('/stats/income-summary', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';

    const cfgRow = await pool.query(`SELECT config_value FROM income_config WHERE config_key='external_sales_category'`);
    const externalCategory = cfgRow.rows[0]?.config_value || '外賣';

    const byType = await pool.query(`
      SELECT branch, account_type,
        COUNT(DISTINCT work_order)              AS car_count,
        SUM(total_untaxed)                      AS total_untaxed,
        ROUND(SUM(engine_wage)/1.05)            AS engine_wage_nt,
        ROUND(SUM(parts_income)/1.05)           AS parts_income_nt,
        ROUND(SUM(accessories_income)/1.05)     AS accessories_income_nt,
        ROUND(SUM(boutique_income)/1.05)        AS boutique_income_nt,
        ROUND(SUM(bodywork_income)/1.05)        AS bodywork_income_nt,
        ROUND(SUM(paint_income)/1.05)           AS paint_income_nt,
        ROUND(SUM(carwash_income)/1.05)         AS carwash_income_nt,
        ROUND(SUM(outsource_income)/1.05)       AS outsource_income_nt,
        ROUND(SUM(addon_income)/1.05)           AS addon_income_nt,
        SUM(parts_cost)                         AS parts_cost_nt
      FROM repair_income ${where}
      GROUP BY branch, account_type
      ORDER BY branch,
        CASE WHEN account_type ILIKE '%一般%' THEN 1 WHEN account_type ILIKE '%保險%' THEN 2
             WHEN account_type ILIKE '%延保%' THEN 3 WHEN account_type ILIKE '%票%'   THEN 4
             WHEN account_type ILIKE '%內結%' THEN 5 WHEN account_type ILIKE '%保固%' THEN 6
             WHEN account_type ILIKE '%VSA%' OR account_type ILIKE '%vsa%' THEN 7
             WHEN account_type ILIKE '%善意%' THEN 8 ELSE 9 END,
        total_untaxed DESC
    `, params);

    const extConds = []; const extParams = []; let eidx = 1;
    if (period) { extConds.push(`period=$${eidx++}`); extParams.push(period); }
    if (branch) { extConds.push(`branch=$${eidx++}`); extParams.push(branch); }
    extConds.push(`category=$${eidx++}`); extParams.push(externalCategory);

    const externalSales = await pool.query(`
      SELECT branch, COUNT(DISTINCT order_no) AS order_count,
        SUM(sale_qty) AS total_qty, SUM(sale_price_untaxed) AS total_sales, SUM(cost_untaxed) AS total_cost
      FROM parts_sales WHERE ${extConds.join(' AND ')}
      GROUP BY branch ORDER BY branch
    `, extParams);

    const techConds = []; const techParams = []; let tidx = 1;
    if (period) { techConds.push(`period=$${tidx++}`); techParams.push(period); }
    if (branch) { techConds.push(`branch=$${tidx++}`); techParams.push(branch); }
    const techWhere = techConds.length ? 'WHERE '+techConds.join(' AND ') : '';

    const techByType = await pool.query(`
      SELECT branch, account_type, COUNT(DISTINCT work_order) AS car_count,
        SUM(wage) AS total_wage, SUM(standard_hours) AS total_hours
      FROM tech_performance ${techWhere}
      GROUP BY branch, account_type
    `, techParams);

    res.json({ byType:byType.rows, externalSales:externalSales.rows, techByType:techByType.rows, externalCategory });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 零件銷售 ──
router.get('/stats/parts', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const conds = []; const params = []; let idx = 1;
    if (period) { conds.push(`period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    const [byType, topParts] = await Promise.all([
      pool.query(`SELECT branch,part_type,COUNT(*) AS count,SUM(sale_qty) AS total_qty,SUM(sale_price_untaxed) AS total_sales,SUM(cost_untaxed) AS total_cost FROM parts_sales ${where} GROUP BY branch,part_type ORDER BY branch,total_sales DESC`,params),
      pool.query(`SELECT part_number,part_name,part_type,SUM(sale_qty) AS total_qty,SUM(sale_price_untaxed) AS total_sales FROM parts_sales ${where} GROUP BY part_number,part_name,part_type ORDER BY total_sales DESC LIMIT 20`,params),
    ]);
    res.json({ byType:byType.rows, topParts:topParts.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 月份趨勢 ──
router.get('/stats/trend', async (req, res) => {
  try {
    const { branch } = req.query;
    const params = branch ? [branch] : [];
    const bc = branch ? 'AND branch=$1' : '';
    const r = await pool.query(`SELECT period,branch,COUNT(DISTINCT work_order) AS car_count,SUM(total_untaxed) AS total_untaxed,SUM(engine_wage) AS engine_wage,SUM(parts_income) AS parts_income FROM repair_income WHERE 1=1 ${bc} GROUP BY period,branch ORDER BY period,branch`,params);
    res.json({ trend: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 每日進廠台數 ──
router.get('/stats/daily', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const colRows = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='business_query'`);
    const cols    = colRows.rows.map(r => r.column_name);
    const dateCol   = cols.find(c => ['open_time','進廠時間','開單時間','開立時間','接車時間'].includes(c)) || 'open_time';
    const typeCol   = cols.find(c => ['repair_type','維修類型'].includes(c));
    const branchCol = cols.find(c => ['branch','據點','分店'].includes(c)) || 'branch';
    const periodCol = cols.find(c => ['period','期間'].includes(c)) || 'period';

    const conditions = [`"${dateCol}" IS NOT NULL`];
    if (typeCol) conditions.push(`"${typeCol}" NOT ILIKE '%PDI%'`);
    const params = []; let idx = 1;
    if (period) { conditions.push(`"${periodCol}"=$${idx++}`); params.push(period); }
    if (branch) { conditions.push(`"${branchCol}"=$${idx++}`); params.push(branch); }
    const where = 'WHERE '+conditions.join(' AND ');

    const [daily, autoSummary] = await Promise.all([
      pool.query(`SELECT "${dateCol}"::date AS arrive_date,"${branchCol}" AS branch,COUNT(DISTINCT plate_no) AS car_count FROM business_query ${where} GROUP BY "${dateCol}"::date,"${branchCol}" ORDER BY arrive_date,"${branchCol}"`,params),
      pool.query(`SELECT "${branchCol}" AS branch,SUM(daily_cnt) AS total_cars,COUNT(DISTINCT "${dateCol}"::date) AS auto_working_days,MAX(daily_cnt) AS max_day,MIN(daily_cnt) AS min_day FROM (SELECT "${branchCol}","${dateCol}"::date,COUNT(DISTINCT plate_no) AS daily_cnt FROM business_query ${where} GROUP BY "${branchCol}","${dateCol}"::date) sub GROUP BY "${branchCol}" ORDER BY "${branchCol}"`,params),
    ]);

    const wdMap = {};
    if (period) {
      for (const row of autoSummary.rows) {
        const wdRow = await pool.query(
          `SELECT work_dates FROM working_days_config WHERE branch=$1 AND period=$2`,
          [row.branch, period]
        );
        if (wdRow.rows.length && wdRow.rows[0].work_dates) wdMap[row.branch] = wdRow.rows[0].work_dates;
      }
    }

// ── 以現在時間點計算「已過工作天」，不依賴有無開單 ──
    const nowTW = new Date(Date.now() + 8 * 60 * 60 * 1000); // UTC+8
    const todayStr = nowTW.toISOString().slice(0, 10);        // YYYY-MM-DD

    const summary = autoSummary.rows.map(r => {
      const configured     = wdMap[r.branch] || null;
      const configuredDays = configured ? configured.length : null;
      const totalCars      = parseInt(r.total_cars || 0);

      // 本月全月工作天（分母）
      const workingDays = configuredDays !== null
        ? configuredDays
        : parseInt(r.auto_working_days || 0);

      // 已過工作天（分子）—— 依今天日期決定，與有無開單無關
      let elapsedDays;
      if (configured && configured.length > 0) {
        // 手動設定曆：算有幾個設定日 <= 今天
        elapsedDays = configured.filter(d => d <= todayStr).length;
      } else if (period) {
        // 無手動設定：算本月月初到今天（或月底，若已過）的平日數
        const y  = parseInt(period.slice(0, 4));
        const mo = parseInt(period.slice(4)) - 1; // 0-indexed
        const monthStart = new Date(Date.UTC(y, mo, 1));
        const monthEnd   = new Date(Date.UTC(y, mo + 1, 0));
        const todayUTC   = new Date(todayStr + 'T00:00:00Z');
        const cutoff     = todayUTC <= monthEnd ? todayUTC : monthEnd;
        let cnt = 0;
        const d = new Date(monthStart);
        while (d <= cutoff) {
          const dow = d.getUTCDay();
          if (dow !== 0 && dow !== 6) cnt++;
          d.setUTCDate(d.getUTCDate() + 1);
        }
        elapsedDays = cnt;
      } else {
        // fallback：只有在沒有 period 參數時才用舊邏輯
        elapsedDays = parseInt(r.auto_working_days || 0);
      }

      return {
        branch: r.branch,
        total_cars: totalCars,
        working_days: workingDays,
        auto_working_days: elapsedDays,          // ← 現在代表「今天為止已過幾個工作天」
        configured_working_days: configuredDays,
        daily_avg: elapsedDays > 0 ? (totalCars / elapsedDays).toFixed(1) : '0',
        max_day: r.max_day,
        min_day: r.min_day,
      };
    });
    
    res.json({ daily: daily.rows, summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SA 銷售矩陣 ──
const SPECIAL_TECH = `'美容技師','外包雜項','不列績效','AMAB','AMAP','AMAE','隔熱紙技師'`;
const canonicalExpr = `
  CASE
    WHEN tech_name_raw IN (${SPECIAL_TECH}) THEN tech_name_raw
    ELSE trim(split_part(regexp_replace(tech_name_raw, '[/、,，[:space:]]+', '/', 'g'), '/', 1))
  END`;

router.get('/stats/sa-sales-matrix', async (req, res) => {
  const { period, branch, view } = req.query;
  const viewParam = view === 'pickup_person' ? 'pickup_person' : 'sales_person';
  try {
    await pool.query(`SET LOCAL statement_timeout = '25000'`);
    const allConfigs = (await pool.query(
      `SELECT id,config_name,filters,stat_method,person_type FROM sa_sales_config ORDER BY id`
    )).rows;
    const configs = allConfigs.filter(cfg => {
      const pt = cfg.person_type || 'sales_person';
      return pt === viewParam || pt === 'both';
    });
    if (!configs.length) return res.json({ configs:[], rows:[], colTotals:{} });

    const saMap = {};
    for (const cfg of configs) {
      const filters   = cfg.filters || [];
      const catCodes  = filters.filter(f=>f.type==='category_code').map(f=>f.value);
      const funcCodes = filters.filter(f=>f.type==='function_code').map(f=>f.value);
      const partNums  = filters.filter(f=>f.type==='part_number').map(f=>f.value);
      const partTypes = filters.filter(f=>f.type==='part_type').map(f=>f.value);
      const workCodes = filters.filter(f=>f.type==='work_code').map(f=>f.value);
      const hasPartsConds = catCodes.length||funcCodes.length||partNums.length||partTypes.length;
      const hasWageConds  = workCodes.length;
      if (!hasPartsConds && !hasWageConds) continue;

      if (hasWageConds) {
        const conds=[]; const params=[]; let idx=1;
        if (period) { conds.push(`tp.period=$${idx++}`); params.push(period); }
        if (branch) { conds.push(`tp.branch=$${idx++}`); params.push(branch); }
        const acTypes = filters.filter(f=>f.type==='account_type').map(f=>f.value);
        if (acTypes.length) { conds.push(`tp.account_type=ANY($${idx++})`); params.push(acTypes); }
        const wcConds = [];
        for (const wc of workCodes) {
          if (wc.includes('-')) { const [from,to]=wc.split('-').map(s=>s.trim()); wcConds.push(`tp.work_code BETWEEN $${idx++} AND $${idx++}`); params.push(from,to); }
          else { wcConds.push(`tp.work_code=$${idx++}`); params.push(wc); }
        }
        if (wcConds.length) conds.push(`(${wcConds.join(' OR ')})`);
        const where    = conds.length ? 'WHERE '+conds.join(' AND ') : '';
        const statExpr = cfg.stat_method==='amount' ? 'SUM(tp.wage)' : cfg.stat_method==='quantity' ? 'SUM(tp.standard_hours)' : 'COUNT(DISTINCT tp.work_order)';
        let r;
        if (viewParam === 'pickup_person') {
          r = await pool.query(`SELECT tp.branch, COALESCE(NULLIF(${canonicalExpr},''),'（未知）') AS sa_name, ${statExpr} AS val FROM tech_performance tp ${where} GROUP BY tp.branch, sa_name`, params);
        } else {
          r = await pool.query(`SELECT tp.branch, COALESCE(NULLIF(ps_uniq.person_name,''),'（未知）') AS sa_name, ${statExpr} AS val FROM tech_performance tp LEFT JOIN (SELECT DISTINCT ON (branch, work_order) branch, work_order, sales_person AS person_name FROM parts_sales ORDER BY branch, work_order, id) ps_uniq ON ps_uniq.work_order=tp.work_order AND ps_uniq.branch=tp.branch ${where} GROUP BY tp.branch, sa_name`, params);
        }
        for (const row of r.rows) {
          const key = `${row.branch}|||${row.sa_name}`;
          if (!saMap[key]) saMap[key] = { branch:row.branch, sa_name:row.sa_name, configs:{} };
          const v = parseFloat(row.val||0);
          saMap[key].configs[cfg.id] = {
            qty:   cfg.stat_method==='quantity' ? v : 0,
            sales: cfg.stat_method==='amount'   ? v : 0,
            cnt:   cfg.stat_method==='count'    ? parseInt(v) : 0,
          };
        }
      } else {
        if (viewParam === 'pickup_person') {
          const tConds=[]; const params=[]; let idx=1;
          if (period) { tConds.push(`tp.period=$${idx++}`); params.push(period); }
          if (branch) { tConds.push(`tp.branch=$${idx++}`); params.push(branch); }
          const techWhere = tConds.length ? 'WHERE '+tConds.join(' AND ') : '';
          const psConds = [];
          if (period) { psConds.push(`ps.period=$${idx++}`); params.push(period); }
          if (branch) { psConds.push(`ps.branch=$${idx++}`); params.push(branch); }
          if (catCodes.length)  { psConds.push(`ps.category_code=ANY($${idx++})`); params.push(catCodes); }
          if (funcCodes.length) { psConds.push(`ps.function_code=ANY($${idx++})`); params.push(funcCodes); }
          if (partNums.length)  { psConds.push(`ps.part_number=ANY($${idx++})`);   params.push(partNums); }
          if (partTypes.length) { psConds.push(`ps.part_type=ANY($${idx++})`);     params.push(partTypes); }
          const psWhere = psConds.length ? 'AND '+psConds.join(' AND ') : '';
          const r = await pool.query(`
            WITH tech_names AS (
              SELECT DISTINCT tp.branch, COALESCE(NULLIF(${canonicalExpr},''),'（未知）') AS canonical_name
              FROM tech_performance tp ${techWhere}
            )
            SELECT tn.branch, tn.canonical_name AS sa_name,
              COALESCE(SUM(ps.sale_qty),0) AS qty,
              COALESCE(SUM(ps.sale_price_untaxed),0) AS sales,
              COALESCE(COUNT(ps.id),0) AS cnt
            FROM tech_names tn
            LEFT JOIN parts_sales ps ON ps.pickup_person=tn.canonical_name AND ps.branch=tn.branch ${psWhere}
            GROUP BY tn.branch, tn.canonical_name
          `, params);
          for (const row of r.rows) {
            const key = `${row.branch}|||${row.sa_name}`;
            if (!saMap[key]) saMap[key] = { branch:row.branch, sa_name:row.sa_name, configs:{} };
            saMap[key].configs[cfg.id] = { qty:parseFloat(row.qty||0), sales:parseFloat(row.sales||0), cnt:parseInt(row.cnt||0) };
          }
        } else {
          const conds=[]; const params=[]; let idx=1;
          if (period) { conds.push(`period=$${idx++}`); params.push(period); }
          if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
          if (catCodes.length)  { conds.push(`category_code=ANY($${idx++})`); params.push(catCodes); }
          if (funcCodes.length) { conds.push(`function_code=ANY($${idx++})`); params.push(funcCodes); }
          if (partNums.length)  { conds.push(`part_number=ANY($${idx++})`);   params.push(partNums); }
          if (partTypes.length) { conds.push(`part_type=ANY($${idx++})`);     params.push(partTypes); }
          const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
          const r = await pool.query(`
            SELECT branch, COALESCE(NULLIF(sales_person,''),'（未知）') AS sa_name,
              SUM(sale_qty) AS qty, SUM(sale_price_untaxed) AS sales, COUNT(*) AS cnt
            FROM parts_sales ${where} GROUP BY branch, sa_name
          `, params);
          for (const row of r.rows) {
            const key = `${row.branch}|||${row.sa_name}`;
            if (!saMap[key]) saMap[key] = { branch:row.branch, sa_name:row.sa_name, configs:{} };
            saMap[key].configs[cfg.id] = { qty:parseFloat(row.qty||0), sales:parseFloat(row.sales||0), cnt:parseInt(row.cnt||0) };
          }
        }
      }
    }

    let excludeNames = new Set();
    if (viewParam === 'pickup_person') {
      const exConds=[]; const exParams=[]; let exIdx=1;
      if (period) { exConds.push(`period=$${exIdx++}`); exParams.push(period); }
      if (branch) { exConds.push(`branch=$${exIdx++}`); exParams.push(branch); }
      const exWhere = exConds.length ? 'WHERE '+exConds.join(' AND ') : '';
      const exRes = await pool.query(`SELECT DISTINCT COALESCE(NULLIF(sales_person,''),'（未知）') AS name FROM parts_sales ${exWhere}`, exParams);
      excludeNames = new Set(exRes.rows.map(r => r.name));
    }

    const rows = Object.values(saMap)
      .filter(row => !excludeNames.has(row.sa_name))
      .sort((a,b) => {
        if (a.branch!==b.branch) return a.branch<b.branch?-1:1;
        const bSum=Object.values(b.configs).reduce((s,c)=>s+c.sales+c.cnt,0);
        const aSum=Object.values(a.configs).reduce((s,c)=>s+c.sales+c.cnt,0);
        return bSum-aSum;
      });
    const colTotals = {};
    for (const cfg of configs) {
      colTotals[cfg.id] = rows.reduce((s,row) => {
        const c=row.configs[cfg.id]||{qty:0,sales:0,cnt:0};
        return { qty:s.qty+c.qty, sales:s.sales+c.sales, cnt:s.cnt+c.cnt };
      }, {qty:0,sales:0,cnt:0});
    }
    res.json({ configs, rows, colTotals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 精品配件銷售 ──
router.get('/stats/boutique-accessories', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const params = []; let idx = 1;
    const conds = [`pc.part_type IN ('精品','配件')`];
    if (period) { conds.push(`ps.period=$${idx++}`); params.push(period); }
    if (branch) { conds.push(`ps.branch=$${idx++}`); params.push(branch); }
    const where = conds.join(' AND ');
    const r = await pool.query(`
      SELECT ps.branch, COALESCE(NULLIF(ps.sales_person,''),'（未知）') AS sales_person,
        pc.part_type AS part_type, COALESCE(NULLIF(ps.part_type,''),'（未分類）') AS account_type,
        SUM(ps.sale_price_untaxed) AS total_sales, SUM(ps.cost_untaxed) AS total_cost,
        SUM(ps.sale_qty) AS total_qty, COUNT(*) AS cnt
      FROM parts_sales ps INNER JOIN parts_catalog pc ON ps.part_number=pc.part_number
      WHERE ${where}
      GROUP BY ps.branch, ps.sales_person, pc.part_type, ps.part_type
      ORDER BY ps.branch, pc.part_type, SUM(ps.sale_price_untaxed) DESC
    `, params);
    const kpi = await pool.query(`
      SELECT ps.branch, pc.part_type AS part_type,
        SUM(ps.sale_price_untaxed) AS total_sales, SUM(ps.cost_untaxed) AS total_cost,
        SUM(ps.sale_qty) AS total_qty, COUNT(DISTINCT ps.order_no) AS order_count
      FROM parts_sales ps INNER JOIN parts_catalog pc ON ps.part_number=pc.part_number
      WHERE ${where}
      GROUP BY ps.branch, pc.part_type ORDER BY ps.branch, pc.part_type
    `, params);
    res.json({ rows: r.rows, kpi: kpi.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 收入明細分解 ──
router.get('/stats/income-breakdown', async (req, res) => {
  const { period, branch } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const params = [period]; let idx = 2;
    const branchCond = branch ? ` AND branch=$${idx++}` : '';
    if (branch) params.push(branch);

    const riRes = await pool.query(`
      SELECT branch, account_type, SUM(total_untaxed) AS total,
        SUM(CASE WHEN COALESCE(bodywork_income,0)>0 OR COALESCE(paint_income,0)>0 THEN total_untaxed ELSE 0 END) AS with_bodywork,
        SUM(CASE WHEN COALESCE(bodywork_income,0)=0 AND COALESCE(paint_income,0)=0 THEN total_untaxed ELSE 0 END) AS without_bodywork
      FROM repair_income WHERE period=$1${branchCond}
      GROUP BY branch, account_type
    `, params);

    const cfgRow = await pool.query(`SELECT config_value FROM income_config WHERE config_key='external_sales_category'`);
    const externalCategory = cfgRow.rows[0]?.config_value || '外賣';
    const extParams = [period, externalCategory]; let eidx = 3;
    const extBranchCond = branch ? ` AND branch=$${eidx++}` : '';
    if (branch) extParams.push(branch);
    const extRes = await pool.query(`
      SELECT branch, SUM(sale_price_untaxed) AS ext_sales
      FROM parts_sales WHERE period=$1 AND category=$2${extBranchCond}
      GROUP BY branch
    `, extParams);
    const extMap = {};
    extRes.rows.forEach(r => { extMap[r.branch] = parseFloat(r.ext_sales || 0); });

    const BRANCHES = branch ? [branch] : ['AMA','AMC','AMD'];
    const result = {};
    BRANCHES.forEach(br => {
      const rows     = riRes.rows.filter(r => r.branch === br);
      const findType = (kw) => rows.find(r => r.account_type?.includes(kw));
      const ins      = findType('保險');
      const gen      = findType('一般');
      const ext_row  = findType('延保');
      const vou      = findType('票');
      const bodywork_insurance = parseFloat(ins?.total || 0);
      const bodywork_self      = parseFloat(gen?.with_bodywork || 0);
      const bodywork_total     = bodywork_insurance + bodywork_self;
      const extended           = parseFloat(ext_row?.total || 0);
      const general_no_bw      = parseFloat(gen?.without_bodywork || 0);
      const voucher            = parseFloat(vou?.total || 0);
      const external           = extMap[br] || 0;
      const general_total      = general_no_bw + voucher + external;
      const paid_total         = general_total + bodywork_total + extended;
      const OTHER_KWS = ['內結','保固','VSA','vsa','善意'];
      const other_rows  = rows.filter(r => OTHER_KWS.some(k => r.account_type?.toLowerCase().includes(k.toLowerCase())));
      const other_total = other_rows.reduce((s, r) => s + parseFloat(r.total || 0), 0);
      const all_total   = paid_total + other_total;
      result[br] = {
        bodywork_self, bodywork_insurance, bodywork_total,
        extended, general_no_bw, voucher, external,
        general_total, paid_total, other_total, all_total,
        other_detail: other_rows.map(r => ({ account_type: r.account_type, total: parseFloat(r.total || 0) })),
      };
    });
    res.json({ branches: result, externalCategory });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 業績統計 ──
router.get('/stats/performance', async (req, res) => {
  const { period, branch } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const metrics = (await pool.query(`SELECT * FROM performance_metrics ORDER BY sort_order, id`)).rows;
    if (!metrics.length) return res.json({ metrics: [], results: [] });

    const BRANCHES = branch ? [branch] : ['AMA','AMC','AMD'];
    const tRes = await pool.query(
      `SELECT * FROM performance_targets WHERE period=$1${branch ? ' AND branch=$2' : ''}`,
      branch ? [period, branch] : [period]
    );
    const tMap = {};
    tRes.rows.forEach(t => { tMap[`${t.metric_id}|||${t.branch}`] = t; });

    const results = [];
    for (const metric of metrics) {
      const filters = metric.filters || [];
      const mr = { metric_id: metric.id, branches: {} };
      for (const br of BRANCHES) {
        let actual = 0;
        try {
          if (metric.metric_type === 'repair_income') {
            const acTypes = filters.filter(f=>f.type==='account_type').map(f=>f.value);
            const q = acTypes.length
              ? `SELECT COALESCE(SUM(total_untaxed),0) as v FROM repair_income WHERE period=$1 AND branch=$2 AND account_type=ANY($3)`
              : `SELECT COALESCE(SUM(total_untaxed),0) as v FROM repair_income WHERE period=$1 AND branch=$2`;
            actual = parseFloat((await pool.query(q, acTypes.length ? [period,br,acTypes] : [period,br])).rows[0]?.v || 0);
          } else if (metric.metric_type === 'parts') {
            const cc=filters.filter(f=>f.type==='category_code').map(f=>f.value);
            const fc=filters.filter(f=>f.type==='function_code').map(f=>f.value);
            const pn=filters.filter(f=>f.type==='part_number').map(f=>f.value);
            const pt=filters.filter(f=>f.type==='part_type').map(f=>f.value);
            const c=[`period=$1`,`branch=$2`]; const p=[period,br]; let i=3;
            if (cc.length){c.push(`category_code=ANY($${i++})`);p.push(cc);}
            if (fc.length){c.push(`function_code=ANY($${i++})`);p.push(fc);}
            if (pn.length){c.push(`part_number=ANY($${i++})`);p.push(pn);}
            if (pt.length){c.push(`part_type=ANY($${i++})`);p.push(pt);}
            const fld = metric.stat_field==='qty'?'SUM(sale_qty)':metric.stat_field==='count'?'COUNT(*)':'SUM(sale_price_untaxed)';
            actual = parseFloat((await pool.query(`SELECT COALESCE(${fld},0) as v FROM parts_sales WHERE ${c.join(' AND ')}`,p)).rows[0]?.v || 0);
          } else if (metric.metric_type === 'boutique') {
            const bt=filters.filter(f=>f.type==='boutique_type').map(f=>f.value);
            const ac=filters.filter(f=>f.type==='account_type').map(f=>f.value);
            const c=[`ps.period=$1`,`ps.branch=$2`]; const p=[period,br]; let i=3;
            if (bt.length){c.push(`pc.part_type=ANY($${i++})`);p.push(bt);}
            else{c.push(`pc.part_type IN ('精品','配件')`);}
            if (ac.length){c.push(`ps.part_type=ANY($${i++})`);p.push(ac);}
            actual = parseFloat((await pool.query(`SELECT COALESCE(SUM(ps.sale_price_untaxed),0) as v FROM parts_sales ps JOIN parts_catalog pc ON ps.part_number=pc.part_number WHERE ${c.join(' AND ')}`,p)).rows[0]?.v || 0);
          } else if (metric.metric_type === 'tech_wage') {
            const buildWCcond = (workCodes, startIdx) => {
              const conds=[]; const ps=[]; let i=startIdx;
              for (const wc of workCodes) {
                if (wc.type==='range'){conds.push(`work_code BETWEEN $${i++} AND $${i++}`);ps.push(wc.from,wc.to);}
                else{conds.push(`work_code=$${i++}`);ps.push(wc.value);}
              }
              return { cond:conds.length?`(${conds.join(' OR ')})` : '1=1', ps };
            };
            const workCodes=filters.filter(f=>f.type==='work_code');
            const acTypes=filters.filter(f=>f.type==='account_type').map(f=>f.value);
            const conds=[`period=$1`,`branch=$2`]; const p=[period,br]; let i=3;
            if (acTypes.length){conds.push(`account_type=ANY($${i++})`);p.push(acTypes);}
            if (workCodes.length){
              const wcs=workCodes.map(f=>{if(f.value.includes('-')){const[from,to]=f.value.split('-');return{type:'range',from,to};}return{type:'exact',value:f.value};});
              const{cond,ps}=buildWCcond(wcs,i);conds.push(cond);p.push(...ps);
            }
            const statExpr=metric.stat_field==='amount'?'SUM(wage)':metric.stat_field==='hours'?'SUM(standard_hours)':'COUNT(DISTINCT work_order)';
            actual=parseFloat((await pool.query(`SELECT COALESCE(${statExpr},0) as v FROM tech_performance WHERE ${conds.join(' AND ')}`,p)).rows[0]?.v||0);
          } else if (metric.metric_type === 'repair_subfield') {
            const VALID_COLS=new Set(['bodywork_income','paint_income','engine_wage','parts_income','accessories_income','boutique_income','carwash_income','outsource_income','addon_income','total_untaxed','parts_cost']);
            const acTypes=filters.filter(f=>f.type==='account_type').map(f=>f.value);
            const subfields=filters.filter(f=>f.type==='subfield'&&VALID_COLS.has(f.value)).map(f=>f.value);
            const woMode=filters.find(f=>f.type==='wo_mode')?.value||'sum';
            if (!subfields.length){actual=0;}
            else{
              const p=[period,br]; let i=3;
              let where=`period=$1 AND branch=$2`;
              if(acTypes.length){where+=` AND account_type=ANY($${i++})`;p.push(acTypes);}
              let q;
              if(woMode==='wo_has'){const hasCond=subfields.map(c=>`COALESCE(${c},0)>0`).join(' OR ');q=`SELECT COALESCE(SUM(total_untaxed),0) as v FROM repair_income WHERE ${where} AND (${hasCond})`;}
              else if(woMode==='wo_exclude'){const excCond=subfields.map(c=>`COALESCE(${c},0)=0`).join(' AND ');q=`SELECT COALESCE(SUM(total_untaxed),0) as v FROM repair_income WHERE ${where} AND (${excCond})`;}
              else{const sumExpr=subfields.map(c=>`COALESCE(${c},0)`).join('+');q=`SELECT COALESCE(SUM(${sumExpr}),0) as v FROM repair_income WHERE ${where}`;}
              actual=parseFloat((await pool.query(q,p)).rows[0]?.v||0);
            }
          }
        } catch(e) { actual = 0; }

        const t  = tMap[`${metric.id}|||${br}`] || {};
        const tv = parseFloat(t.target_value    || 0);
        const ly = parseFloat(t.last_year_value || 0);
        mr.branches[br] = {
          actual,
          target:       tv || null,
          last_year:    ly || null,
          achieve_rate: tv > 0 ? (actual / tv * 100) : null,
          yoy_growth:   ly > 0 ? ((actual - ly) / ly * 100) : null,
        };
      }
      results.push(mr);
    }
    res.json({ metrics, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── WIP 未結工單（累計制）──
router.get('/stats/wip', async (req, res) => {
  const { period, branch } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const params = [period]; let idx = 2;
    const branchCond = branch ? ` AND bq.branch=$${idx++}` : '';
    if (branch) params.push(branch);

    const r = await pool.query(`
      SELECT
        bq.work_order,
        bq.branch,
        bq.period                            AS open_period,
        COALESCE(bq.plate_no, '')            AS plate_no,
        COALESCE(bq.repair_type, '')         AS repair_type,
        COALESCE(bq.repair_item, '')         AS repair_item,
        bq.open_time,
        bq.settle_date,
        COALESCE(bq.status, '')              AS status,
        COALESCE(bq.service_advisor, '')     AS service_advisor,
        COALESCE(bq.car_series, '')          AS car_series,
        COALESCE(bq.repair_type, '')         AS account_type,
        COALESCE(bq.labor_fee, 0)            AS wage,
        COALESCE(bq.repair_amount, 0)        AS sales_amt,
        COALESCE(bq.repair_material_fee, 0)  AS cost_amt,
        COALESCE(bq.sales_material_fee, 0)   AS parts_sales_amt,
        CASE
          WHEN bq.open_time IS NOT NULL
          THEN EXTRACT(DAY FROM (NOW() - bq.open_time))
          ELSE NULL
        END AS days_open,
        COALESCE(wsn.wip_status, '未填寫')  AS wip_status,
        wsn.eta_date,
        COALESCE(wsn.reason, '')            AS wip_reason,
        COALESCE(wsn.updated_by, '')        AS wip_updated_by,
        wsn.updated_at                      AS wip_updated_at
      FROM business_query bq
      LEFT JOIN wip_status_notes wsn
        ON wsn.work_order = bq.work_order AND wsn.branch = bq.branch
      WHERE
        bq.open_time < (to_date($1 || '01', 'YYYYMMDD') + interval '1 month')
        ${branchCond}
        AND COALESCE(bq.repair_type, '') NOT ILIKE '%PV%'
        AND NOT EXISTS (
          SELECT 1 FROM repair_income ri
          WHERE ri.work_order = bq.work_order
            AND ri.branch     = bq.branch
        )
      ORDER BY bq.branch, bq.open_time NULLS LAST, bq.work_order
    `, params);
    const rows = r.rows;
    const byRepairType = {};
    const byPeriod     = {};
    const byBranch     = {};
    const ZERO = () => ({ count: 0, wage: 0, mat: 0, sales: 0, c30: 0, cOver30: 0,
                           wage30: 0, mat30: 0, sales30: 0 });
    let total   = ZERO();
    let exclPdi = ZERO();

    for (const row of rows) {
      const rt      = row.repair_type || '（未知）';
      const per     = row.open_period || '（未知）';
      const br      = row.branch      || '（未知）';
      const w       = parseFloat(row.wage           || 0);  // labor_fee
      const m       = parseFloat(row.cost_amt       || 0);  // repair_material_fee
      const s       = parseFloat(row.sales_amt      || 0);  // repair_amount
      const days    = row.days_open !== null ? parseFloat(row.days_open) : null;
      const isOver30 = days !== null && days > 30;
      const isPdi   = /PDI/i.test(row.repair_type || '') || /PDI/i.test(row.repair_item || '');

      const inc = (obj) => {
        obj.count++;
        obj.wage  += w;
        obj.mat   += m;
        obj.sales += s;
        if (days !== null) {
          if (isOver30) {
            obj.cOver30++;
          } else {
            obj.c30++;
            obj.wage30  += w;
            obj.mat30   += m;
            obj.sales30 += s;
          }
        }
      };

      if (!byRepairType[rt]) byRepairType[rt] = { label: rt, ...ZERO() };
      inc(byRepairType[rt]);
      if (!byPeriod[per]) byPeriod[per] = { label: per, ...ZERO() };
      inc(byPeriod[per]);
      if (!byBranch[br]) byBranch[br] = { label: br, ...ZERO() };
      inc(byBranch[br]);
      inc(total);
      if (!isPdi) inc(exclPdi);
      row.is_pdi = isPdi;
    }

    res.json({
      rows,
      summary: {
        total, exclPdi,
        byAccountType: Object.values(byPeriod).sort((a,b) => a.label < b.label ? -1 : 1),
        byRepairType:  Object.values(byRepairType).sort((a,b) => b.count - a.count),
        byBranch:      Object.values(byBranch).sort((a,b) => a.label < b.label ? -1 : 1),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 單車銷售額 ──
// 分類邏輯：
//   工單有工資代碼 17300/17301/17398 → 保養
//   帳類含「延保」→ 延保
//   帳類含「保險」→ 保險
//   帳類含「一般」且 bodywork/paint > 0 → 自費鈑烤
//   其餘 → 維修
// 台數計算：plate_no + visit_date + repair_category 三合一去重
//   同日同車牌同類型 = 1 台；同日同車牌不同類型 = 2 台
router.get('/stats/revenue-per-vehicle', async (req, res) => {
  const { period, branch } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const params = [period]; let idx = 2;
    const branchCond = branch ? ` AND ri.branch=$${idx++}` : '';
    if (branch) params.push(branch);

    const r = await pool.query(`
      WITH classified_orders AS (
        SELECT
          ri.branch,
          ri.work_order,
          ri.total_untaxed,
          ri.account_type,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM tech_performance tp
              WHERE tp.work_order = ri.work_order
                AND tp.branch = ri.branch
                AND tp.work_code IN ('17300','17301','17398')
            ) THEN '保養'
            WHEN ri.account_type ILIKE '%延保%' THEN '延保'
            WHEN ri.account_type ILIKE '%保險%' THEN '保險'
            WHEN (COALESCE(ri.bodywork_income,0)>0 OR COALESCE(ri.paint_income,0)>0) THEN '自費鈑烤'
            ELSE '維修'
          END AS repair_category
        FROM repair_income ri
        WHERE ri.period=$1${branchCond}
      ),
      vehicle_visits AS (
        SELECT
          co.branch,
          co.repair_category,
          co.work_order,
          co.total_untaxed,
          COALESCE(NULLIF(TRIM(bq.plate_no),''), co.work_order) AS plate_key,
          COALESCE(bq.open_time::date::text, co.work_order)     AS visit_date
        FROM classified_orders co
        LEFT JOIN business_query bq
          ON bq.work_order = co.work_order AND bq.branch = co.branch
      ),
      distinct_vehicles AS (
        SELECT DISTINCT branch, repair_category, plate_key, visit_date
        FROM vehicle_visits
      ),
      vehicle_counts AS (
        SELECT branch, repair_category, COUNT(*) AS vehicle_count
        FROM distinct_vehicles
        GROUP BY branch, repair_category
      ),
      revenue_sums AS (
        SELECT branch, repair_category,
          SUM(total_untaxed) AS total_revenue,
          COUNT(*)           AS wo_count
        FROM classified_orders
        GROUP BY branch, repair_category
      )
      SELECT
        rs.branch,
        rs.repair_category,
        CASE
          WHEN rs.repair_category IN ('保養','維修','自費鈑烤') THEN '一般'
          ELSE rs.repair_category
        END                                              AS main_category,
        ROUND(COALESCE(rs.total_revenue,0))              AS total_revenue,
        rs.wo_count,
        COALESCE(vc.vehicle_count,0)                     AS vehicle_count,
        CASE WHEN COALESCE(vc.vehicle_count,0) > 0
          THEN ROUND(rs.total_revenue / vc.vehicle_count)
          ELSE 0
        END                                              AS revenue_per_vehicle
      FROM revenue_sums rs
      LEFT JOIN vehicle_counts vc
        ON vc.branch = rs.branch AND vc.repair_category = rs.repair_category
      ORDER BY rs.branch,
        CASE rs.repair_category
          WHEN '保養'     THEN 1
          WHEN '維修'     THEN 2
          WHEN '自費鈑烤' THEN 3
          WHEN '延保'     THEN 4
          WHEN '保險'     THEN 5
          ELSE 6
        END
    `, params);

    const rows = r.rows;
    const grandMap = {};
    rows.forEach(row => {
      const key = row.repair_category;
      if (!grandMap[key]) grandMap[key] = {
        repair_category: key, main_category: row.main_category,
        total_revenue: 0, wo_count: 0, vehicle_count: 0,
      };
      grandMap[key].total_revenue  += parseFloat(row.total_revenue  || 0);
      grandMap[key].wo_count       += parseInt(row.wo_count         || 0);
      grandMap[key].vehicle_count  += parseInt(row.vehicle_count    || 0);
    });
    const grand = Object.values(grandMap).map(g => ({
      ...g,
      branch: '全廠合計',
      revenue_per_vehicle: g.vehicle_count > 0 ? Math.round(g.total_revenue / g.vehicle_count) : 0,
    })).sort((a,b) => {
      const o = { '保養':1,'維修':2,'自費鈑烤':3,'延保':4,'保險':5 };
      return (o[a.repair_category]||6) - (o[b.repair_category]||6);
    });

    res.json({ rows, grand });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── SA 進廠台數 ──
router.get('/stats/sa-car-count', async (req, res) => {
  const { period, branch } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const params = [period]; let idx = 2;
    const bc = branch ? ` AND branch=$${idx++}` : '';
    if (branch) params.push(branch);
    const r = await pool.query(`
      SELECT service_advisor, COUNT(DISTINCT plate_no) AS car_count
      FROM repair_income
      WHERE period=$1${bc}
        AND service_advisor IS NOT NULL AND service_advisor != ''
      GROUP BY service_advisor
    `, params);
    const map = {};
    r.rows.forEach(row => { map[row.service_advisor] = parseInt(row.car_count || 0); });
    res.json(map);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── SA 各類型營收 ──
router.get('/stats/sa-paid-revenue', async (req, res) => {
  const { period, branch, rev_type } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const params = [period]; let idx = 2;
    const bc = branch ? ` AND branch=$${idx++}` : '';
    if (branch) params.push(branch);
    let extra = '';
    if (rev_type === 'bodywork') {
      extra = ` AND (account_type ILIKE '%保險%' OR (account_type ILIKE '%一般%' AND (COALESCE(bodywork_income,0)>0 OR COALESCE(paint_income,0)>0)))`;
    } else if (rev_type === 'general') {
      extra = ` AND account_type ILIKE '%一般%' AND COALESCE(bodywork_income,0)=0 AND COALESCE(paint_income,0)=0`;
    } else if (rev_type === 'extended') {
      extra = ` AND account_type ILIKE '%延保%'`;
    } else {
      extra = ` AND account_type NOT ILIKE '%內結%' AND account_type NOT ILIKE '%保固%' AND account_type NOT ILIKE '%VSA%' AND account_type NOT ILIKE '%善意%'`;
    }
    const r = await pool.query(`
      SELECT service_advisor, COALESCE(SUM(total_untaxed),0) AS revenue
      FROM repair_income
      WHERE period=$1${bc}${extra}
        AND service_advisor IS NOT NULL AND service_advisor != ''
      GROUP BY service_advisor
    `, params);
    const map = {};
    r.rows.forEach(row => { map[row.service_advisor] = parseFloat(row.revenue || 0); });
    res.json(map);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// WIP 上月結清率比較
router.get('/stats/wip/last-month-comparison', async (req, res) => {
  const { branch } = req.query;
  try {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lmPrefix = `${lastMonth.getFullYear()}${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;

    const hasBranch = branch && branch !== '全部';
    const params = hasBranch ? [branch] : [];
    const branchCond = hasBranch ? `AND bq.branch = $1` : '';

    const [r1, r2, r3] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) AS total
        FROM business_query bq
        WHERE TO_CHAR(bq.open_time, 'YYYYMM') = '${lmPrefix}'
          AND COALESCE(bq.repair_type,'') NOT ILIKE '%PV%'
          ${branchCond}
      `, params),
      pool.query(`
        SELECT COUNT(DISTINCT bq.work_order || '|||' || bq.branch) AS settled,
               COALESCE(SUM(ri.total_untaxed), 0) AS settled_amt
        FROM business_query bq
        JOIN repair_income ri ON ri.work_order = bq.work_order AND ri.branch = bq.branch
        WHERE TO_CHAR(bq.open_time, 'YYYYMM') = '${lmPrefix}'
          AND COALESCE(bq.repair_type,'') NOT ILIKE '%PV%'
          ${branchCond}
      `, params),
      pool.query(`
        SELECT COUNT(*) AS still_wip,
               COALESCE(SUM(bq.repair_amount), 0) AS still_wip_amt
        FROM business_query bq
        WHERE TO_CHAR(bq.open_time, 'YYYYMM') = '${lmPrefix}'
          AND COALESCE(bq.repair_type,'') NOT ILIKE '%PV%'
          AND NOT EXISTS (
            SELECT 1 FROM repair_income ri
            WHERE ri.work_order = bq.work_order AND ri.branch = bq.branch
          )
          AND COALESCE((
            SELECT wsn.wip_status FROM wip_status_notes wsn
            WHERE wsn.work_order = bq.work_order AND wsn.branch = bq.branch
          ), '未填寫') != '已結清'
          ${branchCond}
      `, params),
    ]);

    const total      = parseInt(r1.rows[0].total)      || 0;
    const settled    = parseInt(r2.rows[0].settled)    || 0;
    const settledAmt = parseFloat(r2.rows[0].settled_amt) || 0;
    const stillWip   = parseInt(r3.rows[0].still_wip)  || 0;
    const stillAmt   = parseFloat(r3.rows[0].still_wip_amt) || 0;
    const rate       = total > 0 ? Math.round(settled / total * 100) : 0;

    res.json({ ok: true, lmPrefix, total, settled, settledAmt, stillWip, stillAmt, rate });
  } catch (e) {
    console.error('wip last-month-comparison error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
