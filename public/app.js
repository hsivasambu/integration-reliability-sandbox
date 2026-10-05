// Integration Reliability Sandbox: browser UI (plain JavaScript, same-origin API).
// All text from the server is rendered with textContent / text nodes, never as HTML.
'use strict';

const POLL_MS = 2000;               // refresh interval while deliveries are in progress
const MAX_BACKOFF_MS = 30000;       // longest wait between refreshes after API failures
const SLOW_NOTICE_MS = 4000;        // after this, explain that the server may be waking up
const REQUEST_TIMEOUT_MS = 90000;   // a request is only treated as failed after this
const ACTIVE_STATES = new Set(['pending', 'retry_scheduled', 'in_progress']);
const KEYS = { token: 'irs.token', selected: 'irs.selectedEvent', replayKeys: 'irs.replayKeys' };

// --- small helpers -----------------------------------------------------------

const $ = (id) => document.getElementById(id);

// Builds an element; children may be strings (inserted as text) or nodes.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') el.className = value;
    else if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
    else el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// sessionStorage can be unavailable (privacy modes); the page still works for this tab.
const storage = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) {
    try {
      if (value === null || value === undefined) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch { /* ignore */ }
  },
};

const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');
const secondsUntil = (iso) => Math.max(0, Math.round((new Date(iso) - Date.now()) / 1000));
const shortId = (id) => id.slice(0, 8);

const EXAMPLES = [
  ['Synthetic appointment reminder', 'Test patient A has a synthetic follow-up visit tomorrow at 09:00.'],
  ['Synthetic lab result ready', 'A synthetic lab panel for test patient B is ready for review.'],
  ['Synthetic discharge notice', 'Test patient C was discharged from synthetic ward 4 at 14:30.'],
  ['Synthetic referral received', 'A synthetic cardiology referral for test patient D was received.'],
];

// --- state -------------------------------------------------------------------

const state = {
  token: storage.get(KEYS.token),
  expiresAt: null,
  sessionNote: null,       // shown when a stored session turned out to be expired
  creatingSession: false,
  events: [],
  hasMoreEvents: false,
  selectedId: storage.get(KEYS.selected),
  detail: null,            // { eventId, deliveries, receipt }
  detailNote: null,        // result of the last duplicate / replay action for the selected event
  receiver: null,
  summary: null,
  pendingSubmit: null,     // { key, body } kept until the server answers, so a retry reuses the key
  poll: { timer: null, running: false, again: false, failures: 0, lastError: null },
  slowRequests: 0,
};

// --- API access ----------------------------------------------------------------

class Unavailable extends Error {}

