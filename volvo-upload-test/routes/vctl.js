/**
 * routes/vctl.js  mount: app.use('/api', …)
 * -------------------------------------------------------------
 * VCTL 商務政策指標（performance.html 底部用）。
 *
 *   GET    /api/vctl/metrics           指標定義列表
 *   POST   /api/vctl/metrics           (feature:bonus_edit)
 *   PUT    /api/vctl/metrics/:id       (feature:bonus_edit)
 *   DELETE /api/vctl/metrics/:id       (feature:bonus_edit)
 *   GET    /api/stats/vctl             計算各指標售價 / 成本 / 毛利率實績
 *
 * source_type: parts / accessories / boutique / wage
 */
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requirePermission } = require('../lib/authMiddleware');

router.use(requireAuth);

// ── CRUD ──
router.get('/vctl/metrics', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM vctl_metrics ORDER BY sort_order, id')).rows); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/vctl/metrics', requirePermission('feature:bonus_edit'), async (req, res) => {
  const { metric_name, description, source_type, calc_method, account_types, filters, unit, sort_order } = req.body;
  if (!metric_name) return res.status(400).json({ error: '名稱為必填' });
  try {
    const r = await pool.query(
      `INSERT INTO vctl_metrics (metric_name,description,source_type,calc_method,account_types,filters,unit,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [metric_name.trim(), description||'', source_type||'parts', calc_method||'amount',
       JSON.stringify(account_types||[]), JSON.stringify(filters||[]), unit||'', sort_order||0]
    );
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/vctl/metrics/:id', requirePermission('feature:bonus_edit'), async (req, res) => {
  const { metric_name, description, source_type, calc_method, account_types, filters, unit, sort_order } = req.body;
  if (!metric_name) return res.status(400).json({ error: '名稱為必填' });
  try {
    const r = await pool.query(
      `UPDATE vctl_metrics SET metric_name=$1,description=$2,source_type=$3,calc_method=$4,
       account_types=$5,filters=$6,unit=$7,sort_order=$8,updated_at=NOW() WHERE id=$9 RETURNING *`,
      [metric_name.trim(), description||'', source_type||'parts', calc_method||'amount',
       JSON.stringify(account_types||[]), JSON.stringify(filters||[]), unit||'', sort_order||0, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: '找不到指標' });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/vctl/metrics/:id', requirePermission('feature:bonus_edit'), async (req, res) => {
  try { await pool.query('DELETE FROM vctl_metrics WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Stats ──
router.get('/stats/vctl', async (req, res) => {
  const { period, branch } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const metrics = (await pool.query('SELECT * FROM vctl_metrics ORDER BY sort_order, id')).rows;
    if (!metrics.length) return res.json({ metrics: [], results: [] });
    const BRANCHES = branch ? [branch] : ['AMA','AMC','AMD'];
    const results  = [];

    for (const m of metrics) {
      const filters  = m.filters      || [];
      const acTypes  = m.account_types || [];
      const mr       = { metric_id: m.id, branches: {} };

      for (const br of BRANCHES) {
        let amount=0, cost=0, qty=0, cnt=0;
        try {
          if (m.source_type === 'wage') {
            // tech_performance
            const conds=['period=$1','branch=$2']; const p=[period,br]; let idx=3;
            if (acTypes.length) { conds.push(`account_type=ANY($${idx++})`); p.push(acTypes); }
            const wcs = filters.filter(f=>f.type==='work_code');
            for (const wc of wcs) {
              if (wc.value.includes('-')) {
                const [fr,to]=wc.value.split('-').map(s=>s.trim());
                conds.push(`work_code BETWEEN $${idx++} AND $${idx++}`); p.push(fr,to);
              } else { conds.push(`work_code=$${idx++}`); p.push(wc.value); }
            }
            const r = await pool.query(
              `SELECT COALESCE(SUM(wage),0) AS wage, COALESCE(SUM(standard_hours),0) AS hours,
                      COALESCE(COUNT(DISTINCT work_order),0) AS cnt
               FROM tech_performance WHERE ${conds.join(' AND ')}`, p);
            amount = parseFloat(r.rows[0]?.wage  || 0);
            cost   = parseFloat(r.rows[0]?.hours || 0); // hours stored in cost slot
            cnt    = parseInt(r.rows[0]?.cnt     || 0);

          } else if (m.source_type === 'boutique' || m.source_type === 'accessories') {
            const catType = m.source_type === 'boutique' ? '精品' : '配件';
            const conds=['ps.period=$1','ps.branch=$2',`pc.part_type=$3`];
            const p=[period,br,catType]; let idx=4;
            if (acTypes.length) { conds.push(`ps.part_type=ANY($${idx++})`); p.push(acTypes); }
            const cc=filters.filter(f=>f.type==='category_code').map(f=>f.value);
            const fc=filters.filter(f=>f.type==='function_code').map(f=>f.value);
            const pn=filters.filter(f=>f.type==='part_number').map(f=>f.value);
            if(cc.length){conds.push(`ps.category_code=ANY($${idx++})`);p.push(cc);}
            if(fc.length){conds.push(`ps.function_code=ANY($${idx++})`);p.push(fc);}
            if(pn.length){conds.push(`ps.part_number=ANY($${idx++})`);p.push(pn);}
            const r = await pool.query(
              `SELECT COALESCE(SUM(ps.sale_price_untaxed),0) AS amount,
                      COALESCE(SUM(ps.cost_untaxed),0) AS cost,
                      COALESCE(SUM(ps.sale_qty),0) AS qty, COUNT(*) AS cnt
               FROM parts_sales ps JOIN parts_catalog pc ON ps.part_number=pc.part_number
               WHERE ${conds.join(' AND ')}`, p);
            amount = parseFloat(r.rows[0]?.amount || 0);
            cost   = parseFloat(r.rows[0]?.cost   || 0);
            qty    = parseFloat(r.rows[0]?.qty     || 0);
            cnt    = parseInt(r.rows[0]?.cnt       || 0);

          } else {
            // parts — parts_sales
            // 若有 catalog_type 篩選，需 JOIN parts_catalog 依 part_type 過濾
            const cc=filters.filter(f=>f.type==='category_code').map(f=>f.value);
            const fc=filters.filter(f=>f.type==='function_code').map(f=>f.value);
            const pn=filters.filter(f=>f.type==='part_number').map(f=>f.value);
            const pt=filters.filter(f=>f.type==='part_type').map(f=>f.value);
            const ct=filters.filter(f=>f.type==='catalog_type').map(f=>f.value); // 新增：零件/精品/配件

            if (ct.length) {
              // JOIN parts_catalog，依 pc.part_type 過濾
              const conds=['ps.period=$1','ps.branch=$2']; const p=[period,br]; let idx=3;
              conds.push(`pc.part_type=ANY($${idx++})`); p.push(ct);
              if(acTypes.length){conds.push(`ps.part_type=ANY($${idx++})`);p.push(acTypes);}
              if(cc.length){conds.push(`ps.category_code=ANY($${idx++})`);p.push(cc);}
              if(fc.length){conds.push(`ps.function_code=ANY($${idx++})`);p.push(fc);}
              if(pn.length){conds.push(`ps.part_number=ANY($${idx++})`);p.push(pn);}
              if(pt.length){conds.push(`ps.part_type=ANY($${idx++})`);p.push(pt);}
              const r = await pool.query(
                `SELECT COALESCE(SUM(ps.sale_price_untaxed),0) AS amount,
                        COALESCE(SUM(ps.cost_untaxed),0) AS cost,
                        COALESCE(SUM(ps.sale_qty),0) AS qty, COUNT(*) AS cnt
                 FROM parts_sales ps
                 JOIN parts_catalog pc ON ps.part_number=pc.part_number
                 WHERE ${conds.join(' AND ')}`, p);
              amount = parseFloat(r.rows[0]?.amount || 0);
              cost   = parseFloat(r.rows[0]?.cost   || 0);
              qty    = parseFloat(r.rows[0]?.qty     || 0);
              cnt    = parseInt(r.rows[0]?.cnt       || 0);
            } else {
              // 原本邏輯：直接查 parts_sales（不限零件類別）
              const conds=['period=$1','branch=$2']; const p=[period,br]; let idx=3;
              if(acTypes.length){conds.push(`part_type=ANY($${idx++})`);p.push(acTypes);}
              if(cc.length){conds.push(`category_code=ANY($${idx++})`);p.push(cc);}
              if(fc.length){conds.push(`function_code=ANY($${idx++})`);p.push(fc);}
              if(pn.length){conds.push(`part_number=ANY($${idx++})`);p.push(pn);}
              if(pt.length){conds.push(`part_type=ANY($${idx++})`);p.push(pt);}
              const r = await pool.query(
                `SELECT COALESCE(SUM(sale_price_untaxed),0) AS amount,
                        COALESCE(SUM(cost_untaxed),0) AS cost,
                        COALESCE(SUM(sale_qty),0) AS qty, COUNT(*) AS cnt
                 FROM parts_sales WHERE ${conds.join(' AND ')}`, p);
              amount = parseFloat(r.rows[0]?.amount || 0);
              cost   = parseFloat(r.rows[0]?.cost   || 0);
              qty    = parseFloat(r.rows[0]?.qty     || 0);
              cnt    = parseInt(r.rows[0]?.cnt       || 0);
            }
          }
        } catch(e) {}
        mr.branches[br] = { amount, cost, qty, cnt };
      }
      results.push(mr);
    }
    res.json({ metrics, results });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
