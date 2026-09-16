import type { EventStore } from '@chess-platform/persistence';
import { isEngineBotUserId } from '@chess-platform/game';
import { HttpError } from '../http/errors.js';

/** Enforces the account-wide fair-play boundary around assistance computation and delivery. */
export class LiveGameAssistanceGuard {
  constructor(private readonly events: EventStore) {}

  async assertEligible(userId: string): Promise<void> {
    const activeGames = await this.events.findActiveGamesByPlayer(userId);
    const humanGame = activeGames.find(({ players }) =>
      !isEngineBotUserId(players.white) && !isEngineBotUserId(players.black));
    if (!humanGame) return;
    throw HttpError.conflict(
      'chess assistance is unavailable while you are playing an active human game',
      { reason: 'active_human_game' },
    );
  }
}
