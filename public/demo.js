// Minimal demo client. The session token lives only in this variable, never in storage.
let token = null;
// The key for the current submission; kept until the server gives a definite answer.
let pendingKey = null;
let lastRequest = null; // { key, body } of the most recent submission, for "send again"
let lastStatusUrl = null; // delivery status URL of the most recent accepted event
let lastDeliveryId = null; // latest delivery of that event (set by "Check delivery")
let replayKey = null; // Idempotency-Key for the replay request in progress

const $ = (id) => document.getElementById(id);

async function api(method, path, { body, headers = {} } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

$('start-session').addEventListener('click', async () => {
  $('session-status').textContent = 'Creating...';
  try {
    const { response, data } = await api('POST', '/v1/sessions');
    if (response.status !== 201) {
      $('session-status').textContent = `HTTP ${response.status}: ${data?.message ?? 'error'}`;
      return;
    }
    token = data.token;
    $('session-status').textContent = `Session active until ${new Date(data.expiresAt).toLocaleString()}.`;
    $('event-list').replaceChildren();
  } catch (err) {
    $('session-status').textContent = `Could not reach the server: ${err.message}`;
  }
});

async function send(key, body) {
  $('event-result').textContent = 'Submitting...';
  lastRequest = { key, body };
  try {
    const { response, data } = await api('POST', '/v1/events', { body, headers: { 'Idempotency-Key': key } });
    // Any answer from the server is final for this key; only network failures keep it for retry.
    pendingKey = null;
    $('idem-key').textContent = key;
    const lines = [`HTTP ${response.status}`];
    if (response.status === 202) lines.push('Accepted: stored and queued for delivery. Not delivered yet. Click "Check delivery".');
    if (response.status === 200) lines.push('Repeat of an earlier request: original event returned, nothing new stored.');
    if (data?.statusUrl) lastStatusUrl = data.statusUrl;
    lines.push(JSON.stringify(data, null, 2));
    $('event-result').textContent = lines.join('\n');
  } catch (err) {
    $('event-result').textContent = `Network error: ${err.message}\nSubmit again to retry with the same Idempotency-Key.`;
  }
}

$('event-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!token) {
    $('event-result').textContent = 'Start a demo session first.';
    return;
  }
  pendingKey ??= crypto.randomUUID();
  $('idem-key').textContent = pendingKey;
  send(pendingKey, {
    type: 'demo.notification',
    payload: { title: $('title').value, message: $('message').value },
  });
});

$('resubmit').addEventListener('click', () => {
  if (!lastRequest) {
    $('event-result').textContent = 'Submit an event first.';
    return;
  }
  send(lastRequest.key, lastRequest.body);
});

$('refresh').addEventListener('click', async () => {
  const list = $('event-list');
  if (!token) {
    list.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Start a demo session first.' }));
    return;
  }
  const { response, data } = await api('GET', '/v1/events?limit=20');
  if (response.status !== 200) {
    list.replaceChildren(Object.assign(document.createElement('li'),
      { textContent: `HTTP ${response.status}: ${data?.message ?? 'error'}` }));
    return;
  }
  const items = data.data.map((e) => Object.assign(document.createElement('li'), {
    textContent: `${e.payload.title} | delivery: ${e.delivery.state} (${e.delivery.attemptCount} attempt(s)) | ${new Date(e.createdAt).toLocaleString()}`,
  }));
  if (items.length === 0) items.push(Object.assign(document.createElement('li'), { textContent: 'No events yet.' }));
  if (data.nextCursor) {
    items.push(Object.assign(document.createElement('li'), { textContent: '(showing newest 20)' }));
  }
  list.replaceChildren(...items);
});

function showReceiver(response, data) {
  $('receiver-status').textContent = response.status === 200
    ? `Mode: ${data.mode}\nEvents processed by the receiver: ${data.processedCount}\n`
      + `Duplicate deliveries recognized (not re-processed): ${data.duplicateCount}\n${data.notice}`
    : `HTTP ${response.status}: ${data?.message ?? 'error'}`;
  if (response.status === 200) $('receiver-mode').value = data.mode;
}

