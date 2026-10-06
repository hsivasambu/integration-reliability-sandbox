// Guided scenario steps (public/guide-model.js): steps advance only from observed API evidence.
// Views are built with the real journey adapter from fixtures shaped like the API's responses.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toJourneyView } = require('../public/journey-model.js');
const { guideStep } = require('../public/guide-model.js');

const NOW = Date.parse('2026-10-05T12:00:10.000Z');
const at = (s) => new Date(NOW + s * 1000).toISOString();
const E = '6f1c2a4e-1111-4c4c-9a9a-000000000001';
const D1 = '0d9e8f7a-2222-4b4b-8a8a-000000000002';
const D2 = '0d9e8f7a-3333-4b4b-8a8a-000000000003';

const attempt = (n, outcome, extra = {}) => ({
  attemptNumber: n, outcome, startedAt: at(n), endedAt: outcome === 'in_progress' ? null : at(n + 1),
  responseStatus: null, errorCategory: null, retryable: null, durationMs: 5, ...extra,
});
const ok = (n) => attempt(n, 'delivered', { responseStatus: 200 });
const rejected = (n) => attempt(n, 'failed', { responseStatus: 503, errorCategory: 'http_error', retryable: true });
const late = (n) => attempt(n, 'failed', { errorCategory: 'timeout', retryable: true });
const live = (n) => attempt(n, 'in_progress');

const delivery = (id, state, attempts, extra = {}) => ({
  id, replayOf: null, state, attemptCount: attempts.length, maxAttempts: 4,
  nextAttemptAt: state === 'retry_scheduled' ? at(5) : null, failureReason: null, attempts, ...extra,
});
function view(deliveries, receipt = { processed: false, duplicateCount: 0, deliveriesReceived: 0 }) {
  const event = { id: E, type: 'demo.notification', payload: { title: 'g' }, createdAt: at(0), delivery: deliveries.at(-1) };
  return toJourneyView({ event, deliveries, receipt: { result: { confirmationCode: 'RCPT-1' }, ...receipt }, receiptState: 'ok', now: NOW });
}
const processed = (dups = 0) => ({ processed: true, duplicateCount: dups, deliveriesReceived: dups + 1 });
const running = (scenario, extra = {}) => ({ scenario, stage: 'running', eventId: E, ...extra });
const ctx = (v, extra = {}) => ({ view: v, selected: true, busy: null, pending: null, modeLabel: 'Temporary outage', ...extra });
const ids = (r) => r.actions.map((a) => a.id);

test('setup: a failed receiver setting stops with a recoverable message and sends nothing', () => {
  assert.equal(guideStep({ scenario: 'recover', stage: 'configuring' }, ctx(null, { busy: 'configuring' })).phase, 'configuring');
  const failed = guideStep({ scenario: 'recover', stage: 'configuring' }, ctx(null));
  assert.equal(failed.phase, 'config-failed');
  assert.match(failed.text, /nothing was sent/);
  assert.deepEqual(ids(failed), ['retry-start', 'leave']);
});

test('setup: an unconfirmed send points to Check again; a rejected send says the receiver stays changed', () => {
  assert.equal(guideStep({ scenario: 'rescue', stage: 'sending' }, ctx(null, { pending: { status: 'uncertain' } })).phase, 'send-unconfirmed');
  const failed = guideStep({ scenario: 'rescue', stage: 'sending' }, ctx(null));
  assert.equal(failed.phase, 'send-failed');
  assert.match(failed.text, /still set to "Temporary outage"/);
});

test('recover: Restore appears only after a rejected try is observed, and says it sends nothing', () => {
  assert.equal(guideStep(running('recover'), ctx(view([delivery(D1, 'in_progress', [live(1)])]))).phase, 'await-failure');
  const r = guideStep(running('recover'), ctx(view([delivery(D1, 'retry_scheduled', [rejected(1)])])));
  assert.equal(r.phase, 'restore');
  assert.deepEqual(ids(r), ['restore', 'leave']);
  assert.match(r.text, /Nothing is sent when you press it/);
  const after = guideStep(running('recover', { restored: true }), ctx(view([delivery(D1, 'retry_scheduled', [rejected(1)])])));
  assert.equal(after.phase, 'await-retry');
  assert.deepEqual(ids(after), ['leave'], 'no further action: the scheduled retry does the work');
  const done = guideStep(running('recover', { restored: true }), ctx(view([delivery(D1, 'delivered', [rejected(1), ok(2)])], processed())));
  assert.equal(done.phase, 'done');
  assert.match(done.text, /Delivered on try 2/);
});

