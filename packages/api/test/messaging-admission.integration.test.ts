import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { migrate } from '@chess-platform/persistence/pg';
import { withSharedDatabase } from '@chess-platform/persistence/test-support/fixtures';
import { DEFAULT_RATE_LIMIT } from '../src/config';
import { PgRateLimiter } from '../src/ports/pg-rate-limiter';
import { startHarness } from './helpers';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(process.cwd(), '../persistence/migrations');

test('messaging sender and IP admission is shared across PostgreSQL-backed API replicas', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({
    cleanup: async (pool) => {
      await pool.query('DELETE FROM rate_limit_buckets WHERE bucket_key = ANY($1::text[])', [keys]);
    },
  }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const rateLimit = {
      ...DEFAULT_RATE_LIMIT,
      conversationCreation: {
        perUser: { maxRequests: 2, windowMs: 60_000 },
        perIp: { maxRequests: 2, windowMs: 60_000 },
      },
      messageSend: {
        perUser: { maxRequests: 1, windowMs: 60_000 },
        perIp: { maxRequests: 10, windowMs: 60_000 },
      },
    };
    const a = await startHarness({ trustProxy: true, rateLimit }, {
      rateLimiter: new PgRateLimiter(pool),
    });
    const b = await startHarness({ trustProxy: true, rateLimit }, {
      rateLimiter: new PgRateLimiter(pool),
    });
    try {
      const alice = await a.makeUser('pg-message-alice');
      const bobA = await a.makeUser('pg-message-bob-a');
      const bobB = await b.makeUser('pg-message-bob-b');
      const charlie = await b.makeUser('pg-message-charlie');
      const openIp = '192.0.2.91';
      const rotatedIp = '192.0.2.92';
      const sendIpA = '192.0.2.93';
      const sendIpB = '192.0.2.94';
      keys.push(
        `message-open:user:${alice.userId}`, `message-open:user:${charlie.userId}`,
        `message-open:ip:${openIp}`, `message-open:ip:${rotatedIp}`,
        `message-send:user:${alice.userId}`,
        `message-send:ip:${sendIpA}`, `message-send:ip:${sendIpB}`,
      );
      const openA = await a.json('POST', '/v1/messages/conversations', {
        token: alice.token, headers: { 'x-forwarded-for': openIp }, body: { playerId: bobA.userId },
      });
      const openB = await b.json('POST', '/v1/messages/conversations', {
        token: alice.token, headers: { 'x-forwarded-for': openIp }, body: { playerId: bobB.userId },
      });
      assert.equal(openA.status, 200);
      assert.equal(openB.status, 200);
      assert.equal((await a.json('POST', '/v1/messages/conversations', {
        token: alice.token, headers: { 'x-forwarded-for': rotatedIp }, body: { playerId: bobA.userId },
      })).status, 429, 'the account budget spans both replicas despite IP rotation');
      assert.equal((await b.json('POST', '/v1/messages/conversations', {
        token: charlie.token, headers: { 'x-forwarded-for': openIp }, body: { playerId: bobB.userId },
      })).status, 429, 'the IP budget spans accounts and replicas');

      const sends = await Promise.all([
        a.json('POST', `/v1/messages/conversations/${openA.body.id}/messages`, {
          token: alice.token, headers: { 'x-forwarded-for': sendIpA }, body: { body: 'from A' },
        }),
        b.json('POST', `/v1/messages/conversations/${openB.body.id}/messages`, {
          token: alice.token, headers: { 'x-forwarded-for': sendIpB }, body: { body: 'from B' },
        }),
      ]);
      assert.deepEqual(sends.map((response) => response.status).sort(), [201, 429]);
      const listA = await a.json('GET', `/v1/messages/conversations/${openA.body.id}/messages`, {
        token: alice.token,
      });
      const listB = await b.json('GET', `/v1/messages/conversations/${openB.body.id}/messages`, {
        token: alice.token,
      });
      assert.equal(listA.body.total + listB.body.total, 1);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
