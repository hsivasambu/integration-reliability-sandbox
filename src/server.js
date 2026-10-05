const { loadConfig, ConfigError } = require('./config');
const { createPool } = require('./db');
const { runMigrations } = require('./migrate');
const { createApp } = require('./app');
const { logger } = require('./logger');
const { backgroundJobs, protectSecrets } = require('./background');

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error('invalid configuration', { problems: err.message });
      process.exit(1);
    }
    throw err;
  }
  logger.setLevel(config.logLevel);
  protectSecrets(config);

  const pool = createPool(config.databaseUrl);

  // On hosting plans without a separate pre-deploy step, migrate before serving.
  if (config.migrateOnStart) {
    await runMigrations(pool, { log: (msg) => logger.info(msg) });
  }

  const server = createApp({ pool, config }).listen(config.port, config.host, () => {
    logger.info('listening', { host: config.host, port: config.port, workerEnabled: config.workerEnabled });
  });

  // For the small deployment the worker shares this process, behind WORKER_ENABLED.
  // It starts after listen() because it delivers to this process's own mock receiver.
  let jobs = null;
  if (config.workerEnabled) {
    jobs = backgroundJobs(pool, config);
    server.once('listening', () => jobs.start());
  } else {
    logger.info('worker disabled in this process (WORKER_ENABLED is not "true"); no deliveries or cleanup run here');
  }

  // Render sends SIGTERM before stopping an instance. Stop claiming work, let in-flight
  // deliveries finish and record their results, then finish open requests and close the pool.
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('shutdown started', { signal });
      await jobs?.stop();
      server.close(() => pool.end().finally(() => {
        logger.info('shutdown complete');
        process.exit(0);
      }));
    });
  }
}

main().catch((err) => {
  logger.error('startup failed', { error: err });
  process.exit(1);
});
