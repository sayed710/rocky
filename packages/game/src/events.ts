/**
 * @packageDocumentation
 * Event-sourcing types for games. A game is an append-only sequence of events;
 * current state is a fold over them ({@link ../game.Game.fromEvents}). Events
 * are the durable source of truth — projections (PGN, ratings) derive from them.
 */

import type { Color, Variant } from '@chess-platform/core';
import type { TimeControl } from './clock';
import type { PreparedOperation } from './prepared-command';

/** How a game terminated. */
export type Termination =
  | 'checkmate'
  | 'resignation'
  | 'timeout'
  | 'stalemate'
  | 'agreement'
  | 'insufficient_material'
  | 'fifty_move'
  | 'threefold'
  | 'variant'
  | 'aborted'
  /**
   * A pregame no-show (ADR-0148): the no-show deadline passed before the first move. Never a chess
   * timeout. `'*'` with no winner is a seek abort or a tournament double forfeit; a tournament game
   * with exactly one ready player is won by that player.
   */
  | 'no_show'
  /**
   * A structural dead position (FIDE Article 5.2.2, ADR-0166): neither player can mate by any
   * possible series of legal moves. Prepared as a draw termination for backward-compatible readers;
   * emission is on HOLD until database and client rollout prerequisites are complete (AUD-03b).
   */
  | 'dead_position';

/**
 * Where a game came from, recorded only when that decides its pregame lifecycle (ADR-0148).
 *
 * A game with a source requires durable readiness from both seats before the first move, starts its
 * chess clock at the first move, and is ended by the server if no move is played before that
 * source's no-show deadline. A game without one (bot games, direct/test creation, and every game
 * stored before this field existed) keeps the original lifecycle: clock anchored at creation, no
 * readiness, no no-show.
 */
export type GameSource = 'seek' | 'tournament';

/** Standard result string. */
export type ResultString = '1-0' | '0-1' | '1/2-1/2' | '*';

/** Player references at game creation. */
export interface Players {
  readonly white: string;
  readonly black: string;
}

export interface GameCreatedEvent {
  readonly type: 'GameCreated';
  readonly gameId: string;
  readonly variant: Variant;
  readonly initialFen: string;
  readonly timeControl: TimeControl;
  readonly players: Players;
  readonly rated: boolean;
  readonly at: number;
  /**
   * For a `chess960` game, the Scharnagl id (0..959) of the arrangement it started from.
   *
   * `initialFen` already pins the *position*, so replay never needed this field to reconstruct the
   * board. What it records is the arrangement's **identity** — which of the 960 a game is — and that
   * is not recoverable from anywhere else once the first move is played: the FEN then describes the
   * position, not the start. A player asking "which one was this?" is asking a question about durable
   * history, so history is where the answer has to live.
   *
   * Optional, and deliberately not versioned. A new field on a payload that is stored as JSON is
   * readable by the existing decoder — `upcast` passes `CURRENT_EVENT_VERSION` rows through as-is —
   * so no upcaster and no version bump are needed, and every stored event keeps decoding. Absent on
   * every non-Chess960 game, which is why it is not required: fabricating an id for a variant that
   * has none would be the same durable falsehood ADR-0123 refused.
   *
   * A stored `chess960` event without it is a game created before this field existed. It replays
   * from `initialFen` exactly as it always did and reports its start id as `null` — genuinely
   * unknown. It is never filled in with 518, which would be a guess wearing the shape of a fact.
   */
  readonly chess960StartId?: number;
  /**
   * See {@link GameSource}. Optional and unversioned for the same reason as `chess960StartId`: an
   * absent field is how every earlier game is stored, and it keeps meaning exactly what it meant.
   */
  readonly source?: GameSource;
  /**
   * Present exactly when `source` is: how long after `at` the game may wait for its first move before
   * the pregame no-show rule ends it. Recorded at creation so the deadline is a durable fact of the
   * game that every replica and every replay agrees on, not a setting each process reads for itself.
   */
  readonly noShowAfterMs?: number;
}

/**
 * A seated player became ready (ADR-0148). Written once per seat, only for a game with a
 * {@link GameCreatedEvent.source}, before its first move. Readiness never reverts.
 */
export interface PlayerReadyEvent {
  readonly type: 'PlayerReady';
  readonly by: Color;
  readonly at: number;
}

export interface MovePlayedEvent {
  readonly type: 'MovePlayed';
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly by: Color;
  readonly moveTimeMs: number;
  /** Remaining clock (ms) for both sides after this move. */
  readonly remaining: { readonly w: number; readonly b: number };
  readonly at: number;
}

