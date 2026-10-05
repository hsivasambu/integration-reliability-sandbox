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
  assert.deepEqual(res.body, { status: 'ok', version, inProcessWorker: false });
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

test('responses do not advertise Express', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.headers['x-powered-by'], undefined);
});
