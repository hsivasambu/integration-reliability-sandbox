// Minimal demo client. The session token lives only in this variable, never in storage.
let token = null;
// The key for the current submission; kept until the server gives a definite answer.
let pendingKey = null;
let lastRequest = null; // { key, body } of the most recent submission, for "send again"

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
    if (response.status === 201) lines.push('Created: stored as PENDING. Not delivered (delivery is a later stage).');
    if (response.status === 200) lines.push('Repeat of an earlier request: original event returned, nothing new stored.');
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
    textContent: `${e.payload.title} | status: ${e.status} (not delivered) | ${new Date(e.createdAt).toLocaleString()}`,
  }));
  if (items.length === 0) items.push(Object.assign(document.createElement('li'), { textContent: 'No events yet.' }));
  if (data.nextCursor) {
    items.push(Object.assign(document.createElement('li'), { textContent: '(showing newest 20)' }));
  }
  list.replaceChildren(...items);
});
