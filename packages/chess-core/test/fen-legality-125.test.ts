import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position, IllegalMoveError } from '../src/position';
import { parseFen, toFen, FenError } from '../src/fen';
import { validatePositionSemantics, validateFen } from '../src/position-validator';
import { applyMove, findKing } from '../src/movegen';
import { squareFromName } from '../src/board';
import { MoveFlag, type Move, type Variant } from '../src/types';

// Three recorded Standard FENs from Issue 125
const FEN_ADJACENT_KINGS = '8/8/8/8/8/8/8/kK6 b - - 0 1';
const FEN_ADJACENT_KINGS_BISHOP = '8/8/8/8/8/8/B7/kK6 b - - 0 1';
const FEN_SIDE_NOT_TO_MOVE_IN_CHECK = '4k3/8/8/8/8/8/8/4R1K1 w - - 0 1';

test('F125-01: raw parse remains permissive for historical decoding contract', () => {
  // Syntax/decoding contract of parseFen and Position.fromFen must remain unchanged
  assert.doesNotThrow(() => parseFen(FEN_ADJACENT_KINGS, 'standard'));
  assert.doesNotThrow(() => parseFen(FEN_ADJACENT_KINGS_BISHOP, 'standard'));
  assert.doesNotThrow(() => parseFen(FEN_SIDE_NOT_TO_MOVE_IN_CHECK, 'standard'));
  assert.doesNotThrow(() => Position.fromFen(FEN_ADJACENT_KINGS, 'standard'));
  assert.doesNotThrow(() => Position.fromFen(FEN_ADJACENT_KINGS_BISHOP, 'standard'));
  assert.doesNotThrow(() => Position.fromFen(FEN_SIDE_NOT_TO_MOVE_IN_CHECK, 'standard'));
});

test('F125-01: validatePositionSemantics and validateFen reject recorded invalid FENs', () => {
  assert.throws(
    () => validateFen(FEN_ADJACENT_KINGS, 'standard'),
    FenError,
    'adjacent kings must be rejected',
  );
  assert.throws(
    () => validateFen(FEN_ADJACENT_KINGS_BISHOP, 'standard'),
    FenError,
    'adjacent kings with bishop must be rejected',
  );
  assert.throws(
    () => validateFen(FEN_SIDE_NOT_TO_MOVE_IN_CHECK, 'standard'),
    FenError,
    'side not to move in check must be rejected',
  );
});

test('F125-02: all 8 variant initial positions pass semantic validation', () => {
  const variants: Variant[] = [
    'standard',
    'chess960',
    'threecheck',
    'crazyhouse',
    'kingofthehill',
    'atomic',
    'horde',
    'racingkings',
  ];
  for (const variant of variants) {
    const initialFen = Position.initial(variant).fen();
    assert.doesNotThrow(
      () => validateFen(initialFen, variant),
      `${variant} initial position must be valid`,
    );
  }
});

test('F125-02: legal nonterminal in-check with evasions and checkmate actual status', () => {
  // 1. Nonterminal check: White in check from Qh4, but has legal escapes (g3, Ke2, etc.)
  const nonTerminalCheckFen = 'rnb1kbnr/pppp1ppp/8/8/4Pp1q/2N5/PPPP2PP/R1BQKBNR w KQkq - 2 4';
  const posInCheck = Position.fromFen(nonTerminalCheckFen, 'standard');
  assert.equal(posInCheck.isCheck(), true, 'position must be in check');
  assert.equal(posInCheck.status().over, false, 'game must not be over (legal escapes exist)');
  assert.ok(posInCheck.legalMoves().length > 0, 'legal moves must be available');
  assert.doesNotThrow(() => validateFen(posInCheck.fen(), 'standard'), 'nonterminal check must be valid');

  // 2. Scholar's mate checkmate (side to move Black has 0 legal moves and is checkmated)
  const scholarMate = 'r1bqkb1r/pppp1Qpp/2n5/4p3/2B1n3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4';
  const posMate = Position.fromFen(scholarMate, 'standard');
  assert.deepEqual(posMate.status(), { over: true, reason: 'checkmate', winner: 'w' });
  assert.doesNotThrow(() => validateFen(scholarMate, 'standard'), 'checkmate position must be semantically valid');
});

