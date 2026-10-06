// A deterministic stand-in for the sandbox API, answered inside the browser through request interception.
// Response shapes follow docs/openapi.yaml. Nothing happens on its own: the test moves each delivery forward
// step by step, and can hold, drop or reorder individual responses. It exists for UI races that are hard to
// reproduce against the real backend. It is not evidence about the backend; live.browser.js covers that.

const crypto = require('node:crypto');

const iso = (ms) => new Date(ms).toISOString();
const MODES = ['success', 'server_error', 'timeout', 'process_then_timeout'];

class FixtureApi {
  constructor({ maxAttempts = 4 } = {}) {
    this.maxAttempts = maxAttempts;
    this.tokens = new Map();   // token -> session number
    this.sessions = 0;
    this.events = [];          // all sessions, oldest first; every read is scoped to the caller's session
    this.byKey = new Map();    // "<session>:<Idempotency-Key>" -> event
    this.mode = 'success';
    this.eventLimit = 100;
    this.log = [];             // every API request the page made
    this.rules = [];           // one-off behaviours added by the test (see `when`)
  }

  // --- test controls ----------------------------------------------------------------------

  // Adds a behaviour for the next request(s) matching `method` and a path pattern:
  //   'hold'        answer computed now, sent only when rule.release() is called (a late answer)
  //   'drop'        the request never reaches the API (network failure before it arrived)
  //   'lose-answer' the API handles it, then the connection fails (the answer is lost)
  //   function      returns { status, body } instead of the normal answer
  when(method, pattern, action, { times = 1 } = {}) {
    const rule = { method, pattern, action, times, held: [], matched: 0 };
    rule.release = async () => {
      const held = rule.held.splice(0);
      for (const h of held) await h();
    };
    this.rules.push(rule);
    return rule;
  }

  expireSession() { this.tokens.clear(); }

  event(index = -1) { return this.events.at(index); }
  delivery(ev) { return ev.deliveries.at(-1); }

  startAttempt(ev = this.event()) {
    const d = this.delivery(ev);
    const now = Date.now();
    d.attempts.push({ attemptNumber: d.attempts.length + 1, outcome: 'in_progress', startedAt: iso(now), endedAt: null,
      responseStatus: null, errorCategory: null, retryable: null, durationMs: null });
    Object.assign(d, { state: 'in_progress', attemptCount: d.attempts.length, nextAttemptAt: null, updatedAt: iso(now) });
  }

  // Ends the running attempt with an error reply or a timeout. `processed` simulates a receiver that handled the
  // alert before the reply was lost (process_then_timeout).
  failAttempt(ev = this.event(), { kind = 'http', retryInMs = 2000, processed = false } = {}) {
    const d = this.delivery(ev);
    const a = d.attempts.at(-1);
    const now = Date.now();
    Object.assign(a, { outcome: 'failed', endedAt: iso(now), retryable: true,
      responseStatus: kind === 'http' ? 503 : null, errorCategory: kind === 'http' ? 'http_error' : 'timeout',
      durationMs: kind === 'http' ? 12 : 2003 });
    if (processed) this.receive(ev);
    if (d.attempts.length >= this.maxAttempts) {
      Object.assign(d, { state: 'failed', failureReason: 'attempts_exhausted', completedAt: iso(now), nextAttemptAt: null });
    } else {
      Object.assign(d, { state: 'retry_scheduled', nextAttemptAt: iso(now + retryInMs) });
    }
    d.updatedAt = iso(now);
  }

  succeedAttempt(ev = this.event()) {
    const d = this.delivery(ev);
    const a = d.attempts.at(-1);
    const now = Date.now();
    Object.assign(a, { outcome: 'delivered', endedAt: iso(now), responseStatus: 200, retryable: null, durationMs: 15 });
    Object.assign(d, { state: 'delivered', completedAt: iso(now), updatedAt: iso(now), nextAttemptAt: null });
    this.receive(ev);
  }

  // The receiver got a delivery: the first one is processed, later ones are recognized as repeats.
  receive(ev) {
    const now = iso(Date.now());
    const r = ev.receipt;
    r.deliveriesReceived += 1;
    if (!r.processed) {
      Object.assign(r, { processed: true, firstReceivedAt: now,
        result: { confirmationCode: `RCPT-${ev.id.slice(0, 8).toUpperCase()}`, summary: 'Synthetic result.' } });
    }
    r.lastReceivedAt = now;
    r.duplicateCount = r.deliveriesReceived - 1;
  }

