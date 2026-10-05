// Follow an Alert: browser UI for the Integration Reliability Sandbox (plain JavaScript, same-origin API).
// All text from the server is rendered with textContent / text nodes, never as HTML.
// Every delivery and processing state shown here comes from the API; the browser never decides it.
'use strict';

const POLL_MS = 2000;               // refresh interval while deliveries are in progress
const MAX_BACKOFF_MS = 30000;       // longest wait between refreshes after API failures
const SLOW_NOTICE_MS = 4000;        // after this, explain that the server may be waking up
const REQUEST_TIMEOUT_MS = 90000;   // a request is only treated as failed after this
const ACTIVE_STATES = new Set(['pending', 'retry_scheduled', 'in_progress']);
const KEYS = {
  token: 'irs.token',
  selected: 'irs.selectedEvent',
  replayKeys: 'irs.replayKeys',
  pending: 'irs.pendingSubmit', // { key, body, status, lastError }: the submission whose result is not yet known
  draft: 'irs.draft',           // { preset, title, message }: what is in the composer
};
const LIMITS = { title: 100, message: 500 }; // same limits as the API (counted in Unicode characters)

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

// Outline icons (24×24, stroke only). Decorative: the words next to them carry the meaning.
const ICON_PATHS = {
  send: ['M4 12 20 4l-5.5 16-3-7z', 'M11.5 13 20 4'],
  check: ['M5 12.5 9.5 17 19 7.5'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7.5V12l3 2'],
  retry: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4v4.5h-4.5'],
  stop: ['M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3z', 'M9.5 9.5l5 5', 'M14.5 9.5l-5 5'],
  cross: ['M7 7l10 10', 'M17 7 7 17'],
  inbox: ['M4 13.5 6.5 5h11l2.5 8.5V19H4z', 'M4 13.5h4.5l1 2.5h5l1-2.5H20'],
  box: ['M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z', 'M3.5 7.5 12 12l8.5-4.5', 'M12 12v9'],
  question: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M9.6 9.3a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.6', 'M12 16.8v.2'],
  dash: ['M7 12h10'],
  offline: ['M3 3l18 18', 'M8.5 8.8A11 11 0 0 0 2.5 12', 'M12 5a11 11 0 0 1 9.5 7', 'M8 15.5a6 6 0 0 1 7.5-.8', 'M12 19.5v.2'],
  replay: ['M4 12a8 8 0 1 0 2.4-5.7', 'M4 4v4.5h4.5', 'M10.5 9.5v5l4-2.5z'],
  hourglass: ['M7 3h10', 'M7 21h10', 'M8 3c0 5 8 5 8 9s-8 4-8 9', 'M16 3c0 5-8 5-8 9s8 4 8 9'],
  bell: ['M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z', 'M10 20.5a2 2 0 0 0 4 0'],
  wrench: ['M5 19l8-8', 'M12.5 6.5a4 4 0 0 1 5.5-1.5l-2.5 2.5 1 2 2 1 2.5-2.5a4 4 0 0 1-5.5 5.5'],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01'],
};
function icon(name, extraClass = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
    class: `icon ${extraClass}`.trim(),
  })) svg.setAttribute(k, v);
  for (const d of ICON_PATHS[name] ?? ICON_PATHS.question) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
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
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Sample alerts. Each fits the API's only event type (demo.notification) and its two fields:
// a title and a message. No urgency, recipients or routing exist in the API, so none are implied.
const PRESETS = [
  { id: 'service', icon: 'bell', title: 'Service request', message: 'Synthetic room A needs assistance.' },
  { id: 'equipment', icon: 'wrench', title: 'Equipment notification', message: 'Demo device reports a maintenance issue.' },
  { id: 'team', icon: 'list', title: 'Team update', message: 'A sample task is ready for review.' },
];
const chars = (text) => [...text].length;

function readJson(key) {
  try { return JSON.parse(storage.get(key) ?? 'null'); } catch { return null; }
}

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
  detailNote: null,        // result of the last copy / replay action for the selected event
  techOpen: false,         // the journey's technical view stays open across refreshes
  receiver: null,
  summary: null,
  // The submission whose outcome is unknown, saved before sending. If the page is reloaded while it was being
  // sent, nobody knows whether it arrived, so it comes back as 'uncertain'. It is never resent automatically.
  pendingSubmit: (() => {
    const saved = readJson(KEYS.pending);
    return saved?.key && saved.body ? { ...saved, status: 'uncertain' } : null;
  })(),
  submitting: false,       // a send or check is in flight: the button is disabled
  preset: null,            // index of the chosen sample alert (null after an experiment fills the fields)
  submitNote: null,        // the result of the last send, shown under the composer
  poll: { timer: null, running: false, again: false, failures: 0, lastError: null },
  slowRequests: 0,
  service: { status: 'checking', detail: null }, // checking | ready | not_ready | unreachable | offline
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

// Plain-language wording for API error codes. The technical line keeps the status and code.
const ERROR_TEXT = {
  event_limit_reached: 'This demo session has reached its limit of alerts. Start a fresh session to continue.',
  rate_limited: 'Too many requests from your connection. Wait a minute, then try again.',
  replay_limit_reached: 'This alert has already been re-delivered the maximum number of times.',
  delivery_not_failed: 'Only a delivery that has stopped can be tried again.',
  already_replayed: 'This delivery was already tried again. Follow the newer delivery instead.',
  idempotency_key_conflict: 'This request reused an identifier that belongs to a different alert, so it was refused.',
  validation_failed: 'Some fields need attention. Nothing was saved.',
  session_capacity_reached: 'The demo is busy right now. Please try again later.',
};
const FIELD_NAMES = { 'payload.title': 'Alert title', 'payload.message': 'Alert message' };

