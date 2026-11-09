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
  WorkerLossBarrier,
  type DurableMoveLedgerEntry,
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

test('WorkerLossBarrier coordinates replica loss to prevent graceful-drain race and enable successor takeover', async () => {
  const barrier = new WorkerLossBarrier();
  assert.equal(barrier.isArmed, false);
  assert.equal(barrier.isTriggered, false);
  const initialTarget = barrier.target;
  assert.equal(initialTarget, undefined);

  barrier.arm();
  assert.equal(barrier.isArmed, true);

  // Cheap ready proof passes through without triggering
  let readyCompleted = false;
  await barrier.interceptProofBoundary('game-ready', 'op-ready', 'ready').then(() => {
    readyCompleted = true;
  });
  assert.equal(readyCompleted, true, 'ready proof must pass through without triggering barrier');
  assert.equal(barrier.isTriggered, false);

  // Active zero-budget proof pauses and triggers
  let workerResumed = false;
  const workerPromise = (async () => {
    await barrier.interceptProofBoundary('game-takeover', 'op-takeover-1', 'active');
    workerResumed = true;
  })();

  const target = await barrier.waitForPause(5000);
  assert.equal(target.gameId, 'game-takeover');
  assert.equal(target.operationId, 'op-takeover-1');
  assert.equal(barrier.isTriggered, true);
  const triggeredTarget = barrier.target;
  assert.deepEqual(triggeredTarget, { gameId: 'game-takeover', operationId: 'op-takeover-1' });
  assert.equal(workerResumed, false, 'worker must remain paused until barrier is released');

  barrier.release();
  await workerPromise;
  assert.equal(workerResumed, true, 'worker must resume after barrier release');
});

test('WorkerLossBarrier passes through immediately when disarmed or after trigger', async () => {
  const barrier = new WorkerLossBarrier();

  // 1. Disarmed barrier returns immediately without pausing
  let disarmedCompleted = false;
  await barrier.interceptProofBoundary('game-skip', 'op-skip', 'active').then(() => {
    disarmedCompleted = true;
  });
  assert.equal(disarmedCompleted, true);
  assert.equal(barrier.isTriggered, false);
  const disarmedTarget = barrier.target;
  assert.equal(disarmedTarget, undefined);

  // 2. Arm and trigger once with active proof
  barrier.arm();
  const triggerPromise = barrier.interceptProofBoundary('game-first', 'op-first', 'active');
  const target = await barrier.waitForPause(5000);
  assert.equal(target.operationId, 'op-first');
  barrier.release();
  await triggerPromise;

  // 3. Subsequent calls after trigger pass through immediately without changing target
  let subsequentCompleted = false;
  await barrier.interceptProofBoundary('game-second', 'op-second', 'active').then(() => {
    subsequentCompleted = true;
  });
  assert.equal(subsequentCompleted, true);
  const finalTarget = barrier.target;
  assert.equal(finalTarget?.operationId, 'op-first', 'target must remain first triggered operation');
});

test('WorkerLossBarrier abort releases waiters safely without hanging', async () => {
  const barrierA = new WorkerLossBarrier();
  barrierA.arm();

  // Waiting pause waiter rejects on abort
  const pausePromise = barrierA.waitForPause(5000);
  barrierA.abort('simulated test shutdown');
  await assert.rejects(pausePromise, {
    name: 'Error',
    message: 'simulated test shutdown',
  });

  // Waiting intercepted worker unblocks on abort
  const barrierB = new WorkerLossBarrier();
  barrierB.arm();
  let workerUnblocked = false;
  const workerPromise = (async () => {
    await barrierB.interceptProofBoundary('game-abort', 'op-abort', 'active');
    workerUnblocked = true;
  })();
  await barrierB.waitForPause(5000);
  barrierB.abort('teardown abort');
  await workerPromise;
  assert.equal(workerUnblocked, true, 'worker must unblock when barrier aborts');

  // Idempotent multiple aborts (e.g. catch then finally) do not throw or trigger unhandled rejection
  const barrierC = new WorkerLossBarrier();
  assert.doesNotThrow(() => barrierC.abort('first abort'));
  assert.doesNotThrow(() => barrierC.abort('idempotent second abort'));
});

