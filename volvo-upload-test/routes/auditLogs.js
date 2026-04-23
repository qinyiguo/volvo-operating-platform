/**
 * routes/auditLogs.js
 * 操作紀錄查詢 API
 *
 * 掛載方式（index.js）：
 *   app.use('/api', require('./routes/auditLogs'));
 */

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../lib/authMiddleware');

// ─── 所有需要登入 ────────────────────────────────────────────────
router.use(requireAuth);

// ─── 權限檢查 helper ─────────────────────────────────────────────
function auditAccessGuard(req, res) {
  const { role, branch } = req.user;
  if (role !== 'super_admin' && role !== 'branch_admin') {
    res.status(403).json({ error: '無調閱操作紀錄的權限' });
    return null;
  }
  return { role, branch };
}

// ─── GET /api/audit-logs ─────────────────────────────────────────
// 超管：查全部；據點管理員：只查自己廠的使用者紀錄
router.get('/audit-logs', async (req, res) => {
  const guard = auditAccessGuard(req, res);
  if (!guard) return;

  const {
    page = 1, limit = 100,
    username, action, data_branch, data_period,
    ip_address, date_from, date_to,
    keyword,
  } = req.query;

  const pageSize   = Math.min(parseInt(limit) || 100, 500);
  const pageOffset = (Math.max(parseInt(page), 1) - 1) * pageSize;

  try {
    const conds  = [];
    const params = [];
    let   idx    = 1;

    // 據點管理員只能看自己廠員工的紀錄
    if (guard.role === 'branch_admin' && guard.branch) {
      conds.push(`user_branch = $${idx++}`);
      params.push(guard.branch);
    }

    if (username) {
      conds.push(`(username ILIKE $${idx} OR display_name ILIKE $${idx++})`);
      params.push(`%${username}%`);
    }
    if (action)       { conds.push(`action = $${idx++}`);                params.push(action.toUpperCase()); }
    if (data_branch)  { conds.push(`data_branch = $${idx++}`);           params.push(data_branch); }
    if (data_period)  { conds.push(`data_period = $${idx++}`);           params.push(data_period); }
    if (ip_address)   { conds.push(`ip_address = $${idx++}`);            params.push(ip_address); }
    if (date_from)    { conds.push(`created_at >= $${idx++}::timestamptz`); params.push(date_from); }
    if (date_to)      { conds.push(`created_at <= $${idx++}::timestamptz`); params.push(date_to + 'T23:59:59Z'); }
    if (keyword) {
      conds.push(`(resource ILIKE $${idx} OR resource_detail ILIKE $${idx} OR resource_path ILIKE $${idx++})`);
      params.push(`%${keyword}%`);
    }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const [rows, total, stats] = await Promise.all([
      pool.query(
        `SELECT id, user_id, username, display_name, user_role, user_branch,
                ip_address, action, resource, resource_path, resource_detail,
                data_branch, data_period, status_code, duration_ms, created_at,
                -- 隱藏 user_agent 敏感部分，只顯示瀏覽器類型
                CASE
                  WHEN user_agent ILIKE '%Chrome%'  THEN 'Chrome'
                  WHEN user_agent ILIKE '%Firefox%' THEN 'Firefox'
                  WHEN user_agent ILIKE '%Safari%'  THEN 'Safari'
                  WHEN user_agent ILIKE '%Edge%'    THEN 'Edge'
                  ELSE '其他'
                END AS browser
         FROM audit_logs ${where}
         ORDER BY created_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, pageSize, pageOffset]
      ),
      pool.query(`SELECT COUNT(*) AS total FROM audit_logs ${where}`, params),
      // 活動統計（最近 30 天）— 用參數綁定避免 SQL injection（guard.branch 來自 users 表，super_admin 可寫）
      (guard.role === 'branch_admin' && guard.branch
        ? pool.query(
            `SELECT action, COUNT(*) AS cnt
             FROM audit_logs
             WHERE created_at >= NOW() - INTERVAL '30 days'
               AND user_branch = $1
             GROUP BY action ORDER BY cnt DESC`,
            [guard.branch]
          )
        : pool.query(
            `SELECT action, COUNT(*) AS cnt
             FROM audit_logs
             WHERE created_at >= NOW() - INTERVAL '30 days'
             GROUP BY action ORDER BY cnt DESC`
          )
      ),
    ]);

    res.json({
      rows:      rows.rows,
      total:     parseInt(total.rows[0].total),
      page:      parseInt(page),
      page_size: pageSize,
      stats:     stats.rows,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/audit-logs/summary ────────────────────────────────
// 統計面板：今日/本週/本月活躍、常用功能、高頻 IP
router.get('/audit-logs/summary', async (req, res) => {
  const guard = auditAccessGuard(req, res);
  if (!guard) return;

  // SQL 注入防護：guard.branch 來自 users 表，super_admin 可寫；用參數綁定，
  // 把「是否要過濾 user_branch」從字串拼接改為 query 結構切換 + $1 參數
  const filterByBranch = guard.role === 'branch_admin' && !!guard.branch;
  const branchParams   = filterByBranch ? [guard.branch] : [];
  const branchCond     = filterByBranch ? 'AND user_branch = $1' : '';

  try {
    const [todayStats, topUsers, topActions, topIPs, recentErrors] = await Promise.all([
      // 今日 / 本週 / 本月 計數
      pool.query(
        `SELECT
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)                           AS today,
          COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('week', NOW()))              AS this_week,
          COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW()))             AS this_month,
          COUNT(DISTINCT username) FILTER (WHERE created_at >= CURRENT_DATE)           AS today_users,
          COUNT(DISTINCT ip_address) FILTER (WHERE created_at >= CURRENT_DATE)        AS today_ips
        FROM audit_logs WHERE 1=1 ${branchCond}`,
        branchParams
      ),
      // 最活躍使用者（近 7 天）
      pool.query(
        `SELECT username, display_name, user_branch, COUNT(*) AS cnt,
               MAX(created_at) AS last_seen
        FROM audit_logs
        WHERE created_at >= NOW() - INTERVAL '7 days' ${branchCond}
        GROUP BY username, display_name, user_branch
        ORDER BY cnt DESC LIMIT 10`,
        branchParams
      ),
      // 最常用功能（近 7 天）
      pool.query(
        `SELECT action, resource, COUNT(*) AS cnt
        FROM audit_logs
        WHERE created_at >= NOW() - INTERVAL '7 days' ${branchCond}
        GROUP BY action, resource
        ORDER BY cnt DESC LIMIT 10`,
        branchParams
      ),
      // 最常出現的 IP（近 7 天）
      pool.query(
        `SELECT ip_address,
               array_agg(DISTINCT username) AS users,
               COUNT(*) AS cnt,
               MAX(created_at) AS last_seen
        FROM audit_logs
        WHERE created_at >= NOW() - INTERVAL '7 days' ${branchCond}
        GROUP BY ip_address
        ORDER BY cnt DESC LIMIT 10`,
        branchParams
      ),
      // 最近錯誤操作（status >= 400）
      pool.query(
        `SELECT username, display_name, ip_address, action, resource,
               status_code, created_at
        FROM audit_logs
        WHERE status_code >= 400 ${branchCond}
        ORDER BY created_at DESC LIMIT 20`,
        branchParams
      ),
    ]);

    res.json({
      counts:        todayStats.rows[0],
      top_users:     topUsers.rows,
      top_actions:   topActions.rows,
      top_ips:       topIPs.rows,
      recent_errors: recentErrors.rows,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/audit-logs/user/:username ─────────────────────────
// 查某個使用者的完整歷程
router.get('/audit-logs/user/:username', async (req, res) => {
  const guard = auditAccessGuard(req, res);
  if (!guard) return;

  try {
    const target = await pool.query(
      `SELECT id, username, display_name, role, branch FROM users WHERE username=$1`,
      [req.params.username]
    );
    if (!target.rows.length) return res.status(404).json({ error: '找不到使用者' });
    const tUser = target.rows[0];

    // 據點管理員只能查自己廠的
    if (guard.role === 'branch_admin' && tUser.branch !== guard.branch) {
      return res.status(403).json({ error: '無法查看其他廠員工的紀錄' });
    }

    const { limit = 200, date_from, date_to } = req.query;
    const conds  = [`username = $1`];
    const params = [req.params.username];
    let   idx    = 2;
    if (date_from) { conds.push(`created_at >= $${idx++}::timestamptz`); params.push(date_from); }
    if (date_to)   { conds.push(`created_at <= $${idx++}::timestamptz`); params.push(date_to + 'T23:59:59Z'); }

    const rows = await pool.query(
      `SELECT id, action, resource, resource_detail, data_branch, data_period,
              ip_address, status_code, duration_ms, created_at,
              CASE WHEN user_agent ILIKE '%Chrome%' THEN 'Chrome'
                   WHEN user_agent ILIKE '%Firefox%' THEN 'Firefox'
                   WHEN user_agent ILIKE '%Safari%' THEN 'Safari'
                   WHEN user_agent ILIKE '%Edge%' THEN 'Edge'
                   ELSE '其他' END AS browser
       FROM audit_logs WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${idx}`,
      [...params, Math.min(parseInt(limit)||200, 1000)]
    );

    res.json({ user: tUser, rows: rows.rows, count: rows.rows.length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── DELETE /api/audit-logs/cleanup ─────────────────────────────
// 清理舊紀錄（只有 super_admin 可執行）
// ═══════════════════════════════════════════════
// 稽核清理：雙人審核制（防單一 super_admin 洗稽核）
// 流程: A super_admin POST request → B 另一個 super_admin POST approve → 執行 DELETE
// ═══════════════════════════════════════════════

// 發起清理申請
router.post('/audit-logs/cleanup-requests', async (req, res, next) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '僅超級管理員可申請' });
  const keep_days = parseInt(req.body?.keep_days);
  const reason    = String(req.body?.reason || '').trim();
  if (!keep_days || keep_days < 30) return res.status(400).json({ error: 'keep_days 必須 ≥ 30（防誤刪）' });
  if (!reason) return res.status(400).json({ error: '請填寫清理理由' });
  try {
    const r = await pool.query(
      `INSERT INTO audit_cleanup_requests (requester_id, requester_name, keep_days, reason)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at, expires_at`,
      [req.user.user_id, req.user.display_name || req.user.username, keep_days, reason]
    );
    req._audit_detail = `發起稽核清理申請 keep_days=${keep_days} reason="${reason}"`;
    res.json({ ok: true, ...r.rows[0], keep_days, reason });
  } catch(err) { next(err); }
});

// 列出待審核申請
router.get('/audit-logs/cleanup-requests', async (req, res, next) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '僅超級管理員可檢視' });
  try {
    // 過期的 pending 標記為 expired
    await pool.query(
      `UPDATE audit_cleanup_requests SET status='expired' WHERE status='pending' AND expires_at < NOW()`
    );
    const r = await pool.query(
      `SELECT * FROM audit_cleanup_requests ORDER BY created_at DESC LIMIT 50`
    );
    res.json(r.rows);
  } catch(err) { next(err); }
});

// 核准申請 → 執行清理（審核者必須不是發起者）
router.post('/audit-logs/cleanup-requests/:id/approve', async (req, res, next) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '僅超級管理員可核准' });
  try {
    const r = await pool.query(
      `SELECT * FROM audit_cleanup_requests WHERE id=$1`, [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: '找不到申請' });
    const reqRow = r.rows[0];
    if (reqRow.status !== 'pending') return res.status(400).json({ error: `申請狀態為 ${reqRow.status}，無法核准` });
    if (new Date(reqRow.expires_at) < new Date()) return res.status(400).json({ error: '申請已過期（24 小時）' });
    if (reqRow.requester_id === req.user.user_id) {
      return res.status(403).json({ error: '不能核准自己發起的申請（雙人審核）' });
    }
    // 執行清理
    const del = await pool.query(
      `DELETE FROM audit_logs WHERE created_at < NOW() - ($1::text || ' days')::interval RETURNING id`,
      [reqRow.keep_days]
    );
    await pool.query(
      `UPDATE audit_cleanup_requests
         SET status='approved', approver_id=$2, approver_name=$3, approved_at=NOW(), deleted_rows=$4
       WHERE id=$1`,
      [reqRow.id, req.user.user_id, req.user.display_name || req.user.username, del.rowCount]
    );
    req._audit_detail = `核准稽核清理 req_id=${reqRow.id} keep_days=${reqRow.keep_days} deleted=${del.rowCount}（發起: ${reqRow.requester_name}）`;
    res.json({ ok: true, deleted: del.rowCount, keep_days: reqRow.keep_days });
  } catch(err) { next(err); }
});

// 拒絕申請
router.post('/audit-logs/cleanup-requests/:id/reject', async (req, res, next) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '僅超級管理員可拒絕' });
  try {
    const r = await pool.query(
      `UPDATE audit_cleanup_requests SET status='rejected' WHERE id=$1 AND status='pending' RETURNING *`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: '申請不存在或狀態不是待審' });
    req._audit_detail = `拒絕稽核清理 req_id=${req.params.id}`;
    res.json({ ok: true });
  } catch(err) { next(err); }
});

// ═══════════════════════════════════════════════
// 資安告警 API
// ═══════════════════════════════════════════════

// 列出告警（預設只顯示未認領；可帶 ?all=1 看全部）
router.get('/audit-alerts', async (req, res, next) => {
  if (!['super_admin','branch_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: '無檢視權限' });
  }
  const { all, severity } = req.query;
  const conds = [];
  const params = [];
  let idx = 1;
  if (!all)       { conds.push(`acknowledged_at IS NULL`); }
  if (severity)   { conds.push(`severity = $${idx++}`); params.push(severity); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  try {
    const r = await pool.query(
      `SELECT a.*, u.display_name AS ack_by_name
       FROM audit_alerts a
       LEFT JOIN users u ON u.id = a.acknowledged_by
       ${where}
       ORDER BY a.triggered_at DESC
       LIMIT 200`,
      params
    );
    res.json(r.rows);
  } catch(err) { next(err); }
});

// 告警計數（nav badge 用）
router.get('/audit-alerts/count', async (req, res, next) => {
  if (!['super_admin','branch_admin'].includes(req.user.role)) return res.json({ unacked: 0 });
  try {
    const r = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE acknowledged_at IS NULL) AS unacked,
              COUNT(*) FILTER (WHERE acknowledged_at IS NULL AND severity='critical') AS critical
       FROM audit_alerts
       WHERE triggered_at > NOW() - INTERVAL '7 days'`
    );
    res.json(r.rows[0]);
  } catch(err) { next(err); }
});

