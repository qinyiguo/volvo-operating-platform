/**
 * routes/managerReview.js  mount: app.use('/api/manager-review', …)
 * -------------------------------------------------------------
 * 主管審核調整獎金（manager_review 表，period+emp_id 唯一）。
 *
 *   GET  /api/manager-review?period=YYYYMM        取該期間所有人的調整
 *   POST /api/manager-review   (feature:bonus_edit)  upsert 單筆調整金額/備註
 *
 * 路徑與其他 router 不同，mount 在 /api/manager-review 而非 /api。
 */
const express = require('express');
const router  = express.Router();
const pool = require('../db/pool');
const { requireAuth, requirePermission } = require('../lib/authMiddleware');

router.use(requireAuth);

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

// 與 routes/bonus.js 共用同一份 lock 邏輯（次月最後一天 23:00 後鎖定）
function bonusPeriodLockAt(period) {
  if (!period || !/^\d{6}$/.test(String(period))) return null;
  const y = parseInt(period.slice(0, 4));
  const m = parseInt(period.slice(4));
  const lastDay = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, lastDay, 23, 0, 0, 0);
}
function isBonusPeriodLocked(period) {
  const t = bonusPeriodLockAt(period);
  return t ? Date.now() >= t.getTime() : false;
}

// POST /api/manager-review  { period, emp_id, amount, note }
router.post('/', requirePermission('feature:bonus_edit'), async (req, res) => {
  const { period, emp_id, amount, note } = req.body;
  if (!period || !emp_id) return res.status(400).json({ error: '缺少必要欄位' });
  if (isBonusPeriodLocked(period)) {
    const lockAt = bonusPeriodLockAt(period);
    return res.status(403).json({
      error: '此期間（' + period.slice(0,4) + '/' + period.slice(4) + '）獎金表已鎖定，無法修改主管考核',
      locked: true,
      lock_at: lockAt && lockAt.toISOString(),
    });
  }
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
