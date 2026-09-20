/**
 * Invariant test: Public UCI round-trip equivalence across all supported variants.
 *
 * For every legal move M in position P:
 *   const uci = P.toUci(M);
 *   P.play(uci) === P.play(M)
 *
 * Both execution paths must produce identical resulting positions, identical public
 * status, identical snapshots, and preserve position immutability.
 * Within every position, UCI representations of legal moves must be strictly unique.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position } from '../src/position';
import type { Move, Variant } from '../src/types';

/**
 * Asserts the UCI round-trip invariant across every legal move in the given position.
 * Returns the count of legal moves verified.
 */
function assertPositionUciRoundTrip(pos: Position): number {
  const moves = pos.legalMoves();
  assert.ok(moves.length > 0, `Position ${pos.fen()} must have at least one legal move`);

  // Uniqueness check: no two distinct legal moves can produce the same UCI string.
  const seenUci = new Map<string, Move>();
  for (const move of moves) {
    const uci = pos.toUci(move);
    assert.strictEqual(
      seenUci.get(uci),
      undefined,
      `UCI collision detected in position ${pos.fen()}: '${uci}' produced for two distinct moves`
    );
    seenUci.set(uci, move);
  }
  assert.strictEqual(seenUci.size, moves.length);

  const parentFen = pos.fen();
  const parentSnapshot = pos.snapshot();

  for (const move of moves) {
    const uci = pos.toUci(move);

    // Path A: play Move object directly
    const viaObject = pos.play(move);

    // Path B: play serialized UCI string
    const viaString = pos.play(uci);

    // 1. Resulting FEN must be byte-for-byte identical
    assert.strictEqual(
      viaString.fen(),
      viaObject.fen(),
      `FEN mismatch after playing '${uci}' in position ${pos.fen()}`
    );

    // 2. Public game status (checkmate, stalemate, variant win/draw, ongoing) must be identical
    assert.deepStrictEqual(
      viaString.status(),
      viaObject.status(),
      `Status mismatch after playing '${uci}' in position ${pos.fen()}`
    );

    // 3. Complete internal state snapshot (turn, pockets, check counters, board) must be identical
    assert.deepStrictEqual(
      viaString.snapshot(),
      viaObject.snapshot(),
      `Snapshot mismatch after playing '${uci}' in position ${pos.fen()}`
    );

    // 4. Immutability invariant: parent position must remain completely unaltered
    assert.strictEqual(pos.fen(), parentFen, 'Position.play mutated parent position FEN');
    assert.deepStrictEqual(pos.snapshot(), parentSnapshot, 'Position.play mutated parent position state');
  }

  return moves.length;
}

test('Standard chess starting position: all legal moves round-trip through UCI', () => {
  const pos = Position.initial('standard');
  const count = assertPositionUciRoundTrip(pos);
  assert.strictEqual(count, 20, 'Standard startpos must have exactly 20 legal moves');
});

