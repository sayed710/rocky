/**
 * Sign-in against a database that has not been migrated, and the probe that is supposed to say so.
 *
 * This file exists because of a reproduced failure, not a hypothesis. `POST /v1/auth/login` returned
 * HTTP 500 against a local PostgreSQL, and the exception was `relation "rate_limit_buckets" does not
 * exist`: the route rate-limits before it authenticates, that table arrives in migration 0004, and a
 * database that never got there fails in the limiter before a credential is ever read. The same 500
 * appears on a database migrated to 3 of 27 — `users` exists from 0001, so the schema looks
 * plausible right up until the first request.
 *
 * The 500 itself is correct. A database that cannot answer is a server-side fault, the client is
 * told nothing but `internal`, and the cause is logged privately. What was wrong is that nothing
 * *said so*: `GET /v1/ready` answered 200 in both states, because readiness was `SELECT 1` — a proof
 * of connectivity, not of usability. That answer is what admits traffic to a Kubernetes pod and what
 * releases the gateway's and search indexer's `wait-for-api` init containers, and the chart's
 * migrate init container is behind a toggle, so nothing else stood between a skipped migration and a
 * fleet serving 500s.
 *
 * Each test owns a PostgreSQL database of its own and migrates it to whatever version the case
 * needs, through the canonical runner and the canonical SQL — never inventing DDL, which is the
 * thing the migration ledger exists to prevent.
 *
 * A database rather than a schema, and the reason is worth recording: `search_path` isolation looks
 * cheaper and fails here. `CREATE EXTENSION IF NOT EXISTS citext` in migration 0001 is a no-op once
 * any other suite has installed the extension into `public`, so a schema-scoped run finds `citext`
 * unresolvable and 0001 fails; adding `public` to the path fixes that and breaks the other half,
 * because then the un-migrated case reads the shared `schema_migrations` and reports itself ready.
 * Only a separate database gives both an empty ledger and a resolvable extension.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { closeServer, listenOnFetchablePort } from './listen';
import {
  migrate,
  migrationFiles,
  missingMigrations,
  migrationsDir,
} from '@chess-platform/persistence/pg';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import type { Pool } from 'pg';
import { createPgApiServer } from '../src/bootstrap';
import { InMemoryEmailSender } from '../src/ports/email';
import { JsonLogger } from '../src/ports/logger';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

/** Long enough for `resolveConfig`, and not a secret — it signs nothing that outlives the test. */
const TEST_SECRET = 'test-access-token-secret-0123456789abcdef';

/** The loopback address this suite binds; also the host in the `baseUrl` it hands to `run`. */
const SERVER_HOST = '127.0.0.1';

/** Captures what the composed server sends, so a test can confirm the account email like its owner. */
const outbox = new InMemoryEmailSender();

/**
 * A directory holding the first `count` migrations, copied byte-for-byte from the real ones.
 *
 * Copied rather than written out, because a second hand-maintained copy of migration SQL is exactly
 * what the checksum ledger exists to make impossible: these have to be the same bytes the runner
 * would apply in production, or the "partially migrated" case under test is not the one that
 * happens.
 */
