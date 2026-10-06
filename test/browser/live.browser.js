// End-to-end browser checks against a real running server: the real API, worker, receiver and database.
// Nothing is mocked. Point BASE_URL at a local server (npm run dev with WORKER_ENABLED=true) or the deployed one.
//
//   BASE_URL=http://127.0.0.1:3000 npm run test:live
//   SCREENSHOT_DIR=shots BASE_URL=... npm run test:live         (also saves desktop and mobile screenshots)
//
// The main tests share one demo session and run in order (guided scenarios lock while deliveries are active, and
// demo sessions are rate limited per IP). Two checks need a server started for them:
//   - paused worker: a server with WORKER_ENABLED=false (the suite reads /health and runs only that check)
//   - quota: set LIVE_EVENT_LIMIT to the server's MAX_EVENTS_PER_SESSION (use a small value, e.g. 2)
// A run creates 2 demo sessions (3 with the quota check) and about 8 synthetic alerts.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { noBrowser, launch, sleep, screenshot, helpers, recordMotion, motionPlays } = require('./harness');

const BASE = process.env.BASE_URL?.replace(/\/$/, '');
const EVENT_LIMIT = Number(process.env.LIVE_EVENT_LIMIT) || null;
let health = null;
let browser;
let main; // the shared session: { page, t, log }

before(async () => {
  if (noBrowser || !BASE) return;
  health = await (await fetch(`${BASE}/health`)).json();
  browser = await launch();
});
after(async () => { await browser?.close(); });

const skipAll = noBrowser || (BASE ? false : 'BASE_URL is not set');
// node:test reads `skip` before `before` has read /health, so tests that need the worker check at their start.
// (`skip` must be false or a reason: node:test treats null as a skip and then hides the test's failures.)
const workerOr = (t) => { if (health && !health.inProcessWorker) { t.skip('this server has no delivery worker'); return false; } return true; };

async function openPage({ width = 1440, height = 1000, motion = true, setup } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height });
  const log = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/v1/')) log.push({ method: r.method(), path: u.pathname + u.search, at: Date.now() });
  });
  if (motion) await recordMotion(page);
  if (setup) await setup(page);
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0', timeout: 120000 });
  const t = helpers(page);
  await t.waitText('#service-status', /Service ready/, 120000);
  return { context, page, t, log };
}

