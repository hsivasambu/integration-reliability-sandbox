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
      const detail = result.body?.error ?? result.error ?? (result.body?.received ? `received (duplicate=${result.body.duplicate})` : '');
      console.log(`${mode.padEnd(20)} -> ${result.outcome.padEnd(13)} HTTP ${String(status).padEnd(4)} ${String(result.durationMs).padStart(5)} ms  ${detail}`);
    }

    const { rows: [{ count }] } = await pool.query(
      'SELECT count(*)::int AS count FROM mock_receiver_receipts WHERE session_id = $1', [session.id]);
    console.log(`\nEvents processed by the receiver: ${count} (success and process_then_timeout process; the others do not)`);

    // Deliver one event twice: the second copy is recognized by its event ID.
    await pool.query("UPDATE receiver_settings SET mode = 'success' WHERE session_id = $1", [session.id]);
    const copy = {
      sessionId: session.id, eventId: crypto.randomUUID(), type: 'demo.notification', payload: { title: 'Duplicate demo' },
    };
    const first = await send(copy);
    const second = await send(copy);
    console.log(`Same event sent twice: duplicate=${first.body.duplicate}, then duplicate=${second.body.duplicate}; `
      + `same result both times: ${first.body.result.confirmationCode === second.body.result.confirmationCode}`);
    await pool.query('DELETE FROM demo_sessions WHERE id = $1', [session.id]);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