function migrationsThrough(count: number): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'signin-migrations-'));
  for (const { file } of migrationFiles(migrationsDir()).slice(0, count)) {
    copyFileSync(join(migrationsDir(), file), join(dir, file));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Fixture {
  readonly baseUrl: string;
  /** The pool the API is running on, connected to this test's own database. */
  readonly pool: Pool;
  /** Bring the database up using the canonical runner. */
  migrateTo(dir: string): Promise<number>;
}

/**
 * Run one case against an API server whose entire world is a private PostgreSQL database, created
 * for the test and dropped after it.
 */
async function withSchema(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  // The pool is capped well below `pg`'s default of ten. This file runs inside a suite that already
  // holds a great many connections against one server, and a test that quietly opened twenty more
  // would push the next file over `max_connections` — which surfaces as that file failing, not this
  // one. Two is the floor rather than one: `migrate` holds the advisory lock on a dedicated client
  // and runs its statements on another, so a single-connection pool deadlocks against itself.
  //
  // This used to absorb SQLSTATE 57P01 on both pools, because ending the pool and immediately
  // dropping the database WITH (FORCE) terminated backends the pool had not finished closing, and
  // `pg` re-emitted that FATAL as an uncaught exception attributed to an unrelated test. That
  // listener treated the symptom. `withTestDatabase` waits for the database to be genuinely unused
  // and then drops it without FORCE, so nothing is terminated and there is no error to absorb — and
  // a real connection failure in these tests is once again as loud as it should be.
  await withTestDatabase(
    async ({ pool }) => {
      // Errors only: a deliberately broken database is about to be exercised, and the point of these
      // tests is the status codes, not a wall of expected failure logging.
      const logger = new JsonLogger({}, { level: 'error', sink: () => {} });

      const savedEnv = { NODE_ENV: process.env['NODE_ENV'], EMAIL_PROVIDER: process.env['EMAIL_PROVIDER'] };
      process.env['NODE_ENV'] = 'test';
      process.env['EMAIL_PROVIDER'] = 'console';

      let http: Server | undefined;
      let shutdownAnalysis: (() => Promise<void>) | undefined;
      let caseFailed = false;
      let caseError: unknown;
      try {
        const composed = createPgApiServer({
          pool,
          logger,
          emailSender: outbox,
          config: { accessTokenSecret: TEST_SECRET },
        });
        shutdownAnalysis = composed.shutdownAnalysis;

        const listening = await listenOnFetchablePort(
          (p, h) => composed.server.listen(p, h),
          SERVER_HOST,
        );
        http = listening.server;

        await run({
          baseUrl: `http://${SERVER_HOST}:${listening.port}`,
          pool,
          migrateTo: (dir) => migrate(pool, dir),
        });
      } catch (error) {
        caseFailed = true;
        caseError = error;
      }

      // The server and the analysis worker both hold this pool, so they have to be shut down before
      // the callback returns — teardown ends the pool the moment it does, and anything still using
      // it would fail with "Cannot use a pool after calling end on the pool".
      //
      // Each step runs whatever the one before it did. Chained with plain awaits, a server that
      // failed to close would skip `shutdownAnalysis` entirely, leaving the analysis worker holding
      // this pool while teardown tried to end it — turning a small close failure into a teardown
      // timeout and a run of pool-after-end errors. Restoring the environment must not be skipped
      // either, or the next test in the file inherits it.
      const cleanupFailures: unknown[] = [];
      const record = (error: unknown): void => {
        cleanupFailures.push(error);
      };
      if (http) await closeServer(http).catch(record);
      if (shutdownAnalysis) await shutdownAnalysis().catch(record);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

      // Same precedence the helper itself uses: the case's own failure is the one worth reading, and
      // a cleanup failure rides along rather than replacing it.
      if (caseFailed) {
        if (cleanupFailures.length > 0 && caseError instanceof Error && caseError.cause === undefined) {
          caseError.cause = cleanupFailures[0];
        }
        throw caseError;
      }
      if (cleanupFailures.length > 0) throw cleanupFailures[0];
    },
    { connectionString: DATABASE_URL, max: 4 },
  );
}

/**
 * The sign-in request exactly as the web client sends it — `POST /v1/auth/login`, JSON body.
 *
 * `body` is deliberately `unknown`: several cases here send something the route should reject, and
 * typing it as a valid request would make the malformed cases unwritable.
 */
const login = (baseUrl: string, body: unknown): Promise<Response> =>
  fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * The reproduction, pinned.
 *
 * Not an aspiration — this is what the failure looked like, asserted so that a future change which
 * quietly turns it into a 200 (or into a 401, which would be worse: a broken database reported as a
 * bad password) has to argue with a test.
 */
test('an un-migrated database: sign-in is a server fault, and readiness reports it unready', { skip }, async () => {
  await withSchema(async ({ baseUrl, pool }) => {
    assert.equal(
      (await missingMigrations(pool)).length,
      migrationFiles(migrationsDir()).length,
      'nothing is applied yet, so every shipped migration is missing',
    );

    assert.equal(
      (await fetch(`${baseUrl}/v1/ready`)).status,
      503,
      'an un-migrated database is not something to send traffic at',
    );

    // Liveness is a different question and keeps its own answer: the process is running, and
    // restarting it would not migrate anything.
    assert.equal((await fetch(`${baseUrl}/v1/health`)).status, 200);

    const response = await login(baseUrl, { handle: 'anyone', password: 'CorrectHorseBattery1' });
    assert.equal(response.status, 500, 'the reproduced failure');

    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'internal');
    assert.equal(body.error.message, 'internal server error');
    assert.ok(
      !JSON.stringify(body).includes('rate_limit_buckets'),
      'the client is never told which relation is missing',
    );
  });
});

