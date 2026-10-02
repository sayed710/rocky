import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { migrate } from '@chess-platform/persistence/pg';
import { runBackupRestoreDrill } from '../db-backup-restore-drill.mjs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgTerminalEventInbox } from '@chess-platform/persistence/pg';
import { TERMINAL_LEASE_MS, TERMINAL_RETRY_BASE_MS } from '@chess-platform/persistence';

const migrationsDir = resolve(fileURLToPath(import.meta.url), '../../../packages/persistence/migrations');

test(
  'integration: full backup, isolated restore, and verification drill against live Postgres',
  async () => {
    assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for live Postgres integration drill');
    await withTestDatabase(async ({ pool, connectionString }) => {
      pool.on('error', () => {});
      await migrate(pool, migrationsDir);
      await pool.end();
      const report = await runBackupRestoreDrill({
        sourceUrl: connectionString,
        keepTarget: false,
        keepBackup: false,
      });
      assert.equal(report.success, true);
      assert.ok(report.checks.length > 0);
    });
  },
);

test('integration: retry deadlines, active leases and successful receipts survive a logical backup/restore', async () => {
  assert.ok(process.env.DATABASE_URL);
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, migrationsDir);
    let now = Date.now();
    const inbox = new PgTerminalEventInbox(pool, () => now);
    const ids = [1, 2, 3].map(n => `00000000-0000-7000-8000-00000000000${n}`);
    for (const id of ids) {
      await pool.query(`INSERT INTO game_events (game_id, seq, type, payload) VALUES ($1, 0, 'GameEnded', $2)`,
        [id, { type: 'GameEnded', result: '1-0', termination: 'resignation', winner: 'w', at: 0 }]);
    }
    const failed = await inbox.claimAfter('bot-analysis', null);
    assert.ok(failed);
    await inbox.fail(failed.lease);
    const active = await inbox.claimAfter('bot-analysis', null);
    assert.ok(active);
    const completed = await inbox.claimAfter('bot-analysis', active.lease);
    assert.ok(completed);
    await inbox.acknowledge(completed.lease);
    const retries = (await pool.query('SELECT * FROM terminal_event_retries ORDER BY game_id')).rows;
    const receipts = (await pool.query('SELECT * FROM terminal_event_receipts ORDER BY game_id')).rows;
    const targetName = `gambit_backup_drill_restore_trust_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const targetUrl = new URL(connectionString);
    targetUrl.pathname = `/${targetName}`;
    const adminUrl = new URL(connectionString);
    adminUrl.pathname = '/postgres';
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
    let ownsTarget = false;
    let restored;
    try {
      assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetName])).rowCount, 0);
      ownsTarget = true;
      const report = await runBackupRestoreDrill({ sourceUrl: connectionString, targetUrl: targetUrl.toString(), keepTarget: true, keepBackup: false });
      assert.equal(report.success, true);
      restored = new pg.Pool({ connectionString: targetUrl.toString() });
      assert.deepEqual((await restored.query('SELECT * FROM terminal_event_retries ORDER BY game_id')).rows, retries);
      assert.deepEqual((await restored.query('SELECT * FROM terminal_event_receipts ORDER BY game_id')).rows, receipts);
      const restoredInbox = new PgTerminalEventInbox(restored, () => now);
      assert.equal(await restoredInbox.claimAfter('bot-analysis', null), undefined);
      now += TERMINAL_RETRY_BASE_MS;
      const due = await restoredInbox.claimAfter('bot-analysis', null);
      assert.equal(due?.lease.gameId, ids[0]);
      await restoredInbox.acknowledge(due.lease);
      now += TERMINAL_LEASE_MS - TERMINAL_RETRY_BASE_MS;
      const recovered = await restoredInbox.claimAfter('bot-analysis', null);
      assert.equal(recovered?.lease.gameId, ids[1]);
      assert.notEqual(recovered?.lease.token, active.lease.token);
      await restoredInbox.acknowledge(recovered.lease);
      assert.equal(await restoredInbox.claimAfter('bot-analysis', null), undefined, 'all receipts remain authoritative');
    } finally {
      await restored?.end();
      // This exact marker-prefixed name was verified absent before this test created it.
      if (ownsTarget) await admin.query(`DROP DATABASE IF EXISTS "${targetName}"`);
      await admin.end();
    }
  });
});