test('SoakMetricsTracker tracks exact target operation claims and settlement status across takeover', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-target-check';
  const op = 'op-target-1';

  assert.equal(tracker.isOperationSettled(op), false);
  assert.equal(tracker.getOperationClaims(op), undefined);

  tracker.recordStartAttempt(10, 0);
  tracker.recordStartAdmitted(game, op, 0, 10);

  // Worker 1 initial claim
  tracker.recordClaim({
    gameId: game,
    operationId: op,
    executorId: 'worker-1',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });

  const claimsAfterFirst = tracker.getOperationClaims(op);
  assert.ok(claimsAfterFirst);
  assert.equal(claimsAfterFirst.length, 1);
  assert.equal(claimsAfterFirst[0]?.executorId, 'worker-1');
  assert.equal(claimsAfterFirst[0]?.generation, '1');
  assert.equal(tracker.isOperationSettled(op), false);

  // Worker 0 successor claim (takeover)
  tracker.recordClaim({
    gameId: game,
    operationId: op,
    executorId: 'worker-0',
    generation: '2',
    leaseUntil: new Date(Date.now() + 5000),
  });

  const claimsAfterTakeover = tracker.getOperationClaims(op);
  assert.ok(claimsAfterTakeover);
  assert.equal(claimsAfterTakeover.length, 2);
  assert.equal(claimsAfterTakeover[1]?.executorId, 'worker-0');
  assert.equal(claimsAfterTakeover[1]?.generation, '2');
  assert.equal(tracker.successorTakeoversCount, 1);

  // Settle and commit
  tracker.recordStep(op, 10, 2, 500);
  tracker.recordSettleAttempt(op, 4);
  tracker.recordSettlementCommitted(op);

  assert.equal(tracker.isOperationSettled(op), true);
  const claimsAfterSettle = tracker.getOperationClaims(op);
  assert.ok(claimsAfterSettle);
  assert.equal(claimsAfterSettle.length, 2);
});

