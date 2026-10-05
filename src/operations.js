// Operational reads: request logging, the session summary, and the private worker check.

const crypto = require('node:crypto');
const express = require('express');
const { requireSession } = require('./auth');
const { sendError, methodNotAllowed } = require('./errors');
const { logger } = require('./logger');

// Gives every request an ID (echoed in X-Request-Id) and logs one line when it finishes.
// Successful reads (polling, static files, health checks) are logged only at debug level so
// routine traffic does not flood the logs. Headers and bodies are never logged.
function requestLogger() {
  return (req, res, next) => {
    const incoming = req.get('X-Request-Id');
    req.id = /^[A-Za-z0-9-]{8,64}$/.test(incoming ?? '') ? incoming : crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const routine = (req.method === 'GET' || req.method === 'HEAD') && res.statusCode < 400;
      logger[routine ? 'debug' : 'info']('request', {
        requestId: req.id,
        method: req.method,
        path: req.originalUrl.split('?')[0], // full path, no query string
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10,
        sessionId: req.session?.id,
        eventId: res.locals.eventId,
        deliveryId: res.locals.deliveryId,
      });
    });
    next();
  };
}

// The demo duration metric, stated precisely so nobody mistakes it for an SLA.
const DURATION_METRIC = {
  name: 'acceptance-to-delivery time',
  start: 'the API accepted the event (the 202 response; events.created_at)',
  end: 'the attempt that received a 2xx response finished (delivery_attempts.ended_at)',
  population: 'this session\'s 50 most recently completed original deliveries that were delivered. '
    + 'Failed and unfinished deliveries are excluded; replays are excluded because they include human waiting time.',
  includes: 'queue wait, HTTP time, and any retry delays before the successful attempt',
};

async function sessionSummary(pool, sessionId) {
  const { rows: [counts] } = await pool.query(
    `SELECT count(*)::int AS events,
            count(*) FILTER (WHERE d.state = 'delivered')::int AS delivered,
            count(*) FILTER (WHERE d.state = 'failed')::int AS failed,
            count(*) FILTER (WHERE d.state IN ('pending', 'retry_scheduled', 'in_progress'))::int AS active
     FROM events e
     CROSS JOIN LATERAL (
       SELECT state FROM deliveries WHERE event_id = e.id ORDER BY created_at DESC, id DESC LIMIT 1
     ) d
     WHERE e.session_id = $1`,
    [sessionId]);
  const { rows: [work] } = await pool.query(
    `SELECT count(a.id)::int AS attempts,
            count(DISTINCT d.id) FILTER (WHERE d.replay_of IS NOT NULL)::int AS replays
     FROM events e JOIN deliveries d ON d.event_id = e.id
     LEFT JOIN delivery_attempts a ON a.delivery_id = d.id
     WHERE e.session_id = $1`,
    [sessionId]);
  const { rows: [duration] } = await pool.query(
    `SELECT count(*)::int AS sample_size,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))::int AS median_ms,
            round(max(ms))::int AS max_ms
     FROM (
       SELECT extract(epoch FROM (a.ended_at - e.created_at)) * 1000 AS ms
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       JOIN delivery_attempts a ON a.delivery_id = d.id AND a.outcome = 'delivered'
       WHERE e.session_id = $1 AND d.state = 'delivered' AND d.replay_of IS NULL
       ORDER BY d.completed_at DESC
       LIMIT 50
     ) recent`,
    [sessionId]);
  const { rows: [receiver] } = await pool.query(
    `SELECT count(*)::int AS processed, coalesce(sum(delivery_count - 1), 0)::int AS duplicates
     FROM mock_receiver_receipts WHERE session_id = $1`,
    [sessionId]);

  return {
    events: counts.events,
    // Each event counted once, by the state of its latest delivery.
    byCurrentDeliveryState: { delivered: counts.delivered, failed: counts.failed, active: counts.active },
    attempts: work.attempts,
    replays: work.replays,
    receiver: { processed: receiver.processed, duplicatesRecognized: receiver.duplicates },
    recentDeliveryDuration: {
      ...DURATION_METRIC,
      sampleSize: duration.sample_size,
      medianMs: duration.median_ms,
      maxMs: duration.max_ms,
    },
    notice: 'Demo statistics for your session only, from a handful of synthetic events on free hosting. '
      + 'They are not a service-level agreement or a performance guarantee.',
  };
}

