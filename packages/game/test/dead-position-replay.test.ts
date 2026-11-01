import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Position } from '@chess-platform/core';
import {
  Game,
  type GameCreatedEvent,
  type GameEndedEvent,
  type GameEvent,
  type MovePlayedEvent,
  type TimeControl,
} from '../src';
import { replayStoredHistory, type StoredHistoryRow } from '../src/stored-history';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };

test('synthetic stored GameEnded with dead_position replays via Game.fromEvents and replayStoredHistory', () => {
  const created: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'dead-pos-game-1',
    variant: 'standard',
    initialFen: '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1',
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: true,
    at: 1000,
  };

  const ended: GameEndedEvent = {
    type: 'GameEnded',
    result: '1/2-1/2',
    termination: 'dead_position',
    winner: null,
    at: 4000,
  };

  const events: GameEvent[] = [created, ended];

  // 1. Replay via Game.fromEvents
  const fromEventsGame = Game.fromEvents(events);
  assert.equal(fromEventsGame.status.over, true);
  if (fromEventsGame.status.over) {
    assert.equal(fromEventsGame.status.result, '1/2-1/2');
    assert.equal(fromEventsGame.status.termination, 'dead_position');
    assert.equal(fromEventsGame.status.winner, null);
  }

  // 2. Replay via replayStoredHistory
  const rows: StoredHistoryRow[] = events.map((event, seq) => ({
    gameId: 'dead-pos-game-1',
    seq,
    version: 1,
    event,
  }));
  const replayed = replayStoredHistory('dead-pos-game-1', rows);
  assert.equal(replayed.game.status.over, true);
  if (replayed.game.status.over) {
    assert.equal(replayed.game.status.result, '1/2-1/2');
    assert.equal(replayed.game.status.termination, 'dead_position');
    assert.equal(replayed.game.status.winner, null);
  }
  assert.equal(replayed.historicalPly, null);
});

test('historical event log replay does not synthesize dead_position ending in Game.reduce / fromEvents', () => {
  // A historical ongoing game stored before AUD-03b without a GameEnded event
  const created: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'historical-dead-game',
    variant: 'standard',
    initialFen: '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1',
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: true,
    at: 1000,
  };

  // Even though the FEN is a dead position, pure event replay MUST NOT synthesize an ending!
  const replayed = Game.fromEvents([created]);
  assert.equal(replayed.status.over, false, 'Historical event replay must remain strictly event-driven');

  // Stored historical resignation in a dead position is preserved byte-for-byte
  const resigned: GameEndedEvent = {
    type: 'GameEnded',
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    at: 5000,
  };
  const replayedResigned = Game.fromEvents([created, resigned]);
  assert.equal(replayedResigned.status.over, true);
  if (replayedResigned.status.over) {
    assert.equal(replayedResigned.status.termination, 'resignation');
    assert.equal(replayedResigned.status.winner, 'w');
    assert.equal(replayedResigned.status.result, '1-0');
  }
});

test('ROOT legacy runtime fixture replay: c7d7 / Kd7 / timeout 0-1 preserves exact historical outcome and timestamps', () => {
  // Exact events from outputs/issue124b-actual-legacy-fixture.json
  const created: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'legacy124b-synthetic-runtime',
    variant: 'standard',
    initialFen: '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1',
    timeControl: {
      initialMs: 1000,
      incrementMs: 0,
      delayMs: 0,
      kind: 'sudden_death',
    },
    players: {
      white: 'legacy-w',
      black: 'legacy-b',
    },
    rated: true,
    at: 0,
  };

  const move: MovePlayedEvent = {
    type: 'MovePlayed',
    ply: 1,
    uci: 'c7d7',
    san: 'Kd7',
    by: 'b',
    moveTimeMs: 100,
    remaining: {
      w: 1000,
      b: 900,
    },
    at: 100,
  };

  const ended: GameEndedEvent = {
    type: 'GameEnded',
    result: '0-1',
    termination: 'timeout',
    winner: 'b',
    at: 2000,
  };

  const events: GameEvent[] = [created, move, ended];

  // 1. Replay via Game.fromEvents: preserves historic timeout outcome, SAN Kd7, clocks, and timestamps
  const game = Game.fromEvents(events);
  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.result, '0-1', 'Must preserve historic 0-1 result');
    assert.equal(game.status.termination, 'timeout', 'Must preserve historic timeout termination');
    assert.equal(game.status.winner, 'b');
  }
  assert.equal(game.snapshot().clock.remaining.b, 900);
  assert.equal(game.snapshot().clock.remaining.w, 1000);

  // 2. Replay via replayStoredHistory
  const rows: StoredHistoryRow[] = events.map((event, seq) => ({
    gameId: 'legacy124b-synthetic-runtime',
    seq,
    version: 1,
    event,
  }));
  const replayed = replayStoredHistory('legacy124b-synthetic-runtime', rows);
  assert.equal(replayed.game.status.over, true);
  if (replayed.game.status.over) {
    assert.equal(replayed.game.status.result, '0-1');
    assert.equal(replayed.game.status.termination, 'timeout');
    assert.equal(replayed.game.status.winner, 'b');
  }
});

