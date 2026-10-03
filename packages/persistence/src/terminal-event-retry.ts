/** Operational scheduling, independent of moderation policy. No arbitrary failure limit. */
export const TERMINAL_LEASE_MS = 300_000;
export const TERMINAL_RENEW_MS = 60_000;
export const TERMINAL_RENEW_TIMEOUT_MS = 10_000;
export const TERMINAL_RETRY_BASE_MS = 120_000;
export const TERMINAL_RETRY_CAP_MS = 21_600_000;
export const TERMINAL_MAX_FAILURES = 2_147_483_647;

/** Clamp the exponent before exponentiation; even a saturated SQL integer cannot overflow. */
export function terminalRetryDelay(failures: number): number {
  if (!Number.isSafeInteger(failures) || failures < 1) throw new Error('failures must be a positive safe integer');
  return Math.min(TERMINAL_RETRY_CAP_MS, TERMINAL_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 8));
}

/** Keep scheduling safely inside both JS and PostgreSQL timestamp ranges, even with injected time. */
export function terminalDeadline(now: number, delay: number): number {
  const max = 8_640_000_000_000_000;
  if (!Number.isSafeInteger(now) || now < 0 || now > max - TERMINAL_RETRY_CAP_MS) {
    throw new Error('terminal clock is outside the supported timestamp range');
  }
  if (!Number.isSafeInteger(delay) || delay <= 0 || delay > TERMINAL_RETRY_CAP_MS) throw new Error('invalid terminal scheduling delay');
  return now + delay;
}

export function assertTerminalConsumer(consumer: string): void {
  if (consumer !== 'bot-analysis' && consumer !== 'anti-cheat-analysis') throw new Error('unknown terminal consumer');
}
