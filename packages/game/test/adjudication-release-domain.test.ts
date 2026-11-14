import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Position,
  type Color,
} from '@chess-platform/core';
import {
  Game,
  GameError,
  prepareCreationAdmission,
  prepareMove,
  prepareReady,
  prepareDrawOffer,
  prepareDrawDecline,
  prepareDrawAccept,
  prepareResign,
  prepareFlagExpiry,
  prepareNoShowExpiry,
  prepareAuthoritativeCommand,
  settlePrepared,
  validateAdjudicationAppendBatch,
  createAdjudicationClockBasis,
  deriveTurnLineageId,
  type AdjudicationClockCompletionDescriptor,
  type AdjudicationClockPolicy,
  type GameEvent,
  type MovePlayedEvent,
  type PreparedOperation,
  type TimeControl,
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

// Initial standard chess position
const FEN_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Mate in 1 position: Queen on e7, King on g6 vs Black King on h8 -> e7g7#
const FEN_MATE1 = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';

// 3-piece endgame position: Queen on g6, King on f7 vs Black King on h8 -> g6g5 (non-terminal)
const FEN_3PIECE = '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1';

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
    gameId: params.gameId ?? 'r1-domain-test',
    variant: 'standard',
    initialFen: params.fen ?? FEN_MATE1,
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

function replayEventsStored(gameId: string, events: readonly GameEvent[]): Game {
  const rows: StoredHistoryRow[] = events.map((event, i) => ({
    gameId,
    seq: i,
    version: 1,
    event,
  }));
  return replayStoredHistory(gameId, rows).game;
}

describe('R1 Domain Lifecycle: Observed Release Clock Accounting & Stopped Completion', () => {
  describe('Suite 1: Policy Admission & Fractional/Bounds Rejection', () => {
    test('rejects fractional initialMs under observed-release-v1 BEFORE Started', () => {
      const tcFrac: TimeControl = {
        kind: 'increment',
        initialMs: 60000.5,
        incrementMs: 2000,
        delayMs: 0,
      };
      const { game } = createManagedGame({ tc: tcFrac });
      assert.throws(
        () => prepareCreationAdmission(game, {
          operationId: 'op-frac-init',
          rulesVersion: '1.0.0',
          at: 1000,
          clockPolicy: 'observed-release-v1',
        }),
        (err: unknown) => err instanceof GameError && /fractional|incompatible|integer/i.test((err as Error).message),
      );
    });

    test('rejects fractional incrementMs under observed-release-v1 BEFORE Started', () => {
      const tcFrac: TimeControl = {
        kind: 'increment',
        initialMs: 60000,
        incrementMs: 2000.25,
        delayMs: 0,
      };
      const { game } = createManagedGame({ tc: tcFrac });
      assert.throws(
        () => prepareCreationAdmission(game, {
          operationId: 'op-frac-inc',
          rulesVersion: '1.0.0',
          at: 1000,
          clockPolicy: 'observed-release-v1',
        }),
        (err: unknown) => err instanceof GameError && /fractional|incompatible|integer/i.test((err as Error).message),
      );
    });

    test('rejects fractional delayMs under observed-release-v1 BEFORE Started', () => {
      const tcFrac: TimeControl = {
        kind: 'delay',
        initialMs: 60000,
        incrementMs: 0,
        delayMs: 500.5,
      };
      const { game } = createManagedGame({ tc: tcFrac });
      assert.throws(
        () => prepareCreationAdmission(game, {
          operationId: 'op-frac-delay',
          rulesVersion: '1.0.0',
          at: 1000,
          clockPolicy: 'observed-release-v1',
        }),
        (err: unknown) => err instanceof GameError && /fractional|incompatible|integer/i.test((err as Error).message),
      );
    });

    test('rejects MAX_SAFE_INTEGER time control bounds under observed-release-v1 BEFORE Started', () => {
      const tcBig: TimeControl = {
        kind: 'increment',
        initialMs: 1000,
        incrementMs: Number.MAX_SAFE_INTEGER,
        delayMs: 0,
      };
      const { game } = createManagedGame({ tc: tcBig });
      assert.throws(
        () => prepareCreationAdmission(game, {
          operationId: 'op-max-inc',
          rulesVersion: '1.0.0',
          at: 1000,
          clockPolicy: 'observed-release-v1',
        }),
        (err: unknown) => err instanceof GameError && /must be a non-negative safe integer <=/i.test((err as Error).message),
      );
    });

    test('preserves legacy fractional admission when policy marker is absent', () => {
      const tcFrac: TimeControl = {
        kind: 'increment',
        initialMs: 60000.5,
        incrementMs: 2000.25,
        delayMs: 0,
      };
      const { game } = createManagedGame({ tc: tcFrac });
      const prepared = prepareCreationAdmission(game, {
        operationId: 'op-legacy-frac',
        rulesVersion: '1.0.0',
        at: 1000,
      });
      assert.equal(prepared.clockPolicy, undefined);
    });

    test('rejects unknown policy string', () => {
      const { game } = createManagedGame();
      assert.throws(
        () => prepareCreationAdmission(game, {
          operationId: 'op-unknown-pol',
          rulesVersion: '1.0.0',
          at: 1000,
          clockPolicy: 'future-policy-v2' as unknown as AdjudicationClockPolicy,
        }),
        (err: unknown) => err instanceof GameError && /policy/i.test((err as Error).message),
      );
    });
  });

  describe('Suite 2: All 4 Completion Exits under observed-release-v1', () => {
    test('Exit 1: Zero-effect creationAdmission installs stopped clock with nonterminal descriptor', () => {
      const { game } = createManagedGame();
      const prepared = prepareCreationAdmission(game, {
        operationId: 'op-create-adm',
        rulesVersion: '1.0.0',
        at: 1000,
        clockPolicy: 'observed-release-v1',
      });
      assert.equal(prepared.clockPolicy, 'observed-release-v1');

      const controller = new AdjudicationJobController();
      controller.createJob(prepared, game);
      stepUntilReady(controller, prepared.operationId);
      assert.equal(controller.getJob(prepared.operationId)?.status, 'ready');

      const startedEvent: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: game.id,
        operationId: prepared.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared,
        clockPolicy: 'observed-release-v1',
      };
      const provingGame = game.withEvents([startedEvent]);
      assert.equal(provingGame.phase, 'proving');
      assert.equal(provingGame.isBlocked, true);

      const settlement = controller.settleJob(provingGame, prepared.operationId, 1200);
      assert.equal(settlement.resolved.clockCompletion?.kind, 'stopped');
      assert.equal(settlement.resolved.clockCompletion?.policy, 'observed-release-v1');
      assert.equal(settlement.resolved.clockCompletion?.runningSince, null);
      assert.equal(settlement.resolved.clockCompletion?.startedSeq, 1);
      assert.equal(settlement.resolved.clockCompletion?.resolvedSeq, 2);
      assert.equal(settlement.resolved.clockCompletion?.completionHead, 2);

      const settledGame = settlement.game;
      assert.equal(settledGame.phase, 'idle');
      assert.equal(settledGame.isBlocked, false);
      assert.equal(settledGame.clockPolicy, 'observed-release-v1');
      assert.notEqual(settledGame.stoppedClock, null);
      assert.equal(settledGame.stoppedClock?.basis.runningSince, null);
      assert.equal(settledGame.flagDeadline, null);
      assert.equal(settledGame.clock.turnStartedAt, null);
    });

    test('Exit 2: Final move (foldMove) applies active elapsed, increment once, E0 for opponent, stops clocks', () => {
      const { game: baseGame } = createManagedGame({ fen: FEN_3PIECE, tc: TC_INCREMENT, at: 1000 });
      const prepared = prepareMove(baseGame, {
        uci: 'g6g5',
        at: 3000, // 2000 ms elapsed
        operationId: 'op-move-g5',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      assert.equal(prepared.clockPolicy, 'observed-release-v1');

      const controller = new AdjudicationJobController();
      controller.createJob(prepared, baseGame);
      stepUntilReady(controller, prepared.operationId);
      assert.equal(controller.getJob(prepared.operationId)?.status, 'ready');

      const startedEvent: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepared.operationId,
        baseRevision: 0,
        at: 3000,
        rulesVersion: '1.0.0',
        prepared,
        clockPolicy: 'observed-release-v1',
      };
      const provingGame = baseGame.withEvents([startedEvent]);
      const settlement = controller.settleJob(provingGame, prepared.operationId, 3500);

      assert.equal(settlement.resolved.clockCompletion?.kind, 'stopped');
      assert.equal(settlement.effects.length, 1);
      const moveEffect = settlement.effects[0];
      assert.equal(moveEffect.type, 'MovePlayed');
      if (moveEffect.type === 'MovePlayed') {
        assert.equal(moveEffect.moveTimeMs, 2000); // Only active thinking charged!
        assert.equal(moveEffect.remaining.w, 60000); // 60000 - 2000 + 2000 increment = 60000
      }

      const settledGame = settlement.game;
      assert.equal(settledGame.ply, 1);
      assert.equal(settledGame.turn, 'b');
      assert.equal(settledGame.clockPolicy, 'observed-release-v1');
      assert.equal(settledGame.clock.turnStartedAt, null);
      assert.equal(settledGame.stoppedClock?.basis.elapsedThinkingMs, 0); // Opponent starts with E=0
    });

    test('Exit 3: Non-move intermediate effect keeps clocks stopped and preserves turn lineage', () => {
      const { game: baseGame } = createManagedGame({ fen: FEN_3PIECE, at: 1000 });
      const prepOffer = prepareDrawOffer(baseGame, {
        color: 'w',
        at: 2000, // 1000 ms elapsed
        operationId: 'op-offer-draw',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const controller = new AdjudicationJobController();
      controller.createJob(prepOffer, baseGame);
      stepUntilReady(controller, prepOffer.operationId);

      const startedEvent: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepOffer.operationId,
        baseRevision: 0,
        at: 2000,
        rulesVersion: '1.0.0',
        prepared: prepOffer,
        clockPolicy: 'observed-release-v1',
      };
      const settlement = controller.settleJob(baseGame.withEvents([startedEvent]), prepOffer.operationId, 2200);

      const gameOffered = settlement.game;
      assert.equal(gameOffered.phase, 'idle');
      assert.equal(gameOffered.clockPolicy, 'observed-release-v1');
      assert.equal(gameOffered.clock.turnStartedAt, null);
      assert.equal(gameOffered.stoppedClock?.basis.elapsedThinkingMs, 1000); // Retained active thinking
    });

    test('Exit 4: Terminal game-ended clears release obligation and emits terminal descriptor', () => {
      const { game: baseGame } = createManagedGame({ fen: FEN_3PIECE, at: 1000 });
      const prepResign = prepareResign(baseGame, {
        color: 'w',
        at: 2000,
        operationId: 'op-resign-exit4',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const controller = new AdjudicationJobController();
      controller.createJob(prepResign, baseGame);
      stepUntilReady(controller, prepResign.operationId);

      const startedEvent: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepResign.operationId,
        baseRevision: 0,
        at: 2000,
        rulesVersion: '1.0.0',
        prepared: prepResign,
        clockPolicy: 'observed-release-v1',
      };
      const settlement = controller.settleJob(baseGame.withEvents([startedEvent]), prepResign.operationId, 2100);

      assert.equal(settlement.resolved.clockCompletion?.kind, 'terminal');
      assert.equal(settlement.game.phase, 'ended');
      assert.equal(settlement.game.releaseNeeded, false);
      assert.equal(settlement.game.stoppedClock, null);
    });

    test('offer -> stopped -> mating move verifies 890 (increment) and 940 (delay) without double debit', () => {
      // 1. Increment TC: 1000 / inc 50
      const tcInc: TimeControl = { kind: 'increment', initialMs: 1000, incrementMs: 50, delayMs: 0 };
      const { game: g1 } = createManagedGame({ fen: FEN_MATE1, tc: tcInc, at: 1000 });
      const prepOffer1 = prepareDrawOffer(g1, {
        color: 'w',
        at: 1160,
        operationId: 'op-offer-inc',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const c1 = new AdjudicationJobController();
      c1.createJob(prepOffer1, g1);
      stepUntilReady(c1, prepOffer1.operationId);
      const s1: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: g1.id,
        operationId: prepOffer1.operationId,
        baseRevision: 0,
        at: 1160,
        rulesVersion: '1.0.0',
        prepared: prepOffer1,
        clockPolicy: 'observed-release-v1',
      };
      const gStopped1 = c1.settleJob(g1.withEvents([s1]), prepOffer1.operationId, 1500).game;
      assert.equal(gStopped1.stoppedClock?.basis.elapsedThinkingMs, 160);

      // Now White plays e7g7# at 2000, settled at 2500
      const prepMate1 = prepareMove(gStopped1, {
        uci: 'e7g7',
        at: 2000,
        operationId: 'op-mate-inc',
        rulesVersion: '1.0.0',
      });
      const c2 = new AdjudicationJobController();
      c2.createJob(prepMate1, gStopped1);
      stepUntilReady(c2, prepMate1.operationId);
      const s2: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gStopped1.id,
        operationId: prepMate1.operationId,
        baseRevision: gStopped1.eventSequence,
        at: 2000,
        rulesVersion: '1.0.0',
        prepared: prepMate1,
        clockPolicy: 'observed-release-v1',
      };
      const proving2 = gStopped1.withEvents([s2]);
      const set2 = c2.settleJob(proving2, prepMate1.operationId, 2500);

      // Expected: 1000 - 160 = 840 + 50 = 890
      const moveEff1 = set2.effects[0] as MovePlayedEvent;
      assert.equal(moveEff1.remaining.w, 890);
      assert.equal(set2.game.clock.remaining.w, 890);

      // Move-only prefix check:
      const moveOnlyPrefix = proving2.withEvents([set2.resolved, moveEff1]);
      assert.equal(moveOnlyPrefix.clock.remaining.w, 890);

      // 2. Delay TC: 1000 / delay 100
      const tcDel: TimeControl = { kind: 'delay', initialMs: 1000, incrementMs: 0, delayMs: 100 };
      const { game: gDel } = createManagedGame({ fen: FEN_MATE1, tc: tcDel, at: 1000 });
      const prepOfferDel = prepareDrawOffer(gDel, {
        color: 'w',
        at: 1160,
        operationId: 'op-offer-del',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const cDel1 = new AdjudicationJobController();
      cDel1.createJob(prepOfferDel, gDel);
      stepUntilReady(cDel1, prepOfferDel.operationId);
      const sDel1: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gDel.id,
        operationId: prepOfferDel.operationId,
        baseRevision: 0,
        at: 1160,
        rulesVersion: '1.0.0',
        prepared: prepOfferDel,
        clockPolicy: 'observed-release-v1',
      };
      const gStoppedDel = cDel1.settleJob(gDel.withEvents([sDel1]), prepOfferDel.operationId, 1500).game;

      const prepMateDel = prepareMove(gStoppedDel, {
        uci: 'e7g7',
        at: 2000,
        operationId: 'op-mate-del',
        rulesVersion: '1.0.0',
      });
      const cDel2 = new AdjudicationJobController();
      cDel2.createJob(prepMateDel, gStoppedDel);
      stepUntilReady(cDel2, prepMateDel.operationId);
      const sDel2: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gStoppedDel.id,
        operationId: prepMateDel.operationId,
        baseRevision: gStoppedDel.eventSequence,
        at: 2000,
        rulesVersion: '1.0.0',
        prepared: prepMateDel,
        clockPolicy: 'observed-release-v1',
      };
      const provingDel = gStoppedDel.withEvents([sDel2]);
      const setDel2 = cDel2.settleJob(provingDel, prepMateDel.operationId, 2500);

      // Expected: 1000 - max(0, 160 - 100) = 1000 - 60 = 940
      const moveEffDel = setDel2.effects[0] as MovePlayedEvent;
      assert.equal(moveEffDel.remaining.w, 940);
      assert.equal(setDel2.game.clock.remaining.w, 940);
      const moveOnlyDelPrefix = provingDel.withEvents([setDel2.resolved, moveEffDel]);
      assert.equal(moveOnlyDelPrefix.clock.remaining.w, 940);
    });

    test('managed terminal resignation clears effective no-show deadline', () => {
      const { game: baseGame } = createManagedGame({
        fen: FEN_3PIECE,
        source: 'seek',
        noShowAfterMs: 30000,
        at: 1000,
      });
      assert.equal(baseGame.noShowDeadline, 31000);

      const prepResign = prepareResign(baseGame, {
        color: 'w',
        at: 1500,
        operationId: 'op-resign-noshow',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(prepResign, baseGame);
      stepUntilReady(ctrl, prepResign.operationId);

      const started: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepResign.operationId,
        baseRevision: 0,
        at: 1500,
        rulesVersion: '1.0.0',
        prepared: prepResign,
        clockPolicy: 'observed-release-v1',
      };
      const set = ctrl.settleJob(baseGame.withEvents([started]), prepResign.operationId, 1700);
      assert.equal(set.game.status.over, true);
      assert.equal(set.game.noShowDeadline, null);
    });
  });

  describe('Suite 3: Prefixes & Append Suffix Checks', () => {
    test('rejects piggybacking next AdjudicationStarted after declared resolution suffix, but allows concatenated full history replay', () => {
      const { game: baseGame, events: baseEvents } = createManagedGame({ fen: FEN_3PIECE, at: 1000 });
      const prepared = prepareCreationAdmission(baseGame, {
        operationId: 'op-suffix-adm',
        rulesVersion: '1.0.0',
        at: 1000,
        clockPolicy: 'observed-release-v1',
      });
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(prepared, baseGame);
      stepUntilReady(ctrl, prepared.operationId);

      const started: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepared.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared,
        clockPolicy: 'observed-release-v1',
      };
      const proving = baseGame.withEvents([started]);
      const set = ctrl.settleJob(proving, prepared.operationId, 1100);

      // Otherwise valid next prepared operation on the settled game
      const nextPrep = prepareDrawOffer(set.game, {
        color: 'w',
        at: 1200,
        operationId: 'op-next-valid',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const nextStarted: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: nextPrep.operationId,
        baseRevision: set.game.eventSequence,
        at: 1200,
        rulesVersion: '1.0.0',
        prepared: nextPrep,
        clockPolicy: 'observed-release-v1',
      };

      // 1. Single append batch cannot piggyback the next Started
      assert.throws(
        () => validateAdjudicationAppendBatch(proving, [...set.batch, nextStarted]),
        (err: unknown) => err instanceof GameError && /declared resolution suffix/i.test(err.message),
      );

      // 2. Separate valid resolution batch succeeds and full concatenated history replays cleanly
      const ctrl2 = new AdjudicationJobController();
      ctrl2.createJob(nextPrep, set.game);
      stepUntilReady(ctrl2, nextPrep.operationId);
      const nextProving = set.game.withEvents([nextStarted]);
      const set2 = ctrl2.settleJob(nextProving, nextPrep.operationId, 1300);

      const fullHistory = [...baseEvents, started, ...set.batch, nextStarted, ...set2.batch];
      const fromEventsGame = Game.fromEvents(fullHistory);
      assert.equal(fromEventsGame.eventSequence, fullHistory.length - 1);
      const fromStoredGame = replayEventsStored(baseGame.id, fullHistory);
      assert.equal(fromStoredGame.eventSequence, fullHistory.length - 1);
      assert.equal(fromStoredGame.stoppedClock?.basis.turnBaseBalances.w, set2.game.stoppedClock?.basis.turnBaseBalances.w);
    });

    test('every incomplete move-plus-ending prefix remains blocked and settling', () => {
      const { game: baseGame } = createManagedGame({ fen: FEN_MATE1, at: 1000 });
      const prepMate = prepareMove(baseGame, {
        uci: 'e7g7',
        at: 2000,
        operationId: 'op-prefix-mate',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(prepMate, baseGame);
      stepUntilReady(ctrl, prepMate.operationId);

      const started: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepMate.operationId,
        baseRevision: 0,
        at: 2000,
        rulesVersion: '1.0.0',
        prepared: prepMate,
        clockPolicy: 'observed-release-v1',
      };
      const proving = baseGame.withEvents([started]);
      const set = ctrl.settleJob(proving, prepMate.operationId, 2500);

      assert.equal(set.effects.length, 2); // MovePlayed + GameEnded
      const prefix1 = proving.withEvents([set.resolved]);
      assert.equal(prefix1.phase, 'settling');
      assert.equal(prefix1.isBlocked, true);

      const prefix2 = proving.withEvents([set.resolved, set.effects[0]]);
      assert.equal(prefix2.phase, 'settling');
      assert.equal(prefix2.isBlocked, true);
    });
  });

  describe('Suite 4: Idle & Stopped Bypass Defense', () => {
    test('managed game rejects unmanaged direct mutation methods', () => {
      const { game: baseGame } = createManagedGame({ fen: FEN_3PIECE, at: 1000 });
      const prepAdm = prepareCreationAdmission(baseGame, {
        operationId: 'op-direct-bypass',
        rulesVersion: '1.0.0',
        at: 1000,
        clockPolicy: 'observed-release-v1',
      });
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(prepAdm, baseGame);
      stepUntilReady(ctrl, prepAdm.operationId);

      const started: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepAdm.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared: prepAdm,
        clockPolicy: 'observed-release-v1',
      };
      const stoppedGame = ctrl.settleJob(baseGame.withEvents([started]), prepAdm.operationId, 1100).game;

      assert.throws(
        () => stoppedGame.playMove('g6g5', 1200),
        (err: unknown) => err instanceof GameError && /managed|unmanaged/i.test((err as Error).message),
      );
      assert.throws(
        () => stoppedGame.resign('w', 1200),
        (err: unknown) => err instanceof GameError && /managed|unmanaged/i.test((err as Error).message),
      );
    });

    test('raw MovePlayed on legal board cannot bypass managed live or stored route', () => {
      const { game: baseGame, events: baseEvents } = createManagedGame({ fen: FEN_3PIECE, at: 1000 });
      const prepAdm = prepareCreationAdmission(baseGame, {
        operationId: 'op-raw-stored',
        rulesVersion: '1.0.0',
        at: 1000,
        clockPolicy: 'observed-release-v1',
      });
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(prepAdm, baseGame);
      stepUntilReady(ctrl, prepAdm.operationId);

      const started: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepAdm.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared: prepAdm,
        clockPolicy: 'observed-release-v1',
      };
      const set = ctrl.settleJob(baseGame.withEvents([started]), prepAdm.operationId, 1100);
      const stoppedGame = set.game;

      // Legally sound MovePlayed: g6g5
      const rawMove: GameEvent = {
        type: 'MovePlayed',
        ply: 1,
        uci: 'g6g5',
        san: 'Qg5',
        by: 'w',
        moveTimeMs: 100,
        remaining: { w: 59900, b: 60000 },
        at: 1200,
      };

      // 1. Live route rejected
      assert.throws(
        () => stoppedGame.withEvents([rawMove]),
        (err: unknown) => err instanceof GameError && /bypass managed adjudication route/i.test(err.message),
      );

      // 2. Stored history replay route rejected
      const historyWithBypass: GameEvent[] = [
        ...baseEvents,
        started,
        ...set.batch,
        rawMove,
      ];
      assert.throws(
        () => replayEventsStored(baseGame.id, historyWithBypass),
        (err: unknown) => err instanceof GameError && /bypass managed adjudication route/i.test(err.message),
      );

      // 3. Legacy control without clockPolicy successfully replays raw MovePlayed
      const legacyCreated = Game.create({
        gameId: 'legacy-control',
        variant: 'standard',
        initialFen: FEN_3PIECE,
        players: { white: 'alice', black: 'bob' },
        at: 1000,
        timeControl: { kind: 'sudden_death', initialMs: 60000, incrementMs: 0, delayMs: 0 },
      });
      const legacyRawMove: GameEvent = {
        type: 'MovePlayed',
        ply: 1,
        uci: 'g6g5',
        san: 'Qg5',
        by: 'w',
        moveTimeMs: 100,
        remaining: { w: 59900, b: 60000 },
        at: 1200,
      };
      const replayedLegacy = replayEventsStored(legacyCreated.game.id, [...legacyCreated.events, legacyRawMove]);
      assert.equal(replayedLegacy.ply, 1);
    });
  });

  describe('Suite 5: Accounting Invariance, Expiry Arbitration & Release Matrix', () => {
    test('delay preserved across offer -> decline -> held move sequence with E<D, E=D, E>D', () => {
      const tcDel: TimeControl = { kind: 'delay', initialMs: 1000, incrementMs: 0, delayMs: 100 };

      // Execute across E = 40 (E < D), E = 100 (E = D), and E = 160 (E > D)
      const testCases = [
        { e: 40, expectedCharge: 0, expectedRemaining: 1000 },
        { e: 100, expectedCharge: 0, expectedRemaining: 1000 },
        { e: 160, expectedCharge: 60, expectedRemaining: 940 },
      ];

      for (const tc of testCases) {
        const { game: gBase } = createManagedGame({ fen: FEN_3PIECE, tc: tcDel, at: 1000 });
        const offerAt = 1000 + tc.e;

        const pOffer = prepareDrawOffer(gBase, {
          color: 'w',
          at: offerAt,
          operationId: `op-d-offer-${tc.e}`,
          rulesVersion: '1.0.0',
          clockPolicy: 'observed-release-v1',
        });
        const cOffer = new AdjudicationJobController();
        cOffer.createJob(pOffer, gBase);
        stepUntilReady(cOffer, pOffer.operationId);
        const sOffer: GameEvent = {
          type: 'AdjudicationStarted',
          gameId: gBase.id,
          operationId: pOffer.operationId,
          baseRevision: 0,
          at: offerAt,
          rulesVersion: '1.0.0',
          prepared: pOffer,
          clockPolicy: 'observed-release-v1',
        };
        const gStopped1 = cOffer.settleJob(gBase.withEvents([sOffer]), pOffer.operationId, offerAt + 100).game;
        assert.equal(gStopped1.stoppedClock?.basis.elapsedThinkingMs, tc.e);

        const declineAt = offerAt + 200;
        const pDecline = prepareDrawDecline(gStopped1, {
          color: 'b',
          at: declineAt,
          operationId: `op-d-decline-${tc.e}`,
          rulesVersion: '1.0.0',
        });
        const cDecline = new AdjudicationJobController();
        cDecline.createJob(pDecline, gStopped1);
        stepUntilReady(cDecline, pDecline.operationId);
        const sDecline: GameEvent = {
          type: 'AdjudicationStarted',
          gameId: gStopped1.id,
          operationId: pDecline.operationId,
          baseRevision: gStopped1.eventSequence,
          at: declineAt,
          rulesVersion: '1.0.0',
          prepared: pDecline,
          clockPolicy: 'observed-release-v1',
        };
        const gStopped2 = cDecline.settleJob(gStopped1.withEvents([sDecline]), pDecline.operationId, declineAt + 100).game;
        assert.equal(gStopped2.stoppedClock?.basis.elapsedThinkingMs, tc.e);

        const moveAt = declineAt + 200;
        const pMove = prepareMove(gStopped2, {
          uci: 'g6g5',
          at: moveAt,
          operationId: `op-d-move-${tc.e}`,
          rulesVersion: '1.0.0',
        });
        const cMove = new AdjudicationJobController();
        cMove.createJob(pMove, gStopped2);
        stepUntilReady(cMove, pMove.operationId);
        const sMove: GameEvent = {
          type: 'AdjudicationStarted',
          gameId: gStopped2.id,
          operationId: pMove.operationId,
          baseRevision: gStopped2.eventSequence,
          at: moveAt,
          rulesVersion: '1.0.0',
          prepared: pMove,
          clockPolicy: 'observed-release-v1',
        };
        const setMove = cMove.settleJob(gStopped2.withEvents([sMove]), pMove.operationId, moveAt + 100);
        const moveEff = setMove.effects[0] as MovePlayedEvent;
        assert.equal(moveEff.remaining.w, tc.expectedRemaining);
        assert.equal(setMove.game.clock.remaining.w, tc.expectedRemaining);
      }
    });

    test('releaseNeeded matrix: tournament both-ready vs seek both-ready vs direct ply0 vs unlimited', () => {
      // 1. Tournament both ready before first move -> releaseNeeded === false
      const { game: gTourn } = createManagedGame({ source: 'tournament', noShowAfterMs: 30000, at: 1000 });
      const pReadyW = prepareReady(gTourn, { color: 'w', at: 1100, operationId: 'op-rw', rulesVersion: '1.0.0', clockPolicy: 'observed-release-v1' });
      assert.equal(pReadyW.kind, 'prepared');
      const cTourn = new AdjudicationJobController();
      cTourn.createJob(pReadyW, gTourn);
      stepUntilReady(cTourn, pReadyW.operationId);
      const sRW: GameEvent = { type: 'AdjudicationStarted', gameId: gTourn.id, operationId: pReadyW.operationId, baseRevision: 0, at: 1100, rulesVersion: '1.0.0', prepared: pReadyW, clockPolicy: 'observed-release-v1' };
      const gRW = cTourn.settleJob(gTourn.withEvents([sRW]), pReadyW.operationId, 1200).game;

      const pReadyB = prepareReady(gRW, { color: 'b', at: 1300, operationId: 'op-rb', rulesVersion: '1.0.0' });
      assert.equal(pReadyB.kind, 'prepared');
      cTourn.createJob(pReadyB, gRW);
      stepUntilReady(cTourn, pReadyB.operationId);
      const sRB: GameEvent = { type: 'AdjudicationStarted', gameId: gRW.id, operationId: pReadyB.operationId, baseRevision: gRW.eventSequence, at: 1300, rulesVersion: '1.0.0', prepared: pReadyB, clockPolicy: 'observed-release-v1' };
      const gBothReady = cTourn.settleJob(gRW.withEvents([sRB]), pReadyB.operationId, 1400).game;
      assert.equal(gBothReady.releaseNeeded, false);

      // 2. Direct finite ply 0 -> releaseNeeded === true
      const { game: gDirect } = createManagedGame({ at: 1000 });
      const pAdm = prepareCreationAdmission(gDirect, { operationId: 'op-dir', rulesVersion: '1.0.0', at: 1000, clockPolicy: 'observed-release-v1' });
      const cDir = new AdjudicationJobController();
      cDir.createJob(pAdm, gDirect);
      stepUntilReady(cDir, pAdm.operationId);
      const sDir: GameEvent = { type: 'AdjudicationStarted', gameId: gDirect.id, operationId: pAdm.operationId, baseRevision: 0, at: 1000, rulesVersion: '1.0.0', prepared: pAdm, clockPolicy: 'observed-release-v1' };
      const gDirectStopped = cDir.settleJob(gDirect.withEvents([sDir]), pAdm.operationId, 1100).game;
      assert.equal(gDirectStopped.releaseNeeded, true);

      // 3. Unlimited without no-show -> releaseNeeded === false
      const { game: gUnlim } = createManagedGame({ tc: TC_UNLIMITED, at: 1000 });
      const pUnlim = prepareCreationAdmission(gUnlim, { operationId: 'op-unlim', rulesVersion: '1.0.0', at: 1000, clockPolicy: 'observed-release-v1' });
      const cUnlim = new AdjudicationJobController();
      cUnlim.createJob(pUnlim, gUnlim);
      stepUntilReady(cUnlim, pUnlim.operationId);
      const sUnlim: GameEvent = { type: 'AdjudicationStarted', gameId: gUnlim.id, operationId: pUnlim.operationId, baseRevision: 0, at: 1000, rulesVersion: '1.0.0', prepared: pUnlim, clockPolicy: 'observed-release-v1' };
      const gUnlimStopped = cUnlim.settleJob(gUnlim.withEvents([sUnlim]), pUnlim.operationId, 1100).game;
      assert.equal(gUnlimStopped.releaseNeeded, false);

      // 4. Seek both ready before first move -> releaseNeeded === true (preserves no-show obligation)
      const { game: gSeek } = createManagedGame({ source: 'seek', noShowAfterMs: 30000, at: 1000 });
      const pSeekW = prepareReady(gSeek, { color: 'w', at: 1100, operationId: 'op-seek-w', rulesVersion: '1.0.0', clockPolicy: 'observed-release-v1' });
      assert.equal(pSeekW.kind, 'prepared');
      if (pSeekW.kind !== 'prepared') throw new Error('Expected prepared');
      const cSeek = new AdjudicationJobController();
      cSeek.createJob(pSeekW, gSeek);
      stepUntilReady(cSeek, pSeekW.operationId);
      const sSeekW: GameEvent = { type: 'AdjudicationStarted', gameId: gSeek.id, operationId: pSeekW.operationId, baseRevision: 0, at: 1100, rulesVersion: '1.0.0', prepared: pSeekW, clockPolicy: 'observed-release-v1' };
      const gSeekW = cSeek.settleJob(gSeek.withEvents([sSeekW]), pSeekW.operationId, 1200).game;

      const pSeekB = prepareReady(gSeekW, { color: 'b', at: 1300, operationId: 'op-seek-b', rulesVersion: '1.0.0' });
      assert.equal(pSeekB.kind, 'prepared');
      if (pSeekB.kind !== 'prepared') throw new Error('Expected prepared');
      cSeek.createJob(pSeekB, gSeekW);
      stepUntilReady(cSeek, pSeekB.operationId);
      const sSeekB: GameEvent = { type: 'AdjudicationStarted', gameId: gSeekW.id, operationId: pSeekB.operationId, baseRevision: gSeekW.eventSequence, at: 1300, rulesVersion: '1.0.0', prepared: pSeekB, clockPolicy: 'observed-release-v1' };
      const gSeekBothReady = cSeek.settleJob(gSeekW.withEvents([sSeekB]), pSeekB.operationId, 1400).game;
      assert.equal(gSeekBothReady.releaseNeeded, true);
      assert.equal(gSeekBothReady.stoppedClock?.basis.noShowRemainderMs, 29900);
    });

    test('exhausted stopped clock passes preparation, Started, and settlement, and arbitration selects it', () => {
      // Creation at 1000, B1000 / inc 50
      const { game: gBase } = createManagedGame({
        fen: FEN_3PIECE,
        tc: { kind: 'increment', initialMs: 1000, incrementMs: 50, delayMs: 0 },
        at: 1000,
      });
      // Move 1: legacy g6g5 at 1100
      const { game: gAfterMove1 } = gBase.playMove('g6g5', 1100);
      assert.equal(gAfterMove1.ply, 1);
      assert.equal(gAfterMove1.turn, 'b');

      // Black draw offer at 2100 -> E = 1000, balance 0!
      const pOffer = prepareDrawOffer(gAfterMove1, {
        color: 'b',
        at: 2100,
        operationId: 'op-b-offer',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(pOffer, gAfterMove1);
      stepUntilReady(ctrl, pOffer.operationId);

      const sOffer: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gAfterMove1.id,
        operationId: pOffer.operationId,
        baseRevision: gAfterMove1.eventSequence,
        at: 2100,
        rulesVersion: '1.0.0',
        prepared: pOffer,
        clockPolicy: 'observed-release-v1',
      };
      const gStopped = ctrl.settleJob(gAfterMove1.withEvents([sOffer]), pOffer.operationId, 2200).game;
      assert.equal(gStopped.stoppedClock?.basis.turnBaseBalances.b, 1000);
      assert.equal(gStopped.stoppedClock?.basis.elapsedThinkingMs, 1000);
      assert.equal(gStopped.clock.remaining.b, 0);

      // 1. prepareFlagExpiry succeeds
      const prepFlag = prepareFlagExpiry(gStopped, {
        flagged: 'b',
        at: 2300,
        operationId: 'op-flag-b',
        rulesVersion: '1.0.0',
      });
      assert.equal(prepFlag.intent.kind, 'expireFlag');

      // 2. Started admission succeeds
      const sFlag: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gStopped.id,
        operationId: prepFlag.operationId,
        baseRevision: gStopped.eventSequence,
        at: 2300,
        rulesVersion: '1.0.0',
        prepared: prepFlag,
        clockPolicy: 'observed-release-v1',
      };
      const provingFlag = gStopped.withEvents([sFlag]);
      assert.equal(provingFlag.phase, 'proving');

      // 3. Authoritative arbitration selects flag expiry at 2300
      const arbResult = prepareAuthoritativeCommand(gStopped, { kind: 'resign' }, {
        color: 'b',
        at: 2300,
        operationId: 'op-arb-flag',
        rulesVersion: '1.0.0',
      });
      assert.equal(arbResult.kind, 'prepared');
      if (arbResult.kind === 'prepared') {
        assert.equal(arbResult.operation.intent.kind, 'expireFlag');
      }

      // 4. Genuine settlement of the flag operation completes with timeout win for White
      const cFlag = new AdjudicationJobController();
      cFlag.createJob(prepFlag, gStopped);
      stepUntilReady(cFlag, prepFlag.operationId);
      const setFlag = cFlag.settleJob(provingFlag, prepFlag.operationId, 2400);
      assert.equal(setFlag.game.status.over, true);
      assert.equal(setFlag.game.status.winner, 'w');
      assert.equal(setFlag.game.status.result, '1-0');
      assert.equal(setFlag.game.status.termination, 'timeout');
    });

    test('started independently rejects structured move intent on exhausted managed turn and cannot advance board even with proof job', () => {
      // Setup: B1000/inc50, move 1 g6g5 at 1100
      const { game: gBase } = createManagedGame({
        fen: FEN_3PIECE,
        tc: { kind: 'increment', initialMs: 1000, incrementMs: 50, delayMs: 0 },
        at: 1000,
      });
      const { game: gAfterMove1 } = gBase.playMove('g6g5', 1100);

      // Canonical legal intent captured while time remains
      const prepLegalIntent = prepareMove(gAfterMove1, {
        uci: 'h8h7',
        at: 1150,
        operationId: 'op-legal-kh7',
        rulesVersion: '1.0.0',
      });
      const moveIntent = prepLegalIntent.intent;

      // Exhausted case: Black offer at 2100, settled at 2200 -> balance 0
      const pOfferExhausted = prepareDrawOffer(gAfterMove1, {
        color: 'b',
        at: 2100,
        operationId: 'op-b-offer-ex',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const cOfferEx = new AdjudicationJobController();
      cOfferEx.createJob(pOfferExhausted, gAfterMove1);
      stepUntilReady(cOfferEx, pOfferExhausted.operationId);
      const sOfferEx: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gAfterMove1.id,
        operationId: pOfferExhausted.operationId,
        baseRevision: gAfterMove1.eventSequence,
        at: 2100,
        rulesVersion: '1.0.0',
        prepared: pOfferExhausted,
        clockPolicy: 'observed-release-v1',
      };
      const gStoppedEx = cOfferEx.settleJob(gAfterMove1.withEvents([sOfferEx]), pOfferExhausted.operationId, 2200).game;
      assert.equal(gStoppedEx.clock.remaining.b, 0);

      // Ordinary Started input with current valid metadata and captured moveIntent
      const opExhausted: PreparedOperation = {
        operationId: 'op-move-exhausted',
        gameId: gStoppedEx.id,
        baseRevision: gStoppedEx.eventSequence,
        baseFen: gStoppedEx.fen,
        variant: 'standard',
        rulesVersion: '1.0.0',
        intent: moveIntent,
        at: 2300,
        clockPolicy: 'observed-release-v1',
        parentStopId: gStoppedEx.stoppedClock?.stopId ?? null,
        turnLineageId: gStoppedEx.stoppedClock?.turnLineageId,
      };
      const sMoveEx: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gStoppedEx.id,
        operationId: opExhausted.operationId,
        baseRevision: opExhausted.baseRevision,
        at: opExhausted.at,
        rulesVersion: opExhausted.rulesVersion,
        prepared: opExhausted,
        clockPolicy: opExhausted.clockPolicy,
      };

      // 1. Started independently rejects the expired move
      assert.throws(
        () => gStoppedEx.withEvents([sMoveEx]),
        (err: unknown) => err instanceof GameError && /clock|flag|exhaust/i.test(err.message),
      );

      // 2. Positive counterfactual: identical structured intent on non-exhausted managed turn settles successfully
      const pOfferNonEx = prepareDrawOffer(gAfterMove1, {
        color: 'b',
        at: 1200,
        operationId: 'op-b-offer-pos',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const cOfferPos = new AdjudicationJobController();
      cOfferPos.createJob(pOfferNonEx, gAfterMove1);
      stepUntilReady(cOfferPos, pOfferNonEx.operationId);
      const sOfferPos: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gAfterMove1.id,
        operationId: pOfferNonEx.operationId,
        baseRevision: gAfterMove1.eventSequence,
        at: 1200,
        rulesVersion: '1.0.0',
        prepared: pOfferNonEx,
        clockPolicy: 'observed-release-v1',
      };
      const gStoppedPos = cOfferPos.settleJob(gAfterMove1.withEvents([sOfferPos]), pOfferNonEx.operationId, 1300).game;
      assert.equal(gStoppedPos.clock.remaining.b, 900);

      const opPos: PreparedOperation = {
        operationId: 'op-move-positive',
        gameId: gStoppedPos.id,
        baseRevision: gStoppedPos.eventSequence,
        baseFen: gStoppedPos.fen,
        variant: 'standard',
        rulesVersion: '1.0.0',
        intent: moveIntent,
        at: 1400,
        clockPolicy: 'observed-release-v1',
        parentStopId: gStoppedPos.stoppedClock?.stopId ?? null,
        turnLineageId: gStoppedPos.stoppedClock?.turnLineageId,
      };
      const sMovePos: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gStoppedPos.id,
        operationId: opPos.operationId,
        baseRevision: opPos.baseRevision,
        at: opPos.at,
        rulesVersion: opPos.rulesVersion,
        prepared: opPos,
        clockPolicy: opPos.clockPolicy,
      };
      const ctrlPos = new AdjudicationJobController();
      ctrlPos.createJob(opPos, gStoppedPos);
      stepUntilReady(ctrlPos, opPos.operationId);
      const setPos = ctrlPos.settleJob(gStoppedPos.withEvents([sMovePos]), opPos.operationId, 1500);
      assert.equal(setPos.game.ply, 2);
      assert.equal(setPos.game.clock.remaining.b, 950);
    });

    test('managed direct ply zero arbiter preserves existing flag precedence and settles draw vs legacy unmarked exemption', () => {
      // 1. Direct unsourced finite game created at 1000 with initial 1000
      const { game: gBase } = createManagedGame({
        fen: FEN_3PIECE,
        tc: { kind: 'increment', initialMs: 1000, incrementMs: 50, delayMs: 0 },
        at: 1000,
      });

      // Managed White draw offer at 2000, settled at 2200 -> White elapsed 1000, balance 0 at ply 0
      const pOffer = prepareDrawOffer(gBase, {
        color: 'w',
        at: 2000,
        operationId: 'op-w-offer-zero',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const cOffer = new AdjudicationJobController();
      cOffer.createJob(pOffer, gBase);
      stepUntilReady(cOffer, pOffer.operationId);
      const sOffer: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gBase.id,
        operationId: pOffer.operationId,
        baseRevision: 0,
        at: 2000,
        rulesVersion: '1.0.0',
        prepared: pOffer,
        clockPolicy: 'observed-release-v1',
      };
      const gStoppedZero = cOffer.settleJob(gBase.withEvents([sOffer]), pOffer.operationId, 2200).game;
      assert.equal(gStoppedZero.ply, 0);
      assert.equal(gStoppedZero.clock.remaining.w, 0);

      // Precedence: prepareAuthoritativeCommand with 'resign' returns 'expireFlag'
      const arbResult = prepareAuthoritativeCommand(gStoppedZero, { kind: 'resign' }, {
        color: 'w',
        at: 2300,
        operationId: 'op-arb-zero-flag',
        rulesVersion: '1.0.0',
      });
      assert.equal(arbResult.kind, 'prepared');
      if (arbResult.kind === 'prepared') {
        assert.equal(arbResult.operation.intent.kind, 'expireFlag');
        assert.equal(arbResult.operation.clockPolicy, 'observed-release-v1');
      }
      assert.equal(gStoppedZero.flagDeadline, null, 'stopped clocks still expose no running deadline');

      // Genuine settlement draws because bare Black King cannot mate White
      const pFlagZero = prepareFlagExpiry(gStoppedZero, {
        flagged: 'w',
        at: 2300,
        operationId: 'op-flag-zero',
        rulesVersion: '1.0.0',
      });
      const cFlagZero = new AdjudicationJobController();
      cFlagZero.createJob(pFlagZero, gStoppedZero);
      stepUntilReady(cFlagZero, pFlagZero.operationId);
      const sFlagZero: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gStoppedZero.id,
        operationId: pFlagZero.operationId,
        baseRevision: gStoppedZero.eventSequence,
        at: 2300,
        rulesVersion: '1.0.0',
        prepared: pFlagZero,
        clockPolicy: 'observed-release-v1',
      };
      const setFlagZero = cFlagZero.settleJob(gStoppedZero.withEvents([sFlagZero]), pFlagZero.operationId, 2500);
      assert.equal(setFlagZero.game.status.over, true);
      assert.equal(setFlagZero.game.status.result, '1/2-1/2');
      assert.equal(setFlagZero.game.status.winner, null);

      // Positive stopped balance never accrues new flag at direct ply 0
      const pOfferPos = prepareDrawOffer(gBase, {
        color: 'w',
        at: 1500,
        operationId: 'op-w-offer-pos',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const cOfferPos = new AdjudicationJobController();
      cOfferPos.createJob(pOfferPos, gBase);
      stepUntilReady(cOfferPos, pOfferPos.operationId);
      const sOfferPos: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gBase.id,
        operationId: pOfferPos.operationId,
        baseRevision: 0,
        at: 1500,
        rulesVersion: '1.0.0',
        prepared: pOfferPos,
        clockPolicy: 'observed-release-v1',
      };
      const gStoppedPos = cOfferPos.settleJob(gBase.withEvents([sOfferPos]), pOfferPos.operationId, 1700).game;
      assert.equal(gStoppedPos.clock.remaining.w, 500);
      assert.equal(gStoppedPos.timeoutDue(90000), false);
      assert.equal(gStoppedPos.flagDeadline, null);

      // Legacy unmarked ply 0 exemption preserved
      const legacyCreated = Game.create({
        gameId: 'legacy-zero',
        variant: 'standard',
        initialFen: FEN_3PIECE,
        players: { white: 'alice', black: 'bob' },
        at: 1000,
        timeControl: { kind: 'increment', initialMs: 1000, incrementMs: 50, delayMs: 0 },
      });
      assert.equal(legacyCreated.game.ply, 0);
      assert.equal(legacyCreated.game.timeoutDue(2000), false);
      assert.equal(legacyCreated.game.flagDeadline, null);
      const legacyArb = prepareAuthoritativeCommand(legacyCreated.game, { kind: 'resign' }, {
        color: 'w',
        at: 2000,
        operationId: 'op-legacy-arb',
        rulesVersion: '1.0.0',
      });
      assert.equal(legacyArb.kind, 'prepared');
      if (legacyArb.kind === 'prepared') {
        assert.equal(legacyArb.operation.intent.kind, 'resign');
      }

      // Sourced unstarted tournament game at ply 0
      const { game: gTourn } = createManagedGame({ source: 'tournament', noShowAfterMs: 30000, at: 1000 });
      assert.equal(gTourn.ply, 0);
      assert.equal(gTourn.timeoutDue(2000), false);
    });

    test('expiry arbitration preserves explicit policy and rejects invalid policy', () => {
      const { game: gBase } = createManagedGame({
        source: 'seek',
        noShowAfterMs: 30000,
        at: 1000,
      });

      // At 32000, noShow has expired.
      // 1. Explicit valid policy preserved
      const resVal = prepareAuthoritativeCommand(gBase, { kind: 'move', uci: 'g6g5' }, {
        color: 'w',
        at: 32000,
        operationId: 'op-arb-val',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      assert.equal(resVal.kind, 'prepared');
      if (resVal.kind === 'prepared') {
        assert.equal(resVal.operation.clockPolicy, 'observed-release-v1');
      }

      // 2. Invalid policy rejected
      assert.throws(
        () => prepareAuthoritativeCommand(gBase, { kind: 'move', uci: 'g6g5' }, {
          color: 'w',
          at: 32000,
          operationId: 'op-arb-inv',
          rulesVersion: '1.0.0',
          clockPolicy: 'unknown-policy' as unknown as AdjudicationClockPolicy,
        }),
        (err: unknown) => err instanceof GameError && /policy/i.test((err as Error).message),
      );
    });
  });

  describe('Suite 6: Descriptor Tamper Rejection & Deep Ownership', () => {
    test('rejects tampered stopId in clockCompletion descriptor during replay', () => {
      const { game: baseGame } = createManagedGame({ at: 1000 });
      const prepared = prepareCreationAdmission(baseGame, {
        operationId: 'op-tamper-stopid',
        rulesVersion: '1.0.0',
        at: 1000,
        clockPolicy: 'observed-release-v1',
      });
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(prepared, baseGame);
      stepUntilReady(ctrl, prepared.operationId);

      const start: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepared.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared,
        clockPolicy: 'observed-release-v1',
      };
      const settlement = ctrl.settleJob(baseGame.withEvents([start]), prepared.operationId, 1100);

      const tamperedDescriptor = {
        ...settlement.resolved.clockCompletion,
        stopId: 'stop:forged-stop-id',
      };
      const tamperedResolved: GameEvent = {
        ...settlement.resolved,
        clockCompletion: tamperedDescriptor as unknown as AdjudicationClockCompletionDescriptor,
      };

      assert.throws(
        () => baseGame.withEvents([start, tamperedResolved]),
        (err: unknown) => err instanceof GameError && /stopId|mismatch|descriptor/i.test((err as Error).message),
      );
    });

    test('rejects tampered completionHead in clockCompletion descriptor during replay', () => {
      const { game: baseGame } = createManagedGame({ at: 1000 });
      const prepared = prepareCreationAdmission(baseGame, {
        operationId: 'op-tamper-head',
        rulesVersion: '1.0.0',
        at: 1000,
        clockPolicy: 'observed-release-v1',
      });
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(prepared, baseGame);
      stepUntilReady(ctrl, prepared.operationId);

      const start: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepared.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared,
        clockPolicy: 'observed-release-v1',
      };
      const settlement = ctrl.settleJob(baseGame.withEvents([start]), prepared.operationId, 1100);

      const tamperedDescriptor = {
        ...settlement.resolved.clockCompletion,
        completionHead: 999,
      };
      const tamperedResolved: GameEvent = {
        ...settlement.resolved,
        clockCompletion: tamperedDescriptor as unknown as AdjudicationClockCompletionDescriptor,
      };

      assert.throws(
        () => baseGame.withEvents([start, tamperedResolved]),
        (err: unknown) => err instanceof GameError && /completionHead|mismatch|descriptor/i.test((err as Error).message),
      );
    });

    test('returned stoppedClock and snapshots are deeply owned and immune to caller mutation', () => {
      const { game: baseGame } = createManagedGame({ at: 1000 });
      const prepared = prepareCreationAdmission(baseGame, {
        operationId: 'op-deep-own',
        rulesVersion: '1.0.0',
        at: 1000,
        clockPolicy: 'observed-release-v1',
      });
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(prepared, baseGame);
      stepUntilReady(ctrl, prepared.operationId);

      const start: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepared.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared,
        clockPolicy: 'observed-release-v1',
      };
      const settledGame = ctrl.settleJob(baseGame.withEvents([start]), prepared.operationId, 1100).game;

      const stoppedClock1 = settledGame.stoppedClock;
      assert.notEqual(stoppedClock1, null);
      if (!stoppedClock1) return;

      assert.throws(
        () => {
          (stoppedClock1.basis.turnBaseBalances as { w: number }).w = 0;
        },
        TypeError,
      );

      assert.equal(settledGame.stoppedClock?.basis.turnBaseBalances.w, 60000);
    });

    test('rejects tampered parentStopId or turnLineageId during resolution settlement and stored replay', () => {
      const { game: baseGame } = createManagedGame({ at: 1000 });
      const prepAdm = prepareCreationAdmission(baseGame, {
        operationId: 'op-adm-lineage',
        rulesVersion: '1.0.0',
        at: 1000,
        clockPolicy: 'observed-release-v1',
      });
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(prepAdm, baseGame);
      stepUntilReady(ctrl, prepAdm.operationId);
      const sAdm: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepAdm.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared: prepAdm,
        clockPolicy: 'observed-release-v1',
      };
      const stoppedGame = ctrl.settleJob(baseGame.withEvents([sAdm]), prepAdm.operationId, 1100).game;
      const genuineStopId = stoppedGame.stoppedClock?.stopId;
      assert.notEqual(genuineStopId, null);

      // Subsequent operation must inherit genuine parentStopId
      const prepOffer = prepareDrawOffer(stoppedGame, {
        color: 'w',
        at: 1200,
        operationId: 'op-offer-lineage',
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      assert.equal(prepOffer.parentStopId, genuineStopId);

      // Tampered parentStopId on Started is rejected
      const tamperedStarted: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: stoppedGame.id,
        operationId: prepOffer.operationId,
        baseRevision: stoppedGame.eventSequence,
        at: 1200,
        rulesVersion: '1.0.0',
        prepared: { ...prepOffer, parentStopId: 'stop:forged-parent' },
        clockPolicy: 'observed-release-v1',
      };
      assert.throws(
        () => stoppedGame.withEvents([tamperedStarted]),
        (err: unknown) => err instanceof GameError && /parentStopId|mismatch/i.test(err.message),
      );

      // Tampered turnLineageId on clockCompletion descriptor is rejected
      const ctrl2 = new AdjudicationJobController();
      ctrl2.createJob(prepOffer, stoppedGame);
      stepUntilReady(ctrl2, prepOffer.operationId);
      const sOffer: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: stoppedGame.id,
        operationId: prepOffer.operationId,
        baseRevision: stoppedGame.eventSequence,
        at: 1200,
        rulesVersion: '1.0.0',
        prepared: prepOffer,
        clockPolicy: 'observed-release-v1',
      };
      const settlement = ctrl2.settleJob(stoppedGame.withEvents([sOffer]), prepOffer.operationId, 1300);
      const tamperedResolved: GameEvent = {
        ...settlement.resolved,
        clockCompletion: {
          ...settlement.resolved.clockCompletion,
          turnLineageId: 'turn:tampered-turn-id',
        } as unknown as AdjudicationClockCompletionDescriptor,
      };
      assert.throws(
        () => stoppedGame.withEvents([sOffer, tamperedResolved]),
        (err: unknown) => err instanceof GameError && /turnLineageId|mismatch|descriptor/i.test(err.message),
      );
    });

    test('stopped no-show zero rejects late readiness and move, while nonzero admits readiness', () => {
      // Seek game created at 1000 with noShowAfterMs = 30000 -> deadline 31000
      const { game: gSeek, events: gSeekEvents } = createManagedGame({ source: 'seek', noShowAfterMs: 30000, at: 1000 });

      // White marks ready at 1100 -> admitted
      const pReadyW = prepareReady(gSeek, { color: 'w', at: 1100, operationId: 'op-ready-w', rulesVersion: '1.0.0', clockPolicy: 'observed-release-v1' });
      assert.equal(pReadyW.kind, 'prepared');
      if (pReadyW.kind !== 'prepared') throw new Error('Expected prepared');
      const cSeek = new AdjudicationJobController();
      cSeek.createJob(pReadyW, gSeek);
      stepUntilReady(cSeek, pReadyW.operationId);
      const sReadyW: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gSeek.id,
        operationId: pReadyW.operationId,
        baseRevision: 0,
        at: 1100,
        rulesVersion: '1.0.0',
        prepared: pReadyW,
        clockPolicy: 'observed-release-v1',
      };
      const gStoppedActive = cSeek.settleJob(gSeek.withEvents([sReadyW]), pReadyW.operationId, 1200).game;
      assert.equal(gStoppedActive.stoppedClock?.basis.noShowRemainderMs, 29900);

      // Nonzero remainder at 1500: Black can mark ready
      const pReadyB = prepareReady(gStoppedActive, { color: 'b', at: 1500, operationId: 'op-ready-b', rulesVersion: '1.0.0' });
      assert.equal(pReadyB.kind, 'prepared');

      // Now consider stopped state where remainder has reached 0
      const { game: gSeekShort } = createManagedGame({ source: 'seek', noShowAfterMs: 200, at: 1000 });
      const pAdmZero = prepareCreationAdmission(gSeekShort, {
        operationId: 'op-adm-zero',
        rulesVersion: '1.0.0',
        at: 1200,
        clockPolicy: 'observed-release-v1',
      });
      const cZero = new AdjudicationJobController();
      cZero.createJob(pAdmZero, gSeekShort);
      stepUntilReady(cZero, pAdmZero.operationId);
      const sAdmZero: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: gSeekShort.id,
        operationId: pAdmZero.operationId,
        baseRevision: 0,
        at: 1200,
        rulesVersion: '1.0.0',
        prepared: pAdmZero,
        clockPolicy: 'observed-release-v1',
      };
      const gStoppedZero = cZero.settleJob(gSeekShort.withEvents([sAdmZero]), pAdmZero.operationId, 1200).game;
      assert.equal(gStoppedZero.stoppedClock?.basis.noShowRemainderMs, 0);

      // Late readiness after deadline returns no-op 'late'
      const resReadyLate = prepareReady(gStoppedZero, { color: 'b', at: 1300, operationId: 'op-late-b', rulesVersion: '1.0.0' });
      assert.deepEqual(resReadyLate, { kind: 'noop', reason: 'late' });

      // Started admission with ready intent after zero remainder is rejected
      assert.throws(
        () => gStoppedZero.withEvents([{
          type: 'AdjudicationStarted',
          gameId: gStoppedZero.id,
          operationId: 'op-late-ready-started',
          baseRevision: gStoppedZero.eventSequence,
          at: 1300,
          rulesVersion: '1.0.0',
          clockPolicy: 'observed-release-v1',
          prepared: {
            operationId: 'op-late-ready-started',
            gameId: gStoppedZero.id,
            baseRevision: gStoppedZero.eventSequence,
            baseFen: gStoppedZero.fen,
            variant: 'standard',
            rulesVersion: '1.0.0',
            at: 1300,
            clockPolicy: 'observed-release-v1',
            parentStopId: gStoppedZero.stoppedClock?.stopId,
            turnLineageId: gStoppedZero.stoppedClock?.turnLineageId,
            intent: { kind: 'ready', color: 'b', isNoop: false },
          },
        }]),
        (err: unknown) => err instanceof GameError && /no-show deadline/i.test(err.message),
      );

      // Move after zero remainder rejected
      assert.throws(
        () => prepareMove(gStoppedZero, { uci: 'g6g5', at: 1300, operationId: 'op-late-move', rulesVersion: '1.0.0' }),
        (err: unknown) => err instanceof GameError && /no-show deadline/i.test(err.message),
      );

      // Authoritative command prioritizes expireNoShow
      const arbResult = prepareAuthoritativeCommand(gStoppedZero, { kind: 'resign' }, {
        color: 'w',
        at: 1300,
        operationId: 'op-arb-noshow',
        rulesVersion: '1.0.0',
      });
      assert.equal(arbResult.kind, 'prepared');
      if (arbResult.kind === 'prepared') {
        assert.equal(arbResult.operation.intent.kind, 'expireNoShow');
      }
    });

    test('full JSON event serialization and replay parity preserves exact stopped game state and continuation', () => {
      const { game: baseGame, events: initEv } = createManagedGame({ fen: FEN_3PIECE, at: 1000 });
      const prepAdm = prepareCreationAdmission(baseGame, {
        operationId: 'op-adm-json',
        rulesVersion: '1.0.0',
        at: 1000,
        clockPolicy: 'observed-release-v1',
      });
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(prepAdm, baseGame);
      stepUntilReady(ctrl, prepAdm.operationId);
      const sAdm: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseGame.id,
        operationId: prepAdm.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared: prepAdm,
        clockPolicy: 'observed-release-v1',
      };
      const setAdm = ctrl.settleJob(baseGame.withEvents([sAdm]), prepAdm.operationId, 1100);

      const allEvents: GameEvent[] = [...initEv, sAdm, ...setAdm.batch];
      const serialized = JSON.stringify(allEvents);
      const deserialized = JSON.parse(serialized) as GameEvent[];

      // Replay from deserialized events
      const fromEventsGame = Game.fromEvents(deserialized);
      const fromStoredGame = replayEventsStored(baseGame.id, deserialized);

      assert.equal(fromEventsGame.fen, setAdm.game.fen);
      assert.equal(fromEventsGame.ply, setAdm.game.ply);
      assert.equal(fromEventsGame.clockPolicy, 'observed-release-v1');
      assert.equal(fromEventsGame.stoppedClock?.stopId, setAdm.game.stoppedClock?.stopId);
      assert.equal(fromStoredGame.fen, setAdm.game.fen);
      assert.equal(fromStoredGame.ply, setAdm.game.ply);
      assert.equal(fromStoredGame.stoppedClock?.stopId, setAdm.game.stoppedClock?.stopId);

      // Continuation move admitted and executed identically across live, JSON-replayed, and stored-replayed stopped games
      const contOpId = 'op-cont-move';
      const prepContLive = prepareMove(setAdm.game, {
        uci: 'g6g5',
        at: 1200,
        operationId: contOpId,
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      const ctrlLive = new AdjudicationJobController();
      ctrlLive.createJob(prepContLive, setAdm.game);
      stepUntilReady(ctrlLive, contOpId);
      const sContLive: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: setAdm.game.id,
        operationId: contOpId,
        baseRevision: setAdm.game.eventSequence,
        at: 1200,
        rulesVersion: '1.0.0',
        prepared: prepContLive,
        clockPolicy: 'observed-release-v1',
      };
      const setContLive = ctrlLive.settleJob(setAdm.game.withEvents([sContLive]), contOpId, 1300);

      const prepContEvents = prepareMove(fromEventsGame, {
        uci: 'g6g5',
        at: 1200,
        operationId: contOpId,
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      assert.equal(prepContEvents.intent.kind, 'move');
      assert.equal(prepContEvents.parentStopId, fromEventsGame.stoppedClock?.stopId);

      const ctrlEvents = new AdjudicationJobController();
      ctrlEvents.createJob(prepContEvents, fromEventsGame);
      stepUntilReady(ctrlEvents, contOpId);
      const sContEvents: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: fromEventsGame.id,
        operationId: contOpId,
        baseRevision: fromEventsGame.eventSequence,
        at: 1200,
        rulesVersion: '1.0.0',
        prepared: prepContEvents,
        clockPolicy: 'observed-release-v1',
      };
      const setContEvents = ctrlEvents.settleJob(fromEventsGame.withEvents([sContEvents]), contOpId, 1300);

      const prepContStored = prepareMove(fromStoredGame, {
        uci: 'g6g5',
        at: 1200,
        operationId: contOpId,
        rulesVersion: '1.0.0',
        clockPolicy: 'observed-release-v1',
      });
      assert.equal(prepContStored.intent.kind, 'move');
      assert.equal(prepContStored.parentStopId, fromStoredGame.stoppedClock?.stopId);

      const ctrlStored = new AdjudicationJobController();
      ctrlStored.createJob(prepContStored, fromStoredGame);
      stepUntilReady(ctrlStored, contOpId);
      const sContStored: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: fromStoredGame.id,
        operationId: contOpId,
        baseRevision: fromStoredGame.eventSequence,
        at: 1200,
        rulesVersion: '1.0.0',
        prepared: prepContStored,
        clockPolicy: 'observed-release-v1',
      };
      const setContStored = ctrlStored.settleJob(fromStoredGame.withEvents([sContStored]), contOpId, 1300);

      // Verify exact parity between live, events-replayed, and stored-replayed
      assert.equal(setContEvents.game.ply, 1);
      assert.equal(setContStored.game.ply, 1);
      assert.equal(setContLive.game.ply, 1);
      assert.equal(setContEvents.game.fen, setContLive.game.fen);
      assert.equal(setContStored.game.fen, setContLive.game.fen);

      // Derived effects batch parity
      assert.deepEqual(setContEvents.batch.map(e => e.type), setContLive.batch.map(e => e.type));
      assert.deepEqual(setContStored.batch.map(e => e.type), setContLive.batch.map(e => e.type));

      // Clock basis and remaining balance parity
      assert.deepEqual(setContEvents.game.clock.remaining, setContLive.game.clock.remaining);
      assert.deepEqual(setContStored.game.clock.remaining, setContLive.game.clock.remaining);
      assert.deepEqual(setContEvents.game.clockAccountingSnapshot()?.displayBalances, setContLive.game.clockAccountingSnapshot()?.displayBalances);
      assert.deepEqual(setContStored.game.clockAccountingSnapshot()?.displayBalances, setContLive.game.clockAccountingSnapshot()?.displayBalances);
      assert.deepEqual(setContEvents.game.clockAccountingSnapshot(), setContLive.game.clockAccountingSnapshot());
      assert.deepEqual(setContStored.game.clockAccountingSnapshot(), setContLive.game.clockAccountingSnapshot());
      assert.equal(setContEvents.game.releaseNeeded, setContLive.game.releaseNeeded);
      assert.equal(setContStored.game.releaseNeeded, setContLive.game.releaseNeeded);
      assert.equal(setContEvents.game.stoppedClock?.stopId, setContLive.game.stoppedClock?.stopId);
      assert.equal(setContStored.game.stoppedClock?.stopId, setContLive.game.stoppedClock?.stopId);
      assert.equal(setContEvents.game.stoppedClock?.turnLineageId, setContLive.game.stoppedClock?.turnLineageId);
      assert.equal(setContStored.game.stoppedClock?.turnLineageId, setContLive.game.stoppedClock?.turnLineageId);

      // Incomplete prefix parity: proving phase before settlement
      const provingLive = setAdm.game.withEvents([sContLive]);
      const provingEvents = fromEventsGame.withEvents([sContEvents]);
      const provingStored = fromStoredGame.withEvents([sContStored]);
      assert.equal(provingEvents.phase, provingLive.phase);
      assert.equal(provingStored.phase, provingLive.phase);
      assert.equal(provingEvents.isBlocked, provingLive.isBlocked);
      assert.equal(provingStored.isBlocked, provingLive.isBlocked);
    });
  });

  describe('Suite 7: Candidate Contract Hardening & Lineage/Context Controls', () => {
    test('fresh initial unmarked game accepts legitimate legacy and new policy, rejects null without reservation', () => {
      const { game: unmarkedGame } = createManagedGame({ at: 1000 });
      assert.equal(unmarkedGame.clockPolicy, null);

      // 1. Legitimate legacy omitted policy allocates cleanly
      const opLegacy = prepareDrawOffer(unmarkedGame, {
        color: 'w',
        at: 1100,
        operationId: 'op-first-legacy',
        rulesVersion: '1.0.0',
      });
      assert.equal(opLegacy.clockPolicy, undefined);
      const ctrlLegacy = new AdjudicationJobController();
      ctrlLegacy.createJob(opLegacy, unmarkedGame);
      assert.notEqual(ctrlLegacy.getJob(opLegacy.operationId), undefined);

      // 2. Legitimate explicit new policy allocates cleanly
      const opNew = prepareDrawOffer(unmarkedGame, {
        color: 'w',
        at: 1100,
        clockPolicy: 'observed-release-v1',
        operationId: 'op-first-new',
        rulesVersion: '1.0.0',
      });
      assert.equal(opNew.clockPolicy, 'observed-release-v1');
      const ctrlNew = new AdjudicationJobController();
      ctrlNew.createJob(opNew, unmarkedGame);
      assert.notEqual(ctrlNew.getJob(opNew.operationId), undefined);

      // 3. Invalid null policy on fresh unmarked game rejects before allocation and does not reserve operationId
      const opNullPoison = prepareDrawOffer(unmarkedGame, {
        color: 'w',
        at: 1100,
        operationId: 'op-first-null-poison',
        rulesVersion: '1.0.0',
      });
      const ctrlPoison = new AdjudicationJobController();
      const badNullOp = { ...opNullPoison, clockPolicy: null } as unknown as PreparedOperation;
      assert.throws(() => ctrlPoison.createJob(badNullOp, unmarkedGame), GameError);
      assert.equal(ctrlPoison.getJob(opNullPoison.operationId), undefined);

      // Corrected operation with exact same operationId succeeds without conflicting
      ctrlPoison.createJob(opNullPoison, unmarkedGame);
      assert.notEqual(ctrlPoison.getJob(opNullPoison.operationId), undefined);

      // 4. Invalid unknown policy on fresh unmarked game rejects before allocation and allows corrected retry
      const opUnknown = prepareDrawOffer(unmarkedGame, {
        color: 'w',
        at: 1100,
        operationId: 'op-first-unknown',
        rulesVersion: '1.0.0',
      });
      const ctrlUnknown = new AdjudicationJobController();
      const badUnknownOp = { ...opUnknown, clockPolicy: 'unknown-policy' } as unknown as PreparedOperation;
      assert.throws(() => ctrlUnknown.createJob(badUnknownOp, unmarkedGame), GameError);
      assert.equal(ctrlUnknown.getJob(opUnknown.operationId), undefined);
      ctrlUnknown.createJob(opUnknown, unmarkedGame);
      assert.notEqual(ctrlUnknown.getJob(opUnknown.operationId), undefined);
    });
    test('first managed opt-in rejects foreign/forged turn lineage before Started fold', () => {
      const { game: bGame } = createManagedGame({ at: 1000 });
      const original = prepareDrawOffer(bGame, {
        color: 'w',
        at: 1100,
        clockPolicy: 'observed-release-v1',
        operationId: 'op-forged-lineage-1',
        rulesVersion: '1.0.0',
      });

      const foreignValues: unknown[] = [
        'foreign-game:foreign-turn',
        { external: 'caller-owned-object' },
        12345,
        ['array-lineage'],
      ];

      for (const val of foreignValues) {
        const forgedOp = { ...original, turnLineageId: val as unknown as string };
        const startedEv: GameEvent = {
          type: 'AdjudicationStarted',
          gameId: bGame.id,
          operationId: original.operationId,
          baseRevision: bGame.eventSequence,
          at: original.at,
          rulesVersion: original.rulesVersion,
          prepared: forgedOp as unknown as PreparedOperation,
          clockPolicy: original.clockPolicy,
        };
        assert.throws(
          () => bGame.withEvents([startedEv]),
          GameError,
          `first managed lineage must reject ${typeof val}`
        );
      }

      // Valid canonical deriveTurnLineageId or undefined succeeds
      const validCanonical = deriveTurnLineageId(bGame.id, bGame.ply);
      const canonicalOp = { ...original, turnLineageId: validCanonical };
      const validStarted: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: bGame.id,
        operationId: original.operationId,
        baseRevision: bGame.eventSequence,
        at: original.at,
        rulesVersion: original.rulesVersion,
        prepared: canonicalOp,
        clockPolicy: original.clockPolicy,
      };
      const validGame = bGame.withEvents([validStarted]);
      assert.equal(validGame.phase, 'proving');
    });

    test('sourced unstarted finite zero rejects explicit flag preparation and Started admission', () => {
      const { game: rawGame } = createManagedGame({
        source: 'tournament',
        noShowAfterMs: 30_000,
        tc: { kind: 'sudden_death', initialMs: 0, incrementMs: 0, delayMs: 0 },
        at: 1000,
      });

      // Creation admission succeeds
      const prepAdm = prepareCreationAdmission(rawGame, {
        at: 1000,
        clockPolicy: 'observed-release-v1',
        operationId: 'op-sourced-adm',
        rulesVersion: '1.0.0',
      });
      const ctrl = new AdjudicationJobController();
      ctrl.createJob(prepAdm, rawGame);
      stepUntilReady(ctrl, prepAdm.operationId);
      const sAdm: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: rawGame.id,
        operationId: prepAdm.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared: prepAdm,
        clockPolicy: 'observed-release-v1',
      };
      const setAdm = ctrl.settleJob(rawGame.withEvents([sAdm]), prepAdm.operationId, 1200);
      const stoppedGame = setAdm.game;

      assert.equal(stoppedGame.timeoutDue(1500), false);
      assert.equal(stoppedGame.ply, 0);

      // Explicit flag preparation is rejected
      assert.throws(
        () => prepareFlagExpiry(stoppedGame, {
          flagged: 'w',
          at: 1500,
          operationId: 'op-sourced-flag',
          rulesVersion: '1.0.0',
        }),
        GameError
      );

      // Direct finite at ply 0 statically exhausted prepares and admits flag expiry
      const { game: directRaw } = createManagedGame({
        tc: { kind: 'sudden_death', initialMs: 0, incrementMs: 0, delayMs: 0 },
        at: 1000,
      });
      const prepDirectAdm = prepareCreationAdmission(directRaw, {
        at: 1000,
        clockPolicy: 'observed-release-v1',
        operationId: 'op-direct-adm',
        rulesVersion: '1.0.0',
      });
      const ctrlDirect = new AdjudicationJobController();
      ctrlDirect.createJob(prepDirectAdm, directRaw);
      stepUntilReady(ctrlDirect, prepDirectAdm.operationId);
      const sDirectAdm: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: directRaw.id,
        operationId: prepDirectAdm.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared: prepDirectAdm,
        clockPolicy: 'observed-release-v1',
      };
      const setDirectAdm = ctrlDirect.settleJob(directRaw.withEvents([sDirectAdm]), prepDirectAdm.operationId, 1200);
      const directStopped = setDirectAdm.game;

      const directFlagOp = prepareFlagExpiry(directStopped, {
        flagged: 'w',
        at: 1500,
        operationId: 'op-direct-flag',
        rulesVersion: '1.0.0',
      });
      assert.equal(directFlagOp.intent.kind, 'expireFlag');

      // Started flag admission rejects sourced unstarted both first opt-in and stopped
      const prepDrawRaw = prepareDrawOffer(rawGame, {
        color: 'w',
        at: 1500,
        clockPolicy: 'observed-release-v1',
        operationId: 'op-raw-draw',
        rulesVersion: '1.0.0',
      });
      const startedFlagRaw: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: rawGame.id,
        operationId: prepDrawRaw.operationId,
        baseRevision: rawGame.eventSequence,
        at: 1500,
        rulesVersion: '1.0.0',
        prepared: { ...prepDrawRaw, intent: directFlagOp.intent },
        clockPolicy: 'observed-release-v1',
      };
      assert.throws(() => rawGame.withEvents([startedFlagRaw]), GameError);

      const prepDrawStopped = prepareDrawOffer(stoppedGame, {
        color: 'w',
        at: 1500,
        clockPolicy: 'observed-release-v1',
        operationId: 'op-stopped-draw',
        rulesVersion: '1.0.0',
      });
      const startedFlagStopped: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: stoppedGame.id,
        operationId: prepDrawStopped.operationId,
        baseRevision: stoppedGame.eventSequence,
        at: 1500,
        rulesVersion: '1.0.0',
        prepared: { ...prepDrawStopped, intent: directFlagOp.intent },
        clockPolicy: 'observed-release-v1',
      };
      assert.throws(() => stoppedGame.withEvents([startedFlagStopped]), GameError);
    });

    test('proof job rejects mismatched metadata before allocation for both pending and fresh contexts', () => {
      const { game: baseRaw } = createManagedGame({ at: 1000 });
      const prepAdm = prepareCreationAdmission(baseRaw, {
        at: 1000,
        clockPolicy: 'observed-release-v1',
        operationId: 'op-adm-ctx',
        rulesVersion: '1.0.0',
      });
      const ctrlAdm = new AdjudicationJobController();
      ctrlAdm.createJob(prepAdm, baseRaw);
      stepUntilReady(ctrlAdm, prepAdm.operationId);
      const sAdm: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: baseRaw.id,
        operationId: prepAdm.operationId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: '1.0.0',
        prepared: prepAdm,
        clockPolicy: 'observed-release-v1',
      };
      const setAdm = ctrlAdm.settleJob(baseRaw.withEvents([sAdm]), prepAdm.operationId, 1200);
      const stoppedGame = setAdm.game;

      const op = prepareDrawOffer(stoppedGame, {
        color: 'w',
        at: 1500,
        operationId: 'op-pending-ctx',
        rulesVersion: '1.0.0',
      });
      const startedEvent: GameEvent = {
        type: 'AdjudicationStarted',
        gameId: stoppedGame.id,
        operationId: op.operationId,
        baseRevision: stoppedGame.eventSequence,
        at: op.at,
        rulesVersion: op.rulesVersion,
        prepared: op,
        clockPolicy: op.clockPolicy,
      };
      const provingGame = stoppedGame.withEvents([startedEvent]);

      // 1. Pending context tests
      const pendingMismatches: [string, unknown][] = [
        ['clockPolicy', undefined],
        ['parentStopId', 'wrong-parent'],
        ['turnLineageId', 'wrong-turn'],
      ];

      for (const [field, value] of pendingMismatches) {
        const ctrl = new AdjudicationJobController();
        const badOp = { ...op, [field]: value } as unknown as PreparedOperation;
        assert.throws(() => ctrl.createJob(badOp, provingGame), GameError);
        assert.equal(ctrl.getJob(op.operationId), undefined);
        // Corrected context allocates successfully
        ctrl.createJob(op, provingGame);
        assert.notEqual(ctrl.getJob(op.operationId), undefined);
      }

      // 2. Fresh context tests (adjudication === null)
      const freshMismatches: [string, unknown][] = [
        ['clockPolicy', undefined],
        ['parentStopId', 'wrong-parent'],
        ['turnLineageId', 'wrong-turn'],
      ];

      for (const [field, value] of freshMismatches) {
        const ctrl = new AdjudicationJobController();
        const badOp = { ...op, [field]: value } as unknown as PreparedOperation;
        assert.throws(() => ctrl.createJob(badOp, stoppedGame), GameError);
        assert.equal(ctrl.getJob(op.operationId), undefined);
        // Corrected context allocates successfully
        ctrl.createJob(op, stoppedGame);
        assert.notEqual(ctrl.getJob(op.operationId), undefined);
      }
    });
  });
});