test('F125-02: atomic variant permits adjacent kings and enforces atomic check rules', () => {
  // Connected / adjacent kings legal in atomic
  const connectedFen = '8/8/8/3k4/3K4/8/8/8 w - - 0 1';
  assert.doesNotThrow(() => validateFen(connectedFen, 'atomic'));

  // Side not to move in check (when not connected) is rejected
  const illegalCheckAtomic = '8/8/8/8/3k4/8/8/3R1K2 w - - 0 1'; // White rook on d1 checking black king on d4 on White turn
  assert.throws(() => validateFen(illegalCheckAtomic, 'atomic'), FenError);

  // Both kings required for analysis / ingress
  assert.throws(() => validateFen('8/8/8/8/8/8/8/4K3 w - - 0 1', 'atomic'), FenError);
  assert.throws(() => validateFen('8/8/8/8/8/8/8/4k3 w - - 0 1', 'atomic'), FenError);
});

test('F125-02: atomic legal king explosion vs illegal self explosion', () => {
  // Legal king explosion: non-king capture explodes enemy king while own king survives
  const pExplodeEnemy = Position.fromFen('8/8/3k4/3n4/5N2/8/8/K7 w - - 0 1', 'atomic');
  const ucis = pExplodeEnemy.legalMoves().map((m) => pExplodeEnemy.toUci(m));
  assert.ok(ucis.includes('f4d5'), 'Nf4xd5 explodes enemy king on d6 and is legal');
  const afterWin = pExplodeEnemy.play('f4d5');
  assert.deepEqual(afterWin.status(), { over: true, reason: 'variant_win', winner: 'w' });

  // Illegal self-explosion: Nf4xd5 explodes d4 (white king) and d6 (black king)
  const pExplodeBoth = Position.fromFen('8/8/3k4/3n4/3K1N2/8/8/8 w - - 0 1', 'atomic');
  const ucisBoth = pExplodeBoth.legalMoves().map((m) => pExplodeBoth.toUci(m));
  assert.ok(!ucisBoth.includes('f4d5'), 'Nf4xd5 would explode both kings and is illegal');
  assert.throws(() => pExplodeBoth.play('f4d5'), IllegalMoveError);
});

test('F125-02: atomic legal opening sequence with adjacent blast threat is valid and not opposite-check', () => {
  // Opening sequence: 1. e4 Nc6 2. Qh5 a6
  // Verified with python-chess 1.11.2 oracle and Lichess Atomic rules: all 4 moves are legal from initial setup.
  let pos = Position.initial('atomic');
  for (const uci of ['e2e4', 'b8c6', 'd1h5', 'a7a6']) {
    pos = pos.play(uci);
  }

  const fen = pos.fen();
  assert.equal(fen, 'r1bqkbnr/1ppppppp/p1n5/7Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 0 3');
  assert.equal(pos.status().over, false);

  // Bounded semantic validation accepts this position (blast threat on f7 is NOT opposite-check)
  assert.doesNotThrow(() => validateFen(fen, 'atomic'));
  assert.doesNotThrow(() => validatePositionSemantics(pos.snapshot()));

  // Winning capture Qxf7 explodes Black king and terminates the game as variant_win
  const legalUcis = pos.legalMoves().map((m) => pos.toUci(m));
  assert.ok(legalUcis.includes('h5f7'), 'Qh5xf7 must be legal winning capture');
  const won = pos.play('h5f7');
  assert.deepEqual(won.status(), { over: true, reason: 'variant_win', winner: 'w' });
});