// Calls the API. Returns { status, data, headers } for any JSON answer (including 4xx/5xx).
// Throws Unavailable when no usable answer arrived (network error, non-JSON reply, 90 s timeout).
async function api(method, path, { body, headers = {}, auth = true } = {}) {
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let slow = false;
  const slowTimer = setTimeout(() => { slow = true; state.slowRequests += 1; renderWakeBanner(); }, SLOW_NOTICE_MS);
  try {
    const response = await fetch(path, {
      method,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        ...(auth && state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    if (!isJson) throw new Unavailable(`The server answered HTTP ${response.status} without API data; it may be starting up.`);
    const data = await response.json();
    if (response.status === 401 && auth && state.token) sessionExpired();
    return { status: response.status, data, headers: response.headers };
  } catch (err) {
    if (err instanceof Unavailable) throw err;
    throw new Unavailable(err.name === 'AbortError'
      ? 'The server did not answer within 90 seconds.'
      : 'Could not reach the server. Check your connection.');
  } finally {
    clearTimeout(hardTimeout);
    clearTimeout(slowTimer);
    if (slow) { state.slowRequests -= 1; renderWakeBanner(); }
  }
}

// Turns an API error body into a readable box (validation details included).
function errorBox(status, data) {
  const quota = status === 429;
  return h('div', { class: `box ${quota ? 'box-warn' : 'box-bad'}` },
    h('strong', {}, `HTTP ${status}${quota ? ' (limit reached)' : ''}: `),
    data?.message ?? 'The request was not accepted.',
    data?.details ? h('ul', {}, data.details.map((d) => h('li', {}, `${d.field} ${d.issue}`))) : null);
}

function unavailableBox(err) {
  return h('div', { class: 'box box-bad' }, h('strong', {}, 'Backend unavailable: '), err.message,
    ' Nothing was changed by this attempt as far as the page can tell; you can try again.');
}

// --- polling -------------------------------------------------------------------

function stopPolling() {
  clearTimeout(state.poll.timer);
  state.poll.timer = null;
}

function schedule(ms) {
  stopPolling();
  if (!state.token || document.hidden) return;
  state.poll.timer = setTimeout(pollNow, ms);
}

// One refresh at a time. A request for a refresh while one is running is remembered and run after it.
async function pollNow() {
  stopPolling();
  if (!state.token) return renderPollStatus('none');
  if (document.hidden) return renderPollStatus('paused');
  if (state.poll.running) { state.poll.again = true; return; }

  state.poll.running = true;
  try {
    await refresh();
    state.poll.failures = 0;
    state.poll.lastError = null;
  } catch (err) {
    state.poll.failures += 1;
    state.poll.lastError = err.message;
  } finally {
    state.poll.running = false;
  }

  if (state.poll.again) {
    state.poll.again = false;
    return schedule(0);
  }
  if (state.poll.failures > 0) {
    const delay = Math.min(POLL_MS * 2 ** state.poll.failures, MAX_BACKOFF_MS);
    renderPollStatus('backoff', delay);
    return schedule(delay);
  }
  if (state.events.some((e) => ACTIVE_STATES.has(e.delivery.state))) {
    renderPollStatus('active');
    return schedule(POLL_MS);
  }
  renderPollStatus('idle');
}

async function refresh() {
  if (!state.token) return;
  const [events, receiver, summary] = await Promise.all([
    api('GET', '/v1/events?limit=20'), api('GET', '/v1/receiver'), api('GET', '/v1/summary'),
  ]);
  if (!state.token) return; // the session expired during the request
  if (events.status !== 200 || receiver.status !== 200) {
    throw new Unavailable(`The API answered HTTP ${events.status !== 200 ? events.status : receiver.status}.`);
  }
  state.events = events.data.data;
  state.hasMoreEvents = Boolean(events.data.nextCursor);
  state.receiver = receiver.data;
  if (summary.status === 200) state.summary = summary.data;
  if (state.selectedId) await loadDetail(state.selectedId);
  render();
}

async function loadDetail(eventId) {
  const [deliveries, receipt] = await Promise.all([
    api('GET', `/v1/events/${eventId}/deliveries`),
    api('GET', `/v1/receiver/receipts/${eventId}`),
  ]);
  if (state.selectedId !== eventId || !state.token) return;
  if (deliveries.status === 404) { selectEvent(null); return; }
  if (deliveries.status !== 200 || receipt.status !== 200) throw new Unavailable('Could not load the event details.');
  state.detail = { eventId, deliveries: deliveries.data.deliveries, receipt: receipt.data };
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopPolling(); renderPollStatus('paused'); } else { pollNow(); }
});
window.addEventListener('pagehide', stopPolling);

// --- session -------------------------------------------------------------------

function setToken(token) {
  state.token = token;
  storage.set(KEYS.token, token);
}

// Called on any 401 from an authenticated request. Never creates a new session by itself.
function sessionExpired() {
  setToken(null);
  stopPolling();
  state.expiresAt = null;
  state.events = [];
  state.detail = null;
  state.receiver = null;
  state.summary = null;
  selectEvent(null);
  state.sessionNote = 'Your demo session has expired or is no longer valid. Start a new one to continue.';
  render();
}

async function startSession() {
  if (state.creatingSession) return false;
  state.creatingSession = true;
  renderSession();
  try {
    const { status, data, headers } = await api('POST', '/v1/sessions', { auth: false });
    if (status !== 201) {
      const retry = headers.get('Retry-After');
      state.sessionNote = `${data.message ?? `HTTP ${status}`}${retry ? ` Try again in about ${Math.ceil(retry / 60)} minute(s).` : ''}`;
      return false;
    }
    setToken(data.token);
    state.expiresAt = data.expiresAt;
    state.sessionNote = null;
    state.events = [];
    selectEvent(null);
    await pollNow();
    return true;
  } catch (err) {
    state.sessionNote = err.message;
    return false;
  } finally {
    state.creatingSession = false;
    render();
  }
}

async function restoreSession() {
  if (!state.token) return render();
  try {
    const { status, data } = await api('GET', '/v1/session');
    if (status === 200) {
      state.expiresAt = data.expiresAt;
      render();
      pollNow();
    }
    // 401 is handled by sessionExpired() inside api().
  } catch (err) {
    state.sessionNote = `Could not check your saved session: ${err.message}`;
    render();
    schedule(POLL_MS * 2);
  }
}

// --- actions ---------------------------------------------------------------------

function selectEvent(eventId) {
  state.selectedId = eventId;
  storage.set(KEYS.selected, eventId);
  state.detail = null;
  state.detailNote = null;
}

function fillExample() {
  const [title, message] = EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)];
  $('title').value = title;
  $('message').value = message;
}

