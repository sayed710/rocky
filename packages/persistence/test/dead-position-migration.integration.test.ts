/**
 * Integration test for Migration 0052: Add dead_position termination code (AUD-03a, FIDE 5.2.2).
 *
 * Verifies in an isolated PostgreSQL test database:
 * 1. Before 0052 (migrated through 51):
 *    - Meaningful historical pre-52 game rows and event logs are seeded across classic terminations
 *      (checkmate, stalemate, insufficient_material).
 *    - Pre-52 foreign key negative check: inserting a game referencing termination = 'dead_position'
 *      fails closed with SQLSTATE 23503 (games_termination_fkey constraint violation).
 * 2. Applying migration 0052 through unchanged runner inserts ('dead_position', true) into terminations.
 * 3. Exact historical preservation after 0052:
 *    - All pre-existing games, timestamps, outcomes, and event log payloads are retained verbatim.
 *    - All pre-existing dictionary entries in terminations and schema_migrations checksums 1..51 are immutable.
 * 4. Post-0052 positive check:
 *    - Inserting a game referencing termination = 'dead_position' succeeds.
 * 5. Real PostgreSQL terminal-event inbox validation:
 *    - Decodes valid dead_position event into stored GameEnded aggregate work.
 *    - Table-driven corrupt variants (decisive results, non-null winner, abort, and unknown termination code)
 *      all produce decodeError through real PgTerminalEventInbox.
 * 6. Forward coexistence & rollback limitations:
 *    - Existing code paths continue to insert and read standard terminations.
 *    - Documented: additive dictionary row remains inert on backend rollback without emission;
 *      an older backend release rolling back would reject newly persisted dead_position events.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { Game, type GameEvent } from '@chess-platform/game';
import { migrate, migrationFiles, migrationsDir } from '../src/pg/migrate';
import { PgTerminalEventInbox } from '../src/pg/terminal-event-inbox';
import { withTestDatabase } from '../src/test-support/database';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';
const MIGRATIONS_DIR = migrationsDir();

interface PgErrorShape {
  readonly code?: string;
  readonly constraint?: string;
}

function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pgError = error as PgErrorShape;
  return pgError.code === '23503' && pgError.constraint === constraint;
}

function migrationsThrough(version: number): { readonly dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), `dead-position-migration-${version}-`));
  for (const migration of migrationFiles(MIGRATIONS_DIR)) {
    if (migration.version > version) continue;
    copyFileSync(join(MIGRATIONS_DIR, migration.file), join(dir, migration.file));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('migration 0052: historical row preservation, negative FK guard before 0052, positive insertion and table-driven real Pg inbox', { skip }, async () => {
  const before52 = migrationsThrough(51);
  try {
    await withTestDatabase(async ({ pool }: { pool: Pool }) => {
      // 1. Migrate through version 51
      await migrate(pool, before52.dir);

      // Snapshot pre-52 terminations and schema_migrations
      const preTerminations = (await pool.query('SELECT code, is_draw FROM terminations ORDER BY code')).rows;
      const preChecksums = (await pool.query('SELECT version, checksum FROM schema_migrations WHERE version <= 51 ORDER BY version')).rows;

      // Seed meaningful historical pre-52 game rows and event logs:
      // A. Valid historical game stream created and played through public Game domain API
      const validHistoryGameId = randomUUID();
      const whitePlayerId = randomUUID();
      const blackPlayerId = randomUUID();
      const historyCreatedAt = 1_000_000;

      const startedGame = Game.create({
        gameId: validHistoryGameId,
        variant: 'standard',
        timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
        players: { white: whitePlayerId, black: blackPlayerId },
        rated: true,
        at: historyCreatedAt,
      });
      const move1 = startedGame.game.playMove('e2e4', historyCreatedAt + 2_000);
      const move2 = move1.game.playMove('e7e5', historyCreatedAt + 4_000);
      const resigned = move2.game.resign('b', historyCreatedAt + 6_000);
      const validHistoryEvents: readonly GameEvent[] = [
        ...startedGame.events,
        ...move1.events,
        ...move2.events,
        ...resigned.events,
      ];

      await pool.query(
        `INSERT INTO games (id, variant, rated, speed, result, termination, started_at, ended_at)
         VALUES ($1, 'standard', true, 'blitz', '1-0', 'resignation', $2, $3)`,
        [validHistoryGameId, new Date(historyCreatedAt), new Date(historyCreatedAt + 6_000)],
      );

      for (const [seq, event] of validHistoryEvents.entries()) {
        await pool.query(
          `INSERT INTO game_events (game_id, seq, type, event_version, payload, server_ts)
           VALUES ($1, $2, $3, 1, $4, $5)`,
          [validHistoryGameId, seq, event.type, event, new Date(historyCreatedAt + seq * 2_000)],
        );
      }

      // B. Additional raw sample rows verifying database row, timestamp, outcome, and payload
      // preservation across termination dictionary types, distinct from the full move-replay stream above.
      const sampleGameCheckmate = randomUUID();
      const sampleGameStalemate = randomUUID();
      const sampleGameInsufficient = randomUUID();

      const sampleStartedAt = new Date('2026-10-15T12:00:00Z');
      const sampleEndedAt = new Date('2026-10-15T12:15:00Z');

      await pool.query(
        `INSERT INTO games (id, variant, rated, speed, result, termination, started_at, ended_at)
         VALUES
           ($1, 'standard', true, 'blitz', '1-0', 'checkmate', $4, $5),
           ($2, 'standard', true, 'rapid', '1/2-1/2', 'stalemate', $4, $5),
           ($3, 'standard', true, 'bullet', '1/2-1/2', 'insufficient_material', $4, $5)`,
        [sampleGameCheckmate, sampleGameStalemate, sampleGameInsufficient, sampleStartedAt, sampleEndedAt],
      );

      await pool.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload, server_ts)
         VALUES
           ($1, 0, 'GameCreated', 1, $4::jsonb, $7),
           ($1, 1, 'GameEnded', 1, '{"type":"GameEnded","result":"1-0","termination":"checkmate","winner":"w","at":900000}'::jsonb, $8),
           ($2, 0, 'GameCreated', 1, $5::jsonb, $7),
           ($2, 1, 'GameEnded', 1, '{"type":"GameEnded","result":"1/2-1/2","termination":"stalemate","winner":null,"at":900000}'::jsonb, $8),
           ($3, 0, 'GameCreated', 1, $6::jsonb, $7),
           ($3, 1, 'GameEnded', 1, '{"type":"GameEnded","result":"1/2-1/2","termination":"insufficient_material","winner":null,"at":900000}'::jsonb, $8)`,
        [
          sampleGameCheckmate, sampleGameStalemate, sampleGameInsufficient,
          JSON.stringify({ type: 'GameCreated', gameId: sampleGameCheckmate, variant: 'standard' }),
          JSON.stringify({ type: 'GameCreated', gameId: sampleGameStalemate, variant: 'standard' }),
          JSON.stringify({ type: 'GameCreated', gameId: sampleGameInsufficient, variant: 'standard' }),
          sampleStartedAt, sampleEndedAt,
        ],
      );

      const allSeededGameIds = [validHistoryGameId, sampleGameCheckmate, sampleGameStalemate, sampleGameInsufficient];
      const preHistoricalGames = (await pool.query(
        'SELECT id, variant, rated, speed, result, termination, started_at, ended_at FROM games WHERE id = ANY($1) ORDER BY id',
        [allSeededGameIds],
      )).rows;
      const preHistoricalEvents = (await pool.query(
        'SELECT game_id, seq, type, event_version, payload, server_ts FROM game_events WHERE game_id = ANY($1) ORDER BY game_id, seq',
        [allSeededGameIds],
      )).rows;

      // 2. Pre-0052 negative check: 'dead_position' is not in dictionary, fails with SQLSTATE 23503
      const newGameId = randomUUID();
      let rejected = false;
      try {
        await pool.query(
          `INSERT INTO games (id, variant, rated, speed, result, termination, started_at)
           VALUES ($1, 'standard', true, 'blitz', '1/2-1/2', 'dead_position', now())`,
          [newGameId],
        );
      } catch (err) {
        rejected = isForeignKeyViolation(err, 'games_termination_fkey');
      }
      assert.equal(rejected, true, 'inserting game with termination dead_position before 0052 must fail with SQLSTATE 23503 on games_termination_fkey');

      // 3. Apply migration 0052 through unchanged runner
      await migrate(pool, MIGRATIONS_DIR);

      // 4. Verify dictionary row ('dead_position', true)
      const dictRow = (await pool.query('SELECT code, is_draw FROM terminations WHERE code = $1', ['dead_position'])).rows[0];
      assert.deepEqual(dictRow, { code: 'dead_position', is_draw: true });

      // 5. Verify all pre-existing terminations are preserved identically
      const postTerminations = (await pool.query('SELECT code, is_draw FROM terminations WHERE code != $1 ORDER BY code', ['dead_position'])).rows;
      assert.deepEqual(postTerminations, preTerminations, 'all pre-existing termination dictionary entries must remain unchanged');

      // 6. Verify ledger checksums through version 51 are immutable
      const postChecksums = (await pool.query('SELECT version, checksum FROM schema_migrations WHERE version <= 51 ORDER BY version')).rows;
      assert.deepEqual(postChecksums, preChecksums, 'migration ledger checksums 1..51 must be immutable');

      // 7. Verify exact historical pre-52 game rows and event logs are preserved post-0052
      const postHistoricalGames = (await pool.query(
        'SELECT id, variant, rated, speed, result, termination, started_at, ended_at FROM games WHERE id = ANY($1) ORDER BY id',
        [allSeededGameIds],
      )).rows;
      assert.deepEqual(postHistoricalGames, preHistoricalGames, 'historical games must be retained identically after migration 0052');

      const postHistoricalEvents = (await pool.query(
        'SELECT game_id, seq, type, event_version, payload, server_ts FROM game_events WHERE game_id = ANY($1) ORDER BY game_id, seq',
        [allSeededGameIds],
      )).rows;
      assert.deepEqual(postHistoricalEvents, preHistoricalEvents, 'historical game events must be retained identically after migration 0052');

      // Replay the post-migration loaded event stream through Game.fromEvents to verify replay fidelity
      const postValidStreamEvents = postHistoricalEvents
        .filter((r) => r.game_id === validHistoryGameId)
        .map((r) => r.payload as GameEvent);
      const replayedGame = Game.fromEvents(postValidStreamEvents);
      assert.equal(replayedGame.status.over, true);
      assert.equal(replayedGame.status.result, '1-0');
      assert.equal(replayedGame.status.termination, 'resignation');
      assert.equal(replayedGame.status.winner, 'w');
      assert.equal(replayedGame.fen, resigned.game.fen);
      assert.equal(replayedGame.turn, resigned.game.turn);

      // 8. Post-0052 positive check: inserting game with dead_position now succeeds
      await pool.query(
        `INSERT INTO games (id, variant, rated, speed, result, termination, started_at)
         VALUES ($1, 'standard', true, 'blitz', '1/2-1/2', 'dead_position', now())`,
        [newGameId],
      );
      const inserted = (await pool.query('SELECT id, termination, result FROM games WHERE id = $1', [newGameId])).rows[0];
      assert.deepEqual(inserted, { id: newGameId, termination: 'dead_position', result: '1/2-1/2' });

      // 9. Real PostgreSQL terminal-event inbox decodes valid dead_position GameEnded event
      const validEventGameId = randomUUID();
      const validEventSeq = 1;
      await pool.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload)
         VALUES ($1, $2, 'GameEnded', 1, $3)`,
        [validEventGameId, validEventSeq, { type: 'GameEnded', result: '1/2-1/2', termination: 'dead_position', winner: null, at: 1_000 }],
      );
      const inbox = new PgTerminalEventInbox(pool);
      // Select the intended inserted event deterministically using claimBefore bounded by (validEventGameId, validEventSeq + 1):
      // Because ordering is DESC, this query evaluates validEventGameId first and picks the highest seq <= validEventSeq,
      // strictly isolating the target event before any older or lexicographically smaller historical event rows.
      const claim = await inbox.claimBefore('bot-analysis', { gameId: validEventGameId, seq: validEventSeq + 1 });
      assert.ok(claim, 'must claim target dead_position event');
      assert.equal(claim.lease.gameId, validEventGameId, 'claimed gameId must match target validEventGameId');
      assert.equal(claim.lease.seq, validEventSeq, 'claimed seq must match target validEventSeq');
      assert.ok('stored' in claim.work, 'real Pg inbox must decode valid dead_position event into stored work');
      if (claim && 'stored' in claim.work && claim.work.stored.event.type === 'GameEnded') {
        assert.equal(claim.work.stored.event.termination, 'dead_position');
        assert.equal(claim.work.stored.event.result, '1/2-1/2');
        assert.equal(claim.work.stored.event.winner, null);
        await inbox.acknowledge(claim.lease);
      } else {
        assert.fail('expected GameEnded stored event');
      }

      // 10. Table-driven corrupt variants and unknown codes through real PgTerminalEventInbox
      const corruptTestCases = [
        { label: 'decisive white win with dead_position', payload: { type: 'GameEnded', result: '1-0', termination: 'dead_position', winner: 'w', at: 1_000 } },
        { label: 'decisive black win with dead_position', payload: { type: 'GameEnded', result: '0-1', termination: 'dead_position', winner: 'b', at: 1_000 } },
        { label: 'abort outcome with dead_position', payload: { type: 'GameEnded', result: '*', termination: 'dead_position', winner: null, at: 1_000 } },
        { label: 'draw with white winner on dead_position', payload: { type: 'GameEnded', result: '1/2-1/2', termination: 'dead_position', winner: 'w', at: 1_000 } },
        { label: 'draw with black winner on dead_position', payload: { type: 'GameEnded', result: '1/2-1/2', termination: 'dead_position', winner: 'b', at: 1_000 } },
        { label: 'unknown termination code in inbox', payload: { type: 'GameEnded', result: '1/2-1/2', termination: 'unknown_termination', winner: null, at: 1_000 } },
      ];

      for (const tc of corruptTestCases) {
        const corruptId = randomUUID();
        const corruptSeq = 1;
        await pool.query(
          `INSERT INTO game_events (game_id, seq, type, event_version, payload)
           VALUES ($1, $2, 'GameEnded', 1, $3)`,
          [corruptId, corruptSeq, tc.payload],
        );
        // Select the intended corrupt test event deterministically using claimBefore bounded by (corruptId, corruptSeq + 1)
        const badClaim = await inbox.claimBefore('bot-analysis', { gameId: corruptId, seq: corruptSeq + 1 });
        assert.ok(badClaim, `must claim corrupt target event for ${tc.label}`);
        assert.equal(badClaim.lease.gameId, corruptId, `claimed gameId must match target corruptId for ${tc.label}`);
        assert.equal(badClaim.lease.seq, corruptSeq, `claimed seq must match target corruptSeq for ${tc.label}`);
        assert.ok('decodeError' in badClaim.work, `expected decodeError for ${tc.label}`);
        await inbox.fail(badClaim.lease);
      }

      // 11. Forward coexistence & rollback limitations:
      // Existing termination codes continue to insert and be recognized normally alongside new code.
      const coexistenceGameId = randomUUID();
      await pool.query(
        `INSERT INTO games (id, variant, rated, speed, result, termination, started_at)
         VALUES ($1, 'standard', true, 'blitz', '1/2-1/2', 'stalemate', now())`,
        [coexistenceGameId],
      );
      const coexistenceRow = (await pool.query('SELECT termination FROM games WHERE id = $1', [coexistenceGameId])).rows[0];
      assert.equal(coexistenceRow?.termination, 'stalemate');
    });
  } finally {
    before52.cleanup();
  }
});
