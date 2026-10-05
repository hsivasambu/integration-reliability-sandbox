// Bounded cleanup of expired demo sessions and everything that belongs to them.
//
// How expiry works, in order:
// 1. At expiry the token stops working: no new events, replays, or mode changes (requireSession).
// 2. Workers never claim deliveries of an expired session (claimNext checks expires_at), so no new
//    HTTP attempts start. An attempt already in flight is allowed to finish.
// 3. Cleanup marks that session's waiting deliveries (pending / retry_scheduled) as failed with
//    failure_reason 'session_expired'.
// 4. After a grace period, cleanup deletes the session; foreign keys cascade to its events,
//    deliveries, attempts, receiver settings, receipts, and replay requests. A session is skipped
//    while any of its deliveries is in progress under a live lease, so a worker's job is never
//    deleted underneath it.
// Every step works in batches (LIMIT + SKIP LOCKED), so one run does a bounded amount of work.

const { setTimeout: sleep } = require('node:timers/promises');
const { logger } = require('./logger');

async function cancelExpiredWork(pool, { batchSize, now = null }) {
  const { rowCount } = await pool.query(
    `WITH expired AS (
       SELECT d.id FROM deliveries d
       JOIN events e ON e.id = d.event_id
       JOIN demo_sessions s ON s.id = e.session_id
       WHERE d.state IN ('pending', 'retry_scheduled')
         AND s.expires_at <= coalesce($2::timestamptz, now())
       LIMIT $1
       FOR UPDATE OF d SKIP LOCKED
     )
     UPDATE deliveries d
     SET state = 'failed', failure_reason = 'session_expired',
         completed_at = coalesce($2::timestamptz, now()), updated_at = coalesce($2::timestamptz, now())
     FROM expired WHERE d.id = expired.id`,
    [batchSize, now]);
  return rowCount;
}

async function purgeExpiredSessions(pool, { graceMinutes, batchSize, now = null }) {
  const { rowCount } = await pool.query(
    `WITH doomed AS (
       SELECT s.id FROM demo_sessions s
       WHERE s.expires_at < coalesce($3::timestamptz, now()) - make_interval(mins => $1)
         AND NOT EXISTS (
           SELECT 1 FROM events e JOIN deliveries d ON d.event_id = e.id
           WHERE e.session_id = s.id AND d.state = 'in_progress'
             AND d.lease_expires_at > coalesce($3::timestamptz, now()))
       ORDER BY s.expires_at
       LIMIT $2
       FOR UPDATE OF s SKIP LOCKED
     )
     DELETE FROM demo_sessions WHERE id IN (SELECT id FROM doomed)`,
    [graceMinutes, batchSize, now]);
  return rowCount;
}

async function pruneHeartbeats(pool) {
  const { rowCount } = await pool.query(
    "DELETE FROM worker_heartbeats WHERE last_heartbeat_at < now() - interval '1 day'");
  return rowCount;
}

function createMaintenance({ pool, intervalMs, batchSize, graceMinutes, log = logger }) {
  let running = false;
  let loop = null;
  let idle = null;

  async function runOnce({ now = null } = {}) {
    const cancelled = await cancelExpiredWork(pool, { batchSize, now });
    const purged = await purgeExpiredSessions(pool, { graceMinutes, batchSize, now });
    const heartbeats = await pruneHeartbeats(pool);
    if (cancelled || purged || heartbeats) {
      log.info('cleanup finished', { cancelledDeliveries: cancelled, purgedSessions: purged, prunedHeartbeats: heartbeats });
    }
    return { cancelled, purged, heartbeats };
  }

  async function run() {
    while (running) {
      try {
        await runOnce();
      } catch (err) {
        log.error('cleanup failed', { error: err });
      }
      idle = new AbortController();
      await sleep(intervalMs, undefined, { signal: idle.signal }).catch(() => {});
    }
  }

  return {
    runOnce,
    start() {
      if (running) return;
      running = true;
      loop = run();
      log.info('cleanup started', { intervalMs, batchSize, graceMinutes });
    },
    async stop() {
      if (!running) return;
      running = false;
      idle?.abort();
      await loop;
    },
  };
}

module.exports = { createMaintenance, cancelExpiredWork, purgeExpiredSessions };
