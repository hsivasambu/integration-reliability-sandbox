// Session-scoped event API: validation, idempotent creation, and pagination.
// Each new event is created together with its delivery job; the worker (src/worker.js) delivers it.

const crypto = require('node:crypto');
const express = require('express');
const { requireSession } = require('./auth');
const { sendError, methodNotAllowed } = require('./errors');

const EVENT_TYPE = 'demo.notification';
const LIMITS = {
  title: 100,          // characters
  message: 500,        // characters
  pageSizeDefault: 20,
  pageSizeMax: 50,
};
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Titles allow no control characters; messages allow line breaks only.
const TITLE_FORBIDDEN = /[\u0000-\u001F\u007F]/;
const MESSAGE_FORBIDDEN = /[\u0000-\u0009\u000B-\u001F\u007F]/;

// Event data plus a summary of its delivery job (delivery state lives only in `deliveries`).
const EVENT_SELECT = `
  SELECT e.id, e.seq, e.type, e.payload, e.idempotency_key, e.request_hash,
         e.created_at, e.updated_at, d.state AS delivery_state, d.attempt_count,
         d.next_attempt_at, d.failure_reason
  FROM events e JOIN deliveries d ON d.event_id = e.id`;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function checkText(value, field, max, forbidden, details) {
  if (value === undefined) return details.push({ field, issue: 'is required' });
  if (typeof value !== 'string') return details.push({ field, issue: 'must be a string' });
  if (value.trim() === '') return details.push({ field, issue: 'must not be blank' });
  if ([...value].length > max) return details.push({ field, issue: `must be at most ${max} characters` });
  if (forbidden.test(value)) return details.push({ field, issue: 'contains control characters' });
}

function rejectUnknown(object, allowed, prefix, details) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) details.push({ field: prefix + key, issue: 'is not an allowed field' });
  }
}

// Returns { event } with only the allowed fields, or { details } listing every problem.
function validateEvent(body) {
  const details = [];
  if (!isPlainObject(body)) {
    return { details: [{ field: '(body)', issue: 'must be a JSON object' }] };
  }
  rejectUnknown(body, ['type', 'payload'], '', details);

  if (body.type === undefined) details.push({ field: 'type', issue: 'is required' });
  else if (body.type !== EVENT_TYPE) details.push({ field: 'type', issue: `must be "${EVENT_TYPE}"` });

  const { payload } = body;
  if (payload === undefined) {
    details.push({ field: 'payload', issue: 'is required' });
  } else if (!isPlainObject(payload)) {
    details.push({ field: 'payload', issue: 'must be an object' });
  } else {
    rejectUnknown(payload, ['title', 'message'], 'payload.', details);
    checkText(payload.title, 'payload.title', LIMITS.title, TITLE_FORBIDDEN, details);
    checkText(payload.message, 'payload.message', LIMITS.message, MESSAGE_FORBIDDEN, details);
  }

  if (details.length > 0) return { details };
  return { event: { type: body.type, payload: { title: payload.title, message: payload.message } } };
}

// Same data always produces the same string, regardless of key order in the request.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const requestHash = (event) => crypto.createHash('sha256').update(canonicalJson(event)).digest();

function toResource(row, maxAttempts) {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    delivery: deliverySummary(row.delivery_state, row, maxAttempts, row.id),
  };
}

const statusUrl = (eventId) => `/v1/events/${eventId}/deliveries`;

// Delivery fields shared by the event resource and the deliveries endpoint.
// nextAttemptAt is only shown while the delivery is waiting for an attempt.
function deliverySummary(state, row, maxAttempts, eventId) {
  return {
    state,
    attemptCount: row.attempt_count,
    maxAttempts,
    nextAttemptAt: ['pending', 'retry_scheduled'].includes(state) ? row.next_attempt_at : null,
    failureReason: row.failure_reason ?? null,
    statusUrl: statusUrl(eventId),
  };
}

function compareExisting(row, hash) {
  return row.request_hash.equals(hash) ? { outcome: 'replayed', row } : { outcome: 'conflict' };
}

