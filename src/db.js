const { Pool } = require('pg');
const { logger } = require('./logger');

function createPool(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
    query_timeout: 5000,
  });
  // An idle client losing its connection (e.g. database restart) must not crash the app.
  pool.on('error', (err) => logger.warn('database pool error', { error: err }));
  return pool;
}

module.exports = { createPool };
