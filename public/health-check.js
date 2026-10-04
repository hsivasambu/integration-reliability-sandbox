const button = document.getElementById('check');
const result = document.getElementById('result');

button.addEventListener('click', async () => {
  button.disabled = true;
  result.textContent = 'Checking...';
  const started = performance.now();
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    const body = await response.text();
    const ms = Math.round(performance.now() - started);
    result.textContent = `HTTP ${response.status} in ${ms} ms\n${body}`;
  } catch (err) {
    result.textContent = `Could not reach the server: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});
