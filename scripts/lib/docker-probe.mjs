import { execFileSync } from 'node:child_process';

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 20_000;
const DEFAULT_BUDGET_MS = 90_000;
const DEFAULT_BACKOFF_MS = 2_000;

/** Ask the Docker daemon for its version; throws when the CLI fails or exceeds `timeoutMs`. */
function defaultExec(timeoutMs) {
  execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
}

/** A one-line reason for a failed probe, preferring the daemon's own message. */
function describeFailure(error) {
  if (error && typeof error === 'object') {
    if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') return 'docker info timed out';
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    if (stderr) return stderr.split('\n')[0];
    if (error.message) return String(error.message).split('\n')[0];
  }
  return String(error);
}

/**
 * Probes whether the Docker daemon is reachable, retrying a slow or briefly unavailable daemon.
 *
 * A CI runner's daemon can take several seconds to answer while it is still starting or cleaning up
 * service containers, so a single short `docker info` call reports a healthy daemon as missing.
 * Each attempt gets `attemptTimeoutMs`; attempts stop once `budgetMs` has elapsed.
 *
 * @param {{ attempts?: number, attemptTimeoutMs?: number, budgetMs?: number, backoffMs?: number,
 *   exec?: (timeoutMs: number) => void, now?: () => number,
 *   sleep?: (delayMs: number) => Promise<void>, log?: (message: string) => void }} [options]
 *   Retry policy and dependency overrides used by deterministic tests.
 * @returns {Promise<{ available: true, attempts: number } | { available: false, attempts: number, reason: string }>}
 */
export async function probeDocker(options = {}) {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const exec = options.exec ?? defaultExec;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() + budgetMs;

  let reason = 'no attempt was made';
  let made = 0;
  while (made < attempts) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    made += 1;
    try {
      exec(Math.min(attemptTimeoutMs, remaining));
      return { available: true, attempts: made };
    } catch (error) {
      reason = describeFailure(error);
      options.log?.(`docker probe attempt ${made}/${attempts} failed: ${reason}`);
    }
    if (made < attempts && deadline - now() > backoffMs) await sleep(backoffMs);
  }
  return { available: false, attempts: made, reason };
}