  // --- the API ------------------------------------------------------------------------------

  summaryOf(d) {
    return { id: d.id, replayOf: d.replayOf, state: d.state, attemptCount: d.attemptCount, maxAttempts: this.maxAttempts,
      nextAttemptAt: ['pending', 'retry_scheduled'].includes(d.state) ? d.nextAttemptAt : null,
      failureReason: d.failureReason, statusUrl: `/v1/events/${d.eventId}/deliveries` };
  }
  recordOf(d) {
    return { ...this.summaryOf(d), replayedBy: d.replayedBy, createdAt: d.createdAt, updatedAt: d.updatedAt,
      completedAt: d.completedAt, attempts: d.attempts.map((a) => ({ ...a })) };
  }
  resourceOf(ev) {
    return { id: ev.id, type: 'demo.notification', payload: ev.payload, idempotencyKey: ev.key, createdAt: ev.createdAt,
      updatedAt: ev.createdAt, delivery: { ...this.summaryOf(this.delivery(ev)), replayCount: ev.deliveries.length - 1 } };
  }
  newDelivery(ev, replayOf = null) {
    const now = iso(Date.now());
    const d = { id: crypto.randomUUID(), eventId: ev.id, replayOf, state: 'pending', attemptCount: 0, nextAttemptAt: now,
      failureReason: null, replayedBy: null, createdAt: now, updatedAt: now, completedAt: null, attempts: [] };
    ev.deliveries.push(d);
    return d;
  }