test('F125-02: horde variant rules (White 0 kings, Black 1 king, rank 1 pawns, check rules)', () => {
  const hordeStart = Position.initial('horde').fen();
  assert.doesNotThrow(() => validateFen(hordeStart, 'horde'));

  // White king present is rejected
  const withWhiteKing = hordeStart.replace('PPPPPPPP w', 'PPPPPPPK w');
  assert.throws(() => validateFen(withWhiteKing, 'horde'), FenError);

  // Black king absent is rejected (rnbq1bnr is valid 8 files: 4 pieces + 1 empty + 3 pieces)
  const withoutBlackKing = hordeStart.replace('rnbqkbnr/pppppppp', 'rnbq1bnr/pppppppp');
  assert.throws(
    () => validateFen(withoutBlackKing, 'horde'),
    (err: unknown) =>
      err instanceof FenError &&
      err.message.includes('Invalid king count for horde: expected White=0, Black=1; got White=0, Black=0'),
  );

  // Black king in check on White's turn is illegal
  const blackCheckedWhiteTurn = '4k3/8/8/8/8/8/8/4R3 w - - 0 1';
  assert.throws(() => validateFen(blackCheckedWhiteTurn, 'horde'), FenError);

  // Black king in check on Black's turn is legal
  const blackCheckedBlackTurn = '4k3/8/8/8/8/8/8/4R3 b - - 0 1';
  assert.doesNotThrow(() => validateFen(blackCheckedBlackTurn, 'horde'));
});

test('F125-02: racing kings variant rules (neither king in check)', () => {
  const rkStart = Position.initial('racingkings').fen();
  assert.doesNotThrow(() => validateFen(rkStart, 'racingkings'));

  // White king checked by Black rook on f8 (both kings present on f1 and d1, non-adjacent)
  const whiteCheckedOnWhiteTurn = '5r2/8/8/8/8/8/8/3k1K2 w - - 0 1';
  assert.throws(
    () => validateFen(whiteCheckedOnWhiteTurn, 'racingkings'),
    (err: unknown) => err instanceof FenError && err.message.includes('Neither king may be in check in Racing Kings'),
  );

  const whiteCheckedOnBlackTurn = '5r2/8/8/8/8/8/8/3k1K2 b - - 0 1';
  assert.throws(
    () => validateFen(whiteCheckedOnBlackTurn, 'racingkings'),
    (err: unknown) => err instanceof FenError && err.message.includes('Neither king may be in check in Racing Kings'),
  );

  // Black king checked by White rook on d8 (both kings present on f1 and d1, non-adjacent)
  const blackCheckedOnBlackTurn = '3R4/8/8/8/8/8/8/3k1K2 b - - 0 1';
  assert.throws(
    () => validateFen(blackCheckedOnBlackTurn, 'racingkings'),
    (err: unknown) => err instanceof FenError && err.message.includes('Neither king may be in check in Racing Kings'),
  );

  const blackCheckedOnWhiteTurn = '3R4/8/8/8/8/8/8/3k1K2 w - - 0 1';
  assert.throws(
    () => validateFen(blackCheckedOnWhiteTurn, 'racingkings'),
    (err: unknown) => err instanceof FenError && err.message.includes('Neither king may be in check in Racing Kings'),
  );

  // Legal non-checking position with both kings present and non-adjacent
  const legalRacingKings = '8/8/8/8/8/8/8/3k1K2 w - - 0 1';
  assert.doesNotThrow(() => validateFen(legalRacingKings, 'racingkings'));
});

test('F125-02: crazyhouse pocket validation', () => {
  for (const fen of [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[K] w KQkq - 0 1',
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[k] w KQkq - 0 1',
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[Kk] w KQkq - 0 1',
  ]) {
    assert.throws(() => validateFen(fen, 'crazyhouse'), FenError);
  }

  // Legal non-king pocket pieces are accepted
  assert.doesNotThrow(() => {
    validateFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[PpNn] w KQkq - 0 1', 'crazyhouse');
  });

  // Non-crazyhouse with pocket pieces is rejected
  assert.throws(
    () => validateFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[P] w KQkq - 0 1', 'standard'),
    FenError,
  );
});

