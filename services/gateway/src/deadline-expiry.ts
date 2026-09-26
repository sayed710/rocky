/**
 * @packageDocumentation
 * The shared machinery of the server's durable deadline workers: pregame no-show (ADR-0148) and
 * in-play flag expiry (ADR-0149).
 *
 * Nothing here keeps a timer per game. Every pass reads one page of due entries from a queue that a
 * `game_events` trigger keeps in step with the log, lets the rule-specific `settle` re-decide each
 * from the durable log, and routes the expiry command to the game's owner like any player command.
 * Correctness comes from the owner's command lock and the log's `expectedSeq` check, never from this
 * loop, so it runs on every replica and holds no state a restart could lose.
 */

import type { Command, CommandRouter, GameAuthority } from '@chess-platform/realtime-gateway';
import type { Counter, Logger } from '@chess-platform/api';
import type { DeadlineCandidate, DeadlineCandidateQuery, DeadlineCursor } from '@chess-platform/persistence/pg';

/** A queue of games by deadline, read one keyset page at a time. */
export interface DeadlineQueue {
  due(query: DeadlineCandidateQuery): Promise<DeadlineCandidate[]>;
}

/** What settling one candidate did. `waiting` leaves it for a later pass. */
export type SettleOutcome = 'expired' | 'dismissed' | 'waiting';

export interface DeadlineExpiryWorkerOptions {
  readonly candidates: DeadlineQueue;
  /** Decide one game from its durable log and act on it. */
  readonly settle: (gameId: string) => Promise<SettleOutcome>;
  /** How the worker names itself in logs, e.g. `No-show expiry`. */
  readonly label: string;
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

export interface DeadlinePass {
  readonly scanned: number;
  readonly expired: number;
  readonly dismissed: number;
  readonly failed: number;
  /** The page was full, so more due games are probably waiting. */
  readonly more: boolean;
}

export class DeadlineExpiryWorker {
  private readonly pollMs: number;
  private readonly pageSize: number;
  private readonly maxBackoffMs: number;
  protected readonly now: () => number;
  private cursor: DeadlineCursor | null = null;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private consecutiveErrors = 0;

  constructor(private readonly options: DeadlineExpiryWorkerOptions) {
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
  async runPass(): Promise<DeadlinePass> {
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
        const outcome = await this.options.settle(candidate.gameId);
        if (outcome === 'expired') {
          expired += 1;
          this.options.expiredCounter?.inc();
        }
        if (outcome === 'dismissed') dismissed += 1;
      } catch (error) {
        failed += 1;
        this.options.failuresCounter?.inc();
        this.options.logger?.error(`${this.options.label} failed for a game; it is retried on a later pass`, {
          gameId: candidate.gameId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { scanned: page.length, expired, dismissed, failed, more };
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
    let pass: DeadlinePass;
    try {
      pass = await this.runPass();
    } catch (error) {
      // The candidate query itself failed (database unreachable): back off instead of spinning.
      this.consecutiveErrors += 1;
      this.options.logger?.error(`${this.options.label} pass failed; retrying with backoff`, {
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
export interface ExpiryOwnership {
  holdsValidLease(gameId: string): boolean;
  release(gameId: string): Promise<void>;
}

export interface RoutedExpiryOptions {
  readonly authority: GameAuthority;
  readonly router: CommandRouter;
  readonly ownership?: ExpiryOwnership;
  /** Whether a player or spectator on this replica is in the game's room. */
  readonly hasLocalSessions: (gameId: string) => boolean;
}

/**
 * Route a server expiry command to the game's owner, exactly like a player's command.
 *
 * Expiring a game nobody on this replica is watching should leave nothing behind: when the game has
 * ended, a lease claimed only for the expiry is released (freeing its command consumer), and a copy
 * loaded only for it is evicted from the authority cache. Either is re-created on demand — a later
 * command claims again with a takeover reload, and a later join reloads from the log — so letting go
 * can delay a racing command but never lose one. A lease this replica already held, or a game someone
 * here is watching, is left exactly as it was.
 */
export function routedExpiry(
  options: RoutedExpiryOptions,
  actor: string,
  command: Command,
): (gameId: string) => Promise<void> {
  const { authority, router, ownership, hasLocalSessions } = options;
  return async (gameId) => {
    const loadedForExpiry = !authority.has(gameId);
    const claimedForExpiry = ownership !== undefined && !ownership.holdsValidLease(gameId);
    if (!(await authority.ensureLoaded(gameId))) return;
    try {
      await router.route(gameId, actor, command);
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
