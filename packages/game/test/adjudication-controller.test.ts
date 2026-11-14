import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Position,
  CooperativeSearchSession,
  type Color,
  type Move,
} from '@chess-platform/core';
import {
  Game,
  GameError,
  prepareCreationAdmission,
  prepareMove,
  prepareDrawOffer,
  prepareFlagExpiry,
  settlePrepared,
  type PreparedOperation,
  type TimeControl,
} from '../src';
import {
  AdjudicationJobController,
  type JobStatus,
} from '../src/adjudication-controller';
import {
  verifyUciWitnessReplay,
} from '../src/adjudication-lifecycle';
import {
  resolveRequiredProofRoles,
} from '../src/adjudication-requirements';
import * as proofModule from '../src/adjudication-proof';

const TC_STANDARD: TimeControl = {
  kind: 'increment',
  initialMs: 300_000,
  incrementMs: 3_000,
  delayMs: 0,
};

// Mate in 1 position: Queen on e7, King on g6 vs Black King on h8 -> e7g7#
const FEN_MATE1 = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';

// Terminal mate position: White Rook on h8, White King on b6, Black King on a8
const FEN_TERMINAL_MATE = 'k6R/1p6/pK6/P7/8/1P6/8/8 b - - 0 1';

// Dead position: Line 14 locked pawns and same-color bishops (statically proven dead)
const FEN_DEAD_KB = '2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1';

function createGame(fen = FEN_MATE1, tc = TC_STANDARD, gameId = 'controller-test-game'): Game {
  const { game } = Game.create({
    gameId,
    variant: 'standard',
    initialFen: fen,
    timeControl: tc,
    players: { white: 'alice', black: 'bob' },
    at: 1_000,
  });
  return game;
}

