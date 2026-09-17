import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { migrate } from '@chess-platform/persistence/pg';
import { runBackupRestoreDrill } from '../db-backup-restore-drill.mjs';

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
