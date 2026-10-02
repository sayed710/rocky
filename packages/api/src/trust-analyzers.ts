/**
 * @packageDocumentation
 * The trust analyzers — bot-timing and engine anti-cheat analysis of every finished game — and the
 * configuration that decides which of them the trust worker hosts (ADR-0152).
 *
 * Both are {@link TerminalEventReconciler} consumers over the durable terminal inbox: committed
 * `GameEnded` events are the work list, a per-consumer receipt marks a game done, a startup scan and
 * a periodic scan recover anything a lost broadcast or a restart missed, and PubSub only wakes the
 * scan early. Each consumer works one game at a time, which is what bounds engine use. Analysis is
 * an idempotent upsert, with fenced per-consumer leases isolating overlapping workers.
 */
import type { Pool } from 'pg';
import type { EventStore } from '@chess-platform/persistence';
import { PgAntiCheatReportRepository, PgBotBehaviorReportRepository, PgTerminalEventInbox } from '@chess-platform/persistence/pg';
import type { PubSub } from '@chess-platform/realtime-gateway';
import { createEngineBackedAnalysisService, createEngineProviderFromEnv } from './anti-cheat/engine-provider';
import { EventStoreGameSource } from './anti-cheat/source';
import { BotAnalysisService } from './bot-detection/analysis-service';
import { EventStoreBotTimingSource } from './bot-detection/source';
import type { Logger } from './ports/logger';
import { TerminalEventReconciler, type TerminalReconcilerErrorMetadata } from './terminal-event-reconciler';

export interface TrustWorkerConfig {
  readonly botAnalysis: boolean;
  readonly antiCheatAnalysis: boolean;
}

/** `"1"` or `"0"`, nothing else: a typo must stop the worker, not quietly turn analysis off. */
function strictFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${name} must be "0" or "1"`);
}

/** Read and check the trust worker's environment. Throws on anything it cannot run as asked. */
export function resolveTrustWorkerConfig(env: NodeJS.ProcessEnv): TrustWorkerConfig {
  if (!env['DATABASE_URL']) throw new Error('DATABASE_URL is required: the trust worker has no in-memory mode');
  const config = { botAnalysis: strictFlag(env, 'BOT_AUTO_ANALYZE'), antiCheatAnalysis: strictFlag(env, 'ANTICHEAT_AUTO_ANALYZE') };
  if (!config.botAnalysis && !config.antiCheatAnalysis) {
    throw new Error('the trust worker has nothing to do: set BOT_AUTO_ANALYZE=1 and/or ANTICHEAT_AUTO_ANALYZE=1');
  }
  if (config.antiCheatAnalysis && !env['STOCKFISH_PATH']) {
    throw new Error('ANTICHEAT_AUTO_ANALYZE=1 requires STOCKFISH_PATH: anti-cheat analysis needs the engine');
  }
  return config;
}

export interface TrustAnalyzers {
  /** Settles when every consumer's first scan of the backlog has finished (errors are logged, not thrown). */
  readonly initialScan: Promise<void>;
  /** Stop scanning, let each game in progress finish, then shut the engine down. */
  stop(): Promise<void>;
}

export interface TrustAnalyzerOptions {
  readonly config: TrustWorkerConfig;
  readonly pool: Pool;
  readonly eventStore: EventStore;
  readonly pubsub: PubSub;
  readonly logger: Logger;
  /** How often to rescan for committed endings; 0 disables the timer (tests). Default 30 s. */
  readonly scanIntervalMs?: number;
}

/** Start the configured consumers. Their first scans run in the background; see `initialScan`. */
export async function startTrustAnalyzers(options: TrustAnalyzerOptions): Promise<TrustAnalyzers> {
  const { config, pool, eventStore, pubsub, logger } = options;
  const inbox = new PgTerminalEventInbox(pool);
  const reconcilerOptions = {
    ...(options.scanIntervalMs !== undefined ? { scanIntervalMs: options.scanIntervalMs } : {}),
    onError: (gameId: string, _error: unknown, metadata?: TerminalReconcilerErrorMetadata) => logger.error('Trust analysis failed; durable work remains recoverable', {
      gameId, consumer: metadata?.consumer ?? null, seq: metadata?.seq ?? null,
      failures: metadata?.retry?.failures ?? null, nextRetryAt: metadata?.retry?.nextRetryAt ?? null,
      errorClass: metadata?.errorClass ?? 'scan-store-error',
    }),
  };
  const workers: TerminalEventReconciler[] = [];
  const engine = config.antiCheatAnalysis ? createEngineProviderFromEnv() : undefined;
  if (config.antiCheatAnalysis && !engine) throw new Error('ANTICHEAT_AUTO_ANALYZE=1 requires STOCKFISH_PATH');

  if (config.botAnalysis) {
    const analysis = new BotAnalysisService(new EventStoreBotTimingSource(eventStore), new PgBotBehaviorReportRepository(pool));
    workers.push(new TerminalEventReconciler(pubsub, inbox, 'bot-analysis', async (gameId, ending, signal) => {
      if (ending.result === '*') return;
      if (!(await analysis.analyzeAndStore(gameId, signal))) throw new Error(`no finished game for ${gameId}`);
    }, reconcilerOptions));
  }
  if (engine) {
    // The logger matters: without it a game whose events cannot be replayed is skipped silently.
    const service = createEngineBackedAnalysisService(new EventStoreGameSource(eventStore, logger), engine, new PgAntiCheatReportRepository(pool));
    workers.push(new TerminalEventReconciler(pubsub, inbox, 'anti-cheat-analysis', async (gameId, ending, signal) => {
      if (ending.result === '*') return;
      if (!(await service.analyzeAndStore(gameId, { signal }))) throw new Error(`no analyzable game for ${gameId}`);
    }, reconcilerOptions));
  }

  const initialScan = Promise.all(workers.map((worker) => worker.start().catch(() => {
    logger.error('Trust analysis startup scan failed; the periodic scan retries', { errorClass: 'scan-store-error' });
  }))).then(() => undefined);
  return {
    initialScan,
    stop: async () => {
      await Promise.all(workers.map((worker) => worker.stop()));
      await engine?.shutdown();
    },
  };
}
