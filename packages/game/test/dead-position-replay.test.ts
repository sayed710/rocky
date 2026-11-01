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

test('proof regression: FEN 8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1 status is not over, and timeout does not emit dead_position', () => {
  const blockedFen = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
  const pos = Position.fromFen(blockedFen);

  // Core status remains over: false (no live dead position detector in AUD-03a)
  assert.deepEqual(pos.status(), { over: false });

  // Live game with Black to move
  const { game } = Game.create({
    gameId: 'flag-blocked-game',
    variant: 'standard',
    initialFen: blockedFen,
    players: { white: 'alice', black: 'bob' },
    timeControl: { initialMs: 1000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    at: 0,
  });

  // Black flags at t=2000
  const flagResult = game.claimFlag(2000);
  assert.equal(flagResult.game.status.over, true);
  if (flagResult.game.status.over) {
    // Must be either insufficient_material or timeout, NEVER dead_position
    assert.notEqual(flagResult.game.status.termination, 'dead_position');
    assert.ok(
      flagResult.game.status.termination === 'insufficient_material'
        || flagResult.game.status.termination === 'timeout',
    );
  }
  for (const event of flagResult.events) {
    if (event.type === 'GameEnded') {
      assert.notEqual(event.termination, 'dead_position');
    }
  }
});

test('narrow literal check: frozen producer files contain zero occurrences of "dead_position"', () => {
  let rootDir = __dirname;
  while (rootDir !== path.dirname(rootDir)) {
    if (fs.existsSync(path.join(rootDir, 'packages'))) {
      break;
    }
    rootDir = path.dirname(rootDir);
  }

  const frozenPaths = [
    'packages/chess-core/src/board.ts',
    'packages/chess-core/src/castling.ts',
    'packages/chess-core/src/check-counters.ts',
    'packages/chess-core/src/chess960.ts',
    'packages/chess-core/src/fen-error.ts',
    'packages/chess-core/src/fen.ts',
    'packages/chess-core/src/index.ts',
    'packages/chess-core/src/movegen.ts',
    'packages/chess-core/src/position-validator.ts',
    'packages/chess-core/src/position.ts',
    'packages/chess-core/src/repetition.ts',
    'packages/chess-core/src/types.ts',
    'packages/game/src/game.ts',
    'packages/game/src/timeout-adjudication.ts',
  ];

  for (const relPath of frozenPaths) {
    const fullPath = path.join(rootDir, relPath);
    assert.ok(fs.existsSync(fullPath), `Expected frozen file to exist: ${relPath}`);
    const content = fs.readFileSync(fullPath, 'utf8');
    assert.ok(
      !content.includes('dead_position'),
      `Frozen file ${relPath} must not contain "dead_position"`,
    );
  }
});
