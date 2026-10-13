import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, type GameEvent, type TimeControl } from '@chess-platform/game';
import { GameAuthority, AuthorityCommitError, AuthorityError } from '../src/authority';
import { InMemoryEventLog, MAX_STATE_REVISION, nextEventHead, type EventLog, type LoggedEvent } from '../src/event-log';
import { InMemoryPubSub, gameChannel } from '../src/pubsub';
import type { Broadcast } from '../src/protocol';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
const params = { gameId: 'revision', timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: false };
const revision = (value: object): unknown => Reflect.get(value, 'stateRevision');

test('REV-01 durable revision advances independently of ply', async () => {
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(new InMemoryPubSub(), () => 1_000, store);
  const states = [await authority.createGame(params)];
  states.push((await authority.apply(params.gameId, 'alice', { kind: 'move', uci: 'e2e4' })).state);
  states.push((await authority.apply(params.gameId, 'bob', { kind: 'move', uci: 'e7e5' })).state);
  states.push((await authority.apply(params.gameId, 'alice', { kind: 'offerDraw' })).state);
  states.push((await authority.apply(params.gameId, 'bob', { kind: 'declineDraw' })).state);
  states.push((await authority.apply(params.gameId, 'bob', { kind: 'resign' })).state);
  assert.deepEqual((await store.load(params.gameId)).map(e => e.seq), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(states.map(s => s.ply), [0, 1, 2, 2, 2, 2]);
  assert.deepEqual(states.map(revision), [0, 1, 2, 3, 4, 5]);
});

test('REV-02 repeated readiness neither appends nor advances revision', async () => {
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(new InMemoryPubSub(), () => 1_000, store);
  await authority.createGame({ ...params, source: 'seek', noShowAfterMs: 60_000 });
  const white = await authority.apply(params.gameId, 'alice', { kind: 'ready' });
  const repeated = await authority.apply(params.gameId, 'alice', { kind: 'ready' });
  const black = await authority.apply(params.gameId, 'bob', { kind: 'ready' });
  assert.deepEqual(repeated.events, []);
  assert.deepEqual(repeated.broadcasts, []);
  assert.equal((await store.load(params.gameId)).length, 3);
  assert.deepEqual([white.state, repeated.state, black.state].map(revision), [1, 1, 2]);
  assert.deepEqual([white.broadcasts[0]!, black.broadcasts[0]!].map(revision), [1, 2]);
});

test('REV-03 move-plus-ending frames carry their own durable prefix and replay identically', async () => {
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(new InMemoryPubSub(), () => 1_000, store);
  await authority.createGame({ ...params, initialFen: '4k2r/8/8/8/8/8/8/R3K3 w - - 99 1' });
  const result = await authority.apply(params.gameId, 'alice', { kind: 'move', uci: 'a1a2' });
  assert.deepEqual(result.events.map(e => e.type), ['MovePlayed', 'GameEnded']);
  const move = result.broadcasts[0]!;
  assert.equal(move.t, 'move');
  if (move.t !== 'move') throw new Error('expected move');
  assert.ok(Object.keys(move.legalMoves).length > 0, 'move prefix is not yet terminal');
  assert.deepEqual(result.state.legalMoves, {});
  assert.equal(result.state.status.over, true);
  assert.deepEqual(result.broadcasts.map(revision), [1, 2]);
  assert.equal(revision(result.state), 2);
  authority.evict(params.gameId);
  assert.equal(await authority.ensureLoaded(params.gameId), true);
  assert.deepEqual(authority.getMissedSince(params.gameId, 0), result.broadcasts);
  assert.deepEqual(authority.getState(params.gameId), result.state);
});

test('REV-04 reload rejects corrupt stored positions instead of renumbering them', async () => {
  const { events } = Game.create({ ...params, at: 1_000 });
  const second: GameEvent = { type: 'DrawOffered', by: 'w', at: 1_000 };
  const histories: readonly (readonly LoggedEvent[])[] = [
    [{ seq: 1, event: events[0]! }],
    [{ seq: 0, event: events[0]! }, { seq: 2, event: second }],
    [{ seq: 0, event: events[0]! }, { seq: 0, event: second }],
    [{ seq: 1, event: events[0]! }, { seq: 0, event: second }],
    ...[-1, 0.5, '0', null, undefined, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1, NaN].map(seq => {
      const entry: LoggedEvent = { seq: 0, event: events[0]! };
      Reflect.set(entry, 'seq', seq); // Deliberately malformed adapter data at the persistence boundary.
      return [entry];
    }),
  ];
  for (const history of histories) {
    const store: EventLog = { append: async () => 0, load: async () => history, exists: async () => true };
    const authority = new GameAuthority(new InMemoryPubSub(), () => 1_000, store);
    await assert.rejects(authority.ensureLoaded(params.gameId), /sequence|revision/i);
    assert.equal(authority.hasFresh(params.gameId), false);
  }
});

test('REV-04 a committed append with a wrong returned head stays an unknown outcome', async () => {
  const backing = new InMemoryEventLog();
  const store: EventLog = {
    append: async (id, head, events) => {
      const actual = await backing.append(id, head, events);
      return head === -1 ? actual : actual + 1;
    },
    load: id => backing.load(id), exists: id => backing.exists(id),
  };
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1_000, store);
  await authority.createGame(params);
  const published: Broadcast[] = [];
  pubsub.subscribe(gameChannel(params.gameId), msg => published.push(msg));
  await assert.rejects(authority.apply(params.gameId, 'alice', { kind: 'move', uci: 'e2e4' }, { requestId: 'exact-command' }), AuthorityCommitError);
  assert.deepEqual(published, [], 'no event or exact-command confirmation on malformed acknowledgement');
  assert.equal((await backing.load(params.gameId)).length, 2, 'the append actually committed');
  assert.equal(authority.getState(params.gameId).ply, 1, 'reload reconciles committed state');
});

