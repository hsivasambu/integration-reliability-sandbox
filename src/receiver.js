// Mock receiver: a controlled stand-in for an external system that receives deliveries.
// Its behaviour is chosen per demo session and stored in PostgreSQL.
//
// It processes each event at most once: the event ID in every delivery is checked against
// mock_receiver_receipts, whose UNIQUE (session_id, event_id) constraint decides which copy
// is first. This protects only this receiver's own effect; it is not a general exactly-once
// guarantee for arbitrary external systems.

const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const express = require('express');
const { requireSession } = require('./auth');
const { sendError, methodNotAllowed } = require('./errors');

const MODES = ['success', 'server_error', 'timeout', 'process_then_timeout'];
const RECEIPT_COLUMNS = 'id, event_id, result, first_received_at, last_received_at, delivery_count';
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

// If the event was already processed, counts this delivery as a duplicate and returns the
// stored receipt; otherwise returns null. Nothing is processed here.
async function recognizeDuplicate(pool, { sessionId, eventId }) {
  const { rows } = await pool.query(
    `UPDATE mock_receiver_receipts
     SET delivery_count = delivery_count + 1, last_received_at = now()
     WHERE session_id = $1 AND event_id = $2
     RETURNING ${RECEIPT_COLUMNS}`,
    [sessionId, eventId]);
  return rows[0] ?? null;
}

// Processes the event at most once. A single statement (one transaction) records the receipt
// together with its synthetic result. If a concurrent copy got there first, the unique
// constraint turns this into a duplicate count instead, and the original result is returned.
async function processOnce(pool, { sessionId, eventId, payload }) {
  const title = typeof payload.title === 'string' ? payload.title.slice(0, 100) : '(untitled)';
  const result = {
    confirmationCode: `RCPT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    summary: `Notification recorded: ${title}`,
  };
  const { rows: [receipt] } = await pool.query(
    `INSERT INTO mock_receiver_receipts (session_id, event_id, result) VALUES ($1, $2, $3)
     ON CONFLICT ON CONSTRAINT mock_receiver_receipts_session_event_unique
     DO UPDATE SET delivery_count = mock_receiver_receipts.delivery_count + 1, last_received_at = now()
     RETURNING ${RECEIPT_COLUMNS}`,
    [sessionId, eventId, result]);
  return receipt;
}

function receiptResponse(receipt) {
  return {
    received: true,
    duplicate: receipt.delivery_count > 1,
    receiptId: receipt.id,
    result: receipt.result,
    firstReceivedAt: receipt.first_received_at,
  };
}

// POST /internal/receiver/deliveries: called only by server-side code holding the secret.
function receiverRoutes(pool, { receiverSecret, receiverSlowResponseMs }) {
  const router = express.Router();
  let pendingDelays = 0;

  // Waits asynchronously (other requests such as /health keep being served).
  // Returns false if the caller disconnected first; the timer is then already cleared.
  async function waitUnlessDisconnected(signal) {
    pendingDelays += 1;
    try {
      await delay(receiverSlowResponseMs, undefined, { signal });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      throw err;
    } finally {
      pendingDelays -= 1;
    }
  }

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

      // An already-processed event is recognized before any simulated failure, in every mode.
      const existing = await recognizeDuplicate(pool, req.body);
      if (existing) return res.status(200).json(receiptResponse(existing));

      switch (settings.mode) {
        case 'success':
          return res.status(200).json(receiptResponse(await processOnce(pool, req.body)));
        case 'server_error':
          res.set('Retry-After', '1');
          return sendError(res, 503, 'simulated_server_error',
            'Mock receiver is simulating an outage. Nothing was processed.');
        case 'timeout':
          if (!(await waitUnlessDisconnected(disconnected.signal))) return;
          // Too late for a caller using the standard timeout, and still not processed.
          return sendError(res, 503, 'simulated_slow_response',
            `Mock receiver answered after ${receiverSlowResponseMs} ms. Nothing was processed.`);
        case 'process_then_timeout': {
          // The work is committed first; only the reply is late. The sender times out without
          // knowing that processing already happened.
          const receipt = await processOnce(pool, req.body);
          if (!(await waitUnlessDisconnected(disconnected.signal))) return;
          return res.status(200).json(receiptResponse(receipt));
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
    const { rows: [counts] } = await pool.query(
      `SELECT count(*)::int AS processed,
              coalesce(sum(delivery_count - 1), 0)::int AS duplicates
       FROM mock_receiver_receipts WHERE session_id = $1`, [sessionId]);
    return {
      mode: settings.mode,
      availableModes: MODES,
      updatedAt: settings.updated_at,
      processedCount: counts.processed,   // distinct events the receiver processed
      duplicateCount: counts.duplicates,  // extra deliveries recognized and not re-processed
      receivedCount: counts.processed,    // kept for compatibility (same as processedCount)
      notice: 'The delivery worker sends your events here, retrying timeouts, 408, 429 and 5xx up to 4 attempts in total.',
    };
  }

  router.get('/receiver', auth, async (req, res) => {
    res.json(await describe(req.session.id));
  });

  // The receiver's view of one of this session's events: was it processed, with what result,
  // and how many duplicate deliveries arrived. Other sessions' events are 404.
  router.get('/receiver/receipts/:eventId', auth, async (req, res) => {
    const notFound = () => sendError(res, 404, 'not_found', 'No event with this ID exists for your session.');
    if (!UUID_PATTERN.test(req.params.eventId)) return notFound();
    const { rows: [row] } = await pool.query(
      `SELECT e.id AS event_id, r.result, r.first_received_at, r.last_received_at, r.delivery_count
       FROM events e
       LEFT JOIN mock_receiver_receipts r ON r.session_id = e.session_id AND r.event_id = e.id
       WHERE e.id = $1 AND e.session_id = $2`,
      [req.params.eventId, req.session.id]);
    if (!row) return notFound();
    res.json({
      eventId: row.event_id,
      processed: row.delivery_count !== null,
      result: row.result,
      firstReceivedAt: row.first_received_at,
      lastReceivedAt: row.last_received_at,
      deliveriesReceived: row.delivery_count ?? 0,
      duplicateCount: row.delivery_count ? row.delivery_count - 1 : 0,
    });
  });
  router.all('/receiver/receipts/:eventId', methodNotAllowed(['GET', 'HEAD']));

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