async function createEvent(pool, { sessionId, idempotencyKey, event, maxEvents }) {
  const hash = requestHash(event);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock this session's row so concurrent requests for the same session run one at a
    // time here. This keeps the per-session cap exact. The unique constraint, not this
    // lock, is what finally guarantees one event per idempotency key.
    const live = await client.query(
      'SELECT 1 FROM demo_sessions WHERE id = $1 AND expires_at > now() FOR UPDATE', [sessionId]);
    if (live.rowCount === 0) {
      await client.query('ROLLBACK');
      return { outcome: 'session_gone' };
    }

    // A repeated key returns the original result, even if the session is now at its cap.
    const existing = await client.query(
      `${EVENT_SELECT} WHERE e.session_id = $1 AND e.idempotency_key = $2`,
      [sessionId, idempotencyKey]);
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return compareExisting(existing.rows[0], hash);
    }

    const { rows: [{ count }] } = await client.query(
      'SELECT count(*)::int AS count FROM events WHERE session_id = $1', [sessionId]);
    if (count >= maxEvents) {
      await client.query('COMMIT');
      return { outcome: 'limit_reached' };
    }

    const inserted = await client.query(
      `INSERT INTO events (session_id, type, payload, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ON CONSTRAINT events_session_idempotency_key_unique DO NOTHING
       RETURNING id, seq, type, payload, idempotency_key, request_hash, created_at, updated_at`,
      [sessionId, event.type, event.payload, idempotencyKey, hash]);
    if (inserted.rows[0]) {
      // The delivery job is created in the same transaction: either both exist or neither does.
      const { rows: [delivery] } = await client.query(
        `INSERT INTO deliveries (event_id) VALUES ($1)
         RETURNING state AS delivery_state, attempt_count, next_attempt_at, failure_reason`,
        [inserted.rows[0].id]);
      await client.query('COMMIT');
      return { outcome: 'created', row: { ...inserted.rows[0], ...delivery } };
    }

    // The constraint rejected the insert: another writer stored this key first.
    const winner = await client.query(
      `${EVENT_SELECT} WHERE e.session_id = $1 AND e.idempotency_key = $2`,
      [sessionId, idempotencyKey]);
    await client.query('COMMIT');
    return compareExisting(winner.rows[0], hash);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const encodeCursor = (seq) => Buffer.from(String(seq)).toString('base64url');
function decodeCursor(cursor) {
  const text = Buffer.from(cursor, 'base64url').toString();
  return /^[1-9]\d{0,17}$/.test(text) ? text : null;
}

// Parses ?limit and ?cursor. Returns { limit, afterSeq } or { details }.
function parseListQuery(query) {
  const details = [];
  rejectUnknown(query, ['limit', 'cursor'], 'query.', details);

  let limit = LIMITS.pageSizeDefault;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (typeof query.limit !== 'string' || !Number.isInteger(limit)
        || limit < 1 || limit > LIMITS.pageSizeMax) {
      details.push({ field: 'query.limit', issue: `must be a whole number from 1 to ${LIMITS.pageSizeMax}` });
    }
  }
  let afterSeq = null;
  if (query.cursor !== undefined) {
    afterSeq = typeof query.cursor === 'string' ? decodeCursor(query.cursor) : null;
    if (!afterSeq) details.push({ field: 'query.cursor', issue: 'is not a valid cursor' });
  }
  return details.length > 0 ? { details } : { limit, afterSeq };
}

