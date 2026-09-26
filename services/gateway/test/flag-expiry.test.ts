/**
 * The flag worker's own logic, hermetically (ADR-0149): what it decides from the durable log, how it
 * corrects the queue from the domain, how it recovers, and how it stops. Real routing, Redis and
 * PostgreSQL are covered by flag-expiry.integration.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, type GameEvent, type TimeControl } from '@chess-platform/game';
import {
  FLAG_ACTOR,
  GameAuthority,
  InMemoryEventLog,
  InMemoryPubSub,
  LocalCommandRouter,
  type Command,
  type CommandRouter,
} from '@chess-platform/realtime-gateway';
import type { DeadlineCandidate, DeadlineCandidateQuery } from '@chess-platform/persistence/pg';
import { FlagExpiryWorker, routedFlagExpiry, type FlagCandidateSource } from '../src/flag-expiry.js';

const TC: TimeControl = { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
const T0 = 1_000_000;
const DEADLINE = T0 + 60_000; // Black's clock, started by White's move at T0

interface Row { gameId: string; seq: number; dueMs: number }

/** The queue as the trigger keeps it: `sync` does what the insert trigger does after each append. */
class FakeQueue implements FlagCandidateSource {
  rows: Row[] = [];
  readonly queries: DeadlineCandidateQuery[] = [];
  readonly rescheduled: Array<[string, number]> = [];
  readonly dismissed: string[] = [];
  failNext = 0;
  constructor(private readonly store: InMemoryEventLog) {}
  async sync(gameId: string): Promise<void> {
    const logged = await this.store.load(gameId);
    this.rows = this.rows.filter((r) => r.gameId !== gameId);
    const lastMove = logged.filter((e) => e.event.type === 'MovePlayed').at(-1);
    const deadline = Game.fromEvents(logged.map((e) => e.event)).flagDeadline;
    if (lastMove && deadline !== null) this.rows.push({ gameId, seq: lastMove.seq, dueMs: deadline });
  }
  async due(query: DeadlineCandidateQuery): Promise<DeadlineCandidate[]> {
    this.queries.push(query);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('database unreachable');
    }
    const after = query.after;
    return this.rows
      .filter((r) => r.dueMs <= query.dueBy.getTime())
      .filter((r) => after === null || r.dueMs > after.dueAt.getTime() || (r.dueMs === after.dueAt.getTime() && r.gameId > after.gameId))
      .sort((x, y) => x.dueMs - y.dueMs || x.gameId.localeCompare(y.gameId))
      .slice(0, query.limit)
      .map((r) => ({ gameId: r.gameId, dueAt: new Date(r.dueMs) }));
  }
  async reschedule(gameId: string, headSeq: number, dueMs: number): Promise<void> {
    this.rescheduled.push([gameId, dueMs]);
    for (const r of this.rows) if (r.gameId === gameId && r.seq <= headSeq) r.dueMs = dueMs;
  }
  async dismiss(gameId: string, headSeq: number): Promise<void> {
    this.dismissed.push(gameId);
    this.rows = this.rows.filter((r) => !(r.gameId === gameId && r.seq <= headSeq));
  }
}

function rig() {
  const clock = { now: T0 };
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, store);
  const queue = new FakeQueue(store);
  const router = new LocalCommandRouter(authority);
  let routed = 0;
  const expire = async (gameId: string): Promise<void> => {
    routed += 1;
    await authority.ensureLoaded(gameId);
    await router.route(gameId, FLAG_ACTOR, { kind: 'expireFlag' });
    await queue.sync(gameId);
  };
  const apply = async (gameId: string, user: string, cmd: Command): Promise<void> => {
    await authority.apply(gameId, user, cmd);
    await queue.sync(gameId);
  };
  /** A game in which White has moved at T0, so Black's clock is running. */
  const started = async (gameId: string, tc: TimeControl = TC): Promise<void> => {
    await authority.createGame({ gameId, timeControl: tc, players: { white: 'w', black: 'b' }, at: T0 - 5 });
    await apply(gameId, 'w', { kind: 'move', uci: 'e2e4' });
  };
  const worker = (extra: Partial<ConstructorParameters<typeof FlagExpiryWorker>[0]> = {}) =>
    new FlagExpiryWorker({ candidates: queue, events: store, expire, now: () => clock.now, ...extra });
  return { clock, store, authority, queue, expire, apply, started, worker, routed: () => routed };
}

async function endings(store: InMemoryEventLog, gameId: string): Promise<GameEvent[]> {
  return (await store.load(gameId)).map((e) => e.event).filter((e) => e.type === 'GameEnded');
}

test('a game nobody is watching ends on time, once, when the side to move\'s clock runs out', async () => {
  const r = rig();
  await r.started('g');
  const worker = r.worker();
  r.clock.now = DEADLINE - 1;
  assert.deepEqual(await worker.runPass(), { scanned: 0, expired: 0, dismissed: 0, failed: 0, more: false });
  r.clock.now = DEADLINE;
  assert.equal((await worker.runPass()).expired, 1);
  assert.equal((await worker.runPass()).scanned, 0, 'the ending left the queue');
  assert.deepEqual(await endings(r.store, 'g'), [{ type: 'GameEnded', result: '1-0', termination: 'timeout', winner: 'w', at: DEADLINE }]);
});

