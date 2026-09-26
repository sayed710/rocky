/**
 * The no-show worker's own logic, hermetically (ADR-0148): what it decides from the durable log,
 * how it recovers from failures, and what it lets go of. Real routing, Redis and PostgreSQL are
 * covered by no-show-expiry.integration.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, type GameSource, type TimeControl } from '@chess-platform/game';
import {
  GameAuthority,
  InMemoryEventLog,
  InMemoryPubSub,
  LocalCommandRouter,
  NO_SHOW_ACTOR,
  type Command,
  type CommandRouter,
} from '@chess-platform/realtime-gateway';
import type { NoShowCandidate, NoShowCandidateQuery } from '@chess-platform/persistence/pg';
import { NoShowExpiryWorker, routedNoShowExpiry, type NoShowCandidateSource } from '../src/no-show-expiry.js';

const TC: TimeControl = { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
const T0 = 1_000_000;
const DEADLINE: Record<GameSource, number> = { seek: 60_000, tournament: 300_000 };

/** The queue as the trigger keeps it; entries leave on dismissal or when the test ends a game. */
class FakeQueue implements NoShowCandidateSource {
  readonly entries: NoShowCandidate[] = [];
  readonly queries: NoShowCandidateQuery[] = [];
  readonly dismissed: string[] = [];
  failNext = 0;
  async due(query: NoShowCandidateQuery): Promise<NoShowCandidate[]> {
    this.queries.push(query);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('database unreachable');
    }
    const after = query.after;
    return this.entries
      .filter((e) => e.dueAt <= query.dueBy)
      .filter((e) => after === null || e.dueAt > after.dueAt || (e.dueAt.getTime() === after.dueAt.getTime() && e.gameId > after.gameId))
      .sort((x, y) => x.dueAt.getTime() - y.dueAt.getTime() || x.gameId.localeCompare(y.gameId))
      .slice(0, query.limit);
  }
  async dismiss(gameId: string): Promise<void> {
    this.dismissed.push(gameId);
    this.remove(gameId);
  }
  remove(gameId: string): void {
    const i = this.entries.findIndex((e) => e.gameId === gameId);
    if (i >= 0) this.entries.splice(i, 1);
  }
}

function rig() {
  const clock = { now: T0 };
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, store);
  const queue = new FakeQueue();
  const expired: string[] = [];
  const router = new LocalCommandRouter(authority);
  const expire = async (gameId: string): Promise<void> => {
    await authority.ensureLoaded(gameId);
    await router.route(gameId, NO_SHOW_ACTOR, { kind: 'expireNoShow' });
    queue.remove(gameId); // the ending's trigger would remove it
    expired.push(gameId);
  };
  const create = async (gameId: string, source: GameSource | null, at = T0): Promise<void> => {
    await authority.createGame({
      gameId, timeControl: TC, players: { white: 'w', black: 'b' }, at,
      ...(source ? { source, noShowAfterMs: DEADLINE[source] } : {}),
    });
    if (source) queue.entries.push({ gameId, dueAt: new Date(at + DEADLINE[source]) });
  };
  return { clock, store, authority, queue, expired, expire, create };
}

async function endings(store: InMemoryEventLog, gameId: string) {
  return (await store.load(gameId)).map((e) => e.event).filter((e) => e.type === 'GameEnded');
}

test('expires a due seek game once, and only once its durable deadline has passed', async () => {
  const r = rig();
  await r.create('seek-1', 'seek');
  const worker = new NoShowExpiryWorker({ candidates: r.queue, events: r.store, expire: r.expire, now: () => r.clock.now });
  r.clock.now = T0 + 59_999;
  assert.equal((await worker.runPass()).expired, 0);
  r.clock.now = T0 + 60_000;
  assert.equal((await worker.runPass()).expired, 1);
  assert.equal((await worker.runPass()).scanned, 0, 'the ending left the queue');
  assert.deepEqual(await endings(r.store, 'seek-1'), [
    { type: 'GameEnded', result: '*', termination: 'no_show', winner: null, at: T0 + 60_000 },
  ]);
});

test('decides from the log: a started game and a both-ready tournament game are dismissed, never expired', async () => {
  const r = rig();
  await r.create('moved', 'seek');
  await r.authority.apply('moved', 'w', { kind: 'ready' });
  await r.authority.apply('moved', 'b', { kind: 'ready' });
  await r.authority.apply('moved', 'w', { kind: 'move', uci: 'e2e4' }); // the queue entry is stale
  await r.create('both', 'tournament');
  await r.authority.apply('both', 'w', { kind: 'ready' });
  await r.authority.apply('both', 'b', { kind: 'ready' });
  const worker = new NoShowExpiryWorker({ candidates: r.queue, events: r.store, expire: r.expire, now: () => r.clock.now });
  r.clock.now = T0 + 86_400_000;
  const pass = await worker.runPass();
  assert.deepEqual([pass.expired, pass.dismissed], [0, 2]);
  assert.deepEqual(r.queue.dismissed.sort(), ['both', 'moved']);
  assert.deepEqual(await endings(r.store, 'moved'), []);
  assert.deepEqual(await endings(r.store, 'both'), []);
  assert.equal((await worker.runPass()).scanned, 0, 'nothing is re-read on later passes');
});

