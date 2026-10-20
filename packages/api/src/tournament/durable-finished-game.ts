import { Game } from '@chess-platform/game';
import { replayStoredHistory } from '@chess-platform/game/stored-history';
import type { EventStore } from '@chess-platform/persistence';

import type { FinishedGame, FinishedGameArchive } from './finished-game';

/**
 * Reconstruct a finished game from the shared durable event log (ADR-0130).
 *
 * The counterpart to `DurableTournamentLiveView`, which reconstructs the same games from the same
 * log and keeps the ones that are still running. This keeps the ones that are over.
 */
export class DurableFinishedGameArchive implements FinishedGameArchive {
  constructor(private readonly events: EventStore) {}

  /**
   * Load a game and return it only if it has ended.
   *
   * The log is the authority for this question and the tournament aggregate is not. Results reach
   * the aggregate through `TournamentResultReporter`, which records them from a PubSub subscription
   * — asynchronously, and with a periodic scan behind it for the ones that go missing. A game can
   * therefore be over in the log for some time before the tournament knows, and asking the
   * tournament instead would answer "still playing" about a game that has finished. For a caller
   * that must never analyse a live board, the safe error is the other one: read the log.
   *
   * @param gameId - the game to load.
   * @returns the finished game, or `undefined` if it is unknown or still in progress.
   */
  async finishedGame(gameId: string): Promise<FinishedGame | undefined> {
    const stored = await this.events.load(gameId);
    if (stored.length === 0) return undefined;

    const events = stored.map((entry) => entry.event);
    const { game, historicalPly } = replayStoredHistory(gameId, stored);
    const state = game.snapshot();
    if (!state.status.over) return undefined;

    // The index of the final move in the *event* log, which carries more than moves. Replaying
    // everything before it reproduces the position that move was played from, which is what the
    // engine may look at; `game.fen` is the position it produced, which may be decided.
    let finalMoveIndex = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]!.type === 'MovePlayed') {
        finalMoveIndex = i;
        break;
      }
    }

    const played = finalMoveIndex === -1 ? undefined : state.moves[state.moves.length - 1];
    const before = finalMoveIndex === -1 ? null : Game.fromEvents(events.slice(0, finalMoveIndex)).fen;

    return {
      gameId,
      variant: state.variant,
      white: state.players.white,
      black: state.players.black,
      result: state.status.result,
      termination: state.status.termination,
      ply: state.ply,
      finalFen: game.fen,
      finalMove: played
        ? { uci: played.uci, san: played.san, by: played.by, ...(played.ply === historicalPly ? { historical: true as const } : {}) }
        : null,
      fenBeforeFinalMove: before,
    };
  }
}
