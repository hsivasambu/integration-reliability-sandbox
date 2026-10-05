// Structured logging: one JSON object per line on stdout (warnings and errors on stderr).
//
// Safety rules, enforced here rather than trusted to every caller:
// - fields whose name suggests a credential or user content are replaced with "[redacted]"
// - demo bearer tokens (irs_...) and registered secret values are masked inside any string
// Callers should still never pass headers, bodies, or payloads.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /token|secret|password|passwd|authorization|cookie|payload|body|database_?url|connection_?string/i;
const DEMO_TOKEN = /irs_[A-Za-z0-9_-]{43}/g;

// Quiet by default under the test runner (NODE_TEST_CONTEXT); LOG_LEVEL overrides.
let threshold = LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_TEST_CONTEXT ? LEVELS.error : LEVELS.info);
const secrets = new Set();
let sink = (level, line) => (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);

function mask(text) {
  let out = text.replace(DEMO_TOKEN, 'irs_[redacted]');
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
}

function clean(value, key = '') {
  if (key && SENSITIVE_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return mask(value);
  if (value instanceof Error) return { message: mask(value.message), code: value.code };
  if (Array.isArray(value)) return value.map((v) => clean(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
  }
  return value;
}

function write(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  sink(level, JSON.stringify({ time: new Date().toISOString(), level, msg: mask(msg), ...clean(fields) }));
}

const logger = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
  setLevel(level) { threshold = LEVELS[level] ?? LEVELS.info; },
  // Values (secrets, database password) that must never appear in a log line.
  registerSecret(value) { if (typeof value === 'string' && value.length >= 8) secrets.add(value); },
  // Tests capture output by replacing the sink; returns a function that restores the default.
  captureTo(fn) {
    const previous = sink;
    sink = fn;
    return () => { sink = previous; };
  },
};

module.exports = { logger };