// 認領告警（表示已處理）
router.post('/audit-alerts/:id/acknowledge', async (req, res, next) => {
  if (!['super_admin','branch_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: '無認領權限' });
  }
  try {
    const r = await pool.query(
      `UPDATE audit_alerts SET acknowledged_by=$1, acknowledged_at=NOW()
       WHERE id=$2 AND acknowledged_at IS NULL
       RETURNING id`,
      [req.user.user_id, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: '告警不存在或已被認領' });
    req._audit_detail = `認領告警 id=${req.params.id}`;
    res.json({ ok: true });
  } catch(err) { next(err); }
});

// ═══════════════════════════════════════════════
// 稽核 tamper-evidence：hash chain checkpoints
// ═══════════════════════════════════════════════

// 列出所有 checkpoint
router.get('/audit-checkpoints', async (req, res, next) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '僅超級管理員可檢視' });
  try {
    const r = await pool.query(
      `SELECT period, row_count, min_id, max_id, chain_hash, prev_hash, created_at
       FROM audit_checkpoints ORDER BY period DESC`
    );
    res.json(r.rows);
  } catch(err) { next(err); }
});

// 驗證某月或全部
router.get('/audit-checkpoints/verify', async (req, res, next) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '僅超級管理員可驗證' });
  const { period } = req.query;
  try {
    const { verifyCheckpoint, verifyAllCheckpoints } = require('../lib/auditCheckpoint');
    if (period) {
      const r = await verifyCheckpoint(period);
      req._audit_detail = `驗證 checkpoint ${period}: ${r.ok ? 'OK' : '失敗'}`;
      res.json(r);
    } else {
      const results = await verifyAllCheckpoints();
      const allOk   = results.every(r => r.ok);
      req._audit_detail = `驗證全部 ${results.length} 個 checkpoint: ${allOk ? 'OK' : '有失敗項目'}`;
      res.json({ all_ok: allOk, results });
    }
  } catch(err) { next(err); }
});

module.exports = router;
