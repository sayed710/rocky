import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Position,
  type Color,
} from '@chess-platform/core';
import {
  Game,
  GameError,
  MAX_SAFE_TIMESTAMP_MS,
  prepareCreationAdmission,
  prepareMove,
  prepareReady,
  prepareDrawOffer,
  prepareDrawDecline,
  prepareDrawAccept,
  prepareResign,
  prepareAbort,
  prepareFlagExpiry,
  prepareNoShowExpiry,
  validateAdjudicationAppendBatch,
  createAdjudicationClockBasis,
  deriveTurnLineageId,
  inspectReleaseRetry,
  assertReleaseRetryValid,
  assertReleaseProposalShape,
  type AdjudicationClocksStartedEvent,
  type AdjudicationClockCompletionDescriptor,
  type AdjudicationClockPolicy,
  type GameEvent,
  type MovePlayedEvent,
  type PreparedOperation,
  type TimeControl,
  type ReleaseProposalParams,
} from '../src';
import {
  AdjudicationJobController,
} from '../src/adjudication-controller';
import { replayStoredHistory, type StoredHistoryRow } from '../src/stored-history';

const TC_INCREMENT: TimeControl = {
  kind: 'increment',
  initialMs: 60_000,
  incrementMs: 2_000,
  delayMs: 0,
};

const TC_DELAY: TimeControl = {
  kind: 'delay',
  initialMs: 60_000,
  incrementMs: 0,
  delayMs: 5_000,
};

const TC_UNLIMITED: TimeControl = {
  kind: 'unlimited',
  initialMs: 0,
  incrementMs: 0,
  delayMs: 0,
};

const FEN_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_3PIECE = '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1'; // White to move: g6g5 (non-terminal), g6g7# (mate)

function createManagedGame(params: {
  fen?: string;
  tc?: TimeControl;
  gameId?: string;
  source?: 'seek' | 'tournament';
  noShowAfterMs?: number;
  at?: number;
} = {}): { game: Game; events: GameEvent[] } {
  const at = params.at ?? 1_000;
  const { game, events } = Game.create({
    gameId: params.gameId ?? 's-release-domain-test',
    variant: 'standard',
    initialFen: params.fen ?? FEN_3PIECE,
    timeControl: params.tc ?? TC_INCREMENT,
    players: { white: 'alice', black: 'bob' },
    source: params.source,
    noShowAfterMs: params.noShowAfterMs,
    at,
  });
  return { game, events };
}

function stepUntilReady(ctrl: AdjudicationJobController, operationId: string, maxIterations = 50): void {
  let iter = 0;
  while (ctrl.getJob(operationId)?.status === 'active') {
    if (++iter > maxIterations) {
      throw new Error(`stepUntilReady timed out after ${maxIterations} iterations for ${operationId}; status is ${ctrl.getJob(operationId)?.status}`);
    }
    ctrl.stepJob(operationId, 500);
  }
  const job = ctrl.getJob(operationId);
  if (!job || job.status !== 'ready') {
    throw new Error(`Job ${operationId} did not become ready; status is ${job?.status}`);
  }
}

function produceSettledStoppedGame(params: {
  fen?: string;
  tc?: TimeControl;
  gameId?: string;
  source?: 'seek' | 'tournament';
  noShowAfterMs?: number;
  createdAt?: number;
  admitAt?: number;
  settleAt?: number;
} = {}): {
  baseGame: Game;
  settledGame: Game;
  historyEvents: GameEvent[];
  startedEvent: GameEvent;
  prepared: PreparedOperation;
} {
  const createdAt = params.createdAt ?? 1_000;
  const admitAt = params.admitAt ?? 1_500;
  const settleAt = params.settleAt ?? 2_000;

  const { game: baseGame, events: initEvents } = createManagedGame({
    fen: params.fen,
    tc: params.tc,
    gameId: params.gameId,
    source: params.source,
    noShowAfterMs: params.noShowAfterMs,
    at: createdAt,
  });

  const prepared = prepareCreationAdmission(baseGame, {
    operationId: 'op-init-admission',
    rulesVersion: '1.0.0',
    at: admitAt,
    clockPolicy: 'observed-release-v1',
  });

  const controller = new AdjudicationJobController();
  controller.createJob(prepared, baseGame);
  stepUntilReady(controller, prepared.operationId);

  const startedEvent: GameEvent = {
    type: 'AdjudicationStarted',
    gameId: baseGame.id,
    operationId: prepared.operationId,
    baseRevision: 0,
    at: admitAt,
    rulesVersion: '1.0.0',
    prepared,
    clockPolicy: 'observed-release-v1',
  };

  const provingGame = baseGame.withEvents([startedEvent]);
  const settlement = controller.settleJob(provingGame, prepared.operationId, settleAt);

  const historyEvents: GameEvent[] = [
    ...initEvents,
    startedEvent,
    settlement.resolved,
    ...settlement.effects,
  ];

  return {
    baseGame,
    settledGame: settlement.game,
    historyEvents,
    startedEvent,
    prepared,
  };
}

function buildMatchingReleaseEvent(
  game: Game,
  requestId: string,
  atS: number,
): AdjudicationClocksStartedEvent {
  const stopped = game.stoppedClock;
  if (!stopped) throw new Error('Game has no stoppedClock to release');
  return {
    type: 'AdjudicationClocksStarted',
    gameId: game.id,
    clockPolicy: 'observed-release-v1',
    rulesVersion: stopped.rulesVersion,
    releaseRequestId: requestId,
    stopId: stopped.stopId,
    originatingOperationId: stopped.originatingOperationId,
    originatingResolvedSeq: stopped.originatingResolvedSeq,
    completionHead: stopped.completionHead,
    expectedHead: game.eventSequence,
    turnLineageId: stopped.turnLineageId,
    side: game.turn,
    ply: game.ply,
    at: atS,
  };
}

function replayEventsStored(gameId: string, events: readonly GameEvent[]): Game {
  const rows: StoredHistoryRow[] = events.map((event, i) => ({
    gameId,
    seq: i,
    version: 1,
    event,
  }));
  return replayStoredHistory(gameId, rows).game;
}