$('load-mode').addEventListener('click', async () => {
  if (!token) return void ($('receiver-status').textContent = 'Start a demo session first.');
  const { response, data } = await api('GET', '/v1/receiver');
  showReceiver(response, data);
});

$('save-mode').addEventListener('click', async () => {
  if (!token) return void ($('receiver-status').textContent = 'Start a demo session first.');
  const { response, data } = await api('PUT', '/v1/receiver', { body: { mode: $('receiver-mode').value } });
  showReceiver(response, data);
});

$('check-delivery').addEventListener('click', async () => {
  if (!lastStatusUrl) return void ($('event-result').textContent = 'Submit an event first.');
  const { response, data } = await api('GET', lastStatusUrl);
  if (response.status !== 200) {
    $('event-result').textContent = `HTTP ${response.status}: ${data?.message ?? 'error'}`;
    return;
  }
  const lines = [];
  // The original delivery first, then any replays, each with its own attempts.
  data.deliveries.forEach((delivery, index) => {
    lines.push(`${index === 0 ? 'Original delivery' : `Replay ${index}`}: ${delivery.state} `
      + `(attempt ${delivery.attemptCount} of ${delivery.maxAttempts})`);
    if (delivery.state === 'pending') lines.push('  Waiting for the worker to pick it up.');
    if (delivery.nextAttemptAt && delivery.state === 'retry_scheduled') {
      lines.push(`  Next retry at ${new Date(delivery.nextAttemptAt).toLocaleTimeString()}`);
    }
    if (delivery.failureReason) lines.push(`  Failed permanently: ${delivery.failureReason}`);
    for (const a of delivery.attempts) {
      lines.push(`  Attempt ${a.attemptNumber}: ${a.outcome}`
        + (a.responseStatus ? ` | HTTP ${a.responseStatus}` : '')
        + (a.errorCategory ? ` | ${a.errorCategory}` : '')
        + (a.retryable === true ? ' | retryable' : a.retryable === false ? ' | not retryable' : '')
        + (a.durationMs !== null ? ` | ${a.durationMs} ms` : ''));
    }
  });
  lastDeliveryId = data.delivery.id;
  if (data.delivery.state === 'failed') lines.push('', 'This delivery failed permanently; you can replay it.');
  // The receiver's side of the story, which the sender cannot see directly.
  const eventId = lastStatusUrl.split('/')[3];
  const receipt = await api('GET', `/v1/receiver/receipts/${eventId}`);
  if (receipt.response.status === 200) {
    const r = receipt.data;
    lines.push('', 'Receiver view:', r.processed
      ? `  processed once (${r.result.confirmationCode}); deliveries received: ${r.deliveriesReceived}, duplicates: ${r.duplicateCount}`
      : '  not processed');
  }
  $('event-result').textContent = lines.join('\n');
});

// Replays the latest delivery of the last event. The key is kept until the server answers,
// so a retried click after a network error cannot schedule a second replay.
$('replay').addEventListener('click', async () => {
  if (!lastDeliveryId) return void ($('event-result').textContent = 'Click "Check delivery" first.');
  replayKey ??= crypto.randomUUID();
  try {
    const { response, data } = await api('POST', `/v1/deliveries/${lastDeliveryId}/replay`,
      { headers: { 'Idempotency-Key': replayKey } });
    replayKey = null;
    $('event-result').textContent = response.status === 202 || response.status === 200
      ? `HTTP ${response.status}: ${data.notice}\nNew delivery: ${data.delivery.state}. Click "Check delivery" to follow it.`
      : `HTTP ${response.status}: ${data?.message ?? 'error'}`;
  } catch (err) {
    $('event-result').textContent = `Network error: ${err.message}. Click Replay again to retry safely.`;
  }
});
