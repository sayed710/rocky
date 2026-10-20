/**
 * #127: the flag and no-show workers stay strict. A finished game never sits in either queue (the
 * `game_events` triggers delete its row on `GameEnded`), but if a stale row ever named a stored atomic
 * game whose final move only the pre-#127 rules allowed, the worker must contain it: no crash, no
 * write, no expiry, one log line per pass, and the rest of the page still settled.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, charge, type GameEvent, type MovePlayedEvent, type TimeControl } from '@chess-platform/game';
import { InMemoryEventLog } from '@chess-platform/realtime-gateway';
import type { Logger } from '@chess-platform/api';
import type { DeadlineCandidate } from '@chess-platform/persistence/pg';
import { FlagExpiryWorker } from '../src/flag-expiry.js';
import { NoShowExpiryWorker } from '../src/no-show-expiry.js';

const TC: TimeControl = { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };

function pre127Log(gameId: string): GameEvent[] {
  let { game, events } = Game.create({ gameId, variant: 'atomic', timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: true, at: 0 });
  const log: GameEvent[] = [...events];
  let at = 0;
  for (const uci of 'e2e3 e7e6 e1e2 e8e7 e2d3 e7d6 d3d4 e6e5'.split(' ')) {
    const r = game.playMove(uci, (at += 1_000));
    game = r.game;
    log.push(...r.events);
  }
  at += 1_000;
  const charged = charge(game.snapshot().clock, 'w', at, TC);
  const move: MovePlayedEvent = { type: 'MovePlayed', ply: 9, uci: 'd4e5', san: 'Kxe5', by: 'w', moveTimeMs: charged.moveTimeMs, remaining: charged.clock.remaining, at };
  return [...log, move, { type: 'GameEnded', result: '0-1', termination: 'variant', winner: 'b', at }];
}

async function rig() {
  const store = new InMemoryEventLog();
  await store.append('legacy', -1, pre127Log('legacy'));
  const resigned = Game.create({ gameId: 'resigned', timeControl: TC, players: { white: 'alice', black: 'bob' }, at: 0 });
  await store.append('resigned', -1, [...resigned.events, ...resigned.game.resign('w', 1_000).events]);
  const due: DeadlineCandidate[] = [
    { gameId: 'legacy', dueAt: new Date(1) },
    { gameId: 'resigned', dueAt: new Date(2) },
  ];
  const errors: string[] = [];
  const logger = { error: (message: string) => errors.push(message), warn() {}, info() {}, debug() {} } as unknown as Logger;
  const expired: string[] = [];
  const dismissed: string[] = [];
  const rescheduled: string[] = [];
  return { store, due, errors, logger, expired, dismissed, rescheduled, before: JSON.stringify(await store.load('legacy')) };
}

test('flag expiry contains a stored pre-#127 game: failed, not expired or written, and the page continues', async () => {
  const r = await rig();
  const worker = new FlagExpiryWorker({
    candidates: {
      due: async () => r.due,
      reschedule: async (gameId: string) => { r.rescheduled.push(gameId); },
      dismiss: async (gameId: string) => { r.dismissed.push(gameId); },
    },
    events: r.store,
    expire: async (gameId) => { r.expired.push(gameId); },
    logger: r.logger,
    now: () => 10_000,
  });
  for (let pass = 0; pass < 3; pass++) {
    assert.deepEqual(await worker.runPass(), { scanned: 2, expired: 0, dismissed: 1, failed: 1, more: false });
  }
  assert.deepEqual(r.expired, []);
  assert.deepEqual(r.rescheduled, []);
  assert.deepEqual(r.dismissed, ['resigned', 'resigned', 'resigned'], 'the healthy candidate is still settled');
  assert.equal(r.errors.length, 3, 'one log line per pass for the contained game, no storm');
  assert.equal(JSON.stringify(await r.store.load('legacy')), r.before);
});

test('no-show expiry contains a stored pre-#127 game the same way', async () => {
  const r = await rig();
  const worker = new NoShowExpiryWorker({
    candidates: {
      due: async () => r.due,
      dismiss: async (gameId: string) => { r.dismissed.push(gameId); },
    },
    events: r.store,
    expire: async (gameId) => { r.expired.push(gameId); },
    logger: r.logger,
    now: () => 10_000,
  });
  assert.deepEqual(await worker.runPass(), { scanned: 2, expired: 0, dismissed: 1, failed: 1, more: false });
  assert.deepEqual(r.expired, []);
  assert.deepEqual(r.dismissed, ['resigned']);
  assert.equal(r.errors.length, 1);
  assert.equal(JSON.stringify(await r.store.load('legacy')), r.before);
});
