/**
 * routes/query.js  mount: app.use('/api', …)
 * -------------------------------------------------------------
 * 四大資料表的全文查詢端點（/query.html 用）+ 系統設定雜項。
 *
 * 查詢（requireAuth）:
 *   GET /api/query/repair_income | tech_performance | parts_sales | business_query
 *   GET /api/periods                        所有有效期間清單
 *   GET /api/counts                         各資料表筆數
 *
 * 系統設定（寫入需 page:settings）:
 *   GET/PUT /api/income-config/:key         收入設定（外賣 category 等）
 *   GET/PUT/DELETE /api/working-days        工作天數設定
 *   GET/PUT/DELETE /api/beauty-op-hours/:op_code  美容工時代碼標準時數
 *
 * 查詢端點不加 LIMIT（供前端 CSV 匯出用）。若畫面慢請先看
 * period + branch 索引是否有建。
 */
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requirePermission, loadBranchScope, branchScopeMiddleware } = require('../lib/authMiddleware');

router.use(requireAuth);
router.use(loadBranchScope);
// 只 scope GET：PUT/DELETE 由 feature:sys_config_edit 把關
router.use(branchScopeMiddleware());

// ── 收入設定 ──
router.get('/income-config', async (req, res) => {
  try {
    const r = await pool.query(`SELECT config_key, config_value, description FROM income_config ORDER BY id`);
    const map = {}; r.rows.forEach(row => { map[row.config_key] = row.config_value; });
    res.json({ rows: r.rows, map });
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

router.put('/income-config/:key', requirePermission('feature:sys_config_edit'), async (req, res) => {
  const { value } = req.body;
  if (!value) return res.status(400).json({ error:'值為必填' });
  try {
    await pool.query(`UPDATE income_config SET config_value=$1,updated_at=NOW() WHERE config_key=$2`,[value.trim(),req.params.key]);
    res.json({ ok:true });
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
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
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

router.put('/working-days', requirePermission('feature:sys_config_edit'), async (req, res) => {
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
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

router.delete('/working-days', requirePermission('feature:sys_config_edit'), async (req, res) => {
  const { branch, period } = req.query;
  if (!branch || !period) return res.status(400).json({ error: 'branch 和 period 為必填' });
  try {
    await pool.query(`DELETE FROM working_days_config WHERE branch=$1 AND period=$2`, [branch, period]);
    res.json({ ok: true });
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
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
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

router.get('/history', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM upload_history ORDER BY created_at DESC LIMIT 20')).rows); } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

router.get('/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status:'ok', db:'connected' }); }
  catch (err) {
    console.error('[' + req.method + ' ' + req.originalUrl + ']', err);
    res.status(500).json({ status:'error', error:'db_unavailable' });
  }
});

router.get('/debug/columns', async (req, res) => {
  try { res.json((await pool.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_name='business_query' ORDER BY ordinal_position`)).rows); } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// ── 明細查詢 ──
const buildQueryConds = (period, branch, prefix) => {
  const p = prefix ? `${prefix}.` : '';
  const conds = []; const params = []; let idx = 1;
  if (period) { conds.push(`${p}period=$${idx++}`); params.push(period); }
  if (branch) { conds.push(`${p}branch=$${idx++}`); params.push(branch); }
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
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// ── 技師績效：JOIN repair_income 取得服務顧問 ──
router.get('/query/tech_performance', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const { conds, params } = buildQueryConds(period, branch, 'tp');
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pool.query(
      `SELECT tp.branch, tp.period, tp.tech_name_clean, tp.dispatch_date, tp.work_order,
              tp.work_code, tp.task_content, tp.account_type, tp.standard_hours, tp.wage,
              tp.discount, tp.wage_category,
              ri.service_advisor
       FROM tech_performance tp
       LEFT JOIN LATERAL (
         SELECT service_advisor FROM repair_income
         WHERE work_order = tp.work_order AND branch = tp.branch
         LIMIT 1
       ) ri ON true
       ${where}
       ORDER BY tp.branch, tp.dispatch_date DESC, tp.tech_name_clean`, params);
    res.json({ rows: r.rows, count: r.rows.length });
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// ── 零件銷售：JOIN repair_income 取得服務顧問、JOIN parts_catalog 取得型錄類別 ──
router.get('/query/parts_sales', async (req, res) => {
  try {
    const { period, branch } = req.query;
    const { conds, params } = buildQueryConds(period, branch, 'ps');
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pool.query(
      `SELECT ps.branch, ps.period, ps.category, ps.order_no, ps.work_order, ps.part_number,
              ps.part_name,
              pc.part_type   AS catalog_type,
              ps.part_type,
              ps.category_code, ps.function_code, ps.sale_qty,
              ps.retail_price, ps.sale_price_untaxed, ps.cost_untaxed, ps.discount_rate,
              ps.department, ps.pickup_person, ps.sales_person, ps.plate_no,
              ri.service_advisor
       FROM parts_sales ps
       LEFT JOIN parts_catalog pc ON pc.part_number = ps.part_number
       LEFT JOIN LATERAL (
         SELECT service_advisor FROM repair_income
         WHERE work_order = ps.work_order AND branch = ps.branch
         LIMIT 1
       ) ri ON true
       ${where}
       ORDER BY ps.branch, ps.order_no DESC`, params);
    res.json({ rows: r.rows, count: r.rows.length });
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
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
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
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
    // 涵蓋 next year + this year + last year，讓使用者能提前選隔年月份做規劃
    // （例如 12 月先把隔年 1 月目標填好）
    for (let y = now.getFullYear() + 1; y >= now.getFullYear() - 1; y--) {
      for (let m = 12; m >= 1; m--) {
        extraPeriods.add(`${y}${String(m).padStart(2,'0')}`);
      }
    }
    const allPeriods = [...new Set([...dbPeriods, ...extraPeriods])].sort().reverse();
    res.json(allPeriods);
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// ── 美容工時代碼 ──
router.get('/beauty-op-hours', async (req, res) => {
  try {
    const r = await pool.query(`SELECT op_code, description, standard_hours FROM beauty_op_hours ORDER BY op_code`);
    res.json(r.rows);
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

router.put('/beauty-op-hours/:op_code', requirePermission('feature:sys_config_edit'), async (req, res) => {
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
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

router.delete('/beauty-op-hours/:op_code', requirePermission('feature:sys_config_edit'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM beauty_op_hours WHERE op_code=$1`, [req.params.op_code]);
    res.json({ ok: true });
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

module.exports = router;
