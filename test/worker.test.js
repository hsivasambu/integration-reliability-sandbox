const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const request = require('supertest');
const { createApp } = require('../src/app');
const { createPool } = require('../src/db');
const { hashToken } = require('../src/sessions');
const { createDeliveryClient } = require('../src/delivery-client');
const { createWorker } = require('../src/worker');
const { claimNext, completeAttempt, recoverExpired } = require('../src/delivery-store');
const { skip, freshDatabase, url } = require('./helpers/db');

const SECRET = 'test-receiver-secret-0123456789abcdefghijkl';
const SLOW_MS = 1600;    // receiver 'timeout' mode delay (4000 in production)
const TIMEOUT_MS = 800;  // delivery client timeout (2000 in production)
const LEASE_MS = 3000;   // claim lease (15000 in production)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('delivery worker', { skip }, () => {
  let pool;
  let server;
  let send;
  let workerErrors;
  const quietLog = { log() {}, error: (msg) => workerErrors.push(msg) };

  const newWorker = (overrides = {}) => createWorker({
    pool, send, pollIntervalMs: 50, leaseMs: LEASE_MS, maxAttempts: 4,
    retryBaseDelayMs: 60_000, // retries are covered in retry.test.js; keep them out of the way here
    log: quietLog, ...overrides,
  });

  before(async () => {
    pool = await freshDatabase();
    const app = createApp({
      pool,
      config: {
        receiverSecret: SECRET,
        receiverSlowResponseMs: SLOW_MS,
        sessionRateLimit: { max: 1000, windowMs: 60_000 },
      },
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    send = createDeliveryClient({
      receiverUrl: `http://127.0.0.1:${server.address().port}/internal/receiver/deliveries`,
      receiverSecret: SECRET,
      deliveryTimeoutMs: TIMEOUT_MS,
    });
  });
  after(async () => {
    server?.close();
    await pool?.end();
  });
  beforeEach(async () => {
    workerErrors = [];
    // Workers claim any due delivery, so each test starts from an empty queue.
    await pool.query('TRUNCATE demo_sessions CASCADE');
  });
  afterEach(() => assert.deepEqual(workerErrors, [], 'worker logged no errors'));

  async function newSession() {
    const res = await request(server).post('/v1/sessions').expect(201);
    const { rows: [row] } = await pool.query(
      'SELECT id FROM demo_sessions WHERE token_hash = $1', [hashToken(res.body.token)]);
    return { token: res.body.token, id: row.id };
  }
  const setMode = (session, mode) => request(server).put('/v1/receiver')
    .set('Authorization', `Bearer ${session.token}`).send({ mode }).expect(200);
  async function submitEvent(session) {
    const res = await request(server).post('/v1/events')
      .set('Authorization', `Bearer ${session.token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ type: 'demo.notification', payload: { title: 'Synthetic title', message: 'Synthetic message' } })
      .expect(202);
    return res.body.eventId;
  }
  async function history(session, eventId) {
    const res = await request(server).get(`/v1/events/${eventId}/deliveries`)
      .set('Authorization', `Bearer ${session.token}`).expect(200);
    return res.body.delivery;
  }
  const receipts = async (session) => (await pool.query(
    'SELECT count(*)::int AS count FROM mock_receiver_receipts WHERE session_id = $1', [session.id])).rows[0].count;
  const expireLeases = () => pool.query(
    "UPDATE deliveries SET lease_expires_at = now() - interval '1 second' WHERE state = 'in_progress'");
  async function waitFor(check, ms = 3000) {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('condition not reached in time');
      await sleep(20);
    }
  }

  describe('single attempt outcomes', () => {
    test('success: 2xx marks the delivery delivered and records the attempt', async () => {
      const session = await newSession();
      const eventId = await submitEvent(session);
      assert.equal(await newWorker().runOnce(), true);

      const delivery = await history(session, eventId);
      assert.equal(delivery.state, 'delivered');
      assert.equal(delivery.attemptCount, 1);
      assert.ok(delivery.completedAt);
      assert.equal(delivery.attempts.length, 1);
      const [attempt] = delivery.attempts;
      assert.equal(attempt.attemptNumber, 1);
      assert.equal(attempt.outcome, 'delivered');
      assert.equal(attempt.responseStatus, 200);
      assert.equal(attempt.errorCategory, null);
      assert.ok(attempt.startedAt && attempt.endedAt);
      assert.ok(Number.isInteger(attempt.durationMs));
      assert.equal(await receipts(session), 1);

      const event = await request(server).get(`/v1/events/${eventId}`).set('Authorization', `Bearer ${session.token}`);
      assert.equal(event.body.event.delivery.state, 'delivered');
      assert.equal(await newWorker().runOnce(), false, 'nothing left to do');
    });

    test('server error: 503 is recorded as a retryable failure and a retry is scheduled', async () => {
      const session = await newSession();
      await setMode(session, 'server_error');
      const eventId = await submitEvent(session);
      await newWorker().runOnce();

      const delivery = await history(session, eventId);
      assert.equal(delivery.state, 'retry_scheduled');
      assert.ok(delivery.nextAttemptAt);
      assert.deepEqual(
        { ...delivery.attempts[0], startedAt: undefined, endedAt: undefined, durationMs: undefined },
        { attemptNumber: 1, outcome: 'failed', responseStatus: 503, errorCategory: 'http_error',
          retryable: true, startedAt: undefined, endedAt: undefined, durationMs: undefined });
      assert.equal(await receipts(session), 0);
      assert.equal(await newWorker().runOnce(), false, 'the retry is not due yet');
    });

    test('timeout: no response status, timeout category, nothing processed', async () => {
      const session = await newSession();
      await setMode(session, 'timeout');
      const eventId = await submitEvent(session);
      await newWorker().runOnce();

      const delivery = await history(session, eventId);
      assert.equal(delivery.state, 'retry_scheduled');
      const [attempt] = delivery.attempts;
      assert.equal(attempt.outcome, 'failed');
      assert.equal(attempt.errorCategory, 'timeout');
      assert.equal(attempt.retryable, true);
      assert.equal(attempt.responseStatus, null);
      assert.ok(attempt.durationMs >= TIMEOUT_MS - 20 && attempt.durationMs < SLOW_MS, `${attempt.durationMs} ms`);
      assert.equal(await receipts(session), 0);
    });
  });

  describe('worker enabled vs disabled, restart, shutdown', () => {
    test('with no worker running, accepted events stay pending', async () => {
      const session = await newSession();
      const eventId = await submitEvent(session);
      await sleep(200);
      const delivery = await history(session, eventId);
      assert.equal(delivery.state, 'pending');
      assert.deepEqual(delivery.attempts, []);
    });

    test('pending work survives a restart and is delivered by a fresh worker process', async () => {
      const session = await newSession();
      const ids = [await submitEvent(session), await submitEvent(session), await submitEvent(session)];

      // "Restart": a brand-new connection pool and worker, as a new process would have.
      const freshPool = createPool(url);
      const worker = createWorker({
        pool: freshPool, send, pollIntervalMs: 50, leaseMs: LEASE_MS, maxAttempts: 4, retryBaseDelayMs: 60_000,
        log: quietLog,
      });
      worker.start();
      try {
        await waitFor(async () => {
          const states = await Promise.all(ids.map(async (id) => (await history(session, id)).state));
          return states.every((s) => s === 'delivered');
        });
      } finally {
        await worker.stop();
        await freshPool.end();
      }
      assert.equal(await receipts(session), 3);
    });

    test('graceful stop: in-flight attempt finishes and is recorded; no new work is claimed', async () => {
      const session = await newSession();
      await setMode(session, 'timeout');
      const first = await submitEvent(session);
      const worker = newWorker();
      worker.start();

      // The attempt row exists before the HTTP request completes.
      await waitFor(async () => (await history(session, first)).attempts[0]?.outcome === 'in_progress');
      assert.equal((await history(session, first)).state, 'in_progress');

      await worker.stop();
      const delivery = await history(session, first);
      assert.equal(delivery.state, 'retry_scheduled', 'result recorded before stop() resolved');
      assert.equal(delivery.attempts[0].errorCategory, 'timeout');

      const second = await submitEvent(session);
      await sleep(200);
      assert.equal((await history(session, second)).state, 'pending', 'stopped worker claims nothing');
    });
  });

  describe('leases and competing workers', () => {
    test('expired lease (worker died before sending): attempt labelled lease_expired, job delivered again', async () => {
      const session = await newSession();
      const eventId = await submitEvent(session);
      await claimNext(pool, { leaseMs: LEASE_MS }); // a worker claims, then dies
      await expireLeases();

      assert.equal(await newWorker().runOnce(), true);
      const delivery = await history(session, eventId);
      assert.equal(delivery.state, 'delivered');
      assert.equal(delivery.attemptCount, 2);
      assert.equal(delivery.attempts[0].outcome, 'lease_expired');
      assert.equal(delivery.attempts[0].errorCategory, 'lease_expired');
      assert.equal(delivery.attempts[0].endedAt, null, 'end time is unknown, not invented');
      assert.equal(delivery.attempts[1].outcome, 'delivered');
      assert.equal(await receipts(session), 1);
    });

    test('crash after the receiver processed it: sent again (at-least-once), receiver recognizes the duplicate', async () => {
      const session = await newSession();
      const eventId = await submitEvent(session);
      const job = await claimNext(pool, { leaseMs: LEASE_MS });
      const result = await send({ sessionId: job.session_id, eventId: job.event_id, type: job.type, payload: job.payload });
      assert.equal(result.outcome, 'delivered'); // the receiver processed it...
      await expireLeases();                      // ...but the worker crashed before recording that

      await newWorker().runOnce();
      // The sender delivered twice; the receiver processed once and counted one duplicate.
      assert.equal(await receipts(session), 1, 'receiver processed the event once');
      const { rows: [row] } = await pool.query(
        'SELECT delivery_count FROM mock_receiver_receipts WHERE event_id = $1', [eventId]);
      assert.equal(row.delivery_count, 2, 'the receiver saw two deliveries');
      const delivery = await history(session, eventId);
      assert.deepEqual(delivery.attempts.map((a) => a.outcome), ['lease_expired', 'delivered']);
    });

    test('a worker whose lease expired cannot overwrite the newer claim\'s result', async () => {
      const session = await newSession();
      const eventId = await submitEvent(session);
      const staleJob = await claimNext(pool, { leaseMs: LEASE_MS });
      await expireLeases();
      await newWorker().runOnce(); // another worker recovers and delivers

      const recorded = await completeAttempt(pool, staleJob,
        { outcome: 'http_error', status: 503, durationMs: 5 });
      assert.equal(recorded, false);
      const delivery = await history(session, eventId);
      assert.equal(delivery.state, 'delivered');
      assert.deepEqual(delivery.attempts.map((a) => a.outcome), ['lease_expired', 'delivered']);
    });

    test('lease recovery is bounded: after the attempt limit the delivery fails', async () => {
      const session = await newSession();
      const eventId = await submitEvent(session);
      for (let i = 0; i < 2; i++) {
        assert.ok(await claimNext(pool, { leaseMs: LEASE_MS }));
        await expireLeases();
        await recoverExpired(pool, { maxAttempts: 2 });
      }
      const delivery = await history(session, eventId);
      assert.equal(delivery.state, 'failed');
      assert.ok(delivery.completedAt);
      assert.deepEqual(delivery.attempts.map((a) => a.outcome), ['lease_expired', 'lease_expired']);
      assert.equal(await claimNext(pool, { leaseMs: LEASE_MS }), null);
    });

    test('two workers competing for one job: exactly one claims and sends it', async () => {
      const otherPool = createPool(url);
      try {
        for (let round = 0; round < 5; round++) {
          const session = await newSession();
          const eventId = await submitEvent(session);
          const workerA = newWorker();
          const workerB = newWorker({ pool: otherPool });
          const results = await Promise.all([workerA.runOnce(), workerB.runOnce()]);
          assert.deepEqual(results.sort(), [false, true], `round ${round}`);
          const delivery = await history(session, eventId);
          assert.equal(delivery.attempts.length, 1);
          assert.equal(await receipts(session), 1);
        }
      } finally {
        await otherPool.end();
      }
    });

    test('two running workers drain a queue with each delivery attempted once', async () => {
      const session = await newSession();
      const ids = [];
      for (let i = 0; i < 12; i++) ids.push(await submitEvent(session));
      const otherPool = createPool(url);
      const workers = [newWorker(), newWorker({ pool: otherPool })];
      workers.forEach((w) => w.start());
      try {
        await waitFor(async () => (await pool.query(
          "SELECT count(*)::int AS n FROM deliveries WHERE state = 'delivered'")).rows[0].n === 12);
      } finally {
        await Promise.all(workers.map((w) => w.stop()));
        await otherPool.end();
      }
      const { rows: [{ attempts }] } = await pool.query('SELECT count(*)::int AS attempts FROM delivery_attempts');
      assert.equal(attempts, 12);
      assert.equal(await receipts(session), 12);
    });
  });

  describe('GET /v1/events/:id/deliveries access', () => {
    test('is scoped to the owning session', async () => {
      const owner = await newSession();
      const other = await newSession();
      const eventId = await submitEvent(owner);
      for (const id of [eventId, crypto.randomUUID(), 'not-a-uuid']) {
        const res = await request(server).get(`/v1/events/${id}/deliveries`).set('Authorization', `Bearer ${other.token}`);
        assert.equal(res.status, 404, id);
      }
      const noToken = await request(server).get(`/v1/events/${eventId}/deliveries`);
      assert.equal(noToken.status, 401);
      const wrongMethod = await request(server).post(`/v1/events/${eventId}/deliveries`)
        .set('Authorization', `Bearer ${owner.token}`);
      assert.equal(wrongMethod.status, 405);
    });
  });
});
