// Small in-memory fixed-window rate limiter keyed by client IP.
// Counters reset when the process restarts; good enough for a single instance.

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
      res.set('Retry-After', String(Math.ceil((entry.resetAt - time) / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }
    next();
  };
}

module.exports = { createRateLimiter };
