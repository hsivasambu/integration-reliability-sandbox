// Database operations for the delivery job queue. Each function is a single SQL statement,
// so no transaction is ever held open while an HTTP request is in flight.
//
// The schedule lives in PostgreSQL (deliveries.next_attempt_at). "Now" is the database clock,
// unless a caller passes `now` (tests use this to control time without waiting).

// Atomically claims the earliest due delivery and records its attempt (before anything is sent).
// SKIP LOCKED lets competing workers pass over a row another worker is claiming right now.
// Returns the job, or null when nothing is due.
async function claimNext(pool, { leaseMs, now = null }) {
  const { rows } = await pool.query(
    `WITH next AS (
       -- Deliveries of expired sessions are never started (cleanup cancels them later).
       SELECT d.id FROM deliveries d
       JOIN events e ON e.id = d.event_id
       JOIN demo_sessions s ON s.id = e.session_id
       WHERE d.state IN ('pending', 'retry_scheduled')
         AND d.next_attempt_at <= coalesce($2::timestamptz, now())
         AND s.expires_at > coalesce($2::timestamptz, now())
       ORDER BY d.next_attempt_at
       LIMIT 1
       FOR UPDATE OF d SKIP LOCKED
     ), claimed AS (
       UPDATE deliveries d
       SET state = 'in_progress',
           claim_token = gen_random_uuid(),
           lease_expires_at = coalesce($2::timestamptz, now())
                              + make_interval(secs => $1::double precision / 1000),
           attempt_count = d.attempt_count + 1,
           updated_at = coalesce($2::timestamptz, now())
       FROM next WHERE d.id = next.id
       RETURNING d.id, d.event_id, d.claim_token, d.attempt_count, d.lease_expires_at
     ), attempt AS (
       INSERT INTO delivery_attempts (delivery_id, attempt_number, claim_token, started_at)
       SELECT id, attempt_count, claim_token, coalesce($2::timestamptz, now()) FROM claimed
       RETURNING id, delivery_id
     )
     SELECT c.id AS delivery_id, c.claim_token, c.attempt_count AS attempt_number,
            c.lease_expires_at, a.id AS attempt_id,
            e.id AS event_id, e.session_id, e.type, e.payload
     FROM claimed c
     JOIN attempt a ON a.delivery_id = c.id
     JOIN events e ON e.id = c.event_id`,
    [leaseMs, now]);
  return rows[0] ?? null;
}

// Records an attempt's result and moves the delivery to decision.state (delivered, failed, or
// retry_scheduled at now + decision.retryDelayMs), but only if this worker's claim is still the
// current one. Returns false when the claim was lost; in that case nothing is written.
async function completeAttempt(pool, job, decision, { now = null } = {}) {
  const { rowCount } = await pool.query(
    `WITH finished AS (
       UPDATE deliveries
       SET state = $3::text,
           claim_token = NULL,
           lease_expires_at = NULL,
           next_attempt_at = CASE WHEN $3::text = 'retry_scheduled'
             THEN coalesce($9::timestamptz, now()) + make_interval(secs => $8::double precision / 1000)
             ELSE next_attempt_at END,
           completed_at = CASE WHEN $3::text IN ('delivered', 'failed')
             THEN coalesce($9::timestamptz, now()) END,
           failure_reason = $10::text,
           updated_at = coalesce($9::timestamptz, now())
       WHERE id = $1 AND claim_token = $2 AND state = 'in_progress'
       RETURNING id
     )
     UPDATE delivery_attempts
     SET outcome = $4, error_category = $5, response_status = $6, duration_ms = $7,
         retryable = $11, ended_at = coalesce($9::timestamptz, now())
     WHERE delivery_id = (SELECT id FROM finished) AND claim_token = $2 AND outcome = 'in_progress'`,
    [job.delivery_id, job.claim_token, decision.state, decision.outcome, decision.errorCategory,
      decision.responseStatus ?? null, decision.durationMs ?? null, decision.retryDelayMs ?? 0,
      now, decision.failureReason ?? null, decision.retryable]);
  return rowCount === 1;
}

// Deliveries whose lease ran out had an attempt with an UNKNOWN result (the worker crashed or
// stalled). Label that attempt 'lease_expired' (not 'failed') and make the delivery due again
// immediately. Lease-expired attempts still count toward maxAttempts; at the limit the delivery
// fails as attempts_exhausted. Returns the number recovered.
async function recoverExpired(pool, { maxAttempts, now = null }) {
  const { rows: [{ recovered }] } = await pool.query(
    `WITH expired AS (
       SELECT id, claim_token FROM deliveries
       WHERE state = 'in_progress' AND lease_expires_at < coalesce($2::timestamptz, now())
       FOR UPDATE SKIP LOCKED
     ), reset AS (
       UPDATE deliveries d
       SET state = CASE WHEN d.attempt_count >= $1 THEN 'failed' ELSE 'pending' END,
           failure_reason = CASE WHEN d.attempt_count >= $1 THEN 'attempts_exhausted' END,
           completed_at = CASE WHEN d.attempt_count >= $1 THEN coalesce($2::timestamptz, now()) END,
           claim_token = NULL, lease_expires_at = NULL,
           next_attempt_at = coalesce($2::timestamptz, now()),
           updated_at = coalesce($2::timestamptz, now())
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
    [maxAttempts, now]);
  return recovered;
}

module.exports = { claimNext, completeAttempt, recoverExpired };