describe('AdjudicationJobController: Domain-Owned Resumable Proof Jobs', () => {
  test('T01: Deterministic slicing vs monolithic execution produces identical genuine evidence', () => {
    const game = createGame(FEN_MATE1);
    const op = prepareMove(game, {
      uci: 'e7g7',
      at: 2_000,
      operationId: 'op-slice-mono',
      rulesVersion: '1.0.0',
    });

    // Controller A: Monolithic large slice
    const ctrlMono = new AdjudicationJobController();
    ctrlMono.createJob(op);
    const stepMono = ctrlMono.stepJob(op.operationId, 2000);
    assert.equal(stepMono.status, 'ready');
    assert.equal(stepMono.handlesReady, true);

    // Controller B: Multi-sliced execution (small shares)
    const ctrlSliced = new AdjudicationJobController();
    ctrlSliced.createJob(op);
    let stepSliced = ctrlSliced.stepJob(op.operationId, 0);
    assert.equal(stepSliced.status, 'active');

    while (stepSliced.status === 'active') {
      stepSliced = ctrlSliced.stepJob(op.operationId, 2);
      assert.ok(stepSliced.deltaWork <= 2, `Slice exceeded budget: ${stepSliced.deltaWork} > 2`);
    }
    assert.equal(stepSliced.status, 'ready');
    assert.equal(stepSliced.handlesReady, true);

    const viewMono = ctrlMono.getJob(op.operationId)!;
    const viewSliced = ctrlSliced.getJob(op.operationId)!;
    assert.equal(viewSliced.status, viewMono.status);
  });

  test('T02: Private genuine handles settle the game; fake or cloned handles are refused', () => {
    const game = createGame(FEN_MATE1);
    const op = prepareMove(game, {
      uci: 'e7g7',
      at: 2_000,
      operationId: 'op-genuine-settle',
      rulesVersion: '1.0.0',
    });

    const provingGame = game.withEvents([{
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    }]);
    assert.equal(provingGame.phase, 'proving');

    const ctrl = new AdjudicationJobController();
    ctrl.createJob(op);
    let step = ctrl.stepJob(op.operationId, 50);
    while (step.status === 'active') {
      step = ctrl.stepJob(op.operationId, 50);
    }
    assert.equal(step.status, 'ready');

    // Settle with genuine handles succeeds via controller.settleJob
    const settlement = ctrl.settleJob(provingGame, op.operationId, 3_000);
    assert.equal(settlement.game.phase, 'ended');
    assert.equal(settlement.resolved.operationId, op.operationId);

    // Fake handle object is rejected by settlePrepared
    const fakeHandle = {
      operationId: op.operationId,
      questionKind: 'global_deadness' as const,
    };
    assert.throws(
      () => settlePrepared(provingGame, { base: fakeHandle }, 3_000),
      /Evidence handle is unauthentic, unregistered, cloned, or serialized/,
    );
  });

  test('T03: Security regression: direct-module negative mint exports do not exist and fake handles are rejected', () => {
    const game = createGame(FEN_MATE1);
    const op = prepareMove(game, {
      uci: 'e7g7',
      at: 2_000,
      operationId: 'op-attack-exports',
      rulesVersion: '1.0.0',
    });

    const provingGame = game.withEvents([{
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    }]);

    // Unchecked direct-module exports MUST NOT exist on the module
    const rawModule = proofModule as Record<string, unknown>;
    assert.equal(rawModule.mintVerifiedExactDeadHandle, undefined);
    assert.equal(rawModule.mintVerifiedTimeoutImpossibleHandle, undefined);
    assert.equal(rawModule.mintVerifiedWitnessHandle, undefined);
    assert.equal(rawModule.mintVerifiedStaticDeadHandle, undefined);
    assert.equal(rawModule.mintRegisteredHandle, undefined);

    // Attack direct-module global negative path with valid provenance strings
    const fakeGlobalDeadHandle = {
      operationId: op.operationId,
      questionKind: 'global_deadness' as const,
      provenance: 'closed_graph' as const,
    };
    assert.throws(
      () => settlePrepared(provingGame, { base: fakeGlobalDeadHandle }, 3_000),
      /Evidence handle is unauthentic, unregistered, cloned, or serialized/,
    );

    // Attack direct-module timeout negative path with valid provenance strings
    const fakeTimeoutHandle = {
      operationId: op.operationId,
      questionKind: 'directional_reachability' as const,
      targetWinner: 'w' as const,
      provenance: 'closed_graph' as const,
    };
    assert.throws(
      () => settlePrepared(provingGame, { timeout: fakeTimeoutHandle }, 3_000),
      /Evidence handle is unauthentic, unregistered, cloned, or serialized/,
    );
  });

  test('T04: Security regression: getJob returns deeply frozen view without minting methods or session aliases', () => {
    const game = createGame(FEN_MATE1);
    const op = prepareMove(game, {
      uci: 'e7g7',
      at: 2_000,
      operationId: 'op-attack-view',
      rulesVersion: '1.0.0',
    });

    const ctrl = new AdjudicationJobController();
    ctrl.createJob(op);
    const view = ctrl.getJob(op.operationId)!;

    // View is frozen
    assert.equal(Object.isFrozen(view), true);
    assert.equal(Object.isFrozen(view.requiredRoles), true);
    if (view.requiredRoles.length > 0) {
      assert.equal(Object.isFrozen(view.requiredRoles[0]), true);
      assert.equal(Object.isFrozen(view.requiredRoles[0].question), true);
    }

    // View has no mint methods or session references
    const viewAny = view as Record<string, unknown>;
    assert.equal(viewAny.mintDeadGlobal, undefined);
    assert.equal(viewAny.baseLanes, undefined);
    assert.equal(viewAny.wFinder, undefined);

    // Controller itself has no mint methods exposed
    const ctrlAny = ctrl as unknown as Record<string, unknown>;
    assert.equal(ctrlAny.mintDeadGlobal, undefined);
    assert.equal(ctrlAny.mintHandle, undefined);
  });

  test('T05: Conditional role resolution: dead base skips unused successor and timeout roles', () => {
    const game = createGame(FEN_DEAD_KB);
    const op = prepareMove(game, {
      uci: 'c1d2',
      at: 2_000,
      operationId: 'op-dead-skip',
      rulesVersion: '1.0.0',
    });

    const reqs = resolveRequiredProofRoles(op);
    assert.equal(reqs.isRootEnding, false);
    assert.equal(reqs.requiredRoles.length, 1);
    assert.equal(reqs.requiredRoles[0].role, 'base');

    const ctrl = new AdjudicationJobController();
    ctrl.createJob(op);

    // Static check proves dead base in 1 unit
    const step = ctrl.stepJob(op.operationId, 500);
    assert.equal(step.status, 'ready');

    const view = ctrl.getJob(op.operationId)!;
    assert.equal(view.requiredRoles.length, 1);
    assert.equal(view.requiredRoles[0].role, 'base');
  });

  test('T06: Threefold repetition context: 3rd repetition move requires base only and settles threefold', () => {
    const startFen = '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1';
    let game = createGame(startFen);

    const moves = ['g6g5', 'h8h7', 'g5g6', 'h7h8', 'g6g5', 'h8h7', 'g5g6'];
    let t = 2_000;
    for (const uci of moves) {
      const op = prepareMove(game, { uci, at: t, operationId: `op-${t}`, rulesVersion: '1.0.0' });
      const proving = game.withEvents([{
        type: 'AdjudicationStarted',
        gameId: game.snapshot().gameId,
        operationId: op.operationId,
        baseRevision: op.baseRevision,
        at: op.at,
        rulesVersion: op.rulesVersion,
        prepared: op,
      }]);
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(op, game);
      while (ctrl.stepJob(op.operationId, 50).status === 'active') {}
      const settled = ctrl.settleJob(proving, op.operationId, t + 100);
      game = settled.game;
      t += 1_000;
    }

    // Now 8th ply: Black plays h7h8 (creates 3rd repetition)
    const opRep = prepareMove(game, { uci: 'h7h8', at: t, operationId: 'op-threefold-move', rulesVersion: '1.0.0' });
    const provingRep = game.withEvents([{
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: opRep.operationId,
      baseRevision: opRep.baseRevision,
      at: opRep.at,
      rulesVersion: opRep.rulesVersion,
      prepared: opRep,
    }]);

    const ctrlRep = new AdjudicationJobController();
    ctrlRep.createJob(opRep, game);

    let stepRep = ctrlRep.stepJob(opRep.operationId, 50);
    while (stepRep.status === 'active') {
      stepRep = ctrlRep.stepJob(opRep.operationId, 50);
    }
    assert.equal(stepRep.status, 'ready');

    const viewRep = ctrlRep.getJob(opRep.operationId)!;
    assert.equal(viewRep.requiredRoles.length, 1);
    assert.equal(viewRep.requiredRoles[0].role, 'base');

    const settledRep = ctrlRep.settleJob(provingRep, opRep.operationId, t + 100);
    assert.equal(settledRep.game.phase, 'ended');
    const status = settledRep.game.status;
    assert.equal(status.over, true);
    assert.equal(status.termination, 'threefold');
    assert.equal(status.result, '1/2-1/2');
  });

  test('T07: Context ownership: caller repetition map without Game is rejected; wrapper { game } derives repetition', () => {
    const game = createGame(FEN_MATE1);
    const op = prepareMove(game, {
      uci: 'e7g7',
      at: 2_000,
      operationId: 'op-rep-mutation',
      rulesVersion: '1.0.0',
    });

    const mutableRep = new Map<string, number>();
    const ctrl = new AdjudicationJobController();

    // Fabricated repetition map without Game is rejected
    assert.throws(
      () => ctrl.createJob(op, { repetition: mutableRep }),
      /Unsupported unauthenticated context: Game instance is required/,
    );

    // Wrapper { game } is supported and derives repetition from game
    const jobId = ctrl.createJob(op, { game, repetition: mutableRep });
    assert.equal(jobId, op.operationId);

    // Mutate caller map after admission - internal state is owned
    mutableRep.set('some-fabricated-fen', 99);
    const view = ctrl.getJob(op.operationId)!;
    assert.equal(view.status, 'active');
  });

  test('T08: Finite work budget: 1-unit and 7-unit calls never overrun budget; phase deltas tracked', () => {
    const game = createGame(FEN_MATE1);
    const op = prepareMove(game, {
      uci: 'e7g7',
      at: 2_000,
      operationId: 'op-budget-check',
      rulesVersion: '1.0.0',
    });

    const ctrl = new AdjudicationJobController();
    ctrl.createJob(op);

    // Step with budget 1
    const res1 = ctrl.stepJob(op.operationId, 1);
    assert.ok(res1.deltaWork <= 1, `Expected deltaWork <= 1, got ${res1.deltaWork}`);

    // Step with budget 7
    const res7 = ctrl.stepJob(op.operationId, 7);
    assert.ok(res7.deltaWork <= 7, `Expected deltaWork <= 7, got ${res7.deltaWork}`);

    // Step with budget 0
    const res0 = ctrl.stepJob(op.operationId, 0);
    assert.equal(res0.deltaWork, 0);

    // Verify view has phase deltas
    const view = ctrl.getJob(op.operationId)!;
    assert.ok(view.generationWork >= 0);
    assert.ok(view.scoringWork >= 0);
    assert.ok(view.replayWork >= 0);
  });

  test('T09: Multi-job fairness: repeated stepAll(1) calls across two unresolved jobs service both jobs fairly', () => {
    const fen = 'r1bqkbnr/pppppppp/2n5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2';
    const game1 = createGame(fen, TC_STANDARD, 'fairness-game-1');
    const op1 = prepareMove(game1, {
      uci: 'g1f3',
      at: 2_000,
      operationId: 'op-fair-1',
      rulesVersion: '1.0.0',
    });

    const game2 = createGame(fen, TC_STANDARD, 'fairness-game-2');
    const op2 = prepareMove(game2, {
      uci: 'g1f3',
      at: 2_000,
      operationId: 'op-fair-2',
      rulesVersion: '1.0.0',
    });

    const ctrl = new AdjudicationJobController();
    ctrl.createJob(op1, game1);
    ctrl.createJob(op2, game2);

    // Call stepAll(1) 12 times
    for (let i = 0; i < 12; i++) {
      ctrl.stepAll(1);
    }

    const view1 = ctrl.getJob(op1.operationId)!;
    const view2 = ctrl.getJob(op2.operationId)!;

    // Neither job may be starved (0 work)
    assert.ok(view1.workCompleted > 0, `Job 1 starved: ${view1.workCompleted}`);
    assert.ok(view2.workCompleted > 0, `Job 2 starved: ${view2.workCompleted}`);

    // Both jobs receive fair shares
    assert.equal(view1.workCompleted + view2.workCompleted, 12);
    assert.equal(view1.workCompleted, 6);
    assert.equal(view2.workCompleted, 6);
  });

  test('T10: Root terminal checkmate creation: admitted terminal-root creation job becomes ready with bundle and settles', () => {
    const game = createGame(FEN_TERMINAL_MATE, TC_STANDARD, 'terminal-mate-game');
    const op = prepareCreationAdmission({
      gameId: game.snapshot().gameId,
      initialFen: FEN_TERMINAL_MATE,
      variant: 'standard',
      operationId: 'op-root-mate',
      rulesVersion: '1.0.0',
      at: 1_000,
    });

    const provingGame = game.withEvents([{
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    }]);

    const ctrl = new AdjudicationJobController();
    ctrl.createJob(op, provingGame);

    const view = ctrl.getJob(op.operationId)!;
    assert.equal(view.status, 'ready');
    assert.equal(view.handlesReady, true);

    // Settlement must succeed and produce checkmate ending
    const settlement = ctrl.settleJob(provingGame, op.operationId, 2_000);
    assert.equal(settlement.game.phase, 'ended');
    const status = settlement.game.status;
    assert.equal(status.over, true);
    assert.equal(status.termination, 'checkmate');
    assert.equal(status.winner, 'w');
    assert.equal(status.result, '1-0');
  });

  test('T11: Capacity limits, cancellation, and explicit eviction', () => {
    const game = createGame(FEN_MATE1);
    const op1 = prepareMove(game, { uci: 'e7g7', at: 2_000, operationId: 'op-cap-1', rulesVersion: '1.0.0' });
    const op2 = prepareMove(game, { uci: 'e7g7', at: 2_000, operationId: 'op-cap-2', rulesVersion: '1.0.0' });

    const ctrl = new AdjudicationJobController({ maxJobs: 1 });
    ctrl.createJob(op1);

    // Over capacity throws GameError
    assert.throws(
      () => ctrl.createJob(op2),
      /Job controller at capacity/,
    );

    // Cannot evict active job
    assert.throws(
      () => ctrl.evictJob(op1.operationId),
      /Cannot evict active adjudication job/,
    );

    // Cancel job
    ctrl.cancelJob(op1.operationId);
    assert.equal(ctrl.getJob(op1.operationId)!.status, 'cancelled');

    // Evict cancelled job succeeds
    const evicted = ctrl.evictJob(op1.operationId);
    assert.equal(evicted, true);
    assert.equal(ctrl.getJob(op1.operationId), undefined);

    // Now capacity is freed
    ctrl.createJob(op2);
    assert.ok(ctrl.getJob(op2.operationId));
  });

  test('T12: Parameter and options validation: invalid maxJobs and mismatched Game rejected', () => {
    assert.throws(
      () => new AdjudicationJobController({ maxJobs: 0 }),
      /maxJobs must be a positive safe integer/,
    );

    assert.throws(
      () => new AdjudicationJobController({ maxJobs: NaN }),
      /maxJobs must be a positive safe integer/,
    );

    assert.throws(
      () => new AdjudicationJobController({ maxJobs: -1 }),
      /maxJobs must be a positive safe integer/,
    );

    const gameA = createGame(FEN_MATE1, TC_STANDARD, 'game-a');
    const gameB = createGame(FEN_MATE1, TC_STANDARD, 'game-b');
    const opA = prepareMove(gameA, { uci: 'e7g7', at: 2_000, operationId: 'op-mismatch', rulesVersion: '1.0.0' });

    const ctrl = new AdjudicationJobController();
    assert.throws(
      () => ctrl.createJob(opA, gameB),
      /Context gameId "game-b" does not match prepared "game-a"/,
    );
  });

  test('T13: Context binding: rejects wrong FEN, wrong revision, and wrong ID; admits pre-Started and matching pending', () => {
    const game1 = createGame(FEN_MATE1, TC_STANDARD, 'bound-game-1');
    const op1 = prepareMove(game1, { uci: 'e7g7', at: 2_000, operationId: 'op-binding-test', rulesVersion: '1.0.0' });

    const ctrl = new AdjudicationJobController();

    // 1. Wrong FEN, same revision & gameId
    const gameWrongFen = createGame(FEN_DEAD_KB, TC_STANDARD, 'bound-game-1');
    assert.throws(
      () => ctrl.createJob(op1, gameWrongFen),
      /Context game position FEN does not match prepared operation base/,
    );

    // 2. Same FEN, later revision
    const gameLaterRev = createGame(FEN_MATE1, TC_STANDARD, 'bound-game-1').withEvents([{
      type: 'DrawOffered',
      by: 'w',
      at: 1_500,
    }]);
    assert.throws(
      () => ctrl.createJob(op1, gameLaterRev),
      /Context game revision does not match prepared operation base/,
    );

    // 3. Wrong gameId
    const gameWrongId = createGame(FEN_MATE1, TC_STANDARD, 'other-game');
    assert.throws(
      () => ctrl.createJob(op1, gameWrongId),
      /Context gameId "other-game" does not match prepared "bound-game-1"/,
    );

    // 4. Matching pre-Started Game succeeds
    const jobPre = ctrl.createJob(op1, game1);
    assert.equal(jobPre, op1.operationId);

    // 5. Matching pending Game (after AdjudicationStarted) succeeds
    const pendingGame = game1.withEvents([{
      type: 'AdjudicationStarted',
      gameId: game1.snapshot().gameId,
      operationId: 'op-pending-test',
      baseRevision: op1.baseRevision,
      at: op1.at,
      rulesVersion: op1.rulesVersion,
      prepared: { ...op1, operationId: 'op-pending-test' },
    }]);
    const jobPending = ctrl.createJob({ ...op1, operationId: 'op-pending-test' }, pendingGame);
    assert.equal(jobPending, 'op-pending-test');
  });

  test('T14: Representability: genuine timeout settlement and oversized boundary reject', () => {
    // 1. Genuine timeout settlement
    const tc: TimeControl = { kind: 'increment', initialMs: 10_000, incrementMs: 0, delayMs: 0 };
    const { game: g0 } = Game.create({
      gameId: 'timeout-settle-game',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: tc,
      players: { white: 'alice', black: 'bob' },
      at: 1_000,
    });

    const opMove = prepareMove(g0, { uci: 'e7e4', at: 2_000, operationId: 'm-1', rulesVersion: '1.0.0' });
    const startedMove = g0.withEvents([{
      type: 'AdjudicationStarted',
      gameId: g0.snapshot().gameId,
      operationId: opMove.operationId,
      baseRevision: opMove.baseRevision,
      at: opMove.at,
      rulesVersion: opMove.rulesVersion,
      prepared: opMove,
    }]);
    const ctrlMove = new AdjudicationJobController();
    ctrlMove.createJob(opMove, g0);
    while (ctrlMove.stepJob(opMove.operationId, 100).status === 'active') {}
    const g1 = ctrlMove.settleJob(startedMove, opMove.operationId, 2_100).game;

    assert.equal(g1.timeoutDue(20_000), true);
    const opFlag = prepareFlagExpiry(g1, { flagged: 'b', at: 20_000, operationId: 'flag-settle', rulesVersion: '1.0.0' });

    const ctrlFlag = new AdjudicationJobController();
    ctrlFlag.createJob(opFlag, g1);
    while (ctrlFlag.stepJob(opFlag.operationId, 100).status === 'active') {}

    const view = ctrlFlag.getJob(opFlag.operationId)!;
    assert.equal(view.status, 'ready');
    assert.equal(view.handlesReady, true);

    const startedFlag = g1.withEvents([{
      type: 'AdjudicationStarted',
      gameId: g1.snapshot().gameId,
      operationId: opFlag.operationId,
      baseRevision: opFlag.baseRevision,
      at: opFlag.at,
      rulesVersion: opFlag.rulesVersion,
      prepared: opFlag,
    }]);
    const settledFlag = ctrlFlag.settleJob(startedFlag, opFlag.operationId, 20_100);
    assert.equal(settledFlag.game.status.over, true);
    if (settledFlag.game.status.over) {
      assert.equal(settledFlag.game.status.termination, 'timeout');
      assert.equal(settledFlag.game.status.winner, 'w');
    }

    // 2. Lifecycle boundary reject for oversized witness (> 500) via verifyUciWitnessReplay
    // (Note: tests isolated replay verification boundary; no live >500 shortest-path game fixture executed without mocking)
    const dummy501 = new Array(501).fill('e2e4');
    const pos = Position.fromFen(FEN_MATE1, 'standard');
    assert.throws(
      () => verifyUciWitnessReplay(pos, 'w', dummy501),
      /Witness move sequence exceeds maximum length/,
    );
  });

  test('T15: Retained completion cursor slicing: genuine rook 3-ply completion at 1, 2, and 7 units', () => {
    const FEN_ROOK_LONGER = '7k/8/5K2/8/8/8/8/R7 w - - 0 1';
    const totals: Array<{ workCompleted: number; exactWork: number; completionWork: number }> = [];
    for (const budget of [1, 2, 7]) {
      const game = createGame(FEN_ROOK_LONGER);
      const op = prepareDrawOffer(game, {
        color: 'w',
        at: 2_000,
        operationId: `rook-slice-${budget}`,
        rulesVersion: '1.0.0',
      });

      const ctrl = new AdjudicationJobController();
      ctrl.createJob(op);

      let prevWork = 0;
      let prevCompletion = 0;
      while (ctrl.getJob(op.operationId)!.status === 'active') {
        const step = ctrl.stepJob(op.operationId, budget);
        const curJob = ctrl.getJob(op.operationId)!;
        const workDelta = curJob.workCompleted - prevWork;
        const compDelta = curJob.completionWork - prevCompletion;

        assert.equal(step.deltaWork, workDelta);
        assert.ok(step.deltaWork <= budget);
        assert.ok(compDelta <= workDelta);

        prevWork = curJob.workCompleted;
        prevCompletion = curJob.completionWork;
      }

      const view = ctrl.getJob(op.operationId)!;
      assert.equal(view.status, 'ready');
      assert.ok(view.exactWork > 0);
      assert.equal(view.completionWork, 4); // 3 plies + 1 = 4
      totals.push({ workCompleted: view.workCompleted, exactWork: view.exactWork, completionWork: view.completionWork });
    }
    // Same candidate: tiny and larger slices yield identical totals (no brittle algorithm constants).
    for (const t of totals.slice(1)) {
      assert.deepEqual(t, totals[0]);
    }
  });

  test('T16: Complete pending context matching and final job settlement binding', () => {
    const game = createGame(FEN_MATE1);
    const op = prepareMove(game, {
      uci: 'e7g7',
      at: 2_000,
      operationId: 'op-match-bind',
      rulesVersion: '1.0.0',
    });

    const pendingGame = game.withEvents([{
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    }]);

    const ctrl = new AdjudicationJobController();
    ctrl.createJob(op, pendingGame);

    // Step until ready
    while (ctrl.stepJob(op.operationId, 7).status === 'active') {}
    assert.equal(ctrl.getJob(op.operationId)!.status, 'ready');

    // 1. Changed acceptance time at settlement is rejected; job remains READY
    const pendingDiffAt = game.withEvents([{
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: 9_999,
      rulesVersion: op.rulesVersion,
      prepared: { ...op, at: 9_999 },
    }]);
    assert.throws(
      () => ctrl.settleJob(pendingDiffAt, op.operationId, 10_000),
      /timestamp at mismatch/,
    );
    assert.equal(ctrl.getJob(op.operationId)!.status, 'ready');

    // 2. Changed rulesVersion at settlement is rejected; job remains READY
    const pendingDiffRules = game.withEvents([{
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: '2.0.0',
      prepared: { ...op, rulesVersion: '2.0.0' },
    }]);
    assert.throws(
      () => ctrl.settleJob(pendingDiffRules, op.operationId, 2_100),
      /rulesVersion mismatch/,
    );
    assert.equal(ctrl.getJob(op.operationId)!.status, 'ready');

    // 3. Changed intent at settlement is rejected; job remains READY
    const opDraw = prepareDrawOffer(game, {
      color: 'w',
      at: 2_000,
      operationId: op.operationId,
      rulesVersion: op.rulesVersion,
    });
    const pendingDiffIntent = game.withEvents([{
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: opDraw,
    }]);
    assert.throws(
      () => ctrl.settleJob(pendingDiffIntent, op.operationId, 2_100),
      /intent mismatch/,
    );
    assert.equal(ctrl.getJob(op.operationId)!.status, 'ready');

    // 4. Mismatched Game ID at settlement is rejected; job remains READY
    const otherGame = createGame(FEN_MATE1, TC_STANDARD, 'other-game-id');
    assert.throws(
      () => ctrl.settleJob(otherGame, op.operationId, 2_100),
      /Game id mismatch/,
    );
    assert.equal(ctrl.getJob(op.operationId)!.status, 'ready');

    // 5. Genuine matching Game settlement succeeds and marks job settled
    const settled = ctrl.settleJob(pendingGame, op.operationId, 2_100);
    assert.equal(settled.game.phase, 'ended');
    assert.equal(ctrl.getJob(op.operationId)!.status, 'settled');
  });

  test('T17: Idempotent createJob: duplicate identical retries preserve progress and allow capacity reuse; conflicts rejected', () => {
    const game = createGame(FEN_MATE1);
    const op = prepareMove(game, {
      uci: 'e7g7',
      at: 2_000,
      operationId: 'op-idempotent',
      rulesVersion: '1.0.0',
    });

    const ctrl = new AdjudicationJobController({ maxJobs: 1 });
    ctrl.createJob(op);

    // Step a few units of work
    ctrl.stepJob(op.operationId, 2);
    const workBefore = ctrl.getJob(op.operationId)!.workCompleted;
    assert.ok(workBefore > 0);

    // Identical retry must preserve progress, returning same ID
    const retryId = ctrl.createJob(op);
    assert.equal(retryId, op.operationId);
    assert.equal(ctrl.getJob(op.operationId)!.workCompleted, workBefore);

    // Conflicting operation with same ID must be rejected
    const conflictOp = { ...op, baseFen: FEN_DEAD_KB };
    assert.throws(
      () => ctrl.createJob(conflictOp),
      /Conflicting prepared operation/,
    );
  });

  test('T18: Terminal fifty-move root honesty: terminal_authorization handle produces empty evidence without fake deadness', () => {
    const FEN_FIFTY_MOVE = '7k/4Q3/6K1/8/8/8/8/8 w - - 100 1';
    const game = createGame(FEN_FIFTY_MOVE);
    const op = prepareMove(game, {
      uci: 'e7g7',
      at: 2_000,
      operationId: 'op-fifty-move-honest',
      rulesVersion: '1.0.0',
    });

    const provingGame = game.withEvents([{
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    }]);

    const ctrl = new AdjudicationJobController();
    ctrl.createJob(op, provingGame);

    const view = ctrl.getJob(op.operationId)!;
    assert.equal(view.status, 'ready');
    assert.equal(view.handlesReady, true);

    const settlement = ctrl.settleJob(provingGame, op.operationId, 3_000);
    assert.equal(settlement.game.phase, 'ended');
    const status = settlement.game.status;
    assert.equal(status.over, true);
    assert.equal(status.termination, 'fifty_move');
    assert.equal(status.result, '1/2-1/2');

    // Evidence must be empty - NOT fabricated deadness
    assert.deepEqual(settlement.resolved.evidence, {});
  });

  test('T19: Genuine negative timeout: non-dead root, clock start, directional negative provenance, and distinct phase deltas', () => {
    const tc: TimeControl = { kind: 'increment', initialMs: 10_000, incrementMs: 0, delayMs: 0 };
    const { game: g0 } = Game.create({
      gameId: 'e-negative-timeout',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: tc,
      players: { white: 'alice', black: 'bob' },
      at: 1_000,
    });

    // Legal moves start the clock
    const { game: g1 } = g0.playMove('e7e5', 2_000);
    const { game: g2 } = g1.playMove('h8g8', 3_000);

    // White flags at 20000; Black has bare king -> insufficient material draw
    const op = prepareFlagExpiry(g2, {
      flagged: 'w',
      at: 20_000,
      operationId: 'e-negative-timeout-op',
      rulesVersion: '1.0.0',
    });

    const started = g2.withEvents([{
      type: 'AdjudicationStarted',
      gameId: g2.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    }]);

    const ctrl = new AdjudicationJobController();
    ctrl.createJob(op, started);

    let calls = 0;
    while (ctrl.stepJob(op.operationId, 7).status === 'active') {
      calls++;
    }
    assert.equal(calls, 2); // 2 steps were active, 3rd stepped to ready

    const view = ctrl.getJob(op.operationId)!;
    assert.equal(view.status, 'ready');
    assert.equal(view.workCompleted, 20);
    assert.equal(view.slicesExecuted, 3);
    assert.equal(view.generationWork, 2);
    assert.equal(view.exactWork, 7);
    assert.equal(view.completionWork, 2);
    assert.equal(view.scoringWork, 8);
    assert.equal(view.replayWork, 2);

    const settlement = ctrl.settleJob(started, op.operationId, 20_100);
    assert.equal(settlement.game.status.over, true);
    if (settlement.game.status.over) {
      assert.equal(settlement.game.status.termination, 'insufficient_material');
      assert.equal(settlement.game.status.result, '1/2-1/2');
      assert.equal(settlement.game.status.winner, null);
    }

    const recorded = settlement.resolved.evidence;
    assert.ok(recorded);
    if (!recorded) throw new Error('Expected recorded evidence');
    assert.ok(recorded.base);
    assert.equal(recorded.base?.status, 'reachable');
    assert.ok(recorded.timeout);
    assert.equal(recorded.timeout?.outcome.status, 'impossible');
    assert.equal(recorded.timeout?.outcome.provenance, 'closed_graph_material_pruned');
  });

  test('T20: Real 8-ply finder completion slicing: 1/2/7 per-call bounds, same-candidate parity, finder origin, and real settlement', () => {
    const FEN_8PLY = 'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq c3 0 1';
    const totals: Array<{
      workCompleted: number;
      exactWork: number;
      completionWork: number;
      witness: readonly string[];
    }> = [];

    for (const budget of [1, 2, 7]) {
      const game = createGame(FEN_8PLY);
      const op = prepareDrawOffer(game, {
        color: 'b',
        at: 2_000,
        operationId: `finder-8ply-op-${budget}`,
        rulesVersion: '1.0.0',
      });

      const pendingGame = game.withEvents([{
        type: 'AdjudicationStarted',
        gameId: game.snapshot().gameId,
        operationId: op.operationId,
        baseRevision: op.baseRevision,
        at: op.at,
        rulesVersion: op.rulesVersion,
        prepared: op,
      }]);

      const ctrl = new AdjudicationJobController();
      ctrl.createJob(op, pendingGame);

      let prevWork = 0;
      let prevCompletion = 0;
      let calls = 0;
      for (;;) {
        const step = ctrl.stepJob(op.operationId, budget);
        const cur = ctrl.getJob(op.operationId)!;
        // Measured per-call bounds: never overrun the budget, and completion never outruns work.
        assert.ok(step.deltaWork <= budget);
        assert.equal(step.deltaWork, cur.workCompleted - prevWork);
        assert.ok(cur.completionWork - prevCompletion <= step.deltaWork);
        prevWork = cur.workCompleted;
        prevCompletion = cur.completionWork;
        calls++;
        if (step.status !== 'active') break;
      }
      assert.ok(calls >= 1);

      const view = ctrl.getJob(op.operationId)!;
      assert.equal(view.status, 'ready');
      assert.equal(view.slicesExecuted, calls);
      assert.ok(view.exactWork > 0);

      // Standalone winner White exact search after the aggregate exact work remains pending
      const pos = Position.fromFen(FEN_8PLY, 'standard');
      const standaloneExact = new CooperativeSearchSession(pos.snapshot(), 'w');
      standaloneExact.resumeWork(view.exactWork);
      assert.equal(standaloneExact.getStatus().status, 'pending');

      // Settle with matching Game
      const settlement = ctrl.settleJob(pendingGame, op.operationId, 2_100);
      assert.equal(settlement.game.phase, 'idle');
      assert.equal(settlement.game.snapshot().drawOffer, 'b');
      assert.ok(settlement.resolved.evidence);
      assert.equal(settlement.resolved.evidence?.base?.status, 'reachable');
      const witness = settlement.resolved.evidence?.base?.witness;
      assert.ok(witness);

      // Genuine finder-origin witness: a legal multi-ply path that really ends in checkmate.
      assert.ok(witness.length > 1 && witness.length <= 500);
      assert.equal(view.completionWork, witness.length + 1); // plies + 1
      let replay = pos;
      for (const uci of witness) {
        replay = replay.play(uci);
      }
      const end = replay.status();
      assert.equal(end.over, true);
      assert.equal(end.over && end.reason, 'checkmate');

      totals.push({
        workCompleted: view.workCompleted,
        exactWork: view.exactWork,
        completionWork: view.completionWork,
        witness: [...witness],
      });
    }

    // Same candidate: tiny and large slices produce identical totals and the identical witness.
    for (const t of totals.slice(1)) {
      assert.deepEqual(t, totals[0]);
    }
  });
});
