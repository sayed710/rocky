/**
 * The trust worker's durable catch-up on real PostgreSQL (ADR-0152): committed endings are the
 * work list, so a game that finished while no worker ran — or whose broadcast was lost — is
 * analyzed on start without any wake, a restart resumes after the last receipt, and two workers
 * overlapping during a rollout each finish the backlog without duplicating a receipt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { Game, type GameEvent } from '@chess-platform/game';
import { InMemoryPubSub } from '@chess-platform/realtime-gateway';
import { migrate, PostgresEventStore } from '@chess-platform/persistence/pg';
import { uuidv7 } from '@chess-platform/persistence';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { JsonLogger } from '../src/ports/logger';
import { startTrustAnalyzers } from '../src/trust-analyzers';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(process.cwd(), '../persistence/migrations');

/** A fool's-mate game, finished and committed to the event log. */
async function finishedGame(events: PostgresEventStore): Promise<string> {
  const gameId = uuidv7();
  let { game, events: created } = Game.create({
    gameId,
    timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
    players: { white: uuidv7(), black: uuidv7() },
    rated: true,
    at: 1000,
  });
  const all: GameEvent[] = [...created];
  let at = 2000;
  for (const uci of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
    ({ game, events: created } = game.playMove(uci, at));
    all.push(...created);
    at += 1000;
  }
  await events.append(gameId, -1, all);
  return gameId;
}

async function analyzed(pool: Pool): Promise<string[]> {
  return (await pool.query('SELECT DISTINCT game_id FROM bot_reports ORDER BY game_id')).rows.map((r) => r.game_id);
}

async function receipts(pool: Pool): Promise<number> {
  return (await pool.query(`SELECT count(*)::int AS n FROM terminal_event_receipts WHERE consumer = 'bot-analysis'`)).rows[0].n;
}

function capturingLogger(errors: unknown[]): JsonLogger {
  return new JsonLogger({}, { level: 'error', sink: (line) => errors.push(line) });
}

const config = { botAnalysis: true, antiCheatAnalysis: false } as const;

test('a game that finished while no worker ran is analyzed on start, with no broadcast at all', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const events = new PostgresEventStore(pool);
    const backlog = [await finishedGame(events), await finishedGame(events)];
    const errors: unknown[] = [];
    // An in-memory PubSub nobody publishes to: the only way to find the games is the durable scan.
    const worker = await startTrustAnalyzers({ config, pool, eventStore: events, pubsub: new InMemoryPubSub(), logger: capturingLogger(errors), scanIntervalMs: 0 });
    await worker.initialScan;
    await worker.stop();
    assert.deepEqual(await analyzed(pool), [...backlog].sort());
    assert.equal(await receipts(pool), 2);
    assert.deepEqual(errors, []);

    // A restart resumes: only the game finished since is analyzed, and no receipt is repeated.
    const later = await finishedGame(events);
    const restarted = await startTrustAnalyzers({ config, pool, eventStore: events, pubsub: new InMemoryPubSub(), logger: capturingLogger(errors), scanIntervalMs: 0 });
    await restarted.initialScan;
    await restarted.stop();
    assert.deepEqual(await analyzed(pool), [...backlog, later].sort());
    assert.equal(await receipts(pool), 3);
    assert.deepEqual(errors, []);
  });
});

test('two workers overlapping during a rollout finish the backlog once between them', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const events = new PostgresEventStore(pool);
    const backlog: string[] = [];
    for (let i = 0; i < 6; i++) backlog.push(await finishedGame(events));
    const errors: unknown[] = [];
    const [one, two] = await Promise.all([0, 1].map(() => startTrustAnalyzers({
      config, pool, eventStore: events, pubsub: new InMemoryPubSub(), logger: capturingLogger(errors), scanIntervalMs: 0,
    })));
    await Promise.all([one!.initialScan, two!.initialScan]);
    await Promise.all([one!.stop(), two!.stop()]);
    assert.deepEqual(await analyzed(pool), [...backlog].sort());
    assert.equal(await receipts(pool), backlog.length, 'one receipt per game, however many workers saw it');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bot_reports')).rows[0].n, backlog.length * 2, 'one report per player per game');
    assert.deepEqual(errors, []);
  });
});
