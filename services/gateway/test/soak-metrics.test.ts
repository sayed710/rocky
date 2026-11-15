import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IllegalMoveError, Position } from '@chess-platform/core';
import {
  BoundedReservoir,
  LostCommitTracker,
  ReplicaRouteGate,
  createPrng,
  createReplicaPublicationGuard,
  deriveFaultSeed,
  deriveGameSeed,
  derivePlyMovePrng,
  isFaultAssociated,
  lossyCommits,
  parsePositiveInt,
  parseSeed,
  parseSoakConfig,
  parseTimeoutMs,
  plyBucket,
  runWithLossyTransactionScope,
  selectSeededMoveUci,
  SoakMetricsTracker,
  TopKCollector,
  verifyLostCommitAdmissionStarted,
  verifyLostCommitDurableEvidence,
  WorkerLossBarrier,
  assertRecoveryStateMatchesReplayPrefix,
  assertStateViewMatchesReplay,
  type DurableLostCommitAdmissionEvidence,
  type DurableLostCommitEvidence,
  type DurableMoveLedgerEntry,
  type LossyCommitControl,
  type LossyCommitCounter,
  type LostCommitInjectionRecord,
  type MovePositionContext,
  type ReplayedGameLike,
  type StateViewSnapshotLike,
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
  tracker.recordStartRequest({ gameId: game, operationId: op, basePly: 4, atMs: 1000, uci: 'g1f3' });
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

  tracker.recordStartRequest({ gameId: 'game-A', operationId: 'op-A-1', basePly: 2, atMs: 1000, uci: 'c2c4' });
  tracker.recordStartAdmitted('game-A', 'op-A-1', 2, 5);
  tracker.recordStartRequest({ gameId: 'game-B', operationId: 'op-B-1', basePly: 6, atMs: 1010, uci: 'd7d5' });
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

  tracker.recordStartRequest({ gameId: game, operationId: 'op-retry-ok', basePly: 10, atMs: 1050, uci: 'd2d4' });
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
  tracker.recordStartRequest({ gameId: game, operationId: op, basePly: 0, atMs: 1000, uci: 'e2e4' });

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

test('SoakMetricsTracker definite UCI failure releases that candidate without retaining proof context while preserving ambiguous different UCI at same ply', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-definite-uci-release';

  const ctxAmbiguous: MovePositionContext = {
    fen: 'fen-ply0',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 100,
    attempt: 0,
    basePly: 0,
  };
  const ctxFailed: MovePositionContext = {
    fen: 'fen-ply0',
    uci: 'c2c4',
    gameIndex: 0,
    gameSeed: 100,
    attempt: 1,
    basePly: 0,
  };

  // 1. Ambiguous commit candidate e2e4 at basePly 0
  tracker.onMovePending(game, 0, 1000, ctxAmbiguous);
  tracker.recordStartRequest({
    gameId: game,
    operationId: 'op-e4-ambig',
    basePly: 0,
    atMs: 1000,
    uci: 'e2e4',
  });
  tracker.onMoveFailed(game, 0, 'ambiguous_commit', 'e2e4');
  assert.equal(tracker.unresolvedStartsCount, 1);

  // 2. Different UCI c2c4 at same ply suffers definite failure before admission commits
  tracker.onMovePending(game, 0, 1100, ctxFailed);
  tracker.onMoveFailed(game, 0, 'definite_failure', 'c2c4');

  // 3. Released c2c4 candidate cannot match broadcasts or state ledgers
  assert.equal(tracker.onMoveBroadcast(game, 1, 1150, 'c2c4'), undefined);
  assert.equal(tracker.onStateBroadcast(game, 1, 1160, [{ ply: 1, uci: 'c2c4' }]), undefined);
  assert.equal(tracker.matchedMovesCount, 0);

  // 4. Subsequent operation for c2c4 without a fresh pending registration does not retain failed context
  tracker.recordStartRequest({
    gameId: game,
    operationId: 'op-c4-after-fail',
    basePly: 0,
    atMs: 1200,
    uci: 'c2c4',
  });
  tracker.recordStartAdmitted(game, 'op-c4-after-fail', 0, 6);
  tracker.recordSettleAttempt('op-c4-after-fail', 3);
  tracker.recordSettlementCommitted('op-c4-after-fail');

  const afterFailOpSample = tracker.getTopProvingWall().find((s) => s.operationId === 'op-c4-after-fail');
  assert.ok(afterFailOpSample);
  assert.equal(afterFailOpSample.positionContext, undefined, 'subsequent operation must not retain failed candidate context');

  // 5. Preserved ambiguous e2e4 still retains exact proof context and move latency context
  tracker.recordClaim({
    gameId: game,
    operationId: 'op-e4-ambig',
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  assert.equal(tracker.unresolvedStartsCount, 0);
  tracker.recordStep('op-e4-ambig', 25, 10, 200);
  tracker.recordSettleAttempt('op-e4-ambig', 4);
  tracker.recordSettlementCommitted('op-e4-ambig');

  const ambigWallSample = tracker.getTopProvingWall().find((s) => s.operationId === 'op-e4-ambig');
  const ambigCpuSample = tracker.getTopProofCpu().find((s) => s.operationId === 'op-e4-ambig');
  assert.deepEqual(ambigWallSample?.positionContext, ctxAmbiguous);
  assert.deepEqual(ambigCpuSample?.positionContext, ctxAmbiguous);

  const latency = tracker.onMoveBroadcast(game, 1, 1350, 'e2e4');
  assert.equal(latency, 350);
  assert.equal(tracker.matchedMovesCount, 1);
  assert.deepEqual(tracker.getTopMoveLatency()[0]?.positionContext, ctxAmbiguous);
});

test('SoakMetricsTracker never retains candidate context as proof context after ply-wide definite failure', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-ply-fail-no-retain';
  const ctx: MovePositionContext = {
    fen: 'fen-ply2',
    uci: 'g1f3',
    gameIndex: 0,
    gameSeed: 200,
    attempt: 0,
    basePly: 2,
  };

  tracker.onMovePending(game, 2, 1000, ctx);
  tracker.onMoveFailed(game, 2, 'definite_failure');
  assert.equal(tracker.onMoveBroadcast(game, 3, 1050, 'g1f3'), undefined);

  // Subsequent start/admit/settle without a new pending move must not inherit failed context
  tracker.recordStartRequest({
    gameId: game,
    operationId: 'op-next-ply2',
    basePly: 2,
    atMs: 1100,
    uci: 'g1f3',
  });
  tracker.recordStartAdmitted(game, 'op-next-ply2', 2, 8);
  tracker.recordSettleAttempt('op-next-ply2', 4);
  tracker.recordSettlementCommitted('op-next-ply2');

  const sample = tracker.getTopProvingWall().find((s) => s.operationId === 'op-next-ply2');
  assert.ok(sample);
  assert.equal(sample.positionContext, undefined);
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
  assert.ok(topAfterLateAdmission[0]!.provingWallMs >= 990);
  assert.ok(topAfterLateAdmission[0]!.lifecycleWallMs >= 990);
});

test('TopKCollector re-ranks evicted sample on late release in lifecycle top-K without reranking proving tails or duplicating entries (capacity 1)', () => {
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
    assert.equal(tracker.getTopLifecycleWall()[0]?.operationId, opB);

    // 3. Late release arrives for opA with high duration (e.g. 500ms)
    currentNow += 500;
    tracker.recordReleaseAttempt(500);
    tracker.recordReleaseCommitted(opA, 500);

    // Proving tails must remain strictly ranked by provingWallMs (opB stays #1)
    const topProving = tracker.getTopProvingWall();
    assert.equal(topProving.length, 1, 'proving capacity must remain strictly 1');
    assert.equal(topProving[0]?.operationId, opB, 'late release must not rerank proving tails');

    // Lifecycle tails re-rank evicted opA to #1 without duplication
    const topLifecycle = tracker.getTopLifecycleWall();
    assert.equal(topLifecycle.length, 1, 'lifecycle capacity must remain strictly 1 without duplication');
    assert.equal(topLifecycle[0]?.operationId, opA, 'opA must become top lifecycle operation after late release');
    assert.equal(topLifecycle[0]?.evidence.releaseDurationMs, 500);
    assert.ok(topLifecycle[0]!.lifecycleWallMs >= 500);
    assert.ok(topLifecycle[0]!.wallDurationMs >= 500);

    // Re-invoking release or late updates on the same object must not duplicate
    tracker.recordReleaseCommitted(opA, 500);
    assert.equal(tracker.getTopProvingWall().length, 1, 'repeated update must not duplicate proving entries');
    assert.equal(tracker.getTopLifecycleWall().length, 1, 'repeated update must not duplicate lifecycle entries');
  } finally {
    performance.now = origNow;
  }
});

test('TopKCollector in-place re-ranks already-retained lifecycle item without reranking proving order or duplicating (capacity 2)', () => {
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
    let topProving = tracker.getTopProvingWall();
    let topLifecycle = tracker.getTopLifecycleWall();
    assert.equal(topProving.length, 2, 'both opA and opB must be retained in capacity 2');
    assert.deepEqual(topProving.map((s) => s.operationId), [opB, opA]);
    assert.deepEqual(topLifecycle.map((s) => s.operationId), [opB, opA]);

    // 3. Late release for already-retained opA with 200ms elapsed
    currentNow += 200;
    tracker.recordReleaseAttempt(200);
    tracker.recordReleaseCommitted(opA, 200);

    // Proving order stays [opB, opA] while release attribution is still visible on opA
    topProving = tracker.getTopProvingWall();
    assert.equal(topProving.length, 2);
    assert.deepEqual(topProving.map((s) => s.operationId), [opB, opA], 'release must not rerank proving order');
    assert.equal(topProving[1]?.evidence.releaseDurationMs, 200);

    // Lifecycle order re-ranks in-place to [opA (200ms+), opB (50ms+)] without dropping opB or duplicating opA
    topLifecycle = tracker.getTopLifecycleWall();
    assert.equal(topLifecycle.length, 2, 'must preserve exact capacity 2 without duplication');
    assert.deepEqual(topLifecycle.map((s) => s.operationId), [opA, opB], 'opA must outrank opB in lifecycle without dropping opB');
    assert.equal(topLifecycle[0]?.evidence.releaseDurationMs, 200);

    // Re-invoking release on already-retained opA must not duplicate entries or drop opB
    tracker.recordReleaseCommitted(opA, 200);
    topProving = tracker.getTopProvingWall();
    topLifecycle = tracker.getTopLifecycleWall();
    assert.equal(topProving.length, 2);
    assert.deepEqual(topProving.map((s) => s.operationId), [opB, opA]);
    assert.equal(topLifecycle.length, 2, 'repeated update must not duplicate entries or drop existing items');
    assert.deepEqual(topLifecycle.map((s) => s.operationId), [opA, opB]);
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

test('SoakMetricsTracker records move latency exactly once on missed broadcast followed by canonical recovery, but rejects when context is missing', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-missed-broadcast-recovery';

  const context: MovePositionContext = {
    fen: 'startfen',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 999,
    attempt: 0,
    basePly: 0,
  };

  // 1. Move registered pending at t = 1000
  tracker.onMovePending(game, 0, 1000, context);
  assert.equal(tracker.matchedMovesCount, 0);
  assert.equal(tracker.getObservedMoveCount(game), 0);

  // 2. PubSub move broadcast was missed (not delivered)
  // Simulated player or final drain executes recovery request returning canonical state.moves at t = 1250
  const recoveryLatency = tracker.onRecoveryResponse(game, 1, 1250, [{ ply: 1, uci: 'e2e4' }]);
  assert.equal(recoveryLatency, 250, 'must compute actual latency from pending start to recovery response return');
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);

  const observed = tracker.getObservedMovesForGame(game);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.ply, 1);
  assert.equal(observed[0]?.uci, 'e2e4');

  const summary = tracker.getMoveLatencyQuantiles();
  assert.equal(summary.n, 1);
  assert.equal(summary.min, 250);
  assert.equal(summary.provenance.recovery_response, 1);
  assert.equal(summary.provenance.move_broadcast, 0);

  // 3. Repeated recovery response or late broadcast for ply 1 logs exactly once (deduplicated)
  const dupRecovery = tracker.onRecoveryResponse(game, 1, 1300, [{ ply: 1, uci: 'e2e4' }]);
  assert.equal(dupRecovery, undefined);
  const lateBroadcast = tracker.onMoveBroadcast(game, 1, 1350, 'e2e4');
  assert.equal(lateBroadcast, undefined);
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);

  // 4. Missing context: canonical recovery includes ply 2 ('d7d5'), but no pending attempt was registered for it
  const missingContextLatency = tracker.onRecoveryResponse(game, 2, 1400, [
    { ply: 1, uci: 'e2e4' },
    { ply: 2, uci: 'd7d5' },
  ]);
  assert.equal(missingContextLatency, undefined, 'recovery without pending move context must not match or fabricate sample');
  assert.equal(tracker.matchedMovesCount, 1, 'matched count must remain 1');
  assert.equal(tracker.getObservedMoveCount(game), 1, 'observed move records must not include ply 2 without context');
});

