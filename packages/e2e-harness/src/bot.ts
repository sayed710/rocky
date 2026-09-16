/**
 * Bot player: auto-joins games and plays random legal moves.
 *
 * The bot subscribes to game channels via pub/sub. When it sees a `move`
 * broadcast, it checks the current authoritative state via `authority.getState`
 * and, if it is the side to move, picks a random legal move and submits it
 * via `authority.apply`.
 *
 * Move choice is seeded per game using `seedFrom(seed, gameId)`. Each game
 * draws from its own deterministic RNG stream keyed by its game ID, so a game's
 * move sequence no longer depends on what other games are doing concurrently.
 *
 * The bot is co-located in the same process as the authority — it calls
 * `authority.apply` directly (no WebSocket). This is the minimal integration;
 * the M14 deployable service would use the engine bridge for bot moves.
 *
 * Promotion handling: `legalMovesOf` collapses promotions to their shared
 * destination square, so the bot emits a 4-char UCI (`origin + dest`). When
 * the position requires a promotion piece, `authority.apply` rejects the
 * 4-char move. On that rejection, the bot retries once with `'q'` (queen
 * promotion) appended — sufficient for a random-move bot that does not need
 * chess knowledge.
 *
 * Determinism lever: if `resignAfterPlies` is set (via the bridge route's
 * `botResignsAfterPlies` body field), the bot resigns on its turn once the
 * game's ply count reaches that threshold. This gives e2e specs a
 * deterministic terminal state without unbounded random play.
 */
import type { GameAuthority } from '@chess-platform/realtime-gateway';
import { ENGINE_BOT_USER_IDS } from '@chess-platform/game';
import { createRng, pick, seedFrom } from './rng.js';
import type { PubSub, Broadcast, StateView } from '@chess-platform/realtime-gateway';

/** A simple random-move bot that plays in any game where it is seated. */
export class BotPlayer {
  private running = false;
  private readonly botUserId: string;
  private readonly games = new Map<string, {
    white: string;
    black: string;
    resignAfterPlies: number | null;
    rng: () => number;
  }>();

  constructor(
    private readonly authority: GameAuthority,
    private readonly pubsub: PubSub,
    private readonly seed = 0x9e3779b9,
  ) {
    this.botUserId = ENGINE_BOT_USER_IDS.novice;
  }

  /** The bot's user id (used when creating games with the bot as a player). */
  get userId(): string {
    return this.botUserId;
  }

  /** Start the bot. */
  start(): void {
    this.running = true;
  }

  /** Stop the bot. */
  stop(): void {
    this.running = false;
    this.games.clear();
  }

  /**
   * Register a game so the bot monitors it. Called when a game is created
   * with the bot as a player. Subscribes to the game's pub/sub channel.
   *
   * @param resignAfterPlies If set, the bot resigns on its turn once the
   *   game's ply count reaches this value. Used by e2e specs for
   *   deterministic termination.
   */
  registerGame(
    gameId: string,
    whiteUserId: string,
    blackUserId: string,
    resignAfterPlies: number | null = null,
  ): void {
    const rng = createRng(seedFrom(this.seed, gameId));
    this.games.set(gameId, { white: whiteUserId, black: blackUserId, resignAfterPlies, rng });
    this.pubsub.subscribe(`game:${gameId}`, (msg: Broadcast) => {
      void this.onBroadcast(gameId, msg);
    });
    // Also try to play immediately (in case it's the bot's turn first)
    this.tryPlay(gameId);
  }

  private async onBroadcast(gameId: string, _msg: Broadcast): Promise<void> {
    if (!this.running) return;
    this.tryPlay(gameId);
  }

  private tryPlay(gameId: string): void {
    if (!this.running) return;

    const gameInfo = this.games.get(gameId);
    if (!gameInfo) return;

    let state: StateView;
    try {
      state = this.authority.getState(gameId);
    } catch {
      return;
    }

    if (state.status.over) return;

    const botIsWhite = gameInfo.white === this.botUserId;
    const botIsBlack = gameInfo.black === this.botUserId;

    if (state.turn === 'w' && !botIsWhite) return;
    if (state.turn === 'b' && !botIsBlack) return;

    // Determinism lever: resign after the configured ply count
    if (gameInfo.resignAfterPlies !== null && state.ply >= gameInfo.resignAfterPlies) {
      void this.authority
        .apply(gameId, this.botUserId, { kind: 'resign' })
        .catch(() => {});
      return;
    }

    // Pick a legal move from the seeded sequence
    const legalMoves = state.legalMoves;
    const origins = Object.keys(legalMoves);
    if (origins.length === 0) return;

    const origin = pick(origins, gameInfo.rng);
    const destinations = legalMoves[origin];
    if (!destinations || destinations.length === 0) return;

    const dest = pick(destinations, gameInfo.rng);
    const uci = `${origin}${dest}`;

    void this.authority
      .apply(gameId, this.botUserId, { kind: 'move', uci })
      .catch(() => {
        const promoUci = `${uci}q`;
        void this.authority
          .apply(gameId, this.botUserId, { kind: 'move', uci: promoUci })
          .catch(() => {});
      });
  }
}
