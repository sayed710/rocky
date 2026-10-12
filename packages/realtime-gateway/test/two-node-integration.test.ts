/**
 * Two-node design sketch (in-process FakeRedis).
 *
 * This test documents the single-owner + command-forwarding architecture
 * (ADR-0010) using an in-process FakeRedis. It is NOT the production
 * correctness gate — that lives in
 * `services/gateway/test/redis-ownership.integration.test.ts` and runs
 * against a real Redis instance (gated behind REDIS_URL).
 *
 * Coverage here:
 * 1. Sequential moves across nodes without spurious rejections
 * 2. Broadcasts reach players/spectators on both nodes
 * 3. Ownership claim after release (owner restart sketch)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimeControl } from '@chess-platform/game';
import {
  GameAuthority,
  AuthorityError,
  InMemoryEventLog,
  type ApplyResult,
  type AuthorityErrorCode,
  type Command,
  type Broadcast,
  type PubSub,
  type Unsubscribe,
} from '../src/index';
import { InMemoryConnection } from '../src/transport';
import { RealtimeGateway } from '../src/gateway';
import type { CommandRouter } from '../src/command-router';
import { FakeTokenVerifier } from './fake-token-verifier';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };
const flush = () => new Promise((r) => setImmediate(r));

// ── FakeRedis (in-process sketch only) ──────────────────────────────────────

class FakeRedis {
  private readonly pubsubChannels = new Map<string, Set<(channel: string, msg: string) => void>>();
  private readonly lists = new Map<string, string[]>();
  private readonly owners = new Map<string, { nodeId: string; expiresAt: number }>();
  private readonly responseQueues = new Map<string, string[]>();
  private readonly blpopWaiters = new Map<string, Array<(value: string) => void>>();

  publish(channel: string, message: string): number {
    const subs = this.pubsubChannels.get(channel);
    if (!subs) return 0;
    for (const cb of [...subs]) cb(channel, message);
    return subs.size;
  }

  subscribe(channel: string, cb: (channel: string, msg: string) => void): void {
    let subs = this.pubsubChannels.get(channel);
    if (!subs) {
      subs = new Set();
      this.pubsubChannels.set(channel, subs);
    }
    subs.add(cb);
  }

  unsubscribe(channel: string, cb: (channel: string, msg: string) => void): void {
    this.pubsubChannels.get(channel)?.delete(cb);
  }

  rpush(key: string, value: string): number {
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    list.push(value);
    const waiters = this.blpopWaiters.get(key);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift()!;
      const val = list.shift()!;
      waiter(val);
    }
    return list.length;
  }

  blpop(key: string, timeoutMs: number): Promise<string | null> {
    const list = this.lists.get(key);
    if (list && list.length > 0) return Promise.resolve(list.shift()!);
    return new Promise((resolve) => {
      let resolved = false;
      const waiter = (val: string) => {
        if (resolved) return;
        resolved = true;
        resolve(val);
      };
      let waiters = this.blpopWaiters.get(key);
      if (!waiters) {
        waiters = [];
        this.blpopWaiters.set(key, waiters);
      }
      waiters.push(waiter);
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        const idx = waiters!.indexOf(waiter);
        if (idx >= 0) waiters!.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
    });
  }

  /** Per-key ownership with TTL (models SET NX EX, not HSETNX). */
  setNxEx(gameId: string, nodeId: string, ttlSec: number): boolean {
    const existing = this.owners.get(gameId);
    const now = Date.now();
    if (existing && existing.expiresAt > now) return false;
    this.owners.set(gameId, { nodeId, expiresAt: now + ttlSec * 1000 });
    return true;
  }

  getOwner(gameId: string): string | null {
    const entry = this.owners.get(gameId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.owners.delete(gameId);
      return null;
    }
    return entry.nodeId;
  }

  delOwner(gameId: string): boolean {
    return this.owners.delete(gameId);
  }

  rpushResponse(key: string, value: string): void {
    let queue = this.responseQueues.get(key);
    if (!queue) {
      queue = [];
      this.responseQueues.set(key, queue);
    }
    queue.push(value);
    const waiters = this.blpopWaiters.get(key);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift()!;
      const val = queue.shift()!;
      waiter(val);
    }
  }

  blpopResponse(key: string, timeoutMs: number): Promise<string | null> {
    const queue = this.responseQueues.get(key);
    if (queue && queue.length > 0) return Promise.resolve(queue.shift()!);
    return new Promise((resolve) => {
      let resolved = false;
      const waiter = (val: string) => {
        if (resolved) return;
        resolved = true;
        resolve(val);
      };
      let waiters = this.blpopWaiters.get(key);
      if (!waiters) {
        waiters = [];
        this.blpopWaiters.set(key, waiters);
      }
      waiters.push(waiter);
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        const idx = waiters!.indexOf(waiter);
        if (idx >= 0) waiters!.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
    });
  }
}

