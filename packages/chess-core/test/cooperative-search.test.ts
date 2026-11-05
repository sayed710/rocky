import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Position,
  CooperativeSearchSession,
  canonicalStateKey,
  generateLegalMoves,
  inCheck,
  applyMove,
  type Move,
  type PositionState,
} from '../src';
import { isPawnFreeMaterialUnwinnable } from '../src/cooperative-search';
import { assertCanonicalWitnessReplay } from './witness-replay-helper';

type MutableMoveRecord = { -readonly [K in keyof Move]: Move[K] };

test('canonical state key is clock-free and collision-free with valid non-adjacent kings', () => {
  // Valid non-adjacent king positions: e1 and e8
  const fen1 = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
  const fen2 = '4k3/8/8/8/8/8/8/4K3 w - - 99 50';

  const pos1 = Position.fromFen(fen1);
  const pos2 = Position.fromFen(fen2);

  assert.equal(
    canonicalStateKey(pos1.snapshot()),
    canonicalStateKey(pos2.snapshot()),
    'Canonical state key must ignore halfmove and fullmove clocks',
  );

  // Turn difference produces different key
  const fenBlack = '4k3/8/8/8/8/8/8/4K3 b - - 0 1';
  assert.notEqual(
    canonicalStateKey(pos1.snapshot()),
    canonicalStateKey(Position.fromFen(fenBlack).snapshot()),
    'Turn change must change canonical key',
  );

  // Castling rights difference produces different key
  const fenCastling = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  const fenNoCastling = 'r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1';
  assert.notEqual(
    canonicalStateKey(Position.fromFen(fenCastling).snapshot()),
    canonicalStateKey(Position.fromFen(fenNoCastling).snapshot()),
    'Castling rights must change canonical key',
  );

  // Chess960 inner rook rights produce distinct key
  const pos960A = Position.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'chess960');
  const snapA = pos960A.snapshot();
  snapA.castling.w.k = 6;
  const snapB = pos960A.snapshot();
  snapB.castling.w.k = 5;
  assert.notEqual(
    canonicalStateKey(snapA),
    canonicalStateKey(snapB),
    'Different rook files must produce distinct canonical keys',
  );
});

test('cooperative search on Line 15 closes with 220 states for both White and Black (raw closure)', () => {
  // Line 15: Bb1k1b2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 w - - 0 1
  const pos = Position.fromFen('Bb1k1b2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 w - - 0 1');

  // Search White winnability
  const whiteSession = new CooperativeSearchSession(pos.snapshot(), 'w');
  const whiteRes = whiteSession.resume(1000);
  assert.equal(whiteRes.status, 'impossible');
  assert.equal(whiteRes.provenance, 'closed_graph', 'Raw all-edge closure on pawn-containing position');
  assert.equal(whiteSession.discoveredStates, 220, 'Discovered exactly 220 states matching baseline');
  assert.equal(whiteSession.expandedStates, 220, 'Fully expanded 220 states matching baseline');
  assert.equal(whiteSession.materialDischarges, 0, 'No pawn-free material lemmas discharged');

  // Search Black winnability
  const blackSession = new CooperativeSearchSession(pos.snapshot(), 'b');
  const blackRes = blackSession.resume(1000);
  assert.equal(blackRes.status, 'impossible');
  assert.equal(blackRes.provenance, 'closed_graph');
  assert.equal(blackSession.discoveredStates, 220);
  assert.equal(blackSession.expandedStates, 220);
  assert.equal(blackSession.materialDischarges, 0);
});

test('cooperative search on Line 26 closes with 220 states for both White and Black (raw closure)', () => {
  // Line 26: Bb2kb2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 b - - 0 1
  const pos = Position.fromFen('Bb2kb2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 b - - 0 1');

  const whiteSession = new CooperativeSearchSession(pos.snapshot(), 'w');
  const whiteRes = whiteSession.resume(1000);
  assert.equal(whiteRes.status, 'impossible');
  assert.equal(whiteRes.provenance, 'closed_graph');
  assert.equal(whiteSession.discoveredStates, 220);
  assert.equal(whiteSession.expandedStates, 220);
  assert.equal(whiteSession.materialDischarges, 0);

  const blackSession = new CooperativeSearchSession(pos.snapshot(), 'b');
  const blackRes = blackSession.resume(1000);
  assert.equal(blackRes.status, 'impossible');
  assert.equal(blackRes.provenance, 'closed_graph');
  assert.equal(blackSession.discoveredStates, 220);
  assert.equal(blackSession.expandedStates, 220);
  assert.equal(blackSession.materialDischarges, 0);
});

