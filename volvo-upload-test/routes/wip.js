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

// 寫入歷史紀錄 helper（給單筆 / 批次共用）
async function insertWipHistory(client, row, user) {
  await client.query(`
    INSERT INTO wip_status_history
      (work_order, branch, wip_status, eta_date, reason, updated_by, user_id, username, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
  `, [
    row.work_order, row.branch, row.wip_status || null,
    row.eta_date || null, row.reason || '', row.updated_by || '',
    user?.user_id || null, user?.username || null,
  ]);
}

// PUT /api/wip/status/:work_order/:branch — 單筆更新
router.put('/wip/status/:work_order/:branch', async (req, res) => {
  const { work_order, branch } = req.params;
  const { wip_status, eta_date, reason, updated_by } = req.body;
  if (!WIP_STATUSES.includes(wip_status)) {
    return res.status(400).json({ error: `無效的狀態：${wip_status}` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
    `, [work_order, branch, wip_status, eta_date || null, reason || '', updated_by || '']);
    await insertWipHistory(client, {
      work_order, branch, wip_status,
      eta_date: eta_date || null, reason: reason || '',
      updated_by: updated_by || '',
    }, req.user);
    await client.query('COMMIT');
    res.json({ ok: true, work_order, branch, wip_status });
  } catch(err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /api/wip/status/:work_order/:branch/history — 取得單一工單的歷史紀錄
router.get('/wip/status/:work_order/:branch/history', async (req, res) => {
  const { work_order, branch } = req.params;
  try {
    const r = await pool.query(`
      SELECT id, wip_status, eta_date, reason, updated_by, username, created_at
      FROM wip_status_history
      WHERE work_order=$1 AND branch=$2
      ORDER BY created_at DESC
      LIMIT 200
    `, [work_order, branch]);
    res.json({ history: r.rows });
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
      const row = {
        work_order: e.work_order,
        branch:     e.branch,
        wip_status: e.wip_status || '未填寫',
        eta_date:   e.eta_date || null,
        reason:     e.reason || '',
        updated_by: e.updated_by || '',
      };
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
      `, [row.work_order, row.branch, row.wip_status,
          row.eta_date, row.reason, row.updated_by]);
      await insertWipHistory(client, row, req.user);
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
