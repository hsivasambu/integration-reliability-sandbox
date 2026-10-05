const path = require('node:path');
const express = require('express');
const { version } = require('../package.json');
const { createSession, findSession, SessionLimitError } = require('./sessions');
const { createRateLimiter } = require('./rate-limit');
const { pendingMigrations } = require('./migrate');

const DEFAULTS = {
  trustProxy: 0,
  sessionTtlHours: 24,
  sessionRateLimit: { max: 10, windowMs: 60 * 60_000 },
  maxActiveSessions: 1000,
};

function methodNotAllowed(allow) {
  return (req, res) => {
    res.set('Allow', allow.join(', '));
    res.status(405).json({ error: 'method_not_allowed', allow });
  };
}

function bearerToken(req) {
  const match = /^Bearer +(\S+)$/i.exec(req.get('Authorization') ?? '');
  return match ? match[1] : null;
}

// Requires a valid demo session bearer token; sets req.session.
function requireSession(pool) {
  return async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const token = bearerToken(req);
    if (!token) {
      res.set('WWW-Authenticate', 'Bearer realm="sandbox"');
      return res.status(401).json({ error: 'missing_token' });
    }
    const session = await findSession(pool, token);
    if (!session) {
      // Invalid and expired tokens get the same answer.
      res.set('WWW-Authenticate', 'Bearer realm="sandbox", error="invalid_token"');
      return res.status(401).json({ error: 'invalid_token' });
    }
    req.session = session;
    next();
  };
}

function createApp({ pool, config = {} } = {}) {
  const settings = { ...DEFAULTS, ...config };
  const app = express();

  // Don't advertise the framework in response headers.
  app.disable('x-powered-by');
  app.set('trust proxy', settings.trustProxy);

  // Liveness check: the process is running. Express answers HEAD with the
  // GET handler's status and headers but no body.
  app.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', version });
  });
  // Any other method on /health is a wrong-method error, not a missing route.
  app.all('/health', methodNotAllowed(['GET', 'HEAD']));

  // Readiness check: the database is reachable and fully migrated.
  app.get('/ready', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!pool) throw new Error('no database configured');
      const pending = await pendingMigrations(pool);
      if (pending.length > 0) {
        return res.status(503).json({ status: 'unavailable', reason: 'migrations_pending' });
      }
      res.json({ status: 'ready' });
    } catch (err) {
      console.error(`Readiness check failed: ${err.message}`);
      res.status(503).json({ status: 'unavailable', reason: 'database_unreachable' });
    }
  });
  app.all('/ready', methodNotAllowed(['GET', 'HEAD']));

  // API routes accept at most 1 KB of JSON.
  app.use('/v1', express.json({ limit: '1kb' }));

  app.post('/v1/sessions', createRateLimiter(settings.sessionRateLimit), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { token, session } = await createSession(pool, {
        ttlHours: settings.sessionTtlHours,
        maxActive: settings.maxActiveSessions,
      });
      res.status(201).json({
        token,
        tokenType: 'Bearer',
        createdAt: session.created_at,
        expiresAt: session.expires_at,
        notice: 'Anonymous demo credential, shown only once. It is not a user account and expires automatically.',
      });
    } catch (err) {
      if (err instanceof SessionLimitError) {
        return res.status(503).json({ error: 'session_capacity_reached' });
      }
      throw err;
    }
  });
  app.all('/v1/sessions', methodNotAllowed(['POST']));

  app.get('/v1/session', requireSession(pool), (req, res) => {
    res.json({ createdAt: req.session.created_at, expiresAt: req.session.expires_at });
  });
  app.all('/v1/session', methodNotAllowed(['GET', 'HEAD']));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Unknown routes get a JSON 404 so it is clear the server is up.
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // Client errors from body parsing (too large, malformed JSON) keep their status.
  // Anything else is logged server-side and returned as a generic 500.
  // Request headers are never logged, so bearer tokens stay out of logs.
  app.use((err, req, res, next) => {
    if (err.status >= 400 && err.status < 500 && err.expose) {
      const error = err.type === 'entity.too.large' ? 'payload_too_large'
        : err.type === 'entity.parse.failed' ? 'invalid_json' : 'bad_request';
      return res.status(err.status).json({ error });
    }
    console.error(err.stack ?? err.message);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

module.exports = { createApp };
