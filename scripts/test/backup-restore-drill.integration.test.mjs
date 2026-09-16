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
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL not set' },
  async () => {
    await withTestDatabase(async ({ pool, connectionString }) => {
      await migrate(pool, migrationsDir);
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
