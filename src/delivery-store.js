// Database operations for the delivery job queue. Each function is a single SQL statement,
// so no transaction is ever held open while an HTTP request is in flight.

// Atomically claims the oldest due delivery and records its attempt (before anything is sent).
// SKIP LOCKED lets competing workers pass over a row another worker is claiming right now.
// Returns the job, or null when nothing is due.
async function claimNext(pool, { leaseMs }) {
  const { rows } = await pool.query(
    `WITH next AS (
       SELECT id FROM deliveries
       WHERE state = 'pending' AND available_at <= now()
       ORDER BY available_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE deliveries d
       SET state = 'in_progress',
           claim_token = gen_random_uuid(),
           lease_expires_at = now() + make_interval(secs => $1::double precision / 1000),
           attempt_count = d.attempt_count + 1,
           updated_at = now()
       FROM next WHERE d.id = next.id
       RETURNING d.id, d.event_id, d.claim_token, d.attempt_count, d.lease_expires_at
     ), attempt AS (
       INSERT INTO delivery_attempts (delivery_id, attempt_number, claim_token)
       SELECT id, attempt_count, claim_token FROM claimed
       RETURNING id, delivery_id
     )
     SELECT c.id AS delivery_id, c.claim_token, c.attempt_count AS attempt_number,
            c.lease_expires_at, a.id AS attempt_id,
            e.id AS event_id, e.session_id, e.type, e.payload
     FROM claimed c
     JOIN attempt a ON a.delivery_id = c.id
     JOIN events e ON e.id = c.event_id`,
    [leaseMs]);
  return rows[0] ?? null;
}

// Maps a delivery-client result onto the stored attempt fields.
function attemptResult(result) {
  if (result.outcome === 'delivered') {
    return { deliveryState: 'delivered', outcome: 'delivered', errorCategory: null };
  }
  // At this stage every non-2xx outcome fails the delivery (no automatic retries yet).
  return { deliveryState: 'failed', outcome: 'failed', errorCategory: result.outcome };
}

// Records the attempt result and finishes the delivery, but only if this worker's claim is
// still the current one. Returns false when the claim was lost (e.g. the lease expired and
// another worker took over); in that case nothing is written.
async function completeAttempt(pool, job, result) {
  const { deliveryState, outcome, errorCategory } = attemptResult(result);
  const { rowCount } = await pool.query(
    `WITH finished AS (
       UPDATE deliveries
       SET state = $3, claim_token = NULL, lease_expires_at = NULL,
           completed_at = now(), updated_at = now()
       WHERE id = $1 AND claim_token = $2 AND state = 'in_progress'
       RETURNING id
     )
     UPDATE delivery_attempts
     SET outcome = $4, error_category = $5, response_status = $6,
         duration_ms = $7, ended_at = now()
     WHERE delivery_id = (SELECT id FROM finished) AND claim_token = $2 AND outcome = 'in_progress'`,
    [job.delivery_id, job.claim_token, deliveryState, outcome, errorCategory,
      result.status ?? null, result.durationMs]);
  return rowCount === 1;
}

// Makes deliveries whose lease ran out claimable again and labels their unfinished attempt
// 'lease_expired' (outcome unknown). After maxAttempts claims, the delivery fails instead,
// so a job that keeps crashing workers cannot loop forever. Returns the number recovered.
async function recoverExpired(pool, { maxAttempts }) {
  const { rows: [{ recovered }] } = await pool.query(
    `WITH expired AS (
       SELECT id, claim_token FROM deliveries
       WHERE state = 'in_progress' AND lease_expires_at < now()
       FOR UPDATE SKIP LOCKED
     ), reset AS (
       UPDATE deliveries d
       SET state = CASE WHEN d.attempt_count >= $1 THEN 'failed' ELSE 'pending' END,
           completed_at = CASE WHEN d.attempt_count >= $1 THEN now() END,
           claim_token = NULL, lease_expires_at = NULL,
           available_at = now(), updated_at = now()
       FROM expired WHERE d.id = expired.id
       RETURNING d.id
     ), labelled AS (
       UPDATE delivery_attempts a
       SET outcome = 'lease_expired', error_category = 'lease_expired'
       FROM expired
       WHERE a.delivery_id = expired.id AND a.claim_token = expired.claim_token
         AND a.outcome = 'in_progress'
       RETURNING a.id
     )
     SELECT (SELECT count(*) FROM reset)::int AS recovered`,
    [maxAttempts]);
  return recovered;
}

module.exports = { claimNext, completeAttempt, recoverExpired };
