// The API documentation and Postman files must match the implementation and contain no secrets.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const YAML = require('yaml');
const { createApp } = require('../src/app');
const { version } = require('../package.json');

const root = path.join(__dirname, '..');
const spec = YAML.parse(fs.readFileSync(path.join(root, 'docs', 'openapi.yaml'), 'utf8'));
const collection = JSON.parse(fs.readFileSync(
  path.join(root, 'postman', 'integration-reliability-sandbox.postman_collection.json'), 'utf8'));
const environment = JSON.parse(fs.readFileSync(
  path.join(root, 'postman', 'integration-reliability-sandbox.postman_environment.json'), 'utf8'));

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];
const SAMPLE_UUID = '00000000-0000-4000-8000-000000000000';
const DEMO_TOKEN = /irs_[A-Za-z0-9_-]{43}/;

// No database: the method checks below are answered before any query runs.
const app = createApp({ config: { opsToken: 'x'.repeat(32), receiverSecret: 'y'.repeat(32) } });

test('spec version matches package.json', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.version, version);
});

test('every documented path allows exactly the documented methods (405 Allow header)', async () => {
  for (const [template, item] of Object.entries(spec.paths)) {
    const url = template.replace(/\{[^}]+\}/g, SAMPLE_UUID);
    const documented = HTTP_METHODS.filter((m) => item[m]).map((m) => m.toUpperCase()).sort();
    assert.ok(!documented.includes('DELETE'), 'probe method must be undocumented');
    const res = await request(app).delete(url);
    assert.equal(res.status, 405, `${template}: DELETE should be 405, got ${res.status}`);
    const allowed = res.headers.allow.split(', ').filter((m) => m !== 'HEAD').sort();
    assert.deepEqual(allowed, documented, `${template}: Allow header vs spec`);
  }
});

test('every error code the server can send is listed in the spec', () => {
  const sources = fs.readdirSync(path.join(root, 'src'))
    .map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
  const codes = new Set([...sources.matchAll(/sendError\(\s*res,\s*[^,]+,\s*'([a-z_]+)'/g)].map((m) => m[1]));
  codes.add('method_not_allowed');
  const documented = new Set(spec.components.schemas.Error.properties.error.enum);
  assert.ok(codes.size >= 20, 'found the error codes in src/');
  for (const code of codes) assert.ok(documented.has(code), `error code ${code} is missing from the spec`);
  for (const code of documented) assert.ok(codes.has(code), `spec lists ${code}, which the server never sends`);
});

test('internal routes are marked internal and use their own secrets', () => {
  for (const [template, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS.filter((m) => item[m])) {
      const op = item[method];
      if (template.startsWith('/internal/')) {
        assert.ok(op.tags.includes('Internal') && op['x-internal'] === true, `${template} is marked internal`);
        assert.notDeepEqual(op.security, undefined, `${template} declares its own security`);
        assert.ok(!JSON.stringify(op.security).includes('sessionToken'));
      } else {
        assert.ok(!op.tags.includes('Internal'), `${template} is public`);
      }
    }
  }
});

test('spec and Postman files contain no live credentials', () => {
  const texts = {
    spec: fs.readFileSync(path.join(root, 'docs', 'openapi.yaml'), 'utf8'),
    collection: JSON.stringify(collection),
    environment: JSON.stringify(environment),
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.doesNotMatch(text, DEMO_TOKEN, `${name} contains something shaped like a real demo token`);
    assert.doesNotMatch(text, /RECEIVER_SECRET=|OPS_TOKEN=|postgres(ql)?:\/\//, `${name} contains a server secret`);
  }
  for (const v of environment.values) {
    if (['session_token', 'other_session_token'].includes(v.key)) {
      assert.equal(v.value, '', `${v.key} is empty in the template`);
      assert.equal(v.type, 'secret');
    }
  }
});

test('Postman environment has the required placeholders and the collection is ordered as agreed', () => {
  const keys = environment.values.map((v) => v.key);
  for (const key of ['base_url', 'session_token', 'event_id', 'delivery_id', 'idempotency_key', 'replay_idempotency_key']) {
    assert.ok(keys.includes(key), `environment has ${key}`);
  }
  assert.deepEqual(collection.item.map((folder) => folder.name.split('.')[0]), ['1', '2', '3', '4', '5', '6', '7', '8']);
  // Every request targets {{base_url}} and a path that exists in the spec.
  const specPaths = Object.keys(spec.paths).map((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`));
  for (const folder of collection.item) {
    for (const item of folder.item) {
      const raw = item.request.url.raw;
      assert.ok(raw.startsWith('{{base_url}}/'), `${item.name} uses base_url`);
      const urlPath = raw.slice('{{base_url}}'.length).split('?')[0];
      assert.ok(specPaths.some((re) => re.test(urlPath)), `${item.name}: ${urlPath} is documented`);
    }
  }
});

test('documentation page and specification are served under the CSP', async () => {
  const page = await request(app).get('/docs/');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.headers['content-security-policy'], /unsafe-/);
  assert.doesNotMatch(page.text, /<script>(?!<\/script>)|<script\s+(?![^>]*src=)/, 'no inline script');
  assert.doesNotMatch(page.text, /\son[a-z]+=|\sstyle=/i);
  for (const asset of ['/docs/docs.js', '/docs/docs.css', '/docs/vendor/swagger-ui-bundle.js', '/docs/vendor/swagger-ui.css']) {
    assert.equal((await request(app).get(asset)).status, 200, asset);
  }
  const yaml = await request(app).get('/openapi.yaml');
  assert.equal(yaml.status, 200);
  assert.match(yaml.headers['content-type'], /yaml/);
  assert.equal(YAML.parse(yaml.text).info.version, version);
  assert.equal((await request(app).get('/docs/vendor/index.html')).status, 404, 'only the two vendor files are exposed');
});
