import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BoundedReservoir,
  createPrng,
  deriveFaultSeed,
  deriveGameSeed,
  derivePlyMovePrng,
  isFaultAssociated,
  parsePositiveInt,
  parseSeed,
  parseSoakConfig,
  parseTimeoutMs,
  plyBucket,
  SoakMetricsTracker,
  TopKCollector,
  type MovePositionContext,
} from './support/soak-metrics.js';

test('parseSoakConfig validates positive integers and rejects invalid/blank env', () => {
  const defaults = parseSoakConfig({});
  assert.equal(defaults.seed, 1337);
  assert.equal(defaults.games, 6);
  assert.equal(defaults.plies, 16);
  assert.equal(defaults.thinkMs, 150);
  assert.equal(defaults.timeoutMs, 900_000);

  const custom = parseSoakConfig({
    SOAK_SEED: '9999',
    SOAK_GAMES: '10',
    SOAK_PLIES: '40',
    SOAK_THINK_MS: '200',
    SOAK_TIMEOUT_MS: '1800000',
  });
  assert.equal(custom.seed, 9999);
  assert.equal(custom.games, 10);
  assert.equal(custom.plies, 40);
  assert.equal(custom.thinkMs, 200);
  assert.equal(custom.timeoutMs, 1_800_000);

  assert.throws(() => parsePositiveInt('0', 6, 'GAMES'), RangeError);
  assert.throws(() => parsePositiveInt('-5', 6, 'GAMES'), RangeError);
  assert.throws(() => parsePositiveInt('abc', 6, 'GAMES'), RangeError);
  assert.throws(() => parsePositiveInt('1.5', 6, 'GAMES'), RangeError);
  assert.throws(() => parsePositiveInt('', 6, 'GAMES'), RangeError);
  assert.throws(() => parsePositiveInt('   ', 6, 'GAMES'), RangeError);

  assert.throws(() => parseSeed('xyz', 1337), RangeError);
  assert.throws(() => parseSeed('-1', 1337), RangeError);
  assert.throws(() => parseSeed('', 1337), RangeError);
  assert.throws(() => parseSeed('4294967296', 1337), RangeError); // > 32-bit uint

  assert.equal(parseTimeoutMs(undefined), 900_000);
  assert.equal(parseTimeoutMs('60000'), 60_000);
  assert.throws(() => parseTimeoutMs(''), RangeError);
  assert.throws(() => parseTimeoutMs('   '), RangeError);
  assert.throws(() => parseTimeoutMs('9999'), RangeError); // < 10000
  assert.throws(() => parseTimeoutMs('3600001'), RangeError); // > 3600000
  assert.throws(() => parseTimeoutMs('invalid'), RangeError);
  assert.throws(() => parseTimeoutMs('12345.67'), RangeError);
});

test('PRNG produces repeatable streams and anchors choices to basePly', () => {
  const seed = 4242;
  const prngA = createPrng(seed);
  const prngB = createPrng(seed);
  const seqA = Array.from({ length: 10 }, () => prngA());
  const seqB = Array.from({ length: 10 }, () => prngB());
  assert.deepEqual(seqA, seqB);

  const faultSeed = deriveFaultSeed(seed);
  const game0Seed = deriveGameSeed(seed, 0);
  const game1Seed = deriveGameSeed(seed, 1);
  assert.notEqual(faultSeed, game0Seed);
  assert.notEqual(game0Seed, game1Seed);

  // Retry PRNG is anchored to basePly: attempt 0 produces identical move choices on retry
  const ply0Try0A = derivePlyMovePrng(game0Seed, 5, 0)();
  const ply0Try0B = derivePlyMovePrng(game0Seed, 5, 0)();
  assert.equal(ply0Try0A, ply0Try0B);

  const ply0Try1 = derivePlyMovePrng(game0Seed, 5, 1)();
  assert.notEqual(ply0Try0A, ply0Try1);
});