test('Standard position with legal castling: kingside and queenside for both colors', () => {
  // White to move with both wings open
  const whitePos = Position.fromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const whiteCount = assertPositionUciRoundTrip(whitePos);
  assert.ok(whiteCount > 0);

  // Black to move with both wings open
  const blackPos = Position.fromFen('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
  const blackCount = assertPositionUciRoundTrip(blackPos);
  assert.ok(blackCount > 0);
});

test('En passant position: en passant capture and non-capture alternatives round-trip through UCI', () => {
  // White en-passant on f6
  const whiteEp = Position.fromFen('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
  const whiteCount = assertPositionUciRoundTrip(whiteEp);
  assert.ok(whiteCount > 0);

  // Black en-passant on d3
  const blackEp = Position.fromFen('4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 1');
  const blackCount = assertPositionUciRoundTrip(blackEp);
  assert.ok(blackCount > 0);
});

test('Pawn promotions: queen, rook, bishop, knight underpromotions round-trip through UCI', () => {
  // White quiet promotions to q, r, b, n
  const whitePromo = Position.fromFen('k7/4P3/8/8/8/8/8/4K3 w - - 0 1');
  const count = assertPositionUciRoundTrip(whitePromo);
  assert.ok(count >= 4);
  for (const uci of ['e7e8q', 'e7e8r', 'e7e8b', 'e7e8n']) {
    const move = whitePromo.legalMoves().find((m) => whitePromo.toUci(m) === uci);
    assert.ok(move, `White quiet promotion ${uci} must be legal`);
    assert.strictEqual(whitePromo.play(uci).fen(), whitePromo.play(move).fen());
  }

  // Black quiet promotions
  const blackPromo = Position.fromFen('4k3/8/8/8/8/8/4p3/K7 b - - 0 1');
  const blackCount = assertPositionUciRoundTrip(blackPromo);
  assert.ok(blackCount >= 4);
  for (const uci of ['e2e1q', 'e2e1r', 'e2e1b', 'e2e1n']) {
    const move = blackPromo.legalMoves().find((m) => blackPromo.toUci(m) === uci);
    assert.ok(move, `Black quiet promotion ${uci} must be legal`);
    assert.strictEqual(blackPromo.play(uci).fen(), blackPromo.play(move).fen());
  }
});

test('Capture promotions: promotions capturing enemy pieces round-trip through UCI', () => {
  // White capture-promotions on d8 (4 promo types) and king evasions (3 moves) = 7 legal moves
  const whiteCapPromo = Position.fromFen('3rk3/4P3/8/8/8/8/8/4K3 w - - 0 1');
  const whiteCount = assertPositionUciRoundTrip(whiteCapPromo);
  assert.strictEqual(whiteCount, 7);

  // Black capture-promotions on d1 (4 promo types), king captures d1 (1 move), king to f2 (1 move) = 6 legal moves
  const blackCapPromo = Position.fromFen('4K3/8/8/8/8/8/4p3/3Rk3 b - - 0 1');
  const blackCount = assertPositionUciRoundTrip(blackCapPromo);
  assert.strictEqual(blackCount, 6);
});

test('Tactical complex position (Kiwipete): pins, checks, captures round-trip through UCI', () => {
  const kiwipete = Position.fromFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const count = assertPositionUciRoundTrip(kiwipete);
  assert.strictEqual(count, 48, 'Kiwipete must have exactly 48 legal moves');
});

test('Chess960: all 960 starting positions round-trip through UCI with strict uniqueness', () => {
  let totalChess960Moves = 0;
  for (let id = 0; id < 960; id++) {
    const pos = Position.chess960(id);
    const count = assertPositionUciRoundTrip(pos);
    assert.ok(count > 0, `Chess960 ID ${id} must have legal moves`);
    totalChess960Moves += count;
  }
  assert.strictEqual(totalChess960Moves, 18882, 'All 960 positions must produce exactly 18,882 legal moves');
});

test('Chess960 castling-specific edge cases: UCI_Chess960 king-takes-rook encoding round-trip', () => {
  // 1. King on b1, not on e-file (rooks on a1 and h1)
  const kingNotOnE = Position.fromFen('8/8/8/k7/8/8/8/RK5R w KQ - 0 1', 'chess960');
  assertPositionUciRoundTrip(kingNotOnE);

  // 2. Inner rook on b1 (rook not on a/h file)
  const innerRook = Position.fromFen('8/8/8/k7/8/8/8/1R2K2R w KQ - 0 1', 'chess960');
  assertPositionUciRoundTrip(innerRook);

  // 3. King already on destination square g1 (UCI is g1h1)
  const kingOnDest = Position.fromFen('8/8/8/k7/8/8/8/R5KR w KQ - 0 1', 'chess960');
  assertPositionUciRoundTrip(kingOnDest);

  // 4. Rook already on destination square f1 (UCI is e1f1)
  const rookOnDest = Position.fromFen('8/8/8/k7/8/8/8/R3KR2 w KQ - 0 1', 'chess960');
  assertPositionUciRoundTrip(rookOnDest);

  // 5. King and rook crossover / swap (King on b1, rook on c1)
  const crossover = Position.fromFen('8/8/8/k7/8/8/8/RKR5 w K - 0 1', 'chess960');
  assertPositionUciRoundTrip(crossover);

  // 6. King and rook directly adjacent (King on f1, rook on g1)
  const adjacent = Position.fromFen('8/8/8/k7/8/8/8/R4KR1 w KQ - 0 1', 'chess960');
  assertPositionUciRoundTrip(adjacent);
});

test('Crazyhouse: legal moves and pocket drops round-trip through UCI', () => {
  // Full pocket [QRBNP]
  const fullPocket = Position.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[QRBNP] w KQkq - 0 1', 'crazyhouse');
  const count = assertPositionUciRoundTrip(fullPocket);
  assert.ok(count > 20, 'Crazyhouse with pockets must have drop moves exceeding standard moves');

  // Interposing drop to block check
  const blockCheck = Position.fromFen('4k3/8/8/8/8/8/8/4K2r[P] w - - 0 1', 'crazyhouse');
  const blockCount = assertPositionUciRoundTrip(blockCheck);
  assert.ok(blockCount > 0);

  // Checkmating drop
  const dropMate = Position.fromFen('7k/5ppp/8/8/8/8/8/4K3[Q] w - - 0 1', 'crazyhouse');
  const mateCount = assertPositionUciRoundTrip(dropMate);
  assert.ok(mateCount > 0);
  const matingDropMove = dropMate.legalMoves().find((m) => dropMate.toUci(m) === 'Q@e8');
  assert.ok(matingDropMove, 'Q@e8 must be a legal drop');
  const dropViaObj = dropMate.play(matingDropMove);
  const dropViaStr = dropMate.play('Q@e8');
  const objStatus = dropViaObj.status();
  const strStatus = dropViaStr.status();
  assert.ok(objStatus.over, 'Object move must result in game over');
  assert.ok(strStatus.over, 'String move must result in game over');
  if (objStatus.over && strStatus.over) {
    assert.strictEqual(objStatus.reason, 'checkmate');
    assert.strictEqual(strStatus.reason, 'checkmate');
  }
  assert.strictEqual(dropViaStr.fen(), dropViaObj.fen());
});

test('Three-check: move round-trip preserves check-counter semantics and terminal win', () => {
  // Initial position
  const start = Position.initial('threecheck');
  assertPositionUciRoundTrip(start);

  // Single check delivery (3+3 -> 2+3)
  const singleCheck = Position.fromFen('4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1', 'threecheck');
  assertPositionUciRoundTrip(singleCheck);

  // Second check delivery (2+3 -> 1+3)
  const secondCheck = Position.fromFen('4k3/8/8/8/8/8/8/3R3K w - - 2+3 0 1', 'threecheck');
  assertPositionUciRoundTrip(secondCheck);

  // Terminal third check delivery
  const terminalCheck = Position.fromFen('4k3/8/8/8/8/8/8/3R3K w - - 1+3 0 1', 'threecheck');
  assertPositionUciRoundTrip(terminalCheck);
});

test('Atomic: captures with non-pawn explosion round-trip through UCI', () => {
  // Queen capture explosion
  const queenExplosion = Position.fromFen('4k3/8/8/7q/8/8/8/3QK3 w - - 0 1', 'atomic');
  assertPositionUciRoundTrip(queenExplosion);
  const queenCapture = queenExplosion.legalMoves().find((m) => queenExplosion.toUci(m) === 'd1h5');
  assert.ok(queenCapture, 'd1h5 capture explosion must be legal');
  const queenViaObj = queenExplosion.play(queenCapture);
  const queenViaStr = queenExplosion.play('d1h5');
  assert.strictEqual(queenViaStr.fen(), '4k3/8/8/8/8/8/8/4K3 b - - 0 1');
  assert.strictEqual(queenViaObj.fen(), queenViaStr.fen());

  // Capture promotion explosion
  const capPromoExplosion = Position.fromFen('k2r4/4P3/8/8/8/8/8/4K3 w - - 0 1', 'atomic');
  assertPositionUciRoundTrip(capPromoExplosion);
  for (const uci of ['e7d8q', 'e7d8r', 'e7d8b', 'e7d8n']) {
    const move = capPromoExplosion.legalMoves().find((m) => capPromoExplosion.toUci(m) === uci);
    assert.ok(move, `Atomic capture promotion ${uci} must be legal`);
    const viaObj = capPromoExplosion.play(move);
    const viaStr = capPromoExplosion.play(uci);
    assert.strictEqual(viaStr.fen(), 'k7/8/8/8/8/8/8/4K3 b - - 0 1');
    assert.strictEqual(viaObj.fen(), viaStr.fen());
  }

  // En passant capture explosion
  const epExplosion = Position.fromFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'atomic');
  assertPositionUciRoundTrip(epExplosion);
});

test('Horde: kingless pawn army and standard Black army round-trip through UCI', () => {
  // Start position (36 White pawns)
  const hordeStart = Position.initial('horde');
  const hordeCount = assertPositionUciRoundTrip(hordeStart);
  assert.ok(hordeCount > 0);

  // Rank 1 double push
  const rank1Push = Position.fromFen('k7/8/8/8/8/8/8/P7 w - - 0 1', 'horde');
  assertPositionUciRoundTrip(rank1Push);

  // Black castling in horde
  const blackCastle = Position.fromFen('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/PPPPPPPP b kq - 0 1', 'horde');
  assertPositionUciRoundTrip(blackCastle);

  // Open flank position
  const openFlank = Position.fromFen('4k3/pp4q1/3P2p1/8/P3PP2/PPP2r2/PPP5/PPPP4 b - - 0 1', 'horde');
  assertPositionUciRoundTrip(openFlank);
});

test('Racing Kings: check-free race to rank 8 round-trip through UCI', () => {
  // Start position
  const rkStart = Position.initial('racingkings');
  const rkCount = assertPositionUciRoundTrip(rkStart);
  assert.ok(rkCount > 0);

  // White winning position (Black cannot equalize)
  const whiteWin = Position.fromFen('2K5/8/8/8/8/8/8/4k3 b - - 0 1', 'racingkings');
  assertPositionUciRoundTrip(whiteWin);

  // Equalizing position (Black reaches rank 8 for draw)
  const equalizeDraw = Position.fromFen('2K5/4k3/8/8/8/8/8/8 b - - 0 1', 'racingkings');
  assertPositionUciRoundTrip(equalizeDraw);
});

test('King of the Hill: standard move generation and center occupation round-trip through UCI', () => {
  // Start position
  const kothStart = Position.initial('kingofthehill');
  const kothCount = assertPositionUciRoundTrip(kothStart);
  assert.strictEqual(kothCount, 20);

  // Center occupation step: king moves from outside center (c3) into center (d4) to win
  const centerWin = Position.fromFen('8/8/8/8/8/2K5/8/7k w - - 0 1', 'kingofthehill');
  assertPositionUciRoundTrip(centerWin);
  const winMove = centerWin.legalMoves().find((m) => centerWin.toUci(m) === 'c3d4');
  assert.ok(winMove, 'c3d4 must be a legal move');
  assert.strictEqual(centerWin.status().over, false);
  const afterObj = centerWin.play(winMove);
  const afterStr = centerWin.play('c3d4');
  const objStatus = afterObj.status();
  const strStatus = afterStr.status();
  assert.ok(objStatus.over, 'Object move must result in game over');
  assert.ok(strStatus.over, 'String move must result in game over');
  if (objStatus.over && strStatus.over) {
    assert.strictEqual(objStatus.reason, 'variant_win');
    assert.strictEqual(objStatus.winner, 'w');
  }
  assert.strictEqual(afterStr.fen(), afterObj.fen());
});
