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
import type { Counter, Gauge } from '@chess-platform/api';

/** Result of an ownership claim attempt. */
export type ClaimResult =
  | { readonly owned: true; readonly nodeId: string }
  | { readonly owned: false; readonly ownerNodeId: string };

export interface OwnershipRegistryOptions {
  /** Redis client (the same connection used for pub/sub publish is fine). */
  redis: Redis;
  /** This node's unique identifier. */
  nodeId: string;
  /** Lease TTL in seconds (default 30). */
  leaseTtlSec?: number;
  /** Renewal interval in seconds (default 15). */
  renewalIntervalSec?: number;
  /** Optional metric counter for successful ownership claims. */
  claimsCounter?: Counter;
  /** Optional metric counter for ownership releases. */
  releasesCounter?: Counter;
  /** Optional metric counter for lease renewal failures. */
  renewalFailuresCounter?: Counter;
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
  private readonly claimsCounter: Counter | undefined;
  private readonly releasesCounter: Counter | undefined;
  private readonly renewalFailuresCounter: Counter | undefined;
  private readonly ownedGamesGauge: Gauge | undefined;
  private readonly ownedGames = new Set<string>();
  /** Per-game monotonic expiration instant (`performance.now() + leaseTtlSec * 1000`). */
  private readonly leaseExpiryMs = new Map<string, number>();
  private renewalTimer: ReturnType<typeof setInterval> | undefined;
  private onClaimed: ((gameId: string) => void) | undefined;
  private onReleased: ((gameId: string) => void) | undefined;

  constructor(opts: OwnershipRegistryOptions) {
    this.redis = opts.redis;
    this.nodeId = opts.nodeId;
    this.leaseTtlSec = opts.leaseTtlSec ?? DEFAULT_LEASE_TTL_SEC;
    this.renewalIntervalSec = opts.renewalIntervalSec ?? DEFAULT_RENEWAL_INTERVAL_SEC;

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
    const key = ownerKey(gameId);
    // SET NX EX — atomic claim with a real key-level TTL.
    const set = await this.redis.set(key, this.nodeId, 'EX', this.leaseTtlSec, 'NX');
    if (set === 'OK') {
      this.markClaimed(gameId, { keyWasFree: true });
      return { owned: true, nodeId: this.nodeId };
    }

    // Another node owns it — or we already own it (SET NX fails if key exists).
    const ownerNodeId = await this.redis.get(key);
    if (ownerNodeId === this.nodeId) {
      // We hold the key, but `SET NX` failed precisely because it exists, so nothing refreshed
      // its TTL — it may be milliseconds from expiring. `markClaimed()` records a FULL lease
      // locally, and the router's fast path then trusts that recording without asking Redis
      // again. Recording a full lease on a nearly-dead key is how this node ends up serving
      // after another node has taken the game: split-brain. Extend the key first, and only
      // treat ourselves as the owner if that succeeded.
      if (await this.renewLease(gameId)) {
        this.markClaimed(gameId);
        return { owned: true, nodeId: this.nodeId };
      }
      return { owned: false, ownerNodeId: (await this.redis.get(key)) ?? 'unknown' };
    }
    if (!ownerNodeId) {
      // Race: key expired between SET NX and GET. Retry once.
      const retry = await this.redis.set(key, this.nodeId, 'EX', this.leaseTtlSec, 'NX');
      if (retry === 'OK') {
        this.markClaimed(gameId, { keyWasFree: true });
        return { owned: true, nodeId: this.nodeId };
      }
      const retryOwner = await this.redis.get(key);
      if (retryOwner === this.nodeId) {
        // Same reasoning as the branch above: the key exists and is ours, but its TTL was not
        // refreshed by the failed SET NX.
        if (await this.renewLease(gameId)) {
          this.markClaimed(gameId);
          return { owned: true, nodeId: this.nodeId };
        }
        return { owned: false, ownerNodeId: (await this.redis.get(key)) ?? 'unknown' };
      }
      return { owned: false, ownerNodeId: retryOwner ?? 'unknown' };
    }
    return { owned: false, ownerNodeId };
  }

  /**
   * Record a lease this node now holds. `keyWasFree` means `SET NX` created the key: whatever this
   * node believed, its previous lease had lapsed, and another node may have owned and advanced the
   * game in between. That is a new claim even if the game never left `ownedGames` — a renewal that
   * threw keeps it there on purpose (see `renewAll`) — so `onClaimed` must fire and the router must
   * reload. Renewing a key this node still holds is continuous ownership and is not new.
   */
  private markClaimed(gameId: string, { keyWasFree = false }: { keyWasFree?: boolean } = {}): void {
    const wasNew = keyWasFree || !this.ownedGames.has(gameId);
    this.ownedGames.add(gameId);
    // Record monotonic instant (performance.now()) when the lease expires in Redis.
    // performance.now() is monotonic and immune to NTP system clock adjustments.
    this.leaseExpiryMs.set(gameId, performance.now() + this.leaseTtlSec * 1000);
    if (wasNew) {
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
    return performance.now() < expiresAt - this.safetyMarginMs;
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
    const key = ownerKey(gameId);
    await this.redis.eval(RELEASE_LUA, 1, key, this.nodeId);
    this.leaseExpiryMs.delete(gameId);
    if (this.ownedGames.delete(gameId)) {
      this.releasesCounter?.inc();
      this.ownedGamesGauge?.set(this.ownedGames.size);
      this.onReleased?.(gameId);
    }
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
    for (const gameId of [...this.ownedGames]) {
      try {
        const stillOurs = await this.renewLease(gameId);
        if (!stillOurs) {
          // Lost ownership — another node claimed after our key expired.
          this.leaseExpiryMs.delete(gameId);
          if (this.ownedGames.delete(gameId)) {
            this.ownedGamesGauge?.set(this.ownedGames.size);
            this.onReleased?.(gameId);
          }
        } else {
          // SUCCESSFUL renewal: refresh the recorded monotonic lease expiration timestamp.
          this.markClaimed(gameId);
        }
      } catch (err) {
        // Renewal error (e.g., Redis is down or unreachable).
        // Increment the renewal failures metric.
        // CRITICAL SAFETY PROPERTY: Keep the game in `ownedGames` (the Redis key might still be running),
        // but DO NOT update `leaseExpiryMs`. A failed renewal MUST NOT extend local expiry.
        // As time advances, `holdsValidLease()` will age out and return false, closing the fast path.
        this.renewalFailuresCounter?.inc();
        console.error(`[OwnershipRegistry] renewal failed for ${gameId}:`, err);
      }
    }
  }
}
