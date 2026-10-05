const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const request = require('supertest');
const { createApp } = require('../src/app');
const { createPool } = require('../src/db');
const { hashToken } = require('../src/sessions');
const { createDeliveryClient } = require('../src/delivery-client');
const { createWorker } = require('../src/worker');
const { claimNext, recoverExpired } = require('../src/delivery-store');
const { isRetryable, retryDelayMs, decideAfterAttempt } = require('../src/retry-policy');
const { skip, freshDatabase, url } = require('./helpers/db');

describe('retry policy', () => {
  const http = (status) => ({ outcome: 'http_error', status });

  test('retries transport failures, timeouts, 408, 429 and 5xx; other 4xx are terminal', () => {
    for (const result of [{ outcome: 'timeout' }, { outcome: 'network_error' },
      http(408), http(429), http(500), http(502), http(503), http(504)]) {
      assert.equal(isRetryable(result), true, JSON.stringify(result));
    }
    for (const result of [http(400), http(401), http(403), http(404), http(409), http(422),
      { outcome: 'delivered', status: 200 }]) {
      assert.equal(isRetryable(result), false, JSON.stringify(result));
    }
  });

  test('delays are deterministic: 2 s, 4 s, 8 s', () => {
    assert.deepEqual([1, 2, 3].map((n) => retryDelayMs(n, 2000)), [2000, 4000, 8000]);
  });

  test('decides delivered, retry_scheduled, or failed with a reason', () => {
    const policy = { maxAttempts: 4, baseDelayMs: 2000 };
    assert.equal(decideAfterAttempt({ outcome: 'delivered', status: 200 }, 1, policy).state, 'delivered');
    assert.deepEqual(decideAfterAttempt(http(503), 1, policy),
      { state: 'retry_scheduled', outcome: 'failed', errorCategory: 'http_error', retryable: true, retryDelayMs: 2000 });
    assert.equal(decideAfterAttempt({ outcome: 'timeout' }, 3, policy).retryDelayMs, 8000);
    assert.deepEqual(decideAfterAttempt(http(503), 4, policy),
      { state: 'failed', outcome: 'failed', errorCategory: 'http_error', retryable: true, failureReason: 'attempts_exhausted' });
    assert.deepEqual(decideAfterAttempt(http(404), 1, policy),
      { state: 'failed', outcome: 'failed', errorCategory: 'http_error', retryable: false, failureReason: 'non_retryable' });
  });
});

const SECRET = 'test-receiver-secret-0123456789abcdefghijkl';
const LEASE_MS = 3000;

