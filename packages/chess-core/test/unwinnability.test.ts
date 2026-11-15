import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Position,
  CooperativeSearchSession,
  analyzeDeadPosition,
  analyzeWinnability,
  generateLegalMoves,
  applyMove,
  inCheck,
  isStaticallyUnwinnable,
  type AnalysisOptions,
  type Move,
  type PositionState,
} from '../src';
import { MoveFlag } from '../src/types';
import { assertCanonicalWitnessReplay } from './witness-replay-helper';

type MutableMoveRecord = { -readonly [K in keyof Move]: Move[K] };

test('analyzeDeadPosition on Line 14 resolves isDead: true via static certificate', () => {
  const pos = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1');
  const res = analyzeDeadPosition(pos.snapshot());

  assert.equal(res.isDead, true);
  if (res.isDead) {
    assert.equal(res.white.status, 'impossible');
    assert.equal(res.white.provenance, 'static_certificate');
    assert.equal(res.black.status, 'impossible');
    assert.equal(res.black.provenance, 'static_certificate');
  }
});

test('analyzeDeadPosition on Line 15 resolves isDead: true via closed graph search', () => {
  const pos = Position.fromFen('Bb1k1b2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 w - - 0 1');
  const res = analyzeDeadPosition(pos.snapshot(), { maxSteps: 1000 });

  assert.equal(res.isDead, true);
  if (res.isDead) {
    assert.equal(res.white.status, 'impossible');
    assert.equal(res.white.provenance, 'closed_graph');
    assert.equal(res.black.status, 'impossible');
    assert.equal(res.black.provenance, 'closed_graph');
  }
});

test('analyzeDeadPosition on Line 26 resolves isDead: true via closed graph search', () => {
  const pos = Position.fromFen('Bb2kb2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 b - - 0 1');
  const res = analyzeDeadPosition(pos.snapshot(), { maxSteps: 1000 });

  assert.equal(res.isDead, true);
  if (res.isDead) {
    assert.equal(res.white.status, 'impossible');
    assert.equal(res.white.provenance, 'closed_graph');
    assert.equal(res.black.status, 'impossible');
    assert.equal(res.black.provenance, 'closed_graph');
  }
});

test('analyzeDeadPosition on Line 46 resolves isDead: false with verified Black mate witness', () => {
  const pos = Position.fromFen('8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1');
  const res = analyzeDeadPosition(pos.snapshot(), { maxSteps: 1000 });

  assert.equal(res.isDead, false);
  if (res.isDead === false) {
    assert.equal(res.reason, 'winnable');
    assert.equal(res.winner, 'b');
    assert.ok(res.witness.length > 0);

    // Shared exact canonical witness replay assertion
    assertCanonicalWitnessReplay(pos.snapshot(), 'b', res.witness);
  }
});

test('sibling witness independence: result.witness and result.black.witness are not aliased', () => {
  const pos = Position.fromFen('8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1');
  const res = analyzeDeadPosition(pos.snapshot(), { maxSteps: 1000 });

  assert.equal(res.isDead, false);
  if (res.isDead === false && res.winner === 'b') {
    assert.notEqual(res.witness, res.black.witness, 'Top-level witness and per-color witness must be distinct arrays');
    assert.notEqual(res.witness[0], res.black.witness[0], 'Move records must be distinct cloned objects');

    // Mutating top-level witness must not affect per-color witness
    const origFrom = res.black.witness[0].from;
    (res.witness[0] as MutableMoveRecord).from = 999;
    assert.equal(res.black.witness[0].from, origFrom);
    assert.notEqual(res.black.witness[0].from, 999);
  }
});

