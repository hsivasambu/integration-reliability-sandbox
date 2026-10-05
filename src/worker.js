// Background delivery worker: polls PostgreSQL for due deliveries and makes HTTP attempts,
// retrying according to src/retry-policy.js. The schedule is stored in the database; the
// poll timer only wakes the worker up to look at it.
//
// Delivery is at-least-once, not exactly-once: if a worker crashes after the receiver has processed
// a delivery but before the result is recorded, the lease expires and the delivery is sent again.

const { setTimeout: sleep } = require('node:timers/promises');
const { claimNext, completeAttempt, recoverExpired } = require('./delivery-store');
const { decideAfterAttempt } = require('./retry-policy');

function createWorker({
  pool, send, pollIntervalMs, leaseMs, maxAttempts, retryBaseDelayMs,
  concurrency = 1,
  clock = null, // tests pass () => Date to control time; null means "use the database clock"
  log = console,
}) {
  const now = () => (clock ? clock() : null);
  const inFlight = new Set();
  let running = false;
  let polling = false;
  let loop = null;
  let idle = null;

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
    if (!recorded) {
      log.log(`Worker: lost the claim on delivery ${job.delivery_id}; result (${result.outcome}) discarded`);
    }
  }

  async function recover() {
    const recovered = await recoverExpired(pool, { maxAttempts, now: now() });
    if (recovered > 0) log.log(`Worker: ${recovered} delivery lease(s) expired and were recovered`);
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
          .catch((err) => log.error(`Worker error on delivery ${job.delivery_id}: ${err.message}`))
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    } finally {
      polling = false;
    }
  }

  async function run() {
    while (running) {
      try {
        await poll();
      } catch (err) {
        log.error(`Worker error: ${err.message}`);
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
      log.log(`Worker: started (poll every ${pollIntervalMs} ms, concurrency ${concurrency}, lease ${leaseMs} ms)`);
    },
    // Stops claiming new work and waits for in-flight deliveries (each bounded by the client timeout).
    async stop() {
      if (!running) return;
      running = false;
      idle?.abort();
      await loop;
      log.log('Worker: stopped');
    },
  };
}

module.exports = { createWorker };
