// Mock receiver: a controlled stand-in for an external system that receives deliveries.
// Its behaviour is chosen per demo session and stored in PostgreSQL.

const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const express = require('express');
const { requireSession } = require('./auth');
const { sendError, methodNotAllowed } = require('./errors');

const MODES = ['success', 'server_error', 'timeout'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// Compares secrets in constant time, so response timing reveals nothing about the secret.
function secretMatches(provided, expected) {
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireReceiverSecret(secret) {
  return (req, res, next) => {
    const match = /^Bearer +(\S+)$/i.exec(req.get('Authorization') ?? '');
    if (!secret || !match || !secretMatches(match[1], secret)) {
      return sendError(res, 401, 'receiver_unauthorized', 'Internal receiver calls require the server-side secret.');
    }
    next();
  };
}

function validateDelivery(body) {
  const details = [];
  if (!isPlainObject(body)) return [{ field: '(body)', issue: 'must be a JSON object' }];
  for (const key of Object.keys(body)) {
    if (!['sessionId', 'eventId', 'type', 'payload'].includes(key)) {
      details.push({ field: key, issue: 'is not an allowed field' });
    }
  }
  for (const field of ['sessionId', 'eventId']) {
    if (typeof body[field] !== 'string' || !UUID_PATTERN.test(body[field])) {
      details.push({ field, issue: 'must be a UUID' });
    }
  }
  if (typeof body.type !== 'string') details.push({ field: 'type', issue: 'must be a string' });
  if (!isPlainObject(body.payload)) details.push({ field: 'payload', issue: 'must be an object' });
  return details;
}

async function getMode(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT s.id, coalesce(r.mode, 'success') AS mode, r.updated_at
     FROM demo_sessions s LEFT JOIN receiver_settings r ON r.session_id = s.id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId]);
  return rows[0] ?? null;
}

// POST /internal/receiver/deliveries: called only by server-side code holding the secret.
function receiverRoutes(pool, { receiverSecret, receiverSlowResponseMs }) {
  const router = express.Router();
  let pendingDelays = 0;

  router.post('/receiver/deliveries',
    requireReceiverSecret(receiverSecret),
    express.json({ limit: '4kb' }),
    async (req, res) => {
      // If the caller disconnects (for example its timeout fired), stop waiting.
      const disconnected = new AbortController();
      res.on('close', () => disconnected.abort());

      const details = validateDelivery(req.body);
      if (details.length > 0) {
        return sendError(res, 422, 'validation_failed', 'The delivery is invalid.', { details });
      }
      const settings = await getMode(pool, req.body.sessionId);
      if (!settings) return sendError(res, 404, 'unknown_session', 'No active demo session with this ID.');

      switch (settings.mode) {
        case 'success': {
          const { rows: [receipt] } = await pool.query(
            `INSERT INTO receiver_receipts (session_id, event_id) VALUES ($1, $2)
             RETURNING id, received_at`,
            [req.body.sessionId, req.body.eventId]);
          return res.status(200).json({ received: true, receiptId: receipt.id, receivedAt: receipt.received_at });
        }
        case 'server_error':
          res.set('Retry-After', '1');
          return sendError(res, 503, 'simulated_server_error',
            'Mock receiver is simulating an outage. Nothing was processed.');
        case 'timeout': {
          // Asynchronous wait: the event loop keeps serving other requests (such as /health).
          pendingDelays += 1;
          try {
            await delay(receiverSlowResponseMs, undefined, { signal: disconnected.signal });
          } catch (err) {
            if (err.name === 'AbortError') return; // caller gave up; the timer is already cleared
            throw err;
          } finally {
            pendingDelays -= 1;
          }
          // Too late for a caller using the standard timeout, and still not processed.
          return sendError(res, 503, 'simulated_slow_response',
            `Mock receiver answered after ${receiverSlowResponseMs} ms. Nothing was processed.`);
        }
      }
    });
  router.all('/receiver/deliveries', methodNotAllowed(['POST']));

  router.stats = () => ({ pendingDelays });
  return router;
}

// GET/PUT /v1/receiver: a demo session reads or changes its own receiver mode.
function receiverSettingsRoutes(pool) {
  const router = express.Router();
  const auth = requireSession(pool);

  async function describe(sessionId) {
    const settings = await getMode(pool, sessionId);
    const { rows: [{ count }] } = await pool.query(
      'SELECT count(*)::int AS count FROM receiver_receipts WHERE session_id = $1', [sessionId]);
    return {
      mode: settings.mode,
      availableModes: MODES,
      updatedAt: settings.updated_at,
      receivedCount: count,
      notice: 'The receiver is not connected to event delivery yet. Submitted events stay pending.',
    };
  }

  router.get('/receiver', auth, async (req, res) => {
    res.json(await describe(req.session.id));
  });

  router.put('/receiver', auth, async (req, res) => {
    if (!req.is('application/json')) {
      return sendError(res, 415, 'unsupported_media_type', 'Send the settings as application/json.');
    }
    const body = req.body;
    const details = [];
    if (!isPlainObject(body)) {
      details.push({ field: '(body)', issue: 'must be a JSON object' });
    } else {
      for (const key of Object.keys(body)) {
        if (key !== 'mode') details.push({ field: key, issue: 'is not an allowed field' });
      }
      if (!MODES.includes(body.mode)) details.push({ field: 'mode', issue: `must be one of: ${MODES.join(', ')}` });
    }
    if (details.length > 0) {
      return sendError(res, 422, 'validation_failed', 'The receiver settings are invalid.', { details });
    }
    await pool.query(
      `INSERT INTO receiver_settings (session_id, mode) VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`,
      [req.session.id, body.mode]);
    res.json(await describe(req.session.id));
  });

  router.all('/receiver', methodNotAllowed(['GET', 'HEAD', 'PUT']));
  return router;
}

module.exports = { receiverRoutes, receiverSettingsRoutes, MODES };