test('revision capacity fails closed before overflow, while a no-op fits the maximum head', () => {
  assert.equal(nextEventHead(-1, 1), 0);
  assert.equal(nextEventHead(MAX_STATE_REVISION - 1, 1), MAX_STATE_REVISION);
  assert.equal(nextEventHead(MAX_STATE_REVISION, 0), MAX_STATE_REVISION);
  assert.throws(() => nextEventHead(MAX_STATE_REVISION, 1), /sequence/);
  assert.throws(() => nextEventHead(MAX_STATE_REVISION - 1, 2), /sequence/);
  for (const head of [-2, 0.5, NaN, Infinity, MAX_STATE_REVISION + 1]) {
    assert.throws(() => nextEventHead(head, 1), /sequence/);
  }
});

test('exhausted authority head refuses an append but permits idempotent readiness', async () => {
  const backing = new InMemoryEventLog();
  let appends = 0;
  const store: EventLog = {
    append: (id, head, events) => { appends++; return backing.append(id, head, events); },
    load: id => backing.load(id), exists: id => backing.exists(id),
  };
  const authority = new GameAuthority(new InMemoryPubSub(), () => 1_000, store);
  await authority.createGame({ ...params, source: 'seek', noShowAfterMs: 60_000 });
  await authority.apply(params.gameId, 'alice', { kind: 'ready' });
  // Bounded capacity fixture, not a valid replay history of two billion events.
  const slots = Reflect.get(authority, 'games') as Map<string, { record: { persistedSeq: number } }>;
  slots.get(params.gameId)!.record.persistedSeq = MAX_STATE_REVISION;
  await assert.rejects(authority.apply(params.gameId, 'bob', { kind: 'ready' }),
    (error: unknown) => error instanceof AuthorityError && !(error instanceof AuthorityCommitError) && /sequence/.test(error.message));
  assert.equal(appends, 2, 'capacity rejection precedes the store call');
  const repeated = await authority.apply(params.gameId, 'alice', { kind: 'ready' });
  assert.equal(revision(repeated.state), MAX_STATE_REVISION);
  assert.equal(appends, 2);
});

test('a controlled append barrier prevents premature state, event or exact receipt publication', async () => {
  const backing = new InMemoryEventLog();
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const store: EventLog = {
    append: async (id, head, events) => {
      if (head >= 0) { reached(); await gate; }
      return backing.append(id, head, events);
    },
    load: id => backing.load(id), exists: id => backing.exists(id),
  };
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1_000, store);
  await authority.createGame(params);
  const published: Broadcast[] = [];
  pubsub.subscribe(gameChannel(params.gameId), msg => published.push(msg));
  const applying = authority.apply(params.gameId, 'alice', { kind: 'move', uci: 'e2e4' }, { requestId: 'barrier-command' });
  await entered;
  assert.equal(published.length, 0);
  assert.equal(revision(authority.getState(params.gameId)), 0);
  assert.equal((await backing.load(params.gameId)).length, 1);
  release();
  const result = await applying;
  assert.equal(revision(result.state), 1);
  assert.deepEqual(published.map(msg => msg.t), ['move', 'commandConfirmed']);
});
