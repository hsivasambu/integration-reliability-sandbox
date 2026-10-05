// Background delivery worker: polls PostgreSQL for due deliveries and makes HTTP attempts,
// retrying according to src/retry-policy.js. The schedule is stored in the database; the
// poll timer only wakes the worker up to look at it.
//
// Delivery is at-least-once, not exactly-once: if a worker crashes after the receiver has processed
// a delivery but before the result is recorded, the lease expires and the delivery is sent again.

const os = require('node:os');
const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { claimNext, completeAttempt, recoverExpired } = require('./delivery-store');
const { decideAfterAttempt } = require('./retry-policy');
const { logger } = require('./logger');

function createWorker({
  pool, send, pollIntervalMs, leaseMs, maxAttempts, retryBaseDelayMs,
  concurrency = 1,
  heartbeatIntervalMs = 10_000,
  clock = null, // tests pass () => Date to control time; null means "use the database clock"
  log = logger,
}) {
  const now = () => (clock ? clock() : null);
  const workerId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const inFlight = new Set();
  let running = false;
  let polling = false;
  let loop = null;
  let idle = null;
  let attemptsFinished = 0;
  let lastHeartbeat = 0;

  // Records that this worker is alive, at most once per heartbeatIntervalMs.
  async function heartbeat({ force = false, stopped = false } = {}) {
    if (!force && Date.now() - lastHeartbeat < heartbeatIntervalMs) return;
    lastHeartbeat = Date.now();
    await pool.query(
      `INSERT INTO worker_heartbeats (worker_id, concurrency, in_flight, attempts_finished, stopped_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END)
       ON CONFLICT (worker_id) DO UPDATE
       SET last_heartbeat_at = now(), in_flight = EXCLUDED.in_flight,
           attempts_finished = EXCLUDED.attempts_finished, stopped_at = EXCLUDED.stopped_at`,
      [workerId, concurrency, inFlight.size, attemptsFinished, stopped]);
  }

  // Sends one claimed delivery and records the result and the next state.
  async function processJob(job) {
    // No database transaction is open here; the claim is already committed.
    const result = await send({
      sessionId: job.session_id,
      eventId: job.event_id,
      type: job.type,
      payload: job.payload,
    });
    const decision = decideAfterAttempt(result, job.attempt_number, {
      maxAttempts, baseDelayMs: retryBaseDelayMs,
    });
    const recorded = await completeAttempt(pool, job,
      { ...decision, responseStatus: result.status, durationMs: result.durationMs }, { now: now() });
    attemptsFinished += 1;
    const fields = {
      workerId,
      eventId: job.event_id,
      deliveryId: job.delivery_id,
      attemptNumber: job.attempt_number,
      outcome: result.outcome,
      responseStatus: result.status ?? null,
      durationMs: result.durationMs,
    };
    if (recorded) {
      log.info('delivery attempt finished', { ...fields, nextState: decision.state, retryInMs: decision.retryDelayMs ?? null });
    } else {
      log.warn('delivery attempt result discarded: claim was lost (lease expired)', fields);
    }
  }

  async function recover() {
    const recovered = await recoverExpired(pool, { maxAttempts, now: now() });
    if (recovered > 0) log.warn('delivery leases expired and were recovered', { workerId, recovered });
  }

  // One polling run: recover expired leases, then claim due work until all slots are busy.
  // A run never overlaps another run, and at most `concurrency` deliveries are in flight.
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await recover();
      while (running && inFlight.size < concurrency) {
        const job = await claimNext(pool, { leaseMs, now: now() });
        if (!job) break;
        const task = processJob(job)
          .catch((err) => log.error('delivery attempt failed to complete', {
            workerId, deliveryId: job.delivery_id, eventId: job.event_id, error: err,
          }))
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
      await heartbeat();
    } finally {
      polling = false;
    }
  }

  async function run() {
    while (running) {
      try {
        await poll();
      } catch (err) {
        log.error('worker poll failed', { workerId, error: err });
      }
      if (!running) break;
      // Wake at the next poll interval, or as soon as an in-flight delivery frees a slot.
      idle = new AbortController();
      await Promise.race([
        sleep(pollIntervalMs, undefined, { signal: idle.signal }).catch(() => {}),
        ...inFlight,
      ]);
      idle.abort(); // clear the timer if a finished delivery woke us first
    }
    await Promise.allSettled(inFlight);
  }

  return {
    workerId,
    // Test helper: recover, then claim and fully process at most one due delivery.
    // Returns true if a delivery was processed.
    async runOnce() {
      await recover();
      const job = await claimNext(pool, { leaseMs, now: now() });
      if (!job) return false;
      await processJob(job);
      return true;
    },
    poll,
    inFlightCount: () => inFlight.size,
    start() {
      if (running) return;
      running = true;
      loop = run();
      log.info('worker started', { workerId, pollIntervalMs, concurrency, leaseMs, maxAttempts, retryBaseDelayMs });
    },
    // Stops claiming new work and waits for in-flight deliveries (each bounded by the client timeout).
    async stop() {
      if (!running) return;
      running = false;
      idle?.abort();
      await loop;
      await heartbeat({ force: true, stopped: true }).catch(() => {});
      log.info('worker stopped', { workerId, attemptsFinished });
    },
  };
}

module.exports = { createWorker };
