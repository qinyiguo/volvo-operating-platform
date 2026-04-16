const router = require('express').Router();
const pool   = require('../db/pool');

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
          bonus_pct, role_amounts, target_factories, active, sort_order, person_type, tiers, stat_method } = req.body;
  if (!rule_name) return res.status(400).json({ error: '名稱為必填' });
  try {
// ✅ 修正後 — 加上 tiers, stat_method
  const r = await pool.query(`
    INSERT INTO promo_bonus_configs
      (rule_name, rule_type, sa_config_id, per_qty, bonus_per_unit,
       part_catalog_types, paycode_types, discount_min, discount_max,
       bonus_pct, role_amounts, target_factories, active, sort_order,
       person_type, tiers, stat_method)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *
  `, [rule_name.trim(), rule_type||'sa_qty', sa_config_id||null,
      per_qty||1, bonus_per_unit||0,
      JSON.stringify(part_catalog_types||[]), JSON.stringify(paycode_types||[]),
      discount_min!=null?parseFloat(discount_min):null,
      discount_max!=null?parseFloat(discount_max):null,
      bonus_pct||0, JSON.stringify(role_amounts||{}),
      JSON.stringify(target_factories||[]), active!==false, sort_order||0,
      person_type||'sales_person', JSON.stringify(tiers||[]), stat_method||'amount']);
      res.json(r.rows[0]);
    } catch(err) { res.status(500).json({ error: err.message }); }
  });