function validateForm() {
  let ok = true;
  for (const [id, max] of [['title', 100], ['message', 500]]) {
    const value = $(id).value;
    const error = $(`${id}-error`);
    let problem = null;
    if (value.trim() === '') problem = 'Required.';
    else if ([...value].length > max) problem = `At most ${max} characters.`;
    else if (id === 'title' && /[\u0000-\u001F\u007F]/.test(value)) problem = 'No line breaks or control characters.';
    error.textContent = problem ?? '';
    error.hidden = !problem;
    $(id).setAttribute('aria-invalid', problem ? 'true' : 'false');
    ok &&= !problem;
  }
  return ok;
}

// Submits an event. The Idempotency-Key is reused if the previous attempt got no answer.
async function submitEvent(title, message) {
  const body = { type: 'demo.notification', payload: { title, message } };
  const same = state.pendingSubmit && JSON.stringify(state.pendingSubmit.body) === JSON.stringify(body);
  const key = same ? state.pendingSubmit.key : crypto.randomUUID();
  state.pendingSubmit = { key, body };
  const result = $('submit-result');
  result.replaceChildren(h('p', { class: 'muted' }, 'Submitting…'));
  try {
    const { status, data } = await api('POST', '/v1/events', { body, headers: { 'Idempotency-Key': key } });
    state.pendingSubmit = null; // the server answered; this key is settled
    if (status === 202) {
      result.replaceChildren(h('div', { class: 'box box-ok' },
        h('strong', {}, 'Accepted by the API (HTTP 202). '),
        'The event is stored and queued for delivery. It has not been delivered yet; follow it under "Your events".'));
      selectEvent(data.eventId);
      await pollNow();
      return data.eventId;
    }
    result.replaceChildren(status === 200
      ? h('div', { class: 'box box-info' }, 'HTTP 200: this exact request was already accepted earlier. No new event was created.')
      : errorBox(status, data));
    return status === 200 ? data.eventId : null;
  } catch (err) {
    result.replaceChildren(h('div', { class: 'box box-bad' }, h('strong', {}, 'No answer from the server: '), err.message,
      ' The event may or may not have been stored. Submitting again reuses the same Idempotency-Key, so it cannot be stored twice.'));
    return null;
  }
}