function techLine(...parts) {
  return h('p', { class: 'hint' }, h('span', { class: 'visually-hidden' }, 'Technical: '), parts.filter(Boolean).join(' · '));
}

// Turns an API error answer into a readable notice (validation details included).
function errorBox(status, data) {
  const tone = status === 429 ? 'is-waiting' : 'is-failed';
  return h('div', { class: `notice ${tone}` },
    h('strong', {}, ERROR_TEXT[data?.error] ?? data?.message ?? 'The request was not accepted.'),
    data?.details ? h('ul', {}, data.details.map((d) => h('li', {}, `${FIELD_NAMES[d.field] ?? d.field} ${d.issue}.`))) : null,
    techLine(`HTTP ${status}`, data?.error));
}

function unavailableBox(err) {
  return h('div', { class: 'notice is-failed' }, h('strong', {}, 'No answer from the service. '), err.message,
    ' As far as this page can tell, nothing was changed; you can try again.');
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
    // A successful refresh reached the API and its database.
    if (state.service.status !== 'ready') setService('ready');
  } catch (err) {
    state.poll.failures += 1;
    state.poll.lastError = err.message;
    if (err instanceof Unavailable) setService(navigator.onLine === false ? 'offline' : 'unreachable', err.message);
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
  // An unconfirmed submission can be confirmed by reading: if an alert with its Idempotency-Key is in the
  // list, it was accepted. Not finding it proves nothing, so that never resolves anything.
  const pending = state.pendingSubmit;
  const found = pending?.status === 'uncertain' && state.events.find((e) => e.idempotencyKey === pending.key);
  if (found) {
    setPending(null);
    selectEvent(found.id);
    state.submitNote = h('div', { class: 'notice is-done' }, h('strong', {}, 'Confirmed: your alert was accepted. '),
      'It appears in your recent alerts, so there is nothing to check again. Delivery may still be pending.',
      techLine('found by reading GET /v1/events', `Idempotency-Key ${pending.key}`));
  }
  if (state.selectedId) await loadDetail(state.selectedId);
  render();
}

async function loadDetail(eventId) {
  const [deliveries, receipt] = await Promise.all([
    api('GET', `/v1/events/${eventId}/deliveries`),
    api('GET', `/v1/receiver/receipts/${eventId}`),
  ]);
  if (state.selectedId !== eventId || !state.token) return; // a stale answer for an alert no longer shown
  if (deliveries.status === 404) { selectEvent(null); return; }
  if (deliveries.status !== 200 || receipt.status !== 200) throw new Unavailable('Could not load the alert details.');
  state.detail = { eventId, deliveries: deliveries.data.deliveries, receipt: receipt.data };
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopPolling(); renderPollStatus('paused'); } else { pollNow(); }
});
window.addEventListener('pagehide', stopPolling);
// "Offline" is only ever shown for the visitor's own connection, never for a receiver mode.
window.addEventListener('offline', () => setService('offline'));
window.addEventListener('online', () => { checkStatus(); pollNow(); });

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
  state.sessionNote = 'Your demo session has ended or is no longer valid. Sending an alert starts a new one.';
  if (state.pendingSubmit) {
    // Idempotency-Keys belong to one session, so the unconfirmed alert can't be checked from a new one.
    setPending(null);
    state.submitNote = h('div', { class: 'notice is-waiting' }, h('strong', {}, 'Your demo session has ended. '),
      'An alert was still unconfirmed. It belonged to that session, so it can no longer be checked.');
  }
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
      state.sessionNote = `${ERROR_TEXT[data.error] ?? data.message ?? `HTTP ${status}`}${retry ? ` Try again in about ${Math.ceil(retry / 60)} minute(s).` : ''}`;
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

// --- composer --------------------------------------------------------------------

const draftBody = () => ({ type: 'demo.notification', payload: { title: $('title').value, message: $('message').value } });

function saveDraft() {
  storage.set(KEYS.draft, JSON.stringify({ preset: state.preset, title: $('title').value, message: $('message').value }));
}

// Choosing a sample fills the editable fields. It never changes the receiver.
function choosePreset(index) {
  state.preset = index;
  $('title').value = PRESETS[index].title;
  $('message').value = PRESETS[index].message;
  for (const id of ['title', 'message']) showFieldError(id, null);
  saveDraft();
  renderComposer();
}

// The draft survives a reload, separately from any unconfirmed submission.
function restoreDraft() {
  const saved = readJson(KEYS.draft);
  if (saved && typeof saved.title === 'string' && typeof saved.message === 'string') {
    state.preset = Number.isInteger(saved.preset) && PRESETS[saved.preset] ? saved.preset : null;
    $('title').value = saved.title;
    $('message').value = saved.message;
  } else {
    choosePreset(0); // a first-time visitor can send without typing
  }
}

// Same rules as the API: required, not blank, length in Unicode characters, no control characters
// (the message may contain line breaks).
function fieldProblem(id, value) {
  if (value.trim() === '') return 'Please fill this in.';
  if (chars(value) > LIMITS[id]) return `Please keep it to ${LIMITS[id]} characters or fewer.`;
  if (id === 'title' && /[\u0000-\u001F\u007F]/.test(value)) return 'Please use a single line without special characters.';
  if (id === 'message' && /[\u0000-\u0009\u000B-\u001F\u007F]/.test(value)) return 'Please remove special characters (line breaks are fine).';
  return null;
}

function showFieldError(id, problem) {
  const error = $(`${id}-error`);
  error.textContent = problem ?? '';
  error.hidden = !problem;
  $(id).setAttribute('aria-invalid', problem ? 'true' : 'false');
}

function validateForm() {
  let firstInvalid = null;
  for (const id of ['title', 'message']) {
    const problem = fieldProblem(id, $(id).value);
    showFieldError(id, problem);
    if (problem && !firstInvalid) firstInvalid = id;
  }
  if (firstInvalid) $(firstInvalid).focus();
  return !firstInvalid;
}