export interface DrawOfferedEvent {
  readonly type: 'DrawOffered';
  readonly by: Color;
  readonly at: number;
}

export interface DrawDeclinedEvent {
  readonly type: 'DrawDeclined';
  readonly by: Color;
  readonly at: number;
}

export interface GameEndedEvent {
  readonly type: 'GameEnded';
  readonly result: ResultString;
  readonly termination: Termination;
  /** Winner, or null for a draw / abort. */
  readonly winner: Color | null;
  readonly at: number;
}

export type RecordedImpossible = {
  readonly status: 'impossible';
  readonly provenance:
    | 'static_certificate'
    | 'closed_graph'
    | 'closed_graph_material_pruned';
};

export type RecordedReachable = {
  readonly status: 'reachable';
  readonly winner: Color;
  readonly witness: readonly string[];
};

export type RecordedGlobalOutcome =
  | {
      readonly status: 'dead';
      readonly white: RecordedImpossible;
      readonly black: RecordedImpossible;
    }
  | RecordedReachable;

export interface RecordedResolutionEvidence {
  readonly base?: RecordedGlobalOutcome;
  readonly successor?: {
    readonly fen: string;
    readonly outcome: RecordedGlobalOutcome;
  };
  readonly timeout?: {
    readonly winner: Color;
    readonly outcome: RecordedImpossible | RecordedReachable;
  };
}

export type AdjudicationEffect =
  | MovePlayedEvent
  | GameEndedEvent
  | DrawOfferedEvent
  | DrawDeclinedEvent
  | PlayerReadyEvent;

/** Supported clock management policies for adjudication (Issue #124, Stage R1). */
export type AdjudicationClockPolicy = 'observed-release-v1';

/** Nonterminal stopped-turn clock completion descriptor (Issue #124, Stage R1). */
export interface AdjudicationClockStoppedDescriptor {
  readonly policy: 'observed-release-v1';
  readonly kind: 'stopped';
  readonly stopId: string;
  readonly originatingOperationId: string;
  readonly startedSeq: number;
  readonly resolvedSeq: number;
  readonly completionHead: number;
  readonly resultingSideToMove: Color;
  readonly resultingPly: number;
  readonly turnLineageId: string;
  readonly parentStopId: string | null;
  readonly runningSince: null;
}

/** Terminal clock completion descriptor (Issue #124, Stage R1). */
export interface AdjudicationClockTerminalDescriptor {
  readonly policy: 'observed-release-v1';
  readonly kind: 'terminal';
  readonly originatingOperationId: string;
  readonly startedSeq: number;
  readonly resolvedSeq: number;
  readonly completionHead: number;
  readonly runningSince: null;
}

/** Discriminated union of clock completion descriptors for observed-release-v1. */
export type AdjudicationClockCompletionDescriptor =
  | AdjudicationClockStoppedDescriptor
  | AdjudicationClockTerminalDescriptor;

/**
 * Adjudication began for an admitted operation (Issue #124, Stage 1).
 * Records immutable prepared operation, suspension instant A, and rules version.
 * Transitions game into a blocked `proving` state.
 */
export interface AdjudicationStartedEvent {
  readonly type: 'AdjudicationStarted';
  readonly gameId: string;
  readonly operationId: string;
  readonly baseRevision: number;
  readonly at: number;
  readonly rulesVersion: string;
  readonly prepared: PreparedOperation;
  readonly clockPolicy?: AdjudicationClockPolicy;
}

/**
 * Adjudication resolved for an operation (Issue #124, Stage 1).
 * Binds operation identity, start sequence in event log, resolution instant R,
 * provenance metadata, structured evidence, and the exact declared effect plan.
 */
export interface AdjudicationResolvedEvent {
  readonly type: 'AdjudicationResolved';
  readonly gameId: string;
  readonly operationId: string;
  readonly baseRevision?: number;
  readonly startedSeq: number;
  readonly at: number;
  readonly rulesVersion: string;
  readonly provenance?: string;
  readonly witness?: readonly string[];
  readonly evidence?: RecordedResolutionEvidence;
  readonly effects: readonly AdjudicationEffect[];
  readonly clockCompletion?: AdjudicationClockCompletionDescriptor;
}

/** The discriminated union of all persisted game events. */
export type GameEvent =
  | GameCreatedEvent
  | PlayerReadyEvent
  | MovePlayedEvent
  | DrawOfferedEvent
  | DrawDeclinedEvent
  | GameEndedEvent
  | AdjudicationStartedEvent
  | AdjudicationResolvedEvent;