test('a move before the deadline replaces it: the old deadline passes without an ending', async () => {
  const r = rig();
  await r.started('g');
  r.clock.now = DEADLINE - 1;
  await r.apply('g', 'b', { kind: 'move', uci: 'e7e5' });
  const worker = r.worker();
  r.clock.now = DEADLINE;
  assert.equal((await worker.runPass()).scanned, 0, 'nothing is due at the old deadline');
  const white = Game.fromEvents((await r.store.load('g')).map((e) => e.event)).flagDeadline!;
  assert.equal(white, DEADLINE - 1 + 59_995, "White's clock, less the 5 ms its creation-anchored first move took");
  r.clock.now = white;
  assert.equal((await worker.runPass()).expired, 1);
  assert.deepEqual(await endings(r.store, 'g'), [{ type: 'GameEnded', result: '0-1', termination: 'timeout', winner: 'b', at: white }]);
});

test('a restarted worker ends every game that flagged while nothing ran, on its first pass', async () => {
  const r = rig();
  for (const id of ['a', 'b', 'c']) await r.started(id);
  r.clock.now = DEADLINE + 86_400_000;
  const restarted = r.worker();
  assert.equal((await restarted.runPass()).expired, 3);
  for (const id of ['a', 'b', 'c']) assert.equal((await endings(r.store, id)).length, 1);
});

test('the log, not the queue, decides: an early row is corrected, a row with no clock is dismissed', async () => {
  const r = rig();
  await r.started('early');
  r.queue.rows[0]!.dueMs = T0 + 10; // the queue claims it is due far too soon
  await r.started('ended');
  await r.authority.apply('ended', 'b', { kind: 'resign' }); // a stale row the ending's delete missed
  r.queue.rows.find((row) => row.gameId === 'ended')!.dueMs = T0 + 10;
  r.clock.now = T0 + 20;
  const pass = await r.worker().runPass();
  assert.deepEqual([pass.expired, pass.dismissed, pass.failed], [0, 1, 0]);
  assert.deepEqual(r.queue.rescheduled, [['early', DEADLINE]]);
  assert.deepEqual(r.queue.dismissed, ['ended']);
  assert.equal(r.routed(), 0, 'nothing was routed to an owner');
  assert.deepEqual(await endings(r.store, 'early'), []);
});

test('two workers deciding the same game append exactly one ending', async () => {
  const r = rig();
  await r.started('g');
  r.clock.now = DEADLINE;
  const passes = await Promise.all([r.worker().runPass(), r.worker().runPass()]);
  assert.equal(passes.reduce((n, p) => n + p.expired, 0) >= 1, true);
  assert.equal((await endings(r.store, 'g')).length, 1);
});

test('a failing scan backs off instead of spinning, and stop() waits for an expiry in flight', async () => {
  const r = rig();
  await r.started('g');
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
  r.clock.now = DEADLINE;
  const worker = r.worker({ expire, pollMs: 5 });
  worker.start();
  await inExpire;
  assert.ok(r.queue.queries.length >= 2, 'the failed scan was retried');
  const stopping = worker.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false, 'stop waits for the routed expiry');
  release();
  await stopping;
  assert.equal(finished, true);
  assert.equal((await endings(r.store, 'g')).length, 1);
  const queries = r.queue.queries.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(r.queue.queries.length, queries, 'no pass starts after stop');

  // With the database down for good, passes are spaced by the growing backoff, not a tight loop.
  const down = rig();
  down.queue.failNext = Number.POSITIVE_INFINITY;
  const failing = down.worker({ pollMs: 10, maxBackoffMs: 40 });
  failing.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await failing.stop();
  assert.ok(down.queue.queries.length <= 7, `backed off (${down.queue.queries.length} scans in 150 ms)`);
});

test('an unwatched expiry lets go of a claim and a copy made only for it, and routes as the flag actor', async () => {
  const store = new InMemoryEventLog();
  const seed = new GameAuthority(new InMemoryPubSub(), () => T0, store);
  await seed.createGame({ gameId: 'g', timeControl: TC, players: { white: 'w', black: 'b' }, at: T0 });
  await seed.apply('g', 'w', { kind: 'move', uci: 'e2e4' });
  const authority = new GameAuthority(new InMemoryPubSub(), () => DEADLINE, store);
  const leases = new Set<string>();
  const released: string[] = [];
  const routed: Array<[string, Command]> = [];
  const router: CommandRouter = {
    route: async (gameId, userId, cmd) => {
      leases.add(gameId);
      routed.push([userId, cmd]);
      return authority.apply(gameId, userId, cmd);
    },
  };
  const ownership = { holdsValidLease: (id: string) => leases.has(id), release: async (id: string) => { leases.delete(id); released.push(id); } };
  await routedFlagExpiry({ authority, router, ownership, hasLocalSessions: () => false })('g');
  assert.deepEqual(routed, [[FLAG_ACTOR, { kind: 'expireFlag' }]]);
  assert.deepEqual(released, ['g']);
  assert.equal(authority.has('g'), false);
  assert.equal((await endings(store, 'g')).length, 1);
});