function setPending(pending) {
  state.pendingSubmit = pending;
  storage.set(KEYS.pending, pending ? JSON.stringify(pending) : null);
}

// "Send alert": validate, start a session only if there is none (and only because of this click),
// save the key and payload, then send once. A new send always gets a new Idempotency-Key.
async function sendDraft() {
  if (state.submitting || state.pendingSubmit) return null;
  if (!validateForm()) return null;
  state.submitting = true; // disables the button before anything is awaited, so double clicks do nothing
  state.submitNote = null;
  renderComposer();
  try {
    if (!state.token) {
      if (!(await startSession())) {
        state.submitNote = h('div', { class: 'notice is-waiting' }, h('strong', {}, 'Could not start a demo session. '),
          state.sessionNote ?? '', ' Your alert was not sent.');
        state.sessionNote = null;
        return null;
      }
    }
    setPending({ key: crypto.randomUUID(), body: draftBody(), status: 'sending' }); // saved before the request
    renderComposer();
    return await sendPending(false);
  } finally {
    state.submitting = false;
    render();
  }
}

// "Check again": the same key and the same payload as the unconfirmed submission. If the first
// request arrived, the API answers 200 with that alert; if it did not, this request creates it once.
async function checkAgain() {
  if (state.submitting || !state.pendingSubmit) return;
  state.submitting = true;
  setPending({ ...state.pendingSubmit, status: 'sending' });
  state.submitNote = null;
  renderComposer();
  try {
    await sendPending(true);
  } finally {
    state.submitting = false;
    render();
  }
}

function stopChecking() {
  setPending(null);
  state.submitNote = h('div', { class: 'notice is-idle' }, h('strong', {}, 'Stopped checking. '),
    'If that alert was accepted, it will still appear in Recent alerts.');
  render();
}

async function sendPending(isCheck) {
  const pending = state.pendingSubmit;
  const uncertain = (reason) => {
    if (state.pendingSubmit === pending) setPending({ ...pending, status: 'uncertain', lastError: reason });
    return null;
  };
  let res;
  try {
    res = await api('POST', '/v1/events', { body: pending.body, headers: { 'Idempotency-Key': pending.key } });
  } catch (err) {
    return uncertain(err.message); // timeout or network failure after sending: the outcome is unknown
  }
  if (res.status >= 500) return uncertain(`The service answered HTTP ${res.status}.`);

  // Any other answer settles this key.
  if (state.pendingSubmit === pending) setPending(null);
  const { status, data } = res;
  if (status === 202 || status === 200) {
    showAccepted(data, status, isCheck);
    return data.eventId;
  }
  if (status === 401) {
    state.submitNote = h('div', { class: 'notice is-waiting' }, h('strong', {}, 'Your demo session has ended. '),
      isCheck
        ? 'The unconfirmed alert belonged to that session, so it can no longer be checked.'
        : 'Nothing was saved. Press Send alert to start a new session and send it.',
      techLine('HTTP 401', data?.error));
    return null;
  }
  if (status === 422 && Array.isArray(data?.details)) {
    for (const d of data.details) {
      const id = d.field === 'payload.title' ? 'title' : d.field === 'payload.message' ? 'message' : null;
      if (id) showFieldError(id, `This ${d.issue}.`);
    }
  }
  const box = errorBox(status, data);
  if (data?.error === 'event_limit_reached') {
    box.append(h('button', { type: 'button', class: 'btn-link', onclick: () => startSession() }, 'Start a fresh session'));
  }
  state.submitNote = box;
  return null;
}