test('SoakMetricsTracker preserves original candidate context and start time across lost reply and subsequent retry when claim arrives for earlier attempt', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-ambiguous-retry-claim';

  const contextA: MovePositionContext = {
    fen: 'fen-A',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 1234,
    attempt: 0,
    basePly: 0,
  };
  const contextB: MovePositionContext = {
    fen: 'fen-A',
    uci: 'd2d4',
    gameIndex: 0,
    gameSeed: 1234,
    attempt: 1,
    basePly: 0,
  };

  // 1. Move A registered pending and request entered at t = 1000
  tracker.onMovePending(game, 0, 1000, contextA);
  tracker.recordStartRequest({
    gameId: game,
    operationId: 'op-A',
    basePly: 0,
    atMs: 1000,
    uci: 'e2e4',
  });
  assert.equal(tracker.unresolvedStartsCount, 1);

  // 2. Reply is lost / ambiguous failure on move A
  tracker.onMoveFailed(game, 0, 'ambiguous_commit', 'e2e4');

  // 3. Retry B registered pending and request entered at t = 1400
  tracker.onMovePending(game, 0, 1400, contextB);
  tracker.recordStartRequest({
    gameId: game,
    operationId: 'op-B',
    basePly: 0,
    atMs: 1400,
    uci: 'd2d4',
  });
  assert.equal(tracker.unresolvedStartsCount, 2);

  // 4. Claim arrives for op-A at t = 2000 (worker picked up op-A from DB)
  tracker.recordClaim({
    gameId: game,
    operationId: 'op-A',
    executorId: 'worker-1',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  assert.equal(tracker.unresolvedStartsCount, 1, 'op-A promoted from unresolved starts');

  // 5. op-A completes proof and settles
  tracker.recordStep('op-A', 50, 40, 1);
  tracker.recordRoles('op-A', ['white'], 'draw');
  tracker.recordSettleAttempt('op-A', 10);
  tracker.recordSettlementCommitted('op-A');
  assert.equal(tracker.unresolvedStartsCount, 1);

  // 6. Verify top proving wall preserved contextA (e2e4, attempt 0) and original admissionStartMs = 1000
  const topWall = tracker.getTopProvingWall();
  assert.equal(topWall.length, 1);
  const sampleA = topWall[0]!;
  assert.equal(sampleA.operationId, 'op-A');
  assert.equal(sampleA.positionContext?.uci, 'e2e4', 'must preserve original candidate UCI e2e4, not retry d2d4');
  assert.equal(sampleA.positionContext?.attempt, 0, 'must preserve attempt 0, not retry attempt 1');
  assert.equal(sampleA.evidence.admissionStartMs, 1000, 'must preserve original request entry atMs');
  assert.equal(sampleA.evidence.admissionDurationMs, 0, 'lost reply has 0 direct admission duration');
});

test('SoakMetricsTracker preserves proving wall duration from request entry when claim arrives after delayed admission', (t) => {
  let currentTime = 1000;
  t.mock.method(performance, 'now', () => currentTime);

  const tracker = new SoakMetricsTracker(5);
  const game = 'game-delayed-claim-wall';

  const context: MovePositionContext = {
    fen: 'fen-start',
    uci: 'g1f3',
    gameIndex: 1,
    gameSeed: 5678,
    attempt: 0,
    basePly: 2,
  };

  // 1. Move registered pending and startAdjudication entered at entry time (t = 1000)
  tracker.onMovePending(game, 2, currentTime, context);
  tracker.recordStartRequest({
    gameId: game,
    operationId: 'op-delayed',
    basePly: 2,
    atMs: currentTime,
    uci: 'g1f3',
  });

  // 2. Claim arrives later at claim time (t = 2500) (delayed worker claim, reply lost/timeout)
  currentTime = 2500;
  tracker.recordClaim({
    gameId: game,
    operationId: 'op-delayed',
    executorId: 'worker-2',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });

  // 3. Settlement commits at settle time (t = 3000)
  currentTime = 3000;
  tracker.recordStep('op-delayed', 100, 80, 2);
  tracker.recordSettleAttempt('op-delayed', 15);
  tracker.recordSettlementCommitted('op-delayed');

  const topWall = tracker.getTopProvingWall();
  assert.equal(topWall.length, 1);
  const sample = topWall[0]!;
  assert.equal(sample.operationId, 'op-delayed');
  assert.equal(sample.evidence.admissionStartMs, 1000, 'admissionStartMs must be request entry monotonic time');
  assert.equal(sample.evidence.firstClaimAtMs, 2500, 'firstClaimAtMs must record claim time');

  const expectedProvingFromEntry = 2985 - 1000; // 1985 (entry to first settle attempt start)
  const provingFromClaim = 2985 - 2500; // 485
  const expectedLifecycleFromEntry = 3000 - 1000; // 2000 (entry through settle commit)
  assert.equal(sample.provingWallMs, expectedProvingFromEntry, 'proving wall measured from entry to first settle start');
  assert.notEqual(sample.provingWallMs, provingFromClaim, 'using claim time as start must fail');
  assert.ok(sample.provingWallMs > provingFromClaim, 'proving wall from entry exceeds proving wall from claim');
  assert.equal(sample.lifecycleWallMs, expectedLifecycleFromEntry, 'lifecycle wall measured from entry through settle commit');
  assert.equal(sample.wallDurationMs, expectedLifecycleFromEntry, 'legacy lifecycle wall alias matches lifecycleWallMs');
  assert.equal(sample.positionContext?.uci, 'g1f3');
});

test('SoakMetricsTracker rejects contextless pending candidate when supplied ledger omits pending ply', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-unrelated-ply-ledger';

  // 1. Contextless pending candidate registered for expected ply 1
  tracker.onMovePending(game, 0, 1000);
  assert.equal(tracker.matchedMovesCount, 0);

  // 2. State broadcast supplied with empty ledger []
  const matchEmpty = tracker.onStateBroadcast(game, 1, 1100, []);
  assert.equal(matchEmpty, undefined, 'empty ledger must reject contextless pending move');
  assert.equal(tracker.matchedMovesCount, 0);

  // 3. State broadcast supplied with unrelated ply ledger (ply 5 present, ply 1 missing)
  const matchUnrelated = tracker.onStateBroadcast(game, 5, 1200, [{ ply: 5, uci: 'g1f3' }]);
  assert.equal(matchUnrelated, undefined, 'ledger omitting pending ply must reject contextless pending move');
  assert.equal(tracker.matchedMovesCount, 0);

  // 4. State broadcast supplied with ledger containing ply 1
  const matchValid = tracker.onStateBroadcast(game, 1, 1300, [{ ply: 1, uci: 'e2e4' }]);
  assert.equal(matchValid, 300, 'ledger containing pending ply must match contextless candidate');
  assert.equal(tracker.matchedMovesCount, 1);
  assert.equal(tracker.getObservedMoveCount(game), 1);
  assert.equal(tracker.getObservedMovesForGame(game)[0]?.uci, 'e2e4');
});

test('assertStateViewMatchesReplay detects stale clock and turnStartedAt mismatches against replay snapshot', () => {
  const baseReplayed: ReplayedGameLike = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    adjudication: null,
    ply: 0,
    turn: 'w',
    status: { over: false },
    drawOffer: null,
    snapshot: () => ({
      clock: {
        remaining: { w: 300_000, b: 300_000 },
        turnStartedAt: 1_000,
      },
    }),
  };

  const validView: StateViewSnapshotLike = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    stateRevision: 0,
    adjudication: undefined,
    ply: 0,
    turn: 'w',
    status: { over: false },
    drawOffer: null,
    clock: { w: 300_000, b: 300_000 },
    turnStartedAt: 1_000,
  };

  // Valid view matches cleanly
  assertStateViewMatchesReplay(validView, baseReplayed, 1);

  // Stale white clock throws
  assert.throws(
    () => assertStateViewMatchesReplay({ ...validView, clock: { w: 299_000, b: 300_000 } }, baseReplayed, 1),
    /owner white clock matches replay snapshot/,
  );

  // Stale black clock throws
  assert.throws(
    () => assertStateViewMatchesReplay({ ...validView, clock: { w: 300_000, b: 298_000 } }, baseReplayed, 1),
    /owner black clock matches replay snapshot/,
  );

  // Stale turnStartedAt throws
  assert.throws(
    () => assertStateViewMatchesReplay({ ...validView, turnStartedAt: 2_000 }, baseReplayed, 1),
    /owner turnStartedAt matches replay snapshot/,
  );

  // Replay ply mismatch throws
  assert.throws(
    () => assertStateViewMatchesReplay({ ...validView, ply: 1 }, baseReplayed, 1),
    /owner ply equals replay ply/,
  );
});

