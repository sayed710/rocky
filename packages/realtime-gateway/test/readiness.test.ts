/**
 * Durable readiness, first-move admission and no-show expiry at the authority and gateway (ADR-0148).
 *
 * Every assertion about readiness reads the durable event log, not presence or a cached view.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameSource, TimeControl } from '@chess-platform/game';
import { AuthorityError, GameAuthority, NO_SHOW_ACTOR, type Command } from '../src/authority';
import { InMemoryEventLog } from '../src/event-log';
import { InMemoryPubSub } from '../src/pubsub';
import { InMemoryConnection } from '../src/transport';
import { RealtimeGateway } from '../src/gateway';
import type { CommandRouter } from '../src/command-router';
import { decode, type Broadcast } from '../src/protocol';
import { FakeTokenVerifier } from './fake-token-verifier';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };
const CREATED_AT = 1_000_000;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

interface NodeOptions {
  readonly store?: InMemoryEventLog;
  readonly pubsub?: InMemoryPubSub;
  readonly router?: (authority: GameAuthority) => CommandRouter;
}

/** One gateway replica: an authority over a shared log and pub/sub, with a controllable clock. */
function node(options: NodeOptions = {}) {
  const clock = { now: CREATED_AT };
  const store = options.store ?? new InMemoryEventLog();
  const pubsub = options.pubsub ?? new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => clock.now, store);
  const verifier = new FakeTokenVerifier().allow('token-alice', 'alice').allow('token-bob', 'bob').allow('token-eve', 'eve');
  const gateway = new RealtimeGateway(authority, pubsub, verifier, () => clock.now, options.router?.(authority));
  const connect = (id: string): InMemoryConnection => {
    const conn = new InMemoryConnection(id);
    gateway.handleConnection(conn);
    return conn;
  };
  return { clock, store, pubsub, authority, gateway, connect };
}

async function create(authority: GameAuthority, gameId = 'g', source: GameSource | null = 'seek'): Promise<void> {
  await authority.createGame({
    gameId, timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: true, at: CREATED_AT,
    ...(source !== null ? { source } : {}),
  });
}

async function readyEvents(store: InMemoryEventLog, gameId = 'g'): Promise<string[]> {
  return (await store.load(gameId)).flatMap(({ event }) => (event.type === 'PlayerReady' ? [event.by] : []));
}

test('a seated authenticated join commits PlayerReady; spectators and bad tokens never do', async () => {
  const n = node();
  await create(n.authority);
  const spectator = n.connect('spec');
  spectator.deliver({ t: 'join', gameId: 'g' });
  const stranger = n.connect('eve');
  stranger.deliver({ t: 'join', gameId: 'g', token: 'token-eve' });
  const forger = n.connect('forger');
  forger.deliver({ t: 'join', gameId: 'g', token: 'not-a-token' });
  await flush();
  assert.equal(forger.last('reject')?.code, 'unauthorized');
  assert.deepEqual(await readyEvents(n.store), [], 'presence of spectators or an invalid token is never readiness');

  const alice = n.connect('a');
  alice.deliver({ t: 'join', gameId: 'g', token: 'token-alice' });
  await flush();
  assert.deepEqual(await readyEvents(n.store), ['w']);
  assert.deepEqual(spectator.last('ready')?.ready, { w: true, b: false }, 'readiness fans out to the room');
});

test('duplicate joins, several tabs and reconnects record exactly one readiness per seat', async () => {
  const n = node();
  await create(n.authority);
  const tabs = ['t1', 't2', 't3'].map((id) => n.connect(id));
  for (const tab of tabs) tab.deliver({ t: 'join', gameId: 'g', token: 'token-alice' });
  tabs[0]!.deliver({ t: 'join', gameId: 'g', token: 'token-alice' });
  await flush();
  tabs[1]!.close();
  n.connect('t4').deliver({ t: 'join', gameId: 'g', token: 'token-alice' });
  await flush();
  assert.deepEqual(await readyEvents(n.store), ['w']);
});

test('readiness survives disconnect and a restart, and the state view reports it from the log', async () => {
  const first = node();
  await create(first.authority);
  const alice = first.connect('a');
  alice.deliver({ t: 'join', gameId: 'g', token: 'token-alice' });
  await flush();
  alice.close();
  assert.deepEqual(first.authority.getState('g').ready, { w: true, b: false }, 'a disconnect does not undo it');

  // The gateway "crashes": a fresh replica over the same durable log.
  const restarted = node({ store: first.store });
  const bob = restarted.connect('b');
  bob.deliver({ t: 'join', gameId: 'g', token: 'token-bob' });
  await flush();
  assert.deepEqual(bob.last('joined')?.state.ready, { w: true, b: false }, 'the reload still knows White is ready');
  assert.deepEqual(restarted.authority.getState('g').ready, { w: true, b: true });
  assert.deepEqual(await readyEvents(first.store), ['w', 'b']);
});

