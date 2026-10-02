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

test('community admission is shared across PostgreSQL-backed API replicas and refuses before writing', { skip }, async () => {
  const keys: string[] = [];
  const userIds: string[] = [];
  await withSharedDatabase({
    cleanup: async (pool) => {
      await pool.query('DELETE FROM rate_limit_buckets WHERE bucket_key = ANY($1::text[])', [keys]);
      await deleteFixtureUsers(pool, userIds);
    },
  }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const one = { maxRequests: 1, windowMs: 60_000 };
    const rateLimit = {
      ...DEFAULT_RATE_LIMIT,
      socialInitiation: { perUser: one, perIp: one },
      teamCreation: { perUser: one, perIp: { maxRequests: 10, windowMs: 60_000 } },
      forumPostCreation: { perUser: one, perIp: { maxRequests: 10, windowMs: 60_000 } },
      teamJoin: { perUser: one, perIp: { maxRequests: 10, windowMs: 60_000 } },
    };
    const secret = 'test-access-token-secret-0123456789abcdef';
    const tokens = new AccessTokenService({ secret, ttlSec: 900, clock: systemClock, ids: uuidv7Generator });
    const users = new PgUsersRepository(pool);
    const makeUser = async (name: string) => {
      const id = uuidv7();
      userIds.push(id);
      const handle = `pg_community_${name}_${id.slice(-12)}`;
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
        replicas.push({ http: listening.server, url: `http://127.0.0.1:${listening.port}`, shutdown: composed.shutdownAnalysis });
      }
      const [a, b] = replicas as [typeof replicas[0], typeof replicas[0]];
      const json = async (
        replica: typeof a, method: string, path: string,
        opts: { token?: string; address?: string; body?: unknown } = {},
      ) => {
        const headers: Record<string, string> = {};
        if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
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
      const carol = await makeUser('carol');
      const dave = await makeUser('dave');
      const [ip1, ip2, ip3, ip4, ip5, ip6] = ['192.0.2.141', '192.0.2.142', '192.0.2.143', '192.0.2.144', '192.0.2.145', '192.0.2.146'];
      const prefixes = ['social-initiate', 'team-create', 'team-join', 'forum-thread', 'forum-post'];
      for (const user of [alice, carol, dave]) keys.push(...prefixes.map((p) => `${p}:user:${user.userId}`));
      for (const address of [ip1, ip2, ip3, ip4, ip5, ip6, '127.0.0.1']) keys.push(...prefixes.map((p) => `${p}:ip:${address}`));

      // Follow: the account budget spans replicas and addresses; the address budget spans accounts.
      assert.equal((await json(a, 'POST', `/v1/social/follows/${bob.userId}`, { token: alice.token, address: ip1 })).status, 200);
      assert.equal((await json(b, 'POST', `/v1/social/follows/${carol.userId}`, { token: alice.token, address: ip2 })).status, 429);
      assert.equal((await json(b, 'POST', `/v1/social/follows/${carol.userId}`, { token: dave.token, address: ip1 })).status, 429);
      assert.equal((await json(a, 'GET', `/v1/social/players/${carol.userId}/followers`)).body.total, 0, 'no refused edge was written');
      assert.equal((await json(a, 'POST', `/v1/social/follows/${carol.userId}`, { token: dave.token, address: ip2 })).status, 200,
        'neither refusal charged the other bucket');
      assert.equal((await json(b, 'GET', `/v1/social/players/${carol.userId}/followers`)).body.total, 1);

      // Team creation: a refused team is never inserted.
      const slug = (n: string) => `pg-adm-${n}-${alice.userId.slice(-12)}`;
      const team = await json(a, 'POST', '/v1/teams', { token: alice.token, address: ip3, body: { slug: slug('one'), name: 'one', visibility: 'public' } });
      assert.equal(team.status, 201);
      assert.equal((await json(b, 'POST', '/v1/teams', { token: alice.token, address: ip4, body: { slug: slug('two'), name: 'two', visibility: 'public' } })).status, 429);
      assert.equal((await json(a, 'GET', `/v1/teams/${slug('two')}`)).status, 404, 'the refused team does not exist');

      // Posts: of two concurrent replies on two replicas, exactly one is admitted and stored.
      const thread = await json(a, 'POST', `/v1/teams/${team.body.id}/forum/threads`, { token: alice.token, body: { title: 't', body: 'opening' } });
      assert.equal(thread.status, 201);
      const posts = `/v1/teams/${team.body.id}/forum/threads/${thread.body.thread.id}/posts`;
      const replies = await Promise.all([
        json(a, 'POST', posts, { token: alice.token, address: ip5, body: { body: 'from A' } }),
        json(b, 'POST', posts, { token: alice.token, address: ip6, body: { body: 'from B' } }),
      ]);
      assert.deepEqual(replies.map((r) => r.status).sort(), [201, 429]);
      assert.equal((await json(b, 'GET', posts)).body.total, 2, 'the opening post and exactly one reply');

      // Joins: a public join and a join request share one budget; racing on two replicas, one lands.
      const other = await json(a, 'POST', '/v1/teams', { token: dave.token, address: ip5, body: { slug: slug('other'), name: 'other', visibility: 'public' } });
      assert.equal(other.status, 201);
      const joins = await Promise.all([
        json(a, 'POST', `/v1/teams/${team.body.id}/members`, { token: carol.token, address: ip5 }),
        json(b, 'POST', `/v1/teams/${other.body.id}/join-requests`, { token: carol.token, address: ip6 }),
      ]);
      assert.deepEqual(joins.map((r) => r.status).sort(), [201, 429]);
      const joined = (await json(b, 'GET', `/v1/teams/${team.body.id}/members`)).body.total - 1;
      const requested = (await json(a, 'GET', '/v1/me/join-requests', { token: carol.token })).body.total;
      assert.equal(joined + requested, 1, 'exactly one of the racing joins was written');
    } finally {
      for (const replica of replicas) {
        await closeServer(replica.http);
        await replica.shutdown();
      }
    }
  });
});