router.put('/promo-bonus/configs/:id', async (req, res) => {
  const { rule_name, rule_type, sa_config_id, per_qty, bonus_per_unit,
          part_catalog_types, paycode_types, discount_min, discount_max,
          bonus_pct, role_amounts, target_factories, active, sort_order, person_type, tiers, stat_method } = req.body;
  if (!rule_name) return res.status(400).json({ error: '名稱為必填' });
  try {
    const r = await pool.query(`
      UPDATE promo_bonus_configs SET
        rule_name=$1, rule_type=$2, sa_config_id=$3, per_qty=$4, bonus_per_unit=$5,
        part_catalog_types=$6, paycode_types=$7, discount_min=$8, discount_max=$9,
        bonus_pct=$10, role_amounts=$11, target_factories=$12, active=$13, sort_order=$14,
      person_type=$15, tiers=$16, stat_method=$17, updated_at=NOW()
      WHERE id=$18 RETURNING *
    `, [rule_name.trim(), rule_type||'sa_qty', sa_config_id||null,
        per_qty||1, bonus_per_unit||0,
        JSON.stringify(part_catalog_types||[]), JSON.stringify(paycode_types||[]),
        discount_min!=null?parseFloat(discount_min):null,
        discount_max!=null?parseFloat(discount_max):null,
        bonus_pct||0, JSON.stringify(role_amounts||{}),
        JSON.stringify(target_factories||[]), active!==false, sort_order||0,
        person_type||'sales_person', JSON.stringify(tiers||[]), stat_method||'amount',
        req.params.id]);
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

    await Promise.all(configs.map(async (cfg) => {
      resultsByConfig[cfg.id] = { config: cfg, byBranch: {} };

      await Promise.all(BRANCHES.map(async (br) => {
        const personResults = {};

        // ── sa_qty ──
        if (cfg.rule_type === 'sa_qty') {
          if (!cfg.sa_config_id) return;
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
          const personType = cfg.person_type || 'sales_person';

          if (workCodes.length > 0) {
            const conds = ['tp.period=$1','tp.branch=$2'];
            const p = [period, br]; let idx = 3;
            if (acTypes.length) { conds.push(`tp.account_type=ANY($${idx++})`); p.push(acTypes); }
            const wcConds = [];
            for (const wc of workCodes) {
              if (wc.includes('-')) {
                const [fr,to] = wc.split('-').map(s=>s.trim());
                wcConds.push(`(tp.work_code BETWEEN $${idx} AND $${idx+1})`); idx+=2;
                p.push(fr, to);
              } else {
                wcConds.push(`tp.work_code=$${idx++}`);
                p.push(wc);
              }
            }
            if (wcConds.length) conds.push(`(${wcConds.join(' OR ')})`);
            const expr = statMethod==='count'  ? 'COUNT(DISTINCT tp.work_order)'
                       : statMethod==='quantity'? 'SUM(tp.standard_hours)'
                       : 'SUM(tp.wage)';
            let r;
            if (personType === 'sales_person') {
              r = await pool.query(`
                SELECT COALESCE(NULLIF(ps_uniq.person_name,''),'（未知）') AS person_name,
                       COALESCE(${expr},0) AS actual
                FROM tech_performance tp
                LEFT JOIN (
                  SELECT DISTINCT ON (branch, work_order) branch, work_order, sales_person AS person_name
                  FROM parts_sales ORDER BY branch, work_order, id
                ) ps_uniq ON ps_uniq.work_order=tp.work_order AND ps_uniq.branch=tp.branch
                WHERE ${conds.join(' AND ')} GROUP BY ps_uniq.person_name`, p);
            } else {
              r = await pool.query(`
                SELECT COALESCE(NULLIF(tp.tech_name_clean,''),'（未知）') AS person_name,
                       COALESCE(${expr},0) AS actual
                FROM tech_performance tp
                WHERE ${conds.join(' AND ')} GROUP BY tp.tech_name_clean`, p);
            }
            for (const row of r.rows) {
              const units = Math.floor(parseFloat(row.actual||0) / perQty);
              if (units > 0) personResults[row.person_name] = Math.round(units * bonusUnit);
            }
          } else {
            const conds = ['period=$1','branch=$2'];
            const p = [period, br]; let idx = 3;
            if (catCodes.length)  { conds.push(`category_code=ANY($${idx++})`); p.push(catCodes); }
            if (funcCodes.length) { conds.push(`function_code=ANY($${idx++})`); p.push(funcCodes); }
            if (partNums.length)  { conds.push(`part_number=ANY($${idx++})`);   p.push(partNums); }
            if (partTypes.length) { conds.push(`part_type=ANY($${idx++})`);     p.push(partTypes); }
            const personCol = personType === 'tech' ? 'pickup_person' : 'sales_person';
            const expr = statMethod==='quantity'?'SUM(sale_qty)':statMethod==='count'?'COUNT(*)':'SUM(sale_price_untaxed)';
            const r = await pool.query(`
              SELECT COALESCE(NULLIF(${personCol},''),'（未知）') AS person_name,
                     COALESCE(${expr},0) AS actual
              FROM parts_sales WHERE ${conds.join(' AND ')} GROUP BY ${personCol}`, p);
            for (const row of r.rows) {
              const units = Math.floor(parseFloat(row.actual||0) / perQty);
              if (units > 0) personResults[row.person_name] = Math.round(units * bonusUnit);
            }
          }

        // ── parts_discount ──
        } else if (cfg.rule_type === 'parts_discount') {
          const catTypes  = cfg.part_catalog_types || [];
          const payCodes  = cfg.paycode_types || [];
          const discMin   = cfg.discount_min;
          const discMax   = cfg.discount_max;
          const bonusPct  = parseFloat(cfg.bonus_pct || 0);
          const conds = ['ps.period=$1','ps.branch=$2'];
          const p = [period, br]; let idx = 3;
          if (catTypes.length) { conds.push(`pc.part_type=ANY($${idx++})`); p.push(catTypes); }
          else                 { conds.push(`pc.part_type IN ('精品','配件')`); }
          if (payCodes.length) { conds.push(`ps.part_type=ANY($${idx++})`); p.push(payCodes); }
          if (discMin != null) { conds.push(`ps.discount_rate >= $${idx++}`); p.push(parseFloat(discMin)); }
          if (discMax != null) { conds.push(`ps.discount_rate <= $${idx++}`); p.push(parseFloat(discMax)); }
          const r = await pool.query(`
            SELECT COALESCE(NULLIF(ps.sales_person,''),'（未知）') AS person_name,
                   COALESCE(SUM(ps.sale_price_untaxed),0) AS total_sales
            FROM parts_sales ps
            JOIN parts_catalog pc ON ps.part_number = pc.part_number
            WHERE ${conds.join(' AND ')}
            GROUP BY ps.sales_person`, p);
          for (const row of r.rows) {
            const sales = parseFloat(row.total_sales || 0);
            if (sales > 0) personResults[row.person_name] = Math.round(sales * bonusPct / 100);
          }

// ── sa_tier：門檻階梯型 ──
} else if (cfg.rule_type === 'sa_tier') {
  if (!cfg.sa_config_id) return;
  const saFilters  = cfg.sa_filters || [];
  const workCodes  = saFilters.filter(f=>f.type==='work_code').map(f=>f.value);
  const catCodes   = saFilters.filter(f=>f.type==='category_code').map(f=>f.value);
  const funcCodes  = saFilters.filter(f=>f.type==='function_code').map(f=>f.value);
  const partNums   = saFilters.filter(f=>f.type==='part_number').map(f=>f.value);
  const partTypes  = saFilters.filter(f=>f.type==='part_type').map(f=>f.value);
  const acTypes    = saFilters.filter(f=>f.type==='account_type').map(f=>f.value);
  const personType = cfg.person_type || 'sales_person';
  const tiers      = cfg.tiers || [];
  const statMethod = cfg.stat_method || 'amount';
  if (!tiers.length) return;

  // 計算每人實績值
  let personActuals = {};
  if (workCodes.length > 0) {
    const conds = ['tp.period=$1','tp.branch=$2'];
    const p = [period, br]; let idx = 3;
    if (acTypes.length) { conds.push(`tp.account_type=ANY($${idx++})`); p.push(acTypes); }
    const wcConds = [];
    for (const wc of workCodes) {
      if (wc.includes('-')) {
        const [fr,to] = wc.split('-').map(s=>s.trim());
        wcConds.push(`(tp.work_code BETWEEN $${idx} AND $${idx+1})`); idx+=2; p.push(fr,to);
      } else { wcConds.push(`tp.work_code=$${idx++}`); p.push(wc); }
    }
    if (wcConds.length) conds.push(`(${wcConds.join(' OR ')})`);
    const expr = statMethod==='count'?'COUNT(DISTINCT tp.work_order)':statMethod==='quantity'?'SUM(tp.standard_hours)':'SUM(tp.wage)';
    const personCol = personType==='sales_person'
      ? 'COALESCE(NULLIF(ps_uniq.person_name,\'\'),\'（未知）\')'
      : 'COALESCE(NULLIF(tp.tech_name_clean,\'\'),\'（未知）\')';
    const joinClause = personType==='sales_person'
      ? `LEFT JOIN (SELECT DISTINCT ON (branch,work_order) branch,work_order,sales_person AS person_name FROM parts_sales ORDER BY branch,work_order,id) ps_uniq ON ps_uniq.work_order=tp.work_order AND ps_uniq.branch=tp.branch`
      : '';
    const r = await pool.query(
      `SELECT ${personCol} AS person_name, COALESCE(${expr},0) AS actual FROM tech_performance tp ${joinClause} WHERE ${conds.join(' AND ')} GROUP BY person_name`, p
    );
    r.rows.forEach(row => { personActuals[row.person_name] = parseFloat(row.actual||0); });
  } else {
    const conds = ['period=$1','branch=$2'];
    const p = [period, br]; let idx = 3;
    if (catCodes.length)  { conds.push(`category_code=ANY($${idx++})`); p.push(catCodes); }
    if (funcCodes.length) { conds.push(`function_code=ANY($${idx++})`); p.push(funcCodes); }
    if (partNums.length)  { conds.push(`part_number=ANY($${idx++})`);   p.push(partNums); }
    if (partTypes.length) { conds.push(`part_type=ANY($${idx++})`);     p.push(partTypes); }
    const personCol = personType==='tech'?'pickup_person':'sales_person';
    const expr = statMethod==='quantity'?'SUM(sale_qty)':statMethod==='count'?'COUNT(*)':'SUM(sale_price_untaxed)';
    const r = await pool.query(
      `SELECT COALESCE(NULLIF(${personCol},''),'（未知）') AS person_name, COALESCE(${expr},0) AS actual FROM parts_sales WHERE ${conds.join(' AND ')} GROUP BY ${personCol}`, p
    );
    r.rows.forEach(row => { personActuals[row.person_name] = parseFloat(row.actual||0); });
  }

// 依門檻計算獎金
  const sortedTiers = [...tiers].sort((a,b) => b.gte - a.gte);
  for (const [name, actual] of Object.entries(personActuals)) {
    const matchTier = sortedTiers.find(t => actual >= t.gte);
    if (!matchTier) continue;
    let bonus = 0;
    if (matchTier.bonus_type === 'pct') {
      bonus = Math.round(actual * matchTier.bonus_value / 100);
    } else if (matchTier.bonus_type === 'per_unit') {
      bonus = Math.round(actual * matchTier.bonus_value);
    } else if (matchTier.bonus_type === 'fixed') {
      bonus = Math.round(matchTier.bonus_value);
    }
    if (bonus > 0) {
      personResults[name] = (personResults[name]||0) + bonus;
      if (!resultsByConfig[cfg.id].tierMatchByBranch) resultsByConfig[cfg.id].tierMatchByBranch = {};
      if (!resultsByConfig[cfg.id].tierMatchByBranch[br]) resultsByConfig[cfg.id].tierMatchByBranch[br] = {};
      resultsByConfig[cfg.id].tierMatchByBranch[br][name] = {
        bonus_value: matchTier.bonus_value,
        bonus_type:  matchTier.bonus_type,
      };
    }
  }
  // ★ 移進來：只在 sa_tier 才有 personActuals
  if (!resultsByConfig[cfg.id].actualByBranch) resultsByConfig[cfg.id].actualByBranch = {};
  resultsByConfig[cfg.id].actualByBranch[br] = personActuals;

// ── sa_pct：比例型（指標銷售總額 × %）──
        } else if (cfg.rule_type === 'sa_pct') {
          if (!cfg.sa_config_id) return;
          const saFilters  = cfg.sa_filters || [];
          const catCodes   = saFilters.filter(f=>f.type==='category_code').map(f=>f.value);
          const funcCodes  = saFilters.filter(f=>f.type==='function_code').map(f=>f.value);
          const partNums   = saFilters.filter(f=>f.type==='part_number').map(f=>f.value);
          const partTypes  = saFilters.filter(f=>f.type==='part_type').map(f=>f.value);
          const workCodes  = saFilters.filter(f=>f.type==='work_code').map(f=>f.value);
          const acTypes    = saFilters.filter(f=>f.type==='account_type').map(f=>f.value);
          const payCodes   = Array.isArray(cfg.paycode_types) ? cfg.paycode_types
                             : (cfg.paycode_types ? JSON.parse(cfg.paycode_types) : []);
          const bonusPct   = parseFloat(cfg.bonus_pct || 0);
          const personType = cfg.person_type || 'sales_person';
          const statMethod = cfg.sa_stat_method || 'amount';

          if (workCodes.length > 0) {
            // ── tech_performance 路徑 ──
            const conds = ['tp.period=$1','tp.branch=$2'];
            const p = [period, br]; let idx = 3;
            if (acTypes.length) { conds.push(`tp.account_type=ANY($${idx++})`); p.push(acTypes); }
            const wcConds = [];
            for (const wc of workCodes) {
              if (wc.includes('-')) {
                const [fr,to] = wc.split('-').map(s=>s.trim());
                wcConds.push(`(tp.work_code BETWEEN $${idx} AND $${idx+1})`); idx+=2; p.push(fr,to);
              } else { wcConds.push(`tp.work_code=$${idx++}`); p.push(wc); }
            }
            if (wcConds.length) conds.push(`(${wcConds.join(' OR ')})`);
            const expr = statMethod==='count'?'COUNT(DISTINCT tp.work_order)':statMethod==='quantity'?'SUM(tp.standard_hours)':'SUM(tp.wage)';
            let r;
            if (personType === 'sales_person') {
              r = await pool.query(`
                SELECT COALESCE(NULLIF(ps_uniq.person_name,''),'（未知）') AS person_name,
                       COALESCE(${expr},0) AS actual
                FROM tech_performance tp
                LEFT JOIN (
                  SELECT DISTINCT ON (branch,work_order) branch,work_order,sales_person AS person_name
                  FROM parts_sales ORDER BY branch,work_order,id
                ) ps_uniq ON ps_uniq.work_order=tp.work_order AND ps_uniq.branch=tp.branch
                WHERE ${conds.join(' AND ')} GROUP BY ps_uniq.person_name`, p);
            } else {
              r = await pool.query(`
                SELECT COALESCE(NULLIF(tp.tech_name_clean,''),'（未知）') AS person_name,
                       COALESCE(${expr},0) AS actual
                FROM tech_performance tp
                WHERE ${conds.join(' AND ')} GROUP BY tp.tech_name_clean`, p);
            }
            for (const row of r.rows) {
              const salesAmt = parseFloat(row.actual||0);
              if (salesAmt > 0) personResults[row.person_name] = Math.round(salesAmt * bonusPct / 100);
            }

          } else {
            // ── parts_sales 路徑（主要路徑）──
            const conds = ['period=$1','branch=$2'];
            const p = [period, br]; let idx = 3;
            if (catCodes.length)  { conds.push(`category_code=ANY($${idx++})`); p.push(catCodes); }
            if (funcCodes.length) { conds.push(`function_code=ANY($${idx++})`); p.push(funcCodes); }
            if (partNums.length)  { conds.push(`part_number=ANY($${idx++})`);   p.push(partNums); }
            if (partTypes.length) { conds.push(`part_type=ANY($${idx++})`);     p.push(partTypes); }
            if (payCodes.length)  { conds.push(`part_type=ANY($${idx++})`);     p.push(payCodes); }
            const personCol = personType==='tech' ? 'pickup_person' : 'sales_person';
            const expr = statMethod==='quantity'?'SUM(sale_qty)':statMethod==='count'?'COUNT(*)':'SUM(sale_price_untaxed)';
            const r = await pool.query(`
              SELECT COALESCE(NULLIF(${personCol},''),'（未知）') AS person_name,
                     COALESCE(${expr},0) AS actual
              FROM parts_sales WHERE ${conds.join(' AND ')} GROUP BY ${personCol}`, p);
            for (const row of r.rows) {
              const salesAmt = parseFloat(row.actual||0);
              if (salesAmt > 0) personResults[row.person_name] = Math.round(salesAmt * bonusPct / 100);
            }
          }
}
        resultsByConfig[cfg.id].byBranch[br] = personResults;  // ← 這行維持在外面
      }));
    }));

    res.json({ configs, resultsByConfig, period });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