test('cooperative search on Line 46 finds reachable mate for Black and keeps White pending', () => {
  // Line 46: 8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1
  const pos = Position.fromFen('8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1');

  // Black can deliver checkmate
  const blackSession = new CooperativeSearchSession(pos.snapshot(), 'b');
  const blackRes = blackSession.resume(1000);
  assert.equal(blackRes.status, 'reachable');
  if (blackRes.status !== 'reachable') throw new Error('Expected reachable');
  assert.equal(blackRes.winner, 'b');
  assert.ok(blackRes.witness.length > 0);

  // Shared canonical witness replay: verifies all canonical fields, legal match, and direct application
  assertCanonicalWitnessReplay(pos.snapshot(), 'b', blackRes.witness);

  // White search within budget 1000 remains pending without false impossibility claim
  // (Root independent python-chess proof establishes Black reachable only, White pending)
  const whiteSession = new CooperativeSearchSession(pos.snapshot(), 'w');
  const whiteRes = whiteSession.resume(1000);
  assert.equal(whiteRes.status, 'pending');
  assert.equal(whiteRes.reason, 'budget_exhausted');
});

test('caller root mutation protection: mutating caller state after session creation does not alter proof', () => {
  // Create session from ordinary starting position
  const start = Position.initial().snapshot();
  const session = new CooperativeSearchSession(start, 'w');

  // Mutate caller's board and nested structures to bare kings
  const bare = Position.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').snapshot();
  start.board.splice(0, start.board.length, ...bare.board);
  start.castling.w.k = -1;
  start.castling.w.q = -1;
  start.castling.b.k = -1;
  start.castling.b.q = -1;
  start.pockets.w.push('q');
  start.checkCount.w = 5;

  // Resuming session for 1 step must not have been mutated to bare kings
  const res = session.resume(1);
  assert.equal(res.status, 'pending', 'Session must evaluate starting position, not mutated bare kings');
  assert.ok(session.root!.board.includes('P'), 'Internal root must retain White pawns');
  assert.equal(session.root!.checkCount.w, 0, 'Internal root must retain zero check counters');
  assert.equal(session.root!.pockets.w.length, 0, 'Internal root must retain empty pockets');
});

test('returned witness mutation protection: mutating returned witness array or move records does not poison repeat results', () => {
  const pos = Position.fromFen('8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1');
  const session = new CooperativeSearchSession(pos.snapshot(), 'b');
  const res = session.resume(1000);
  assert.equal(res.status, 'reachable');
  const originalLength = res.witness.length;
  assert.ok(originalLength > 0);

  // Mutate move record fields inside the returned witness
  const firstMove = res.witness[0] as MutableMoveRecord;
  const originalFrom = firstMove.from;
  firstMove.from = 999;
  firstMove.to = 999;
  firstMove.piece = 'K';

  // Mutate the returned witness array length
  (res.witness as Move[]).length = 0;

  // Repeated inquiry through getStatus() must return intact witness and intact move record
  const repeated = session.getStatus();
  assert.equal(repeated.status, 'reachable');
  if (repeated.status === 'reachable') {
    assert.equal(repeated.witness.length, originalLength, 'Repeated inquiry must return intact witness length');
    assert.equal(repeated.witness[0].from, originalFrom, 'Repeated inquiry must not see mutated move record fields');
    assert.notEqual(repeated.witness[0].from, 999);
  }
});

test('standard chess castling witness control: exact search finds 1-move O-O# checkmate', () => {
  // White: Ke1, Rh1, pawn g6. Black: Kf8, Re8, Rg8, pawn e7, pawn g7.
  // 1. O-O# is checkmate in 1!
  const pos = Position.fromFen('4rkr1/4p1p1/6P1/8/8/8/8/4K2R w K - 0 1');
  const session = new CooperativeSearchSession(pos.snapshot(), 'w');
  const res = session.resume(50);
  assert.equal(res.status, 'reachable');
  assert.equal(res.winner, 'w');
  assert.equal(res.witness.length, 1);

  // Verify castling flags and exact canonical replay
  assert.equal((res.witness[0].flags & 8) !== 0, true, 'Witness move must be KingCastle flag');
  assert.equal(res.witness[0].castleRook, 7, 'castleRook must be file 7 (h1)');
  assertCanonicalWitnessReplay(pos.snapshot(), 'w', res.witness);
});

test('Chess960 castling witness control: exact search finds 1-move O-O# checkmate with rook on h1 and king on c1', () => {
  // White: Kc1 (file 2), Rh1 (file 7). Held right: w.k = 7.
  // Castling O-O lands King on g1 and Rook on f1 delivering checkmate!
  const pos = Position.fromFen('4rkr1/4p1p1/6P1/8/8/8/8/2K4R w H - 0 1', 'chess960');
  const session = new CooperativeSearchSession(pos.snapshot(), 'w');
  const res = session.resume(50);
  assert.equal(res.status, 'reachable');
  assert.equal(res.winner, 'w');
  assert.equal(res.witness.length, 1);

  assert.equal((res.witness[0].flags & 8) !== 0, true, 'Witness move must have KingCastle flag');
  assert.equal(res.witness[0].from, 2, 'Chess960 king starts on c1 (file 2)');
  assert.equal(res.witness[0].to, 6, 'King lands on g1 (file 6)');
  assert.equal(res.witness[0].castleRook, 7, 'castleRook is h1 (file 7)');
  assertCanonicalWitnessReplay(pos.snapshot(), 'w', res.witness);
});

