/**
 * Ownership registry: tracks which gateway node owns each game.
 *
 * Uses a **per-game Redis key** with a real TTL:
 *   SET game:owner:{gameId} {nodeId} NX EX {leaseSec}
 *
 * Redis has no per-hash-field TTL, so a single `game:owners` hash cannot
 * expire individual games. A crashed owner's lease expires when the key's
 * TTL elapses, allowing another node to claim with SET NX EX.
 *
 * Renewal uses a compare-and-expire Lua script (only the current owner
 * refreshes the TTL). Release uses a compare-and-delete Lua script.
 *
 * See ADR-0010 for the design rationale.
 */

import type { Redis } from 'ioredis';
import type { Counter, Gauge, Histogram } from '@chess-platform/api';

/** Result of an ownership claim attempt. */
export type ClaimResult =
  | { readonly owned: true; readonly nodeId: string }
  | { readonly owned: false; readonly ownerNodeId: string };

/** Process-local admission identity, not a durable PostgreSQL fencing token. */
export interface OwnershipTicket {
  readonly gameId: string;
  readonly nodeId: string;
  readonly claimGeneration: number;
}

export type OwnershipCheckFailureReason = 'timeout' | 'error' | 'mismatch' | 'invalidated';

export class OwnershipAttemptExpiredError extends Error {
  constructor() { super('Ownership operation invalidated before claim completed.'); }
}

interface OwnershipLane {
  epoch: number;
  pending: number;
  tail: Promise<void>;
  renewal?: Promise<void>;
}

export interface OwnershipRegistryOptions {
  /** Redis client (the same connection used for pub/sub publish is fine). */
  redis: Redis;
  /** This node's unique identifier. */
  nodeId: string;
  /** Lease TTL in seconds (default 30). */
  leaseTtlSec?: number;
  /** Renewal interval in seconds (default 15). */
  renewalIntervalSec?: number;
  /** Monotonic milliseconds; injectable for deterministic lease schedules. */
  monotonicNow?: () => number;
  /** Optional metric counter for successful ownership claims. */
  claimsCounter?: Counter;
  /** Optional metric counter for ownership releases. */
  releasesCounter?: Counter;
  /** Optional metric counter for lease renewal failures. */
  renewalFailuresCounter?: Counter;
  /** Bounded reason labels only: no game/node/request IDs or raw error messages. */
  ownershipCheckFailuresCounters?: Readonly<Record<OwnershipCheckFailureReason, Counter>>;
  ownershipCheckLatencyHistogram?: Histogram;
  /** Optional metric gauge for owned games count. */
  ownedGamesGauge?: Gauge;
}

const DEFAULT_LEASE_TTL_SEC = 30;
const DEFAULT_RENEWAL_INTERVAL_SEC = 15;

/** Per-game ownership key — real Redis TTL applies. */
export function ownerKey(gameId: string): string {
  return `game:owner:${gameId}`;
}

/** Compare-and-delete: DEL only if the value equals this node. */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Compare-and-expire: EXPIRE only if the value equals this node. */
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

/**
 * Redis-backed ownership registry. Tracks which node owns each game using
 * per-game keys with real TTLs (SET NX EX).
 */
export class OwnershipRegistry {
  private readonly redis: Redis;
  private readonly nodeId: string;
  private readonly leaseTtlSec: number;
  private readonly renewalIntervalSec: number;
  private readonly monotonicNow: () => number;
  private readonly claimsCounter: Counter | undefined;
  private readonly releasesCounter: Counter | undefined;
  private readonly renewalFailuresCounter: Counter | undefined;
  private readonly ownershipCheckFailuresCounters: Readonly<Record<OwnershipCheckFailureReason, Counter>> | undefined;
  private readonly ownershipCheckLatencyHistogram: Histogram | undefined;
  private readonly ownedGamesGauge: Gauge | undefined;
  private readonly ownedGames = new Set<string>();
  /** Per-game monotonic expiration instant (`performance.now() + leaseTtlSec * 1000`). */
  private readonly leaseExpiryMs = new Map<string, number>();
  private readonly claimGeneration = new Map<string, number>();
  private claimSequence = 0;
  private operationSequence = 0;
  private readonly operationLanes = new Map<string, OwnershipLane>();
  private renewalTimer: ReturnType<typeof setInterval> | undefined;
  private onClaimed: ((gameId: string) => void) | undefined;
  private onReleased: ((gameId: string) => void) | undefined;

