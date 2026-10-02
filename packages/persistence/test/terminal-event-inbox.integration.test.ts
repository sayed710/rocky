import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { createPool } from '../src/pg/pool';
import { migrate, migrationFiles, migrationsDir } from '../src/pg/migrate';
import { PgTerminalEventInbox } from '../src/pg/terminal-event-inbox';
import { withTestDatabase } from '../src/test-support/database';
import { TERMINAL_LEASE_MS, TERMINAL_MAX_FAILURES, TERMINAL_RETRY_BASE_MS, TERMINAL_RETRY_CAP_MS } from '../src/terminal-event-retry';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const ending = { type: 'GameEnded', result: '1-0', termination: 'resignation', winner: 'w', at: 0 };

async function insert(pool: Pool, gameId = randomUUID(), version = 1): Promise<string> {
  await pool.query('INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, $2, $3, $4)',
    [gameId, 'GameEnded', version, ending]);
  return gameId;
}

/** Keep real connections/transactions while placing a test-only gate around one statement. */
function interceptQueries(pool: Pool, run: (client: PoolClient, sql: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  return { connect: async () => {
    const client = await pool.connect();
    return { query: (sql: string, values?: unknown[]) => run(client, sql, values), release: () => client.release() };
  } } as unknown as Pool;
}

test('genuine separate pools race to one fenced lease; independent consumers can own the same ending', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, migrationsDir());
    const replica = createPool({ connectionString, max: 2 });
    try {
      const id = await insert(pool);
      let now = 1_000_000;
      const one = new PgTerminalEventInbox(pool, () => now);
      const two = new PgTerminalEventInbox(replica, () => now);
      const claims = await Promise.all([one.claimAfter('bot-analysis', null), two.claimAfter('bot-analysis', null)]);
      assert.equal(claims.filter(Boolean).length, 1, 'simultaneous connections must not both lease');
      const winner = claims.find(Boolean)!;
      assert.equal(winner.lease.gameId, id);
      assert.equal(await two.claimAfter('bot-analysis', null), undefined);
      assert.ok(await two.claimAfter('anti-cheat-analysis', null), 'active bot lease cannot hide anti-cheat work');
      now += TERMINAL_LEASE_MS - 1;
      assert.equal(await one.claimAfter('bot-analysis', null), undefined);
      now++;
      // Crash: drop the worker instance without acknowledging or performing any lease cleanup.
      const afterCrash = new PgTerminalEventInbox(replica, () => now);
      const recovered = await afterCrash.claimAfter('bot-analysis', null);
      assert.ok(recovered);
      assert.notEqual(recovered.lease.token, winner.lease.token);
      assert.equal((await pool.query('SELECT failures FROM terminal_event_retries WHERE consumer = $1', ['bot-analysis'])).rows[0].failures, 0);
      assert.equal(await one.renew(winner.lease), false);
      assert.equal(await one.fail(winner.lease), undefined);
      assert.equal(await one.acknowledge(winner.lease), false);
      assert.equal(await afterCrash.acknowledge(recovered.lease), true);
      assert.equal(await afterCrash.acknowledge(recovered.lease), false, 'replayed completion is harmless');
      assert.equal((await pool.query('SELECT 1 FROM terminal_event_retries WHERE consumer = $1', ['bot-analysis'])).rowCount, 0, 'success must clear the lease');
      now += TERMINAL_RETRY_CAP_MS;
      assert.equal(await two.claimAfter('bot-analysis', null), undefined);
      assert.equal((await pool.query('SELECT 1 FROM terminal_event_receipts WHERE consumer = $1', ['bot-analysis'])).rowCount, 1);
    } finally { await replica.end(); }
  });
});

