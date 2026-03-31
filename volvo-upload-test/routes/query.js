const router = require('express').Router();
const pool   = require('../db/pool');

// ── 收入設定 ──
router.get('/income-config', async (req, res) => {
  try {
    const r = await pool.query(`SELECT config_key, config_value, description FROM income_config ORDER BY id`);
    const map = {}; r.rows.forEach(row => { map[row.config_key] = row.config_value; });
    res.json({ rows: r.rows, map });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/income-config/:key', async (req, res) => {
  const { value } = req.body;
  if (!value) return res.status(400).json({ error:'值為必填' });
  try {
    await pool.query(`UPDATE income_config SET config_value=$1,updated_at=NOW() WHERE config_key=$2`,[value.trim(),req.params.key]);
    res.json({ ok:true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 工作天數設定 ──
router.get('/working-days', async (req, res) => {
  const { branch, period } = req.query;
  try {
    if (branch && period) {
      const r = await pool.query(
        `SELECT branch, period, work_dates, note, updated_at FROM working_days_config WHERE branch=$1 AND period=$2`,
        [branch, period]
      );
      res.json(r.rows[0] || { branch, period, work_dates: [], note: '' });
    } else {
      const r = await pool.query(
        `SELECT branch, period, work_dates, note, updated_at FROM working_days_config ORDER BY period DESC, branch`
      );
      res.json(r.rows);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/working-days', async (req, res) => {
  const { branch, period, work_dates, note } = req.body;
  if (!branch || !period) return res.status(400).json({ error: 'branch 和 period 為必填' });
  if (!Array.isArray(work_dates)) return res.status(400).json({ error: 'work_dates 必須為陣列' });
  try {
    await pool.query(
      `INSERT INTO working_days_config (branch, period, work_dates, note, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (branch, period) DO UPDATE SET work_dates=$3, note=$4, updated_at=NOW()`,
      [branch, period, JSON.stringify(work_dates), note || '']
    );
    res.json({ ok: true, count: work_dates.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/working-days', async (req, res) => {
  const { branch, period } = req.query;
  if (!branch || !period) return res.status(400).json({ error: 'branch 和 period 為必填' });
  try {
    await pool.query(`DELETE FROM working_days_config WHERE branch=$1 AND period=$2`, [branch, period]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 基礎查詢 ──
router.get('/counts', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT 'repair_income' AS 表格,COUNT(*) AS 筆數 FROM repair_income UNION ALL
      SELECT 'tech_performance',COUNT(*) FROM tech_performance UNION ALL
      SELECT 'parts_sales',COUNT(*) FROM parts_sales UNION ALL
      SELECT 'business_query',COUNT(*) FROM business_query UNION ALL
      SELECT 'parts_catalog',COUNT(*) FROM parts_catalog UNION ALL
      SELECT 'upload_history',COUNT(*) FROM upload_history`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/history', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM upload_history ORDER BY created_at DESC LIMIT 20')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status:'ok', db:'connected' }); }
  catch (err) { res.status(500).json({ status:'error', error:err.message }); }
});

router.get('/debug/columns', async (req, res) => {
  try { res.json((await pool.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_name='business_query' ORDER BY ordinal_position`)).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 明細查詢 ──
const buildQueryConds = (period, branch) => {
  const conds = []; const params = []; let idx = 1;
  if (period) { conds.push(`period=$${idx++}`); params.push(period); }
  if (branch) { conds.push(`branch=$${idx++}`); params.push(branch); }
  return { conds, params, idx };
};

router.get('/query/repair_income', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const { conds, params } = buildQueryConds(period, branch);
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pool.query(
      `SELECT branch, period, work_order, settle_date, customer, plate_no,
              account_type_code, account_type, parts_income, accessories_income,
              boutique_income, engine_wage, bodywork_income, paint_income,
              carwash_income, outsource_income, addon_income, total_untaxed,
              total_taxed, parts_cost, service_advisor
       FROM repair_income ${where}
       ORDER BY branch, settle_date DESC, work_order`, params);
    res.json({ rows: r.rows, count: r.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/query/tech_performance', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const { conds, params } = buildQueryConds(period, branch);
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pool.query(
      `SELECT branch, period, tech_name_clean, dispatch_date, work_order,
              work_code, task_content, account_type, standard_hours, wage,
              discount, wage_category
       FROM tech_performance ${where}
       ORDER BY branch, dispatch_date DESC, tech_name_clean`, params);
    res.json({ rows: r.rows, count: r.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/query/parts_sales', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const { conds, params } = buildQueryConds(period, branch);
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pool.query(
      `SELECT branch, period, category, order_no, work_order, part_number,
              part_name, part_type, category_code, function_code, sale_qty,
              retail_price, sale_price_untaxed, cost_untaxed, discount_rate,
              department, pickup_person, sales_person, plate_no
       FROM parts_sales ${where}
       ORDER BY branch, order_no DESC`, params);
    res.json({ rows: r.rows, count: r.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/query/business_query', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const { conds, params } = buildQueryConds(period, branch);
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pool.query(
      `SELECT branch, period, work_order, open_time, settle_date, plate_no,
              vin, status, repair_item, service_advisor, assigned_tech,
              repair_tech, repair_type, car_series, car_model, model_year,
              owner, is_ev, mileage_in, mileage_out
       FROM business_query ${where}
       ORDER BY branch, open_time DESC`, params);
    res.json({ rows: r.rows, count: r.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/periods', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT DISTINCT period FROM repair_income
      UNION SELECT DISTINCT period FROM tech_performance
      UNION SELECT DISTINCT period FROM parts_sales
      UNION SELECT DISTINCT period FROM revenue_targets
      ORDER BY period DESC`);
    const dbPeriods = new Set(r.rows.map(r => r.period));
    const now = new Date();
    const extraPeriods = new Set();
    for (let y = now.getFullYear(); y >= now.getFullYear() - 1; y--) {
      for (let m = 12; m >= 1; m--) {
        extraPeriods.add(`${y}${String(m).padStart(2,'0')}`);
      }
    }
    const allPeriods = [...new Set([...dbPeriods, ...extraPeriods])].sort().reverse();
    res.json(allPeriods);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 美容工時代碼 ──
router.get('/beauty-op-hours', async (req, res) => {
  try {
    const r = await pool.query(`SELECT op_code, description, standard_hours FROM beauty_op_hours ORDER BY op_code`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/beauty-op-hours/:op_code', async (req, res) => {
  const op_code = req.params.op_code.trim();
  const { description, standard_hours } = req.body;
  if (!op_code) return res.status(400).json({ error: 'op_code 為必填' });
  const hours = parseFloat(standard_hours);
  if (isNaN(hours) || hours < 0) return res.status(400).json({ error: 'standard_hours 必須為正數' });
  try {
    await pool.query(
      `INSERT INTO beauty_op_hours (op_code, description, standard_hours, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (op_code) DO UPDATE SET description=$2, standard_hours=$3, updated_at=NOW()`,
      [op_code, description || '', hours]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/beauty-op-hours/:op_code', async (req, res) => {
  try {
    await pool.query(`DELETE FROM beauty_op_hours WHERE op_code=$1`, [req.params.op_code]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
