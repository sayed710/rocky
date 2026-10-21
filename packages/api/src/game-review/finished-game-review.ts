import { replayStoredHistory } from '@chess-platform/game/stored-history';
import type { Color, Variant } from '@chess-platform/core';
import type { EventStore } from '@chess-platform/persistence';

/** One durable move together with the position it was played from. */
export interface FinishedGameReviewMove {
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly by: Color;
  readonly fenBefore: string;
  /** Set on the stored pre-#127 atomic move, which today's rules (and so the engine) reject (#127). */
  readonly historical?: true;
}

/** The private, completed-game source a player review is allowed to read. */
export interface FinishedGameForReview {
  readonly gameId: string;
  readonly variant: Variant;
  readonly white: string;
  readonly black: string;
  readonly result: '1-0' | '0-1' | '1/2-1/2';
  readonly termination: string;
  readonly moves: readonly FinishedGameReviewMove[];
}

/** Returns no data for an unknown or still-live game, avoiding a live-game oracle. */
export interface FinishedGameReviewArchive {
  finishedGameForReview(gameId: string): Promise<FinishedGameForReview | undefined>;
}

/** Reads completed game history from the authoritative event stream. */
export class DurableFinishedGameReviewArchive implements FinishedGameReviewArchive {
  /** Bind the archive to the authoritative append-only event store. */
  constructor(private readonly events: EventStore) {}

  /** Reconstruct a completed game and its pre-move positions, withholding live or unknown games. */
  async finishedGameForReview(gameId: string): Promise<FinishedGameForReview | undefined> {
    const stored = await this.events.load(gameId);
    if (stored.length === 0) return undefined;

    // One forward replay captures each pre-move position; the stored-history replay also admits a
    // pre-#127 atomic final move, which the review lists like any other.
    const moves: FinishedGameReviewMove[] = [];
    const { game } = replayStoredHistory(gameId, stored, ({ event, before, historical }) => {
      moves.push({
        ply: event.ply,
        uci: event.uci,
        san: event.san,
        by: event.by,
        fenBefore: before.fen(),
        ...(historical ? { historical } : {}),
      });
    });
    const state = game.snapshot();
    if (!state.status.over || state.status.result === '*') return undefined;

    return {
      gameId,
      variant: state.variant,
      white: state.players.white,
      black: state.players.black,
      result: state.status.result,
      termination: state.status.termination,
      moves,
    };
  }
}
