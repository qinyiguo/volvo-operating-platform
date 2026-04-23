/**
 * routes/promoBonus.js  mount: app.use('/api', …)
 * -------------------------------------------------------------
 * 銷售 / 專案獎金規則與計算（獨立於一般月績效獎金）。
 *
 *   GET    /api/promo-bonus/configs            規則列表
 *   POST   /api/promo-bonus/configs            (feature:bonus_edit)
 *   PUT    /api/promo-bonus/configs/:id        (feature:bonus_edit)
 *   DELETE /api/promo-bonus/configs/:id        (feature:bonus_edit)
 *   GET    /api/promo-bonus/results?period&branch
 *     計算所有啟用中規則的每人獎金結果（把 SA 矩陣快取後平行計算）。
 *
 * 規則類型（rule_type）:
 *   sa_qty          每 N 單/台給固定金額
 *   parts_discount  特定零件類別 × 折扣範圍 × 比例
 *   sa_tier         門檻階梯型（含 tiers 陣列，bonus_type: pct/per_unit/fixed）
 *   sa_pct          指標銷售總額 × %
 *
 * 與 stats.js 直接函式呼叫取 SA 矩陣（不走 HTTP loopback）。
 */
const { computeSaMatrix } = require('./stats');
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requirePermission } = require('../lib/authMiddleware');

router.use(requireAuth);

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

router.post('/promo-bonus/configs', requirePermission('feature:promo_bonus_edit'), async (req, res) => {
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

router.put('/promo-bonus/configs/:id', requirePermission('feature:promo_bonus_edit'), async (req, res) => {
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

router.delete('/promo-bonus/configs/:id', requirePermission('feature:promo_bonus_edit'), async (req, res, next) => {
  try {
    const pre = await pool.query(`SELECT rule_name, rule_type FROM promo_bonus_configs WHERE id=$1`, [req.params.id]);
    await pool.query('DELETE FROM promo_bonus_configs WHERE id=$1', [req.params.id]);
    if (pre.rows.length) {
      req._audit_detail = `刪除銷售獎金規則 id=${req.params.id} name="${pre.rows[0].rule_name}" type=${pre.rows[0].rule_type}`;
    }
    res.json({ ok: true });
  } catch(err) { next(err); }
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

// ★ 預先計算所有需要的矩陣（串行，避免並行重複查詢）
const matrixCache = {};
for (const br of BRANCHES) {
  for (const viewParam of ['sales_person', 'pickup_person']) {
    const key = `${br}-${viewParam}`;
    try {
      matrixCache[key] = await computeSaMatrix(period, br, viewParam);
    } catch(e) {
      matrixCache[key] = { rows: [], configs: [], colTotals: {} };
      console.warn('[matrixCache]', key, e.message);
    }
  }
}
function getCachedMatrix(period, br, viewParam) {
  return matrixCache[`${br}-${viewParam}`] || { rows: [], configs: [], colTotals: {} };
}

    await Promise.all(configs.map(async (cfg) => {
      resultsByConfig[cfg.id] = { config: cfg, byBranch: {} };

      await Promise.all(BRANCHES.map(async (br) => {
        const personResults = {};

        // ── sa_qty ──
        if (cfg.rule_type === 'sa_qty') {
          if (!cfg.sa_config_id) return;
          const statMethod = cfg.sa_stat_method || 'amount';
          const perQty     = parseFloat(cfg.per_qty || 1);
          const bonusUnit  = parseFloat(cfg.bonus_per_unit || 0);
          const personType = cfg.person_type || 'sales_person';

try {
            const viewParam = personType === 'tech' ? 'pickup_person' : 'sales_person';
            const matrixData = getCachedMatrix(period, br, viewParam);
            for (const row of matrixData.rows) {
              if (row.branch !== br) continue;
              const cfgData = row.configs[cfg.sa_config_id];
              if (!cfgData) continue;
              const val = statMethod === 'quantity' ? cfgData.qty
                        : statMethod === 'count'    ? cfgData.cnt
                        : cfgData.sales;
              const units = Math.floor(val / perQty);
              if (units > 0) personResults[row.sa_name] = Math.round(units * bonusUnit);
            }
          } catch(e) {
            console.warn('[sa_qty] computeSaMatrix 失敗:', e.message);
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
  const personType = cfg.person_type || 'sales_person';
  const tiers      = cfg.tiers || [];
  const statMethod = cfg.stat_method || 'amount';
  if (!tiers.length) return;

  // 計算每人實績值
let personActuals = {};
  try {
    const viewParam = personType === 'tech' ? 'pickup_person' : 'sales_person';
    const matrixData = getCachedMatrix(period, br, viewParam);
    for (const row of matrixData.rows) {
      if (row.branch !== br) continue;
      const cfgData = row.configs[cfg.sa_config_id];
      if (!cfgData) continue;
      const val = statMethod === 'quantity' ? cfgData.qty
                : statMethod === 'count'    ? cfgData.cnt
                : cfgData.sales;
      if (val > 0) personActuals[row.sa_name] = val;
    }
  } catch(e) {
    console.warn('[sa_tier] computeSaMatrix 失敗:', e.message);
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
          const bonusPct   = parseFloat(cfg.bonus_pct || 0);
          const personType = cfg.person_type || 'sales_person';
          const statMethod = cfg.sa_stat_method || 'amount';

try {
            const viewParam = personType === 'tech' ? 'pickup_person' : 'sales_person';
            const matrixData = getCachedMatrix(period, br, viewParam);
            for (const row of matrixData.rows) {
              if (row.branch !== br) continue;
              const cfgData = row.configs[cfg.sa_config_id];
              if (!cfgData) continue;
              const val = statMethod === 'quantity' ? cfgData.qty
                        : statMethod === 'count'    ? cfgData.cnt
                        : cfgData.sales;
              if (val > 0) personResults[row.sa_name] = Math.round(val * bonusPct / 100);
            }
          } catch(e) {
            console.warn('[sa_pct] computeSaMatrix 失敗:', e.message);
          }
}
        resultsByConfig[cfg.id].byBranch[br] = personResults;  // ← 這行維持在外面
      }));
    }));

    res.json({ configs, resultsByConfig, period });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
