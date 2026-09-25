import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { DuplicateUserError, uuidv7 } from '@chess-platform/persistence';
import {
  createPool,
  migrate,
  PgSessionsRepository,
  PgUsersRepository,
} from '@chess-platform/persistence/pg';
import {
  deleteFixtureUsers,
  withSharedDatabase,
} from '@chess-platform/persistence/test-support/fixtures';
import type { Pool } from 'pg';
import { PgRateLimiter } from '../src/ports/pg-rate-limiter';
import type { RateLimitReservation } from '../src/ports/rate-limiter';
import { backendPid, waitForBackendBlocked } from './pg-observer';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';

const MIGRATIONS = join(process.cwd(), '../persistence/migrations');

/**
 * Remove the rate-limit buckets a test created.
 *
 * `rate_limit_buckets` is keyed by `bucket_key` alone and no foreign key references it, so no
 * cascade can ever reach these rows: the only thing that removes one is naming it.
 * `PgRateLimiter.sweep` is not that thing — it fires once every thousand admissions and evicts only
 * buckets that expired over an hour ago, which none of these do inside a run.
 *
 * Deleting by exact key rather than by the shared `integration:` prefix is the contract, not a
 * detail. The prefix is a naming convention, not an ownership claim, so `LIKE 'integration:%'`
 * would delete rows this file never created.
 */
const deleteBuckets =
  (keys: readonly string[]) =>
  async (pool: Pool): Promise<void> => {
    await pool.query('DELETE FROM rate_limit_buckets WHERE bucket_key = ANY($1::text[])', [
      [...keys],
    ]);
  };

/**
 * Throughout this file, every identifier is recorded *before* the statement that creates its row.
 *
 * Recording afterwards loses exactly the rows worth cleaning up: a create that commits and is then
 * contradicted by a failing assertion never reaches the line that would have registered it, so the
 * row it left behind is orphaned by the very failure that made cleanup necessary. Deleting an
 * identifier whose row was never inserted matches nothing, so pre-recording costs nothing and
 * stays correct under any mid-test throw.
 */

test('Postgres registration transaction allows one concurrent case-insensitive handle', { skip }, async () => {
  const userIds: string[] = [];
  await withSharedDatabase({ cleanup: (pool) => deleteFixtureUsers(pool, userIds) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const users = new PgUsersRepository(pool);
    const suffix = uuidv7().replaceAll('-', '').slice(0, 12);
    // Both contenders are recorded, because which one commits is the race under test. The loser's
    // row never exists, and deleting an id that was never inserted matches nothing.
    const upper = uuidv7();
    const lower = uuidv7();
    userIds.push(upper, lower);
    const attempts = await Promise.allSettled([
      users.createWithPasswordAndRole({ id: upper, handle: `Race${suffix}` }, 'hash-a', 'user'),
      users.createWithPasswordAndRole({ id: lower, handle: `race${suffix}` }, 'hash-b', 'user'),
    ]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof DuplicateUserError);
    const winner = await users.findByHandle(`RACE${suffix}`);
    assert.ok(winner);
    assert.ok(await users.getPasswordHash(winner.id));
    assert.deepEqual(await users.rolesOf(winner.id), ['user']);
  });
});

