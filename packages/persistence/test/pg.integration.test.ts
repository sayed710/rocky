import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';
import { ENGINE_BOT_USER_IDS, Game, type GameEvent } from '@chess-platform/game';
import { createPool } from '../src/pg/pool';
import { migrate, migrationChecksum, readMigrationSql } from '../src/pg/migrate';
import { PostgresEventStore } from '../src/pg/event-store';
import { PgGamesRepository, PgSeeksRepository, PgSeekAcceptor, PgGameStarter, PgUsersRepository } from '../src/pg/repositories';
import { uuidv7 } from '../src/ids';
import { ConcurrencyError, PlayerLockUnavailableError } from '../src/errors';
import { withTestDatabase } from '../src/test-support/database';

// Integration tests need a real Postgres. They SKIP (not fail) when DATABASE_URL
// is unset, so dependency-free suites still run everywhere (incl. CI before a DB).
const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

/**
 * Every test here that writes takes a disposable database of its own.
 *
 * This file cannot meet the obligation the other shared-database suites meet — remove what you
 * created — because it appends to `game_events`, and that table is append-only by production
 * trigger (`game_events_block_mutate`, migration 0001): `DELETE` raises. Cleaning up after itself
 * would mean weakening a production safety rule to suit a test, so the honest alternative is to
 * stop writing into a database it shares. The rows it used to leave behind were not harmless: a
 * `games` row referencing one of its users is what made the achievements suite's cleanup abort
 * with SQLSTATE 23503 on every reused database.
 *
 * Two of these tests also edit `schema_migrations` deliberately — setting a checksum the runner
 * must reject, or marking an online index pending — which no other suite may observe. That used
 * to rest on `--test-concurrency=1` keeping files apart. On a database nobody else can reach, it
 * rests on nothing.
 */
const isolated = { connectionString: DATABASE_URL, max: 4 } as const;

test('migrations apply and are idempotent', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    const dir = join(process.cwd(), 'migrations');
    await migrate(pool, dir);

    const index = await pool.query<{
      indisvalid: boolean;
      columns: string;
      definition: string;
      predicate: string;
    }>(
      `SELECT i.indisvalid,
              array_to_string(ARRAY(
                SELECT a.attname
                  FROM unnest(i.indkey) WITH ORDINALITY AS indexed_column(attnum, position)
                  JOIN pg_attribute a
                    ON a.attrelid = i.indrelid AND a.attnum = indexed_column.attnum
                 ORDER BY indexed_column.position
              ), ',') AS columns,
              pg_get_indexdef(i.indexrelid) AS definition,
              pg_get_expr(i.indpred, i.indrelid) AS predicate
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'community_join_requests_pending_by_player_idx'`,
    );
    assert.equal(index.rows[0]?.indisvalid, true);
    assert.equal(index.rows[0]?.columns, 'player_id,created_at,id');
    assert.match(index.rows[0]?.definition ?? '', /\(player_id, created_at DESC, id\)/);
    assert.match(index.rows[0]?.predicate ?? '', /status/);
    assert.match(index.rows[0]?.predicate ?? '', /'pending'/);

    const activePlayersIndex = await pool.query<{ indisvalid: boolean; definition: string; predicate: string }>(
      `SELECT i.indisvalid,
              pg_get_indexdef(i.indexrelid) AS definition,
              pg_get_expr(i.indpred, i.indrelid) AS predicate
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'game_events_active_players_idx'`,
    );
    assert.equal(activePlayersIndex.rows[0]?.indisvalid, true);
    assert.match(activePlayersIndex.rows[0]?.definition ?? '', /USING gin/);
    assert.match(activePlayersIndex.rows[0]?.definition ?? '', /payload\s*->\s*'players'/);
    assert.match(activePlayersIndex.rows[0]?.predicate ?? '', /seq = 0/);
    assert.match(activePlayersIndex.rows[0]?.predicate ?? '', /GameCreated/);

    assert.equal(await migrate(pool, dir), 0, 're-running applies nothing');

    await pool.query("UPDATE schema_migrations SET state = 'pending' WHERE version = 23");
    assert.equal(await migrate(pool, dir), 1, 're-running completes an interrupted online index');
    const migration = await pool.query<{ state: string }>(
      'SELECT state FROM schema_migrations WHERE version = 23',
    );
    assert.equal(migration.rows[0]?.state, 'applied');
  }, isolated);
});

