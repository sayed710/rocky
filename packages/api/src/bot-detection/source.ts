import type { MoveTiming } from '@chess-platform/anti-cheat';
import type { EventStore } from '@chess-platform/persistence';
import { Game } from '@chess-platform/game';

export interface BotFinishedGame {
  readonly white: string;
  readonly black: string;
  readonly moves: readonly MoveTiming[];
}

export interface BotGameTimingSource {
  load(gameId: string, signal?: AbortSignal): Promise<BotFinishedGame | null>;
}

export class EventStoreBotTimingSource implements BotGameTimingSource {
  constructor(private readonly events: EventStore) {}

  async load(gameId: string, signal?: AbortSignal): Promise<BotFinishedGame | null> {
    signal?.throwIfAborted();
    const stored = await this.events.load(gameId);
    signal?.throwIfAborted();
    if (stored.length === 0) return null;
    const state = Game.fromEvents(stored.map((e) => e.event)).snapshot();
    if (!state.status.over) return null;
    if (!state.players.white || !state.players.black) return null;
    return {
      white: state.players.white,
      black: state.players.black,
      moves: state.moves.map((m) => ({ by: m.by, moveTimeMs: m.moveTimeMs })),
    };
  }
}