test('parallel failure recordings count exactly once per owned attempt; due filtering survives restart and grows to cap', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, migrationsDir());
    const replica = createPool({ connectionString, max: 2 });
    try {
      await insert(pool);
      let now = 1_000_000;
      const one = new PgTerminalEventInbox(pool, () => now);
      const two = new PgTerminalEventInbox(replica, () => now);
      for (let attempt = 1; attempt <= 12; attempt++) {
        const claim = await one.claimAfter('anti-cheat-analysis', null);
        assert.ok(claim);
        const results = await Promise.all([one.fail(claim.lease), two.fail(claim.lease)]);
        assert.equal(results.filter(Boolean).length, 1);
        const failure = results.find(Boolean)!;
        assert.equal(failure.failures, attempt);
        assert.equal(failure.nextRetryAt - now, Math.min(TERMINAL_RETRY_CAP_MS, TERMINAL_RETRY_BASE_MS * 2 ** (attempt - 1)));
        assert.equal(await two.claimAfter('anti-cheat-analysis', null), undefined);
        const restarted = new PgTerminalEventInbox(replica, () => now);
        now = failure.nextRetryAt - 1;
        assert.equal(await restarted.claimBefore('anti-cheat-analysis', { gameId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', seq: 0 }), undefined);
        assert.equal((await pool.query('SELECT 1 FROM terminal_event_receipts')).rowCount, 0);
        now++;
      }
      const claim = await one.claimAfter('anti-cheat-analysis', null);
      assert.ok(claim);
      await pool.query('UPDATE terminal_event_retries SET failures = $1', [TERMINAL_MAX_FAILURES]);
      assert.equal((await two.fail(claim.lease))?.failures, TERMINAL_MAX_FAILURES, 'saturation never wraps or drops work');
    } finally { await replica.end(); }
  });
});

test('renewed leases cannot expire at their original deadline; stale and expired owners cannot renew', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    await insert(pool);
    let now = 1_000_000;
    const inbox = new PgTerminalEventInbox(pool, () => now);
    const first = await inbox.claimAfter('bot-analysis', null);
    assert.ok(first);
    now += TERMINAL_LEASE_MS - 1;
    assert.equal(await inbox.renew(first.lease), true);
    now += 1;
    assert.equal(await inbox.claimAfter('bot-analysis', null), undefined);
    now += TERMINAL_LEASE_MS;
    assert.equal(await inbox.renew(first.lease), false);
    assert.ok(await inbox.claimAfter('bot-analysis', null));
  });
});

test('acknowledgement and concurrent claims never reappear; receipt and cleanup roll back together on failure', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, migrationsDir());
    const replica = createPool({ connectionString, max: 2 });
    try {
      const inbox = new PgTerminalEventInbox(pool);
      const other = new PgTerminalEventInbox(replica);
      for (let n = 0; n < 12; n++) {
        await insert(pool);
        const claim = await inbox.claimAfter('bot-analysis', null);
        assert.ok(claim);
        const [ack, competing] = await Promise.all([inbox.acknowledge(claim.lease), other.claimAfter('bot-analysis', null)]);
        assert.equal(ack, true);
        assert.equal(competing, undefined);
        assert.equal(await other.claimAfter('bot-analysis', null), undefined);
      }
      await insert(pool);
      const claim = await inbox.claimAfter('bot-analysis', null);
      assert.ok(claim);
      // A test-only constraint fails the receipt INSERT after the scheduling DELETE.
      await pool.query(`ALTER TABLE terminal_event_receipts ADD CONSTRAINT injected_failure CHECK (consumer <> 'bot-analysis') NOT VALID`);
      await assert.rejects(inbox.acknowledge(claim.lease), /injected_failure/);
      assert.equal((await pool.query('SELECT 1 FROM terminal_event_retries WHERE game_id = $1', [claim.lease.gameId])).rowCount, 1);
      await pool.query('ALTER TABLE terminal_event_receipts DROP CONSTRAINT injected_failure');
      assert.equal(await inbox.acknowledge(claim.lease), true);
    } finally { await replica.end(); }
  });
});