  constructor(opts: OwnershipRegistryOptions) {
    this.redis = opts.redis;
    this.nodeId = opts.nodeId;
    this.leaseTtlSec = opts.leaseTtlSec ?? DEFAULT_LEASE_TTL_SEC;
    this.renewalIntervalSec = opts.renewalIntervalSec ?? DEFAULT_RENEWAL_INTERVAL_SEC;
    this.monotonicNow = opts.monotonicNow ?? (() => performance.now());

    // Both values come from operator-set env vars, and renewing no more often than the lease
    // lasts is not a tuning choice — it is a broken lease. Every renewal would race the key's
    // own expiry, and the derived safety margin below goes NEGATIVE, which would make
    // holdsValidLease() answer true *after* the lease expired: the split-brain this whole
    // mechanism exists to prevent. Refuse to start instead of serving on arithmetic nobody
    // checked.
    if (this.renewalIntervalSec >= this.leaseTtlSec) {
      throw new Error(
        `OWNERSHIP_RENEWAL_INTERVAL_SEC (${this.renewalIntervalSec}) must be less than ` +
          `OWNERSHIP_LEASE_TTL_SEC (${this.leaseTtlSec}): a lease that expires before it is ` +
          `renewed cannot be held safely, and the fast path would serve past expiry.`,
      );
    }
    this.claimsCounter = opts.claimsCounter;
    this.releasesCounter = opts.releasesCounter;
    this.renewalFailuresCounter = opts.renewalFailuresCounter;
    this.ownershipCheckFailuresCounters = opts.ownershipCheckFailuresCounters;
    this.ownershipCheckLatencyHistogram = opts.ownershipCheckLatencyHistogram;
    this.ownedGamesGauge = opts.ownedGamesGauge;
  }

  /**
   * Safety margin in milliseconds deducted from the recorded lease expiration.
   *
   * WHY DERIVED:
   * Serving commands on an expired lease leads to split-brain (two nodes both believing
   * they are the authority, creating divergent game states and appending conflicting events).
   *
   * The safety margin must cover:
   * 1) At least one missed renewal interval (`renewalIntervalSec * 1000`), so if a single
   *    renewal tick is missed or delayed, the fast path stops before the Redis lease expires.
   * 2) Clock drift between this Node process and the Redis server, plus execution/network latency.
   *
   * Derivation:
   * `slackMs = (leaseTtlSec - renewalIntervalSec) * 1000`.
   * `driftMarginMs` = 1000ms (or scaled down for very small intervals).
   * `safetyMarginMs` = `Math.floor(slackMs / 2) + driftMarginMs`.
   *
   * This guarantees:
   * - Under normal operation with successful renewals every `renewalIntervalSec`, the fast path
   *   remains valid continuously without dropping off before renewal ticks.
   * - When Redis becomes unreachable and renewals fail, the fast path closes closed on its own
   *   well before the key's TTL elapses in Redis, preventing split-brain execution.
   */
  private get safetyMarginMs(): number {
    const slackMs = (this.leaseTtlSec - this.renewalIntervalSec) * 1000;
    const driftMarginMs = Math.min(1000, Math.max(200, Math.floor(this.renewalIntervalSec * 200)));
    // The constructor rejects renewal >= TTL, so slackMs is positive here. The clamp is belt and
    // braces for the one direction that must never happen: a margin at or below zero means the
    // fast path outlives the lease, and a defence-in-depth line is cheap next to split-brain.
    return Math.max(driftMarginMs, Math.floor(slackMs / 2) + driftMarginMs);
  }

  /**
   * Optional hooks: called when this node newly claims or releases a game.
   * Used by the command router to start/stop the owner consumer loop.
   */
  setHooks(hooks: {
    onClaimed?: (gameId: string) => void;
    onReleased?: (gameId: string) => void;
  }): void {
    this.onClaimed = hooks.onClaimed;
    this.onReleased = hooks.onReleased;
  }

  /**
   * Extend this node's lease on `gameId` in Redis, compare-and-expire so another node's key is
   * never touched. Returns whether we still hold it afterwards.
   *
   * Shared by the renewal timer and by `claim()`'s "we already hold the key" branches, so that
   * every path which refreshes the LOCAL expiry has first refreshed the REAL one. Those two must
   * not drift apart: the local record is what the router's fast path trusts.
   */
  private async renewLease(gameId: string): Promise<boolean> {
    const renewed = await this.redis.eval(
      RENEW_LUA,
      1,
      ownerKey(gameId),
      this.nodeId,
      String(this.leaseTtlSec),
    );
    return !(renewed === 0 || renewed === '0');
  }