// Shows the accepted alert at once, from the API's own answer; later refreshes replace it.
function showAccepted(data, status, isCheck) {
  if (!state.events.some((e) => e.id === data.event.id)) state.events = [data.event, ...state.events];
  selectEvent(data.eventId);
  state.submitNote = h('div', { class: 'notice is-done' },
    status === 200 && isCheck
      ? [h('strong', {}, 'Confirmed: your alert was accepted. '),
        'The earlier request did reach the sandbox. Checking again did not create a second alert.']
      : status === 200
        ? [h('strong', {}, 'Already accepted. '), 'This exact request was accepted earlier, so nothing new was created.']
        : [h('strong', {}, 'Alert accepted. '),
          isCheck ? 'The earlier request had not arrived, so this check sent it. There is still only one alert. ' : '',
          'Delivery may still be pending: the journey shows each step as it happens.'],
    techLine(`HTTP ${status}`, status === 200 ? 'Idempotent-Replayed: true' : 'stored and queued, not yet delivered',
      `Idempotency-Key ${data.event.idempotencyKey}`));
  render();
  pollNow();
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
    status.textContent = `Saved. The test receiver now: ${MODE_INFO[mode][0]}.`;
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
  state.detailNote = h('p', { class: 'hint' }, 'Sending an exact copy…');
  keepFocus($('detail'), renderDetail);
  try {
    const { status, data, headers } = await api('POST', '/v1/events', {
      body: { type: event.type, payload: event.payload },
      headers: { 'Idempotency-Key': event.idempotencyKey },
    });
    state.detailNote = status === 200
      ? h('div', { class: 'notice is-done' }, h('strong', {}, 'Copy recognized. '),
        'The sandbox saw this exact alert before: no new alert was created and nothing was delivered again.',
        techLine(`HTTP ${status}`, headers.get('Idempotent-Replayed') ? 'Idempotent-Replayed: true' : null,
          `same event ID ${shortId(data.eventId)}…`))
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
  state.detailNote = h('p', { class: 'hint' }, 'Asking the sandbox to deliver it again…');
  keepFocus($('detail'), renderDetail);
  try {
    const { status, data } = await api('POST', `/v1/deliveries/${deliveryId}/replay`,
      { headers: { 'Idempotency-Key': keys[deliveryId] } });
    delete keys[deliveryId];
    storage.set(KEYS.replayKeys, JSON.stringify(keys));
    state.detailNote = status === 202 || status === 200
      ? h('div', { class: 'notice is-done' }, h('strong', {}, 'Delivering again. '),
        'A new delivery of the same alert has started with a fresh set of tries. The stopped delivery stays in the record.',
        techLine(`HTTP ${status}`, 'manual replay scheduled'))
      : errorBox(status, data);
    await pollNow();
  } catch (err) {
    state.detailNote = unavailableBox(err);
  }
  keepFocus($('detail'), renderDetail);
}

// --- experiments (the guided scenarios) -------------------------------------------

const SCENARIOS = [
  {
    id: 'recover',
    icon: 'retry',
    title: 'Receiver has a short outage',
    why: 'The test receiver refuses alerts for a while. Watch the sandbox wait and try again, then turn the receiver back on.',
    mode: 'server_error',
    eventTitle: 'Experiment: short receiver outage',
    steps: [
      'Press Start. The test receiver is set to refuse alerts, and one alert is sent.',
      'Watch the first try fail and a new try get scheduled (tries follow after 2, 4 and 8 seconds).',
      'Press "Turn receiver back on" within about 14 seconds, before the fourth and last try.',
    ],
    expected: 'The next try is confirmed and the receiver processes the alert once. The earlier tries stay in the record as failed.',
    followUp: { label: 'Turn receiver back on', mode: 'success' },
  },
  {
    id: 'timeout',
    icon: 'hourglass',
    title: 'Receiver replies too late',
    why: 'The receiver does the work, but its reply arrives after the sandbox stops waiting. Watch the sandbox try again without the alert being processed twice.',
    mode: 'process_then_timeout',
    eventTitle: 'Experiment: reply arrives too late',
    steps: [
      'Press Start. The test receiver is set to do the work but reply late, and one alert is sent.',
      'After about 3 seconds the first try shows "No reply in time", while the receiver already shows the alert as processed.',
      'After about 6 seconds the sandbox tries again. No action is needed.',
    ],
    expected: 'Two tries: no reply in time, then confirmed. The receiver processed the alert once and recognized one repeat.',
  },
  {
    id: 'replay',
    icon: 'replay',
    title: 'Outage outlasts every try',
    why: 'All four tries fail, so the sandbox stops. Then turn the receiver back on and deliver the alert again by hand.',
    mode: 'server_error',
    eventTitle: 'Experiment: outage longer than every try',
    steps: [
      'Press Start. The test receiver is set to refuse alerts, and one alert is sent.',
      'Wait about 15 seconds until the journey shows "Delivery stopped".',
      'Press "Turn receiver back on", then "Deliver again" in the journey.',
    ],
    expected: 'The first delivery stays stopped with 4 failed tries. A new delivery is confirmed on its first try. The receiver processed the alert once.',
    followUp: { label: 'Turn receiver back on', mode: 'success' },
  },
];

async function runScenario(scenario, button) {
  button.disabled = true;
  try {
    if (state.pendingSubmit || state.submitting) {
      state.submitNote = h('div', { class: 'notice is-waiting' }, 'Please resolve the unconfirmed alert in the composer first.');
      renderComposer();
      return;
    }
    if (!state.token && !(await startSession())) return;
    if (!(await setReceiverMode(scenario.mode))) return;
    state.preset = null;
    $('title').value = scenario.eventTitle;
    $('message').value = 'Synthetic data for a sandbox experiment.';
    saveDraft();
    const eventId = await sendDraft();
    if (eventId) {
      const box = $('journey').getBoundingClientRect();
      if (box.top < 0 || box.top > window.innerHeight * 0.6) {
        $('journey').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      }
    }
  } finally {
    button.disabled = false;
  }
}

function renderScenarios() {
  $('scenarios').replaceChildren(...SCENARIOS.map((s) => {
    const start = h('button', { type: 'button', class: 'btn btn-primary' }, 'Start experiment');
    start.addEventListener('click', () => runScenario(s, start));
    return h('article', { class: 'card experiment', 'aria-labelledby': `scenario-${s.id}` },
      icon(s.icon, 'exp-icon'),
      h('h3', { id: `scenario-${s.id}` }, s.title),
      h('p', {}, s.why),
      h('p', { class: 'note' }, 'Changes how your test receiver responds for this session.'),
      h('details', { class: 'tech' }, h('summary', {}, 'Steps and what to expect'),
        h('ol', {}, s.steps.map((step) => h('li', {}, step))),
        h('p', {}, h('strong', {}, 'Expected: '), s.expected)),
      h('div', { class: 'button-row' }, start,
        s.followUp ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => setReceiverMode(s.followUp.mode) }, s.followUp.label) : null));
  }));
}

// --- plain-language views of API state ------------------------------------------------

