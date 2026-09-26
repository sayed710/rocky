import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pubSubConnectionOptions } from '../src/redis-pubsub.js';

// The subscriber-mode race this guards against appeared once in CI and does not reproduce on
// demand, so the configuration that prevents it is pinned directly.
test('pub/sub connections: only the subscriber skips the ready check', () => {
  const { pub, sub } = pubSubConnectionOptions({ tls: {} });

  assert.equal(sub['enableReadyCheck'], false, 'subscriber: no ready check');
  assert.equal(pub['enableReadyCheck'], undefined, 'publisher: ioredis default (ready check on)');
  for (const options of [pub, sub]) {
    assert.equal(options['lazyConnect'], false);
    assert.deepEqual(options['tls'], {}, 'caller options pass through');
  }
});

test('pub/sub connections: a caller cannot turn the subscriber ready check back on', () => {
  const { sub } = pubSubConnectionOptions({ enableReadyCheck: true });
  assert.equal(sub['enableReadyCheck'], false);
});