test('Postgres refresh rotation has exactly one winner under concurrency', { skip }, async () => {
  const userIds: string[] = [];
  await withSharedDatabase({ cleanup: (pool) => deleteFixtureUsers(pool, userIds) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const users = new PgUsersRepository(pool);
    const sessions = new PgSessionsRepository(pool);
    // Every session this test creates hangs off this user, the rotation child included, so the
    // user id is the whole ownership record: `sessions.user_id` is `ON DELETE CASCADE`.
    const userId = uuidv7();
    userIds.push(userId);
    const user = await users.createWithPasswordAndRole(
      { id: userId, handle: `rotate${uuidv7().replaceAll('-', '').slice(0, 12)}` },
      'hash',
      'user',
    );
    const oldId = uuidv7();
    await sessions.create({
      id: oldId,
      userId: user.id,
      refreshHash: `old-${uuidv7()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const oldHash = (await pool.query<{ refresh_hash: string }>(
      'SELECT refresh_hash FROM sessions WHERE id = $1', [oldId],
    )).rows[0]!.refresh_hash;
    const now = new Date();
    const rotations = await Promise.all([
      sessions.rotate(oldHash, {
        id: uuidv7(), userId: user.id, refreshHash: `new-a-${uuidv7()}`,
        expiresAt: new Date(Date.now() + 60_000), rotatedFrom: oldId,
      }, now),
      sessions.rotate(oldHash, {
        id: uuidv7(), userId: user.id, refreshHash: `new-b-${uuidv7()}`,
        expiresAt: new Date(Date.now() + 60_000), rotatedFrom: oldId,
      }, now),
    ]);
    assert.deepEqual(rotations.map((result) => result.status).sort(), ['revoked', 'rotated']);
    const children = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM sessions WHERE rotated_from = $1', [oldId],
    );
    assert.equal(children.rows[0]!.count, '1');
  });
});

test('Postgres account revocation cannot miss a concurrently rotated successor', { skip }, async () => {
  const userIds: string[] = [];
  await withSharedDatabase({ cleanup: (pool) => deleteFixtureUsers(pool, userIds) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const users = new PgUsersRepository(pool);
    const sessions = new PgSessionsRepository(pool);
    const userId = uuidv7();
    userIds.push(userId);
    const user = await users.createWithPasswordAndRole(
      { id: userId, handle: `burn${uuidv7().replaceAll('-', '').slice(0, 12)}` },
      'hash',
      'user',
    );
    const oldId = uuidv7();
    const oldHash = `burn-old-${uuidv7()}`;
    await sessions.create({
      id: oldId, userId: user.id, refreshHash: oldHash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await Promise.all([
      sessions.rotate(oldHash, {
        id: uuidv7(), userId: user.id, refreshHash: `burn-new-${uuidv7()}`,
        expiresAt: new Date(Date.now() + 60_000), rotatedFrom: oldId,
      }, new Date()),
      sessions.revokeAllForUser(user.id, new Date()),
    ]);

    const active = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id],
    );
    assert.equal(active.rows[0]!.count, '0');
  });
});

test('Postgres chain revocation cannot miss a concurrently rotated successor', { skip }, async () => {
  const userIds: string[] = [];
  await withSharedDatabase({ cleanup: (pool) => deleteFixtureUsers(pool, userIds) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const users = new PgUsersRepository(pool);
    const sessions = new PgSessionsRepository(pool);
    const userId = uuidv7();
    userIds.push(userId);
    const user = await users.createWithPasswordAndRole(
      { id: userId, handle: `chain${uuidv7().replaceAll('-', '').slice(0, 12)}` },
      'hash',
      'user',
    );
    const rootId = uuidv7();
    const rootHash = `chain-root-${uuidv7()}`;
    await sessions.create({
      id: rootId,
      userId: user.id,
      refreshHash: rootHash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await Promise.all([
      sessions.rotate(rootHash, {
        id: uuidv7(),
        userId: user.id,
        refreshHash: `chain-next-${uuidv7()}`,
        expiresAt: new Date(Date.now() + 60_000),
        rotatedFrom: rootId,
      }, new Date()),
      sessions.revokeChainForUser(user.id, rootId, new Date()),
    ]);

    const active = await pool.query<{ count: string }>(
      `WITH RECURSIVE chain(id) AS (
         SELECT id FROM sessions WHERE id = $1
         UNION
         SELECT child.id FROM sessions child JOIN chain parent ON child.rotated_from = parent.id
       )
       SELECT COUNT(*)::text AS count
       FROM sessions
       WHERE id IN (SELECT id FROM chain) AND revoked_at IS NULL`,
      [rootId],
    );
    assert.equal(active.rows[0]!.count, '0');
  });
});

/**
 * `AuthService.revokeSession` audits only when its own call performed the revocation, which is only
 * true if the repository resolves the race rather than the service. The in-memory fake mirrors the
 * contract but cannot prove it — a single JavaScript turn has no interleaving to lose.
 */
test('Postgres session revocation has exactly one winner under concurrency', { skip }, async () => {
  const userIds: string[] = [];
  await withSharedDatabase({ cleanup: (pool) => deleteFixtureUsers(pool, userIds) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const users = new PgUsersRepository(pool);
    const sessions = new PgSessionsRepository(pool);
    const userId = uuidv7();
    userIds.push(userId);
    const user = await users.createWithPasswordAndRole(
      { id: userId, handle: `revoke${uuidv7().replaceAll('-', '').slice(0, 12)}` },
      'hash',
      'user',
    );
    const id = uuidv7();
    await sessions.create({
      id,
      userId: user.id,
      refreshHash: `rev-${uuidv7()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const at = new Date();
    const outcomes = await Promise.all([
      sessions.revoke(id, at),
      sessions.revoke(id, at),
      sessions.revoke(id, at),
    ]);
    assert.equal(outcomes.filter(Boolean).length, 1, 'one caller performed the transition');

    const later = await sessions.revoke(id, new Date(Date.now() + 1_000));
    assert.equal(later, false, 'a revoked session cannot be revoked again');

    const row = (await pool.query<{ revoked_at: Date }>(
      'SELECT revoked_at FROM sessions WHERE id = $1', [id],
    )).rows[0]!;
    assert.equal(row.revoked_at.getTime(), at.getTime(), 'the first revocation time stands');
  });
});

/**
 * The account-security screen identifies sessions by their created metadata, so it has to survive
 * the round trip: the columns are written by `create` but were absent from the read projection.
 */
test('Postgres session rows carry the request metadata they were created with', { skip }, async () => {
  const userIds: string[] = [];
  await withSharedDatabase({ cleanup: (pool) => deleteFixtureUsers(pool, userIds) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const users = new PgUsersRepository(pool);
    const sessions = new PgSessionsRepository(pool);
    const userId = uuidv7();
    userIds.push(userId);
    const user = await users.createWithPasswordAndRole(
      { id: userId, handle: `meta${uuidv7().replaceAll('-', '').slice(0, 12)}` },
      'hash',
      'user',
    );
    const id = uuidv7();
    await sessions.create({
      id,
      userId: user.id,
      refreshHash: `meta-${uuidv7()}`,
      expiresAt: new Date(Date.now() + 60_000),
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121',
    });

    const listed = (await sessions.listForUser(user.id)).find((s) => s.id === id);
    assert.equal(listed?.createdIp, '203.0.113.7');
    assert.equal(listed?.createdUserAgent, 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121');
    assert.equal(listed?.lastIp, null, 'nothing writes the last-seen fields');
  });
});

test('Postgres rate limiting is shared and atomic across limiter instances', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const a = new PgRateLimiter(pool);
    const b = new PgRateLimiter(pool);
    const key = `integration:${uuidv7()}`;
    keys.push(key);
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      (index % 2 === 0 ? a : b).admit([{ key, limit: { maxRequests: 5, windowMs: 60_000 } }])));
    assert.equal(results.filter((result) => result.allowed).length, 5);
  });
});

