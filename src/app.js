const path = require('node:path');
const express = require('express');
const { version } = require('../package.json');

function createApp() {
  const app = express();

  // Don't advertise the framework in response headers.
  app.disable('x-powered-by');

  // Liveness check. Express answers HEAD with the GET handler's
  // status and headers but no body.
  app.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', version });
  });

  // Any other method on /health is a wrong-method error, not a missing route.
  app.all('/health', (req, res) => {
    res.set('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'method_not_allowed', allow: ['GET', 'HEAD'] });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Unknown routes get a JSON 404 so it is clear the server is up.
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // Last-resort error handler: log server-side, return a generic message.
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

module.exports = { createApp };
