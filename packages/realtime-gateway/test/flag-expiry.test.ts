/**
 * In-play flag expiry at the authority (ADR-0149): only the server may expire a clock, the owner
 * decides on its own time and freshest copy, and once the side to move has flagged every command
 * records the timeout — so the outcome never depends on whether a move or the worker arrives first.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameEvent, TimeControl } from '@chess-platform/game';
import { AuthorityError, FLAG_ACTOR, GameAuthority, NO_SHOW_ACTOR, type Command } from '../src/authority';
import { InMemoryEventLog } from '../src/event-log';
import { InMemoryPubSub } from '../src/pubsub';

const TC: TimeControl = { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
const T0 = 1_000_000;
const MOVED = T0 + 1_000;
/** Black's clock starts at White's first move with its full minute. */
const DEADLINE = MOVED + 60_000;
const TIMEOUT = { type: 'GameEnded', result: '1-0', termination: 'timeout', winner: 'w', at: DEADLINE };

async function started(store = new InMemoryEventLog()) {
  const clock = { now: T0 };
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, store);
  await authority.createGame({ gameId: 'g', timeControl: TC, players: { white: 'alice', black: 'bob' }, at: T0 });
  clock.now = MOVED;
  await authority.apply('g', 'alice', { kind: 'move', uci: 'e2e4' });
  return { clock, store, authority };
}

async function tail(store: InMemoryEventLog): Promise<GameEvent[]> {
  return (await store.load('g')).map((e) => e.event).slice(2);
}

async function refused(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof AuthorityError && err.code === code);
}

test('only the server may expire a clock, and not before the side to move has flagged', async () => {
  const r = await started();
  r.clock.now = DEADLINE;
  await refused(r.authority.apply('g', 'alice', { kind: 'expireFlag' }), 'not_a_player');
  await refused(r.authority.apply('g', NO_SHOW_ACTOR, { kind: 'expireFlag' }), 'not_a_player');
  r.clock.now = DEADLINE - 1;
  await refused(r.authority.apply('g', FLAG_ACTOR, { kind: 'expireFlag' }), 'invalid_command');
  assert.deepEqual(await tail(r.store), []);
  r.clock.now = DEADLINE;
  await r.authority.apply('g', FLAG_ACTOR, { kind: 'expireFlag' });
  assert.deepEqual(await tail(r.store), [TIMEOUT]);
  await refused(r.authority.apply('g', FLAG_ACTOR, { kind: 'expireFlag' }), 'invalid_command');
  assert.deepEqual(await tail(r.store), [TIMEOUT], 'a second expiry appends nothing');
});

test('a late worker stamps its own time but never changes the outcome', async () => {
  const r = await started();
  r.clock.now = DEADLINE + 3_600_000;
  await r.authority.apply('g', FLAG_ACTOR, { kind: 'expireFlag' });
  assert.deepEqual(await tail(r.store), [{ ...TIMEOUT, at: DEADLINE + 3_600_000 }]);
});

test('before a first move the flag worker has nothing to expire, even on a game whose clock was anchored at creation', async () => {
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(new InMemoryPubSub(), () => T0 + 10_000_000, store);
  await authority.createGame({ gameId: 'g', timeControl: TC, players: { white: 'alice', black: 'bob' }, at: T0 });
  await refused(authority.apply('g', FLAG_ACTOR, { kind: 'expireFlag' }), 'invalid_command');
  assert.equal((await store.load('g')).length, 1);
});

test('once the side to move has flagged, every player command records the timeout instead', async () => {
  const commands: Array<[string, Command]> = [
    ['bob', { kind: 'move', uci: 'e7e5' }],
    ['bob', { kind: 'resign' }],
    ['alice', { kind: 'resign' }],
    ['bob', { kind: 'offerDraw' }],
    ['alice', { kind: 'abort' }],
    ['bob', { kind: 'ready' }],
  ];
  for (const [user, cmd] of commands) {
    const r = await started();
    r.clock.now = DEADLINE;
    const result = await r.authority.apply('g', user, cmd);
    assert.deepEqual(result.events, [TIMEOUT], `${user} ${cmd.kind}`);
    assert.deepEqual(await tail(r.store), [TIMEOUT]);
  }
  // Accepting a draw the flagged player offered in time does not rescue them after the flag.
  const r = await started();
  r.clock.now = DEADLINE - 10;
  await r.authority.apply('g', 'bob', { kind: 'offerDraw' });
  r.clock.now = DEADLINE;
  assert.deepEqual((await r.authority.apply('g', 'alice', { kind: 'acceptDraw' })).events, [TIMEOUT]);
});

