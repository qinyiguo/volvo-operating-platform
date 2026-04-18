const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requirePermission } = require('../lib/authMiddleware');

router.use(requireAuth);

// ── parts-lookup 必須在 /:id 之前 ──
router.get('/sa-config/parts-lookup', async (req, res) => {
  const { type, q } = req.query;
  if (!['category_code','function_code','part_number'].includes(type))
    return res.status(400).json({ error:'無效的 type' });
  try {
    const search = `%${(q||'').trim()}%`;
    let sql, params;
    if (type === 'part_number') {
      sql    = `SELECT part_number AS value, part_name AS label, category_code, function_code FROM parts_catalog WHERE part_number ILIKE $1 OR part_name ILIKE $1 ORDER BY part_number LIMIT 30`;
      params = [search];
    } else {
      sql    = `SELECT ${type} AS value, COUNT(*) AS part_count, STRING_AGG(DISTINCT part_name,'、' ORDER BY part_name) FILTER (WHERE part_name!='') AS sample_names FROM parts_catalog WHERE ${type} ILIKE $1 AND ${type}!='' GROUP BY ${type} ORDER BY part_count DESC LIMIT 30`;
      params = [search];
    }
    res.json((await pool.query(sql, params)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/sa-config', async (req, res) => {
  try {
    res.json((await pool.query(
      `SELECT id,config_name,description,filters,stat_method,person_type,created_at,updated_at
       FROM sa_sales_config ORDER BY id`
    )).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sa-config', requirePermission('feature:bonus_edit'), async (req, res) => {
  const { config_name, description, filters, stat_method, person_type } = req.body;
  if (!config_name) return res.status(400).json({ error:'名稱為必填' });
  if (!Array.isArray(filters)||!filters.length) return res.status(400).json({ error:'至少需要一個篩選條件' });
  const method = ['amount','quantity','count'].includes(stat_method) ? stat_method : 'amount';
  const ptype  = ['sales_person','pickup_person','both'].includes(person_type) ? person_type : 'sales_person';
  try {
    res.json((await pool.query(
      `INSERT INTO sa_sales_config (config_name,description,filters,stat_method,person_type)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [config_name.trim(), description||'', JSON.stringify(filters), method, ptype]
    )).rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/sa-config/:id', requirePermission('feature:bonus_edit'), async (req, res) => {
  const { config_name, description, filters, stat_method, person_type } = req.body;
  if (!config_name) return res.status(400).json({ error:'名稱為必填' });
  if (!Array.isArray(filters)||!filters.length) return res.status(400).json({ error:'至少需要一個篩選條件' });
  const method = ['amount','quantity','count'].includes(stat_method) ? stat_method : 'amount';
  const ptype  = ['sales_person','pickup_person','both'].includes(person_type) ? person_type : 'sales_person';
  try {
    const r = await pool.query(
      `UPDATE sa_sales_config
       SET config_name=$1,description=$2,filters=$3,stat_method=$4,person_type=$5,updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [config_name.trim(), description||'', JSON.stringify(filters), method, ptype, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error:'找不到設定' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/sa-config/:id', requirePermission('feature:bonus_edit'), async (req, res) => {
  try { await pool.query(`DELETE FROM sa_sales_config WHERE id=$1`,[req.params.id]); res.json({ ok:true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