test('SoakMetricsTracker preserves earliest wrapper entry and context on same-ID retry and duplicate admission after claim', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-same-id-earliest-entry';

  const contextA: MovePositionContext = {
    fen: 'fen-start',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 4321,
    attempt: 0,
    basePly: 0,
  };

  // 1. Initial request entered at t = 1000
  tracker.onMovePending(game, 0, 1000, contextA);
  tracker.recordStartRequest({
    gameId: game,
    operationId: 'op-same-id',
    basePly: 0,
    atMs: 1000,
    uci: 'e2e4',
  });

  // 2. Same-ID retry request at t = 1100 must NOT overwrite original entryAtMs (1000) or context
  tracker.recordStartRequest({
    gameId: game,
    operationId: 'op-same-id',
    basePly: 0,
    atMs: 1100,
    uci: 'e2e4',
  });
  assert.equal(tracker.unresolvedStartsCount, 1);

  // 3. Worker claim arrives at t = 1200, promoting the operation
  tracker.recordClaim({
    gameId: game,
    operationId: 'op-same-id',
    executorId: 'worker-1',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  assert.equal(tracker.unresolvedStartsCount, 0);

  // 4. Duplicate admission response arrives at t = 1300 with duration 300ms
  // Must NOT move admissionStartAt from 1000 or overwrite context
  tracker.recordStartAdmitted(game, 'op-same-id', 0, 300);

  // 5. Complete and settle
  tracker.recordStep('op-same-id', 20, 15, 1);
  tracker.recordSettleAttempt('op-same-id', 10);
  tracker.recordSettlementCommitted('op-same-id');

  const topWall = tracker.getTopProvingWall();
  assert.equal(topWall.length, 1);
  const sample = topWall[0]!;
  assert.equal(sample.operationId, 'op-same-id');
  assert.equal(sample.evidence.admissionStartMs, 1000, 'must preserve earliest wrapper entry monotonic start');
  assert.equal(sample.evidence.admissionDurationMs, 300, 'updates duration from admission response');
  assert.equal(sample.positionContext?.uci, 'e2e4');
  assert.equal(sample.positionContext?.attempt, 0);
});

test('SoakMetricsTracker omits unverifiable move context when exact candidate is absent despite conflicting sibling', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-conflicting-sibling';

  const siblingContext: MovePositionContext = {
    fen: 'fen-start',
    uci: 'e2e4',
    gameIndex: 2,
    gameSeed: 7777,
    attempt: 0,
    basePly: 0,
  };

  // 1. Pending candidate registered for sibling UCI 'e2e4'
  tracker.onMovePending(game, 0, 1000, siblingContext);

  // 2. Request entered for a DIFFERENT UCI 'd2d4' that has no exact pending candidate registered
  tracker.recordStartRequest({
    gameId: game,
    operationId: 'op-conflicting',
    basePly: 0,
    atMs: 1500,
    uci: 'd2d4',
  });

  // 3. Claim arrives for op-conflicting; must NOT steal sibling 'e2e4' context
  tracker.recordClaim({
    gameId: game,
    operationId: 'op-conflicting',
    executorId: 'worker-sibling',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });

  tracker.recordStep('op-conflicting', 40, 30, 1);
  tracker.recordSettleAttempt('op-conflicting', 10);
  tracker.recordSettlementCommitted('op-conflicting');

  const topWall = tracker.getTopProvingWall();
  assert.equal(topWall.length, 1);
  const sample = topWall[0]!;
  assert.equal(sample.operationId, 'op-conflicting');
  assert.equal(sample.positionContext, undefined, 'unverifiable move context must be omitted without stealing sibling');
  assert.equal(sample.evidence.admissionStartMs, 1500);
});

test('SoakMetricsTracker preserves original bound entry when same-ID duplicate admission arrives after claim and settlement', () => {
  const tracker = new SoakMetricsTracker(5);
  const game = 'game-settled-dup';
  const op = 'op-settled-dup';

  const context: MovePositionContext = {
    fen: 'fen-settled',
    uci: 'e2e4',
    gameIndex: 0,
    gameSeed: 888,
    attempt: 0,
    basePly: 0,
  };

  // 1. Pending candidate registered and request entered at monotonic t = 1000
  tracker.onMovePending(game, 0, 1000, context);
  tracker.recordStartRequest({
    gameId: game,
    operationId: op,
    basePly: 0,
    atMs: 1000,
    uci: 'e2e4',
  });

  // 2. Claim arrives and promotes op at t = 1200
  tracker.recordClaim({
    gameId: game,
    operationId: op,
    executorId: 'worker-1',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });

  // 3. Operation completes and settles before duplicate admission return arrives
  tracker.recordStep(op, 30, 20, 1);
  tracker.recordSettleAttempt(op, 10);
  tracker.recordSettlementCommitted(op);

  // 4. Duplicate admission arrives AFTER settlement
  // Must preserve bound admissionStartMs = 1000 and update admissionDurationMs to 45
  tracker.recordStartAdmitted(game, op, 0, 45);

  const topWall = tracker.getTopProvingWall();
  assert.equal(topWall.length, 1);
  const sample = topWall[0]!;
  assert.equal(sample.operationId, op);
  assert.equal(sample.evidence.admissionStartMs, 1000, 'must preserve original bound entry startMs');
  assert.equal(sample.evidence.admissionDurationMs, 45, 'updates admissionDurationMs from duplicate response');
  assert.equal(sample.positionContext?.uci, 'e2e4', 'preserves original bound position context');
});

interface FakeTxQueryLog {
  readonly sql: string;
}

interface FakeConnectedClient {
  readonly queries: FakeTxQueryLog[];
  readonly released: boolean;
  query(sql: string | { text: string }): Promise<{ rows: unknown[]; rowCount: number }>;
  release(): void;
}

function createFakePgPool(options?: {
  failPredicate?: (sqlText: string, callIndex: number) => Error | undefined;
}): {
  pool: {
    connect(): Promise<FakeConnectedClient>;
    query(sql: string | { text: string }): Promise<{ rows: unknown[]; rowCount: number }>;
  };
  clients: FakeConnectedClient[];
  allSql: string[];
} {
  const clients: FakeConnectedClient[] = [];
  const allSql: string[] = [];
  let callIndex = 0;

  const extractSql = (sql: string | { text: string }): string =>
    typeof sql === 'string' ? sql : sql.text;

  const pool = {
    async connect(): Promise<FakeConnectedClient> {
      const queries: FakeTxQueryLog[] = [];
      let released = false;
      const client: FakeConnectedClient = {
        queries,
        get released() {
          return released;
        },
        async query(sql: string | { text: string }) {
          const sqlText = extractSql(sql);
          const idx = ++callIndex;
          queries.push({ sql: sqlText });
          allSql.push(sqlText);
          const failErr = options?.failPredicate?.(sqlText, idx);
          if (failErr) {
            throw failErr;
          }
          return { rows: [], rowCount: 1 };
        },
        release() {
          released = true;
        },
      };
      clients.push(client);
      return client;
    },
    async query(sql: string | { text: string }) {
      const sqlText = extractSql(sql);
      const idx = ++callIndex;
      allSql.push(sqlText);
      const failErr = options?.failPredicate?.(sqlText, idx);
      if (failErr) {
        throw failErr;
      }
      return { rows: [], rowCount: 0 };
    },
  };

  return { pool, clients, allSql };
}

test('lossyCommits forwards scoped move_admission COMMIT before throwing and deduplicates retries by operationId', async () => {
  const { pool, clients } = createFakePgPool();
  const control: LossyCommitControl = {
    enabled: true,
    targetMinLost: 2,
    rate: 0,
    targetGameId: 'game-target',
    maxLost: 2,
    requireInsertInTx: true,
  };
  const injections: LostCommitInjectionRecord[] = [];
  const counter: LossyCommitCounter = {
    lost: 0,
    injectedOperationIds: new Set<string>(),
    injections,
  };
  const proxyPool = lossyCommits(pool, control, counter, () => 0.99);

  await assert.rejects(
    async () =>
      runWithLossyTransactionScope(
        {
          purpose: 'move_admission',
          gameId: 'game-target',
          operationId: 'op-admit-1',
          commandKind: 'move',
          uci: 'e2e4',
          basePly: 0,
        },
        async () => {
          const client = await proxyPool.connect();
          try {
            await client.query('BEGIN');
            await client.query('INSERT INTO game_adjudications (game_id, operation_id) VALUES ($1, $2)');
            await client.query('COMMIT');
          } finally {
            client.release();
          }
        },
      ),
    /connection lost after COMMIT/,
  );

  // Underlying COMMIT must have been forwarded to PostgreSQL before throwing to caller
  assert.deepEqual(
    clients[0]!.queries.map((q) => q.sql),
    ['BEGIN', 'INSERT INTO game_adjudications (game_id, operation_id) VALUES ($1, $2)', 'COMMIT'],
  );
  assert.equal(clients[0]!.released, true);
  assert.equal(counter.lost, 1);
  assert.equal(injections.length, 1);
  assert.equal(injections[0]!.gameId, 'game-target');
  assert.equal(injections[0]!.operationId, 'op-admit-1');
  assert.equal(injections[0]!.uci, 'e2e4');

  // Duplicate retry for the same operationId must commit normally without stealing second injection slot
  await runWithLossyTransactionScope(
    {
      purpose: 'move_admission',
      gameId: 'game-target',
      operationId: 'op-admit-1',
      commandKind: 'move',
      uci: 'e2e4',
      basePly: 0,
    },
    async () => {
      const client = await proxyPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO game_adjudications (game_id, operation_id) VALUES ($1, $2)');
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    },
  );
  assert.equal(counter.lost, 1, 'duplicate retry of injected operationId must not inject again');
  assert.equal(injections.length, 1);
});

test('lossyCommits leaves worker, out-of-scope, non-move, wrong-game, and non-insert COMMIT unaffected', async () => {
  const { pool, clients } = createFakePgPool();
  const control: LossyCommitControl = {
    enabled: true,
    targetMinLost: 1,
    rate: 1,
    targetGameId: 'game-target',
    maxLost: 5,
    requireInsertInTx: true,
  };
  const injections: LostCommitInjectionRecord[] = [];
  const counter: LossyCommitCounter = {
    lost: 0,
    injectedOperationIds: new Set<string>(),
    injections,
  };
  const proxyPool = lossyCommits(pool, control, counter, () => 0);

  // 1) Ordinary worker / unscoped transaction (claim/renew/settle/release)
  const workerClient = await proxyPool.connect();
  await workerClient.query('BEGIN');
  await workerClient.query('UPDATE game_adjudications SET lease_until = NOW()');
  await workerClient.query('COMMIT');
  workerClient.release();

  // 2) Out-of-scope command (other_admission / resign) even with INSERT
  await runWithLossyTransactionScope(
    {
      purpose: 'other_admission',
      gameId: 'game-target',
      operationId: 'op-resign-1',
      commandKind: 'resign',
    },
    async () => {
      const c = await proxyPool.connect();
      await c.query('BEGIN');
      await c.query('INSERT INTO game_events (game_id, seq) VALUES ($1, 1)');
      await c.query('COMMIT');
      c.release();
    },
  );

  // 3) Wrong targetGameId for move_admission
  await runWithLossyTransactionScope(
    {
      purpose: 'move_admission',
      gameId: 'game-other',
      operationId: 'op-other-game',
      commandKind: 'move',
      uci: 'd2d4',
      basePly: 0,
    },
    async () => {
      const c = await proxyPool.connect();
      await c.query('BEGIN');
      await c.query('INSERT INTO game_adjudications (game_id) VALUES ($1)');
      await c.query('COMMIT');
      c.release();
    },
  );

  // 4) Scoped move_admission without any INSERT when requireInsertInTx=true (regression against blind COMMIT drop)
  await runWithLossyTransactionScope(
    {
      purpose: 'move_admission',
      gameId: 'game-target',
      operationId: 'op-select-only',
      commandKind: 'move',
      uci: 'e2e4',
      basePly: 0,
    },
    async () => {
      const c = await proxyPool.connect();
      await c.query('BEGIN');
      await c.query('SELECT * FROM game_adjudications WHERE game_id = $1');
      await c.query('COMMIT');
      c.release();
    },
  );

  assert.equal(counter.lost, 0, 'none of the out-of-scope/worker/wrong-game/read-only COMMITs may be dropped');
  assert.equal(injections.length, 0);
  assert.equal(clients.length, 4);

  // 5) Now exact target game + move_admission + INSERT with object-form { text: 'COMMIT' } succeeds in injecting
  await assert.rejects(
    async () =>
      runWithLossyTransactionScope(
        {
          purpose: 'move_admission',
          gameId: 'game-target',
          operationId: 'op-exact-1',
          commandKind: 'move',
          uci: 'e2e4',
          basePly: 0,
        },
        async () => {
          const c = await proxyPool.connect();
          await c.query('BEGIN');
          await c.query('INSERT INTO game_events (game_id, seq) VALUES ($1, 1)');
          await c.query({ text: 'COMMIT' });
          c.release();
        },
      ),
    /connection lost after COMMIT/,
  );
  assert.equal(counter.lost, 1);
  assert.equal(injections[0]!.operationId, 'op-exact-1');
});