test('recover: if every try is used before restoring, rescue is offered instead', () => {
  const r = guideStep(running('recover'), ctx(view([delivery(D1, 'failed', [rejected(1), rejected(2), rejected(3), rejected(4)], { failureReason: 'attempts_exhausted' })])));
  assert.equal(r.phase, 'stopped-early');
  assert.deepEqual(ids(r), ['restore-retry', 'leave']);
});

test('twice: timeout observed, then the repeat is recognized from the receipt', () => {
  assert.equal(guideStep(running('twice'), ctx(view([delivery(D1, 'in_progress', [live(1)])]))).phase, 'await-timeout');
  assert.equal(guideStep(running('twice'), ctx(view([delivery(D1, 'in_progress', [live(1)])], processed()))).phase, 'await-repeat',
    'processed while the reply is still outstanding');
  assert.equal(guideStep(running('twice'), ctx(view([delivery(D1, 'retry_scheduled', [late(1)])], processed()))).phase, 'await-repeat');
  const done = guideStep(running('twice'), ctx(view([delivery(D1, 'delivered', [late(1), ok(2)])], processed(1))));
  assert.equal(done.phase, 'done');
  assert.match(done.text, /One processing result \(RCPT-1\)\. The repeat was recognized/);
});

test('rescue: Restore and retry only once a failed terminal delivery is confirmed', () => {
  const retrying = guideStep(running('rescue'), ctx(view([delivery(D1, 'retry_scheduled', [rejected(1), rejected(2)])])));
  assert.equal(retrying.phase, 'await-stop');
  assert.ok(!ids(retrying).includes('restore-retry'));
  const stopped = guideStep(running('rescue'), ctx(view([delivery(D1, 'failed', [rejected(1), rejected(2), rejected(3), rejected(4)], { failureReason: 'attempts_exhausted' })])));
  assert.equal(stopped.phase, 'rescue');
  assert.deepEqual(ids(stopped), ['restore-retry', 'leave']);
});

test('rescue: an unconfirmed retry request is never resent automatically; evidence of a replay wins', () => {
  const failed = delivery(D1, 'failed', [rejected(1), rejected(2), rejected(3), rejected(4)], { failureReason: 'attempts_exhausted' });
  const unsure = guideStep(running('rescue', { replay: { deliveryId: D1, status: 'requested' } }), ctx(view([failed])));
  assert.equal(unsure.phase, 'replay-unconfirmed');
  assert.deepEqual(ids(unsure), ['replay-check', 'leave'], 'only an explicit Check again');
  // After a reload, the replay delivery is visible in the history: that is proof enough, no request needed.
  const replay = delivery(D2, 'in_progress', [live(1)], { replayOf: D1 });
  assert.equal(guideStep(running('rescue', { replay: { deliveryId: D1, status: 'requested' } }), ctx(view([failed, replay]))).phase, 'await-replay');
  const done = guideStep(running('rescue'), ctx(view([failed, { ...replay, state: 'delivered', attempts: [ok(1)] }], processed())));
  assert.equal(done.phase, 'done');
  assert.match(done.text, /stopped delivery stays in the history/);
});

test('the guided alert not selected: the guide asks to show it instead of guessing', () => {
  const r = guideStep(running('twice'), ctx(null, { selected: false }));
  assert.equal(r.phase, 'elsewhere');
  assert.deepEqual(ids(r), ['show', 'leave']);
});

test('cues: waiting steps say which part of the journey to watch; steps that need the visitor do not', () => {
  const watch = (scenario, v, extra) => guideStep(running(scenario, extra), ctx(v)).watch;
  assert.equal(watch('recover', view([delivery(D1, 'in_progress', [live(1)])])), 'delivery', 'watch the first try fail');
  assert.equal(watch('recover', view([delivery(D1, 'retry_scheduled', [rejected(1)])])), null, 'Restore receiver: the visitor acts');
  assert.equal(watch('recover', view([delivery(D1, 'retry_scheduled', [rejected(1)])]), { restored: true }), 'delivery');
  assert.equal(watch('twice', view([delivery(D1, 'in_progress', [live(1)])])), 'receiver', 'the record shows processing first');
  assert.equal(watch('rescue', view([delivery(D1, 'retry_scheduled', [rejected(1)])])), 'delivery', 'wait for the stop');
  const stopped = view([delivery(D1, 'failed', [rejected(1), rejected(2), rejected(3), rejected(4)], { failureReason: 'attempts_exhausted' })]);
  const rescue = guideStep(running('rescue'), ctx(stopped));
  assert.equal(rescue.phase, 'rescue');
  assert.equal(rescue.watch, null, 'Restore and retry: the visitor acts');
  assert.ok(rescue.actions.some((a) => a.primary));
});
