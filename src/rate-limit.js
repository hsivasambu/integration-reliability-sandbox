// Small in-memory fixed-window rate limiter keyed by client IP.
//
// Accuracy limit: counters live in one process. With N application instances (including the
// brief overlap of old and new instances during a Render deploy) a client can make up to N times
// the limit, and counters reset whenever the process restarts. Limits that must hold across
// instances (session cap, per-session event cap, replay cap) are enforced in PostgreSQL instead.

const { sendError } = require('./errors');

const MAX_TRACKED_CLIENTS = 10_000;

function createRateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map(); // ip -> { count, resetAt }

  return function rateLimit(req, res, next) {
    const time = now();
    if (hits.size >= MAX_TRACKED_CLIENTS) {
      for (const [key, entry] of hits) if (entry.resetAt <= time) hits.delete(key);
    }

    let entry = hits.get(req.ip);
    if (!entry || entry.resetAt <= time) {
      entry = { count: 0, resetAt: time + windowMs };
      hits.set(req.ip, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - time) / 1000);
      res.set('Retry-After', String(retryAfter));
      return sendError(res, 429, 'rate_limited', `Too many requests. Try again in ${retryAfter} seconds.`);
    }
    next();
  };
}

module.exports = { createRateLimiter };