test('lossyCommits does not misattribute underlying DB or COMMIT failures as injected successes', async () => {
  let shouldFailCommit = true;
  const { pool } = createFakePgPool({
    failPredicate: (sqlText) => {
      if (shouldFailCommit && sqlText === 'COMMIT') {
        return new Error('PG serialization failure 40001');
      }
      if (sqlText.startsWith('INSERT INTO fail_insert')) {
        return new Error('PG constraint error');
      }
      return undefined;
    },
  });

  const control: LossyCommitControl = {
    enabled: true,
    targetMinLost: 1,
    rate: 0,
    targetGameId: 'game-1',
    maxLost: 1,
    requireInsertInTx: true,
  };
  const injections: LostCommitInjectionRecord[] = [];
  const injectedOperationIds = new Set<string>();
  const counter: LossyCommitCounter = {
    lost: 0,
    injectedOperationIds,
    injections,
  };
  const proxyPool = lossyCommits(pool, control, counter, () => 0);

  // Real DB failure on COMMIT must propagate raw PG error and MUST NOT count as injected
  await assert.rejects(
    async () =>
      runWithLossyTransactionScope(
        {
          purpose: 'move_admission',
          gameId: 'game-1',
          operationId: 'op-db-fail',
          commandKind: 'move',
          uci: 'e2e4',
          basePly: 0,
        },
        async () => {
          const c = await proxyPool.connect();
          await c.query('BEGIN');
          await c.query('INSERT INTO game_adjudications (game_id) VALUES ($1)');
          await c.query('COMMIT');
        },
      ),
    /PG serialization failure 40001/,
  );
  assert.equal(counter.lost, 0, 'failed DB COMMIT must never increment lost count');
  assert.equal(injections.length, 0);
  assert.equal(injectedOperationIds.has('op-db-fail'), false, 'failed DB COMMIT must not burn operationId dedup');

  // Reused client after ROLLBACK resets tx insert state so select-only COMMIT afterward stays unaffected
  shouldFailCommit = false;
  await runWithLossyTransactionScope(
    {
      purpose: 'move_admission',
      gameId: 'game-1',
      operationId: 'op-rollback-reuse',
      commandKind: 'move',
      uci: 'e2e4',
      basePly: 0,
    },
    async () => {
      const c = await proxyPool.connect();
      await c.query('BEGIN');
      await assert.rejects(
        () => c.query('INSERT INTO fail_insert VALUES (1)'),
        /PG constraint error/,
      );
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query('SELECT 1');
      await c.query('COMMIT');
      c.release();
    },
  );
  assert.equal(counter.lost, 0);

  // Subsequent healthy move_admission COMMIT still gets injected once
  await assert.rejects(
    async () =>
      runWithLossyTransactionScope(
        {
          purpose: 'move_admission',
          gameId: 'game-1',
          operationId: 'op-db-ok',
          commandKind: 'move',
          uci: 'g1f3',
          basePly: 2,
        },
        async () => {
          const c = await proxyPool.connect();
          await c.query('BEGIN');
          await c.query('INSERT INTO game_adjudications (game_id) VALUES ($1)');
          await c.query('COMMIT');
          c.release();
        },
      ),
    /connection lost after COMMIT/,
  );
  assert.equal(counter.lost, 1);
  assert.equal(injections[0]!.operationId, 'op-db-ok');
});

test('lossyCommits isolates concurrent AsyncLocalStorage transactions without stealing injection', async () => {
  const { pool } = createFakePgPool();
  const control: LossyCommitControl = {
    enabled: true,
    targetMinLost: 1,
    rate: 0,
    targetGameId: 'game-target',
    maxLost: 1,
    requireInsertInTx: true,
  };
  const injections: LostCommitInjectionRecord[] = [];
  const counter: LossyCommitCounter = {
    lost: 0,
    injectedOperationIds: new Set<string>(),
    injections,
  };
  const proxyPool = lossyCommits(pool, control, counter, () => 0);

  const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

  const targetTask = assert.rejects(
    async () =>
      runWithLossyTransactionScope(
        {
          purpose: 'move_admission',
          gameId: 'game-target',
          operationId: 'op-conc-target',
          commandKind: 'move',
          uci: 'e2e4',
          basePly: 0,
        },
        async () => {
          const c = await proxyPool.connect();
          await c.query('BEGIN');
          await yieldTick();
          await c.query('INSERT INTO game_adjudications (game_id) VALUES ($1)');
          await yieldTick();
          await c.query('COMMIT');
          c.release();
        },
      ),
    /connection lost after COMMIT/,
  );

  const workerTask = (async () => {
    const c = await proxyPool.connect();
    await c.query('BEGIN');
    await c.query('INSERT INTO worker_claims VALUES ($1)');
    await yieldTick();
    await c.query('COMMIT');
    c.release();
  })();

  const wrongGameTask = runWithLossyTransactionScope(
    {
      purpose: 'move_admission',
      gameId: 'game-decoy',
      operationId: 'op-conc-decoy',
      commandKind: 'move',
      uci: 'd2d4',
      basePly: 0,
    },
    async () => {
      const c = await proxyPool.connect();
      await c.query('BEGIN');
      await c.query('INSERT INTO game_adjudications (game_id) VALUES ($1)');
      await yieldTick();
      await c.query('COMMIT');
      c.release();
    },
  );

  await Promise.all([targetTask, workerTask, wrongGameTask]);
  assert.equal(counter.lost, 1);
  assert.equal(injections.length, 1);
  assert.equal(injections[0]!.operationId, 'op-conc-target');
});

