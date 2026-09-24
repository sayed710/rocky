import type { EventStore } from '@chess-platform/persistence';
import { isHumanGamePlayers } from '@chess-platform/game';
import { HttpError } from '../http/errors.js';

/** Enforces the account-wide fair-play boundary around assistance computation and delivery. */
export class LiveGameAssistanceGuard {
  /** Read eligibility from the durable game event store shared by all sessions. */
  constructor(private readonly events: EventStore) {}

  /** Reject assistance whenever the account has an unended human-vs-human game. */
  async assertEligible(userId: string): Promise<void> {
    const activeGames = await this.events.findActiveGamesByPlayer(userId);
    const humanGame = activeGames.find(({ players }) =>
      isHumanGamePlayers(players));
    if (!humanGame) return;
    throw HttpError.conflict(
      'chess assistance is unavailable while you are playing an active human game',
      { reason: 'active_human_game' },
    );
  }
}