test('a failure before the append is retried by a later pass; one after it is not repeated', async () => {
  const r = rig();
  await r.create('flaky', 'seek');
  let crashes = 1;
  const expire = async (gameId: string): Promise<void> => {
    if (crashes > 0) {
      crashes -= 1;
      throw new Error('worker crashed before the append');
    }
    await r.expire(gameId);
  };
  const failures: string[] = [];
  const worker = new NoShowExpiryWorker({
    candidates: r.queue, events: r.store, expire, now: () => r.clock.now,
    logger: { error: (msg: string) => failures.push(msg), info: () => {}, warn: () => {}, debug: () => {} } as never,
  });
  r.clock.now = T0 + 60_000;
  const first = await worker.runPass();
  assert.deepEqual([first.expired, first.failed], [0, 1]);
  assert.equal(failures.length, 1);
  assert.equal((await worker.runPass()).expired, 1, 'the retry succeeds');

  // A crash after the append: the entry is still queued (the trigger's delete was lost with the
  // process in this fake), and a restarted worker finds the game ended and dismisses it.
  r.queue.entries.push({ gameId: 'flaky', dueAt: new Date(T0 + 60_000) });
  const restarted = new NoShowExpiryWorker({ candidates: r.queue, events: r.store, expire: r.expire, now: () => r.clock.now });
  const pass = await restarted.runPass();
  assert.deepEqual([pass.expired, pass.dismissed], [0, 1]);
  assert.equal((await endings(r.store, 'flaky')).length, 1);
});

test('the cursor rotates past a game that keeps failing, so it cannot starve the games behind it', async () => {
  const r = rig();
  for (let i = 0; i < 5; i += 1) await r.create(`g-${i}`, 'seek', T0 + i);
  const expire = async (gameId: string): Promise<void> => {
    if (gameId === 'g-0') throw new Error('corrupt');
    await r.expire(gameId);
  };
  const worker = new NoShowExpiryWorker({ candidates: r.queue, events: r.store, expire, now: () => r.clock.now, pageSize: 2 });
  r.clock.now = T0 + 120_000;
  for (let i = 0; i < 4; i += 1) await worker.runPass();
  assert.deepEqual(r.expired.sort(), ['g-1', 'g-2', 'g-3', 'g-4']);
});

test('the running worker backs off on a failing scan, pauses on a stuck page, and stop() awaits the pass', async () => {
  const r = rig();
  await r.create('late', 'seek');
  r.queue.failNext = 1;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inExpire = new Promise<void>((resolve) => { entered = resolve; });
  let finished = false;
  const expire = async (gameId: string): Promise<void> => {
    entered();
    await gate;
    await r.expire(gameId);
    finished = true;
  };
  r.clock.now = T0 + 60_000;
  const worker = new NoShowExpiryWorker({ candidates: r.queue, events: r.store, expire, now: () => r.clock.now, pollMs: 5 });
  worker.start();
  await inExpire; // the first scan failed, the backed-off retry found the game
  assert.ok(r.queue.queries.length >= 2);
  const stopping = worker.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false, 'stop waits for the routed command in flight');
  release();
  await stopping;
  assert.equal(finished, true);
  const queries = r.queue.queries.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(r.queue.queries.length, queries, 'no pass starts after stop');

  // A full page on which every game fails is not progress, so the worker waits a poll between passes.
  const stuck = rig();
  for (let i = 0; i < 3; i += 1) await stuck.create(`s-${i}`, 'seek');
  stuck.clock.now = T0 + 60_000;
  const spinning = new NoShowExpiryWorker({
    candidates: stuck.queue, events: stuck.store, expire: async () => { throw new Error('owner down'); },
    now: () => stuck.clock.now, pageSize: 3, pollMs: 50,
  });
  spinning.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  await spinning.stop();
  assert.ok(stuck.queue.queries.length <= 4, `paced passes, not a tight loop (${stuck.queue.queries.length})`);
});

test('after an unwatched expiry the claim and the loaded copy are let go; a held lease or a local room keeps them', async () => {
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(new InMemoryPubSub(), () => T0 + 60_000, store);
  const seed = new GameAuthority(new InMemoryPubSub(), () => T0, store);
  for (const id of ['g', 'h', 'i']) {
    await seed.createGame({ gameId: id, timeControl: TC, players: { white: 'w', black: 'b' }, at: T0, source: 'seek', noShowAfterMs: 60_000 });
  }
  const leases = new Set<string>();
  const released: string[] = [];
  const ownership = {
    holdsValidLease: (id: string) => leases.has(id),
    release: async (id: string) => { leases.delete(id); released.push(id); },
  };
  const routed: Array<[string, string, Command]> = [];
  const router: CommandRouter = {
    route: async (gameId, userId, cmd) => {
      leases.add(gameId); // routing claims the unowned game
      routed.push([gameId, userId, cmd]);
      return authority.apply(gameId, userId, cmd);
    },
  };
  let localRoom = false;
  const expire = routedNoShowExpiry({ authority, router, ownership, hasLocalSessions: () => localRoom });
  await expire('g');
  assert.deepEqual(routed, [['g', NO_SHOW_ACTOR, { kind: 'expireNoShow' }]]);
  assert.deepEqual(released, ['g'], 'claimed only for expiry, nobody here: released');
  assert.equal(authority.has('g'), false, 'and the copy loaded for it is evicted');

  leases.add('h');
  await authority.ensureLoaded('h');
  await expire('h');
  assert.deepEqual(released, ['g'], 'a lease held before expiry is kept');
  assert.equal(authority.has('h'), true, 'a copy that was already resident is kept');

  localRoom = true;
  await expire('i');
  assert.deepEqual(released, ['g'], 'a game with a local room is kept');
  assert.equal(authority.has('i'), true);
  await expire('missing');
  assert.equal(routed.length, 3, 'an unknown game is not routed');
  assert.ok(Game.fromEvents((await store.load('g')).map((e) => e.event)).status.over);
});
