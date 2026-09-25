/**
 * Login step-up against real PostgreSQL (audit P1-1, ADR-0145).
 *
 * The first half holds the storage contract under genuine concurrency: one outstanding code per
 * account, single use, a bounded number of wrong codes, and no effect at all unless the caller has
 * already confirmed the password. The second half runs two API servers on one database — two
 * replicas — and shows the account-wide failure count and the emailed code are shared between them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { migrate, PgIdentityTokensRepository, PgUsersRepository } from '@chess-platform/persistence/pg';
import { uuidv7 } from '@chess-platform/persistence';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import type { Pool } from 'pg';
import { createPgApiServer } from '../src/bootstrap';
import { PgRateLimiter } from '../src/ports/pg-rate-limiter';
import { DEFAULT_RATE_LIMIT } from '../src/config';
import { InMemoryEmailSender } from '../src/ports/email';
import { JsonLogger } from '../src/ports/logger';
import { closeServer, listenOnFetchablePort } from './listen';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(process.cwd(), '../persistence/migrations');
const MAX_ATTEMPTS = 5;
const HOUR = 60 * 60 * 1000;

async function account(pool: Pool): Promise<string> {
  const id = uuidv7();
  await new PgUsersRepository(pool).createWithPasswordAndRole(
    { id, handle: `stepup_${id.slice(-12)}`, email: `${id}@example.test`, emailHash: null },
    'hash',
    'user',
  );
  return id;
}

function issue(
  repo: PgIdentityTokensRepository,
  userId: string,
  tokenHash: string,
  eligible = true,
  at = new Date(),
  reissueCutoff = at,
) {
  return repo.issueLoginStepUp(
    {
      userId,
      tokenHash,
      expiresAt: new Date(at.getTime() + HOUR),
      eligible,
      maxAttempts: MAX_ATTEMPTS,
      reissueCutoff,
    },
    at,
  );
}

function check(repo: PgIdentityTokensRepository, userId: string, tokenHash: string, checked = true, at = new Date()) {
  return repo.checkLoginStepUp({ userId, tokenHash, checked, maxAttempts: MAX_ATTEMPTS }, at);
}

async function stored(pool: Pool, userId: string): Promise<{ token_hash: string; attempts: number }[]> {
  const res = await pool.query<{ token_hash: string; attempts: number }>(
    `SELECT token_hash, attempts FROM identity_tokens WHERE user_id = $1 AND kind = 'login_step_up'`,
    [userId],
  );
  return res.rows;
}

test('Postgres step-up codes: one outstanding, single use, bounded misses, inert unless checked', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const repo = new PgIdentityTokensRepository(pool);
    const userId = await account(pool);

    assert.equal(await issue(repo, userId, 'a', false), false, 'an ineligible request issues nothing');
    assert.deepEqual(await stored(pool, userId), []);

    assert.equal(await issue(repo, userId, 'a'), true);
    assert.equal(await issue(repo, userId, 'b'), false, 'a live code is not replaced');
    assert.deepEqual(await stored(pool, userId), [{ token_hash: 'a', attempts: 0 }]);

    assert.equal(await check(repo, userId, 'x', false), false);
    assert.deepEqual(await stored(pool, userId), [{ token_hash: 'a', attempts: 0 }], 'unchecked is inert');

    assert.equal(await check(repo, userId, 'x'), false);
    assert.deepEqual(await stored(pool, userId), [{ token_hash: 'a', attempts: 1 }]);

    assert.equal(await check(repo, userId, 'a'), true);
    assert.deepEqual(await stored(pool, userId), [], 'a used code is deleted');
    assert.equal(await check(repo, userId, 'a'), false, 'and cannot be used again');

    // Exhausted by misses: the right code no longer works. A new code replaces it only once the
    // exhausted one was issued at or before the cutoff — the cooldown on burn-and-re-mint.
    const issuedAt = new Date();
    assert.equal(await issue(repo, userId, 'c', true, issuedAt), true);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await check(repo, userId, `miss-${i}`);
    assert.equal(await check(repo, userId, 'c'), false);
    const soon = new Date(issuedAt.getTime() + 60_000);
    assert.equal(
      await issue(repo, userId, 'd', true, soon, new Date(soon.getTime() - 5 * 60_000)),
      false,
      'not within the cooldown',
    );
    assert.equal(await issue(repo, userId, 'd', true, soon, issuedAt), true, 'once the cutoff reaches it');
    assert.deepEqual(await stored(pool, userId), [{ token_hash: 'd', attempts: 0 }]);

    // Expired: refused, and replaceable.
    const later = new Date(Date.now() + 2 * HOUR);
    assert.equal(await check(repo, userId, 'd', true, later), false);
    assert.equal(await issue(repo, userId, 'e', true, later), true);
  });
});

test('Postgres verification re-send honours its cutoff', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const repo = new PgIdentityTokensRepository(pool);
    const userId = await account(pool);
    const at = new Date();
    const token = (hash: string) => ({ tokenHash: hash, userId, expiresAt: new Date(at.getTime() + 24 * HOUR) });

    assert.ok(await repo.replaceActiveEmailVerification(token('v1'), at));
    const later = new Date(at.getTime() + 60_000);
    assert.equal(
      await repo.replaceActiveEmailVerification(token('v2'), later, new Date(later.getTime() - 10 * 60_000)),
      null,
      'a token issued within the cutoff blocks a re-send',
    );
    assert.ok(
      await repo.replaceActiveEmailVerification(token('v3'), later, at),
      'a token issued at or before the cutoff does not',
    );
    assert.ok(
      await repo.consumeEmailVerification('v1', later),
      'and a cutoff-limited re-send left the earlier link valid',
    );
  });
});

test('Postgres step-up codes stay single under concurrency', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const a = new PgIdentityTokensRepository(pool);
    const b = new PgIdentityTokensRepository(pool);
    const userId = await account(pool);

    const issued = await Promise.all(
      Array.from({ length: 20 }, (_, i) => issue(i % 2 === 0 ? a : b, userId, `code-${i}`)),
    );
    assert.equal(issued.filter(Boolean).length, 1, 'exactly one of twenty racing requests issues a code');
    const [row] = await stored(pool, userId);
    assert.ok(row);

    const used = await Promise.all(
      Array.from({ length: 20 }, (_, i) => check(i % 2 === 0 ? a : b, userId, row.token_hash)),
    );
    assert.equal(used.filter(Boolean).length, 1, 'exactly one of twenty racing checks uses it');

    assert.equal(await issue(a, userId, 'fresh'), true);
    await Promise.all(Array.from({ length: 20 }, (_, i) => check(i % 2 === 0 ? a : b, userId, `miss-${i}`)));
    assert.equal((await stored(pool, userId))[0]?.attempts, MAX_ATTEMPTS, 'misses stop counting at the cap');
    assert.equal(await check(a, userId, 'fresh'), false, 'and the code is dead');
  });
});

test('Postgres step-up count admits exactly its threshold across replicas under concurrency', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const a = new PgRateLimiter(pool);
    const b = new PgRateLimiter(pool);
    const bucket = { key: `login:handle:stepup_${uuidv7().slice(-12)}`, limit: { maxRequests: 3, windowMs: HOUR } };
    const counted = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b).tally(bucket)),
    );
    assert.equal(counted.filter((reservation) => reservation !== null).length, 3);
  });
});

test('Postgres step-up is shared between API replicas', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const saved = { NODE_ENV: process.env['NODE_ENV'], EMAIL_PROVIDER: process.env['EMAIL_PROVIDER'] };
    process.env['NODE_ENV'] = 'test';
    process.env['EMAIL_PROVIDER'] = 'console';
    const logger = new JsonLogger({}, { level: 'error', sink: () => {} });
    const outbox = new InMemoryEmailSender();
    const config = {
      accessTokenSecret: 'test-access-token-secret-0123456789abcdef',
      trustProxy: true,
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        login: { ...DEFAULT_RATE_LIMIT.login, perHandleBeforeStepUp: { maxRequests: 3, windowMs: HOUR } },
      },
    };
    const replicas: { http: Server; url: string; shutdown: () => Promise<void> }[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const composed = createPgApiServer({ pool, logger, emailSender: outbox, config });
        const listening = await listenOnFetchablePort((p, h) => composed.server.listen(p, h), '127.0.0.1');
        replicas.push({
          http: listening.server,
          url: `http://127.0.0.1:${listening.port}`,
          shutdown: composed.shutdownAnalysis,
        });
      }
      const [one, two] = replicas as [typeof replicas[0], typeof replicas[0]];
      const post = async (base: string, path: string, body: unknown, ip: string) => {
        const res = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : undefined };
      };

      const handle = `stepup_${uuidv7().slice(-12)}`;
      const email = `${handle}@example.test`;
      const password = 'CorrectHorseBattery1';
      assert.equal((await post(one.url, '/v1/auth/register', { handle, password, email }, '192.0.2.1')).status, 201);
      const verification = outbox.sent.find((m) => m.to === email && m.type === 'email_verify');
      assert.ok(verification);
      assert.equal((await post(two.url, '/v1/auth/email/verify', { token: verification.token }, '192.0.2.1')).status, 204);

      // Failures spread over both replicas and three addresses reach the shared threshold.
      for (let i = 0; i < 3; i++) {
        const replica = i % 2 === 0 ? one : two;
        assert.equal((await post(replica.url, '/v1/auth/login', { handle, password: 'wrong' }, `203.0.113.${i}`)).status, 401);
      }

      const challenged = await post(two.url, '/v1/auth/login', { handle, password }, '198.51.100.10');
      assert.equal(challenged.status, 401);
      assert.equal(challenged.body.error.details.reason, 'step_up_required');
      const code = outbox.sent.find((m) => m.to === email && m.type === 'login_step_up');
      assert.ok(code, 'the replica that saw the correct password sent a code');

      // The code, issued through one replica, is redeemed through the other.
      const signedIn = await post(one.url, '/v1/auth/login', { handle, password, code: code.token }, '198.51.100.10');
      assert.equal(signedIn.status, 200);
      assert.equal(signedIn.body.user.handle, handle);
    } finally {
      // Every step runs even if one before it fails: a replica left holding the pool would stall
      // the test database's teardown, and the environment must be restored for the next test.
      const failures: unknown[] = [];
      const record = (error: unknown): void => { failures.push(error); };
      for (const replica of replicas) {
        await closeServer(replica.http).catch(record);
        await replica.shutdown().catch(record);
      }
      process.env['NODE_ENV'] = saved.NODE_ENV;
      process.env['EMAIL_PROVIDER'] = saved.EMAIL_PROVIDER;
      if (saved.NODE_ENV === undefined) delete process.env['NODE_ENV'];
      if (saved.EMAIL_PROVIDER === undefined) delete process.env['EMAIL_PROVIDER'];
      if (failures.length > 0) throw failures[0];
    }
  });
});
