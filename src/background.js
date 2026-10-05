// Shared by the web server (src/server.js) and the standalone worker (src/worker-main.js).
const { createWorker } = require('./worker');
const { createMaintenance } = require('./maintenance');
const { createDeliveryClient } = require('./delivery-client');
const { logger } = require('./logger');

// Makes sure configured secrets can never appear in a log line, even by accident.
function protectSecrets(config) {
  logger.registerSecret(config.receiverSecret);
  logger.registerSecret(config.opsToken);
  logger.registerSecret(config.databaseUrl);
  try { logger.registerSecret(decodeURIComponent(new URL(config.databaseUrl).password)); } catch { /* ignore */ }
}

// Worker and cleanup run together in processes that have WORKER_ENABLED=true.
function backgroundJobs(pool, config) {
  const worker = createWorker({
    pool,
    send: createDeliveryClient(config),
    pollIntervalMs: config.workerPollIntervalMs,
    leaseMs: config.deliveryLeaseMs,
    maxAttempts: config.deliveryMaxAttempts,
    retryBaseDelayMs: config.retryBaseDelayMs,
    concurrency: config.workerConcurrency,
    heartbeatIntervalMs: config.workerHeartbeatIntervalMs,
  });
  const cleanup = createMaintenance({
    pool,
    intervalMs: config.cleanupIntervalMs,
    batchSize: config.cleanupBatchSize,
    graceMinutes: config.expiredRetentionMinutes,
  });
  return {
    start() { worker.start(); cleanup.start(); },
    async stop() { await Promise.all([worker.stop(), cleanup.stop()]); },
  };
}

module.exports = { backgroundJobs, protectSecrets };
