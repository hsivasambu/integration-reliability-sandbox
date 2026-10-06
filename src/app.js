const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { version } = require('../package.json');
const { createSession, SessionLimitError } = require('./sessions');
const { createRateLimiter } = require('./rate-limit');
const { pendingMigrations } = require('./migrate');
const { requireSession } = require('./auth');
const { eventRoutes } = require('./events');
const { replayRoutes } = require('./replay');
const { receiverRoutes, receiverSettingsRoutes } = require('./receiver');
const { sendError, methodNotAllowed } = require('./errors');
const { requestLogger, summaryRoutes, opsRoutes } = require('./operations');
const { logger } = require('./logger');

const DEFAULTS = {
  trustProxy: 0,
  sessionTtlHours: 24,
  sessionRateLimit: { max: 10, windowMs: 60 * 60_000 },
  maxActiveSessions: 1000,
  maxEventsPerSession: 100,
  receiverSecret: undefined, // without a secret, every receiver call is rejected
  receiverSlowResponseMs: 4000,
  workerEnabled: false,
  deliveryMaxAttempts: 4,
  maxReplaysPerEvent: 3,
  apiRateLimit: { max: 600, windowMs: 60_000 },
  opsToken: undefined, // without it the private ops check is disabled
  workerStallSeconds: 60,
  build: 'local', // see BUILD_ID in src/config.js
};

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PAGE_ASSETS = /(src|href)="\/((?:app|journey-model|journey-motion|guide-model)\.(?:js|css))"/g;

// Stamps the page with the build it belongs to: a meta tag the page compares with /health, and ?v= on its own
// script and stylesheet URLs so a new page never pairs with old cached assets.
function stampPage(html, build) {
  const v = encodeURIComponent(build);
  return html
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta name="app-build" content="${v}">`)
    .replace(PAGE_ASSETS, `$1="/$2?v=${v}"`);
}

function createApp({ pool, config = {} } = {}) {
  const settings = { ...DEFAULTS, ...config };
  const app = express();

  // Don't advertise the framework in response headers.
  app.disable('x-powered-by');
  app.set('trust proxy', settings.trustProxy);
  app.use(requestLogger());

  // Browser hardening. The page keeps a demo token in sessionStorage, so it must only ever run
  // its own same-origin scripts: no inline scripts, no third-party code, no framing.
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; "
        + "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; "
        + "frame-ancestors 'none'; object-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  // Liveness check: the process is running. Express answers HEAD with the
  // GET handler's status and headers but no body.
  app.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    // build identifies the deployed code (see stampPage). inProcessWorker says whether this process runs the
    // delivery worker (WORKER_ENABLED).
    res.json({ status: 'ok', version, build: settings.build, inProcessWorker: settings.workerEnabled });
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
      logger.warn('readiness check failed', { requestId: req.id, error: err });
      res.status(503).json({ status: 'unavailable', reason: 'database_unreachable' });
    }
  });
  app.all('/ready', methodNotAllowed(['GET', 'HEAD']));

  // Per-IP request budget for the whole API (in-memory; see src/rate-limit.js for its limits).
  app.use('/v1', createRateLimiter(settings.apiRateLimit));
  // API routes accept at most 4 KB of JSON (the largest valid event is well under this).
  app.use('/v1', express.json({ limit: '4kb' }));

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
        return sendError(res, 503, 'session_capacity_reached',
          'The sandbox has too many active demo sessions. Try again later.');
      }
      throw err;
    }
  });
  app.all('/v1/sessions', methodNotAllowed(['POST']));

  app.get('/v1/session', requireSession(pool), (req, res) => {
    res.json({ createdAt: req.session.created_at, expiresAt: req.session.expires_at });
  });
  app.all('/v1/session', methodNotAllowed(['GET', 'HEAD']));

  app.use('/v1', eventRoutes(pool, settings));
  app.use('/v1', replayRoutes(pool, settings));
  app.use('/v1', receiverSettingsRoutes(pool));
  app.use('/v1', summaryRoutes(pool));

  // Mock receiver for server-side callers only (protected by RECEIVER_SECRET).
  const receiver = receiverRoutes(pool, settings);
  app.locals.receiverStats = receiver.stats;
  app.use('/internal', receiver);
  app.use('/internal', opsRoutes(pool, settings));

  // API documentation: the OpenAPI file and a Swagger UI page. Swagger UI's two files are served
  // from the pinned swagger-ui-dist package (same origin), so the strict CSP above still applies.
  app.get('/openapi.yaml', (req, res) => {
    res.type('application/yaml').sendFile(path.join(__dirname, '..', 'docs', 'openapi.yaml'));
  });
  const swaggerUi = path.dirname(require.resolve('swagger-ui-dist/package.json'));
  for (const file of ['swagger-ui-bundle.js', 'swagger-ui.css']) {
    app.get(`/docs/vendor/${file}`, (req, res) => res.sendFile(path.join(swaggerUi, file)));
  }

  // The page itself, stamped with the build (read per request, so local edits show without a restart).
  app.get(['/', '/index.html'], async (req, res) => {
    const html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(stampPage(html, settings.build));
  });
  app.use(express.static(PUBLIC_DIR));

  // Unknown routes get a JSON 404 so it is clear the server is up.
  app.use((req, res) => {
    sendError(res, 404, 'not_found', 'No route matches this path.', { path: req.path });
  });

  // Client errors from body parsing (too large, malformed JSON) keep their status.
  // Anything else is logged server-side and returned as a generic 500.
  // Request headers and bodies are never logged, so tokens stay out of logs.
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return sendError(res, 413, 'payload_too_large', 'Request body must be at most 4 KB.');
    }
    if (err.type === 'entity.parse.failed') {
      return sendError(res, 400, 'invalid_json', 'Request body is not valid JSON.');
    }
    if (err.status >= 400 && err.status < 500 && err.expose) {
      return sendError(res, err.status, 'bad_request', 'The request could not be processed.');
    }
    logger.error('unhandled request error', { requestId: req.id, path: req.path, error: err, stack: err.stack });
    sendError(res, 500, 'internal_error', 'Something went wrong on the server.');
  });

  return app;
}

module.exports = { createApp };
