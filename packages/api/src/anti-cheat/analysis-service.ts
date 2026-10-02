import type { Variant } from '@chess-platform/core';
import {
  AntiCheatService,
  type PositionEvaluator,
  type AntiCheatReportRepository,
  type GameCorrelationReport,
} from '@chess-platform/anti-cheat';
import { extractPlies } from '@chess-platform/anti-cheat/engine';
import type { FinishedGameSource } from './source';

export const DEFAULT_ANALYSIS_DEPTH = 18;

export class AntiCheatAnalysisService {
  constructor(
    private readonly source: FinishedGameSource,
    private readonly makeEvaluator: (variant: Variant, signal?: AbortSignal) => PositionEvaluator,
    private readonly repository: AntiCheatReportRepository,
  ) {}

  async analyzeAndStore(
    gameId: string,
    opts: { depth?: number; signal?: AbortSignal } = {},
  ): Promise<GameCorrelationReport | null> {
    opts.signal?.throwIfAborted();
    const g = await this.source.load(gameId, opts.signal);
    opts.signal?.throwIfAborted();
    if (!g) return null;
    const plies = extractPlies(g.moves, g.variant, g.initialFen);
    const service = new AntiCheatService(this.makeEvaluator(g.variant, opts.signal), this.repository);
    return service.analyzeAndStore({
      gameId,
      players: { white: g.white, black: g.black },
      plies,
      depth: opts.depth ?? DEFAULT_ANALYSIS_DEPTH,
    });
  }
}
