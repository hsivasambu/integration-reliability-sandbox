// Applies versioned SQL migrations from /migrations in filename order.
// Each file runs once, inside a transaction, and is recorded in schema_migrations.
// Safe to run repeatedly and from several instances at once (advisory lock).

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const LOCK_ID = 727274; // arbitrary constant shared by all instances of this app

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((name) => /^\d{3}_[\w-]+\.sql$/.test(name))
    .sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), file: path.join(dir, name) }));
}

async function runMigrations(pool, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    const pending = listMigrations(dir).filter((m) => !applied.has(m.version));
    for (const migration of pending) {
      const sql = fs.readFileSync(migration.file, 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
        await client.query('COMMIT');
        log(`Applied migration ${migration.version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.version} failed: ${err.message}`);
      }
    }
    if (pending.length === 0) log('Database schema is up to date');
    return pending.map((m) => m.version);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

// Returns migration versions that exist in code but are not applied to the database.
async function pendingMigrations(pool) {
  const expected = listMigrations().map((m) => m.version);
  const { rows } = await pool.query(
    "SELECT version FROM schema_migrations WHERE version = ANY($1)", [expected]);
  const applied = new Set(rows.map((r) => r.version));
  return expected.filter((v) => !applied.has(v));
}

if (require.main === module) {
  const { createPool } = require('./db');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required to run migrations');
    process.exit(1);
  }
  const pool = createPool(process.env.DATABASE_URL);
  runMigrations(pool)
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err.message);
      await pool.end();
      process.exit(1);
    });
}

module.exports = { runMigrations, listMigrations, pendingMigrations };
