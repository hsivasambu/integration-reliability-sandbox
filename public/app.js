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
  motion: 'irs.motion',
  guide: 'irs.guide',           // the guided scenario in progress (this tab only)
  sessionTag: 'irs.sessionTag', // random tag for the current session, so a stored guide can't leak into another         // 'on' | 'off': the visitor's explicit motion choice (else the system setting)
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
  'arrow-right': ['M4 12h15', 'M14 7l5 5-5 5'],
  'arrow-left': ['M20 12H5', 'M10 7l-5 5 5 5'],
  mail: ['M3.5 6.5h17v11h-17z', 'M3.5 7l8.5 6 8.5-6'],
  gap: ['M4 12h3', 'M10.5 12h3', 'M17 12h3'],
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
  known: new Map(),        // event id -> { event, checkedAt }: every alert seen in this session (Stage 17)
  firstPageIds: new Set(), // ids on the polled first page (the rest show "status as of")
  olderCursor: null,       // the API's cursor for the next older page
  olderLoaded: false,
  loadingOlder: false,
  olderError: null,
  receipts: new Map(),     // event id -> { processed, code, repeats, at }: receipts actually read in this page
  viewNote: null,          // shown in the empty journey after "Reset view"
  selectedId: storage.get(KEYS.selected),
  detail: null,            // { eventId, deliveries, receipt, receiptState: 'ok' | 'unavailable' }
  detailController: null,  // cancels the selected alert's in-flight requests when the selection changes
  refreshController: null, // cancels an in-flight refresh when the session changes
  showLocal: false,        // the journey shows the alert being submitted (not yet confirmed by the server)
  // When data was last refreshed successfully, and whether the page is currently reconnecting.
  connection: { status: 'live', lastUpdatedAt: null },
  announced: null,         // the last journey state read out to screen readers
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
  guide: null,             // the guided scenario in progress (Stage 16), loaded after the session tag is known
  guideBusy: null,         // 'starting' | 'configuring' | 'sending' | 'restoring' | 'replaying' while requests run
  guideNote: null,         // a short message under the scenario cards
  submitNote: null,        // the result of the last send, shown under the composer
  poll: { timer: null, running: false, again: false, failures: 0, lastError: null },
  slowRequests: 0,
  service: { status: 'checking', detail: null }, // checking | ready | not_ready | unreachable | offline
};

// --- API access ----------------------------------------------------------------

class Unavailable extends Error {}
class Aborted extends Error {} // the page cancelled the request because its answer is no longer wanted