async function setReceiverMode(mode) {
  const status = $('receiver-status');
  status.textContent = 'Saving…';
  try {
    const res = await api('PUT', '/v1/receiver', { body: { mode } });
    if (res.status !== 200) {
      status.replaceChildren(errorBox(res.status, res.data));
      return false;
    }
    state.receiver = res.data;
    status.textContent = `Saved: your receiver is now in "${mode}" mode.`;
    renderReceiver();
    return true;
  } catch (err) {
    status.replaceChildren(unavailableBox(err));
    renderReceiver();
    return false;
  }
}

// Reuses the original event's Idempotency-Key and payload: the API must not create a new event.
async function submitDuplicate(event) {
  state.detailNote = h('p', { class: 'muted' }, 'Sending the duplicate submission…');
  keepFocus($('detail'), renderDetail);
  try {
    const { status, data, headers } = await api('POST', '/v1/events', {
      body: { type: event.type, payload: event.payload },
      headers: { 'Idempotency-Key': event.idempotencyKey },
    });
    state.detailNote = status === 200
      ? h('div', { class: 'box box-ok' }, h('strong', {}, 'Duplicate submission: HTTP 200'),
        headers.get('Idempotent-Replayed') ? ' with Idempotent-Replayed: true.' : '.',
        ` Same event ID (${shortId(data.eventId)}…); no new event and no new delivery were created.`)
      : errorBox(status, data);
  } catch (err) {
    state.detailNote = unavailableBox(err);
  }
  keepFocus($('detail'), renderDetail);
}

// The replay key is stored per delivery until the server answers, so a retried click is safe.
async function replayDelivery(deliveryId) {
  let keys = {};
  try { keys = JSON.parse(storage.get(KEYS.replayKeys) || '{}'); } catch { keys = {}; }
  keys[deliveryId] ??= crypto.randomUUID();
  storage.set(KEYS.replayKeys, JSON.stringify(keys));
  state.detailNote = h('p', { class: 'muted' }, 'Requesting a replay…');
  keepFocus($('detail'), renderDetail);
  try {
    const { status, data } = await api('POST', `/v1/deliveries/${deliveryId}/replay`,
      { headers: { 'Idempotency-Key': keys[deliveryId] } });
    delete keys[deliveryId];
    storage.set(KEYS.replayKeys, JSON.stringify(keys));
    state.detailNote = status === 202 || status === 200
      ? h('div', { class: 'box box-ok' }, h('strong', {}, `Replay scheduled (HTTP ${status}). `),
        'A new delivery of the same event starts with a fresh budget of attempts. The failed one stays in the history.')
      : errorBox(status, data);
    await pollNow();
  } catch (err) {
    state.detailNote = unavailableBox(err);
  }
  keepFocus($('detail'), renderDetail);
}

// --- guided scenarios -------------------------------------------------------------

const SCENARIOS = [
  {
    id: 'recover',
    title: '1. Recover from a temporary failure',
    why: 'Receivers have short outages. Retrying with a delay lets the delivery succeed once the receiver is back.',
    mode: 'server_error',
    eventTitle: 'Scenario 1: temporary receiver outage',
    steps: [
      'Start: the receiver is set to server_error and one event is submitted.',
      'Watch attempt 1 fail with HTTP 503 and a retry get scheduled (retries follow after 2, 4 and 8 seconds).',
      'Click "Switch receiver to success" before the 4th attempt (you have about 14 seconds).',
    ],
    expected: 'The first attempt after the switch is delivered (HTTP 200). Earlier attempts show failed, HTTP 503, retryable. The receiver processed the event once.',
    followUp: { label: 'Switch receiver to success', mode: 'success' },
  },
  {
    id: 'timeout',
    title: '2. Prevent duplicate processing after a timeout',
    why: 'A receiver can finish the work but answer too late. The sender sees only a timeout and must retry without knowing.',
    mode: 'process_then_timeout',
    eventTitle: 'Scenario 2: processed, but the reply was late',
    steps: [
      'Start: the receiver is set to process_then_timeout and one event is submitted.',
      'After about 3 seconds: attempt 1 shows "timeout, no response", while the receiver already shows it processed the event.',
      'After about 6 seconds the retry runs. No action is needed.',
    ],
    expected: 'Sender: 2 attempts (timeout, then delivered). Receiver: processed once, 1 duplicate recognized, same confirmation code.',
  },
  {
    id: 'replay',
    title: '3. Replay after retries are exhausted',
    why: 'Some failures outlast every retry. An operator can replay the delivery later without losing the record of what failed.',
    mode: 'server_error',
    eventTitle: 'Scenario 3: outage longer than the retry budget',
    steps: [
      'Start: the receiver is set to server_error and one event is submitted.',
      'Wait about 15 seconds until the delivery shows "Failed: all 4 attempts used".',
      'Click "Switch receiver to success", then "Replay failed delivery" in the event details.',
    ],
    expected: 'The original delivery stays failed with 4 attempts. A separate replay delivery is delivered on its first attempt. The receiver processed the event once.',
    followUp: { label: 'Switch receiver to success', mode: 'success' },
  },
];

