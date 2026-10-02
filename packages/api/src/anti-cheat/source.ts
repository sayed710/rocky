import type { Variant } from '@chess-platform/core';
import type { EventStore } from '@chess-platform/persistence';
import { Game } from '@chess-platform/game';
import { NullLogger, type Logger } from '../ports/logger';

export interface FinishedGame {
  readonly moves: readonly string[];
  readonly variant: Variant;
  /**
   * The position the game started from.
   *
   * Carried rather than re-derived from `variant`: since ADR-0137 a Chess960 game starts from
   * whichever of the 960 arrangements the server drew, so `Position.initial(variant)` names the right
   * board for seven variants and the wrong one for most Chess960 games.
   */
  readonly initialFen: string;
  readonly white: string;
  readonly black: string;
}

export interface FinishedGameSource {
  load(gameId: string, signal?: AbortSignal): Promise<FinishedGame | null>;
}

export class EventStoreGameSource implements FinishedGameSource {
  /**
   * `logger` defaults to silence so every existing construction site keeps working, and is supplied in
   * `bootstrap` where a real one exists. It is used for exactly one thing: saying out loud that a
   * stored event stream could not be replayed.
   */
  constructor(
    private readonly events: EventStore,
    private readonly logger: Logger = new NullLogger(),
  ) {}

  async load(gameId: string, signal?: AbortSignal): Promise<FinishedGame | null> {
    signal?.throwIfAborted();
    const stored = await this.events.load(gameId);
    signal?.throwIfAborted();
    if (stored.length === 0) return null;
    const events = stored.map((e) => e.event);
    // Read from the creation event rather than the folded state: the aggregate keeps the *current*
    // position, and what a replay needs is the one the game began at. The store guarantees the first
    // event is `GameCreated`, so this is a read rather than a search.
    const created = events[0];
    if (created?.type !== 'GameCreated') return null;

    // Replay can now throw on a stream this method would previously have folded without complaint:
    // ADR-0137 made `Game.reduce` reject a stored Chess960 start id that is out of range, sits on a
    // non-Chess960 event, or disagrees with the stored FEN. Those throws are the point — a corrupt
    // creation event must not silently become a board — but an anti-cheat *read* is not the place they
    // should surface. This method's contract is "the finished game, or null"; an unanalysable game is
    // an absent one, and letting the error escape would turn a bad row into a failed request on an
    // endpoint that has nothing to do with it. Raised in the CodeRabbit review of PR #12.
    //
    // **Contained, not swallowed.** Returning a bare `null` made a corrupt stream indistinguishable
    // from an ordinary miss: the moderation route maps `null` to a 404 "no finished game", and
    // `AntiCheatAutoAnalyzer` only reports *rejected* promises, so nothing anywhere would have said a
    // durable row is unreadable. A log line is the difference between a contained failure and an
    // invisible one. Raised in the Qodo review of PR #12.
    let state;
    try {
      state = Game.fromEvents(events).snapshot();
    } catch {
      this.logger.error('anti-cheat: stored game could not be replayed', {
        gameId,
        // Replay exceptions can embed stored FENs and other arbitrary payload values.
        errorClass: 'game-replay-error',
      });
      return null;
    }
    if (!state.status.over) return null;
    if (!state.players.white || !state.players.black) return null;
    return {
      moves: state.moves.map((m) => m.uci),
      variant: state.variant,
      initialFen: created.initialFen,
      white: state.players.white,
      black: state.players.black,
    };
  }
}
