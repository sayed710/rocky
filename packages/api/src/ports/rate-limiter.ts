/**
 * @packageDocumentation
 * A port for rate limiting. Abstracting this behind a port allows us to
 * use an in-memory implementation for single-instance deployments or testing,
 * and a Postgres-backed implementation for multi-instance deployments.
 */

export interface RateLimit {
  readonly maxRequests: number;
  readonly windowMs: number;
}

/** One bucket a request must fit into: the key that identifies it and the limit it carries. */
export interface RateLimitRequest {
  readonly key: string;
  readonly limit: RateLimit;
  /**
   * The bucket is a failure budget whose charge may be handed back with `refund` once the request
   * succeeds. An admission returns a {@link RateLimitReservation} for each such bucket.
   */
  readonly refundable?: boolean;
}

/**
 * A charge an admission made to a refundable bucket: its key, and an opaque identity of the window
 * the charge landed in. A refund applies only while that same window is current, so a request that
 * outlives its window cannot hand a slot back to the next one, which other requests have charged.
 */
export interface RateLimitReservation {
  readonly key: string;
  readonly window: string;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /**
   * 0 when allowed, otherwise the number of seconds the client should wait.
   *
   * When several buckets reject at once this is the **longest** of their waits, not the first
   * one found. Anything shorter would be a number the client can act on and still be refused,
   * and the value must not depend on the order the buckets happened to be evaluated in.
   */
  readonly retryAfterSeconds: number;
  /** One per `refundable` bucket charged by an admitted request; absent when there are none. */
  readonly reservations?: readonly RateLimitReservation[];
}

/**
 * Admission control for one request against one or more buckets.
 *
 * The port has a single admission method, and that is the point. Its predecessor exposed
 * `check(key, limit)`, so a route guarded by two buckets had to call it twice — and every such
 * route consumed the first bucket's quota before discovering the second one refused. A caller
 * behind a shared NAT paid their own private quota for requests the IP ceiling never let run.
 * Reversing the order only moves the victim: one abusive account would drain the shared bucket
 * before its own limit stopped it.
 *
 * `admit` takes every bucket at once so the implementation can decide before it commits, and
 * there is deliberately no single-key consuming method left to reach for. Sequential
 * multi-bucket consumption is not something a caller can express any more.
 *
 * The contract, which both implementations are tested against:
 *
 * - **All or nothing.** Either every bucket admits and every one is charged, or none is.
 * - **Atomic.** Two concurrent calls racing for one remaining slot: exactly one wins. There is
 *   no observable window between deciding and committing.
 * - **Rejection is cheap.** A refused request charges nothing anywhere.
 * - **Order-independent.** The answer does not depend on the order of `requests`.
 * - **Distinct keys.** A key may appear at most once. Naming it twice throws.
 *
 * The distinct-key rule replaced a "one unit per entry" rule that read as reasonable and was
 * not order-independent: given `[{k, max: 5}, {k, max: 1}]` the second entry is measured as a
 * cumulative two units against a limit of one and refuses, while `[{k, max: 1}, {k, max: 5}]`
 * admits. Two orderings of one list, two answers, in direct contradiction of the property above
 * it. No caller wants several units of one bucket — a request guarded by two buckets is a
 * different thing from a request costing two — so the case is refused rather than given a
 * policy nobody asked for. Raised in the Qodo review of PR #137.
 *
 * `admit` is the only thing standing between a caller and real work, so a limiter that cannot
 * answer must not be read as one that said yes: an implementation that throws propagates, and
 * the caller fails closed. Raised in the CodeRabbit review of PR #137.
 */
export interface RateLimiter {
  /**
   * Admit a request against every bucket in `requests`, charging one unit to each — or to none.
   *
   * An empty list admits: a route with rate limiting configured off asks for nothing and is
   * refused nothing.
   */
  admit(requests: readonly RateLimitRequest[]): RateLimitResult | Promise<RateLimitResult>;
  /**
   * Hand back the unit each reservation charged, when the request turned out not to be the thing
   * the bucket counts.
   *
   * This exists for failure budgets. Login reserves a slot in its per-handle buckets at admission —
   * so concurrent guesses cannot all slip past a nearly full bucket — and refunds it when the
   * password was right, so a successful login spends none of the budget an attacker would need.
   *
   * A refund applies only while the reservation's window is still current and live; after the
   * window has lapsed or been replaced there is nothing of this request's left to hand back, and
   * the refund does nothing. It never takes a bucket below zero. A refund that faults leaves its
   * slots charged, which fails closed: the budget recovers when the window ends instead of at once.
   */
  refund(reservations: readonly RateLimitReservation[]): void | Promise<void>;
  /**
   * Reset the limit for a given key.
   * Useful for testing or administrative actions.
   */
  reset?(key: string): void | Promise<void>;
}
