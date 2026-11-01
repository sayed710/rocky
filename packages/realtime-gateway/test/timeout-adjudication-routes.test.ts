/**
 * Real-time gateway Route 3 (expireFlag) and Route 4 (late command arbitration)
 * regression tests for FIDE 6.9 timeout reachability adjudication under Standard
 * and Chess960.
 *
 * Exercises the authoritative GameAuthority pipeline with InMemoryEventLog:
 * - Ongoing Draw (Control 1 predecessor): ensures timeout yields insufficient_material draw.
 * - Ongoing Win (KN vs KR predecessor): ensures timeout yields 1-0 win for White.
 * - Both Standard and Chess960 (with synthetic legacy GameCreated lacking chess960StartId).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameCreatedEvent, GameEvent, TimeControl } from '@chess-platform/game';
import {
  FLAG_ACTOR,
  GameAuthority,
  type ApplyResult,
} from '../src/authority';
import { InMemoryEventLog } from '../src/event-log';
import { InMemoryPubSub } from '../src/pubsub';

const TC: TimeControl = { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
const T0 = 1_000_000;
const MOVED = T0 + 1_000;
const DEADLINE = MOVED + 60_000;

const DRAW_PREDECESSOR = '7k/5K1n/8/6B1/8/8/8/8 w - - 0 1';
const WIN_PREDECESSOR = '8/8/8/8/8/K4N2/1r6/k7 w - - 0 1';

async function tail(store: InMemoryEventLog, gameId: string): Promise<GameEvent[]> {
  return (await store.load(gameId)).map((e) => e.event);
}

// ============================================================================
// Standard Routes 3 & 4
// ============================================================================

test('Route 3 (expireFlag) - Standard Ongoing Draw: adjudicates insufficient_material', async () => {
  const store = new InMemoryEventLog();
  const clock = { now: T0 };
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, store);

  await authority.createGame({
    gameId: 'std-draw-route3',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    variant: 'standard',
    initialFen: DRAW_PREDECESSOR,
    at: T0,
  });

  // White plays g5f6 reaching Control 1 at MOVED
  clock.now = MOVED;
  await authority.apply('std-draw-route3', 'alice', { kind: 'move', uci: 'g5f6' });

  // Clock expires at DEADLINE for Black
  clock.now = DEADLINE;
  const res: ApplyResult = await authority.apply('std-draw-route3', FLAG_ACTOR, { kind: 'expireFlag' });

  const endEvent = res.events.find((e) => e.type === 'GameEnded');
  assert.ok(endEvent && endEvent.type === 'GameEnded');
  assert.equal(endEvent.result, '1/2-1/2');
  assert.equal(endEvent.termination, 'insufficient_material');
  assert.equal(endEvent.winner, null);

  // Assert stored event log contains the exact GameEnded event
  const events = await tail(store, 'std-draw-route3');
  const storedEnd = events[events.length - 1];
  assert.deepEqual(storedEnd, endEvent);
});

test('Route 4 (command arbitration) - Standard Ongoing Draw: late move adjudicates insufficient_material', async () => {
  const store = new InMemoryEventLog();
  const clock = { now: T0 };
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, store);

  await authority.createGame({
    gameId: 'std-draw-route4',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    variant: 'standard',
    initialFen: DRAW_PREDECESSOR,
    at: T0,
  });

  clock.now = MOVED;
  await authority.apply('std-draw-route4', 'alice', { kind: 'move', uci: 'g5f6' });

  // Bob attempts a move at DEADLINE when clock has expired
  clock.now = DEADLINE;
  const res: ApplyResult = await authority.apply('std-draw-route4', 'bob', { kind: 'move', uci: 'h7f6' });

  const endEvent = res.events.find((e) => e.type === 'GameEnded');
  assert.ok(endEvent && endEvent.type === 'GameEnded');
  assert.equal(endEvent.result, '1/2-1/2');
  assert.equal(endEvent.termination, 'insufficient_material');
  assert.equal(endEvent.winner, null);
});

test('Route 3 (expireFlag) - Standard Ongoing Win (KN vs KR): adjudicates timeout win for White', async () => {
  const store = new InMemoryEventLog();
  const clock = { now: T0 };
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, store);

  await authority.createGame({
    gameId: 'std-win-route3',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    variant: 'standard',
    initialFen: WIN_PREDECESSOR,
    at: T0,
  });

  clock.now = MOVED;
  await authority.apply('std-win-route3', 'alice', { kind: 'move', uci: 'f3e1' });

  clock.now = DEADLINE;
  const res: ApplyResult = await authority.apply('std-win-route3', FLAG_ACTOR, { kind: 'expireFlag' });

  const endEvent = res.events.find((e) => e.type === 'GameEnded');
  assert.ok(endEvent && endEvent.type === 'GameEnded');
  assert.equal(endEvent.result, '1-0');
  assert.equal(endEvent.termination, 'timeout');
  assert.equal(endEvent.winner, 'w');
});

test('Route 4 (command arbitration) - Standard Ongoing Win (KN vs KR): late move adjudicates timeout win', async () => {
  const store = new InMemoryEventLog();
  const clock = { now: T0 };
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, store);

  await authority.createGame({
    gameId: 'std-win-route4',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    variant: 'standard',
    initialFen: WIN_PREDECESSOR,
    at: T0,
  });

  clock.now = MOVED;
  await authority.apply('std-win-route4', 'alice', { kind: 'move', uci: 'f3e1' });

  clock.now = DEADLINE;
  const res: ApplyResult = await authority.apply('std-win-route4', 'bob', { kind: 'move', uci: 'b2b1' });

  const endEvent = res.events.find((e) => e.type === 'GameEnded');
  assert.ok(endEvent && endEvent.type === 'GameEnded');
  assert.equal(endEvent.result, '1-0');
  assert.equal(endEvent.termination, 'timeout');
  assert.equal(endEvent.winner, 'w');
});

// ============================================================================
// Chess960 Legacy Routes 3 & 4 (Synthetic GameCreated without chess960StartId)
// ============================================================================

test('Route 3 (expireFlag) - Chess960 Legacy Ongoing Draw: adjudicates insufficient_material', async () => {
  const store = new InMemoryEventLog();
  const legacyCreated: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'c960-draw-route3',
    variant: 'chess960',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: false,
    initialFen: DRAW_PREDECESSOR,
    at: T0,
  };
  await store.append('c960-draw-route3', -1, [legacyCreated]);

  const clock = { now: MOVED };
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, store);
  await authority.ensureLoaded('c960-draw-route3');

  await authority.apply('c960-draw-route3', 'alice', { kind: 'move', uci: 'g5f6' });

  clock.now = DEADLINE;
  const res = await authority.apply('c960-draw-route3', FLAG_ACTOR, { kind: 'expireFlag' });

  const endEvent = res.events.find((e) => e.type === 'GameEnded');
  assert.ok(endEvent && endEvent.type === 'GameEnded');
  assert.equal(endEvent.result, '1/2-1/2');
  assert.equal(endEvent.termination, 'insufficient_material');
  assert.equal(endEvent.winner, null);
});

test('Route 4 (command arbitration) - Chess960 Legacy Ongoing Draw: late move adjudicates insufficient_material', async () => {
  const store = new InMemoryEventLog();
  const legacyCreated: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'c960-draw-route4',
    variant: 'chess960',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: false,
    initialFen: DRAW_PREDECESSOR,
    at: T0,
  };
  await store.append('c960-draw-route4', -1, [legacyCreated]);

  const clock = { now: MOVED };
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, store);
  await authority.ensureLoaded('c960-draw-route4');

  await authority.apply('c960-draw-route4', 'alice', { kind: 'move', uci: 'g5f6' });

  clock.now = DEADLINE;
  const res = await authority.apply('c960-draw-route4', 'bob', { kind: 'move', uci: 'h7f6' });

  const endEvent = res.events.find((e) => e.type === 'GameEnded');
  assert.ok(endEvent && endEvent.type === 'GameEnded');
  assert.equal(endEvent.result, '1/2-1/2');
  assert.equal(endEvent.termination, 'insufficient_material');
  assert.equal(endEvent.winner, null);
});

test('Route 3 (expireFlag) - Chess960 Legacy Ongoing Win: adjudicates timeout win for White', async () => {
  const store = new InMemoryEventLog();
  const legacyCreated: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'c960-win-route3',
    variant: 'chess960',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: false,
    initialFen: WIN_PREDECESSOR,
    at: T0,
  };
  await store.append('c960-win-route3', -1, [legacyCreated]);

  const clock = { now: MOVED };
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, store);
  await authority.ensureLoaded('c960-win-route3');

  await authority.apply('c960-win-route3', 'alice', { kind: 'move', uci: 'f3e1' });

  clock.now = DEADLINE;
  const res = await authority.apply('c960-win-route3', FLAG_ACTOR, { kind: 'expireFlag' });

  const endEvent = res.events.find((e) => e.type === 'GameEnded');
  assert.ok(endEvent && endEvent.type === 'GameEnded');
  assert.equal(endEvent.result, '1-0');
  assert.equal(endEvent.termination, 'timeout');
  assert.equal(endEvent.winner, 'w');
});

test('Route 4 (command arbitration) - Chess960 Legacy Ongoing Win: late move adjudicates timeout win', async () => {
  const store = new InMemoryEventLog();
  const legacyCreated: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'c960-win-route4',
    variant: 'chess960',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: false,
    initialFen: WIN_PREDECESSOR,
    at: T0,
  };
  await store.append('c960-win-route4', -1, [legacyCreated]);

  const clock = { now: MOVED };
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, store);
  await authority.ensureLoaded('c960-win-route4');

  await authority.apply('c960-win-route4', 'alice', { kind: 'move', uci: 'f3e1' });

  clock.now = DEADLINE;
  const res = await authority.apply('c960-win-route4', 'bob', { kind: 'move', uci: 'b2b1' });

  const endEvent = res.events.find((e) => e.type === 'GameEnded');
  assert.ok(endEvent && endEvent.type === 'GameEnded');
  assert.equal(endEvent.result, '1-0');
  assert.equal(endEvent.termination, 'timeout');
  assert.equal(endEvent.winner, 'w');
});
