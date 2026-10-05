const { loadConfig, ConfigError } = require('./config');
const { createPool } = require('./db');
const { runMigrations } = require('./migrate');
const { createApp } = require('./app');
const { createWorker } = require('./worker');
const { createDeliveryClient } = require('./delivery-client');

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const pool = createPool(config.databaseUrl);

  // On hosting plans without a separate pre-deploy step, migrate before serving.
  if (config.migrateOnStart) {
    await runMigrations(pool);
  }

  const server = createApp({ pool, config }).listen(config.port, config.host, () => {
    console.log(`Listening on http://${config.host}:${config.port}`);
  });

  // For the small deployment the worker shares this process, behind WORKER_ENABLED.
  // It starts after listen() because it delivers to this process's own mock receiver.
  let worker = null;
  if (config.workerEnabled) {
    worker = createWorker({
      pool,
      send: createDeliveryClient(config),
      pollIntervalMs: config.workerPollIntervalMs,
      leaseMs: config.deliveryLeaseMs,
      maxAttempts: config.deliveryMaxAttempts,
      retryBaseDelayMs: config.retryBaseDelayMs,
      concurrency: config.workerConcurrency,
    });
    server.once('listening', () => worker.start());
  } else {
    console.log('Worker: disabled in this process (WORKER_ENABLED is not "true")');
  }

  // Render sends SIGTERM before stopping an instance. Stop claiming work, let the in-flight
  // delivery finish and record its result, then finish open requests and close the pool.
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`${signal} received, shutting down`);
      await worker?.stop();
      server.close(() => pool.end().finally(() => process.exit(0)));
    });
  }
}

main().catch((err) => {
  console.error(`Startup failed: ${err.message}`);
  process.exit(1);
});
