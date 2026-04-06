const router = require('express').Router();
const pool   = require('../db/pool');

// ── 自動補欄位（只跑一次）──
pool.query(`ALTER TABLE promo_bonus_configs ADD COLUMN IF NOT EXISTS person_type VARCHAR(20) DEFAULT 'sales_person'`).catch(()=>{});

// ── CRUD ──
router.get('/promo-bonus/configs', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT pbc.*, ssc.config_name AS sa_config_name, ssc.stat_method AS sa_stat_method
      FROM promo_bonus_configs pbc
      LEFT JOIN sa_sales_config ssc ON ssc.id = pbc.sa_config_id
      ORDER BY pbc.sort_order, pbc.id
    `);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/promo-bonus/configs', async (req, res) => {
  const { rule_name, rule_type, sa_config_id, per_qty, bonus_per_unit,
          part_catalog_types, paycode_types, discount_min, discount_max,
          bonus_pct, role_amounts, target_factories, active, sort_order, person_type } = req.body;
  if (!rule_name) return res.status(400).json({ error: '名稱為必填' });
  try {
    const r = await pool.query(`
      INSERT INTO promo_bonus_configs
        (rule_name, rule_type, sa_config_id, per_qty, bonus_per_unit,
         part_catalog_types, paycode_types, discount_min, discount_max,
         bonus_pct, role_amounts, target_factories, active, sort_order, person_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *
    `, [rule_name.trim(), rule_type||'sa_qty', sa_config_id||null,
        per_qty||1, bonus_per_unit||0,
        JSON.stringify(part_catalog_types||[]), JSON.stringify(paycode_types||[]),
        discount_min!=null?parseFloat(discount_min):null,
        discount_max!=null?parseFloat(discount_max):null,
        bonus_pct||0, JSON.stringify(role_amounts||{}),
        JSON.stringify(target_factories||[]), active!==false, sort_order||0, person_type||'sales_person']);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/promo-bonus/configs/:id', async (req, res) => {
  const { rule_name, rule_type, sa_config_id, per_qty, bonus_per_unit,
          part_catalog_types, paycode_types, discount_min, discount_max,
          bonus_pct, role_amounts, target_factories, active, sort_order, person_type } = req.body;
  if (!rule_name) return res.status(400).json({ error: '名稱為必填' });
  try {
    const r = await pool.query(`
      UPDATE promo_bonus_configs SET
        rule_name=$1, rule_type=$2, sa_config_id=$3, per_qty=$4, bonus_per_unit=$5,
        part_catalog_types=$6, paycode_types=$7, discount_min=$8, discount_max=$9,
        bonus_pct=$10, role_amounts=$11, target_factories=$12, active=$13, sort_order=$14,
        person_type=$15, updated_at=NOW()
      WHERE id=$16 RETURNING *
    `, [rule_name.trim(), rule_type||'sa_qty', sa_config_id||null,
        per_qty||1, bonus_per_unit||0,
        JSON.stringify(part_catalog_types||[]), JSON.stringify(paycode_types||[]),
        discount_min!=null?parseFloat(discount_min):null,
        discount_max!=null?parseFloat(discount_max):null,
        bonus_pct||0, JSON.stringify(role_amounts||{}),
        JSON.stringify(target_factories||[]), active!==false, sort_order||0,
        person_type||'sales_person', req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: '找不到設定' });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/promo-bonus/configs/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM promo_bonus_configs WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 計算結果 ──
router.get('/promo-bonus/results', async (req, res) => {
  const { period, branch } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const cfgRes = await pool.query(`
      SELECT pbc.*, ssc.config_name AS sa_config_name,
             ssc.filters AS sa_filters, ssc.stat_method AS sa_stat_method
      FROM promo_bonus_configs pbc
      LEFT JOIN sa_sales_config ssc ON ssc.id = pbc.sa_config_id
      WHERE pbc.active = true
      ORDER BY pbc.sort_order, pbc.id
    `);
    const configs = cfgRes.rows;
    const BRANCHES = branch && ['AMA','AMC','AMD'].includes(branch)
      ? [branch] : ['AMA','AMC','AMD'];

    const resultsByConfig = {};

    for (const cfg of configs) {
      resultsByConfig[cfg.id] = { config: cfg, byBranch: {} };

      for (const br of BRANCHES) {
        const personResults = {};

if (cfg.rule_type === 'sa_qty') {
  if (!cfg.sa_config_id) continue;
  const perQty    = parseFloat(cfg.per_qty || 1);
  const bonusUnit = parseFloat(cfg.bonus_per_unit || 0);
  const personType = cfg.person_type || 'sales_person';
  const port = process.env.PORT || 3001;
  const view = personType === 'tech' ? 'pickup_person' : 'sales_person';
  try {
    const matrixData = await fetch(
      `http://localhost:${port}/api/stats/sa-sales-matrix?period=${period}&branch=${br}&view=${view}`
    ).then(r => r.json()).catch(() => null);
    if (matrixData) {
      const cfg2 = matrixData.configs.find(c => c.id == cfg.sa_config_id);
      if (cfg2) {
        const statMethod = cfg2.stat_method || 'amount';
        for (const row of matrixData.rows) {
          const colData = row.configs[cfg.sa_config_id];
          if (!colData) continue;
          const val = statMethod === 'quantity' ? colData.qty
                    : statMethod === 'count'    ? colData.cnt
                    : colData.sales;
          const units = Math.floor(parseFloat(val || 0) / perQty);
          if (units > 0) personResults[row.sa_name] = Math.round(units * bonusUnit);
        }
      }
    }
  } catch(e) { console.warn('[promo sa_qty]', e.message); }

        } else if (cfg.rule_type === 'parts_discount') {
          // ── 零件折扣型 ──
          const catTypes  = cfg.part_catalog_types || [];
          const payCodes  = cfg.paycode_types || [];
          const discMin   = cfg.discount_min;
          const discMax   = cfg.discount_max;
          const bonusPct  = parseFloat(cfg.bonus_pct || 0);

          const conds = ['ps.period=$1','ps.branch=$2'];
          const p = [period, br]; let idx = 3;

          if (catTypes.length) {
            conds.push(`pc.part_type=ANY($${idx++})`); p.push(catTypes);
          } else {
            conds.push(`pc.part_type IN ('精品','配件')`);
          }
          if (payCodes.length) { conds.push(`ps.part_type=ANY($${idx++})`); p.push(payCodes); }
          if (discMin != null) { conds.push(`ps.discount_rate >= $${idx++}`); p.push(parseFloat(discMin)); }
          if (discMax != null) { conds.push(`ps.discount_rate <= $${idx++}`); p.push(parseFloat(discMax)); }

          const r = await pool.query(`
            SELECT COALESCE(NULLIF(ps.sales_person,''),'（未知）') AS person_name,
                   COALESCE(SUM(ps.sale_price_untaxed),0) AS total_sales
            FROM parts_sales ps
            JOIN parts_catalog pc ON ps.part_number = pc.part_number
            WHERE ${conds.join(' AND ')}
            GROUP BY ps.sales_person
          `, p);

          for (const row of r.rows) {
            const sales = parseFloat(row.total_sales || 0);
            if (sales > 0) personResults[row.person_name] = Math.round(sales * bonusPct / 100);
          }
        

} else if (cfg.rule_type === 'sa_pct') {
  if (!cfg.sa_config_id) continue;
  const bonusPct   = parseFloat(cfg.bonus_pct || 0);
  const personType = cfg.person_type || 'sales_person';
  const port = process.env.PORT || 3001;
  const view = personType === 'tech' ? 'pickup_person' : 'sales_person';
  try {
    const matrixData = await fetch(
      `http://localhost:${port}/api/stats/sa-sales-matrix?period=${period}&branch=${br}&view=${view}`
    ).then(r => r.json()).catch(() => null);
    if (matrixData) {
      for (const row of matrixData.rows) {
        const colData = row.configs[cfg.sa_config_id];
        if (!colData) continue;
        const sales = parseFloat(colData.sales || 0);
        if (sales > 0) personResults[row.sa_name] = Math.round(sales * bonusPct / 100);
      }
    }
  } catch(e) { console.warn('[promo sa_pct]', e.message); }
        resultsByConfig[cfg.id].byBranch[br] = personResults;
      }
    }

    res.json({ configs, resultsByConfig, period });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
