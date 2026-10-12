/** R-01 D4/D3: real Redis/PostgreSQL, two gateway instances in one process, controlled I/O. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { Redis } from 'ioredis';
import { GameAuthority, InMemoryConnection, RealtimeGateway, gameChannel, type EventLog, type Broadcast } from '@chess-platform/realtime-gateway';
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
function node(store: EventLog, leaseTtlSec = 30, ownershipCheckTimeoutMs = 1000) {
  const nodeId = `d4-${randomUUID()}`;
  const redis = new Redis(REDIS_URL!);
  const fan = createRedisPubSub({ url: REDIS_URL!, nodeId });
  const authority = new GameAuthority(fan.pubsub, () => 1000, store);
  const registry = new OwnershipRegistry({ redis, nodeId, leaseTtlSec, renewalIntervalSec: leaseTtlSec === 30 ? 15 : 1 });
  const consumer = new OwnerCommandConsumer(authority, redis);
  const router = new RedisCommandRouter({ authority, registry, redis, nodeId, consumer, ownershipCheckTimeoutMs });
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
  return { authority, router, registry, redis, pubsub: fan.pubsub, join, close };
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

function pauseNextAppend(store: EventLog) {
  const entered = barrier(), release = barrier(); let pause = false;
  const log: EventLog = { exists: id => store.exists(id), load: id => store.load(id),
    append: async (...args) => {
      if (pause) { pause = false; entered.resolve(); await release.done; }
      return store.append(...args);
    } };
  return { log, entered, release, arm: () => { pause = true; } };
}

function commandQueued(authority: GameAuthority) {
  const queued = barrier(), apply = authority.apply.bind(authority);
  authority.apply = (...args) => { const done = apply(...args); queued.resolve(); return done; };
  return queued;
}

for (const takeover of ['expiry', 'same-node-reclaim'] as const) {
  stackTest(`D3 real stack: ${takeover} refuses obsolete queued local move; admitted first append finishes`, { timeout: 90000 }, async () => {
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, migrationsDir());
      const store = new PostgresEventStore(pool), gameId = randomUUID(), paused = pauseNextAppend(store);
      const a = node(paused.log, takeover === 'expiry' ? 3 : 30), b = node(store);
      const frames: Broadcast[] = [];
      const unsubscribe = a.pubsub.subscribe(gameChannel(gameId), msg => { frames.push(msg); });
      let first: ReturnType<GameAuthority['apply']> | undefined;
      let refused: Promise<void> | undefined;
      try {
        await create(a.authority, gameId); assert.equal(await a.router.prepareOwnership(gameId), true);
        paused.arm();
        first = a.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' });
        await paused.entered.done;
        assert.equal(a.registry.holdsValidLease(gameId), true);
        const queued = commandQueued(a.authority);
        refused = assert.rejects(a.router.route(gameId, 'bob', { kind: 'move', uci: 'e7e5' }), /ownership.*changed/);
        await queued.done; // The second legal intent is actually in the production slot queue.
        if (takeover === 'expiry') {
          const end = Date.now() + 5000;
          while (await b.redis.get(`game:owner:${gameId}`)) {
            assert.ok(Date.now() < end, 'real Redis lease must expire');
            await new Promise(r => setTimeout(r, 10));
          }
          assert.equal(await b.router.prepareOwnership(gameId), true);
          assert.equal(b.authority.getState(gameId).ply, 0, 'successor read precedes the admitted append');
        } else {
          await a.registry.release(gameId); assert.equal((await a.registry.claim(gameId)).owned, true);
        }
        paused.release.resolve(); assert.equal((await first).state.ply, 1); await refused;
        assert.deepEqual((await store.load(gameId)).map(e => e.seq), [0, 1]);
        assert.equal(a.authority.getState(gameId).ply, 1, 'no obsolete domain advancement');
        await until(() => frames.some(m => m.t === 'move'));
        assert.equal(frames.filter(m => m.t === 'move').length, 1);
        assert.equal(frames.filter(m => m.t === 'commandConfirmed').length, 0);
        if (takeover === 'same-node-reclaim') {
          assert.equal((await a.router.route(gameId, 'bob', { kind: 'move', uci: 'e7e5' })).state.ply, 2,
            'a genuinely new gesture can settle reclaim debt');
        }
      } finally {
        paused.release.resolve(); await Promise.allSettled([first, refused]); unsubscribe();
        await a.close(); await b.close(); await store.closePlayerLocks();
      }
    });
  });
}

stackTest('D3 real stack: reclaim during hydration cannot rebind the waiting local intent', { timeout: 90000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const store = new PostgresEventStore(pool), gameId = randomUUID(), delay = delayedRead(store);
    const seed = node(store), a = node(delay.log);
    try {
      await create(seed.authority, gameId);
      const obsolete = assert.rejects(a.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' }), /ownership.*changed/);
      await delay.entered.done;
      await a.registry.release(gameId); assert.equal((await a.registry.claim(gameId)).owned, true);
      delay.release.resolve(); await obsolete;
      assert.deepEqual((await store.load(gameId)).map(e => e.seq), [0]);
      assert.equal((await a.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' })).state.ply, 1);
    } finally { delay.release.resolve(); await a.close(); await seed.close(); await store.closePlayerLocks(); }
  });
});

stackTest('D3 real stack: local lease expires while the real Redis comparison reply is held', { timeout: 90000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const store = new PostgresEventStore(pool), gameId = randomUUID(), a = node(store, 3, 4000);
    const entered = barrier(), release = barrier();
    try {
      await create(a.authority, gameId); assert.equal(await a.router.prepareOwnership(gameId), true);
      const duplicate = a.redis.duplicate.bind(a.redis);
      a.redis.duplicate = (...args) => {
        const conn = duplicate(...args);
        if (args[0]?.enableOfflineQueue === false) {
          const get = conn.get.bind(conn);
          conn.get = async key => { const owner = await get(key); entered.resolve(); await release.done; return owner; };
        }
        return conn;
      };
      const refused = assert.rejects(a.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' }), /ownership.*verified/);
      await entered.done;
      await until(() => !a.registry.holdsValidLease(gameId));
      release.resolve(); await refused;
      assert.deepEqual((await store.load(gameId)).map(e => e.seq), [0]);
      assert.equal(a.authority.getState(gameId).ply, 0);
    } finally { release.resolve(); await a.close(); await store.closePlayerLocks(); }
  });
});

stackTest('D3 real stack: a blackholed owner-comparison socket fails closed within its budget', { timeout: 90000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const store = new PostgresEventStore(pool), gameId = randomUUID(), a = node(store, 30, 500);
    const accepted = barrier(), sockets = new Set<Socket>();
    const blackhole = createServer(socket => { sockets.add(socket); accepted.resolve(); });
    await new Promise<void>(resolve => { blackhole.listen(0, '127.0.0.1', resolve); });
    const address = blackhole.address(); assert.ok(address && typeof address === 'object');
    try {
      await create(a.authority, gameId); assert.equal(await a.router.prepareOwnership(gameId), true);
      const duplicate = a.redis.duplicate.bind(a.redis);
      a.redis.duplicate = (...args) => args[0]?.enableOfflineQueue === false
        ? new Redis({ ...args[0], host: '127.0.0.1', port: address.port }) : duplicate(...args);
      const refused = assert.rejects(a.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' }), /ownership.*verified/);
      await accepted.done; await refused;
      assert.deepEqual((await store.load(gameId)).map(e => e.seq), [0]);
      assert.equal(a.authority.getState(gameId).ply, 0);
      a.redis.duplicate = duplicate;
      assert.equal((await a.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' })).state.ply, 1,
        'timed-out validation released the actual stable slot');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => blackhole.close(err => err ? reject(err) : resolve()));
      await a.close(); await store.closePlayerLocks();
    }
  });
});

stackTest('D3 real stack: first forwarded intent settles takeover debt before START_REQUEST execution', { timeout: 90000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const store = new PostgresEventStore(pool), gameId = randomUUID(), a = node(store), b = node(store);
    const frames: Broadcast[] = [], unsubscribe = b.pubsub.subscribe(gameChannel(gameId), msg => { frames.push(msg); });
    try {
      await create(a.authority, gameId); await b.authority.ensureLoaded(gameId);
      await a.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' });
      assert.equal(b.authority.getState(gameId).ply, 0);
      await a.registry.release(gameId); assert.equal((await b.registry.claim(gameId)).owned, true);
      const black = await a.router.route(gameId, 'bob', { kind: 'move', uci: 'e7e5' });
      assert.equal(black.state.ply, 2); assert.equal(b.authority.getState(gameId).ply, 2);
      assert.deepEqual((await store.load(gameId)).map(e => e.seq), [0, 1, 2]);
      await until(() => frames.some(m => m.t === 'commandConfirmed'));
      assert.equal(frames.filter(m => m.t === 'commandConfirmed').length, 1);
    } finally { unsubscribe(); await a.close(); await b.close(); await store.closePlayerLocks(); }
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
