const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const request = require('supertest');
const { createApp } = require('../src/app');
const { logger } = require('../src/logger');
const { hashToken } = require('../src/sessions');
const { createDeliveryClient } = require('../src/delivery-client');
const { createWorker } = require('../src/worker');
const { claimNext } = require('../src/delivery-store');
const { cancelExpiredWork, purgeExpiredSessions } = require('../src/maintenance');
const { skip, freshDatabase } = require('./helpers/db');

const SECRET = 'test-receiver-secret-0123456789abcdefghijkl';
const OPS_TOKEN = 'test-ops-token-0123456789abcdefghijklmnop';
const MARKER = 'Synthetic-PAYLOAD-marker-7c1e'; // must never appear in logs

// Captures log lines (as parsed JSON) while fn runs, at the given level.
async function captureLogs(fn, level = 'debug') {
  const lines = [];
  const restore = logger.captureTo((lvl, line) => lines.push(JSON.parse(line)));
  logger.setLevel(level);
  try {
    await fn();
  } finally {
    logger.setLevel('error');
    restore();
  }
  return lines;
}

describe('logger safety', () => {
  test('writes JSON lines and redacts sensitive fields, demo tokens and registered secrets', async () => {
    logger.registerSecret('super-secret-value-123');
    const token = `irs_${'a'.repeat(43)}`;
    const lines = await captureLogs(async () => {
      logger.info(`saw ${token}`, {
        authorization: `Bearer ${token}`, payload: { title: MARKER }, password: 'x',
        note: 'contains super-secret-value-123 inside', eventId: 'e-1',
      });
    });
    const [line] = lines;
    assert.equal(line.level, 'info');
    assert.ok(line.time);
    assert.equal(line.authorization, '[redacted]');
    assert.equal(line.payload, '[redacted]');
    assert.equal(line.password, '[redacted]');
    assert.equal(line.note, 'contains [redacted] inside');
    assert.equal(line.eventId, 'e-1');
    const raw = JSON.stringify(lines);
    assert.ok(!raw.includes(token) && !raw.includes(MARKER) && !raw.includes('super-secret-value-123'));
  });
});