interface ForwardedResult {
  ok: boolean;
  events?: unknown[];
  broadcasts?: unknown[];
  state?: unknown;
  error?: { code: string; message: string };
}

class ForwardingCommandRouter implements CommandRouter {
  private readonly responsePrefix = 'game:resp';
  private readonly cmdPrefix = 'game:cmd';
  private readonly leaseTtlSec = 30;
  private readonly forwardTimeoutMs = 2000;
  private readonly onClaim: (gameId: string) => void;

  constructor(
    private readonly authority: GameAuthority,
    private readonly redis: FakeRedis,
    private readonly nodeId: string,
    onClaim: (gameId: string) => void,
  ) {
    this.onClaim = onClaim;
  }

  async route(gameId: string, userId: string, cmd: Command): Promise<ApplyResult> {
    const claimed = this.redis.setNxEx(gameId, this.nodeId, this.leaseTtlSec);
    if (claimed) {
      this.onClaim(gameId);
      return this.authority.apply(gameId, userId, cmd);
    }
    const owner = this.redis.getOwner(gameId);
    if (!owner || owner === this.nodeId) {
      const reclaimed = this.redis.setNxEx(gameId, this.nodeId, this.leaseTtlSec);
      if (reclaimed) {
        this.onClaim(gameId);
        return this.authority.apply(gameId, userId, cmd);
      }
    }
    return this.forward(gameId, userId, cmd);
  }

