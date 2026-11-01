/**
 * @packageDocumentation
 * Shared bounded variant-aware position-semantic validator (#125).
 */

import { opposite } from './board';
import { FenError } from './fen-error';
import { parseFen } from './fen';
import { inCheck, isAdjacent } from './movegen';
import type { PositionState, Variant } from './types';

/**
 * Validate the semantic validity of a decoded {@link PositionState}.
 *
 * Checks:
 * - Royal counts: Horde has 0 White kings and 1 Black king; all other variants have 1 White and 1 Black king.
 * - Royal adjacency: Kings must not be adjacent, except in Atomic where connected kings are legal.
 * - Check semantics:
 *   - Racing Kings: neither king may be in check.
 *   - Horde: White has no king and is never in check; Black cannot be in check when it is White's turn.
 *   - All other variants: side not to move cannot be in check.
 * - Crazyhouse pockets: no kings allowed in either pocket; non-Crazyhouse must have empty pockets.
 */
export function validatePositionSemantics(state: PositionState): void {
  const board = state.board;
  let whiteKings = 0;
  let blackKings = 0;
  let whiteKingSq = -1;
  let blackKingSq = -1;

  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const piece = board[sq];
    if (piece === 'K') {
      whiteKings++;
      whiteKingSq = sq;
    } else if (piece === 'k') {
      blackKings++;
      blackKingSq = sq;
    }
  }

  const expectedWhite = state.variant === 'horde' ? 0 : 1;
  const expectedBlack = 1;
  if (whiteKings !== expectedWhite || blackKings !== expectedBlack) {
    throw new FenError(
      `Invalid king count for ${state.variant}: expected White=${expectedWhite}, Black=${expectedBlack}; got White=${whiteKings}, Black=${blackKings}`,
    );
  }

  // Non-adjacent kings (Atomic permits adjacent kings; Horde White has no king).
  if (state.variant !== 'atomic' && state.variant !== 'horde') {
    if (isAdjacent(whiteKingSq, blackKingSq)) {
      throw new FenError('Kings cannot be adjacent');
    }
  }

  // Check rules
  if (state.variant === 'racingkings') {
    if (inCheck(state, 'w') || inCheck(state, 'b')) {
      throw new FenError('Neither king may be in check in Racing Kings');
    }
  } else if (state.variant === 'horde') {
    // White has no king, so White can never be in check. Black cannot be in check when it is White's turn.
    if (state.turn === 'w' && inCheck(state, 'b')) {
      throw new FenError('Side not to move cannot be in check');
    }
  } else {
    // Standard, Chess960, Threecheck, Crazyhouse, King of the Hill, Atomic
    const sideNotToMove = opposite(state.turn);
    if (inCheck(state, sideNotToMove)) {
      throw new FenError('Side not to move cannot be in check');
    }
  }

  // Pockets
  if (state.variant === 'crazyhouse') {
    if (state.pockets.w.includes('k') || state.pockets.b.includes('k')) {
      throw new FenError('Crazyhouse pockets cannot contain a king');
    }
  } else if (state.pockets.w.length > 0 || state.pockets.b.length > 0) {
    throw new FenError(`Pocket pieces are only permitted in Crazyhouse, got pockets in ${state.variant}`);
  }
}

/**
 * Parse and semantically validate a FEN string into a {@link PositionState}.
 * Throws {@link FenError} if malformed or semantically invalid.
 */
export function validateFen(fen: string, variant: Variant = 'standard'): PositionState {
  const state = parseFen(fen, variant);
  validatePositionSemantics(state);
  return state;
}
