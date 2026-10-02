/**
 * The trust worker's anti-cheat consumer with the pinned Stockfish and a real PostgreSQL
 * (ADR-0152): a committed ending is analyzed by the engine and stored, found by the durable scan
 * alone. Runs in the `analysis-smoke` CI job, which provides both and refuses to skip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Game, type GameEvent } from '@chess-platform/game';
import { InMemoryPubSub } from '@chess-platform/realtime-gateway';
import { migrate, PostgresEventStore } from '@chess-platform/persistence/pg';
import { uuidv7 } from '@chess-platform/persistence';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { JsonLogger } from '../src/ports/logger';
import { resolveTrustWorkerConfig, startTrustAnalyzers } from '../src/trust-analyzers';

const skip = process.env['DATABASE_URL'] && process.env['STOCKFISH_PATH'] ? false : 'DATABASE_URL and STOCKFISH_PATH are required';

test('the anti-cheat consumer analyzes a committed game with the real engine and stores both players', { skip, timeout: 120_000 }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const events = new PostgresEventStore(pool);
    const gameId = uuidv7();
    const white = uuidv7();
    const black = uuidv7();
    let { game, events: created } = Game.create({
      gameId, timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
      players: { white, black }, rated: true, at: 1000,
    });
    const all: GameEvent[] = [...created];
    let at = 2000;
    for (const uci of ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']) {
      ({ game, events: created } = game.playMove(uci, at));
      all.push(...created);
      at += 1000;
    }
    await events.append(gameId, -1, all);

    const config = resolveTrustWorkerConfig({ ...process.env, BOT_AUTO_ANALYZE: '0', ANTICHEAT_AUTO_ANALYZE: '1' });
    const errors: unknown[] = [];
    const worker = await startTrustAnalyzers({
      config, pool, eventStore: events, pubsub: new InMemoryPubSub(),
      logger: new JsonLogger({}, { level: 'error', sink: (line) => errors.push(line) }), scanIntervalMs: 0,
    });
    try {
      await worker.initialScan;
    } finally {
      await worker.stop();
    }
    assert.deepEqual(errors, []);
    const rows = (await pool.query('SELECT player_id FROM anti_cheat_reports WHERE game_id = $1 ORDER BY player_id', [gameId])).rows;
    assert.deepEqual(rows.map((r) => r.player_id), [white, black].sort());
    const receipt = await pool.query(`SELECT 1 FROM terminal_event_receipts WHERE consumer = 'anti-cheat-analysis' AND game_id = $1`, [gameId]);
    assert.equal(receipt.rowCount, 1);
  });
});