/**
 * The all-or-nothing invariant against the real database, where it is actually at risk.
 *
 * The in-memory limiter gets atomicity for free by being synchronous. Postgres does not: two
 * buckets are two statements, so the guarantee has to come from a transaction that rolls back
 * when any of them refuses. Nothing about that is visible to a single-threaded fake, which is why
 * this runs against a live server with real concurrency.
 */
test('Postgres multi-bucket admission charges every bucket or none', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const limiter = new PgRateLimiter(pool);
    const run = uuidv7();
    const full = { key: `integration:full:${run}`, limit: { maxRequests: 1, windowMs: 60_000 } };
    const roomy = { key: `integration:roomy:${run}`, limit: { maxRequests: 5, windowMs: 60_000 } };
    keys.push(full.key, roomy.key);

    assert.equal((await limiter.admit([full])).allowed, true, "fill the tight bucket");

    // Four refusals, driven concurrently so the transactions genuinely overlap.
    const refusals = await Promise.all(
      Array.from({ length: 4 }, () => limiter.admit([roomy, full])),
    );
    assert.equal(refusals.filter((r) => r.allowed).length, 0);
    assert.ok(refusals.every((r) => r.retryAfterSeconds > 0), "a refusal carries a wait");

    // If any of those had committed its half of the work, the roomy bucket would be short.
    const survivors = [];
    for (let i = 0; i < 5; i += 1) survivors.push(await limiter.admit([roomy]));
    assert.equal(survivors.filter((r) => r.allowed).length, 5, "all five slots were preserved");
    assert.equal((await limiter.admit([roomy])).allowed, false, "and the sixth is refused");
  });
});