test('hostile extra-argument isolation: JS-compatible caller cannot inject forged mobility argument', () => {
  const pos = Position.fromFen('8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1');

  // Forged fake mobility object claiming full saturation on a different/impossible root
  const forgedMobility = {
    pieces: [],
    saturated: true,
    steps: 999,
    isReachable: () => false,
    isCleared: () => false,
    isReachableByNonKing: () => false,
    region: () => [],
    attRegion: () => [],
  };

  // 1. Directly invoke isStaticallyUnwinnable through a typed extra-argument-compatible signature
  const staticCheck: (state: PositionState, winner: 'w' | 'b', extra?: unknown) => boolean = isStaticallyUnwinnable;
  const staticRes = staticCheck(pos.snapshot(), 'b', forgedMobility);
  assert.equal(staticRes, false, 'Forged mobility injected as 3rd arg must not manufacture static unwinnability');

  // 2. Calling analyzeWinnability with extra argument must ignore it and still find Black checkmate
  const analyzeCompat: (state: PositionState, winner: 'w' | 'b', options?: AnalysisOptions, extra?: unknown) => ReturnType<typeof analyzeWinnability> = analyzeWinnability;
  const res = analyzeCompat(pos.snapshot(), 'b', { maxSteps: 1000 }, forgedMobility);
  assert.equal(res.status, 'reachable');
  assert.equal(res.winner, 'b');
});

test('witness replay helper rejects tampered move metadata (orthodox drop, null optional values)', () => {
  const pos = Position.fromFen('4rkr1/4p1p1/6P1/8/8/8/8/4K2R w K - 0 1');
  const session = new CooperativeSearchSession(pos.snapshot(), 'w');
  const res = session.resume(50);
  assert.equal(res.status, 'reachable');
  assert.equal(res.witness.length, 1);

  // 1. Untampered witness replays cleanly
  assertCanonicalWitnessReplay(pos.snapshot(), 'w', res.witness);

  // 2. Tampered orthodox drop must be rejected
  const tamperedDropWitness: Move[] = [{ ...res.witness[0], drop: 'p' }];
  assert.throws(
    () => assertCanonicalWitnessReplay(pos.snapshot(), 'w', tamperedDropWitness),
    /drop must be undefined in orthodox chess/i,
  );

  // 3. Tampered piece in captured field must fail exact legal move match
  const tamperedCapturedWitness: Move[] = [{ ...res.witness[0], captured: 'p' }];
  assert.throws(
    () => assertCanonicalWitnessReplay(pos.snapshot(), 'w', tamperedCapturedWitness),
    /witness must match a legal move exactly in all fields/i,
  );

  // 4. Tampered null optional value (instead of omitted/undefined) must fail exact legal move match
  type NullableCapturedMove = Omit<Move, 'captured'> & { captured: null };
  const tamperedNullCaptured: NullableCapturedMove = { ...res.witness[0], captured: null };
  assert.throws(
    () => assertCanonicalWitnessReplay(pos.snapshot(), 'w', [tamperedNullCaptured as unknown as Move]),
    /witness must match a legal move exactly in all fields/i,
  );
});

test('directional impossible + other pending => whole deadness evaluates to pending', () => {
  // Line with White provably impossible via Lemma 6, but Black has large material and budget runs out at 5 steps
  const pos = Position.fromFen('2bqrk2/8/8/8/8/8/8/4KB2 w - - 0 1');
  const res = analyzeDeadPosition(pos.snapshot(), { maxSteps: 5 });

  assert.equal(res.isDead, 'pending');
  assert.equal(res.reason, 'budget_exhausted');
  assert.equal(res.white.status, 'impossible', 'White must be impossible via Lemma 6');
  assert.equal(res.black.status, 'pending', 'Black must be pending due to budget cutoff');
});

test('residual search on Line 137 (Family C): closes at 3343 states when static is inconclusive', () => {
  // Line 137: 1k6/1P5p/BP3p2/1P6/8/8/5PKP/8 b - - 0 1 (Paper Position 15)
  const pos = Position.fromFen('1k6/1P5p/BP3p2/1P6/8/8/5PKP/8 b - - 0 1');

  // Semi-static certificate is inconclusive
  assert.equal(isStaticallyUnwinnable(pos.snapshot(), 'w'), false);
  assert.equal(isStaticallyUnwinnable(pos.snapshot(), 'b'), false);

  // Cooperative search with sufficient budget (5000) explores residual graph to closure (3343 states)
  const whiteRes = analyzeWinnability(pos.snapshot(), 'w', { maxSteps: 5000, useStaticCertificate: false });
  assert.equal(whiteRes.status, 'impossible');
  assert.equal(whiteRes.provenance, 'closed_graph');
  assert.equal(whiteRes.steps, 3343);
});