test('SoakMetricsTracker correlates move latency on state snapshot recovery without move broadcast and prevents double counting', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-cold-restart';

  // 1. Pending move at basePly 1 expecting resultPly 2
  const positionContext: MovePositionContext = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 1234,
    attempt: 0,
    basePly: 1,
  };
  tracker.onMovePending(game, 1, 1000, positionContext);
  assert.equal(tracker.matchedMovesCount, 0);

  // 2. Early recovery response or state broadcast at ply 1 (not yet advanced) does not match
  const earlyRecovery = tracker.onRecoveryResponse(game, 1, 1050);
  assert.equal(earlyRecovery, undefined);
  const earlyState = tracker.onStateBroadcast(game, 1, 1060);
  assert.equal(earlyState, undefined);
  assert.equal(tracker.matchedMovesCount, 0);

  // 3. Cold restart simulated player reconnect receives readRecovery response at ply 2
  const recoveryLatency = tracker.onRecoveryResponse(game, 2, 1250, [{ ply: 2, uci: 'e2e4' }]);
  assert.equal(recoveryLatency, 250);
  assert.equal(tracker.matchedMovesCount, 1);

  const metricsAfterRecovery = tracker.getMoveLatencyQuantiles();
  assert.equal(metricsAfterRecovery.n, 1);
  assert.equal(metricsAfterRecovery.min, 250);
  assert.equal(metricsAfterRecovery.provenance.recovery_response, 1);
  assert.equal(metricsAfterRecovery.provenance.move_broadcast, 0);
  assert.equal(metricsAfterRecovery.provenance.state_broadcast, 0);
  assert.ok(metricsAfterRecovery.note.includes('in-process simulated-player API/pubsub visibility'));

  const top = tracker.getTopMoveLatency();
  assert.equal(top.length, 1);
  assert.equal(top[0]?.gameId, game);
  assert.equal(top[0]?.basePly, 1);
  assert.equal(top[0]?.resultPly, 2);
  assert.equal(top[0]?.latencyMs, 250);
  assert.equal(top[0]?.provenance, 'recovery_response');

  // 4. Late move broadcast and late state broadcast do not double-count
  const lateBroadcast = tracker.onMoveBroadcast(game, 2, 1300);
  assert.equal(lateBroadcast, undefined);
  const lateState = tracker.onStateBroadcast(game, 2, 1350);
  assert.equal(lateState, undefined);
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getMoveLatencyQuantiles().n, 1);

  // 5. Normal move path (move broadcast arrives first) records move_broadcast provenance
  tracker.onMovePending(game, 2, 1400);
  const normBroadcast = tracker.onMoveBroadcast(game, 3, 1520);
  assert.equal(normBroadcast, 120);
  assert.equal(tracker.matchedMovesCount, 2);

  // Late recovery response and late state broadcast for ply 3 do not double-count
  const lateRecoveryNorm = tracker.onRecoveryResponse(game, 3, 1550);
  assert.equal(lateRecoveryNorm, undefined);
  const lateStateNorm = tracker.onStateBroadcast(game, 3, 1600);
  assert.equal(lateStateNorm, undefined);
  assert.equal(tracker.matchedMovesCount, 2);

  // 6. Pubsub state broadcast delivery records state_broadcast provenance
  tracker.onMovePending(game, 3, 1650);
  const stateBroadcastLatency = tracker.onStateBroadcast(game, 4, 1750);
  assert.equal(stateBroadcastLatency, 100);
  assert.equal(tracker.matchedMovesCount, 3);

  const lateMoveAfterState = tracker.onMoveBroadcast(game, 4, 1800);
  assert.equal(lateMoveAfterState, undefined);
  assert.equal(tracker.matchedMovesCount, 3);

  // 7. Failed admission / retry isolation: onMoveFailed deletes pending move so state/recovery does not record it
  tracker.onMovePending(game, 4, 1850);
  tracker.onMoveFailed(game, 4);
  const failedRecovery = tracker.onRecoveryResponse(game, 5, 1900, [{ ply: 5, uci: 'g1f3' }]);
  assert.equal(failedRecovery, undefined);
  const failedState = tracker.onStateBroadcast(game, 5, 1950, [{ ply: 5, uci: 'g1f3' }]);
  assert.equal(failedState, undefined);
  assert.equal(tracker.matchedMovesCount, 3);

  // 8. Strict provenance breakdown verification
  const finalSummary = tracker.getMoveLatencyQuantiles();
  assert.equal(finalSummary.n, 3);
  const counts = tracker.moveLatencyProvenanceCounts;
  assert.equal(counts.recovery_response, 1);
  assert.equal(counts.move_broadcast, 1);
  assert.equal(counts.state_broadcast, 1);
  assert.equal(counts.recovery_response + counts.move_broadcast + counts.state_broadcast, finalSummary.n);
});

test('SoakMetricsTracker retains original start timestamp across ambiguous lost reply followed by same move retry', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-lost-reply';

  const context0: MovePositionContext = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 101,
    attempt: 0,
    basePly: 0,
  };

  // Attempt 0 at t = 1000
  tracker.onMovePending(game, 0, 1000, context0);
  assert.equal(tracker.matchedMovesCount, 0);

  // Ambiguous failure at t = 1050 (e.g. AuthorityCommitError on lost COMMIT reply)
  tracker.onMoveFailed(game, 0, 'ambiguous_commit', 'e2e4');
  assert.equal(tracker.matchedMovesCount, 0);
  assert.equal(tracker.getObservedMoveCount(game), 0);

  // Retry Attempt 1 for the SAME move at t = 1100
  const context1: MovePositionContext = {
    ...context0,
    attempt: 1,
  };
  tracker.onMovePending(game, 0, 1100, context1);

  // Definite refusal of the retry at t = 1150 must not delete the older ambiguous candidate
  tracker.onMoveFailed(game, 0, 'definite_failure', 'e2e4');
  assert.equal(tracker.matchedMovesCount, 0);

  // Durable move broadcast arrives at t = 1250 for ply 1 with uci 'e2e4'
  const latency = tracker.onMoveBroadcast(game, 1, 1250, 'e2e4');
  // Latency MUST be measured from initial attempt start (1250 - 1000 = 250ms), NOT retry start (1250 - 1100 = 150ms)
  assert.equal(latency, 250);
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);

  const summary = tracker.getMoveLatencyQuantiles();
  assert.equal(summary.n, 1);
  assert.equal(summary.min, 250);
  assert.equal(summary.max, 250);
  assert.equal(summary.provenance.move_broadcast, 1);

  const top = tracker.getTopMoveLatency();
  assert.equal(top.length, 1);
  assert.equal(top[0]?.latencyMs, 250);
  assert.equal(top[0]?.positionContext?.uci, 'e2e4');
  assert.equal(top[0]?.provenance, 'move_broadcast');
});

