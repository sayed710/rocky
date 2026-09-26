/**
 * @packageDocumentation
 * Server-authoritative pregame no-show expiry (ADR-0148).
 *
 * A seek or tournament game records its no-show deadline on `GameCreated`. If it has no first move
 * by then, the server ends it, with nobody connected. Nothing here keeps a timer per game: every pass
 * reads the due entries of `pregame_deadlines` (kept in step with the event log by a trigger),
 * re-decides each from the durable log, and routes `expireNoShow` to the game's owner like any other
 * command. The owner checks the game's own durable deadline; the worker supplies none.
 *
 * Why the guarantees hold:
 * - **Once only, never over a first move.** The owner applies the command under the game's command
 *   lock, where the domain refuses it unless the game is ongoing with no move played, and the event
 *   log's `expectedSeq` check rejects any append made from a copy that missed a concurrent write. A
 *   player command that reaches the owner after the deadline records the no-show itself, so a late
 *   worker never changes the outcome.
 * - **Safe on every replica.** Two workers deciding the same game both route to its single owner;
 *   the second finds it over. Even a split-brain owner loses at the log's sequence check.
 * - **Durable and restartable.** The worker holds no state that correctness depends on, so a crash
 *   before the append is retried by the next pass, one after it finds the entry gone (the ending
 *   removed it), and a restart catches up on every overdue game at once.
 */

import { Game } from '@chess-platform/game';
import {
  NO_SHOW_ACTOR,
  type CommandRouter,
  type EventLog,
  type GameAuthority,
} from '@chess-platform/realtime-gateway';
import type { Counter, Logger } from '@chess-platform/api';
import type { NoShowCandidate, NoShowCandidateQuery, NoShowCursor } from '@chess-platform/persistence/pg';

export interface NoShowCandidateSource {
  due(query: NoShowCandidateQuery): Promise<NoShowCandidate[]>;
  /** Remove a game the log shows will never expire. */
  dismiss(gameId: string): Promise<void>;
}

/** Ends one game by the no-show rule on its owner; see {@link routedNoShowExpiry}. */
export type ExpireNoShow = (gameId: string) => Promise<void>;

export interface NoShowExpiryWorkerOptions {
  readonly candidates: NoShowCandidateSource;
  /** The durable event log, which decides every candidate. */
  readonly events: Pick<EventLog, 'load'>;
  readonly expire: ExpireNoShow;
  /** Delay between passes once nothing more is due (default 5 s). */
  readonly pollMs?: number;
  /** Candidates read per pass (default 50). */
  readonly pageSize?: number;
  /** Ceiling for the delay after consecutive failed passes (default 60 s). */
  readonly maxBackoffMs?: number;
  readonly now?: () => number;
  readonly logger?: Logger;
  readonly expiredCounter?: Counter;
  readonly failuresCounter?: Counter;
}

export interface NoShowPass {
  readonly scanned: number;
  readonly expired: number;
  readonly dismissed: number;
  readonly failed: number;
  /** The page was full, so more due games are probably waiting. */
  readonly more: boolean;
}

export class NoShowExpiryWorker {
  private readonly pollMs: number;
  private readonly pageSize: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private cursor: NoShowCursor | null = null;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private consecutiveErrors = 0;

