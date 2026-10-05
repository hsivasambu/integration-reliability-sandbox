// Anonymous demo sessions backed by the demo_sessions table.
// The plain token is returned to the caller once and never stored or logged.

const crypto = require('node:crypto');

const TOKEN_PREFIX = 'irs_';
// irs_ + 32 random bytes in base64url (43 characters).
const TOKEN_PATTERN = /^irs_[A-Za-z0-9_-]{43}$/;

function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

// SHA-256 is appropriate here because the token is long and random, unlike a password.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest();
}

class SessionLimitError extends Error {}

async function createSession(pool, { ttlHours, maxActive }) {
  // Only unexpired sessions count toward the cap. Expired ones are removed in bounded batches by
  // the cleanup job (src/maintenance.js), never here, so no in-flight work is deleted mid-request.
  const { rows: [{ count }] } = await pool.query(
    'SELECT count(*)::int AS count FROM demo_sessions WHERE expires_at > now()');
  if (count >= maxActive) throw new SessionLimitError('Too many active demo sessions');

  const token = generateToken();
  const { rows: [row] } = await pool.query(
    `INSERT INTO demo_sessions (token_hash, expires_at)
     VALUES ($1, now() + make_interval(hours => $2))
     RETURNING id, created_at, expires_at`,
    [hashToken(token), ttlHours]);
  return { token, session: row };
}

// Returns the session for a valid, unexpired token, or null.
async function findSession(pool, token) {
  if (!TOKEN_PATTERN.test(token)) return null;
  const { rows } = await pool.query(
    `SELECT id, created_at, expires_at FROM demo_sessions
     WHERE token_hash = $1 AND expires_at > now()`,
    [hashToken(token)]);
  return rows[0] ?? null;
}

module.exports = { createSession, findSession, hashToken, SessionLimitError, TOKEN_PATTERN };
