import assert from 'node:assert/strict';
import { opposite } from '../src/board';
import { cloneState } from '../src/fen';
import { applyMove, generateLegalMoves, inCheck } from '../src/movegen';
import type { Color, Move, PositionState } from '../src/types';

/**
 * Shared canonical witness replay assertion.
 * Replays the witness against chess-core legal move generation, validating that each move:
 * 1. Conforms to canonical Move field values (from, to, piece, flags, and optional captured/promotion/castleRook).
 * 2. Matches an engine-generated legal move in the current board state across all fields.
 * 3. Is accepted directly by applyMove(curr, wMove) without mutation.
 * 4. Culminates in terminal checkmate for the intended winner (or verifies root checkmate if witness is empty).
 *
 * (External root Python checks serve as the actual independent engine verification evidence).
 */
export function assertCanonicalWitnessReplay(
  root: PositionState,
  winner: Color,
  witness: readonly Move[],
): void {
  assert.ok(Array.isArray(witness), 'Witness must be an array');
  const opponent = opposite(winner);
  let curr = cloneState(root);

  if (witness.length === 0) {
    assert.equal(curr.turn, opponent, 'Opponent must be to move on root checkmate');
    assert.equal(inCheck(curr, opponent), true, 'Opponent must be in check on root checkmate');
    assert.equal(generateLegalMoves(curr).length, 0, 'Opponent must have zero legal moves on root checkmate');
    return;
  }

  for (let i = 0; i < witness.length; i++) {
    const wMove: Move = witness[i];

    assert.equal(typeof wMove.from, 'number', `Move ${i} from must be number`);
    assert.equal(typeof wMove.to, 'number', `Move ${i} to must be number`);
    assert.equal(typeof wMove.piece, 'string', `Move ${i} piece must be string`);
    assert.equal(typeof wMove.flags, 'number', `Move ${i} flags must be number`);
    assert.equal(wMove.drop, undefined, `Move ${i} drop must be undefined in orthodox chess`);

    const legals = generateLegalMoves(curr);
    const match = legals.find(
      (m) =>
        m.from === wMove.from &&
        m.to === wMove.to &&
        m.piece === wMove.piece &&
        m.flags === wMove.flags &&
        m.captured === wMove.captured &&
        m.promotion === wMove.promotion &&
        m.castleRook === wMove.castleRook &&
        m.drop === wMove.drop,
    );
    assert.ok(match !== undefined, `Move ${i} in witness must match a legal move exactly in all fields`);

    curr = applyMove(curr, wMove);
  }

  assert.equal(curr.turn, opponent, 'Opponent must be to move at end of witness');
  assert.equal(inCheck(curr, opponent), true, 'Opponent must be in check at end of witness');
  assert.equal(generateLegalMoves(curr).length, 0, 'Opponent must have zero legal moves at end of witness');
}
