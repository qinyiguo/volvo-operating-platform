const { Pool } = require('pg');

// 預設關閉 TLS（目前部署的 Zeabur Postgres 未開 SSL）。
// DB 支援 SSL 時，設 POSTGRES_SSL=require（接受自簽）或 POSTGRES_SSL=strict（嚴格驗證）。
const sslMode = (process.env.POSTGRES_SSL || 'false').toLowerCase();
const ssl =
  sslMode === 'strict' || sslMode === 'verify' ? true :
  sslMode === 'require' || sslMode === 'true'  ? { rejectUnauthorized: false } :
  false;

const pool = new Pool({
  connectionString: process.env.POSTGRES_CONNECTION_STRING,
  ssl,
  max: 10,
});

module.exports = pool;
