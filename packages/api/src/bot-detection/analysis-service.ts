import type { BotGameTimingSource } from './source';
import { BotDetectionService } from '@chess-platform/anti-cheat';
import type { BotBehaviorReportRepository, GameBotReport } from '@chess-platform/anti-cheat';

/** Loads a finished game's timings and runs the bot-detection analysis, storing the result. */
export class BotAnalysisService {
  private readonly service: BotDetectionService;

  constructor(
    private readonly source: BotGameTimingSource,
    repository: BotBehaviorReportRepository,
  ) {
    this.service = new BotDetectionService(repository);
  }

  async analyzeAndStore(gameId: string, signal?: AbortSignal): Promise<GameBotReport | null> {
    signal?.throwIfAborted();
    const g = await this.source.load(gameId, signal);
    signal?.throwIfAborted();
    if (!g) return null;
    return this.service.analyzeAndStore({
      gameId,
      players: { white: g.white, black: g.black },
      moves: g.moves,
    });
  }
}
