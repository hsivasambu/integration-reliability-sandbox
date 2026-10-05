// Background delivery worker: polls PostgreSQL for due deliveries and makes one HTTP attempt each.
// Delivery is at-least-once, not exactly-once: if a worker crashes after the receiver has processed
// a delivery but before the result is recorded, the lease expires and the delivery is sent again.

const { setTimeout: sleep } = require('node:timers/promises');
const { claimNext, completeAttempt, recoverExpired } = require('./delivery-store');

function createWorker({ pool, send, pollIntervalMs, leaseMs, maxAttempts, log = console }) {
  let running = false;
  let loop = null;
  let idle = null; // aborts the poll sleep so stop() takes effect immediately

  // Recovers expired leases, then claims and processes at most one delivery.
  // Returns true if a delivery was processed.
  async function runOnce() {
    const recovered = await recoverExpired(pool, { maxAttempts });
    if (recovered > 0) log.log(`Worker: ${recovered} delivery lease(s) expired and were recovered`);

    const job = await claimNext(pool, { leaseMs });
    if (!job) return false;

    // No database transaction is open here; the claim is already committed.
    const result = await send({
      sessionId: job.session_id,
      eventId: job.event_id,
      type: job.type,
      payload: job.payload,
    });

    const recorded = await completeAttempt(pool, job, result);
    if (!recorded) {
      log.log(`Worker: lost the claim on delivery ${job.delivery_id}; result (${result.outcome}) discarded`);
    }
    return true;
  }

  async function run() {
    while (running) {
      let processed = false;
      try {
        processed = await runOnce();
      } catch (err) {
        log.error(`Worker error: ${err.message}`);
      }
      if (processed || !running) continue; // more work may be waiting
      idle = new AbortController();
      await sleep(pollIntervalMs, undefined, { signal: idle.signal }).catch(() => {});
    }
  }

  return {
    runOnce,
    start() {
      if (running) return;
      running = true;
      loop = run();
      log.log(`Worker: started (poll every ${pollIntervalMs} ms, lease ${leaseMs} ms)`);
    },
    // Stops claiming new work and waits for the in-flight delivery (bounded by the client timeout).
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
