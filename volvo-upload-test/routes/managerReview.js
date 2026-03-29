const express = require('express');
const router  = express.Router();
const pool    = require('../db');

// GET /api/manager-review?period=202603
router.get('/', async (req, res) => {
  const { period } = req.query;
  if (!period) return res.json([]);
  try {
    const r = await pool.query(
      'SELECT emp_id, amount, note FROM manager_review WHERE period=$1',
      [period]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/manager-review  { period, emp_id, amount, note }
router.post('/', async (req, res) => {
  const { period, emp_id, amount, note } = req.body;
  if (!period || !emp_id) return res.status(400).json({ error: '缺少必要欄位' });
  try {
    await pool.query(`
      INSERT INTO manager_review (period, emp_id, amount, note)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (period, emp_id)
      DO UPDATE SET amount=$3, note=$4, updated_at=NOW()
    `, [period, emp_id, parseInt(amount)||0, note||null]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