// One delivery's state, from delivery.state / attemptCount / maxAttempts / nextAttemptAt / failureReason.
function deliveryView(d) {
  const n = d.attemptCount;
  const max = d.maxAttempts;
  switch (d.state) {
    case 'pending':
      return n === 0
        ? { tone: 'is-waiting', icon: 'clock', label: 'Waiting to send', detail: 'Queued for the sandbox\'s delivery worker.' }
        : { tone: 'is-waiting', icon: 'clock', label: 'Waiting to send again', detail: `Try ${n} ended without a known result (the delivery worker stopped). It will be sent again.` };
    case 'in_progress':
      return { tone: 'is-active', icon: 'send', label: 'Sending', detail: `Try ${n} of ${max} is on its way to the receiver.` };
    case 'retry_scheduled': {
      const wait = secondsUntil(d.nextAttemptAt);
      return {
        tone: 'is-waiting', icon: 'retry', label: 'Trying again',
        detail: `Try ${n} of ${max} did not get through. Next try ${wait > 0 ? `in about ${wait} s` : 'is due now'} (at ${time(d.nextAttemptAt)}).`,
      };
    }
    case 'delivered':
      return { tone: 'is-done', icon: 'check', label: 'Delivery confirmed', detail: `The receiver acknowledged it on try ${n} of ${max}.` };
    case 'failed':
      return {
        tone: 'is-failed', icon: 'stop', label: 'Delivery stopped',
        detail: {
          attempts_exhausted: `All ${max} tries failed, so the sandbox stopped trying.`,
          non_retryable: 'The receiver refused it in a way that trying again cannot fix.',
          session_expired: 'The demo session ended before it could be delivered.',
        }[d.failureReason] ?? 'The sandbox stopped trying.',
      };
    default:
      return { tone: 'is-unknown', icon: 'question', label: 'Unknown state', detail: `The API reported "${d.state}".` };
  }
}

// One attempt, from outcome / errorCategory / retryable.
function attemptView(a) {
  const at = ` (${time(a.startedAt)})`;
  if (a.outcome === 'in_progress') return { tone: 'is-active', icon: 'send', text: `Try ${a.attemptNumber}: sending…${at}` };
  if (a.outcome === 'delivered') return { tone: 'is-done', icon: 'check', text: `Try ${a.attemptNumber}: receiver confirmed${at}` };
  if (a.outcome === 'lease_expired') return { tone: 'is-unknown', icon: 'question', text: `Try ${a.attemptNumber}: result unknown, the delivery worker restarted${at}` };
  const why = {
    http_error: a.retryable === false ? 'receiver refused it' : 'receiver reported a problem',
    timeout: 'no reply in time',
    network_error: 'could not reach the receiver',
  }[a.errorCategory] ?? 'did not get through';
  return { tone: a.errorCategory === 'timeout' ? 'is-waiting' : 'is-failed', icon: a.errorCategory === 'timeout' ? 'hourglass' : 'cross', text: `Try ${a.attemptNumber}: ${why}${at}` };
}

// The receiver's side, from the receipt (processed / result / deliveriesReceived / duplicateCount).
function receiverView(receipt, latest) {
  if (!receipt) return { tone: 'is-unknown', icon: 'question', label: 'Checking…', detail: 'Loading what the receiver recorded.' };
  if (receipt.processed) {
    const repeats = receipt.duplicateCount;
    return {
      tone: 'is-done', icon: 'inbox', label: 'Receiver processed alert',
      detail: `Confirmation ${receipt.result?.confirmationCode ?? '(none)'}. `
        + (repeats > 0
          ? `It received the alert ${receipt.deliveriesReceived} times, recognized ${repeats} as ${repeats === 1 ? 'a repeat' : 'repeats'}, and processed it only once.`
          : 'Processed once.'),
    };
  }
  if (latest && ACTIVE_STATES.has(latest.state)) {
    return { tone: 'is-idle', icon: 'dash', label: 'Not processed yet', detail: 'Nothing has been processed while delivery is still under way.' };
  }
  if (latest?.state === 'failed') {
    return { tone: 'is-idle', icon: 'dash', label: 'Not processed', detail: 'The receiver did not act on this alert.' };
  }
  return { tone: 'is-unknown', icon: 'question', label: 'No processing recorded', detail: 'The delivery was confirmed, but the receiver has no record of processing it.' };
}

const MODE_INFO = {
  success: ['Works normally', 'Accepts the alert and processes it right away.'],
  server_error: ['Temporary outage', 'Refuses alerts with an error and processes nothing. The sandbox tries again.'],
  timeout: ['Too slow to reply', 'Replies after the sandbox has stopped waiting, and processes nothing.'],
  process_then_timeout: ['Processes, then replies late', 'Does the work, but the reply arrives after the sandbox has stopped waiting.'],
};

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
  renderComposer();
}

function setService(status, detail = null) {
  state.service = { status, detail };
  renderService();
}

function renderService() {
  const { status } = state.service;
  const waking = state.slowRequests > 0 && status === 'checking';
  const view = waking
    ? ['is-waiting', 'hourglass', 'Waking up…']
    : {
      checking: ['is-idle', 'clock', 'Checking service…'],
      ready: ['is-done', 'check', 'Service ready'],
      not_ready: ['is-failed', 'stop', 'Service not ready'],
      unreachable: ['is-failed', 'cross', 'Can\'t reach service'],
      offline: ['is-failed', 'offline', 'You are offline'],
    }[status];
  const pill = $('service-status');
  pill.className = `status-pill ${view[0]}`;
  pill.replaceChildren(icon(view[1]), view[2]);
}

function renderWakeBanner() {
  const banner = $('wake-banner');
  banner.hidden = state.slowRequests === 0;
  banner.textContent = state.slowRequests > 0
    ? 'Waiting for the server… On the free hosting plan the service sleeps after 15 minutes without visitors '
      + 'and can take about a minute to wake up. Nothing has failed: your request is still in progress.'
    : '';
  renderService();
}

function renderSession() {
  const area = $('session-area');
  const children = [];
  if (state.sessionNote) children.push(h('div', { class: 'notice is-waiting' }, state.sessionNote));
  if (state.token) {
    children.push(h('div', { class: 'session-box' },
      h('p', { class: 'status-pill is-done' }, icon('check'), 'Demo session active'),
      state.expiresAt ? h('p', { class: 'hint' }, `until ${new Date(state.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`) : null,
      // A fresh session would make an unconfirmed alert impossible to check, so wait until it is resolved.
      h('button', {
        type: 'button', class: 'btn-link small', onclick: () => startSession(),
        disabled: state.creatingSession || state.submitting || Boolean(state.pendingSubmit),
      }, state.creatingSession ? 'Starting…' : 'Start fresh session')));
  }
  area.replaceChildren(...children);
}