async function runScenario(scenario, button) {
  button.disabled = true;
  try {
    if (!state.token && !(await startSession())) return;
    if (!(await setReceiverMode(scenario.mode))) return;
    $('title').value = scenario.eventTitle;
    $('message').value = 'Synthetic data for a guided scenario.';
    const eventId = await submitEvent(scenario.eventTitle, 'Synthetic data for a guided scenario.');
    if (eventId) $('detail-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } finally {
    button.disabled = false;
  }
}

function renderScenarios() {
  $('scenarios').replaceChildren(...SCENARIOS.map((s) => {
    const start = h('button', { type: 'button', class: 'primary' }, 'Start scenario');
    start.addEventListener('click', () => runScenario(s, start));
    return h('article', { class: 'scenario', 'aria-labelledby': `scenario-${s.id}` },
      h('h3', { id: `scenario-${s.id}` }, s.title),
      h('p', {}, s.why),
      h('ol', {}, s.steps.map((step) => h('li', {}, step))),
      h('p', {}, h('strong', {}, 'Expected: '), s.expected),
      h('div', { class: 'button-row' }, start,
        s.followUp ? h('button', { type: 'button', onclick: () => setReceiverMode(s.followUp.mode) }, s.followUp.label) : null));
  }));
}

// --- rendering ---------------------------------------------------------------------

// Re-renders a region and puts keyboard focus back on the "same" control (matched by
// data-focus-key), so the 2-second refresh does not disrupt keyboard or screen-reader users.
function keepFocus(container, renderFn) {
  const key = container.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  renderFn();
  if (key) container.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus();
}

function render() {
  renderSession();
  renderReceiver();
  keepFocus($('event-list'), renderEvents);
  keepFocus($('detail'), renderDetail);
  renderSummary();
  const signedIn = Boolean(state.token);
  for (const id of ['submit-event', 'new-example']) $(id).disabled = !signedIn;
}

function renderWakeBanner() {
  const banner = $('wake-banner');
  banner.hidden = state.slowRequests === 0;
  banner.textContent = state.slowRequests > 0
    ? 'Waiting for the server… On the free hosting plan the service sleeps after 15 minutes without traffic '
      + 'and can take about a minute to wake up. Nothing has failed: your request is still in progress.'
    : '';
}

function renderSession() {
  const area = $('session-area');
  const children = [];
  if (state.sessionNote) children.push(h('div', { class: 'box box-warn' }, state.sessionNote));
  if (state.token) {
    children.push(h('p', {}, 'Session active',
      state.expiresAt ? ` until ${new Date(state.expiresAt).toLocaleString()}` : '', '.'));
    children.push(h('button', { type: 'button', onclick: () => startSession(), disabled: state.creatingSession },
      state.creatingSession ? 'Starting…' : 'Start a fresh session'));
  } else {
    children.push(h('p', {}, 'No session yet. A session is an anonymous demo credential, not an account.'));
    children.push(h('button', { type: 'button', class: 'primary', onclick: () => startSession(), disabled: state.creatingSession },
      state.creatingSession ? 'Starting…' : (state.sessionNote ? 'Start a new session' : 'Start demo session')));
  }
  area.replaceChildren(...children);
}

const MODE_INFO = {
  success: ['success', 'Processes the event and answers HTTP 200 immediately.'],
  server_error: ['server_error', 'Answers HTTP 503 immediately and processes nothing (retryable).'],
  timeout: ['timeout', 'Answers too late (after the 2 s sender timeout) and processes nothing.'],
  process_then_timeout: ['process_then_timeout', 'Processes the event, then answers too late. The sender cannot tell that it worked.'],
};

function renderReceiver() {
  const container = $('receiver-modes');
  const current = state.receiver?.mode;
  // The radio buttons are created once and only updated, so refreshes never move keyboard focus.
  if (!container.firstChild) {
    container.append(...Object.entries(MODE_INFO).map(([mode, [label, description]]) => {
      const input = h('input', { type: 'radio', name: 'mode', value: mode, id: `mode-${mode}` });
      input.addEventListener('change', () => setReceiverMode(mode));
      return h('label', { for: `mode-${mode}` }, input, h('span', {}, h('strong', {}, label), description));
    }));
  }
  for (const input of container.querySelectorAll('input')) {
    input.checked = input.value === current;
    input.disabled = !state.token;
  }
  if (!state.token) $('receiver-status').textContent = 'Start a session to configure your receiver.';
  else if (state.receiver && !$('receiver-status').textContent) {
    $('receiver-status').textContent = `Current mode: ${current}.`;
  }
}

function deliveryBadge(delivery) {
  const { state: s, attemptCount: n, maxAttempts: max } = delivery;
  switch (s) {
    case 'pending':
      return ['badge-info', n === 0 ? 'Queued for delivery' : 'Queued again (a worker stopped responding)'];
    case 'in_progress':
      return ['badge-info', `Sending attempt ${n} of ${max}`];
    case 'retry_scheduled':
      return ['badge-warn', `Attempt ${n} failed · retry ${n + 1} of ${max} at ${time(delivery.nextAttemptAt)} (in ~${secondsUntil(delivery.nextAttemptAt)} s)`];
    case 'delivered':
      return ['badge-ok', `Delivered (HTTP 2xx) on attempt ${n}`];
    case 'failed':
      return ['badge-bad', delivery.failureReason === 'non_retryable'
        ? `Failed: receiver rejected it (not retryable)`
        : `Failed: all ${max} attempts used`];
    default:
      return ['badge-info', s];
  }
}

function renderEvents() {
  const list = $('event-list');
  if (!state.token) {
    list.replaceChildren(h('li', { class: 'muted' }, 'Start a session to submit and track events.'));
    return;
  }
  if (state.events.length === 0) {
    list.replaceChildren(h('li', { class: 'muted' }, 'No events yet. Submit one or start a guided scenario.'));
    return;
  }
  const items = state.events.map((event) => {
    const [badgeClass, text] = deliveryBadge(event.delivery);
    const button = h('button', {
      type: 'button', class: 'event-item', 'aria-current': event.id === state.selectedId ? 'true' : 'false',
      'data-focus-key': `event-${event.id}`,
    },
    h('span', { class: 'event-title' }, event.payload.title),
    h('span', { class: `badge ${badgeClass}` }, text),
    h('span', { class: 'event-meta' }, `Accepted ${time(event.createdAt)}`,
      event.delivery.replayCount ? ` · ${event.delivery.replayCount} replay(s)` : ''));
    button.addEventListener('click', () => {
      selectEvent(event.id);
      render();
      pollNow();
    });
    return h('li', {}, button);
  });
  if (state.hasMoreEvents) items.push(h('li', { class: 'muted' }, 'Showing your 20 newest events.'));
  list.replaceChildren(...items);
}

function renderPollStatus(mode, delay) {
  const text = {
    none: '',
    active: 'Deliveries in progress: refreshing every 2 seconds.',
    idle: 'All deliveries have finished. Refreshing stopped; it restarts when you submit or replay.',
    paused: 'Refreshing paused while this tab is hidden.',
    backoff: `Could not refresh (${state.poll.lastError}). Trying again in ${Math.round((delay ?? 0) / 1000)} s.`,
  }[mode];
  const el = $('poll-status');
  el.replaceChildren(text ?? '');
  if (mode === 'backoff') el.append(' ', h('button', { type: 'button', onclick: () => pollNow() }, 'Retry now'));
}

function attemptLine(a) {
  const parts = [`Attempt ${a.attemptNumber}: ${a.outcome.replace('_', ' ')}`];
  if (a.outcome === 'in_progress') parts.push('waiting for the receiver');
  else if (a.outcome === 'lease_expired') parts.push('result unknown (the worker stopped before reporting)');
  else parts.push(a.responseStatus ? `HTTP ${a.responseStatus}` : 'no HTTP response');
  if (a.errorCategory && a.outcome === 'failed') parts.push(a.errorCategory.replace('_', ' '));
  if (a.retryable === true) parts.push('retryable');
  if (a.retryable === false) parts.push('not retryable');
  if (a.durationMs !== null) parts.push(`${a.durationMs} ms`);
  parts.push(`started ${time(a.startedAt)}`);
  return parts.join(' · ');
}

function renderDetail() {
  const container = $('detail');
  const event = state.events.find((e) => e.id === state.selectedId);
  if (!state.token || !event) {
    container.replaceChildren(h('p', { class: 'muted' }, 'Select an event to see its delivery history.'));
    return;
  }
  const detail = state.detail?.eventId === event.id ? state.detail : null;
  const latest = detail?.deliveries.at(-1);

  const lane1 = h('div', { class: 'lane lane-1' },
    h('h3', {}, '1. Accepted by the API'),
    h('p', {}, `HTTP 202 at ${time(event.createdAt)}: stored durably with Idempotency-Key `,
      h('code', {}, event.idempotencyKey), '. Acceptance means "will be delivered", not "delivered".'),
    h('div', { class: 'button-row' },
      h('button', { type: 'button', 'data-focus-key': 'duplicate', onclick: () => submitDuplicate(event) },
        'Submit duplicate (same key and payload)')),
    state.detailNote);

  const lane2 = h('div', { class: 'lane lane-2' }, h('h3', {}, '2. HTTP delivery (what the sender saw)'));
  if (!detail) {
    lane2.append(h('p', { class: 'muted' }, 'Loading delivery history…'));
  } else {
    detail.deliveries.forEach((delivery, index) => {
      const [badgeClass, text] = deliveryBadge(delivery);
      lane2.append(h('div', { class: 'delivery-block' },
        h('p', {}, h('strong', {}, index === 0 ? 'Original delivery' : `Replay ${index}`), ' ',
          h('span', { class: `badge ${badgeClass}` }, text)),
        delivery.attempts.length
          ? h('ol', { class: 'attempts' }, delivery.attempts.map((a) => h('li', {}, attemptLine(a))))
          : h('p', { class: 'muted' }, 'No attempts yet: waiting for the worker.')));
    });
    if (latest?.state === 'failed') {
      lane2.append(h('div', { class: 'button-row' },
        h('button', { type: 'button', class: 'primary', 'data-focus-key': 'replay', onclick: () => replayDelivery(latest.id) },
          'Replay failed delivery')));
    }
  }

  const lane3 = h('div', { class: 'lane lane-3' }, h('h3', {}, '3. Receiver processing (what the receiver did)'));
  if (detail) {
    const r = detail.receipt;
    if (r.processed) {
      lane3.append(h('p', {}, h('span', { class: 'badge badge-ok' }, 'Processed once'),
        ` Confirmation ${r.result.confirmationCode}: ${r.result.summary}`));
      lane3.append(h('p', {}, `Deliveries received: ${r.deliveriesReceived} · duplicates recognized and not re-processed: ${r.duplicateCount}.`));
      const timedOut = detail.deliveries.some((d) => d.attempts.some((a) => a.errorCategory === 'timeout'));
      if (timedOut) {
        lane3.append(h('div', { class: 'box box-info' },
          'The receiver processed this event even though a sender attempt timed out. The sender could not know that, so it retried; the receiver recognized the event ID and did not process it again.'));
      }
    } else {
      lane3.append(h('p', {}, h('span', { class: 'badge badge-info' }, 'Not processed'),
        ' The receiver has not processed this event (yet).'));
    }
  }
  container.replaceChildren(h('p', {}, h('strong', {}, event.payload.title)), lane1, lane2, lane3);
}

function renderSummary() {
  const container = $('summary');
  const s = state.summary;
  if (!state.token || !s) {
    container.replaceChildren(h('p', { class: 'muted' }, 'Start a session to see a summary.'));
    return;
  }
  const d = s.recentDeliveryDuration;
  container.replaceChildren(
    h('p', {}, `Events: ${s.events} · delivered: ${s.byCurrentDeliveryState.delivered} · failed: ${s.byCurrentDeliveryState.failed}`
      + ` · in progress: ${s.byCurrentDeliveryState.active} · HTTP attempts: ${s.attempts} · replays: ${s.replays}`),
    h('p', {}, `Receiver: processed ${s.receiver.processed} event(s), recognized ${s.receiver.duplicatesRecognized} duplicate delivery(ies).`),
    h('p', {}, h('strong', {}, 'Recent delivery time: '), d.sampleSize === 0
      ? 'no delivered events yet.'
      : `median ${(d.medianMs / 1000).toFixed(1)} s, slowest ${(d.maxMs / 1000).toFixed(1)} s, over ${d.sampleSize} delivered event(s).`),
    h('details', { class: 'note' }, h('summary', {}, 'How this is measured'),
      h('p', {}, `From: ${d.start}. To: ${d.end}. Population: ${d.population} Includes ${d.includes}.`),
      h('p', {}, s.notice)));
}

// --- API status (from Stage 1) -----------------------------------------------------

async function checkStatus() {
  const result = $('status-result');
  const button = $('check-status');
  button.disabled = true;
  result.textContent = 'Checking…';
  try {
    const started = performance.now();
    const health = await api('GET', '/health', { auth: false });
    const ready = await api('GET', '/ready', { auth: false });
    const ms = Math.round(performance.now() - started);
    const ok = health.status === 200 && ready.status === 200;
    result.replaceChildren(h('span', { class: `badge ${ok ? 'badge-ok' : 'badge-bad'}` }, ok ? 'Ready' : 'Not ready'),
      ` Process: ${health.data.status} (version ${health.data.version}). `,
      `Database: ${ready.status === 200 ? 'ready' : `unavailable (${ready.data.reason})`}. Checked in ${ms} ms.`);
  } catch (err) {
    result.replaceChildren(unavailableBox(err));
  } finally {
    button.disabled = false;
  }
}

// --- wiring ------------------------------------------------------------------------

$('check-status').addEventListener('click', checkStatus);
$('new-example').addEventListener('click', fillExample);
$('event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.token) return;
  if (!validateForm()) return;
  const button = $('submit-event');
  button.disabled = true;
  try {
    await submitEvent($('title').value, $('message').value);
  } finally {
    button.disabled = !state.token;
  }
});

fillExample();
renderScenarios();
render();
checkStatus();
restoreSession();
