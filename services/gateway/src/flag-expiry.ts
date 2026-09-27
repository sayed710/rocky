/**
 * @packageDocumentation
 * Server-authoritative in-play flag expiry (ADR-0149).
 *
 * Once a timed game's first move has started its clock, the side to move loses on time when that
 * clock runs out, with nobody connected and nobody claiming. Every pass reads the due entries of
 * `flag_deadlines` (kept in step with the event log by a trigger: each move replaces its game's
 * deadline, an ending removes it), re-decides each from the durable log with the game domain, and
 * routes `expireFlag` to the game's owner like any other command. The owner decides again on its own
 * clock and its freshest copy, and records the same `GameEnded` a `claimFlag` would, including the
 * draw when the winner could not possibly have mated.
 *
 * Why the guarantees hold:
 * - **The deadline decides, not the arrival order.** The owner records the timeout for any command
 *   it applies at or after the side to move's flag — a late move, a resignation, a draw acceptance,
 *   this worker's expiry — and refuses the expiry before it. A move the owner applied before the
 *   deadline has already replaced the clock, so the expiry that follows is refused.
 * - **Once only, never over a newer move.** One owner applies commands per game under its lock, and
 *   the log's `expectedSeq` check rejects an append from a copy that missed a concurrent write, which
 *   then reloads and decides again. Nothing can follow `GameEnded`.
 * - **Durable and restartable.** The worker holds no state that correctness depends on. A restart
 *   catches up on every overdue game in its first passes, and a game that flagged while no process
 *   ran ends as soon as one does, with the timeout stamped at the owner's time.
 */

import { Game } from '@chess-platform/game';
import { FLAG_ACTOR, type EventLog } from '@chess-platform/realtime-gateway';
import type { Counter, Logger } from '@chess-platform/api';
import {
  DeadlineExpiryWorker,
  routedExpiry,
  type DeadlineQueue,
  type RoutedExpiryOptions,
  type SettleOutcome,
} from './deadline-expiry.js';

export interface FlagCandidateSource extends DeadlineQueue {
  /** Set a game's deadline to what its log says, unless a move after `headSeq` replaced it. */
  reschedule(gameId: string, headSeq: number, dueMs: number): Promise<void>;
  /** Remove a game whose log shows no clock that can flag, unless a move after `headSeq` wrote it. */
  dismiss(gameId: string, headSeq: number): Promise<void>;
}

export interface FlagExpiryWorkerOptions {
  readonly candidates: FlagCandidateSource;
  /** The durable event log, which decides every candidate. */
  readonly events: Pick<EventLog, 'load'>;
  /** Ends one game on time on its owner; see {@link routedFlagExpiry}. */
  readonly expire: (gameId: string) => Promise<void>;
  /** Delay between passes once nothing more is due (default 1 s). */
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

export class FlagExpiryWorker extends DeadlineExpiryWorker {
  constructor(options: FlagExpiryWorkerOptions) {
    const now = options.now ?? (() => Date.now());
    super({
      ...options,
      pollMs: options.pollMs ?? 1_000,
      now,
      label: 'Flag expiry',
      settle: (gameId) => settleFlag(options, now, gameId),
    });
  }
}

/**
 * Decide one game from its durable log. The queue is only an index: when the log disagrees with it,
 * the log wins and the row is corrected (a later deadline) or dismissed (no clock that can flag).
 */
async function settleFlag(options: FlagExpiryWorkerOptions, now: () => number, gameId: string): Promise<SettleOutcome> {
  const logged = await options.events.load(gameId);
  const head = logged.at(-1);
  if (head === undefined) return 'waiting';
  const game = Game.fromEvents(logged.map((entry) => entry.event));
  if (game.timeoutDue(now())) {
    await options.expire(gameId);
    return 'expired';
  }
  const deadline = game.flagDeadline;
  if (deadline === null || !Number.isFinite(deadline)) {
    await options.candidates.dismiss(gameId, head.seq);
    return 'dismissed';
  }
  await options.candidates.reschedule(gameId, head.seq, Math.ceil(deadline));
  return 'waiting';
}

/** Route `expireFlag` to the game's owner, exactly like a player's command; see {@link routedExpiry}. */
export function routedFlagExpiry(options: RoutedExpiryOptions): (gameId: string) => Promise<void> {
  return routedExpiry(options, FLAG_ACTOR, { kind: 'expireFlag' });
}