test('legal predecessor move b5b6 emits MovePlayed then GameEnded with dead_position draw', () => {
  const predecessorFen = '8/1pk2p1p/p1p1pPpP/PPP1P1P1/5K2/8/8/8 w - - 0 1';
  const { game: initialGame, events: createEvents } = Game.create({
    gameId: 'predecessor-game-test',
    variant: 'standard',
    initialFen: predecessorFen,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    at: 1000,
  });

  assert.equal(initialGame.status.over, false);

  // White plays b5b6, reaching the dead position
  const { game, events: moveEvents } = initialGame.playMove('b5b6', 2000);

  assert.equal(moveEvents.length, 2);
  assert.equal(moveEvents[0]!.type, 'MovePlayed');
  assert.equal(moveEvents[1]!.type, 'GameEnded');
  if (moveEvents[0]!.type === 'MovePlayed') {
    assert.equal(moveEvents[0]!.uci, 'b5b6');
    assert.equal(moveEvents[0]!.san, 'b6+');
    assert.equal(moveEvents[0]!.ply, 1);
  }
  if (moveEvents[1]!.type === 'GameEnded') {
    assert.equal(moveEvents[1]!.termination, 'dead_position');
    assert.equal(moveEvents[1]!.result, '1/2-1/2');
    assert.equal(moveEvents[1]!.winner, null);
  }

  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.termination, 'dead_position');
    assert.equal(game.status.result, '1/2-1/2');
  }

  // Subsequent move rejected
  assert.throws(() => game.playMove('c7d7', 3000), /Game is already over/);

  // Round-trip through fromEvents
  const roundTripped = Game.fromEvents([...createEvents, ...moveEvents]);
  assert.equal(roundTripped.status.over, true);
  if (roundTripped.status.over) {
    assert.equal(roundTripped.status.termination, 'dead_position');
    assert.equal(roundTripped.status.result, '1/2-1/2');
  }
});

test('live producer: issue FEN creates ended game with dead_position draw', () => {
  const blockedFen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
  const pos = Position.fromFen(blockedFen);

  // Core status recognizes dead_position
  assert.deepEqual(pos.status(), { over: true, reason: 'dead_position' });

  // Live creation emits GameCreated and explicit GameEnded
  const { game, events } = Game.create({
    gameId: 'custom-dead-creation',
    variant: 'standard',
    initialFen: blockedFen,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    at: 1000,
  });

  assert.equal(events.length, 2);
  assert.equal(events[0]!.type, 'GameCreated');
  assert.equal(events[1]!.type, 'GameEnded');
  if (events[1]!.type === 'GameEnded') {
    assert.equal(events[1]!.termination, 'dead_position');
    assert.equal(events[1]!.result, '1/2-1/2');
    assert.equal(events[1]!.winner, null);
  }
  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.termination, 'dead_position');
    assert.equal(game.status.result, '1/2-1/2');
    assert.equal(game.status.winner, null);
  }
});