/**
 * The documented `Retry-After` policy, against the real limiter.
 *
 * When several buckets refuse at once the answer is the longest of their waits. The short bucket
 * is named so that it sorts first, because the transaction visits keys in sorted order — an
 * implementation that reported whichever refusal it met first would return five seconds here, and
 * the caller would come back to a second refusal having learned nothing.
 */
test('Postgres reports the longest wait when several buckets refuse', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const limiter = new PgRateLimiter(pool);
    const run = uuidv7();
    const short = { key: `integration:a-short:${run}`, limit: { maxRequests: 1, windowMs: 5_000 } };
    const long = { key: `integration:z-long:${run}`, limit: { maxRequests: 1, windowMs: 600_000 } };
    keys.push(short.key, long.key);

    assert.equal((await limiter.admit([short, long])).allowed, true);

    const refused = await limiter.admit([short, long]);
    assert.equal(refused.allowed, false);
    assert.ok(
      refused.retryAfterSeconds > 300,
      `expected the 10-minute bucket to set the wait, got ${refused.retryAfterSeconds}s`,
    );
    assert.ok(refused.retryAfterSeconds <= 600);
  });
});

/**
 * A refused single-bucket admission must leave the stored counter exactly as it found it.
 *
 * The first implementation incremented unconditionally and decided afterwards, so a refusal
 * persisted `maxRequests + 1` — a charge recorded against a request that never ran. It
 * contradicted the port's own "rejection is free" clause and disagreed with the in-memory
 * limiter, which writes nothing; raising the limit underneath it, as during a rolling
 * configuration change, then handed the next caller a bucket that had already spent a slot on a
 * request it refused. Only a real server can show this, because the evidence is a stored row.
 */
test('Postgres single-bucket refusals leave the stored counter untouched', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const limiter = new PgRateLimiter(pool);
    const key = `integration:refusal:${uuidv7()}`;
    keys.push(key);
    const tight = { key, limit: { maxRequests: 2, windowMs: 600_000 } };

    assert.equal((await limiter.admit([tight])).allowed, true);
    assert.equal((await limiter.admit([tight])).allowed, true);

    // Five refusals against a full bucket.
    for (let i = 0; i < 5; i += 1) {
      const refused = await limiter.admit([tight]);
      assert.equal(refused.allowed, false, `refusal ${i}`);
      assert.ok(refused.retryAfterSeconds > 0, `refusal ${i} carries a wait`);
    }

    const stored = await pool.query<{ request_count: number }>(
      'SELECT request_count FROM rate_limit_buckets WHERE bucket_key = $1',
      [key],
    );
    assert.equal(
      Number(stored.rows[0]!.request_count),
      2,
      'the counter must record the two admissions and none of the five refusals',
    );

    // The observable consequence: raising the limit hands over exactly the slots it promises.
    const raised = { key, limit: { maxRequests: 4, windowMs: 600_000 } };
    assert.equal((await limiter.admit([raised])).allowed, true);
    assert.equal((await limiter.admit([raised])).allowed, true);
    assert.equal((await limiter.admit([raised])).allowed, false);
  });
});