test('the ledger is portable across checkouts but still rejects edits', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    const dir = join(process.cwd(), 'migrations');
    const file = '0023_community_pending_join_requests_index.sql';
    const version = 23;
    const canonical = migrationChecksum(readMigrationSql(dir, file));
    /** The checksum recorded for this migration, or undefined if it has no row. */
    const readChecksum = async (): Promise<string | undefined> =>
      (
        await pool.query<{ checksum: string }>(
          'SELECT checksum FROM schema_migrations WHERE version = $1',
          [version],
        )
      ).rows[0]?.checksum;

    /**
     * Overwrite this migration's recorded checksum.
     *
     * This deliberately leaves a checksum the runner must reject. It used to need restoring in a
     * `finally`, and a comment explaining that `--test-concurrency=1` was what kept any other file
     * from migrating against the corrupted ledger meanwhile. The database is this test's own now
     * and is dropped when it returns, so there is nothing to restore and nobody to protect.
     */
    const setChecksum = async (checksum: string): Promise<void> => {
      await pool.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [
        version,
        checksum,
      ]);
    };

    await migrate(pool, dir);
    assert.equal(await readChecksum(), canonical, 'a fresh run records the canonical checksum');

    // A ledger written by the pre-canonicalization runner on a Windows checkout
    // holds the CRLF rendering of this very file. That is the same migration, so
    // the run must succeed — and converge the row onto the canonical checksum.
    const legacyCrlf = createHash('sha256')
      .update(readMigrationSql(dir, file).replace(/\n/g, '\r\n'), 'utf8')
      .digest('hex');
    assert.notEqual(legacyCrlf, canonical, 'the CRLF rendering must differ, or this proves nothing');

    await setChecksum(legacyCrlf);
    assert.equal(await migrate(pool, dir), 0, 'a CRLF-era ledger applies nothing');
    assert.equal(await readChecksum(), canonical, 'the legacy checksum is healed in place');

    // An actual edit to an applied migration matches neither rendering.
    await setChecksum(createHash('sha256').update('edited migration', 'utf8').digest('hex'));
    await assert.rejects(migrate(pool, dir), /changed after being applied; history is immutable/);
  }, isolated);
});

test('postgres event store: round-trip and optimistic concurrency', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const store = new PostgresEventStore(pool);
    const gameId = uuidv7();
    const timeControl = { initialMs: 60_000, incrementMs: 1_000, delayMs: 0, kind: 'increment' as const };

    let { game, events } = Game.create({
      gameId,
      timeControl,
      players: { white: 'a', black: 'b' },
      rated: false,
      at: 1000,
    });
    let head = await store.append(gameId, -1, events);
    let t = 2000;
    for (const uci of ['e2e4', 'c7c5', 'g1f3']) {
      ({ game, events } = game.playMove(uci, t));
      head = await store.append(gameId, head, events);
      t += 1000;
    }

    const stored = await store.load(gameId);
    const rebuilt = Game.fromEvents(stored.map((s) => s.event));
    assert.equal(rebuilt.snapshot().position.fen(), game.snapshot().position.fen());
    assert.equal(head, stored.length - 1);

    // A second append at a stale head is rejected.
    await assert.rejects(store.append(gameId, -1, events), ConcurrencyError);
  }, isolated);
});

