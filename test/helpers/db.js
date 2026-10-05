// Shared setup for tests that need PostgreSQL.
// Uses TEST_DATABASE_URL, which must point at a database whose name ends in "_test",
// because the schema is wiped before each test file.

const { createPool } = require('../../src/db');
const { runMigrations } = require('../../src/migrate');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set (see README: Local setup)';

async function freshDatabase() {
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to reset "${dbName}": test database name must end in _test`);
  }
  const pool = createPool(url);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool, { log: () => {} });
  return pool;
}

module.exports = { skip, freshDatabase, url };