test('a move one millisecond before the deadline is played and replaces the deadline the worker was waiting for', async () => {
  const r = await started();
  r.clock.now = DEADLINE - 1;
  const result = await r.authority.apply('g', 'bob', { kind: 'move', uci: 'e7e5' });
  assert.equal(result.events[0]!.type, 'MovePlayed');
  r.clock.now = DEADLINE;
  await refused(r.authority.apply('g', FLAG_ACTOR, { kind: 'expireFlag' }), 'invalid_command');
  assert.equal((await tail(r.store)).length, 1, 'only the move');
});

test('a move and an expiry racing on the owner: whichever the lock takes first decides, and only one history exists', async () => {
  for (const order of ['move-first', 'expiry-first'] as const) {
    const r = await started();
    r.clock.now = DEADLINE - 1;
    // Both are queued on the game's command lock before either runs. The owner reads its clock when it
    // applies each, so the one applied first at a pre-deadline instant is a legal move.
    const first = order === 'move-first'
      ? r.authority.apply('g', 'bob', { kind: 'move', uci: 'e7e5' })
      : r.authority.apply('g', FLAG_ACTOR, { kind: 'expireFlag' });
    const second = order === 'move-first'
      ? r.authority.apply('g', FLAG_ACTOR, { kind: 'expireFlag' })
      : r.authority.apply('g', 'bob', { kind: 'move', uci: 'e7e5' });
    const settled = await Promise.allSettled([first, second]);
    const events = await tail(r.store);
    if (order === 'move-first') {
      assert.equal(settled[0].status, 'fulfilled');
      assert.equal(settled[1].status, 'rejected', 'the move replaced the clock; the expiry is refused');
      assert.deepEqual(events.map((e) => e.type), ['MovePlayed']);
    } else {
      assert.equal(settled[0].status, 'rejected', 'not due yet on the owner');
      assert.deepEqual(events.map((e) => e.type), ['MovePlayed']);
    }
  }
  // At the deadline the order no longer matters: both paths record the one timeout.
  for (const order of ['move-first', 'expiry-first'] as const) {
    const r = await started();
    r.clock.now = DEADLINE;
    const move = () => r.authority.apply('g', 'bob', { kind: 'move', uci: 'e7e5' });
    const expire = () => r.authority.apply('g', FLAG_ACTOR, { kind: 'expireFlag' });
    await Promise.allSettled(order === 'move-first' ? [move(), expire()] : [expire(), move()]);
    assert.deepEqual(await tail(r.store), [TIMEOUT], order);
  }
});

test('a stale owner cannot end a game over a move a newer owner committed: the log sequence check refuses it', async () => {
  const store = new InMemoryEventLog();
  const old = await started(store);
  const newer = new GameAuthority(new InMemoryPubSub(), () => DEADLINE - 1, store);
  await newer.ensureLoaded('g');
  await newer.apply('g', 'bob', { kind: 'move', uci: 'e7e5' }); // the takeover owner's move
  old.clock.now = DEADLINE; // the stale copy still shows Black's clock running out
  await refused(old.authority.apply('g', FLAG_ACTOR, { kind: 'expireFlag' }), 'invalid_command');
  assert.deepEqual((await tail(store)).map((e) => e.type), ['MovePlayed'], 'the newer move stands alone');
  // The refusal reloaded the stale owner, which now decides from the log.
  await refused(old.authority.apply('g', FLAG_ACTOR, { kind: 'expireFlag' }), 'invalid_command');
  assert.equal(old.authority.getState('g').ply, 2);
});

test('unlimited games never expire', async () => {
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(new InMemoryPubSub(), () => Number.MAX_SAFE_INTEGER, store);
  await authority.createGame({
    gameId: 'g', timeControl: { initialMs: 0, incrementMs: 0, delayMs: 0, kind: 'unlimited' },
    players: { white: 'alice', black: 'bob' }, at: T0,
  });
  await authority.apply('g', 'alice', { kind: 'move', uci: 'e2e4' });
  await refused(authority.apply('g', FLAG_ACTOR, { kind: 'expireFlag' }), 'invalid_command');
  assert.equal((await authority.apply('g', 'bob', { kind: 'move', uci: 'e7e5' })).events[0]!.type, 'MovePlayed');
});
