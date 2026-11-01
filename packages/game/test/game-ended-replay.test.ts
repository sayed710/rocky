/**
 * Tests for Issue #128: Game event replay must reject events after GameEnded.
 *
 * Live commands already refuse actions on finished games (assertOngoing). Replay via
 * Game.fromEvents and incremental withEvents must also fail closed whenever an event
 * follows GameEnded, preventing moves from being played on finished boards, draw offers
 * from mutating ended state, duplicate GameEnded from altering or flipping prior results,
 * and forged GameCreated from overwriting aggregates.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, GameError } from '../src/game';
import { FOLD_STORED } from '../src/internal/stored-replay-key';
import type {
  DrawDeclinedEvent,
  DrawOfferedEvent,
  GameCreatedEvent,
  GameEndedEvent,
  GameEvent,
  MovePlayedEvent,
  PlayerReadyEvent,
} from '../src/events';
import type { TimeControl } from '../src/clock';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };

function createTestGame() {
  return Game.create({
    gameId: 'issue128-game',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
    at: 1_000,
  });
}

function resignGame() {
  const { game, events } = createTestGame();
  const m1 = game.playMove('e2e4', 2_000);
  const m2 = m1.game.playMove('e7e5', 3_000);
  const ended = m2.game.resign('b', 4_000);
  const allEvents: GameEvent[] = [...events, ...m1.events, ...m2.events, ...ended.events];
  return { game: ended.game, events: allEvents };
}

function checkmateGame() {
  const { game, events } = createTestGame();
  const line = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
  let g = game;
  const allEvents: GameEvent[] = [...events];
  let t = 2_000;
  for (const uci of line) {
    const res = g.playMove(uci, (t += 1_000));
    g = res.game;
    allEvents.push(...res.events);
  }
  return { game: g, events: allEvents };
}

test('Game.fromEvents rejects MovePlayed after GameEnded', () => {
  const { events } = resignGame();
  const lateMove: MovePlayedEvent = {
    type: 'MovePlayed',
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    moveTimeMs: 1_000,
    remaining: { w: 299_000, b: 297_000 },
    at: 5_000,
  };
  assert.throws(
    () => Game.fromEvents([...events, lateMove]),
    (err: unknown) => err instanceof GameError && err.message === 'MovePlayed after GameEnded',
  );
});

test('Game.fromEvents rejects MovePlayed after checkmate GameEnded', () => {
  const { events } = checkmateGame();
  // Checkmate ends with [MovePlayed(h5f7), GameEnded(checkmate)]
  assert.equal(events[events.length - 1]!.type, 'GameEnded');
  assert.equal(events[events.length - 2]!.type, 'MovePlayed');

  const lateMove: MovePlayedEvent = {
    type: 'MovePlayed',
    ply: 8,
    uci: 'a7a6',
    san: 'a6',
    by: 'b',
    moveTimeMs: 1_000,
    remaining: { w: 298_000, b: 296_000 },
    at: 10_000,
  };
  assert.throws(
    () => Game.fromEvents([...events, lateMove]),
    (err: unknown) => err instanceof GameError && err.message === 'MovePlayed after GameEnded',
  );
});

test('Game.fromEvents rejects DrawOffered and DrawDeclined after GameEnded', () => {
  const { events } = resignGame();
  const lateDrawOffer: DrawOfferedEvent = {
    type: 'DrawOffered',
    by: 'w',
    at: 5_000,
  };
  assert.throws(
    () => Game.fromEvents([...events, lateDrawOffer]),
    (err: unknown) => err instanceof GameError && err.message === 'DrawOffered after GameEnded',
  );

  const lateDrawDecline: DrawDeclinedEvent = {
    type: 'DrawDeclined',
    by: 'b',
    at: 5_500,
  };
  assert.throws(
    () => Game.fromEvents([...events, lateDrawDecline]),
    (err: unknown) => err instanceof GameError && err.message === 'DrawDeclined after GameEnded',
  );
});

test('Game.fromEvents rejects duplicate or conflicting GameEnded events', () => {
  const { events } = resignGame();
  // Duplicate identical GameEnded
  const duplicateEnding = events[events.length - 1]!;
  assert.throws(
    () => Game.fromEvents([...events, duplicateEnding]),
    (err: unknown) => err instanceof GameError && err.message === 'GameEnded after GameEnded',
  );

  // Conflicting GameEnded attempting to overwrite white win with black win
  const flippedEnding: GameEndedEvent = {
    type: 'GameEnded',
    result: '0-1',
    termination: 'resignation',
    winner: 'b',
    at: 6_000,
  };
  assert.throws(
    () => Game.fromEvents([...events, flippedEnding]),
    (err: unknown) => err instanceof GameError && err.message === 'GameEnded after GameEnded',
  );
});

test('Game.fromEvents rejects forged GameCreated after GameEnded and on active game', () => {
  const { events } = resignGame();
  const forgedCreated: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'forged',
    variant: 'standard',
    initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    timeControl: TC,
    players: { white: 'eve', black: 'mallory' },
    rated: false,
    at: 10_000,
  };
  assert.throws(
    () => Game.fromEvents([...events, forgedCreated]),
    (err: unknown) => err instanceof GameError && err.message === 'GameCreated after GameEnded',
  );

  // Also verify second GameCreated on an active prefix is rejected
  const activeCreated = events.slice(0, 2); // [GameCreated, MovePlayed]
  assert.throws(
    () => Game.fromEvents([...activeCreated, forgedCreated]),
    (err: unknown) => err instanceof GameError && err.message === 'GameCreated after GameCreated',
  );
});

test('Game.fromEvents rejects PlayerReady after GameEnded', () => {
  const { events } = resignGame();
  const lateReady: PlayerReadyEvent = {
    type: 'PlayerReady',
    by: 'w',
    at: 5_000,
  };
  assert.throws(
    () => Game.fromEvents([...events, lateReady]),
    (err: unknown) => err instanceof GameError && err.message === 'PlayerReady after GameEnded',
  );
});

function captureDetachedState(g: Game) {
  const snap = g.snapshot();
  return {
    fen: g.fen,
    turn: g.turn,
    ply: snap.ply,
    status: structuredClone(snap.status),
    clock: structuredClone(snap.clock),
    ready: structuredClone(snap.ready),
    moves: structuredClone(snap.moves),
    repetitionEntries: [...snap.repetition.entries()],
    drawOffer: snap.drawOffer,
  };
}

test('Game.withEvents rejects all event kinds when applied to an ended game aggregate and preserves immutability', () => {
  const { game } = resignGame();
  assert.equal(game.status.over, true);
  const detachedBefore = captureDetachedState(game);

  // 1. MovePlayed
  const lateMove: MovePlayedEvent = {
    type: 'MovePlayed',
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    moveTimeMs: 1_000,
    remaining: { w: 299_000, b: 297_000 },
    at: 5_000,
  };
  assert.throws(
    () => game.withEvents([lateMove]),
    (err: unknown) => err instanceof GameError && err.message === 'MovePlayed after GameEnded',
  );

  // 2. DrawOffered
  const lateOffer: DrawOfferedEvent = { type: 'DrawOffered', by: 'w', at: 5_000 };
  assert.throws(
    () => game.withEvents([lateOffer]),
    (err: unknown) => err instanceof GameError && err.message === 'DrawOffered after GameEnded',
  );

  // 3. DrawDeclined
  const lateDecline: DrawDeclinedEvent = { type: 'DrawDeclined', by: 'b', at: 5_500 };
  assert.throws(
    () => game.withEvents([lateDecline]),
    (err: unknown) => err instanceof GameError && err.message === 'DrawDeclined after GameEnded',
  );

  // 4. GameEnded (duplicate/conflicting)
  const lateEnding: GameEndedEvent = {
    type: 'GameEnded',
    result: '1/2-1/2',
    termination: 'agreement',
    winner: null,
    at: 5_000,
  };
  assert.throws(
    () => game.withEvents([lateEnding]),
    (err: unknown) => err instanceof GameError && err.message === 'GameEnded after GameEnded',
  );

  // 5. PlayerReady
  const lateReady: PlayerReadyEvent = { type: 'PlayerReady', by: 'w', at: 5_000 };
  assert.throws(
    () => game.withEvents([lateReady]),
    (err: unknown) => err instanceof GameError && err.message === 'PlayerReady after GameEnded',
  );

  // 6. GameCreated
  const lateCreated: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'forged',
    variant: 'standard',
    initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    timeControl: TC,
    players: { white: 'eve', black: 'mallory' },
    rated: false,
    at: 10_000,
  };
  assert.throws(
    () => game.withEvents([lateCreated]),
    (err: unknown) => err instanceof GameError && err.message === 'GameCreated after GameEnded',
  );

  // Verify the original game aggregate remains completely immutable via detached comparison
  const detachedAfter = captureDetachedState(game);
  assert.deepEqual(detachedAfter, detachedBefore);

  // Deliberate nested clock mutation control: prove that assert.deepEqual on detached state is sensitive
  // to nested mutations and fails demonstrably, proving the check is not fooled by object aliasing.
  const syntheticMutated = structuredClone(detachedBefore);
  if ('remaining' in syntheticMutated.clock && typeof syntheticMutated.clock.remaining === 'object' && syntheticMutated.clock.remaining !== null) {
    (syntheticMutated.clock.remaining as { w: number }).w += 1;
  }
  assert.throws(
    () => assert.deepEqual(detachedAfter.clock, syntheticMutated.clock),
    (err: unknown) => err instanceof assert.AssertionError,
  );
  // Ensure the actual aggregate was NOT affected by the synthetic control
  assert.deepEqual(captureDetachedState(game), detachedBefore);

  // Empty withEvents is a clean no-op returning identical snapshot without mutating resident game
  const noop = game.withEvents([]);
  assert.deepEqual(captureDetachedState(noop), detachedBefore);
  assert.notEqual(noop, game);
});

test('batch withEvents containing active prefix, GameEnded, and trailing event fails atomically', () => {
  const { game } = createTestGame();
  const m1 = game.playMove('e2e4', 2_000);
  const ongoing = m1.game;
  const detachedBefore = captureDetachedState(ongoing);

  const batch: GameEvent[] = [
    {
      type: 'MovePlayed',
      ply: 2,
      uci: 'e7e5',
      san: 'e5',
      by: 'b',
      moveTimeMs: 1_000,
      remaining: { w: 299_000, b: 297_000 },
      at: 3_000,
    },
    {
      type: 'GameEnded',
      result: '1-0',
      termination: 'resignation',
      winner: 'w',
      at: 4_000,
    },
    {
      type: 'MovePlayed',
      ply: 3,
      uci: 'g1f3',
      san: 'Nf3',
      by: 'w',
      moveTimeMs: 1_000,
      remaining: { w: 299_000, b: 297_000 },
      at: 5_000,
    },
  ];

  assert.throws(
    () => ongoing.withEvents(batch),
    (err: unknown) => err instanceof GameError && err.message === 'MovePlayed after GameEnded',
  );

  // The ongoing aggregate must remain completely untouched (atomicity of fold)
  assert.deepEqual(captureDetachedState(ongoing), detachedBefore);
  assert.equal(ongoing.status.over, false);
  assert.equal(ongoing.snapshot().ply, 1);
});

test('natural terminal MovePlayed followed by GameEnded succeeds via withEvents (explicit control)', () => {
  const { game: expectedMatedGame, events: mateEvents } = checkmateGame();
  // Events: [GameCreated, MovePlayed x 6, MovePlayed(h5f7), GameEnded(checkmate)]
  // Fold the first 7 events (GameCreated + 6 moves) to reach the position right before checkmate
  const preMatingGame = Game.fromEvents(mateEvents.slice(0, 7));
  assert.equal(preMatingGame.status.over, false);
  assert.equal(preMatingGame.snapshot().ply, 6);

  // Apply [matingMove, checkmateEnding] via withEvents
  const terminalSuffix = mateEvents.slice(7);
  assert.equal(terminalSuffix.length, 2);
  assert.equal(terminalSuffix[0]!.type, 'MovePlayed');
  assert.equal(terminalSuffix[1]!.type, 'GameEnded');

  const finishedGame = preMatingGame.withEvents(terminalSuffix);
  assert.equal(finishedGame.status.over, true);
  if (finishedGame.status.over) {
    assert.equal(finishedGame.status.termination, 'checkmate');
    assert.equal(finishedGame.status.result, '1-0');
    assert.equal(finishedGame.status.winner, 'w');
  }
  assert.deepEqual(finishedGame.snapshot(), expectedMatedGame.snapshot());
});

test('Game.fromEvents rejects unknown event types rather than returning undefined', () => {
  const { events } = createTestGame();
  const unknownEvent = { type: 'UnknownEvent', at: 2_000 } as unknown as GameEvent;
  assert.throws(
    () => Game.fromEvents([...events, unknownEvent]),
    (err: unknown) => err instanceof GameError && err.message.includes('Unknown event type'),
  );
});

test('active prefixes without terminal events remain completely legitimate', () => {
  const { events } = resignGame();
  // Strip the GameEnded event: legitimate ongoing active prefix
  const ongoingEvents = events.slice(0, -1);
  const ongoingGame = Game.fromEvents(ongoingEvents);
  assert.equal(ongoingGame.status.over, false);
  assert.equal(ongoingGame.snapshot().ply, 2);
  assert.equal(ongoingGame.turn, 'w');

  // withEvents on active game continues to work normally
  const nextMove: MovePlayedEvent = {
    type: 'MovePlayed',
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    moveTimeMs: 1_000,
    remaining: { w: 299_000, b: 297_000 },
    at: 4_000,
  };
  const advanced = ongoingGame.withEvents([nextMove]);
  assert.equal(advanced.status.over, false);
  assert.equal(advanced.snapshot().ply, 3);
  assert.equal(advanced.turn, 'b');
});

test('Game[FOLD_STORED] rejects events after GameEnded', () => {
  const { events } = resignGame();
  const lateMove: MovePlayedEvent = {
    type: 'MovePlayed',
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    moveTimeMs: 1_000,
    remaining: { w: 299_000, b: 297_000 },
    at: 5_000,
  };
  assert.throws(
    () => Game[FOLD_STORED]([...events, lateMove], () => null, () => {}),
    (err: unknown) => err instanceof GameError && err.message === 'MovePlayed after GameEnded',
  );
});

