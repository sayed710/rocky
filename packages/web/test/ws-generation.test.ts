import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

test('obsolete socket events cannot open, close or deliver into its successor', () => {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  const client = new WsClient({ url: 'wss://example.test/ws', factory: factory.factory,
    scheduler, heartbeatMs: 0, reconnect: { jitter: 'none' } });
  let opens = 0;
  let messages = 0;
  let errors = 0;
  client.on({ open: () => { opens++; }, message: () => { messages++; }, error: () => { errors++; } });
  client.connect(); const obsolete = factory.last; obsolete.open(); obsolete.serverClose();
  scheduler.runNext(); factory.last.open();
  obsolete.open(); obsolete.emit({ t: 'presence', gameId: 'g1', white: true, black: false, spectators: 0 });
  obsolete.handlers.onClose({ code: 1006, reason: '', wasClean: false });
  obsolete.handlers.onError(new Error('obsolete socket'));
  assert.equal(opens, 2);
  assert.equal(messages, 0);
  assert.equal(errors, 0);
  assert.equal(client.state, 'open');
  client.close();
});
