/**
 * routes/techWage.js  mount: app.use('/api', …)
 * -------------------------------------------------------------
 * 工資代碼追蹤設定 + 工資代碼統計矩陣。
 *
 *   GET    /api/tech-wage-config               工資代碼設定列表
 *   POST   /api/tech-wage-config               (feature:bonus_edit)
 *   PUT    /api/tech-wage-config/:id           (feature:bonus_edit)
 *   DELETE /api/tech-wage-config/:id           (feature:bonus_edit)
 *   GET    /api/stats/tech-wage-matrix         依工資代碼統計台數 / 金額 / 工時
 */
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requirePermission, loadBranchScope, branchScopeMiddleware } = require('../lib/authMiddleware');

router.use(requireAuth);
router.use(loadBranchScope);
router.use(branchScopeMiddleware());

router.get('/tech-wage-config', async (req, res) => {
  try { res.json((await pool.query(`SELECT * FROM tech_wage_configs ORDER BY id`)).rows); } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

router.post('/tech-wage-config', requirePermission('feature:tech_config_edit'), async (req, res) => {
  const { config_name, description, work_codes, account_types, stat_method } = req.body;
  if (!config_name) return res.status(400).json({ error: '名稱為必填' });
  if (!Array.isArray(work_codes) || !work_codes.length) return res.status(400).json({ error: '至少需要一個工資代碼' });
  const method = ['count','amount','hours'].includes(stat_method) ? stat_method : 'count';
  try {
    const r = await pool.query(
      `INSERT INTO tech_wage_configs (config_name,description,work_codes,account_types,stat_method)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [config_name.trim(), description||'', JSON.stringify(work_codes), JSON.stringify(account_types||[]), method]
    );
    res.json(r.rows[0]);
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

router.put('/tech-wage-config/:id', requirePermission('feature:tech_config_edit'), async (req, res) => {
  const { config_name, description, work_codes, account_types, stat_method } = req.body;
  if (!config_name) return res.status(400).json({ error: '名稱為必填' });
  const method = ['count','amount','hours'].includes(stat_method) ? stat_method : 'count';
  try {
    const r = await pool.query(
      `UPDATE tech_wage_configs SET config_name=$1,description=$2,work_codes=$3,account_types=$4,stat_method=$5,updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [config_name.trim(), description||'', JSON.stringify(work_codes||[]), JSON.stringify(account_types||[]), method, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: '找不到設定' });
    res.json(r.rows[0]);
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

router.delete('/tech-wage-config/:id', requirePermission('feature:tech_config_edit'), async (req, res) => {
  try { await pool.query(`DELETE FROM tech_wage_configs WHERE id=$1`, [req.params.id]); res.json({ ok:true }); } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

// ── 工資代碼矩陣統計 ──
router.get('/stats/tech-wage-matrix', async (req, res) => {
  const { period, branch } = req.query;
  try {
    const configs = (await pool.query(`SELECT * FROM tech_wage_configs ORDER BY id`)).rows;
    if (!configs.length) return res.json({ configs:[], rows:[], colTotals:{} });

    const buildWorkCodeCond = (workCodes, startIdx) => {
      const conds = []; const params = [];
      let idx = startIdx;
      for (const wc of workCodes) {
        if (wc.type === 'range') {
          conds.push(`work_code BETWEEN $${idx++} AND $${idx++}`);
          params.push(wc.from, wc.to);
        } else {
          conds.push(`work_code=$${idx++}`);
          params.push(wc.value);
        }
      }
      return { cond: conds.length ? `(${conds.join(' OR ')})` : '1=1', params };
    };

    const saMap = {};
    for (const cfg of configs) {
      const workCodes  = cfg.work_codes || [];
      const acTypes    = cfg.account_types || [];
      if (!workCodes.length) continue;

      let p = []; let idx = 1;
      const baseConds = [];
      if (period) { baseConds.push(`period=$${idx++}`); p.push(period); }
      if (branch) { baseConds.push(`branch=$${idx++}`); p.push(branch); }
      if (acTypes.length) { baseConds.push(`account_type=ANY($${idx++})`); p.push(acTypes); }

      const wcResult = buildWorkCodeCond(workCodes, idx);
      baseConds.push(wcResult.cond);
      p = p.concat(wcResult.params);

      const where    = baseConds.length ? 'WHERE ' + baseConds.join(' AND ') : '';
      const statExpr = cfg.stat_method === 'amount' ? 'SUM(wage)' :
                       cfg.stat_method === 'hours'  ? 'SUM(standard_hours)' :
                       'COUNT(DISTINCT work_order)';
      const r = await pool.query(
        `SELECT branch, tech_name_clean AS name, ${statExpr} AS val FROM tech_performance ${where} GROUP BY branch, tech_name_clean`,
        p
      );
      for (const row of r.rows) {
        const key = `${row.branch}|||${row.name}`;
        if (!saMap[key]) saMap[key] = { branch:row.branch, name:row.name, configs:{} };
        saMap[key].configs[cfg.id] = parseFloat(row.val || 0);
      }
    }

    const rows = Object.values(saMap).sort((a,b) => {
      if (a.branch !== b.branch) return a.branch < b.branch ? -1 : 1;
      const aSum = Object.values(a.configs).reduce((s,v) => s+v, 0);
      const bSum = Object.values(b.configs).reduce((s,v) => s+v, 0);
      return bSum - aSum;
    });
    const colTotals = {};
    for (const cfg of configs) {
      colTotals[cfg.id] = rows.reduce((s,row) => s + (row.configs[cfg.id]||0), 0);
    }
    res.json({ configs, rows, colTotals });
  } catch(err) { console.error('[' + req.method + ' ' + req.originalUrl + ']', err); res.status(500).json({ error: '內部錯誤，請稍後再試' }); }
});

module.exports = router;
