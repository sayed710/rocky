/**
 * The trust worker entrypoint as deployed (ADR-0152): started against a real PostgreSQL, it becomes
 * ready, analyzes a game that finished before it started, and exits cleanly on SIGTERM.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Game, type GameEvent } from '@chess-platform/game';
import { uuidv7 } from '@chess-platform/persistence';
import { migrate, migrationsDir, PostgresEventStore } from '@chess-platform/persistence/pg';
import { withTestDatabase } from '@chess-platform/persistence/test-support';

const WORKER = fileURLToPath(new URL('../src/trust-worker.js', import.meta.url));
const DATABASE_URL = process.env['DATABASE_URL'];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

(DATABASE_URL ? test : test.skip)('the trust worker becomes ready, catches up on a finished game, and exits 0 on SIGTERM', { timeout: 90_000 }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, migrationsDir());
    const gameId = uuidv7();
    let { game, events } = Game.create({
      gameId, timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
      players: { white: uuidv7(), black: uuidv7() }, rated: true, at: 1000,
    });
    const all: GameEvent[] = [...events];
    let at = 2000;
    for (const uci of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
      ({ game, events } = game.playMove(uci, at));
      all.push(...events);
      at += 1000;
    }
    await new PostgresEventStore(pool).append(gameId, -1, all);
    const poisonId = '00000000-0000-7000-8000-000000000001';
    await pool.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, 'GameEnded', 99, $2)`,
      [poisonId, { type: 'GameEnded', secretPayload: 'must-not-be-logged' }]);

    const port = await freePort();
    const child = spawn(process.execPath, [WORKER], {
      env: {
        PATH: process.env['PATH'] ?? '', DATABASE_URL: connectionString, HOST: '127.0.0.1', HEALTH_PORT: String(port),
        BOT_AUTO_ANALYZE: '1', ANTICHEAT_AUTO_ANALYZE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      await until('/ready', async () => ((await fetch(`http://127.0.0.1:${port}/ready`)).ok ? true : undefined));
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
      await until('the bot report', async () => ((await pool.query('SELECT 1 FROM bot_reports WHERE game_id = $1', [gameId])).rowCount ? true : undefined));
      await until('durable poison backoff', async () => {
        const row = (await pool.query('SELECT failures, next_retry_at, lease_token FROM terminal_event_retries WHERE game_id = $1', [poisonId])).rows[0];
        return row?.failures === 1 ? row : undefined;
      });
      assert.equal((await fetch(`http://127.0.0.1:${port}/ready`)).status, 200, 'poison work is not process unavailability');
      assert.equal((await pool.query('SELECT 1 FROM terminal_event_receipts WHERE game_id = $1', [poisonId])).rowCount, 0);
      assert.equal(output.includes('must-not-be-logged'), false);
      assert.match(output, /decode-error/);
      child.kill('SIGTERM');
      assert.equal(await exited, 0, output);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