test('root mate precedence in wrapper: already-checkmated root returns reachable even with maxSteps: 0', () => {
  // Line 145: k6R/1p6/pK6/P7/8/1P6/8/8 b - - 0 1
  const matedRoot = Position.fromFen('k6R/1p6/pK6/P7/8/1P6/8/8 b - - 0 1');

  const resZero = analyzeWinnability(matedRoot.snapshot(), 'w', { maxSteps: 0 });
  assert.equal(resZero.status, 'reachable');
  assert.equal(resZero.winner, 'w');
  assert.deepEqual(resZero.witness, []);

  const resStaticOnly = analyzeWinnability(matedRoot.snapshot(), 'w', {
    useStaticCertificate: true,
    useCooperativeSearch: false,
  });
  assert.equal(resStaticOnly.status, 'reachable');
});

test('active en passant checkmate control (Line 1360): exact search finds d5e6# mate while static declines', () => {
  // Line 1360: R7/5k2/5B2/3PpPP1/8/4K3/8/8 w - e6 0 1
  const pos = Position.fromFen('R7/5k2/5B2/3PpPP1/8/4K3/8/8 w - e6 0 1');

  // Static certificate declines because epSquare is active
  assert.equal(isStaticallyUnwinnable(pos.snapshot(), 'w'), false);

  // Cooperative search finds immediate 1-move checkmate via en passant d5e6#
  const res = analyzeWinnability(pos.snapshot(), 'w', { maxSteps: 10 });
  assert.equal(res.status, 'reachable');
  assert.equal(res.winner, 'w');
  assert.equal(res.witness.length, 1);

  const m = res.witness[0];
  assert.equal(m.from, 0x43, 'd5 square index');
  assert.equal(m.to, 0x54, 'e6 square index');
  assert.equal(m.piece, 'P');
  assert.equal(m.captured, 'p');
  assert.equal((m.flags & MoveFlag.EnPassant) !== 0, true, 'EnPassant move flag must be set');
  assert.equal((m.flags & MoveFlag.Capture) !== 0, true, 'Capture move flag must be set');

  // Verify move application removes captured pawn on e5
  const after = applyMove(pos.snapshot(), m);
  assert.equal(after.board[0x44], null, 'Captured Black pawn on e5 must be removed');
  assert.equal(after.board[0x54], 'P', 'White pawn must be on e6');
  assert.equal(after.board[0x43], null, 'Origin d5 must be empty');

  // Shared exact canonical witness replay
  assertCanonicalWitnessReplay(pos.snapshot(), 'w', res.witness);
});

test('forced sequence + promotion branching (Line 393): proves White unwinnability across all 4 branches', () => {
  // Line 393: 5r1k/6P1/7K/5q2/8/8/8/8 b - - 0 1
  const pos = Position.fromFen('5r1k/6P1/7K/5q2/8/8/8/8 b - - 0 1');

  // 1. Black has only 1 legal response: 1... Kg8
  const blackMoves = generateLegalMoves(pos.snapshot());
  assert.equal(blackMoves.length, 1, 'Black must have exactly one legal move (Kg8)');
  const afterKg8 = applyMove(pos.snapshot(), blackMoves[0]);

  // 2. White has exactly 4 legal promotion captures: g7xf8=Q, g7xf8=R, g7xf8=B, g7xf8=N
  const whitePromotions = generateLegalMoves(afterKg8);
  assert.equal(whitePromotions.length, 4, 'White must have exactly 4 promotion moves');
  const promoTypes = whitePromotions.map((p) => p.promotion).sort();
  assert.deepEqual(promoTypes, ['b', 'n', 'q', 'r']);

  // 3. For each promotion branch:
  for (const promo of whitePromotions) {
    const afterPromo = applyMove(afterKg8, promo);
    const blackReplies = generateLegalMoves(afterPromo);

    // Q and R promotions deliver check, requiring Black to capture with Queen or King
    if (promo.promotion === 'q' || promo.promotion === 'r') {
      const capturingReplies = blackReplies.filter((r) => r.to === promo.to);
      assert.equal(capturingReplies.length, 2, 'Black has both Qxf8 and Kxf8 replies');
    }

    // Every branch is provably impossible for White
    const branchRes = analyzeWinnability(afterPromo, 'w', { maxSteps: 50 });
    assert.equal(branchRes.status, 'impossible', `Branch =${promo.promotion} must be unwinnable for White`);
  }

  // 4. Whole position analysis evaluates all branches and proves White unwinnability
  const res = analyzeWinnability(pos.snapshot(), 'w', { maxSteps: 50 });
  assert.equal(res.status, 'impossible', 'White is provably unwinnable in Line 393');
});