test('a receipt committed after the candidate snapshot prevents a fresh lease', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, migrationsDir());
    const replica = createPool({ connectionString, max: 1 });
    const gate = await pool.connect();
    const gateKey = 1_540_048;
    let gateLocked = false;
    let releaseAcknowledgement!: () => void;
    const acknowledgementGate = new Promise<void>((resolve) => { releaseAcknowledgement = resolve; });
    let reachedCommit!: () => void;
    const atCommit = new Promise<void>((resolve) => { reachedCommit = resolve; });
    let acknowledged: Promise<boolean> | undefined;
    let competing: ReturnType<PgTerminalEventInbox['claimAfter']> | undefined;
    try {
      const id = await insert(pool);
      let now = 1_000_000;
      const owner = new PgTerminalEventInbox(pool, () => now);
      const claim = await owner.claimAfter('bot-analysis', null);
      assert.ok(claim);
      await gate.query('SELECT pg_advisory_lock($1)', [gateKey]);
      gateLocked = true;

      const completing = new PgTerminalEventInbox(interceptQueries(pool, async (client, sql, values) => {
        if (sql === 'COMMIT') {
          reachedCommit();
          await acknowledgementGate;
        }
        return client.query(sql, values);
      }), () => now);
      acknowledged = completing.acknowledge(claim.lease);
      await Promise.race([atCommit, acknowledged.then(() => assert.fail('completion must reach its commit gate'))]);
      // Ownership was checked while valid; its receipt and retry deletion are still uncommitted.
      now += TERMINAL_LEASE_MS;
      let candidateGameId: string | undefined;
      let candidatePid: number | undefined;
      const contender = new PgTerminalEventInbox(interceptQueries(replica, async (client, sql, values) => {
        if (sql.startsWith('SELECT ended.game_id')) {
          candidatePid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          // PostgreSQL fixes this statement's MVCC snapshot before the CTE blocks. The CTE
          // must finish before LockRows can obtain the event lock; eligibility is unchanged.
          const gatedSql = `WITH candidate_snapshot_gate AS MATERIALIZED (SELECT pg_advisory_xact_lock(${gateKey}))\n` +
            sql.replace('FROM game_events AS ended', 'FROM candidate_snapshot_gate CROSS JOIN game_events AS ended');
          const result = await client.query(gatedSql, values);
          candidateGameId = result.rows[0]?.game_id;
          return result;
        }
        return client.query(sql, values);
      }), () => now);
      competing = contender.claimAfter('bot-analysis', null);
      void competing.catch(() => undefined); // Observe failures while the test is waiting at the barrier.
      // Observe the genuine backend wait rather than infer snapshot ordering from a sleep.
      let waiting = false;
      const waitDeadline = Date.now() + 2_000;
      while (!waiting && Date.now() < waitDeadline) {
        const locks = await pool.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = $2 AND NOT granted',
          [candidatePid ?? null, 'advisory']);
        waiting = locks.rowCount === 1;
      }
      assert.equal(waiting, true, 'candidate statement must hold its pre-commit snapshot at the advisory gate');
      releaseAcknowledgement();
      assert.equal(await acknowledged, true);
      await gate.query('SELECT pg_advisory_unlock($1)', [gateKey]);
      gateLocked = false;
      assert.equal(await competing, undefined, 'fresh receipt check must reject the stale candidate');
      assert.equal(candidateGameId, id, 'candidate SELECT must actually return the old snapshot, not skip the receipt');
      assert.equal((await pool.query('SELECT 1 FROM terminal_event_receipts WHERE game_id = $1', [id])).rowCount, 1);
      assert.equal((await pool.query('SELECT 1 FROM terminal_event_retries WHERE game_id = $1', [id])).rowCount, 0);
    } finally {
      releaseAcknowledgement();
      if (gateLocked) await gate.query('SELECT pg_advisory_unlock($1)', [gateKey]).catch(() => undefined);
      await Promise.allSettled([acknowledged, competing].filter((promise) => promise !== undefined));
      gate.release();
      await replica.end();
    }
  });
});

test('decode corruption takes the same lease and backoff while healthy work remains claimable', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const poison = await insert(pool, '00000000-0000-7000-8000-000000000001', 99);
    const healthy = await insert(pool, '00000000-0000-7000-8000-000000000002');
    let now = 1_000_000;
    const inbox = new PgTerminalEventInbox(pool, () => now);
    const bad = await inbox.claimAfter('bot-analysis', null);
    assert.ok(bad && 'decodeError' in bad.work);
    await inbox.fail(bad.lease);
    const good = await inbox.claimAfter('bot-analysis', null);
    assert.equal(good?.lease.gameId, healthy);
    assert.ok(good);
    await inbox.acknowledge(good.lease);
    assert.equal(await inbox.claimAfter('bot-analysis', null), undefined);
    now += TERMINAL_RETRY_BASE_MS;
    const due = await inbox.claimBefore('bot-analysis', { gameId: healthy, seq: 0 });
    assert.equal(due?.lease.gameId, poison);
    assert.ok(due && 'decodeError' in due.work);
  });
});

