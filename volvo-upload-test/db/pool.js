/**
 * db/pool.js
 * -------------------------------------------------------------
 * 建立並匯出單一 PostgreSQL 連線池（`pg.Pool`），所有路由透過它執行 SQL。
 *
 * 環境變數:
 *   POSTGRES_CONNECTION_STRING  必填
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.POSTGRES_CONNECTION_STRING,
  max: 10,
  // 連線逾時 10s：DB 不可達時讓請求快速失敗，不讓 client 痴等 TCP handshake 30s+
  connectionTimeoutMillis: 10_000,
  // idle 連線 30s 後歸還；避免 Zeabur 內部 NAT 悶掉殭屍連線
  idleTimeoutMillis: 30_000,
});

// pg Pool 的 'error' 事件必須接，不然連線斷線會變 uncaught exception → 整個程序掛掉
pool.on('error', (err) => {
  console.warn('[pgPool] idle client error:', err.message);
});

module.exports = pool;
