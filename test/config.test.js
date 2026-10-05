const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, ConfigError } = require('../src/config');

const base = { DATABASE_URL: 'postgres://user:pw@localhost:5432/db' };

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
