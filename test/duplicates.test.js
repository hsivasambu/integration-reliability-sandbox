const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const request = require('supertest');
const { createApp } = require('../src/app');
const { hashToken } = require('../src/sessions');
const { createDeliveryClient } = require('../src/delivery-client');
const { createWorker } = require('../src/worker');
const { skip, freshDatabase } = require('./helpers/db');

const SECRET = 'test-receiver-secret-0123456789abcdefghijkl';
const SLOW_MS = 1600;    // receiver delay (4000 in production)
const TIMEOUT_MS = 800;  // sender timeout (2000 in production)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('receiver-side duplicate protection', { skip }, () => {
  let pool;
  let app;
  let server;
  let send;
  let fakeNow;
  let workerErrors;
  const clock = () => new Date(fakeNow);
  const quietLog = { log() {}, error: (msg) => workerErrors.push(msg) };
  const newWorker = () => createWorker({
    pool, send, pollIntervalMs: 20, leaseMs: 3000, maxAttempts: 4, retryBaseDelayMs: 2000, clock, log: quietLog,
  });

  before(async () => {
    pool = await freshDatabase();
    app = createApp({
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
    await pool.query('TRUNCATE demo_sessions CASCADE');
  });
  afterEach(() => assert.deepEqual(workerErrors, [], 'worker logged no errors'));

  async function syncClock() {
    const { rows: [{ ms }] } = await pool.query(
      "SELECT floor(extract(epoch FROM now() + interval '1 second') * 1000)::float8 AS ms");
    fakeNow = ms;
  }
  async function newSession() {
    const res = await request(server).post('/v1/sessions').expect(201);
    const { rows: [row] } = await pool.query(
      'SELECT id FROM demo_sessions WHERE token_hash = $1', [hashToken(res.body.token)]);
    return { token: res.body.token, id: row.id };
  }
  const authed = (session, req) => req.set('Authorization', `Bearer ${session.token}`);
  const setMode = (session, mode) => authed(session, request(server).put('/v1/receiver')).send({ mode }).expect(200);
  async function submitEvent(session, key = crypto.randomUUID()) {
    const res = await authed(session, request(server).post('/v1/events'))
      .set('Idempotency-Key', key)
      .send({ type: 'demo.notification', payload: { title: 'Synthetic title', message: 'Synthetic message' } });
    assert.ok([200, 202].includes(res.status));
    return res.body.eventId;
  }
  const delivery = (session, eventId) => ({
    sessionId: session.id, eventId, type: 'demo.notification',
    payload: { title: 'Synthetic title', message: 'Synthetic message' },
  });
  const receiverView = async (session, eventId) =>
    (await authed(session, request(server).get(`/v1/receiver/receipts/${eventId}`)).expect(200)).body;
  const receiverSummary = async (session) =>
    (await authed(session, request(server).get('/v1/receiver')).expect(200)).body;
  const senderView = async (session, eventId) =>
    (await authed(session, request(server).get(`/v1/events/${eventId}/deliveries`)).expect(200)).body.delivery;

  test('concurrent duplicate deliveries: processed once, every copy gets the same result', async () => {
    const session = await newSession();
    const eventId = await submitEvent(session);
    const results = await Promise.all(Array.from({ length: 10 }, () => send(delivery(session, eventId))));

    assert.ok(results.every((r) => r.outcome === 'delivered' && r.status === 200));
    assert.equal(results.filter((r) => r.body.duplicate === false).length, 1, 'exactly one copy did the work');
    assert.equal(new Set(results.map((r) => r.body.result.confirmationCode)).size, 1, 'one result, shared');

    const view = await receiverView(session, eventId);
    assert.equal(view.processed, true);
    assert.equal(view.deliveriesReceived, 10);
    assert.equal(view.duplicateCount, 9);
    const summary = await receiverSummary(session);
    assert.equal(summary.processedCount, 1);
    assert.equal(summary.duplicateCount, 9);
  });

  test('an existing receipt is recognized before simulating a failure', async () => {
    const session = await newSession();
    const eventId = await submitEvent(session);
    const first = await send(delivery(session, eventId));
    assert.equal(first.body.duplicate, false);

    await setMode(session, 'server_error');
    const duringOutage = await send(delivery(session, eventId));
    assert.equal(duringOutage.status, 200, 'already processed, so no simulated 503');
    assert.equal(duringOutage.body.duplicate, true);

    await setMode(session, 'timeout');
    const duringSlowness = await send(delivery(session, eventId));
    assert.equal(duringSlowness.status, 200);
    assert.ok(duringSlowness.durationMs < TIMEOUT_MS, 'answered immediately, no simulated delay');
    assert.equal(duringSlowness.body.result.confirmationCode, first.body.result.confirmationCode);
  });

  test('ordinary timeout and server_error modes still process nothing', async () => {
    const session = await newSession();
    await setMode(session, 'timeout');
    const slowEvent = await submitEvent(session);
    assert.equal((await send(delivery(session, slowEvent))).outcome, 'timeout');
    await sleep(SLOW_MS + 100); // past the moment a late reply would have been sent
    assert.equal((await receiverView(session, slowEvent)).processed, false);

    await setMode(session, 'server_error');
    const failedEvent = await submitEvent(session);
    assert.equal((await send(delivery(session, failedEvent))).status, 503);
    assert.equal((await receiverView(session, failedEvent)).processed, false);
    assert.equal(app.locals.receiverStats().pendingDelays, 0);
  });

  test('process_then_timeout: receiver commits, sender times out, the retry is recognized as a duplicate', async () => {
    const session = await newSession();
    await setMode(session, 'process_then_timeout');
    const eventId = await submitEvent(session);
    await syncClock();
    const worker = newWorker();

    await worker.runOnce();
    // Sender's knowledge: the attempt timed out; it cannot tell whether anything happened.
    let sender = await senderView(session, eventId);
    assert.equal(sender.state, 'retry_scheduled');
    assert.equal(sender.attempts[0].errorCategory, 'timeout');
    assert.equal(sender.attempts[0].responseStatus, null);
    // Receiver's reality: it already processed the event.
    let receiver = await receiverView(session, eventId);
    assert.equal(receiver.processed, true);
    assert.equal(receiver.deliveriesReceived, 1);
    const { confirmationCode } = receiver.result;

    fakeNow += 2000; // the retry is due
    await worker.runOnce();
    sender = await senderView(session, eventId);
    assert.equal(sender.state, 'delivered');
    assert.deepEqual(sender.attempts.map((a) => [a.outcome, a.responseStatus]), [['failed', null], ['delivered', 200]]);
    receiver = await receiverView(session, eventId);
    assert.equal(receiver.duplicateCount, 1);
    assert.equal(receiver.result.confirmationCode, confirmationCode, 'the result was not repeated');
    assert.equal((await receiverSummary(session)).processedCount, 1);
  });

  test('retry after switching the receiver back to success: still processed only once', async () => {
    const session = await newSession();
    await setMode(session, 'process_then_timeout');
    const eventId = await submitEvent(session);
    await syncClock();
    const worker = newWorker();
    await worker.runOnce();
    const { confirmationCode } = (await receiverView(session, eventId)).result;

    await setMode(session, 'success');
    fakeNow += 2000;
    await worker.runOnce();
    assert.equal((await senderView(session, eventId)).state, 'delivered');
    const receiver = await receiverView(session, eventId);
    assert.equal(receiver.duplicateCount, 1);
    assert.equal(receiver.result.confirmationCode, confirmationCode);
    assert.equal((await receiverSummary(session)).processedCount, 1);
  });

  test('submission idempotency and receiver idempotency protect different things', async () => {
    const session = await newSession();
    await syncClock();
    // Same Idempotency-Key twice: one event, one delivery, processed once.
    const a = await submitEvent(session, 'same-key');
    const b = await submitEvent(session, 'same-key');
    assert.equal(a, b);
    // Same content under a new key: a *different* event (new ID), so the receiver processes it too.
    const c = await submitEvent(session, 'other-key');
    assert.notEqual(c, a);

    const worker = newWorker();
    while (await worker.runOnce()) { /* drain */ }
    assert.equal((await receiverSummary(session)).processedCount, 2, 'deduplication is by event ID, not content');
    assert.equal((await receiverSummary(session)).duplicateCount, 0);
  });

  test('receipt reads are scoped to the session', async () => {
    const owner = await newSession();
    const other = await newSession();
    const eventId = await submitEvent(owner);
    assert.deepEqual(
      { ...(await receiverView(owner, eventId)), eventId: undefined },
      { eventId: undefined, processed: false, result: null, firstReceivedAt: null,
        lastReceivedAt: null, deliveriesReceived: 0, duplicateCount: 0 });
    for (const id of [eventId, crypto.randomUUID(), 'nope']) {
      const res = await authed(other, request(server).get(`/v1/receiver/receipts/${id}`));
      assert.equal(res.status, 404, id);
    }
    assert.equal((await request(server).get(`/v1/receiver/receipts/${eventId}`)).status, 401);
  });
});
