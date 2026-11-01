import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Position,
  type PositionState,
  type Variant,
} from '../src';
import { isFrozenDeadPosition } from '../src/dead-position';

/**
 * Reflect a FEN vertically (flip ranks 1..8) and swap piece colors (uppercase <-> lowercase)
 * and swap active color ('w' <-> 'b').
 */
function reflectAndColorSwapFen(fen: string): string {
  const parts = fen.trim().split(/\s+/);
  const boardStr = parts[0]!;
  const ranks = boardStr.split('/');
  const reversedRanks = ranks.slice().reverse();
  const swappedRanks = reversedRanks.map((r) =>
    r
      .split('')
      .map((c) => {
        if (c >= 'A' && c <= 'Z') return c.toLowerCase();
        if (c >= 'a' && c <= 'z') return c.toUpperCase();
        return c;
      })
      .join(''),
  );
  const newBoard = swappedRanks.join('/');
  const newTurn = parts[1] === 'w' ? 'b' : 'w';
  const newEp = '-'; // EP remains -
  return `${newBoard} ${newTurn} - ${newEp} ${parts[4] ?? '0'} ${parts[5] ?? '1'}`;
}

test('issue FEN: 8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1 is recognized as frozen dead position with c7d7 escape', () => {
  const fen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
  const pos = Position.fromFen(fen);

  // Black is in check from White pawn on b6
  assert.equal(pos.isCheck(), true);

  // Black has the explicit legal escape move c7d7 (escapes check)
  const legalUcis = pos.legalMoves().map((m) => pos.toUci(m));
  assert.ok(legalUcis.includes('c7d7'), 'Must include legal escape move c7d7');

  const afterEscape = pos.play('c7d7');
  assert.equal(afterEscape.isCheck(), false, 'Playing c7d7 successfully escapes check');

  // Pure certificate verifies dead position
  assert.equal(isFrozenDeadPosition(pos.snapshot()), true);

  // Position.status() returns dead_position
  const status = pos.status();
  assert.deepEqual(status, { over: true, reason: 'dead_position' });
});

test('issue FEN reflection: color swapped and rank reflected is recognized as frozen dead position', () => {
  const originalFen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
  const reflectedFen = reflectAndColorSwapFen(originalFen);
  const pos = Position.fromFen(reflectedFen);

  // White is in check from Black pawn
  assert.equal(pos.isCheck(), true);
  assert.ok(pos.legalMoves().length > 0);

  assert.equal(isFrozenDeadPosition(pos.snapshot()), true);
  assert.deepEqual(pos.status(), { over: true, reason: 'dead_position' });
});

test('checkmate priority over dead position: checked king with no escape is checkmate', () => {
  const pos = Position.fromFen('k6R/8/1K6/8/8/8/8/8 b - - 0 1');
  assert.equal(pos.isCheck(), true);
  assert.equal(pos.legalMoves().length, 0);

  assert.equal(isFrozenDeadPosition(pos.snapshot()), false);
  assert.deepEqual(pos.status(), { over: true, reason: 'checkmate', winner: 'w' });
});

test('stalemate priority over dead position: trapped king with no check is stalemate', () => {
  const fen = 'k7/P7/K7/8/8/8/8/8 b - - 0 1'; // Ka8 vs Ka6, Pa7. Black to move is stalemated
  const pos = Position.fromFen(fen);
  assert.equal(pos.isCheck(), false);
  assert.equal(pos.legalMoves().length, 0);

  assert.equal(isFrozenDeadPosition(pos.snapshot()), false);
  assert.deepEqual(pos.status(), { over: true, reason: 'stalemate' });
});

test('fifty-move rule priority: frozen dead position takes priority over fifty-move rule at halfmove 100', () => {
  // Issue FEN with halfmove clock at 100
  const fen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 100 50';
  const pos = Position.fromFen(fen);

  assert.equal(isFrozenDeadPosition(pos.snapshot()), true);
  assert.deepEqual(pos.status(), { over: true, reason: 'dead_position' });
});

test('fifty-move rule priority: unrelated material position (bare kings) preserves fifty_move precedence over insufficient_material', () => {
  // Unrelated bare kings position at halfmove clock 100
  const fen = '4k3/8/8/8/8/8/8/4K3 w - - 100 50';
  const pos = Position.fromFen(fen);

  assert.equal(isFrozenDeadPosition(pos.snapshot()), false);
  // Preserves existing platform rule: fifty_move takes precedence over insufficient_material
  assert.deepEqual(pos.status(), { over: true, reason: 'fifty_move' });
});

