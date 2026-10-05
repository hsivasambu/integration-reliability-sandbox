// Standalone delivery worker (plus cleanup) for local checks: npm run dev:worker
// Uses the same configuration as the web server and delivers to RECEIVER_URL, so the web
// server (which hosts the mock receiver) must be running. It does not serve HTTP itself.

const { loadConfig, ConfigError } = require('./config');
const { createPool } = require('./db');
const { logger } = require('./logger');
const { backgroundJobs, protectSecrets } = require('./background');

let config;
try {
  config = loadConfig();
} catch (err) {
  logger.error(err instanceof ConfigError ? 'invalid configuration' : 'startup failed', { problems: err.message });
  process.exit(1);
}
logger.setLevel(config.logLevel);
protectSecrets(config);

const pool = createPool(config.databaseUrl);
const jobs = backgroundJobs(pool, config);
logger.info('standalone worker process starting', { receiverUrl: config.receiverUrl });
jobs.start();

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown started', { signal });
    await jobs.stop();
    await pool.end();
    process.exit(0);
  });
}