  handle(method, url, headers, body) {
    const { pathname } = new URL(url);
    const json = (status, data) => ({ status, body: data });
    const error = (status, code, message) => json(status, { error: code, message });
    if (pathname === '/health') return json(200, { status: 'ok', version: 'fixture', build: this.build ?? 'fixture', inProcessWorker: true });
    if (pathname === '/ready') return json(200, { status: 'ready' });

    if (method === 'POST' && pathname === '/v1/sessions') {
      const token = `fixture-token-${++this.sessions}-${crypto.randomUUID()}`;
      this.tokens.set(token, this.sessions);
      const now = Date.now();
      return json(201, { token, tokenType: 'Bearer', createdAt: iso(now), expiresAt: iso(now + 24 * 3600e3), notice: 'Fixture session.' });
    }
    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    if (!this.tokens.has(token)) return error(401, 'invalid_token', 'The token is invalid or expired. Create a new demo session.');
    const session = this.tokens.get(token);
    const mine = this.events.filter((e) => e.session === session);

    if (method === 'GET' && pathname === '/v1/session') {
      return json(200, { createdAt: iso(Date.now() - 1000), expiresAt: iso(Date.now() + 24 * 3600e3) });
    }
    if (method === 'POST' && pathname === '/v1/events') {
      const key = headers['idempotency-key'];
      const existing = this.byKey.get(`${session}:${key}`);
      if (existing) return json(200, { eventId: existing.id, statusUrl: `/v1/events/${existing.id}/deliveries`, event: this.resourceOf(existing), notice: 'Replayed.' });
      if (mine.length >= this.eventLimit) {
        return { status: 429, body: { error: 'event_limit_reached', message: 'This demo session has reached its limit.', limit: this.eventLimit } };
      }
      const ev = { id: crypto.randomUUID(), session, key, payload: JSON.parse(body).payload, createdAt: iso(Date.now()), deliveries: [],
        receipt: { processed: false, result: null, firstReceivedAt: null, lastReceivedAt: null, deliveriesReceived: 0, duplicateCount: 0 } };
      this.newDelivery(ev);
      this.events.push(ev);
      this.byKey.set(`${session}:${key}`, ev);
      return json(202, { eventId: ev.id, statusUrl: `/v1/events/${ev.id}/deliveries`, event: this.resourceOf(ev), notice: 'Accepted.' });
    }
    if (method === 'GET' && pathname === '/v1/events') {
      return json(200, { data: [...mine].reverse().slice(0, 20).map((e) => this.resourceOf(e)), nextCursor: null });
    }
    const find = (id) => mine.find((e) => e.id === id);
    let m = pathname.match(/^\/v1\/events\/([^/]+)\/deliveries$/);
    if (method === 'GET' && m) {
      const ev = find(m[1]);
      if (!ev) return error(404, 'not_found', 'No event with this ID exists for your session.');
      const records = ev.deliveries.map((d) => this.recordOf(d));
      return json(200, { eventId: ev.id, delivery: records.at(-1), deliveries: records });
    }
    m = pathname.match(/^\/v1\/receiver\/receipts\/([^/]+)$/);
    if (method === 'GET' && m) {
      const ev = find(m[1]);
      if (!ev) return error(404, 'not_found', 'No event with this ID exists for your session.');
      return json(200, { eventId: ev.id, ...ev.receipt });
    }
    if (pathname === '/v1/receiver' && (method === 'GET' || method === 'PUT')) {
      if (method === 'PUT') this.mode = JSON.parse(body).mode;
      const processed = mine.filter((e) => e.receipt.processed).length;
      const duplicates = mine.reduce((n, e) => n + e.receipt.duplicateCount, 0);
      return json(200, { mode: this.mode, availableModes: MODES, updatedAt: iso(Date.now()), processedCount: processed,
        duplicateCount: duplicates, receivedCount: processed, notice: 'Fixture receiver.' });
    }
    if (method === 'GET' && pathname === '/v1/summary') {
      const states = mine.map((e) => this.delivery(e).state);
      return json(200, {
        events: mine.length,
        byCurrentDeliveryState: { delivered: states.filter((s) => s === 'delivered').length, failed: states.filter((s) => s === 'failed').length,
          active: states.filter((s) => ['pending', 'retry_scheduled', 'in_progress'].includes(s)).length },
        attempts: mine.reduce((n, e) => n + e.deliveries.reduce((k, d) => k + d.attempts.length, 0), 0),
        replays: mine.reduce((n, e) => n + e.deliveries.length - 1, 0),
        receiver: { processed: mine.filter((e) => e.receipt.processed).length, duplicatesRecognized: 0 },
        recentDeliveryDuration: { start: 'event accepted', end: 'delivery confirmed', population: 'fixture.', includes: 'fixture.',
          sampleSize: 0, medianMs: null, maxMs: null },
        notice: 'Fixture statistics.',
      });
    }
    m = pathname.match(/^\/v1\/deliveries\/([^/]+)\/replay$/);
    if (method === 'POST' && m) {
      const ev = mine.find((e) => e.deliveries.some((d) => d.id === m[1]));
      const old = ev?.deliveries.find((d) => d.id === m[1]);
      if (!old) return error(404, 'not_found', 'No delivery with this ID exists for your session.');
      if (old.state !== 'failed') return error(409, 'delivery_not_failed', 'Only a failed delivery can be replayed.');
      const d = this.newDelivery(ev, old.id);
      old.replayedBy = d.id;
      return json(202, { eventId: ev.id, ...this.summaryOf(d), notice: 'Replay scheduled.' });
    }
    return error(404, 'not_found', 'No route matches this path.');
  }

  // Answers the page's API requests; everything else (the page and its scripts) goes to the real static server.
  async attach(page) {
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      const url = request.url();
      const { pathname } = new URL(url);
      if (!(pathname.startsWith('/v1/') || pathname === '/health' || pathname === '/ready')) return request.continue();
      const method = request.method();
      const headers = request.headers();
      const body = request.postData() ?? null;
      this.log.push({ method, path: pathname + new URL(url).search, key: headers['idempotency-key'] ?? null, at: Date.now() });
      const respond = (answer) => request.respond({ status: answer.status, contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(answer.body) }).catch(() => {});
      const rule = this.rules.find((r) => r.times > 0 && r.method === method && r.pattern.test(pathname + new URL(url).search));
      if (rule) {
        rule.times -= 1;
        rule.matched += 1;
        if (rule.action === 'drop') return request.abort('failed');
        if (rule.action === 'lose-answer') { this.handle(method, url, headers, body); return request.abort('failed'); }
        if (rule.action === 'hold') {
          const answer = this.handle(method, url, headers, body);
          rule.held.push(() => respond(answer));
          return;
        }
        return respond(rule.action({ method, url, headers, body }));
      }
      return respond(this.handle(method, url, headers, body));
    });
  }
}

module.exports = { FixtureApi };
