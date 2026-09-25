import type { Clock } from './clock';
import type { RateLimit, RateLimiter, RateLimitRequest, RateLimitResult } from './rate-limiter';

interface Bucket {
  count: number;
  windowStart: number;
  /** windowStart + the limit's windowMs — when this bucket becomes stale. */
  expiresAt: number;
}

/** Sweep expired buckets every this many `admit()` calls. */
const SWEEP_INTERVAL_CALLS = 500;

const ADMITTED: RateLimitResult = { allowed: true, retryAfterSeconds: 0 };

/**
 * A fixed-window rate limiter that stores request counts in memory.
 * Uses an injected Clock to ensure deterministic behavior in tests.
 *
 * Buckets for keys that are never checked again (e.g. one-off IPs) would
 * otherwise accumulate forever. Every {@link SWEEP_INTERVAL_CALLS} calls,
 * `admit()` opportunistically evicts buckets whose window has already
 * lapsed — no timer/lifecycle to manage, safe to call from short-lived
 * processes (tests, the e2e harness) that never explicitly dispose it.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private callsSinceSweep = 0;

  constructor(private readonly clock: Clock) {}

  /**
   * Admit against every bucket, or against none.
   *
   * `admit` is **synchronous**, and that is what makes it atomic here: nothing else runs on this
   * thread between deciding and committing, so there is no window in which a concurrent caller
   * could observe a half-charged request or win a slot this one has already claimed. An `async`
   * signature with an `await` between the two phases would reintroduce exactly the race the port
   * exists to close, so this must stay sync even though the port permits a promise.
   */
  admit(requests: readonly RateLimitRequest[]): RateLimitResult {
    const now = this.clock.now();

    this.callsSinceSweep += 1;
    if (this.callsSinceSweep >= SWEEP_INTERVAL_CALLS) {
      this.callsSinceSweep = 0;
      this.sweep(now);
    }

    if (requests.length === 0) return ADMITTED;

    assertDistinctKeys(requests);

    // Phase 1 — decide. Nothing is written to `this.buckets` in this loop.
    let worstRetry = 0;

    for (const { key, limit } of requests) {
      const effective = this.effectiveCount(key, now);
      if (effective.count + 1 > limit.maxRequests) {
        worstRetry = Math.max(worstRetry, retryAfterFrom(effective.windowStart, limit, now));
      }
    }

    // A rejected request charges nothing. Returning here is the whole invariant: the loop above
    // measured every bucket and wrote to none of them.
    if (worstRetry > 0) return { allowed: false, retryAfterSeconds: worstRetry };

    // Phase 2 — commit. Every bucket admitted, so every bucket is charged.
    for (const { key, limit } of requests) {
      const bucket = this.openBucket(key, now, limit);
      bucket.count += 1;
    }

    return ADMITTED;
  }

  refund(requests: readonly RateLimitRequest[]): void {
    assertDistinctKeys(requests);
    const now = this.clock.now();
    for (const { key } of requests) {
      const bucket = this.buckets.get(key);
      if (bucket && now < bucket.expiresAt && bucket.count > 0) bucket.count -= 1;
    }
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * What `key` currently holds, treating a lapsed window as empty — **without** resetting it.
   *
   * Phase 1 must not touch state. A lapsed window rolled over here and then abandoned because
   * another bucket refused would be a write on the rejection path, and the count it discarded
   * belonged to a window that had not yet been replaced.
   */
  private effectiveCount(key: string, now: number): { count: number; windowStart: number } {
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.expiresAt) return { count: 0, windowStart: now };
    return { count: bucket.count, windowStart: bucket.windowStart };
  }

  /** The live bucket for `key`, rolling a lapsed window over. Commit path only. */
  private openBucket(key: string, now: number, limit: RateLimit): Bucket {
    const bucket = this.buckets.get(key);
    if (bucket && now < bucket.expiresAt) return bucket;
    const fresh: Bucket = { count: 0, windowStart: now, expiresAt: now + limit.windowMs };
    this.buckets.set(key, fresh);
    return fresh;
  }

  /** Remove buckets whose window has already lapsed. */
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.expiresAt) this.buckets.delete(key);
    }
  }

  /** Number of tracked keys (diagnostics/tests). */
  get size(): number {
    return this.buckets.size;
  }
}

/**
 * A key may appear at most once.
 *
 * Two entries for one key with different limits have no order-independent answer — a cumulative
 * demand measured against whichever limit the loop is currently holding gives one result
 * forwards and another backwards. Shared with `PgRateLimiter`, which had the same reversal.
 * Raised in the Qodo review of PR #137.
 */
export function assertDistinctKeys(requests: readonly RateLimitRequest[]): void {
  if (requests.length < 2) return;
  const seen = new Set<string>();
  for (const { key } of requests) {
    if (seen.has(key)) {
      throw new Error(`RateLimiter.admit: duplicate bucket key ${JSON.stringify(key)}`);
    }
    seen.add(key);
  }
}

function retryAfterFrom(windowStart: number, limit: RateLimit, now: number): number {
  const resetMs = windowStart + limit.windowMs - now;
  // At least one second: a caller told to wait zero seconds would retry immediately and be
  // refused again, and `retryAfterSeconds: 0` is the value that means "admitted".
  return Math.max(1, Math.ceil(resetMs / 1000));
}
