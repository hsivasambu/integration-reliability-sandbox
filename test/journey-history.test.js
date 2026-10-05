// Outcome summary and attempt timeline (public/journey-model.js, Stage 17), from fixtures shaped like the API's
// responses. Everything shown must come from recorded data; nothing is inferred beyond it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toJourneyView } = require('../public/journey-model.js');

const T0 = Date.parse('2026-10-05T12:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const NOW = T0 + 60_000;
const E = '6f1c2a4e-1111-4c4c-9a9a-000000000001';
const D1 = '0d9e8f7a-2222-4b4b-8a8a-000000000002';
const D2 = '0d9e8f7a-3333-4b4b-8a8a-000000000003';

// attempt(n, startSecond, endSecond, outcome, extra)
const attempt = (n, s, e, outcome, extra = {}) => ({
  attemptNumber: n, outcome, startedAt: at(s), endedAt: e === null ? null : at(e),
  responseStatus: null, errorCategory: null, retryable: null, durationMs: e === null ? null : (e - s) * 1000, ...extra,
});
const ok = (n, s) => attempt(n, s, s + 0.02, 'delivered', { responseStatus: 200 });
const err503 = (n, s) => attempt(n, s, s + 0.01, 'failed', { responseStatus: 503, errorCategory: 'http_error', retryable: true });
const late = (n, s) => attempt(n, s, s + 2, 'failed', { errorCategory: 'timeout', retryable: true });
const lost = (n, s) => attempt(n, s, null, 'lease_expired', { errorCategory: 'lease_expired' });

function delivery(id, state, attempts, extra = {}) {
  return {
    id, replayOf: null, state, attemptCount: attempts.length, maxAttempts: 4, nextAttemptAt: null, failureReason: null,
    createdAt: at(0), updatedAt: at(1), completedAt: ['delivered', 'failed'].includes(state) ? attempts.at(-1)?.endedAt ?? at(1) : null,
    replayedBy: null, statusUrl: `/v1/events/${E}/deliveries`, attempts, ...extra,
  };
}
const receipt = (processed, dups = 0) => ({
  eventId: E, processed, result: processed ? { confirmationCode: 'RCPT-ABCD1234', summary: 's' } : null,
  firstReceivedAt: processed ? at(1) : null, lastReceivedAt: processed ? at(9) : null,
  deliveriesReceived: processed ? dups + 1 : 0, duplicateCount: dups,
});
function view(deliveries, rcpt, receiptState = rcpt ? 'ok' : 'unavailable') {
  const event = { id: E, type: 'demo.notification', payload: { title: 't', message: 'm' }, idempotencyKey: 'k', createdAt: at(0), updatedAt: at(0), delivery: deliveries.at(-1) };
  return toJourneyView({ event, deliveries, receipt: rcpt, receiptState, now: NOW });
}
const texts = (v, g = 0) => v.timeline.groups[g].items.map((i) => i.text);

test('Delivery confirmed: acknowledged on the first attempt; timing only from recorded times', () => {
  const v = view([delivery(D1, 'delivered', [ok(1, 0.5)])], receipt(true));
  assert.equal(v.outcome.delivery.label, 'Delivery confirmed');
  assert.match(v.outcome.delivery.text, /acknowledged the alert/);
  assert.equal(v.outcome.processing.label, 'Processed');
  assert.match(v.outcome.timing, /Confirmed about 1 s after the alert was accepted/);
  assert.deepEqual(texts(v), [
    'Saved and queued for delivery.',
    'Attempt 1: delivery confirmed (the receiving system acknowledged it).',
    'Delivery confirmed.',
  ]);
});

test('Retried successfully: a later attempt acknowledged after an earlier failure; waits come from recorded times', () => {
  const v = view([delivery(D1, 'delivered', [err503(1, 1), ok(2, 3.01)])], receipt(true));
  assert.equal(v.outcome.delivery.label, 'Retried successfully');
  assert.deepEqual(texts(v), [
    'Saved and queued for delivery.',
    'Attempt 1: the receiving system returned an error.',
    'Waiting before another attempt (about 2 s, from the recorded times).',
    'Attempt 2: delivery confirmed (the receiving system acknowledged it).',
    'Delivery confirmed.',
  ]);
  assert.equal(v.timeline.groups[0].items[2].at, at(1.01), 'the wait starts when attempt 1 ended');
});

test('Processed once comes only from the receipt, never from attempt counts', () => {
  const twoTries = [delivery(D1, 'delivered', [late(1, 1), ok(2, 5)])];
  assert.equal(view(twoTries, receipt(true, 1)).outcome.processing.label, 'Processed once');
  assert.match(view(twoTries, receipt(true, 1)).outcome.processing.text, /one synthetic processing result, although the alert reached it 2 times/);
  assert.equal(view(twoTries, receipt(true, 0)).outcome.processing.label, 'Processed', 'no repeat in the record: not "processed once"');
  assert.equal(view(twoTries, null).outcome.processing, null, 'receipt unavailable: hidden, not guessed from two attempts');
  assert.deepEqual(view(twoTries, receipt(true, 1)).timeline.receiver.map((i) => i.text), [
    'Processed the alert (confirmation RCPT-ABCD1234).',
    'Recognized 1 repeat delivery and did not process again.',
  ]);
});

test('Stopped: allowance exhausted, terminal error, session ended, or no reason recorded', () => {
  const four = [err503(1, 1), err503(2, 3), err503(3, 7), err503(4, 15)];
  const exhausted = view([delivery(D1, 'failed', four, { failureReason: 'attempts_exhausted' })], receipt(false));
  assert.equal(exhausted.outcome.delivery.label, 'Stopped');
  assert.match(exhausted.outcome.delivery.text, /configured attempt allowance \(4\) was exhausted/);
  assert.equal(exhausted.outcome.processing.label, 'Not processed');
  assert.equal(texts(exhausted).at(-1), 'Delivery stopped: all 4 attempts allowed were used.');
  const refused = view([delivery(D1, 'failed', [attempt(1, 1, 1.1, 'failed', { responseStatus: 404, errorCategory: 'http_error', retryable: false })], { failureReason: 'non_retryable' })], receipt(false));
  assert.match(refused.outcome.delivery.text, /terminal error occurred/);
  assert.equal(texts(refused)[1], 'Attempt 1: the receiving system refused it (an error that retrying cannot fix).');
  const expired = view([delivery(D1, 'failed', [], { failureReason: 'session_expired' })], receipt(false));
  assert.match(expired.outcome.delivery.text, /demo session ended/);
  const noReason = view([delivery(D1, 'failed', [err503(1, 1)], { failureReason: null })], receipt(false));
  assert.match(noReason.outcome.delivery.text, /no reason was recorded/);
  assert.equal(texts(noReason).at(-1), 'Delivery stopped (no reason was recorded).');
});

test('Interrupted attempts are marked unknown, with no invented failure reason', () => {
  const v = view([delivery(D1, 'delivered', [lost(1, 1), ok(2, 17)])], receipt(true));
  const items = v.timeline.groups[0].items;
  assert.match(items[1].text, /Attempt 1: interrupted\. .*outcome is unknown/);
  assert.equal(items[1].endedAt, null, 'no end time is invented');
  assert.equal(items[2].text, 'Queued again straight away, because the result of that attempt is unknown.');
  assert.equal(v.outcome.delivery.label, 'Delivery confirmed', 'an interrupted attempt is not counted as a failure');
});

test('Unfinished: in progress and waiting with the recorded due time; no outcome claimed', () => {
  const sending = view([delivery(D1, 'in_progress', [attempt(1, 1, null, 'in_progress')])], receipt(false));
  assert.equal(texts(sending)[1], 'Attempt 1: in progress, no result yet.');
  assert.equal(sending.outcome.delivery.label, 'Not finished');
  assert.equal(sending.outcome.processing, null, 'not processed yet is not an outcome');
  const waiting = view([delivery(D1, 'retry_scheduled', [err503(1, 1)], { nextAttemptAt: at(3) })], receipt(false));
  const last = waiting.timeline.groups[0].items.at(-1);
  assert.equal(last.text, 'Waiting before another attempt.');
  assert.equal(last.dueAt, at(3));
});

test('Replay history: original and retry by hand are separate labelled groups; the summary says which it describes', () => {
  const original = delivery(D1, 'failed', [err503(1, 1), err503(2, 3), err503(3, 7), err503(4, 15)], { failureReason: 'attempts_exhausted', replayedBy: D2 });
  const replay = delivery(D2, 'delivered', [ok(1, 40)], { replayOf: D1, createdAt: at(39) });
  const v = view([original, replay], receipt(true));
  assert.deepEqual(v.timeline.groups.map((g) => [g.id, g.label, g.current]), [[D1, 'Original delivery', false], [D2, 'Delivered again (1)', true]]);
  assert.equal(v.timeline.groups[1].items[0].text, 'Retried by hand: a new delivery of the same alert was started.');
  assert.equal(v.timeline.groups[0].items.at(-1).text, 'Delivery stopped: all 4 attempts allowed were used.', 'the historical failure stays visible');
  assert.equal(v.outcome.delivery.label, 'Retried successfully');
  assert.match(v.outcome.delivery.text, /after a retry by hand/);
  assert.match(v.outcome.current, /newest delivery \(Delivered again \(1\)\)/);
  assert.equal(v.outcome.timing, null, 'no timing across a retry by hand (it would include human waiting time)');
});

test('Receiver record: unknown when it could not be loaded, checking while loading', () => {
  assert.match(view([delivery(D1, 'delivered', [ok(1, 1)])], null).timeline.receiver[0].text, /Unknown/);
  assert.match(view([delivery(D1, 'delivered', [ok(1, 1)])], null, 'loading').timeline.receiver[0].text, /Checking/);
});