function renderReceiver() {
  const container = $('receiver-modes');
  const current = state.receiver?.mode;
  // The radio buttons are created once and only updated, so refreshes never move keyboard focus.
  if (!container.firstChild) {
    container.append(...Object.entries(MODE_INFO).map(([mode, [label, description]]) => {
      const input = h('input', { type: 'radio', name: 'mode', value: mode, id: `mode-${mode}` });
      input.addEventListener('change', () => setReceiverMode(mode));
      return h('label', { for: `mode-${mode}`, class: 'choice' }, input, h('span', {}, h('strong', {}, label), h('span', {}, description)));
    }));
  }
  for (const input of container.querySelectorAll('input')) {
    input.checked = input.value === current;
    input.disabled = !state.token;
  }
  if (!state.token) $('receiver-status').textContent = 'Start a session to choose how the test receiver responds.';
  else if (state.receiver && !$('receiver-status').textContent) {
    $('receiver-status').textContent = `Currently: ${MODE_INFO[current]?.[0] ?? current}.`;
  }
}

function renderComposer() {
  // Sample cards: created once, then only updated, so refreshes never move keyboard focus.
  const list = $('preset-list');
  if (!list.firstChild) {
    list.append(...PRESETS.map((p, i) => {
      const input = h('input', { type: 'radio', name: 'preset', value: p.id, id: `preset-${p.id}` });
      input.addEventListener('change', () => choosePreset(i));
      return h('label', { for: `preset-${p.id}`, class: 'preset' }, input,
        icon(p.icon, 'preset-icon'),
        h('span', { class: 'preset-text' }, h('strong', {}, p.title), h('span', {}, p.message)));
    }));
  }
  list.querySelectorAll('input').forEach((input, i) => { input.checked = state.preset === i; });

  const title = $('title').value;
  const message = $('message').value;
  for (const [id, value] of [['title', title], ['message', message]]) {
    const counter = $(`${id}-count`);
    const n = chars(value);
    counter.textContent = `${n} of ${LIMITS[id]} characters`;
    counter.classList.toggle('over', n > LIMITS[id]);
  }

  const preset = PRESETS[state.preset];
  const edited = !preset || preset.title !== title || preset.message !== message;
  $('preview').replaceChildren(
    h('p', { class: 'message-card-tag' }, icon(preset?.icon ?? 'bell'), preset && !edited ? 'Sample alert' : 'Sample alert, edited'),
    h('p', { class: 'message-card-title' }, title.trim() ? title : '(no title yet)'),
    h('p', { class: 'message-card-body' }, message.trim() ? message : '(no message yet)'));

  const pending = state.pendingSubmit;
  // While an alert is unconfirmed, show the exact request that "Check again" repeats.
  $('request-json').textContent = [
    pending ? '# The unconfirmed request, repeated exactly by "Check again"' : '# What "Send alert" will send',
    'POST /v1/events',
    'Content-Type: application/json',
    'Authorization: Bearer <your demo token, never shown>',
    `Idempotency-Key: ${pending ? pending.key : '<a new random key, created when you press Send alert>'}`,
    '',
    JSON.stringify(pending ? pending.body : draftBody(), null, 2),
  ].join('\n');

  const button = $('submit-event');
  button.disabled = state.submitting || Boolean(pending);
  const firstSend = state.submitting && !pending?.lastError; // not a "Check again"
  button.textContent = state.creatingSession ? 'Starting session…' : firstSend ? 'Sending…' : 'Send alert';
  $('send-hint').textContent = pending
    ? 'Send alert is paused until the unconfirmed alert below is resolved.'
    : state.token ? '' : 'Sending starts a private demo session: anonymous, no sign-up, and it ends after 24 hours.';

  renderPending();
  $('submit-result').replaceChildren(...[state.submitNote].filter(Boolean));

  const mode = state.token ? state.receiver?.mode : 'success';
  $('receiver-label').replaceChildren(icon('inbox'),
    h('span', {}, 'Test receiver: ', h('strong', {}, MODE_INFO[mode]?.[0] ?? 'checking…'),
      state.token ? '' : ' (the default for a new session)',
      h('span', { class: 'hint receiver-hint' }, 'Experiments below can change this.')));
}

// The unconfirmed submission, shown apart from the draft so editing the draft never changes it.
function renderPending() {
  const area = $('pending-area');
  const pending = state.pendingSubmit;
  if (!pending || (pending.status === 'sending' && !pending.lastError)) {
    area.replaceChildren();
    return;
  }
  const checking = state.submitting;
  const draftDiffers = JSON.stringify(pending.body) !== JSON.stringify(draftBody());
  area.replaceChildren(h('div', { class: 'notice is-waiting pending', role: 'alert' },
    h('p', {}, h('strong', {}, checking ? 'Checking…' : 'We could not confirm whether your alert was accepted.')),
    h('p', {}, 'The connection failed or timed out after the alert was sent. ',
      'Check again repeats the exact same request, so it cannot create a second alert.'),
    h('p', { class: 'pending-alert' }, 'Unconfirmed alert: ', h('q', {}, pending.body.payload.title)),
    draftDiffers ? h('p', { class: 'hint' }, 'Your edited draft is kept separately and is not affected.') : null,
    h('div', { class: 'button-row' },
      h('button', { type: 'button', class: 'btn btn-primary', 'data-focus-key': 'check-again', onclick: () => checkAgain(), disabled: checking },
        checking ? 'Checking…' : 'Check again'),
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => stopChecking(), disabled: checking }, 'Stop checking')),
    techLine(pending.lastError, `Idempotency-Key ${pending.key}`)));
}

