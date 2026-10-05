// Every error response has the same shape:
//   { "error": "<machine_code>", "message": "<human text>", ...optional details }

function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: code, message, ...extra });
}

function methodNotAllowed(allow) {
  return (req, res) => {
    res.set('Allow', allow.join(', '));
    sendError(res, 405, 'method_not_allowed', `Use ${allow.join(' or ')} for this path.`, { allow });
  };
}

module.exports = { sendError, methodNotAllowed };
