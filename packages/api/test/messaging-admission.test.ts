import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RATE_LIMIT } from '../src/config';
import { MAX_MESSAGE_LENGTH } from '@chess-platform/messaging';
import { InMemoryRateLimiter } from '../src/ports/in-memory-rate-limiter';
import { ManualClock } from '../src/ports/clock';
import { startHarness } from './helpers';

const limits = {
  perUser: { maxRequests: 1, windowMs: 60_000 },
  perIp: { maxRequests: 1, windowMs: 60_000 },
};

const ip = (address: string) => ({ 'x-forwarded-for': address });

describe('messaging admission', () => {
  it('atomically limits conversation opens by sender and IP without creating refused conversations', async () => {
    const h = await startHarness({
      trustProxy: true,
      rateLimit: { ...DEFAULT_RATE_LIMIT, conversationCreation: limits },
    });
    try {
      const alice = await h.makeUser('admit-open-alice');
      const bob = await h.makeUser('admit-open-bob');
      const charlie = await h.makeUser('admit-open-charlie');
      const open = (token: string, address: string, playerId: string) => h.json(
        'POST', '/v1/messages/conversations',
        { token, headers: ip(address), body: { playerId } },
      );

      assert.equal((await open(alice.token, '192.0.2.1', bob.userId)).status, 200);
      const userRefusal = await open(alice.token, '192.0.2.2', charlie.userId);
      assert.equal(userRefusal.status, 429, 'IP rotation must not bypass the sender budget');
      assert.equal(userRefusal.body.error.code, 'rate_limited');
      assert.equal(userRefusal.headers.get('retry-after'), '60');
      assert.equal((await h.json('GET', '/v1/messages/conversations', {
        token: alice.token,
      })).body.total, 1, 'the refused Alice to Charlie pair was not created');
      const ipRefusal = await open(charlie.token, '192.0.2.1', bob.userId);
      assert.equal(ipRefusal.status, 429, 'another sender cannot bypass the IP budget');
      assert.equal(ipRefusal.headers.get('retry-after'), '60');
      assert.equal((await h.json('GET', '/v1/messages/conversations', {
        token: charlie.token,
      })).body.total, 0, 'the refused Charlie to Bob pair was not created');
      assert.equal((await open(charlie.token, '192.0.2.2', bob.userId)).status, 200,
        'neither refusal may partially charge the other bucket');

      const aliceList = await h.json('GET', '/v1/messages/conversations', { token: alice.token });
      assert.equal(aliceList.body.total, 1);
      const charlieList = await h.json('GET', '/v1/messages/conversations', { token: charlie.token });
      assert.equal(charlieList.body.total, 1);
    } finally {
      await h.close();
    }
  });

  it('atomically limits sends by sender and IP without storing refused messages', async () => {
    const h = await startHarness({
      trustProxy: true,
      rateLimit: { ...DEFAULT_RATE_LIMIT, messageSend: limits },
    });
    try {
      const alice = await h.makeUser('admit-send-alice');
      const bob = await h.makeUser('admit-send-bob');
      const open = await h.json('POST', '/v1/messages/conversations', {
        token: alice.token, body: { playerId: bob.userId },
      });
      assert.equal(open.status, 200);
      const path = `/v1/messages/conversations/${open.body.id}/messages`;
      const send = (token: string, address: string, body: unknown) => h.json(
        'POST', path, { token, headers: ip(address), body: { body } },
      );

      assert.equal((await send(alice.token, '192.0.2.3', 'first')).status, 201);
      const userRefusal = await send(alice.token, '192.0.2.4', 'refused');
      assert.equal(userRefusal.status, 429);
      assert.equal(userRefusal.body.error.code, 'rate_limited');
      assert.equal(userRefusal.headers.get('retry-after'), '60');
      const ipRefusal = await send(bob.token, '192.0.2.3', 'refused');
      assert.equal(ipRefusal.status, 429);
      assert.equal(ipRefusal.headers.get('retry-after'), '60');
      assert.equal((await send(bob.token, '192.0.2.4', 'second')).status, 201,
        'another sender retains a separate account budget');

      const messages = await h.json('GET', path, { token: alice.token });
      assert.equal(messages.body.total, 2);
      assert.deepEqual(messages.body.items.map((message: { body: string }) => message.body), ['first', 'second']);
    } finally {
      await h.close();
    }
  });

  it('rejects malformed create and send bodies before spending admission', async () => {
    const h = await startHarness({
      trustProxy: true,
      rateLimit: { ...DEFAULT_RATE_LIMIT, conversationCreation: limits, messageSend: limits },
    });
    try {
      const alice = await h.makeUser('admit-invalid-alice');
      const bob = await h.makeUser('admit-invalid-bob');
      const headers = ip('192.0.2.5');
      assert.equal((await h.json('POST', '/v1/messages/conversations', {
        token: alice.token, headers, body: { playerId: 'invalid' },
      })).status, 422);
      assert.equal((await h.json('POST', '/v1/messages/conversations', {
        token: alice.token, headers, body: { playerId: alice.userId },
      })).status, 422);
      const open = await h.json('POST', '/v1/messages/conversations', {
        token: alice.token, headers, body: { playerId: bob.userId },
      });
      assert.equal(open.status, 200);
      const path = `/v1/messages/conversations/${open.body.id}/messages`;
      assert.equal((await h.json('POST', path, {
        token: alice.token, headers, body: { body: '   ' },
      })).status, 422);
      assert.equal((await h.json('POST', path, {
        token: alice.token, headers, body: { body: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) },
      })).status, 422);
      assert.equal((await h.json('POST', path, {
        token: alice.token, headers, body: { body: 'valid' },
      })).status, 201);
    } finally {
      await h.close();
    }
  });

  it('rejects a differently cased self UUID before charging either conversation budget', async () => {
    const h = await startHarness({
      trustProxy: true,
      rateLimit: { ...DEFAULT_RATE_LIMIT, conversationCreation: limits },
    });
    try {
      const alice = await h.makeUser('admit-case-alice');
      const bob = await h.makeUser('admit-case-bob');
      const headers = ip('192.0.2.6');
      const differentlyCasedId = alice.userId.toUpperCase();
      assert.notEqual(differentlyCasedId, alice.userId);
      const self = await h.json('POST', '/v1/messages/conversations', {
        token: alice.token, headers, body: { playerId: differentlyCasedId },
      });
      assert.equal(self.status, 422);
      assert.equal(self.body.error.details.actor, 'self_conversation');
      assert.equal((await h.json('POST', '/v1/messages/conversations', {
        token: alice.token, headers, body: { playerId: bob.userId },
      })).status, 200, 'the self request spent neither the sender nor IP admission slot');
    } finally {
      await h.close();
    }
  });

  it('admits only one concurrent send at the last account slot', async () => {
    const h = await startHarness({ rateLimit: { ...DEFAULT_RATE_LIMIT, messageSend: {
      perUser: { maxRequests: 1, windowMs: 60_000 },
      perIp: { maxRequests: 10, windowMs: 60_000 },
    } } });
    try {
      const alice = await h.makeUser('admit-race-alice');
      const bob = await h.makeUser('admit-race-bob');
      const open = await h.json('POST', '/v1/messages/conversations', {
        token: alice.token, body: { playerId: bob.userId },
      });
      assert.equal(open.status, 200);
      const path = `/v1/messages/conversations/${open.body.id}/messages`;
      const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        h.json('POST', path, { token: alice.token, body: { body: `race ${index}` } })));
      assert.equal(attempts.filter((response) => response.status === 201).length, 1);
      assert.equal(attempts.filter((response) => response.status === 429).length, 7);
      const messages = await h.json('GET', path, { token: alice.token });
      assert.equal(messages.body.total, 1);
    } finally {
      await h.close();
    }
  });

  it('fails closed before messaging persistence if the limiter is unavailable', async () => {
    class UnavailableLimiter extends InMemoryRateLimiter {
      override admit(): never { throw new Error('rate-limit storage unavailable'); }
    }
    const h = await startHarness({}, { rateLimiter: new UnavailableLimiter(new ManualClock(0)) });
    try {
      const alice = await h.makeUser('admit-fault-alice');
      const bob = await h.makeUser('admit-fault-bob');
      const refused = await h.json('POST', '/v1/messages/conversations', {
        token: alice.token, body: { playerId: bob.userId },
      });
      assert.equal(refused.status, 500);
      const conversations = await h.json('GET', '/v1/messages/conversations', { token: alice.token });
      assert.equal(conversations.body.total, 0);
    } finally {
      await h.close();
    }
  });

  it('preserves get-or-create, block and nonparticipant rules under the admission policy', async () => {
    const h = await startHarness();
    try {
      const alice = await h.makeUser('admit-rules-alice');
      const bob = await h.makeUser('admit-rules-bob');
      const charlie = await h.makeUser('admit-rules-charlie');
      const open = () => h.json('POST', '/v1/messages/conversations', {
        token: alice.token, body: { playerId: bob.userId },
      });
      const first = await open();
      const second = await open();
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(second.body.id, first.body.id);
      const path = `/v1/messages/conversations/${first.body.id}/messages`;
      assert.equal((await h.json('POST', path, {
        token: charlie.token, body: { body: 'stranger' },
      })).status, 404);
      assert.equal((await h.json('POST', `/v1/social/blocks/${bob.userId}`, {
        token: alice.token,
      })).status, 200);
      assert.equal((await h.json('POST', path, {
        token: bob.token, body: { body: 'blocked' },
      })).status, 403);
      assert.equal((await h.json('GET', path, { token: alice.token })).body.total, 0);
    } finally {
      await h.close();
    }
  });
});
