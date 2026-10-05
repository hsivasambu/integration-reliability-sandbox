// Standalone delivery worker for local checks: npm run dev:worker
// Uses the same configuration as the web server and delivers to RECEIVER_URL, so the web
// server (which hosts the mock receiver) must be running. It does not serve HTTP itself.

const { loadConfig, ConfigError } = require('./config');
const { createPool } = require('./db');
const { createWorker } = require('./worker');
const { createDeliveryClient } = require('./delivery-client');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : `Startup failed: ${err.message}`);
  process.exit(1);
}

const pool = createPool(config.databaseUrl);
const worker = createWorker({
  pool,
  send: createDeliveryClient(config),
  pollIntervalMs: config.workerPollIntervalMs,
  leaseMs: config.deliveryLeaseMs,
  maxAttempts: config.deliveryMaxAttempts,
  retryBaseDelayMs: config.retryBaseDelayMs,
  concurrency: config.workerConcurrency,
});

console.log(`Worker process delivering to ${config.receiverUrl}`);
worker.start();

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, stopping worker`);
    await worker.stop();
    await pool.end();
    process.exit(0);
  });
}