function renderEvents() {
  const list = $('event-list');
  if (!state.token) {
    list.replaceChildren(h('li', { class: 'history-empty' }, 'Your alerts will appear here.'));
    return;
  }
  if (state.events.length === 0) {
    list.replaceChildren(h('li', { class: 'history-empty' }, 'No alerts yet. Send one or start an experiment.'));
    return;
  }
  const items = state.events.map((event) => {
    const view = deliveryView(event.delivery);
    const replays = event.delivery.replayCount;
    const button = h('button', {
      type: 'button', class: `history-item ${view.tone}`, 'aria-current': event.id === state.selectedId ? 'true' : 'false',
      'data-focus-key': `event-${event.id}`,
    },
    icon(view.icon),
    h('span', { class: 'h-title' }, event.payload.title),
    h('span', { class: 'h-time' }, time(event.createdAt)),
    h('span', { class: 'h-state' }, view.label, replays ? ` · delivered again ${replays === 1 ? 'once' : `${replays} times`}` : ''));
    button.addEventListener('click', () => {
      selectEvent(event.id);
      render();
      pollNow();
    });
    return h('li', {}, button);
  });
  if (state.hasMoreEvents) items.push(h('li', { class: 'hint' }, 'Showing your 20 newest alerts.'));
  list.replaceChildren(...items);
}

function renderPollStatus(mode, delay) {
  const text = {
    none: '',
    active: 'Updating every 2 seconds while alerts are on their way.',
    idle: 'All alerts have finished. Updates resume when you send or deliver again.',
    paused: 'Updates paused while this tab is hidden.',
    backoff: `Couldn't update (${state.poll.lastError}). Trying again in ${Math.round((delay ?? 0) / 1000)} s.`,
  }[mode];
  const el = $('poll-status');
  el.replaceChildren(text ?? '');
  if (mode === 'backoff') el.append(' ', h('button', { type: 'button', class: 'btn-link', onclick: () => pollNow() }, 'Retry now'));
}

function stage(name, question, view, ...body) {
  return h('li', { class: `stage ${view.tone}` },
    h('div', { class: 'stage-icon' }, icon(view.icon)),
    h('p', { class: 'stage-name' }, name),
    h('p', { class: 'stage-question' }, question),
    h('p', { class: 'stage-status' }, view.label),
    h('div', { class: 'stage-body' }, view.detail ? h('p', {}, view.detail) : null, ...body));
}

const STAGES = [
  ['1 · Sandbox', 'Did the sandbox accept the alert?'],
  ['2 · Delivery', 'Did the receiver confirm it got the alert?'],
  ['3 · Receiver', 'Did the receiver act on it?'],
];

// Technical lines kept from the earlier UI, shown only in the technical view.
function attemptLine(a) {
  const parts = [`Attempt ${a.attemptNumber}: ${a.outcome}`];
  parts.push(a.responseStatus ? `HTTP ${a.responseStatus}` : 'no HTTP response');
  if (a.errorCategory) parts.push(a.errorCategory);
  if (a.retryable !== null) parts.push(`retryable: ${a.retryable}`);
  if (a.durationMs !== null) parts.push(`${a.durationMs} ms`);
  return parts.join(' · ');
}

function technicalView(event, detail) {
  const details = h('details', { class: 'tech', open: state.techOpen },
    h('summary', { 'data-focus-key': 'tech' }, 'Technical view: IDs, status codes and raw API data'),
    h('ul', { class: 'tech-list' },
      h('li', {}, 'Event ID: ', h('code', {}, event.id)),
      h('li', {}, 'Idempotency-Key: ', h('code', {}, event.idempotencyKey)),
      h('li', {}, 'Accepted with HTTP 202 at ', h('code', {}, event.createdAt)),
      h('li', {}, 'Status URL: ', h('code', {}, event.delivery.statusUrl)),
      ...(detail?.deliveries ?? []).map((d, i) => h('li', {},
        `${i === 0 ? 'Original delivery' : `Replay ${i}`} `, h('code', {}, d.id), `: state ${d.state}`,
        d.failureReason ? `, failureReason ${d.failureReason}` : '',
        h('ul', {}, d.attempts.map((a) => h('li', {}, attemptLine(a)))))),
      detail ? h('li', {}, `Receiver receipt: processed ${detail.receipt.processed}, deliveriesReceived ${detail.receipt.deliveriesReceived}, duplicateCount ${detail.receipt.duplicateCount}`) : null),
    h('pre', {}, JSON.stringify({ event, deliveries: detail?.deliveries ?? null, receipt: detail?.receipt ?? null }, null, 2)));
  details.addEventListener('toggle', () => { state.techOpen = details.open; });
  return details;
}