test('malformed current-version endings cannot become successful abort receipts', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const id = randomUUID();
    await pool.query('INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, $2, 1, $3)',
      [id, 'GameEnded', { type: 'GameEnded', result: '*' }]);
    const inbox = new PgTerminalEventInbox(pool);
    const claim = await inbox.claimAfter('bot-analysis', null);
    assert.ok(claim && 'decodeError' in claim.work, 'missing ending fields must reach the failure path before abort handling');
    assert.equal((await inbox.fail(claim.lease))?.failures, 1);
    assert.equal(await inbox.claimAfter('bot-analysis', null), undefined);
    assert.equal((await pool.query('SELECT 1 FROM terminal_event_receipts WHERE game_id = $1', [id])).rowCount, 0);
  });
});

test('0047 upgrade preserves receipts and reports, manufactures no attempts, and enforces retry constraints', { skip }, async () => {
  const prior = mkdtempSync(join(tmpdir(), 'trust-retry-schema-'));
  for (const migration of migrationFiles(migrationsDir())) {
    if (migration.version <= 47) copyFileSync(join(migrationsDir(), migration.file), join(prior, migration.file));
  }
  try {
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, prior);
      const completed = await insert(pool);
      const pending = await insert(pool);
      await pool.query('INSERT INTO terminal_event_receipts (consumer, game_id, seq) VALUES ($1, $2, 0)', ['bot-analysis', completed]);
      for (const table of ['bot_reports', 'anti_cheat_reports']) {
        await pool.query(`INSERT INTO ${table} (player_id, game_id, color, report) VALUES ($1, $2, 'white', $3)`, [randomUUID(), completed, { fixture: 'existing evidence' }]);
      }
      const before = await pool.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
      const bot = (await pool.query('SELECT * FROM bot_reports')).rows;
      const cheat = (await pool.query('SELECT * FROM anti_cheat_reports')).rows;
      await migrate(pool, migrationsDir());
      assert.deepEqual((await pool.query('SELECT version, checksum FROM schema_migrations WHERE version <= 47 ORDER BY version')).rows, before.rows);
      assert.deepEqual((await pool.query('SELECT * FROM bot_reports')).rows, bot);
      assert.deepEqual((await pool.query('SELECT * FROM anti_cheat_reports')).rows, cheat);
      assert.equal((await pool.query('SELECT 1 FROM terminal_event_retries')).rowCount, 0);
      const inbox = new PgTerminalEventInbox(pool);
      const claim = await inbox.claimAfter('bot-analysis', null);
      assert.equal(claim?.lease.gameId, pending);
      assert.equal((await pool.query('SELECT failures FROM terminal_event_retries')).rows[0].failures, 0);
      await assert.rejects(pool.query('UPDATE terminal_event_retries SET failures = -1'), /check constraint/);
      await assert.rejects(pool.query("UPDATE terminal_event_retries SET consumer = 'attacker'"), /check constraint/);
      await assert.rejects(pool.query('UPDATE terminal_event_retries SET lease_until = NULL'), /check constraint/);
      await assert.rejects(pool.query("UPDATE terminal_event_retries SET next_retry_at = 'infinity'"), /check constraint/);
      await assert.rejects(pool.query('UPDATE terminal_event_retries SET lease_until = next_retry_at'), /check constraint/);
      await assert.rejects(pool.query('DELETE FROM game_events WHERE game_id = $1', [pending]), /append-only/);
      assert.equal((await pool.query("SELECT confdeltype FROM pg_constraint WHERE conrelid = 'terminal_event_retries'::regclass AND contype = 'f'")).rows[0].confdeltype, 'a', 'same NO ACTION deletion semantics as receipts');
      await assert.rejects(pool.query('INSERT INTO terminal_event_retries (consumer, game_id, seq) VALUES ($1, $2, 0)', ['bot-analysis', randomUUID()]), /foreign key/);
    });
  } finally { rmSync(prior, { recursive: true }); }
});
