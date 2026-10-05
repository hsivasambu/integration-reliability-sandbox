// Motion planner (public/journey-motion.js): which illustrations play for which observed changes.
// Views are built with the real adapter from fixtures shaped like the API's responses.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toJourneyView } = require('../public/journey-model.js');
const { createPlanner } = require('../public/journey-motion.js');

const NOW = Date.parse('2026-10-05T12:00:10.000Z');
const at = (s) => new Date(NOW + s * 1000).toISOString();
const E1 = '6f1c2a4e-1111-4c4c-9a9a-000000000001';
const E2 = '6f1c2a4e-1111-4c4c-9a9a-000000000002';
const D1 = '0d9e8f7a-2222-4b4b-8a8a-000000000002';
const D2 = '0d9e8f7a-3333-4b4b-8a8a-000000000003';
const D3 = '0d9e8f7a-4444-4b4b-8a8a-000000000004';

const attempt = (n, outcome, extra = {}) => ({
  attemptNumber: n, outcome, startedAt: at(n), endedAt: outcome === 'in_progress' ? null : at(n + 1),
  responseStatus: null, errorCategory: null, retryable: null, durationMs: 5, ...extra,
});
const ok = (n) => attempt(n, 'delivered', { responseStatus: 200 });
const in503 = (n) => attempt(n, 'failed', { responseStatus: 503, errorCategory: 'http_error', retryable: true });
const late = (n) => attempt(n, 'failed', { errorCategory: 'timeout', retryable: true });
const live = (n) => attempt(n, 'in_progress');

function delivery(id, attempts, extra = {}) {
  const last = attempts.at(-1);
  const state = !last ? 'pending' : last.outcome === 'in_progress' ? 'in_progress'
    : last.outcome === 'delivered' ? 'delivered' : 'retry_scheduled';
  return {
    id, replayOf: null, state, attemptCount: attempts.length, maxAttempts: 4,
    nextAttemptAt: state === 'retry_scheduled' ? at(30) : null, failureReason: null, attempts, ...extra,
  };
}
function view(eventId, deliveries, receipt = { processed: false, duplicateCount: 0, deliveriesReceived: 0 }) {
  const event = { id: eventId, type: 'demo.notification', payload: { title: 't', message: 'm' }, createdAt: at(0), delivery: deliveries.at(-1) };
  return toJourneyView({ event, deliveries, receipt: { result: { confirmationCode: 'RCPT-1' }, ...receipt }, receiptState: 'ok', now: NOW });
}
const types = (effects) => effects.map((e) => (e.outcome ? `${e.type}:${e.outcome}` : e.type));
const processed = (dups = 0) => ({ processed: true, duplicateCount: dups, deliveriesReceived: dups + 1 });

test('history is never animated on first sight (page load or first selection)', () => {
  const p = createPlanner();
  assert.deepEqual(p.observe(view(E1, [delivery(D1, [in503(1), ok(2)])], processed())), []);
  assert.deepEqual(p.observe(view(E1, [delivery(D1, [in503(1), ok(2)])], processed())), [], 'a re-render changes nothing');
});

test('nothing is recorded before the attempt history has loaded', () => {
  const p = createPlanner();
  p.accepted(E1);
  const summaryOnly = toJourneyView({ event: { id: E1, payload: { title: 't' }, createdAt: at(0), delivery: delivery(D1, []) }, now: NOW, receiptState: 'loading' });
  assert.deepEqual(p.observe(summaryOnly), []);
  assert.deepEqual(types(p.observe(view(E1, [delivery(D1, [live(1)])]))), ['send'], 'the first attempt is still live');
});

test('own send, observed live: accepted, then send, then acknowledgement and processing', () => {
  const p = createPlanner();
  assert.deepEqual(types(p.accepted(E1)), ['accepted']);
  assert.deepEqual(types(p.observe(view(E1, [delivery(D1, [])]))), []);
  assert.deepEqual(types(p.observe(view(E1, [delivery(D1, [live(1)])]))), ['send']);
  assert.deepEqual(types(p.observe(view(E1, [delivery(D1, [ok(1)])], processed()))), ['ack', 'processed']);
  assert.deepEqual(p.observe(view(E1, [delivery(D1, [ok(1)])], processed())), [], 'deduplicated across re-renders');
});

test('quick success missed between polls: one labelled look back, never a live send', () => {
  const p = createPlanner();
  p.accepted(E1);
  const fx = p.observe(view(E1, [delivery(D1, [ok(1)])], processed()));
  assert.deepEqual(types(fx), ['latest:ack', 'processed']);
  assert.ok(!fx.some((e) => e.type === 'send'));
});

test('several attempts finished unseen: only the latest gets the look back', () => {
  const p = createPlanner();
  p.accepted(E1);
  assert.deepEqual(types(p.observe(view(E1, [delivery(D1, [in503(1), in503(2), ok(3)])], processed()))), ['latest:ack', 'processed']);
});

test('503 then retry: error reply, a new packet only when the new attempt is observed', () => {
  const p = createPlanner();
  p.accepted(E1);
  p.observe(view(E1, [delivery(D1, [live(1)])]));
  assert.deepEqual(types(p.observe(view(E1, [delivery(D1, [in503(1)])]))), ['error-reply']);
  assert.deepEqual(p.observe(view(E1, [delivery(D1, [in503(1)])])), [], 'waiting for the retry plays nothing');
  assert.deepEqual(types(p.observe(view(E1, [delivery(D1, [in503(1), live(2)])]))), ['send']);
  assert.deepEqual(types(p.observe(view(E1, [delivery(D1, [in503(1), ok(2)])], processed()))), ['ack', 'processed']);
});

test('process_then_timeout: processed from the receipt, timed out reply, then Already processed', () => {
  const p = createPlanner();
  p.accepted(E1);
  p.observe(view(E1, [delivery(D1, [live(1)])]));
  assert.deepEqual(types(p.observe(view(E1, [delivery(D1, [live(1)])], processed()))), ['processed'],
    'the receiver card updates from receipt evidence, independently of the sender');
  assert.deepEqual(types(p.observe(view(E1, [delivery(D1, [late(1)])], processed()))), ['timeout']);
  const fx = p.observe(view(E1, [delivery(D1, [late(1), ok(2)])], processed(1)));
  assert.deepEqual(types(fx), ['latest:ack', 'duplicate']);
  assert.ok(!fx.some((e) => e.type === 'processed'), 'no second processing result');
});

test('switching alerts: changes made while another alert was shown are history', () => {
  const p = createPlanner();
  p.accepted(E1);
  p.observe(view(E1, [delivery(D1, [live(1)])]));
  p.observe(view(E2, [delivery(D2, [ok(1)])], processed()));          // look at another alert
  assert.deepEqual(p.observe(view(E1, [delivery(D1, [ok(1)])], processed())), [], 'returning shows the result without replaying it');
  assert.deepEqual(types(p.observe(view(E1, [delivery(D1, [ok(1)]), delivery(D3, [live(1)], { replayOf: D1 })], processed()))),
    ['send'], 'continued watching is live again; the replay attempt has its own key');
});

test('tab returns: the current state is reconciled without replaying missed transitions', () => {
  const p = createPlanner();
  p.accepted(E1);
  p.observe(view(E1, [delivery(D1, [live(1)])]));
  p.resync();
  assert.deepEqual(p.observe(view(E1, [delivery(D1, [late(1), ok(2)])], processed(1))), []);
  assert.deepEqual(p.observe(view(E1, [delivery(D1, [late(1), ok(2)])], processed(1))), []);
});
