const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../src/app');
const { skip, freshDatabase } = require('./helpers/db');

const validEvent = (overrides = {}) => ({
  type: 'demo.notification',
  payload: { title: 'Synthetic title', message: 'Synthetic message' },
  ...overrides,
});

describe('event API', { skip }, () => {
  let pool;
  let server;
  let token;

  before(async () => {
    pool = await freshDatabase();
    // A real listening server, so concurrent requests are truly concurrent.
    server = createApp({ pool, config: {
      maxEventsPerSession: 5,
      sessionRateLimit: { max: 1000, windowMs: 60_000 },
    } }).listen(0);
  });
  after(async () => {
    server?.close();
    await pool?.end();
  });

  async function newSession() {
    const res = await request(server).post('/v1/sessions').expect(201);
    return res.body.token;
  }

  function submit(body, { key = crypto.randomUUID(), auth = token } = {}) {
    const req = request(server).post('/v1/events').set('Idempotency-Key', key);
    if (auth) req.set('Authorization', `Bearer ${auth}`);
    return req.send(body);
  }

  const countEvents = async () =>
    (await pool.query('SELECT count(*)::int AS count FROM events')).rows[0].count;

  beforeEach(async () => { token = await newSession(); });

  describe('POST /v1/events', () => {
    test('accepts a new event with 202, a status URL, and a pending delivery created with it', async () => {
      const res = await submit(validEvent());
      assert.equal(res.status, 202);
      assert.equal(res.body.eventId, res.body.event.id);
      assert.equal(res.body.statusUrl, `/v1/events/${res.body.eventId}/deliveries`);
      assert.equal(res.body.event.delivery.state, 'pending');
      assert.equal(res.body.event.status, undefined, 'no separate event status field');
      assert.equal(res.body.event.type, 'demo.notification');
      assert.deepEqual(res.body.event.payload, validEvent().payload);
      assert.match(res.body.notice, /not been delivered yet/);
      assert.equal(res.headers.location, res.body.statusUrl);

      const { rows } = await pool.query(
        `SELECT e.session_id, d.state FROM events e JOIN deliveries d ON d.event_id = e.id WHERE e.id = $1`,
        [res.body.eventId]);
      assert.equal(rows[0].state, 'pending');
      assert.ok(rows[0].session_id, 'event is linked to its session');
    });

    test('accepts maximum-length fields (counted in characters, not bytes)', async () => {
      const res = await submit(validEvent({
        payload: { title: 'é'.repeat(100), message: `line one\n${'🙂'.repeat(491)}` },
      }));
      assert.equal(res.status, 202);
    });

    test('rejects invalid payloads with a consistent 422 error listing every problem', async () => {
      const cases = [
        [validEvent({ type: 'other.type' }), 'type'],
        [validEvent({ extra: 1 }), 'extra'],
        [validEvent({ payload: { title: 'x', message: 'y', priority: 'high' } }), 'payload.priority'],
        [validEvent({ payload: { message: 'y' } }), 'payload.title'],
        [validEvent({ payload: { title: '   ', message: 'y' } }), 'payload.title'],
        [validEvent({ payload: { title: 5, message: 'y' } }), 'payload.title'],
        [validEvent({ payload: { title: 'x'.repeat(101), message: 'y' } }), 'payload.title'],
        [validEvent({ payload: { title: 'x', message: 'y'.repeat(501) } }), 'payload.message'],
        [validEvent({ payload: { title: 'a\nb', message: 'y' } }), 'payload.title'],
        [validEvent({ payload: 'text' }), 'payload'],
        [[validEvent()], '(body)'],
      ];
      const before = await countEvents();
      for (const [body, field] of cases) {
        const res = await submit(body);
        assert.equal(res.status, 422, JSON.stringify(body));
        assert.equal(res.body.error, 'validation_failed');
        assert.equal(typeof res.body.message, 'string');
        assert.ok(res.body.details.some((d) => d.field === field), `${field} in ${JSON.stringify(res.body.details)}`);
      }
      const multiple = await submit({ payload: { extra: true } });
      assert.ok(multiple.body.details.length >= 4, 'all problems are reported at once');

      assert.equal(await countEvents(), before, 'nothing invalid was stored');
    });

    test('requires a valid bearer token', async () => {
      const missing = await submit(validEvent(), { auth: null });
      assert.equal(missing.status, 401);
      assert.equal(missing.body.error, 'missing_token');
      const invalid = await submit(validEvent(), { auth: `irs_${'B'.repeat(43)}` });
      assert.equal(invalid.status, 401);
      assert.equal(invalid.body.error, 'invalid_token');
    });

    test('requires a well-formed Idempotency-Key header', async () => {
      const missing = await request(server).post('/v1/events')
        .set('Authorization', `Bearer ${token}`).send(validEvent());
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error, 'idempotency_key_required');
      const bad = await submit(validEvent(), { key: 'has spaces in it' });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, 'invalid_idempotency_key');
    });

    test('requires JSON', async () => {
      const res = await request(server).post('/v1/events')
        .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'k1')
        .set('Content-Type', 'text/plain').send('hello');
      assert.equal(res.status, 415);
    });

    test('identical repeat returns 200 with the original event and stores nothing new', async () => {
      const before = await countEvents();
      const first = await submit(validEvent(), { key: 'retry-1' });
      // Same data, different key order: still the same request.
      const repeat = await submit(
        { payload: { message: 'Synthetic message', title: 'Synthetic title' }, type: 'demo.notification' },
        { key: 'retry-1' });
      assert.equal(first.status, 202);
      assert.equal(repeat.status, 200);
      assert.equal(repeat.headers['idempotent-replayed'], 'true');
      assert.deepEqual(repeat.body.event, first.body.event);
      assert.equal(await countEvents(), before + 1);
    });

    test('same key with a different payload returns 409', async () => {
      await submit(validEvent(), { key: 'reuse-1' }).expect(202);
      const res = await submit(validEvent({ payload: { title: 'Different', message: 'Synthetic message' } }),
        { key: 'reuse-1' });
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'idempotency_key_conflict');
    });

    test('keys are scoped per session: another session can reuse the same key', async () => {
      await submit(validEvent(), { key: 'shared-key' }).expect(202);
      const other = await newSession();
      const res = await submit(validEvent(), { key: 'shared-key', auth: other });
      assert.equal(res.status, 202);
    });

    test('concurrent identical submissions create exactly one event', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => submit(validEvent(), { key: 'race-1' })));
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 200, 202]);
      assert.equal(new Set(results.map((r) => r.body.event.id)).size, 1, 'all responses name one event');
      const { rows: [{ count }] } = await pool.query(
        "SELECT count(*)::int AS count FROM events WHERE idempotency_key = 'race-1'");
      assert.equal(count, 1);
    });

    test('concurrent submissions reusing a key with different payloads: one wins, rest 409', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        submit(validEvent({ payload: { title: `Title ${i}`, message: 'm' } }), { key: 'race-2' })));
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [202, 409, 409, 409, 409, 409]);
    });

    test('per-session cap returns 429, but repeats of existing keys still replay', async () => {
      for (let i = 0; i < 5; i++) await submit(validEvent(), { key: `cap-${i}` }).expect(202);
      const over = await submit(validEvent(), { key: 'cap-5' });
      assert.equal(over.status, 429);
      assert.equal(over.body.error, 'event_limit_reached');
      assert.equal(over.body.limit, 5);
      await submit(validEvent(), { key: 'cap-0' }).expect(200);
    });

    test('concurrent submissions cannot exceed the per-session cap', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => submit(validEvent())));
      const created = results.filter((r) => r.status === 202).length;
      assert.equal(created, 5);
      assert.equal(results.filter((r) => r.status === 429).length, 3);
    });
  });

  describe('database constraint', () => {
    test('rejects a duplicate (session_id, idempotency_key) written directly', async () => {
      const created = await submit(validEvent(), { key: 'direct-1' }).expect(202);
      const { rows: [row] } = await pool.query(
        'SELECT session_id, request_hash FROM events WHERE id = $1', [created.body.event.id]);
      await assert.rejects(
        pool.query(
          `INSERT INTO events (session_id, type, payload, idempotency_key, request_hash)
           VALUES ($1, 'demo.notification', '{}', 'direct-1', $2)`,
          [row.session_id, row.request_hash]),
        (err) => err.code === '23505' && err.constraint === 'events_session_idempotency_key_unique');
    });
  });

  describe('GET /v1/events/:id', () => {
    test('returns the event to its owning session', async () => {
      const created = await submit(validEvent()).expect(202);
      const res = await request(server).get(`/v1/events/${created.body.event.id}`)
        .set('Authorization', `Bearer ${token}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.event, created.body.event);
    });

    test("another session gets 404, the same as a nonexistent ID", async () => {
      const created = await submit(validEvent()).expect(202);
      const other = await newSession();
      const ids = [created.body.event.id, crypto.randomUUID(), 'not-a-uuid'];
      const bodies = [];
      for (const id of ids) {
        const res = await request(server).get(`/v1/events/${id}`).set('Authorization', `Bearer ${other}`);
        assert.equal(res.status, 404, id);
        bodies.push(res.body);
      }
      assert.deepEqual(bodies[0], bodies[1], 'foreign and missing IDs are indistinguishable');
    });

    test('requires a token', async () => {
      const res = await request(server).get(`/v1/events/${crypto.randomUUID()}`);
      assert.equal(res.status, 401);
    });
  });

  describe('GET /v1/events', () => {
    test('pages through only the current session, newest first', async () => {
      for (let i = 0; i < 5; i++) {
        await submit(validEvent({ payload: { title: `T${i}`, message: 'm' } })).expect(202);
      }
      const other = await newSession();
      await submit(validEvent(), { auth: other }).expect(202);

      const list = (query) => request(server).get('/v1/events').query(query)
        .set('Authorization', `Bearer ${token}`);
      const page1 = await list({ limit: 2 });
      assert.equal(page1.status, 200);
      assert.deepEqual(page1.body.data.map((e) => e.payload.title), ['T4', 'T3']);
      const page2 = await list({ limit: 2, cursor: page1.body.nextCursor });
      assert.deepEqual(page2.body.data.map((e) => e.payload.title), ['T2', 'T1']);
      const page3 = await list({ limit: 2, cursor: page2.body.nextCursor });
      assert.deepEqual(page3.body.data.map((e) => e.payload.title), ['T0']);
      assert.equal(page3.body.nextCursor, null);
    });

    test('defaults to 20 per page and rejects bad parameters', async () => {
      const list = (query) => request(server).get('/v1/events').query(query)
        .set('Authorization', `Bearer ${token}`);
      assert.equal((await list({})).status, 200);
      for (const query of [{ limit: 0 }, { limit: 51 }, { limit: 'ten' }, { cursor: 'bogus!' }, { sort: 'asc' }]) {
        const res = await list(query);
        assert.equal(res.status, 400, JSON.stringify(query));
        assert.equal(res.body.error, 'invalid_query');
      }
    });

    test('requires a token', async () => {
      const res = await request(server).get('/v1/events');
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'missing_token');
    });
  });
});
