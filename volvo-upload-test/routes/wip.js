const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../lib/authMiddleware');

router.use(requireAuth);

// ── WIP 狀態常數 ──
const WIP_STATUSES = ['等料', '施工中', '待修', '待客確認', '已可結帳', '暫緩', '已結清', '未填寫'];

// GET /api/wip/status?period=YYYYMM&branch=AMA
// 取得指定 period/branch 的 WIP 工單狀態備註
router.get('/wip/status', async (req, res) => {
  const { period, branch } = req.query;
  if (!period) return res.status(400).json({ error: 'period 為必填' });
  try {
    const params = [period]; let idx = 2;
    const branchCond = branch ? ` AND bq.branch=$${idx++}` : '';
    if (branch) params.push(branch);

    const r = await pool.query(`
      SELECT wsn.*
      FROM wip_status_notes wsn
      WHERE wsn.work_order IN (
        SELECT bq.work_order
        FROM business_query bq
        WHERE bq.open_time < (to_date($1 || '01', 'YYYYMMDD') + interval '1 month')
        ${branchCond}
        AND COALESCE(bq.repair_type, '') NOT ILIKE '%PV%'
        AND NOT EXISTS (
          SELECT 1 FROM repair_income ri
          WHERE ri.work_order = bq.work_order
            AND ri.branch     = bq.branch
        )
      )
      AND COALESCE(wsn.wip_status, '未填寫') != '已結清'
    `, params);

    // 回傳為 { work_order|||branch: {...} } 格式方便前端查詢
    const statusMap = {};
    r.rows.forEach(row => {
      statusMap[`${row.work_order}|||${row.branch}`] = row;
    });
    res.json({ rows: r.rows, statusMap });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/wip/status/:work_order/:branch — 單筆更新
router.put('/wip/status/:work_order/:branch', async (req, res) => {
  const { work_order, branch } = req.params;
  const { wip_status, eta_date, reason, updated_by } = req.body;
  if (!WIP_STATUSES.includes(wip_status)) {
    return res.status(400).json({ error: `無效的狀態：${wip_status}` });
  }
  try {
    await pool.query(`
      INSERT INTO wip_status_notes
        (work_order, branch, wip_status, eta_date, reason, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (work_order, branch) DO UPDATE SET
        wip_status = $3,
        eta_date   = $4,
        reason     = $5,
        updated_by = $6,
        updated_at = NOW()
    `, [work_order, branch, wip_status, eta_date || null, reason || '', updated_by || '']);
    res.json({ ok: true, work_order, branch, wip_status });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/wip/status/batch — 批次更新
router.put('/wip/status/batch', async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || !entries.length)
    return res.status(400).json({ error: '無資料' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      if (!e.work_order || !e.branch) continue;
      await client.query(`
        INSERT INTO wip_status_notes
          (work_order, branch, wip_status, eta_date, reason, updated_by, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (work_order, branch) DO UPDATE SET
          wip_status = $3,
          eta_date   = $4,
          reason     = $5,
          updated_by = $6,
          updated_at = NOW()
      `, [e.work_order, e.branch, e.wip_status || '未填寫',
          e.eta_date || null, e.reason || '', e.updated_by || '']);
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: entries.length });
  } catch(err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// DELETE /api/wip/status/:work_order/:branch — 清除狀態（回到未填寫）
router.delete('/wip/status/:work_order/:branch', async (req, res) => {
  const { work_order, branch } = req.params;
  try {
    await pool.query(`DELETE FROM wip_status_notes WHERE work_order=$1 AND branch=$2`, [work_order, branch]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/wip/status-options — 前端用，取得所有狀態選項
router.get('/wip/status-options', (req, res) => {
  res.json(WIP_STATUSES);
});

module.exports = router;
