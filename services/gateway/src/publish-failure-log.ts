/**
 * Throttled reporting of failed Redis publishes (Qodo #7, PR #119).
 *
 * Redis Pub/Sub is best-effort: a failed publish loses that broadcast for other nodes. This module
 * only makes the failure visible; it is not a delivery or recovery mechanism.
 */

/** Diagnostic log throttle only; not a delivery mechanism. */
export const PUBLISH_FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * Returns a listener for `PubSub.onPublishFailed` that reports at most one failure per channel per
 * interval. Entries older than the interval are pruned on every call, so the map holds only
 * channels that failed within the last interval.
 */
export function createPublishFailureLogger(
  warn: (channel: string) => void,
  now: () => number = () => Date.now(),
  intervalMs: number = PUBLISH_FAILURE_LOG_INTERVAL_MS,
): ((channel: string) => void) & { readonly trackedChannels: () => number } {
  const lastReported = new Map<string, number>();
  const listener = (channel: string): void => {
    const at = now();
    for (const [tracked, reportedAt] of lastReported) {
      if (at - reportedAt >= intervalMs) lastReported.delete(tracked);
    }
    if (lastReported.has(channel)) return;
    lastReported.set(channel, at);
    warn(channel);
  };
  return Object.assign(listener, { trackedChannels: () => lastReported.size });
}
