const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Polls a health URL until it returns HTTP 2xx or the deadline elapses.
 *
 * @param {string} url - The health-check URL to poll.
 * @param {string} name - Human-readable service name for log and error messages.
 * @param {{ timeoutMs?: number, pollInterval?: number, now?: () => number,
 *   fetch?: typeof globalThis.fetch, sleep?: (delayMs: number) => Promise<void>,
 *   log?: (message: string) => void }} [options]
 *   Deadline and dependency overrides used by deterministic tests.
 * @returns {Promise<true>} Resolves when the service is healthy.
 * @throws {Error} When the service does not become healthy within the configured timeout.
 */
export async function waitForHealth(url, name, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const fetchHealth = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    try {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const response = await fetchHealth(url, { signal: AbortSignal.timeout(remaining) });
      if (response.ok) {
        options.log?.(`✓ ${name} healthy`);
        return true;
      }
    } catch {
      // The service is not ready yet; retry while time remains.
    }

    const delay = Math.max(0, Math.min(pollInterval, deadline - now()));
    if (delay > 0) await sleep(delay);
  }

  throw new Error(`✗ ${name} did not become healthy within ${timeoutMs / 1000}s`);
}