test('capacity pause and same-session resumption: pauses mating continuation and setCapacity completes witness', () => {
  // Line 46: 8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1 has a 2-move checkmate for Black requiring > 50 discovered states
  const pos = Position.fromFen('8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1');
  const session = new CooperativeSearchSession(pos.snapshot(), 'b', { maxRetainedStates: 10 });

  // Pauses at exactly 10 states before indispensable mating continuation can be discovered
  const pauseRes = session.resume(1000);
  assert.equal(pauseRes.status, 'pending');
  assert.equal(pauseRes.reason, 'resource_limit');
  assert.equal(session.discoveredStates, 10);

  // Raise capacity on the SAME session and resume
  session.setCapacity(500);
  assert.equal(session.maxStates, 500);
  const resumedRes = session.resume(1000);
  assert.equal(resumedRes.status, 'reachable');
  assert.equal(resumedRes.winner, 'b');
  assert.ok(resumedRes.witness.length > 0);

  // Replay witness
  assertCanonicalWitnessReplay(pos.snapshot(), 'b', resumedRes.witness);
});

test('mixed-branch search: prunes dead material leaf while discovering alternative checkmate witness', () => {
  // White: Kh1, Rf2. Black: Kh3, pg3. White to move, winner: Black.
  // A continuation capturing the g3 pawn leaves Black with a bare king (pruned via Lemma 5 material discharge).
  // Alternative legal continuations allow Black to deliver checkmate.
  const pos = Position.fromFen('8/8/8/8/8/6pk/5R2/7K w - - 0 1');
  const session = new CooperativeSearchSession(pos.snapshot(), 'b');
  const res = session.resume(1000);

  assert.equal(res.status, 'reachable');
  assert.equal(res.winner, 'b');
  assert.equal(res.witness.length, 4);
  assert.ok(session.materialDischarges >= 1, 'Search must record material discharge for the bare-king leaf');
  assertCanonicalWitnessReplay(pos.snapshot(), 'b', res.witness);
});

test('differing valid numeric clock counters retain identical clock-free graph semantics', () => {
  // Line 15: Bb1k1b2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 w - - 0 1
  const pos = Position.fromFen('Bb1k1b2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 w - - 0 1');

  const snap1 = pos.snapshot();
  snap1.halfmoves = 0;
  snap1.fullmoves = 1;

  const snap2 = pos.snapshot();
  snap2.halfmoves = 45;
  snap2.fullmoves = 99;

  const sess1 = new CooperativeSearchSession(snap1, 'w');
  const sess2 = new CooperativeSearchSession(snap2, 'w');

  const res1 = sess1.resume(1000);
  const res2 = sess2.resume(1000);

  assert.equal(res1.status, 'impossible');
  assert.equal(res2.status, 'impossible');
  assert.equal(res1.provenance, 'closed_graph');
  assert.equal(res2.provenance, 'closed_graph');
  assert.equal(sess1.discoveredStates, 220);
  assert.equal(sess2.discoveredStates, 220);
  assert.equal(sess1.expandedStates, 220);
  assert.equal(sess2.expandedStates, 220);
});

test('invalid allowance controls: NaN, Infinity, negative, and 0 never run unbounded search', () => {
  const bare = Position.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').snapshot();

  // NaN budget
  const sessionNaN = new CooperativeSearchSession(bare, 'w');
  const resNaN = sessionNaN.resume(NaN);
  assert.equal(resNaN.status, 'pending', 'NaN allowance must return pending without executing search');
  assert.equal(resNaN.reason, 'budget_exhausted');

  // Infinity budget
  const sessionInf = new CooperativeSearchSession(bare, 'w');
  const resInf = sessionInf.resume(Infinity);
  assert.equal(resInf.status, 'pending', 'Infinity allowance must return pending without executing search');

  // Negative budget
  const sessionNeg = new CooperativeSearchSession(bare, 'w');
  const resNeg = sessionNeg.resume(-10);
  assert.equal(resNeg.status, 'pending');

  // Zero budget
  const sessionZero = new CooperativeSearchSession(bare, 'w');
  const resZero = sessionZero.resume(0);
  assert.equal(resZero.status, 'pending', 'Zero budget must return pending');
});