test('postgres event store finds only unended games for either player seat', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const store = new PostgresEventStore(pool);
    const target = uuidv7();
    const opponent = uuidv7();
    const activeGameId = uuidv7();
    const activeBlackGameId = uuidv7();
    const finishedGameId = uuidv7();
    const olderFinishedGameId = uuidv7();
    const unrelatedGameId = uuidv7();
    const botGameId = uuidv7();
    const event = (gameId: string, players: { white: string; black: string }): GameEvent => ({
      type: 'GameCreated',
      gameId,
      variant: 'standard',
      initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      players,
      rated: true,
      at: 1,
    });
    await store.append(activeGameId, -1, [event(activeGameId, { white: target, black: opponent })]);
    await store.append(activeBlackGameId, -1, [event(activeBlackGameId, { white: opponent, black: target })]);
    await store.append(finishedGameId, -1, [event(finishedGameId, { white: opponent, black: target })]);
    await store.append(finishedGameId, 0, [{
      type: 'GameEnded',
      result: '1-0',
      termination: 'resignation',
      winner: 'w',
      at: 2,
    }]);
    await store.append(olderFinishedGameId, -1, [event(olderFinishedGameId, { white: target, black: opponent })]);
    await store.append(olderFinishedGameId, 0, [{
      type: 'GameEnded',
      result: '1-0',
      termination: 'resignation',
      winner: 'w',
      at: 3,
    }]);
    await store.append(unrelatedGameId, -1, [event(unrelatedGameId, { white: opponent, black: uuidv7() })]);
    await store.append(botGameId, -1, [event(botGameId, { white: target, black: ENGINE_BOT_USER_IDS.novice })]);

    const found = await store.findActiveGamesByPlayer(target);
    assert.deepEqual(found.map(({ gameId }) => gameId).sort(),
      [activeGameId, activeBlackGameId, botGameId].sort());
    assert.deepEqual(found.find(({ gameId }) => gameId === activeGameId)?.players,
      { white: target, black: opponent });
    assert.deepEqual(found.find(({ gameId }) => gameId === activeBlackGameId)?.players,
      { white: opponent, black: target });
    assert.deepEqual(await store.findActiveGamesByPlayer(uuidv7()), []);

    try {
      const lockedPlayer = uuidv7();
      const blockedGameId = uuidv7();
      const release = await store.acquirePlayerLock(lockedPlayer);
      let appendSettled = false;
      let appendError: unknown;
      let blockedAppend: Promise<void> | undefined;
      try {
        blockedAppend = store.append(blockedGameId, -1, [event(blockedGameId, {
          white: lockedPlayer,
          black: uuidv7(),
        })]).then(() => {
          appendSettled = true;
        }, (error: unknown) => {
          appendError = error;
          appendSettled = true;
        });
        // Observe the actual PostgreSQL backend waiting on the transaction advisory lock.
        // A fixed sleep could pass before append had even acquired a pooled connection.
        const deadline = Date.now() + 10_000;
        let waiting = false;
        while (!waiting && !appendSettled && Date.now() < deadline) {
          const observed = await pool.query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1
                 FROM pg_locks AS lock
                 JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
                WHERE activity.datname = current_database()
                  AND lock.locktype = 'advisory'
                  AND NOT lock.granted
                  AND activity.query LIKE '%pg_advisory_xact_lock%'
             ) AS waiting`,
          );
          waiting = observed.rows[0]?.waiting ?? false;
          if (!waiting) await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.equal(waiting, true, 'human-game append must reach and wait at the PostgreSQL advisory lock');
        assert.equal(appendSettled, false, 'human-game creation must not cross the held delivery lock');
      } finally {
        await release();
      }
      await release(); // the response cleanup path must be idempotent
      assert.ok(blockedAppend);
      await blockedAppend;
      if (appendError) throw appendError;
      assert.equal(appendSettled, true);
    } finally {
      await store.closePlayerLocks();
    }
  }, isolated);
});

test('advisory locks leave even a one-client query pool available', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const databaseUrl = new URL(connectionString);
    const queryPool = new Pool({
      host: databaseUrl.hostname,
      port: Number(databaseUrl.port || 5432),
      user: decodeURIComponent(databaseUrl.username),
      password: decodeURIComponent(databaseUrl.password),
      database: decodeURIComponent(databaseUrl.pathname.slice(1)),
      max: 1,
    });
    const store = new PostgresEventStore(queryPool);
    let releaseFirst: (() => Promise<void>) | undefined;
    let releaseSecond: (() => Promise<void>) | undefined;
    try {
      releaseFirst = await store.acquirePlayerLock(uuidv7());
      assert.equal(queryPool.idleCount, queryPool.totalCount,
        'player locks must not check out query-pool clients');
      releaseSecond = await store.acquirePlayerLock(uuidv7());
      assert.deepEqual(await store.findActiveGamesByPlayer(uuidv7()), []);
    } finally {
      await releaseSecond?.();
      await releaseFirst?.();
      await store.closePlayerLocks();
      await queryPool.end();
    }
    await assert.rejects(store.acquirePlayerLock(uuidv7()), /player lock pool is closed/);
  }, isolated);
});

test('same-player lock waiters cannot exhaust capacity for an unrelated player', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    const store = new PostgresEventStore(pool);
    const playerId = uuidv7();
    const releaseHolder = await store.acquirePlayerLock(playerId);
    const lockPool = (store as unknown as { playerLockPool: Pool }).playerLockPool;
    assert.ok(lockPool, 'holder must initialize the real advisory-lock pool');
    const capacity = lockPool.options.max ?? 10;
    const connection = lockPool as unknown as { connect: () => Promise<import('pg').PoolClient> };
    const originalConnect = connection.connect.bind(lockPool);
    let attempts = 0;
    let reachedCapacity!: () => void;
    const allAttempted = new Promise<void>((resolve) => { reachedCapacity = resolve; });
    connection.connect = () => {
      attempts += 1;
      if (attempts === capacity - 1) reachedCapacity();
      return originalConnect();
    };
    const waiters = Array.from({ length: capacity * 2 }, () => store.acquirePlayerLock(playerId));
    try {
      await allAttempted;
      const releaseUnrelated = await store.acquirePlayerLock(uuidv7());
      await releaseUnrelated();
    } finally {
      connection.connect = originalConnect;
      await releaseHolder();
      const settled = await Promise.allSettled(waiters.map(async (waiter) => (await waiter)()));
      await store.closePlayerLocks();
      assert.ok(settled.every((result) => result.status === 'fulfilled'), 'every same-player waiter eventually acquires');
    }
  }, isolated);
});

test('exhausted advisory-lock pool raises a typed temporary refusal', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    const store = new PostgresEventStore(pool);
    const releases: Array<() => Promise<void>> = [];
    try {
      // Distinct users legitimately hold every connection; the next checkout must time out.
      releases.push(await store.acquirePlayerLock(uuidv7()));
      const lockPool = (store as unknown as { playerLockPool: Pool }).playerLockPool;
      assert.ok(lockPool);
      const capacity = lockPool.options.max ?? 10;
      for (let i = 1; i < capacity; i += 1) {
        releases.push(await store.acquirePlayerLock(uuidv7()));
      }
      await assert.rejects(store.acquirePlayerLock(uuidv7()), PlayerLockUnavailableError);
    } finally {
      await Promise.all(releases.map((release) => release()));
      await store.closePlayerLocks();
    }
  }, isolated);
});

test('blocked game creation yields a one-client query pool to assistance', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const databaseUrl = new URL(connectionString);
    const queryPool = new Pool({
      host: databaseUrl.hostname,
      port: Number(databaseUrl.port || 5432),
      user: decodeURIComponent(databaseUrl.username),
      password: decodeURIComponent(databaseUrl.password),
      database: decodeURIComponent(databaseUrl.pathname.slice(1)),
      max: 1,
      connectionTimeoutMillis: 2_000,
    });
    const store = new PostgresEventStore(queryPool);
    const playerId = uuidv7();
    const gameId = uuidv7();
    const release = await store.acquirePlayerLock(playerId);
    let append: Promise<number> | undefined;
    try {
      append = store.append(gameId, -1, [{
        type: 'GameCreated',
        gameId,
        variant: 'standard',
        initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
        players: { white: playerId, black: uuidv7() },
        rated: true,
        at: 1,
      }]);
      const deadline = Date.now() + 10_000;
      let observed = false;
      while (!observed && Date.now() < deadline) {
        const result = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks AS lock
             JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
             WHERE activity.datname = current_database()
               AND lock.locktype = 'advisory' AND NOT lock.granted
               AND activity.query LIKE '%pg_advisory_xact_lock%'
           ) AS waiting`,
        );
        observed = result.rows[0]?.waiting ?? false;
        if (!observed) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(observed, true, 'the creator must first reach the held PostgreSQL lock');
      assert.deepEqual(await store.findActiveGamesByPlayer(uuidv7()), [],
        'eligibility reads must progress while a creator waits for the same player');
      assert.deepEqual(await store.load(gameId), [], 'game creation must remain blocked');
    } finally {
      await release();
      await append?.catch(() => undefined);
      await store.closePlayerLocks();
      await queryPool.end();
    }
    assert.equal((await pool.query('SELECT 1 FROM game_events WHERE game_id = $1', [gameId])).rowCount, 1);
  }, isolated);
});

