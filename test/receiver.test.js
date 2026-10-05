const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const request = require('supertest');
const { createApp } = require('../src/app');
const { hashToken } = require('../src/sessions');
const { createDeliveryClient } = require('../src/delivery-client');
const { skip, freshDatabase } = require('./helpers/db');

const SECRET = 'test-receiver-secret-0123456789abcdefghijkl';
const SLOW_MS = 1600;     // receiver 'timeout' mode delay (4000 in production)
const TIMEOUT_MS = 800;   // client timeout (2000 in production)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mock receiver', { skip }, () => {
  let pool;
  let app;
  let server;
  let receiverUrl;
  let send;

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
    receiverUrl = `http://127.0.0.1:${server.address().port}/internal/receiver/deliveries`;
    send = createDeliveryClient({ receiverUrl, receiverSecret: SECRET, deliveryTimeoutMs: TIMEOUT_MS });
  });
  after(async () => {
    server?.close();
    await pool?.end();
  });

  // Fail any test that causes an unhandled error or a server-side error log.
  let problems;
  const onProblem = (err) => problems.push(err);
  let originalConsoleError;
  beforeEach(() => {
    problems = [];
    process.on('unhandledRejection', onProblem);
    process.on('uncaughtException', onProblem);
    originalConsoleError = console.error;
    console.error = (...args) => problems.push(args.join(' '));
  });
  afterEach(() => {
    process.off('unhandledRejection', onProblem);
    process.off('uncaughtException', onProblem);
    console.error = originalConsoleError;
    assert.deepEqual(problems, [], 'no unhandled errors or error logs');
  });

  async function newSession() {
    const res = await request(server).post('/v1/sessions').expect(201);
    const { rows: [row] } = await pool.query(
      'SELECT id FROM demo_sessions WHERE token_hash = $1', [hashToken(res.body.token)]);
    return { token: res.body.token, id: row.id };
  }
  const setMode = (session, mode) => request(server).put('/v1/receiver')
    .set('Authorization', `Bearer ${session.token}`).send({ mode });
  const delivery = (session) => ({
    sessionId: session.id,
    eventId: crypto.randomUUID(),
    type: 'demo.notification',
    payload: { title: 'Synthetic title', message: 'Synthetic message' },
  });
  const receipts = async (session) => (await pool.query(
    'SELECT count(*)::int AS count FROM mock_receiver_receipts WHERE session_id = $1', [session.id])).rows[0].count;

  async function waitFor(check, ms = 1000) {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) return false;
      await sleep(10);
    }
    return true;
  }

  describe('modes (real HTTP via the delivery client)', () => {
    test('new sessions default to success', async () => {
      const session = await newSession();
      const res = await request(server).get('/v1/receiver').set('Authorization', `Bearer ${session.token}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.mode, 'success');
      assert.deepEqual(res.body.availableModes, ['success', 'server_error', 'timeout', 'process_then_timeout']);
    });

    test('success: 200 immediately and the delivery is processed', async () => {
      const session = await newSession();
      const result = await send(delivery(session));
      assert.equal(result.outcome, 'delivered');
      assert.equal(result.status, 200);
      assert.equal(result.body.received, true);
      assert.equal(await receipts(session), 1);
    });

    test('server_error: 503 and nothing is processed', async () => {
      const session = await newSession();
      await setMode(session, 'server_error').expect(200);
      const result = await send(delivery(session));
      assert.equal(result.outcome, 'http_error');
      assert.equal(result.status, 503);
      assert.equal(result.body.error, 'simulated_server_error');
      assert.equal(await receipts(session), 0);
    });

    test('timeout: client gives up after its timeout; receiver stops waiting and processes nothing', async () => {
      const session = await newSession();
      await setMode(session, 'timeout').expect(200);
      const result = await send(delivery(session));
      assert.equal(result.outcome, 'timeout');
      assert.equal(result.status, undefined, 'no HTTP status: no response arrived');
      assert.ok(result.durationMs >= TIMEOUT_MS - 20 && result.durationMs < SLOW_MS, `${result.durationMs} ms`);

      // The disconnect cancels the receiver's pending timer promptly (no leaked timers).
      assert.ok(await waitFor(() => app.locals.receiverStats().pendingDelays === 0, 500),
        'pending delay was cleaned up after the client disconnected');
      await sleep(SLOW_MS); // well past when the late answer would have been sent
      assert.equal(await receipts(session), 0);
    });

    test('timeout mode with a patient client: late 503, still nothing processed', async () => {
      const session = await newSession();
      await setMode(session, 'timeout').expect(200);
      const patient = createDeliveryClient({ receiverUrl, receiverSecret: SECRET, deliveryTimeoutMs: 3000 });
      const result = await patient(delivery(session));
      assert.equal(result.outcome, 'http_error');
      assert.equal(result.status, 503);
      assert.equal(result.body.error, 'simulated_slow_response');
      assert.ok(result.durationMs >= SLOW_MS - 20, `${result.durationMs} ms`);
      assert.equal(await receipts(session), 0);
    });

    test('/health stays responsive while a slow response is pending', async () => {
      const session = await newSession();
      await setMode(session, 'timeout').expect(200);
      const patient = createDeliveryClient({ receiverUrl, receiverSecret: SECRET, deliveryTimeoutMs: 3000 });
      const slow = patient(delivery(session));

      assert.ok(await waitFor(() => app.locals.receiverStats().pendingDelays === 1, 500));
      const started = Date.now();
      const health = await request(server).get('/health');
      const healthMs = Date.now() - started;
      assert.equal(health.status, 200);
      assert.ok(healthMs < 200, `/health took ${healthMs} ms during a pending slow response`);
      assert.equal(app.locals.receiverStats().pendingDelays, 1, 'slow request was still waiting');

      assert.equal((await slow).status, 503);
    });
  });

  describe('receiver authentication', () => {
    const post = (headers) => {
      const req = request(server).post('/internal/receiver/deliveries');
      for (const [k, v] of Object.entries(headers)) req.set(k, v);
      return req.send({});
    };

    test('missing or wrong secret is rejected with 401', async () => {
      for (const headers of [{}, { Authorization: 'Bearer wrong-secret' }, { Authorization: SECRET }]) {
        const res = await post(headers);
        assert.equal(res.status, 401, JSON.stringify(headers));
        assert.equal(res.body.error, 'receiver_unauthorized');
      }
    });

    test('a demo session token is not accepted as the receiver secret', async () => {
      const session = await newSession();
      const res = await post({ Authorization: `Bearer ${session.token}` });
      assert.equal(res.status, 401);
    });

    test('with no secret configured, every call is rejected', async () => {
      const unconfigured = createApp({ pool });
      const res = await request(unconfigured).post('/internal/receiver/deliveries')
        .set('Authorization', 'Bearer anything').send({});
      assert.equal(res.status, 401);
    });

    test('the secret never appears in browser-facing responses', async () => {
      const session = await newSession();
      for (const path of ['/', '/app.js', '/app.css']) {
        const res = await request(server).get(path);
        assert.ok(!res.text.includes(SECRET), path);
      }
      const settings = await request(server).get('/v1/receiver').set('Authorization', `Bearer ${session.token}`);
      assert.ok(!JSON.stringify(settings.body).includes(SECRET));
    });

    test('authenticated but invalid deliveries get 422; unknown sessions 404', async () => {
      const authed = (body) => request(server).post('/internal/receiver/deliveries')
        .set('Authorization', `Bearer ${SECRET}`).send(body);
      const invalid = await authed({ sessionId: 'nope', url: 'http://example.com' });
      assert.equal(invalid.status, 422);
      assert.ok(invalid.body.details.some((d) => d.field === 'url'));
      const unknown = await authed({ ...delivery({ id: crypto.randomUUID() }) });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error, 'unknown_session');
    });
  });

  describe('session isolation', () => {
    test("one session's mode does not affect another's", async () => {
      const a = await newSession();
      const b = await newSession();
      await setMode(a, 'server_error').expect(200);

      assert.equal((await send(delivery(a))).status, 503);
      assert.equal((await send(delivery(b))).status, 200);

      const bSettings = await request(server).get('/v1/receiver').set('Authorization', `Bearer ${b.token}`);
      assert.equal(bSettings.body.mode, 'success');
      assert.equal(bSettings.body.receivedCount, 1);
      const aSettings = await request(server).get('/v1/receiver').set('Authorization', `Bearer ${a.token}`);
      assert.equal(aSettings.body.mode, 'server_error');
      assert.equal(aSettings.body.receivedCount, 0);
    });

    test('mode is stored in PostgreSQL', async () => {
      const session = await newSession();
      await setMode(session, 'timeout').expect(200);
      const { rows } = await pool.query('SELECT mode FROM receiver_settings WHERE session_id = $1', [session.id]);
      assert.equal(rows[0].mode, 'timeout');
    });
  });

  describe('PUT /v1/receiver validation', () => {
    test('rejects unknown modes and fields, missing tokens, and non-JSON', async () => {
      const session = await newSession();
      const bad = await setMode(session, 'chaos');
      assert.equal(bad.status, 422);
      assert.equal(bad.body.error, 'validation_failed');
      const extra = await request(server).put('/v1/receiver').set('Authorization', `Bearer ${session.token}`)
        .send({ mode: 'success', url: 'http://example.com' });
      assert.equal(extra.status, 422);
      assert.ok(extra.body.details.some((d) => d.field === 'url'));
      const noToken = await request(server).put('/v1/receiver').send({ mode: 'success' });
      assert.equal(noToken.status, 401);
      const text = await request(server).put('/v1/receiver').set('Authorization', `Bearer ${session.token}`)
        .set('Content-Type', 'text/plain').send('success');
      assert.equal(text.status, 415);
    });
  });

  describe('delivery client', () => {
    test('refuses to follow redirects', async () => {
      let redirectedHits = 0;
      const target = http.createServer((req, res) => { redirectedHits += 1; res.end('ok'); });
      const redirector = http.createServer((req, res) => {
        res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/` }).end();
      });
      target.listen(0, '127.0.0.1');
      redirector.listen(0, '127.0.0.1');
      await Promise.all([once(target, 'listening'), once(redirector, 'listening')]);
      try {
        const client = createDeliveryClient({
          receiverUrl: `http://127.0.0.1:${redirector.address().port}/`,
          receiverSecret: SECRET,
          deliveryTimeoutMs: TIMEOUT_MS,
        });
        const result = await client({ any: 'thing' });
        assert.equal(result.outcome, 'network_error');
        assert.match(result.error, /redirect/i);
        assert.equal(redirectedHits, 0, 'redirect target was never contacted');
      } finally {
        target.close();
        redirector.close();
      }
    });

    test('reports a refused connection as network_error', async () => {
      const client = createDeliveryClient({
        receiverUrl: 'http://127.0.0.1:1/', receiverSecret: SECRET, deliveryTimeoutMs: TIMEOUT_MS,
      });
      assert.equal((await client({})).outcome, 'network_error');
    });
  });
});