test('BoundedReservoir tracks exact counts and caps memory without first-N bias', () => {
  const reservoir = new BoundedReservoir(50, 0x1234);
  for (let i = 1; i <= 500; i++) {
    reservoir.record(i);
  }
  const summary = reservoir.summary;
  assert.equal(summary.n, 500);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 500);
  assert.equal(summary.total, (500 * 501) / 2);
  assert.equal(summary.reservoirSize, 50);
  assert.equal(summary.isSampled, true);
  assert.ok(summary.p50 >= 180 && summary.p50 <= 320);
});

test('TopKCollector preserves late tails without first-N bias', () => {
  const topK = new TopKCollector<{ id: string; val: number }>(5, (item) => item.val);
  for (let i = 0; i < 20; i++) {
    topK.record({ id: `early-${i}`, val: 10 + i });
  }
  assert.equal(topK.items.length, 5);
  assert.equal(topK.items[0]?.val, 29);

  // Late tail with extreme latency arrives
  topK.record({ id: 'late-tail', val: 5000 });
  assert.equal(topK.items.length, 5);
  assert.equal(topK.items[0]?.id, 'late-tail');
  assert.equal(topK.items[0]?.val, 5000);
});

test('plyBucket partitions plies into 0-39, 40-79, 80-119, 120+', () => {
  assert.equal(plyBucket(0), '0-39');
  assert.equal(plyBucket(39), '0-39');
  assert.equal(plyBucket(40), '40-79');
  assert.equal(plyBucket(79), '40-79');
  assert.equal(plyBucket(80), '80-119');
  assert.equal(plyBucket(119), '80-119');
  assert.equal(plyBucket(120), '120+');
});

test('SoakMetricsTracker correlates move latency with basePly -> broadcast resultPly wiring', () => {
  const tracker = new SoakMetricsTracker(10);
  const game = 'game-wiring-test';

  tracker.onMovePending(game, 0, 1000);
  const lat0 = tracker.onMoveBroadcast(game, 1, 1180);
  assert.equal(lat0, 180);
  assert.equal(tracker.matchedMovesCount, 1);

  tracker.onMovePending(game, 1, 1300);
  const lat1 = tracker.onMoveBroadcast(game, 2, 1450);
  assert.equal(lat1, 150);
  assert.equal(tracker.matchedMovesCount, 2);

  const top = tracker.getTopMoveLatency();
  assert.equal(top.length, 2);
  assert.equal(top[0]?.basePly, 0);
  assert.equal(top[0]?.resultPly, 1);
  assert.equal(top[0]?.latencyMs, 180);
});

test('SoakMetricsTracker preserves state across failed-then-successful settlement retries', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-retry';
  const op = 'op-retry-1';

  tracker.recordStartAttempt(12.5, 45);
  tracker.recordStartAdmitted(game, op, 45, 12.5);

  const leaseDate = new Date(Date.now() + 5000);
  tracker.recordClaim({
    gameId: game,
    operationId: op,
    executorId: 'worker-1',
    generation: '1',
    leaseUntil: leaseDate,
  });

  tracker.recordStep(op, 20, 5, 2000);
  tracker.recordStep(op, 15, 4, 1500);

  // Settle attempt 1 FAILS
  tracker.recordSettleAttempt(op, 8.5);
  assert.equal(tracker.settledCommittedCount, 0);

  // Settle attempt 2 SUCCEEDS
  tracker.recordSettleAttempt(op, 6.0);
  tracker.recordSettlementCommitted(op);
  assert.equal(tracker.settledCommittedCount, 1);

  const topWall = tracker.getTopProvingWall();
  assert.equal(topWall.length, 1);
  const sample = topWall[0]!;
  assert.equal(sample.operationId, op);
  assert.equal(sample.basePly, 45);
  assert.equal(sample.resultPly, 46);
  assert.equal(sample.activeProofSliceWallMs, 35);
  assert.equal(sample.activeProofCpuMs, 9);
  assert.equal(sample.proofSteps, 3500);
  assert.equal(sample.proofSlices, 2);
  assert.equal(sample.evidence.settleAttempts, 2);
  assert.equal(sample.evidence.settleDbWallMs, 14.5);
});