test('F125-02: chess960 castling and threecheck counters', () => {
  // Chess960 starting positions
  assert.doesNotThrow(() => validateFen(Position.chess960(518).fen(), 'chess960'));
  assert.doesNotThrow(() => validateFen(Position.chess960(0).fen(), 'chess960'));

  // Chess960 castling UCI (king-takes-rook) and Move object
  const pos960 = Position.fromFen('8/8/8/k7/8/8/8/R3K2R w KQ - 0 1', 'chess960');
  const ucis = pos960.legalMoves().map((m) => pos960.toUci(m));
  assert.ok(ucis.includes('e1h1'), 'Chess960 castling available');
  assert.doesNotThrow(() => pos960.play('e1h1'));

  // Threecheck with counters
  assert.doesNotThrow(() => validateFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3+3 0 1', 'threecheck'));
  assert.doesNotThrow(() => validateFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 2+1 0 1', 'threecheck'));
});

test('F125-03: both colors king captures and promotions omitted from legalMoves and rejected by play', () => {
  // 1. Black king capturing White king
  const pBlackCapture = Position.fromFen(FEN_ADJACENT_KINGS, 'standard');
  const ucisBlack = pBlackCapture.legalMoves().map((m) => pBlackCapture.toUci(m));
  assert.ok(!ucisBlack.includes('a1b1'), `legalMoves must omit king capture a1b1, got: ${ucisBlack.join(' ')}`);
  assert.throws(() => pBlackCapture.play('a1b1'), IllegalMoveError);
  const moveObjBlack: Move = {
    from: squareFromName('a1'),
    to: squareFromName('b1'),
    piece: 'k',
    captured: 'K',
    flags: MoveFlag.Capture,
  };
  assert.throws(() => pBlackCapture.play(moveObjBlack), IllegalMoveError);

  // 2. White king capturing Black king
  const pWhiteCapture = Position.fromFen('8/8/8/8/8/8/8/Kk6 w - - 0 1', 'standard');
  const ucisWhite = pWhiteCapture.legalMoves().map((m) => pWhiteCapture.toUci(m));
  assert.ok(!ucisWhite.includes('a1b1'), `legalMoves must omit king capture a1b1, got: ${ucisWhite.join(' ')}`);
  assert.throws(() => pWhiteCapture.play('a1b1'), IllegalMoveError);
  const moveObjWhite: Move = {
    from: squareFromName('a1'),
    to: squareFromName('b1'),
    piece: 'K',
    captured: 'k',
    flags: MoveFlag.Capture,
  };
  assert.throws(() => pWhiteCapture.play(moveObjWhite), IllegalMoveError);

  // 3. White rook capturing Black king
  const pRookCapture = Position.fromFen(FEN_SIDE_NOT_TO_MOVE_IN_CHECK, 'standard');
  const ucisRook = pRookCapture.legalMoves().map((m) => pRookCapture.toUci(m));
  assert.ok(!ucisRook.includes('e1e8'), `legalMoves must omit king capture e1e8, got: ${ucisRook.join(' ')}`);
  assert.throws(() => pRookCapture.play('e1e8'), IllegalMoveError);
  const moveObjRook: Move = {
    from: squareFromName('e1'),
    to: squareFromName('e8'),
    piece: 'R',
    captured: 'k',
    flags: MoveFlag.Capture,
  };
  assert.throws(() => pRookCapture.play(moveObjRook), IllegalMoveError);

  // 4. Black rook capturing White king
  const pBlackRookCapture = Position.fromFen('4r1k1/8/8/8/8/8/8/4K3 b - - 0 1', 'standard');
  const ucisBlackRook = pBlackRookCapture.legalMoves().map((m) => pBlackRookCapture.toUci(m));
  assert.ok(!ucisBlackRook.includes('e8e1'), 'legalMoves must omit e8e1 king capture');
  assert.throws(() => pBlackRookCapture.play('e8e1'), IllegalMoveError);
  const moveObjBlackRook: Move = {
    from: squareFromName('e8'),
    to: squareFromName('e1'),
    piece: 'r',
    captured: 'K',
    flags: MoveFlag.Capture,
  };
  assert.throws(() => pBlackRookCapture.play(moveObjBlackRook), IllegalMoveError);

  // 5. Pawn promotion capturing opposing king
  const pPromoCapture = Position.fromFen('4k3/3P4/8/8/8/8/8/4K3 w - - 0 1', 'standard');
  const ucisPromo = pPromoCapture.legalMoves().map((m) => pPromoCapture.toUci(m));
  assert.ok(!ucisPromo.includes('d7e8q'), 'legalMoves must omit d7e8q king capture');
  assert.throws(() => pPromoCapture.play('d7e8q'), IllegalMoveError);
  const moveObjPromo: Move = {
    from: squareFromName('d7'),
    to: squareFromName('e8'),
    piece: 'P',
    captured: 'k',
    promotion: 'q',
    flags: MoveFlag.Capture | MoveFlag.Promotion,
  };
  assert.throws(() => pPromoCapture.play(moveObjPromo), IllegalMoveError);
});

test('F125-03: crazyhouse king drops must never be generated or played from pockets via string or Move object', () => {
  for (const fen of [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[K] w KQkq - 0 1',
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[k] w KQkq - 0 1',
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[Kk] w KQkq - 0 1',
  ]) {
    const p = Position.fromFen(fen, 'crazyhouse');
    const drops = p.legalMoves().filter((m) => m.drop === 'k');
    assert.equal(drops.length, 0, `must not generate king drops for ${fen}`);
    assert.throws(() => p.play('K@e4'), IllegalMoveError);

    const dropMoveObj: Move = {
      from: -1,
      to: squareFromName('e4'),
      piece: 'K',
      drop: 'k',
      flags: MoveFlag.Normal,
    };
    assert.throws(() => p.play(dropMoveObj), IllegalMoveError);
  }
});

test('F125-05: low-level applyMove executes pre-#127 move without strict legality gating', () => {
  // Pre-#127 line reached position before d4e5:
  // FEN: rnbq1bnr/pppp1ppp/3k4/4p3/3K4/4P3/PPPP1PPP/RNBQ1BNR w - - 0 5
  const pre127Fen = 'rnbq1bnr/pppp1ppp/3k4/4p3/3K4/4P3/PPPP1PPP/RNBQ1BNR w - - 0 5';

  // 1. Position before move parses and validates because connected kings are legal in Atomic
  const parsed = parseFen(pre127Fen, 'atomic');
  assert.doesNotThrow(() => validatePositionSemantics(parsed));
  assert.doesNotThrow(() => validateFen(pre127Fen, 'atomic'));

  // 2. Low-level applyMove executes the pre-#127 move d4e5 (Kxe5) without strict legality refusal
  const moveKxe5: Move = {
    from: squareFromName('d4'),
    to: squareFromName('e5'),
    piece: 'K',
    captured: 'p',
    flags: MoveFlag.Capture,
  };
  const afterMove = applyMove(parsed, moveKxe5);

  // In Atomic, Kxe5 exploded both kings (the capturer on e5 and adjacent king on d6)
  assert.equal(findKing(afterMove, 'w'), -1, 'white king was exploded');
  assert.equal(findKing(afterMove, 'b'), -1, 'black king was exploded');

  // 3. Raw parseFen and Position.fromFen remain permissive and decode the resulting state
  const serialized = toFen(afterMove);
  assert.doesNotThrow(() => parseFen(serialized, 'atomic'));
  assert.doesNotThrow(() => Position.fromFen(serialized, 'atomic'));
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('F125-06: seeded property coverage: legal moves never capture opposing royal king and crazyhouse never pockets/drops king', () => {
  const variants: Variant[] = ['standard', 'chess960', 'threecheck', 'crazyhouse', 'kingofthehill', 'racingkings', 'horde'];
  const rng = mulberry32(125);

  for (const variant of variants) {
    for (let game = 0; game < 20; game++) {
      let pos = Position.initial(variant);
      for (let ply = 0; ply < 40 && !pos.status().over; ply++) {
        const moves = pos.legalMoves();
        if (moves.length === 0) break;

        for (const m of moves) {
          // No non-atomic move may capture opposing royal king
          assert.notEqual(m.captured, 'k', `${variant} move ${pos.toUci(m)} must not capture black king`);
          assert.notEqual(m.captured, 'K', `${variant} move ${pos.toUci(m)} must not capture white king`);
          // No king drop
          assert.notEqual(m.drop, 'k', `${variant} move must not drop king`);
        }

        const chosen = moves[Math.floor(rng() * moves.length)]!;
        pos = pos.play(chosen);

        // Position state must never hold pocket kings
        const s = pos.snapshot();
        assert.ok(!s.pockets.w.includes('k'), `${variant} game ${game} ply ${ply}: white pocket contains king`);
        assert.ok(!s.pockets.b.includes('k'), `${variant} game ${game} ply ${ply}: black pocket contains king`);
      }
    }
  }
});