/**
 * The wait a losing request is told to observe, when it lost a race to create the bucket.
 *
 * `ON CONFLICT DO UPDATE` can inspect a row committed by a concurrent transaction after the
 * statement began — Postgres steps outside the statement snapshot for exactly that purpose — but
 * an ordinary `SELECT` in the same statement cannot. The first version of the conditional upsert
 * carried its retry lookup in that trailing `SELECT`, so a request refused by a row it could not
 * see reported the one-second fallback for a bucket that was full for the rest of its window.
 * Against a ten-minute window it advised 1s instead of 600s, and the client would have come
 * straight back to the same refusal.
 *
 * The race is forced rather than hoped for: A inserts inside an open transaction, B starts its
 * statement (taking its snapshot) and blocks on the uncommitted unique key, then A commits and B
 * proceeds. Nothing about this is visible without a real server. Raised independently by both the
 * Qodo and CodeRabbit reviews of PR #137.
 *
 * Increment 6 sequenced that with a 300ms sleep, which could only ever be a guess: if the losing
 * statement had not reached the server before the holder committed, the race did not happen and
 * the test passed anyway — both orderings end with the same stored row and the same refusal, so
 * no assertion below could tell them apart. It is now sequenced on PostgreSQL's own report that
 * the backend is blocked, and that observation is asserted, so a run which did not race fails
 * instead of passing quietly. Raised in the CodeRabbit review of PR #137; see ADR-0119.
 */
test('Postgres tells the loser of a bucket-creation race the real remaining window', { skip }, async () => {
  const keys: string[] = [];
  // The admin pool is the shared one, so it is also the pool cleanup runs on. The bucket under
  // test is inserted by this test's own statement rather than through the limiter, which makes it
  // exactly the kind of row a cleanup written from the repository's point of view would miss.
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (admin) => {
    // The limiter gets its own single-connection pool so the backend running the blocked statement
    // is known by identity. Without that the observer would be guessing which of the pool's clients
    // to watch, and "some backend somewhere is blocked" is not the claim this test needs to make.
    const limiterPool = createPool({ max: 1 });
    const observerPool = createPool({ max: 1 });
    try {
      await migrate(admin, MIGRATIONS);
      const limiter = new PgRateLimiter(limiterPool);
      const key = `integration:create-race:${uuidv7()}`;
      keys.push(key);
      const windowMs = 600_000;
      const bucket = { key, limit: { maxRequests: 1, windowMs } };

      // A holds the row uncommitted; B then starts and blocks on the unique key.
      const holder = await admin.connect();
      let loser;
      let evidence;
      let pending;
      let holderPid;
      try {
        // Inside the try that releases the client, because reading a backend pid is a query and a
        // query can fail. When these ran ahead of the try, such a failure leaked the leased client,
        // and a pool with a client still checked out never finishes `end()` — so the file hung
        // instead of reporting the error that caused it.
        holderPid = await backendPid(holder);
        const limiterPid = await backendPid(limiterPool);
        await holder.query('BEGIN');
        await holder.query(
          `INSERT INTO rate_limit_buckets (bucket_key, request_count, window_started_at, expires_at)
           VALUES ($1, 1, now(), now() + ($2 * interval '1 millisecond'))`,
          [key, windowMs],
        );

        pending = limiter.admit([bucket]);
        // Wait for the server to report the limiter blocked on this holder's transaction. Throws
        // rather than continuing if that never happens, so the race cannot be skipped in silence.
        evidence = await waitForBackendBlocked(observerPool, {
          pid: limiterPid,
          blockedBy: holderPid,
        });
        await holder.query('COMMIT');
        loser = await pending;
      } finally {
        // An assertion failing between BEGIN and COMMIT leaves this transaction open with the
        // admission still blocked on it. Rolling back before release keeps a failing test from
        // handing a poisoned client back to the pool, and unblocks the pending statement so its
        // rejection is awaited here rather than surfacing as an unhandled one later.
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
        await pending?.catch(() => undefined);
      }

      // Load-bearing. This is what separates a run that raced from one that reached the same
      // numbers sequentially; remove the wait above and there is nothing left to assert here.
      assert.equal(evidence.waitEvent, 'transactionid');
      assert.ok(
        evidence.blockingPids.includes(holderPid),
        `the admission must have been blocked by backend ${holderPid}, not merely slower than it`,
      );

      assert.equal(loser.allowed, false, 'the bucket was already full when the race resolved');
      assert.ok(
        loser.retryAfterSeconds > 300,
        `expected the real remaining window, got ${loser.retryAfterSeconds}s`,
      );
      assert.ok(loser.retryAfterSeconds <= 600);
    } finally {
      await Promise.all([limiterPool.end(), observerPool.end()]);
    }
  });
});

