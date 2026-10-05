// Sends one delivery to the mock receiver over real HTTP.
// The destination comes only from server configuration; callers cannot choose a URL.

const MAX_RESPONSE_CHARS = 2000;

// Returns { outcome, status?, durationMs, body?, error? } where outcome is one of:
//   delivered      receiver answered 2xx
//   http_error     receiver answered, but not 2xx (e.g. 503)
//   timeout        no complete answer within timeoutMs; the request was aborted
//   network_error  connection failed, or a redirect was refused
function createDeliveryClient({ receiverUrl, receiverSecret, deliveryTimeoutMs }) {
  return async function sendDelivery(delivery) {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const response = await fetch(receiverUrl, {
        method: 'POST',
        redirect: 'error', // never follow a redirect to some other destination
        signal: AbortSignal.timeout(deliveryTimeoutMs),
        headers: {
          Authorization: `Bearer ${receiverSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(delivery),
      });
      const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return {
        outcome: response.ok ? 'delivered' : 'http_error',
        status: response.status,
        durationMs: elapsed(),
        body,
      };
    } catch (err) {
      if (err.name === 'TimeoutError') {
        return { outcome: 'timeout', durationMs: elapsed(), error: `no response within ${deliveryTimeoutMs} ms` };
      }
      return { outcome: 'network_error', durationMs: elapsed(), error: err.cause?.message ?? err.message };
    }
  };
}

module.exports = { createDeliveryClient };
