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
          // ── SA config 數量型 ──
          if (!cfg.sa_config_id) continue;
          const saFilters  = cfg.sa_filters || [];
          const catCodes   = saFilters.filter(f=>f.type==='category_code').map(f=>f.value);
          const funcCodes  = saFilters.filter(f=>f.type==='function_code').map(f=>f.value);
          const partNums   = saFilters.filter(f=>f.type==='part_number').map(f=>f.value);
          const partTypes  = saFilters.filter(f=>f.type==='part_type').map(f=>f.value);
          const workCodes  = saFilters.filter(f=>f.type==='work_code').map(f=>f.value);
          const acTypes    = saFilters.filter(f=>f.type==='account_type').map(f=>f.value);
          const statMethod = cfg.sa_stat_method || 'amount';
          const perQty     = parseFloat(cfg.per_qty || 1);
          const bonusUnit  = parseFloat(cfg.bonus_per_unit || 0);

          if (workCodes.length > 0) {
            // tech_performance based
             const payCodes2 = cfg.paycode_types || [];
            const conds = ['period=$1','branch=$2']; const p = [period, br]; let idx = 3;
            if (acTypes.length) { conds.push(`account_type=ANY($${idx++})`); p.push(acTypes); }
            const wcConds = [];
            for (const wc of workCodes) {
              if (wc.includes('-')) {
                const [fr,to] = wc.split('-').map(s=>s.trim());
                wcConds.push(`(work_code BETWEEN $${idx++} AND $${idx++})`);
                p.push(fr, to);
              } else {
                wcConds.push(`work_code=$${idx++}`);
                p.push(wc);
              }
            }
            if (wcConds.length) conds.push(`(${wcConds.join(' OR ')})`);
            const expr = statMethod==='count'?'COUNT(DISTINCT work_order)':statMethod==='quantity'?'SUM(standard_hours)':'SUM(wage)';
            const r = await pool.query(
              `SELECT tech_name_clean AS person_name, COALESCE(${expr},0) AS actual
               FROM tech_performance WHERE ${conds.join(' AND ')} GROUP BY tech_name_clean`, p);
            for (const row of r.rows) {
              const units = Math.floor(parseFloat(row.actual||0) / perQty);
              if (units > 0) personResults[row.person_name] = Math.round(units * bonusUnit);
            }
          } else {
            // parts_sales based
            const payCodes2 = cfg.paycode_types || [];
            const conds = ['period=$1','branch=$2']; const p = [period, br]; let idx = 3;
            if (catCodes.length)  { conds.push(`category_code=ANY($${idx++})`); p.push(catCodes); }
            if (funcCodes.length) { conds.push(`function_code=ANY($${idx++})`); p.push(funcCodes); }
            if (partNums.length)  { conds.push(`part_number=ANY($${idx++})`);   p.push(partNums); }
            if (partTypes.length) { conds.push(`part_type=ANY($${idx++})`);     p.push(partTypes); }
            
            const personCol = cfg.person_type === 'tech' ? 'pickup_person' : 'sales_person';
            const expr = statMethod==='quantity'?'SUM(sale_qty)':statMethod==='count'?'COUNT(*)':'SUM(sale_price_untaxed)';
            const r = await pool.query(
              `SELECT COALESCE(NULLIF(${personCol},''),'（未知）') AS person_name,
                      COALESCE(${expr},0) AS actual
               FROM parts_sales WHERE ${conds.join(' AND ')} GROUP BY ${personCol}`, p);
            for (const row of r.rows) {
              const units = Math.floor(parseFloat(row.actual||0) / perQty);
              if (units > 0) personResults[row.person_name] = Math.round(units * bonusUnit);
            }
          }

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
          const saFilters  = cfg.sa_filters || [];
          const catCodes   = saFilters.filter(f=>f.type==='category_code').map(f=>f.value);
          const funcCodes  = saFilters.filter(f=>f.type==='function_code').map(f=>f.value);
          const partNums   = saFilters.filter(f=>f.type==='part_number').map(f=>f.value);
          const partTypes  = saFilters.filter(f=>f.type==='part_type').map(f=>f.value);
          const workCodes  = saFilters.filter(f=>f.type==='work_code').map(f=>f.value);
          const acTypes    = saFilters.filter(f=>f.type==='account_type').map(f=>f.value);
          const payCodes2  = cfg.paycode_types || [];
          const bonusPct   = parseFloat(cfg.bonus_pct || 0);
          const personCol  = cfg.person_type === 'tech' ? 'pickup_person' : 'sales_person';

          if (workCodes.length > 0) {
            // tech_performance based（美容等用工資代碼的指標）
            const conds = ['period=$1','branch=$2']; const p = [period, br]; let idx = 3;
            if (acTypes.length) { conds.push(`account_type=ANY($${idx++})`); p.push(acTypes); }
            const wcConds = [];
            for (const wc of workCodes) {
              if (wc.includes('-')) {
                const [fr,to] = wc.split('-').map(s=>s.trim());
                wcConds.push(`(work_code BETWEEN $${idx++} AND $${idx++})`);
                p.push(fr, to);
              } else {
                wcConds.push(`work_code=$${idx++}`);
                p.push(wc);
              }
            }
            if (wcConds.length) conds.push(`(${wcConds.join(' OR ')})`);
            const r = await pool.query(
              `SELECT tech_name_clean AS person_name, COALESCE(SUM(wage),0) AS actual
               FROM tech_performance WHERE ${conds.join(' AND ')} GROUP BY tech_name_clean`, p);
            for (const row of r.rows) {
              const sales = parseFloat(row.actual || 0);
              if (sales > 0) personResults[row.person_name] = Math.round(sales * bonusPct / 100);
            }
            }
          } else {
            // parts_sales based
            const conds = ['period=$1','branch=$2']; const p = [period, br]; let idx = 3;
            if (catCodes.length)  { conds.push(`category_code=ANY($${idx++})`); p.push(catCodes); }
            if (funcCodes.length) { conds.push(`function_code=ANY($${idx++})`); p.push(funcCodes); }
            if (partNums.length)  { conds.push(`part_number=ANY($${idx++})`);   p.push(partNums); }
            if (partTypes.length) { conds.push(`part_type=ANY($${idx++})`);     p.push(partTypes); }
            if (payCodes2.length) { conds.push(`part_type=ANY($${idx++})`);     p.push(payCodes2); }
            const r = await pool.query(
              `SELECT COALESCE(NULLIF(${personCol},''),'（未知）') AS person_name,
                      COALESCE(SUM(sale_price_untaxed),0) AS actual
               FROM parts_sales WHERE ${conds.join(' AND ')} GROUP BY ${personCol}`, p);
            for (const row of r.rows) {
              const sales = parseFloat(row.actual || 0);
              if (sales > 0) personResults[row.person_name] = Math.round(sales * bonusPct / 100);
            }
          }
        
        resultsByConfig[cfg.id].byBranch[br] = personResults;
      }
    }

    res.json({ configs, resultsByConfig, period });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