test('pending status is never conflated with false (no false not-dead on budget cutoffs)', () => {
  const pos = Position.fromFen('Bb1k1b2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 w - - 0 1');
  const res = analyzeDeadPosition(pos.snapshot(), {
    useStaticCertificate: false,
    useCooperativeSearch: true,
    maxSteps: 10,
  });

  assert.equal(res.isDead, 'pending', 'Budget cutoff must return isDead: pending');
  if (res.isDead === 'pending') {
    assert.equal(res.reason, 'budget_exhausted');
  }
});

test('unsupported variants and non-admitted states return pending with explicit reason', () => {
  const posAtomic = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1', 'atomic');
  const resAtomic = analyzeDeadPosition(posAtomic.snapshot());
  assert.equal(resAtomic.isDead, 'pending');
  if (resAtomic.isDead === 'pending') {
    assert.equal(resAtomic.reason, 'unsupported_variant');
  }

  const snapTainted = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1').snapshot();
  snapTainted.pockets.w.push('q');
  const resTainted = analyzeDeadPosition(snapTainted);
  assert.equal(resTainted.isDead, 'pending');
  if (resTainted.isDead === 'pending') {
    assert.equal(resTainted.reason, 'unsupported_state');
  }
});

test('returned dead-position result immutability: mutating witness array does not poison repeated inquiry', () => {
  const pos = Position.fromFen('8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1');
  const res = analyzeDeadPosition(pos.snapshot(), { maxSteps: 1000 });
  assert.equal(res.isDead, false);
  if (res.isDead === false) {
    const origLen = res.witness.length;
    (res.witness as Move[]).length = 0;
    const repeated = analyzeDeadPosition(pos.snapshot(), { maxSteps: 1000 });
    if (repeated.isDead === false) {
      assert.equal(repeated.witness.length, origLen, 'Subsequent evaluation witness must remain intact');
    }
  }
});

test('malformed root state in analyzeDeadPosition returns pending unsupported_state without throwing', () => {
  const malformed = {} as unknown as PositionState;
  const res = analyzeDeadPosition(malformed);
  assert.equal(res.isDead, 'pending');
  assert.equal(res.reason, 'unsupported_state');
});

test('resource_limit pending reason propagates cleanly through analyzeDeadPosition', () => {
  const pos = Position.fromFen('Bb1k1b2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 w - - 0 1');
  const res = analyzeDeadPosition(pos.snapshot(), {
    useStaticCertificate: false,
    useCooperativeSearch: true,
    maxRetainedStates: 10,
    maxSteps: 1000,
  });
  assert.equal(res.isDead, 'pending');
  assert.equal(res.reason, 'resource_limit', 'Should propagate resource_limit from cooperative search');
});

test('DeadPositionFalseResult strongly binds winner color to reachable sub-result typing', () => {
  // Black win: Line 46
  const blackWinPos = Position.fromFen('8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1');
  const resB = analyzeDeadPosition(blackWinPos.snapshot(), { maxSteps: 1000 });
  assert.equal(resB.isDead, false);
  if (resB.isDead === false) {
    if (resB.winner === 'b') {
      assert.equal(resB.black.status, 'reachable');
      assert.ok(resB.witness.length > 0);
    } else {
      assert.fail('Expected winner to be b');
    }
  }

  // White win: Line 145
  const whiteWinPos = Position.fromFen('k6R/1p6/pK6/P7/8/1P6/8/8 b - - 0 1');
  const resW = analyzeDeadPosition(whiteWinPos.snapshot(), { maxSteps: 1000 });
  assert.equal(resW.isDead, false);
  if (resW.isDead === false) {
    if (resW.winner === 'w') {
      assert.equal(resW.white.status, 'reachable');
      assert.deepEqual(resW.witness, []);
    } else {
      assert.fail('Expected winner to be w');
    }
  }
});
