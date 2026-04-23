/**
 * lib/auditCheckpoint.js
 * -------------------------------------------------------------
 * 稽核防竄改：每月第一天為上個月的 audit_logs 做 SHA-256 摘要 + 鏈式雜湊。
 *
 * 資料結構 audit_checkpoints:
 *   period      'YYYY-MM'（上一個月）
 *   row_count, min_id, max_id
 *   chain_hash  SHA-256 of (prev_hash || rows_digest)
 *   prev_hash   前一月的 chain_hash（第一月為全 0）
 *
 * 驗證邏輯 verifyCheckpoint(period):
 *   1. 重算該月份所有 row 的 digest
 *   2. 取前一月份的 chain_hash（或全 0）
 *   3. 組 chain_hash = SHA-256(prev_hash || rows_digest)
 *   4. 與 DB 裡的 chain_hash 比對
 *   有差 = 歷史資料被竄改（或 checkpoint 本身被改）
 *
 * DB 已加 RULE audit_logs_no_update 阻擋 UPDATE；只能 DELETE（透過雙人審核）。
 * 寫入新 row 不破壞已封存月份的 checkpoint（min_id/max_id 鎖定範圍）。
 */
const crypto = require('crypto');
const pool   = require('../db/pool');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 把單一 row 轉成穩定字串（欄位順序固定）
function rowDigestLine(row) {
  // 只挑 immutable 欄位，不含可能被 timezone 影響的 text 表示；用 epoch ms
  const ts = row.created_at ? new Date(row.created_at).getTime() : 0;
  return [
    row.id, row.user_id || '', row.username || '', row.user_role || '',
    row.user_branch || '', row.ip_address || '', row.action || '',
    row.resource || '', row.resource_path || '', row.resource_detail || '',
    row.data_branch || '', row.data_period || '', row.status_code || '',
    ts,
  ].join('|');
}

// 算一個月的 rows_digest
async function computeMonthDigest(period) {
  // period = YYYY-MM
  const [y, m] = period.split('-').map(Number);
  const rangeStart = new Date(Date.UTC(y, m - 1, 1));
  const rangeEnd   = new Date(Date.UTC(y, m, 1));
  const r = await pool.query(
    `SELECT id, user_id, username, user_role, user_branch, ip_address,
            action, resource, resource_path, resource_detail,
            data_branch, data_period, status_code, created_at
     FROM audit_logs
     WHERE created_at >= $1 AND created_at < $2
     ORDER BY id ASC`,
    [rangeStart, rangeEnd]
  );
  const digest = sha256(r.rows.map(rowDigestLine).join('\n'));
  const min_id = r.rows[0]?.id || null;
  const max_id = r.rows[r.rows.length - 1]?.id || null;
  return { digest, row_count: r.rowCount, min_id, max_id };
}

async function createCheckpoint(period) {
  // 取前一月 checkpoint 的 chain_hash
  const prev = await pool.query(
    `SELECT chain_hash FROM audit_checkpoints WHERE period < $1 ORDER BY period DESC LIMIT 1`,
    [period]
  );
  const prev_hash = prev.rows[0]?.chain_hash || '0'.repeat(64);
  const { digest, row_count, min_id, max_id } = await computeMonthDigest(period);
  const chain_hash = sha256(prev_hash + digest);
  await pool.query(
    `INSERT INTO audit_checkpoints (period, row_count, min_id, max_id, chain_hash, prev_hash)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (period) DO NOTHING`,
    [period, row_count, min_id, max_id, chain_hash, prev_hash]
  );
  return { period, row_count, min_id, max_id, chain_hash, prev_hash };
}

// 驗證某月是否被竄改
async function verifyCheckpoint(period) {
  const cp = await pool.query(`SELECT * FROM audit_checkpoints WHERE period=$1`, [period]);
  if (!cp.rows.length) return { ok: false, reason: 'no_checkpoint', period };
  const stored = cp.rows[0];
  const { digest } = await computeMonthDigest(period);
  const expected = sha256((stored.prev_hash || '0'.repeat(64)) + digest);
  const ok = expected === stored.chain_hash;
  return {
    ok, period,
    stored_hash:     stored.chain_hash,
    recomputed_hash: expected,
    row_count: stored.row_count,
  };
}

// 驗證整條 chain（從頭到尾）
async function verifyAllCheckpoints() {
  const all = await pool.query(`SELECT period FROM audit_checkpoints ORDER BY period ASC`);
  const results = [];
  for (const row of all.rows) {
    results.push(await verifyCheckpoint(row.period));
  }
  return results;
}

// 上一個月的 period（YYYY-MM）
function prevMonthStr() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
}

async function runOnce() {
  try {
    const target = prevMonthStr();
    // 若該月 checkpoint 尚未建立就建立
    const exists = await pool.query(`SELECT 1 FROM audit_checkpoints WHERE period=$1`, [target]);
    if (exists.rowCount) return; // 已有則略過
    const cp = await createCheckpoint(target);
    console.log('[auditCheckpoint] created', target, 'rows=' + cp.row_count, 'hash=' + cp.chain_hash.slice(0, 12) + '…');
  } catch (e) {
    console.error('[auditCheckpoint] failed:', e.message);
  }
}

function startAuditCheckpointScheduler() {
  // 啟動後 60s 先跑一次（若上月 checkpoint 缺失會建立）
  setTimeout(runOnce, 60 * 1000);
  // 之後每 24h 檢查一次（正常上月 checkpoint 建好就不再動）
  setInterval(runOnce, 24 * 60 * 60 * 1000);
  console.log('[auditCheckpoint] scheduler started (daily)');
}

module.exports = {
  startAuditCheckpointScheduler,
  createCheckpoint,
  verifyCheckpoint,
  verifyAllCheckpoints,
  runOnce,
};
