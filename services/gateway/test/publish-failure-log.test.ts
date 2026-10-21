import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryEventLog, GameAuthority, RedisPubSub, type RedisLike } from '@chess-platform/realtime-gateway';
import { createPublishFailureLogger, PUBLISH_FAILURE_LOG_INTERVAL_MS } from '../src/publish-failure-log.js';

test('publish-failure logger: one warning per channel per interval', () => {
  let clock = 0;
  const warned: string[] = [];
  const log = createPublishFailureLogger((channel) => warned.push(channel), () => clock);

  log('game:a');
  log('game:a');
  log('game:b');
  assert.deepEqual(warned, ['game:a', 'game:b'], 'repeats within the interval are suppressed');

  clock = PUBLISH_FAILURE_LOG_INTERVAL_MS;
  log('game:a');
  assert.deepEqual(warned, ['game:a', 'game:b', 'game:a'], 'reported again after the interval');
});

test('publish-failure logger: the tracking map stays bounded to the last interval', () => {
  let clock = 0;
  const log = createPublishFailureLogger(() => {}, () => clock);
  for (let i = 0; i < 1000; i++) log(`game:${i}`);
  assert.equal(log.trackedChannels(), 1000);

  clock = PUBLISH_FAILURE_LOG_INTERVAL_MS;
  log('game:new');
  assert.equal(log.trackedChannels(), 1, 'entries older than the interval are pruned');
});

test('publish-failure logger: wired to RedisPubSub.onPublishFailed, a rejected publish is reported', async () => {
  const failing: RedisLike = {
    publish: () => Promise.reject(new Error('Redis down')),
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
    on: () => {},
    off: () => {},
    quit: () => Promise.resolve(),
  };
  const idle: RedisLike = { ...failing, publish: () => Promise.resolve(0) };
  const pubsub = new RedisPubSub(failing, idle, 'node-1');
  const warned: string[] = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    pubsub.onPublishFailed(createPublishFailureLogger((channel) => warned.push(channel)));
    const authority = new GameAuthority(pubsub, () => 1000, new InMemoryEventLog());
    await authority.createGame({
      gameId: 'g1',
      players: { white: 'alice', black: 'bob' },
      timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rated: false,
    });
    await authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(warned, ['game:g1'], 'the failed broadcast publish was reported once');
});
