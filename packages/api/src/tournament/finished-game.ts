/**
 * The finished-game port (ADR-0130).
 *
 * `TournamentLiveView` answers "what is being played right now" and deliberately drops any game
 * that is over (`durable-live-view.ts`). Tournament commentary needs the opposite set — only games
 * that are over — so it gets its own port rather than a flag on that one: the live projection's
 * whole contract is that everything in it is still running, and a caller that could ask it for
 * finished games would be asking a different question of the same name.
 *
 * The port exists because a finished game's authoritative state is the durable event log, which
 * lives in the composition root. `TournamentLiveView` is arranged the same way and for the same
 * reason: the API layer states what it needs, and the root — the one place that holds an
 * `EventStore` — supplies it.
 */

/** The move a finished game ended on. */
export interface FinalMove {
  /** Long algebraic (UCI) form, e.g. `e7e8q`. */
  readonly uci: string;
  /** Standard algebraic form, e.g. `e8=Q+`. */
  readonly san: string;
  /** The side that played it. */
  readonly by: 'w' | 'b';
  /**
   * Set when the move is a stored pre-#127 atomic move that today's rules reject (#127): it was never
   * legal, so no engine can analyse it and nothing should describe it as a move played from
   * {@link FinishedGame.fenBeforeFinalMove}.
   */
  readonly historical?: true;
}

/**
 * A tournament game that has ended, reconstructed from its event log.
 *
 * Every field here is derived from the log; none of it is supplied by a caller. That is the point
 * of the type — it is the boundary at which "what the client asked about" becomes "what the server
 * knows", and a commentary route that reads only from here cannot narrate a client's fiction.
 */
export interface FinishedGame {
  readonly gameId: string;
  readonly variant: string;
  /** Player ids — not display names. Resolving those is the caller's job and its own decision. */
  readonly white: string;
  readonly black: string;
  /** The result as the game itself recorded it, e.g. `1-0`. */
  readonly result: string;
  /** How it ended: `checkmate`, `resign`, `timeout`, and so on. */
  readonly termination: string;
  /** Total plies played. Zero for a game that ended before a move was made. */
  readonly ply: number;
  /** The position the game ended in. */
  readonly finalFen: string;
  /** The last move played, or `null` if no move was ever made. */
  readonly finalMove: FinalMove | null;
  /**
   * The position the final move was played *from*, or `null` when there was no final move.
   *
   * This is the position worth commentating and it is deliberately not `finalFen`. A move and the
   * position it produced do not belong together: pairing them describes a move being played from a
   * board it has already been played on — the defect ADR-0129 §7 fixed on the Coach's client. It
   * also keeps the engine off a decided position: whatever the game ended in may be checkmate or
   * stalemate, where an evaluation is not a fact (ADR-0116), while the position a legal move was
   * played from never is.
   */
  readonly fenBeforeFinalMove: string | null;
}

/**
 * Reads finished games out of durable storage.
 *
 * Returns `undefined` for a game that does not exist *and* for one that is still being played. The
 * two are one answer on purpose: this port's callers may only ever see games that are over, so a
 * distinct "exists but running" reply would be an oracle for exactly the state they must not read.
 * Establishing that a game belongs to a tournament is a separate question, answered by the
 * tournament aggregate before this port is asked anything.
 */
export interface FinishedGameArchive {
  /**
   * @param gameId - the game to load.
   * @returns the finished game, or `undefined` if it is unknown or still being played.
   */
  finishedGame(gameId: string): Promise<FinishedGame | undefined>;
}
