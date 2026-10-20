import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { GameAuthority, InMemoryPubSub, AuthorityCommitError } from '@chess-platform/realtime-gateway';
import type { TimeControl } from '@chess-platform/game';
import { PostgresEventStore, migrate, migrationsDir } from '@chess-platform/persistence/pg';
import { withTestDatabase } from '@chess-platform/persistence/test-support';

// PostgreSQL only (the pub/sub is in-memory), so these run wherever DATABASE_URL is set.
const stackTest = process.env['DATABASE_URL'] ? test : test.skip;
const TC: TimeControl = { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };

stackTest('PG1: write timeout under SHARE ROW EXCLUSIVE lock rolls back, clears stall and allows next command', { timeout: 30000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const store = new PostgresEventStore(pool);
    const pubsub = new InMemoryPubSub();
    const authority = new GameAuthority(pubsub, () => Date.now(), store, {
      durableWriteTimeoutMs: 300,
    });
    const gameId = randomUUID();
    await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

    const lockClient = await pool.connect();
    try {
      await lockClient.query('BEGIN');
      await lockClient.query('LOCK TABLE game_events IN SHARE ROW EXCLUSIVE MODE');

      // Run a GameAuthority command with small durableWriteTimeoutMs
      await assert.rejects(
        authority.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' }),
        AuthorityCommitError,
      );

      // The abort destroys the connection, so the append settles (rejects) promptly.
      const start = Date.now();
      while (authority.stalledWriteCount() > 0 && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(authority.stalledWriteCount(), 0, 'stall cleared after append settles');
    } finally {
      await lockClient.query('ROLLBACK');
      lockClient.release();
    }

    // Release the lock: NO new rows are present (the transaction rolled back)
    const rows = await pool.query('SELECT * FROM game_events WHERE game_id = $1', [gameId]);
    assert.equal(rows.rowCount, 1, 'only GameCreated event exists, move rolled back');

    // Slot is reconciled (stall cleared), and following command succeeds and appends exactly one event
    const res = await authority.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
    assert.equal(res.state.ply, 1);
    const rowsAfter = await pool.query('SELECT * FROM game_events WHERE game_id = $1', [gameId]);
    assert.equal(rowsAfter.rowCount, 2, 'following command succeeded and appended exactly one event');
  });
});

stackTest('PG2: createGame timeout under SHARE ROW EXCLUSIVE lock rolls back, clears stall, game does not exist, retry succeeds', { timeout: 30000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const store = new PostgresEventStore(pool);
    const pubsub = new InMemoryPubSub();
    const authority = new GameAuthority(pubsub, () => Date.now(), store, {
      durableCreateTimeoutMs: 300,
    });
    const gameId = randomUUID();

    const lockClient = await pool.connect();
    try {
      await lockClient.query('BEGIN');
      await lockClient.query('LOCK TABLE game_events IN SHARE ROW EXCLUSIVE MODE');

      // createGame times out under lock
      await assert.rejects(
        authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false }),
        AuthorityCommitError,
      );

      const start = Date.now();
      while (authority.stalledWriteCount() > 0 && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(authority.stalledWriteCount(), 0, 'stall cleared after create append settles');
    } finally {
      await lockClient.query('ROLLBACK');
      lockClient.release();
    }

    // After release the game does NOT exist
    const rows = await pool.query('SELECT * FROM game_events WHERE game_id = $1', [gameId]);
    assert.equal(rows.rowCount, 0, 'game does not exist');
    assert.equal(await store.exists(gameId), false);

    // Retry with the same id succeeds
    const created = await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });
    assert.equal(created.gameId, gameId);
    const rowsAfter = await pool.query('SELECT * FROM game_events WHERE game_id = $1', [gameId]);
    assert.equal(rowsAfter.rowCount, 1, 'game created successfully');
  });
});