  private async forward(gameId: string, userId: string, cmd: Command): Promise<ApplyResult> {
    const requestId = `${this.nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cmdKey = `${this.cmdPrefix}:${gameId}`;
    const respKey = `${this.responsePrefix}:${requestId}`;
    this.redis.rpush(cmdKey, JSON.stringify({ requestId, gameId, userId, cmd, responseKey: respKey }));
    const response = await this.redis.blpopResponse(respKey, this.forwardTimeoutMs);
    if (!response) {
      const reclaimed = this.redis.setNxEx(gameId, this.nodeId, this.leaseTtlSec);
      if (reclaimed) {
        this.onClaim(gameId);
        await this.authority.ensureLoaded(gameId);
        return this.authority.apply(gameId, userId, cmd);
      }
      throw new AuthorityError('invalid_command', 'command forward timeout');
    }
    const result = JSON.parse(response) as ForwardedResult;
    if (!result.ok) {
      throw new AuthorityError(
        (result.error?.code as AuthorityErrorCode) ?? 'invalid_command',
        result.error?.message ?? 'forwarded command failed',
      );
    }
    return {
      events: (result.events ?? []) as ApplyResult['events'],
      broadcasts: (result.broadcasts ?? []) as ApplyResult['broadcasts'],
      state: (result.state ?? {}) as ApplyResult['state'],
    };
  }
}

class OwnerCommandConsumer {
  private running = false;
  private readonly cmdPrefix = 'game:cmd';
  private readonly ownedGames = new Set<string>();

  constructor(
    private readonly authority: GameAuthority,
    private readonly redis: FakeRedis,
  ) {}

  startConsumer(gameId: string): void {
    this.ownedGames.add(gameId);
    if (!this.running) {
      this.running = true;
      void this.consumeLoop();
    }
  }

  stop(): void {
    this.running = false;
    this.ownedGames.clear();
  }

  private async consumeLoop(): Promise<void> {
    while (this.running) {
      let processed = false;
      for (const gameId of this.ownedGames) {
        const raw = await this.redis.blpop(`${this.cmdPrefix}:${gameId}`, 50);
        if (raw) {
          processed = true;
          await this.processCommand(raw);
        }
      }
      if (!processed) await new Promise((r) => setImmediate(r));
    }
  }

  private async processCommand(raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as {
      gameId: string;
      userId: string;
      cmd: Command;
      responseKey: string;
    };
    try {
      await this.authority.ensureLoaded(envelope.gameId);
      const result = await this.authority.apply(envelope.gameId, envelope.userId, envelope.cmd);
      this.redis.rpushResponse(
        envelope.responseKey,
        JSON.stringify({
          ok: true,
          events: result.events,
          broadcasts: result.broadcasts,
          state: result.state,
        }),
      );
    } catch (err) {
      this.redis.rpushResponse(
        envelope.responseKey,
        JSON.stringify({
          ok: false,
          error: {
            code: err instanceof AuthorityError ? err.code : 'invalid_command',
            message: err instanceof Error ? err.message : String(err),
          },
        }),
      );
    }
  }
}

class BridgedPubSub implements PubSub {
  private readonly localSubs = new Map<string, Set<(msg: Broadcast) => void>>();
  private readonly redisListener: (channel: string, msg: string) => void;

  constructor(
    private readonly redis: FakeRedis,
    private readonly nodeId: string,
  ) {
    this.redisListener = (channel: string, msg: string) => {
      const subs = this.localSubs.get(channel);
      if (!subs) return;
      const envelope = JSON.parse(msg) as { origin: string; msg: Broadcast };
      if (envelope.origin === this.nodeId) return;
      for (const handler of [...subs]) handler(envelope.msg);
    };
  }

  publish(channel: string, msg: Broadcast): void {
    const subs = this.localSubs.get(channel);
    if (subs) {
      for (const handler of [...subs]) handler(msg);
    }
    this.redis.publish(channel, JSON.stringify({ origin: this.nodeId, msg }));
  }

  subscribe(channel: string, handler: (msg: Broadcast) => void): Unsubscribe {
    let subs = this.localSubs.get(channel);
    const isFirst = !subs || subs.size === 0;
    if (!subs) {
      subs = new Set();
      this.localSubs.set(channel, subs);
    }
    subs.add(handler);
    if (isFirst) this.redis.subscribe(channel, this.redisListener);
    return () => {
      const set = this.localSubs.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        this.localSubs.delete(channel);
        this.redis.unsubscribe(channel, this.redisListener);
      }
    };
  }
}

async function twoNodeHarness() {
  let clock = 1_000;
  const now = () => (clock += 10);
  const redis = new FakeRedis();

  const pubsub1 = new BridgedPubSub(redis, 'node-1');
  const pubsub2 = new BridgedPubSub(redis, 'node-2');
  // Shared durable log so both nodes rehydrate the same game (mirrors Postgres).
  const store = new InMemoryEventLog();
  const authority1 = new GameAuthority(pubsub1, now, store);
  const authority2 = new GameAuthority(pubsub2, now, store);

  const consumer1 = new OwnerCommandConsumer(authority1, redis);
  const consumer2 = new OwnerCommandConsumer(authority2, redis);

  const router1 = new ForwardingCommandRouter(authority1, redis, 'node-1', (g) =>
    consumer1.startConsumer(g),
  );
  const router2 = new ForwardingCommandRouter(authority2, redis, 'node-2', (g) =>
    consumer2.startConsumer(g),
  );

  const verifier = new FakeTokenVerifier().allow('token-alice', 'alice').allow('token-bob', 'bob');
  const gateway1 = new RealtimeGateway(authority1, pubsub1, verifier, now, router1);
  const gateway2 = new RealtimeGateway(authority2, pubsub2, verifier, now, router2);

  await authority1.createGame({
    gameId: 'g1',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
  });

  const connect1 = (id: string) => {
    const c = new InMemoryConnection(id);
    gateway1.handleConnection(c);
    return c;
  };
  const connect2 = (id: string) => {
    const c = new InMemoryConnection(id);
    gateway2.handleConnection(c);
    return c;
  };

  return {
    authority1,
    authority2,
    gateway1,
    gateway2,
    consumer1,
    consumer2,
    redis,
    connect1,
    connect2,
  };
}

test('sketch: sequential moves across nodes without spurious rejections', async (t) => {
  const { connect1, connect2, consumer1, consumer2 } = await twoNodeHarness();
  t.after(() => { consumer1.stop(); consumer2.stop(); });

  const alice = connect1('alice');
  const bob = connect2('bob');
  alice.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
  bob.deliver({ t: 'join', gameId: 'g1', token: 'token-bob' });
  // node-2 has no resident copy of g1, so bob's join hydrates asynchronously
  // from the shared durable log; flush before asserting the seated roles.
  await flush();
  assert.equal(alice.last('joined')!.role, 'white');
  assert.equal(bob.last('joined')!.role, 'black');

  alice.deliver({ t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  await flush();
  await flush();

  assert.ok(alice.last('move'), 'alice receives her move');
  assert.ok(bob.last('move'), "bob receives alice's move via pub/sub");
  assert.equal(bob.last('move')!.ply, 1);

  bob.deliver({ t: 'move', gameId: 'g1', uci: 'e7e5', clientSeq: 1 });
  await flush();
  await flush();
  await flush();

  assert.ok(alice.last('move'), "alice receives bob's move");
  assert.equal(alice.last('move')!.ply, 2);
  assert.equal(alice.last('reject'), undefined);
  assert.equal(bob.last('reject'), undefined);

  consumer1.stop();
  consumer2.stop();
});

test('sketch: broadcasts reach spectators on both nodes', async (t) => {
  const { connect1, connect2, consumer1, consumer2 } = await twoNodeHarness();
  t.after(() => { consumer1.stop(); consumer2.stop(); });

  const alice = connect1('alice');
  const bob = connect2('bob');
  const spec1 = connect1('spec1');
  const spec2 = connect2('spec2');

  alice.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
  bob.deliver({ t: 'join', gameId: 'g1', token: 'token-bob' });
  spec1.deliver({ t: 'join', gameId: 'g1' });
  spec2.deliver({ t: 'join', gameId: 'g1' });

  // The cold node must finish joining/subscribing before it can receive a move.
  await flush();
  assert.ok(bob.last('joined'));
  assert.ok(spec2.last('joined'));

  alice.deliver({ t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  await flush();
  await flush();

  for (const [conn, name] of [
    [alice, 'alice'],
    [bob, 'bob'],
    [spec1, 'spec1'],
    [spec2, 'spec2'],
  ] as const) {
    const mv = conn.last('move');
    assert.ok(mv, `${name} should receive the move broadcast`);
    assert.equal(mv!.ply, 1);
  }

  consumer1.stop();
  consumer2.stop();
});

test('sketch: ownership can transfer after owner release', async (t) => {
  const { connect1, connect2, consumer1, consumer2, redis } = await twoNodeHarness();
  t.after(() => { consumer1.stop(); consumer2.stop(); });

  const alice = connect1('alice');
  const bob = connect2('bob');
  alice.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
  bob.deliver({ t: 'join', gameId: 'g1', token: 'token-bob' });

  alice.deliver({ t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  await flush();
  await flush();

  // Owner (node-1) shuts down and releases ownership.
  consumer1.stop();
  redis.delOwner('g1');
  alice.close();

  const claimed = redis.setNxEx('g1', 'node-2', 30);
  assert.ok(claimed, 'node-2 claims ownership after node-1 releases');
  consumer2.startConsumer('g1');

  consumer2.stop();
});