function renderDetail() {
  const container = $('detail');
  const event = state.events.find((e) => e.id === state.selectedId);
  if (!state.token || !event) {
    const idle = { tone: 'is-idle', icon: 'dash', label: 'Not started', detail: null };
    container.replaceChildren(h('div', { class: 'journey-empty' },
      h('p', {}, !state.token
        ? 'Start a demo session and send an alert. Its journey will appear here, step by step.'
        : state.events.length ? 'Choose an alert from Recent alerts to see its journey.' : 'Send an alert to see its journey here.'),
      h('p', { class: 'journey-sub' }, 'Every journey has three steps:'),
      h('ol', { class: 'stages' }, STAGES.map(([name, question]) => stage(name, question, idle)))));
    return;
  }

  const detail = state.detail?.eventId === event.id ? state.detail : null;
  const deliveries = detail?.deliveries ?? null;
  const latest = deliveries?.at(-1) ?? event.delivery;

  const accepted = { tone: 'is-done', icon: 'box', label: 'Accepted', detail: 'Saved and queued. Accepted means it will be delivered, not that it has been.' };

  let deliveryBody;
  if (!deliveries) {
    deliveryBody = [h('p', { class: 'stage-question' }, 'Loading the delivery record…')];
  } else {
    deliveryBody = deliveries.map((d, index) => h('div', { class: 'delivery-group' },
      deliveries.length > 1 ? h('h4', {}, index === 0 ? 'First delivery' : `Delivered again (${index})`, ': ', deliveryView(d).label) : null,
      d.attempts.length
        ? h('ul', { class: 'tries' }, d.attempts.map((a) => {
          const v = attemptView(a);
          return h('li', { class: v.tone }, icon(v.icon), h('span', {}, v.text));
        }))
        : h('p', {}, 'No tries yet.')));
  }

  // After a manual replay, the stage summary describes the newest delivery; say so.
  const latestView = deliveryView(latest);
  if (deliveries && deliveries.length > 1) latestView.detail = `Delivered again: ${latestView.detail.charAt(0).toLowerCase()}${latestView.detail.slice(1)}`;

  const timedOutButProcessed = detail?.receipt.processed
    && deliveries.some((d) => d.attempts.some((a) => a.errorCategory === 'timeout'));

  const actions = h('div', { class: 'journey-actions' },
    h('button', { type: 'button', class: 'btn', 'data-focus-key': 'duplicate', onclick: () => submitDuplicate(event) },
      'Send an exact copy'),
    latest.state === 'failed' && deliveries
      ? h('button', { type: 'button', class: 'btn btn-primary', 'data-focus-key': 'replay', onclick: () => replayDelivery(latest.id) },
        icon('replay'), 'Deliver again')
      : null);

  // replaceChildren() would print null as text, so empty parts are filtered out.
  container.replaceChildren(...[
    h('h3', { class: 'journey-title' }, event.payload.title),
    h('p', { class: 'journey-sub' }, `Sent ${time(event.createdAt)}`),
    h('ol', { class: 'stages' },
      stage(...STAGES[0], accepted),
      stage(...STAGES[1], latestView, ...deliveryBody),
      stage(...STAGES[2], receiverView(detail?.receipt, latest))),
    timedOutButProcessed
      ? h('p', { class: 'journey-explain' }, 'The receiver processed this alert even though a try ran out of time. The sandbox could not know that, so it tried again; the receiver recognized the repeat and did not process it twice.')
      : null,
    actions,
    h('p', { class: 'journey-sub' }, '"Send an exact copy" repeats the original request, to show that it cannot create a second alert.'),
    state.detailNote,
    technicalView(event, detail)].filter(Boolean));
}

function renderSummary() {
  const container = $('summary');
  const s = state.summary;
  if (!state.token || !s) {
    container.replaceChildren(h('p', { class: 'hint' }, 'Start a session to see a summary.'));
    return;
  }
  const d = s.recentDeliveryDuration;
  container.replaceChildren(
    h('p', {}, `Alerts: ${s.events} · confirmed: ${s.byCurrentDeliveryState.delivered} · stopped: ${s.byCurrentDeliveryState.failed}`
      + ` · under way: ${s.byCurrentDeliveryState.active} · tries: ${s.attempts} · delivered again: ${s.replays}`),
    h('p', {}, `Receiver: processed ${s.receiver.processed}, recognized ${s.receiver.duplicatesRecognized} repeat(s).`),
    h('p', {}, 'Test receiver mode (API value): ', h('code', {}, state.receiver?.mode ?? 'unknown')),
    h('p', {}, h('strong', {}, 'Recent delivery time: '), d.sampleSize === 0
      ? 'no confirmed alerts yet.'
      : `median ${(d.medianMs / 1000).toFixed(1)} s, slowest ${(d.maxMs / 1000).toFixed(1)} s, over ${d.sampleSize} alert(s).`),
    h('details', { class: 'tech' }, h('summary', {}, 'How this is measured'),
      h('p', {}, `From: ${d.start}. To: ${d.end}. Population: ${d.population} Includes ${d.includes}.`),
      h('p', {}, s.notice)));
}

// --- service status (/health and /ready) -------------------------------------------

async function checkStatus() {
  const result = $('status-result');
  const button = $('check-status');
  button.disabled = true;
  result.textContent = 'Checking…';
  if (state.service.status !== 'ready') setService('checking');
  try {
    const started = performance.now();
    const health = await api('GET', '/health', { auth: false });
    const ready = await api('GET', '/ready', { auth: false });
    const ms = Math.round(performance.now() - started);
    const ok = health.status === 200 && ready.status === 200;
    setService(ok ? 'ready' : 'not_ready', ready.data.reason);
    result.replaceChildren(ok ? 'Ready.' : 'Not ready.',
      ` Process: ${health.data.status} (version ${health.data.version}, delivery worker in this process: ${health.data.inProcessWorker ? 'yes' : 'no'}). `,
      `Database: ${ready.status === 200 ? 'ready' : `unavailable (${ready.data.reason})`}. Checked in ${ms} ms.`);
  } catch (err) {
    setService(navigator.onLine === false ? 'offline' : 'unreachable', err.message);
    result.replaceChildren(unavailableBox(err));
  } finally {
    button.disabled = false;
  }
}

// --- wiring ------------------------------------------------------------------------

$('check-status').addEventListener('click', checkStatus);
for (const id of ['title', 'message']) {
  $(id).addEventListener('input', () => {
    // Re-check a field only once it is showing an error, so typing is not interrupted.
    if ($(id).getAttribute('aria-invalid') === 'true') showFieldError(id, fieldProblem(id, $(id).value));
    saveDraft();
    renderComposer();
  });
}
$('event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await sendDraft();
});

restoreDraft();
renderScenarios();
renderService();
render();
checkStatus();
restoreSession();