describe('operational visibility and bounds', { skip }, () => {
  let pool;
  let app;
  let server;
  let send;
  const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

  before(async () => {
    pool = await freshDatabase();
    app = createApp({
      pool,
      config: {
        receiverSecret: SECRET,
        receiverSlowResponseMs: 1600,
        sessionRateLimit: { max: 1000, windowMs: 60_000 },
        opsToken: OPS_TOKEN,
        workerStallSeconds: 60,
      },
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    send = createDeliveryClient({
      receiverUrl: `http://127.0.0.1:${server.address().port}/internal/receiver/deliveries`,
      receiverSecret: SECRET, deliveryTimeoutMs: 800,
    });
  });
  after(async () => {
    server?.close();
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE demo_sessions, worker_heartbeats CASCADE');
  });

  const newWorker = (overrides = {}) => createWorker({
    pool, send, pollIntervalMs: 20, leaseMs: 3000, maxAttempts: 4, retryBaseDelayMs: 60_000, log: quietLog, ...overrides,
  });
  async function newSession() {
    const res = await request(server).post('/v1/sessions').expect(201);
    const { rows: [row] } = await pool.query('SELECT id FROM demo_sessions WHERE token_hash = $1', [hashToken(res.body.token)]);
    return { token: res.body.token, id: row.id };
  }
  const authed = (s, req) => req.set('Authorization', `Bearer ${s.token}`);
  async function submitEvent(session, title = MARKER) {
    const res = await authed(session, request(server).post('/v1/events'))
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ type: 'demo.notification', payload: { title, message: `${MARKER} message` } })
      .expect(202);
    return res.body;
  }
  const expire = (session) => pool.query(
    "UPDATE demo_sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '10 minutes' WHERE id = $1",
    [session.id]);

  describe('structured logs', () => {
    test('request logs carry request ID, route, status, duration, IDs; never tokens or payloads', async () => {
      let session;
      let created;
      let echoed;
      const lines = await captureLogs(async () => {
        session = await newSession();
        created = await submitEvent(session);
        echoed = await authed(session, request(server).get('/v1/events')).set('X-Request-Id', 'client-req-12345');
        await request(server).get('/v1/events').set('Authorization', 'Bearer not-a-real-token');
      });
      const post = lines.find((l) => l.msg === 'request' && l.method === 'POST' && l.path === '/v1/events');
      assert.ok(post.requestId);
      assert.equal(post.status, 202);
      assert.equal(typeof post.durationMs, 'number');
      assert.equal(post.eventId, created.eventId);
      assert.equal(post.sessionId, session.id);
      assert.equal(echoed.headers['x-request-id'], 'client-req-12345');
      assert.ok(lines.some((l) => l.requestId === 'client-req-12345'));
      assert.ok(lines.some((l) => l.status === 401), 'failed auth is logged');

      const raw = JSON.stringify(lines);
      assert.ok(!raw.includes(session.token), 'no bearer token');
      assert.ok(!raw.includes(MARKER), 'no payload text');
      assert.ok(!raw.includes(SECRET), 'no receiver secret');
      assert.ok(!/authorization/i.test(raw), 'no headers');
    });

    test('routine successful reads are debug-level only, so polling does not flood info logs', async () => {
      const session = await newSession();
      const lines = await captureLogs(async () => {
        for (let i = 0; i < 5; i++) await authed(session, request(server).get('/v1/events')).expect(200);
        await request(server).get('/health').expect(200);
      }, 'info');
      assert.equal(lines.length, 0);
    });

    test('worker logs each attempt with event, delivery, attempt number, status, duration and next state', async () => {
      const session = await newSession();
      const created = await submitEvent(session);
      const lines = await captureLogs(async () => { await newWorker({ log: logger }).runOnce(); });
      const attempt = lines.find((l) => l.msg === 'delivery attempt finished');
      assert.equal(attempt.eventId, created.eventId);
      assert.equal(attempt.deliveryId, created.event.delivery.id);
      assert.equal(attempt.attemptNumber, 1);
      assert.equal(attempt.responseStatus, 200);
      assert.equal(attempt.nextState, 'delivered');
      assert.equal(typeof attempt.durationMs, 'number');
      assert.ok(attempt.workerId);
      assert.ok(!JSON.stringify(lines).includes(MARKER));
    });
  });

  describe('session summary', () => {
    test('counts by current delivery state and a defined recent-duration metric', async () => {
      const session = await newSession();
      await submitEvent(session, 'one');
      await submitEvent(session, 'two');
      await newWorker().runOnce();
      await newWorker().runOnce();
      await authed(session, request(server).put('/v1/receiver')).send({ mode: 'server_error' }).expect(200);
      await submitEvent(session, 'three');

      const res = await authed(session, request(server).get('/v1/summary')).expect(200);
      assert.equal(res.body.events, 3);
      assert.deepEqual(res.body.byCurrentDeliveryState, { delivered: 2, failed: 0, active: 1 });
      assert.equal(res.body.receiver.processed, 2);
      const metric = res.body.recentDeliveryDuration;
      assert.match(metric.start, /accepted/);
      assert.match(metric.end, /2xx/);
      assert.match(metric.population, /50 most recently completed/);
      assert.equal(metric.sampleSize, 2);
      assert.ok(Number.isInteger(metric.medianMs) && metric.medianMs >= 0 && metric.maxMs >= metric.medianMs);
      assert.match(res.body.notice, /not a service-level agreement/);
    });

    test('requires a session and only counts that session', async () => {
      assert.equal((await request(server).get('/v1/summary')).status, 401);
      const a = await newSession();
      const b = await newSession();
      await submitEvent(a);
      const res = await authed(b, request(server).get('/v1/summary')).expect(200);
      assert.equal(res.body.events, 0);
      assert.equal(res.body.recentDeliveryDuration.sampleSize, 0);
    });
  });

  describe('private worker check', () => {
    const ops = () => request(server).get('/internal/ops/worker');

    test('is disabled without OPS_TOKEN and rejects wrong tokens', async () => {
      const unconfigured = createApp({ pool });
      assert.equal((await request(unconfigured).get('/internal/ops/worker')).status, 404);
      assert.equal((await ops()).status, 401);
      assert.equal((await ops().set('Authorization', 'Bearer wrong')).status, 401);
      const session = await newSession();
      assert.equal((await ops().set('Authorization', `Bearer ${session.token}`)).status, 401);
    });

    test('database readiness alone is not reported as a working worker', async () => {
      await request(server).get('/ready').expect(200);
      const res = await ops().set('Authorization', `Bearer ${OPS_TOKEN}`).expect(200);
      assert.equal(res.body.verdict, 'no_live_worker');
      assert.deepEqual(res.body.workers, []);
    });

    test('a polling worker writes a heartbeat; stopping it marks it stopped', async () => {
      const worker = newWorker({ heartbeatIntervalMs: 1000 });
      worker.start();
      let res;
      for (let i = 0; i < 50; i++) {
        res = await ops().set('Authorization', `Bearer ${OPS_TOKEN}`);
        if (res.body.workers.length) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(res.body.verdict, 'idle');
      assert.equal(res.body.workers[0].workerId, worker.workerId);
      await worker.stop();
      res = await ops().set('Authorization', `Bearer ${OPS_TOKEN}`).expect(200);
      assert.ok(res.body.workers[0].stoppedAt);
      assert.equal(res.body.verdict, 'no_live_worker');
    });

    test('reports "stalled" when a worker is alive but due work is waiting too long', async () => {
      const session = await newSession();
      await submitEvent(session);
      await pool.query("UPDATE deliveries SET next_attempt_at = now() - interval '2 minutes'");
      await pool.query("INSERT INTO worker_heartbeats (worker_id, concurrency) VALUES ('stuck-worker', 2)");
      const res = await ops().set('Authorization', `Bearer ${OPS_TOKEN}`).expect(200);
      assert.equal(res.body.verdict, 'stalled');
      assert.equal(res.body.queue.overdue, 1);
      assert.ok(res.body.queue.oldestOverdueSeconds >= 119);
    });
  });

  describe('expiry and bounded cleanup', () => {
    test('expired sessions get no new attempts; their waiting deliveries are cancelled', async () => {
      const session = await newSession();
      const { eventId } = await submitEvent(session);
      await expire(session);
      assert.equal(await claimNext(pool, { leaseMs: 3000 }), null, 'worker does not start new work');
      assert.equal(await cancelExpiredWork(pool, { batchSize: 10 }), 1);
      const { rows: [row] } = await pool.query(
        'SELECT state, failure_reason FROM deliveries WHERE event_id = $1', [eventId]);
      assert.deepEqual(row, { state: 'failed', failure_reason: 'session_expired' });
    });

    test('purge waits for the grace period, skips live claims, cascades, and is batched', async () => {
      const busy = await newSession();
      await submitEvent(busy);
      assert.ok(await claimNext(pool, { leaseMs: 60_000 })); // a worker holds a live lease
      const idle = [await newSession(), await newSession(), await newSession()];
      for (const s of idle) await submitEvent(s);
      for (const s of [busy, ...idle]) await expire(s); // expired 10 minutes ago

      assert.equal(await purgeExpiredSessions(pool, { graceMinutes: 60, batchSize: 10 }), 0, 'still in grace period');
      assert.equal(await purgeExpiredSessions(pool, { graceMinutes: 5, batchSize: 2 }), 2, 'batch size respected');
      assert.equal(await purgeExpiredSessions(pool, { graceMinutes: 5, batchSize: 2 }), 1);
      assert.equal(await purgeExpiredSessions(pool, { graceMinutes: 5, batchSize: 2 }), 0, 'busy session kept');

      const { rows: [left] } = await pool.query(
        `SELECT (SELECT count(*) FROM demo_sessions)::int AS sessions, (SELECT count(*) FROM events)::int AS events,
                (SELECT count(*) FROM deliveries)::int AS deliveries`);
      assert.deepEqual(left, { sessions: 1, events: 1, deliveries: 1 }, 'related rows cascaded');

      await pool.query("UPDATE deliveries SET lease_expires_at = now() - interval '1 second'"); // lease lapsed
      assert.equal(await purgeExpiredSessions(pool, { graceMinutes: 5, batchSize: 2 }), 1);
    });
  });

  describe('API rate limit', () => {
    test('per-IP request budget returns 429 with Retry-After and a message', async () => {
      const limited = createApp({ pool, config: { apiRateLimit: { max: 3, windowMs: 60_000 } } });
      for (let i = 0; i < 3; i++) await request(limited).get('/v1/session');
      const res = await request(limited).get('/v1/session');
      assert.equal(res.status, 429);
      assert.equal(res.body.error, 'rate_limited');
      assert.match(res.body.message, /Try again in \d+ seconds/);
      assert.ok(Number(res.headers['retry-after']) > 0);
    });
  });
});