  /**
   * Try to claim ownership of `gameId`. If successful, this node is the
   * owner. If another node already owns it (and the lease hasn't expired),
   * returns the owner's node ID.
   */
  async claim(gameId: string): Promise<ClaimResult> {
    const lane = this.operationLane(gameId), epoch = lane.epoch;
    const assertCurrent = (): void => {
      if (lane.epoch !== epoch) throw new OwnershipAttemptExpiredError();
    };
    return this.enqueueOperation(gameId, lane, async () => {
      assertCurrent();
      const result = await this.claimNow(gameId, assertCurrent);
      assertCurrent();
      return result;
    });
  }

  private async claimNow(gameId: string, assertCurrent: () => void): Promise<ClaimResult> {
    // An expired local generation cannot be renewed into continuity while a new
    // claim acknowledgement is pending. New intents must acquire a new ticket.
    if (!this.holdsValidLease(gameId)) this.invalidateTicket(gameId);
    const generation = this.claimGeneration.get(gameId);
    const startedAt = this.monotonicNow();
    const markRenewed = (): void => this.markClaimed(gameId, {
      // Only the same still-valid generation observed at dispatch is continuous.
      // Another pending claim or expiry must establish a fresh identity and debt.
      newClaim: this.claimGeneration.get(gameId) !== generation || !this.holdsValidLease(gameId),
      startedAt,
    });
    const key = ownerKey(gameId);
    // SET NX EX — atomic claim with a real key-level TTL.
    const set = await this.redis.set(key, this.nodeId, 'EX', this.leaseTtlSec, 'NX');
    assertCurrent();
    if (set === 'OK') {
      this.markClaimed(gameId, { newClaim: true, startedAt });
      return { owned: true, nodeId: this.nodeId };
    }

    // Another node owns it — or we already own it (SET NX fails if key exists).
    const ownerNodeId = await this.redis.get(key);
    assertCurrent();
    if (ownerNodeId === this.nodeId) {
      // We hold the key, but `SET NX` failed precisely because it exists, so nothing refreshed
      // its TTL — it may be milliseconds from expiring. `markClaimed()` records a FULL lease
      // locally, and the router's fast path then trusts that recording without asking Redis
      // again. Recording a full lease on a nearly-dead key is how this node ends up serving
      // after another node has taken the game: split-brain. Extend the key first, and only
      // treat ourselves as the owner if that succeeded.
      if (await this.renewLease(gameId)) {
        assertCurrent();
        markRenewed();
        return { owned: true, nodeId: this.nodeId };
      }
      return { owned: false, ownerNodeId: (await this.redis.get(key)) ?? 'unknown' };
    }
    if (!ownerNodeId) {
      // Race: key expired between SET NX and GET. Retry once.
      const retry = await this.redis.set(key, this.nodeId, 'EX', this.leaseTtlSec, 'NX');
      assertCurrent();
      if (retry === 'OK') {
        this.markClaimed(gameId, { newClaim: true, startedAt });
        return { owned: true, nodeId: this.nodeId };
      }
      const retryOwner = await this.redis.get(key);
      assertCurrent();
      if (retryOwner === this.nodeId) {
        // Same reasoning as the branch above: the key exists and is ours, but its TTL was not
        // refreshed by the failed SET NX.
        if (await this.renewLease(gameId)) {
          assertCurrent();
          markRenewed();
          return { owned: true, nodeId: this.nodeId };
        }
        return { owned: false, ownerNodeId: (await this.redis.get(key)) ?? 'unknown' };
      }
      return { owned: false, ownerNodeId: retryOwner ?? 'unknown' };
    }
    return { owned: false, ownerNodeId };
  }

  /**
   * Record a lease this node now holds. `newClaim` means SET NX created the key or claim I/O
   * could not preserve the original local generation. An invalidated generation also establishes
   * new identity even if the game never left `ownedGames`, so onClaimed records reload debt.
   * Only a continuously valid renewal preserves identity; this is not durable fencing.
   */
  private markClaimed(gameId: string, { newClaim = false, startedAt }: { newClaim?: boolean; startedAt: number }): void {
    const wasNew = newClaim || !this.ownedGames.has(gameId) || !this.claimGeneration.has(gameId);
    this.ownedGames.add(gameId);
    // Record monotonic instant (performance.now()) when the lease expires in Redis.
    // performance.now() is monotonic and immune to NTP system clock adjustments.
    // Start at dispatch, not reply: delayed Redis acknowledgements cannot extend local expiry.
    this.leaseExpiryMs.set(gameId, startedAt + this.leaseTtlSec * 1000);
    if (wasNew) {
      this.claimGeneration.set(gameId, ++this.claimSequence);
      this.claimsCounter?.inc();
      this.ownedGamesGauge?.set(this.ownedGames.size);
      this.onClaimed?.(gameId);
    }
  }

