/**
 * @packageDocumentation
 * Server-authoritative pregame no-show expiry (ADR-0148).
 *
 * A seek or tournament game that has no first move by its source's deadline after `GameCreated` is
 * ended by the server, with nobody connected. Nothing here keeps a timer per game: every pass reads
 * the games that are due from the `games` projection, re-decides each one from the durable event
 * log, and routes `expireNoShow` to the game's owner like any other command.
 *
 * Why the guarantees hold:
 * - **Once only, never over a first move.** The owner applies the command under the game's command
 *   lock, where the domain refuses it unless the game is ongoing with no move played, and the event
 *   log's `expectedSeq` check rejects any append made from a copy that missed a concurrent write. A
 *   first move and an expiry therefore cannot both commit, and nothing can follow `GameEnded`.
 * - **Safe on every replica.** Two workers deciding the same game both route to its single owner;
 *   the second finds it over. Even a split-brain owner loses at the log's sequence check.
 * - **Durable and restartable.** The deadline is `GameCreated.at` plus configuration, and the worker
 *   holds no state that correctness depends on, so a crash before the append is retried by the next
 *   pass, one after it finds the game ended, and a restart catches up on every overdue game at once.
 */

import { Game, type GameSource } from '@chess-platform/game';
import {
  NO_SHOW_ACTOR,
  type CommandRouter,
  type EventLog,
  type GameAuthority,
} from '@chess-platform/realtime-gateway';
import type { Counter, Logger } from '@chess-platform/api';
import type { NoShowCandidate, NoShowCandidateQuery, NoShowCursor } from '@chess-platform/persistence/pg';

/** How long after creation each source's game may wait for its first move. */
export type NoShowDeadlines = Readonly<Record<GameSource, number>>;

/** Defaults fixed by owner policy: one minute for a seek, five for a tournament game. */
export const DEFAULT_NO_SHOW_DEADLINES: NoShowDeadlines = { seek: 60_000, tournament: 300_000 };

export interface NoShowCandidateSource {
  due(query: NoShowCandidateQuery): Promise<NoShowCandidate[]>;
}

/** Ends one game by the no-show rule on its owner; see {@link routedNoShowExpiry}. */
export type ExpireNoShow = (gameId: string, afterMs: number) => Promise<void>;

export interface NoShowExpiryWorkerOptions {
  readonly candidates: NoShowCandidateSource;
  /** The durable event log, which decides every candidate. */
  readonly events: Pick<EventLog, 'load'>;
  readonly expire: ExpireNoShow;
  readonly deadlines?: NoShowDeadlines;
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
  readonly failed: number;
  /** The page was full, so more due games are probably waiting. */
  readonly more: boolean;
}

/**
 * Tournament games whose players are both ready wait for the first move indefinitely and stay in the
 * pending index, so the worker remembers them instead of re-reading their logs every pass. Readiness
 * never reverts, so a remembered game can only have moved or ended since, and either removes it from
 * the index. Losing the memory (a restart, or eviction past this bound) costs one re-read per game.
 */
const MAX_REMEMBERED_WAITING = 10_000;

export class NoShowExpiryWorker {
  private readonly deadlines: NoShowDeadlines;
  private readonly pollMs: number;
  private readonly pageSize: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly waiting = new Set<string>();
  private cursor: NoShowCursor | null = null;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private consecutiveErrors = 0;

  constructor(private readonly options: NoShowExpiryWorkerOptions) {
    this.deadlines = options.deadlines ?? DEFAULT_NO_SHOW_DEADLINES;
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
   * One bounded pass: a page of due candidates after the rotating cursor. The cursor moves on even
   * past games that failed, so a game that keeps failing cannot starve the ones behind it; it comes
   * round again when the cursor wraps.
   */
  async runPass(): Promise<NoShowPass> {
    const now = this.now();
    const page = await this.options.candidates.due({
      seekDueBy: new Date(now - this.deadlines.seek),
      tournamentDueBy: new Date(now - this.deadlines.tournament),
      after: this.cursor,
      limit: this.pageSize,
    });
    const more = page.length === this.pageSize;
    const last = page.at(-1);
    this.cursor = more && last ? { startedAt: last.startedAt, gameId: last.gameId } : null;

    let expired = 0;
    let failed = 0;
    for (const candidate of page) {
      if (this.waiting.has(candidate.gameId)) continue;
      try {
        if (await this.settle(candidate.gameId)) expired += 1;
      } catch (error) {
        failed += 1;
        this.options.failuresCounter?.inc();
        this.options.logger?.error('No-show expiry failed for a game; it is retried on a later pass', {
          gameId: candidate.gameId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { scanned: page.length, expired, failed, more };
  }

  /** Decide one game from its durable log and expire it if the rule says so. True if it expired. */
  private async settle(gameId: string): Promise<boolean> {
    const logged = await this.options.events.load(gameId);
    if (logged.length === 0) return false;
    const game = Game.fromEvents(logged.map((entry) => entry.event));
    const source = game.snapshot().source;
    if (source === null) return false;
    const afterMs = this.deadlines[source];
    const verdict = game.noShowVerdict(afterMs, this.now());
    if (verdict.kind === 'both_ready') {
      this.remember(gameId);
      return false;
    }
    if (verdict.kind !== 'expire') return false;
    await this.options.expire(gameId, afterMs);
    this.options.expiredCounter?.inc();
    return true;
  }

  private remember(gameId: string): void {
    if (this.waiting.size >= MAX_REMEMBERED_WAITING) {
      const oldest = this.waiting.values().next().value;
      if (oldest !== undefined) this.waiting.delete(oldest);
    }
    this.waiting.add(gameId);
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
    this.schedule(pass.more ? 0 : this.pollMs);
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
 * Expiring an unowned game makes this replica claim it, and a claim holds a lease and a command
 * consumer until released. A game nobody on this replica is watching gains nothing from that once it
 * has ended, so a claim made only to expire it is released afterwards.
 */
export function routedNoShowExpiry(options: RoutedNoShowExpiryOptions): ExpireNoShow {
  const { authority, router, ownership, hasLocalSessions } = options;
  return async (gameId, afterMs) => {
    const claimedForExpiry = ownership !== undefined && !ownership.holdsValidLease(gameId);
    if (!(await authority.ensureLoaded(gameId))) return;
    try {
      await router.route(gameId, NO_SHOW_ACTOR, { kind: 'expireNoShow', afterMs });
    } finally {
      if (claimedForExpiry && ownership.holdsValidLease(gameId) && !hasLocalSessions(gameId)) {
        await ownership.release(gameId);
      }
    }
  };
}
