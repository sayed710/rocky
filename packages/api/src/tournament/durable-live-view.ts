import { createHash } from 'node:crypto';
import { replayStoredHistory } from '@chess-platform/game/stored-history';
import type { EventStore, TournamentsRepository } from '@chess-platform/persistence';

import type { LiveBoard, TournamentLiveView } from './live-view';

/** Reconstruct active tournament boards from the shared durable event log. */
export class DurableTournamentLiveView implements TournamentLiveView {
  constructor(
    private readonly tournaments: TournamentsRepository,
    private readonly events: EventStore,
  ) {}

  async activeGames(tournamentId: string): Promise<LiveBoard[]> {
    const stored = await this.tournaments.findById(tournamentId);
    if (!stored) return [];

    const gameLinks = stored.snapshot.gameLinks ?? [];
    const reconstructed = await Promise.all(gameLinks.map(async ([, gameId]): Promise<LiveBoard | null> => {
      const stored = await this.events.load(gameId);
      if (stored.length === 0) return null;
      const { game } = replayStoredHistory(gameId, stored);
      const state = game.snapshot();
      if (state.status.over) return null;
      const fen = game.fen;
      return {
        gameId,
        white: state.players.white,
        black: state.players.black,
        ply: state.ply,
        turn: game.turn,
        fen,
        fenHash: createHash('sha256').update(fen).digest('hex').slice(0, 12),
        clock: { w: state.clock.remaining.w, b: state.clock.remaining.b },
        status: state.status,
      } satisfies LiveBoard;
    }));

    const boards: LiveBoard[] = [];
    for (const board of reconstructed) {
      if (board !== null) boards.push(board);
    }
    return boards;
  }
}