test('LostCommitTracker and verifyLostCommitDurableEvidence enforce uncertain route and matching durable persistence', () => {
  const makeRecord = (overrides?: Partial<LostCommitInjectionRecord>): LostCommitInjectionRecord => ({
    gameId: 'game-1',
    operationId: 'op-1',
    purpose: 'move_admission',
    commandKind: 'move',
    uci: 'e2e4',
    basePly: 0,
    hadInsertInTx: true,
    injectedAtMs: 100,
    routeOutcome: 'pending',
    durableVerified: false,
    ...overrides,
  });

  const makeDeclaredMoveEffect = (overrides?: Record<string, unknown>) => ({
    type: 'MovePlayed',
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    ...overrides,
  });

  // Legal settlement ordering per settlePrepared ([resolved, ...resolved.effects]) and appendSettlementBatch (startedSeq+1..finalSeq)
  const makeEvidence = (overrides?: Partial<DurableLostCommitEvidence>): DurableLostCommitEvidence => ({
    gameId: 'game-1',
    operationId: 'op-1',
    executionState: 'completed',
    startedSeq: 1,
    finalSeq: 3,
    events: [
      {
        seq: 1,
        type: 'AdjudicationStarted',
        payload: { gameId: 'game-1', operationId: 'op-1', prepared: { intent: { kind: 'move', uci: 'e2e4' } } },
      },
      {
        seq: 2,
        type: 'AdjudicationResolved',
        payload: {
          gameId: 'game-1',
          operationId: 'op-1',
          startedSeq: 1,
          effects: [makeDeclaredMoveEffect()],
        },
      },
      {
        seq: 3,
        type: 'MovePlayed',
        payload: { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
      },
    ],
    ...overrides,
  });

  // Positive case: uncertain_error + completed operation with [AdjudicationStarted (1), AdjudicationResolved (2), MovePlayed (3)]
  const validRec = makeRecord({ routeOutcome: 'uncertain_error', routeErrorName: 'AuthorityCommitError' });
  const validCheck = verifyLostCommitDurableEvidence(validRec, makeEvidence());
  assert.equal(validCheck.valid, true);
  if (validCheck.valid) {
    assert.equal(validCheck.resultPly, 1);
    assert.equal(validCheck.startedSeq, 1);
    assert.equal(validCheck.resolvedSeq, 2);
  }

  // Positive terminal-move branch per deriveMoveEffects ([MovePlayed, GameEnded] -> seq 3 and seq 4)
  const terminalMoveCheck = verifyLostCommitDurableEvidence(
    validRec,
    makeEvidence({
      finalSeq: 4,
      events: [
        {
          seq: 1,
          type: 'AdjudicationStarted',
          payload: { gameId: 'game-1', operationId: 'op-1', prepared: { intent: { kind: 'move', uci: 'e2e4' } } },
        },
        {
          seq: 2,
          type: 'AdjudicationResolved',
          payload: {
            gameId: 'game-1',
            operationId: 'op-1',
            startedSeq: 1,
            effects: [
              makeDeclaredMoveEffect(),
              { type: 'GameEnded', result: '1-0', termination: 'checkmate', winner: 'w' },
            ],
          },
        },
        { seq: 3, type: 'MovePlayed', payload: { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' } },
        { seq: 4, type: 'GameEnded', payload: { result: '1-0', termination: 'checkmate', winner: 'w' } },
      ],
    }),
  );
  assert.equal(terminalMoveCheck.valid, true);

  // Tracker only increments verifiedCommittedCount once durable evidence matches and surfaces failure reasons
  const tracker = new LostCommitTracker();
  assert.equal(tracker.recordInjection(makeRecord()), true);
  assert.equal(tracker.recordInjection(makeRecord()), false, 'duplicate operationId injection rejected');
  assert.equal(tracker.injectedCount, 1);
  assert.equal(tracker.verifiedCommittedCount, 0, 'must not count committed move before route uncertainty + durable proof');

  // Regression: route unexpected_success or pending must prevent durable verification and expose rejection reason
  const pendingDetail = tracker.verifyDurableEvidenceDetailed('op-1', makeEvidence());
  assert.equal(pendingDetail.valid, false);
  assert.match(tracker.lastFailureReason ?? '', /routeOutcome was "pending"/);

  tracker.recordRouteOutcome('op-1', 'uncertain_error', 'CommandOutcomeUnknownError');
  assert.equal(tracker.uncertainRouteCount, 1);
  const verifiedDetail = tracker.verifyDurableEvidenceDetailed('op-1', makeEvidence());
  assert.equal(verifiedDetail.valid, true);
  assert.equal(tracker.lastFailureReason, undefined);
  assert.equal(tracker.verifiedCommittedCount, 1);

  // Inverted-order negative: MovePlayed before AdjudicationResolved violates [resolved, ...resolved.effects]
  const invertedCheck = verifyLostCommitDurableEvidence(
    validRec,
    makeEvidence({
      events: [
        {
          seq: 1,
          type: 'AdjudicationStarted',
          payload: { gameId: 'game-1', operationId: 'op-1', prepared: { intent: { kind: 'move', uci: 'e2e4' } } },
        },
        { seq: 2, type: 'MovePlayed', payload: { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' } },
        {
          seq: 3,
          type: 'AdjudicationResolved',
          payload: { gameId: 'game-1', operationId: 'op-1', startedSeq: 1, effects: [makeDeclaredMoveEffect()] },
        },
      ],
    }),
  );
  assert.equal(invertedCheck.valid, false, 'inverted MovePlayed-before-AdjudicationResolved must be rejected');
  if (!invertedCheck.valid) {
    assert.match(invertedCheck.reason, /AdjudicationResolved.*startedSeq\+1/);
  }

  // Regressions proving prior weak checks fail:
  // 1) unexpected_success fails even if durable move exists
  assert.equal(
    verifyLostCommitDurableEvidence(makeRecord({ routeOutcome: 'unexpected_success' }), makeEvidence()).valid,
    false,
  );
  // 2) unsettled execution_state='proving' (or worker claim without completion) fails
  assert.equal(
    verifyLostCommitDurableEvidence(
      validRec,
      makeEvidence({ executionState: 'proving' }),
    ).valid,
    false,
  );
  // 3) mismatched persisted UCI vs declared MovePlayed fails
  assert.equal(
    verifyLostCommitDurableEvidence(
      validRec,
      makeEvidence({
        events: [
          {
            seq: 1,
            type: 'AdjudicationStarted',
            payload: { gameId: 'game-1', operationId: 'op-1', prepared: { intent: { kind: 'move', uci: 'e2e4' } } },
          },
          {
            seq: 2,
            type: 'AdjudicationResolved',
            payload: { gameId: 'game-1', operationId: 'op-1', startedSeq: 1, effects: [makeDeclaredMoveEffect()] },
          },
          { seq: 3, type: 'MovePlayed', payload: { ply: 1, uci: 'd2d4', san: 'd4', by: 'w' } },
        ],
      }),
    ).valid,
    false,
  );
  // 4) wrong basePly correlation fails (stale/different ply move cannot impersonate admitted move)
  assert.equal(
    verifyLostCommitDurableEvidence(
      makeRecord({ routeOutcome: 'uncertain_error', basePly: 4 }),
      makeEvidence(),
    ).valid,
    false,
  );
  // 5) root/base GameEnded resolution without MovePlayed fails (move did not execute)
  assert.equal(
    verifyLostCommitDurableEvidence(
      validRec,
      makeEvidence({
        events: [
          {
            seq: 1,
            type: 'AdjudicationStarted',
            payload: { gameId: 'game-1', operationId: 'op-1', prepared: { intent: { kind: 'move', uci: 'e2e4' } } },
          },
          {
            seq: 2,
            type: 'AdjudicationResolved',
            payload: {
              gameId: 'game-1',
              operationId: 'op-1',
              startedSeq: 1,
              effects: [{ type: 'GameEnded', result: '1/2-1/2', termination: 'dead_position', winner: null }],
            },
          },
          { seq: 3, type: 'GameEnded', payload: { result: '1/2-1/2', termination: 'dead_position', winner: null } },
        ],
      }),
    ).valid,
    false,
  );
  // 6) non-move admission intent cannot pass as move admission
  assert.equal(
    verifyLostCommitDurableEvidence(
      validRec,
      makeEvidence({
        events: [
          {
            seq: 1,
            type: 'AdjudicationStarted',
            payload: { gameId: 'game-1', operationId: 'op-1', prepared: { intent: { kind: 'resign' } } },
          },
          {
            seq: 2,
            type: 'AdjudicationResolved',
            payload: { gameId: 'game-1', operationId: 'op-1', startedSeq: 1, effects: [makeDeclaredMoveEffect()] },
          },
          { seq: 3, type: 'MovePlayed', payload: { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' } },
        ],
      }),
    ).valid,
    false,
  );
});

test('createReplicaPublicationGuard blocks stale and disposed replica publications after cold restart', async () => {
  const active: Array<{ executorId: string } | undefined> = [{ executorId: 'exec-old' }];
  const oldIdentity = active[0]!;
  const newIdentity = { executorId: 'exec-cold-replacement' };
  const publishedBy: string[] = [];

  const oldGuard = createReplicaPublicationGuard(
    0,
    (idx) => active[idx],
    () => oldIdentity,
  );
  const newGuard = createReplicaPublicationGuard(
    0,
    (idx) => active[idx],
    () => newIdentity,
  );

  const oldPublish = oldGuard.wrapPublish(async (chg: { gameId: string }) => {
    publishedBy.push(`old:${chg.gameId}`);
  });
  const newPublish = newGuard.wrapPublish(async (chg: { gameId: string }) => {
    publishedBy.push(`new:${chg.gameId}`);
  });

  // Active undisposed old replica publishes cleanly
  await oldPublish({ gameId: 'g-1' });
  assert.equal(oldGuard.publishCount, 1);
  assert.equal(oldGuard.staleBlockedCount, 0);

  // Replacement takes slot 0 before old worker drains -> old publication is blocked even before markDisposed
  active[0] = newIdentity;
  await assert.rejects(() => oldPublish({ gameId: 'g-1' }), /Stale replica exec-old \(slot 0\) blocked/);
  assert.equal(oldGuard.staleBlockedCount, 1);
  assert.equal(oldGuard.publishCount, 1);

  // markDisposed permanently blocks old replica
  oldGuard.markDisposed();
  assert.equal(oldGuard.isDisposed, true);
  await assert.rejects(() => oldPublish({ gameId: 'g-2' }), /Stale replica exec-old \(slot 0\) blocked/);
  assert.equal(oldGuard.staleBlockedCount, 2);

  // Replacement replica publishes without interference
  await newPublish({ gameId: 'g-1' });
  assert.equal(newGuard.publishCount, 1);
  assert.deepEqual(publishedBy, ['old:g-1', 'new:g-1']);
});

test('LostCommitTracker Stage 1 admission verification rejects wrong identity and requires final MovePlayed proof', () => {
  const tracker = new LostCommitTracker();
  const injection: LostCommitInjectionRecord = {
    gameId: 'game-1',
    operationId: 'op-1',
    purpose: 'move_admission',
    commandKind: 'move',
    uci: 'e2e4',
    basePly: 0,
    hadInsertInTx: true,
    injectedAtMs: 100,
    routeOutcome: 'pending',
    admissionVerified: false,
    durableVerified: false,
  };
  assert.equal(tracker.recordInjection(injection), true);

  const makeAdmissionEvidence = (
    overrides?: Partial<DurableLostCommitAdmissionEvidence>,
  ): DurableLostCommitAdmissionEvidence => ({
    gameId: 'game-1',
    operationId: 'op-1',
    executionState: 'proving',
    startedSeq: 1,
    events: [
      {
        seq: 1,
        type: 'AdjudicationStarted',
        payload: {
          gameId: 'game-1',
          operationId: 'op-1',
          prepared: { gameId: 'game-1', operationId: 'op-1', intent: { kind: 'move', uci: 'e2e4' } },
        },
      },
    ],
    ...overrides,
  });

  // Pending route outcome must be rejected even when AdjudicationStarted is already persisted
  const pendingAdm = tracker.verifyAdmissionStartedDetailed('op-1', makeAdmissionEvidence());
  assert.equal(pendingAdm.valid, false);
  assert.match(tracker.lastFailureReason ?? '', /routeOutcome was "pending"/);

  tracker.recordRouteOutcome('op-1', 'uncertain_error', 'AuthorityCommitError');
  const validRec = tracker.getRecord('op-1')!;

  // Wrong identity cases must be rejected with explicit failure reasons
  const wrongCases: Array<{ label: string; evidence: DurableLostCommitAdmissionEvidence; pattern: RegExp }> = [
    {
      label: 'wrong AdjudicationStarted gameId',
      evidence: makeAdmissionEvidence({
        events: [
          {
            seq: 1,
            type: 'AdjudicationStarted',
            payload: {
              gameId: 'game-wrong',
              operationId: 'op-1',
              prepared: { gameId: 'game-1', operationId: 'op-1', intent: { kind: 'move', uci: 'e2e4' } },
            },
          },
        ],
      }),
      pattern: /AdjudicationStarted gameId.*does not match/,
    },
    {
      label: 'missing AdjudicationStarted gameId',
      evidence: makeAdmissionEvidence({
        events: [
          {
            seq: 1,
            type: 'AdjudicationStarted',
            payload: {
              operationId: 'op-1',
              prepared: { intent: { kind: 'move', uci: 'e2e4' } },
            },
          },
        ],
      }),
      pattern: /AdjudicationStarted gameId.*does not match/,
    },
    {
      label: 'wrong AdjudicationStarted operationId',
      evidence: makeAdmissionEvidence({
        events: [
          {
            seq: 1,
            type: 'AdjudicationStarted',
            payload: {
              gameId: 'game-1',
              operationId: 'op-wrong',
              prepared: { gameId: 'game-1', operationId: 'op-1', intent: { kind: 'move', uci: 'e2e4' } },
            },
          },
        ],
      }),
      pattern: /AdjudicationStarted operationId.*does not match/,
    },
    {
      label: 'wrong prepared.gameId',
      evidence: makeAdmissionEvidence({
        events: [
          {
            seq: 1,
            type: 'AdjudicationStarted',
            payload: {
              gameId: 'game-1',
              operationId: 'op-1',
              prepared: { gameId: 'game-wrong', operationId: 'op-1', intent: { kind: 'move', uci: 'e2e4' } },
            },
          },
        ],
      }),
      pattern: /prepared gameId.*does not match/,
    },
    {
      label: 'wrong prepared.operationId',
      evidence: makeAdmissionEvidence({
        events: [
          {
            seq: 1,
            type: 'AdjudicationStarted',
            payload: {
              gameId: 'game-1',
              operationId: 'op-1',
              prepared: { gameId: 'game-1', operationId: 'op-wrong', intent: { kind: 'move', uci: 'e2e4' } },
            },
          },
        ],
      }),
      pattern: /prepared operationId.*does not match/,
    },
    {
      label: 'wrong move UCI in prepared intent',
      evidence: makeAdmissionEvidence({
        events: [
          {
            seq: 1,
            type: 'AdjudicationStarted',
            payload: {
              gameId: 'game-1',
              operationId: 'op-1',
              prepared: { gameId: 'game-1', operationId: 'op-1', intent: { kind: 'move', uci: 'd2d4' } },
            },
          },
        ],
      }),
      pattern: /prepared intent.*does not match admitted move UCI/,
    },
    {
      label: 'non-AdjudicationStarted event at startedSeq',
      evidence: makeAdmissionEvidence({
        events: [{ seq: 1, type: 'MovePlayed', payload: { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' } }],
      }),
      pattern: /missing durable AdjudicationStarted event at startedSeq=1/,
    },
    {
      label: 'invalid executionState',
      evidence: makeAdmissionEvidence({ executionState: 'aborted' }),
      pattern: /durable execution_state was "aborted"/,
    },
  ];

  for (const tc of wrongCases) {
    const res = tracker.verifyAdmissionStartedDetailed('op-1', tc.evidence);
    assert.equal(res.valid, false, `${tc.label} must fail`);
    assert.match(tracker.lastFailureReason ?? '', tc.pattern, `${tc.label} must expose failure reason`);
    assert.equal(verifyLostCommitAdmissionStarted(validRec, tc.evidence).valid, false);
    assert.equal(validRec.admissionVerified, false);
    assert.equal(tracker.verifiedCommittedCount, 0);
  }

  // Valid Stage 1 admission verification succeeds while still 'proving' (queued),
  // WITHOUT marking durableVerified or counting as covered before final MovePlayed proof.
  const admOk = tracker.verifyAdmissionStartedDetailed('op-1', makeAdmissionEvidence());
  assert.equal(admOk.valid, true);
  if (admOk.valid) {
    assert.equal(admOk.startedSeq, 1);
    assert.equal(admOk.executionState, 'proving');
  }
  assert.equal(validRec.admissionVerified, true);
  assert.equal(validRec.durableVerified, false);
  assert.equal(tracker.verifiedCommittedCount, 0, 'admission verification alone must not count as covered');
  assert.equal(tracker.lastFailureReason, undefined);

  // Final drain check MUST fail while operation is still proving (no final MovePlayed proof yet)
  const prematureFinal = tracker.verifyDurableEvidenceDetailed('op-1', {
    ...makeAdmissionEvidence(),
    finalSeq: null,
  });
  assert.equal(prematureFinal.valid, false);
  assert.match(tracker.lastFailureReason ?? '', /execution_state was "proving", expected "completed"/);
  assert.equal(validRec.durableVerified, false);
  assert.equal(tracker.verifiedCommittedCount, 0);

  // Final drain check succeeds once matching AdjudicationResolved + MovePlayed settle the exact command
  const finalOk = tracker.verifyDurableEvidenceDetailed('op-1', {
    gameId: 'game-1',
    operationId: 'op-1',
    executionState: 'completed',
    startedSeq: 1,
    finalSeq: 3,
    events: [
      ...makeAdmissionEvidence().events,
      {
        seq: 2,
        type: 'AdjudicationResolved',
        payload: {
          gameId: 'game-1',
          operationId: 'op-1',
          startedSeq: 1,
          effects: [{ type: 'MovePlayed', ply: 1, uci: 'e2e4', san: 'e4', by: 'w' }],
        },
      },
      { seq: 3, type: 'MovePlayed', payload: { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' } },
    ],
  });
  assert.equal(finalOk.valid, true);
  assert.equal(validRec.durableVerified, true);
  assert.equal(tracker.verifiedCommittedCount, 1);
  assert.equal(tracker.lastFailureReason, undefined);
});

test('SoakMetricsTracker.getOperationQueuedMs reports elapsed queued time when available and omits when unavailable', () => {
  const tracker = new SoakMetricsTracker(5);
  assert.equal(tracker.getOperationQueuedMs('op-missing'), undefined);

  tracker.recordStartRequest({
    gameId: 'game-q',
    operationId: 'op-q1',
    basePly: 0,
    atMs: 1000,
    uci: 'e2e4',
  });
  // Before any claim, queued elapsed is unavailable
  assert.equal(tracker.getOperationQueuedMs('op-q1'), undefined);

  // Claim arrives after admission request (without recordStartAdmitted, simulating lost COMMIT)
  tracker.recordClaim({
    gameId: 'game-q',
    operationId: 'op-q1',
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(Date.now() + 5000),
  });
  const activeQueuedMs = tracker.getOperationQueuedMs('op-q1');
  assert.equal(typeof activeQueuedMs, 'number');
  assert.ok(activeQueuedMs! >= 0);

  tracker.recordSettleAttempt('op-q1', 4);
  tracker.recordSettlementCommitted('op-q1');
  const settledQueuedMs = tracker.getOperationQueuedMs('op-q1');
  assert.equal(settledQueuedMs, activeQueuedMs);
});

test('assertRecoveryStateMatchesReplayPrefix verifies exact prefix with proving/stopped/absent phase and rejects mutated snapshots', () => {
  const makeReplayed = (overrides?: Partial<ReplayedGameLike>, moves = [{ ply: 1, uci: 'e2e4', san: 'e4', by: 'w' }]): ReplayedGameLike => ({
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    adjudication: null,
    isBlocked: false,
    stoppedClock: null,
    ply: 1,
    turn: 'b',
    status: { over: false },
    drawOffer: null,
    snapshot: () => ({
      clock: { remaining: { w: 299_500, b: 300_000 }, turnStartedAt: 12_345 },
      moves,
    }),
    ...overrides,
  });

  const baseRecovery: StateViewSnapshotLike = {
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    stateRevision: 1,
    ply: 1,
    turn: 'b',
    clock: { w: 299_500, b: 300_000 },
    turnStartedAt: 12_345,
    status: { over: false },
    drawOffer: null,
    moves: [{ ply: 1, uci: 'e2e4', san: 'e4', by: 'w' }],
  };

  // Valid absent, proving, and stopped phases against exact prefix (not a racing later head at rev=2)
  assertRecoveryStateMatchesReplayPrefix(baseRecovery, makeReplayed(), 2);
  assertRecoveryStateMatchesReplayPrefix(
    { ...baseRecovery, adjudication: 'proving' },
    makeReplayed({ isBlocked: true, adjudication: { operationId: 'op-1' } }),
    2,
  );
  assertRecoveryStateMatchesReplayPrefix(
    { ...baseRecovery, adjudication: 'stopped' },
    makeReplayed({ isBlocked: false, stoppedClock: { stopId: 'stop-1' } }),
    2,
  );

  // Mutated recovery snapshots must fail with clear reasons
  assert.throws(
    () => assertRecoveryStateMatchesReplayPrefix({ ...baseRecovery, adjudication: 'proving' }, makeReplayed(), 2),
    /recovery adjudication phase matches replay prefix/,
  );
  assert.throws(
    () => assertRecoveryStateMatchesReplayPrefix(baseRecovery, makeReplayed({ stoppedClock: { stopId: 'stop-1' } }), 2),
    /recovery adjudication phase matches replay prefix/,
  );
  assert.throws(
    () => assertRecoveryStateMatchesReplayPrefix({ ...baseRecovery, stateRevision: 2 }, makeReplayed(), 2),
    /recovery stateRevision equals logged head seq/,
  );
  assert.throws(
    () => assertRecoveryStateMatchesReplayPrefix({ ...baseRecovery, fen: 'bad-fen' }, makeReplayed(), 2),
    /recovery copy equals replay fen/,
  );
  assert.throws(
    () => assertRecoveryStateMatchesReplayPrefix({ ...baseRecovery, drawOffer: 'w' }, makeReplayed(), 2),
    /recovery drawOffer equals replay drawOffer/,
  );
  assert.throws(
    () =>
      assertRecoveryStateMatchesReplayPrefix(
        { ...baseRecovery, moves: [{ ply: 1, uci: 'd2d4', san: 'd4', by: 'w' }] },
        makeReplayed(),
        2,
      ),
    /recovery moves match replay snapshot/,
  );
});

test('ReplicaRouteGate and createReplicaPublicationGuard drain in-flight work, bypass draining workers, and block post-cutover writes', async () => {
  const deferred = <T = void>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  const eventsAppended: string[] = [];
  const broadcastsSent: string[] = [];
  const publishesSent: string[] = [];

  interface MockReplica {
    readonly executorId: string;
    readonly getStats: () => { readonly disposed: boolean };
    readonly apply: (tag: string) => Promise<string>;
    readonly append: (ev: string) => Promise<void>;
    readonly broadcast: (msg: string) => void;
    readonly publish: (chg: { readonly gameId: string }) => Promise<void>;
  }

  const active: Array<MockReplica | undefined> = [];
  const makeMockReplica = (executorId: string): { replica: MockReplica; guard: ReturnType<typeof createReplicaPublicationGuard> } => {
    let ref: MockReplica | undefined;
    const guard = createReplicaPublicationGuard(0, (i) => active[i], () => ref);
    const append = guard.wrapAsyncCall('eventStore.append', async (ev: string) => {
      eventsAppended.push(`${executorId}:${ev}`);
    });
    const broadcast = guard.wrapSyncBroadcast((msg: string) => {
      broadcastsSent.push(`${executorId}:${msg}`);
    });
    const publish = guard.wrapPublish(async (chg: { readonly gameId: string }) => {
      publishesSent.push(`${executorId}:${chg.gameId}`);
    });
    const apply = guard.wrapAsyncCall('authority.apply', async (tag: string) => {
      await append(tag);
      broadcast(tag);
      return `${executorId}:${tag}`;
    });
    ref = {
      executorId,
      getStats: () => ({ disposed: guard.isDisposed }),
      apply,
      append,
      broadcast,
      publish,
    };
    return { replica: ref, guard };
  };

  const oldPair = makeMockReplica('old-exec');
  const newPair = makeMockReplica('new-exec');
  active[0] = oldPair.replica;
  const gate = new ReplicaRouteGate(0);

  // 1) Pre-cutover in-flight command starts on oldReplica before pause
  const cmdAGate = deferred<void>();
  const cmdAPromise = gate.route(
    false,
    () => active[0]!,
    async (r) => {
      await cmdAGate.promise;
      return r.apply('cmdA');
    },
  );
  assert.equal(gate.inFlightCount, 1);

  // 2) Begin pauseAndDrain: must wait for cmdA, while blocking new normal cmdB behind pause
  let pauseResolved = false;
  const pausePromise = gate.pauseAndDrain().then(() => {
    pauseResolved = true;
  });
  await Promise.resolve();
  assert.equal(pauseResolved, false);
  assert.equal(gate.phase, 'draining');

  let cmdBDispatchedTo: string | undefined;
  const cmdBPromise = gate.route(
    false,
    () => active[0]!,
    async (r) => {
      cmdBDispatchedTo = r.executorId;
      return r.apply('cmdB');
    },
  );
  await Promise.resolve();
  assert.equal(gate.pausedWaitersCount, 1);
  assert.equal(cmdBDispatchedTo, undefined, 'paused new work must not dispatch to old replica');

  // Release cmdA -> completes on oldReplica and unblocks pauseAndDrain
  cmdAGate.resolve();
  assert.equal(await cmdAPromise, 'old-exec:cmdA');
  await pausePromise;
  assert.equal(pauseResolved, true);
  assert.equal(gate.inFlightCount, 0);

  // 3) Draining worker bypass path runs during 'draining' WITHOUT deadlocking behind pause
  const workerBypassGate = deferred<void>();
  const workerBypassPromise = gate.route(
    true,
    () => active[0]!,
    async (r) => {
      await workerBypassGate.promise;
      return r.apply('workerDrain');
    },
  );
  assert.equal(gate.inFlightCount, 1);

  let fenceResolved = false;
  const fencePromise = gate.drainAndFence().then(() => {
    fenceResolved = true;
  });
  await Promise.resolve();
  assert.equal(fenceResolved, false, 'drainAndFence must wait for in-flight draining worker call');

  workerBypassGate.resolve();
  assert.equal(await workerBypassPromise, 'old-exec:workerDrain');
  await fencePromise;
  assert.equal(fenceResolved, true);
  assert.equal(gate.phase, 'fenced');

  // Stray bypass during 'fenced' rejects immediately without deadlocking
  await assert.rejects(
    () => gate.route(true, () => active[0]!, (r) => r.apply('strayBypass')),
    /cutover fenced/,
  );

  // 4) Dispose old replica, swap fresh replica, and resume routing
  oldPair.guard.markDisposed();
  active[0] = newPair.replica;
  gate.resume();
  assert.equal(gate.phase, 'active');

  // Paused cmdB now wakes up and executes on new replica
  assert.equal(await cmdBPromise, 'new-exec:cmdB');
  assert.equal(cmdBDispatchedTo, 'new-exec');

  // 5) Old commands cannot apply, append, broadcast, or publish after cutover
  const appendsBeforeStale = eventsAppended.length;
  const broadcastsBeforeStale = broadcastsSent.length;
  const publishesBeforeStale = publishesSent.length;

  await assert.rejects(() => oldPair.replica.apply('staleApply'), /Stale replica old-exec/);
  await assert.rejects(() => oldPair.replica.append('staleAppend'), /Stale replica old-exec/);
  assert.throws(() => oldPair.replica.broadcast('staleBroadcast'), /Stale replica old-exec/);
  await assert.rejects(() => oldPair.replica.publish({ gameId: 'g-1' }), /Stale replica old-exec/);

  assert.equal(eventsAppended.length, appendsBeforeStale);
  assert.equal(broadcastsSent.length, broadcastsBeforeStale);
  assert.equal(publishesSent.length, publishesBeforeStale);
  assert.equal(oldPair.guard.staleAuthorityBlockedCount, 1);
  assert.equal(oldPair.guard.staleAppendBlockedCount, 1);
  assert.equal(oldPair.guard.staleBroadcastBlockedCount, 1);
  assert.equal(oldPair.guard.staleBlockedCount, 4);
});

test('ReplicaRouteGate.abort unblocks paused callers on failing cutover, drains in-flight work, blocks stale dispatch, and preserves primary error', async () => {
  const deferred = <T = void>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  const replica = {
    executorId: 'old-exec',
    getStats: () => ({ disposed: false }),
  };
  const gate = new ReplicaRouteGate(0);

  let pausedDispatchCount = 0;
  let futureDispatchCount = 0;
  let inFlightDispatchCount = 0;
  let inFlightCompleted = false;

  const cutoverStepGate = deferred<void>();
  const inFlightGate = deferred<void>();
  const primaryErr = new Error('cutover failed before resume');

  // Begin cutover pause so new player routes wait behind the gate
  await gate.pauseAndDrain();
  assert.equal(gate.phase, 'draining');

  // Start a genuine outstanding draining-worker bypass call
  const genuineInFlightPromise = gate.route(
    true,
    () => replica,
    async () => {
      inFlightDispatchCount++;
      await inFlightGate.promise;
      inFlightCompleted = true;
      return 'drained-ok';
    },
  );
  assert.equal(inFlightDispatchCount, 1);
  assert.equal(gate.inFlightCount, 1);

  // Queue a paused caller behind the gate before cutover fails
  let playerCaughtAbort: unknown;
  let playerTerminated = false;
  const pausedPlayerTask = (async () => {
    try {
      await gate.route(
        false,
        () => replica,
        async () => {
          pausedDispatchCount++;
          return 'should-never-dispatch';
        },
      );
    } catch (err) {
      playerCaughtAbort = err;
    } finally {
      playerTerminated = true;
    }
  })();

  const failingCutoverTask = (async () => {
    await cutoverStepGate.promise;
    throw primaryErr;
  })();

  await Promise.resolve();
  assert.equal(gate.pausedWaitersCount, 1);
  assert.equal(pausedDispatchCount, 0);
  assert.equal(playerTerminated, false);

  // Trigger cutover failure before resume() is ever reached
  cutoverStepGate.resolve();

  const taskPromises = [pausedPlayerTask, failingCutoverTask];
  let abortResolved = false;
  let drainedResult: PromiseSettledResult<unknown>[] = [];

  await assert.rejects(
    async () => {
      try {
        await Promise.all(taskPromises);
      } catch (runErr) {
        const abortPromise = gate
          .abort(runErr instanceof Error ? runErr.message : String(runErr))
          .then(() => {
            abortResolved = true;
          });

        // Paused caller immediately wakes & terminates without dispatching stale work
        await pausedPlayerTask;
        assert.equal(playerTerminated, true);
        assert.match(String(playerCaughtAbort), /Slot 0 route gate aborted: cutover failed before resume/);
        assert.equal(pausedDispatchCount, 0);
        assert.equal(gate.phase, 'aborted');
        assert.equal(gate.pausedWaitersCount, 0);

        // Terminal abort cannot be undone by resume() and blocks future routes & cutover phases
        gate.resume();
        assert.equal(gate.phase, 'aborted');

        await assert.rejects(
          () =>
            gate.route(false, () => replica, async () => {
              futureDispatchCount++;
              return 'stale-normal';
            }),
          /Slot 0 route gate aborted/,
        );
        await assert.rejects(
          () =>
            gate.route(true, () => replica, async () => {
              futureDispatchCount++;
              return 'stale-bypass';
            }),
          /Slot 0 route gate aborted/,
        );
        assert.equal(futureDispatchCount, 0);
        await assert.rejects(() => gate.pauseAndDrain(), /Slot 0 route gate aborted/);
        await assert.rejects(() => gate.drainAndFence(), /Slot 0 route gate aborted/);
        assert.equal(gate.phase, 'aborted');

        // abort() must still wait for genuine outstanding in-flight dispatch to finish draining
        await Promise.resolve();
        assert.equal(abortResolved, false);
        assert.equal(inFlightCompleted, false);

        inFlightGate.resolve();
        assert.equal(await genuineInFlightPromise, 'drained-ok');
        await abortPromise;
        assert.equal(abortResolved, true);
        assert.equal(inFlightCompleted, true);
        assert.equal(gate.inFlightCount, 0);

        drainedResult = await Promise.allSettled(taskPromises);
        throw runErr;
      }
    },
    (err: unknown) => err === primaryErr,
  );

  assert.equal(drainedResult.length, 2);
  assert.equal(drainedResult[0]?.status, 'fulfilled');
  assert.equal(drainedResult[1]?.status, 'rejected');
  assert.equal(pausedDispatchCount, 0);
  assert.equal(futureDispatchCount, 0);
});

test('selectSeededMoveUci keeps non-pawn back-rank rook moves unpromoted when pawns exist, promotes pawns to queen, and skips lazy position read for ordinary moves', () => {
  const collapseLegalEntries = (pos: Position): readonly string[] => {
    const seen = new Set<string>();
    for (const move of pos.legalMoves()) {
      seen.add(pos.toUci(move).slice(0, 4));
    }
    return [...seen];
  };

  // White: back-rank rook move a7a8, legal pawn promotion c7c8, ordinary moves (e.g. e2e4), plus unrelated pawn on e2
  const whitePos = Position.fromFen('8/R1P5/7k/8/8/8/4P3/4K3 w - - 0 1');
  const whiteLegal = collapseLegalEntries(whitePos);
  const whiteRookIdx = whiteLegal.indexOf('a7a8');
  const whitePromoIdx = whiteLegal.indexOf('c7c8');
  const whiteOrdinaryIdx = whiteLegal.indexOf('e2e4');
  assert.ok(whiteRookIdx >= 0, 'a7a8 must be present in legal entries');
  assert.ok(whitePromoIdx >= 0, 'c7c8 must be present in legal entries');
  assert.ok(whiteOrdinaryIdx >= 0, 'e2e4 must be present in legal entries');

  let lazyReads = 0;
  const readWhitePos = (): Position => {
    lazyReads++;
    return whitePos;
  };

  // Ordinary move must skip the lazy position read completely
  const ordinaryUci = selectSeededMoveUci(readWhitePos, whiteLegal, () => (whiteOrdinaryIdx + 0.5) / whiteLegal.length);
  assert.equal(ordinaryUci, 'e2e4');
  assert.equal(lazyReads, 0, 'ordinary move selection must not trigger lazy position read');
  assert.doesNotThrow(() => whitePos.play(ordinaryUci));

  // Promotion-shaped back-rank rook move reads lazily and stays unpromoted
  const whiteRookUci = selectSeededMoveUci(readWhitePos, whiteLegal, () => (whiteRookIdx + 0.5) / whiteLegal.length);
  assert.equal(whiteRookUci, 'a7a8');
  assert.equal(lazyReads, 1);
  assert.doesNotThrow(() => whitePos.play(whiteRookUci));
  assert.throws(() => whitePos.play('a7a8q'), IllegalMoveError);

  // Promotion-shaped pawn move reads lazily and promotes to queen
  const whitePromoUci = selectSeededMoveUci(readWhitePos, whiteLegal, () => (whitePromoIdx + 0.5) / whiteLegal.length);
  assert.equal(whitePromoUci, 'c7c8q');
  assert.equal(lazyReads, 2);
  assert.doesNotThrow(() => whitePos.play(whitePromoUci));

  for (let i = 0; i < whiteLegal.length; i++) {
    const uci = selectSeededMoveUci(() => whitePos, whiteLegal, () => (i + 0.5) / whiteLegal.length);
    assert.doesNotThrow(() => whitePos.play(uci), `expected legal UCI for white index ${i}: ${uci}`);
  }

  // White back-rank rook move a7a8 with only an unrelated black pawn on e2 (no promoting pawn)
  const unrelatedPawnPos = Position.fromFen('8/R7/7k/8/8/8/4p3/4K3 w - - 0 1');
  const unrelatedLegal = collapseLegalEntries(unrelatedPawnPos);
  const unrelatedRookIdx = unrelatedLegal.indexOf('a7a8');
  assert.ok(unrelatedRookIdx >= 0);
  const unrelatedRookUci = selectSeededMoveUci(
    () => unrelatedPawnPos,
    unrelatedLegal,
    () => (unrelatedRookIdx + 0.5) / unrelatedLegal.length,
  );
  assert.equal(unrelatedRookUci, 'a7a8');
  assert.doesNotThrow(() => unrelatedPawnPos.play(unrelatedRookUci));

  // Black: back-rank rook move a2a1, legal pawn promotion c2c1, plus unrelated pawn on e7
  const blackPos = Position.fromFen('4k3/4p3/8/8/8/7K/r1p5/8 b - - 0 1');
  const blackLegal = collapseLegalEntries(blackPos);
  const blackRookIdx = blackLegal.indexOf('a2a1');
  const blackPromoIdx = blackLegal.indexOf('c2c1');
  assert.ok(blackRookIdx >= 0, 'a2a1 must be present in legal entries');
  assert.ok(blackPromoIdx >= 0, 'c2c1 must be present in legal entries');

  const blackRookUci = selectSeededMoveUci(() => blackPos, blackLegal, () => (blackRookIdx + 0.5) / blackLegal.length);
  assert.equal(blackRookUci, 'a2a1');
  assert.doesNotThrow(() => blackPos.play(blackRookUci));
  assert.throws(() => blackPos.play('a2a1q'), IllegalMoveError);

  const blackPromoUci = selectSeededMoveUci(() => blackPos, blackLegal, () => (blackPromoIdx + 0.5) / blackLegal.length);
  assert.equal(blackPromoUci, 'c2c1q');
  assert.doesNotThrow(() => blackPos.play(blackPromoUci));
});

test('SoakMetricsTracker ranks topProvingWall strictly by proving interval so slow DB settlement and release cannot outrank a longer proof', (t) => {
  let currentNow = 1000;
  t.mock.method(performance, 'now', () => currentNow);

  const cap1Tracker = new SoakMetricsTracker(1);
  const cap2Tracker = new SoakMetricsTracker(2);
  const trackers = [cap1Tracker, cap2Tracker];
  const opShort = 'op-short-proof-slow-db';
  const opLong = 'op-longer-proof-fast-db';

  // 1. Short proof (20ms proving wall) followed by slow retried DB settlement (700ms) and slow release (800ms)
  for (const tracker of trackers) {
    tracker.recordStartRequest({ gameId: 'g-1', operationId: opShort, basePly: 0, atMs: 1000 });
  }
  currentNow = 1010;
  for (const tracker of trackers) {
    tracker.recordStartAttempt(10, 0);
    tracker.recordStartAdmitted('g-1', opShort, 0, 10);
  }
  currentNow = 1015;
  for (const tracker of trackers) {
    tracker.recordClaim({
      gameId: 'g-1',
      operationId: opShort,
      executorId: 'worker-0',
      generation: '1',
      leaseUntil: new Date(10_000),
    });
  }
  currentNow = 1020;
  for (const tracker of trackers) {
    tracker.recordStep(opShort, 5, 2, 100);
    tracker.recordProofCompleted(opShort, currentNow);
    // Actual monotonic boundary captured before awaiting store.settleAdjudication
    tracker.recordSettleAttemptStart(opShort, currentNow);
  }
  // Attempt 1 stalls 400ms in DB and fails
  currentNow = 1420;
  for (const tracker of trackers) {
    tracker.recordSettleAttempt(opShort, 400);
  }
  // Retry attempt 2 starts at 1450 and commits after 300ms (must not overwrite firstSettleAttemptAtMs=1020)
  currentNow = 1450;
  for (const tracker of trackers) {
    tracker.recordSettleAttemptStart(opShort, currentNow);
  }
  currentNow = 1750;
  for (const tracker of trackers) {
    tracker.recordSettleAttempt(opShort, 300);
    tracker.recordSettlementCommitted(opShort);
  }

  // 2. Longer proof (150ms proving wall) followed by fast DB settlement (5ms) and fast release (5ms)
  currentNow = 3000;
  for (const tracker of trackers) {
    tracker.recordStartRequest({ gameId: 'g-2', operationId: opLong, basePly: 2, atMs: 3000 });
  }
  currentNow = 3010;
  for (const tracker of trackers) {
    tracker.recordStartAttempt(10, 2);
    tracker.recordStartAdmitted('g-2', opLong, 2, 10);
    tracker.recordClaim({
      gameId: 'g-2',
      operationId: opLong,
      executorId: 'worker-1',
      generation: '1',
      leaseUntil: new Date(15_000),
    });
  }
  currentNow = 3150;
  for (const tracker of trackers) {
    tracker.recordStep(opLong, 130, 90, 2000);
    tracker.recordProofCompleted(opLong, currentNow);
    tracker.recordSettleAttemptStart(opLong, currentNow);
  }
  currentNow = 3155;
  for (const tracker of trackers) {
    tracker.recordSettleAttempt(opLong, 5);
    tracker.recordSettlementCommitted(opLong);
  }
  currentNow = 3160;
  for (const tracker of trackers) {
    tracker.recordReleaseAttempt(5);
    tracker.recordReleaseCommitted(opLong, 5);
  }

  // 3. Delayed slow release (800ms) for opShort arrives AFTER opLong already settled and claimed #1
  currentNow = 3960;
  for (const tracker of trackers) {
    tracker.recordReleaseAttempt(800);
    tracker.recordReleaseCommitted(opShort, 800);
  }

  // Capacity 1: longer proof wins topProvingWall; slow DB + release opShort wins topLifecycleWall
  const cap1Proving = cap1Tracker.getTopProvingWall();
  assert.equal(cap1Proving.length, 1);
  assert.equal(cap1Proving[0]?.operationId, opLong, 'slow settle DB and release must not outrank longer proof');
  assert.equal(cap1Proving[0]?.provingWallMs, 150);
  assert.equal(cap1Proving[0]?.lifecycleWallMs, 160);

  const cap1Lifecycle = cap1Tracker.getTopLifecycleWall();
  assert.equal(cap1Lifecycle.length, 1);
  assert.equal(cap1Lifecycle[0]?.operationId, opShort, 'lifecycle top-K reflects opposite ranking from slow settle/release');
  assert.equal(cap1Lifecycle[0]?.provingWallMs, 20);
  assert.equal(cap1Lifecycle[0]?.lifecycleWallMs, 2960);
  assert.equal(cap1Lifecycle[0]?.wallDurationMs, 2960);

  // Capacity 2: opposite ordering and exact interval/attribution preservation
  const cap2Proving = cap2Tracker.getTopProvingWall();
  assert.deepEqual(cap2Proving.map((s) => s.operationId), [opLong, opShort]);
  const shortSample = cap2Proving[1]!;
  assert.equal(shortSample.provingWallMs, 20);
  assert.equal(shortSample.evidence.admissionStartMs, 1000);
  assert.equal(shortSample.evidence.proofCompletedAtMs, 1020);
  assert.equal(shortSample.evidence.firstSettleAttemptAtMs, 1020);
  assert.equal(shortSample.evidence.provingEndAtMs, 1020);
  assert.equal(shortSample.evidence.provingWallMs, 20);
  assert.equal(shortSample.evidence.settleAttempts, 2);
  assert.equal(shortSample.evidence.settleDbWallMs, 700);
  assert.equal(shortSample.evidence.releaseDurationMs, 800);
  assert.equal(shortSample.evidence.lifecycleWallMs, 2960);
  assert.equal(shortSample.evidence.totalWallMs, 2960);

  const cap2Lifecycle = cap2Tracker.getTopLifecycleWall();
  assert.deepEqual(cap2Lifecycle.map((s) => s.operationId), [opShort, opLong]);
});

test('SoakMetricsTracker protects late admission binding and active proving interval boundaries', (t) => {
  let currentNow = 5000;
  t.mock.method(performance, 'now', () => currentNow);

  const tracker = new SoakMetricsTracker(5);

  // Case A: Early provisional claim (hasBoundStart=false), slow settle + slow release, then late admission
  const opLate = 'op-late-bound-after-release';
  tracker.recordClaim({
    gameId: 'g-late',
    operationId: opLate,
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(20_000),
  });
  currentNow = 5025;
  tracker.recordStep(opLate, 20, 15, 250);
  tracker.recordProofCompleted(opLate, currentNow);
  tracker.recordSettleAttemptStart(opLate, currentNow);
  currentNow = 5525;
  tracker.recordSettleAttempt(opLate, 500);
  tracker.recordSettlementCommitted(opLate);
  currentNow = 6325;
  tracker.recordReleaseAttempt(800);
  tracker.recordReleaseCommitted(opLate, 800);

  // Before late admission: provisional start was claim time 5000, provingWallMs = 5025 - 5000 = 25ms
  let lateSample = tracker.getTopProvingWall().find((s) => s.operationId === opLate)!;
  assert.equal(lateSample.evidence.hasBoundStart, false);
  assert.equal(lateSample.provingWallMs, 25);
  assert.equal(lateSample.lifecycleWallMs, 1325);

  // Delayed admission arrives at t=6325 with duration 1365ms (started at 6325 - 1365 = 4960, 40ms before claim)
  tracker.recordStartAdmitted('g-late', opLate, 0, 1365);
  lateSample = tracker.getTopProvingWall().find((s) => s.operationId === opLate)!;
  assert.equal(lateSample.evidence.hasBoundStart, true);
  assert.equal(lateSample.evidence.admissionStartMs, 4960);
  // provingWallMs must end at provingEndAtMs (5025), NOT releaseCommittedAtMs (6325): 5025 - 4960 = 65ms
  assert.equal(lateSample.provingWallMs, 65);
  assert.equal(lateSample.lifecycleWallMs, 1365);

  // Subsequent duplicate admission must NOT overwrite already-bound admissionStartMs
  currentNow = 9000;
  tracker.recordStartAdmitted('g-late', opLate, 0, 8000);
  assert.equal(lateSample.evidence.admissionStartMs, 4960);
  assert.equal(lateSample.provingWallMs, 65);

  // Case B: Already-bound start via recordStartRequest is protected against duplicate late admission
  const opBound = 'op-already-bound';
  currentNow = 10_000;
  tracker.recordStartRequest({ gameId: 'g-bound', operationId: opBound, basePly: 4, atMs: 10_000 });
  currentNow = 10_040;
  tracker.recordClaim({
    gameId: 'g-bound',
    operationId: opBound,
    executorId: 'worker-0',
    generation: '1',
    leaseUntil: new Date(30_000),
  });
  currentNow = 10_100;
  tracker.recordStep(opBound, 60, 45, 500);
  tracker.recordProofCompleted(opBound, currentNow);
  tracker.recordSettleAttemptStart(opBound, currentNow);
  currentNow = 10_400;
  tracker.recordSettleAttempt(opBound, 300);
  tracker.recordSettlementCommitted(opBound);
  // Late/duplicate admission arrives after settle with large duration; bound start 10000 must remain intact
  currentNow = 15_000;
  tracker.recordStartAdmitted('g-bound', opBound, 4, 5000);

  const boundSample = tracker.getTopProvingWall().find((s) => s.operationId === opBound)!;
  assert.equal(boundSample.evidence.admissionStartMs, 10_000);
  assert.equal(boundSample.provingWallMs, 100);
  assert.equal(boundSample.lifecycleWallMs, 400);

  // Case C: Provisional active op receives recordStartAdmitted while active, plus late retry protection
  const opActiveLate = 'op-active-late-bind';
  currentNow = 20_000;
  tracker.recordClaim({
    gameId: 'g-active',
    operationId: opActiveLate,
    executorId: 'worker-1',
    generation: '1',
    leaseUntil: new Date(40_000),
  });
  // Admission returns at 20030 with duration 60ms -> binds start at 19970
  currentNow = 20_030;
  tracker.recordStartAdmitted('g-active', opActiveLate, 6, 60);
  // Duplicate admission at 20080 with duration 500ms must NOT overwrite bound 19970
  currentNow = 20_080;
  tracker.recordStartAdmitted('g-active', opActiveLate, 6, 500);
  tracker.recordStep(opActiveLate, 50, 40, 300);
  tracker.recordProofCompleted(opActiveLate, currentNow);
  // Omit explicit recordSettleAttemptStart; settle at 20280 with 200ms DB duration recovers start=20080
  currentNow = 20_280;
  tracker.recordSettleAttempt(opActiveLate, 200);
  tracker.recordSettlementCommitted(opActiveLate);

  const activeLateSample = tracker.getTopProvingWall().find((s) => s.operationId === opActiveLate)!;
  assert.equal(activeLateSample.evidence.admissionStartMs, 19_970);
  assert.equal(activeLateSample.evidence.firstSettleAttemptAtMs, 20_080);
  assert.equal(activeLateSample.provingWallMs, 110);
  assert.equal(activeLateSample.lifecycleWallMs, 310);
});