  constructor(private readonly options: NoShowExpiryWorkerOptions) {
    this.pollMs = options.pollMs ?? 5_000;
    this.pageSize = options.pageSize ?? 50;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Start passing immediately, so games that became overdue while no process ran end at once. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stop scheduling and wait for an in-flight pass, including its routed commands, to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /**
   * One bounded pass: a page of due entries after the rotating cursor. Settled entries leave the
   * queue (an ending removes its entry; a game that will never expire is dismissed), so what stays
   * is only what failed. The cursor moves past failures, so a game that keeps failing cannot starve
   * the ones behind it; it comes round again when a short page resets the cursor.
   */
  async runPass(): Promise<NoShowPass> {
    const page = await this.options.candidates.due({
      dueBy: new Date(this.now()),
      after: this.cursor,
      limit: this.pageSize,
    });
    const more = page.length === this.pageSize;
    const last = page.at(-1);
    this.cursor = more && last ? { dueAt: last.dueAt, gameId: last.gameId } : null;

    let expired = 0;
    let dismissed = 0;
    let failed = 0;
    for (const candidate of page) {
      try {
        const outcome = await this.settle(candidate.gameId);
        if (outcome === 'expired') expired += 1;
        if (outcome === 'dismissed') dismissed += 1;
      } catch (error) {
        failed += 1;
        this.options.failuresCounter?.inc();
        this.options.logger?.error('No-show expiry failed for a game; it is retried on a later pass', {
          gameId: candidate.gameId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { scanned: page.length, expired, dismissed, failed, more };
  }

  /** Decide one game from its durable log: expire it, dismiss it, or leave it for a later pass. */
  private async settle(gameId: string): Promise<'expired' | 'dismissed' | 'waiting'> {
    const logged = await this.options.events.load(gameId);
    if (logged.length === 0) return 'waiting';
    const verdict = Game.fromEvents(logged.map((entry) => entry.event)).noShowVerdict(this.now());
    switch (verdict.kind) {
      case 'expire':
        await this.options.expire(gameId);
        this.options.expiredCounter?.inc();
        return 'expired';
      case 'both_ready':
      case 'not_applicable':
        // Readiness never reverts, and a started or ended game never needs a no-show again.
        await this.options.candidates.dismiss(gameId);
        return 'dismissed';
      case 'not_due':
        return 'waiting';
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick().finally(() => {
        this.running = undefined;
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let pass: NoShowPass;
    try {
      pass = await this.runPass();
    } catch (error) {
      // The candidate query itself failed (database unreachable): back off instead of spinning.
      this.consecutiveErrors += 1;
      this.options.logger?.error('No-show expiry pass failed; retrying with backoff', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.schedule(Math.min(this.maxBackoffMs, this.pollMs * 2 ** this.consecutiveErrors));
      return;
    }
    this.consecutiveErrors = 0;
    // A full page of games that all failed is not progress; pausing keeps a stuck page from spinning.
    const progressed = pass.expired + pass.dismissed > 0;
    this.schedule(pass.more && progressed ? 0 : this.pollMs);
  }
}

/** Multi-node ownership, as `OwnershipRegistry` provides it. Absent on a single node. */
export interface NoShowOwnership {
  holdsValidLease(gameId: string): boolean;
  release(gameId: string): Promise<void>;
}

export interface RoutedNoShowExpiryOptions {
  readonly authority: GameAuthority;
  readonly router: CommandRouter;
  readonly ownership?: NoShowOwnership;
  /** Whether a player or spectator on this replica is in the game's room. */
  readonly hasLocalSessions: (gameId: string) => boolean;
}

/**
 * Route `expireNoShow` to the game's owner, exactly like a player's command.
 *
 * Expiring a game nobody on this replica is watching should leave nothing behind: when the game has
 * ended, a lease claimed only for the expiry is released (freeing its command consumer), and a copy
 * loaded only for it is evicted from the authority cache. Either is re-created on demand — a later
 * command claims again with a takeover reload, and a later join reloads from the log — so letting go
 * can delay a racing command but never lose one.
 */
export function routedNoShowExpiry(options: RoutedNoShowExpiryOptions): ExpireNoShow {
  const { authority, router, ownership, hasLocalSessions } = options;
  return async (gameId) => {
    const loadedForExpiry = !authority.has(gameId);
    const claimedForExpiry = ownership !== undefined && !ownership.holdsValidLease(gameId);
    if (!(await authority.ensureLoaded(gameId))) return;
    try {
      await router.route(gameId, NO_SHOW_ACTOR, { kind: 'expireNoShow' });
    } finally {
      if (!hasLocalSessions(gameId)) {
        // Only the owner's own copy can show the ending; a lease is let go only once it does.
        const ended = authority.hasFresh(gameId) && authority.getState(gameId).status.over;
        if (ended && claimedForExpiry && ownership.holdsValidLease(gameId)) await ownership.release(gameId);
        if (loadedForExpiry) authority.evict(gameId);
      }
    }
  };
}
