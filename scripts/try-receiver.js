// Local test client for the mock receiver.
// Usage (with the app running): npm run receiver:try [-- success|server_error|timeout]
//
// Creates a throwaway demo session in the database, sets its receiver mode, and sends one
// real HTTP delivery per mode to the configured RECEIVER_URL using the delivery client.

const crypto = require('node:crypto');
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db');
const { createSession } = require('../src/sessions');
const { createDeliveryClient } = require('../src/delivery-client');
const { MODES } = require('../src/receiver');

async function main() {
  const config = loadConfig();
  const requested = process.argv.slice(2);
  const modes = requested.length > 0 ? requested : MODES;
  for (const mode of modes) {
    if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}". Use: ${MODES.join(', ')}`);
  }

  const pool = createPool(config.databaseUrl);
  const send = createDeliveryClient(config);
  try {
    const { session } = await createSession(pool, { ttlHours: 1, maxActive: config.maxActiveSessions });
    console.log(`Receiver URL: ${config.receiverUrl}`);
    console.log(`Client timeout: ${config.deliveryTimeoutMs} ms; slow response: ${config.receiverSlowResponseMs} ms\n`);

    for (const mode of modes) {
      await pool.query(
        `INSERT INTO receiver_settings (session_id, mode) VALUES ($1, $2)
         ON CONFLICT (session_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`,
        [session.id, mode]);
      const result = await send({
        sessionId: session.id,
        eventId: crypto.randomUUID(),
        type: 'demo.notification',
        payload: { title: 'Synthetic title', message: 'Synthetic message' },
      });
      const status = result.status ?? '-';
      const detail = result.body?.error ?? result.error ?? (result.body?.received ? 'received' : '');
      console.log(`${mode.padEnd(13)} -> ${result.outcome.padEnd(13)} HTTP ${String(status).padEnd(4)} ${String(result.durationMs).padStart(5)} ms  ${detail}`);
    }

    const { rows: [{ count }] } = await pool.query(
      'SELECT count(*)::int AS count FROM receiver_receipts WHERE session_id = $1', [session.id]);
    console.log(`\nReceipts recorded by the receiver: ${count} (only 'success' processes deliveries)`);
    await pool.query('DELETE FROM demo_sessions WHERE id = $1', [session.id]);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