  /**
   * Check whether this node currently holds a valid local lease for `gameId`.
   *
   * Returns true ONLY if:
   * 1. This node locally tracks ownership of `gameId`.
   * 2. Monotonic current time (`performance.now()`) is strictly less than the recorded
   *    expiry instant minus the conservative safety margin.
   *
   * When Redis is unreachable, renewals fail, expiry stops advancing, and this predicate
   * turns false automatically as the lease ages out — closing the fast path and failing closed.
   */
  holdsValidLease(gameId: string): boolean {
    if (!this.ownedGames.has(gameId)) return false;
    const expiresAt = this.leaseExpiryMs.get(gameId);
    if (expiresAt === undefined) return false;
    return this.monotonicNow() < expiresAt - this.safetyMarginMs;
  }

  captureTicket(gameId: string): OwnershipTicket | undefined {
    const generation = this.claimGeneration.get(gameId);
    if (generation === undefined || !this.holdsValidLease(gameId)) return undefined;
    return Object.freeze({ gameId, nodeId: this.nodeId, claimGeneration: generation });
  }

  isTicketCurrent(ticket: OwnershipTicket): boolean {
    return ticket.nodeId === this.nodeId &&
      this.claimGeneration.get(ticket.gameId) === ticket.claimGeneration &&
      this.holdsValidLease(ticket.gameId);
  }

