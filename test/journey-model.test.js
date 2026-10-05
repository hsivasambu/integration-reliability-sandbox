// The journey presentation adapter (public/journey-model.js), tested with fixtures shaped like the
// API's responses (see docs/openapi.yaml: Event, DeliveryRecord, Attempt, Receipt).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toJourneyView, deliveryStatus } = require('../public/journey-model.js');

const NOW = Date.parse('2026-10-05T12:00:10.000Z');
const at = (s) => new Date(NOW + s * 1000).toISOString();
const EVENT_ID = '6f1c2a4e-1111-4c4c-9a9a-000000000001';
const D1 = '0d9e8f7a-2222-4b4b-8a8a-000000000002';
const D2 = '0d9e8f7a-3333-4b4b-8a8a-000000000003';

function delivery(id, state, attempts, extra = {}) {
  return {
    id, replayOf: null, state, attemptCount: attempts.length, maxAttempts: 4,
    nextAttemptAt: null, failureReason: null, statusUrl: `/v1/events/${EVENT_ID}/deliveries`,
    replayedBy: null, createdAt: at(-10), updatedAt: at(-1), completedAt: null, attempts, ...extra,
  };
}
const attempt = (n, outcome, extra = {}) => ({
  attemptNumber: n, outcome, startedAt: at(-9 + n), endedAt: outcome === 'in_progress' ? null : at(-8 + n),
  responseStatus: null, errorCategory: null, retryable: null, durationMs: 10, ...extra,
});
const ok = (n) => attempt(n, 'delivered', { responseStatus: 200 });
const err503 = (n) => attempt(n, 'failed', { responseStatus: 503, errorCategory: 'http_error', retryable: true });
const timeout = (n) => attempt(n, 'failed', { errorCategory: 'timeout', retryable: true, durationMs: 2003 });

function event(summary) {
  return {
    id: EVENT_ID, type: 'demo.notification', payload: { title: 'Service request', message: 'Synthetic room A needs assistance.' },
    idempotencyKey: 'k-1', createdAt: at(-10), updatedAt: at(-10), delivery: { ...summary, replayCount: 0 },
  };
}
const receipt = (processed, extra = {}) => ({
  eventId: EVENT_ID, processed, result: processed ? { confirmationCode: 'RCPT-1A2B3C4D', summary: 'x' } : null,
  firstReceivedAt: processed ? at(-5) : null, lastReceivedAt: processed ? at(-5) : null,
  deliveriesReceived: processed ? 1 : 0, duplicateCount: 0, ...extra,
});
const view = (deliveries, rcpt, opts = {}) => toJourneyView({
  event: event(deliveries.at(-1)), deliveries, receipt: rcpt, receiptState: rcpt ? 'ok' : 'unavailable', now: NOW, ...opts,
});

test('local submitting state is separate from server-accepted state', () => {
  const sending = toJourneyView({ local: { status: 'sending', title: 'Team update' }, now: NOW });
  assert.equal(sending.server, false);
  assert.equal(sending.alert.label, 'Sending to the sandbox');
  assert.equal(sending.delivery.label, 'Not started');
  const unsure = toJourneyView({ local: { status: 'uncertain', title: 'Team update' }, now: NOW });
  assert.equal(unsure.alert.label, 'Unconfirmed');
  assert.equal(unsure.delivery.code, 'unknown');
  assert.match(unsure.explanation, /could not confirm/);
});

test('just accepted: Saved, nothing sent, processing not yet', () => {
  const d = delivery(D1, 'pending', [], { nextAttemptAt: at(-10) });
  const v = view([d], receipt(false));
  assert.equal(v.server, true);
  assert.equal(v.key, `event:${EVENT_ID}`);
  assert.equal(v.alert.label, 'Accepted');
  assert.equal(v.delivery.label, 'Saved');
  assert.equal(v.forward.label, 'No try sent yet');
  assert.equal(v.ack.label, 'No reply yet');
  assert.equal(v.processing.label, 'Not processed yet');
});

test('only the list summary is known: no attempt history is invented', () => {
  const v = toJourneyView({
    event: event({ id: D1, replayOf: null, state: 'in_progress', attemptCount: 1, maxAttempts: 4, nextAttemptAt: null, failureReason: null }),
    now: NOW, receiptState: 'loading',
  });
  assert.equal(v.delivery.label, 'Sending');
  assert.equal(v.ack.label, 'Not loaded yet');
  assert.equal(v.processing.label, 'Checking…', 'loading is not the same as unknown');
  assert.deepEqual(v.deliveries, []);
});

test('sending: forward path active, waiting for the reply', () => {
  const v = view([delivery(D1, 'in_progress', [attempt(1, 'in_progress')])], receipt(false));
  assert.equal(v.delivery.label, 'Sending');
  assert.equal(v.delivery.currentTry, 1);
  assert.equal(v.forward.active, true);
  assert.equal(v.ack.label, 'Waiting for a reply');
});

