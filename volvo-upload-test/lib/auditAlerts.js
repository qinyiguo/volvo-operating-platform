/**
 * lib/auditAlerts.js
 * -------------------------------------------------------------
 * 背景偵測器：每 5 分鐘掃 audit_logs，識別攻擊 / 異常行為，寫入 audit_alerts。
 *
 * 偵測規則:
 *   BRUTE_FORCE       — 同 IP 1h 內失敗登入 (401) ≥ 20 次
 *   MANY_AUTH_FAIL    — 同 username 1h 內失敗登入 (401) ≥ 10 次
 *   MULTI_LOCK        — 1h 內 LOGIN_LOCK_TEMP / LOGIN_LOCK_PERM ≥ 5 筆
 *   MASS_DOWNLOAD     — 同使用者 10min 內 DOWNLOAD ≥ 100 筆
 *   SUSPICIOUS_DELETE — 10min 內 DELETE ≥ 20 筆 或 非工作時間的 DELETE
 *
 * 去重: 同 signature (e.g. "BRUTE_FORCE:1.2.3.4") 1h 內不重複寫入。
 *
 * Webhook: 若 env.ALERT_WEBHOOK_URL 有值，發 POST JSON 給第三方（Slack incoming webhook /
 * Teams connector / 內部 email relay）。失敗不影響告警寫入。
 *
 * 使用方式 (index.js):
 *   const { startAuditAlertDetector } = require('./lib/auditAlerts');
 *   startAuditAlertDetector();
 */
const pool = require('../db/pool');

// 工作時間外 (22:00–06:00 或週末) 做 DELETE 列為可疑
function isOffHours(d = new Date()) {
  const h = d.getHours();
  const wd = d.getDay();
  return wd === 0 || wd === 6 || h >= 22 || h < 6;
}

// 已發過的 signature 本輪不再重寫（DB 層去重：1h 內同 signature 只留一筆）
async function alertExists(signature) {
  const r = await pool.query(
    `SELECT 1 FROM audit_alerts
      WHERE signature = $1
        AND triggered_at > NOW() - INTERVAL '1 hour'
      LIMIT 1`,
    [signature]
  );
  return r.rowCount > 0;
}

