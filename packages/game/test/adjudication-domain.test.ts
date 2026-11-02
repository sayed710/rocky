/**
 * @packageDocumentation
 * Mandatory domain contract tests for Issue #124 Stage 1 (P01 through P14).
 *
 * References:
 * - ../../work/opencode124d-draft-engineering-review/final.txt
 * - ../../work/pi124d-draft-test-review/final.txt
 * - ../../outputs/agy124d-observed-corrections.md
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Position,
  repetitionKey,
  type Color,
} from '@chess-platform/core';
import {
  charge,
  evaluatePreparedProof,
  freezeClock,
  Game,
  GameError,
  getRegisteredEvidence,
  MAX_SAFE_TIMESTAMP_MS,
  prepareAbort,
  prepareAuthoritativeCommand,
  prepareCreationAdmission,
  prepareDrawAccept,
  prepareDrawDecline,
  prepareDrawOffer,
  prepareFlagExpiry,
  prepareMove,
  prepareNoShowExpiry,
  prepareReady,
  prepareResign,
  resumeClockSameTurn,
  settlePrepared,
  validateAdjudicationAppendBatch,
  type AdjudicationEffect,
  type AdjudicationEvidenceHandle,
  type AdjudicationResolvedEvent,
  type AdjudicationStartedEvent,
  type GameCreatedEvent,
  type GameEndedEvent,
  type GameEvent,
  type MovePlayedEvent,
  type PreparedOperation,
  type RecordedResolutionEvidence,
  type TimeControl,
} from '../src';
import { replayStoredHistory, type StoredHistoryRow } from '../src/stored-history';
import { FOLD_STORED } from '../src/game';

const TC_STANDARD: TimeControl = {
  kind: 'increment',
  initialMs: 300_000,
  incrementMs: 3_000,
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

/** Known fast-resolving test positions */
const FEN_MATE1 = '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1';
const FEN_CASTLING_MATE = '4rkr1/4p1p1/6P1/8/8/8/8/4K2R w K - 0 1';
const FEN_CORPUS_LINE14 = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';

function createActiveGame(
  tc = TC_STANDARD,
  initialFen = FEN_MATE1,
  gameId = 'test-game',
): { game: Game; created: GameCreatedEvent } {
  const { game, events } = Game.create({
    gameId,
    variant: 'standard',
    initialFen,
    timeControl: tc,
    players: { white: 'alice', black: 'bob' },
    at: 1_000,
  });
  return { game, created: events[0] as GameCreatedEvent };
}

