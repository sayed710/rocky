import { analyzeGame, type GameCorrelationReport, type AnalyzedPly, type Player } from './analyzer';
import { aggregatePlayer, type PlayerAggregateReport, type PlayerAggregateInput } from './aggregate';
import type { PositionEvaluator } from './port';
import type { AntiCheatReportRepository } from './repository';

export interface AnalyzeAndStoreInput {
  readonly gameId: string;
  readonly players: {
    readonly white: string;
    readonly black: string;
  };
  readonly plies: readonly AnalyzedPly[];
  readonly depth: number;
  /** The player whose stored final move was left out of `plies` as pre-#127 history (#127). */
  readonly historicalExcluded?: Player;
}

export class AntiCheatService {
  constructor(
    private readonly evaluator: PositionEvaluator,
    private readonly repository: AntiCheatReportRepository,
  ) {}

  async analyzeAndStore(input: AnalyzeAndStoreInput): Promise<GameCorrelationReport> {
    if (input.players.white === input.players.black) {
      throw new Error(
        `AntiCheatService.analyzeAndStore: white and black must be different players (got "${input.players.white}" for both)`,
      );
    }

    const analyzed = await analyzeGame({
      plies: input.plies,
      depth: input.depth,
      evaluator: this.evaluator,
    });
    const side = input.historicalExcluded;
    const report = side === undefined ? analyzed : { ...analyzed, [side]: { ...analyzed[side], historicalExcludedPlies: 1 } };

    await this.repository.saveBatch([
      {
        gameId: input.gameId,
        playerId: input.players.white,
        color: 'white',
        report: report.white,
      },
      {
        gameId: input.gameId,
        playerId: input.players.black,
        color: 'black',
        report: report.black,
      },
    ]);

    return report;
  }

  async aggregatePlayer(playerId: string): Promise<PlayerAggregateReport> {
    const storedReports = await this.repository.listByPlayer(playerId);
    const inputs: PlayerAggregateInput[] = storedReports.map((record) => ({
      gameId: record.gameId,
      report: record.report,
    }));
    return aggregatePlayer(inputs);
  }
}