test('the first move is refused with not_ready until both seats are ready, then starts only Black\'s clock', async () => {
  const n = node();
  await create(n.authority);
  const alice = n.connect('a');
  alice.deliver({ t: 'join', gameId: 'g', token: 'token-alice' });
  await flush();
  alice.deliver({ t: 'move', gameId: 'g', uci: 'e2e4', clientSeq: 1 });
  await flush();
  assert.equal(alice.last('reject')?.code, 'not_ready');
  assert.equal(alice.last('reject')?.ref, 1);

  const bob = n.connect('b');
  bob.deliver({ t: 'join', gameId: 'g', token: 'token-bob' });
  await flush();
  n.clock.now += 30_000; // both ready, then half a minute before White moves
  assert.deepEqual(n.authority.getState('g').clock, { w: 300_000, b: 300_000 });
  assert.equal(n.authority.getState('g').turnStartedAt, null, 'no clock runs while waiting for the first move');
  alice.deliver({ t: 'move', gameId: 'g', uci: 'e2e4', clientSeq: 2 });
  await flush();
  const move = bob.last('move');
  assert.deepEqual(move?.clock, { w: 303_000, b: 300_000 }, 'White is not charged for the wait');
  assert.equal(n.authority.getState('g').turnStartedAt, n.clock.now, "Black's clock starts at the move's server time");
});

test('White moving while Black\'s readiness is still committing is refused, never admitted early', async () => {
  const n = node();
  await create(n.authority);
  await n.authority.apply('g', 'alice', { kind: 'ready' });
  // Both commands queue on the per-game lock in arrival order: the move is evaluated first.
  const move = n.authority.apply('g', 'alice', { kind: 'move', uci: 'e2e4' });
  const ready = n.authority.apply('g', 'bob', { kind: 'ready' });
  await assert.rejects(move, (err: unknown) => err instanceof AuthorityError && err.code === 'not_ready');
  await ready;
  assert.deepEqual((await n.store.load('g')).map(({ event }) => event.type), ['GameCreated', 'PlayerReady', 'PlayerReady']);
});

test('two replicas racing different seats\' readiness both land, exactly once each', async () => {
  // Split brain on purpose: both replicas act as the authority over one log with local routing.
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const a = node({ store, pubsub });
  const b = node({ store, pubsub });
  await create(a.authority);
  await b.authority.ensureLoaded('g');
  const alice = a.connect('a');
  const bob = b.connect('b');
  alice.deliver({ t: 'join', gameId: 'g', token: 'token-alice' });
  bob.deliver({ t: 'join', gameId: 'g', token: 'token-bob' });
  await flush();
  assert.equal(bob.last('reject'), undefined, 'the losing append was re-evaluated, not reported');
  assert.deepEqual((await readyEvents(store)).sort(), ['b', 'w']);
  const reloaded = node({ store });
  await reloaded.authority.ensureLoaded('g');
  assert.deepEqual(reloaded.authority.getState('g').ready, { w: true, b: true });
});

test('a game without a source records no readiness and admits the first move at once', async () => {
  const n = node();
  await create(n.authority, 'legacy', null);
  const alice = n.connect('a');
  alice.deliver({ t: 'join', gameId: 'legacy', token: 'token-alice' });
  await flush();
  assert.equal(alice.last('joined')?.state.ready, null);
  alice.deliver({ t: 'move', gameId: 'legacy', uci: 'e2e4', clientSeq: 1 });
  await flush();
  assert.equal(alice.last('reject'), undefined);
  assert.deepEqual((await n.store.load('legacy')).map(({ event }) => event.type), ['GameCreated', 'MovePlayed']);
});