test('SoakMetricsTracker does not fabricate move latency sample on terminal or no-move settlement', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-terminal-no-move';

  const context: MovePositionContext = {
    fen: 'fen-ply2',
    uci: 'g1f3',
    gameIndex: 0,
    gameSeed: 202,
    attempt: 0,
    basePly: 2,
  };

  // 1. Move pending at basePly 2 (expectedPly 3)
  tracker.onMovePending(game, 2, 1000, context);

  // 2. Admission started
  tracker.recordStartAttempt(10, 2);
  tracker.recordStartAdmitted(game, 'op-term-1', 2, 10);
  tracker.recordClaim({
    gameId: game,
    operationId: 'op-term-1',
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  tracker.recordStep('op-term-1', 10, 2, 100);

  // 3. Settle commits terminal/no-move (ply does not advance)
  tracker.recordSettleAttempt('op-term-1', 5);
  tracker.recordSettlementCommitted('op-term-1');

  // 4. Definite failure reported to tracker
  tracker.onMoveFailed(game, 2, 'definite_failure');

  // 5. State broadcast arrives at ply 2
  const stateLat = tracker.onStateBroadcast(game, 2, 1100);
  assert.equal(stateLat, undefined);

  // 6. Recovery response arrives at ply 2
  const recLat = tracker.onRecoveryResponse(game, 2, 1200);
  assert.equal(recLat, undefined);

  // 7. Verify zero fabricated move samples
  assert.equal(tracker.matchedMovesCount, 0);
  assert.equal(tracker.getObservedMoveCount(game), 0);
  const summary = tracker.getMoveLatencyQuantiles();
  assert.equal(summary.n, 0);
  assert.equal(summary.total, 0);
  assert.equal(tracker.getTopMoveLatency().length, 0);
});

test('SoakMetricsTracker deduplicates observations across move broadcast, state broadcast, and recovery response', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-dedup';

  const context: MovePositionContext = {
    fen: 'startfen',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 303,
    attempt: 0,
    basePly: 0,
  };

  tracker.onMovePending(game, 0, 1000, context);

  // First observation: move broadcast arrives at t = 1150
  const lat1 = tracker.onMoveBroadcast(game, 1, 1150, 'e2e4');
  assert.equal(lat1, 150);
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);

  // Duplicate move broadcast at t = 1160 does not match
  const dupMove = tracker.onMoveBroadcast(game, 1, 1160, 'e2e4');
  assert.equal(dupMove, undefined);

  // Duplicate state broadcast at t = 1200 does not match
  const dupState = tracker.onStateBroadcast(game, 1, 1200);
  assert.equal(dupState, undefined);

  // Duplicate recovery response at t = 1300 does not match
  const dupRecovery = tracker.onRecoveryResponse(game, 1, 1300);
  assert.equal(dupRecovery, undefined);

  // Counts remain strictly 1
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);
  const counts = tracker.moveLatencyProvenanceCounts;
  assert.equal(counts.move_broadcast, 1);
  assert.equal(counts.state_broadcast, 0);
  assert.equal(counts.recovery_response, 0);
});