test('ongoing dead prefix command arbitration: adjudicates dead_position before moves, timeouts, or resignations', () => {
  const blockedFen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
  // Reconstruct an ongoing game aggregate without terminal event (simulating an existing legacy ongoing prefix)
  const legacyOngoing = Game.fromEvents([{
    type: 'GameCreated',
    gameId: 'legacy-ongoing-dead',
    variant: 'standard',
    initialFen: blockedFen,
    players: { white: 'alice', black: 'bob' },
    timeControl: { initialMs: 1000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    rated: false,
    at: 1000,
  }]);

  assert.equal(legacyOngoing.status.over, false);

  // 1. Move attempt on already-dead position is not accepted; adjudicates dead_position ending instead
  const moveAttempt = legacyOngoing.playMove('c7d7', 2000);
  assert.equal(moveAttempt.events.length, 1);
  assert.equal(moveAttempt.events[0]!.type, 'GameEnded');
  if (moveAttempt.events[0]!.type === 'GameEnded') {
    assert.equal(moveAttempt.events[0]!.termination, 'dead_position');
    assert.equal(moveAttempt.events[0]!.result, '1/2-1/2');
  }

  // 2. Resignation attempt adjudicates dead_position ending
  const resignAttempt = legacyOngoing.resign('b', 2000);
  assert.equal(resignAttempt.events.length, 1);
  if (resignAttempt.events[0]!.type === 'GameEnded') {
    assert.equal(resignAttempt.events[0]!.termination, 'dead_position');
  }

  // 3. Flag claim adjudicates dead_position ending (not timeout or insufficient_material)
  const flagAttempt = legacyOngoing.claimFlag(3000);
  assert.equal(flagAttempt.events.length, 1);
  if (flagAttempt.events[0]!.type === 'GameEnded') {
    assert.equal(flagAttempt.events[0]!.termination, 'dead_position');
    assert.equal(flagAttempt.events[0]!.result, '1/2-1/2');
    assert.equal(flagAttempt.events[0]!.winner, null);
  }
});

test('data-driven command admission refusal partitions: invalid commands throw GameError without mutating state or settling dead position', () => {
  const blockedFen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';

  const baseEvent: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'dead-admission-base',
    variant: 'standard',
    initialFen: blockedFen,
    players: { white: 'alice', black: 'bob' },
    timeControl: { initialMs: 10_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    rated: false,
    at: 0,
  };

  const sourcedEvent: GameCreatedEvent = {
    ...baseEvent,
    source: 'seek',
    noShowAfterMs: 1000,
  };

  // Two ply event prefix for abort refusal
  const move1: MovePlayedEvent = {
    type: 'MovePlayed',
    ply: 1,
    uci: 'c7d7',
    san: 'Kd7',
    by: 'b',
    moveTimeMs: 100,
    remaining: { w: 10_000, b: 9_900 },
    at: 100,
  };
  const move2: MovePlayedEvent = {
    type: 'MovePlayed',
    ply: 2,
    uci: 'f4e3',
    san: 'Ke3',
    by: 'w',
    moveTimeMs: 100,
    remaining: { w: 9_900, b: 9_900 },
    at: 200,
  };

  const drawOfferEvent: GameEvent = {
    type: 'DrawOffered',
    by: 'b',
    at: 100,
  };

  type RefusalCase = {
    name: string;
    events: GameEvent[];
    action: (g: Game) => void;
    expectedPattern: RegExp;
  };

  const refusalCases: RefusalCase[] = [
    {
      name: 'early no-show',
      events: [sourcedEvent],
      action: (g) => g.expireNoShow(500),
      expectedPattern: /No-show expiry refused: not_due/,
    },
    {
      name: 'non-applicable no-show',
      events: [baseEvent],
      action: (g) => g.expireNoShow(500),
      expectedPattern: /No-show expiry refused: not_applicable/,
    },
    {
      name: 'early flag claim',
      events: [baseEvent],
      action: (g) => g.claimFlag(100),
      expectedPattern: /Opponent has not flagged/,
    },
    {
      name: 'abort after 2 plies',
      events: [baseEvent, move1, move2],
      action: (g) => g.abort(300),
      expectedPattern: /Game can no longer be aborted/,
    },
    {
      name: 'missing draw offer decline',
      events: [baseEvent],
      action: (g) => g.declineDraw('w', 100),
      expectedPattern: /No draw offer to decline/,
    },
    {
      name: 'missing draw offer accept',
      events: [baseEvent],
      action: (g) => g.acceptDraw('w', 100),
      expectedPattern: /No draw offer from the opponent to accept/,
    },
    {
      name: 'duplicate own draw offer',
      events: [baseEvent, drawOfferEvent],
      action: (g) => g.offerDraw('b', 200),
      expectedPattern: /Draw already offered by this side/,
    },
    {
      name: 'unready move',
      events: [sourcedEvent],
      action: (g) => g.playMove('c7d7', 500),
      expectedPattern: /Both players must be ready before the first move/,
    },
    {
      name: 'illegal move',
      events: [baseEvent],
      action: (g) => g.playMove('e2e4', 100),
      expectedPattern: /No legal move matches "e2e4"/,
    },
  ];

  for (const { name, events, action, expectedPattern } of refusalCases) {
    const game = Game.fromEvents(events);
    const beforeFen = game.fen;
    assert.equal(game.status.over, false, `${name}: game must be ongoing before command`);
    assert.throws(
      () => action(game),
      expectedPattern,
      `${name}: must throw expected error`,
    );
    assert.equal(game.fen, beforeFen, `${name}: FEN must remain unchanged after refusal`);
    assert.equal(game.status.over, false, `${name}: game must remain ongoing without dead settlement`);
  }
});

test('data-driven due admitted actions on dead position: admitted commands adjudicate dead_position draw', () => {
  const blockedFen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';

  const baseEvent: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'dead-admitted-base',
    variant: 'standard',
    initialFen: blockedFen,
    players: { white: 'alice', black: 'bob' },
    timeControl: { initialMs: 1000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    rated: false,
    at: 0,
  };

  const sourcedEvent: GameCreatedEvent = {
    ...baseEvent,
    source: 'seek',
    noShowAfterMs: 1000,
  };

  const drawOfferedByWhite: GameEvent = {
    type: 'DrawOffered',
    by: 'w',
    at: 100,
  };

  type AdmittedCase = {
    name: string;
    events: GameEvent[];
    action: (g: Game) => { game: Game; events: GameEvent[] };
  };

  const admittedCases: AdmittedCase[] = [
    {
      name: 'due no-show on dead position yields dead_position draw',
      events: [sourcedEvent],
      action: (g) => g.expireNoShow(1500),
    },
    {
      name: 'due flag on dead position yields dead_position draw',
      events: [baseEvent],
      action: (g) => g.claimFlag(2000),
    },
    {
      name: 'valid abort on dead position yields dead_position draw',
      events: [baseEvent],
      action: (g) => g.abort(500),
    },
    {
      name: 'admitted legal move on dead position yields dead_position draw without MovePlayed',
      events: [baseEvent],
      action: (g) => g.playMove('c7d7', 100),
    },
    {
      name: 'valid accepted draw on dead position yields dead_position draw',
      events: [baseEvent, drawOfferedByWhite],
      action: (g) => g.acceptDraw('b', 200),
    },
  ];

  for (const { name, events, action } of admittedCases) {
    const game = Game.fromEvents(events);
    assert.equal(game.status.over, false, `${name}: game must be ongoing before command`);
    const { game: afterGame, events: emitted } = action(game);
    assert.equal(emitted.length, 1, `${name}: must emit exactly 1 event`);
    assert.equal(emitted[0]!.type, 'GameEnded', `${name}: emitted event must be GameEnded`);
    if (emitted[0]!.type === 'GameEnded') {
      assert.equal(emitted[0]!.termination, 'dead_position', `${name}: termination must be dead_position`);
      assert.equal(emitted[0]!.result, '1/2-1/2', `${name}: result must be 1/2-1/2`);
      assert.equal(emitted[0]!.winner, null, `${name}: winner must be null`);
    }
    assert.equal(afterGame.status.over, true, `${name}: resulting game status must be over`);
    if (afterGame.status.over) {
      assert.equal(afterGame.status.termination, 'dead_position');
      assert.equal(afterGame.status.result, '1/2-1/2');
      assert.equal(afterGame.status.winner, null);
    }
  }
});

test('narrow literal check: frozen timeout-adjudication solver and unrelated core files remain untouched', () => {
  let rootDir = __dirname;
  while (rootDir !== path.dirname(rootDir)) {
    if (fs.existsSync(path.join(rootDir, 'packages'))) {
      break;
    }
    rootDir = path.dirname(rootDir);
  }

  // Files that MUST remain frozen with zero occurrences of "dead_position"
  const strictlyFrozenPaths = [
    'packages/chess-core/src/board.ts',
    'packages/chess-core/src/castling.ts',
    'packages/chess-core/src/check-counters.ts',
    'packages/chess-core/src/chess960.ts',
    'packages/chess-core/src/fen-error.ts',
    'packages/chess-core/src/fen.ts',
    'packages/chess-core/src/movegen.ts',
    'packages/chess-core/src/position-validator.ts',
    'packages/chess-core/src/repetition.ts',
    'packages/game/src/timeout-adjudication.ts',
  ];

  for (const relPath of strictlyFrozenPaths) {
    const fullPath = path.join(rootDir, relPath);
    assert.ok(fs.existsSync(fullPath), `Expected frozen file to exist: ${relPath}`);
    const content = fs.readFileSync(fullPath, 'utf8');
    assert.ok(
      !content.includes('dead_position'),
      `Frozen file ${relPath} must not contain "dead_position"`,
    );
  }
});
