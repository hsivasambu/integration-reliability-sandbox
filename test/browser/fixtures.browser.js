// Browser tests against a deterministic fixture API (test/browser/fixture-api.js), for UI races and failure paths
// that are hard to reproduce against the real backend: double clicks, lost answers, late answers for an old
// selection or session, expiry, quota, a paused worker, motion bookkeeping, reduced motion and the keyboard.
// The page and its scripts are the real ones, served by the real app (no database). Only API answers are fixtures.
//
//   npm run test:browser          (needs an installed Edge or Chrome; set BROWSER_PATH to choose one)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../../src/app');
const { FixtureApi } = require('./fixture-api');
const { noBrowser, launch, sleep, screenshot, helpers, recordMotion, motionPlays } = require('./harness');

let browser;
let server;
let base;

before(async () => {
  if (noBrowser) return;
  server = createApp({ config: { build: 'fixture' } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

// A fresh browser context (empty sessionStorage) with its own fixture API.
async function open({ width = 1280, height = 900, motion = false, setup } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height });
  const api = new FixtureApi();
  await api.attach(page);
  if (motion) await recordMotion(page);
  if (setup) await setup(page);
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  const t = helpers(page);
  await t.waitText('#service-status', /Service ready/);
  const requests = (method, pattern) => api.log.filter((r) => r.method === method && pattern.test(r.path));
  const send = async () => {
    const before = api.events.length;
    await page.click('#submit-event');
    await t.waitFor('the alert to be accepted', () => /Accepted/.test(document.querySelector('#detail .jd-alert')?.textContent ?? ''));
    assert.equal(api.events.length, before + 1);
    return api.event();
  };
  const viewCard = (title) => page.evaluate((name) => [...document.querySelectorAll('#event-list li')]
    .find((li) => li.querySelector('.hc-title').textContent === name).querySelector('.hc-view').click(), title);
  return { context, page, api, t, requests, send, viewCard, close: () => context.close() };
}

const opt = { skip: noBrowser, timeout: 90000 };

test('double click: one request and one alert', opt, async () => {
  const { page, api, t, requests, close } = await open();
  const held = api.when('POST', /^\/v1\/events$/, 'hold');
  await page.click('#submit-event');
  await page.click('#submit-event', { clickCount: 2 });
  await sleep(300);
  assert.equal(requests('POST', /^\/v1\/events$/).length, 1, 'only one POST while the first is in flight');
  assert.equal(await page.$eval('#submit-event', (b) => b.getAttribute('aria-disabled')), 'true', 'Send is unavailable while sending');
  await held.release();
  await t.waitText('#submit-result', /Alert accepted/);
  await sleep(500);
  assert.equal(requests('POST', /^\/v1\/events$/).length, 1);
  assert.equal(api.events.length, 1);
  await close();
});

test('double click after the first answer already came back: still one alert (Send alert and scenario card)', opt, async () => {
  // The session exists, so the fixture answers a send in about 100 ms: the second click of a person's double click
  // (200 ms later) arrives after the first alert was accepted, when Send is available again.
  const { page, api, t, send, close } = await open();
  await send();
  await page.click('#preset-team');
  await sleep(700);
  await t.doubleClick('#submit-event', 200);
  await sleep(1500);
  assert.equal(api.events.length, 2, 'the double click sent one alert, not two');
  await sleep(700);
  await t.doubleClick(await page.evaluateHandle(() => document.getElementById('scenario-normal').closest('article').querySelector('button')), 400);
  await sleep(2000);
  assert.equal(api.events.length, 3, 'the scenario card sent one alert, not two');
  await close();
});

test('lost answer: Check again reuses the key and finds the stored alert', opt, async () => {
  const { page, api, t, requests, close } = await open();
  api.when('POST', /^\/v1\/events$/, 'lose-answer');
  await page.click('#submit-event');
  await t.waitText('#pending-area', /could not confirm whether your alert was accepted/);
  assert.equal(api.events.length, 1, 'the API stored it; only the answer was lost');
  await screenshot(page, 'fixture-unconfirmed');
  await t.clickButton('#pending-area', 'Check again');
  await t.waitText('#submit-result', /Confirmed: your alert was accepted[\s\S]*did not create a second alert/);
  const posts = requests('POST', /^\/v1\/events$/);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].key, posts[1].key, 'Check again sends the same Idempotency-Key');
  assert.equal(api.events.length, 1);
  await t.waitFor('one history card', () => document.querySelectorAll('#event-list li').length === 1);
  await close();
});

