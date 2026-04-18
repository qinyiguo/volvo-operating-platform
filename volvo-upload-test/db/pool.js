const { Pool } = require('pg');

// 預設啟用 TLS（rejectUnauthorized:false 以支援雲端 DB 常見的自簽/中繼憑證）。
// 在本機明文 Postgres 開發時可設 POSTGRES_SSL=false 關閉；
// 若要嚴格驗證憑證鏈改設 POSTGRES_SSL=strict。
const sslMode = (process.env.POSTGRES_SSL || '').toLowerCase();
const ssl =
  sslMode === 'false' || sslMode === 'disable' ? false :
  sslMode === 'strict' || sslMode === 'verify' ? true :
  { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: process.env.POSTGRES_CONNECTION_STRING,
  ssl,
  max: 10,
});

module.exports = pool;