test('material draw priority: bare kings or lone minor below 100 halfmoves retain insufficient_material', () => {
  const kVsK = Position.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  assert.equal(isFrozenDeadPosition(kVsK.snapshot()), false);
  assert.deepEqual(kVsK.status(), { over: true, reason: 'insufficient_material' });

  const kBNVsK = Position.fromFen('4k3/8/8/8/8/8/8/4KB2 w - - 0 1');
  assert.equal(isFrozenDeadPosition(kBNVsK.snapshot()), false);
  assert.deepEqual(kBNVsK.status(), { over: true, reason: 'insufficient_material' });
});

test('negative control (Pi counterexample): 7k/8/8/pK6/P7/8/8/8 w - - 0 1 has mobile king that captures and promotes', () => {
  const fen = '7k/8/8/pK6/P7/8/8/8 w - - 0 1';
  const pos = Position.fromFen(fen);

  assert.equal(isFrozenDeadPosition(pos.snapshot()), false);
  assert.deepEqual(pos.status(), { over: false });
});

test('negative control (Pi counterexample reflected): Black king can capture and promote', () => {
  const reflectedFen = reflectAndColorSwapFen('7k/8/8/pK6/P7/8/8/8 w - - 0 1');
  const pos = Position.fromFen(reflectedFen);

  assert.equal(isFrozenDeadPosition(pos.snapshot()), false);
  assert.deepEqual(pos.status(), { over: false });
});

test('negative control: multi-step king access across empty board to unprotected pawn', () => {
  const fen = '7k/8/8/p7/P7/8/8/7K w - - 0 1';
  const pos = Position.fromFen(fen);

  assert.equal(isFrozenDeadPosition(pos.snapshot()), false);
  assert.deepEqual(pos.status(), { over: false });
});

test('negative control: unblocked pawn can push forward', () => {
  const fen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/7P/8 b - - 0 1'; // White pawn on h2 can push
  const pos = Position.fromFen(fen);

  assert.equal(isFrozenDeadPosition(pos.snapshot()), false);
});

test('negative control (ROOT verified): geometric pawn capture after forward blocking (7k/8/8/4pp2/4PP2/8/8/K7 w - - 0 1)', () => {
  // All pawns forward-blocked by pawns (e4 blocked by e5, f4 blocked by f5)
  // But White has legal diagonal capture e4f5 (and f4e5)
  const fen = '7k/8/8/4pp2/4PP2/8/8/K7 w - - 0 1';
  const pos = Position.fromFen(fen);

  // Verify board properties
  const legalUcis = pos.legalMoves().map((m) => pos.toUci(m));
  assert.ok(legalUcis.includes('e4f5'), 'White pawn e4 must have legal capture e4f5');

  assert.equal(
    isFrozenDeadPosition(pos.snapshot()),
    false,
    'Must be rejected due to geometric pawn capture despite all pawns being forward-blocked',
  );
  assert.deepEqual(pos.status(), { over: false });
});

test('negative control (ROOT verified): reachable fixed chain root access (8/8/8/2p5/1pP5/1P6/8/k6K b - - 0 1)', () => {
  // All pawns forward blocked by pawns (b4 blocked by b3, c4 blocked by c5)
  // No geometric pawn captures exist.
  // But Black king can legally walk and capture unprotected root b3: a1a2, h1g1, a2b3 (Kxb3)
  const fen = '8/8/8/2p5/1pP5/1P6/8/k6K b - - 0 1';
  const pos = Position.fromFen(fen);

  assert.equal(
    isFrozenDeadPosition(pos.snapshot()),
    false,
    'Must be rejected because unprotected pawn chain root b3 is reachable by Black king',
  );
  assert.deepEqual(pos.status(), { over: false });

  // Verify the exact legal approach and capture sequence
  const p1 = pos.play('a1a2'); // Ka2
  const p2 = p1.play('h1g1');  // Kg1
  const p3 = p2.play('a2b3');  // Kxb3
  assert.equal(p3.fen(), '8/8/8/2p5/1pP5/1k6/8/6K1 w - - 0 3');
});

