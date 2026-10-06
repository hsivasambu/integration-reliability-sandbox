const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

const app = createApp();

test('landing page is served with a strict Content-Security-Policy', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
});

test('page loads only same-origin script and stylesheet, with no inline script or handlers', async () => {
  const { text } = await request(app).get('/');
  const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  // Same-origin only, stamped with the build (see stampPage in src/app.js; the default build is 'local').
  assert.deepEqual(scripts.map((m) => m[1].trim()),
    ['src="/journey-model.js?v=local"', 'src="/journey-motion.js?v=local"', 'src="/guide-model.js?v=local"', 'src="/app.js?v=local"']);
  assert.ok(scripts.every((m) => m[2].trim() === ''), 'no inline script');
  assert.doesNotMatch(text, /\son[a-z]+=/i, 'no inline event handlers');
  assert.doesNotMatch(text, /\sstyle=/i, 'no inline styles (blocked by the CSP)');
  assert.match(text, /<link rel="stylesheet" href="\/app.css\?v=local">/);
});

test('UI assets are served with correct types', async () => {
  const js = await request(app).get('/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  const css = await request(app).get('/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
});

test('UI scripts render server text safely and never put the token in a URL', async () => {
  for (const file of ['/app.js', '/journey-model.js', '/journey-motion.js', '/guide-model.js']) {
    const res = await request(app).get(file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers['content-type'], /javascript/);
    assert.doesNotMatch(res.text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
    assert.doesNotMatch(res.text, /localStorage/, `${file}: token stays in sessionStorage only`);
    assert.doesNotMatch(res.text, /[?&]token=/, file);
  }
});

test('removed stop-gap scripts are gone', async () => {
  assert.equal((await request(app).get('/demo.js')).status, 404);
  assert.equal((await request(app).get('/health-check.js')).status, 404);
});