// The one test in this file that writes nothing. It reads a row that cannot exist, so it needs a
// migrated schema and nothing else — and paying for a disposable database to prove a lookup
// returns null would buy nothing.
test('postgres games repository treats a malformed public id as not found', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const games = new PgGamesRepository(pool);
    assert.equal(await games.findById('not-a-uuid'), null);
  } finally {
    await pool.end();
  }
});

test('postgres seek acceptance: optimistic concurrency', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const seeks = new PgSeeksRepository(pool);
    const acceptor = new PgSeekAcceptor(pool);
    const users = new PgUsersRepository(pool);

    const creatorId = uuidv7();
    const p2Id = uuidv7();
    const p3Id = uuidv7();
    await users.createWithPasswordAndRole({ id: creatorId, handle: `creator-${creatorId.slice(0, 8)}` }, 'hash', 'user');
    await users.createWithPasswordAndRole({ id: p2Id, handle: `p2-${p2Id.slice(0, 8)}` }, 'hash', 'user');
    await users.createWithPasswordAndRole({ id: p3Id, handle: `p3-${p3Id.slice(0, 8)}` }, 'hash', 'user');

    const seekId = uuidv7();
    await seeks.create({
      id: seekId,
      creatorId,
      variant: 'standard',
      timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
      rated: false,
      color: 'random',
      minRating: null,
      maxRating: null,
    });

    const gameId1 = uuidv7();
    const gameId2 = uuidv7();
    const startedAt1 = Date.now();
    const startedAt2 = startedAt1 + 1;
    const { events: events1 } = Game.create({
      gameId: gameId1,
      timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
      players: { white: creatorId, black: p2Id },
      rated: false,
      at: startedAt1,
    });
    const { events: events2 } = Game.create({
      gameId: gameId2,
      timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
      players: { white: creatorId, black: p3Id },
      rated: false,
      at: startedAt2,
    });

    const accept1 = acceptor.accept(seekId, gameId1, events1, {
      id: gameId1,
      variant: 'standard',
      rated: false,
      speed: 'blitz',
      whiteId: creatorId,
      blackId: p2Id,
      startedAt: new Date(startedAt1),
    });

    const accept2 = acceptor.accept(seekId, gameId2, events2, {
      id: gameId2,
      variant: 'standard',
      rated: false,
      speed: 'blitz',
      whiteId: creatorId,
      blackId: p3Id,
      startedAt: new Date(startedAt2),
    });

    const [res1, res2] = await Promise.all([accept1, accept2]);

    const successes = [res1, res2].filter(r => r !== null);
    assert.equal(successes.length, 1, 'exactly one accept must succeed');
    
    const successRes = successes[0]!;
    const winningGameId = successRes.gameId;

    const gameRes = await pool.query('SELECT * FROM games WHERE id = $1', [winningGameId]);
    assert.equal(gameRes.rowCount, 1, 'exactly one game should exist');

    const eventsRes = await pool.query('SELECT * FROM game_events WHERE game_id = $1', [winningGameId]);
    assert.ok(eventsRes.rowCount! > 0, 'game events should exist');

    const losingGameId = res1 === null ? gameId1 : gameId2;
    const orphanGame = await pool.query('SELECT * FROM games WHERE id = $1', [losingGameId]);
    assert.equal(orphanGame.rowCount, 0, 'no orphan game should exist');
    const orphanEvents = await pool.query('SELECT * FROM game_events WHERE game_id = $1', [losingGameId]);
    assert.equal(orphanEvents.rowCount, 0, 'no orphan events should exist');

    // Cancellation uses the same open-row predicate as acceptance. Whichever
    // operation obtains the row first wins, and an accepted receipt is never deleted.
    const cancelSeekId = uuidv7();
    const cancelGameId = uuidv7();
    const cancelStartedAt = Date.now();
    await seeks.create({
      id: cancelSeekId,
      creatorId,
      variant: 'standard',
      timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
      rated: false,
      color: 'white',
      minRating: null,
      maxRating: null,
    });
    const { events: cancelEvents } = Game.create({
      gameId: cancelGameId,
      timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
      players: { white: creatorId, black: p2Id },
      rated: false,
      at: cancelStartedAt,
    });

    const [removed, accepted] = await Promise.all([
      seeks.remove(cancelSeekId),
      acceptor.accept(cancelSeekId, cancelGameId, cancelEvents, {
        id: cancelGameId,
        variant: 'standard',
        rated: false,
        speed: 'blitz',
        whiteId: creatorId,
        blackId: p2Id,
        startedAt: new Date(cancelStartedAt),
      }),
    ]);
    assert.equal(Number(removed) + Number(accepted !== null), 1, 'cancel or accept must win, never both');

    const finalSeek = await seeks.findById(cancelSeekId);
    const finalGame = await pool.query('SELECT id FROM games WHERE id = $1', [cancelGameId]);
    const finalEvents = await pool.query('SELECT game_id FROM game_events WHERE game_id = $1', [cancelGameId]);
    if (accepted) {
      assert.equal(removed, false);
      assert.equal(finalSeek?.gameId, cancelGameId);
      assert.equal(finalGame.rowCount, 1);
      assert.ok(finalEvents.rowCount! > 0);
    } else {
      assert.equal(removed, true);
      assert.equal(finalSeek, null);
      assert.equal(finalGame.rowCount, 0);
      assert.equal(finalEvents.rowCount, 0);
    }
  }, isolated);
});

