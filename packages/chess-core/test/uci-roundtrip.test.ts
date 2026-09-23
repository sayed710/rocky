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
import { MoveFlag, type Move, type PieceType } from '../src/types';

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

/**
 * Asserts that a specific legal move exists in pos, optionally carries the expected flag,
 * and produces identical results whether played via Move object or via UCI string.
 */
function assertSpecificMoveRoundTrip(
  pos: Position,
  expectedUci: string,
  expectedFlag?: MoveFlag
): { move: Move; after: Position } {
  const move = pos.legalMoves().find((m) => pos.toUci(m) === expectedUci);
  assert.ok(move, `Expected legal move '${expectedUci}' not found in position ${pos.fen()}`);
  if (expectedFlag !== undefined) {
    assert.strictEqual(
      (move.flags & expectedFlag),
      expectedFlag,
      `Move '${expectedUci}' in position ${pos.fen()} expected flag ${expectedFlag}, got ${move.flags}`
    );
  }
  const viaObject = pos.play(move);
  const viaString = pos.play(expectedUci);
  assert.strictEqual(
    viaString.fen(),
    viaObject.fen(),
    `FEN mismatch for move '${expectedUci}' in position ${pos.fen()}`
  );
  assert.deepStrictEqual(
    viaString.status(),
    viaObject.status(),
    `Status mismatch for move '${expectedUci}' in position ${pos.fen()}`
  );
  assert.deepStrictEqual(
    viaString.snapshot(),
    viaObject.snapshot(),
    `Snapshot mismatch for move '${expectedUci}' in position ${pos.fen()}`
  );
  return { move, after: viaString };
}

test('Standard chess starting position: all legal moves round-trip through UCI', () => {
  const pos = Position.initial('standard');
  const count = assertPositionUciRoundTrip(pos);
  assert.strictEqual(count, 20, 'Standard startpos must have exactly 20 legal moves');
});

