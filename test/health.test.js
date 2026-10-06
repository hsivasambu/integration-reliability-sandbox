const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { version } = require('../package.json');

const app = createApp();

test('GET /health returns 200 with status and version', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(res.body, { status: 'ok', version, build: 'local', inProcessWorker: false });
});

test('HEAD /health returns 200 with no body', async () => {
  const res = await request(app).head('/health');
  assert.equal(res.status, 200);
  assert.equal(res.text, undefined);
});

test('wrong method on /health returns 405 with Allow header', async () => {
  const res = await request(app).post('/health');
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
});

test('unknown route returns JSON 404', async () => {
  const res = await request(app).get('/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('GET / serves the landing page', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<title>[^<]*Integration Reliability Sandbox<\/title>/);
});

test('GET / is stamped with the build: meta tag and versioned page assets', async () => {
  const stamped = createApp({ config: { build: 'abc123def456' } });
  const res = await request(stamped).get('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.match(res.text, /<meta name="app-build" content="abc123def456">/);
  for (const asset of ['app.css', 'journey-model.js', 'journey-motion.js', 'guide-model.js', 'app.js']) {
    assert.ok(res.text.includes(`/${asset}?v=abc123def456"`), asset);
  }
  assert.equal((await request(stamped).get('/health')).body.build, 'abc123def456');
  // The versioned URL serves the same file.
  assert.equal((await request(stamped).get('/app.js?v=abc123def456')).status, 200);
  // A conditional request for an unchanged page is answered 304.
  const again = await request(stamped).get('/').set('If-None-Match', res.headers.etag);
  assert.equal(again.status, 304);
});

test('responses do not advertise Express', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.headers['x-powered-by'], undefined);
});
