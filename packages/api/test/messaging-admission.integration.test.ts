import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { migrate, PgUsersRepository } from '@chess-platform/persistence/pg';
import { uuidv7 } from '@chess-platform/persistence';
import { deleteFixtureUsers, withSharedDatabase } from '@chess-platform/persistence/test-support/fixtures';
import { AccessTokenService } from '../src/auth/tokens';
import { createPgApiServer } from '../src/bootstrap';
import { DEFAULT_RATE_LIMIT } from '../src/config';
import { InMemoryEmailSender } from '../src/ports/email';
import { systemClock } from '../src/ports/clock';
import { uuidv7Generator } from '../src/ports/ids';
import { PgRateLimiter } from '../src/ports/pg-rate-limiter';
import { JsonLogger } from '../src/ports/logger';
import { closeServer, listenOnFetchablePort } from './listen';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(process.cwd(), '../persistence/migrations');

test('messaging sender and IP admission is shared across PostgreSQL-backed API replicas', { skip }, async () => {
  const keys: string[] = [];
  const userIds: string[] = [];
  await withSharedDatabase({
    cleanup: async (pool) => {
      await pool.query('DELETE FROM rate_limit_buckets WHERE bucket_key = ANY($1::text[])', [keys]);
      await deleteFixtureUsers(pool, userIds);
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
    const secret = 'test-access-token-secret-0123456789abcdef';
    const tokens = new AccessTokenService({ secret, ttlSec: 900, clock: systemClock, ids: uuidv7Generator });
    const users = new PgUsersRepository(pool);
    const makeUser = async (name: string) => {
      const id = uuidv7();
      userIds.push(id);
      const handle = `pg_message_${name}_${id.slice(-12)}`;
      await users.create({ id, handle });
      await users.addRole(id, 'user');
      return { userId: id, token: tokens.issue({ userId: id, handle, roles: ['user'] }).token };
    };
    const logger = new JsonLogger({}, { level: 'error', sink: () => {} });
    const replicas: { http: Server; url: string; shutdown: () => Promise<void> }[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const composed = createPgApiServer({
          pool, logger, emailSender: new InMemoryEmailSender(), rateLimiter: new PgRateLimiter(pool),
          config: { accessTokenSecret: secret, trustProxy: true, rateLimit },
        });
        const listening = await listenOnFetchablePort((port, host) => composed.server.listen(port, host), '127.0.0.1');
        replicas.push({
          http: listening.server,
          url: `http://127.0.0.1:${listening.port}`,
          shutdown: composed.shutdownAnalysis,
        });
      }
      const [a, b] = replicas as [typeof replicas[0], typeof replicas[0]];
      const json = async (
        replica: typeof a, method: string, path: string,
        opts: { token: string; address?: string; body?: unknown },
      ) => {
        const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
        if (opts.address) headers['x-forwarded-for'] = opts.address;
        if (opts.body !== undefined) headers['content-type'] = 'application/json';
        const response = await fetch(`${replica.url}${path}`, {
          method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined };
      };
      const alice = await makeUser('alice');
      const bob = await makeUser('bob');
      const charlie = await makeUser('charlie');
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
      const openA = await json(a, 'POST', '/v1/messages/conversations', {
        token: alice.token, address: openIp, body: { playerId: bob.userId },
      });
      const openB = await json(b, 'POST', '/v1/messages/conversations', {
        token: alice.token, address: openIp, body: { playerId: bob.userId },
      });
      assert.equal(openA.status, 200);
      assert.equal(openB.status, 200);
      assert.equal(openB.body.id, openA.body.id, 'both replicas see the same PostgreSQL conversation');
      assert.equal((await json(a, 'POST', '/v1/messages/conversations', {
        token: alice.token, address: rotatedIp, body: { playerId: charlie.userId },
      })).status, 429, 'the account budget spans both replicas despite IP rotation');
      assert.equal((await json(b, 'POST', '/v1/messages/conversations', {
        token: charlie.token, address: openIp, body: { playerId: bob.userId },
      })).status, 429, 'the IP budget spans accounts and replicas');

      const path = `/v1/messages/conversations/${openA.body.id}/messages`;
      const sends = await Promise.all([
        json(a, 'POST', path, {
          token: alice.token, address: sendIpA, body: { body: 'from A' },
        }),
        json(b, 'POST', path, {
          token: alice.token, address: sendIpB, body: { body: 'from B' },
        }),
      ]);
      assert.deepEqual(sends.map((response) => response.status).sort(), [201, 429]);
      const listA = await json(a, 'GET', path, { token: alice.token });
      const listB = await json(b, 'GET', path, { token: alice.token });
      assert.equal(listA.status, 200);
      assert.equal(listB.status, 200);
      assert.equal(listA.body.total, 1);
      assert.deepEqual(listB.body, listA.body, 'both replicas read the same persisted message');
    } finally {
      for (const replica of replicas) {
        await closeServer(replica.http);
        await replica.shutdown();
      }
    }
  });
});