test('negative control: non-pawn piece present (e.g. Knight or Bishop)', () => {
  const fen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5KN1/8/8/8 b - - 0 1';
  const pos = Position.fromFen(fen);

  assert.equal(isFrozenDeadPosition(pos.snapshot()), false);
});

test('negative control: en passant square metadata present', () => {
  const fen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - e3 0 1';
  const pos = Position.fromFen(fen);

  assert.equal(isFrozenDeadPosition(pos.snapshot()), false);
});

test('chess960 support: valid frozen position in Chess960 variant', () => {
  const fen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
  const pos = Position.fromFen(fen, 'chess960');

  assert.equal(isFrozenDeadPosition(pos.snapshot()), true);
  assert.deepEqual(pos.status(), { over: true, reason: 'dead_position' });
});

test('variant exclusion: non-standard and non-chess960 variants are rejected outside catch blocks', () => {
  const fen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
  const excludedVariants: Variant[] = [
    'atomic',
    'crazyhouse',
    'horde',
    'kingofthehill',
    'racingkings',
    'threecheck',
  ];

  for (const variant of excludedVariants) {
    let pos: Position | null = null;
    try {
      pos = Position.fromFen(fen, variant);
    } catch {
      // Syntax parsing refused for variant (e.g. threecheck checks/pockets)
    }

    if (pos) {
      assert.equal(
        isFrozenDeadPosition(pos.snapshot()),
        false,
        `Variant ${variant} parsed position must be rejected by isFrozenDeadPosition`,
      );
    } else {
      // Construct a valid state for this variant directly to assert detector rejects it
      const baseState = Position.fromFen(fen, 'standard').snapshot();
      const variantState = { ...baseState, variant };
      assert.equal(
        isFrozenDeadPosition(variantState),
        false,
        `Constructed variant ${variant} state must be rejected by isFrozenDeadPosition`,
      );
    }
  }
});

test('input immutability: isFrozenDeadPosition does not mutate the position state on success or rejection', () => {
  const fen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
  const pos = Position.fromFen(fen);

  // 1. Positive success path
  const successState = pos.snapshot();
  const successBefore = JSON.stringify(successState);
  const resultSuccess = isFrozenDeadPosition(successState);
  assert.equal(resultSuccess, true);
  const successAfter = JSON.stringify(successState);
  assert.equal(successBefore, successAfter, 'Positive path must not mutate input state');

  // 2. Late rejection path (Pi counterexample reaches king flood before rejecting)
  const rejectFen = '7k/8/8/pK6/P7/8/8/8 w - - 0 1';
  const rejectPos = Position.fromFen(rejectFen);
  const rejectState = rejectPos.snapshot();
  const rejectBefore = JSON.stringify(rejectState);
  const resultReject = isFrozenDeadPosition(rejectState);
  assert.equal(resultReject, false);
  const rejectAfter = JSON.stringify(rejectState);
  assert.equal(rejectBefore, rejectAfter, 'Rejection path must not mutate input state');
});

// Note on King Obstacles: The conservative king reachability flood deliberately ignores both king
// obstacles and enemy king attacks to compute an inductive reachability superset without requiring
// an artificial vacated-barrier fixture or dedicated negative vacated-king mutant.

test('malformed state rejection: backrank pawns, adjacent kings, opponent in check', () => {
  const validFen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
  const baseState = Position.fromFen(validFen).snapshot();

  // 1. Pawn on rank 1 (0x88 rank 0)
  const rank1State: PositionState = {
    ...baseState,
    board: [...baseState.board],
  };
  rank1State.board[0] = 'P'; // a1
  assert.equal(isFrozenDeadPosition(rank1State), false);

  // 2. Adjacent kings
  const adjacentKingsState: PositionState = {
    ...baseState,
    board: [...baseState.board],
  };
  // Move White king to c6 (square 0x52 = 82, adjacent to Black king on c7 = 98)
  adjacentKingsState.board[baseState.board.indexOf('K')] = null;
  adjacentKingsState.board[82] = 'K'; // c6
  assert.equal(isFrozenDeadPosition(adjacentKingsState), false);

  // 3. Side NOT to move in check
  // In issue FEN turn is 'b'. Let's flip turn to 'w' so White is to move, but Black is in check.
  const opponentInCheckState: PositionState = {
    ...baseState,
    turn: 'w',
  };
  assert.equal(isFrozenDeadPosition(opponentInCheckState), false);
});