test('lost answer, then a refresh: resolved from the alert list without sending again', opt, async () => {
  const { page, api, t, requests, close } = await open();
  api.when('POST', /^\/v1\/events$/, 'lose-answer');
  await page.click('#submit-event');
  await t.waitText('#pending-area', /could not confirm/);
  await page.reload({ waitUntil: 'networkidle0' });
  await t.waitText('#submit-result', /It appears in your recent alerts, so there is nothing to check again/);
  assert.equal(requests('POST', /^\/v1\/events$/).length, 1, 'the refresh did not resend');
  assert.equal(await t.text('#pending-area'), '');
  assert.equal(api.events.length, 1);
  await close();
});

test('request that never arrived: Check again creates it exactly once', opt, async () => {
  const { page, api, t, requests, close } = await open();
  api.when('POST', /^\/v1\/events$/, 'drop');
  await page.click('#submit-event');
  await t.waitText('#pending-area', /could not confirm/);
  assert.equal(api.events.length, 0);
  await t.clickButton('#pending-area', 'Check again');
  await t.waitText('#submit-result', /had not arrived, so this check sent it\. There is still only one alert/);
  const posts = requests('POST', /^\/v1\/events$/);
  assert.equal(posts[0].key, posts[1].key);
  assert.equal(api.events.length, 1);
  await close();
});

test('late answer for the previously selected alert is ignored', opt, async () => {
  const { page, api, t, send, viewCard, close } = await open();
  const a = await send();
  api.startAttempt(a); api.succeedAttempt(a);
  await t.waitText('#detail .jd-delivery .jd-badge', /Confirmed/);
  await page.click('#preset-team');
  const b = await send();
  for (let i = 0; i < 4; i++) { api.startAttempt(b); api.failAttempt(b); }
  await t.waitText('#detail .jd-delivery .jd-badge', /Stopped/);
  // A's journey is requested, its answer held back; then B is chosen; then A's answer arrives.
  const held = api.when('GET', new RegExp(`/v1/events/${a.id}/deliveries`), 'hold');
  await viewCard('Service request');
  for (let i = 0; i < 50 && held.matched === 0; i++) await sleep(50);
  assert.equal(held.matched, 1, 'A was requested');
  // Record every frame of the journey from here on: A's late answer must never show, not even briefly.
  await page.evaluate(() => {
    window.__frames = [];
    const detail = document.getElementById('detail');
    new MutationObserver(() => window.__frames.push({
      title: detail.querySelector('.journey-title')?.textContent ?? '',
      badge: detail.querySelector('.jd-delivery .jd-badge')?.textContent ?? '',
    })).observe(detail, { childList: true, subtree: true, characterData: true });
  });
  await viewCard('Team update');
  await t.waitText('#detail .journey-title', /Team update/);
  await held.release();
  await sleep(1500);
  assert.match(await t.text('#detail .journey-title'), /Team update/);
  assert.match(await t.deliveryBadge(), /Stopped/, 'B still shows its own state');
  const frames = await page.evaluate(() => window.__frames);
  const leaked = frames.filter((f) => /Team update/.test(f.title) && /Confirmed/.test(f.badge));
  assert.equal(leaked.length, 0, `A's Confirmed appeared under B's title in ${leaked.length} of ${frames.length} frames`);
  await close();
});

