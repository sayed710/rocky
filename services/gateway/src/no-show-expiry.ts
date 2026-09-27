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
import { NO_SHOW_ACTOR, type EventLog } from '@chess-platform/realtime-gateway';
import type { Counter, Logger } from '@chess-platform/api';
import type { NoShowCandidate, NoShowCandidateQuery } from '@chess-platform/persistence/pg';
import {
  DeadlineExpiryWorker,
  routedExpiry,
  type DeadlinePass,
  type ExpiryOwnership,
  type RoutedExpiryOptions,
  type SettleOutcome,
} from './deadline-expiry.js';

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

export type NoShowPass = DeadlinePass;

export class NoShowExpiryWorker extends DeadlineExpiryWorker {
  constructor(options: NoShowExpiryWorkerOptions) {
    const now = options.now ?? (() => Date.now());
    super({ ...options, now, label: 'No-show expiry', settle: (gameId) => settleNoShow(options, now, gameId) });
  }
}

/** Decide one game from its durable log: expire it, dismiss it, or leave it for a later pass. */
async function settleNoShow(options: NoShowExpiryWorkerOptions, now: () => number, gameId: string): Promise<SettleOutcome> {
  const logged = await options.events.load(gameId);
  if (logged.length === 0) return 'waiting';
  const verdict = Game.fromEvents(logged.map((entry) => entry.event)).noShowVerdict(now());
  switch (verdict.kind) {
    case 'expire':
      await options.expire(gameId);
      return 'expired';
    case 'both_ready':
    case 'not_applicable':
      // Readiness never reverts, and a started or ended game never needs a no-show again.
      await options.candidates.dismiss(gameId);
      return 'dismissed';
    case 'not_due':
      return 'waiting';
  }
}

/** Multi-node ownership, as `OwnershipRegistry` provides it. Absent on a single node. */
export type NoShowOwnership = ExpiryOwnership;
export type RoutedNoShowExpiryOptions = RoutedExpiryOptions;

/** Route `expireNoShow` to the game's owner, exactly like a player's command; see {@link routedExpiry}. */
export function routedNoShowExpiry(options: RoutedNoShowExpiryOptions): ExpireNoShow {
  return routedExpiry(options, NO_SHOW_ACTOR, { kind: 'expireNoShow' });
}