test('SoakMetricsTracker rejects wrong UCI at same ply and does not mislabel measurement context', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-wrong-uci';

  const context: MovePositionContext = {
    fen: 'startfen',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 404,
    attempt: 0,
    basePly: 0,
  };

  // Pending move at ply 0 (expectedPly 1) for 'e2e4'
  tracker.onMovePending(game, 0, 1000, context);

  // Broadcast arrives for ply 1, but with wrong UCI 'd2d4'
  const wrongMatch = tracker.onMoveBroadcast(game, 1, 1100, 'd2d4');
  assert.equal(wrongMatch, undefined, 'must reject broadcast with different UCI at same ply');
  assert.equal(tracker.matchedMovesCount, 0);
  assert.equal(tracker.getObservedMoveCount(game), 0);

  // State broadcast arrives with move ledger specifying ply 1 was 'd2d4'
  const wrongStateMatch = tracker.onStateBroadcast(game, 1, 1150, [{ ply: 1, uci: 'd2d4' }]);
  assert.equal(wrongStateMatch, undefined, 'state broadcast with mismatched durable UCI must not match pending move');
  assert.equal(tracker.matchedMovesCount, 0);
  assert.equal(tracker.getObservedMoveCount(game), 0);

  // Correct broadcast arrives for 'e2e4' at ply 1
  const correctMatch = tracker.onMoveBroadcast(game, 1, 1200, 'e2e4');
  assert.equal(correctMatch, 200);
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);
  const top = tracker.getTopMoveLatency();
  assert.equal(top.length, 1);
  assert.equal(top[0]?.positionContext?.uci, 'e2e4');
});

test('SoakMetricsTracker preserves uncommitted ambiguous attempt context when retry attempts different UCI', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-diff-uci-retry';

  const contextE4: MovePositionContext = {
    fen: 'startfen',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 505,
    attempt: 0,
    basePly: 0,
  };

  // Attempt 0 for 'e2e4' at t = 1000
  tracker.onMovePending(game, 0, 1000, contextE4);

  // Ambiguous commit failure at t = 1050
  tracker.onMoveFailed(game, 0, 'ambiguous_commit');

  // Retry with DIFFERENT UCI 'c2c4' at t = 1080
  const contextC4: MovePositionContext = {
    fen: 'startfen',
    uci: 'c2c4',
    gameIndex: 0,
    gameSeed: 505,
    attempt: 1,
    basePly: 0,
  };
  tracker.onMovePending(game, 0, 1080, contextC4);

  // If PostgreSQL actually committed the first attempt ('e2e4'), the broadcast arrives for 'e2e4':
  const matchE4 = tracker.onMoveBroadcast(game, 1, 1200, 'e2e4');
  // Must match 'e2e4' with its original measurement start time (1200 - 1000 = 200ms)
  assert.equal(matchE4, 200);
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);

  // Subsequent broadcast for 'c2c4' cannot double-count or match
  const lateC4 = tracker.onMoveBroadcast(game, 1, 1220, 'c2c4');
  assert.equal(lateC4, undefined);
  assert.equal(tracker.matchedMovesCount, 1);
});

test('SoakMetricsTracker preserves ambiguous attempt A when retry B suffers definite failure, matching A when durable', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-ambig-a-fail-b';

  const contextA: MovePositionContext = {
    fen: 'startfen',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 601,
    attempt: 0,
    basePly: 0,
  };
  const contextB: MovePositionContext = {
    fen: 'startfen',
    uci: 'c2c4',
    gameIndex: 0,
    gameSeed: 601,
    attempt: 1,
    basePly: 0,
  };

  // Attempt A at t = 1000
  tracker.onMovePending(game, 0, 1000, contextA);

  // Ambiguous failure on attempt A at t = 1050
  tracker.onMoveFailed(game, 0, 'ambiguous_commit', 'e2e4');

  // Attempt B at t = 1080
  tracker.onMovePending(game, 0, 1080, contextB);

  // Definite failure on attempt B at t = 1100 (e.g. invalid move or rejected)
  tracker.onMoveFailed(game, 0, 'definite_failure', 'c2c4');

  // Attempt A actually committed in PG, broadcast arrives for 'e2e4' at t = 1250
  const matchA = tracker.onMoveBroadcast(game, 1, 1250, 'e2e4');
  assert.equal(matchA, 250, 'latency must be measured from attempt A start');
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);
  const observed = tracker.getObservedMovesForGame(game);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.ply, 1);
  assert.equal(observed[0]?.uci, 'e2e4');
});

