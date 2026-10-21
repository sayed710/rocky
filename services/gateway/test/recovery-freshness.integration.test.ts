/** D1-A real stack: recovery freshness across gateway nodes via PostgreSQL and Redis. */
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

async function until(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() >= end) throw Error('expected gateway transition did not complete');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function node(store: EventLog, leaseTtlSec = 30, ownershipCheckTimeoutMs = 1000) {
  const nodeId = `d1a-${randomUUID()}`;
  const redis = new Redis(REDIS_URL!);
  const fan = createRedisPubSub({ url: REDIS_URL!, nodeId });
  const authority = new GameAuthority(fan.pubsub, () => 1000, store);
  const registry = new OwnershipRegistry({
    redis,
    nodeId,
    leaseTtlSec,
    renewalIntervalSec: leaseTtlSec === 30 ? 15 : 1,
  });
  const consumer = new OwnerCommandConsumer(authority, redis);
  const router = new RedisCommandRouter({ authority, registry, redis, nodeId, consumer, ownershipCheckTimeoutMs });
  const gateway = new RealtimeGateway(authority, fan.pubsub, { verify: (token) => ({ userId: token }) }, () => 1000, router);
  const connections: InMemoryConnection[] = [];

  const join = (gameId: string, userId?: string): InMemoryConnection => {
    const c = new InMemoryConnection();
    connections.push(c);
    gateway.handleConnection(c);
    c.deliver(userId ? { t: 'join', gameId, token: userId } : { t: 'join', gameId });
    return c;
  };

  const close = async (): Promise<void> => {
    for (const c of connections) c.close();
    consumer.stop();
    registry.stopRenewal();
    await registry.releaseAll();
    await fan.close();
    await redis.quit();
  };

  return { authority, router, registry, redis, pubsub: fan.pubsub, gateway, join, close };
}

async function create(a: GameAuthority, gameId: string): Promise<void> {
  await a.createGame({
    gameId,
    players: { white: 'alice', black: 'bob' },
    rated: false,
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
  });
}

stackTest('D1-A real stack: non-owner edge serves freshest committed prefix on join and resume', { timeout: 90000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const store = new PostgresEventStore(pool);
    const gameId = randomUUID();
    const a = node(store);
    const b = node(store);

    try {
      // Node A creates and owns the game.
      await create(a.authority, gameId);

      // Spectator joins on Node B (B hydrates cold).
      const s1 = b.join(gameId);
      await until(() => !!s1.last('joined'));
      assert.equal(s1.last('joined')?.state.stateRevision, 0);
      assert.equal(s1.last('joined')?.state.ply, 0);

      // Players move on Node A (two moves).
      await a.router.route(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
      await a.router.route(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

      // A new spectator joins on Node B.
      const s2 = b.join(gameId);
      await until(() => !!s2.last('joined'));

      // Existing spectator resumes lastPly 0 on Node B.
      s1.deliver({ t: 'resume', gameId, lastPly: 0 });
      await until(() => !!s1.last('resumed'));

      // Both receive stateRevision 2 and ply 2 from the durable log.
      const joinedState = s2.last('joined')!.state;
      assert.equal(joinedState.stateRevision, 2);
      assert.equal(joinedState.ply, 2);

      const resumed = s1.last('resumed')!;
      assert.equal(resumed.state.stateRevision, 2);
      assert.equal(resumed.state.ply, 2);
      assert.equal(resumed.missed.filter((m) => m.t === 'move').length, 2);

      // Same-ply draw offer by White on Node A (stateRevision 3, ply 2).
      await a.router.route(gameId, 'alice', { kind: 'offerDraw' });

      // Existing spectator resumes on Node B and sees the draw offer at stateRevision 3.
      s1.deliver({ t: 'resume', gameId, lastPly: 0 });
      await until(() => s1.last('resumed')?.state.stateRevision === 3);

      const resumedDraw = s1.last('resumed')!;
      assert.equal(resumedDraw.state.stateRevision, 3);
      assert.equal(resumedDraw.state.ply, 2);
      assert.equal(resumedDraw.state.drawOffer, 'w');
    } finally {
      await b.close();
      await a.close();
      await store.closePlayerLocks();
    }
  });
});
