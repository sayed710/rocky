/** F4 real Redis/PostgreSQL: controlled log errors, not a simulated database outage. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { GameAuthority, InMemoryPubSub, type EventLog } from '@chess-platform/realtime-gateway';
import { PostgresEventStore, migrate, migrationsDir } from '@chess-platform/persistence/pg';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { OwnershipRegistry } from '../src/ownership.js';
import { OwnerCommandConsumer, RedisCommandRouter } from '../src/command-forwarder.js';

const url = process.env['REDIS_URL'];
const stackTest = url && process.env['DATABASE_URL'] ? test : test.skip;
function barrier() {
  let resolve!: () => void;
  const done = new Promise<void>(r => { resolve = r; }); return { done, resolve };
}

function node(log: EventLog) {
  assert.ok(url);
  const redis = new Redis(url), nodeId = `f4-${randomUUID()}`;
  const authority = new GameAuthority(new InMemoryPubSub(), () => 1000, log);
  const registry = new OwnershipRegistry({ redis, nodeId });
  const consumer = new OwnerCommandConsumer(authority, redis);
  const router = new RedisCommandRouter({ authority, registry, redis, nodeId, consumer });
  const meta = router as unknown as {
    staleAfterClaim: Set<string>; claimGeneration: Map<string, number>;
    rehydrations: Map<string, { readonly generation: number; readonly done: Promise<void> }>;
  };
  const close = async () => { consumer.stop(); registry.stopRenewal(); await registry.releaseAll(); redis.disconnect(); };
  return { authority, registry, consumer, router, meta, close };
}
async function create(authority: GameAuthority, gameId: string) {
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, rated: false,
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' } });
}

stackTest('F4 real stack: twelve durable failed-load/released games retain no abandoned router debt', { timeout: 90000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const store = new PostgresEventStore(pool);
    let fail = true;
    const log: EventLog = { exists: id => store.exists(id), append: (...args) => store.append(...args),
      load: async id => { const snapshot = await store.load(id); if (fail) throw Error('controlled durable reload failure'); return snapshot; } };
    const a = node(log);
    try {
      for (let n = 0; n < 12; n++) {
        const gameId = randomUUID(); await create(a.authority, gameId);
        await assert.rejects(a.router.prepareOwnership(gameId), /controlled durable reload failure/);
        await a.registry.release(gameId);
        assert.deepEqual((await store.load(gameId)).map(e => e.seq), [0]);
      }
      assert.equal(a.registry.ownedCount, 0); assert.equal(a.meta.rehydrations.size, 0);
      assert.equal(a.meta.staleAfterClaim.size, 0, 'abandoned router debt must not accumulate for actual PG games');
      assert.equal(a.meta.claimGeneration.size, 0);
      fail = false;
      const gameId = randomUUID(); await create(a.authority, gameId);
      assert.equal((await a.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' })).state.ply, 1);
      assert.deepEqual((await store.load(gameId)).map(e => e.seq), [0, 1]);
    } finally { await a.close(); await store.closePlayerLocks(); }
  });
});

stackTest('F4 real stack: obsolete failure preserves successor debt; fresh forwarded identity commits exactly once', { timeout: 90000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const store = new PostgresEventStore(pool), gameId = randomUUID();
    const oldEntered = barrier(), oldRelease = barrier(), newEntered = barrier(), newRelease = barrier();
    let reads = 0;
    const log: EventLog = { exists: id => store.exists(id), append: (...args) => store.append(...args),
      load: async id => {
        const read = ++reads, snapshot = await store.load(id);
        if (read === 1) { oldEntered.resolve(); await oldRelease.done; throw Error('old reload failed'); }
        if (read === 2) { newEntered.resolve(); await newRelease.done; }
        return snapshot;
      } };
    const a = node(log), b = node(store);
    let obsolete: Promise<void> | undefined, fresh: ReturnType<RedisCommandRouter['route']> | undefined;
    try {
      await create(a.authority, gameId); await a.registry.claim(gameId);
      obsolete = assert.rejects(a.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' }), /old reload failed/);
      await oldEntered.done; await a.registry.release(gameId); await a.registry.claim(gameId);
      const generation = a.meta.claimGeneration.get(gameId);
      fresh = a.router.route(gameId, 'alice', { kind: 'move', uci: 'b1c3' });
      const pending = a.meta.rehydrations.get(gameId); assert.ok(pending);
      oldRelease.resolve(); await obsolete; await newEntered.done;
      assert.equal(a.meta.claimGeneration.get(gameId), generation);
      assert.equal(a.meta.rehydrations.get(gameId), pending);
      assert.equal(a.meta.staleAfterClaim.has(gameId), true);
      assert.equal(a.router.holdsOwnership(gameId), false);
      assert.deepEqual((await store.load(gameId)).map(e => e.seq), [0]);
      newRelease.resolve(); assert.equal((await fresh).state.ply, 1);
      assert.equal(a.meta.rehydrations.size, 0); assert.equal(a.meta.claimGeneration.size, 0);
      // Actual Redis START/FINISH/response path, not direct processCommand or fabricated approval.
      assert.equal((await b.router.route(gameId, 'bob', { kind: 'move', uci: 'e7e5' })).state.ply, 2);
      const events = await store.load(gameId);
      assert.deepEqual(events.map(e => e.seq), [0, 1, 2]);
      assert.deepEqual(events.flatMap(e => e.event.type === 'MovePlayed' ? [e.event.uci] : []), ['b1c3', 'e7e5']);
      assert.equal(a.consumer.isConsuming(gameId), true);
    } finally {
      oldRelease.resolve(); newRelease.resolve(); await Promise.allSettled([obsolete, fresh]);
      await b.close(); await a.close(); await store.closePlayerLocks();
    }
  });
});
