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
const MAX_REPLAYS = 2;

describe('manual replay', { skip }, () => {
  let pool;
  let server;
  let worker;
  let fakeNow;
  let workerErrors;
  const quietLog = { log() {}, debug() {}, info() {}, warn() {}, error: (msg) => workerErrors.push(msg) };

  before(async () => {
    pool = await freshDatabase();
    const app = createApp({
      pool,
      config: {
        receiverSecret: SECRET,
        receiverSlowResponseMs: 1600,
        sessionRateLimit: { max: 1000, windowMs: 60_000 },
        maxReplaysPerEvent: MAX_REPLAYS,
      },
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const send = createDeliveryClient({
      receiverUrl: `http://127.0.0.1:${server.address().port}/internal/receiver/deliveries`,
      receiverSecret: SECRET,
      deliveryTimeoutMs: 800,
    });
    worker = createWorker({
      pool, send, pollIntervalMs: 20, leaseMs: 3000, maxAttempts: 4, retryBaseDelayMs: 2000,
      clock: () => new Date(fakeNow), log: quietLog,
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

  // Runs the worker until nothing is due, advancing the fake clock past each scheduled retry.
  async function drain() {
    const { rows: [{ ms }] } = await pool.query(
      "SELECT floor(extract(epoch FROM now() + interval '1 second') * 1000)::float8 AS ms");
    fakeNow = Math.max(fakeNow ?? 0, ms);
    for (let i = 0; i < 50; i++) {
      if (!(await worker.runOnce())) {
        const { rows: [next] } = await pool.query(
          "SELECT min(next_attempt_at) AS at FROM deliveries WHERE state = 'retry_scheduled'");
        if (!next.at) return;
        fakeNow = Math.max(fakeNow, next.at.getTime());
      }
    }
    throw new Error('drain did not finish');
  }
  async function newSession() {
    const res = await request(server).post('/v1/sessions').expect(201);
    const { rows: [row] } = await pool.query(
      'SELECT id FROM demo_sessions WHERE token_hash = $1', [hashToken(res.body.token)]);
    return { token: res.body.token, id: row.id };
  }
  const authed = (session, req) => req.set('Authorization', `Bearer ${session.token}`);
  const setMode = (session, mode) => authed(session, request(server).put('/v1/receiver')).send({ mode }).expect(200);
  async function submitEvent(session) {
    const res = await authed(session, request(server).post('/v1/events'))
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ type: 'demo.notification', payload: { title: 'Synthetic title', message: 'Synthetic message' } })
      .expect(202);
    return { eventId: res.body.eventId, deliveryId: res.body.event.delivery.id };
  }
  const history = async (session, eventId) =>
    (await authed(session, request(server).get(`/v1/events/${eventId}/deliveries`)).expect(200)).body;
  const replay = (session, deliveryId, key = crypto.randomUUID()) =>
    authed(session, request(server).post(`/v1/deliveries/${deliveryId}/replay`)).set('Idempotency-Key', key);

  // An event whose delivery has failed terminally (4 attempts of 503).
  async function failedEvent(session) {
    await setMode(session, 'server_error');
    const ids = await submitEvent(session);
    await drain();
    assert.equal((await history(session, ids.eventId)).delivery.state, 'failed');
    return ids;
  }

  test('failed then successful replay: new linked delivery, same event ID, history kept separately', async () => {
    const session = await newSession();
    const { eventId, deliveryId } = await failedEvent(session);
    const before = await history(session, eventId);

    await setMode(session, 'success');
    const res = await replay(session, deliveryId);
    assert.equal(res.status, 202);
    assert.equal(res.headers.location, `/v1/events/${eventId}/deliveries`);
    assert.equal(res.body.eventId, eventId);
    assert.equal(res.body.delivery.replayOf, deliveryId);
    assert.notEqual(res.body.delivery.id, deliveryId);
    assert.equal(res.body.delivery.state, 'pending');
    assert.equal(res.body.delivery.attemptCount, 0, 'fresh attempt budget');
    assert.equal(res.body.delivery.maxAttempts, 4);

    await drain();
    const after = await history(session, eventId);
    assert.equal(after.deliveries.length, 2);
    const [original, replayed] = after.deliveries;
    assert.equal(original.id, deliveryId);
    assert.equal(original.state, 'failed');
    assert.equal(original.failureReason, 'attempts_exhausted');
    assert.equal(original.replayedBy, replayed.id);
    assert.deepEqual(original.attempts, before.delivery.attempts, 'original attempts unchanged');
    assert.equal(replayed.replayOf, deliveryId);
    assert.equal(replayed.state, 'delivered');
    assert.deepEqual(replayed.attempts.map((a) => [a.attemptNumber, a.outcome]), [[1, 'delivered']]);
    assert.equal(after.delivery.id, replayed.id, '`delivery` is the latest');

    const event = await authed(session, request(server).get(`/v1/events/${eventId}`)).expect(200);
    assert.equal(event.body.event.delivery.state, 'delivered');
    assert.equal(event.body.event.delivery.replayCount, 1);

    // The receiver saw the same event ID (the 503s processed nothing; the replay processed it once).
    const receipt = await authed(session, request(server).get(`/v1/receiver/receipts/${eventId}`)).expect(200);
    assert.equal(receipt.body.processed, true);
    assert.equal(receipt.body.deliveriesReceived, 1);
  });

  test('replay of an event the receiver already processed is recognized as a duplicate', async () => {
    const session = await newSession();
    // process_then_timeout: the receiver processes, but every reply is late, so the sender
    // exhausts its attempts... except that retries are recognized as duplicates and succeed.
    // To get a failed delivery of an already-processed event, process it out of band first.
    const { eventId, deliveryId } = await failedEvent(session);
    await pool.query(
      `INSERT INTO mock_receiver_receipts (session_id, event_id, result)
       VALUES ($1, $2, '{"confirmationCode":"RCPT-EARLIER","summary":"processed earlier"}')`,
      [session.id, eventId]);
    await replay(session, deliveryId).expect(202);
    await drain();
    const receipt = await authed(session, request(server).get(`/v1/receiver/receipts/${eventId}`)).expect(200);
    assert.equal(receipt.body.result.confirmationCode, 'RCPT-EARLIER');
    assert.equal(receipt.body.duplicateCount, 1);
  });

  test('duplicate replay submission returns the same new delivery, even after it completes', async () => {
    const session = await newSession();
    const { deliveryId } = await failedEvent(session);
    await setMode(session, 'success');
    const first = await replay(session, deliveryId, 'replay-key-1').expect(202);
    const again = await replay(session, deliveryId, 'replay-key-1');
    assert.equal(again.status, 200);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal(again.body.delivery.id, first.body.delivery.id);

    await drain();
    const later = await replay(session, deliveryId, 'replay-key-1');
    assert.equal(later.status, 200);
    assert.equal(later.body.delivery.id, first.body.delivery.id);
    assert.equal(later.body.delivery.state, 'delivered', 'shows the current state');
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE replay_of = $1', [deliveryId]);
    assert.equal(n, 1);
  });

  test('concurrent replay requests schedule exactly one replay', async () => {
    const session = await newSession();
    const { eventId, deliveryId } = await failedEvent(session);

    const sameKey = await Promise.all(Array.from({ length: 8 }, () => replay(session, deliveryId, 'race-key')));
    assert.deepEqual(sameKey.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 202]);
    assert.equal(new Set(sameKey.map((r) => r.body.delivery.id)).size, 1);

    const session2 = await newSession();
    const other = await failedEvent(session2);
    const differentKeys = await Promise.all(Array.from({ length: 8 }, () => replay(session2, other.deliveryId)));
    const statuses = differentKeys.map((r) => r.status).sort();
    assert.deepEqual(statuses, [202, 409, 409, 409, 409, 409, 409, 409]);
    assert.ok(differentKeys.filter((r) => r.status === 409).every((r) => r.body.error === 'already_replayed'));

    for (const id of [eventId, other.eventId]) {
      const { rows: [{ active, replays }] } = await pool.query(
        `SELECT count(*) FILTER (WHERE state IN ('pending','retry_scheduled','in_progress'))::int AS active,
                count(*) FILTER (WHERE replay_of IS NOT NULL)::int AS replays
         FROM deliveries WHERE event_id = $1`, [id]);
      assert.equal(replays, 1, 'exactly one replay scheduled');
      assert.ok(active <= 1, 'never more than one active delivery');
    }
  });

  test('session isolation and authentication', async () => {
    const owner = await newSession();
    const intruder = await newSession();
    const { deliveryId } = await failedEvent(owner);
    for (const id of [deliveryId, crypto.randomUUID(), 'not-a-uuid']) {
      const res = await replay(intruder, id);
      assert.equal(res.status, 404, id);
      assert.equal(res.body.error, 'not_found');
    }
    const noToken = await request(server).post(`/v1/deliveries/${deliveryId}/replay`).set('Idempotency-Key', 'k');
    assert.equal(noToken.status, 401);
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE replay_of = $1', [deliveryId]);
    assert.equal(n, 0, 'nothing was scheduled');
  });

  test('only terminally failed deliveries are eligible', async () => {
    const session = await newSession();
    await setMode(session, 'success');
    const pending = await submitEvent(session);
    const notYet = await replay(session, pending.deliveryId);
    assert.equal(notYet.status, 409);
    assert.equal(notYet.body.error, 'delivery_not_failed');
    assert.equal(notYet.body.state, 'pending');

    await drain();
    const delivered = await replay(session, pending.deliveryId);
    assert.equal(delivered.status, 409);
    assert.equal(delivered.body.state, 'delivered');

    await setMode(session, 'server_error');
    const scheduled = await submitEvent(session);
    fakeNow = Date.now() + 1000;
    await worker.runOnce(); // one failure: retry_scheduled, not terminal
    const retrying = await replay(session, scheduled.deliveryId);
    assert.equal(retrying.status, 409);
    assert.equal(retrying.body.state, 'retry_scheduled');
  });

  test('already replayed, conflicting key, missing key, body, and the per-event cap', async () => {
    const session = await newSession();
    const { eventId, deliveryId } = await failedEvent(session); // receiver stays in server_error

    const first = await replay(session, deliveryId, 'key-A').expect(202);
    const again = await replay(session, deliveryId, 'key-B');
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'already_replayed');
    assert.equal(again.body.replayDeliveryId, first.body.delivery.id);

    const otherEvent = await failedEvent(session);
    const conflict = await replay(session, otherEvent.deliveryId, 'key-A');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'idempotency_key_conflict');

    const noKey = await authed(session, request(server).post(`/v1/deliveries/${deliveryId}/replay`));
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error, 'idempotency_key_required');
    const withBody = await replay(session, otherEvent.deliveryId).send({ url: 'http://example.com' });
    assert.equal(withBody.status, 422);

    // Replays of the same event: the first replay fails too; replay that one, and so on.
    await drain();
    const second = await replay(session, first.body.delivery.id).expect(202);
    await drain();
    const capped = await replay(session, second.body.delivery.id);
    assert.equal(capped.status, 429);
    assert.equal(capped.body.error, 'replay_limit_reached');
    assert.equal(capped.body.limit, MAX_REPLAYS);

    const { deliveries } = await history(session, eventId);
    assert.deepEqual(deliveries.map((d) => [d.state, d.attemptCount]), [['failed', 4], ['failed', 4], ['failed', 4]]);
    assert.deepEqual(deliveries.map((d) => d.replayOf), [null, deliveries[0].id, deliveries[1].id]);
  });

  test('database constraints back up the rules', async () => {
    const session = await newSession();
    const { eventId, deliveryId } = await failedEvent(session);
    await replay(session, deliveryId).expect(202); // now one active delivery
    await assert.rejects(
      pool.query('INSERT INTO deliveries (event_id) VALUES ($1)', [eventId]),
      (err) => err.code === '23505' && err.constraint === 'deliveries_one_active_per_event');
    await assert.rejects(
      pool.query("INSERT INTO deliveries (event_id, replay_of, state, completed_at) VALUES ($1, $2, 'failed', now())",
        [eventId, deliveryId]),
      (err) => err.code === '23505' && err.constraint === 'deliveries_replay_of_key');
  });
});