test('SoakMetricsTracker resolves two pending candidates at same ply exactly once against durable state ledger', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-two-candidates';

  const contextA: MovePositionContext = {
    fen: 'startfen',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 701,
    attempt: 0,
    basePly: 0,
  };
  const contextB: MovePositionContext = {
    fen: 'startfen',
    uci: 'c2c4',
    gameIndex: 0,
    gameSeed: 701,
    attempt: 1,
    basePly: 0,
  };

  tracker.onMovePending(game, 0, 1000, contextA);
  tracker.onMoveFailed(game, 0, 'ambiguous_commit', 'e2e4');
  tracker.onMovePending(game, 0, 1100, contextB);

  // State broadcast arrives with durable ledger indicating 'e2e4' was committed at ply 1
  const ledger: readonly DurableMoveLedgerEntry[] = [{ ply: 1, uci: 'e2e4' }];
  const match = tracker.onStateBroadcast(game, 1, 1300, ledger);

  assert.equal(match, 300, 'must match candidate A with original t=1000 start (1300 - 1000 = 300)');
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);

  const observed = tracker.getObservedMovesForGame(game);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.ply, 1);
  assert.equal(observed[0]?.uci, 'e2e4');

  // Any subsequent recovery or broadcast for ply 1 cannot double count
  const lateRecovery = tracker.onRecoveryResponse(game, 1, 1400, ledger);
  assert.equal(lateRecovery, undefined);
  const lateBroadcast = tracker.onMoveBroadcast(game, 1, 1450, 'c2c4');
  assert.equal(lateBroadcast, undefined);
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);
});

test('SoakMetricsTracker suppresses re-registration and prevents double counting when stale retry registers already-observed ply', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-stale-reregistration';

  const context: MovePositionContext = {
    fen: 'startfen',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 801,
    attempt: 0,
    basePly: 0,
  };

  // Initial attempt and broadcast
  tracker.onMovePending(game, 0, 1000, context);
  const firstLat = tracker.onMoveBroadcast(game, 1, 1150, 'e2e4');
  assert.equal(firstLat, 150);
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);

  // Stale retry attempts to register pending move for the same basePly (expectedPly 1)
  tracker.onMovePending(game, 0, 1200, { ...context, attempt: 1 });

  // Stale broadcast or state snapshot for ply 1 arrives
  const staleBroadcast = tracker.onMoveBroadcast(game, 1, 1250, 'e2e4');
  assert.equal(staleBroadcast, undefined);

  const staleState = tracker.onStateBroadcast(game, 1, 1300, [{ ply: 1, uci: 'e2e4' }]);
  assert.equal(staleState, undefined);

  const staleRecovery = tracker.onRecoveryResponse(game, 1, 1350, [{ ply: 1, uci: 'e2e4' }]);
  assert.equal(staleRecovery, undefined);

  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);
  assert.equal(tracker.getMoveLatencyQuantiles().n, 1);
});

test('SoakMetricsTracker never fabricates known move sample from state snapshot when ledger is missing or empty', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-missing-ledger';

  const context: MovePositionContext = {
    fen: 'startfen',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 901,
    attempt: 0,
    basePly: 0,
  };

  tracker.onMovePending(game, 0, 1000, context);

  // 1. State broadcast without ledger
  const matchNoLedger = tracker.onStateBroadcast(game, 1, 1100);
  assert.equal(matchNoLedger, undefined, 'must not match known UCI when ledger is absent');
  assert.equal(tracker.matchedMovesCount, 0);

  // 2. Recovery response with empty ledger
  const matchEmptyLedger = tracker.onRecoveryResponse(game, 1, 1150, []);
  assert.equal(matchEmptyLedger, undefined, 'must not match known UCI when ledger is empty');
  assert.equal(tracker.matchedMovesCount, 0);

  // 3. State broadcast with ledger confirming 'e2e4' at ply 1
  const matchWithLedger = tracker.onStateBroadcast(game, 1, 1200, [{ ply: 1, uci: 'e2e4' }]);
  assert.equal(matchWithLedger, 200, 'matches once ledger confirms durable UCI');
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);
});