test('unsupported payload controls: non-admitted states return pending without claiming impossibility', () => {
  // Non-empty pockets
  const tainted = Position.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').snapshot();
  tainted.pockets.w.push('q');
  const sessionPockets = new CooperativeSearchSession(tainted, 'w');
  const resPockets = sessionPockets.resume(10);
  assert.equal(resPockets.status, 'pending');
  assert.equal(resPockets.reason, 'unsupported_state', 'Non-empty pockets must yield unsupported_state pending');

  // Non-zero check counters
  const taintedCounters = Position.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').snapshot();
  taintedCounters.checkCount = { w: 1, b: 0 };
  const sessionCounters = new CooperativeSearchSession(taintedCounters, 'w');
  const resCounters = sessionCounters.resume(10);
  assert.equal(resCounters.status, 'pending');
  assert.equal(resCounters.reason, 'unsupported_state');

  // Missing king
  const missingKing = Position.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').snapshot();
  missingKing.board[4] = null; // remove White king
  const sessionNoKing = new CooperativeSearchSession(missingKing, 'w');
  const resNoKing = sessionNoKing.resume(10);
  assert.equal(resNoKing.status, 'pending');
  assert.equal(resNoKing.reason, 'unsupported_state');

  // Pawn on rank 1
  const pawnRank1 = Position.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').snapshot();
  pawnRank1.board[0] = 'P'; // pawn on a1
  const sessionPawn1 = new CooperativeSearchSession(pawnRank1, 'w');
  const resPawn1 = sessionPawn1.resume(10);
  assert.equal(resPawn1.status, 'pending');
  assert.equal(resPawn1.reason, 'unsupported_state');
});

test('malformed constructor input does not throw TypeError and yields unsupported_state', () => {
  const malformed = {} as unknown as PositionState;
  const session = new CooperativeSearchSession(malformed, 'w');
  assert.equal(session.root, null);
  const res = session.resume(10);
  assert.equal(res.status, 'pending');
  assert.equal(res.reason, 'unsupported_state');
});

test('cancellation and capacity semantics: cancel() preserves cancelled status and prevents empty queue artifact', () => {
  const pos = Position.fromFen('Bb1k1b2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 w - - 0 1');
  const session = new CooperativeSearchSession(pos.snapshot(), 'w');

  // Expand 10 steps
  session.resume(10);

  // Cancel session
  session.cancel();
  const cancelledRes = session.getStatus();
  assert.equal(cancelledRes.status, 'pending');
  assert.equal(cancelledRes.reason, 'cancelled');

  // Subsequent resume calls must remain cancelled, never returning impossible
  const resumeAfterCancel = session.resume(1000);
  assert.equal(resumeAfterCancel.status, 'pending');
  assert.equal(resumeAfterCancel.reason, 'cancelled');
});

