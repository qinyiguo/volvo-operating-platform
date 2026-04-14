const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.POSTGRES_CONNECTION_STRING,
  ssl: false,
  max: 10,
});

module.exports = pool;
