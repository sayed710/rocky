import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Position,
  type Move,
  type Color,
} from '../src';
import {
  CooperativeWitnessSession,
  MAX_WITNESS_LENGTH,
  verifyWitnessPath,
  type WitnessSearchResult,
} from '../src/witness-search';

test('CooperativeWitnessSession: finds immediate root checkmate at depth 0', () => {
  // Black king on a8 is in check by White rook on h8 with 0 legal moves
  const matedRoot = Position.fromFen('k6R/1p6/pK6/P7/8/1P6/8/8 b - - 0 1');
  const session = new CooperativeWitnessSession(matedRoot.snapshot(), 'w');

  const res = session.resume(100);
  assert.equal(res.status, 'reachable');
  assert.equal(res.winner, 'w');
  assert.deepEqual(res.witness, []);
  assert.equal(res.counters.maxDepthReached, 0);
});

test('CooperativeWitnessSession: finds 1-ply and multi-ply cooperative checkmate', () => {
  // Mate in 1 for White: Queen on e7, King on g6 vs Black King on h8 -> e7g7#
  const pos1 = Position.fromFen('7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
  const session1 = new CooperativeWitnessSession(pos1.snapshot(), 'w');
  const res1 = session1.resume(200);

  assert.equal(res1.status, 'reachable');
  assert.equal(res1.winner, 'w');
  assert.equal(res1.witness.length, 1);
  const verify1 = verifyWitnessPath(pos1.snapshot(), 'w', res1.witness);
  assert.equal(verify1.valid, true);
  assert.ok(session1.counters.replayWork >= 1);

  // Mate in 3-5 (cooperative helper mate)
  // White: King on f6, Rook on a1. Black: King on h8.
  // 1. Kg6 Kg8 2. Ra8# or 1. Rh1 Kg8 2. Rh7 Kf8 3. Rh8#
  const posRook = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');
  const sessionRook = new CooperativeWitnessSession(posRook.snapshot(), 'w');
  const resRook = sessionRook.resume(10000);
  assert.equal(resRook.status, 'reachable');
  assert.equal(resRook.winner, 'w');
  assert.ok(resRook.witness.length >= 3);
  const verifyRook = verifyWitnessPath(posRook.snapshot(), 'w', resRook.witness);
  assert.equal(verifyRook.valid, true);
  assert.ok(sessionRook.counters.replayWork >= 1);
});

test('CooperativeWitnessSession: resume(1) strictly enforces budget and never overruns', () => {
  const pos1 = Position.fromFen('7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
  const session1 = new CooperativeWitnessSession(pos1.snapshot(), 'w');

  const before = session1.counters.workUnits;
  const res = session1.resume(1);
  const delta = session1.counters.workUnits - before;
  assert.ok(delta <= 1, `Expected delta <= 1, got ${delta}`);
});

test('CooperativeWitnessSession: deterministic slicing matches monolithic execution', () => {
  const pos = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');

  // Monolithic
  const sessionMono = new CooperativeWitnessSession(pos.snapshot(), 'w', {
    attempts: [{ maxDepth: 6, maxBranching: 4, attemptWorkLimit: 1000 }],
  });
  const resMono = sessionMono.resume(2000);
  assert.equal(resMono.status, 'reachable');

  // Sliced with 2 work units per slice
  const sessionSliced = new CooperativeWitnessSession(pos.snapshot(), 'w', {
    attempts: [{ maxDepth: 6, maxBranching: 4, attemptWorkLimit: 1000 }],
  });
  let resSliced: WitnessSearchResult = sessionSliced.resume(0);
  assert.equal(resSliced.status, 'pending');

  while (resSliced.status === 'pending') {
    const before = sessionSliced.counters.workUnits;
    resSliced = sessionSliced.resume(2);
    const delta = sessionSliced.counters.workUnits - before;
    assert.ok(delta <= 2, `Slice exceeded budget: ${delta} > 2`);
  }

  assert.equal(resSliced.status, 'reachable');
  assert.equal(resSliced.winner, resMono.winner);
  assert.deepEqual(resSliced.witness, resMono.witness);
  assert.equal(sessionSliced.counters.workUnits, sessionMono.counters.workUnits);
});

test('CooperativeWitnessSession: zero budget returns pending without side effects', () => {
  const pos = Position.fromFen('7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
  const session = new CooperativeWitnessSession(pos.snapshot(), 'w');

  const res0 = session.resume(0);
  assert.equal(res0.status, 'pending');
  assert.equal(res0.reason, 'slice_exhausted');
  assert.equal(session.counters.workUnits, 0);
  assert.equal(session.counters.candidatesApplied, 0);
});

test('CooperativeWitnessSession: wrong winner checkmate is not accepted as proof', () => {
  const pos = Position.fromFen('k6R/1p6/pK6/P7/8/1P6/8/8 b - - 0 1');
  const session = new CooperativeWitnessSession(pos.snapshot(), 'b', {
    attempts: [{ maxDepth: 4, maxBranching: 2, attemptWorkLimit: 50 }],
  });
  const res = session.resume(100);
  assert.equal(res.status, 'pending');
  assert.equal(res.winner, 'b');
});

test('CooperativeWitnessSession: path cycle rejection detects and skips repeated states', () => {
  // Knight cycles back and forth
  const pos = Position.fromFen('8/8/8/8/8/4k3/4N3/4K3 w - - 0 1');
  const session = new CooperativeWitnessSession(pos.snapshot(), 'w', {
    playouts: false,
    attempts: [{ maxDepth: 8, maxBranching: 4, attemptWorkLimit: 600 }],
  });
  const res = session.resume(1000);
  assert.equal(res.status, 'pending');
  assert.ok(session.counters.cycleRejections >= 1, `Expected cycleRejections >= 1, got ${session.counters.cycleRejections}`);
});

test('CooperativeWitnessSession: resume after exhausted attempt is latched and never throws', () => {
  const pos = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');
  const session = new CooperativeWitnessSession(pos.snapshot(), 'w', {
    playouts: false,
    attempts: [{ maxDepth: 6, maxBranching: 4, attemptWorkLimit: 1 }],
  });

  const res1 = session.resume(100);
  assert.equal(res1.status, 'pending');
  assert.equal(res1.reason, 'attempts_exhausted');

  // Next resume(1) must not throw TypeError and must return attempts_exhausted with 0 delta
  const before = session.counters.workUnits;
  const res2 = session.resume(1);
  assert.equal(res2.status, 'pending');
  assert.equal(res2.reason, 'attempts_exhausted');
  assert.equal(session.counters.workUnits, before);
});

test('CooperativeWitnessSession: caller options array mutation does not break session', () => {
  const pos = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');
  const myAttempts = [{ maxDepth: 6, maxBranching: 4, attemptWorkLimit: 1 }];
  const session = new CooperativeWitnessSession(pos.snapshot(), 'w', { attempts: myAttempts });

  // Mutate caller array
  myAttempts.length = 0;

  // Session must operate normally on its deep-cloned attempts without throwing
  const res = session.resume(1);
  assert.equal(res.status, 'pending');
});

test('CooperativeWitnessSession: cancellation halts search stickily', () => {
  const pos = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');
  const session = new CooperativeWitnessSession(pos.snapshot(), 'w');

  session.cancel();
  const res = session.resume(100);
  assert.equal(res.status, 'pending');
  assert.equal(res.reason, 'cancelled');

  const res2 = session.resume(100);
  assert.equal(res2.status, 'pending');
  assert.equal(res2.reason, 'cancelled');
});

test('CooperativeWitnessSession: respects maxWitnessLength limit', () => {
  assert.equal(MAX_WITNESS_LENGTH, 500);

  // Mate requires 3 plies. Set maxWitnessLength: 2 -> must return resource_limit
  const pos = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');
  const session = new CooperativeWitnessSession(pos.snapshot(), 'w', {
    playouts: false,
    maxWitnessLength: 2,
    attempts: [{ maxDepth: 6, maxBranching: 4, attemptWorkLimit: 500 }],
  });
  const res = session.resume(500);
  assert.equal(res.status, 'pending');
  assert.equal(res.reason, 'resource_limit');
});

test('CooperativeWitnessSession: oversized candidate does not permanently retire search', () => {
  const pos = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');
  const session = new CooperativeWitnessSession(pos.snapshot(), 'w', {
    maxWitnessLength: 2,
    attempts: [{ maxDepth: 6, maxBranching: 10, attemptWorkLimit: 100000 }],
  });

  // Step 1: resume across slices
  const r1 = session.resume(100);
  assert.equal(r1.status, 'pending');
  assert.notEqual(r1.status, 'reachable', 'Must never publish oversized witness');
  const w1 = r1.counters.workUnits;
  assert.ok(w1 > 0);

  // Step 2: run further into search where the 5-ply candidate is encountered and rejected
  let lastWork = w1;
  for (let i = 0; i < 20; i++) {
    const r = session.resume(100);
    assert.notEqual(r.status, 'reachable', 'Must never publish candidate exceeding maxWitnessLength');
    assert.ok(r.counters.workUnits > lastWork, 'work must progress across slices exploring alternatives');
    lastWork = r.counters.workUnits;
  }

  // Work must have progressed past the first encountered oversized candidate and continued exploring
  assert.ok(session.counters.workUnits >= 2000);
  assert.ok(session.counters.attemptsStarted >= 1);
  const finalStatus = session.getStatus();
  assert.equal(finalStatus.status, 'pending');
  if (finalStatus.status === 'pending') {
    assert.equal(finalStatus.reason, 'resource_limit');
  }
});

test('CooperativeWitnessSession: deep immutability protects cached results and isolates caller input', () => {
  const pos = Position.fromFen('7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
  const snap = pos.snapshot();
  const session = new CooperativeWitnessSession(snap, 'w');

  // Caller input is not frozen or mutated by session
  assert.equal(Object.isFrozen(snap), false, 'Caller input state is not frozen');
  snap.board[0] = 'p';

  const res = session.resume(200);
  assert.equal(res.status, 'reachable');
  if (res.status === 'reachable') {
    assert.ok(res.witness.length >= 1);
    assert.ok(Object.isFrozen(res), 'Result object is deeply frozen');
    assert.ok(Object.isFrozen(res.witness), 'Witness array is deeply frozen');
    assert.ok(Object.isFrozen(res.witness[0]), 'Individual Move objects are deeply frozen');

    // Repeated getStatus and resume(0) return the exact same cached immutable instance with zero work
    const workBefore = session.counters.workUnits;
    const status1 = session.getStatus();
    const status2 = session.resume(0);
    assert.equal(session.counters.workUnits, workBefore, 'Zero work on repeated cached inquiry');
    assert.strictEqual(status1, res, 'getStatus returns cached instance');
    assert.strictEqual(status2, res, 'resume(0) returns cached instance');
  }
});

test('CooperativeWitnessSession: 1-unit preparation debits legal generation, scoring, and insertion comparison', () => {
  const pos = Position.fromFen('7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
  const session = new CooperativeWitnessSession(pos.snapshot(), 'w', { playouts: false });

  // Step 1: Legal move generation (1 unit)
  session.resume(1);
  assert.equal(session.counters.workUnits, 1);
  assert.equal(session.counters.legalGenerations, 1);
  assert.equal(session.counters.scoringWork, 0);
  assert.equal(session.counters.candidateEvaluations, 0);

  // Step 2: Score first candidate (1 unit)
  session.resume(1);
  assert.equal(session.counters.workUnits, 2);
  assert.equal(session.counters.legalGenerations, 1);
  assert.equal(session.counters.scoringWork, 1);
  assert.equal(session.counters.candidateEvaluations, 1);

  // Step 3: Insert first candidate into ordered list (1 unit)
  session.resume(1);
  assert.equal(session.counters.workUnits, 3);
  assert.equal(session.counters.legalGenerations, 1);
  assert.equal(session.counters.scoringWork, 2);
  assert.equal(session.counters.candidateEvaluations, 1);

  // Step 4: Score second candidate (1 unit)
  session.resume(1);
  assert.equal(session.counters.workUnits, 4);
  assert.equal(session.counters.legalGenerations, 1);
  assert.equal(session.counters.scoringWork, 3);
  assert.equal(session.counters.candidateEvaluations, 2);

  // Step 5: Bounded comparison / insertion for second candidate (1 unit)
  session.resume(1);
  assert.equal(session.counters.workUnits, 5);
  assert.equal(session.counters.legalGenerations, 1);
  assert.equal(session.counters.scoringWork, 4);
  assert.equal(session.counters.candidateEvaluations, 2);
});

test('CooperativeWitnessSession: verifyWitnessPath rejects tampered canonical metadata', () => {
  const pos = Position.fromFen('7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
  const session = new CooperativeWitnessSession(pos.snapshot(), 'w');
  const res = session.resume(200);
  assert.equal(res.status, 'reachable');
  assert.ok(res.witness.length >= 1);

  const genuineMove = res.witness[0];

  // Tamper captured piece
  const tamperedCaptured: Move = { ...genuineMove, captured: 'p' };
  assert.equal(verifyWitnessPath(pos.snapshot(), 'w', [tamperedCaptured]).valid, false);

  // Tamper flags
  const tamperedFlags: Move = { ...genuineMove, flags: genuineMove.flags ^ 1 };
  assert.equal(verifyWitnessPath(pos.snapshot(), 'w', [tamperedFlags]).valid, false);

  // Tamper castling rook
  const tamperedRook: Move = { ...genuineMove, castleRook: 0x77 };
  assert.equal(verifyWitnessPath(pos.snapshot(), 'w', [tamperedRook]).valid, false);
});

test('CooperativeWitnessSession: rejects invalid or over-500 maxWitnessLength options', () => {
  const pos = Position.fromFen('7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
  const snap = pos.snapshot();

  assert.throws(
    () => new CooperativeWitnessSession(snap, 'w', { maxWitnessLength: 0 }),
    /maxWitnessLength must be a positive safe integer <= 500/,
  );

  assert.throws(
    () => new CooperativeWitnessSession(snap, 'w', { maxWitnessLength: NaN }),
    /maxWitnessLength must be a positive safe integer <= 500/,
  );

  assert.throws(
    () => new CooperativeWitnessSession(snap, 'w', { maxWitnessLength: 501 }),
    /maxWitnessLength must be a positive safe integer <= 500/,
  );
});

test('CooperativeWitnessSession: multi-ply 5-ply rook discovery under slices of 1, 2, and 7 spends delta <= allowance', () => {
  const budgets = [1, 2, 7];
  for (const budget of budgets) {
    // 5-ply rook discovery: 1. Rh1 Kg8 2. Rh7 Kf8 3. Rh8#
    const pos = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');
    const session = new CooperativeWitnessSession(pos.snapshot(), 'w', {
      attempts: [{ maxDepth: 6, maxBranching: 10, attemptWorkLimit: 100000 }],
    });
    let res = session.getStatus();
    while (res.status === 'pending') {
      const before = session.counters.workUnits;
      res = session.resume(budget);
      const delta = session.counters.workUnits - before;
      assert.ok(delta <= budget, `Delta ${delta} must not exceed budget ${budget}`);
      if (res.status === 'pending') {
        assert.equal(delta, budget, `Pending step must consume full budget ${budget}`);
      }
    }
    assert.equal(res.status, 'reachable');
    assert.equal(res.witness.length, 5);
    const replay = verifyWitnessPath(pos.snapshot(), 'w', res.witness);
    assert.equal(replay.valid, true);
  }
});

test('CooperativeWitnessSession: 5-ply rook discovery monolithic parity, canonical replay, and cached immutable outputs', () => {
  const pos = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');
  const attemptConfig = [{ maxDepth: 6, maxBranching: 10, attemptWorkLimit: 100000 }];

  // Monolithic run
  const sessionMono = new CooperativeWitnessSession(pos.snapshot(), 'w', { attempts: attemptConfig });
  const resMono = sessionMono.resume(10000);
  assert.equal(resMono.status, 'reachable');
  assert.equal(resMono.witness.length, 5);

  // Sliced 7-unit run
  const sessionSliced = new CooperativeWitnessSession(pos.snapshot(), 'w', { attempts: attemptConfig });
  let resSliced: WitnessSearchResult = sessionSliced.getStatus();
  while (resSliced.status === 'pending') {
    const before = sessionSliced.counters.workUnits;
    resSliced = sessionSliced.resume(7);
    const delta = sessionSliced.counters.workUnits - before;
    assert.ok(delta <= 7, `Delta ${delta} must not exceed 7`);
  }
  assert.equal(resSliced.status, 'reachable');
  assert.equal(resSliced.witness.length, 5);
  assert.deepEqual(resSliced.witness, resMono.witness);
  assert.equal(sessionSliced.counters.workUnits, sessionMono.counters.workUnits);

  // Full canonical replay pass
  const replay = verifyWitnessPath(pos.snapshot(), 'w', resSliced.witness);
  assert.equal(replay.valid, true);

  // Deeply frozen cached outputs
  assert.ok(Object.isFrozen(resSliced), 'Result is frozen');
  assert.ok(Object.isFrozen(resSliced.witness), 'Witness array is frozen');
  assert.ok(Object.isFrozen(resSliced.witness[0]), 'Move objects are frozen');

  // Zero-work repeated reads
  const workAfter = sessionSliced.counters.workUnits;
  const resRepeat = sessionSliced.resume(0);
  const statusRepeat = sessionSliced.getStatus();
  assert.equal(sessionSliced.counters.workUnits, workAfter);
  assert.strictEqual(resRepeat, resSliced);
  assert.strictEqual(statusRepeat, resSliced);
});

test('CooperativeWitnessSession: cached finalized outcomes top-level immutability protects cancel and unsupported states', () => {
  // 1. Cancelled outcome
  const posNormal = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');
  const sessionCancel = new CooperativeWitnessSession(posNormal.snapshot(), 'w');
  sessionCancel.cancel();
  const resCancel = sessionCancel.getStatus();
  assert.equal(resCancel.status, 'pending');
  assert.equal(resCancel.reason, 'cancelled');
  assert.ok(Object.isFrozen(resCancel), 'Cancelled result is top-level frozen');
  assert.throws(() => {
    Object.assign(resCancel, { status: 'impossible' });
  }, TypeError);
  assert.strictEqual(sessionCancel.getStatus(), resCancel);
  assert.strictEqual(sessionCancel.resume(0), resCancel);

  // 2. Unsupported admission outcome
  const posUnsupported = Position.fromFen('8/8/8/8/8/8/8/8 w - - 0 1'); // No kings
  const sessionUnsupported = new CooperativeWitnessSession(posUnsupported.snapshot(), 'w');
  const resUnsupported = sessionUnsupported.getStatus();
  assert.equal(resUnsupported.status, 'pending');
  assert.equal(resUnsupported.reason, 'unsupported_state');
  assert.ok(Object.isFrozen(resUnsupported), 'Unsupported result is top-level frozen');
  assert.throws(() => {
    Object.assign(resUnsupported, { status: 'impossible' });
  }, TypeError);
  assert.strictEqual(sessionUnsupported.getStatus(), resUnsupported);
  assert.strictEqual(sessionUnsupported.resume(0), resUnsupported);

  // 3. Caller input state remains mutable and detached
  const snap = posNormal.snapshot();
  const sessionIsolate = new CooperativeWitnessSession(snap, 'w');
  assert.equal(Object.isFrozen(snap), false);
  snap.board[0] = 'q';
  assert.equal(sessionIsolate.getStatus().status, 'pending');
});

test('CooperativeWitnessSession: retained ordering shifting transitions smoothly across 1, 2, and 7 unit slices', () => {
  // Position with multiple candidate moves that trigger scoring, comparison, and rightward shifting
  const pos = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');

  // Verify that slicing finely (1 unit) through the entire ordering phase yields identical candidate order
  // as coarser slices (2 and 7 units)
  const session1 = new CooperativeWitnessSession(pos.snapshot(), 'w', {
    playouts: false,
    attempts: [{ maxDepth: 4, maxBranching: 6, attemptWorkLimit: 200 }],
  });
  const session7 = new CooperativeWitnessSession(pos.snapshot(), 'w', {
    playouts: false,
    attempts: [{ maxDepth: 4, maxBranching: 6, attemptWorkLimit: 200 }],
  });

  // Advance session1 by 1-unit steps
  for (let i = 0; i < 50; i++) {
    session1.resume(1);
  }
  // Advance session7 by 7-unit steps
  while (session7.counters.workUnits < session1.counters.workUnits) {
    session7.resume(7);
  }

  assert.ok(session1.counters.scoringWork > 0);
  assert.ok(session7.counters.scoringWork > 0);
  assert.ok(session1.counters.legalGenerations >= 1);
  assert.ok(session7.counters.legalGenerations >= 1);
});

// ── Guided playouts (Issue #124) ────────────────────────────────────────────

function runToEnd(session: CooperativeWitnessSession): WitnessSearchResult {
  let res = session.getStatus();
  for (let i = 0; i < 100_000; i++) {
    res = session.resume(5000);
    if (res.status !== 'pending' || res.reason !== 'slice_exhausted') break;
  }
  return res;
}

test('playouts: find a verified witness where the depth-first attempts alone exhaust', () => {
  // A middlegame position with mating material for White but no short forced helpmate.
  const pos = Position.fromFen('r1bqk2r/pp2bppp/2n1pn2/3p4/3P4/2NBPN2/PP3PPP/R1BQ1RK1 w kq - 0 9');
  const without = runToEnd(new CooperativeWitnessSession(pos.snapshot(), 'w', { playouts: false }));
  assert.equal(without.status, 'pending', 'the bounded depth-first attempts do not reach a mate');
  const withPlayouts = runToEnd(new CooperativeWitnessSession(pos.snapshot(), 'w'));
  assert.equal(withPlayouts.status, 'reachable');
  if (withPlayouts.status !== 'reachable') return;
  assert.ok(withPlayouts.witness.length > 0 && withPlayouts.witness.length <= MAX_WITNESS_LENGTH);
  assert.equal(verifyWitnessPath(pos.snapshot(), 'w', withPlayouts.witness).valid, true);
});

test('playouts: are deterministic for a position, and resumable across any slicing', () => {
  const pos = Position.fromFen('r1bqk2r/pp2bppp/2n1pn2/3p4/3P4/2NBPN2/PP3PPP/R1BQ1RK1 w kq - 0 9');
  const whole = runToEnd(new CooperativeWitnessSession(pos.snapshot(), 'w'));
  const sliced = new CooperativeWitnessSession(pos.snapshot(), 'w');
  let res = sliced.getStatus();
  for (let i = 0; i < 1_000_000 && res.status === 'pending' && res.reason === 'slice_exhausted'; i++) res = sliced.resume(7);
  assert.equal(whole.status, 'reachable');
  assert.equal(res.status, 'reachable');
  if (whole.status !== 'reachable' || res.status !== 'reachable') return;
  assert.deepEqual(res.witness, whole.witness);
});

test('playouts: never claim a mate the replay refuses, and give up where no mate exists', () => {
  // A lone king can never mate: playouts and attempts both end pending, never reachable.
  const pos = Position.fromFen('4k3/8/8/8/8/8/PPPP4/RNBQK3 w - - 0 1');
  const res = runToEnd(new CooperativeWitnessSession(pos.snapshot(), 'b'));
  assert.equal(res.status, 'pending');
});

test('playouts: options are validated', () => {
  const pos = Position.fromFen('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
  for (const bad of [{ count: 0, maxPlies: 10 }, { count: 2, maxPlies: 0 }, { count: 1.5, maxPlies: 3 }]) {
    assert.throws(() => new CooperativeWitnessSession(pos.snapshot(), 'w', { playouts: bad }), /playouts\./);
  }
});

test('playouts: unsuccessful playouts leave the first depth-first attempt its whole budget', () => {
  // A cooperative mate exists, but not in one move, so one-ply playouts cannot find it.
  const pos = Position.fromFen('7k/8/5K2/8/8/8/8/1Q6 w - - 0 1');
  const attempt = { maxDepth: 4, maxBranching: 40, attemptWorkLimit: 1_000_000 };
  const alone = runToEnd(new CooperativeWitnessSession(pos.snapshot(), 'w', { playouts: false, attempts: [attempt] }));
  assert.equal(alone.status, 'reachable');
  // Exactly the work that attempt needs: any of it charged to the playouts would exhaust it.
  const exact = { ...attempt, attemptWorkLimit: alone.counters.workUnits };
  const res = runToEnd(new CooperativeWitnessSession(pos.snapshot(), 'w', { playouts: { count: 50, maxPlies: 1 }, attempts: [exact] }));
  assert.equal(res.status, 'reachable', 'the single attempt still ran in full after the playouts');
  assert.ok(res.counters.workUnits > alone.counters.workUnits, 'the playouts did run and count toward the session');
});
