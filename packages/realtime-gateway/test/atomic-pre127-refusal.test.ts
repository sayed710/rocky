/**
 * #127 option (ii), the owner-accepted interim limitation: gateway hydration stays strict, so a socket
 * join of a stored atomic game whose final move only the pre-#127 rules allowed is refused with the
 * generic `invalid_command` "failed to load game" — not a dedicated historical-game code. These tests
 * pin that the refusal is safe: no crash, nothing resident, no room, one load per join, no write.
 * HTTP readers replay such games through `@chess-platform/game/stored-history` instead.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, charge, type GameEvent, type MovePlayedEvent, type TimeControl } from '@chess-platform/game';
import { GameAuthority } from '../src/authority';
import { InMemoryEventLog } from '../src/event-log';
import { RealtimeGateway } from '../src/gateway';
import { InMemoryPubSub } from '../src/pubsub';
import { InMemoryConnection } from '../src/transport';
import { FakeTokenVerifier } from './fake-token-verifier';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
const LINE = 'e2e3 e7e6 e1e2 e8e7 e2d3 e7d6 d3d4 e6e5';

function pre127Log(gameId: string): GameEvent[] {
  let { game, events } = Game.create({ gameId, variant: 'atomic', timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: true, at: 0 });
  const log: GameEvent[] = [...events];
  let at = 0;
  for (const uci of LINE.split(' ')) {
    const r = game.playMove(uci, (at += 1_000));
    game = r.game;
    log.push(...r.events);
  }
  at += 1_000;
  const charged = charge(game.snapshot().clock, 'w', at, TC);
  const move: MovePlayedEvent = { type: 'MovePlayed', ply: 9, uci: 'd4e5', san: 'Kxe5', by: 'w', moveTimeMs: charged.moveTimeMs, remaining: charged.clock.remaining, at };
  return [...log, move, { type: 'GameEnded', result: '0-1', termination: 'variant', winner: 'b', at }];
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function rig() {
  const store = new InMemoryEventLog();
  await store.append('legacy', -1, pre127Log('legacy'));
  const authority = new GameAuthority(new InMemoryPubSub(), () => 100_000, store);
  await authority.createGame({ gameId: 'live', variant: 'atomic', players: { white: 'alice', black: 'bob' }, rated: false, timeControl: TC });
  const original = store.load.bind(store);
  const loads: string[] = [];
  store.load = async (gameId) => {
    loads.push(gameId);
    return original(gameId);
  };
  const pubsub = new InMemoryPubSub();
  const gateway = new RealtimeGateway(authority, pubsub, new FakeTokenVerifier().allow('alice-token', 'alice'));
  return { store, original, authority, gateway, loads };
}

test('a socket join of a stored pre-#127 atomic game is refused safely, every time, without residue', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const { original, authority, gateway, loads } = await rig();
    const before = JSON.stringify(await original('legacy'));
    const joins: Array<{ token?: string }> = [{}, { token: 'alice-token' }, {}];
    for (const [i, extra] of joins.entries()) {
      const c = new InMemoryConnection(`c${i}`);
      gateway.handleConnection(c);
      c.deliver({ t: 'join', gameId: 'legacy', ...extra });
      await flush();
      assert.deepEqual(c.all('reject').map((r) => [r.code, r.message]), [['invalid_command', 'failed to load game']], `join ${i}`);
      assert.equal(c.last('joined'), undefined);
      assert.equal(c.isClosed, false, 'the socket stays open; the client decides whether to retry');
      // A command on the refused game is answered as for any game never joined.
      c.deliver({ t: 'move', gameId: 'legacy', uci: 'a7a6', clientSeq: 1 });
      await flush();
      assert.equal(c.last('reject')?.code, 'not_joined');
    }
    assert.deepEqual(loads, ['legacy', 'legacy', 'legacy'], 'exactly one load per join: no internal retry loop');
    assert.equal(authority.has('legacy'), false, 'no half-loaded slot is left resident');
    assert.equal(authority.hasFresh('legacy'), false);
    assert.equal((gateway as unknown as { rooms: Map<string, unknown> }).rooms.has('legacy'), false, 'no room is left behind');
    assert.equal(JSON.stringify(await original('legacy')), before, 'the stored result and events are untouched');
    assert.deepEqual(unhandled, []);

    // Positive control: the same gateway still serves other games.
    const ok = new InMemoryConnection('ok');
    gateway.handleConnection(ok);
    ok.deliver({ t: 'join', gameId: 'live', token: 'alice-token' });
    await flush();
    assert.equal(ok.last('joined')?.role, 'white');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('live play never admits the pre-#127 move: the authority refuses it like any illegal move', async () => {
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(new InMemoryPubSub(), () => 100_000, store);
  await authority.createGame({ gameId: 'g', variant: 'atomic', players: { white: 'alice', black: 'bob' }, rated: false, timeControl: TC });
  for (const [i, uci] of LINE.split(' ').entries()) await authority.apply('g', i % 2 === 0 ? 'alice' : 'bob', { kind: 'move', uci });
  const head = (await store.load('g')).length;
  await assert.rejects(authority.apply('g', 'alice', { kind: 'move', uci: 'd4e5' }));
  assert.equal((await store.load('g')).length, head, 'nothing was appended');
  assert.equal(authority.getState('g').status.over, false);
  const connected = await authority.apply('g', 'alice', { kind: 'move', uci: 'd4d5' });
  assert.equal(connected.state.ply, 9, 'the connected-king move the old rules forbade is now playable');
});
