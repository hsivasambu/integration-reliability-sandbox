// Retry policy: the one place that decides what a delivery attempt's result means.
//
//   Result                                   Retry?
//   2xx                                      no (delivered)
//   timeout, connection/transport failure    yes
//   HTTP 408, 429, 5xx                       yes
//   any other HTTP status (e.g. 400, 404)    no (terminal for this demo)
//
// Delays are deterministic: base × 2^(attempt − 1), i.e. 2 s, 4 s, 8 s with the default base.
// Retry-After response headers are not honoured yet.

function isRetryable(result) {
  switch (result.outcome) {
    case 'timeout':
    case 'network_error':
      return true;
    case 'http_error':
      return result.status === 408 || result.status === 429 || result.status >= 500;
    default:
      return false;
  }
}

function retryDelayMs(attemptNumber, baseDelayMs) {
  return baseDelayMs * 2 ** (attemptNumber - 1);
}

// Decides the delivery's next state after attempt `attemptNumber` produced `result`.
function decideAfterAttempt(result, attemptNumber, { maxAttempts, baseDelayMs }) {
  if (result.outcome === 'delivered') {
    return { state: 'delivered', outcome: 'delivered', errorCategory: null, retryable: null };
  }
  const failed = { outcome: 'failed', errorCategory: result.outcome, retryable: isRetryable(result) };
  if (!failed.retryable) return { ...failed, state: 'failed', failureReason: 'non_retryable' };
  if (attemptNumber >= maxAttempts) return { ...failed, state: 'failed', failureReason: 'attempts_exhausted' };
  return { ...failed, state: 'retry_scheduled', retryDelayMs: retryDelayMs(attemptNumber, baseDelayMs) };
}

module.exports = { isRetryable, retryDelayMs, decideAfterAttempt };
