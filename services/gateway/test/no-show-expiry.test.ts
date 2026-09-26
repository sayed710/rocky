/**
 * The no-show worker's own logic, hermetically (ADR-0148): what it decides from the durable log,
 * how it recovers from failures, and how it lets go of what it claimed. Real routing, Redis and
 * PostgreSQL are covered by no-show-expiry.integration.test.ts.
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

/** The projection's view: every listed game is a candidate once its source's deadline has passed. */
class FakeCandidates implements NoShowCandidateSource {
  readonly games: NoShowCandidate[] = [];
  readonly queries: NoShowCandidateQuery[] = [];
  failNext = 0;
  async due(query: NoShowCandidateQuery): Promise<NoShowCandidate[]> {
    this.queries.push(query);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('database unreachable');
    }
    const after = query.after;
    return this.games
      .filter((g) => g.startedAt <= (g.source === 'seek' ? query.seekDueBy : query.tournamentDueBy))
      .filter((g) => after === null || g.startedAt > after.startedAt || (g.startedAt.getTime() === after.startedAt.getTime() && g.gameId > after.gameId))
      .sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime() || x.gameId.localeCompare(y.gameId))
      .slice(0, query.limit);
  }
}

function rig() {
  const clock = { now: T0 };
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, store);
  const candidates = new FakeCandidates();
  const expired: string[] = [];
  const router = new LocalCommandRouter(authority);
  const expire = async (gameId: string, afterMs: number): Promise<void> => {
    await authority.ensureLoaded(gameId);
    await router.route(gameId, NO_SHOW_ACTOR, { kind: 'expireNoShow', afterMs });
    expired.push(gameId);
  };
  const create = async (gameId: string, source: GameSource | null, at = T0): Promise<void> => {
    await authority.createGame({
      gameId, timeControl: TC, players: { white: 'w', black: 'b' }, at, ...(source ? { source } : {}),
    });
    if (source) candidates.games.push({ gameId, source, startedAt: new Date(at) });
  };
  return { clock, store, authority, candidates, expired, expire, create };
}

async function ending(store: InMemoryEventLog, gameId: string) {
  return (await store.load(gameId)).map((e) => e.event).filter((e) => e.type === 'GameEnded');
}

test('expires a due seek game once, and only once its deadline has passed', async () => {
  const r = rig();
  await r.create('seek-1', 'seek');
  const worker = new NoShowExpiryWorker({ candidates: r.candidates, events: r.store, expire: r.expire, now: () => r.clock.now });
  r.clock.now = T0 + 59_999;
  assert.equal((await worker.runPass()).expired, 0);
  r.clock.now = T0 + 60_000;
  assert.equal((await worker.runPass()).expired, 1);
  assert.equal((await worker.runPass()).expired, 0, 'a later pass finds the game ended');
  assert.deepEqual(await ending(r.store, 'seek-1'), [
    { type: 'GameEnded', result: '*', termination: 'no_show', winner: null, at: T0 + 60_000 },
  ]);
});

test('uses each source\'s configured deadline, and decides from the log rather than the projection', async () => {
  const r = rig();
  await r.create('t-1', 'tournament');
  await r.create('s-1', 'seek');
  // The projection is stale: it still lists a game that has already had its first move.
  await r.create('moved', 'seek');
  await r.authority.apply('moved', 'w', { kind: 'ready' });
  await r.authority.apply('moved', 'b', { kind: 'ready' });
  r.clock.now = T0 + 1;
  await r.authority.apply('moved', 'w', { kind: 'move', uci: 'e2e4' });
  const worker = new NoShowExpiryWorker({
    candidates: r.candidates, events: r.store, expire: r.expire, now: () => r.clock.now,
    deadlines: { seek: 10_000, tournament: 20_000 },
  });
  r.clock.now = T0 + 10_000;
  await worker.runPass();
  assert.deepEqual(r.expired, ['s-1']);
  r.clock.now = T0 + 20_000;
  await worker.runPass();
  assert.deepEqual(r.expired, ['s-1', 't-1']);
  assert.deepEqual(await ending(r.store, 'moved'), [], 'a game with a first move is never expired');
});

test('a tournament game with both players ready is remembered and never expired or re-read', async () => {
  const r = rig();
  await r.create('both', 'tournament');
  await r.authority.apply('both', 'w', { kind: 'ready' });
  await r.authority.apply('both', 'b', { kind: 'ready' });
  let loads = 0;
  const events = { load: async (id: string) => { loads += 1; return r.store.load(id); } };
  const worker = new NoShowExpiryWorker({ candidates: r.candidates, events, expire: r.expire, now: () => r.clock.now });
  r.clock.now = T0 + 86_400_000;
  await worker.runPass();
  await worker.runPass();
  assert.equal(loads, 1, 'read once, then remembered');
  assert.deepEqual(r.expired, []);
  assert.deepEqual(await ending(r.store, 'both'), []);
});