test('clients can issue neither readiness nor expiry over the wire; only the server actor expires', async () => {
  assert.equal(decode(JSON.stringify({ t: 'ready', gameId: 'g' })), null);
  assert.equal(decode(JSON.stringify({ t: 'expireNoShow', gameId: 'g', afterMs: 1 })), null);
  const n = node();
  await create(n.authority);
  const expire: Command = { kind: 'expireNoShow', afterMs: 60_000 };
  n.clock.now = CREATED_AT + 60_000;
  await assert.rejects(n.authority.apply('g', 'alice', expire), (e: unknown) => e instanceof AuthorityError && e.code === 'not_a_player');
  await assert.rejects(n.authority.apply('g', NO_SHOW_ACTOR, { kind: 'resign' }), (e: unknown) => e instanceof AuthorityError && e.code === 'not_a_player');
  await assert.rejects(n.authority.apply('g', NO_SHOW_ACTOR, { kind: 'expireNoShow', afterMs: 0 }), /positive integer/);
  n.clock.now = CREATED_AT + 59_999;
  await assert.rejects(n.authority.apply('g', NO_SHOW_ACTOR, expire), /not_due/);
});

test('no-show expiry ends the game once, fans out, and refuses every later command', async () => {
  const n = node();
  await create(n.authority);
  const spectator = n.connect('s');
  spectator.deliver({ t: 'join', gameId: 'g' });
  const ended: Broadcast[] = [];
  n.pubsub.subscribe('games:ended', (m) => ended.push(m));
  n.clock.now = CREATED_AT + 60_000;
  const [first, second] = await Promise.allSettled([
    n.authority.apply('g', NO_SHOW_ACTOR, { kind: 'expireNoShow', afterMs: 60_000 }),
    n.authority.apply('g', NO_SHOW_ACTOR, { kind: 'expireNoShow', afterMs: 60_000 }),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected', 'a second expiry finds the game over');
  assert.deepEqual(spectator.last('ended'), {
    t: 'ended', gameId: 'g', result: '*', termination: 'no_show', winner: null, serverTs: CREATED_AT + 60_000,
  });
  assert.equal(ended.length, 1);
  const types = (await n.store.load('g')).map(({ event }) => event.type);
  assert.deepEqual(types, ['GameCreated', 'GameEnded']);
});

test('expiry racing the first move on one owner: exactly one of them wins', async () => {
  for (const order of ['move-first', 'expiry-first'] as const) {
    const n = node();
    await create(n.authority);
    await n.authority.apply('g', 'alice', { kind: 'ready' });
    await n.authority.apply('g', 'bob', { kind: 'ready' });
    n.clock.now = CREATED_AT + 60_000;
    const move = (): Promise<unknown> => n.authority.apply('g', 'alice', { kind: 'move', uci: 'e2e4' });
    const expire = (): Promise<unknown> => n.authority.apply('g', NO_SHOW_ACTOR, { kind: 'expireNoShow', afterMs: 60_000 });
    const results = await Promise.allSettled(order === 'move-first' ? [move(), expire()] : [expire(), move()]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected'], order);
    const types = (await n.store.load('g')).map(({ event }) => event.type);
    assert.deepEqual(types.slice(3), [order === 'move-first' ? 'MovePlayed' : 'GameEnded'], order);
  }
});

test('a stale owner cannot append a first move after another owner committed the no-show', async () => {
  const store = new InMemoryEventLog();
  const stale = node({ store });
  const fresh = node({ store });
  await create(stale.authority);
  await stale.authority.apply('g', 'alice', { kind: 'ready' });
  await stale.authority.apply('g', 'bob', { kind: 'ready' });
  await fresh.authority.ensureLoaded('g');
  fresh.clock.now = CREATED_AT + 60_000;
  await fresh.authority.apply('g', NO_SHOW_ACTOR, { kind: 'expireNoShow', afterMs: 60_000 });

  // The stale copy still thinks the game is waiting for White's first move.
  await assert.rejects(stale.authority.apply('g', 'alice', { kind: 'move', uci: 'e2e4' }), /failed to persist/);
  const types = (await store.load('g')).map(({ event }) => event.type);
  assert.deepEqual(types, ['GameCreated', 'PlayerReady', 'PlayerReady', 'GameEnded'], 'no MovePlayed after the no-show');
  assert.equal(stale.authority.getState('g').status.over, true, 'the losing owner reloaded the durable ending');
});

test('a resume after restart replays readiness broadcasts from the durable log', async () => {
  const first = node();
  await create(first.authority);
  await first.authority.apply('g', 'alice', { kind: 'ready' });
  const restarted = node({ store: first.store });
  await restarted.authority.ensureLoaded('g');
  assert.deepEqual(restarted.authority.getMissedSince('g', 0), [
    { t: 'ready', gameId: 'g', ready: { w: true, b: false }, serverTs: CREATED_AT },
  ]);
});