/**
 * A key may appear at most once, in this implementation as in the in-memory one. Two entries
 * for one key with different limits had no order-independent answer in either.
 */
test('Postgres refuses a duplicate bucket key rather than charging it twice', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const limiter = new PgRateLimiter(pool);
    const key = `integration:dup:${uuidv7()}`;
    // Recorded even though the assertion below proves the refusal created no row. Cleanup states
    // what this test claims to own, and stating it costs one no-op delete; leaving it out would
    // mean a regression that made the refusal write a row leaked it instead of being caught.
    keys.push(key);

    await assert.rejects(
      () =>
        limiter.admit([
          { key, limit: { maxRequests: 5, windowMs: 60_000 } },
          { key, limit: { maxRequests: 1, windowMs: 60_000 } },
        ]),
      /duplicate bucket key/,
    );

    const stored = await pool.query(
      'SELECT 1 FROM rate_limit_buckets WHERE bucket_key = $1',
      [key],
    );
    assert.equal(stored.rowCount, 0, 'a refused request must not have created the bucket');
  });
});

/**
 * Two concurrent requests, one remaining slot, and a bucket ordering that would deadlock if the
 * limiter took its row locks in the order the caller happened to list them. Both are handed the
 * same pair of keys in opposite orders; the limiter sorts them, so one transaction simply waits
 * for the other instead of the pair being killed as a cycle.
 */
test('Postgres combined admission is deadlock-free and hands the last slot to exactly one', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const limiter = new PgRateLimiter(pool);
    const run = uuidv7();
    // Deliberately named so that "user" sorts before "zip" — the reversed call below hands them
    // over the other way round.
    const user = { key: `integration:auser:${run}`, limit: { maxRequests: 1, windowMs: 60_000 } };
    const zip = { key: `integration:zip:${run}`, limit: { maxRequests: 20, windowMs: 60_000 } };
    keys.push(user.key, zip.key);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? limiter.admit([user, zip]) : limiter.admit([zip, user]),
      ),
    );

    assert.equal(results.filter((r) => r.allowed).length, 1, "exactly one took the single slot");

    // The seven losers charged nothing to the shared bucket: 19 of its 20 slots remain.
    let remaining = 0;
    for (;;) {
      if (!(await limiter.admit([zip])).allowed) break;
      remaining += 1;
      if (remaining > 25) break;
    }
    assert.equal(remaining, 19);
  });
});

/**
 * `refund` against the real schema (audit P1-1). `request_count` carries `CHECK (> 0)`, so the last
 * unit has to leave as a delete; and a refund must never hand out capacity the bucket did not have.
 */
async function reserveOn(
  limiter: PgRateLimiter,
  bucket: { key: string; limit: { maxRequests: number; windowMs: number } },
): Promise<RateLimitReservation[]> {
  const result = await limiter.admit([{ ...bucket, refundable: true }]);
  assert.equal(result.allowed, true, `reserve ${bucket.key}`);
  return [...(result.reservations ?? [])];
}

async function storedCount(pool: Pool, key: string): Promise<number> {
  const row = await pool.query<{ request_count: number }>(
    'SELECT request_count FROM rate_limit_buckets WHERE bucket_key = $1',
    [key],
  );
  return row.rows[0]?.request_count ?? 0;
}

