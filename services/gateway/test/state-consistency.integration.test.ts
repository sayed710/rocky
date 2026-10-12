/** D4 only: real Redis/PostgreSQL, two gateway instances in one process, controlled log I/O. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { GameAuthority, InMemoryConnection, RealtimeGateway, type EventLog } from '@chess-platform/realtime-gateway';
import { PostgresEventStore, migrate, migrationsDir } from '@chess-platform/persistence/pg';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { OwnershipRegistry } from '../src/ownership.js';
import { OwnerCommandConsumer, RedisCommandRouter } from '../src/command-forwarder.js';
import { createRedisPubSub } from '../src/redis-pubsub.js';

const REDIS_URL = process.env['REDIS_URL'];
const stackTest = REDIS_URL && process.env['DATABASE_URL'] ? test : test.skip;
function barrier() {
  let resolve!: () => void;
  const done = new Promise<void>(r => { resolve = r; });
  return { done, resolve };
}
async function until(fn: () => boolean) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() >= end) throw Error('expected gateway transition did not complete');
    await new Promise(r => setTimeout(r, 5));
  }
}
function node(store: EventLog) {
  const nodeId = `d4-${randomUUID()}`;
  const redis = new Redis(REDIS_URL!);
  const fan = createRedisPubSub({ url: REDIS_URL!, nodeId });
  const authority = new GameAuthority(fan.pubsub, () => 1000, store);
  const registry = new OwnershipRegistry({ redis, nodeId, leaseTtlSec: 30, renewalIntervalSec: 15 });
  const consumer = new OwnerCommandConsumer(authority, redis);
  const router = new RedisCommandRouter({ authority, registry, redis, nodeId, consumer });
  const gateway = new RealtimeGateway(authority, fan.pubsub, { verify: token => ({ userId: token }) }, () => 1000, router);
  const connections: InMemoryConnection[] = [];
  const join = (gameId: string, userId: string) => {
    const c = new InMemoryConnection(); connections.push(c); gateway.handleConnection(c);
    c.deliver({ t: 'join', gameId, token: userId }); return c;
  };
  const close = async () => {
    for (const c of connections) c.close();
    consumer.stop(); registry.stopRenewal(); await registry.releaseAll();
    await fan.close(); await redis.quit();
  };
  return { authority, router, registry, join, close };
}
function delayedRead(store: EventLog) {
  const entered = barrier(), release = barrier();
  let reads = 0;
  const log: EventLog = { exists: id => store.exists(id), append: (...args) => store.append(...args),
    load: async id => {
      const read = ++reads;
      const snapshot = await store.load(id);
      if (read === 1) { entered.resolve(); await release.done; }
      return snapshot;
    } };
  return { log, entered, release, reads: () => reads };
}
async function create(a: GameAuthority, gameId: string) {
  await a.createGame({ gameId, players: { white: 'alice', black: 'bob' }, rated: false,
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' } });
}

stackTest('D4 real stack: simultaneous cold joins coalesce; normal owner and forwarded moves commit once', { timeout: 90000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const store = new PostgresEventStore(pool), gameId = randomUUID();
    const a = node(store), delay = delayedRead(store), b = node(delay.log);
    try {
      await create(a.authority, gameId);
      const first = b.join(gameId, 'alice'); await delay.entered.done;
      const second = b.join(gameId, 'alice');
      // Let the second join enter ensureLoaded while the first actual PG snapshot is held.
      await new Promise<void>(r => setImmediate(r));
      assert.equal(delay.reads(), 1);
      assert.equal(second.last('joined'), undefined, 'second join must wait for the single flight');
      delay.release.resolve();
      await until(() => !!first.last('joined') && !!second.last('joined'));
      assert.equal(delay.reads(), 1, 'both completed joins used the same cold read');
      assert.equal((await b.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' })).state.ply, 1);
      // Another gateway forwards the exact black response via the production Redis consumer.
      assert.equal((await a.router.route(gameId, 'bob', { kind: 'move', uci: 'e7e5' })).state.ply, 2);
      assert.equal(b.authority.getState(gameId).ply, 2);
      assert.deepEqual((await store.load(gameId)).filter(e => e.event.type === 'MovePlayed').map(e => e.seq), [1, 2]);
      assert.equal(first.last('joined')?.state.ply, 0);
      assert.equal(second.last('joined')?.state.ply, 0);
    } finally { delay.release.resolve(); await b.close(); await a.close(); await store.closePlayerLocks(); }
  });
});

stackTest('D4 real stack: late ply-0 cold read cannot satisfy takeover after durable ply 1', { timeout: 90000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const store = new PostgresEventStore(pool), gameId = randomUUID();
    const a = node(store), delay = delayedRead(store), b = node(delay.log);
    try {
      await create(a.authority, gameId);
      const ordinary = b.authority.ensureLoaded(gameId); await delay.entered.done;
      assert.equal((await a.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' })).state.ply, 1);
      await a.registry.release(gameId);
      const forcedQueued = barrier();
      const reload = b.authority.reloadFromLog.bind(b.authority);
      b.authority.reloadFromLog = id => {
        const done = reload(id); // The production method synchronously queues its own read.
        forcedQueued.resolve();
        return done;
      };
      const takeover = b.router.prepareOwnership(gameId);
      await forcedQueued.done;
      assert.equal(delay.reads(), 1, 'forced read is queued while the cold snapshot is still held');
      assert.equal(b.authority.hasFresh(gameId), false);
      delay.release.resolve();
      assert.equal(await ordinary, true);
      assert.equal(await takeover, true);
      assert.equal(b.authority.getState(gameId).ply, 1);
      assert.equal(delay.reads(), 2, 'forced read follows older ordinary snapshot');
      assert.equal((await b.router.route(gameId, 'bob', { kind: 'move', uci: 'e7e5' })).state.ply, 2);
      assert.deepEqual((await store.load(gameId)).map(e => e.seq), [0, 1, 2]);
    } finally { delay.release.resolve(); await b.close(); await a.close(); await store.closePlayerLocks(); }
  });
});

stackTest('D4 real stack: a reclaimed ownership generation cannot reuse an earlier reload', { timeout: 90000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const store = new PostgresEventStore(pool), gameId = randomUUID();
    const a = node(store), delay = delayedRead(store), b = node(delay.log);
    try {
      await create(a.authority, gameId);
      const reclaimedReloadQueued = barrier();
      const reload = b.authority.reloadFromLog.bind(b.authority);
      let reloads = 0;
      b.authority.reloadFromLog = id => {
        const done = reload(id);
        if (++reloads === 2) reclaimedReloadQueued.resolve();
        return done;
      };
      const oldClaim = b.router.prepareOwnership(gameId); await delay.entered.done;
      await b.registry.release(gameId);
      await a.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' });
      await a.registry.release(gameId);
      const currentClaim = b.router.prepareOwnership(gameId);
      // Confirm the new claim has requested its own forced read while the old one is held.
      await reclaimedReloadQueued.done;
      assert.equal(b.registry.holdsValidLease(gameId), true);
      delay.release.resolve();
      assert.equal(await oldClaim, true);
      assert.equal(await currentClaim, true);
      assert.equal(delay.reads(), 2);
      assert.equal(b.authority.getState(gameId).ply, 1);
      assert.equal((await b.router.route(gameId, 'bob', { kind: 'move', uci: 'e7e5' })).state.ply, 2);
      assert.deepEqual((await store.load(gameId)).map(e => e.seq), [0, 1, 2]);
    } finally { delay.release.resolve(); await b.close(); await a.close(); await store.closePlayerLocks(); }
  });
});