test('polling is single-flight: no second refresh while one is outstanding', opt, async () => {
  const { api, t, requests, send, close } = await open();
  await send(); // pending: polling every 2 s
  await t.waitText('#poll-status', /Updating every 2 seconds/);
  const held = api.when('GET', /^\/v1\/events\?limit=20$/, 'hold');
  for (let i = 0; i < 60 && held.matched === 0; i++) await sleep(100);
  const countAtHold = requests('GET', /^\/v1\/events\?limit=20$/).length;
  await sleep(6000); // three polling intervals
  assert.equal(requests('GET', /^\/v1\/events\?limit=20$/).length, countAtHold, 'no overlapping refresh');
  await held.release();
  for (let i = 0; i < 60 && requests('GET', /^\/v1\/events\?limit=20$/).length === countAtHold; i++) await sleep(100);
  assert.ok(requests('GET', /^\/v1\/events\?limit=20$/).length > countAtHold, 'polling resumes after the answer');
  await close();
});

test('a late answer from the previous session never reaches the screen', opt, async () => {
  const { page, api, t, send, close } = await open();
  await send();
  await t.waitText('#poll-status', /Updating every 2 seconds/);
  const held = api.when('GET', /^\/v1\/events\?limit=20$/, 'hold');
  for (let i = 0; i < 60 && held.matched === 0; i++) await sleep(100);
  await t.clickButton('#session-area', 'Start fresh session');
  await t.waitFor('the new session to be empty', () => !document.querySelector('#event-list .hc-title'));
  await held.release();
  await sleep(1000);
  assert.equal(await page.$('#event-list .hc-title'), null, 'the old session\'s alert did not reappear');
  assert.equal(api.sessions, 2);
  await close();
});

test('session expiry: the page says so and does not start a new session by itself', opt, async () => {
  const { api, t, requests, send, close } = await open();
  await send();
  api.expireSession();
  await t.waitText('#session-area', /Your demo session has ended or is no longer valid/);
  const sessions = requests('POST', /^\/v1\/sessions$/).length;
  await sleep(4500);
  assert.equal(requests('POST', /^\/v1\/sessions$/).length, sessions, 'no automatic new session');
  assert.equal(await t.text('#event-list .hc-title'), '', 'the ended session\'s alerts are cleared');
  await close();
});

test('quota: the limit is explained, nothing is retried, a fresh session is offered', opt, async () => {
  const { page, api, t, requests, send, close } = await open();
  api.eventLimit = 1;
  await send();
  await page.click('#preset-team');
  await page.click('#submit-event');
  await t.waitText('#submit-result', /reached its limit of alerts/);
  await sleep(2500);
  assert.equal(requests('POST', /^\/v1\/events$/).length, 2, 'the refused alert is not resent');
  assert.equal(requests('POST', /^\/v1\/sessions$/).length, 1, 'no automatic new session');
  assert.ok(await page.$$eval('#submit-result button', (bs) => bs.some((b) => b.textContent === 'Start a fresh session')));
  await screenshot(page, 'fixture-quota');
  await close();
});