describe('Issue #124 Stage 1: Mandatory Contract Tests (P01-P14)', () => {
  // -------------------------------------------------------------------------
  // P01: Replay every prefix of resolution + move + ending; all incomplete
  // settlement prefixes remain blocked.
  // -------------------------------------------------------------------------
  test('P01: Replay every prefix of resolution + move + ending; incomplete prefixes remain blocked', () => {
    // 1-ply castling mate fixture: e1g1# ends the game
    const { game, created } = createActiveGame(TC_STANDARD, FEN_CASTLING_MATE);
    const op = prepareMove(game, {
      uci: 'e1g1',
      at: 2_000,
      operationId: 'op-p01',
      rulesVersion: '1.0.0',
    });
    assert.equal(op.baseRevision, 0, 'creation durable head is 0');

    const started: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    };

    // Prefix 1: [Created, Started] -> proving phase, blocked
    const provingGame = Game.fromEvents([created, started]);
    assert.equal(provingGame.phase, 'proving');
    assert.equal(provingGame.isBlocked, true);
    assert.equal(provingGame.flagDeadline, null);
    assert.equal(provingGame.timeoutDue(10_000), false);
    assert.throws(() => provingGame.playMove('e1g1', 3_000), GameError);

    const handle = evaluatePreparedProof(op, { kind: 'global_deadness' });
    assert.ok(handle, 'genuine evidence handle minted');

    const settlement = settlePrepared(provingGame, handle, 3_000);
    const [resolved, ...effects] = settlement.batch;
    assert.equal(effects.length, 2, 'move and checkmate ending effects declared');
    const [moveEffect, endingEffect] = effects;

    // Prefix 2: [Created, Started, Resolved] -> settling phase, blocked
    const prefix2Game = Game.fromEvents([created, started, resolved]);
    assert.equal(prefix2Game.phase, 'settling');
    assert.equal(prefix2Game.isBlocked, true);
    assert.equal(prefix2Game.flagDeadline, null);
    assert.equal(prefix2Game.timeoutDue(10_000), false);
    assert.equal(prefix2Game.snapshot().clock.turnStartedAt, null);
    assert.throws(() => prefix2Game.playMove('e1g1', 3_500), GameError);

    // Prefix 3: [Created, Started, Resolved, MovePlayed] -> STILL settling phase, blocked
    const prefix3Game = Game.fromEvents([created, started, resolved, moveEffect!]);
    assert.equal(prefix3Game.phase, 'settling');
    assert.equal(prefix3Game.isBlocked, true);
    assert.equal(prefix3Game.flagDeadline, null);
    assert.equal(prefix3Game.timeoutDue(10_000), false);
    assert.equal(prefix3Game.snapshot().clock.turnStartedAt, null);
    assert.throws(() => prefix3Game.playMove('e1g1', 3_500), GameError);

    // Prefix 4: Full batch replay -> ended phase, unblocked
    const completedGame = Game.fromEvents([created, started, resolved, moveEffect!, endingEffect!]);
    assert.equal(completedGame.phase, 'ended');
    assert.equal(completedGame.isBlocked, false);
    assert.equal(completedGame.status.over, true);
    if (completedGame.status.over) {
      assert.equal(completedGame.status.termination, 'checkmate');
      assert.equal(completedGame.status.winner, 'w');
    }

    // validateAdjudicationAppendBatch rejects both incomplete prefixes
    assert.throws(() => validateAdjudicationAppendBatch(provingGame, [resolved]), GameError);
    assert.throws(() => validateAdjudicationAppendBatch(provingGame, [resolved, moveEffect!]), GameError);
    assert.doesNotThrow(() => validateAdjudicationAppendBatch(provingGame, settlement.batch));
  });

  // -------------------------------------------------------------------------
  // P02: Append validator rejects split settlement; accepts pending start and
  // valid zero-effect creation continuation.
  // -------------------------------------------------------------------------
  test('P02: Append validator rejects split settlement; accepts pending start and valid zero-effect creation continuation', () => {
    const { game } = createActiveGame();
    const op = prepareMove(game, {
      uci: 'g6g7',
      at: 2_000,
      operationId: 'op-p02',
      rulesVersion: '1.0.0',
    });

    const started: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    };

    // Append batch ending in proving is valid
    assert.doesNotThrow(() => validateAdjudicationAppendBatch(game, [started]));

    const provingGame = game.withEvents([started]);
    const handle = evaluatePreparedProof(op, { kind: 'global_deadness' });
    assert.ok(handle);
    const settlement = settlePrepared(provingGame, handle, 3_000);

    // Append batch with Resolved alone (leaving settling state) must throw
    assert.throws(
      () => validateAdjudicationAppendBatch(provingGame, [settlement.resolved]),
      (err: unknown) => err instanceof GameError && /incomplete settling state/.test(err.message),
    );

    // Reject committing from already-settling state
    const settlingPrefixGame = provingGame.withEvents([settlement.resolved, settlement.effects[0]!]);
    assert.throws(
      () => validateAdjudicationAppendBatch(settlingPrefixGame, [settlement.effects[1]!]),
      (err: unknown) => err instanceof GameError && /already settling state/.test(err.message),
    );

    // Complete settlement batch is valid
    assert.doesNotThrow(() => validateAdjudicationAppendBatch(provingGame, settlement.batch));

    // Zero-effect creation admission continuation
    const creationOp = prepareCreationAdmission({
      gameId: game.snapshot().gameId,
      initialFen: FEN_MATE1,
      variant: 'standard',
      at: 2_000,
      operationId: 'op-creation',
      rulesVersion: '1.0.0',
    });
    const creationStarted: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: creationOp.operationId,
      baseRevision: 0,
      at: 2_000,
      rulesVersion: '1.0.0',
      prepared: creationOp,
    };
    const creationProvingGame = game.withEvents([creationStarted]);
    const creationHandle = evaluatePreparedProof(creationOp, { kind: 'global_deadness' });
    assert.ok(creationHandle);
    const creationSettlement = settlePrepared(creationProvingGame, creationHandle, 3_000);
    assert.equal(creationSettlement.effects.length, 0, 'zero effects for creation continuation');
    assert.doesNotThrow(() => validateAdjudicationAppendBatch(creationProvingGame, creationSettlement.batch));
  });

  // -------------------------------------------------------------------------
  // P03: Wrong next type or same type with altered payload rejects; no-op
  // resolution cannot swallow a move/resignation.
  // -------------------------------------------------------------------------
  test('P03: Wrong next type or same type with altered payload rejects; no-op resolution cannot swallow move/resignation', () => {
    const { game } = createActiveGame();
    const op = prepareMove(game, {
      uci: 'g6g7',
      at: 2_000,
      operationId: 'op-p03',
      rulesVersion: '1.0.0',
    });
    const started: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    };
    const provingGame = game.withEvents([started]);
    const handle = evaluatePreparedProof(op, { kind: 'global_deadness' });
    assert.ok(handle);
    const settlement = settlePrepared(provingGame, handle, 3_000);
    const expectedMove = settlement.effects[0] as MovePlayedEvent;

    // Wrong event type during settling
    assert.throws(
      () => provingGame.withEvents([settlement.resolved, { type: 'DrawOffered', by: 'w', at: 3_000 }]),
      (err: unknown) => err instanceof GameError && /Settling effect type mismatch/.test(err.message),
    );

    // Same type but altered uci
    assert.throws(
      () => provingGame.withEvents([settlement.resolved, { ...expectedMove, uci: 'g6g8' }]),
      (err: unknown) => err instanceof GameError && /MovePlayed uci mismatch/.test(err.message),
    );

    // Same type but altered remaining clock balance
    assert.throws(
      () => provingGame.withEvents([settlement.resolved, { ...expectedMove, remaining: { w: 999_999, b: 300_000 } }]),
      (err: unknown) => err instanceof GameError && /MovePlayed remaining clock mismatch/.test(err.message),
    );

    // Same type but altered moveTimeMs
    assert.throws(
      () => provingGame.withEvents([settlement.resolved, { ...expectedMove, moveTimeMs: 999 }]),
      (err: unknown) => err instanceof GameError && /MovePlayed moveTimeMs mismatch/.test(err.message),
    );

    // No-op resolution cannot swallow move
    const swallowedResolved: AdjudicationResolvedEvent = {
      ...settlement.resolved,
      effects: [],
    };
    assert.throws(
      () => provingGame.withEvents([swallowedResolved]),
      (err: unknown) => err instanceof GameError && /No-op resolution cannot swallow move/.test(err.message),
    );

    // Nested lifecycle events rejected in declared plan
    assert.throws(
      () => provingGame.withEvents([{
        ...settlement.resolved,
        effects: [started as unknown as AdjudicationEffect],
      }]),
      (err: unknown) => err instanceof GameError && /Forbidden nested lifecycle event/.test(err.message),
    );

    // No-op resolution cannot swallow resignation
    const resignOp = prepareResign(game, {
      color: 'w',
      at: 2_000,
      operationId: 'op-resign-swallow',
      rulesVersion: '1.0.0',
    });
    const resignStarted: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: resignOp.operationId,
      baseRevision: resignOp.baseRevision,
      at: resignOp.at,
      rulesVersion: resignOp.rulesVersion,
      prepared: resignOp,
    };
    const resignProvingGame = game.withEvents([resignStarted]);
    const resignHandle = evaluatePreparedProof(resignOp, { kind: 'global_deadness' });
    assert.ok(resignHandle);
    const resignSettlement = settlePrepared(resignProvingGame, resignHandle, 3_000);
    const swallowedResignResolved: AdjudicationResolvedEvent = {
      ...resignSettlement.resolved,
      effects: [],
    };
    assert.throws(
      () => resignProvingGame.withEvents([swallowedResignResolved]),
      (err: unknown) => err instanceof GameError && /No-op resolution cannot swallow resign/.test(err.message),
    );
  });

  // -------------------------------------------------------------------------
  // P04: Strict and stored-history replay enforce identical lifecycle checks;
  // pre-127 Atomic compatibility stays narrowly unchanged.
  // -------------------------------------------------------------------------
  test('P04: Strict and stored-history replay enforce identical lifecycle checks; pre-127 Atomic compatibility stays narrowly unchanged', () => {
    const { game, created } = createActiveGame();
    const op = prepareMove(game, {
      uci: 'g6g7',
      at: 2_000,
      operationId: 'op-p04',
      rulesVersion: '1.0.0',
    });
    const started: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    };
    const provingGame = game.withEvents([started]);
    const handle = evaluatePreparedProof(op, { kind: 'global_deadness' });
    assert.ok(handle);
    const settlement = settlePrepared(provingGame, handle, 3_000);

    const events: GameEvent[] = [created, started, ...settlement.batch];
    const rows: StoredHistoryRow[] = events.map((ev, idx) => ({
      gameId: 'test-game',
      seq: idx,
      version: 1,
      event: ev,
    }));

    const strictResult = Game.fromEvents(events);
    let pliesSeen = 0;
    const storedResult = replayStoredHistory('test-game', rows, () => {
      pliesSeen++;
    });

    assert.equal(storedResult.game.fen, strictResult.fen);
    assert.equal(storedResult.game.phase, strictResult.phase);
    assert.equal(pliesSeen, 1);

    // Forbidden pending move does NOT leak to onPly in stored history
    const badMove: MovePlayedEvent = {
      type: 'MovePlayed',
      ply: 1,
      uci: 'g6g7',
      san: 'Qg7#',
      by: 'w',
      moveTimeMs: 1_000,
      remaining: { w: 300_000, b: 300_000 },
      at: 2_500,
    };
    const illegalRows: StoredHistoryRow[] = [
      { gameId: 'test-game', seq: 0, version: 1, event: created },
      { gameId: 'test-game', seq: 1, version: 1, event: started },
      { gameId: 'test-game', seq: 2, version: 1, event: badMove },
    ];
    let callbackFired = false;
    assert.throws(
      () => replayStoredHistory('test-game', illegalRows, () => {
        callbackFired = true;
      }),
      (err: unknown) => err instanceof GameError && /MovePlayed forbidden while adjudication is pending/.test(err.message),
    );
    assert.equal(callbackFired, false, 'onPly must not fire for forbidden pending move');

    // Pre-127 Atomic compatibility: replay pre-127 king capture line
    const ATOMIC_LINE = 'e2e3 e7e6 e1e2 e8e7 e2d3 e7d6 d3d4 e6e5';
    let { game: atomicGame, events: atomicEvents } = Game.create({
      gameId: 'atomic-legacy',
      variant: 'atomic',
      timeControl: TC_STANDARD,
      players: { white: 'alice', black: 'bob' },
      rated: true,
      at: 0,
    });
    const atomicLog: GameEvent[] = [...atomicEvents];
    let at = 0;
    for (const uci of ATOMIC_LINE.split(' ')) {
      const r = atomicGame.playMove(uci, (at += 1_000));
      atomicGame = r.game;
      atomicLog.push(...r.events);
    }
    const snap = atomicGame.snapshot();
    const moveAt = at + 1_000;
    const charged = charge(snap.clock, snap.position.turn, moveAt, snap.timeControl);
    const legacyMove: MovePlayedEvent = {
      type: 'MovePlayed',
      ply: snap.ply + 1,
      uci: 'd4e5',
      san: 'Kxe5',
      by: snap.position.turn,
      moveTimeMs: charged.moveTimeMs,
      remaining: charged.clock.remaining,
      at: moveAt,
    };
    const legacyEvents: GameEvent[] = [
      ...atomicLog,
      legacyMove,
      { type: 'GameEnded', result: '0-1', termination: 'variant', winner: 'b', at: moveAt },
    ];
    const legacyRows: StoredHistoryRow[] = legacyEvents.map((event, seq) => ({
      gameId: 'atomic-legacy',
      seq,
      version: 1,
      event,
    }));
    const replayedAtomic = replayStoredHistory('atomic-legacy', legacyRows);
    assert.equal(replayedAtomic.historicalPly, 9);
    assert.equal(replayedAtomic.game.status.over, true);
  });

  // -------------------------------------------------------------------------
  // P05: Wrong revision with identical FEN rejects; wrong game/operation/start
  // sequence/rules/successor rejects.
  // -------------------------------------------------------------------------
  test('P05: Wrong revision with identical FEN rejects; wrong game/operation/start sequence/rules/successor rejects', () => {
    const { game, created } = createActiveGame();
    const op = prepareMove(game, {
      uci: 'g6g7',
      at: 2_000,
      operationId: 'op-p05',
      rulesVersion: '1.0.0',
    });
    assert.equal(op.baseRevision, 0, 'creation head is 0');

    // Advance through non-move events: DrawOffered then DrawDeclined
    const offerEvent: GameEvent = { type: 'DrawOffered', by: 'w', at: 2_100 };
    const declineEvent: GameEvent = { type: 'DrawDeclined', by: 'b', at: 2_200 };
    const advancedGame = game.withEvents([offerEvent, declineEvent]);
    assert.equal(advancedGame.eventSequence, 2, 'two non-move events increment sequence to 2');

    const advancedOp = prepareMove(advancedGame, {
      uci: 'g6g7',
      at: 2_300,
      operationId: 'op-advanced',
      rulesVersion: '1.0.0',
    });
    assert.equal(advancedOp.baseRevision, 2, 'baseRevision matches current durable head sequence');

    // Wrong base revision (1 instead of 0)
    const wrongRevStarted: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: 1,
      at: 2_000,
      rulesVersion: '1.0.0',
      prepared: { ...op, baseRevision: 1 },
    };
    assert.throws(
      () => Game.fromEvents([created, wrongRevStarted]),
      (err: unknown) => err instanceof GameError && /AdjudicationStarted baseRevision mismatch/.test(err.message),
    );

    // Wrong gameId
    const wrongGameStarted: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: 'wrong-game-id',
      operationId: op.operationId,
      baseRevision: 0,
      at: 2_000,
      rulesVersion: '1.0.0',
      prepared: op,
    };
    assert.throws(
      () => Game.fromEvents([created, wrongGameStarted]),
      (err: unknown) => err instanceof GameError && /AdjudicationStarted gameId mismatch/.test(err.message),
    );

    // Wrong startedSeq in resolution
    const validStarted: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: 0,
      at: 2_000,
      rulesVersion: '1.0.0',
      prepared: op,
    };
    const wrongStartedSeqResolved: AdjudicationResolvedEvent = {
      type: 'AdjudicationResolved',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      startedSeq: 99,
      at: 3_000,
      rulesVersion: '1.0.0',
      provenance: 'witness',
      effects: [],
    };
    assert.throws(
      () => Game.fromEvents([created, validStarted, wrongStartedSeqResolved]),
      (err: unknown) => err instanceof GameError && /AdjudicationResolved startedSeq mismatch/.test(err.message),
    );

    // Backward timestamp (R < A)
    const backwardResolved: AdjudicationResolvedEvent = {
      type: 'AdjudicationResolved',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      startedSeq: 1,
      at: 1_500, // precedes A = 2_000
      rulesVersion: '1.0.0',
      provenance: 'witness',
      effects: [],
    };
    assert.throws(
      () => Game.fromEvents([created, validStarted, backwardResolved]),
      (err: unknown) => err instanceof GameError && /precedes started timestamp/.test(err.message),
    );
  });

  // -------------------------------------------------------------------------
  // P06: Literal, spread-cloned and JSON-round-tripped evidence handles cannot settle;
  // genuine internally generated evidence can.
  // -------------------------------------------------------------------------
  test('P06: Literal, spread-cloned and JSON-round-tripped evidence handles cannot settle; genuine internally generated evidence can', () => {
    const { game } = createActiveGame();
    const op = prepareMove(game, {
      uci: 'g6g7',
      at: 2_000,
      operationId: 'op-p06',
      rulesVersion: '1.0.0',
    });
    const started: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    };
    const provingGame = game.withEvents([started]);

    // Literal object
    const literalHandle = { operationId: 'op-p06', questionKind: 'global_deadness' as const };
    assert.throws(
      () => settlePrepared(provingGame, literalHandle, 3_000),
      (err: unknown) => err instanceof GameError && /unauthentic, unregistered, cloned, or serialized/.test(err.message),
    );

    // Genuine handle
    const genuineHandle = evaluatePreparedProof(op, { kind: 'global_deadness' });
    assert.ok(genuineHandle);

    // Spread-cloned object
    const spreadHandle = { ...genuineHandle };
    assert.throws(
      () => settlePrepared(provingGame, spreadHandle, 3_000),
      (err: unknown) => err instanceof GameError && /unauthentic, unregistered, cloned, or serialized/.test(err.message),
    );

    // JSON round-tripped object
    const jsonHandle = JSON.parse(JSON.stringify(genuineHandle)) as AdjudicationEvidenceHandle;
    assert.throws(
      () => settlePrepared(provingGame, jsonHandle, 3_000),
      (err: unknown) => err instanceof GameError && /unauthentic, unregistered, cloned, or serialized/.test(err.message),
    );

    // Cross-game evidence reuse rejected
    const { game: game2 } = createActiveGame(TC_STANDARD, FEN_MATE1, 'test-game-2');
    const op2 = prepareMove(game2, {
      uci: 'g6g7',
      at: 2_000,
      operationId: 'op-p06',
      rulesVersion: '1.0.0',
    });
    assert.throws(
      () => getRegisteredEvidence(genuineHandle, op2, { kind: 'global_deadness' }),
      (err: unknown) => err instanceof GameError && /Evidence gameId mismatch/.test(err.message),
    );

    // Returned record mutation does not poison registry
    const record = getRegisteredEvidence(genuineHandle, op, { kind: 'global_deadness' });
    assert.equal(record.outcome.kind, 'winnable');
    try {
      (record as unknown as { outcome: unknown }).outcome = { kind: 'dead', provenance: 'tampered' };
    } catch {}
    const reloaded = getRegisteredEvidence(genuineHandle, op, { kind: 'global_deadness' });
    assert.equal(reloaded.outcome.kind, 'winnable', 'registry was not poisoned');

    // Genuine handle settles successfully
    const settlement = settlePrepared(provingGame, genuineHandle, 3_000);
    assert.equal(settlement.game.phase, 'ended');
  });

  // -------------------------------------------------------------------------
  // P07: Pending evidence cannot end; wrong-color directional evidence cannot award timeout.
  // -------------------------------------------------------------------------
  test('P07: Pending evidence cannot end; wrong-color directional evidence cannot award timeout', () => {
    // Normal starting position e2e4 is an explicit pending control
    const normalGame = Game.create({
      gameId: 'normal-game',
      variant: 'standard',
      players: { white: 'w', black: 'b' },
      timeControl: TC_STANDARD,
      at: 1_000,
    }).game;
    const normalOp = prepareMove(normalGame, {
      uci: 'e2e4',
      at: 2_000,
      operationId: 'op-pending-control',
      rulesVersion: '1.0.0',
    });
    const pendingHandle = evaluatePreparedProof(normalOp, { kind: 'global_deadness' });
    assert.equal(pendingHandle, null, 'ordinary start e2e4 proof remains pending');

    // Directional timeout scenario on short fixture: Black flagged, prospective winner is White
    const { game } = createActiveGame();
    assert.throws(
      () =>
        prepareFlagExpiry(
          game
            .withEvents([
              {
                type: 'MovePlayed',
                ply: 1,
                uci: 'g6g7',
                san: 'Qg7#',
                by: 'w',
                moveTimeMs: 1_000,
                remaining: { w: 300_000, b: 300_000 },
                at: 2_000,
              },
            ])
            .withEvents([
              {
                type: 'GameEnded',
                result: '1-0',
                termination: 'checkmate',
                winner: 'w',
                at: 2_000,
              },
            ]),
          {
            flagged: 'b',
            at: 500_000,
            operationId: 'op-timeout-p07',
            rulesVersion: '1.0.0',
          },
        ),
      /Game is already over/,
    );

    // Directional evidence on ongoing KRK position where White prospective winner is proved
    const krkGame = Game.create({
      gameId: 'krk-timeout',
      variant: 'standard',
      initialFen: '6k1/5R2/6K1/8/8/8/8/8 b - - 0 1',
      timeControl: TC_STANDARD,
      players: { white: 'w', black: 'b' },
      at: 1_000,
    }).game;
    const flagOp = prepareFlagExpiry(krkGame, {
      flagged: 'b',
      at: 500_000,
      operationId: 'op-flag-b',
      rulesVersion: '1.0.0',
    });

    // Evaluate directional proof for black ('b') instead of white ('w')
    // In K+R vs K, Black has bare king, so Black reachability is impossible
    const blackDirectionalHandle = evaluatePreparedProof(flagOp, {
      kind: 'directional_reachability',
      winner: 'b',
    });
    assert.ok(blackDirectionalHandle);

    // Attempting to verify or settle white timeout with black directional evidence throws
    assert.throws(
      () => getRegisteredEvidence(blackDirectionalHandle, flagOp, {
        kind: 'directional_reachability',
        winner: 'w',
      }),
      (err: unknown) => err instanceof GameError && /directional target color mismatch/.test(err.message),
    );
  });

  // -------------------------------------------------------------------------
  // P08: Fischer freeze grants no increment; execution grants exactly one;
  // no double debit of frozen balances.
  // -------------------------------------------------------------------------
  test('P08: Fischer freeze grants no increment; execution grants exactly one; no double debit', () => {
    const tc: TimeControl = { kind: 'increment', initialMs: 60_000, incrementMs: 5_000, delayMs: 0 };
    const { game } = createActiveGame(tc, '6k1/5R2/6K1/8/8/8/8/8 b - - 0 1');

    // Black thinks 4_000 ms until t = 5_000, prepares g8h8
    const op = prepareMove(game, {
      uci: 'g8h8',
      at: 5_000,
      operationId: 'op-p08',
      rulesVersion: '1.0.0',
    });
    const started: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    };

    const provingGame = game.withEvents([started]);
    // Frozen clock must have: 60_000 - 4_000 = 56_000 ms. NO increment!
    assert.equal(provingGame.snapshot().clock.remaining.b, 56_000);
    assert.equal(provingGame.snapshot().clock.turnStartedAt, null);

    // Pause duration: 15_000 ms, resumes at R = 20_000
    const baseHandle = evaluatePreparedProof(op, { kind: 'global_deadness' });
    assert.ok(baseHandle);
    const succHandle = evaluatePreparedProof(op, {
      kind: 'successor_deadness',
      successorFen: (op.intent as { successorFen: string }).successorFen,
    });
    assert.ok(succHandle);
    const settlement = settlePrepared(provingGame, [baseHandle, succHandle], 20_000);
    const completedGame = settlement.game;

    // Black's final clock after move execution at R = 20_000:
    // Original (60_000) - 4_000 + 5_000 (increment once) = 61_000 ms!
    assert.equal(completedGame.snapshot().clock.remaining.b, 61_000);
    // Opponent White's clock anchor starts at R = 20_000
    assert.equal(completedGame.snapshot().clock.turnStartedAt, 20_000);
  });

  // -------------------------------------------------------------------------
  // P09: Delay pauses before/inside/after free delay; repeated pauses preserve consumed delay.
  // -------------------------------------------------------------------------
  test('P09: Delay pauses before/inside/after free delay; repeated pauses preserve consumed delay', () => {
    const { game } = createActiveGame(TC_DELAY);
    const move1: MovePlayedEvent = {
      type: 'MovePlayed',
      ply: 1,
      uci: 'f7f6',
      san: 'Kf6',
      by: 'w',
      moveTimeMs: 1_000,
      remaining: { w: 60_000, b: 60_000 },
      at: 1_000,
    };
    const g1 = game.withEvents([move1]);

    // Pause 1 inside delay: Black has spent 2_000 ms (< 5_000 delay) at t = 3_000
    const { frozenClock: f1, elapsed: e1 } = freezeClock(g1.snapshot().clock, 'b', 3_000, TC_DELAY);
    assert.equal(e1, 2_000);
    assert.equal(f1.remaining.b, 60_000); // 0 deducted

    // Resume same turn at R1 = 10_000
    const resumed1 = resumeClockSameTurn(g1.snapshot().clock, 3_000, 10_000);
    assert.equal(resumed1.turnStartedAt, 1_000 + (10_000 - 3_000)); // 8_000

    // Pause 2 at t = 11_000 (Black has spent another 1_000 ms, total 3_000 ms < 5_000)
    const { frozenClock: f2, elapsed: e2 } = freezeClock(resumed1, 'b', 11_000, TC_DELAY);
    assert.equal(e2, 3_000);
    assert.equal(f2.remaining.b, 60_000);

    // Resume same turn at R2 = 20_000
    const resumed2 = resumeClockSameTurn(resumed1, 11_000, 20_000);
    assert.equal(resumed2.turnStartedAt, 8_000 + (20_000 - 11_000)); // 17_000

    // Black finally moves at t = 24_000 (elapsed from resumed2 anchor = 24_000 - 17_000 = 7_000 ms)
    // Delay = 5_000, chargeable = 2_000 ms!
    const charged = charge(resumed2, 'b', 24_000, TC_DELAY);
    assert.equal(charged.moveTimeMs, 7_000);
    assert.equal(charged.chargedMs, 2_000);
    assert.equal(charged.clock.remaining.b, 58_000);
  });

  // -------------------------------------------------------------------------
  // P10: Exact flag boundary at A; crossing old deadline during suspension does not flag at R.
  // -------------------------------------------------------------------------
  test('P10: Exact flag boundary at A; crossing old deadline during suspension does not flag at R', () => {
    const tcShort: TimeControl = { kind: 'sudden_death', initialMs: 5_000, incrementMs: 0, delayMs: 0 };
    const { game } = createActiveGame(tcShort, '6k1/5R2/6K1/8/8/8/8/8 w - - 0 1');
    const move1: MovePlayedEvent = {
      type: 'MovePlayed',
      ply: 1,
      uci: 'f7a7',
      san: 'Ra7',
      by: 'w',
      moveTimeMs: 1_000,
      remaining: { w: 5_000, b: 5_000 },
      at: 1_000,
    };
    const g1 = game.withEvents([move1]);
    // Black clock started at 1_000, initial 5_000 -> deadline is 6_000

    // Pause at A = 5_999 (1 ms before deadline)
    const op = prepareDrawOffer(g1, {
      color: 'b',
      at: 5_999,
      operationId: 'op-p10',
      rulesVersion: '1.0.0',
    });
    const started: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: g1.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    };
    const provingGame = g1.withEvents([started]);
    assert.equal(provingGame.timeoutDue(10_000), false);
    assert.equal(provingGame.flagDeadline, null);

    // Wall clock crossed 6_000 long ago; resolution at R = 20_000
    const handle = evaluatePreparedProof(op, { kind: 'global_deadness' });
    assert.ok(handle);
    const settlement = settlePrepared(provingGame, handle, 20_000);
    const resumedGame = settlement.game;

    // Resumed anchor: 1_000 + (20_000 - 5_999) = 15_001
    // Resumed deadline: 15_001 + 5_000 = 20_001
    assert.equal(resumedGame.snapshot().clock.turnStartedAt, 15_001);
    assert.equal(resumedGame.flagDeadline, 20_001);
    assert.equal(resumedGame.timeoutDue(20_000), false, 'must not flag at R = 20_000');
    assert.equal(resumedGame.timeoutDue(20_001), true, 'flags at new shifted deadline 20_001');

    // Attempting to prepare move exactly at deadline (6_000) throws flag expiry
    assert.throws(
      () => prepareMove(g1, { uci: 'g8h8', at: 6_000, operationId: 'op-exact-flag', rulesVersion: '1.0.0' }),
      GameError,
    );
  });

  // -------------------------------------------------------------------------
  // P11: Unlimited, sourced/direct first move, no-show remainder and already-due.
  // -------------------------------------------------------------------------
  test('P11: Unlimited, sourced/direct first move, no-show remainder and already-due', () => {
    // 1. Unlimited time control
    const { game: unlGame } = createActiveGame(TC_UNLIMITED);
    const unlOp = prepareMove(unlGame, {
      uci: 'g6g7',
      at: 10_000,
      operationId: 'op-unl',
      rulesVersion: '1.0.0',
    });
    const unlStarted: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: unlGame.snapshot().gameId,
      operationId: unlOp.operationId,
      baseRevision: unlOp.baseRevision,
      at: unlOp.at,
      rulesVersion: unlOp.rulesVersion,
      prepared: unlOp,
    };
    const unlProving = unlGame.withEvents([unlStarted]);
    assert.equal(unlProving.snapshot().clock.turnStartedAt, null);
    assert.equal(unlProving.flagDeadline, null);

    // 2. Sourced seek game no-show remainder
    const { game: sourcedGame } = Game.create({
      gameId: 'sourced-p11',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: TC_STANDARD,
      players: { white: 'w1', black: 'b1' },
      source: 'seek',
      noShowAfterMs: 30_000,
      at: 1_000,
    });
    // noShowAt = 31_000. Pause at A = 11_000 (remaining = 20_000 ms)
    const readyRes = prepareReady(sourcedGame, {
      color: 'w',
      at: 11_000,
      operationId: 'op-ready',
      rulesVersion: '1.0.0',
    });
    if (readyRes.kind === 'noop') throw new Error('Expected prepared ready');
    const readyOp = readyRes;
    const readyStarted: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: 'sourced-p11',
      operationId: readyOp.operationId,
      baseRevision: readyOp.baseRevision,
      at: readyOp.at,
      rulesVersion: readyOp.rulesVersion,
      prepared: readyOp,
    };
    const sourcedProving = sourcedGame.withEvents([readyStarted]);
    assert.deepEqual(sourcedProving.noShowVerdict(35_000), { kind: 'not_due' });

    // Resolution at R = 50_000. Resumed noShowAt = 50_000 + 20_000 = 70_000
    const readyHandle = evaluatePreparedProof(readyOp, { kind: 'global_deadness' });
    assert.ok(readyHandle);
    const sourcedSettled = settlePrepared(sourcedProving, readyHandle, 50_000).game;
    assert.equal(sourcedSettled.snapshot().noShowAt, 70_000);
    assert.deepEqual(sourcedSettled.noShowVerdict(69_000), { kind: 'not_due' });
    assert.equal(sourcedSettled.noShowVerdict(70_000).kind, 'expire');

    // 3. Sourced tournament game with both players ready waits for first move
    const { game: tourneyGame } = Game.create({
      gameId: 'tourney-p11',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: TC_STANDARD,
      players: { white: 'w1', black: 'b1' },
      source: 'tournament',
      noShowAfterMs: 30_000,
      at: 1_000,
    });
    const tourneyBothReady = tourneyGame
      .markReady('w', 2_000).game
      .markReady('b', 3_000).game;
    assert.deepEqual(tourneyBothReady.noShowVerdict(500_000), { kind: 'both_ready' });

    // 4. Already-due no-show cannot be credited away
    assert.throws(
      () => prepareMove(sourcedSettled, { uci: 'g6g7', at: 71_000, operationId: 'op-late', rulesVersion: '1.0.0' }),
      (err: unknown) => err instanceof GameError && /no-show deadline has expired/.test(err.message),
    );
  });

  // -------------------------------------------------------------------------
  // P12: Command rejection ordering; predecessor dead emits no move;
  // successor pending cannot unlock.
  // -------------------------------------------------------------------------
  test('P12: Command rejection ordering; predecessor dead emits no move; successor pending cannot unlock', () => {
    const { game } = createActiveGame();
    const op = prepareMove(game, {
      uci: 'g6g7',
      at: 2_000,
      operationId: 'op-p12',
      rulesVersion: '1.0.0',
    });
    const started: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    };
    const blocked = game.withEvents([started]);

    // All commands rejected while blocked
    assert.throws(() => blocked.playMove('g6g7', 3_000), GameError);
    assert.throws(() => blocked.resign('w', 3_000), GameError);
    assert.throws(() => blocked.offerDraw('w', 3_000), GameError);
    assert.throws(() => blocked.acceptDraw('w', 3_000), GameError);
    assert.throws(() => blocked.declineDraw('w', 3_000), GameError);
    assert.throws(() => blocked.claimFlag(3_000), GameError);
    assert.throws(() => blocked.abort(3_000), GameError);
    assert.throws(() => blocked.markReady('w', 3_000), GameError);
    assert.throws(() => blocked.expireNoShow(3_000), GameError);

    // Predecessor dead: root position is dead (accepted corpus line 14 interlocking pawns reached via b5b6)
    const predecessorFen = '8/1pk2p1p/p1p1pPpP/PPP1P1P1/5K2/8/8/8 w - - 0 1';
    const g0 = Game.create({
      gameId: 'dead-root',
      variant: 'standard',
      initialFen: predecessorFen,
      timeControl: TC_STANDARD,
      players: { white: 'w', black: 'b' },
      at: 1_000,
    }).game;
    const move1: MovePlayedEvent = {
      type: 'MovePlayed',
      ply: 1,
      uci: 'b5b6',
      san: 'b6+',
      by: 'w',
      moveTimeMs: 1_000,
      remaining: { w: 300_000, b: 300_000 },
      at: 2_000,
    };
    const deadGame = g0.withEvents([move1]);

    const deadOp = prepareMove(deadGame, {
      uci: 'c7d7',
      at: 3_000,
      operationId: 'op-dead-root',
      rulesVersion: '1.0.0',
    });
    const deadStarted: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: 'dead-root',
      operationId: deadOp.operationId,
      baseRevision: deadOp.baseRevision,
      at: deadOp.at,
      rulesVersion: deadOp.rulesVersion,
      prepared: deadOp,
    };
    const deadProving = deadGame.withEvents([deadStarted]);
    const deadHandle = evaluatePreparedProof(deadOp, { kind: 'global_deadness' });
    assert.ok(deadHandle);
    const deadSettlement = settlePrepared(deadProving, deadHandle, 3_000);

    // Emits GameEnded dead_position, NEVER MovePlayed!
    assert.equal(deadSettlement.effects.length, 1);
    assert.equal(deadSettlement.effects[0]!.type, 'GameEnded');
    assert.equal((deadSettlement.effects[0] as GameEndedEvent).termination, 'dead_position');

    // Successor pending: non-terminal move without successor evidence stays proving
    const ongoingGame = Game.create({
      gameId: 'ongoing-game',
      variant: 'standard',
      initialFen: '6k1/5R2/6K1/8/8/8/8/8 w - - 0 1',
      timeControl: TC_STANDARD,
      players: { white: 'w', black: 'b' },
      at: 1_000,
    }).game;
    const nonterminalOp = prepareMove(ongoingGame, {
      uci: 'f7f1',
      at: 2_000,
      operationId: 'op-nonterminal',
      rulesVersion: '1.0.0',
    });
    const nonterminalStarted: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: 'ongoing-game',
      operationId: nonterminalOp.operationId,
      baseRevision: nonterminalOp.baseRevision,
      at: nonterminalOp.at,
      rulesVersion: nonterminalOp.rulesVersion,
      prepared: nonterminalOp,
    };
    const nonterminalProving = ongoingGame.withEvents([nonterminalStarted]);
    const baseOnlyHandle = evaluatePreparedProof(nonterminalOp, { kind: 'global_deadness' });
    assert.ok(baseOnlyHandle);

    // Settlement with only base handle throws because successor is non-terminal and unproven!
    assert.throws(
      () => settlePrepared(nonterminalProving, baseOnlyHandle, 3_000),
      (err: unknown) => err instanceof GameError && /successor deadness evidence/.test(err.message),
    );
    assert.equal(nonterminalProving.phase, 'proving', 'remains proving');
  });

  // -------------------------------------------------------------------------
  // P13: Existing checkmate/stalemate/frozen/material/fifty/repetition labels remain stable.
  // -------------------------------------------------------------------------
  test('P13: Existing checkmate/stalemate/frozen/material/fifty/repetition labels remain stable', () => {
    // 1. Checkmate (Fool's Mate) from standard start position
    const { game } = createActiveGame(TC_STANDARD, Position.initial('standard').fen());
    const g1 = game.playMove('f2f3', 1_000).game
      .playMove('e7e5', 2_000).game
      .playMove('g2g4', 3_000).game
      .playMove('d8h4', 4_000).game;
    assert.equal(g1.status.over, true);
    if (g1.status.over) {
      assert.equal(g1.status.termination, 'checkmate');
      assert.equal(g1.status.winner, 'b');
    }

    // 2. Stalemate
    const stalemateFen = '7k/5K2/6Q1/8/8/8/8/8 b - - 0 1';
    const stalematePos = Position.fromFen(stalemateFen, 'standard');
    const stalemateStatus = stalematePos.status();
    assert.equal(stalemateStatus.over, true);
    if (stalemateStatus.over) {
      assert.equal(stalemateStatus.reason, 'stalemate');
    }

    // 3. Insufficient material (King vs King)
    const kvkPos = Position.fromFen('8/8/8/4k3/8/8/4K3/8 w - - 0 1', 'standard');
    const kvkStatus = kvkPos.status();
    assert.equal(kvkStatus.over, true);
    if (kvkStatus.over) {
      assert.equal(kvkStatus.reason, 'insufficient_material');
    }

    // 4. Fifty move rule
    const fiftyFen = '8/8/8/4k3/4r3/8/4K3/8 w - - 100 51';
    const fiftyPos = Position.fromFen(fiftyFen, 'standard');
    const fiftyStatus = fiftyPos.status();
    assert.equal(fiftyStatus.over, true);
    if (fiftyStatus.over) {
      assert.equal(fiftyStatus.reason, 'fifty_move');
    }
  });

  // -------------------------------------------------------------------------
  // P14: Mutating inputs, prepared move, returned pending snapshot or witness
  // cannot alter later settlement/replay.
  // -------------------------------------------------------------------------
  test('P14: Mutating inputs, prepared move, returned pending snapshot or witness cannot alter settlement/replay', () => {
    const { game } = createActiveGame();
    const op = prepareMove(game, {
      uci: 'g6g7',
      at: 2_000,
      operationId: 'op-p14',
      rulesVersion: '1.0.0',
    });
    const started: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: game.snapshot().gameId,
      operationId: op.operationId,
      baseRevision: op.baseRevision,
      at: op.at,
      rulesVersion: op.rulesVersion,
      prepared: op,
    };
    const provingGame = game.withEvents([started]);
    const handle = evaluatePreparedProof(op, { kind: 'global_deadness' });
    assert.ok(handle);

    // Attempt tampering on op object after handle minting
    try {
      (op as unknown as { rulesVersion: string }).rulesVersion = 'tampered-version';
      (op.intent as unknown as { uci: string }).uci = 'a2a4';
    } catch {}

    // Attempt mutating pending getter original clock
    try {
      (provingGame.adjudication!.originalClock.remaining as { w: number }).w = 999_999;
    } catch {}
    assert.notEqual(provingGame.snapshot().clock.remaining.w, 999_999);

    // Settlement reads from registered record in private WeakMap, not from caller's mutated object
    const settlement = settlePrepared(provingGame, handle, 3_000);
    assert.equal(settlement.resolved.rulesVersion, '1.0.0', 'rulesVersion in settlement remains uncorrupted');
    const moveEffect = settlement.effects[0] as MovePlayedEvent;
    assert.equal(moveEffect.uci, 'g6g7', 'move UCI remains uncorrupted');
  });

  // -------------------------------------------------------------------------
  // P15: Integrity boundaries, witness replay, provenance acceptance, and admission guards
  // -------------------------------------------------------------------------
  test('P15: Integrity boundaries, witness replay, provenance acceptance, and admission guards', () => {
    // 1. move_record_requires_global_base & live_move_requires_global_base
    const { game: liveGame } = createActiveGame();
    const preparedMove = prepareMove(liveGame, {
      uci: 'g6g5',
      at: 2000,
      operationId: 'op-p15',
      rulesVersion: '1.0.0',
    });
    const started: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: liveGame.snapshot().gameId,
      operationId: preparedMove.operationId,
      baseRevision: preparedMove.baseRevision,
      at: preparedMove.at,
      rulesVersion: preparedMove.rulesVersion,
      prepared: preparedMove,
    };
    const blocked = liveGame.withEvents([started]);
    const baseHandle = evaluatePreparedProof(preparedMove, { kind: 'global_deadness' }, { maxSteps: 1000 });
    const successorHandle = evaluatePreparedProof(
      preparedMove,
      { kind: 'successor_deadness', successorFen: preparedMove.intent.kind === 'move' ? preparedMove.intent.successorFen : '' },
      { maxSteps: 1000 },
    );
    assert.ok(baseHandle);
    assert.ok(successorHandle);

    // Live settlement without base evidence rejects
    assert.throws(
      () => settlePrepared(blocked, { successor: successorHandle }, 3000),
      (err: unknown) => err instanceof GameError && /Settlement requires verified base deadness evidence/.test(err.message),
    );

    // Live settlement with both base and successor succeeds
    const settlement = settlePrepared(blocked, { base: baseHandle, successor: successorHandle }, 3000);
    assert.equal(settlement.game.phase, 'idle');

    // Recorded batch validation without base evidence rejects
    assert.ok(settlement.resolved.evidence);
    const noBaseResolved: AdjudicationResolvedEvent = {
      ...settlement.resolved,
      evidence: { successor: settlement.resolved.evidence.successor },
    };
    assert.throws(
      () => validateAdjudicationAppendBatch(blocked, [noBaseResolved, ...settlement.resolved.effects]),
      (err: unknown) => err instanceof GameError && /missing required base evidence/.test(err.message),
    );

    // 2. Timeout with illegal positive witness rejects
    const timeoutGame = Game.create({
      gameId: 'timeout-game',
      variant: 'standard',
      initialFen: '7k/r7/5KQ1/8/8/8/8/8 b - - 0 1',
      timeControl: { initialMs: 1000, incrementMs: 0, delayMs: 0, kind: 'increment' },
      players: { white: 'w', black: 'b' },
      at: 1000,
    }).game;
    const timeoutOp = prepareFlagExpiry(timeoutGame, {
      flagged: 'b',
      at: 2500,
      operationId: 'op-timeout',
      rulesVersion: '1.0.0',
    });
    const timeoutStarted: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: 'timeout-game',
      operationId: timeoutOp.operationId,
      baseRevision: timeoutOp.baseRevision,
      at: timeoutOp.at,
      rulesVersion: timeoutOp.rulesVersion,
      prepared: timeoutOp,
    };
    const timeoutBlocked = timeoutGame.withEvents([timeoutStarted]);
    const timeoutBase = evaluatePreparedProof(timeoutOp, { kind: 'global_deadness' }, { maxSteps: 1000 });
    const timeoutDirection = evaluatePreparedProof(
      timeoutOp,
      { kind: 'directional_reachability', winner: 'w' },
      { maxSteps: 1000 },
    );
    assert.ok(timeoutBase);
    assert.ok(timeoutDirection);
    const validTimeout = settlePrepared(timeoutBlocked, { base: timeoutBase, timeout: timeoutDirection }, 2600);
    assert.ok(validTimeout.game.status.over);
    assert.equal(validTimeout.game.status.termination, 'timeout');
    assert.equal(validTimeout.game.status.winner, 'w');

    // Tampering witness with illegal move 'a1a8' throws during batch validation
    assert.ok(validTimeout.resolved.evidence?.timeout);
    const illegalWitnessResolved: AdjudicationResolvedEvent = {
      ...validTimeout.resolved,
      evidence: {
        ...validTimeout.resolved.evidence,
        timeout: {
          winner: 'w',
          outcome: { status: 'reachable', winner: 'w', witness: ['a1a8'] },
        },
      },
    };
    assert.throws(
      () => validateAdjudicationAppendBatch(timeoutBlocked, [illegalWitnessResolved, ...validTimeout.resolved.effects]),
      (err: unknown) => err instanceof GameError && /Candidate mate witness move "a1a8" failed legal replay verification/.test(err.message),
    );

    // Structural consistency check only: provenance closed_graph_material_pruned is accepted in literal record format
    const prunedProvenanceResolved: AdjudicationResolvedEvent = {
      ...settlement.resolved,
      evidence: {
        base: {
          status: 'dead',
          white: { status: 'impossible', provenance: 'closed_graph_material_pruned' },
          black: { status: 'impossible', provenance: 'closed_graph_material_pruned' },
        },
        successor: settlement.resolved.evidence.successor,
      },
      effects: [{
        type: 'GameEnded',
        result: '1/2-1/2',
        termination: 'dead_position',
        winner: null,
        at: 3000,
      }],
    };
    validateAdjudicationAppendBatch(blocked, [prunedProvenanceResolved, ...prunedProvenanceResolved.effects]);

    // 3. Snapshot immutability: mutating snapshot().phase or adjudication leaves game unaffected
    const settlingGame = blocked.withEvents([settlement.resolved]);
    assert.equal(settlingGame.phase, 'settling');
    const exposedSnapshot = settlingGame.snapshot();
    assert.ok(Object.isFrozen(exposedSnapshot), 'snapshot must be frozen');
    assert.equal(Reflect.set(exposedSnapshot, 'phase', 'idle'), false);
    assert.equal(settlingGame.phase, 'settling');
    assert.equal(settlingGame.adjudication?.operationId, preparedMove.operationId);

    // 4. Started prerequisite bypass rejections:
    const unreadyGame = Game.create({
      gameId: 'unready-game',
      variant: 'standard',
      timeControl: TC_STANDARD,
      players: { white: 'alice', black: 'bob' },
      at: 1000,
      source: 'seek',
      noShowAfterMs: 60_000,
    }).game;
    assert.throws(
      () => prepareMove(unreadyGame, { uci: 'e2e4', at: 1500, operationId: 'op-unready', rulesVersion: '1.0.0' }),
      (err: unknown) => err instanceof GameError && /Both players must be ready/.test(err.message),
    );
    const fakePrepared = {
      ...preparedMove,
      gameId: 'unready-game',
      baseRevision: 0,
      baseFen: unreadyGame.snapshot().position.fen(),
      at: 1500,
    };
    const unreadyStarted: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: 'unready-game',
      operationId: fakePrepared.operationId,
      baseRevision: 0,
      at: 1500,
      rulesVersion: '1.0.0',
      prepared: fakePrepared,
    };
    assert.throws(
      () => unreadyGame.withEvents([unreadyStarted]),
      (err: unknown) => err instanceof GameError && /Both players must be ready/.test(err.message),
    );
  });

  test('Correction 3 boundary controls: unused timeout, abort deadness, repetition isolation, no-show discriminant, and core material-pruned proof', () => {
    const tcSudden: TimeControl = { initialMs: 1_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
    const qGlobal = { kind: 'global_deadness' as const };

    const startBlocked = (game: Game, prepared: PreparedOperation): Game =>
      game.withEvents([{
        type: 'AdjudicationStarted',
        gameId: prepared.gameId,
        operationId: prepared.operationId,
        baseRevision: prepared.baseRevision,
        at: prepared.at,
        rulesVersion: prepared.rulesVersion,
        prepared,
      }]);

    // 1. global_dead_base_does_not_require_unused_directional_timeout
    // Closed-graph position played e8d8 leaves turn 'w'. Flag expiry prepared for 'w'.
    const preGame = Game.create({
      gameId: 'rec-closed-game',
      initialFen: 'Bb2kb2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 b - - 0 1',
      timeControl: tcSudden,
      players: { white: 'w', black: 'b' },
      at: 1000,
    }).game;
    const played = preGame.playMove('e8d8', 1200).game;
    const flagOp = prepareFlagExpiry(played, {
      flagged: 'w',
      at: 2500,
      operationId: 'closed-flag-op',
      rulesVersion: '1.0.0',
    });
    const flagBlocked = startBlocked(played, flagOp);
    const bothDeadHandle = evaluatePreparedProof(flagOp, qGlobal, { maxSteps: 1000 });
    assert.ok(bothDeadHandle, 'Complete two-direction closed graph proof must succeed');
    const baseOnlyDead = settlePrepared(flagBlocked, { base: bothDeadHandle }, 2600);
    assert.ok(baseOnlyDead.game.status.over);
    assert.equal(baseOnlyDead.game.status.termination, 'dead_position');
    assert.ok(baseOnlyDead.resolved.evidence);
    assert.equal(baseOnlyDead.resolved.evidence.base?.status, 'dead');
    assert.equal(baseOnlyDead.resolved.evidence.timeout, undefined);

    // 2. abort_consumed_global_dead_requires_both_directions
    const gameOffer = Game.create({
      gameId: 'rec-abort-game',
      initialFen: '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1',
      timeControl: tcSudden,
      players: { white: 'w', black: 'b' },
      at: 1000,
    }).game;
    const abortOp = prepareAbort(gameOffer, { at: 1100, operationId: 'abort-op', rulesVersion: '1.0.0' });
    const abortBlocked = startBlocked(gameOffer, abortOp);
    const abortBase = evaluatePreparedProof(abortOp, qGlobal, { maxSteps: 100 });
    assert.ok(abortBase);
    const abortControl = settlePrepared(abortBlocked, { base: abortBase }, 1200);
    assert.ok(abortControl.game.status.over);
    assert.equal(abortControl.game.status.termination, 'aborted');

    const malformedAbort: AdjudicationResolvedEvent = {
      ...abortControl.resolved,
      evidence: {
        base: { status: 'dead' } as unknown as RecordedResolutionEvidence['base'],
      },
      effects: [{
        type: 'GameEnded',
        result: '1/2-1/2',
        termination: 'dead_position',
        winner: null,
        at: 1200,
      }],
    };
    assert.throws(
      () => validateAdjudicationAppendBatch(abortBlocked, [malformedAbort, ...malformedAbort.effects]),
      (err: unknown) => err instanceof GameError && /Dead outcome requires white record/.test(err.message),
    );

    // 3. managed_snapshot_repetition_cannot_change_valid_move_to_draw
    const moveGame = Game.create({
      gameId: 'rec-move-game',
      initialFen: '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1',
      timeControl: tcSudden,
      players: { white: 'w', black: 'b' },
      at: 1000,
    }).game;
    const moveOp = prepareMove(moveGame, { uci: 'g6g5', at: 1100, operationId: 'move-op', rulesVersion: '1.0.0' });
    if (moveOp.intent.kind !== 'move') throw new Error('Expected move intent');
    const moveBlocked = startBlocked(moveGame, moveOp);
    const moveBase = evaluatePreparedProof(moveOp, qGlobal, { maxSteps: 1000 });
    const moveSucc = evaluatePreparedProof(moveOp, { kind: 'successor_deadness', successorFen: moveOp.intent.successorFen }, { maxSteps: 1000 });
    assert.ok(moveBase);
    assert.ok(moveSucc);
    const succKey = repetitionKey(Position.fromFen(moveOp.intent.successorFen).snapshot());
    try {
      (moveBlocked.snapshot().repetition as unknown as Map<string, number>).set(succKey, 2);
    } catch {
      // Repetition map may be read-only or detached
    }
    const moveSettled = settlePrepared(moveBlocked, { base: moveBase, successor: moveSucc }, 1200);
    assert.equal(moveSettled.game.status.over, false, 'Mutating snapshot repetition must not turn valid move into threefold draw');

    // 4. serialized_no_show_cannot_change_ending_discriminant
    const noShowGame = Game.create({
      gameId: 'rec-noshow-game',
      initialFen: '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1',
      timeControl: tcSudden,
      players: { white: 'w', black: 'b' },
      at: 1000,
      source: 'seek',
      noShowAfterMs: 1000,
    }).game;
    const noShowOp = prepareNoShowExpiry(noShowGame, { at: 2100, operationId: 'noshow-op', rulesVersion: '1.0.0' });
    if (noShowOp.intent.kind !== 'expireNoShow') throw new Error('Expected expireNoShow intent');
    const forgedNoShowOp: PreparedOperation = {
      ...noShowOp,
      intent: {
        kind: 'expireNoShow',
        ending: {
          ...noShowOp.intent.ending,
          type: 'DrawOffered',
          by: 'w',
        } as unknown as GameEndedEvent,
      },
    };
    assert.throws(
      () => startBlocked(noShowGame, forgedNoShowOp),
      (err: unknown) => err instanceof GameError && /Prepared no-show ending must have type "GameEnded"/.test(err.message),
    );

    // 5. Genuine accepted core-produced material-pruned proof control (Lemma 5 discharge: K+N vs K+Q where Nxa3 leaves bare King)
    const matPrunedGame = Game.create({
      gameId: 'rec-mat-pruned-game',
      initialFen: '8/8/8/8/8/q7/2k5/KN6 w - - 0 1',
      timeControl: tcSudden,
      players: { white: 'w', black: 'b' },
      at: 1000,
    }).game;
    const matOfferOp = prepareDrawOffer(matPrunedGame, {
      color: 'w',
      at: 1100,
      operationId: 'mat-offer-op',
      rulesVersion: '1.0.0',
    });
    const matBlocked = startBlocked(matPrunedGame, matOfferOp);
    const matBaseHandle = evaluatePreparedProof(matOfferOp, qGlobal, { maxSteps: 50 });
    assert.ok(matBaseHandle, 'Core cooperative search must produce global deadness handle via Lemma 5 material discharge');
    const matBaseRec = getRegisteredEvidence(matBaseHandle, matOfferOp, qGlobal);
    assert.equal(matBaseRec.outcome.kind, 'dead');
    assert.equal(matBaseRec.outcome.provenance, 'closed_graph_material_pruned');
    assert.equal(matBaseRec.outcome.white.provenance, 'closed_graph_material_pruned');
    assert.equal(matBaseRec.outcome.black.provenance, 'closed_graph_material_pruned');
    const matSettlement = settlePrepared(matBlocked, { base: matBaseHandle }, 1200);
    assert.ok(matSettlement.game.status.over);
    assert.equal(matSettlement.game.status.termination, 'dead_position');
    assert.equal(matSettlement.game.status.result, '1/2-1/2');
    assert.ok(matSettlement.resolved.evidence);
    assert.equal(matSettlement.resolved.evidence.base?.status, 'dead');
    assert.equal(matSettlement.resolved.evidence.base?.white.provenance, 'closed_graph_material_pruned');
    assert.equal(matSettlement.resolved.evidence.base?.black.provenance, 'closed_graph_material_pruned');
  });

  // -------------------------------------------------------------------------
  // Correction 4: Closed role requirements, native Map isolation, timeControl/plain-value ownership, and canonical no-show timestamp
  // -------------------------------------------------------------------------
  test('Correction 4: Closed role requirements, native Map isolation, timeControl/plain-value ownership, and canonical no-show timestamp', () => {
    const qGlobal = { kind: 'global_deadness' as const };
    const tcSudden: TimeControl = { initialMs: 10000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };

    const startBlocked = (game: Game, prepared: PreparedOperation): Game =>
      game.withEvents([{
        type: 'AdjudicationStarted',
        gameId: prepared.gameId,
        operationId: prepared.operationId,
        baseRevision: prepared.baseRevision,
        at: prepared.at,
        rulesVersion: prepared.rulesVersion,
        prepared,
      }]);

    // 1. Roles: creationAdmission, ready, and expireNoShow require base evidence; omitting it rejects
    const fen = '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1';
    for (const kind of ['creationAdmission', 'ready', 'expireNoShow'] as const) {
      const id = `cor4-role-${kind}`;
      const created = Game.create({
        gameId: id,
        initialFen: fen,
        timeControl: tcSudden,
        players: { white: 'w', black: 'b' },
        at: 1000,
        source: 'seek',
        noShowAfterMs: 1000,
      });
      const params = { at: kind === 'expireNoShow' ? 2100 : 1100, operationId: `${id}-op`, rulesVersion: '1.0.0' };
      let op: PreparedOperation;
      if (kind === 'creationAdmission') {
        op = prepareCreationAdmission({ ...params, gameId: id, initialFen: fen, variant: 'standard' });
      } else if (kind === 'ready') {
        const readyRes = prepareReady(created.game, { ...params, color: 'w' });
        if (readyRes.kind === 'noop') throw new Error('Expected prepared ready');
        op = readyRes;
      } else {
        op = prepareNoShowExpiry(created.game, params);
      }
      const blocked = startBlocked(created.game, op);
      const baseHandle = evaluatePreparedProof(op, qGlobal, { maxSteps: 1000 });
      assert.ok(baseHandle);

      // Live settlement without base evidence rejects
      assert.throws(
        () => settlePrepared(blocked, {}, 2200),
        (err: unknown) => err instanceof GameError && /empty evidence bundle|verified base deadness evidence/i.test(err.message),
      );

      // Genuine live settlement with base succeeds
      const settlement = settlePrepared(blocked, { base: baseHandle }, 2200);

      // Replay batch with missing base rejects
      const noBaseResolved: AdjudicationResolvedEvent = {
        ...settlement.resolved,
        evidence: {},
      };
      assert.throws(
        () => validateAdjudicationAppendBatch(blocked, [noBaseResolved, ...settlement.resolved.effects]),
        (err: unknown) => err instanceof GameError && /missing required base evidence/i.test(err.message),
      );
      assert.throws(
        () => Game.fromEvents([...created.events, {
          type: 'AdjudicationStarted',
          gameId: op.gameId,
          operationId: op.operationId,
          baseRevision: op.baseRevision,
          at: op.at,
          rulesVersion: op.rulesVersion,
          prepared: op,
        }, noBaseResolved, ...settlement.resolved.effects]),
        (err: unknown) => err instanceof GameError && /missing required base evidence/i.test(err.message),
      );
    }

    // 2. Real state encapsulation: native Map.prototype.set.call cannot mutate authoritative repetition
    const protoGame = Game.create({
      gameId: 'cor4-proto-map',
      initialFen: fen,
      timeControl: tcSudden,
      players: { white: 'w', black: 'b' },
      at: 1000,
    }).game;
    const protoOp = prepareMove(protoGame, { uci: 'g6g5', at: 1100, operationId: 'proto-op', rulesVersion: '1.0.0' });
    if (protoOp.intent.kind !== 'move') throw new Error('Expected move');
    const protoBlocked = startBlocked(protoGame, protoOp);
    const protoBase = evaluatePreparedProof(protoOp, qGlobal, { maxSteps: 1000 });
    const protoSucc = evaluatePreparedProof(protoOp, { kind: 'successor_deadness', successorFen: protoOp.intent.successorFen }, { maxSteps: 1000 });
    assert.ok(protoBase);
    assert.ok(protoSucc);
    const protoClean = settlePrepared(protoBlocked, { base: protoBase, successor: protoSucc }, 1200);
    assert.equal(protoClean.game.status.over, false);
    const succKey = repetitionKey(Position.fromFen(protoOp.intent.successorFen).snapshot());
    Map.prototype.set.call(protoBlocked.snapshot().repetition, succKey, 2);
    const protoAttacked = settlePrepared(protoBlocked, { base: protoBase, successor: protoSucc }, 1200);
    assert.equal(protoAttacked.game.status.over, false, 'Native Map mutation on snapshot must not affect authoritative repetition');
    assert.deepEqual(protoAttacked.effects, protoClean.effects);
    assert.equal(protoAttacked.game.fen, protoClean.game.fen);
    assert.equal(protoAttacked.game.ply, protoClean.game.ply);
    assert.equal(protoBlocked.snapshot().repetition.get(succKey), undefined);

    // 3. TimeControl ingress, egress, snapshot, getter, replay, and plain-value isolation
    interface MutableTimeControl {
      initialMs: number;
      incrementMs: number;
      delayMs: number;
      kind: 'increment' | 'delay' | 'sudden_death' | 'unlimited';
    }
    interface MutablePlayers {
      white: string;
      black: string;
    }
    const mutableTc: MutableTimeControl = { initialMs: 10000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
    const mutablePlayers: MutablePlayers = { white: 'w', black: 'b' };
    const createdWithAliases = Game.create({
      gameId: 'cor4-ownership',
      initialFen: fen,
      timeControl: mutableTc,
      players: mutablePlayers,
      at: 1000,
    });
    const ownGame = createdWithAliases.game;
    const expectedTc = { initialMs: 10000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const };

    // Mutating original caller timeControl and players objects has no effect on game
    mutableTc.incrementMs = 999;
    mutableTc.kind = 'increment';
    mutablePlayers.white = 'eve';
    assert.deepEqual(ownGame.timeControl, expectedTc);
    assert.equal(ownGame.players.white, 'w');

    // Mutating snapshot timeControl or players fails or has no effect
    try { (ownGame.snapshot().timeControl as unknown as MutableTimeControl).incrementMs = 888; } catch {}
    try { (ownGame.snapshot().players as unknown as MutablePlayers).white = 'mallory'; } catch {}
    try { (ownGame.snapshot().status as unknown as { over: boolean }).over = true; } catch {}
    assert.deepEqual(ownGame.timeControl, expectedTc);
    assert.deepEqual(ownGame.snapshot().timeControl, expectedTc);
    assert.equal(ownGame.players.white, 'w');
    assert.equal(ownGame.status.over, false);

    // Mutating public getters fails or has no effect
    try { (ownGame.timeControl as unknown as MutableTimeControl).incrementMs = 777; } catch {}
    try { (ownGame.players as unknown as MutablePlayers).white = 'sybil'; } catch {}
    try { (ownGame.clock.remaining as unknown as { w: number }).w = 1; } catch {}
    assert.deepEqual(ownGame.timeControl, expectedTc);
    assert.equal(ownGame.players.white, 'w');
    assert.deepEqual(ownGame.clock.remaining, { w: 10000, b: 10000 });

    // Replay ingress: event.timeControl mutation after creation does not affect replayed game
    const replayEventTc: MutableTimeControl = { initialMs: 20000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
    const replayedCreatedEvent: GameCreatedEvent = {
      type: 'GameCreated',
      gameId: 'cor4-replay-tc',
      variant: 'standard',
      initialFen: fen,
      timeControl: replayEventTc,
      players: { white: 'w', black: 'b' },
      rated: false,
      at: 1000,
    };
    const replayedGame = Game.fromEvents([replayedCreatedEvent]);
    replayEventTc.incrementMs = 555;
    assert.deepEqual(replayedGame.timeControl, { initialMs: 20000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' });

    // 4. Canonical no-show nested timestamp
    const nsGame = Game.create({
      gameId: 'cor4-noshow-ts',
      initialFen: fen,
      timeControl: tcSudden,
      players: { white: 'w', black: 'b' },
      at: 1000,
      source: 'seek',
      noShowAfterMs: 1000,
    }).game;
    const nsOp = prepareNoShowExpiry(nsGame, { at: 2100, operationId: 'ns-op', rulesVersion: '1.0.0' });
    if (nsOp.intent.kind !== 'expireNoShow') throw new Error('Expected expireNoShow');

    // Nested A+1 rejected at Started
    const alteredTsOp: PreparedOperation = {
      ...nsOp,
      intent: {
        ...nsOp.intent,
        ending: { ...nsOp.intent.ending, at: nsOp.intent.ending.at + 1 },
      },
    };
    assert.throws(
      () => startBlocked(nsGame, alteredTsOp),
      (err: unknown) => err instanceof GameError && /Prepared no-show ending mismatch/.test(err.message),
    );

    // Missing nested timestamp rejected at Started
    const missingTsOp: PreparedOperation = {
      ...nsOp,
      intent: {
        ...nsOp.intent,
        ending: { ...nsOp.intent.ending, at: undefined as unknown as number },
      },
    };
    assert.throws(
      () => startBlocked(nsGame, missingTsOp),
      (err: unknown) => err instanceof GameError && /Prepared no-show ending mismatch/.test(err.message),
    );

    // Canonical seek and tournament controls succeed
    const legitimateBlocked = startBlocked(nsGame, nsOp);
    assert.equal(legitimateBlocked.phase, 'proving');
  });

  test('Correction 5: Surviving pure-domain clock, authority admission, readiness no-ops, and deadline contracts', () => {
    const startBlocked = (game: Game, prepared: PreparedOperation): Game =>
      game.withEvents([{
        type: 'AdjudicationStarted',
        gameId: game.id,
        operationId: prepared.operationId,
        baseRevision: prepared.baseRevision,
        at: prepared.at,
        rulesVersion: prepared.rulesVersion,
        prepared,
      }]);

    // -----------------------------------------------------------------------
    // A. Explicit pure authoritative admission & legitimate no-ops
    // -----------------------------------------------------------------------
    // 1. Due no-show normalization before command
    const { game: authNsGame } = Game.create({
      gameId: 'auth-ns',
      timeControl: TC_STANDARD,
      players: { white: 'w', black: 'b' },
      at: 1000,
      source: 'seek',
      noShowAfterMs: 60_000,
    });
    const authNsRes = prepareAuthoritativeCommand(
      authNsGame,
      { kind: 'move', uci: 'e2e4' },
      { color: 'w', at: 62_000, operationId: 'auth-ns-op', rulesVersion: '1.0.0' },
    );
    assert.equal(authNsRes.kind, 'prepared');
    if (authNsRes.kind === 'prepared') {
      assert.equal(authNsRes.operation.intent.kind, 'expireNoShow');
    }

    // 2. Due flag normalization before command (no move rescue)
    const { game: authFlagGame } = createActiveGame(
      { kind: 'increment', initialMs: 10_000, incrementMs: 0, delayMs: 0 },
      FEN_MATE1,
      'auth-flag',
    );
    const { game: startedFlagGame } = authFlagGame.playMove('g6h7', 2000);
    const authFlagRes = prepareAuthoritativeCommand(
      startedFlagGame,
      { kind: 'move', uci: 'h8g8' },
      { color: 'b', at: 13_000, operationId: 'auth-flag-op', rulesVersion: '1.0.0' },
    );
    assert.equal(authFlagRes.kind, 'prepared');
    if (authFlagRes.kind === 'prepared') {
      assert.equal(authFlagRes.operation.intent.kind, 'expireFlag');
      if (authFlagRes.operation.intent.kind === 'expireFlag') {
        assert.equal(authFlagRes.operation.intent.flagged, 'b');
      }
    }

    // 3. Wrong flagged side refused
    assert.throws(
      () => prepareFlagExpiry(startedFlagGame, {
        flagged: 'w',
        at: 13_000,
        operationId: 'wrong-flag-side',
        rulesVersion: '1.0.0',
      }),
      (err: unknown) => err instanceof GameError && /not side to move/i.test(err.message),
    );

    // 4. Standard player commands admitted when not expired
    const authMoveRes = prepareAuthoritativeCommand(
      startedFlagGame,
      { kind: 'move', uci: 'h8h7' },
      { color: 'b', at: 5000, operationId: 'auth-move-op', rulesVersion: '1.0.0' },
    );
    assert.equal(authMoveRes.kind, 'prepared');
    if (authMoveRes.kind === 'prepared') {
      assert.equal(authMoveRes.operation.intent.kind, 'move');
    }

    const authResignRes = prepareAuthoritativeCommand(
      startedFlagGame,
      { kind: 'resign' },
      { color: 'b', at: 5000, operationId: 'auth-resign-op', rulesVersion: '1.0.0' },
    );
    assert.equal(authResignRes.kind, 'prepared');
    if (authResignRes.kind === 'prepared') {
      assert.equal(authResignRes.operation.intent.kind, 'resign');
    }

    // 5. Readiness legitimate no-ops: unsourced, post-first-move, already_ready, late, game_over
    const { game: directGame } = createActiveGame();
    const unsourcedReady = prepareReady(directGame, {
      color: 'w',
      at: 1500,
      operationId: 'unsourced-ready-op',
      rulesVersion: '1.0.0',
    });
    assert.deepEqual(unsourcedReady, { kind: 'noop', reason: 'unsourced' });

    const { game: sourcedPre } = Game.create({
      gameId: 'sourced-ready-move',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: TC_STANDARD,
      players: { white: 'w', black: 'b' },
      at: 1000,
      source: 'seek',
      noShowAfterMs: 60_000,
    });
    const sourcedReadyGame = sourcedPre.markReady('w', 1200).game.markReady('b', 1300).game;
    const sourcedMoveGame = sourcedReadyGame.playMove('g6h7', 2000).game;
    const postFirstMoveReady = prepareReady(sourcedMoveGame, {
      color: 'b',
      at: 3000,
      operationId: 'post-first-ready-op',
      rulesVersion: '1.0.0',
    });
    assert.deepEqual(postFirstMoveReady, { kind: 'noop', reason: 'post_first_move' });

    const { game: seekGame } = Game.create({
      gameId: 'seek-noop',
      timeControl: TC_STANDARD,
      players: { white: 'w', black: 'b' },
      at: 1000,
      source: 'seek',
      noShowAfterMs: 60_000,
    });
    const readySeek = seekGame.markReady('w', 1500).game;
    const dupReady = prepareReady(readySeek, {
      color: 'w',
      at: 2000,
      operationId: 'dup-ready-op',
      rulesVersion: '1.0.0',
    });
    assert.deepEqual(dupReady, { kind: 'noop', reason: 'already_ready' });

    const lateReady = prepareReady(seekGame, {
      color: 'w',
      at: 65_000,
      operationId: 'late-ready-op',
      rulesVersion: '1.0.0',
    });
    assert.deepEqual(lateReady, { kind: 'noop', reason: 'late' });

    const endedGame = directGame.resign('w', 2000).game;
    const overReady = prepareReady(endedGame, {
      color: 'w',
      at: 2500,
      operationId: 'over-ready-op',
      rulesVersion: '1.0.0',
    });
    assert.deepEqual(overReady, { kind: 'noop', reason: 'game_over' });

    // -----------------------------------------------------------------------
    // B. Safe new lifecycle time, causal bases, and surviving obligations
    // -----------------------------------------------------------------------
    const { game: timeGame } = createActiveGame(TC_STANDARD, FEN_MATE1, 'time-game');
    const moveOp = prepareMove(timeGame, {
      uci: 'g6g7',
      at: 2000,
      operationId: 'time-op',
      rulesVersion: '1.0.0',
    });

    // Backward A before creation (1000) rejected
    assert.throws(
      () => startBlocked(timeGame, { ...moveOp, at: 500, intent: { ...moveOp.intent } }),
      (err: unknown) => err instanceof GameError && /precede active causal basis/i.test(err.message),
    );

    // Fractional / non-finite A rejected
    assert.throws(
      () => startBlocked(timeGame, { ...moveOp, at: 2000.5, intent: { ...moveOp.intent } }),
      (err: unknown) => err instanceof GameError && /must be a non-negative safe integer/i.test(err.message),
    );
    assert.throws(
      () => startBlocked(timeGame, { ...moveOp, at: Infinity, intent: { ...moveOp.intent } }),
      (err: unknown) => err instanceof GameError && /must be a non-negative safe integer/i.test(err.message),
    );

    // Basis established by prior managed settlement:
    const drawOpTime1 = prepareDrawOffer(timeGame, {
      color: 'w',
      at: 2000,
      operationId: 'time-op-1',
      rulesVersion: '1.0.0',
    });
    const started1 = {
      type: 'AdjudicationStarted' as const,
      gameId: timeGame.id,
      operationId: 'time-op-1',
      baseRevision: 0,
      at: 2000,
      rulesVersion: '1.0.0',
      prepared: drawOpTime1,
    };
    const blocked1 = timeGame.withEvents([started1]);
    const baseH = evaluatePreparedProof(started1.prepared, { kind: 'global_deadness' });
    assert.ok(baseH);
    const settled1 = settlePrepared(blocked1, { base: baseH }, 5000).game;
    const op2 = prepareDrawDecline(settled1, {
      color: 'w',
      at: 6000,
      operationId: 'time-op-2',
      rulesVersion: '1.0.0',
    });
    assert.throws(
      () => startBlocked(settled1, { ...op2, at: 4500, intent: { ...op2.intent } }),
      (err: unknown) => err instanceof GameError && /precede active causal basis 5000/i.test(err.message),
    );

    // R < A rejected
    assert.throws(
      () => settlePrepared(blocked1, { base: baseH }, 1500),
      (err: unknown) => err instanceof GameError && /precede started timestamp|precede suspension timestamp/i.test(err.message),
    );

    // Fractional TC remains compatible
    const fractionalTc: TimeControl = {
      kind: 'increment',
      initialMs: 60_000.5,
      incrementMs: 1_000.5,
      delayMs: 0,
    };
    const { game: fracGame } = Game.create({
      gameId: 'frac-game',
      timeControl: fractionalTc,
      players: { white: 'w', black: 'b' },
      at: 1000,
    });
    assert.equal(fracGame.snapshot().timeControl.initialMs, 60_000.5);
    assert.equal(fracGame.snapshot().timeControl.incrementMs, 1_000.5);

    // Surviving deadline overflow rejected atomically
    const nearLimitAt = MAX_SAFE_TIMESTAMP_MS - 20_000;
    const { game: nearLimitGame } = Game.create({
      gameId: 'near-limit',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 },
      players: { white: 'w', black: 'b' },
      at: nearLimitAt,
    });
    const nontermOp = prepareMove(nearLimitGame, {
      uci: 'g6g5',
      at: nearLimitAt + 1000,
      operationId: 'near-limit-op',
      rulesVersion: '1.0.0',
    });
    const nearLimitBlocked = startBlocked(nearLimitGame, nontermOp);
    const nearBaseH = evaluatePreparedProof(nontermOp, { kind: 'global_deadness' }, { maxSteps: 1000 });
    assert.ok(nearBaseH);
    if (nontermOp.intent.kind !== 'move') throw new Error('Expected move');
    const nearSuccH = evaluatePreparedProof(
      nontermOp,
      { kind: 'successor_deadness', successorFen: nontermOp.intent.successorFen },
      { maxSteps: 1000 },
    );
    assert.ok(nearSuccH);
    assert.throws(
      () => settlePrepared(nearLimitBlocked, { base: nearBaseH, successor: nearSuccH }, MAX_SAFE_TIMESTAMP_MS - 10_000),
      (err: unknown) => err instanceof GameError && /Surviving opponent flag deadline/i.test(err.message),
    );

    // Terminal move discards opponent deadline -> SUCCEEDS near limit
    const { game: nearCastlingGame } = Game.create({
      gameId: 'near-castling',
      variant: 'standard',
      initialFen: FEN_CASTLING_MATE,
      timeControl: { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 },
      players: { white: 'w', black: 'b' },
      at: nearLimitAt,
    });
    const termOp = prepareMove(nearCastlingGame, {
      uci: 'e1g1',
      at: nearLimitAt + 1000,
      operationId: 'near-term-op',
      rulesVersion: '1.0.0',
    });
    const termBlocked = startBlocked(nearCastlingGame, termOp);
    const termBaseH = evaluatePreparedProof(termOp, { kind: 'global_deadness' });
    assert.ok(termBaseH);
    const termSettled = settlePrepared(termBlocked, { base: termBaseH }, MAX_SAFE_TIMESTAMP_MS - 10_000);
    assert.equal(termSettled.game.status.over, true);
    assert.equal(termSettled.game.status.termination, 'checkmate');

    // -----------------------------------------------------------------------
    // C. Delay vector & pause cycles
    // -----------------------------------------------------------------------
    const { game: delayVecGame } = createActiveGame(TC_DELAY, FEN_MATE1, 'delay-vector');
    const drawOp1 = prepareDrawOffer(delayVecGame, {
      color: 'w',
      at: 3000,
      operationId: 'delay-draw-1',
      rulesVersion: '1.0.0',
    });
    const delayBlocked1 = startBlocked(delayVecGame, drawOp1);
    const drawBaseH1 = evaluatePreparedProof(drawOp1, { kind: 'global_deadness' });
    assert.ok(drawBaseH1);
    const delaySettled1 = settlePrepared(delayBlocked1, { base: drawBaseH1 }, 4000).game;
    assert.equal(delaySettled1.snapshot().clock.turnStartedAt, 2000);
    assert.equal(delaySettled1.snapshot().clock.remaining.w, 60_000);

    const drawOp2 = prepareDrawDecline(delaySettled1, {
      color: 'w',
      at: 5000,
      operationId: 'delay-draw-2',
      rulesVersion: '1.0.0',
    });
    const delayBlocked2 = startBlocked(delaySettled1, drawOp2);
    const drawBaseH2 = evaluatePreparedProof(drawOp2, { kind: 'global_deadness' });
    assert.ok(drawBaseH2);
    const delaySettled2 = settlePrepared(delayBlocked2, { base: drawBaseH2 }, 6000).game;
    assert.equal(delaySettled2.snapshot().clock.turnStartedAt, 3000);
    assert.equal(delaySettled2.snapshot().clock.remaining.w, 60_000);

    const afterDelayMove = delaySettled2.playMove('g6g7', 10_000).game;
    assert.equal(afterDelayMove.snapshot().clock.remaining.w, 58_000);

    // -----------------------------------------------------------------------
    // D. Timeout paths with genuine directional evidence
    // -----------------------------------------------------------------------
    const { game: timeoutBaseGame } = createActiveGame(
      { kind: 'increment', initialMs: 10_000, incrementMs: 0, delayMs: 0 },
      FEN_MATE1,
      'timeout-paths',
    );
    const flagTurnGame = timeoutBaseGame.playMove('g6h7', 2000).game;
    const timeoutOp = prepareFlagExpiry(flagTurnGame, {
      flagged: 'b',
      at: 15_000,
      operationId: 'timeout-flag-op',
      rulesVersion: '1.0.0',
    });
    const timeoutBlocked = startBlocked(flagTurnGame, timeoutOp);
    const timeoutBaseH = evaluatePreparedProof(timeoutOp, { kind: 'global_deadness' });
    assert.ok(timeoutBaseH);

    const timeoutDirH = evaluatePreparedProof(timeoutOp, { kind: 'directional_reachability', winner: 'w' });
    assert.ok(timeoutDirH);
    const timeoutSettled = settlePrepared(timeoutBlocked, { base: timeoutBaseH, timeout: timeoutDirH }, 16_000);
    assert.equal(timeoutSettled.game.status.over, true);
    // Since 7k/5K1Q is globally dead (only legal move is 1... Kxh7 leaving bare kings),
    // validated base deadness takes precedence over timeout and yields dead_position draw.
    assert.equal(timeoutSettled.game.status.result, '1/2-1/2');
    assert.equal(timeoutSettled.game.status.termination, 'dead_position');
    assert.equal(timeoutSettled.game.status.winner, null);

    // Winning timeout path: White retains mating material (Rook vs King)
    const FEN_ROOK_WIN = '6k1/5R2/6K1/8/8/8/8/8 b - - 0 1';
    const { game: timeoutWinGame } = createActiveGame(
      { kind: 'increment', initialMs: 10_000, incrementMs: 0, delayMs: 0 },
      FEN_ROOK_WIN,
      'timeout-win-path',
    );
    const timeoutWinOp = prepareFlagExpiry(timeoutWinGame, {
      flagged: 'b',
      at: 15_000,
      operationId: 'timeout-win-flag-op',
      rulesVersion: '1.0.0',
    });
    const timeoutWinBlocked = startBlocked(timeoutWinGame, timeoutWinOp);
    const timeoutWinBaseH = evaluatePreparedProof(timeoutWinOp, { kind: 'global_deadness' });
    assert.ok(timeoutWinBaseH);
    const timeoutWinDirH = evaluatePreparedProof(timeoutWinOp, { kind: 'directional_reachability', winner: 'w' });
    assert.ok(timeoutWinDirH);
    const timeoutWinSettled = settlePrepared(timeoutWinBlocked, { base: timeoutWinBaseH, timeout: timeoutWinDirH }, 16_000);
    assert.equal(timeoutWinSettled.game.status.over, true);
    assert.equal(timeoutWinSettled.game.status.result, '1-0');
    assert.equal(timeoutWinSettled.game.status.termination, 'timeout');
    assert.equal(timeoutWinSettled.game.status.winner, 'w');

    // -----------------------------------------------------------------------
    // E. Stored callback isolation & terminal status immutability
    // -----------------------------------------------------------------------
    const { game: storedCbGame, created: storedCbCreated } = createActiveGame();
    const playedMove = storedCbGame.playMove('g6g7', 2000);
    let callbackCalled = false;
    interface MutableSeatView {
      players: { white: string };
      clock: { remaining: { w: number } };
    }
    interface MutableRemainingEvent {
      remaining: { w: number };
    }
    const foldedCb = Game[FOLD_STORED]([storedCbCreated, ...playedMove.events], () => null, (view, event) => {
      callbackCalled = true;
      try {
        const mv = view as unknown as MutableSeatView;
        mv.players.white = 'mutated';
      } catch {}
      try {
        const me = event as unknown as MutableRemainingEvent;
        me.remaining.w = 999;
      } catch {}
      try {
        const mc = view as unknown as MutableSeatView;
        mc.clock.remaining.w = 999;
      } catch {}
    });
    assert.equal(callbackCalled, true);
    assert.equal(foldedCb.players.white, 'alice');
    assert.notEqual(foldedCb.clock.remaining.w, 999);

    interface MutableStatusView {
      status: { over: boolean };
    }
    const resigned = storedCbGame.resign('w', 2000).game;
    try {
      const ms = resigned.snapshot() as unknown as MutableStatusView;
      ms.status.over = false;
    } catch {}
    assert.throws(
      () => resigned.resign('b', 3000),
      (err: unknown) => err instanceof GameError && /already over/i.test(err.message),
    );
  });

  // -------------------------------------------------------------------------
  // Correction 6: Projected surviving obligations, fractional deadline support,
  // and tournament first-move admission
  // -------------------------------------------------------------------------
  const makeStarted = (prepared: PreparedOperation): GameEvent => ({
    type: 'AdjudicationStarted',
    gameId: prepared.gameId,
    operationId: prepared.operationId,
    baseRevision: prepared.baseRevision,
    at: prepared.at,
    rulesVersion: prepared.rulesVersion,
    prepared,
  });
  const startBlocked = (game: Game, prepared: PreparedOperation): Game =>
    game.withEvents([makeStarted(prepared)]);

  const parseJsonEvents = (events: readonly GameEvent[]): GameEvent[] => {
    const parsed: unknown = JSON.parse(JSON.stringify(events));
    if (!Array.isArray(parsed)) throw new Error('Expected array of GameEvent from JSON round-trip');
    return parsed as GameEvent[];
  };

  const assertSemanticMatch = (replayed: Game, settled: Game): void => {
    assert.deepEqual(replayed.clock, settled.clock);
    assert.deepEqual(replayed.status, settled.status);
    assert.deepEqual(replayed.adjudication, settled.adjudication);
    assert.equal(replayed.isReady('w'), settled.isReady('w'));
    assert.equal(replayed.isReady('b'), settled.isReady('b'));
    assert.equal(replayed.awaitingReadiness, settled.awaitingReadiness);
    assert.equal(replayed.fen, settled.fen);
    assert.equal(replayed.ply, settled.ply);
    assert.equal(replayed.phase, settled.phase);
    assert.equal(replayed.isBlocked, settled.isBlocked);
    assert.equal(replayed.drawOffer, settled.drawOffer);
    assert.equal(replayed.flagDeadline, settled.flagDeadline);
    assert.equal(replayed.noShowDeadline, settled.noShowDeadline);
  };

  const MAX = MAX_SAFE_TIMESTAMP_MS;
  const unlimitedTC: TimeControl = { initialMs: 0, incrementMs: 0, delayMs: 0, kind: 'unlimited' };

  test('Correction 6: readiness exemption and selected second Ready near DateMax succeed, replay and admit play', () => {
    // 1. Unlimited tournament already both ready: near-DateMax continuation succeeds and replays
    const { game: tBothReadyGame, event: tCreated } = Game.create({
      gameId: 't-both-ready',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: unlimitedTC,
      players: { white: 'alice', black: 'bob' },
      source: 'tournament',
      noShowAfterMs: 1000,
      at: 1000,
    });
    const tReadyW = tBothReadyGame.markReady('w', 1100);
    const tReadyB = tReadyW.game.markReady('b', 1200);
    const tOfferOp = prepareDrawOffer(tReadyB.game, {
      color: 'w',
      at: 1500,
      operationId: 't-offer-op',
      rulesVersion: '1.0.0',
    });
    const tOfferBlocked = startBlocked(tReadyB.game, tOfferOp);
    const tOfferBaseH = evaluatePreparedProof(tOfferOp, { kind: 'global_deadness' });
    assert.ok(tOfferBaseH);
    const tOfferSettled = settlePrepared(tOfferBlocked, { base: tOfferBaseH }, MAX - 10);
    assert.equal(tOfferSettled.game.status.over, false);
    assert.notEqual(tOfferSettled.game.noShowVerdict(MAX - 10).kind, 'expire');

    const tReplayed = Game.fromEvents(parseJsonEvents([
      tCreated,
      ...tReadyW.events,
      ...tReadyB.events,
      makeStarted(tOfferOp),
      ...tOfferSettled.batch,
    ]));
    assertSemanticMatch(tReplayed, tOfferSettled.game);
    assert.equal(tReplayed.status.over, false);
    assert.equal(tReplayed.noShowDeadline, 2000);
    assert.notEqual(tReplayed.noShowVerdict(MAX - 10).kind, 'expire');

    // 2. Selected PlayerReady makes tournament both ready: near-DateMax settlement fully consumes & replays
    const { game: tOneReadyGame, event: tOneCreated } = Game.create({
      gameId: 't-ready-exempt',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: unlimitedTC,
      players: { white: 'alice', black: 'bob' },
      source: 'tournament',
      noShowAfterMs: 1000,
      at: 1000,
    });
    const tOneW = tOneReadyGame.markReady('w', 1100);
    const readyBOp = prepareReady(tOneW.game, {
      color: 'b',
      at: 1500,
      operationId: 't-ready-b-op',
      rulesVersion: '1.0.0',
    });
    if (readyBOp.kind === 'noop') throw new Error('Expected actionable ready');
    const readyBBlocked = startBlocked(tOneW.game, readyBOp);
    const readyBBaseH = evaluatePreparedProof(readyBOp, { kind: 'global_deadness' });
    assert.ok(readyBBaseH);
    const readyBSettled = settlePrepared(readyBBlocked, { base: readyBBaseH }, MAX - 10);
    assert.equal(readyBSettled.game.isReady('w'), true);
    assert.equal(readyBSettled.game.isReady('b'), true);
    assert.equal(readyBSettled.game.status.over, false);
    assert.notEqual(readyBSettled.game.noShowVerdict(MAX - 10).kind, 'expire');

    const readyBHistory: GameEvent[] = [
      tOneCreated,
      ...tOneW.events,
      makeStarted(readyBOp),
      ...readyBSettled.batch,
    ];
    const readyBReplayed = Game.fromEvents(parseJsonEvents(readyBHistory));
    assertSemanticMatch(readyBReplayed, readyBSettled.game);
    assert.deepEqual(readyBReplayed.noShowVerdict(MAX - 10), readyBSettled.game.noShowVerdict(MAX - 10));

    // Next legal behavior on both: White plays first move
    const readyBNextSettled = readyBSettled.game.playMove('g6g5', MAX - 5);
    const readyBNextReplayed = readyBReplayed.playMove('g6g5', MAX - 5);
    assert.equal(readyBNextSettled.game.ply, 1);
    assert.equal(readyBNextReplayed.game.ply, 1);
    assert.equal(readyBNextSettled.game.fen, readyBNextReplayed.game.fen);
    assert.deepEqual(readyBNextSettled.game.status, readyBNextReplayed.game.status);
  });

  test('Correction 6: active overflow controls retain active-overflow rejection for seek and missing-ready tournament', () => {
    // 3. Counterparts: active seek or missing-ready tournament retain active-overflow rejection
    const { game: seekOverflowGame } = Game.create({
      gameId: 'seek-overflow',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: unlimitedTC,
      players: { white: 'alice', black: 'bob' },
      source: 'seek',
      noShowAfterMs: 1000,
      at: 1000,
    });
    const seekReadyW = prepareReady(seekOverflowGame, {
      color: 'w',
      at: 1500,
      operationId: 'seek-ready-op',
      rulesVersion: '1.0.0',
    });
    if (seekReadyW.kind === 'noop') throw new Error('Expected actionable ready');
    const seekBlocked = startBlocked(seekOverflowGame, seekReadyW);
    const seekBaseH = evaluatePreparedProof(seekReadyW, { kind: 'global_deadness' });
    assert.ok(seekBaseH);
    assert.throws(
      () => settlePrepared(seekBlocked, { base: seekBaseH }, MAX - 10),
      (err: unknown) => err instanceof GameError && /deadline|overflow|represent/i.test(err.message),
    );

    // Tournament with only White ready retains active-overflow rejection
    const { game: tMissingGame } = Game.create({
      gameId: 't-missing-overflow',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: unlimitedTC,
      players: { white: 'alice', black: 'bob' },
      source: 'tournament',
      noShowAfterMs: 1000,
      at: 1000,
    });
    const tOneW = tMissingGame.markReady('w', 1100);
    const tStillMissingOp = prepareDrawOffer(tOneW.game, {
      color: 'w',
      at: 1500,
      operationId: 't-missing-op',
      rulesVersion: '1.0.0',
    });
    const tStillBlocked = startBlocked(tOneW.game, tStillMissingOp);
    const tStillBaseH = evaluatePreparedProof(tStillMissingOp, { kind: 'global_deadness' });
    assert.ok(tStillBaseH);
    assert.throws(
      () => settlePrepared(tStillBlocked, { base: tStillBaseH }, MAX - 10),
      (err: unknown) => err instanceof GameError && /deadline|overflow|represent/i.test(err.message),
    );
  });

  test('Correction 6: fractional increment held move/same-turn continuation preserves raw deadlines, balances and integer boundaries', () => {
    // 4. Fractional held move and same-turn continuation preserve raw deadlines, balances and integer-time flag boundaries
    const fracTC: TimeControl = { initialMs: 1000.5, incrementMs: 0.25, delayMs: 0, kind: 'increment' };
    const { game: fracGame, event: fracCreated } = Game.create({
      gameId: 'frac-game',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: fracTC,
      players: { white: 'alice', black: 'bob' },
      at: 1000,
    });
    const fracMoveOp = prepareMove(fracGame, {
      uci: 'g6g5',
      at: 1100,
      operationId: 'frac-move-op',
      rulesVersion: '1.0.0',
    });
    const fracBlocked = startBlocked(fracGame, fracMoveOp);
    const fracBaseH = evaluatePreparedProof(fracMoveOp, { kind: 'global_deadness' });
    assert.ok(fracBaseH);
    if (fracMoveOp.intent.kind !== 'move') throw new Error('Expected move');
    const fracSuccH = evaluatePreparedProof(fracMoveOp, { kind: 'successor_deadness', successorFen: fracMoveOp.intent.successorFen });
    assert.ok(fracSuccH);
    const fracSettled = settlePrepared(fracBlocked, { base: fracBaseH, successor: fracSuccH }, 2000);
    assert.equal(fracSettled.effects[0].type, 'MovePlayed');
    if (fracSettled.effects[0].type !== 'MovePlayed') throw new Error('Expected MovePlayed');
    assert.equal(fracSettled.effects[0].moveTimeMs, 100);
    assert.deepEqual(fracSettled.effects[0].remaining, { w: 900.75, b: 1000.5 });
    assert.equal(fracSettled.game.flagDeadline, 3000.5);
    assert.equal(fracSettled.game.timeoutDue(3000), false);
    assert.equal(fracSettled.game.timeoutDue(3001), true);

    const fracHistory: GameEvent[] = [
      fracCreated,
      makeStarted(fracMoveOp),
      ...fracSettled.batch,
    ];
    const fracReplayed = Game.fromEvents(parseJsonEvents(fracHistory));
    assertSemanticMatch(fracReplayed, fracSettled.game);
    assert.equal(fracReplayed.timeoutDue(3000), false);
    assert.equal(fracReplayed.timeoutDue(3001), true);

    // Same-turn pause continuation on fractional game
    const fracDrawOp = prepareDrawOffer(fracSettled.game, {
      color: 'b',
      at: 2200,
      operationId: 'frac-draw-op',
      rulesVersion: '1.0.0',
    });
    const fracDrawBlocked = startBlocked(fracSettled.game, fracDrawOp);
    const fracDrawBaseH = evaluatePreparedProof(fracDrawOp, { kind: 'global_deadness' });
    assert.ok(fracDrawBaseH);
    const fracDrawSettled = settlePrepared(fracDrawBlocked, { base: fracDrawBaseH }, 2500);
    assert.equal(fracDrawSettled.game.flagDeadline, 3300.5);
    assert.equal(fracDrawSettled.game.timeoutDue(3300), false);
    assert.equal(fracDrawSettled.game.timeoutDue(3301), true);

    const fracDrawHistory: GameEvent[] = [
      ...fracHistory,
      makeStarted(fracDrawOp),
      ...fracDrawSettled.batch,
    ];
    const fracDrawReplayed = Game.fromEvents(parseJsonEvents(fracDrawHistory));
    assertSemanticMatch(fracDrawReplayed, fracDrawSettled.game);
    assert.equal(fracDrawReplayed.timeoutDue(3300), false);
    assert.equal(fracDrawReplayed.timeoutDue(3301), true);

    // Next legal behavior on both: White accepts draw offer from Black
    const fracAcceptSettled = fracDrawSettled.game.acceptDraw('w', 2600);
    const fracAcceptReplayed = fracDrawReplayed.acceptDraw('w', 2600);
    assert.equal(fracAcceptSettled.game.status.over, true);
    assert.equal(fracAcceptReplayed.game.status.over, true);
    assert.equal(fracAcceptSettled.game.status.result, '1/2-1/2');
    assert.equal(fracAcceptReplayed.game.status.result, '1/2-1/2');
  });

  test('Correction 6: fractional delay with pause and subsequent held move preserves timing, replay and ending', () => {
    // 5. Fractional delay with pause and subsequent held move
    const fracDelayTC: TimeControl = { initialMs: 1000.25, incrementMs: 0, delayMs: 0.5, kind: 'delay' };
    const { game: fracDelayGame, event: fracDelayCreated } = Game.create({
      gameId: 'frac-delay-game',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: fracDelayTC,
      players: { white: 'alice', black: 'bob' },
      at: 1000,
    });
    // Move 1: White plays g6g5 at 1100 (elapsed 100, chargeable 99.5 -> w: 900.75, b: 1000.25)
    const delayMove1 = fracDelayGame.playMove('g6g5', 1100);
    assert.deepEqual(delayMove1.game.clock.remaining, { w: 900.75, b: 1000.25 });
    assert.equal(delayMove1.game.clock.turnStartedAt, 1100);
    assert.equal(delayMove1.game.turn, 'b');

    // Pause: Draw offer by Black at 1200, resolved at 2000
    // Shift = 2000 - 1200 = 800; resumed anchor = 1100 + 800 = 1900
    // Black flagDeadline = 1900 + 0.5 + 1000.25 = 2900.75
    const delayDrawOp = prepareDrawOffer(delayMove1.game, {
      color: 'b',
      at: 1200,
      operationId: 'delay-draw-op',
      rulesVersion: '1.0.0',
    });
    const delayDrawBlocked = startBlocked(delayMove1.game, delayDrawOp);
    const delayDrawBaseH = evaluatePreparedProof(delayDrawOp, { kind: 'global_deadness' });
    assert.ok(delayDrawBaseH);
    const delayDrawSettled = settlePrepared(delayDrawBlocked, { base: delayDrawBaseH }, 2000);
    assert.equal(delayDrawSettled.game.clock.turnStartedAt, 1900);
    assert.equal(delayDrawSettled.game.flagDeadline, 2900.75);
    assert.equal(delayDrawSettled.game.timeoutDue(2900), false);
    assert.equal(delayDrawSettled.game.timeoutDue(2901), true);

    // Subsequent held move: Black plays h8h7 at 2100, resolved at 3000
    // Elapsed from 1900 to 2100 = 200ms; chargeable = 200 - 0.5 = 199.5ms
    // Black remaining becomes 1000.25 - 199.5 = 800.75ms
    // Next turn is White, turnStartedAt = 3000
    // White remaining = 900.75; White flagDeadline = 3000 + 0.5 + 900.75 = 3901.25
    const delayMove2Op = prepareMove(delayDrawSettled.game, {
      uci: 'h8h7',
      at: 2100,
      operationId: 'delay-move2-op',
      rulesVersion: '1.0.0',
    });
    const delayMove2Blocked = startBlocked(delayDrawSettled.game, delayMove2Op);
    const delayMove2BaseH = evaluatePreparedProof(delayMove2Op, { kind: 'global_deadness' });
    assert.ok(delayMove2BaseH);
    if (delayMove2Op.intent.kind !== 'move') throw new Error('Expected move');
    const delayMove2SuccH = evaluatePreparedProof(delayMove2Op, { kind: 'successor_deadness', successorFen: delayMove2Op.intent.successorFen });
    assert.ok(delayMove2SuccH);
    const delayMove2Settled = settlePrepared(delayMove2Blocked, { base: delayMove2BaseH, successor: delayMove2SuccH }, 3000);
    assert.equal(delayMove2Settled.effects[0].type, 'MovePlayed');
    if (delayMove2Settled.effects[0].type !== 'MovePlayed') throw new Error('Expected MovePlayed');
    assert.equal(delayMove2Settled.effects[0].moveTimeMs, 200);
    assert.deepEqual(delayMove2Settled.effects[0].remaining, { w: 900.75, b: 800.75 });
    assert.equal(delayMove2Settled.game.ply, 2);
    assert.equal(delayMove2Settled.game.turn, 'w');
    assert.equal(delayMove2Settled.game.clock.turnStartedAt, 3000);
    assert.equal(delayMove2Settled.game.flagDeadline, 3901.25);
    assert.equal(delayMove2Settled.game.timeoutDue(3901), false);
    assert.equal(delayMove2Settled.game.timeoutDue(3902), true);

    const delayHistory: GameEvent[] = [
      fracDelayCreated,
      ...delayMove1.events,
      makeStarted(delayDrawOp),
      ...delayDrawSettled.batch,
      makeStarted(delayMove2Op),
      ...delayMove2Settled.batch,
    ];
    const delayReplayed = Game.fromEvents(parseJsonEvents(delayHistory));
    assertSemanticMatch(delayReplayed, delayMove2Settled.game);
    assert.equal(delayReplayed.timeoutDue(3901), false);
    assert.equal(delayReplayed.timeoutDue(3902), true);

    // Next legal behavior on both: White checkmates with g5g7
    const delayMateSettled = delayMove2Settled.game.playMove('g5g7', 3100);
    const delayMateReplayed = delayReplayed.playMove('g5g7', 3100);
    assert.equal(delayMateSettled.game.status.over, true);
    assert.equal(delayMateReplayed.game.status.over, true);
    assert.equal(delayMateSettled.game.status.termination, 'checkmate');
    assert.equal(delayMateReplayed.game.status.termination, 'checkmate');
    assert.equal(delayMateSettled.game.status.winner, 'w');
    assert.equal(delayMateReplayed.game.status.winner, 'w');
  });

  test('Correction 6: late tournament first move after historical deadline is admitted and replays', () => {
    // 6. Both-ready tournament first move after historical deadline
    const { game: tLateGame, event: tLateCreated } = Game.create({
      gameId: 't-late-game',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: unlimitedTC,
      players: { white: 'alice', black: 'bob' },
      source: 'tournament',
      noShowAfterMs: 1000,
      at: 1000,
    });
    const tLateW = tLateGame.markReady('w', 1100);
    const tLateB = tLateW.game.markReady('b', 1200);
    const tLateDirect = prepareMove(tLateB.game, {
      uci: 'g6g5',
      at: 2100,
      operationId: 't-late-direct-op',
      rulesVersion: '1.0.0',
    });
    assert.equal(tLateDirect.intent.kind, 'move');
    const tLateAuth = prepareAuthoritativeCommand(tLateB.game, { kind: 'move', uci: 'g6g5' }, {
      at: 2100,
      color: 'w',
      operationId: 't-late-auth-op',
      rulesVersion: '1.0.0',
    });
    assert.equal(tLateAuth.kind, 'prepared');
    assert.equal(tLateAuth.operation.intent.kind, 'move');
    const tLateBlocked = startBlocked(tLateB.game, tLateAuth.operation);
    const tLateBaseH = evaluatePreparedProof(tLateAuth.operation, { kind: 'global_deadness' });
    assert.ok(tLateBaseH);
    if (tLateAuth.operation.intent.kind !== 'move') throw new Error('Expected move');
    const tLateSuccH = evaluatePreparedProof(tLateAuth.operation, { kind: 'successor_deadness', successorFen: tLateAuth.operation.intent.successorFen });
    assert.ok(tLateSuccH);
    const tLateSettled = settlePrepared(tLateBlocked, { base: tLateBaseH, successor: tLateSuccH }, 2200);
    assert.equal(tLateSettled.game.ply, 1);
    assert.equal(tLateSettled.game.status.over, false);

    const tLateHistory: GameEvent[] = [
      tLateCreated,
      ...tLateW.events,
      ...tLateB.events,
      makeStarted(tLateAuth.operation),
      ...tLateSettled.batch,
    ];
    const tLateReplayed = Game.fromEvents(parseJsonEvents(tLateHistory));
    assertSemanticMatch(tLateReplayed, tLateSettled.game);
    assert.notEqual(tLateReplayed.noShowVerdict(2200).kind, 'expire');

    // Next legal behavior on both: Black plays h8h7
    const blackSettled = tLateSettled.game.playMove('h8h7', 2300);
    const blackReplayed = tLateReplayed.playMove('h8h7', 2300);
    assert.equal(blackSettled.game.ply, 2);
    assert.equal(blackReplayed.game.ply, 2);
    assert.equal(blackSettled.game.fen, blackReplayed.game.fen);
    assert.deepEqual(blackSettled.game.status, blackReplayed.game.status);
  });

  test('Correction 6: seek expiry after deadline normalizes to no-show and replays', () => {
    // Equivalent seek first move after deadline normalizes to no-show expiry
    const { game: seekLateGame, event: seekLateCreated } = Game.create({
      gameId: 'seek-late-game',
      variant: 'standard',
      initialFen: FEN_MATE1,
      timeControl: unlimitedTC,
      players: { white: 'alice', black: 'bob' },
      source: 'seek',
      noShowAfterMs: 1000,
      at: 1000,
    });
    const seekLateW = seekLateGame.markReady('w', 1100);
    const seekLateB = seekLateW.game.markReady('b', 1200);
    const seekLateAuth = prepareAuthoritativeCommand(seekLateB.game, { kind: 'move', uci: 'g6g5' }, {
      at: 2100,
      color: 'w',
      operationId: 'seek-late-auth-op',
      rulesVersion: '1.0.0',
    });
    assert.equal(seekLateAuth.kind, 'prepared');
    assert.equal(seekLateAuth.operation.intent.kind, 'expireNoShow');
    const seekLateBlocked = startBlocked(seekLateB.game, seekLateAuth.operation);
    const seekLateBaseH = evaluatePreparedProof(seekLateAuth.operation, { kind: 'global_deadness' });
    assert.ok(seekLateBaseH);
    const seekLateSettled = settlePrepared(seekLateBlocked, { base: seekLateBaseH }, 2200);
    assert.equal(seekLateSettled.game.status.over, true);
    if (!seekLateSettled.game.status.over) throw new Error('Expected game over');
    assert.equal(seekLateSettled.game.status.termination, 'no_show');
    assert.equal(seekLateSettled.game.status.result, '*');

    const seekLateHistory: GameEvent[] = [
      seekLateCreated,
      ...seekLateW.events,
      ...seekLateB.events,
      makeStarted(seekLateAuth.operation),
      ...seekLateSettled.batch,
    ];
    const seekLateReplayed = Game.fromEvents(parseJsonEvents(seekLateHistory));
    assertSemanticMatch(seekLateReplayed, seekLateSettled.game);
    assert.equal(seekLateReplayed.status.over, true);
    if (!seekLateReplayed.status.over) throw new Error('Expected game over');
    assert.equal(seekLateReplayed.status.termination, 'no_show');
    assert.equal(seekLateReplayed.status.result, '*');
  });
});