/**
 * The variant that actually bites people: a database migrated once and then left behind.
 *
 * `users` exists, so nothing about the schema looks obviously empty, and the failure still lands in
 * the rate limiter. Migration 4 is the first one missing, which is exactly the table the reproduced
 * exception named.
 */
test('a partially migrated database is not ready either', { skip }, async () => {
  const { dir, cleanup } = migrationsThrough(3);
  try {
    await withSchema(async ({ baseUrl, pool, migrateTo }) => {
      assert.equal(await migrateTo(dir), 3);

      const missing = await missingMigrations(pool);
      assert.equal(missing[0], 4, 'the first gap is the migration that creates rate_limit_buckets');

      assert.equal((await fetch(`${baseUrl}/v1/ready`)).status, 503);
      assert.equal(
        (await login(baseUrl, { handle: 'anyone', password: 'CorrectHorseBattery1' })).status,
        500,
      );
    });
  } finally {
    cleanup();
  }
});

/**
 * An online index still being built must not take the fleet out.
 *
 * `migrate` reserves an online-index migration as `pending`, runs `CREATE INDEX CONCURRENTLY`, and
 * only then marks it `applied`. On a large table that build can run for the better part of an hour,
 * and it runs concurrently precisely so that nothing has to stop for it. A probe that required
 * `applied` would spend that hour reporting 503 and would turn the non-blocking option into the
 * blocking one — so presence in the ledger is the test, in whatever state, and the table the index
 * belongs to already exists by then.
 */
test('a migration still building its index concurrently does not make the API unready', { skip }, async () => {
  await withSchema(async ({ baseUrl, pool, migrateTo }) => {
    await migrateTo(migrationsDir());
    const latest = migrationFiles(migrationsDir()).at(-1)?.version;
    assert.ok(latest !== undefined);

    await pool.query("UPDATE schema_migrations SET state = 'pending' WHERE version = $1", [latest]);

    assert.deepEqual(await missingMigrations(pool), [], 'a reserved migration is present, not absent');
    assert.equal((await fetch(`${baseUrl}/v1/ready`)).status, 200);
  });
});

/**
 * The other half of the claim: the stricter probe must not refuse a database that is actually fine,
 * and sign-in must still behave exactly as it did.
 */
test('a fully migrated database is ready, and signs in', { skip }, async () => {
  await withSchema(async ({ baseUrl, pool, migrateTo }) => {
    await migrateTo(migrationsDir());
    assert.deepEqual(await missingMigrations(pool), []);

    assert.equal((await fetch(`${baseUrl}/v1/ready`)).status, 200);

    const handle = `signin_${Date.now().toString(36)}`;
    const password = 'CorrectHorseBattery1';

    const registered = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, password, email: `${handle}@example.test` }),
    });
    assert.equal(registered.status, 201);

    // Password sign-in needs a verified email (audit P1-1): confirm it as the owner would.
    const verification = [...outbox.sent].reverse().find((m) => m.to === `${handle}@example.test`);
    assert.ok(verification, 'registration sent a verification email');
    const verified = await fetch(`${baseUrl}/v1/auth/email/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verification.token }),
    });
    assert.equal(verified.status, 204);

    assert.equal((await login(baseUrl, { handle, password })).status, 200);

    // The failures that must never become 500s, because that is the class of defect this file was
    // opened to rule out.
    assert.equal((await login(baseUrl, { handle, password: 'WrongPassword123' })).status, 401);
    assert.equal(
      (await login(baseUrl, { handle: 'nobody_at_all_here', password })).status,
      401,
      'an unknown handle is a rejection, not a fault, and reads identically to a wrong password',
    );
    assert.equal((await login(baseUrl, { handle })).status, 422, 'a malformed request is the caller’s');
  });
});