test('motion follows observed attempt IDs and never plays an effect twice', opt, async () => {
  const { page, api, t, send, close } = await open({ motion: true });
  const ev = await send();
  const d = api.delivery(ev);
  api.startAttempt(ev);
  await t.waitText('#detail .jd-delivery .jd-badge', /Sending/);
  api.failAttempt(ev, { retryInMs: 3000 });
  await t.waitText('#detail .jd-delivery .jd-badge', /Trying again/);
  api.startAttempt(ev);
  await t.waitText('#detail .jd-delivery .jd-badge', /Sending/);
  api.succeedAttempt(ev);
  await t.waitText('#detail .jd-delivery .jd-badge', /Confirmed/);
  await t.waitText('#detail .jd-card', /Processed/);
  await sleep(1500);
  const playsBefore = await motionPlays(page);
  // Re-renders: reselect the alert, open and close details, resize, motion off and on, then more polls.
  await page.evaluate(() => document.querySelector('#event-list .hc-view').click());
  await page.evaluate(() => { const x = document.querySelector('#detail details.tech'); x.open = true; x.open = false; });
  await page.setViewport({ width: 900, height: 900 });
  await page.setViewport({ width: 1280, height: 900 });
  await page.click('#motion-toggle');
  await page.click('#motion-toggle');
  await sleep(4000);
  const plays = await motionPlays(page);
  const live = playsBefore.map((p) => `${p.type}|${p.key}`).sort();
  assert.deepEqual(live, [
    'accepted|accepted:' + ev.id, `error-reply|${d.id}:1`, `processed|processed:${ev.id}`,
    `ack|${d.id}:2`, `send|${d.id}:1`, `send|${d.id}:2`,
  ].sort(), 'one effect per observed change, keyed by delivery ID and attempt number');
  assert.equal(plays.filter((p) => p.repeated).length, 0, 'nothing replayed within the page');
  assert.equal(plays.length, playsBefore.length, 'reselect, resize, toggles and polls add nothing');
  // A refresh shows the finished journey as it is: nothing is replayed as if it were happening now.
  await page.reload({ waitUntil: 'networkidle0' });
  await t.waitText('#detail .jd-delivery .jd-badge', /Confirmed/);
  await sleep(3000);
  assert.deepEqual(await motionPlays(page), [], 'nothing replayed after a refresh');
  await close();
});

test('paused worker: no invented progress, only the acceptance is illustrated', opt, async () => {
  const { page, t, send, close } = await open({ motion: true });
  await send(); // the fixture never starts an attempt, like a stopped worker
  await sleep(8000); // four polls, past the scheduled time
  const plays = await motionPlays(page);
  assert.deepEqual(plays.map((p) => p.type), ['accepted']);
  assert.doesNotMatch(await t.deliveryBadge(), /Sending|Trying again|Confirmed|Stopped/);
  assert.match(await t.text('#detail .jd-forward'), /No try sent yet/);
  assert.match(await t.text('#detail .jd-card'), /Not processed yet/);
  await screenshot(page, 'fixture-worker-paused');
  await close();
});

test('reduced motion: no illustrations, control disabled, states still update', opt, async () => {
  const { page, api, t, send, close } = await open({ motion: true,
    setup: (p) => p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]) });
  assert.equal(await page.$eval('#motion-toggle', (b) => b.disabled && /system setting/.test(b.textContent)), true);
  const ev = await send();
  api.startAttempt(ev); api.succeedAttempt(ev);
  await t.waitText('#detail .jd-delivery .jd-badge', /Confirmed/);
  await sleep(1000);
  assert.deepEqual(await motionPlays(page), []);
  await close();
});

test('keyboard: choose a sample, send, open a journey and toggle motion without a mouse', opt, async () => {
  const { page, api, t, close } = await open();
  await page.focus('#preset-service');
  await page.keyboard.press('ArrowDown'); // radio group: the next sample is chosen
  assert.equal(await page.$eval('#title', (i) => i.value), 'Equipment notification');
  // Tab forward to Send alert (fields first), then press Enter.
  let id = '';
  for (let i = 0; i < 12 && id !== 'submit-event'; i++) {
    await page.keyboard.press('Tab');
    id = await page.evaluate(() => document.activeElement.id);
  }
  assert.equal(id, 'submit-event', 'Send alert is reachable with Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.notEqual(outline, 'none', 'keyboard focus is visible');
  await page.keyboard.press('Enter');
  await t.waitText('#submit-result', /Alert accepted/);
  assert.equal(api.events.length, 1);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'submit-event', 'focus stays on Send alert');
  // History card: View journey by keyboard.
  await page.focus('#event-list .hc-view');
  await page.keyboard.press('Enter');
  await t.waitText('#detail .journey-title', /Equipment notification/);
  // Motion control by keyboard.
  await page.focus('#motion-toggle');
  await page.keyboard.press('Space');
  assert.equal(await page.$eval('#motion-toggle', (b) => b.getAttribute('aria-pressed')), 'false');
  await close();
});