test('Postgres refund returns exactly the slots that were charged', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const limiter = new PgRateLimiter(pool);
    const bucket = { key: `integration:refund:${uuidv7()}`, limit: { maxRequests: 2, windowMs: 600_000 } };
    keys.push(bucket.key);

    const first = await reserveOn(limiter, bucket);
    const second = await reserveOn(limiter, bucket);
    assert.equal((await limiter.admit([bucket])).allowed, false);
    assert.equal(first.length, 1);

    await limiter.refund(first);
    assert.equal(await storedCount(pool, bucket.key), 1);
    await limiter.refund(second);
    assert.equal(await storedCount(pool, bucket.key), 0, 'the last unit is removed, not written as zero');
    await limiter.refund(second);
    await limiter.refund([{ key: `integration:never-charged:${uuidv7()}`, window: first[0]!.window }]);

    assert.equal((await limiter.admit([bucket])).allowed, true);
    assert.equal((await limiter.admit([bucket])).allowed, true);
    assert.equal((await limiter.admit([bucket])).allowed, false, 'surplus refunds minted nothing');
  });
});

test('Postgres refund leaves a lapsed window alone', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const limiter = new PgRateLimiter(pool);
    const bucket = { key: `integration:refund-lapsed:${uuidv7()}`, limit: { maxRequests: 3, windowMs: 600_000 } };
    keys.push(bucket.key);
    const reservation = await reserveOn(limiter, bucket);
    await reserveOn(limiter, bucket);
    // Lapse the window without waiting for it.
    await pool.query(
      `UPDATE rate_limit_buckets SET expires_at = now() - interval '1 second' WHERE bucket_key = $1`,
      [bucket.key],
    );

    await limiter.refund(reservation);
    assert.equal(await storedCount(pool, bucket.key), 2, 'a stale row is not decremented');
  });
});

/**
 * A login admitted just before its window ends can finish after other requests have opened the
 * next window. Its reservation names the old window, so the refund leaves the new one untouched.
 * Raised by Qodo and Greptile on PR #63.
 */
test('Postgres refund from a replaced window leaves the new window alone', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const limiter = new PgRateLimiter(pool);
    const bucket = { key: `integration:refund-rollover:${uuidv7()}`, limit: { maxRequests: 2, windowMs: 600_000 } };
    keys.push(bucket.key);
    const stale = await reserveOn(limiter, bucket);
    // Lapse the window, and move its start back so the next window's identity differs for certain.
    await pool.query(
      `UPDATE rate_limit_buckets
          SET expires_at = now() - interval '1 second', window_started_at = now() - interval '1 hour'
        WHERE bucket_key = $1`,
      [bucket.key],
    );
    await reserveOn(limiter, bucket); // opens the next window
    await reserveOn(limiter, bucket);

    await limiter.refund(stale);
    assert.equal(await storedCount(pool, bucket.key), 2, 'the new window keeps both charges');
    assert.equal((await limiter.admit([bucket])).allowed, false);
  });
});

/**
 * A reservation is single-use. Replaying one after another request has charged the same window
 * must not take that request's charge; nor may a structurally equal object the limiter never
 * issued. Raised by Qodo on PR #63.
 */
test('Postgres refund of a replayed or forged reservation does nothing', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const limiter = new PgRateLimiter(pool);
    const bucket = { key: `integration:refund-replay:${uuidv7()}`, limit: { maxRequests: 2, windowMs: 600_000 } };
    keys.push(bucket.key);
    const first = await reserveOn(limiter, bucket);
    await reserveOn(limiter, bucket);
    await limiter.refund(first);
    await reserveOn(limiter, bucket);

    await limiter.refund(first);
    await limiter.refund(first.map((r) => ({ ...r })));
    assert.equal(await storedCount(pool, bucket.key), 2, 'both live charges survive');
    assert.equal((await limiter.admit([bucket])).allowed, false);
  });
});

/**
 * Login's reservation across replicas: two limiter instances share one database, and twenty
 * concurrent failed-login admissions from twenty addresses race for an account-wide budget of
 * three. A check-then-charge design would let every one of them through; the reservation admits
 * exactly three. A refund on one replica is then visible to the other.
 */
