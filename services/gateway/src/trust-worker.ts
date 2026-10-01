/**
 * @packageDocumentation
 * The trust worker (ADR-0152): the one process that hosts bot-timing and engine anti-cheat analysis
 * of finished games. Deployed as a single replica beside the gateway, from the same image, which
 * ships Stockfish.
 *
 * It runs no WebSocket server, game authority, ownership registry, command consumer or engine bot,
 * so it can never own a game or take client traffic. It serves only `/health` and `/ready`.
 *
 * Config via environment:
 * - `DATABASE_URL` (required) — the shared PostgreSQL; there is no in-memory mode.
 * - `BOT_AUTO_ANALYZE`, `ANTICHEAT_AUTO_ANALYZE` (required, exactly "0" or "1"; at least one "1").
 * - `STOCKFISH_PATH` (required when `ANTICHEAT_AUTO_ANALYZE=1`; the gateway image sets it).
 * - `REDIS_URL` (optional) — subscribes to game-ended broadcasts to wake early. Correctness never
 *   depends on it: committed endings are rescanned on start and every `TRUST_SCAN_MS`.
 * - `TRUST_SCAN_MS` (default 30000) — the periodic rescan interval, a positive integer.
 * - `HEALTH_PORT` (default 4176), `HOST` (default 0.0.0.0).
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { InMemoryPubSub, type PubSub } from '@chess-platform/realtime-gateway';
import { JsonLogger, resolveTrustWorkerConfig, startTrustAnalyzers } from '@chess-platform/api';
import { createPool, PostgresEventStore } from '@chess-platform/persistence/pg';

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function main(): Promise<void> {
  const config = resolveTrustWorkerConfig(process.env);
  const scanIntervalMs = positiveIntEnv('TRUST_SCAN_MS', 30_000);
  const healthPort = positiveIntEnv('HEALTH_PORT', 4176);
  const host = process.env['HOST'] ?? '0.0.0.0';
  const nodeId = process.env['NODE_ID'] ?? `trust-${randomUUID()}`;
  const logger = new JsonLogger({ service: 'trust-worker', nodeId });

  const pool = createPool();
  let pubsub: PubSub = new InMemoryPubSub();
  let closePubSub: (() => Promise<void>) | undefined;
  const redisUrl = process.env['REDIS_URL'];
  if (redisUrl) {
    const { createRedisPubSub } = await import('./redis-pubsub.js');
    const redis = createRedisPubSub({ url: redisUrl, nodeId });
    pubsub = redis.pubsub;
    closePubSub = redis.close;
  }

  // Signals are handled from here on, whatever startup step is in flight: shutdown stops only
  // what has started, and a signal during startup ends the process once that cleanup is done.
  let analyzers: Awaited<ReturnType<typeof startTrustAnalyzers>> | undefined;
  let health: ReturnType<typeof createServer> | undefined;
  let shuttingDown = false;
  const shutdown = async (code: number): Promise<never> => {
    shuttingDown = true;
    try {
      await analyzers?.stop();
      if (health?.listening) await new Promise<void>((resolve) => health!.close(() => resolve()));
      await closePubSub?.();
      await pool.end();
    } catch (error) {
      logger.error('Trust worker shutdown failed', { error: String(error) });
      code = 1;
    }
    process.exit(code);
  };
  const onSignal = (): void => {
    if (shuttingDown) return;
    logger.info('Shutdown signal received; finishing the game in progress');
    void shutdown(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    // Health first, so a port conflict fails the start before any analysis begins.
    health = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'trust-worker' }));
        return;
      }
      if (req.url === '/ready') {
        // The database only: Redis merely wakes the worker early, so its outage must not block a rollout.
        void pool.query('SELECT 1').then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ready', service: 'trust-worker' }));
        }).catch((error: unknown) => {
          logger.warn('readiness check failed', { error: String(error) });
          res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ status: 'unavailable', service: 'trust-worker' }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const server = health;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(healthPort, host, () => resolve());
    });
    if (shuttingDown) return;
    analyzers = await startTrustAnalyzers({ config, pool, eventStore: new PostgresEventStore(pool), pubsub, logger, scanIntervalMs });
    logger.info('Trust worker started', { ...config, scanIntervalMs, wakeups: redisUrl ? 'redis' : 'none (periodic scan only)' });
  } catch (error) {
    logger.error('Failed to start trust worker', { error: error instanceof Error ? error.message : String(error) });
    if (!shuttingDown) await shutdown(1);
  }
}

void main().catch((error: unknown) => {
  console.error('Failed to start trust worker:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
