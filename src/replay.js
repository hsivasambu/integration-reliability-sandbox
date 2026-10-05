// Manual replay of a terminally failed delivery.
//
// The failed delivery and its attempts are kept unchanged. A new delivery for the same event is
// created, linked through replay_of, with a fresh attempt budget. The worker then sends the same
// event ID again, so the receiver's duplicate protection still applies.
//
// Concurrency: one transaction locks the event row, so replay requests for an event run one at a
// time. Database constraints are the backstop: replay_of is UNIQUE (one replay per delivery), at most
// one active delivery per event (partial unique index), and replay keys are UNIQUE per session.

const express = require('express');
const { requireSession } = require('./auth');
const { sendError, methodNotAllowed } = require('./errors');
const { deliverySummary, statusUrl, IDEMPOTENCY_KEY_PATTERN, UUID_PATTERN } = require('./events');

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

async function replayDelivery(pool, { sessionId, deliveryId, idempotencyKey, maxReplays }) {
  // A unique violation means a concurrent request won a race; one re-check then sees its result.
  for (let tries = 1; ; tries++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Only this session's deliveries are visible. Lock the event so replays of it are serialized.
      const { rows: [original] } = await client.query(
        `SELECT d.id, d.state, d.event_id FROM deliveries d JOIN events e ON e.id = d.event_id
         WHERE d.id = $1 AND e.session_id = $2
         FOR UPDATE OF e`,
        [deliveryId, sessionId]);
      if (!original) {
        await client.query('ROLLBACK');
        return { outcome: 'not_found' };
      }

      // The same key again returns what that request created (checked before eligibility,
      // because after a successful replay the original is no longer eligible).
      const { rows: [prior] } = await client.query(
        `SELECT original_delivery_id, replay_delivery_id FROM replay_requests
         WHERE session_id = $1 AND idempotency_key = $2`,
        [sessionId, idempotencyKey]);
      if (prior) {
        await client.query('COMMIT');
        return prior.original_delivery_id === deliveryId
          ? { outcome: 'repeated', replayId: prior.replay_delivery_id, eventId: original.event_id }
          : { outcome: 'key_conflict' };
      }

      if (original.state !== 'failed') {
        await client.query('COMMIT');
        return { outcome: 'not_failed', state: original.state };
      }
      const { rows: [replayedBy] } = await client.query(
        'SELECT id FROM deliveries WHERE replay_of = $1', [deliveryId]);
      if (replayedBy) {
        await client.query('COMMIT');
        return { outcome: 'already_replayed', replayId: replayedBy.id };
      }
      const { rows: [{ replays }] } = await client.query(
        'SELECT count(*)::int AS replays FROM deliveries WHERE event_id = $1 AND replay_of IS NOT NULL',
        [original.event_id]);
      if (replays >= maxReplays) {
        await client.query('COMMIT');
        return { outcome: 'limit_reached' };
      }

      const { rows: [replay] } = await client.query(
        'INSERT INTO deliveries (event_id, replay_of) VALUES ($1, $2) RETURNING id',
        [original.event_id, deliveryId]);
      await client.query(
        `INSERT INTO replay_requests (session_id, idempotency_key, original_delivery_id, replay_delivery_id)
         VALUES ($1, $2, $3, $4)`,
        [sessionId, idempotencyKey, deliveryId, replay.id]);
      await client.query('COMMIT');
      return { outcome: 'created', replayId: replay.id, eventId: original.event_id };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505' && tries < 2) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

function replayRoutes(pool, { deliveryMaxAttempts, maxReplaysPerEvent }) {
  const router = express.Router();

  async function replayResource(replayId) {
    const { rows: [row] } = await pool.query(
      `SELECT id AS delivery_id, event_id, state AS delivery_state, attempt_count, next_attempt_at,
              failure_reason, replay_of
       FROM deliveries WHERE id = $1`,
      [replayId]);
    return {
      eventId: row.event_id,
      statusUrl: statusUrl(row.event_id),
      delivery: deliverySummary(row, deliveryMaxAttempts, row.event_id),
    };
  }

  router.post('/deliveries/:id/replay', requireSession(pool), async (req, res) => {
    const idempotencyKey = req.get('Idempotency-Key');
    if (idempotencyKey === undefined) {
      return sendError(res, 400, 'idempotency_key_required',
        'Send an Idempotency-Key header so a repeated replay request cannot schedule a second replay.');
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return sendError(res, 400, 'invalid_idempotency_key',
        'Idempotency-Key must be 1-100 characters: letters, digits, ".", "_", ":" or "-".');
    }
    if (req.body !== undefined && !(isPlainObject(req.body) && Object.keys(req.body).length === 0)) {
      return sendError(res, 422, 'validation_failed', 'A replay request takes no body.',
        { details: [{ field: '(body)', issue: 'must be empty' }] });
    }
    if (!UUID_PATTERN.test(req.params.id)) {
      return sendError(res, 404, 'not_found', 'No delivery with this ID exists for your session.');
    }

    const result = await replayDelivery(pool, {
      sessionId: req.session.id, deliveryId: req.params.id, idempotencyKey, maxReplays: maxReplaysPerEvent,
    });
    switch (result.outcome) {
      case 'created': {
        const body = await replayResource(result.replayId);
        res.set('Location', body.statusUrl);
        return res.status(202).json({
          ...body,
          notice: 'Replay scheduled: a new delivery of the same event, with a fresh attempt budget. The failed delivery is kept in the history.',
        });
      }
      case 'repeated':
        res.set('Idempotent-Replayed', 'true');
        return res.status(200).json({
          ...(await replayResource(result.replayId)),
          notice: 'This Idempotency-Key already scheduled a replay of this delivery. Returning that replay; nothing new was scheduled.',
        });
      case 'not_found':
        return sendError(res, 404, 'not_found', 'No delivery with this ID exists for your session.');
      case 'key_conflict':
        return sendError(res, 409, 'idempotency_key_conflict',
          'This Idempotency-Key was already used to replay a different delivery. Use a new key.');
      case 'not_failed':
        return sendError(res, 409, 'delivery_not_failed',
          `Only failed deliveries can be replayed; this one is ${result.state}.`, { state: result.state });
      case 'already_replayed':
        return sendError(res, 409, 'already_replayed',
          'This delivery has already been replayed. Replay the newer delivery if it also fails.',
          { replayDeliveryId: result.replayId });
      case 'limit_reached':
        return sendError(res, 429, 'replay_limit_reached',
          `This event has reached its limit of ${maxReplaysPerEvent} replays.`, { limit: maxReplaysPerEvent });
    }
  });
  router.all('/deliveries/:id/replay', methodNotAllowed(['POST']));
  return router;
}

module.exports = { replayRoutes };
