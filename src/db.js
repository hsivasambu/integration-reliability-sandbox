const { Pool } = require('pg');

function createPool(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
    query_timeout: 5000,
  });
  // An idle client losing its connection (e.g. database restart) must not crash the app.
  pool.on('error', (err) => console.error(`Database pool error: ${err.message}`));
  return pool;
}

module.exports = { createPool };