test('capacity validation: constructor and setCapacity strictly enforce finite positive integer', () => {
  const pos = Position.fromFen('Bb1k1b2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 w - - 0 1');

  // Constructor capacity validation
  assert.throws(() => new CooperativeSearchSession(pos.snapshot(), 'w', { maxRetainedStates: Number.NaN }), RangeError);
  assert.throws(() => new CooperativeSearchSession(pos.snapshot(), 'w', { maxRetainedStates: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => new CooperativeSearchSession(pos.snapshot(), 'w', { maxRetainedStates: 0 }), RangeError);
  assert.throws(() => new CooperativeSearchSession(pos.snapshot(), 'w', { maxRetainedStates: -10 }), RangeError);
  assert.throws(() => new CooperativeSearchSession(pos.snapshot(), 'w', { maxRetainedStates: 10.5 }), RangeError);

  // setCapacity validation
  const session = new CooperativeSearchSession(pos.snapshot(), 'w', { maxRetainedStates: 10 });
  assert.throws(() => session.setCapacity(Number.NaN), RangeError);
  assert.throws(() => session.setCapacity(Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => session.setCapacity(-5), RangeError);
  assert.throws(() => session.setCapacity(20.5), RangeError);
  assert.throws(() => session.setCapacity(10), RangeError, 'Capacity cannot be set to <= current');
  assert.throws(() => session.setCapacity(5), RangeError, 'Capacity cannot decrease');
  session.setCapacity(20);
  assert.equal(session.maxStates, 20);
});

test('mid-node capacity pause and recovery: capacity pause emits resource_limit and setCapacity recovers exact graph', () => {
  const pos = Position.fromFen('Bb1k1b2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 w - - 0 1');

  // Uncapped reference run: produces exactly 220 discovered states
  const uncapped = new CooperativeSearchSession(pos.snapshot(), 'w');
  const uncappedRes = uncapped.resume(1000);
  assert.equal(uncappedRes.status, 'impossible');
  assert.equal(uncappedRes.provenance, 'closed_graph');
  assert.equal(uncapped.discoveredStates, 220);

  // Capped session at 10 states
  const capped = new CooperativeSearchSession(pos.snapshot(), 'w', { maxRetainedStates: 10 });
  const pauseRes = capped.resume(1000);
  assert.equal(pauseRes.status, 'pending');
  assert.equal(pauseRes.reason, 'resource_limit', 'Must yield distinct resource_limit reason');
  assert.equal(capped.discoveredStates, 10);

  // Resuming with extra node budget alone without increasing capacity remains paused at resource_limit
  const retrySameCap = capped.resume(1000);
  assert.equal(retrySameCap.status, 'pending');
  assert.equal(retrySameCap.reason, 'resource_limit');
  assert.equal(capped.discoveredStates, 10);

  // Now increase capacity to 500 (sufficient for the 220-state graph)
  capped.setCapacity(500);
  assert.equal(capped.maxStates, 500);

  // Resuming completes the search from the preserved mid-node cursor
  const resumedRes = capped.resume(1000);
  assert.equal(resumedRes.status, 'impossible');
  assert.equal(resumedRes.provenance, 'closed_graph');
  assert.equal(capped.discoveredStates, 220, 'Must discover exact same 220 states as uncapped');
  assert.equal(capped.expandedStates, 220, 'Must expand exact same 220 states as uncapped');
});

test('resumable traversal: preserving cursor mid-expansion yields identical closed graph as monolithic run', () => {
  const pos = Position.fromFen('Bb1k1b2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 w - - 0 1');

  // Sliced session: 50, 50, 500
  const sessionA = new CooperativeSearchSession(pos.snapshot(), 'w');
  const res1 = sessionA.resume(50);
  assert.equal(res1.status, 'pending');
  assert.equal(sessionA.expandedStates, 50);

  const res2 = sessionA.resume(50);
  assert.equal(res2.status, 'pending');
  assert.equal(sessionA.expandedStates, 100);

  const res3 = sessionA.resume(500);
  assert.equal(res3.status, 'impossible');
  assert.equal(sessionA.expandedStates, 220);

  // Monolithic session
  const sessionB = new CooperativeSearchSession(pos.snapshot(), 'w');
  const resB = sessionB.resume(1000);
  assert.equal(resB.status, 'impossible');
  assert.equal(sessionB.expandedStates, 220);
  assert.equal(sessionA.discoveredStates, sessionB.discoveredStates);
});

test('Lemma 5 controls (Paper page 7): pawn-free knight unwinnability hypotheses', () => {
  // Positive control: White K+N vs Black K+Q. Strictly pawn-free, Black has no N, B, R.
  // White is provably unwinnable under Lemma 5.
  const posPos = Position.fromFen('3qk3/8/8/8/8/5N2/8/4K3 w - - 0 1');
  assert.equal(isPawnFreeMaterialUnwinnable(posPos.snapshot(), 'w'), true, 'K+N vs K+Q is unwinnable for White');

  const sessionPos = new CooperativeSearchSession(posPos.snapshot(), 'w');
  const resPos = sessionPos.resume(100);
  assert.equal(resPos.status, 'impossible');
  assert.equal(resPos.provenance, 'closed_graph_material_pruned');
  assert.ok(sessionPos.materialDischarges > 0);

  // Negative control 1: Black also has a knight (smothered mate possible)
  const posNegKnight = Position.fromFen('3nk3/8/8/8/8/5N2/8/4K3 w - - 0 1');
  assert.equal(isPawnFreeMaterialUnwinnable(posNegKnight.snapshot(), 'w'), false, 'Opponent knight invalidates Lemma 5');

  // Negative control 2: Black has a bishop
  const posNegBishop = Position.fromFen('3bk3/8/8/8/8/5N2/8/4K3 w - - 0 1');
  assert.equal(isPawnFreeMaterialUnwinnable(posNegBishop.snapshot(), 'w'), false, 'Opponent bishop invalidates Lemma 5');

  // Negative control 3: Black has a rook
  const posNegRook = Position.fromFen('3rk3/8/8/8/8/5N2/8/4K3 w - - 0 1');
  assert.equal(isPawnFreeMaterialUnwinnable(posNegRook.snapshot(), 'w'), false, 'Opponent rook invalidates Lemma 5');

  // Negative control 4: Pawns present on board
  const posNegPawn = Position.fromFen('3qk3/8/8/8/8/5N2/4P3/4K3 w - - 0 1');
  assert.equal(isPawnFreeMaterialUnwinnable(posNegPawn.snapshot(), 'w'), false, 'Pawns present invalidates pawn-free hypothesis');
});

test('Lemma 6 controls (Paper page 7): pawn-free single-color bishop unwinnability hypotheses', () => {
  // Positive control: White has K + light-squared bishop (f1). Black has K + light-squared bishop (c8) + Rook + Queen.
  // Black has no knights and no dark-squared bishops.
  // White is provably unwinnable under Lemma 6.
  const posPos = Position.fromFen('2bqrk2/8/8/8/8/8/8/4KB2 w - - 0 1');
  assert.equal(isPawnFreeMaterialUnwinnable(posPos.snapshot(), 'w'), true, 'K+B vs K+B(same)+R+Q is unwinnable for White');

  // Negative control 1: Black has a knight
  const posNegKnight = Position.fromFen('2nqrk2/8/8/8/8/8/8/4KB2 w - - 0 1');
  assert.equal(isPawnFreeMaterialUnwinnable(posNegKnight.snapshot(), 'w'), false, 'Opponent knight invalidates Lemma 6');

  // Negative control 2: Black has an opposite-colored bishop (dark square: e8 is dark square)
  // Let Black have dark-sq bishop on d7 (rank 6, file 3 => 6+3=9 odd -> dark/light check)
  // Rank 6, file 3: (6+3)%2 = 1. Wait, f1 is (0+5)%2 = 1. So d7 is same color.
  // Bishop on c7: rank 6, file 2 => (6+2)%2 = 0 (opposite square color).
  const posNegOppBishop = Position.fromFen('4rk2/2b5/8/8/8/8/8/4KB2 w - - 0 1');
  assert.equal(isPawnFreeMaterialUnwinnable(posNegOppBishop.snapshot(), 'w'), false, 'Opponent opposite-colored bishop invalidates Lemma 6');

  // Negative control 3: Winner has bishops on both colors (can deliver mate alone)
  const posTwoBishops = Position.fromFen('4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1');
  assert.equal(isPawnFreeMaterialUnwinnable(posTwoBishops.snapshot(), 'w'), false, 'Bishops on both square colors invalidates Lemma 6');
});

test('root mate precedence: already-checkmated root returns reachable witness [] with budget 0', () => {
  // Line 145: k6R/1p6/pK6/P7/8/1P6/8/8 b - - 0 1
  // Black king on a8 is in check by White rook on h8 and has 0 legal moves.
  const matedRoot = Position.fromFen('k6R/1p6/pK6/P7/8/1P6/8/8 b - - 0 1');

  // Evaluated for White winnability with budget 0
  const session = new CooperativeSearchSession(matedRoot.snapshot(), 'w');
  const res0 = session.resume(0);
  assert.equal(res0.status, 'reachable', 'Already-checkmated root must return reachable');
  assert.equal(res0.winner, 'w');
  assert.deepEqual(res0.witness, [], 'Witness for already-checkmated root is empty sequence');
});

test('cycle with exit: cooperative search explores cycles without prematurely declaring deadness', () => {
  // Line 46 cycle: 8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1
  const pos = Position.fromFen('8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1');
  const blackSession = new CooperativeSearchSession(pos.snapshot(), 'b');
  const res = blackSession.resume(500);
  assert.equal(res.status, 'reachable');
  assert.equal(res.winner, 'b');
  assert.ok(res.witness.length > 0);
});

test('resumeWork exact entrypoint: deterministic per-successor slicing matches uninterrupted execution', () => {
  // Line 46 position
  const pos = Position.fromFen('8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1');

  // Monolithic run
  const sessionMono = new CooperativeSearchSession(pos.snapshot(), 'b');
  const resMono = sessionMono.resumeWork(5000);
  assert.equal(resMono.status, 'reachable');
  assert.equal(resMono.winner, 'b');
  assert.ok(resMono.witness.length > 0);

  // Sliced run with 3 work units per slice
  const sessionSliced = new CooperativeSearchSession(pos.snapshot(), 'b');
  let resSliced = sessionSliced.resumeWork(0);
  assert.equal(resSliced.status, 'pending');
  assert.equal(sessionSliced.totalWork, 0);

  while (resSliced.status === 'pending') {
    resSliced = sessionSliced.resumeWork(3);
  }

  assert.equal(resSliced.status, 'reachable');
  assert.equal(resSliced.winner, 'b');
  assert.equal(resSliced.witness.length, resMono.witness.length);
  assert.deepEqual(resSliced.witness, resMono.witness);
  assert.equal(sessionSliced.totalWork, sessionMono.totalWork);
});

test('resumeWork exact entrypoint: proves impossible closed graph with material pruning', () => {
  const pos = Position.fromFen('3qk3/8/8/8/8/5N2/8/4K3 w - - 0 1');
  const session = new CooperativeSearchSession(pos.snapshot(), 'w');

  let res = session.resumeWork(5);
  while (res.status === 'pending') {
    res = session.resumeWork(5);
  }

  assert.equal(res.status, 'impossible');
  assert.equal(res.provenance, 'closed_graph_material_pruned');
  assert.ok(session.totalWork > 0);
  assert.ok(session.materialDischarges > 0);
});

test('resumeWork exact entrypoint: resumeWork(1) on mate strictly spends 1 unit per call', () => {
  const pos = Position.fromFen('7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
  const session = new CooperativeSearchSession(pos.snapshot(), 'w');

  let res = session.resumeWork(1);
  while (res.status === 'pending') {
    const before = session.getWorkUnits();
    res = session.resumeWork(1);
    const delta = session.getWorkUnits() - before;
    assert.equal(delta, 1, `Every step must spend exactly 1 unit, got ${delta}`);
  }

  assert.equal(res.status, 'reachable');
  assert.equal(res.witness?.length, 1);
});

test('resumeWork exact entrypoint: slices of 1, 2, and 7 on multi-ply mate strictly bound delta work', () => {
  const budgets = [1, 2, 7];
  for (const budget of budgets) {
    // 3-ply rook mate position for White (1. Kg6 Kg8 2. Ra8#)
    const pos = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');
    const session = new CooperativeSearchSession(pos.snapshot(), 'w');
    let res = session.getStatus();
    while (res.status === 'pending') {
      const before = session.getWorkUnits();
      res = session.resumeWork(budget);
      const delta = session.getWorkUnits() - before;
      assert.ok(delta <= budget, `Delta ${delta} must not exceed budget ${budget}`);
      if (res.status === 'pending') {
        assert.equal(delta, budget, `Pending step must consume full budget ${budget}`);
      }
    }
    assert.equal(res.status, 'reachable');
    assert.equal(res.witness.length, 3);
  }
});

test('resumeWork exact entrypoint: 3-ply rook checkmate monolithic vs sliced parity and mixed legacy reads', () => {
  const pos = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');

  // Monolithic run
  const sessionMono = new CooperativeSearchSession(pos.snapshot(), 'w');
  const resMono = sessionMono.resumeWork(5000);
  assert.equal(resMono.status, 'reachable');
  assert.equal(resMono.witness.length, 3);

  // Sliced 1-unit run
  const sessionSliced = new CooperativeSearchSession(pos.snapshot(), 'w');
  let resSliced = sessionSliced.getStatus();
  while (resSliced.status === 'pending') {
    const before = sessionSliced.getWorkUnits();
    resSliced = sessionSliced.resumeWork(1);
    const delta = sessionSliced.getWorkUnits() - before;
    assert.equal(delta, 1, `1-unit step must spend exactly 1 unit, got ${delta}`);
  }
  assert.equal(resSliced.status, 'reachable');
  assert.equal(resSliced.witness.length, 3);
  assert.deepEqual(resSliced.witness, resMono.witness);
  assert.equal(sessionSliced.totalWork, sessionMono.totalWork);

  // Cached repeat read spends zero work
  const workAfter = sessionSliced.getWorkUnits();
  const resRepeat = sessionSliced.resumeWork(0);
  assert.equal(sessionSliced.getWorkUnits(), workAfter);
  assert.strictEqual(resRepeat, resSliced);

  // Mixed legacy read returns a detached mutable copy
  const resLegacy = sessionSliced.resume(10);
  assert.equal(resLegacy.status, 'reachable');
  assert.notStrictEqual(resLegacy, resSliced, 'Legacy resume must return a detached clone');
  const legacyMove = resLegacy.witness[0] as MutableMoveRecord;
  const originalFrom = legacyMove.from;
  legacyMove.from = 999;
  assert.equal(legacyMove.from, 999);
  assert.equal(resSliced.witness[0].from, originalFrom, 'Cached result must not be mutated');
});

test('cached finalized outcomes: cancel, unsupported admission, capacity limit, and impossible are top-level frozen while session is not', () => {
  // 1. Cancelled outcome
  const posNormal = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');
  const sessionCancel = new CooperativeSearchSession(posNormal.snapshot(), 'w');
  sessionCancel.cancel();
  const resCancel = sessionCancel.getStatus();
  assert.equal(resCancel.status, 'pending');
  assert.equal(resCancel.reason, 'cancelled');
  assert.ok(Object.isFrozen(resCancel), 'Cancelled result is top-level frozen');
  if (resCancel.status === 'pending') {
    assert.ok(resCancel.session);
    assert.equal(Object.isFrozen(resCancel.session), false, 'Session is not frozen');
  }
  assert.throws(() => {
    Object.assign(resCancel, { status: 'impossible' });
  }, TypeError);
  assert.strictEqual(sessionCancel.getStatus(), resCancel);
  assert.strictEqual(sessionCancel.resumeWork(0), resCancel);

  // 2. Unsupported admission outcome
  const posUnsupported = Position.fromFen('8/8/8/8/8/8/8/8 w - - 0 1'); // No kings
  const sessionUnsupported = new CooperativeSearchSession(posUnsupported.snapshot(), 'w');
  const resUnsupported = sessionUnsupported.getStatus();
  assert.equal(resUnsupported.status, 'pending');
  assert.equal(resUnsupported.reason, 'unsupported_state');
  assert.ok(Object.isFrozen(resUnsupported), 'Unsupported admission result is top-level frozen');
  if (resUnsupported.status === 'pending') {
    assert.ok(resUnsupported.session);
    assert.equal(Object.isFrozen(resUnsupported.session), false, 'Session is not frozen');
  }
  assert.throws(() => {
    Object.assign(resUnsupported, { status: 'impossible' });
  }, TypeError);
  assert.strictEqual(sessionUnsupported.getStatus(), resUnsupported);
  assert.strictEqual(sessionUnsupported.resumeWork(0), resUnsupported);

  // 3. Resource limit capacity hit outcome
  const posCycle = Position.fromFen('8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1');
  const sessionCap = new CooperativeSearchSession(posCycle.snapshot(), 'b', { maxRetainedStates: 1 });
  const resCap = sessionCap.resumeWork(10);
  assert.equal(resCap.status, 'pending');
  assert.equal(resCap.reason, 'resource_limit');
  assert.ok(Object.isFrozen(resCap), 'Capacity-limited result is top-level frozen');
  if (resCap.status === 'pending') {
    assert.ok(resCap.session);
    assert.equal(Object.isFrozen(resCap.session), false, 'Session is not frozen');
    // Session is not frozen, so setCapacity and recovery work!
    resCap.session.setCapacity(5000);
    assert.equal(resCap.session.getCapacity(), 5000);
  }
  assert.throws(() => {
    Object.assign(resCap, { status: 'impossible' });
  }, TypeError);
  const recovered = sessionCap.resumeWork(5000);
  assert.equal(recovered.status, 'reachable');

  // 4. Impossible outcome
  const posImpossible = Position.fromFen('3qk3/8/8/8/8/5N2/8/4K3 w - - 0 1');
  const sessionImp = new CooperativeSearchSession(posImpossible.snapshot(), 'w');
  const resImp = sessionImp.resumeWork(5000);
  assert.equal(resImp.status, 'impossible');
  assert.ok(Object.isFrozen(resImp), 'Impossible result is top-level frozen');
  assert.throws(() => {
    Object.assign(resImp, { status: 'reachable' });
  }, TypeError);

  // 5. Legacy resume returns detached mutable copies even for pending states
  const sessionLegacyPending = new CooperativeSearchSession(posCycle.snapshot(), 'b');
  const legacyPending = sessionLegacyPending.resume(0);
  assert.equal(legacyPending.status, 'pending');
  assert.equal(Object.isFrozen(legacyPending), false, 'Legacy resume must return unfrozen mutable copy');
  Object.assign(legacyPending, { status: 'impossible' });
  assert.equal(legacyPending.status, 'impossible');
  // Internal session status remains pending
  assert.equal(sessionLegacyPending.getStatus().status, 'pending');
});

test('resumeWork exact entrypoint: cached immutable result returned with zero work on repeated reads', () => {
  const pos = Position.fromFen('7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
  const session = new CooperativeSearchSession(pos.snapshot(), 'w');
  const res = session.resumeWork(100);
  assert.equal(res.status, 'reachable');
  assert.ok(res.witness.length >= 1);
  assert.ok(Object.isFrozen(res), 'Result object is deeply frozen');
  assert.ok(Object.isFrozen(res.witness), 'Witness array is deeply frozen');
  assert.ok(Object.isFrozen(res.witness[0]), 'Move objects are deeply frozen');

  const workBefore = session.getWorkUnits();
  const resRepeated = session.resumeWork(0);
  const statusRepeated = session.getStatus();
  assert.equal(session.getWorkUnits(), workBefore, 'Zero work spent on repeated inquiry');
  assert.strictEqual(resRepeated, res, 'resumeWork returns exact cached instance without copy');
  assert.strictEqual(statusRepeated, res, 'getStatus returns exact cached instance without copy');
});

test('resume legacy API: detached mutable output behavior is fully preserved', () => {
  const pos = Position.fromFen('7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
  const session = new CooperativeSearchSession(pos.snapshot(), 'w');
  const resLegacy = session.resume(100);
  assert.equal(resLegacy.status, 'reachable');
  assert.ok(resLegacy.witness.length >= 1);

  // Legacy returned witness is mutable and detached
  const firstMove = resLegacy.witness[0] as MutableMoveRecord;
  const originalFrom = firstMove.from;
  firstMove.from = 999;
  assert.equal(firstMove.from, 999, 'Legacy caller can mutate detached result');

  // Session internal state and getStatus are protected
  const status = session.getStatus();
  if (status.status === 'reachable') {
    assert.equal(status.witness[0].from, originalFrom, 'Session internal state remains intact');
  }
});