// The session's alerts, read through the page's own session (the token never leaves the page).
const listEvents = (page) => page.evaluate(async () => {
  const token = sessionStorage.getItem('irs.token');
  const res = await fetch('/v1/events?limit=50', { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()).data.map((e) => ({ id: e.id, title: e.payload.title, state: e.delivery.state }));
});
const receipt = (page, id) => page.evaluate(async (eventId) => {
  const token = sessionStorage.getItem('irs.token');
  return (await fetch(`/v1/receiver/receipts/${eventId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
}, id);
const setMode = (page, mode) => page.evaluate(async (m) => {
  const token = sessionStorage.getItem('irs.token');
  return (await fetch('/v1/receiver', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: m }) })).status;
}, mode);
// Scenarios are locked while any alert in the session is still being delivered: wait until this one can start.
async function startGuide(page, id) {
  await helpers(page).waitFor(`the "${id}" scenario to be available`,
    (s) => document.getElementById(`scenario-${s}`)?.closest('article').querySelector('button')?.disabled === false, id, 90000);
  await page.evaluate((s) => document.getElementById(`scenario-${s}`).closest('article').querySelector('button').click(), id);
}

// Desktop and phone screenshots of the same moment (only when SCREENSHOT_DIR is set).
async function shots(page, name) {
  if (!process.env.SCREENSHOT_DIR) return;
  await screenshot(page, `live-${name}-1440`);
  await screenshot(page, `live-${name}-1440-journey`, { element: '#journey' });
  await page.setViewport({ width: 390, height: 844 });
  await sleep(500);
  await screenshot(page, `live-${name}-390`);
  await screenshot(page, `live-${name}-390-journey`, { element: '#journey' });
  await page.setViewport({ width: 1440, height: 1000 });
  await sleep(300);
}

test('first visit, sample choice and a normal send: confirmed and processed once', { skip: skipAll, timeout: 180000 }, async (tc) => {
  if (!workerOr(tc)) return;
  main = await openPage();
  const { page, t, log } = main;
  assert.equal(await page.evaluate(() => sessionStorage.getItem('irs.token')), null, 'no session before the visitor acts');
  assert.equal(log.filter((r) => r.method === 'POST').length, 0, 'loading the page sends nothing');
  await screenshot(page, 'live-first-visit-1440');
  await page.click('#preset-equipment');
  assert.equal(await page.$eval('#title', (i) => i.value), 'Equipment notification');
  await page.click('#submit-event');
  await t.waitText('#detail .jd-delivery .jd-badge', /Confirmed/, 30000);
  await t.waitText('#detail .jd-card', /Processed/, 15000);
  assert.match(await t.text('#detail .jo'), /Delivery confirmed/);
  assert.equal(log.filter((r) => r.method === 'POST' && r.path === '/v1/sessions').length, 1);
  await shots(page, 'confirmed');
});

test('double click: exactly one new alert', { skip: skipAll, timeout: 120000 }, async (tc) => {
  if (!workerOr(tc)) return;
  const { page, t } = main;
  const before = (await listEvents(page)).length;
  await page.click('#preset-team');
  await t.doubleClick('#submit-event');
  await t.waitFor('the new alert', () => /Team update/.test(document.querySelector('#detail .journey-title')?.textContent ?? ''), null, 30000);
  await sleep(2000);
  assert.equal((await listEvents(page)).length, before + 1, 'one alert for one double click');
  await t.waitText('#detail .jd-delivery .jd-badge', /Confirmed/, 30000);
});

test('temporary failure, then the scheduled retry recovers (with a connection drop on the way)', { skip: skipAll, timeout: 180000 }, async (tc) => {
  if (!workerOr(tc)) return;
  const { page, t, log } = main;
  await startGuide(page, 'recover');
  await t.waitText('#guide', /first try was rejected/, 45000);
  await shots(page, 'retry-scheduled');
  // The network drops while the retry is waiting: last known state, clearly marked; nothing changes state.
  await page.setOfflineMode(true);
  await t.waitText('#detail', /Reconnecting/, 30000);
  assert.match(await t.deliveryBadge(), /Trying again|Waiting/);
  await shots(page, 'offline-stale');
  await page.setOfflineMode(false);
  await t.waitFor('the connection to come back', () => !/Reconnecting/.test(document.getElementById('detail').textContent), null, 30000);
  const puts = log.filter((r) => r.method === 'PUT').length;
  await t.clickButton('#guide', 'Restore receiver');
  await t.waitText('#guide', /Delivered on try \d/, 60000);
  assert.equal(log.filter((r) => r.method === 'PUT').length, puts + 1, 'Restore changed the mode once and sent nothing');
  assert.match(await t.text('#detail .jo'), /Retried successfully/);
  await shots(page, 'retried-successfully');
  await t.clickButton('#guide', 'Close guide');
});

test('processing before a timeout: one receiver result, the repeat recognized', { skip: skipAll, timeout: 180000 }, async (tc) => {
  if (!workerOr(tc)) return;
  const { page, t } = main;
  await startGuide(page, 'twice');
  await t.waitText('#guide', /One processing result \(RCPT-[0-9A-F]+\)\. The repeat was recognized/, 90000);
  const id = (await listEvents(page))[0].id;
  const r = await receipt(page, id);
  assert.equal(r.processed, true);
  assert.ok(r.duplicateCount >= 1, 'at least one repeat delivery was recognized');
  assert.match(r.result.confirmationCode, /^RCPT-/);
  assert.match(await t.text('#detail .jd-card'), /Already processed: \d+ repeats? recognized/);
  await shots(page, 'processed-once');
  await t.clickButton('#guide', 'Close guide');
});

test('retries exhausted, then one manual replay is confirmed', { skip: skipAll, timeout: 240000 }, async (tc) => {
  if (!workerOr(tc)) return;
  const { page, t, log } = main;
  await startGuide(page, 'rescue');
  await t.waitText('#guide', /Delivery stopped: every automatic try failed/, 120000);
  assert.match(await t.deliveryBadge(), /Stopped/);
  assert.match(await t.text('#guide-cue'), /Your turn Press Restore and retry/, 'the guide says which button to press');
  await shots(page, 'stopped');
  const replaysBefore = log.filter((r) => r.method === 'POST' && /\/replay$/.test(r.path)).length;
  await t.clickButton('#guide', 'Restore and retry');
  await t.waitText('#guide', /new delivery was confirmed/, 60000);
  assert.equal(log.filter((r) => r.method === 'POST' && /\/replay$/.test(r.path)).length, replaysBefore + 1, 'one replay request');
  assert.match(await t.text('#detail .jd-history'), /Original delivery: Stopped[\s\S]*Delivered again \(1\): Confirmed/);
  await shots(page, 'replayed');
  await t.clickButton('#guide', 'Close guide');
  assert.equal(await setMode(page, 'success'), 200);
});

test('refresh restores the selection without replaying; choosing another alert switches cleanly', { skip: skipAll, timeout: 120000 }, async (tc) => {
  if (!workerOr(tc)) return;
  const { page, t } = main;
  const events = await listEvents(page);
  const target = events.find((e) => e.title === 'Equipment notification');
  await page.evaluate((title) => [...document.querySelectorAll('#event-list li')]
    .find((li) => li.querySelector('.hc-title').textContent === title).querySelector('.hc-view').click(), target.title);
  await t.waitText('#detail .journey-title', /Equipment notification/);
  await page.reload({ waitUntil: 'networkidle0' });
  await t.waitText('#detail .journey-title', /Equipment notification/, 30000);
  await t.waitText('#detail .jd-delivery .jd-badge', /Confirmed/, 15000);
  await sleep(2500);
  assert.deepEqual(await motionPlays(page), [], 'a refresh replays nothing');
  await page.evaluate(() => [...document.querySelectorAll('#event-list li')]
    .find((li) => li.querySelector('.hc-title').textContent === 'Team update').querySelector('.hc-view').click());
  await t.waitText('#detail .journey-title', /Team update/);
  await main.context.close();
});

test('reduced motion: no illustrations, and the journey still completes', { skip: skipAll, timeout: 120000 }, async (tc) => {
  if (!workerOr(tc)) return;
  const { context, page, t } = await openPage({ setup: (p) => p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]) });
  assert.match(await t.text('#motion-toggle'), /system setting/);
  await page.click('#submit-event');
  await t.waitText('#detail .jd-delivery .jd-badge', /Confirmed/, 30000);
  await sleep(1000);
  assert.deepEqual(await motionPlays(page), []);
  await context.close();
});

test('an expired or unknown session: the real API answers 401, the page says so and starts nothing', { skip: skipAll, timeout: 120000 }, async () => {
  const { context, page, t, log } = await openPage({ motion: false,
    setup: (p) => p.evaluateOnNewDocument(() => { if (!sessionStorage.getItem('irs.token')) sessionStorage.setItem('irs.token', `expired-${'0'.repeat(40)}`); }) });
  await t.waitText('#session-area', /Your demo session has ended or is no longer valid/, 30000);
  await sleep(3000);
  assert.equal(log.filter((r) => r.method === 'POST').length, 0, 'no session or alert is created by itself');
  await context.close();
});

test('quota: the session limit is explained and nothing is retried', { skip: skipAll || (!EVENT_LIMIT && 'LIVE_EVENT_LIMIT is not set'), timeout: 120000 }, async () => {
  const { context, page, t, log } = await openPage({ motion: false });
  for (let i = 0; i < EVENT_LIMIT; i++) {
    await page.click(i % 2 ? '#preset-team' : '#preset-service');
    await page.click('#submit-event');
    await t.waitText('#submit-result', /Alert accepted/, 30000);
  }
  await page.click('#preset-equipment');
  await page.click('#submit-event');
  await t.waitText('#submit-result', /reached its limit of alerts/, 30000);
  await sleep(2000);
  assert.equal(log.filter((r) => r.method === 'POST' && r.path === '/v1/events').length, EVENT_LIMIT + 1);
  assert.equal(log.filter((r) => r.method === 'POST' && r.path === '/v1/sessions').length, 1);
  await screenshot(page, 'live-quota-1440');
  await context.close();
});

test('paused worker: the alert is saved and nothing else is claimed', { skip: skipAll, timeout: 120000 }, async (tc) => {
  if (health?.inProcessWorker) return tc.skip('this server runs the worker (start one with WORKER_ENABLED=false)');
  const { context, page, t } = await openPage();
  await page.click('#submit-event');
  await t.waitText('#detail .jd-alert', /Accepted/, 30000);
  await sleep(8000);
  assert.deepEqual((await motionPlays(page)).map((p) => p.type), ['accepted']);
  assert.doesNotMatch(await t.deliveryBadge(), /Sending|Trying again|Confirmed|Stopped/);
  assert.match(await t.text('#detail .jd-forward'), /No try sent yet/);
  await shots(page, 'worker-paused');
  await context.close();
});
