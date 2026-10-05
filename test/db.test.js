const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { createPool } = require('../src/db');
const { runMigrations, listMigrations } = require('../src/migrate');
const { skip, freshDatabase } = require('./helpers/db');

const TOKEN_FORMAT = /^irs_[A-Za-z0-9_-]{43}$/;

describe('database-backed behaviour', { skip }, () => {
  let pool;
  before(async () => { pool = await freshDatabase(); });
  after(async () => { await pool?.end(); });

  const appWith = (config = {}) => createApp({ pool, config });

  describe('migrations', () => {
    test('are recorded and safe to run again', async () => {
      const applied = await runMigrations(pool, { log: () => {} });
      assert.deepEqual(applied, [], 'second run applies nothing');
      const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
      assert.deepEqual(rows.map((r) => r.version), listMigrations().map((m) => m.version));
    });
  });

  describe('GET /ready', () => {
    test('returns 200 when the database is reachable and migrated', async () => {
      const res = await request(appWith()).get('/ready');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { status: 'ready' });
    });

    test('returns 503 when migrations are missing', async () => {
      await pool.query("DELETE FROM schema_migrations WHERE version = '001_create_demo_sessions'");
      try {
        const res = await request(appWith()).get('/ready');
        assert.equal(res.status, 503);
        assert.equal(res.body.reason, 'migrations_pending');
      } finally {
        await pool.query("INSERT INTO schema_migrations (version) VALUES ('001_create_demo_sessions')");
      }
    });

    test('returns 503 when the database is unreachable', async () => {
      const deadPool = createPool('postgres://nobody:nothing@127.0.0.1:1/none');
      try {
        const res = await request(createApp({ pool: deadPool })).get('/ready');
        assert.equal(res.status, 503);
        assert.equal(res.body.reason, 'database_unreachable');
      } finally {
        await deadPool.end();
      }
    });
  });

  describe('POST /v1/sessions', () => {
    test('issues a token once and stores only its hash', async () => {
      const res = await request(appWith()).post('/v1/sessions');
      assert.equal(res.status, 201);
      assert.match(res.body.token, TOKEN_FORMAT);
      assert.equal(res.body.tokenType, 'Bearer');
      assert.equal(res.headers['cache-control'], 'no-store');

      const { rows } = await pool.query('SELECT * FROM demo_sessions');
      const stored = JSON.stringify(rows);
      assert.ok(!stored.includes(res.body.token), 'plain token must not be stored');
    });

    test('expires after the configured lifetime (default 24h)', async () => {
      for (const [config, hours] of [[{}, 24], [{ sessionTtlHours: 2 }, 2]]) {
        const res = await request(appWith(config)).post('/v1/sessions');
        const lifetimeMs = new Date(res.body.expiresAt) - new Date(res.body.createdAt);
        assert.equal(lifetimeMs, hours * 3600_000);
      }
    });

    test('is rate limited per client', async () => {
      const app = appWith({ sessionRateLimit: { max: 2, windowMs: 60_000 } });
      await request(app).post('/v1/sessions').expect(201);
      await request(app).post('/v1/sessions').expect(201);
      const res = await request(app).post('/v1/sessions');
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers['retry-after']) > 0);
    });

    test('refuses new sessions when the active-session cap is reached', async () => {
      const res = await request(appWith({ maxActiveSessions: 1 })).post('/v1/sessions');
      assert.equal(res.status, 503);
      assert.equal(res.body.error, 'session_capacity_reached');
    });

    test('rejects request bodies over 4 KB', async () => {
      const res = await request(appWith()).post('/v1/sessions')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ padding: 'x'.repeat(5000) }));
      assert.equal(res.status, 413);
      assert.equal(res.body.error, 'payload_too_large');
    });

    test('rejects malformed JSON', async () => {
      const res = await request(appWith()).post('/v1/sessions')
        .set('Content-Type', 'application/json').send('{not json');
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_json');
    });

    test('wrong method returns 405', async () => {
      const res = await request(appWith()).get('/v1/sessions');
      assert.equal(res.status, 405);
      assert.equal(res.headers.allow, 'POST');
    });

    test('removes expired sessions when a new one is created', async () => {
      await pool.query(
        "UPDATE demo_sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'");
      await request(appWith()).post('/v1/sessions').expect(201);
      const { rows: [{ count }] } = await pool.query('SELECT count(*)::int AS count FROM demo_sessions');
      assert.equal(count, 1);
    });
  });

  describe('GET /v1/session', () => {
    async function newToken() {
      const res = await request(appWith()).post('/v1/sessions').expect(201);
      return res.body.token;
    }

    test('returns minimal metadata for a valid token', async () => {
      const token = await newToken();
      const res = await request(appWith()).get('/v1/session').set('Authorization', `Bearer ${token}`);
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body).sort(), ['createdAt', 'expiresAt']);
    });

    test('missing credential returns 401 missing_token', async () => {
      const res = await request(appWith()).get('/v1/session');
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'missing_token');
      assert.match(res.headers['www-authenticate'], /^Bearer/);
    });

    test('non-Bearer scheme is treated as missing', async () => {
      const res = await request(appWith()).get('/v1/session').set('Authorization', 'Basic dXNlcjpwdw==');
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'missing_token');
    });

    test('unknown or malformed tokens return 401 invalid_token', async () => {
      const unknown = `irs_${'A'.repeat(43)}`;
      for (const token of [unknown, 'not-a-token', `${unknown}x`]) {
        const res = await request(appWith()).get('/v1/session').set('Authorization', `Bearer ${token}`);
        assert.equal(res.status, 401, token);
        assert.equal(res.body.error, 'invalid_token');
        assert.match(res.headers['www-authenticate'], /error="invalid_token"/);
      }
    });

    test('expired token returns 401 invalid_token', async () => {
      const token = await newToken();
      await pool.query(
        "UPDATE demo_sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second'");
      const res = await request(appWith()).get('/v1/session').set('Authorization', `Bearer ${token}`);
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'invalid_token');
    });
  });
});
