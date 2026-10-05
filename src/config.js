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
  };

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}

module.exports = { loadConfig, ConfigError };