async function insertAlert({ alert_type, severity, signature, summary, details, window_start, window_end }) {
  if (signature && await alertExists(signature)) return null;
  const r = await pool.query(
    `INSERT INTO audit_alerts (alert_type, severity, signature, summary, details, window_start, window_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [alert_type, severity, signature || null, summary, details || {}, window_start, window_end]
  );
  return r.rows[0]?.id || null;
}

async function sendWebhook(alertId, row) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    const payload = {
      text: `🚨 [${row.severity.toUpperCase()}] ${row.alert_type}`,
      summary: row.summary,
      details: row.details,
      triggered_at: row.triggered_at,
    };
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await pool.query(`UPDATE audit_alerts SET webhook_sent=true WHERE id=$1`, [alertId]);
  } catch (e) {
    console.warn('[auditAlerts] webhook send failed:', e.message);
  }
}

// ── 偵測規則 ──
async function detectBruteForce() {
  // 同 IP 1h 內失敗登入 ≥ 20 次
  const r = await pool.query(`
    SELECT ip_address, COUNT(*) AS c, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
           ARRAY_AGG(DISTINCT username) AS usernames,
           (ARRAY_AGG(id ORDER BY created_at DESC))[1:5] AS sample_ids
    FROM audit_logs
    WHERE action = 'LOGIN'
      AND status_code = 401
      AND created_at > NOW() - INTERVAL '1 hour'
    GROUP BY ip_address
    HAVING COUNT(*) >= 20
  `);
  for (const row of r.rows) {
    await insertAlert({
      alert_type: 'BRUTE_FORCE',
      severity:   'critical',
      signature:  `BRUTE_FORCE:${row.ip_address}`,
      summary:    `IP ${row.ip_address} 1 小時內失敗登入 ${row.c} 次（涉及 ${row.usernames.length} 個帳號）`,
      details:    { ip: row.ip_address, count: parseInt(row.c), usernames: row.usernames, sample_ids: row.sample_ids },
      window_start: row.first_at,
      window_end:   row.last_at,
    });
  }
}

async function detectAuthFailByUser() {
  // 同 username 1h 內失敗 ≥ 10 次
  const r = await pool.query(`
    SELECT username, COUNT(*) AS c, ARRAY_AGG(DISTINCT ip_address) AS ips,
           MIN(created_at) AS first_at, MAX(created_at) AS last_at,
           (ARRAY_AGG(id ORDER BY created_at DESC))[1:5] AS sample_ids
    FROM audit_logs
    WHERE action = 'LOGIN'
      AND status_code IN (401, 403)
      AND created_at > NOW() - INTERVAL '1 hour'
      AND username <> 'anonymous'
    GROUP BY username
    HAVING COUNT(*) >= 10
  `);
  for (const row of r.rows) {
    await insertAlert({
      alert_type: 'MANY_AUTH_FAIL',
      severity:   'high',
      signature:  `MANY_AUTH_FAIL:${row.username}`,
      summary:    `帳號 ${row.username} 1 小時內失敗 ${row.c} 次（來自 ${row.ips.length} 個 IP）`,
      details:    { username: row.username, count: parseInt(row.c), ips: row.ips, sample_ids: row.sample_ids },
      window_start: row.first_at,
      window_end:   row.last_at,
    });
  }
}

async function detectMultiLock() {
  // 1h 內被鎖的帳號 ≥ 5 個
  const r = await pool.query(`
    SELECT COUNT(DISTINCT username) AS c, ARRAY_AGG(DISTINCT username) AS users,
           MIN(created_at) AS first_at, MAX(created_at) AS last_at,
           (ARRAY_AGG(id ORDER BY created_at DESC))[1:10] AS sample_ids
    FROM audit_logs
    WHERE action IN ('LOGIN_LOCK_TEMP','LOGIN_LOCK_PERM')
      AND created_at > NOW() - INTERVAL '1 hour'
  `);
  const count = parseInt(r.rows[0]?.c || 0);
  if (count >= 5) {
    await insertAlert({
      alert_type: 'MULTI_LOCK',
      severity:   'critical',
      signature:  `MULTI_LOCK:${new Date().toISOString().slice(0,13)}`, // 每小時一個 signature
      summary:    `1 小時內 ${count} 個帳號被鎖，疑似分散式攻擊`,
      details:    { locked_users: r.rows[0].users, sample_ids: r.rows[0].sample_ids },
      window_start: r.rows[0].first_at,
      window_end:   r.rows[0].last_at,
    });
  }
}

async function detectMassDownload() {
  // 同使用者 10min 內 DOWNLOAD ≥ 100 筆 → 疑似資料外洩
  const r = await pool.query(`
    SELECT username, COUNT(*) AS c, ARRAY_AGG(DISTINCT resource) AS resources,
           MIN(created_at) AS first_at, MAX(created_at) AS last_at,
           (ARRAY_AGG(id ORDER BY created_at DESC))[1:10] AS sample_ids
    FROM audit_logs
    WHERE action = 'DOWNLOAD'
      AND created_at > NOW() - INTERVAL '10 minutes'
      AND username <> 'anonymous'
    GROUP BY username
    HAVING COUNT(*) >= 100
  `);
  for (const row of r.rows) {
    await insertAlert({
      alert_type: 'MASS_DOWNLOAD',
      severity:   'critical',
      signature:  `MASS_DOWNLOAD:${row.username}`,
      summary:    `使用者 ${row.username} 10 分鐘內下載 ${row.c} 次，疑似資料外洩`,
      details:    { username: row.username, count: parseInt(row.c), resources: row.resources, sample_ids: row.sample_ids },
      window_start: row.first_at,
      window_end:   row.last_at,
    });
  }
}

async function detectSuspiciousDelete() {
  // 10min 內 DELETE ≥ 20 筆 → mass delete 警示
  const rMass = await pool.query(`
    SELECT username, COUNT(*) AS c, ARRAY_AGG(DISTINCT resource) AS resources,
           MIN(created_at) AS first_at, MAX(created_at) AS last_at,
           (ARRAY_AGG(id ORDER BY created_at DESC))[1:10] AS sample_ids
    FROM audit_logs
    WHERE action = 'DELETE'
      AND created_at > NOW() - INTERVAL '10 minutes'
    GROUP BY username
    HAVING COUNT(*) >= 20
  `);
  for (const row of rMass.rows) {
    await insertAlert({
      alert_type: 'SUSPICIOUS_DELETE',
      severity:   'high',
      signature:  `SUSPICIOUS_DELETE:${row.username}`,
      summary:    `使用者 ${row.username} 10 分鐘內刪除 ${row.c} 筆資料`,
      details:    { username: row.username, count: parseInt(row.c), resources: row.resources, sample_ids: row.sample_ids, reason: 'mass_delete' },
      window_start: row.first_at,
      window_end:   row.last_at,
    });
  }

  // 非工作時間 DELETE → 低度警示
  if (isOffHours()) {
    const rOff = await pool.query(`
      SELECT username, COUNT(*) AS c, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
             (ARRAY_AGG(id ORDER BY created_at DESC))[1:5] AS sample_ids
      FROM audit_logs
      WHERE action = 'DELETE'
        AND created_at > NOW() - INTERVAL '10 minutes'
        AND username <> 'anonymous'
      GROUP BY username
      HAVING COUNT(*) >= 3
    `);
    for (const row of rOff.rows) {
      await insertAlert({
        alert_type: 'SUSPICIOUS_DELETE',
        severity:   'medium',
        signature:  `OFF_HOURS_DELETE:${row.username}:${new Date().toISOString().slice(0,13)}`,
        summary:    `使用者 ${row.username} 於非工作時間刪除 ${row.c} 筆資料`,
        details:    { username: row.username, count: parseInt(row.c), sample_ids: row.sample_ids, reason: 'off_hours_delete' },
        window_start: row.first_at,
        window_end:   row.last_at,
      });
    }
  }
}

async function runOnce() {
  try {
    await Promise.all([
      detectBruteForce(),
      detectAuthFailByUser(),
      detectMultiLock(),
      detectMassDownload(),
      detectSuspiciousDelete(),
    ]);
    // 送 webhook：未送過的、最近 5 分鐘內產生的
    const newAlerts = await pool.query(`
      SELECT * FROM audit_alerts
      WHERE webhook_sent = false
        AND triggered_at > NOW() - INTERVAL '5 minutes'
    `);
    for (const a of newAlerts.rows) await sendWebhook(a.id, a);
  } catch (e) {
    console.error('[auditAlerts] run failed:', e.message);
  }
}

function startAuditAlertDetector() {
  // 啟動後延遲 30s 跑一次（避開 initDB 競爭），之後每 5 分鐘一次
  setTimeout(runOnce, 30 * 1000);
  setInterval(runOnce, 5 * 60 * 1000);
  console.log('[auditAlerts] detector started (every 5min, webhook=' + (process.env.ALERT_WEBHOOK_URL ? 'on' : 'off') + ')');
}

module.exports = { startAuditAlertDetector, runOnce };
