/**
 * @packageDocumentation
 * Terminal-position adjudication at the API boundary (ADR-0116).
 *
 * A finished game has an outcome, not an evaluation. Asking a chess engine to score a position with
 * no legal moves produces nothing to score, and `UciEngineInstance.assembleResults` fills the gap
 * with a placeholder `{ cp: 0, depth: 0 }` — reasonable as an internal "no scored info" marker, and
 * a lie the moment it reaches a client as an evaluation. Checkmate was being reported as `+0.00`,
 * dead level, by both `POST /v1/analysis` and Move Explanation.
 *
 * The fix belongs here rather than in the engine package: `EngineResult` is consumed by anti-cheat
 * and the bot mover as well, and changing what it means for every consumer to correct a presentation
 * defect on two HTTP surfaces is a far larger blast radius than the defect. The API owns its own
 * responses, and it already owns an authoritative rules engine.
 */

import type { GameStatus, Variant } from '@chess-platform/core';
import { Position } from '@chess-platform/core';

/**
 * Why a position is terminal, in the vocabulary the platform already uses.
 *
 * Prepared for compatibility consumers to accept `dead_position` (AUD-03a, FIDE 5.2.2), while
 * core `GameStatus['reason']` remains unchanged until detector implementation (AUD-03b).
 * `threefold` is included even though `Position.status()` cannot
 * return it from a single FEN — repetition needs the move history, which no analysis request
 * carries — because this module is exported, and mapping it onto a *neighbouring* reason would
 * report a wrong result rather than no result. Raised in the Qodo review of PR #135.
 */
export type TerminalReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient_material'
  | 'fifty_move'
  | 'threefold'
  | 'variant_win'
  | 'variant_draw'
  | 'dead_position';

/**
 * A terminal position's outcome.
 *
 * `result` is the platform's existing `ResultString` vocabulary (`@chess-platform/game`), the same
 * strings `GameSummaryView.result` already puts on the wire — so a client that can render a finished
 * game can render this without learning a second spelling of "White won". It is not repeated as a
 * `winner` field: `1-0` already says who won, and two fields that must agree are two fields that can
 * disagree.
 */
export interface TerminalOutcome {
  readonly reason: TerminalReason;
  readonly result: '1-0' | '0-1' | '1/2-1/2';
}

/**
 * The terminal outcome of a position, or `undefined` when play continues.
 *
 * Delegates entirely to `Position.status()`, which is the platform's authoritative, variant-aware
 * adjudicator: it resolves King of the Hill centre occupation, Three-check counts, Atomic king
 * explosion, Racing Kings promotion to the eighth rank and Horde annihilation *before* the generic
 * no-legal-moves check, so this function needs no per-variant knowledge of its own and cannot drift
 * from the rules the rest of the platform plays by. Adding a second implementation here is precisely
 * what this must not do.
 */
export function terminalOutcome(fen: string, variant: Variant): TerminalOutcome | undefined {
  let status: GameStatus;
  try {
    status = Position.fromFen(fen, variant).status();
  } catch {
    // An unparseable FEN is not this function's error to report. Callers validate before reaching
    // here; returning `undefined` lets the existing validation produce the existing 422.
    return undefined;
  }
  return fromStatus(status);
}

/** The wire form of a `GameStatus`, or `undefined` when the game is not over. */
export function fromStatus(status: GameStatus): TerminalOutcome | undefined {
  if (!status.over) return undefined;

  switch (status.reason) {
    case 'checkmate':
      return { reason: 'checkmate', result: status.winner === 'w' ? '1-0' : '0-1' };
    case 'variant_win':
      return { reason: 'variant_win', result: status.winner === 'w' ? '1-0' : '0-1' };
    case 'stalemate':
      return { reason: 'stalemate', result: '1/2-1/2' };
    case 'insufficient_material':
      return { reason: 'insufficient_material', result: '1/2-1/2' };
    case 'fifty_move':
      return { reason: 'fifty_move', result: '1/2-1/2' };
    case 'variant_draw':
      return { reason: 'variant_draw', result: '1/2-1/2' };
    case 'threefold':
      // Not reachable from `Position.status()` today, and reported honestly regardless: a caller
      // that does know the history gets back the reason it supplied, not a neighbouring draw.
      return { reason: 'threefold', result: '1/2-1/2' };
    default:
      // A new `GameStatus` reason must fail to compile here rather than fall through to
      // `undefined`, which would silently report a terminal position as still in play — the exact
      // class of defect this module exists to remove.
      return assertExhaustive(status);
  }
}

function assertExhaustive(status: never): never {
  throw new Error(`unhandled terminal status: ${JSON.stringify(status)}`);
}

/** A short human-readable phrase, for grounding text and for clients that want a default label. */
export function describeTerminal(outcome: TerminalOutcome): string {
  switch (outcome.reason) {
    case 'checkmate':
      return `checkmate — ${outcome.result === '1-0' ? 'White' : 'Black'} wins`;
    case 'variant_win':
      return `variant win — ${outcome.result === '1-0' ? 'White' : 'Black'} wins`;
    case 'stalemate':
      return 'stalemate — drawn';
    case 'insufficient_material':
      return 'insufficient material — drawn';
    case 'fifty_move':
      return 'fifty-move rule — drawn';
    case 'threefold':
      return 'threefold repetition — drawn';
    case 'variant_draw':
      return 'variant draw — drawn';
    case 'dead_position':
      return 'dead position — drawn';
  }
}