test('Standard position with legal castling: kingside and queenside for both colors', () => {
  // White to move with both wings open
  const whitePos = Position.fromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assertPositionUciRoundTrip(whitePos);
  assertSpecificMoveRoundTrip(whitePos, 'e1g1', MoveFlag.KingCastle);
  assertSpecificMoveRoundTrip(whitePos, 'e1c1', MoveFlag.QueenCastle);

  // Black to move with both wings open
  const blackPos = Position.fromFen('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
  assertPositionUciRoundTrip(blackPos);
  assertSpecificMoveRoundTrip(blackPos, 'e8g8', MoveFlag.KingCastle);
  assertSpecificMoveRoundTrip(blackPos, 'e8c8', MoveFlag.QueenCastle);
});

test('En passant position: en passant capture and non-capture alternatives round-trip through UCI', () => {
  // White en-passant on f6
  const whiteEp = Position.fromFen('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
  assertPositionUciRoundTrip(whiteEp);
  const { after: afterWhite } = assertSpecificMoveRoundTrip(whiteEp, 'e5f6', MoveFlag.EnPassant);
  assert.strictEqual(
    afterWhite.fen(),
    'rnbqkbnr/ppp1p1pp/5P2/3p4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3',
    'En passant capture e5f6 must remove the captured black pawn at f5'
  );

  // Black en-passant on d3
  const blackEp = Position.fromFen('4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 1');
  assertPositionUciRoundTrip(blackEp);
  const { after: afterBlack } = assertSpecificMoveRoundTrip(blackEp, 'e4d3', MoveFlag.EnPassant);
  assert.strictEqual(
    afterBlack.fen(),
    '4k3/8/8/8/8/3p4/8/4K3 w - - 0 2',
    'En passant capture e4d3 must remove the captured white pawn at d4'
  );
});

test('Pawn promotions: queen, rook, bishop, knight underpromotions round-trip through UCI', () => {
  // White quiet promotions to q, r, b, n
  const whitePromo = Position.fromFen('k7/4P3/8/8/8/8/8/4K3 w - - 0 1');
  assertPositionUciRoundTrip(whitePromo);
  for (const uci of ['e7e8q', 'e7e8r', 'e7e8b', 'e7e8n']) {
    const move = whitePromo.legalMoves().find((m) => whitePromo.toUci(m) === uci);
    assert.ok(move, `White quiet promotion ${uci} must be legal`);
    assert.strictEqual(whitePromo.play(uci).fen(), whitePromo.play(move).fen());
  }

  // Black quiet promotions
  const blackPromo = Position.fromFen('4k3/8/8/8/8/8/4p3/K7 b - - 0 1');
  assertPositionUciRoundTrip(blackPromo);
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
  for (const uci of ['e7d8q', 'e7d8r', 'e7d8b', 'e7d8n']) {
    assertSpecificMoveRoundTrip(whiteCapPromo, uci, MoveFlag.Promotion | MoveFlag.Capture);
  }

  // Black capture-promotions on d1 (4 promo types), king captures d1 (1 move), king to f2 (1 move) = 6 legal moves
  const blackCapPromo = Position.fromFen('4K3/8/8/8/8/8/4p3/3Rk3 b - - 0 1');
  const blackCount = assertPositionUciRoundTrip(blackCapPromo);
  assert.strictEqual(blackCount, 6);
  for (const uci of ['e2d1q', 'e2d1r', 'e2d1b', 'e2d1n']) {
    assertSpecificMoveRoundTrip(blackCapPromo, uci, MoveFlag.Promotion | MoveFlag.Capture);
  }
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
  assertSpecificMoveRoundTrip(kingNotOnE, 'b1h1', MoveFlag.KingCastle);
  assertSpecificMoveRoundTrip(kingNotOnE, 'b1a1', MoveFlag.QueenCastle);

  // 2. Inner rook on b1 (rook not on a/h file)
  const innerRook = Position.fromFen('8/8/8/k7/8/8/8/1R2K2R w KQ - 0 1', 'chess960');
  assertPositionUciRoundTrip(innerRook);
  assertSpecificMoveRoundTrip(innerRook, 'e1h1', MoveFlag.KingCastle);
  assertSpecificMoveRoundTrip(innerRook, 'e1b1', MoveFlag.QueenCastle);

  // 3. King already on destination square g1 (UCI is g1h1)
  const kingOnDest = Position.fromFen('8/8/8/k7/8/8/8/R5KR w KQ - 0 1', 'chess960');
  assertPositionUciRoundTrip(kingOnDest);
  assertSpecificMoveRoundTrip(kingOnDest, 'g1h1', MoveFlag.KingCastle);
  assertSpecificMoveRoundTrip(kingOnDest, 'g1a1', MoveFlag.QueenCastle);

  // 4. Rook already on destination square f1 (UCI is e1f1)
  const rookOnDest = Position.fromFen('8/8/8/k7/8/8/8/R3KR2 w KQ - 0 1', 'chess960');
  assertPositionUciRoundTrip(rookOnDest);
  assertSpecificMoveRoundTrip(rookOnDest, 'e1f1', MoveFlag.KingCastle);
  assertSpecificMoveRoundTrip(rookOnDest, 'e1a1', MoveFlag.QueenCastle);

  // 5. King and rook crossover / swap (King on b1, rook on c1)
  const crossover = Position.fromFen('8/8/8/k7/8/8/8/RKR5 w K - 0 1', 'chess960');
  assertPositionUciRoundTrip(crossover);
  assertSpecificMoveRoundTrip(crossover, 'b1c1', MoveFlag.KingCastle);

  // 6. King and rook directly adjacent (King on f1, rook on g1)
  const adjacent = Position.fromFen('8/8/8/k7/8/8/8/R4KR1 w KQ - 0 1', 'chess960');
  assertPositionUciRoundTrip(adjacent);
  assertSpecificMoveRoundTrip(adjacent, 'f1g1', MoveFlag.KingCastle);
  assertSpecificMoveRoundTrip(adjacent, 'f1a1', MoveFlag.QueenCastle);
});

test('Crazyhouse: legal moves and pocket drops round-trip through UCI', () => {
  // Full pocket [QRBNP]
  const fullPocket = Position.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[QRBNP] w KQkq - 0 1', 'crazyhouse');
  const count = assertPositionUciRoundTrip(fullPocket);
  assert.ok(count > 20, 'Crazyhouse with pockets must have drop moves exceeding standard moves');

  // Representative drops for each pocket piece type: P@e4, N@c3, B@e3, R@d3, Q@d4
  const representativeDrops: [string, PieceType][] = [
    ['P@e4', 'p'],
    ['N@c3', 'n'],
    ['B@e3', 'b'],
    ['R@d3', 'r'],
    ['Q@d4', 'q'],
  ];
  for (const [uci, piece] of representativeDrops) {
    const { move } = assertSpecificMoveRoundTrip(fullPocket, uci);
    assert.strictEqual(move.from, -1, `Drop move '${uci}' must have from === -1`);
    assert.strictEqual(move.drop, piece, `Drop move '${uci}' must have drop === '${piece}'`);
  }

  // Interposing drop to block check
  const blockCheck = Position.fromFen('4k3/8/8/8/8/8/8/4K2r[B] w - - 0 1', 'crazyhouse');
  assertPositionUciRoundTrip(blockCheck);
  const { move: interposeMove } = assertSpecificMoveRoundTrip(blockCheck, 'B@f1');
  assert.strictEqual(interposeMove.from, -1);
  assert.strictEqual(interposeMove.drop, 'b');

  // Checkmating drop
  const dropMate = Position.fromFen('7k/5ppp/8/8/8/8/8/4K3[Q] w - - 0 1', 'crazyhouse');
  assertPositionUciRoundTrip(dropMate);
  const { move: matingDropMove, after: dropAfter } = assertSpecificMoveRoundTrip(dropMate, 'Q@e8');
  assert.strictEqual(matingDropMove.from, -1);
  assert.strictEqual(matingDropMove.drop, 'q');
  const dropStatus = dropAfter.status();
  assert.ok(dropStatus.over, 'Q@e8 must result in game over');
  assert.strictEqual(dropStatus.reason, 'checkmate');
});

test('Three-check: move round-trip preserves check-counter semantics and terminal win', () => {
  // Initial position
  const start = Position.initial('threecheck');
  assertPositionUciRoundTrip(start);

  // FEN records checks remaining; snapshot.checkCount records checks delivered.
  // Single check delivery (3+3 -> 2+3)
  const singleCheck = Position.fromFen('4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1', 'threecheck');
  assertPositionUciRoundTrip(singleCheck);
  const { after: afterSingle } = assertSpecificMoveRoundTrip(singleCheck, 'd1e1');
  assert.strictEqual(
    afterSingle.fen(),
    '4k3/8/8/8/8/8/8/4R2K b - - 2+3 1 1',
    'Delivering first check must transition counter from 3+3 to 2+3'
  );
  assert.deepStrictEqual(
    afterSingle.snapshot().checkCount,
    { w: 1, b: 0 },
    'Delivering first check must record 1 check delivered by White in snapshot'
  );

  // Second check delivery (2+3 -> 1+3)
  const secondCheck = Position.fromFen('4k3/8/8/8/8/8/8/3R3K w - - 2+3 0 1', 'threecheck');
  assertPositionUciRoundTrip(secondCheck);
  const { after: afterSecond } = assertSpecificMoveRoundTrip(secondCheck, 'd1e1');
  assert.strictEqual(
    afterSecond.fen(),
    '4k3/8/8/8/8/8/8/4R2K b - - 1+3 1 1',
    'Delivering second check must transition counter from 2+3 to 1+3'
  );
  assert.deepStrictEqual(
    afterSecond.snapshot().checkCount,
    { w: 2, b: 0 },
    'Delivering second check must record 2 checks delivered by White in snapshot'
  );

  // Terminal third check delivery
  const terminalCheck = Position.fromFen('4k3/8/8/8/8/8/8/3R3K w - - 1+3 0 1', 'threecheck');
  assertPositionUciRoundTrip(terminalCheck);
  const { after: afterTerminal } = assertSpecificMoveRoundTrip(terminalCheck, 'd1e1');
  const tcStatus = afterTerminal.status();
  assert.ok(tcStatus.over, 'Terminal check must end game');
  assert.strictEqual(tcStatus.reason, 'variant_win');
  assert.strictEqual(tcStatus.winner, 'w');
});

test('Atomic: captures with non-pawn explosion round-trip through UCI', () => {
  // Queen capture explosion
  const queenExplosion = Position.fromFen('4k3/8/8/7q/8/8/8/3QK3 w - - 0 1', 'atomic');
  assertPositionUciRoundTrip(queenExplosion);
  const { after: afterQueen } = assertSpecificMoveRoundTrip(queenExplosion, 'd1h5', MoveFlag.Capture);
  assert.strictEqual(afterQueen.fen(), '4k3/8/8/8/8/8/8/4K3 b - - 0 1');

  // Atomic collateral damage excludes pawns adjacent to the capture square.
  const pawnSurvives = Position.fromFen('4k3/8/8/6Pq/8/8/8/3QK3 w - - 0 1', 'atomic');
  assertPositionUciRoundTrip(pawnSurvives);
  const { after: afterPawnSurvives } = assertSpecificMoveRoundTrip(pawnSurvives, 'd1h5', MoveFlag.Capture);
  assert.strictEqual(afterPawnSurvives.fen(), '4k3/8/8/6P1/8/8/8/4K3 b - - 0 1');

  // Capture promotion explosion
  const capPromoExplosion = Position.fromFen('k2r4/4P3/8/8/8/8/8/4K3 w - - 0 1', 'atomic');
  assertPositionUciRoundTrip(capPromoExplosion);
  for (const uci of ['e7d8q', 'e7d8r', 'e7d8b', 'e7d8n']) {
    const { after } = assertSpecificMoveRoundTrip(capPromoExplosion, uci, MoveFlag.Promotion | MoveFlag.Capture);
    assert.strictEqual(after.fen(), 'k7/8/8/8/8/8/8/4K3 b - - 0 1');
  }

  // En passant capture explosion
  const epExplosion = Position.fromFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'atomic');
  assertPositionUciRoundTrip(epExplosion);
  const { after: afterEp } = assertSpecificMoveRoundTrip(epExplosion, 'e5d6', MoveFlag.EnPassant);
  assert.strictEqual(
    afterEp.fen(),
    '4k3/8/8/8/8/8/8/4K3 b - - 0 1',
    'Atomic en passant capture e5d6 must explode both pawns leaving board empty of pawns'
  );
});

test('Horde: kingless pawn army and standard Black army round-trip through UCI', () => {
  // Start position (36 White pawns)
  const hordeStart = Position.initial('horde');
  assertPositionUciRoundTrip(hordeStart);

  // Rank 1 double push
  const rank1Push = Position.fromFen('k7/8/8/8/8/8/8/P7 w - - 0 1', 'horde');
  assertPositionUciRoundTrip(rank1Push);
  assertSpecificMoveRoundTrip(rank1Push, 'a1a3', MoveFlag.DoublePawnPush);

  // Black castling in horde
  const blackCastle = Position.fromFen('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/PPPPPPPP b kq - 0 1', 'horde');
  assertPositionUciRoundTrip(blackCastle);
  assertSpecificMoveRoundTrip(blackCastle, 'e8g8', MoveFlag.KingCastle);
  assertSpecificMoveRoundTrip(blackCastle, 'e8c8', MoveFlag.QueenCastle);

  // Open flank position
  const openFlank = Position.fromFen('4k3/pp4q1/3P2p1/8/P3PP2/PPP2r2/PPP5/PPPP4 b - - 0 1', 'horde');
  const openFlankCount = assertPositionUciRoundTrip(openFlank);
  assert.strictEqual(openFlankCount, 30, 'Horde openFlank must have exactly 30 legal moves');
  assertSpecificMoveRoundTrip(openFlank, 'f3f4', MoveFlag.Capture);
  assertSpecificMoveRoundTrip(openFlank, 'f3c3', MoveFlag.Capture);
  assertSpecificMoveRoundTrip(openFlank, 'g7c3', MoveFlag.Capture);
  assertSpecificMoveRoundTrip(openFlank, 'a7a5', MoveFlag.DoublePawnPush);
  assertSpecificMoveRoundTrip(openFlank, 'e8d7');
});

test('Racing Kings: check-free race to rank 8 round-trip through UCI', () => {
  // Start position
  const rkStart = Position.initial('racingkings');
  const rkCount = assertPositionUciRoundTrip(rkStart);
  assert.strictEqual(rkCount, 21, 'Racing Kings startpos must have exactly 21 legal moves');
  // Forward race moves round-trip cleanly
  assertSpecificMoveRoundTrip(rkStart, 'h2h3');
  assertSpecificMoveRoundTrip(rkStart, 'g2g3');
  assertSpecificMoveRoundTrip(rkStart, 'e2d4');
  // Anti-check rule: the knight can reach c3/c1, but either move checks Black's king on a2.
  // The same board under standard rules is the positive control for move geometry and king safety.
  const standardControl = Position.fromFen(rkStart.fen(), 'standard');
  const standardLegalUcis = standardControl.legalMoves().map((m) => standardControl.toUci(m));
  const rkLegalUcis = rkStart.legalMoves().map((m) => rkStart.toUci(m));
  for (const uci of ['e2c3', 'e2c1']) {
    assert.ok(standardLegalUcis.includes(uci), `${uci} must be legal on the same board under standard rules`);
    assert.ok(standardControl.play(uci).isCheck(), `${uci} must check Black's king under standard rules`);
    assert.strictEqual(rkLegalUcis.includes(uci), false, `${uci} must be excluded only by the Racing Kings anti-check rule`);
  }

  // White winning position (White reaches rank 8 and Black cannot equalize)
  const whiteWin = Position.fromFen('8/2K5/8/8/8/8/8/4k3 w - - 0 1', 'racingkings');
  assertPositionUciRoundTrip(whiteWin);
  assert.strictEqual(whiteWin.status().over, false);
  const { after: afterWhiteWin } = assertSpecificMoveRoundTrip(whiteWin, 'c7c8');
  const rkWinStatus = afterWhiteWin.status();
  assert.ok(rkWinStatus.over, 'Reaching rank 8 must end game when Black cannot equalize');
  assert.strictEqual(rkWinStatus.reason, 'variant_win');
  assert.strictEqual(rkWinStatus.winner, 'w');

  // One rank away, Black retains the equalizing move after White reaches rank 8.
  const blackCanEqualize = Position.fromFen('8/2K1k3/8/8/8/8/8/8 w - - 0 1', 'racingkings');
  assertPositionUciRoundTrip(blackCanEqualize);
  const { after: awaitingBlack } = assertSpecificMoveRoundTrip(blackCanEqualize, 'c7c8');
  assert.deepStrictEqual(awaitingBlack.status(), { over: false });
  assertPositionUciRoundTrip(awaitingBlack);
  const { after: afterEqualizingReply } = assertSpecificMoveRoundTrip(awaitingBlack, 'e7e8');
  assert.deepStrictEqual(afterEqualizingReply.status(), { over: true, reason: 'variant_draw' });

  // Equalizing position (Black reaches rank 8 for draw)
  const equalizeDraw = Position.fromFen('2K5/4k3/8/8/8/8/8/8 b - - 0 1', 'racingkings');
  assertPositionUciRoundTrip(equalizeDraw);
  assert.strictEqual(equalizeDraw.status().over, false);
  const { after: afterEqualize } = assertSpecificMoveRoundTrip(equalizeDraw, 'e7e8');
  assert.deepStrictEqual(
    afterEqualize.status(),
    { over: true, reason: 'variant_draw' },
    'Black equalizing king move to rank 8 must yield variant_draw'
  );
});

test('King of the Hill: standard move generation and center occupation round-trip through UCI', () => {
  // Start position
  const kothStart = Position.initial('kingofthehill');
  const kothCount = assertPositionUciRoundTrip(kothStart);
  assert.strictEqual(kothCount, 20);

  // Center occupation step: king moves from outside center (c3) into center (d4) to win
  const centerWin = Position.fromFen('8/8/8/8/8/2K5/8/7k w - - 0 1', 'kingofthehill');
  assertPositionUciRoundTrip(centerWin);
  assert.strictEqual(centerWin.status().over, false);
  const { after: afterWin } = assertSpecificMoveRoundTrip(centerWin, 'c3d4');
  const kothStatus = afterWin.status();
  assert.ok(kothStatus.over, 'King reaching the center must end the game');
  assert.strictEqual(kothStatus.reason, 'variant_win');
  assert.strictEqual(kothStatus.winner, 'w');
});