  /** Bounded, isolated, non-renewing validation. Late replies never revive an attempt. */
  async validateTicket(ticket: OwnershipTicket, timeoutMs = 1000): Promise<boolean> {
    const refuse = (reason: OwnershipCheckFailureReason): false => {
      this.ownershipCheckFailuresCounters?.[reason].inc();
      return false;
    };
    if (!this.isTicketCurrent(ticket)) return refuse('invalidated');
    const startedAt = this.monotonicNow();
    let conn: Redis | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const comparisonConn = this.redis.duplicate({ lazyConnect: true, enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false, maxRetriesPerRequest: 0,
        retryStrategy: () => null, connectTimeout: timeoutMs, commandTimeout: timeoutMs });
      conn = comparisonConn;
      comparisonConn.on('error', () => undefined);
      const compare = (async () => {
        await comparisonConn.connect();
        return await comparisonConn.get(ownerKey(ticket.gameId)) === ticket.nodeId;
      })();
      const deadline = new Promise<boolean>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(false); }, timeoutMs); });
      const matches = await Promise.race([compare, deadline]);
      if (!matches) return refuse(timedOut ? 'timeout' : 'mismatch');
      return this.isTicketCurrent(ticket) || refuse('invalidated');
    } catch (err) {
      return refuse(err instanceof Error && /timed out|timeout|ETIMEDOUT/i.test(err.message) ? 'timeout' : 'error');
    } finally {
      if (timer) clearTimeout(timer);
      conn?.disconnect();
      this.ownershipCheckLatencyHistogram?.observe(Math.max(0, this.monotonicNow() - startedAt) / 1000);
    }
  }

  /**
   * Check who owns `gameId` without attempting to claim. Returns null if
   * no node owns it (or the lease has expired).
   */
  async getOwner(gameId: string): Promise<string | null> {
    return this.redis.get(ownerKey(gameId));
  }

  /** Check whether this node owns `gameId`. */
  async isOwner(gameId: string): Promise<boolean> {
    const owner = await this.redis.get(ownerKey(gameId));
    return owner === this.nodeId;
  }

  /**
   * Release ownership of `gameId`. Compare-and-delete so we never delete
   * another node's claim. Called during graceful shutdown.
   */
  async release(gameId: string): Promise<void> {
    const lane = this.operationLane(gameId);
    // Epoch changes even when the ticket is already absent after local expiry.
    lane.epoch = ++this.operationSequence;
    // Invalidate before I/O so a queued command cannot be admitted during release.
    this.forgetClaim(gameId);
    await this.enqueueOperation(gameId, lane, async () => {
      await this.redis.eval(RELEASE_LUA, 1, ownerKey(gameId), this.nodeId);
    });
  }

  private operationLane(gameId: string): OwnershipLane {
    let lane = this.operationLanes.get(gameId);
    if (!lane) {
      lane = { epoch: ++this.operationSequence, pending: 0, tail: Promise.resolve() };
      this.operationLanes.set(gameId, lane);
    }
    return lane;
  }

  /** Lease I/O ordering is independent of the authority slot; hooks never await hydration. */
  private enqueueOperation<T>(gameId: string, lane: OwnershipLane, operation: () => Promise<T>): Promise<T> {
    lane.pending++;
    const result = lane.tail.then(operation);
    lane.tail = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      lane.pending--;
      if (lane.pending === 0 && this.operationLanes.get(gameId) === lane) this.operationLanes.delete(gameId);
    });
  }

  private forgetClaim(gameId: string): void {
    this.invalidateTicket(gameId);
    if (this.ownedGames.delete(gameId)) {
      this.releasesCounter?.inc();
      this.ownedGamesGauge?.set(this.ownedGames.size);
      this.onReleased?.(gameId);
    }
  }

  /** End admission continuity without stranding requests routed to an extant Redis key. */
  private invalidateTicket(gameId: string): void {
    this.claimGeneration.delete(gameId);
    this.leaseExpiryMs.delete(gameId);
  }

  /** Release all owned games. Called during graceful shutdown. */
  async releaseAll(): Promise<void> {
    const games = [...this.ownedGames];
    for (const gameId of games) {
      await this.release(gameId);
    }
    this.ownedGamesGauge?.set(0);
  }

  /**
   * Start the lease renewal loop. The owner periodically refreshes the TTL
   * for all its owned games so the lease doesn't expire while it's alive.
   */
  startRenewal(): void {
    if (this.renewalTimer) return;
    this.renewalTimer = setInterval(() => {
      void this.renewAll();
    }, this.renewalIntervalSec * 1000);
    this.renewalTimer.unref?.();
  }

  /** Stop the lease renewal loop. */
  stopRenewal(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = undefined;
    }
  }

  /** Number of games this node currently owns (diagnostics). */
  get ownedCount(): number {
    return this.ownedGames.size;
  }

  /** Snapshot of game IDs this process believes it owns (local set). */
  get ownedGameIds(): readonly string[] {
    return [...this.ownedGames];
  }

  /**
   * Renew the lease for all owned games via compare-and-expire. If we no
   * longer own a key (lost the race / lease stolen), drop it from the local set.
   */
  private async renewAll(): Promise<void> {
    await Promise.all([...this.ownedGames].map(gameId => this.renewGame(gameId)));
  }

  private renewGame(gameId: string): Promise<void> {
    const lane = this.operationLane(gameId), epoch = lane.epoch;
    if (lane.renewal) return lane.renewal;
    const renewal = this.enqueueOperation(gameId, lane, async () => {
      if (lane.epoch !== epoch || !this.ownedGames.has(gameId)) return;
      await this.renewOwnedGame(gameId, lane, epoch);
    });
    lane.renewal = renewal;
    return renewal.finally(() => { if (lane.renewal === renewal) lane.renewal = undefined; });
  }

  private async renewOwnedGame(gameId: string, lane: OwnershipLane, epoch: number): Promise<void> {
    if (!this.holdsValidLease(gameId)) this.invalidateTicket(gameId);
    const generation = this.claimGeneration.get(gameId);
    const startedAt = this.monotonicNow();
    try {
      const stillOurs = await this.renewLease(gameId);
      // A release is visible even when both ticket generations would be absent.
      if (lane.epoch !== epoch || this.claimGeneration.get(gameId) !== generation || !this.ownedGames.has(gameId)) return;
      if (!this.holdsValidLease(gameId)) this.invalidateTicket(gameId);
      if (!stillOurs) {
        this.leaseExpiryMs.delete(gameId);
        this.claimGeneration.delete(gameId);
        if (this.ownedGames.delete(gameId)) {
          this.ownedGamesGauge?.set(this.ownedGames.size);
          this.onReleased?.(gameId);
        }
      } else {
        this.markClaimed(gameId, { startedAt });
      }
    } catch (err) {
      // Keep possibly owned keys, but never extend expiry on failed I/O.
      this.renewalFailuresCounter?.inc();
      console.error(`[OwnershipRegistry] renewal failed for ${gameId}:`, err);
    }
  }
}
