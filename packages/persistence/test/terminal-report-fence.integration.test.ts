import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { StoredBotReport, StoredPlayerReport } from '@chess-platform/anti-cheat';
import type { TerminalConsumer, TerminalEventLease } from '../src/event-store';
import { PgAntiCheatReportRepository } from '../src/pg/anti-cheat';
import { PgBotBehaviorReportRepository } from '../src/pg/bot-reports';
import { PgTerminalEventInbox } from '../src/pg/terminal-event-inbox';
import { migrate, migrationsDir } from '../src/pg/migrate';
import { withTestDatabase } from '../src/test-support/database';
import { TERMINAL_LEASE_MS } from '../src/terminal-event-retry';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function intercepted(pool: Pool, run: (client: PoolClient, sql: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  return { connect: async () => {
    const client = await pool.connect();
    return { query: (sql: string, values?: unknown[]) => run(client, sql, values), release: () => client.release() };
  } } as unknown as Pool;
}
async function insert(pool: Pool): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, $2, 1, $3)',
    [id, 'GameEnded', { type: 'GameEnded', result: '1-0', termination: 'resignation', winner: 'w', at: 0 }]);
  return id;
}
function writer(pool: Pool, lease: TerminalEventLease, now: () => number, playerId: string, signal?: AbortSignal) {
  const fence = { lease, now, ...(signal ? { signal } : {}) };
  // Distinct JSON markers expose an overwritten result; report calculation is outside this persistence test.
  return lease.consumer === 'bot-analysis'
    ? (marker: string) => new PgBotBehaviorReportRepository(pool, fence).saveBatch([
      { gameId: lease.gameId, playerId, color: 'white', report: { marker } } as unknown as StoredBotReport,
    ])
    : (marker: string) => new PgAntiCheatReportRepository(pool, fence).saveBatch([
      { gameId: lease.gameId, playerId, color: 'white', report: { marker } } as unknown as StoredPlayerReport,
    ]);
}

for (const consumer of ['bot-analysis', 'anti-cheat-analysis'] as const satisfies readonly TerminalConsumer[]) {
  const table = consumer === 'bot-analysis' ? 'bot_reports' : 'anti_cheat_reports';
  test(`${consumer} late stale report cannot overwrite a replacement report or its receipt`, { skip }, async () => {
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, migrationsDir());
      const gameId = await insert(pool);
      const playerId = randomUUID();
      let now = Date.now();
      const inbox = new PgTerminalEventInbox(pool, () => now);
      const first = (await inbox.claimAfter(consumer, null))!;
      const entered = deferred();
      const resume = deferred();
      const delayed = intercepted(pool, async (client, sql, values) => {
        if (sql === 'BEGIN') { entered.resolve(); await resume.promise; }
        return client.query(sql, values);
      });
      const stale = writer(delayed, first.lease, () => now, playerId)('stale');
      // Attach rejection handling before releasing the blocked real connection.
      const rejected = assert.rejects(stale, /lease|ownership/i);
      try {
        await entered.promise;
        now += TERMINAL_LEASE_MS;
        const replacement = (await inbox.claimAfter(consumer, null))!;
        assert.notEqual(first.lease.token, replacement.lease.token);
        await writer(pool, replacement.lease, () => now, playerId)('replacement');
        assert.equal(await inbox.acknowledge(replacement.lease), true);
      } finally { resume.resolve(); }
      await rejected;
      assert.deepEqual((await pool.query(`SELECT report FROM ${table} WHERE game_id = $1`, [gameId])).rows, [{ report: { marker: 'replacement' } }]);
      assert.equal((await pool.query('SELECT 1 FROM terminal_event_receipts WHERE game_id = $1 AND consumer = $2', [gameId, consumer])).rowCount, 1);
      assert.equal((await pool.query('SELECT 1 FROM terminal_event_retries WHERE game_id = $1 AND consumer = $2', [gameId, consumer])).rowCount, 0);
      const record = { gameId, playerId, color: 'white', report: { marker: 'wrong-scope' } } as unknown as StoredBotReport & StoredPlayerReport;
      const wrongConsumer = { ...first.lease, consumer: consumer === 'bot-analysis' ? 'anti-cheat-analysis' : 'bot-analysis' } as const;
      const make = (lease: TerminalEventLease) => consumer === 'bot-analysis'
        ? new PgBotBehaviorReportRepository(pool, { lease })
        : new PgAntiCheatReportRepository(pool, { lease });
      await assert.rejects(make(wrongConsumer).saveBatch([record]), /does not match/);
      await assert.rejects(make(first.lease).saveBatch([{ ...record, gameId: randomUUID() }]), /does not match/);
      assert.deepEqual((await pool.query(`SELECT report FROM ${table} WHERE game_id = $1`, [gameId])).rows, [{ report: { marker: 'replacement' } }]);
    });
  });

  test(`${consumer} expiry or cancellation during report writes rolls back before replacement`, { skip }, async () => {
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, migrationsDir());
      let now = Date.now();
      const inbox = new PgTerminalEventInbox(pool, () => now);
      for (const reason of ['expiry', 'cancellation'] as const) {
        const gameId = await insert(pool);
        const playerId = randomUUID();
        const claim = (await inbox.claimAfter(consumer, null))!;
        const controller = new AbortController();
        const entered = deferred();
        const resume = deferred();
        const blocked = intercepted(pool, async (client, sql, values) => {
          const result = await client.query(sql, values);
          if (sql.includes(`INSERT INTO ${table}`)) { entered.resolve(); await resume.promise; }
          return result;
        });
        const pending = writer(blocked, claim.lease, () => now, playerId, controller.signal)('stale');
        const rejected = assert.rejects(pending, /lease|ownership|cancelled/i);
        try {
          await entered.promise;
          if (reason === 'expiry') now += TERMINAL_LEASE_MS;
          else controller.abort(new Error('cancelled'));
          assert.equal(await inbox.claimAfter(consumer, null), undefined, 'short report transaction excludes a replacement until it settles');
        } finally { resume.resolve(); }
        await rejected;
        assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE game_id = $1`, [gameId])).rowCount, 0, 'uncommitted stale report must roll back');
        if (reason === 'cancellation') now += TERMINAL_LEASE_MS;
        const replacement = (await inbox.claimAfter(consumer, null))!;
        await writer(pool, replacement.lease, () => now, playerId)('replacement');
        assert.equal(await inbox.acknowledge(replacement.lease), true);
        assert.deepEqual((await pool.query(`SELECT report FROM ${table} WHERE game_id = $1`, [gameId])).rows, [{ report: { marker: 'replacement' } }]);
      }
    });
  });
}