// Illustrations must never cover text: travelling tokens stay in lanes between the nodes, node effects are rings
// just outside the node's box. Every visible motion element is compared with every text run in the diagram,
// sampled every 30 ms while real effects play (send, error reply, retry, confirmation, processed, look-back).
for (const width of [1440, 390]) {
  test(`motion never covers journey text (${width} px)`, opt, async () => {
    const { page, api, t, send, close } = await open({ width });
    await page.evaluate(() => {
      window.__covered = new Set();
      window.__samples = 0;
      const textRects = () => {
        const out = [];
        const walker = document.createTreeWalker(document.querySelector('#detail .jd'), NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          for (const r of range.getClientRects()) out.push({ r, text: walker.currentNode.textContent.trim().slice(0, 30) });
        }
        return out;
      };
      setInterval(() => {
        const visible = [...document.querySelectorAll('#journey-motion .jm')].filter((el) => Number(getComputedStyle(el).opacity) > 0.3);
        if (!visible.length || !document.querySelector('#detail .jd')) return;
        window.__samples += 1;
        const texts = textRects();
        for (const el of visible) {
          const b = el.getBoundingClientRect();
          const parts = el.classList.contains('jm-ring') // transparent inside: only the edge can cover text
            ? [{ ...b.toJSON(), bottom: b.top + 3 }, { ...b.toJSON(), top: b.bottom - 3 }, { ...b.toJSON(), right: b.left + 3 }, { ...b.toJSON(), left: b.right - 3 }]
            : [b];
          for (const a of parts) {
            for (const { r, text } of texts) {
              const ix = Math.min(a.right, r.right) - Math.max(a.left, r.left);
              const iy = Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top);
              if (ix > 1 && iy > 1) window.__covered.add(`${el.dataset.effect} over "${text}"`);
            }
          }
        }
      }, 30);
    });
    const ev = await send();
    api.startAttempt(ev);
    await t.waitText('#detail .jd-delivery .jd-badge', /Sending/);
    await sleep(1200);
    api.failAttempt(ev, { retryInMs: 4000 });
    await t.waitText('#detail .jd-delivery .jd-badge', /Trying again/);
    await sleep(1200);
    api.startAttempt(ev);
    await t.waitText('#detail .jd-delivery .jd-badge', /Sending/);
    await sleep(1200);
    api.succeedAttempt(ev);
    await t.waitText('#detail .jd-delivery .jd-badge', /Confirmed/);
    await sleep(2500);
    // An attempt that finished between two refreshes: the labelled look-back, with a timeout.
    await page.click('#preset-team');
    await sleep(700);
    const ev2 = await send();
    await sleep(1500);
    api.startAttempt(ev2);
    api.failAttempt(ev2, { kind: 'timeout', retryInMs: 5000 });
    await t.waitText('#detail .jd-delivery .jd-badge', /Trying again/);
    await sleep(2500);
    assert.ok(await page.evaluate(() => window.__samples) > 20, 'illustrations were actually playing while sampled');
    assert.deepEqual(await page.evaluate(() => [...window.__covered]), []);
    await close();
  });
}

test('a page loaded before a deploy says so; a current page does not', opt, async () => {
  const current = await open();
  assert.equal(await current.page.$eval('#build-note', (n) => n.hidden), true, 'same build: no notice');
  assert.match(await current.t.text('#status-result'), /Build: page fixture, service fixture\./);
  await current.close();
  const stale = await open();
  stale.api.build = 'newer-build';
  await stale.t.clickButton('#technical', 'Check again'); // the same check runs on load and on return to the tab
  await stale.t.waitText('#build-note', /loaded before the service was updated\. Reload the page/);
  assert.equal(await stale.page.$eval('#build-note', (n) => n.hidden), false);
  await stale.close();
});
