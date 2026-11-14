/**
 * @packageDocumentation
 * `@chess-platform/core` — a fully-typed, variant-aware chess rules engine.
 *
 * Public API:
 * - {@link Position}: immutable position with legal move generation, SAN/UCI,
 *   game-status detection, and `perft`.
 * - FEN helpers, board math, and low-level move generation for advanced use.
 */

export * from './types';
export * from './board';
export * from './fen';
export {
  CHESS960_POSITIONS,
  CHESS960_STANDARD_ID,
  chess960BackRank,
  chess960Fen,
} from './chess960';
// Deliberately not `export *`, for the same reason as `check-counters.ts` below: the rights
// bookkeeping is how this package maintains castling state, and publishing it invites a second
// copy of that logic. Only `NO_CASTLING_ROOK` is exported, because `CastlingRights` is public and a
// caller reading `state.castling` needs to know what marks an absent right. The `CastlingRights`,
// `ColorCastlingRights` and `CastlingSide` types themselves come from `./types` above.
export { NO_CASTLING_ROOK } from './castling';
// Deliberately not `export *`. The field-shape predicates and the counter-field parsers are how
// the codec reads a FEN, and `check-counters.ts` exists so that the conversion lives in one
// place; publishing them invites a second one. Raised in the CodeRabbit review of PR #140.
export { THREE_CHECK_LIMIT, deliveredFromRemaining, remainingFromDelivered } from './check-counters';
export type { CheckCounters } from './check-counters';
export {
  findKing,
  inCheck,
  isSquareAttacked,
  generatePseudoLegal,
  generateLegalMoves,
  applyMove,
} from './movegen';
export { Position, IllegalMoveError, HORDE_FEN, RACING_KINGS_FEN } from './position';
export { isFrozenDeadPosition } from './dead-position';
export { repetitionKey } from './repetition';
export { validatePositionSemantics, validateFen } from './position-validator';