// Calls the API. Returns { status, data, headers } for any JSON answer (including 4xx/5xx).
// Throws Unavailable when no usable answer arrived (network error, non-JSON reply, 90 s timeout),
// and Aborted when the caller's `signal` cancelled it (selection or session changed).
async function api(method, path, { body, headers = {}, auth = true, signal } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel);
  const hardTimeout = setTimeout(cancel, REQUEST_TIMEOUT_MS);
  let slow = false;
  const slowTimer = setTimeout(() => { slow = true; state.slowRequests += 1; renderWakeBanner(); }, SLOW_NOTICE_MS);
  const sentToken = auth ? state.token : null;
  try {
    if (signal?.aborted) throw new Aborted();
    const response = await fetch(path, {
      method,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        ...(sentToken ? { Authorization: `Bearer ${sentToken}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    if (!isJson) throw new Unavailable(`The server answered HTTP ${response.status} without API data; it may be starting up.`);
    const data = await response.json();
    // Only a 401 for the session that is still current ends it; a late answer for an older session doesn't.
    if (response.status === 401 && sentToken && sentToken === state.token) sessionExpired();
    return { status: response.status, data, headers: response.headers };
  } catch (err) {
    if (signal?.aborted || err instanceof Aborted) throw new Aborted();
    if (err instanceof Unavailable) throw err;
    throw new Unavailable(err.name === 'AbortError'
      ? 'The server did not answer within 90 seconds.'
      : 'Could not reach the server. Check your connection.');
  } finally {
    signal?.removeEventListener('abort', cancel);
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
    const completed = await refresh();
    state.poll.failures = 0;
    state.poll.lastError = null;
    if (completed) state.connection = { status: 'live', lastUpdatedAt: Date.now() };
    // A successful refresh reached the API and its database.
    if (state.service.status !== 'ready') setService('ready');
  } catch (err) {
    if (err instanceof Aborted) {
      state.poll.again = true; // superseded (selection or session changed): fetch the current view instead
    } else {
      state.poll.failures += 1;
      state.poll.lastError = err.message;
      if (err instanceof Unavailable) setService(navigator.onLine === false ? 'offline' : 'unreachable', err.message);
      // Keep the last known state and mark it as stale. A polling failure is not a delivery failure.
      state.connection = { ...state.connection, status: 'reconnecting' };
      keepFocus($('detail'), renderDetail);
      renderGuide();          // "Waiting for the delivery service" with Reconnect
      renderScenarioCards();  // locks depend on the connection too
    }
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

// Fetches a current snapshot. Returns true when it was applied, false when its answers were discarded
// because the session changed meanwhile.
async function refresh() {
  if (!state.token) return false;
  const token = state.token;
  state.refreshController?.abort();
  const controller = new AbortController();
  state.refreshController = controller;
  const { signal } = controller;
  const [events, receiver, summary] = await Promise.all([
    api('GET', '/v1/events?limit=20', { signal }), api('GET', '/v1/receiver', { signal }), api('GET', '/v1/summary', { signal }),
  ]);
  // Answers for a session that is no longer current must never reach the screen.
  if (state.token !== token) return false;
  if (events.status !== 200 || receiver.status !== 200) {
    throw new Unavailable(`The API answered HTTP ${events.status !== 200 ? events.status : receiver.status}.`);
  }
  state.events = events.data.data;
  const checkedAt = Date.now();
  for (const e of state.events) state.known.set(e.id, { event: e, checkedAt });
  state.firstPageIds = new Set(state.events.map((e) => e.id));
  if (!state.olderLoaded) state.olderCursor = events.data.nextCursor;
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
  if (state.token !== token) return false;
  if (state.motionResync) { motion.planner.resync(); state.motionResync = false; }
  render();
  return true;
}

// Loads the selected alert's delivery history and receipt. Selecting another alert (or changing the
// session) aborts these requests, and any answer that still arrives for an older selection is ignored.
async function loadDetail(eventId) {
  state.detailController?.abort();
  const controller = new AbortController();
  state.detailController = controller;
  const token = state.token;
  const isCurrent = () => state.detailController === controller && state.selectedId === eventId && state.token === token;
  const { signal } = controller;

  const deliveriesRequest = api('GET', `/v1/events/${eventId}/deliveries`, { signal });
  // The receipt is the receiving system's record. If it can't be loaded, processing is shown as Unknown;
  // the rest of the journey still updates.
  const receiptRequest = api('GET', `/v1/receiver/receipts/${eventId}`, { signal })
    .catch((err) => { if (err instanceof Aborted) throw err; return null; });
  const [deliveries, receipt] = await Promise.all([deliveriesRequest, receiptRequest]);
  if (!isCurrent()) return;
  if (deliveries.status === 404) { selectEvent(null); return; }
  if (deliveries.status !== 200) throw new Unavailable('Could not load the alert details.');
  const receiptOk = receipt?.status === 200;
  state.detail = {
    eventId,
    deliveries: deliveries.data.deliveries,
    receipt: receiptOk ? receipt.data : null,
    receiptState: receiptOk ? 'ok' : 'unavailable',
  };
  // The detail read is the freshest status for this alert: update its history card too.
  const entry = state.known.get(eventId);
  const records = deliveries.data.deliveries.map(JourneyModel.reconcile);
  const latest = records.at(-1);
  if (entry && latest) {
    entry.event = {
      ...entry.event,
      delivery: {
        id: latest.id, replayOf: latest.replayOf, state: latest.state === 'settling' ? entry.event.delivery.state : latest.state,
        attemptCount: latest.attemptCount, maxAttempts: latest.maxAttempts, nextAttemptAt: latest.nextAttemptAt,
        failureReason: latest.failureReason, statusUrl: latest.statusUrl, replayCount: records.filter((d) => d.replayOf).length,
      },
    };
    entry.checkedAt = Date.now();
  }
  if (receiptOk) {
    const r = receipt.data;
    state.receipts.set(eventId, { processed: r.processed, code: r.result?.confirmationCode ?? null, repeats: r.duplicateCount, at: Date.now() });
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
    renderPollStatus('paused');
    motion.player.cancelAll();
    state.motionResync = true; // the next fresh data is recorded without replaying what was missed
  } else { pollNow(); keepFocus($('detail'), renderDetail); }
  syncCountdown();
});
window.addEventListener('pagehide', stopPolling);
// "Offline" is only ever shown for the visitor's own connection, never for a receiver mode.
window.addEventListener('offline', () => setService('offline'));
window.addEventListener('online', () => { checkStatus(); pollNow(); });

// --- session -------------------------------------------------------------------

function setToken(token) {
  // Requests made for the previous session are cancelled; their answers would belong to another session.
  if (token !== state.token) {
    state.refreshController?.abort();
    state.detailController?.abort();
    state.connection = { status: 'live', lastUpdatedAt: null };
  }
  if (token !== state.token) {
    resetHistory();
    storage.set(KEYS.sessionTag, token ? crypto.randomUUID() : null);
    if (state.guide) {
      state.guide = null;
      storage.set(KEYS.guide, null);
      state.guideNote = 'The guide ended because the demo session changed.';
    }
  }
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
  if (eventId !== state.selectedId) {
    state.detailController?.abort(); // the old alert's answers are no longer wanted
    motion?.player.cancelAll();      // and so are its illustrations
  }
  state.selectedId = eventId;
  storage.set(KEYS.selected, eventId);
  state.detail = null;
  state.detailNote = null;
  state.showLocal = false;
  if (eventId) state.viewNote = null;
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
    guideNoteSubmission(state.pendingSubmit.key);
    state.showLocal = true; // the journey shows the alert as 'Sending to the sandbox' until the server answers
    render();
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
  state.showLocal = true;
  render();
  try {
    await sendPending(true);
  } finally {
    state.submitting = false;
    render();
  }
}

function stopChecking() {
  setPending(null);
  state.showLocal = false;
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
  state.showLocal = false; // 202/200 switch to the server's view below; errors return to the previous view
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
  // The history store backs the journey and the cards: add the accepted alert now, not at the next refresh.
  if (!state.known.has(data.event.id)) {
    state.known.set(data.event.id, { event: data.event, checkedAt: Date.now() });
    state.firstPageIds.add(data.event.id);
  }
  selectEvent(data.eventId);
  const acceptedEffects = motion.planner.accepted(data.eventId);
  if (motionOn() && !document.hidden) motion.player.enqueue(acceptedEffects);
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
    keepFocus($('detail'), renderDetail);
    if (status === 202 || status === 200) return 'accepted';
    return data?.error === 'already_replayed' ? 'exists' : 'rejected';
  } catch (err) {
    // No answer: the stored key is kept, so asking again can't start a second retry.
    state.detailNote = unavailableBox(err);
    keepFocus($('detail'), renderDetail);
    return 'unknown';
  }
}

// --- guided scenarios (Stage 16) -----------------------------------------------------
// Uses only the existing per-session receiver modes, event submission and replay endpoints. The guide's
// progress lives in this tab (sessionStorage), tied to the current session by a local session tag; steps
// advance from what the API reports (public/guide-model.js), never from elapsed time.

const SCENARIO_ORDER = ['normal', 'recover', 'twice', 'rescue'];
const sessionTag = () => storage.get(KEYS.sessionTag);

function loadGuide() {
  const g = readJson(KEYS.guide);
  return g && g.tag && g.tag === sessionTag() && GuideModel.SCENARIOS[g.scenario] ? g : null;
}
function saveGuide(g) {
  state.guide = g;
  storage.set(KEYS.guide, g ? JSON.stringify(g) : null);
}
const guideOpen = () => Boolean(state.guide && state.guide.stage !== 'done');

// Deliveries that are still waiting or in flight anywhere in this session. /v1/summary counts all of the
// session's alerts (the history list shows only the newest 20).
function activeDeliveries() {
  const fromList = state.events.filter((e) => ACTIVE_STATES.has(e.delivery.state)).length;
  return Math.max(fromList, state.summary?.byCurrentDeliveryState.active ?? 0);
}

// Re-reads the session's active deliveries just before a receiver change. Throws if it can't be read.
async function readActiveDeliveries() {
  const res = await api('GET', '/v1/summary');
  if (res.status !== 200) throw new Unavailable(`The API answered HTTP ${res.status}.`);
  state.summary = res.data;
  return res.data.byCurrentDeliveryState.active;
}

const ACTIVE_REASON = (n) => `${n === 1 ? 'An alert in your session is' : `${n} alerts in your session are`} still being delivered. `
  + 'The receiver setting applies to the whole session, so changing it now would change how '
  + `${n === 1 ? 'that alert is' : 'those alerts are'} handled. Wait until delivery is confirmed or stopped.`;

// Why starting this scenario (or changing the receiver by hand) is not possible right now, or null.
function scenarioLock(id) {
  if (state.guideBusy) return 'Please wait: the previous step is still running.';
  if (guideOpen()) return 'Finish or leave the current guide first.';
  if (state.submitting || state.pendingSubmit) return 'An alert is still being sent. Wait until it is confirmed.';
  if (state.connection.status === 'reconnecting') return 'Waiting for the delivery service to answer.';
  const needsChange = id === 'free' || GuideModel.SCENARIOS[id]?.guided || state.receiver?.mode !== 'success';
  const active = activeDeliveries();
  if (needsChange && active > 0) return ACTIVE_REASON(active);
  return null;
}

function setGuideNote(note) {
  state.guideNote = note;
  renderScenarioCards();
}

async function startScenario(id) {
  const s = GuideModel.SCENARIOS[id];
  const lock = scenarioLock(id);
  if (lock) { setGuideNote(lock); return; }
  state.guideBusy = 'starting'; // disables every start button before anything is awaited
  setGuideNote(null);
  render();
  try {
    if (!state.token && !(await startSession())) {
      setGuideNote(`Could not start a demo session. ${state.sessionNote ?? ''} Nothing was sent.`);
      return;
    }
    // Re-read: another alert may have started since this page last refreshed (another tab, for example).
    let active;
    try {
      active = await readActiveDeliveries();
    } catch (err) {
      setGuideNote(`Could not check your alerts (${err.message}). Nothing was changed.`);
      return;
    }
    const needsChange = s.guided || state.receiver?.mode !== s.mode;
    if (needsChange && active > 0) {
      setGuideNote(ACTIVE_REASON(active));
      pollNow();
      return;
    }
    if (s.guided) saveGuide({ tag: sessionTag(), scenario: id, title: s.eventTitle, stage: 'configuring', startedAt: new Date().toISOString() });
    if (needsChange) {
      state.guideBusy = 'configuring';
      render();
      if (!(await setReceiverMode(s.mode))) {
        // The guide (if any) stays at 'configuring': it then shows a recoverable "not confirmed" step.
        if (!s.guided) setGuideNote('The receiver setting was not confirmed, so nothing was sent. You can try again.');
        return;
      }
    }
    if (s.guided) saveGuide({ ...state.guide, stage: 'sending' });
    state.guideBusy = 'sending';
    state.preset = null;
    $('title').value = s.eventTitle;
    $('message').value = s.guided ? 'Synthetic data for a guided scenario.' : 'Synthetic data for a normal delivery.';
    saveDraft();
    render();
    const eventId = await sendDraft();
    if (s.guided && eventId) saveGuide({ ...state.guide, stage: 'running', eventId });
    if (eventId) revealGuide(s.guided);
  } finally {
    state.guideBusy = null;
    render();
  }
}

// The Stage 13 send pipeline saves the Idempotency-Key before sending; the guide remembers it so the
// alert can be found again after a reload, even if the answer was lost.
function guideNoteSubmission(key) {
  if (state.guide?.stage === 'sending') saveGuide({ ...state.guide, submissionKey: key });
}

// A guide waiting for its alert finds it by its Idempotency-Key in the alert list (reading, not sending).
function guideAttachFromList() {
  const g = state.guide;
  if (g?.stage !== 'sending' || !g.submissionKey || state.pendingSubmit?.key === g.submissionKey && state.submitting) return;
  const found = state.events.find((e) => e.idempotencyKey === g.submissionKey);
  if (found) saveGuide({ ...g, stage: 'running', eventId: found.id });
}

function revealGuide(guided) {
  const target = guided ? $('guide') : $('journey');
  const box = target.getBoundingClientRect();
  if (box.top < 0 || box.top > window.innerHeight * 0.6) target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

// Restore: only PUT /v1/receiver. Nothing is sent; the next scheduled try does the delivery.
async function guideRestore() {
  if (state.guideBusy) return;
  state.guideBusy = 'restoring';
  render();
  try {
    const others = activeDeliveries() - 1;
    if (await setReceiverMode('success')) {
      saveGuide({ ...state.guide, restored: true });
      setGuideNote(others > 0 ? 'Receiver restored. Your other waiting alerts will also be delivered normally from their next try.' : null);
    } else {
      setGuideNote('The receiver could not be restored. Nothing was sent; you can try again.');
    }
  } finally {
    state.guideBusy = null;
    render();
  }
}

// Restore, then retry by hand with the existing replay endpoint. Only for a confirmed stopped delivery.
async function guideRestoreAndRetry() {
  if (state.guideBusy) return;
  state.guideBusy = 'restoring';
  render();
  try {
    if (!(await setReceiverMode('success'))) {
      setGuideNote('The receiver could not be restored, so nothing was retried. You can try again.');
      return;
    }
    saveGuide({ ...state.guide, restored: true });
    // Re-read the delivery: retry only if it is still confirmed as stopped.
    await loadDetail(state.guide.eventId);
    const v = currentJourneyView();
    if (!v?.server || v.eventId !== state.guide.eventId || v.delivery.code !== 'stopped') {
      setGuideNote('The delivery is no longer shown as stopped, so it was not retried.');
      return;
    }
    saveGuide({ ...state.guide, replay: { deliveryId: v.deliveryId, status: 'requested' } }); // saved before sending
    state.guideBusy = 'replaying';
    render();
    await guideReplay(v.deliveryId);
  } finally {
    state.guideBusy = null;
    render();
  }
}

// Sends (or re-sends, with the same stored Idempotency-Key) the replay request. Never called automatically.
async function guideReplay(deliveryId) {
  const outcome = await replayDelivery(deliveryId);
  const status = { accepted: 'confirmed', exists: 'confirmed', unknown: 'requested' }[outcome] ?? 'rejected';
  saveGuide({ ...state.guide, replay: { deliveryId, status } });
  if (status === 'rejected') setGuideNote('The retry was not accepted (see the message in the journey).');
}

async function guideCheckReplay() {
  if (state.guideBusy || !state.guide?.replay) return;
  state.guideBusy = 'replaying';
  render();
  try {
    await guideReplay(state.guide.replay.deliveryId);
  } finally {
    state.guideBusy = null;
    render();
  }
}

function guideLeave() {
  const mode = MODE_INFO[state.receiver?.mode]?.[0];
  const running = state.guide?.eventId;
  saveGuide(null);
  setGuideNote(running
    ? `You left the guide. Your alert keeps being delivered by the sandbox in the background${mode ? `, and the receiver stays set to "${mode}"` : ''}.`
    : `You left the guide.${mode ? ` The receiver is set to "${mode}".` : ''}`);
  render();
}

function guideAction(id) {
  const scenario = state.guide?.scenario;
  switch (id) {
    case 'restore': return guideRestore();
    case 'restore-retry': return guideRestoreAndRetry();
    case 'replay-check': return guideCheckReplay();
    case 'show':
      selectEvent(state.guide.eventId);
      render();
      return pollNow();
    case 'leave': return guideLeave();
    case 'close':
      saveGuide(null);
      setGuideNote(null);
      return render();
    case 'again':
    case 'retry-start':
      saveGuide(null);
      return startScenario(scenario);
    default:
      return undefined;
  }
}

function currentGuideStep() {
  const g = state.guide;
  if (!g) return null;
  const selected = Boolean(g.eventId) && state.selectedId === g.eventId && !state.showLocal;
  const result = GuideModel.guideStep(g, {
    view: selected ? currentJourneyView() : null,
    selected,
    busy: ['configuring', 'sending', 'restoring', 'replaying'].includes(state.guideBusy) ? state.guideBusy : null,
    pending: state.pendingSubmit,
    modeLabel: MODE_INFO[state.receiver?.mode]?.[0],
  });
  // Once finished, remember it: a reload shows the result without re-deriving it.
  if (result.phase === 'done' && g.stage !== 'done') saveGuide({ ...g, stage: 'done', doneText: result.text });
  return result;
}

function renderGuide() {
  guideAttachFromList();
  const panel = $('guide');
  const r = currentGuideStep();
  panel.hidden = !r;
  if (!r) return;
  const s = GuideModel.SCENARIOS[state.guide.scenario];
  panel.className = `guide card ${r.tone}`;
  $('guide-heading').replaceChildren(icon(s.icon), `Guide: ${s.title}`);
  $('guide-step').textContent = `Step ${r.step} of ${r.total}`;
  const text = r.phase === 'done' && state.guide.doneText ? state.guide.doneText : r.text;
  if ($('guide-text').textContent !== text) $('guide-text').textContent = text; // announced only when it changes
  const waiting = state.connection.status === 'reconnecting' || state.slowRequests > 0;
  $('guide-extra').replaceChildren(...[
    waiting ? h('p', { class: 'notice is-waiting' }, h('strong', {}, 'Waiting for the delivery service. '),
      'The free service may be waking up; the guide continues when it answers. ',
      h('button', { type: 'button', class: 'btn-link', 'data-focus-key': 'reconnect', onclick: () => pollNow() }, 'Reconnect now')) : null,
  ].filter(Boolean));
  keepFocus($('guide-actions'), () => $('guide-actions').replaceChildren(...r.actions.map((a) => h('button', {
    type: 'button', class: `btn ${a.primary ? 'btn-primary' : 'btn-quiet'}`, 'data-focus-key': `guide-${a.id}`,
    disabled: Boolean(state.guideBusy), onclick: () => guideAction(a.id),
  }, a.label))));
}

function renderScenarioCards() {
  const container = $('scenarios');
  keepFocus(container, () => container.replaceChildren(...SCENARIO_ORDER.map((id) => {
    const s = GuideModel.SCENARIOS[id];
    const mine = state.guide?.scenario === id && guideOpen();
    const lock = mine ? null : scenarioLock(id);
    const reasonId = `scenario-${id}-reason`;
    const button = mine
      ? h('button', { type: 'button', class: 'btn btn-quiet', 'data-focus-key': `start-${id}`, onclick: () => { revealGuide(true); $('guide').focus(); } }, 'Go to the guide')
      : h('button', {
        type: 'button', class: 'btn btn-primary', 'data-focus-key': `start-${id}`,
        disabled: Boolean(lock), 'aria-describedby': lock ? reasonId : null, onclick: () => startScenario(id),
      }, s.guided ? 'Start guide' : 'Send a normal alert');
    return h('article', { class: `card experiment${s.guided ? '' : ' is-normal'}`, 'aria-labelledby': `scenario-${id}` },
      icon(s.icon, 'exp-icon'),
      h('h3', { id: `scenario-${id}` }, s.title),
      h('p', {}, s.summary),
      h('p', { class: 'note' }, s.guided
        ? `Sets your receiver to "${MODE_INFO[s.mode][0]}" for the whole session, then sends one alert. One step at a time.`
        : 'Sets the receiver back to "Works normally" if needed, then sends one alert.'),
      h('div', { class: 'button-row' }, button),
      lock ? h('p', { class: 'hint lock-reason', id: reasonId }, lock) : null,
      mine ? h('p', { class: 'hint' }, 'In progress: the guide is shown above the journey.') : null);
  })));
  $('scenario-note').replaceChildren(...[state.guideNote ? h('p', { class: 'notice is-waiting' }, state.guideNote) : null].filter(Boolean));
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
// It also keeps the focused element where it is on screen: if this region grows or shrinks (a new alert
// above, a longer timeline), the page scrolls by the same amount, so nothing jumps under the visitor.
function keepFocus(container, renderFn) {
  const active = document.activeElement;
  const focused = active && active !== document.body && document.contains(active) ? active : null;
  const key = focused && container.contains(focused) ? focused.dataset.focusKey : null;
  const top = focused?.getBoundingClientRect().top;
  renderFn();
  let target = focused && document.contains(focused) ? focused : null;
  if (key) {
    const again = container.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
    if (again) {
      if (document.activeElement !== again) again.focus({ preventScroll: true });
      target = again;
    }
  }
  if (target && top !== undefined) {
    const shift = target.getBoundingClientRect().top - top;
    if (Math.abs(shift) >= 1) window.scrollBy(0, shift);
  }
}

function render() {
  renderSession();
  renderReceiver();
  keepFocus($('event-list'), renderEvents);
  keepFocus($('detail'), renderDetail);
  renderSummary();
  renderComposer();
  renderScenarioCards();
  renderGuide();
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
      input.addEventListener('change', () => changeModeByHand(mode));
      return h('label', { for: `mode-${mode}`, class: 'choice' }, input, h('span', {}, h('strong', {}, label), h('span', {}, description)));
    }));
  }
  const lock = state.token ? scenarioLock('free') : null;
  for (const input of container.querySelectorAll('input')) {
    input.checked = input.value === current;
    input.disabled = !state.token || Boolean(lock);
  }
  $('receiver-lock').textContent = lock ?? '';
  if (!state.token) $('receiver-status').textContent = 'Start a session to choose how the test receiver responds.';
  else if (state.receiver && !$('receiver-status').textContent) {
    $('receiver-status').textContent = `Currently: ${MODE_INFO[current]?.[0] ?? current}.`;
  }
}

// Changing the receiver by hand: re-read the session's active deliveries first.
async function changeModeByHand(mode) {
  const lock = scenarioLock('free');
  if (lock) { $('receiver-lock').textContent = lock; renderReceiver(); return; }
  try {
    const active = await readActiveDeliveries();
    if (active > 0) {
      $('receiver-lock').textContent = ACTIVE_REASON(active);
      renderReceiver(); // puts the radio back on the current mode
      pollNow();
      return;
    }
  } catch (err) {
    $('receiver-status').replaceChildren(unavailableBox(err));
    renderReceiver();
    return;
  }
  await setReceiverMode(mode);
  render();
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
      h('span', { class: 'hint receiver-hint' }, 'The scenarios below can change this.')));
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

// --- alert history (Stage 17) ----------------------------------------------------------
// Every alert this page has seen in the current session, newest first. The first page (20 newest) is
// refreshed by polling; older pages are loaded only when asked ("Load older alerts", the API's cursor).
// Alerts that slide off the first page stay listed with the time their status was last read.

const findEvent = (id) => (id ? state.known.get(id)?.event ?? null : null);

function knownEvents() {
  return [...state.known.values()].map((k) => k.event)
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : (a.id < b.id ? -1 : 1)));
}

function resetHistory() {
  state.known = new Map();
  state.firstPageIds = new Set();
  state.olderCursor = null;
  state.olderLoaded = false;
  state.loadingOlder = false;
  state.olderError = null;
  state.receipts = new Map();
}

// A bounded read of the next older page, only on request.
async function loadOlder() {
  if (state.loadingOlder || !state.olderCursor || !state.token) return;
  const token = state.token;
  const before = state.known.size;
  state.loadingOlder = true;
  state.olderError = null;
  renderHistoryMore();
  try {
    const res = await api('GET', `/v1/events?limit=20&cursor=${encodeURIComponent(state.olderCursor)}`);
    if (state.token !== token) return;
    if (res.status !== 200) { state.olderError = `The API answered HTTP ${res.status}.`; return; }
    const checkedAt = Date.now();
    for (const e of res.data.data) if (!state.firstPageIds.has(e.id)) state.known.set(e.id, { event: e, checkedAt });
    state.olderCursor = res.data.nextCursor;
    state.olderLoaded = true;
  } catch (err) {
    if (!(err instanceof Aborted)) state.olderError = err.message;
  } finally {
    state.loadingOlder = false;
    keepFocus($('event-list'), renderEvents);
    // If the button went away (no more pages), keep keyboard users in the list: focus the first newly
    // loaded card, or the last card if the page held nothing new (those alerts were already listed).
    if (document.activeElement === document.body || !document.activeElement) {
      const all = knownEvents();
      const target = all[before] ?? all.at(-1);
      if (target) $('event-list').querySelector(`[data-focus-key="event-${CSS.escape(target.id)}"]`)?.focus();
    }
  }
}

function historyCard() {
  const li = h('li', { class: 'history-entry' });
  const button = h('button', { type: 'button', class: 'btn btn-quiet hc-view' }, 'View journey');
  button.addEventListener('click', () => {
    const id = li.dataset.eventId;
    state.viewNote = null;
    selectEvent(id);
    render();
    pollNow(); // bounded reads: the alert list, the receiver summary, this alert's history and receipt
  });
  li.append(h('article', { class: 'history-card' },
    h('div', { class: 'hc-head' }, h('span', { class: 'hc-icon' }), h('h3', { class: 'hc-title' }), h('p', { class: 'hc-time' })),
    h('p', { class: 'hc-delivery' }),
    h('p', { class: 'hc-processing' }),
    h('p', { class: 'hc-asof' }),
    button));
  return li;
}

// Updates a card in place (no rebuild), so focus and scroll position are kept while statuses change.
function updateCard(li, event) {
  const status = JourneyModel.deliveryStatus(event.delivery, Date.now());
  const selected = event.id === state.selectedId && !state.showLocal;
  const titleId = `hc-title-${event.id}`;
  li.dataset.eventId = event.id;
  const card = li.firstChild;
  card.className = `history-card ${status.tone}${selected ? ' is-selected' : ''}`;
  card.setAttribute('aria-labelledby', titleId);
  const [head, delivery, processing, asof, button] = card.children;
  head.children[0].replaceChildren(icon(status.icon));
  head.children[1].id = titleId;
  if (head.children[1].textContent !== event.payload.title) head.children[1].textContent = event.payload.title;
  head.children[2].textContent = time(event.createdAt);
  const replays = event.delivery.replayCount;
  delivery.replaceChildren(h('span', { class: 'hc-label' }, 'Delivery: '), status.label,
    replays ? ` · retried by hand ${replays === 1 ? 'once' : `${replays} times`}` : '');
  // Processing is shown only when the receiver's record was actually read in this page.
  const r = state.receipts.get(event.id);
  processing.hidden = !r;
  if (r) {
    processing.replaceChildren(h('span', { class: 'hc-label' }, 'Processing: '), r.processed
      ? `processed${r.code ? ` (${r.code})` : ''}${r.repeats ? ` · ${r.repeats} repeat${r.repeats === 1 ? '' : 's'} recognized` : ''}`
      : `none recorded when checked at ${time(new Date(r.at).toISOString())}`);
  }
  const k = state.known.get(event.id);
  const stale = !state.firstPageIds.has(event.id);
  asof.hidden = !stale;
  if (stale) asof.textContent = `Status as of ${time(new Date(k.checkedAt).toISOString())}. View the journey to refresh it.`;
  button.dataset.focusKey = `event-${event.id}`;
  button.setAttribute('aria-current', selected ? 'true' : 'false');
  button.setAttribute('aria-describedby', titleId);
}

function renderEvents() {
  const list = $('event-list');
  const events = state.token ? knownEvents() : [];
  if (events.length === 0) {
    list.replaceChildren(h('li', { class: 'history-empty' }, state.token
      ? 'No alerts yet. Send one, or try a scenario below.'
      : 'Your alerts will appear here.'));
    renderHistoryMore();
    return;
  }
  const ids = new Set(events.map((e) => e.id));
  const existing = new Map();
  for (const li of [...list.children]) {
    if (li.dataset.eventId && ids.has(li.dataset.eventId)) existing.set(li.dataset.eventId, li);
    else li.remove();
  }
  let previous = null;
  for (const event of events) {
    const li = existing.get(event.id) ?? historyCard();
    updateCard(li, event);
    const expected = previous ? previous.nextSibling : list.firstChild;
    if (li !== expected) list.insertBefore(li, expected); // new cards are inserted; existing ones keep their place
    previous = li;
  }
  renderHistoryMore();
}

function renderHistoryMore() {
  const more = $('history-more');
  const parts = [];
  if (state.token && state.olderCursor) {
    parts.push(h('button', {
      type: 'button', class: 'btn btn-quiet', 'data-focus-key': 'load-older', disabled: state.loadingOlder, onclick: () => loadOlder(),
    }, state.loadingOlder ? 'Loading…' : 'Load older alerts'));
  } else if (state.token && state.olderLoaded) {
    parts.push(h('p', { class: 'hint' }, 'All your alerts are shown.'));
  }
  if (state.olderError) parts.push(h('p', { class: 'hint' }, `Could not load older alerts (${state.olderError}). You can try again.`));
  keepFocus(more, () => more.replaceChildren(...parts));
}

// "New alert": a draft action only. Nothing is sent until Send alert is pressed; an unconfirmed
// submission (if any) is kept separately.
function newAlertDraft() {
  choosePreset(0);
  $('submit-result').replaceChildren(h('p', { class: 'hint' }, 'New draft ready. Nothing is sent until you press Send alert.'));
  const composer = $('composer-heading');
  if (composer.getBoundingClientRect().top < 0) composer.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  $('title').focus();
}

// "Reset view": only clears what the journey shows.
function resetView() {
  selectEvent(null);
  state.viewNote = 'View reset. Nothing was cancelled or deleted: your alerts are still listed under Recent alerts, and any delivery in progress continues.';
  render();
  $('journey-heading').focus();
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

// --- journey (Stage 14) ------------------------------------------------------------
// The view model comes from public/journey-model.js (window.JourneyModel); this part only draws it.

const fullTime = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');

// One component of the system: Your alert, Delivery service, Receiving system.
function journeyNode(kind, name, iconName, badge, ...extra) {
  return h('div', { class: `jd-node jd-${kind}` },
    h('div', { class: 'jd-head' }, h('span', { class: 'jd-icon' }, icon(iconName)), h('p', { class: 'jd-name' }, name)),
    badge ? h('p', { class: `jd-badge ${badge.tone}` }, icon(badge.icon ?? 'dash'), badge.label) : null,
    ...extra);
}

// A labelled path between components. Arrows show direction; the words say what travels on it.
function journeyPath(kind, name, direction, view) {
  // A return arrow is drawn only when a reply actually arrived (2xx or an HTTP error reply).
  const unobserved = kind === 'ack' && !view.responseObserved;
  return h('div', { class: `jd-path jd-${kind} ${view.tone}${view.active ? ' is-current' : ''}${unobserved ? ' is-unobserved' : ''}` },
    h('span', { class: 'jd-path-name' }, name),
    h('span', { class: 'jd-line' }, icon(unobserved ? 'gap' : direction === 'back' ? 'arrow-left' : 'arrow-right', 'jd-arrow')),
    h('span', { class: 'jd-path-state' }, view.label));
}

// The wait before the next try, from the end of the last try to nextAttemptAt (both from the API).
// Decorative: the words next to it ("Next try in about N s") carry the meaning.
function waitIndicator(d) {
  if (!d.waitFrom || !d.nextAttemptAt || !['retrying', 'waiting'].includes(d.code)) return null;
  return h('div', { class: 'jd-wait', 'aria-hidden': 'true' },
    h('span', { class: 'jd-wait-fill', 'data-wait-from': d.waitFrom, 'data-wait-to': d.nextAttemptAt }));
}

function triesText(d) {
  if (d.max === undefined) return null;
  switch (d.code) {
    case 'saved': return `No tries yet (up to ${d.max})`;
    case 'sending': return `Try ${d.currentTry} of ${d.max}`;
    case 'confirmed': return `Confirmed on try ${d.triesSoFar} of ${d.max}`;
    default: return `${d.triesSoFar} of ${d.max} tries used`;
  }
}

function nextTryText(d) {
  if (d.code === 'retrying') {
    return h('span', {}, 'Next try ', h('span', { 'data-countdown-to': d.nextAttemptAt }, `in about ${d.countdownSeconds} s`),
      ` (at ${fullTime(d.nextAttemptAt)})`);
  }
  if (d.code === 'waiting' && d.nextAttemptAt) return `Next try was due at ${fullTime(d.nextAttemptAt)}; waiting for it to start`;
  return null;
}

function journeyDiagram(v, recovery) {
  const d = v.delivery;
  const p = v.processing;
  return h('div', { class: 'jd', role: 'group', 'aria-label': 'Alert journey diagram' },
    journeyNode('alert', 'Your alert', 'bell', v.alert,
      h('p', { class: 'jd-detail' }, v.title),
      v.acceptedAt ? h('p', { class: 'jd-meta' }, `Accepted ${fullTime(v.acceptedAt)}`) : h('p', { class: 'jd-meta' }, v.alert.detail)),
    h('div', { class: `jd-link jd-handover ${v.handover.tone}` },
      h('span', { class: 'jd-line' }, icon('arrow-right', 'jd-arrow')), h('span', { class: 'jd-path-state' }, v.handover.label)),
    journeyNode('delivery', 'Delivery service', 'send', d,
      triesText(d) ? h('p', { class: 'jd-meta' }, triesText(d)) : null,
      nextTryText(d) ? h('p', { class: 'jd-meta jd-next' }, nextTryText(d)) : null,
      waitIndicator(d),
      recovery),
    h('div', { class: 'jd-link jd-paths' },
      journeyPath('forward', 'Delivery try', 'forward', v.forward),
      journeyPath('ack', 'Acknowledgement', 'back', v.ack)),
    journeyNode('receiver', 'Receiving system', 'inbox', null,
      h('div', { class: `jd-card ${p.tone}` },
        h('p', { class: 'jd-card-title' }, 'Processing record'),
        h('p', { class: `jd-badge ${p.tone}` }, icon(p.icon), p.label),
        p.confirmationCode ? h('p', { class: 'jd-meta' }, `Confirmation ${p.confirmationCode}`) : null,
        p.alreadyProcessedNote ? h('p', { class: 'jd-meta jd-already' }, p.alreadyProcessedNote) : null)));
}

function journeyNow(v) {
  const d = v.delivery;
  const facts = [
    ['Delivery', d.label],
    ['Tries', triesText(d) ?? '—'],
    ['Next try', d.code === 'retrying' ? `at ${fullTime(d.nextAttemptAt)}` : d.code === 'waiting' && d.nextAttemptAt ? `was due at ${fullTime(d.nextAttemptAt)}` : '—'],
    ['Processing', v.processing.label],
  ];
  return h('div', { class: 'jd-now' },
    h('p', { class: 'jd-explain' }, v.explanation),
    h('dl', { class: 'jd-facts' }, facts.flatMap(([k, val]) => [h('dt', {}, k), h('dd', {}, val)])),
    v.ack.note ? h('p', { class: 'hint' }, h('strong', {}, `Acknowledgement: ${v.ack.label}. `), v.ack.note) : null,
    // The outcome panel already states the processing result; only an unknown record is repeated here.
    v.processing.code === 'unknown' ? h('p', { class: 'hint' }, v.processing.detail) : null);
}

function staleBanner(v) {
  if (!v.stale) return null;
  return h('p', { class: 'jd-stale', role: 'status' }, icon('offline'),
    v.stale.since
      ? `Reconnecting… Showing the last known state, from ${fullTime(v.stale.since)}`
      : 'Reconnecting… Nothing could be loaded yet.');
}

// The outcome, from evidence: what the sender's acknowledgements show, and separately what the receiver's
// record shows. Anything the data can't support is omitted.
function journeyOutcome(v) {
  if (!v.server || !v.outcome) return null;
  const o = v.outcome;
  const row = (heading, x) => h('div', { class: `jo-row ${x.tone}` },
    h('p', { class: 'jo-label' }, heading),
    h('p', { class: 'jo-value' }, h('strong', {}, x.label), ` · ${x.text}`));
  return h('section', { class: 'jo', 'aria-label': 'Outcome' },
    h('h4', {}, 'Outcome'),
    row('Delivery (acknowledgements)', o.delivery),
    o.processing ? row('Processing (receiver\'s record)', o.processing) : null,
    o.timing ? h('p', { class: 'hint' }, o.timing) : null,
    o.current ? h('p', { class: 'hint' }, o.current) : null);
}

// The stored history as a readable timeline: one group per delivery, plus the receiver's record.
function journeyTimeline(v) {
  if (!v.server) return null;
  if (!v.timeline || v.timeline.groups.length === 0) return h('p', { class: 'hint' }, 'Loading what happened so far…');
  const entry = (item) => h('li', { class: `tl-item ${item.tone}`, 'data-key': item.key, 'data-attempt-key': item.attempt ? item.key : null },
    icon(item.icon),
    h('span', { class: 'tl-text' }, item.dueAt
      ? `${item.text.replace(/\.$/, '')} (next try due at ${fullTime(item.dueAt)})`
      : item.text),
    h('span', { class: 'tl-time' }, item.at ? h('time', { datetime: item.at }, fullTime(item.at)) : 'time not recorded'));
  return h('section', { class: 'jd-history', 'aria-label': 'What happened so far' },
    h('h4', {}, 'What happened so far'),
    h('p', { class: 'hint' }, `Times come from the stored records (accepted by the sandbox at ${fullTime(v.acceptedAt)})`),
    ...v.timeline.groups.map((g) => h('div', { class: `delivery-group${g.current ? ' is-current' : ''}`, 'data-delivery-id': g.id },
      h('p', { class: 'delivery-group-name' }, g.label, ': ', h('strong', {}, v.deliveries.find((x) => x.id === g.id)?.status.label ?? ''),
        g.current && v.timeline.groups.length > 1 ? ' (current)' : ''),
      h('ol', { class: 'timeline' }, g.items.map(entry)))),
    h('div', { class: 'delivery-group receiver-group' },
      h('p', { class: 'delivery-group-name' }, 'Receiving system\'s record'),
      h('ol', { class: 'timeline' }, v.timeline.receiver.map(entry))));
}

// Technical lines kept from the earlier UI, shown only in the technical view.
function attemptLine(a) {
  const parts = [`Attempt ${a.attemptNumber}: ${a.outcome}`];
  parts.push(a.responseStatus ? `HTTP ${a.responseStatus}` : 'no HTTP response');
  if (a.errorCategory) parts.push(a.errorCategory);
  if (a.retryable !== null) parts.push(`retryable: ${a.retryable}`);
  if (a.durationMs !== null) parts.push(`${a.durationMs} ms`);
  parts.push(`started ${a.startedAt}`);
  parts.push(a.endedAt ? `ended ${a.endedAt}` : 'no end time recorded');
  return parts.join(' · ');
}

// Technical details: permitted request data, statuses, non-secret IDs and timestamps, with plain
// definitions. The demo token and server secrets are never part of any of this.
function technicalView(event, detail) {
  const term = (name, definition, ...value) => [h('dt', {}, name), h('dd', {}, h('span', { class: 'def' }, definition), ...value)];
  const request = [
    'POST /v1/events',
    'Content-Type: application/json',
    'Authorization: Bearer <your demo token, never shown>',
    `Idempotency-Key: ${event.idempotencyKey}`,
    '',
    JSON.stringify({ type: event.type, payload: event.payload }, null, 2),
  ].join('\n');
  const details = h('details', { class: 'tech', open: state.techOpen },
    h('summary', { 'data-focus-key': 'tech' }, 'Technical details: request, status codes, IDs and timestamps'),
    h('h5', {}, 'The request that created this alert'),
    h('pre', {}, request),
    h('p', {}, 'Response: HTTP 202 Accepted (saved and queued, not yet delivered). Sending exactly the same request again returns HTTP 200 with this same alert.'),
    h('h5', {}, 'Identifiers and times'),
    h('dl', { class: 'tech-terms' },
      ...term('Event ID', 'identifies this alert in the sandbox.', h('code', {}, event.id)),
      ...term('Idempotency-Key', 'a label sent with the request, so a repeat of the same request is recognized instead of creating a second alert.', h('code', {}, event.idempotencyKey)),
      ...term('Accepted at', 'when the sandbox saved the alert.', h('code', {}, event.createdAt)),
      ...term('Status URL', 'where the delivery history can be read.', h('code', {}, event.delivery.statusUrl))),
    ...(detail?.deliveries ?? []).map((d) => h('div', { class: 'tech-delivery' },
      h('p', {}, h('strong', {}, d.replayOf ? 'Retry by hand (replay) ' : 'Original delivery '), h('code', {}, d.id)),
      h('p', { class: 'def' }, d.replayOf
        ? `A delivery is one series of attempts. This one was started by hand after delivery ${d.replayOf.slice(0, 8)}… stopped.`
        : 'A delivery is one series of attempts to send the alert, with its own attempt allowance.'),
      h('p', {}, `State ${d.state}${d.failureReason ? `, reason ${d.failureReason}` : ''} · created ${d.createdAt}${d.completedAt ? ` · finished ${d.completedAt}` : ''}`),
      h('ul', { class: 'tech-list' }, d.attempts.map((a) => h('li', {}, attemptLine(a)))))),
    detail
      ? h('div', { class: 'tech-delivery' },
        h('p', {}, h('strong', {}, 'Receiver receipt')),
        h('p', { class: 'def' }, 'The receiving system\'s own record of what it processed (a receipt), separate from what the sender saw.'),
        h('p', {}, detail.receiptState === 'ok'
          ? `processed ${detail.receipt.processed}${detail.receipt.result ? `, confirmation ${detail.receipt.result.confirmationCode}` : ''}, deliveries received ${detail.receipt.deliveriesReceived}, repeats recognized ${detail.receipt.duplicateCount}${detail.receipt.firstReceivedAt ? `, first ${detail.receipt.firstReceivedAt}` : ''}${detail.receipt.lastReceivedAt ? `, latest ${detail.receipt.lastReceivedAt}` : ''}`
          : 'could not be loaded (shown as Unknown)'))
      : null,
    h('h5', {}, 'Two different protections against duplicates'),
    h('ul', { class: 'tech-list' },
      h('li', {}, h('strong', {}, 'Submission idempotency'), ' (sender side): the Idempotency-Key makes a repeated request return the same alert, so retrying a send can never create a second alert.'),
      h('li', {}, h('strong', {}, 'Receiver duplicate protection'), ' (receiving side): the receiving system remembers each alert\'s Event ID, so when the same alert is delivered again (after a timeout or a retry) it recognizes it and does not process it twice.')),
    h('h5', {}, 'Raw API data'),
    h('pre', {}, JSON.stringify({ event, deliveries: detail?.deliveries ?? null, receipt: detail?.receipt ?? null }, null, 2)));
  details.addEventListener('toggle', () => { state.techOpen = details.open; });
  return details;
}

// The view model for whatever the journey should show now, or null for the empty state.
function currentJourneyView() {
  const stale = state.connection.status === 'reconnecting'
    ? { since: state.connection.lastUpdatedAt ? new Date(state.connection.lastUpdatedAt).toISOString() : null }
    : null;
  const pending = state.pendingSubmit;
  if (state.showLocal && pending) {
    return JourneyModel.toJourneyView({
      local: { status: pending.status === 'uncertain' ? 'uncertain' : 'sending', title: pending.body.payload.title },
      now: Date.now(),
      stale: null, // the local state is the browser's own; staleness applies to server data
    });
  }
  const event = state.token ? findEvent(state.selectedId) : null;
  if (!event) return null;
  const detail = state.detail?.eventId === event.id ? state.detail : null;
  return JourneyModel.toJourneyView({
    event,
    deliveries: detail?.deliveries ?? null,
    receipt: detail?.receipt ?? null,
    receiptState: detail ? detail.receiptState : 'loading',
    now: Date.now(),
    stale,
  });
}

const EMPTY_STEPS = [
  ['Your alert', 'bell', 'What you send.'],
  ['Delivery service', 'send', 'Saves your alert, sends it, and tries again if needed.'],
  ['Receiving system', 'inbox', 'A test system inside this sandbox that confirms and processes alerts.'],
];

function renderDetail() {
  const container = $('detail');
  const v = currentJourneyView();
  if (!v) {
    container.replaceChildren(h('div', { class: 'journey-empty' },
      state.viewNote ? h('p', { class: 'notice is-idle' }, state.viewNote) : null,
      h('p', {}, !state.token
        ? 'Send an alert to see its journey here, step by step.'
        : state.known.size ? 'Choose View journey on any alert under Recent alerts.' : 'Send an alert to see its journey here.'),
      h('ul', { class: 'jd-legend' }, EMPTY_STEPS.map(([name, iconName, text]) =>
        h('li', {}, icon(iconName), h('span', {}, h('strong', {}, name), ` · ${text}`))))));
    announce(null);
    syncCountdown();
    motion.player.cancelAll();
    return;
  }

  const event = v.server ? findEvent(v.eventId) : null;
  const detail = event && state.detail?.eventId === event.id ? state.detail : null;
  const canReplay = v.server && v.delivery.code === 'stopped' && detail;
  const recovery = canReplay
    ? h('button', { type: 'button', class: 'btn btn-primary jd-recover', 'data-focus-key': 'replay', onclick: () => replayDelivery(v.deliveryId) },
      icon('replay'), 'Deliver again')
    : null;
  const actions = v.server
    ? h('div', { class: 'journey-actions' },
      h('button', { type: 'button', class: 'btn', 'data-focus-key': 'duplicate', onclick: () => submitDuplicate(event) },
        'Send an exact copy'),
      h('button', { type: 'button', class: 'btn btn-quiet', 'data-focus-key': 'reset-view', onclick: () => resetView() }, 'Reset view'))
    : null;

  // replaceChildren() would print null as text, so empty parts are filtered out.
  container.replaceChildren(...[
    staleBanner(v),
    h('h3', { class: 'journey-title' }, v.title),
    h('p', { class: 'journey-sub' }, v.server
      ? (v.stale ? 'Last known state' : `Updated ${fullTime(new Date(state.connection.lastUpdatedAt ?? Date.now()).toISOString())}`)
      : 'Not confirmed by the sandbox yet'),
    journeyDiagram(v, recovery),
    journeyOutcome(v),
    journeyNow(v),
    journeyTimeline(v),
    actions,
    v.server ? h('p', { class: 'journey-sub' }, '"Send an exact copy" repeats the original request, to show that it cannot create a second alert.') : null,
    v.server ? state.detailNote : null,
    event ? technicalView(event, detail) : null].filter(Boolean));
  announce(v);
  syncCountdown();
  startWaitIndicators();
  // Motion is planned from what changed, after the true state is already on screen. It never holds
  // anything back and is skipped entirely when motion is off or the tab is hidden.
  const effects = motion.planner.observe(v);
  if (motionOn() && !document.hidden) motion.player.enqueue(effects);
}

// Screen readers hear a short sentence only when the delivery or processing state actually changes,
// not on every refresh.
function announce(v) {
  const text = v ? `${v.title}: delivery ${v.delivery.label}. Processing ${v.processing.label}.` : null;
  if (text === state.announced) return;
  const first = state.announced === null;
  state.announced = text;
  if (text && !first) $('journey-announce').textContent = text;
}

// Updates "in about N s" once a second while a retry is scheduled. When it reaches zero, the journey is
// redrawn from the last data, which then says "waiting for the next attempt" until the API reports a try.
let countdownTimer = null;
function syncCountdown() {
  const needed = !document.hidden && document.querySelector('[data-countdown-to]');
  if (needed && !countdownTimer) countdownTimer = setInterval(tickCountdown, 1000);
  if (!needed && countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}
function tickCountdown() {
  let reachedZero = false;
  for (const el of document.querySelectorAll('[data-countdown-to]')) {
    const seconds = Math.ceil((Date.parse(el.dataset.countdownTo) - Date.now()) / 1000);
    if (seconds <= 0) reachedZero = true;
    else el.textContent = `in about ${seconds} s`;
  }
  if (reachedZero) keepFocus($('detail'), renderDetail);
  else { if (!motionOn()) startWaitIndicators(); syncCountdown(); }
}

// --- motion (Stage 15) ---------------------------------------------------------------
// Illustrations only (public/journey-motion.js). The state text above is always current on its own.

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
// The visitor's explicit choice wins; otherwise follow the system's reduced-motion setting.
const motionOn = () => (storage.get(KEYS.motion) ?? (motionQuery.matches ? 'off' : 'on')) === 'on';

const motion = {
  planner: JourneyMotion.createPlanner(),
  player: JourneyMotion.createPlayer($('journey-motion'), { getGeometry: journeyGeometry, label: { icon } }),
};

// Points (relative to the motion layer) taken from the current layout each time an effect starts, so the
// paths follow the stacked (phone) or row (desktop) layout.
function journeyGeometry() {
  const layer = $('journey-motion').getBoundingClientRect();
  const box = (sel) => $('detail').querySelector(sel)?.getBoundingClientRect();
  const del = box('.jd-delivery');
  const rec = box('.jd-receiver');
  const fwd = box('.jd-forward .jd-line');
  const ack = box('.jd-ack .jd-line');
  const diagram = box('.jd');
  if (!del || !rec || !fwd || !ack || !diagram || layer.width === 0) return null;
  const pt = (x, y) => ({ x: x - layer.left, y: y - layer.top });
  const mid = (r) => pt(r.left + r.width / 2, r.top + r.height / 2);
  const card = box('.jd-receiver .jd-card') ?? rec;
  const row = rec.left >= del.right - 1;
  const inset = 14; // stop short of the node edges so moving labels don't cover the node headings
  // Stacked layout: forward packets travel down the left of the path labels, replies up the right.
  const side = row ? 0 : Math.min(100, (rec.width / 2) - 40);
  const f = { ...mid(fwd), x: mid(fwd).x - side };
  const a = { ...mid(ack), x: mid(ack).x + side };
  return {
    alert: mid(box('.jd-alert')),
    receiver: mid(card),
    forwardMid: f,
    ackMid: a,
    top: pt(diagram.right - 120, diagram.top - 14), // right-hand side, clear of the 'Updated' line
    forwardFrom: row ? pt(del.right + inset, f.y + layer.top) : pt(f.x + layer.left, del.bottom + inset),
    forwardTo: row ? pt(rec.left - inset, f.y + layer.top) : pt(f.x + layer.left, rec.top - inset),
    ackFrom: row ? pt(rec.left - inset, a.y + layer.top) : pt(a.x + layer.left, rec.top - inset),
    ackTo: row ? pt(del.right + inset, a.y + layer.top) : pt(a.x + layer.left, del.bottom + inset),
  };
}

// The retry wait fills from the end of the last try to nextAttemptAt. With motion on it moves smoothly;
// with motion off it is redrawn once a second. Either way it stops (full) at the scheduled time.
function startWaitIndicators() {
  for (const fill of $('detail').querySelectorAll('.jd-wait-fill')) {
    const from = Date.parse(fill.dataset.waitFrom);
    const to = Date.parse(fill.dataset.waitTo);
    const now = Date.now();
    const fraction = to > from ? Math.min(1, Math.max(0, (now - from) / (to - from))) : 1;
    fill.getAnimations().forEach((a) => a.cancel());
    if (motionOn() && !document.hidden && fraction < 1) {
      fill.animate([{ transform: `scaleX(${fraction})` }, { transform: 'scaleX(1)' }], { duration: to - now, fill: 'forwards', easing: 'linear' });
    } else {
      fill.style.transform = `scaleX(${fraction})`;
    }
  }
}

function renderMotionToggle() {
  const on = motionOn();
  const button = $('motion-toggle');
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
  button.textContent = on ? 'Motion: on' : 'Motion: off';
}

$('motion-toggle').addEventListener('click', () => {
  storage.set(KEYS.motion, motionOn() ? 'off' : 'on');
  if (!motionOn()) motion.player.cancelAll(); // stop at once; the state text is unaffected
  renderMotionToggle();
  startWaitIndicators();
});
motionQuery.addEventListener('change', () => {
  if (!motionOn()) motion.player.cancelAll();
  renderMotionToggle();
});
// Illustrations follow paths measured when they start. If the journey's width changes mid-flight (window
// resized, layout switching between row and stacked), they are dropped; the state text stays. Height
// changes from routine refreshes or a node gaining a line don't cancel anything.
let journeyWidth = null;
new ResizeObserver(([entry]) => {
  const width = Math.round(entry.contentRect.width);
  if (journeyWidth !== null && width !== journeyWidth) motion.player.cancelAll();
  journeyWidth = width;
}).observe($('journey'));

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
$('new-alert').addEventListener('click', newAlertDraft);
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
state.showLocal = Boolean(state.pendingSubmit); // an unconfirmed alert from before the reload
if (state.token && !sessionTag()) storage.set(KEYS.sessionTag, crypto.randomUUID());
state.guide = loadGuide();
renderMotionToggle();
renderService();
render();
checkStatus();
restoreSession();