describe('Stage K: Recorded AdjudicationClocksStarted (S) Domain Replay & Continuation', () => {
  describe('Gate 1: Trust Boundary & Replay Rejection Enforcement', () => {
    test('literal recorded S is accepted by history reconstruction Game.fromEvents', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      assert.notEqual(settledGame.stoppedClock, null);

      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-rel-1', 2500);
      const reconstructed = Game.fromEvents([...historyEvents, sEvent]);

      assert.equal(reconstructed.stoppedClock, null);
      assert.notEqual(reconstructed.releasedClock, null);
      assert.equal(reconstructed.releasedClock?.releaseRequestId, 'req-rel-1');
      assert.equal(reconstructed.releasedClock?.releasedAt, 2500);
      assert.equal(reconstructed.releaseNeeded, false);
      assert.equal(reconstructed.isStopConsumed(settledGame.stoppedClock!.stopId), true);
    });

    test('ordinary live Game.prototype.withEvents([S]) strictly rejects recorded S', () => {
      const { settledGame } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-rel-live', 2500);

      assert.throws(
        () => settledGame.withEvents([sEvent]),
        (err: unknown) => err instanceof GameError && /replay\/reconstruction route required/i.test((err as Error).message),
      );
    });

    test('reconstructed game from history does NOT inherit persistent replay authority to append live S', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-rel-recon', 2500);
      const reconstructed = Game.fromEvents([...historyEvents, sEvent]);

      // Attempting to feed another live S via withEvents on reconstructed game must reject
      const fakeNextS: AdjudicationClocksStartedEvent = {
        ...sEvent,
        releaseRequestId: 'req-rel-illegal-second',
        expectedHead: reconstructed.eventSequence,
        at: 3000,
      };
      assert.throws(
        () => reconstructed.withEvents([fakeNextS]),
        (err: unknown) => err instanceof GameError && /replay\/reconstruction route required/i.test((err as Error).message),
      );
    });

    test('standalone batch validator validates shape structurally without live mutation', () => {
      const { settledGame } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-rel-batch', 2500);

      // Standalone batch passes pure structural validation
      assert.doesNotThrow(() => validateAdjudicationAppendBatch(settledGame, [sEvent]));

      // Multi-event batch containing S is strictly rejected
      const dummyMove: MovePlayedEvent = {
        type: 'MovePlayed',
        ply: 0,
        uci: 'g6g5',
        san: 'g5',
        by: 'w',
        moveTimeMs: 100,
        remaining: { w: 60000, b: 60000 },
        at: 2600,
      };
      assert.throws(
        () => validateAdjudicationAppendBatch(settledGame, [sEvent, dummyMove]),
        (err: unknown) => err instanceof GameError && /standalone append batch/i.test((err as Error).message),
      );
    });
  });

  describe('Gate 2: Read-Only Retry Inspection & Receipt Ownership', () => {
    test('identical proposal returns existing_match with owned immutable receipt', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-id-1', 2500);
      const reconstructed = Game.fromEvents([...historyEvents, sEvent]);

      const proposal: ReleaseProposalParams = {
        releaseRequestId: 'req-id-1',
        gameId: sEvent.gameId,
        stopId: sEvent.stopId,
        originatingOperationId: sEvent.originatingOperationId,
        originatingResolvedSeq: sEvent.originatingResolvedSeq,
        completionHead: sEvent.completionHead,
        expectedHead: sEvent.expectedHead,
        turnLineageId: sEvent.turnLineageId,
        side: sEvent.side,
        ply: sEvent.ply,
        at: sEvent.at,
        clockPolicy: sEvent.clockPolicy,
        rulesVersion: sEvent.rulesVersion,
      };

      const result = inspectReleaseRetry(reconstructed, proposal);
      assert.equal(result.kind, 'existing_match');
      if (result.kind === 'existing_match') {
        assert.equal(result.receipt.releaseRequestId, 'req-id-1');
        assert.equal(result.receipt.at, 2500);
        assert.equal(result.receipt.stopId, sEvent.stopId);
      }

      const receipt = assertReleaseRetryValid(reconstructed, proposal);
      assert.equal(receipt.releaseRequestId, 'req-id-1');
    });

    test('changed content under same releaseRequestId returns conflict', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-id-conflict', 2500);
      const reconstructed = Game.fromEvents([...historyEvents, sEvent]);

      const changedProposal: ReleaseProposalParams = {
        releaseRequestId: 'req-id-conflict',
        gameId: sEvent.gameId,
        stopId: sEvent.stopId,
        originatingOperationId: sEvent.originatingOperationId,
        originatingResolvedSeq: sEvent.originatingResolvedSeq,
        completionHead: sEvent.completionHead,
        expectedHead: sEvent.expectedHead,
        turnLineageId: sEvent.turnLineageId,
        side: sEvent.side,
        ply: sEvent.ply,
        at: 2600, // Changed from 2500 to 2600
        clockPolicy: sEvent.clockPolicy,
        rulesVersion: sEvent.rulesVersion,
      };

      const result = inspectReleaseRetry(reconstructed, changedProposal);
      assert.equal(result.kind, 'conflict');
      assert.throws(
        () => assertReleaseRetryValid(reconstructed, changedProposal),
        (err: unknown) => err instanceof GameError && /Release request conflict/i.test((err as Error).message),
      );
    });

    test('new releaseRequestId against already consumed stop returns consumed_stop', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-first', 2500);
      const reconstructed = Game.fromEvents([...historyEvents, sEvent]);

      const newProposalOnConsumedStop: ReleaseProposalParams = {
        releaseRequestId: 'req-second-new',
        gameId: sEvent.gameId,
        stopId: sEvent.stopId,
        originatingOperationId: sEvent.originatingOperationId,
        originatingResolvedSeq: sEvent.originatingResolvedSeq,
        completionHead: sEvent.completionHead,
        expectedHead: sEvent.expectedHead,
        turnLineageId: sEvent.turnLineageId,
        side: sEvent.side,
        ply: sEvent.ply,
        at: 2500,
        clockPolicy: sEvent.clockPolicy,
        rulesVersion: sEvent.rulesVersion,
      };

      const result = inspectReleaseRetry(reconstructed, newProposalOnConsumedStop);
      assert.equal(result.kind, 'consumed_stop');
      assert.throws(
        () => assertReleaseRetryValid(reconstructed, newProposalOnConsumedStop),
        (err: unknown) => err instanceof GameError && /New release request rejected/i.test((err as Error).message),
      );
    });

    test('unrecorded releaseRequestId returns not_released', () => {
      const { settledGame } = produceSettledStoppedGame({ settleAt: 2000 });
      const proposal: ReleaseProposalParams = {
        releaseRequestId: 'req-unrecorded',
        gameId: settledGame.id,
        stopId: settledGame.stoppedClock!.stopId,
        originatingOperationId: settledGame.stoppedClock!.originatingOperationId,
        originatingResolvedSeq: settledGame.stoppedClock!.originatingResolvedSeq,
        completionHead: settledGame.stoppedClock!.completionHead,
        expectedHead: settledGame.eventSequence,
        turnLineageId: settledGame.stoppedClock!.turnLineageId,
        side: settledGame.turn,
        ply: settledGame.ply,
        at: 2500,
        clockPolicy: 'observed-release-v1',
        rulesVersion: '1.0.0',
      };

      const result = inspectReleaseRetry(settledGame, proposal);
      assert.equal(result.kind, 'not_released');
    });

    test('receipts map and receipts lookup are deeply owned and immune to caller mutation', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-mut-check', 2500);
      const reconstructed = Game.fromEvents([...historyEvents, sEvent]);

      const receipts = reconstructed.releaseReceipts;
      assert.equal(receipts.length, 1);
      assert.throws(
        () => { (receipts as unknown as unknown[])[0] = null; },
        (err: unknown) => err instanceof TypeError,
      );

      const r = reconstructed.getReleaseReceipt('req-mut-check')!;
      assert.notEqual(r, null);
      assert.throws(
        () => { (r as unknown as { at: number }).at = 99999; },
        (err: unknown) => err instanceof TypeError,
      );
      assert.equal(reconstructed.getReleaseReceipt('req-mut-check')?.at, 2500);
    });
  });

  describe('Gate 3: Negative Structural & Causal Boundary Rejection', () => {
    test('rejects duplicate committed S event in history fold', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-dup', 2500);

      // Two identical S events in same replay stream
      assert.throws(
        () => Game.fromEvents([...historyEvents, sEvent, sEvent]),
        (err: unknown) => err instanceof GameError && /Duplicate committed AdjudicationClocksStarted event rejected/i.test((err as Error).message),
      );
    });

    test('rejects backward release timestamp S < stoppedAt', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-back-s', 1900); // 1900 < settleAt (2000)

      assert.throws(
        () => Game.fromEvents([...historyEvents, sEvent]),
        (err: unknown) => err instanceof GameError && /cannot precede (active causal floor|last stop observation) 2000/i.test((err as Error).message),
      );
    });

    test('rejects backward release timestamp S < causal floor', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ createdAt: 1000, settleAt: 2000 });
      const sEvent: AdjudicationClocksStartedEvent = {
        ...buildMatchingReleaseEvent(settledGame, 'req-floor-back', 2500),
        at: 500, // 500 < createdAt 1000
      };

      assert.throws(
        () => Game.fromEvents([...historyEvents, sEvent]),
        (err: unknown) => err instanceof GameError && /cannot precede/i.test((err as Error).message),
      );
    });

    test('rejects oversized timestamp exceeding MAX_SAFE_TIMESTAMP_MS', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent: AdjudicationClocksStartedEvent = {
        ...buildMatchingReleaseEvent(settledGame, 'req-overflow', 2500),
        at: MAX_SAFE_TIMESTAMP_MS + 1,
      };

      assert.throws(
        () => Game.fromEvents([...historyEvents, sEvent]),
        (err: unknown) => err instanceof GameError && /must be a non-negative safe integer <=/i.test((err as Error).message),
      );
    });

    test('rejects fractional timestamp in recorded S', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent: AdjudicationClocksStartedEvent = {
        ...buildMatchingReleaseEvent(settledGame, 'req-frac', 2500),
        at: 2500.5,
      };

      assert.throws(
        () => Game.fromEvents([...historyEvents, sEvent]),
        (err: unknown) => err instanceof GameError && /must be a non-negative safe integer <=/i.test((err as Error).message),
      );
    });

    test('rejects stopId, originatingOperationId, or expectedHead mismatch', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-mismatch', 2500);

      const wrongStopId = { ...sEvent, stopId: 'stop:fake:999' };
      assert.throws(
        () => Game.fromEvents([...historyEvents, wrongStopId]),
        (err: unknown) => err instanceof GameError && /stopId mismatch/i.test((err as Error).message),
      );

      const wrongOpId = { ...sEvent, originatingOperationId: 'op-different' };
      assert.throws(
        () => Game.fromEvents([...historyEvents, wrongOpId]),
        (err: unknown) => err instanceof GameError && /originatingOperationId mismatch/i.test((err as Error).message),
      );

      const wrongHead = { ...sEvent, expectedHead: 99 };
      assert.throws(
        () => Game.fromEvents([...historyEvents, wrongHead]),
        (err: unknown) => err instanceof GameError && /expectedHead mismatch/i.test((err as Error).message),
      );
    });

    test('rejects release when no countdown is applicable (unlimited non-sourced)', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({
        tc: TC_UNLIMITED,
        settleAt: 2000,
      });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-unlimited', 2500);

      assert.throws(
        () => Game.fromEvents([...historyEvents, sEvent]),
        (err: unknown) => err instanceof GameError && /no countdown is applicable/i.test((err as Error).message),
      );
    });
  });

  describe('Gate 4: Delay Matrix Accounting & Forward Continuations after S', () => {
    test('Vector: B=1000, D=100, S=5000, A=5030 with prior E=160 evaluates to remaining 910', () => {
      // White to move in FEN_3PIECE. Time control: initial 1000 ms, delay 100 ms.
      const tcVector: TimeControl = {
        kind: 'delay',
        initialMs: 1_000,
        incrementMs: 0,
        delayMs: 100,
      };

      const { game: baseGame, events: initEvents } = createManagedGame({
        fen: FEN_3PIECE,
        tc: tcVector,
        at: 1000,
      });

      // Prepare first command with 160 ms elapsed: at 1160
      const prep1 = prepareDrawOffer(baseGame, {
        color: 'w',
        at: 1160, // elapsed 160 ms
        operationId: 'op-offer-160',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });

      const ctrl1 = new AdjudicationJobController();
      ctrl1.createJob(prep1, baseGame);
      stepUntilReady(ctrl1, prep1.operationId);

      const started1: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prep1.operationId,
        baseRevision: 0,
        at: 1160,
        rulesVersion: '1.0.0',
        prepared: prep1,
        clockPolicy: 'observed-release-v1',
      };
      const prov1 = baseGame.withEvents([started1]);
      const set1 = ctrl1.settleJob(prov1, prep1.operationId, 5000); // Settles at S=5000

      // Now at S=5000, clocks stopped with E=160.
      assert.equal(set1.game.stoppedClock?.basis.elapsedThinkingMs, 160);

      // Release clocks at S=5000
      const sEvent = buildMatchingReleaseEvent(set1.game, 'req-vector-1', 5000);
      const eventsAfterS: GameEvent[] = [
        ...initEvents,
        started1,
        set1.resolved,
        ...set1.effects,
        sEvent,
      ];
      const releasedGame = Game.fromEvents(eventsAfterS);
      assert.notEqual(releasedGame.releasedClock, null);
      assert.equal(releasedGame.releasedClock?.basis.elapsedThinkingMs, 160);

      // Next forward command at A=5030 (A - S = 30 ms):
      // Total elapsed thinking = 160 + 30 = 190 ms.
      // Delay = 100 ms. Chargeable = max(0, 190 - 100) = 90 ms.
      // Expected remaining balance for White = 1000 - 90 = 910 ms.
      const prep2 = prepareDrawDecline(releasedGame, {
        color: 'b',
        at: 5030,
        operationId: 'op-decline-5030',
        rulesVersion: '1.0.0',
      });

      const ctrl2 = new AdjudicationJobController();
      ctrl2.createJob(prep2, releasedGame);
      stepUntilReady(ctrl2, prep2.operationId);

      const started2: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: releasedGame.id,
        operationId: prep2.operationId,
        baseRevision: releasedGame.eventSequence,
        at: 5030,
        rulesVersion: '1.0.0',
        prepared: prep2,
        clockPolicy: 'observed-release-v1',
      };

      const prov2 = releasedGame.withEvents([started2]);
      // Public frozen clock during proving reflects the managed display balances (910 ms)
      assert.equal(prov2.clock.remaining.w, 910);

      // Settle at R=6000. R adds NOTHING!
      const set2 = ctrl2.settleJob(prov2, prep2.operationId, 6000);
      const finalStoppedGame = set2.game;

      assert.equal(finalStoppedGame.stoppedClock?.basis.elapsedThinkingMs, 190);
      assert.equal(finalStoppedGame.clock.remaining.w, 910);
      assert.equal(finalStoppedGame.stoppedClock?.basis.turnBaseBalances.w, 1000);
    });

    test('backward timestamp A < S is strictly rejected on continuation command', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-causal-test', 3000);
      const releasedGame = Game.fromEvents([...historyEvents, sEvent]);

      // Command prepared at A=2900 < S=3000 must reject
      assert.throws(
        () => prepareMove(releasedGame, {
          uci: 'g6g5',
          at: 2900,
          operationId: 'op-back-move',
          rulesVersion: '1.0.0',
        }),
        (err: unknown) => err instanceof GameError,
      );
    });

    test('move completion after S adds increment once, switches turn, opponent starts at E=0', () => {
      const { game: baseGame, events: initEvents } = createManagedGame({
        fen: FEN_3PIECE,
        tc: TC_INCREMENT, // 60s + 2s increment
        at: 1000,
      });

      // Prepare initial admission at 1100, settle at 2000
      const prep1 = prepareCreationAdmission(baseGame, {
        operationId: 'op-init-move-chain',
        rulesVersion: '1.0.0',
        at: 1100,
        clockPolicy: 'observed-release-v1',
      });
      const ctrl1 = new AdjudicationJobController();
      ctrl1.createJob(prep1, baseGame);
      stepUntilReady(ctrl1, prep1.operationId);

      const started1: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prep1.operationId,
        baseRevision: 0,
        at: 1100,
        rulesVersion: '1.0.0',
        prepared: prep1,
        clockPolicy: 'observed-release-v1',
      };
      const prov1 = baseGame.withEvents([started1]);
      const set1 = ctrl1.settleJob(prov1, prep1.operationId, 2000);

      // Release at S=2500
      const sEvent = buildMatchingReleaseEvent(set1.game, 'req-rel-move', 2500);
      const releasedGame = Game.fromEvents([...initEvents, started1, set1.resolved, ...set1.effects, sEvent]);

      // Play move g6g5 at A=3500 (1000 ms elapsed)
      const prepMove = prepareMove(releasedGame, {
        uci: 'g6g5',
        at: 3500,
        operationId: 'op-move-after-s',
        rulesVersion: '1.0.0',
      });
      assert.equal(prepMove.clockPolicy, 'observed-release-v1');
      assert.equal(prepMove.parentStopId, set1.game.stoppedClock!.stopId);

      const ctrl2 = new AdjudicationJobController();
      ctrl2.createJob(prepMove, releasedGame);
      stepUntilReady(ctrl2, prepMove.operationId);

      const startedMove: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: releasedGame.id,
        operationId: prepMove.operationId,
        baseRevision: releasedGame.eventSequence,
        at: 3500,
        rulesVersion: '1.0.0',
        prepared: prepMove,
        clockPolicy: 'observed-release-v1',
      };
      const provMove = releasedGame.withEvents([startedMove]);
      const setMove = ctrl2.settleJob(provMove, prepMove.operationId, 4000);

      const afterMoveGame = setMove.game;
      assert.equal(afterMoveGame.ply, 1);
      assert.equal(afterMoveGame.turn, 'b');
      // White was charged 100 ms at initial admission (1100-1000) and 1000 ms at move (3500-2500), plus 2000 ms increment: 60000 - 1100 + 2000 = 60900
      assert.equal(afterMoveGame.clock.remaining.w, 60900);
      // Black (new side to move) starts with fresh turn: E=0
      assert.equal(afterMoveGame.stoppedClock?.basis.elapsedThinkingMs, 0);
      assert.equal(afterMoveGame.stoppedClock?.basis.turnBaseBalances.b, 60000);
    });
  });

  describe('Gate 5: No-Show & Chess Countdown Applicability Separation', () => {
    test('sourced no-show-only seek released at 5000 with remainder 600: ready at 5100 leaves 500 remainder and 0 chess elapsed', () => {
      // Seek game: source = 'seek', noShowAfterMs = 600. Created at 1000.
      const { game: baseGame, events: initEvents } = createManagedGame({
        fen: FEN_3PIECE,
        tc: TC_INCREMENT,
        source: 'seek',
        noShowAfterMs: 600,
        at: 1000,
      });

      // Prepare creation admission at 1000, settle at 1500
      const prep1 = prepareCreationAdmission(baseGame, {
        operationId: 'op-seek-init',
        rulesVersion: '1.0.0',
        at: 1000,
        clockPolicy: 'observed-release-v1',
      });
      const ctrl1 = new AdjudicationJobController();
      ctrl1.createJob(prep1, baseGame);
      stepUntilReady(ctrl1, prep1.operationId);

      const started1: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prep1.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared: prep1,
        clockPolicy: 'observed-release-v1',
      };
      const set1 = ctrl1.settleJob(baseGame.withEvents([started1]), prep1.operationId, 1500);

      // Release at S=5000:
      // In pre-first-move sourced game, chess clock is UNSTARTED (runningSince is null for chess),
      // while no-show is active with remainder 600!
      const sEvent = buildMatchingReleaseEvent(set1.game, 'req-noshow-rel', 5000);
      const releasedGame = Game.fromEvents([...initEvents, started1, set1.resolved, ...set1.effects, sEvent]);

      assert.equal(releasedGame.releasedClock?.isChessApplicable, false);
      assert.equal(releasedGame.releasedClock?.noShowRunningSince, 5000);
      assert.equal(releasedGame.noShowDeadline, 5600); // 5000 + 600
      assert.equal(releasedGame.flagDeadline, null); // Chess deadline null!

      // Player White marks ready at A=5100 (100 ms elapsed into no-show window)
      const prepReady = prepareReady(releasedGame, {
        color: 'w',
        at: 5100,
        operationId: 'op-ready-w',
        rulesVersion: '1.0.0',
      });
      assert.equal(prepReady.kind, 'prepared');
      if (prepReady.kind === 'prepared') {
        const ctrl2 = new AdjudicationJobController();
        ctrl2.createJob(prepReady, releasedGame);
        stepUntilReady(ctrl2, prepReady.operationId);

        const startedReady: GameEvent = {
          type: 'AdjudicationStarted',
          gameId: releasedGame.id,
          operationId: prepReady.operationId,
          baseRevision: releasedGame.eventSequence,
          at: 5100,
          rulesVersion: '1.0.0',
          prepared: prepReady,
          clockPolicy: 'observed-release-v1',
        };
        const provReady = releasedGame.withEvents([startedReady]);
        const setReady = ctrl2.settleJob(provReady, prepReady.operationId, 5200);

        // After ready at 5100: no-show remainder is 600 - 100 = 500 ms!
        // Chess elapsed is 0!
        assert.equal(setReady.game.stoppedClock?.basis.noShowRemainderMs, 500);
        assert.equal(setReady.game.stoppedClock?.basis.elapsedThinkingMs, 0);
      }
    });

    test('first move in sourced game clears noShow remainder completely', () => {
      const { game: baseGame, events: initEvents } = createManagedGame({
        fen: FEN_3PIECE,
        tc: TC_INCREMENT,
        source: 'tournament',
        noShowAfterMs: 30000,
        at: 1000,
      });

      // Prepare White ready with observed-release-v1
      const prepReadyW = prepareReady(baseGame, {
        color: 'w',
        at: 1100,
        operationId: 'op-tourn-ready-w',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      assert.equal(prepReadyW.kind, 'prepared');
      const ctrl1 = new AdjudicationJobController();
      ctrl1.createJob(prepReadyW, baseGame);
      stepUntilReady(ctrl1, prepReadyW.operationId);

      const startedReadyW: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepReadyW.operationId,
        baseRevision: 0,
        at: 1100,
        rulesVersion: '1.0.0',
        prepared: prepReadyW,
        clockPolicy: 'observed-release-v1',
      };
      const provW = baseGame.withEvents([startedReadyW]);
      const setW = ctrl1.settleJob(provW, prepReadyW.operationId, 1200);

      // S release for Black's ready
      const s1 = buildMatchingReleaseEvent(setW.game, 'req-rel-ready-b', 1300);
      const relGame1 = Game.fromEvents([...initEvents, startedReadyW, setW.resolved, ...setW.effects, s1]);

      // Prepare Black ready
      const prepReadyB = prepareReady(relGame1, {
        color: 'b',
        at: 1400,
        operationId: 'op-tourn-ready-b',
        rulesVersion: '1.0.0',
      });
      assert.equal(prepReadyB.kind, 'prepared');
      const ctrl2 = new AdjudicationJobController();
      ctrl2.createJob(prepReadyB, relGame1);
      stepUntilReady(ctrl2, prepReadyB.operationId);

      const startedReadyB: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: relGame1.id,
        operationId: prepReadyB.operationId,
        baseRevision: relGame1.eventSequence,
        at: 1400,
        rulesVersion: '1.0.0',
        prepared: prepReadyB,
        clockPolicy: 'observed-release-v1',
      };
      const provB = relGame1.withEvents([startedReadyB]);
      const setB = ctrl2.settleJob(provB, prepReadyB.operationId, 1500);

      // In tournament when both players are ready, noShowRemainderMs is cleared (null)
      assert.equal(setB.game.stoppedClock?.basis.noShowRemainderMs, null);

      // In tournament both ready at ply 0, neither chess nor noShow is applicable, so S is rejected
      const s2Tourn = buildMatchingReleaseEvent(setB.game, 'req-tourn-move-rel', 2000);
      assert.throws(
        () => Game.fromEvents([
          ...initEvents,
          startedReadyW, setW.resolved, ...setW.effects, s1,
          startedReadyB, setB.resolved, ...setB.effects, s2Tourn,
        ]),
        (err: unknown) => err instanceof GameError && /no countdown is applicable/i.test((err as Error).message),
      );

      // Now test seek game where seek preserves noShow until first move, and first move clears it
      const { game: gSeek, events: sInitEvents } = createManagedGame({
        fen: FEN_3PIECE,
        tc: TC_INCREMENT,
        source: 'seek',
        noShowAfterMs: 30000,
        at: 1000,
      });

      const pSeekW = prepareReady(gSeek, {
        color: 'w',
        at: 1100,
        operationId: 'op-seek-w',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      if (pSeekW.kind !== 'prepared') throw new Error('Expected prepared ready');
      const cSeek1 = new AdjudicationJobController();
      cSeek1.createJob(pSeekW, gSeek);
      stepUntilReady(cSeek1, pSeekW.operationId);
      const stSeekW: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gSeek.id,
        operationId: pSeekW.operationId,
        baseRevision: 0,
        at: 1100,
        rulesVersion: '1.0.0',
        prepared: pSeekW,
        clockPolicy: 'observed-release-v1',
      };
      const setSeekW = cSeek1.settleJob(gSeek.withEvents([stSeekW]), pSeekW.operationId, 1200);

      const sSeek1 = buildMatchingReleaseEvent(setSeekW.game, 'req-seek-rel-1', 1300);
      const relSeek1 = Game.fromEvents([...sInitEvents, stSeekW, setSeekW.resolved, ...setSeekW.effects, sSeek1]);

      const pSeekB = prepareReady(relSeek1, {
        color: 'b',
        at: 1400,
        operationId: 'op-seek-b',
        rulesVersion: '1.0.0',
      });
      if (pSeekB.kind !== 'prepared') throw new Error('Expected prepared ready');
      const cSeek2 = new AdjudicationJobController();
      cSeek2.createJob(pSeekB, relSeek1);
      stepUntilReady(cSeek2, pSeekB.operationId);
      const stSeekB: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: relSeek1.id,
        operationId: pSeekB.operationId,
        baseRevision: relSeek1.eventSequence,
        at: 1400,
        rulesVersion: '1.0.0',
        prepared: pSeekB,
        clockPolicy: 'observed-release-v1',
      };
      const setSeekB = cSeek2.settleJob(relSeek1.withEvents([stSeekB]), pSeekB.operationId, 1500);

      // Seek preserves noShow even when both ready!
      assert.notEqual(setSeekB.game.stoppedClock?.basis.noShowRemainderMs, null);

      // Release at S=2000
      const sSeek2 = buildMatchingReleaseEvent(setSeekB.game, 'req-seek-rel-2', 2000);
      const relSeek2 = Game.fromEvents([
        ...sInitEvents,
        stSeekW, setSeekW.resolved, ...setSeekW.effects, sSeek1,
        stSeekB, setSeekB.resolved, ...setSeekB.effects, sSeek2,
      ]);

      // Play move g6g5 at A=2500
      const prepMove = prepareMove(relSeek2, {
        uci: 'g6g5',
        at: 2500,
        operationId: 'op-first-move',
        rulesVersion: '1.0.0',
      });
      const ctrl3 = new AdjudicationJobController();
      ctrl3.createJob(prepMove, relSeek2);
      stepUntilReady(ctrl3, prepMove.operationId);

      const startedMove: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: relSeek2.id,
        operationId: prepMove.operationId,
        baseRevision: relSeek2.eventSequence,
        at: 2500,
        rulesVersion: '1.0.0',
        prepared: prepMove,
        clockPolicy: 'observed-release-v1',
      };
      const provMove = relSeek2.withEvents([startedMove]);
      const setMove = ctrl3.settleJob(provMove, prepMove.operationId, 2800);

      // After first move (ply 1), no-show is cleared permanently!
      assert.equal(setMove.game.ply, 1);
      assert.equal(setMove.game.stoppedClock?.basis.noShowRemainderMs, null);
    });
  });

  describe('Gate 6: Replay Parity Across JSON Serialization & Stored History', () => {
    test('JSON serialization/deserialization retains exact replay parity', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-json-parity', 2500);
      const fullEvents = [...historyEvents, sEvent];

      const jsonStr = JSON.stringify(fullEvents);
      const parsedEvents = JSON.parse(jsonStr) as GameEvent[];

      const fromParsed = Game.fromEvents(parsedEvents);
      const fromOriginal = Game.fromEvents(fullEvents);

      assert.equal(fromParsed.id, fromOriginal.id);
      assert.equal(fromParsed.eventSequence, fromOriginal.eventSequence);
      assert.equal(fromParsed.releasedClock?.consumedStopId, fromOriginal.releasedClock?.consumedStopId);
      assert.equal(fromParsed.releasedClock?.releasedAt, fromOriginal.releasedClock?.releasedAt);
      assert.equal(fromParsed.getReleaseReceipt('req-json-parity')?.at, 2500);
    });

    test('replayStoredHistory reproduces exact state matching Game.fromEvents', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-stored-parity', 2500);
      const fullEvents = [...historyEvents, sEvent];

      const fromReconstructed = Game.fromEvents(fullEvents);
      const fromStored = replayEventsStored(settledGame.id, fullEvents);

      assert.equal(fromStored.id, fromReconstructed.id);
      assert.equal(fromStored.eventSequence, fromReconstructed.eventSequence);
      assert.equal(fromStored.releasedClock?.consumedStopId, fromReconstructed.releasedClock?.consumedStopId);
      assert.equal(fromStored.getReleaseReceipt('req-stored-parity')?.at, 2500);
    });
  });

  describe('Gate 7: Stage K2 Reviewer Remediations & Trust-Boundary Hardening', () => {
    test('assertReleaseLineageMatch rejects event.rulesVersion differing from stopped.rulesVersion', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      assert.equal(settledGame.stoppedClock?.rulesVersion, '1.0.0');

      // Release event carrying mismatched rulesVersion '2.0.0'
      const sMismatched: AdjudicationClocksStartedEvent = {
        ...buildMatchingReleaseEvent(settledGame, 'req-rules-mismatch', 2500),
        rulesVersion: '2.0.0',
      };

      // 1) History reconstruction Game.fromEvents strictly rejects
      assert.throws(
        () => Game.fromEvents([...historyEvents, sMismatched]),
        (err: unknown) => err instanceof GameError && /rulesVersion mismatch: expected "1.0.0", got "2.0.0"/i.test((err as Error).message),
      );

      // 2) Standalone batch validation strictly rejects
      assert.throws(
        () => validateAdjudicationAppendBatch(settledGame, [sMismatched]),
        (err: unknown) => err instanceof GameError && /rulesVersion mismatch/i.test((err as Error).message),
      );

      // 3) Replay stored history strictly rejects
      assert.throws(
        () => replayEventsStored(settledGame.id, [...historyEvents, sMismatched]),
        (err: unknown) => err instanceof GameError && /rulesVersion mismatch/i.test((err as Error).message),
      );

      // 4) Release with valid rulesVersion succeeds, then retry with changed rulesVersion returns conflict
      const sValid = buildMatchingReleaseEvent(settledGame, 'req-rules-match', 2500);
      const relGame = Game.fromEvents([...historyEvents, sValid]);

      const conflictProposal: ReleaseProposalParams = {
        releaseRequestId: 'req-rules-match',
        gameId: sValid.gameId,
        stopId: sValid.stopId,
        originatingOperationId: sValid.originatingOperationId,
        originatingResolvedSeq: sValid.originatingResolvedSeq,
        completionHead: sValid.completionHead,
        expectedHead: sValid.expectedHead,
        turnLineageId: sValid.turnLineageId,
        side: sValid.side,
        ply: sValid.ply,
        at: sValid.at,
        clockPolicy: sValid.clockPolicy,
        rulesVersion: '2.0.0', // Differs from receipt rulesVersion '1.0.0'
      };
      const retryResult = inspectReleaseRetry(relGame, conflictProposal);
      assert.equal(retryResult.kind, 'conflict');
      assert.throws(
        () => assertReleaseRetryValid(relGame, conflictProposal),
        (err: unknown) => err instanceof GameError && /rulesVersion mismatch/i.test((err as Error).message),
      );
    });

    test('direct finite ply 0 release exposes active flagDeadline matching snapshot and timeoutDue', () => {
      // Direct finite game with 10s base time (B10000)
      const TC_10S: TimeControl = { kind: 'delay', initialMs: 10_000, incrementMs: 0, delayMs: 0 };
      const { settledGame, historyEvents } = produceSettledStoppedGame({
        tc: TC_10S,
        createdAt: 1000,
        admitAt: 1000,
        settleAt: 1500,
      });

      // Released at S=2500
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-ply0-flag', 2500);
      const releasedGame = Game.fromEvents([...historyEvents, sEvent]);

      assert.equal(releasedGame.ply, 0);
      assert.equal(releasedGame.releasedClock?.isChessApplicable, true);
      // Deadline is S + B = 2500 + 10000 = 12500
      assert.equal(releasedGame.flagDeadline, 12500);
      assert.equal(releasedGame.clockAccountingSnapshot(2500)?.flagDeadline, 12500);

      // Before deadline at 12499:
      assert.equal(releasedGame.timeoutDue(12499), false);
      assert.throws(
        () => prepareFlagExpiry(releasedGame, {
          flagged: 'w',
          at: 12499,
          operationId: 'op-flag-early',
          rulesVersion: '1.0.0',
        }),
        (err: unknown) => err instanceof GameError && /Flag has not fallen for w at 12499/i.test((err as Error).message),
      );

      // At deadline 12500:
      assert.equal(releasedGame.timeoutDue(12500), true);
      const prepFlag = prepareFlagExpiry(releasedGame, {
        flagged: 'w',
        at: 12500,
        operationId: 'op-flag-due',
        rulesVersion: '1.0.0',
      });
      assert.equal(prepFlag.intent.kind, 'expireFlag');
      assert.equal(prepFlag.at, 12500);

      // Compare with sourced unstarted game: chess clock is not applicable at ply 0
      const { settledGame: sourcedSettled, historyEvents: sourcedEvents } = produceSettledStoppedGame({
        source: 'seek',
        noShowAfterMs: 30000,
        createdAt: 1000,
        admitAt: 1000,
        settleAt: 1500,
      });
      const sSourced = buildMatchingReleaseEvent(sourcedSettled, 'req-sourced-rel', 2500);
      const sourcedRel = Game.fromEvents([...sourcedEvents, sSourced]);
      assert.equal(sourcedRel.releasedClock?.isChessApplicable, false);
      assert.equal(sourcedRel.flagDeadline, null); // Fake chess countdown avoided!
      assert.equal(sourcedRel.noShowDeadline, 2500 + 30000); // Independent noShow semantics intact
    });

    test('validates derived deadline bounds during admission rejecting safe-integer overflow', () => {
      // 1) Direct finite B1000 with S = MAX_SAFE_TIMESTAMP_MS overflows flag deadline
      const TC_1S: TimeControl = { kind: 'increment', initialMs: 1000, incrementMs: 0, delayMs: 0 };
      const { settledGame: gDirect, historyEvents: hDirect } = produceSettledStoppedGame({
        tc: TC_1S,
        createdAt: 1000,
        admitAt: 1000,
        settleAt: 1500,
      });
      const sOverflowDirect: AdjudicationClocksStartedEvent = {
        ...buildMatchingReleaseEvent(gDirect, 'req-over-direct', MAX_SAFE_TIMESTAMP_MS),
        at: MAX_SAFE_TIMESTAMP_MS,
      };
      assert.throws(
        () => Game.fromEvents([...hDirect, sOverflowDirect]),
        (err: unknown) => err instanceof GameError && /Flag deadline overflow/i.test((err as Error).message),
      );

      // 2) Sourced seek with noShowRemainder 600 with S = MAX_SAFE_TIMESTAMP_MS overflows noShow deadline
      const { settledGame: gSeek, historyEvents: hSeek } = produceSettledStoppedGame({
        source: 'seek',
        noShowAfterMs: 600,
        createdAt: 1000,
        admitAt: 1500,
        settleAt: 2000,
      });
      const sOverflowSeek: AdjudicationClocksStartedEvent = {
        ...buildMatchingReleaseEvent(gSeek, 'req-over-seek', MAX_SAFE_TIMESTAMP_MS),
        at: MAX_SAFE_TIMESTAMP_MS,
      };
      assert.throws(
        () => Game.fromEvents([...hSeek, sOverflowSeek]),
        (err: unknown) => err instanceof GameError && /No-show deadline overflow/i.test((err as Error).message),
      );

      // 3) Boundary value: S = MAX_SAFE_TIMESTAMP_MS - 1000 with B = 1000 is accepted with deadline MAX_SAFE_TIMESTAMP_MS
      const sBoundaryDirect: AdjudicationClocksStartedEvent = {
        ...buildMatchingReleaseEvent(gDirect, 'req-boundary-direct', MAX_SAFE_TIMESTAMP_MS - 1000),
        at: MAX_SAFE_TIMESTAMP_MS - 1000,
      };
      const gBoundary = Game.fromEvents([...hDirect, sBoundaryDirect]);
      assert.equal(gBoundary.releasedClock?.releasedAt, MAX_SAFE_TIMESTAMP_MS - 1000);
      assert.equal(gBoundary.flagDeadline, MAX_SAFE_TIMESTAMP_MS);
    });

    test('central preparation causal validation rejects backtime A < S across prepare APIs', () => {
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-causal-test', 5000);
      const releasedGame = Game.fromEvents([...historyEvents, sEvent]);

      assert.equal(releasedGame.releasedClock?.releasedAt, 5000);

      // All preparation APIs called with A = 4999 (< S = 5000) must reject BEFORE minting operation
      assert.throws(
        () => prepareMove(releasedGame, { uci: 'g6g5', at: 4999, operationId: 'op-move-back', rulesVersion: '1.0.0' }),
        (err: unknown) => err instanceof GameError && /Command timestamp 4999 cannot precede active release floor 5000/i.test((err as Error).message),
      );
      assert.throws(
        () => prepareDrawOffer(releasedGame, { color: 'w', at: 4999, operationId: 'op-offer-back', rulesVersion: '1.0.0' }),
        (err: unknown) => err instanceof GameError && /Command timestamp 4999 cannot precede active release floor 5000/i.test((err as Error).message),
      );
      assert.throws(
        () => prepareDrawDecline(releasedGame, { color: 'w', at: 4999, operationId: 'op-decline-back', rulesVersion: '1.0.0' }),
        (err: unknown) => err instanceof GameError && /Command timestamp 4999 cannot precede active release floor 5000/i.test((err as Error).message),
      );
      assert.throws(
        () => prepareResign(releasedGame, { color: 'w', at: 4999, operationId: 'op-resign-back', rulesVersion: '1.0.0' }),
        (err: unknown) => err instanceof GameError && /Command timestamp 4999 cannot precede active release floor 5000/i.test((err as Error).message),
      );
      assert.throws(
        () => prepareAbort(releasedGame, { at: 4999, operationId: 'op-abort-back', rulesVersion: '1.0.0' }),
        (err: unknown) => err instanceof GameError && /Command timestamp 4999 cannot precede active release floor 5000/i.test((err as Error).message),
      );
      assert.throws(
        () => prepareFlagExpiry(releasedGame, { flagged: 'w', at: 4999, operationId: 'op-flag-back', rulesVersion: '1.0.0' }),
        (err: unknown) => err instanceof GameError && /Command timestamp 4999 cannot precede active release floor 5000/i.test((err as Error).message),
      );

      // Verify at A = 5000 preparation succeeds
      const prepValid = prepareMove(releasedGame, { uci: 'g6g5', at: 5000, operationId: 'op-move-at-s', rulesVersion: '1.0.0' });
      assert.equal(prepValid.at, 5000);

      // Verify preparation rejection and Started rejection are tested independently:
      // A manually forged Started event with at = 4999 is independently rejected by assertStartedTopLevel
      const forgedStarted: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: releasedGame.id,
        operationId: 'forged-op',
        baseRevision: releasedGame.eventSequence,
        at: 4999,
        rulesVersion: '1.0.0',
        prepared: { ...prepValid, at: 4999 },
        clockPolicy: 'observed-release-v1',
      };
      assert.throws(
        () => releasedGame.withEvents([forgedStarted]),
        (err: unknown) => err instanceof GameError && /Suspension timestamp 4999 cannot precede active causal basis 5000/i.test((err as Error).message),
      );
    });

    test('assertReleaseProposalShape rejects non-objects, primitives, and malformed field types', () => {
      assert.throws(
        () => assertReleaseProposalShape(null as unknown as ReleaseProposalParams),
        (err: unknown) => err instanceof GameError && /non-null object/i.test((err as Error).message),
      );
      assert.throws(
        () => assertReleaseProposalShape(undefined as unknown as ReleaseProposalParams),
        (err: unknown) => err instanceof GameError && /non-null object/i.test((err as Error).message),
      );
      assert.throws(
        () => assertReleaseProposalShape([] as unknown as ReleaseProposalParams),
        (err: unknown) => err instanceof GameError && /non-null object/i.test((err as Error).message),
      );
      assert.throws(
        () => assertReleaseProposalShape('malformed' as unknown as ReleaseProposalParams),
        (err: unknown) => err instanceof GameError && /non-null object/i.test((err as Error).message),
      );

      const validProposal: ReleaseProposalParams = {
        releaseRequestId: 'req-valid',
        gameId: 'game-1',
        stopId: 'stop-1',
        originatingOperationId: 'op-1',
        originatingResolvedSeq: 1,
        completionHead: 2,
        expectedHead: 2,
        turnLineageId: 'lineage-1',
        side: 'w',
        ply: 0,
        at: 2000,
        clockPolicy: 'observed-release-v1',
        rulesVersion: '1.0.0',
      };
      assert.doesNotThrow(() => assertReleaseProposalShape(validProposal));

      assert.throws(
        () => assertReleaseProposalShape({ ...validProposal, side: 'invalid' as Color }),
        (err: unknown) => err instanceof GameError && /Invalid side/i.test((err as Error).message),
      );
      assert.throws(
        () => assertReleaseProposalShape({ ...validProposal, originatingOperationId: '' }),
        (err: unknown) => err instanceof GameError && /originatingOperationId must be a non-empty string/i.test((err as Error).message),
      );
      assert.throws(
        () => assertReleaseProposalShape({ ...validProposal, turnLineageId: '' }),
        (err: unknown) => err instanceof GameError && /turnLineageId must be a non-empty string/i.test((err as Error).message),
      );
      assert.throws(
        () => assertReleaseProposalShape({ ...validProposal, rulesVersion: '' }),
        (err: unknown) => err instanceof GameError && /rulesVersion must be a non-empty string/i.test((err as Error).message),
      );
    });

    test('full continuation replay parity between Game.fromEvents JSON history and replayStoredHistory across 4 completion exits', () => {
      // Setup stopped game, release at S=2500
      const { settledGame, historyEvents } = produceSettledStoppedGame({ settleAt: 2000 });
      const sEvent = buildMatchingReleaseEvent(settledGame, 'req-continuation-s', 2500);

      // --- EXIT 2: Move completion continuation ---
      const relGame = Game.fromEvents([...historyEvents, sEvent]);
      const prepMove = prepareMove(relGame, { uci: 'g6g5', at: 3000, operationId: 'op-move-cont', rulesVersion: '1.0.0' });
      const ctrlMove = new AdjudicationJobController();
      ctrlMove.createJob(prepMove, relGame);
      stepUntilReady(ctrlMove, prepMove.operationId);
      const stMove: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: relGame.id,
        operationId: prepMove.operationId,
        baseRevision: relGame.eventSequence,
        at: 3000,
        rulesVersion: '1.0.0',
        prepared: prepMove,
        clockPolicy: 'observed-release-v1',
      };
      const setMove = ctrlMove.settleJob(relGame.withEvents([stMove]), prepMove.operationId, 3200);
      const fullMoveEvents: GameEvent[] = [
        ...historyEvents,
        sEvent,
        stMove,
        setMove.resolved,
        ...setMove.effects,
      ];

      // JSON round-trip
      const parsedMoveEvents = JSON.parse(JSON.stringify(fullMoveEvents)) as GameEvent[];
      const fromParsedMove = Game.fromEvents(parsedMoveEvents);
      const fromStoredMove = replayEventsStored(relGame.id, fullMoveEvents);

      assert.equal(fromStoredMove.id, fromParsedMove.id);
      assert.equal(fromStoredMove.eventSequence, fromParsedMove.eventSequence);
      assert.equal(fromStoredMove.ply, 1);
      assert.equal(fromStoredMove.ply, fromParsedMove.ply);
      assert.equal(fromStoredMove.fen, fromParsedMove.fen);
      assert.equal(fromStoredMove.stoppedClock?.stopId, fromParsedMove.stoppedClock?.stopId);
      assert.equal(fromStoredMove.stoppedClock?.basis.turnBaseBalances.w, fromParsedMove.stoppedClock?.basis.turnBaseBalances.w);
      assert.equal(fromStoredMove.stoppedClock?.basis.turnBaseBalances.b, fromParsedMove.stoppedClock?.basis.turnBaseBalances.b);
      assert.equal(fromStoredMove.getReleaseReceipt('req-continuation-s')?.at, 2500);
      assert.equal(fromParsedMove.getReleaseReceipt('req-continuation-s')?.at, 2500);

      // --- EXIT 4: Terminal game over continuation (resignation) ---
      const sEvent2 = buildMatchingReleaseEvent(setMove.game, 'req-s-terminal', 4000);
      const relGame2 = Game.fromEvents([...fullMoveEvents, sEvent2]);
      const prepResign = prepareResign(relGame2, { color: 'b', at: 4500, operationId: 'op-resign-cont', rulesVersion: '1.0.0' });
      const ctrlResign = new AdjudicationJobController();
      ctrlResign.createJob(prepResign, relGame2);
      stepUntilReady(ctrlResign, prepResign.operationId);
      const stResign: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: relGame2.id,
        operationId: prepResign.operationId,
        baseRevision: relGame2.eventSequence,
        at: 4500,
        rulesVersion: '1.0.0',
        prepared: prepResign,
        clockPolicy: 'observed-release-v1',
      };
      const setResign = ctrlResign.settleJob(relGame2.withEvents([stResign]), prepResign.operationId, 4700);
      const fullResignEvents: GameEvent[] = [
        ...fullMoveEvents,
        sEvent2,
        stResign,
        setResign.resolved,
        ...setResign.effects,
      ];

      const parsedResignEvents = JSON.parse(JSON.stringify(fullResignEvents)) as GameEvent[];
      const fromParsedResign = Game.fromEvents(parsedResignEvents);
      const fromStoredResign = replayEventsStored(relGame2.id, fullResignEvents);

      assert.equal(fromStoredResign.status.over, true);
      assert.equal(fromParsedResign.status.over, true);
      assert.equal(fromStoredResign.status.winner, 'w');
      assert.equal(fromParsedResign.status.winner, 'w');
      assert.equal(fromStoredResign.eventSequence, fromParsedResign.eventSequence);
      assert.equal(fromStoredResign.stoppedClock, null);
      assert.equal(fromParsedResign.stoppedClock, null);
      assert.equal(fromStoredResign.releaseNeeded, false);
      assert.equal(fromParsedResign.releaseNeeded, false);
    });
  });
});