function eventRoutes(pool, { maxEventsPerSession, deliveryMaxAttempts }) {
  const resource = (row) => toResource(row, deliveryMaxAttempts);
  const router = express.Router();
  const auth = requireSession(pool);

  router.post('/events', auth, async (req, res) => {
    const idempotencyKey = req.get('Idempotency-Key');
    if (idempotencyKey === undefined) {
      return sendError(res, 400, 'idempotency_key_required',
        'Send an Idempotency-Key header (for example a UUID) so retries cannot create duplicates.');
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return sendError(res, 400, 'invalid_idempotency_key',
        'Idempotency-Key must be 1-100 characters: letters, digits, ".", "_", ":" or "-".');
    }
    if (!req.is('application/json')) {
      return sendError(res, 415, 'unsupported_media_type', 'Send the event as application/json.');
    }
    const { event, details } = validateEvent(req.body);
    if (details) {
      return sendError(res, 422, 'validation_failed', 'The event is invalid. Nothing was stored.', { details });
    }

    const result = await createEvent(pool, {
      sessionId: req.session.id, idempotencyKey, event, maxEvents: maxEventsPerSession,
    });
    switch (result.outcome) {
      case 'created':
        // 202 Accepted: durably stored and queued; delivery happens asynchronously.
        res.set('Location', statusUrl(result.row.id));
        return res.status(202).json({
          eventId: result.row.id,
          statusUrl: statusUrl(result.row.id),
          event: resource(result.row),
          notice: 'Accepted: stored durably and queued for asynchronous delivery. It has not been delivered yet; check statusUrl.',
        });
      case 'replayed':
        res.set('Idempotent-Replayed', 'true');
        return res.status(200).json({
          eventId: result.row.id,
          statusUrl: statusUrl(result.row.id),
          event: resource(result.row),
          notice: 'This Idempotency-Key was already used with the same payload. Returning the original event and its current delivery state; nothing new was stored.',
        });
      case 'conflict':
        return sendError(res, 409, 'idempotency_key_conflict',
          'This Idempotency-Key was already used with a different payload. Use a new key for a new event.');
      case 'limit_reached':
        return sendError(res, 429, 'event_limit_reached',
          `This demo session has reached its limit of ${maxEventsPerSession} events. Start a new session to continue.`,
          { limit: maxEventsPerSession });
      case 'session_gone':
        return sendError(res, 401, 'invalid_token', 'The token is invalid or expired. Create a new demo session.');
    }
  });

  router.get('/events', auth, async (req, res) => {
    const { limit, afterSeq, details } = parseListQuery(req.query);
    if (details) return sendError(res, 400, 'invalid_query', 'The query parameters are invalid.', { details });

    // Fetch one extra row to know whether another page exists.
    const { rows } = await pool.query(
      `${EVENT_SELECT}
       WHERE e.session_id = $1 AND ($2::bigint IS NULL OR e.seq < $2)
       ORDER BY e.seq DESC LIMIT $3`,
      [req.session.id, afterSeq, limit + 1]);
    const page = rows.slice(0, limit);
    res.json({
      data: page.map(resource),
      nextCursor: rows.length > limit ? encodeCursor(page.at(-1).seq) : null,
    });
  });

  // Unknown, malformed, and other sessions' IDs all look the same: 404.
  const notFound = (res) => sendError(res, 404, 'not_found', 'No event with this ID exists for your session.');

  router.get('/events/:id', auth, async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) return notFound(res);
    const { rows } = await pool.query(
      `${EVENT_SELECT} WHERE e.id = $1 AND e.session_id = $2`,
      [req.params.id, req.session.id]);
    if (!rows[0]) return notFound(res);
    res.json({ event: resource(rows[0]) });
  });

  // Delivery state and full attempt history for one of this session's events.
  router.get('/events/:id/deliveries', auth, async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) return notFound(res);
    const { rows: [delivery] } = await pool.query(
      `SELECT d.id, d.state, d.attempt_count, d.next_attempt_at, d.failure_reason,
              d.created_at, d.updated_at, d.completed_at
       FROM deliveries d JOIN events e ON e.id = d.event_id
       WHERE e.id = $1 AND e.session_id = $2`,
      [req.params.id, req.session.id]);
    if (!delivery) return notFound(res);
    const { rows: attempts } = await pool.query(
      `SELECT attempt_number, outcome, started_at, ended_at, response_status, error_category,
              retryable, duration_ms
       FROM delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_number`,
      [delivery.id]);
    res.json({
      eventId: req.params.id,
      delivery: {
        ...deliverySummary(delivery.state, delivery, deliveryMaxAttempts, req.params.id),
        createdAt: delivery.created_at,
        updatedAt: delivery.updated_at,
        completedAt: delivery.completed_at,
        attempts: attempts.map((a) => ({
          attemptNumber: a.attempt_number,
          outcome: a.outcome,
          startedAt: a.started_at,
          endedAt: a.ended_at,
          responseStatus: a.response_status,
          errorCategory: a.error_category,
          retryable: a.retryable,
          durationMs: a.duration_ms,
        })),
      },
    });
  });

  router.all('/events', methodNotAllowed(['GET', 'HEAD', 'POST']));
  router.all('/events/:id', methodNotAllowed(['GET', 'HEAD']));
  router.all('/events/:id/deliveries', methodNotAllowed(['GET', 'HEAD']));
  return router;
}

module.exports = { eventRoutes, validateEvent, canonicalJson, LIMITS };
