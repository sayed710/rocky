import type { GameLauncher } from '@chess-platform/api';

/** Watch games created here immediately; periodic reporter scans cover other replicas. */
export function createReportingLauncher(
  launcher: GameLauncher,
  watch: (tournamentId: string, gameId: string) => void,
): GameLauncher {
  return {
    roundAttemptForGame: (input, gameId) => launcher.roundAttemptForGame?.(input, gameId),
    launch: async (input, signal) => {
      const result = await launcher.launch(input, signal);
      signal?.throwIfAborted();
      if (result.terminalOutcome === undefined) watch(input.tournamentId, result.gameId);
      return result;
    },
  };
}
