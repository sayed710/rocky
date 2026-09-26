/** Client view of durable readiness and pregame no-show outcomes (ADR-0148). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { GameController } from '../src/app/game-controller.js';
import type { ReadyView, Role, StateView } from '../src/net/ws-protocol.js';
import { decodeServer } from '../src/net/ws-protocol.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function setup() {
  const factory = new FakeSocketFactory();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler: new ManualScheduler(),
    now: () => 0,
    rng: () => 0,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync = new GameSync(client, { gameId: 'g1', token: 'token-u1' });
  const statuses: string[] = [];
  const turns: boolean[] = [];
  const controller = new GameController({
    gameSync: sync,
    callbacks: {
      onPosition: () => {},
      onTurn: (myTurn) => turns.push(myTurn),
      onClock: () => {},
      onStatus: (text) => statuses.push(text),
    },
  });
  controller.start();
  sync.start();
  factory.last.open();
  return { factory, sync, controller, statuses, turns };
}

function view(ready: ReadyView | null | undefined, over: StateView['status'] = { over: false }): StateView {
  return {
    gameId: 'g1',
    variant: 'standard',
    players: { white: 'u1', black: 'u2' },
    timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    fen: START,
    fenHash: 'h0',
    ply: 0,
    turn: 'w',
    clock: { w: 60_000, b: 60_000 },
    turnStartedAt: null,
    status: over,
    drawOffer: null,
    moves: [],
    legalMoves: {},
    chess960StartId: null,
    ...(ready !== undefined ? { ready } : {}),
  };
}

function join(role: Role, ready: ReadyView | null | undefined) {
  const h = setup();
  h.factory.last.emit({ t: 'joined', gameId: 'g1', role, state: view(ready) });
  return h;
}

test('a seated player waits for the opponent, and the board stays closed until both are ready', () => {
  const h = join('white', { w: false, b: false });
  assert.equal(h.statuses.at(-1), 'Joining…');
  assert.equal(h.turns.at(-1), false);

  h.factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: true, b: false }, serverTs: 1 });
  assert.equal(h.statuses.at(-1), 'Waiting for your opponent to join');
  assert.equal(h.turns.at(-1), false);

  h.factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: true, b: true }, serverTs: 2 });
  assert.equal(h.statuses.at(-1), 'Your move');
  assert.equal(h.turns.at(-1), true);
});

test('a late or reordered readiness broadcast never undoes a ready seat', () => {
  const h = join('black', { w: false, b: false });
  h.factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: true, b: true }, serverTs: 2 });
  h.factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: true, b: false }, serverTs: 1 });
  assert.deepEqual(h.sync.getState().ready, { w: true, b: true });
  assert.equal(h.statuses.at(-1), 'White to move');
});

test('spectators see who the game is waiting for, from readiness rather than presence', () => {
  const h = join('spectator', { w: false, b: false });
  assert.equal(h.statuses.at(-1), 'Waiting for both players to join');
  h.factory.last.emit({ t: 'presence', gameId: 'g1', white: true, black: true, spectators: 1 });
  assert.equal(h.statuses.at(-1), 'Waiting for both players to join', 'presence is not readiness');
  h.factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: false, b: true }, serverTs: 1 });
  assert.equal(h.statuses.at(-1), 'Waiting for White to join');
});

test('a game without readiness, or a gateway that sends none, behaves exactly as before', () => {
  for (const ready of [null, undefined]) {
    const h = join('white', ready);
    assert.equal(h.sync.getState().ready, null);
    assert.equal(h.statuses.at(-1), 'Your move');
    assert.equal(h.turns.at(-1), true);
  }
});

test('malformed readiness from the wire reads as none rather than locking the board', () => {
  const frame = JSON.stringify({ t: 'joined', gameId: 'g1', role: 'white', state: { ...view(null), ready: { w: 'yes', b: 1 } } });
  const h = setup();
  h.factory.last.emit(decodeServer(frame)!);
  assert.equal(h.sync.getState().ready, null);
  h.factory.last.emit({ t: 'ready', gameId: 'g1', ready: 'nonsense' } as never);
  assert.equal(h.sync.getState().ready, null);
  assert.equal(h.turns.at(-1), true);
});

test('pregame no-show endings are described as no-shows, never as time forfeits', () => {
  const cases: Array<[StateView['status'], string]> = [
    [{ over: true, result: '1-0', termination: 'no_show', winner: 'w' }, 'White wins — the opponent did not show up (1-0)'],
    [{ over: true, result: '0-1', termination: 'no_show', winner: 'b' }, 'Black wins — the opponent did not show up (0-1)'],
    [{ over: true, result: '*', termination: 'no_show', winner: null }, 'Not started in time — no result'],
  ];
  for (const [status, text] of cases) {
    const h = setup();
    h.factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: view({ w: true, b: false }, status) });
    assert.equal(h.statuses.at(-1), text);
  }
  const live = join('white', { w: true, b: false });
  live.factory.last.emit({ t: 'ended', gameId: 'g1', result: '*', termination: 'no_show', winner: null, serverTs: 60_000 });
  assert.equal(live.statuses.at(-1), 'Not started in time — no result');
});
