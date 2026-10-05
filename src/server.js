const { loadConfig, ConfigError } = require('./config');
const { createPool } = require('./db');
const { runMigrations } = require('./migrate');
const { createApp } = require('./app');

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

  // Render sends SIGTERM before stopping an instance; finish open requests first.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`${signal} received, shutting down`);
      server.close(() => pool.end().finally(() => process.exit(0)));
    });
  }
}

main().catch((err) => {
  console.error(`Startup failed: ${err.message}`);
  process.exit(1);
});
