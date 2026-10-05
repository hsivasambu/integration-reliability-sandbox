// Reads and validates server configuration from environment variables.
// Startup stops with a clear message if anything required is missing or invalid.

class ConfigError extends Error {}

function intSetting(env, name, fallback, min, max, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
    return fallback;
  }
  return value;
}

function loadConfig(env = process.env) {
  const problems = [];

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    problems.push('DATABASE_URL is required (see .env.example)');
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL must start with postgres:// or postgresql://');
  }

  const receiverSecret = env.RECEIVER_SECRET;
  if (!receiverSecret) {
    problems.push('RECEIVER_SECRET is required (a random string of at least 32 characters)');
  } else if (receiverSecret.length < 32 || /\s/.test(receiverSecret)) {
    problems.push('RECEIVER_SECRET must be at least 32 characters with no spaces');
  }

  const config = {
    port: intSetting(env, 'PORT', 3000, 1, 65535, problems),
    // Hosting platforms such as Render require listening on all interfaces.
    host: env.HOST || '0.0.0.0',
    databaseUrl,
    migrateOnStart: env.MIGRATE_ON_START === 'true',
    // Number of reverse proxies in front of the app, so req.ip is the real client.
    trustProxy: intSetting(env, 'TRUST_PROXY', 0, 0, 5, problems),
    sessionTtlHours: intSetting(env, 'SESSION_TTL_HOURS', 24, 1, 168, problems),
    sessionRateLimit: {
      max: intSetting(env, 'SESSION_RATE_LIMIT_MAX', 10, 1, 1000, problems),
      windowMs: intSetting(env, 'SESSION_RATE_LIMIT_WINDOW_MINUTES', 60, 1, 1440, problems) * 60_000,
    },
    maxActiveSessions: intSetting(env, 'MAX_ACTIVE_SESSIONS', 1000, 1, 100_000, problems),
    maxEventsPerSession: intSetting(env, 'MAX_EVENTS_PER_SESSION', 100, 1, 10_000, problems),
    receiverSecret,
    // How long the delivery client waits for the receiver before giving up.
    deliveryTimeoutMs: intSetting(env, 'DELIVERY_TIMEOUT_MS', 2000, 500, 10_000, problems),
    // How long the mock receiver's 'timeout' mode waits before answering.
    receiverSlowResponseMs: intSetting(env, 'RECEIVER_SLOW_RESPONSE_MS', 4000, 1000, 10_000, problems),
  };

  // Background delivery worker.
  config.workerEnabled = env.WORKER_ENABLED === 'true';
  config.workerPollIntervalMs = intSetting(env, 'WORKER_POLL_INTERVAL_MS', 1000, 200, 60_000, problems);
  config.deliveryLeaseMs = intSetting(env, 'DELIVERY_LEASE_MS', 15_000, 1000, 300_000, problems);
  config.deliveryMaxAttempts = intSetting(env, 'DELIVERY_MAX_ATTEMPTS', 3, 1, 10, problems);
  if (config.deliveryLeaseMs < config.deliveryTimeoutMs + 1000) {
    problems.push('DELIVERY_LEASE_MS must be at least DELIVERY_TIMEOUT_MS + 1000, or healthy attempts would lose their lease');
  }

  if (config.receiverSlowResponseMs <= config.deliveryTimeoutMs) {
    problems.push('RECEIVER_SLOW_RESPONSE_MS must be longer than DELIVERY_TIMEOUT_MS, or timeouts cannot be simulated');
  }

  // Delivery destination is fixed by server configuration. By default the app calls its own
  // mock receiver over loopback, which also works on Render.
  config.receiverUrl = env.RECEIVER_URL
    || `http://127.0.0.1:${config.port}/internal/receiver/deliveries`;
  if (!/^https?:\/\/\S+$/.test(config.receiverUrl)) {
    problems.push('RECEIVER_URL must be an http:// or https:// URL');
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}

module.exports = { loadConfig, ConfigError };