test('SoakMetricsTracker correlates clock release by receipt.stopOperationId and protects same-game next op', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-same-game-next-op';
  const op1 = 'op-1';
  const op2 = 'op-2';

  // 1. op1 lifecycle: start, claim, step, settle
  tracker.recordStartAttempt(10, 0);
  tracker.recordStartAdmitted(game, op1, 0, 10);
  tracker.recordClaim({
    gameId: game,
    operationId: op1,
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  tracker.recordStep(op1, 10, 2, 500);
  tracker.recordSettleAttempt(op1, 5);
  tracker.recordSettlementCommitted(op1);

  // 2. op2 starts for the SAME game before op1 release arrives
  tracker.recordStartAttempt(8, 1);
  tracker.recordStartAdmitted(game, op2, 1, 8);
  tracker.recordClaim({
    gameId: game,
    operationId: op2,
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  tracker.recordStep(op2, 15, 3, 800);

  // 3. Release arrives for op1 (using receipt.stopOperationId = op1)
  tracker.recordReleaseAttempt(4.5);
  tracker.recordReleaseCommitted(op1, 4.5);

  // Verify op1 received release duration 4.5
  const topWallAfterOp1Release = tracker.getTopProvingWall();
  const sample1 = topWallAfterOp1Release.find((s) => s.operationId === op1)!;
  assert.ok(sample1);
  assert.equal(sample1.evidence.releaseDurationMs, 4.5);
  assert.ok(sample1.evidence.releaseCommittedAtMs !== undefined);

  // 4. Settle and release op2 with its own release duration 7.2
  tracker.recordSettleAttempt(op2, 6);
  tracker.recordSettlementCommitted(op2);
  tracker.recordReleaseAttempt(7.2);
  tracker.recordReleaseCommitted(op2, 7.2);

  const topWallFinal = tracker.getTopProvingWall();
  const sample2 = topWallFinal.find((s) => s.operationId === op2)!;
  assert.ok(sample2);
  assert.equal(sample2.evidence.releaseDurationMs, 7.2);
  assert.equal(sample1.evidence.releaseDurationMs, 4.5); // op1 untouched by op2 release
});

test('SoakMetricsTracker exposes phase evidence, claimGapWallMs, and epoch lease deadlines', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-takeover';
  const op = 'op-takeover-1';

  tracker.recordStartAttempt(10, 85);
  tracker.recordStartAdmitted(game, op, 85, 10);

  const lease1 = new Date(1731000000000);
  tracker.recordClaim({
    gameId: game,
    operationId: op,
    executorId: 'worker-1',
    generation: '1',
    leaseUntil: lease1,
  });

  const lease2 = new Date(1731000005000);
  tracker.recordClaim({
    gameId: game,
    operationId: op,
    executorId: 'worker-0',
    generation: '2',
    leaseUntil: lease2,
  });

  tracker.recordStep(op, 15, 3, 1000);
  tracker.recordRoles(op, ['global_deadness'], 'global_deadness');

  tracker.recordSettleAttempt(op, 5.0);
  tracker.recordSettlementCommitted(op);

  const topWall = tracker.getTopProvingWall();
  const sample = topWall[0]!;
  assert.equal(sample.isCausalTakeover, true);
  assert.equal(sample.evidence.claimsCount, 2);
  assert.equal(sample.evidence.firstExecutorId, 'worker-1');
  assert.equal(sample.evidence.lastExecutorId, 'worker-0');
  assert.equal(sample.evidence.claims[0]?.leaseDeadlineEpochMs, 1731000000000);
  assert.equal(sample.evidence.claims[1]?.leaseDeadlineEpochMs, 1731000005000);
  assert.ok(sample.evidence.claimGapWallMs >= 0);
});

test('isFaultAssociated respects finite duration bounds', () => {
  const faults = [{ name: 'worker_1_death', startMs: 1000, finiteDurationMs: 5000 }];

  // Within the 5000 ms finite window
  const during = isFaultAssociated(2000, 2500, faults, false);
  assert.equal(during.faultAssociated, true);
  assert.deepEqual(during.faultReasons, ['worker_1_death']);

  // After the 5000 ms window without lease takeover
  const after = isFaultAssociated(7000, 7500, faults, false);
  assert.equal(after.faultAssociated, false);

  // After the window with lease takeover
  const afterWithTakeover = isFaultAssociated(7000, 7500, faults, true);
  assert.equal(afterWithTakeover.faultAssociated, true);
  assert.deepEqual(afterWithTakeover.faultReasons, ['lease_takeover']);
});

test('SoakMetricsTracker tracks activeOpsCount and successorTakeoversCount accurately', () => {
  const tracker = new SoakMetricsTracker(5);
  assert.equal(tracker.activeOpsCount, 0);
  assert.equal(tracker.successorTakeoversCount, 0);

  tracker.recordStartAttempt(10, 0);
  tracker.recordStartAdmitted('game-1', 'op-1', 0, 10);
  assert.equal(tracker.activeOpsCount, 1);

  // First claim by worker-0
  tracker.recordClaim({
    gameId: 'game-1',
    operationId: 'op-1',
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  assert.equal(tracker.successorTakeoversCount, 0);

  // Renewal claim by same worker-0 (not a takeover)
  tracker.recordClaim({
    gameId: 'game-1',
    operationId: 'op-1',
    executorId: 'worker-0',
    generation: '2',
    leaseUntil: new Date(Date.now() + 5000),
  });
  assert.equal(tracker.successorTakeoversCount, 0);

  // Successor claim by worker-1 (takeover)
  tracker.recordClaim({
    gameId: 'game-1',
    operationId: 'op-1',
    executorId: 'worker-1',
    generation: '3',
    leaseUntil: new Date(Date.now() + 5000),
  });
  assert.equal(tracker.successorTakeoversCount, 1);

  // Additional renewal by worker-1 doesn't re-increment
  tracker.recordClaim({
    gameId: 'game-1',
    operationId: 'op-1',
    executorId: 'worker-1',
    generation: '4',
    leaseUntil: new Date(Date.now() + 5000),
  });
  assert.equal(tracker.successorTakeoversCount, 1);

  // Settle and committed removes from activeOps
  tracker.recordSettleAttempt('op-1', 5);
  tracker.recordSettlementCommitted('op-1');
  assert.equal(tracker.activeOpsCount, 0);
  assert.equal(tracker.successorTakeoversCount, 1);
});

test('LossyCommitControl deterministically forces at least targetMinLost commits', () => {
  const control = { enabled: true, targetMinLost: 1, rate: 0 };
  let counter = 0;
  const faultRnd = () => 0.5;

  const checkCommit = () => {
    if (control.enabled) {
      const shouldDrop = counter < control.targetMinLost || (control.rate > 0 && faultRnd() < control.rate);
      if (shouldDrop) {
        counter++;
        throw new Error('connection lost after COMMIT');
      }
    }
  };

  // First commit is deterministically dropped even when rate is 0
  assert.throws(() => checkCommit(), /connection lost after COMMIT/);
  assert.equal(counter, 1);

  // Subsequent commit with rate 0 is NOT dropped because targetMinLost reached
  assert.doesNotThrow(() => checkCommit());
  assert.equal(counter, 1);
});

test('SoakMetricsTracker retains exact position and candidate move context in tail samples', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-alpha';
  const op = 'op-alpha-1';
  const context: MovePositionContext = {
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    uci: 'g1f3',
    gameIndex: 0,
    gameSeed: 1337,
    attempt: 0,
    basePly: 4,
  };

  tracker.onMovePending(game, 4, 1000, context);
  tracker.recordStartAttempt(5, 4);
  tracker.recordStartAdmitted(game, op, 4, 5);
  tracker.recordClaim({
    gameId: game,
    operationId: op,
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  tracker.recordStep(op, 10, 2, 500);
  tracker.recordSettleAttempt(op, 4);
  tracker.recordSettlementCommitted(op);
  tracker.recordReleaseAttempt(3);
  tracker.recordReleaseCommitted(op, 3);
  tracker.onMoveBroadcast(game, 5, 1100);

  const provingTails = tracker.getTopProvingWall();
  assert.equal(provingTails.length, 1);
  const provingSample = provingTails[0]!;
  assert.ok(provingSample.positionContext, 'proving tail sample must retain positionContext');
  assert.equal(provingSample.positionContext.fen, context.fen);
  assert.equal(provingSample.positionContext.uci, 'g1f3');
  assert.equal(provingSample.positionContext.gameIndex, 0);
  assert.equal(provingSample.positionContext.gameSeed, 1337);
  assert.equal(provingSample.positionContext.attempt, 0);
  assert.equal(provingSample.positionContext.basePly, 4);

  const cpuTails = tracker.getTopProofCpu();
  assert.equal(cpuTails.length, 1);
  const cpuSample = cpuTails[0]!;
  assert.ok(cpuSample.positionContext, 'CPU tail sample must retain positionContext');
  assert.equal(cpuSample.positionContext.uci, 'g1f3');

  const moveTails = tracker.getTopMoveLatency();
  assert.equal(moveTails.length, 1);
  const moveSample = moveTails[0]!;
  assert.ok(moveSample.positionContext, 'move latency tail sample must retain positionContext');
  assert.equal(moveSample.positionContext.fen, context.fen);
  assert.equal(moveSample.positionContext.uci, 'g1f3');
});

test('SoakMetricsTracker isolates position context without cross-game or cross-ply contamination', () => {
  const tracker = new SoakMetricsTracker(5);
  const ctxA: MovePositionContext = {
    fen: 'fen-A-ply2',
    uci: 'c2c4',
    gameIndex: 0,
    gameSeed: 100,
    attempt: 0,
    basePly: 2,
  };
  const ctxB: MovePositionContext = {
    fen: 'fen-B-ply6',
    uci: 'd7d5',
    gameIndex: 1,
    gameSeed: 200,
    attempt: 0,
    basePly: 6,
  };

  tracker.onMovePending('game-A', 2, 1000, ctxA);
  tracker.onMovePending('game-B', 6, 1010, ctxB);

  tracker.recordStartAdmitted('game-A', 'op-A-1', 2, 5);
  tracker.recordStartAdmitted('game-B', 'op-B-1', 6, 6);

  tracker.recordSettleAttempt('op-A-1', 4);
  tracker.recordSettlementCommitted('op-A-1');

  tracker.recordSettleAttempt('op-B-1', 4);
  tracker.recordSettlementCommitted('op-B-1');

  const tails = tracker.getTopProvingWall();
  const sampleA = tails.find((s) => s.operationId === 'op-A-1')!;
  const sampleB = tails.find((s) => s.operationId === 'op-B-1')!;

  assert.ok(sampleA?.positionContext);
  assert.ok(sampleB?.positionContext);
  assert.equal(sampleA.positionContext.fen, 'fen-A-ply2');
  assert.equal(sampleA.positionContext.uci, 'c2c4');
  assert.equal(sampleA.positionContext.gameIndex, 0);

  assert.equal(sampleB.positionContext.fen, 'fen-B-ply6');
  assert.equal(sampleB.positionContext.uci, 'd7d5');
  assert.equal(sampleB.positionContext.gameIndex, 1);
});

test('SoakMetricsTracker replaces position context on failed retry without mismatch', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-retry';

  const failedContext: MovePositionContext = {
    fen: 'fen-before-move',
    uci: 'e2e4',
    gameIndex: 2,
    gameSeed: 555,
    attempt: 0,
    basePly: 10,
  };
  tracker.onMovePending(game, 10, 1000, failedContext);
  // Move is refused/fails
  tracker.onMoveFailed(game, 10);

  // Retry with next attempt & new move
  const retryContext: MovePositionContext = {
    fen: 'fen-before-move',
    uci: 'd2d4',
    gameIndex: 2,
    gameSeed: 555,
    attempt: 1,
    basePly: 10,
  };
  tracker.onMovePending(game, 10, 1050, retryContext);

  tracker.recordStartAdmitted(game, 'op-retry-ok', 10, 5);
  tracker.recordSettleAttempt('op-retry-ok', 4);
  tracker.recordSettlementCommitted('op-retry-ok');
  tracker.onMoveBroadcast(game, 11, 1200);

  const sample = tracker.getTopProvingWall()[0]!;
  assert.ok(sample.positionContext);
  assert.equal(sample.positionContext.attempt, 1);
  assert.equal(sample.positionContext.uci, 'd2d4');

  const moveSample = tracker.getTopMoveLatency()[0]!;
  assert.ok(moveSample.positionContext);
  assert.equal(moveSample.positionContext.attempt, 1);
  assert.equal(moveSample.positionContext.uci, 'd2d4');
});

test('SoakMetricsTracker updates provisional early-claim op with true admission duration and ply', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-early-claim';
  const op = 'op-early-claim-1';
  const context: MovePositionContext = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 42,
    attempt: 0,
    basePly: 0,
  };

  tracker.onMovePending(game, 0, 1000, context);

  // Early claim arrives before startAdjudication returns
  tracker.recordClaim({
    gameId: game,
    operationId: op,
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  tracker.recordStep(op, 10, 2, 10);

  // startAdjudication finally returns with true duration 55ms
  tracker.recordStartAttempt(55, 0);
  tracker.recordStartAdmitted(game, op, 0, 55);

  tracker.recordSettleAttempt(op, 5);
  tracker.recordSettlementCommitted(op);

  const sample = tracker.getTopProvingWall()[0]!;
  assert.equal(sample.evidence.admissionDurationMs, 55, 'admissionDurationMs must be updated to true duration');
  assert.equal(sample.proofSteps, 10, 'proof work must be preserved');
  assert.equal(sample.evidence.claimsCount, 1, 'claims count must be preserved');
  assert.ok(sample.positionContext, 'position context must be preserved');
  assert.equal(sample.positionContext.uci, 'e2e4');
  assert.equal(sample.basePly, 0);
  assert.equal(sample.resultPly, 1);
});

test('delayed admission return does not recreate completed op or corrupt active tracking', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-delayed-start';
  const op = 'op-delayed-1';

  tracker.recordClaim({
    gameId: game,
    operationId: op,
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  tracker.recordSettleAttempt(op, 5);
  tracker.recordSettlementCommitted(op);

  assert.equal(tracker.activeOpsCount, 0);

  // Delayed admission return arrives AFTER settlement has already committed
  tracker.recordStartAttempt(42, 0);
  tracker.recordStartAdmitted(game, op, 0, 42);

  // Must NOT recreate active operation
  assert.equal(tracker.activeOpsCount, 0, 'completed op must not be recreated in activeOps');
  const sample = tracker.getTopProvingWall()[0]!;
  assert.equal(sample.evidence.admissionDurationMs, 42, 'settled sample updated with true duration');
});

test('SoakMetricsTracker bounds and cleans up retained position context', () => {
  const tracker = new SoakMetricsTracker(5);
  assert.equal(tracker.positionContextsCount, 0);

  const ctx: MovePositionContext = {
    fen: 'fen-1',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 100,
    attempt: 0,
    basePly: 0,
  };

  // 1. Pending adds context
  tracker.onMovePending('game-clean', 0, 1000, ctx);
  assert.equal(tracker.positionContextsCount, 1);

  // 2. Failed move cleans up context
  tracker.onMoveFailed('game-clean', 0);
  assert.equal(tracker.positionContextsCount, 0);

  // 3. Settle cleans up context
  tracker.onMovePending('game-clean', 0, 1050, ctx);
  tracker.recordStartAdmitted('game-clean', 'op-clean-1', 0, 10);
  tracker.recordSettleAttempt('op-clean-1', 5);
  tracker.recordSettlementCommitted('op-clean-1');
  assert.equal(tracker.positionContextsCount, 0, 'context must be evicted after settlement');

  // 4. Bounded capacity (max 512)
  for (let i = 0; i < 600; i++) {
    tracker.onMovePending(`game-${i}`, 0, 2000 + i, {
      fen: `fen-${i}`,
      uci: 'e2e4',
      gameIndex: i,
      gameSeed: i,
      attempt: 0,
      basePly: 0,
    });
  }
  assert.equal(tracker.positionContextsCount, 512, 'must be capped at bounded 512 entries');
});

test('TopKCollector re-ranks evicted sample when late admission increases duration (capacity 1)', () => {
  const tracker = new SoakMetricsTracker(1);
  const opA = 'operation-a';
  const opB = 'operation-b';

  // 1. Provisional claim and settle for opA (very short provisional duration)
  tracker.recordClaim({
    gameId: 'game-1',
    operationId: opA,
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  tracker.recordSettleAttempt(opA, 2);
  tracker.recordSettlementCommitted(opA);

  // 2. Normal admission and settle for opB with 20ms duration (evicts opA from capacity 1 top-K)
  tracker.recordStartAttempt(20, 0);
  tracker.recordStartAdmitted('game-1', opB, 0, 20);
  tracker.recordClaim({
    gameId: 'game-1',
    operationId: opB,
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  tracker.recordSettleAttempt(opB, 5);
  tracker.recordSettlementCommitted(opB);

  // At this point, opB (20ms) should be the top and only item in topProvingWall
  const topBeforeLateAdmission = tracker.getTopProvingWall();
  assert.equal(topBeforeLateAdmission.length, 1);
  assert.equal(topBeforeLateAdmission[0]?.operationId, opB);

  // 3. Delayed admission for opA arrives supplying 1000ms duration
  tracker.recordStartAttempt(1000, 0);
  tracker.recordStartAdmitted('game-1', opA, 0, 1000);

  // opA must be reconsidered, re-ranked, and evict opB from capacity 1 top-K
  const topAfterLateAdmission = tracker.getTopProvingWall();
  assert.equal(topAfterLateAdmission.length, 1);
  assert.equal(topAfterLateAdmission[0]?.operationId, opA, 'opA must become top operation after late admission');
  assert.ok(topAfterLateAdmission[0]!.wallDurationMs >= 990);
});

test('TopKCollector re-ranks evicted sample on late release without duplicating entries (capacity 1)', () => {
  const tracker = new SoakMetricsTracker(1);
  const opA = 'op-rel-a';
  const opB = 'op-rel-b';

  const origNow = performance.now;
  let currentNow = 1000;
  performance.now = () => currentNow;
  try {
    // 1. opA starts and settles with small duration (e.g. 5ms)
    tracker.recordStartAttempt(5, 0);
    tracker.recordStartAdmitted('game-rel', opA, 0, 5);
    currentNow += 5;
    tracker.recordSettleAttempt(opA, 2);
    tracker.recordSettlementCommitted(opA);

    // 2. opB starts and settles with 50ms duration (evicts opA from capacity 1)
    currentNow += 10;
    tracker.recordStartAttempt(50, 0);
    tracker.recordStartAdmitted('game-rel', opB, 0, 50);
    currentNow += 50;
    tracker.recordSettleAttempt(opB, 5);
    tracker.recordSettlementCommitted(opB);

    assert.equal(tracker.getTopProvingWall()[0]?.operationId, opB);

    // 3. Late release arrives for opA with high duration (e.g. 500ms)
    currentNow += 500;
    tracker.recordReleaseAttempt(500);
    tracker.recordReleaseCommitted(opA, 500);

    const top = tracker.getTopProvingWall();
    assert.equal(top.length, 1, 'capacity must remain strictly 1 without duplication');
    assert.equal(top[0]?.operationId, opA, 'opA must become top operation after late release');
    assert.equal(top[0]?.evidence.releaseDurationMs, 500);
    assert.ok(top[0]!.wallDurationMs >= 500);

    // Re-invoking release or late updates on the same object must not duplicate
    tracker.recordReleaseCommitted(opA, 500);
    assert.equal(tracker.getTopProvingWall().length, 1, 'repeated update must not duplicate entries');
  } finally {
    performance.now = origNow;
  }
});

test('TopKCollector in-place re-ranks already-retained item without duplication (capacity 2)', () => {
  const tracker = new SoakMetricsTracker(2);
  const opA = 'op-dup-a';
  const opB = 'op-dup-b';

  const origNow = performance.now;
  let currentNow = 2000;
  performance.now = () => currentNow;
  try {
    // 1. opA starts and settles at 10ms
    tracker.recordStartAttempt(10, 0);
    tracker.recordStartAdmitted('game-dup', opA, 0, 10);
    currentNow += 10;
    tracker.recordSettleAttempt(opA, 2);
    tracker.recordSettlementCommitted(opA);

    // 2. opB starts and settles at 50ms
    currentNow += 5;
    tracker.recordStartAttempt(50, 0);
    tracker.recordStartAdmitted('game-dup', opB, 0, 50);
    currentNow += 50;
    tracker.recordSettleAttempt(opB, 5);
    tracker.recordSettlementCommitted(opB);

    // Both are retained in capacity 2, ordered [opB (50ms+), opA (10ms+)]
    let top = tracker.getTopProvingWall();
    assert.equal(top.length, 2, 'both opA and opB must be retained in capacity 2');
    assert.deepEqual(top.map((s) => s.operationId), [opB, opA]);

    // 3. Late release for already-retained opA with 200ms elapsed
    currentNow += 200;
    tracker.recordReleaseAttempt(200);
    tracker.recordReleaseCommitted(opA, 200);

    // opA outranks opB in-place; ordered [opA (200ms+), opB (50ms+)], no dropped opB, no duplicate opA
    top = tracker.getTopProvingWall();
    assert.equal(top.length, 2, 'must preserve exact capacity 2 without duplication');
    assert.deepEqual(top.map((s) => s.operationId), [opA, opB], 'opA must outrank opB without dropping opB');
    assert.equal(top[0]?.evidence.releaseDurationMs, 200);

    // Re-invoking release on already-retained opA must not duplicate entries or drop opB
    tracker.recordReleaseCommitted(opA, 200);
    top = tracker.getTopProvingWall();
    assert.equal(top.length, 2, 'repeated update must not duplicate entries or drop existing items');
    assert.deepEqual(top.map((s) => s.operationId), [opA, opB]);
  } finally {
    performance.now = origNow;
  }
});

test('delayed admission after release updates settled sample and does not recreate active op', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-after-release';
  const op = 'op-after-release-1';

  // 1. Provisional claim, step, settle, and release commit
  tracker.recordClaim({
    gameId: game,
    operationId: op,
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  tracker.recordStep(op, 15, 3, 20);
  tracker.recordSettleAttempt(op, 4);
  tracker.recordSettlementCommitted(op);
  tracker.recordReleaseAttempt(10);
  tracker.recordReleaseCommitted(op, 10);

  assert.equal(tracker.activeOpsCount, 0);

  // 2. Delayed admission arrives AFTER release has already committed
  tracker.recordStartAttempt(250, 0);
  tracker.recordStartAdmitted(game, op, 0, 250);

  // Must NOT recreate active operation
  assert.equal(tracker.activeOpsCount, 0, 'must not recreate active operation');

  // Must update settled sample with true admission duration and proof/claim preserved
  const sample = tracker.getTopProvingWall().find((s) => s.operationId === op)!;
  assert.ok(sample, 'sample must be retained');
  assert.equal(sample.evidence.admissionDurationMs, 250, 'true admission duration retained');
  assert.equal(sample.evidence.releaseDurationMs, 10, 'release duration preserved');
  assert.equal(sample.proofSteps, 20, 'proof steps preserved');
  assert.equal(sample.evidence.claimsCount, 1, 'claims count preserved');
});