test('PgGameStarter: creates game and handles duplicate id cleanly', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const starter = new PgGameStarter(pool);
    const users = new PgUsersRepository(pool);

    const u1 = uuidv7();
    const u2 = uuidv7();
    // Distinct prefixes, like every other test here: uuidv7 leads with a millisecond timestamp,
    // so two ids minted in the same millisecond share their first 8 hex characters and a shared
    // prefix would collide on the UNIQUE handle.
    await users.create({ id: u1, handle: `white-${u1.slice(0, 8)}` });
    await users.create({ id: u2, handle: `black-${u2.slice(0, 8)}` });

    const gameId = uuidv7();
    const timeControl = { initialMs: 60_000, incrementMs: 1_000, delayMs: 0, kind: 'increment' as const };
    const { events } = Game.create({
      gameId,
      timeControl,
      players: { white: u1, black: u2 },
      rated: false,
      at: 1000,
    });

    const gameStart = {
      id: gameId,
      variant: 'standard' as const,
      rated: false,
      speed: 'blitz' as const,
      whiteId: u1,
      blackId: u2,
      startedAt: new Date(1000),
    };

    const first = await starter.start(gameId, events, gameStart);
    assert.equal(first, true);

    const second = await starter.start(gameId, events, gameStart);
    assert.equal(second, false, 'duplicate gameId must return false without throwing');
  }, isolated);
});

