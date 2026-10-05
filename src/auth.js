const { findSession } = require('./sessions');
const { sendError } = require('./errors');

function bearerToken(req) {
  const match = /^Bearer +(\S+)$/i.exec(req.get('Authorization') ?? '');
  return match ? match[1] : null;
}

// Requires a valid demo session bearer token; sets req.session.
function requireSession(pool) {
  return async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const token = bearerToken(req);
    if (!token) {
      res.set('WWW-Authenticate', 'Bearer realm="sandbox"');
      return sendError(res, 401, 'missing_token',
        'Send a demo session token as "Authorization: Bearer <token>".');
    }
    const session = await findSession(pool, token);
    if (!session) {
      // Invalid and expired tokens get the same answer.
      res.set('WWW-Authenticate', 'Bearer realm="sandbox", error="invalid_token"');
      return sendError(res, 401, 'invalid_token',
        'The token is invalid or expired. Create a new demo session.');
    }
    req.session = session;
    next();
  };
}

module.exports = { requireSession };
