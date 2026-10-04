const { createApp } = require('./app');

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
// Hosting platforms such as Render require listening on all interfaces.
const host = process.env.HOST || '0.0.0.0';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}

const server = createApp().listen(port, host, () => {
  console.log(`Listening on http://${host}:${port}`);
});

// Render sends SIGTERM before stopping an instance; finish open requests first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