test('a failure before the append is retried by a later pass; one after it is not repeated', async () => {
  const r = rig();
  await r.create('flaky', 'seek');
  let crashes = 1;
  const expire = async (gameId: string, afterMs: number): Promise<void> => {
    if (crashes > 0) {
      crashes -= 1;
      throw new Error('worker crashed before the append');
    }
    await r.expire(gameId, afterMs);
  };
  const failures: string[] = [];
  const worker = new NoShowExpiryWorker({
    candidates: r.candidates, events: r.store, expire, now: () => r.clock.now,
    logger: { error: (msg: string) => failures.push(msg), info: () => {}, warn: () => {}, debug: () => {} } as never,
  });
  r.clock.now = T0 + 60_000;
  const first = await worker.runPass();
  assert.deepEqual([first.expired, first.failed], [0, 1]);
  assert.equal(failures.length, 1);
  assert.equal((await worker.runPass()).expired, 1, 'the retry succeeds');

  // A fresh worker (a restart after the append) finds nothing left to do.
  const restarted = new NoShowExpiryWorker({ candidates: r.candidates, events: r.store, expire: r.expire, now: () => r.clock.now });
  assert.equal((await restarted.runPass()).expired, 0);
  assert.equal((await ending(r.store, 'flaky')).length, 1);
});

test('the cursor rotates past a game that keeps failing, so it cannot starve the games behind it', async () => {
  const r = rig();
  for (let i = 0; i < 5; i += 1) await r.create(`g-${i}`, 'seek', T0 + i);
  const expire = async (gameId: string, afterMs: number): Promise<void> => {
    if (gameId === 'g-0') throw new Error('corrupt');
    await r.expire(gameId, afterMs);
  };
  const worker = new NoShowExpiryWorker({ candidates: r.candidates, events: r.store, expire, now: () => r.clock.now, pageSize: 2 });
  r.clock.now = T0 + 120_000;
  for (let i = 0; i < 4; i += 1) await worker.runPass();
  assert.deepEqual(r.expired.sort(), ['g-1', 'g-2', 'g-3', 'g-4']);
});

test('the running worker backs off on a failing scan, passes at once when behind, and stop() awaits the pass', async () => {
  const r = rig();
  await r.create('late', 'seek');
  r.candidates.failNext = 1;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inExpire = new Promise<void>((resolve) => { entered = resolve; });
  let finished = false;
  const expire = async (gameId: string, afterMs: number): Promise<void> => {
    entered();
    await gate;
    await r.expire(gameId, afterMs);
    finished = true;
  };
  r.clock.now = T0 + 60_000;
  const worker = new NoShowExpiryWorker({ candidates: r.candidates, events: r.store, expire, now: () => r.clock.now, pollMs: 5 });
  worker.start();
  await inExpire; // the first scan failed, the backed-off retry found the game
  assert.ok(r.candidates.queries.length >= 2);
  const stopping = worker.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false, 'stop waits for the routed command in flight');
  release();
  await stopping;
  assert.equal(finished, true);
  const queries = r.candidates.queries.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(r.candidates.queries.length, queries, 'no pass starts after stop');
});

test('a claim made only to expire a game is released; one that was already held, or has a local room, is kept', async () => {
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(new InMemoryPubSub(), () => T0 + 60_000, store);
  await authority.createGame({ gameId: 'g', timeControl: TC, players: { white: 'w', black: 'b' }, at: T0, source: 'seek' });
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
  await expire('g', 60_000);
  assert.deepEqual(routed, [['g', NO_SHOW_ACTOR, { kind: 'expireNoShow', afterMs: 60_000 }]]);
  assert.deepEqual(released, ['g'], 'claimed for expiry, nobody here: released');

  await authority.createGame({ gameId: 'h', timeControl: TC, players: { white: 'w', black: 'b' }, at: T0, source: 'seek' });
  leases.add('h');
  await expire('h', 60_000);
  assert.deepEqual(released, ['g'], 'a lease held before expiry is kept');

  await authority.createGame({ gameId: 'i', timeControl: TC, players: { white: 'w', black: 'b' }, at: T0, source: 'seek' });
  localRoom = true;
  await expire('i', 60_000);
  assert.deepEqual(released, ['g'], 'a game with a local room is kept');
  await expire('missing', 60_000);
  assert.equal(routed.length, 3, 'an unknown game is not routed');
  assert.ok(Game.fromEvents((await store.load('g')).map((e) => e.event)).status.over);
});
