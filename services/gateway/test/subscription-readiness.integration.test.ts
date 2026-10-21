/**
 * Real-Redis integration tests for Redis SUBSCRIBE readiness, reconnect resubscription,
 * and concurrent subscribe/unsubscribe (PR #119 Stage B).
 *
 * Gated behind REDIS_URL — skipped when unset (same pattern as redis-ownership.integration.test.ts).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  RedisPubSub,
  gameChannel,
  type Broadcast,
} from '@chess-platform/realtime-gateway';
import { createRedisPubSub } from '../src/redis-pubsub.js';

const REDIS_URL = process.env['REDIS_URL'];
const describeOrSkip = REDIS_URL ? test : test.skip;

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  errorMessage: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) {
    throw new Error(errorMessage);
  }
}

function parseClientList(output: string): Map<string, string>[] {
  return output
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const map = new Map<string, string>();
      for (const part of line.trim().split(/\s+/)) {
        const eqIdx = part.indexOf('=');
        if (eqIdx !== -1) {
          map.set(part.slice(0, eqIdx), part.slice(eqIdx + 1));
        }
      }
      return map;
    });
}

describeOrSkip('RI1, readiness', { timeout: 30_000 }, async () => {
  if (!REDIS_URL) return;
  const gameId = `ri1-${randomUUID()}`;
  const channel = gameChannel(gameId);

  const nodeA = createRedisPubSub({ url: REDIS_URL, nodeId: `node-a-${randomUUID()}` });
  const nodeB = createRedisPubSub({ url: REDIS_URL, nodeId: `node-b-${randomUUID()}` });

  const received: Broadcast[] = [];
  let unsub: (() => void) | undefined;
  try {
    unsub = nodeB.pubsub.subscribe(channel, (msg) => {
      received.push(msg);
    });

    assert.ok(nodeB.pubsub.ready, 'nodeB.pubsub.ready must be defined');
    await nodeB.pubsub.ready(channel);

    const testMsg: Broadcast = {
      t: 'commandConfirmed',
      gameId,
      requestId: randomUUID(),
    };
    nodeA.pubsub.publish(channel, testMsg);

    await waitFor(() => received.length === 1, 5000, 'handler on B did not receive message');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], testMsg);
  } finally {
    unsub?.();
    await Promise.all([
      nodeA.close().catch(() => undefined),
      nodeB.close().catch(() => undefined),
    ]);
  }
});

describeOrSkip('RI2, reconnect with the ready check disabled', { timeout: 30_000 }, async () => {
  if (!REDIS_URL) return;
  const gameId = `ri2-${randomUUID()}`;
  const channel = gameChannel(gameId);

  const bConnName = `sub-b-${randomUUID()}`;
  const nodeA = createRedisPubSub({ url: REDIS_URL, nodeId: `node-a-${randomUUID()}` });
  const nodeB = createRedisPubSub({
    url: REDIS_URL,
    nodeId: `node-b-${randomUUID()}`,
    redisOptions: { connectionName: bConnName },
  });
  const admin = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });

  const received: Broadcast[] = [];
  let unsub: (() => void) | undefined;
  let cancelTimeout: (() => void) | undefined;
  try {
    unsub = nodeB.pubsub.subscribe(channel, (msg) => {
      received.push(msg);
    });

    assert.ok(nodeB.pubsub.ready, 'nodeB.pubsub.ready must be defined');
    await nodeB.pubsub.ready(channel);

    // Prepare bounded listener for B's onReconnect
    assert.ok(nodeB.pubsub.onReconnect, 'nodeB.pubsub.onReconnect must be defined');
    const reconnectPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for B onReconnect listener to fire after CLIENT KILL'));
      }, 10_000);
      timer.unref?.();
      cancelTimeout = () => clearTimeout(timer);
      nodeB.pubsub.onReconnect!(() => {
        cancelTimeout?.();
        resolve();
      });
    });

    // Use admin client: CLIENT LIST to find B's subscriber connection
    const rawList = await admin.call('CLIENT', 'LIST');
    assert.ok(typeof rawList === 'string', 'CLIENT LIST must return string');
    const clients = parseClientList(rawList);
    const subClient = clients.find(
      (c) =>
        c.get('name') === bConnName &&
        (c.get('flags')?.includes('P') || Number(c.get('sub') ?? '0') > 0),
    );
    assert.ok(subClient, `subscriber connection for ${bConnName} not found in CLIENT LIST`);
    const clientId = subClient.get('id');
    assert.ok(clientId, 'client id missing in CLIENT LIST entry');

    // CLIENT KILL ID <id>
    await admin.call('CLIENT', 'KILL', 'ID', clientId);

    // Wait, bounded by a promise with a generous timeout (fail the test, never hang),
    // for B's onReconnect listener to fire
    await reconnectPromise;

    if (!(nodeB.pubsub instanceof RedisPubSub)) {
      throw new Error('expected nodeB.pubsub to be RedisPubSub instance');
    }
    assert.equal(nodeB.pubsub.subscriptionState(channel), 'ok');

    // Publish from A; B receives it
    const testMsg: Broadcast = {
      t: 'commandConfirmed',
      gameId,
      requestId: randomUUID(),
    };
    nodeA.pubsub.publish(channel, testMsg);

    await waitFor(() => received.length === 1, 5000, 'handler on B did not receive message after reconnect');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], testMsg);
  } finally {
    cancelTimeout?.();
    unsub?.();
    await Promise.all([
      admin.quit().catch(() => undefined),
      nodeA.close().catch(() => undefined),
      nodeB.close().catch(() => undefined),
    ]);
  }
});

describeOrSkip(
  'RI3, unsubscribe then subscribe while the first SUBSCRIBE is in flight, against real Redis',
  { timeout: 30_000 },
  async () => {
    if (!REDIS_URL) return;
    const gameId = `ri3-${randomUUID()}`;
    const channel = gameChannel(gameId);

    const nodeA = createRedisPubSub({ url: REDIS_URL, nodeId: `node-a-${randomUUID()}` });
    const nodeB = createRedisPubSub({ url: REDIS_URL, nodeId: `node-b-${randomUUID()}` });

    const received1: Broadcast[] = [];
    const received2: Broadcast[] = [];
    let unsub2: (() => void) | undefined;
    try {
      // First subscriber
      const unsub1 = nodeB.pubsub.subscribe(channel, (msg) => {
        received1.push(msg);
      });

      // Synchronously unsubscribe while first SUBSCRIBE is in flight
      unsub1();

      // Immediately subscribe second handler
      unsub2 = nodeB.pubsub.subscribe(channel, (msg) => {
        received2.push(msg);
      });

      // The final state is subscribed
      assert.ok(nodeB.pubsub.ready, 'nodeB.pubsub.ready must be defined');
      await nodeB.pubsub.ready(channel);

      if (!(nodeB.pubsub instanceof RedisPubSub)) {
        throw new Error('expected nodeB.pubsub to be RedisPubSub instance');
      }
      assert.equal(nodeB.pubsub.subscriptionState(channel), 'ok');

      // Publish from A; received exactly once on B
      const testMsg: Broadcast = {
        t: 'commandConfirmed',
        gameId,
        requestId: randomUUID(),
      };
      nodeA.pubsub.publish(channel, testMsg);

      await waitFor(() => received2.length === 1, 5000, 'handler 2 on B did not receive message');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(received1.length, 0, 'unsubscribed handler 1 must receive 0 messages');
      assert.equal(received2.length, 1, 'handler 2 must receive exactly one message');
      assert.deepEqual(received2[0], testMsg);
    } finally {
      unsub2?.();
      await Promise.all([
        nodeA.close().catch(() => undefined),
        nodeB.close().catch(() => undefined),
      ]);
    }
  },
);