test('retry scheduled in the future: Trying again, with the next try and a countdown', () => {
  const v = view([delivery(D1, 'retry_scheduled', [err503(1)], { nextAttemptAt: at(3) })], receipt(false));
  assert.equal(v.delivery.label, 'Trying again');
  assert.equal(v.delivery.triesSoFar, 1);
  assert.equal(v.delivery.nextTry, 2);
  assert.equal(v.delivery.countdownSeconds, 3);
  assert.equal(v.delivery.nextAttemptAt, at(3));
  assert.equal(v.ack.label, 'Error reply');
  assert.equal(v.ack.technical, 'HTTP 503');
  assert.equal(v.processing.label, 'Not processed yet');
});

test('countdown reached zero before the worker ran: Waiting for the next attempt, no fabricated send', () => {
  const v = view([delivery(D1, 'retry_scheduled', [err503(1)], { nextAttemptAt: at(-1) })], receipt(false));
  assert.equal(v.delivery.label, 'Waiting');
  assert.match(v.delivery.detail, /Waiting for the next attempt/);
  assert.equal(v.forward.label, '1 try sent');
  assert.equal(v.delivery.countdownSeconds, 0);
});

test('lost lease: Waiting, result of the last try unknown', () => {
  const v = view([delivery(D1, 'pending', [attempt(1, 'lease_expired', { errorCategory: 'lease_expired' })])], receipt(false));
  assert.equal(v.delivery.label, 'Waiting');
  assert.equal(v.ack.label, 'Unknown');
});

test('delivered: 2xx confirms delivery; the receipt confirms processing', () => {
  const v = view([delivery(D1, 'delivered', [ok(1)])], receipt(true));
  assert.equal(v.delivery.label, 'Confirmed');
  assert.equal(v.ack.label, 'Delivery confirmed');
  assert.equal(v.processing.label, 'Processed');
  assert.equal(v.processing.confirmationCode, 'RCPT-1A2B3C4D');
});

test('delivered but the receipt is unavailable: processing is Unknown, not "not processed"', () => {
  const v = view([delivery(D1, 'delivered', [ok(1)])], null);
  assert.equal(v.delivery.label, 'Confirmed');
  assert.equal(v.processing.label, 'Unknown');
  assert.match(v.processing.detail, /not proof that nothing was processed/);
  assert.match(v.explanation, /could not be checked/);
});

test('reply too late: processed while the sender retries, then a recognized repeat', () => {
  const mid = view([delivery(D1, 'retry_scheduled', [timeout(1)], { nextAttemptAt: at(2) })], receipt(true));
  assert.equal(mid.ack.label, 'No reply in time');
  assert.equal(mid.processing.label, 'Processed');
  assert.match(mid.explanation, /already processed your alert, but its reply did not arrive in time/);
  const done = view([delivery(D1, 'delivered', [timeout(1), ok(2)])], receipt(true, { deliveriesReceived: 2, duplicateCount: 1 }));
  assert.equal(done.delivery.label, 'Confirmed');
  assert.equal(done.processing.repeats, 1);
  assert.match(done.explanation, /recognized the repeat and did not process it twice/);
});

test('retries exhausted: Stopped, no processing recorded', () => {
  const d = delivery(D1, 'failed', [err503(1), err503(2), err503(3), err503(4)], { failureReason: 'attempts_exhausted' });
  const v = view([d], receipt(false));
  assert.equal(v.delivery.label, 'Stopped');
  assert.equal(v.delivery.reason, 'attempts_exhausted');
  assert.equal(v.forward.label, '4 tries sent');
  assert.equal(v.processing.label, 'No processing recorded');
  assert.match(v.explanation, /deliver it again/);
});

test('replay deliveries stay separate and are keyed by stable IDs', () => {
  const original = delivery(D1, 'failed', [err503(1), err503(2), err503(3), err503(4)], { failureReason: 'attempts_exhausted', replayedBy: D2 });
  const replay = delivery(D2, 'delivered', [ok(1)], { replayOf: D1 });
  const v = view([original, replay], receipt(true));
  assert.equal(v.deliveryId, D2, 'the diagram shows the latest delivery');
  assert.equal(v.delivery.label, 'Confirmed');
  assert.deepEqual(v.deliveries.map((d) => [d.id, d.label, d.status.label]),
    [[D1, 'Original delivery', 'Stopped'], [D2, 'Delivered again (1)', 'Confirmed']]);
  const keys = v.deliveries.flatMap((d) => d.attempts.map((a) => a.key));
  assert.equal(new Set(keys).size, keys.length, 'attempt keys are unique across deliveries');
  assert.ok(keys.includes(`${D1}:1`) && keys.includes(`${D2}:1`));
  assert.match(v.explanation, /^This is a new delivery, started by hand. /);
});

test('stale marker is carried through without changing the delivery state', () => {
  const d = delivery(D1, 'retry_scheduled', [err503(1)], { nextAttemptAt: at(3) });
  const v = view([d], receipt(false), { stale: { since: at(-30) } });
  assert.deepEqual(v.stale, { since: at(-30) });
  assert.equal(v.delivery.label, 'Trying again', 'a polling failure never turns into a delivery failure');
});

test('unknown delivery states are shown as unknown, not guessed', () => {
  assert.equal(deliveryStatus({ state: 'archived', attemptCount: 0, maxAttempts: 4 }, NOW).label, 'Unknown');
});
