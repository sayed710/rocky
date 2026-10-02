import { createEngineManager, type EngineManager, type AnalysisProvider } from '@chess-platform/engine';
import { EngineBackedEvaluator } from '@chess-platform/anti-cheat/engine';
import type { AntiCheatReportRepository } from '@chess-platform/anti-cheat';
import type { FinishedGameSource } from './source';
import { AntiCheatAnalysisService } from './analysis-service';

/**
 * Build a real engine provider from the environment, or `undefined` when no engine
 * binary is configured (`STOCKFISH_PATH` unset) so callers can stay engine-free.
 * Construction is lazy — workers spawn on first analysis, so this does not spawn here.
 */
export function createEngineProviderFromEnv(): EngineManager | undefined {
  if (!process.env['STOCKFISH_PATH']) return undefined;
  return createEngineManager();
}

/** Compose the engine-backed anti-cheat analysis service (source -> engine evaluator -> store). */
export function createEngineBackedAnalysisService(
  source: FinishedGameSource,
  provider: AnalysisProvider,
  repository: AntiCheatReportRepository,
): AntiCheatAnalysisService {
  return new AntiCheatAnalysisService(
    source,
    (variant, signal) => new EngineBackedEvaluator(provider, variant, signal),
    repository,
  );
}
