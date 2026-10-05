const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, ConfigError } = require('../src/config');

const base = {
  DATABASE_URL: 'postgres://user:pw@localhost:5432/db',
  RECEIVER_SECRET: 'test-only-secret-0123456789abcdefghij',
};

test('missing DATABASE_URL fails with a clear message', () => {
  assert.throws(() => loadConfig({}), (err) =>
    err instanceof ConfigError && /DATABASE_URL is required/.test(err.message));
});

test('non-Postgres DATABASE_URL is rejected', () => {
  assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://x' }), /must start with postgres/);
});

test('invalid numeric settings are all reported together', () => {
  assert.throws(
    () => loadConfig({ ...base, PORT: 'abc', SESSION_TTL_HOURS: '0' }),
    (err) => /PORT/.test(err.message) && /SESSION_TTL_HOURS/.test(err.message));
});

test('defaults: 24 hour sessions, all interfaces, no migrate on start', () => {
  const config = loadConfig(base);
  assert.equal(config.sessionTtlHours, 24);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 3000);
  assert.equal(config.migrateOnStart, false);
});

test('session lifetime is configurable', () => {
  assert.equal(loadConfig({ ...base, SESSION_TTL_HOURS: '2' }).sessionTtlHours, 2);
});

test('missing or short RECEIVER_SECRET fails clearly', () => {
  assert.throws(() => loadConfig({ DATABASE_URL: base.DATABASE_URL }), /RECEIVER_SECRET is required/);
  assert.throws(() => loadConfig({ ...base, RECEIVER_SECRET: 'short' }), /at least 32 characters/);
});

test('receiver defaults: own loopback URL, 2 s client timeout, 4 s slow response', () => {
  const config = loadConfig({ ...base, PORT: '10000' });
  assert.equal(config.receiverUrl, 'http://127.0.0.1:10000/internal/receiver/deliveries');
  assert.equal(config.deliveryTimeoutMs, 2000);
  assert.equal(config.receiverSlowResponseMs, 4000);
});

test('slow response must exceed the client timeout', () => {
  assert.throws(
    () => loadConfig({ ...base, DELIVERY_TIMEOUT_MS: '3000', RECEIVER_SLOW_RESPONSE_MS: '2000' }),
    /must be longer than DELIVERY_TIMEOUT_MS/);
});

test('RECEIVER_URL must be http(s)', () => {
  assert.throws(() => loadConfig({ ...base, RECEIVER_URL: 'file:///etc/passwd' }), /RECEIVER_URL/);
});
