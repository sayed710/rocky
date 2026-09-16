import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBackupRestoreDrill } from '../db-backup-restore-drill.mjs';

test(
  'integration: full backup, isolated restore, and verification drill against live Postgres',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL not set' },
  async () => {
    const sourceUrl = process.env.DATABASE_URL;
    const report = await runBackupRestoreDrill({
      sourceUrl,
      keepTarget: false,
      keepBackup: false,
    });
    assert.equal(report.success, true);
    assert.ok(report.checks.length > 0);
  },
);