describe('retry scheduling (controllable clock)', { skip }, () => {
  let pool;
  let server;
  let send;
  let fakeNow;
  let workerErrors;
  const clock = () => new Date(fakeNow);
  const advance = (ms) => { fakeNow += ms; };
  const quietLog = { log() {}, debug() {}, info() {}, warn() {}, error: (msg) => workerErrors.push(msg) };
  const newWorker = (overrides = {}) => createWorker({
    pool, send, pollIntervalMs: 20, leaseMs: LEASE_MS, maxAttempts: 4, retryBaseDelayMs: 2000,
    clock, log: quietLog, ...overrides,
  });

  before(async () => {
    pool = await freshDatabase();
    const app = createApp({
      pool,
      config: {
        receiverSecret: SECRET,
        receiverSlowResponseMs: 1600,
        sessionRateLimit: { max: 1000, windowMs: 60_000 },
      },
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    send = createDeliveryClient({
      receiverUrl: `http://127.0.0.1:${server.address().port}/internal/receiver/deliveries`,
      receiverSecret: SECRET,
      deliveryTimeoutMs: 800,
    });
  });
  after(async () => {
    server?.close();
    await pool?.end();
  });
  beforeEach(async () => {
    workerErrors = [];
    await pool.query('TRUNCATE demo_sessions CASCADE');
  });
  afterEach(() => assert.deepEqual(workerErrors, [], 'worker logged no errors'));

  // Starts the fake clock just after the database's current time, so freshly created
  // deliveries are already due.
  async function syncClock() {
    const { rows: [{ ms }] } = await pool.query(
      "SELECT floor(extract(epoch FROM now() + interval '1 second') * 1000)::float8 AS ms");
    fakeNow = ms;
    return fakeNow;
  }
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
  const at = (ms) => new Date(ms).toISOString();

  test('immediate success: one attempt, delivered, nothing scheduled', async () => {
    const session = await newSession();
    const eventId = await submitEvent(session);
    await syncClock();
    assert.equal(await newWorker().runOnce(), true);
    const delivery = await history(session, eventId);
    assert.equal(delivery.state, 'delivered');
    assert.equal(delivery.attemptCount, 1);
    assert.equal(delivery.maxAttempts, 4);
    assert.equal(delivery.nextAttemptAt, null);
    assert.equal(delivery.failureReason, null);
  });

  test('server_error then success: retried after 2 s and delivered on attempt 2', async () => {
    const session = await newSession();
    await setMode(session, 'server_error');
    const eventId = await submitEvent(session);
    const t0 = await syncClock();
    const worker = newWorker();

    await worker.runOnce();
    let delivery = await history(session, eventId);
    assert.equal(delivery.state, 'retry_scheduled');
    assert.equal(delivery.nextAttemptAt, at(t0 + 2000), 'next retry is shown in the API');

    advance(1999);
    assert.equal(await worker.runOnce(), false, 'not due 1 ms early');

    await setMode(session, 'success'); // the receiver recovers between attempts
    advance(1);
    assert.equal(await worker.runOnce(), true);
    delivery = await history(session, eventId);
    assert.equal(delivery.state, 'delivered');
    assert.equal(delivery.nextAttemptAt, null);
    assert.deepEqual(delivery.attempts.map((a) => [a.outcome, a.responseStatus, a.retryable]),
      [['failed', 503, true], ['delivered', 200, null]]);
    assert.equal(await receipts(session), 1);
  });

  test('exhaustion: four attempts 2 s, 4 s, 8 s apart, then failed', async () => {
    const session = await newSession();
    await setMode(session, 'server_error');
    const eventId = await submitEvent(session);
    await syncClock();
    const worker = newWorker();

    const gaps = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      assert.equal(await worker.runOnce(), true, `attempt ${attempt}`);
      const delivery = await history(session, eventId);
      if (attempt < 4) {
        assert.equal(delivery.state, 'retry_scheduled');
        const wait = Date.parse(delivery.nextAttemptAt) - fakeNow;
        gaps.push(wait);
        advance(wait);
      }
    }
    assert.deepEqual(gaps, [2000, 4000, 8000]);

    const delivery = await history(session, eventId);
    assert.equal(delivery.state, 'failed');
    assert.equal(delivery.failureReason, 'attempts_exhausted');
    assert.equal(delivery.attemptCount, 4);
    assert.equal(delivery.nextAttemptAt, null);
    assert.ok(delivery.completedAt);
    assert.equal(delivery.attempts.length, 4);
    advance(60_000);
    assert.equal(await worker.runOnce(), false, 'no fifth attempt');
  });

  test('terminal 4xx: a 404 from the receiver fails immediately without retry', async () => {
    const session = await newSession();
    const eventId = await submitEvent(session);
    // A stand-in destination that rejects every delivery with 404 (real HTTP).
    const rejecting = http.createServer((req, res) => {
      req.resume();
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not_found"}');
    });
    rejecting.listen(0, '127.0.0.1');
    await once(rejecting, 'listening');
    const sendToRejecting = createDeliveryClient({
      receiverUrl: `http://127.0.0.1:${rejecting.address().port}/`, receiverSecret: SECRET, deliveryTimeoutMs: 800,
    });
    await syncClock();
    try {
      await newWorker({ send: sendToRejecting }).runOnce();
    } finally {
      rejecting.close();
    }

    const { rows: [row] } = await pool.query(
      `SELECT d.state, d.failure_reason, d.attempt_count, a.response_status, a.retryable, a.error_category
       FROM deliveries d JOIN delivery_attempts a ON a.delivery_id = d.id WHERE d.event_id = $1`, [eventId]);
    assert.deepEqual(row, {
      state: 'failed', failure_reason: 'non_retryable', attempt_count: 1,
      response_status: 404, retryable: false, error_category: 'http_error',
    });
  });

  test('restart during a scheduled retry: a new process resumes from the stored schedule', async () => {
    const session = await newSession();
    await setMode(session, 'server_error');
    const eventId = await submitEvent(session);
    const t0 = await syncClock();
    await newWorker().runOnce(); // first attempt fails; the original worker then "dies"

    // The schedule is only in PostgreSQL.
    const { rows: [stored] } = await pool.query(
      'SELECT state, next_attempt_at FROM deliveries WHERE event_id = $1', [eventId]);
    assert.equal(stored.state, 'retry_scheduled');
    assert.equal(stored.next_attempt_at.toISOString(), at(t0 + 2000));

    await setMode(session, 'success');
    const freshPool = createPool(url); // a brand-new process
    const worker = newWorker({ pool: freshPool });
    worker.start();
    try {
      advance(1000);
      await new Promise((resolve) => setTimeout(resolve, 150)); // several polls
      assert.equal((await history(session, eventId)).state, 'retry_scheduled', 'not yet due');
      advance(1000);
      const deadline = Date.now() + 3000;
      while ((await history(session, eventId)).state !== 'delivered') {
        assert.ok(Date.now() < deadline, 'retry was not resumed');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await worker.stop();
      await freshPool.end();
    }
    const delivery = await history(session, eventId);
    assert.equal(delivery.attemptCount, 2);
  });

  test('crash recovery is not a confirmed failure, but recovered sends count toward the limit', async () => {
    const session = await newSession();
    await setMode(session, 'server_error');
    const eventId = await submitEvent(session);
    await syncClock();

    for (let crash = 1; crash <= 3; crash++) {
      assert.ok(await claimNext(pool, { leaseMs: LEASE_MS, now: clock() })); // worker claims, then dies
      advance(LEASE_MS + 1);
      assert.equal(await recoverExpired(pool, { maxAttempts: 4, now: clock() }), 1);
      const delivery = await history(session, eventId);
      assert.equal(delivery.state, 'pending', 'uncertain attempt: due again now, no backoff');
      assert.equal(delivery.nextAttemptAt, at(fakeNow));
    }

    await newWorker().runOnce(); // attempt 4 gets a real (retryable) 503
    const delivery = await history(session, eventId);
    assert.deepEqual(delivery.attempts.map((a) => a.outcome),
      ['lease_expired', 'lease_expired', 'lease_expired', 'failed']);
    assert.deepEqual(delivery.attempts.map((a) => a.errorCategory),
      ['lease_expired', 'lease_expired', 'lease_expired', 'http_error']);
    assert.equal(delivery.state, 'failed');
    assert.equal(delivery.failureReason, 'attempts_exhausted');
  });

  test('concurrency is bounded and polling runs never overlap', async () => {
    const session = await newSession();
    await setMode(session, 'timeout'); // each attempt takes ~800 ms
    for (let i = 0; i < 5; i++) await submitEvent(session);
    const worker = newWorker({ clock: null, concurrency: 2, retryBaseDelayMs: 60_000 });
    worker.start();
    let maxInProgress = 0;
    let maxInFlight = 0;
    try {
      const until = Date.now() + 1500;
      while (Date.now() < until) {
        await Promise.all([worker.poll(), worker.poll(), worker.poll()]); // extra, concurrent polls
        const { rows: [{ n }] } = await pool.query(
          "SELECT count(*)::int AS n FROM deliveries WHERE state = 'in_progress'");
        maxInProgress = Math.max(maxInProgress, n);
        maxInFlight = Math.max(maxInFlight, worker.inFlightCount());
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await worker.stop();
    }
    assert.equal(maxInProgress, 2);
    assert.equal(maxInFlight, 2);
  });
});
