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
router.delete('/audit-logs/cleanup', async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '僅超級管理員可執行' });
  const { keep_days = 90 } = req.query;
  try {
    const r = await pool.query(
      `DELETE FROM audit_logs WHERE created_at < NOW() - ($1 || ' days')::interval RETURNING id`,
      [parseInt(keep_days) || 90]
    );
    // 記錄這次清理操作本身
    await pool.query(`
      INSERT INTO audit_logs
        (username, display_name, user_role, ip_address, action, resource, resource_detail)
      VALUES ($1,$2,$3,$4,'DELETE','操作紀錄清理',$5)
    `, [req.user.username, req.user.display_name, req.user.role,
        req.headers['x-forwarded-for'] || req.ip,
        `清除 ${keep_days} 天前紀錄，共 ${r.rowCount} 筆`]);
    res.json({ ok: true, deleted: r.rowCount, keep_days });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
