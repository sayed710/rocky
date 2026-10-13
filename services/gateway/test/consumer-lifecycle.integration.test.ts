/** Real ioredis disconnect rejection, delayed only at the connection completion boundary. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import { GameAuthority, InMemoryEventLog, InMemoryPubSub, FLAG_ACTOR } from '@chess-platform/realtime-gateway';
import { OwnerCommandConsumer, RedisCommandRouter } from '../src/command-forwarder.js';
import { OwnershipRegistry } from '../src/ownership.js';
import { ENQUEUE_REQUEST, START_REQUEST, REQUEST_RETENTION_MS, requestKey } from '../src/forwarded-request.js';

function barrier() {
  let resolve!: () => void;
  const done = new Promise<void>(r => { resolve = r; }); return { done, resolve };
}

async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>(r => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const url = process.env['REDIS_URL'];
(url ? test : test.skip)('real Redis F3: stopped instance settles; replacement forwards real moves and restarts', { timeout: 15000 }, async () => {
  assert.ok(url);
  const redis = new Redis(url), senderRedis = new Redis(url);
  const id = `f3-${randomUUID()}`, name = `f3-client-${randomUUID()}`;
  const store = new InMemoryEventLog(), authority = new GameAuthority(new InMemoryPubSub(), () => 1000, store);
  const connections: Redis[] = [], calls: number[] = [];
  const rejected = barrier(), deliver = barrier();
  const duplicate = redis.duplicate.bind(redis);
  redis.duplicate = (...args) => {
    const conn = duplicate(...args), index = connections.length;
    connections.push(conn); calls.push(0);
    const blpop = conn.blpop.bind(conn);
    conn.blpop = (async (...input: Parameters<typeof blpop>) => {
      calls[index] = calls[index]! + 1;
      try { return await blpop(...input); } catch (error) {
        if (index === 0) { rejected.resolve(); await deliver.done; }
        throw error;
      }
    }) as typeof conn.blpop;
    return conn;
  };
  const registry = new OwnershipRegistry({ redis, nodeId: 'f3-owner' });
  const consumer = new OwnerCommandConsumer(authority, redis);
  const ownerRouter = new RedisCommandRouter({ authority, registry, redis, nodeId: 'f3-owner', consumer });
  const otherAuthority = new GameAuthority(new InMemoryPubSub(), () => 1000, store);
  const senderRegistry = new OwnershipRegistry({ redis: senderRedis, nodeId: 'f3-sender' });
  const senderConsumer = new OwnerCommandConsumer(otherAuthority, senderRedis);
  const sender = new RedisCommandRouter({ authority: otherAuthority, registry: senderRegistry,
    redis: senderRedis, nodeId: 'f3-sender', consumer: senderConsumer });
  let old: Promise<void> | undefined;
  try {
    await authority.createGame({ gameId: id, players: { white: 'alice', black: 'bob' }, rated: false,
      timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'increment' } });
    // Name the duplicates using inherited options before the claim launches the first BLPOP.
    redis.options.connectionName = name;
    assert.equal(await ownerRouter.prepareOwnership(id), true);
    // @ts-expect-error diagnostic observation of the production loop promise
    old = consumer.loops.get(id) as Promise<void>;
    assert.ok(old); let settled = false; void old.then(() => { settled = true; });
    await until(async () => (await senderRedis.client('LIST') as string).split('\n')
      .some(line => line.includes(`name=${name}`) && line.includes('cmd=blpop')), 'server-side A BLPOP');
    consumer.stopConsumer(id); await rejected.done;
    assert.equal(connections[0]!.status, 'end', 'genuine ioredis disconnect reached end');
    consumer.startConsumer(id); deliver.resolve();
    await new Promise<void>(r => setImmediate(r));
    assert.equal(settled, true, 'obsolete real A must settle after B registers');
    assert.equal(calls[0], 1, 'closed A must never call BLPOP again');
    assert.equal((await sender.route(id, 'alice', { kind: 'move', uci: 'e2e4' })).state.ply, 1);
    assert.equal(consumer.isConsuming(id), true);
    consumer.stop(); consumer.startConsumer(id);
    assert.equal((await sender.route(id, 'bob', { kind: 'move', uci: 'e7e5' })).state.ply, 2);
    assert.deepEqual((await store.load(id)).map(e => e.seq), [0, 1, 2]);
  } finally {
    deliver.resolve(); consumer.stop(); senderConsumer.stop();
    await old; for (const conn of connections) conn.disconnect();
    await registry.releaseAll(); await senderRegistry.releaseAll();
    await redis.del(`game:cmd:v2:${id}`);
    redis.disconnect(); senderRedis.disconnect();
  }
});

(url ? test : test.skip)('real Redis F3/R04: stopped expiry without replacement evicts its temporary copy and preserves handoff', { timeout: 10000 }, async () => {
  assert.ok(url); const redis = new Redis(url);
  const id = `f3-expiry-${randomUUID()}`, requestId = randomUUID(), queue = `game:cmd:v2:${id}`;
  const authority = new GameAuthority(new InMemoryPubSub(), () => 1000, new InMemoryEventLog());
  const consumer = new OwnerCommandConsumer(authority, redis); consumer.bindOwner('old-owner');
  const entered = barrier(), release = barrier();
  const evaluate = redis.eval.bind(redis);
  redis.eval = (async (...args: Parameters<typeof evaluate>) => {
    const result = await evaluate(...args);
    if (args[0] === START_REQUEST) {
      assert.equal(result, 'not_owner'); entered.resolve(); await release.done;
    }
    return result;
  }) as typeof redis.eval;
  consumer.watchLocalSessions(() => false);
  const payload = JSON.stringify({ version: 2, gameId: id, requestId, responseKey: `game:resp:${requestId}`,
    userId: FLAG_ACTOR, cmd: { kind: 'expireFlag' } });
  let old: Promise<void> | undefined;
  try {
    await authority.createGame({ gameId: id, players: { white: 'alice', black: 'bob' }, rated: false,
      timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'increment' } });
    await authority.apply(id, 'alice', { kind: 'resign' }); authority.evict(id);
    await redis.set(`game:owner:${id}`, 'successor', 'EX', 30);
    await redis.eval(ENQUEUE_REQUEST, 2, requestKey(requestId), queue, payload, 1000, REQUEST_RETENTION_MS);
    consumer.startConsumer(id);
    // @ts-expect-error diagnostic observation of the actual instance promise
    old = consumer.loops.get(id) as Promise<void>; assert.ok(old);
    await entered.done; assert.equal(authority.has(id), true);
    consumer.stopConsumer(id); release.resolve(); await old;
    assert.equal(authority.has(id), false, 'no replacement owns this temporary ended copy');
    assert.equal(consumer.isConsuming(id), false);
    assert.deepEqual(await redis.lrange(queue, 0, -1), [payload]);
    assert.equal(await redis.hget(requestKey(requestId), 'status'), 'queued');
  } finally {
    release.resolve(); consumer.stop(); await old;
    await redis.del(queue, requestKey(requestId), `game:resp:${requestId}`, `game:owner:${id}`);
    redis.disconnect();
  }
});