function summaryRoutes(pool) {
  const router = express.Router();
  router.get('/summary', requireSession(pool), async (req, res) => {
    res.json(await sessionSummary(pool, req.session.id));
  });
  router.all('/summary', methodNotAllowed(['GET', 'HEAD']));
  return router;
}

// GET /internal/ops/worker: private check of worker liveness and queue health.
// Disabled (404) unless OPS_TOKEN is configured; requires it as a bearer token.
function opsRoutes(pool, { opsToken, workerStallSeconds }) {
  const router = express.Router();

  router.get('/ops/worker', async (req, res) => {
    if (!opsToken) return sendError(res, 404, 'not_found', 'No route matches this path.', { path: req.path });
    const match = /^Bearer +(\S+)$/i.exec(req.get('Authorization') ?? '');
    const given = crypto.createHash('sha256').update(match?.[1] ?? '').digest();
    const expected = crypto.createHash('sha256').update(opsToken).digest();
    if (!match || !crypto.timingSafeEqual(given, expected)) {
      return sendError(res, 401, 'ops_unauthorized', 'This operational check requires the ops token.');
    }
    res.set('Cache-Control', 'no-store');

    const { rows: workers } = await pool.query(
      `SELECT worker_id, started_at, last_heartbeat_at, stopped_at, concurrency, in_flight, attempts_finished,
              extract(epoch FROM now() - last_heartbeat_at)::int AS heartbeat_age_seconds
       FROM worker_heartbeats
       WHERE last_heartbeat_at > now() - interval '1 hour'
       ORDER BY last_heartbeat_at DESC
       LIMIT 20`);
    const { rows: [queue] } = await pool.query(
      `SELECT count(*) FILTER (WHERE state IN ('pending', 'retry_scheduled') AND next_attempt_at <= now())::int AS overdue,
              coalesce(extract(epoch FROM now() - min(next_attempt_at)
                FILTER (WHERE state IN ('pending', 'retry_scheduled') AND next_attempt_at <= now())), 0)::int AS oldest_overdue_seconds,
              count(*) FILTER (WHERE state = 'retry_scheduled' AND next_attempt_at > now())::int AS retries_waiting,
              count(*) FILTER (WHERE state = 'in_progress')::int AS in_progress,
              count(*) FILTER (WHERE state = 'in_progress' AND lease_expires_at < now())::int AS expired_leases
       FROM deliveries
       WHERE state IN ('pending', 'retry_scheduled', 'in_progress')`);

    const alive = workers.filter((w) => !w.stopped_at && w.heartbeat_age_seconds <= workerStallSeconds);
    let verdict;
    if (alive.length === 0) verdict = 'no_live_worker';
    else if (queue.oldest_overdue_seconds > workerStallSeconds) verdict = 'stalled';
    else verdict = queue.overdue > 0 || queue.in_progress > 0 ? 'progressing' : 'idle';

    res.json({
      checkedAt: new Date().toISOString(),
      verdict,
      explanation: {
        no_live_worker: `No worker heartbeat in the last ${workerStallSeconds} s. Due deliveries will wait.`,
        stalled: `A worker is alive, but due work has waited more than ${workerStallSeconds} s.`,
        progressing: 'A worker is alive and due work is being picked up.',
        idle: 'A worker is alive and nothing is due.',
      }[verdict],
      workers: workers.map((w) => ({
        workerId: w.worker_id,
        startedAt: w.started_at,
        lastHeartbeatAt: w.last_heartbeat_at,
        heartbeatAgeSeconds: w.heartbeat_age_seconds,
        stoppedAt: w.stopped_at,
        concurrency: w.concurrency,
        inFlight: w.in_flight,
        attemptsFinished: Number(w.attempts_finished),
      })),
      queue: {
        overdue: queue.overdue,
        oldestOverdueSeconds: queue.oldest_overdue_seconds,
        retriesWaiting: queue.retries_waiting,
        inProgress: queue.in_progress,
        expiredLeases: queue.expired_leases,
      },
    });
  });
  router.all('/ops/worker', methodNotAllowed(['GET', 'HEAD']));
  return router;
}

module.exports = { requestLogger, summaryRoutes, opsRoutes, sessionSummary, DURATION_METRIC };