test('Postgres login reservations hold across replicas under concurrency', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const a = new PgRateLimiter(pool);
    const b = new PgRateLimiter(pool);
    const run = uuidv7();
    const handle = {
      key: `integration:login-handle:${run}`,
      limit: { maxRequests: 3, windowMs: 600_000 },
      refundable: true,
    };
    keys.push(handle.key);
    const attempt = (i: number) => {
      const ip = { key: `integration:login-ip:${run}:${i}`, limit: { maxRequests: 10, windowMs: 600_000 } };
      const source = {
        key: `integration:login-source:${run}:${i}`,
        limit: { maxRequests: 5, windowMs: 600_000 },
        refundable: true,
      };
      keys.push(ip.key, source.key);
      return { ip, source, buckets: [ip, source, handle] };
    };

    const attempts = Array.from({ length: 20 }, (_, i) => attempt(i));
    const results = await Promise.all(
      attempts.map(({ buckets }, i) => (i % 2 === 0 ? a : b).admit(buckets)),
    );
    assert.equal(results.filter((r) => r.allowed).length, 3);
    results.forEach((result, i) => {
      if (!result.allowed) return;
      assert.deepEqual(
        (result.reservations ?? []).map((r) => r.key).sort(),
        [attempts[i]!.source.key, handle.key].sort(),
        'an admission reserves its source and handle buckets, never the IP bucket',
      );
    });

    // A reservation is refunded by the replica that issued it; the freed slot is shared.
    const winner = results.findIndex((r) => r.allowed);
    const issuer = winner % 2 === 0 ? a : b;
    const other = issuer === a ? b : a;
    await issuer.refund((results[winner]!.reservations ?? []).filter((r) => r.key === handle.key));
    assert.equal((await other.admit(attempt(100).buckets)).allowed, true, 'the refunded slot is shared');
    assert.equal((await other.admit(attempt(101).buckets)).allowed, false);
  });
});

/**
 * Refunds racing admissions and each other must never violate `CHECK (request_count > 0)` or mint
 * capacity.
 */
test('Postgres concurrent refunds never mint capacity', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const a = new PgRateLimiter(pool);
    const b = new PgRateLimiter(pool);
    const bucket = { key: `integration:refund-race:${uuidv7()}`, limit: { maxRequests: 5, windowMs: 600_000 } };
    keys.push(bucket.key);
    const reservations: RateLimitReservation[][] = [];
    for (let i = 0; i < 5; i += 1) reservations.push(await reserveOn(a, bucket));

    await Promise.all([
      ...reservations.map((reservation, i) => (i % 2 === 0 ? a : b).refund(reservation)),
      ...Array.from({ length: 5 }, (_, i) => (i % 2 === 0 ? b : a).admit([bucket])),
    ]);

    const stored = await storedCount(pool, bucket.key);
    assert.ok(stored >= 0 && stored <= 5, `stored count ${stored} is within capacity`);
    let admitted = 0;
    for (let i = 0; i < 6; i += 1) if ((await a.admit([bucket])).allowed) admitted += 1;
    assert.equal(admitted, 5 - stored, 'the bucket admits exactly what its stored count leaves');
  });
});

/**
 * A refund waiting on a contended row gives up at the lock timeout instead of holding a pooled
 * client indefinitely — the same bound multi-bucket admission has.
 */
test('Postgres refund is bounded by the lock timeout on a contended row', { skip }, async () => {
  const keys: string[] = [];
  await withSharedDatabase({ cleanup: deleteBuckets(keys) }, async (pool) => {
    await migrate(pool, MIGRATIONS);
    const limiter = new PgRateLimiter(pool);
    const bucket = { key: `integration:refund-contended:${uuidv7()}`, limit: { maxRequests: 3, windowMs: 600_000 } };
    keys.push(bucket.key);
    const reservation = await reserveOn(limiter, bucket);
    await reserveOn(limiter, bucket);

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM rate_limit_buckets WHERE bucket_key = $1 FOR UPDATE', [bucket.key]);
      await assert.rejects(limiter.refund(reservation), /lock timeout/);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    assert.equal(await storedCount(pool, bucket.key), 2, 'the timed-out refund changed nothing');
  });
});
