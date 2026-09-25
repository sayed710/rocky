/**
 * @packageDocumentation
 * Autonomous engine bot move executor for live games (M14 inc 13, ADR-0080).
 *
 * Listens for game state updates via pub/sub and triggers engine move generation
 * when it is a bot account's turn. Submits moves through the CommandRouter so multi-node
 * ownership and forwarding (ADR-0010) are honored.
 *
 * Under multi-node routing, only the replica that owns a game computes its bot moves. A
 * non-owner's cached aggregate never sees the owner's moves (they arrive as room broadcasts), so a
 * move computed from it is a move for a position the game has left — and the owner would apply it
 * whenever it happens to be legal. Ownership is therefore settled BEFORE the engine runs, and
 * re-checked together with the position AFTER it, because either can change while it thinks.
 */

import type { AnalysisProvider } from '@chess-platform/engine';
import { JobPriority } from '@chess-platform/engine';
import {
  AuthorityError,
  gameChannel,
  type CommandRouter,
  type GameAuthority,
  type PubSub,
  type StateView,
  type Unsubscribe,
} from '@chess-platform/realtime-gateway';
import { botAccountByUserId } from '@chess-platform/api';
import type { Counter, Histogram, Logger } from '@chess-platform/api';

/**
 * Fixed think time allocated for engine bot moves (300ms).
 * Gives humanlike response time while keeping UCI worker utilization low.
 */
const BOT_THINK_TIME_MS = 300;

/** How often a replica that does not own a bot game checks back; serve.ts passes the lease TTL. */
const DEFAULT_NON_OWNER_RECHECK_MS = 30_000;

/**
 * Ownership gate for multi-node routing (ADR-0010), implemented by `RedisCommandRouter`.
 * Absent on a single node, which owns every game.
 */
export interface BotMoveOwnership {
  /** Claim or confirm ownership and settle takeover rehydration; `false` if another node owns it. */
  prepareOwnership(gameId: string): Promise<boolean>;
  /** Whether this node still owns the game on a fresh copy — checked after the engine returns. */
  holdsOwnership(gameId: string): boolean;
}

export interface EngineBotMoverOptions {
  readonly authority: GameAuthority;
  readonly router: CommandRouter;
  readonly pubsub: PubSub;
  readonly provider: AnalysisProvider;
  readonly ownership?: BotMoveOwnership;
  /** Interval at which a non-owner re-checks a registered game (see `scheduleRecheck`). */
  readonly nonOwnerRecheckMs?: number;
  readonly logger?: Logger;
  readonly movesCounter?: Counter;
  readonly failuresCounter?: Counter;
  readonly moveSecondsHistogram?: Histogram;
}

export class EngineBotMover {
  private readonly authority: GameAuthority;
  private readonly router: CommandRouter;
  private readonly pubsub: PubSub;
  private readonly provider: AnalysisProvider;
  private readonly ownership?: BotMoveOwnership;
  private readonly nonOwnerRecheckMs: number;
  private readonly logger?: Logger;
  private readonly movesCounter?: Counter;
  private readonly failuresCounter?: Counter;
  private readonly moveSecondsHistogram?: Histogram;

  private readonly subscriptions = new Map<string, Unsubscribe>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /**
   * Games whose state changed while a move was already in flight.
   *
   * Coalescing a concurrent trigger into the in-flight promise is not enough on its own: pub/sub
   * delivery is synchronous, so the broadcast caused by the bot's *own* routed move arrives while
   * `doMove` is still running. Dropping that trigger means a game the bot just ended is never
   * re-examined, so it is never unregistered and its subscription outlives the game.
   */
  private readonly pendingRerun = new Set<string>();
  /** Pending non-owner re-checks, one per game. */
  private readonly rechecks = new Map<string, ReturnType<typeof setTimeout>>();
  /** Games whose next pass must first reload this node's copy from the durable log. */
  private readonly reloadBeforeNextPass = new Set<string>();

  constructor(opts: EngineBotMoverOptions) {
    this.authority = opts.authority;
    this.router = opts.router;
    this.pubsub = opts.pubsub;
    this.provider = opts.provider;
    this.ownership = opts.ownership;
    this.nonOwnerRecheckMs = opts.nonOwnerRecheckMs ?? DEFAULT_NON_OWNER_RECHECK_MS;
    this.logger = opts.logger;
    this.movesCounter = opts.movesCounter;
    this.failuresCounter = opts.failuresCounter;
    this.moveSecondsHistogram = opts.moveSecondsHistogram;
  }

  /**
   * Register a game to be monitored for bot moves.
   * Safe to call multiple times for the same game (idempotent).
   */
  registerGame(gameId: string): void {
    if (!this.subscriptions.has(gameId)) {
      const unsub = this.pubsub.subscribe(gameChannel(gameId), (msg) => {
        // A non-owner's cached copy never reaches `over`, so the terminal broadcast is the only
        // signal that stops bot work for this game on every replica.
        if (msg.t === 'ended') {
          this.unregisterGame(gameId);
          return;
        }
        void this.attemptMove(gameId);
      });
      this.subscriptions.set(gameId, unsub);
    }
    // Attempt move immediately upon registration to handle cases where the bot
    // moves first (e.g. Bot plays White at ply 0).
    void this.attemptMove(gameId);
  }

  /** Unregister a game and remove its pub/sub subscription. */
  unregisterGame(gameId: string): void {
    clearTimeout(this.rechecks.get(gameId));
    this.rechecks.delete(gameId);
    this.reloadBeforeNextPass.delete(gameId);
    const unsub = this.subscriptions.get(gameId);
    if (unsub) {
      unsub();
      this.subscriptions.delete(gameId);
    }
  }

  /**
   * Attempt to make a move for the specified game if it is currently a bot's turn.
   * Concurrency guard ensures at most one in-flight play() operation per game.
   */
  async attemptMove(gameId: string): Promise<void> {
    const active = this.inFlight.get(gameId);
    if (active) {
      this.pendingRerun.add(gameId);
      await active;
      return;
    }
    const run = this.drainMoves(gameId);
    this.inFlight.set(gameId, run);
    await run;
  }

  /**
   * Run moves for a game until no further trigger arrived while the last one was running.
   *
   * The loop terminates because each pass either moves (handing the turn to the opponent, whose
   * broadcast only re-enters when it is the bot's turn again) or returns without publishing
   * anything, and a pass that publishes nothing cannot set `pendingRerun` — except a pass that
   * drops a stale engine result, which asks for exactly one more pass to re-check from scratch.
   */
  private async drainMoves(gameId: string): Promise<void> {
    try {
      do {
        this.pendingRerun.delete(gameId);
        await this.doMove(gameId);
      } while (this.pendingRerun.has(gameId));
    } finally {
      this.pendingRerun.delete(gameId);
      this.inFlight.delete(gameId);
    }
  }

  private async doMove(gameId: string): Promise<void> {
    let state: StateView;
    try {
      if (this.reloadBeforeNextPass.delete(gameId)) await this.authority.reloadFromLog(gameId);
      // A cached copy can be behind, but an ending is final, so a copy that says `over` is right.
      if (this.authority.hasFresh(gameId) && this.authority.getState(gameId).status.over) {
        this.unregisterGame(gameId);
        return;
      }
      if (this.ownership && !(await this.ownership.prepareOwnership(gameId))) {
        this.scheduleRecheck(gameId);
        return;
      }
      state = this.authority.getState(gameId);
    } catch (err: unknown) {
      if (err instanceof AuthorityError && err.code === 'unknown_game') {
        this.unregisterGame(gameId);
        return;
      }
      this.scheduleRecheck(gameId);
      this.failuresCounter?.inc();
      this.logger?.warn(`[EngineBotMover] Failed to get state for game ${gameId}`, {
        gameId,
        err: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      return;
    }

    if (state.status.over) {
      this.unregisterGame(gameId);
      return;
    }

    const currentUserId = state.turn === 'w' ? state.players.white : state.players.black;
    if (!currentUserId) return;

    const botAcc = botAccountByUserId(currentUserId);
    if (!botAcc) {
      // Not a bot's turn. Check if neither player is a bot to drop non-bot games.
      const whiteBot = state.players.white ? botAccountByUserId(state.players.white) : undefined;
      const blackBot = state.players.black ? botAccountByUserId(state.players.black) : undefined;
      if (!whiteBot && !blackBot) {
        this.unregisterGame(gameId);
      }
      return;
    }

    const startTime = performance.now();
    try {
      const result = await this.provider.play({
        fen: state.fen,
        variant: state.variant,
        limits: { timeMs: BOT_THINK_TIME_MS },
        strength: botAcc.strength,
        priority: JobPriority.BotMove,
      });

      const durationSec = (performance.now() - startTime) / 1000;
      this.moveSecondsHistogram?.observe(durationSec);

      // Ownership and the game can both move on while the engine thinks. Submit only if this
      // node still owns the game and it is still the exact position the move was computed for.
      // Otherwise drop it and look again: a changed position has queued a re-run already, but a
      // lapsed lease announces nothing, and the bot may still be to move.
      if (!this.stillCurrent(gameId, state, botAcc.userId)) {
        this.pendingRerun.add(gameId);
        return;
      }

      await this.router.route(gameId, botAcc.userId, {
        kind: 'move',
        uci: result.move,
      });

      this.movesCounter?.inc();
    } catch (err: unknown) {
      this.failuresCounter?.inc();
      this.logger?.warn(`[EngineBotMover] Bot move failed for game ${gameId}`, {
        gameId,
        err: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
  }

  /**
   * Whether `computedFor` is still the live position on an owned, fresh copy with the bot to move.
   *
   * Synchronous and immediately followed by `route()`, whose owner fast path applies without I/O
   * in between: while the lease is valid no other node can own the game, and in `computedFor` only
   * the bot has a legal move, so no other command can change the position before the apply. (A
   * resignation can still end the game first; the authority then rejects the move as game over.)
   */
  private stillCurrent(gameId: string, computedFor: StateView, botUserId: string): boolean {
    if (this.ownership && !this.ownership.holdsOwnership(gameId)) return false;
    let now: StateView;
    try {
      now = this.authority.getState(gameId);
    } catch {
      return false;
    }
    const botToMove = (now.turn === 'w' ? now.players.white : now.players.black) === botUserId;
    return !now.status.over && botToMove && now.ply === computedFor.ply && now.fen === computedFor.fen;
  }

  /**
   * Check back on a game this node registered but does not own.
   *
   * The subscription alone is not enough: nothing is broadcast when a dead owner's lease expires,
   * and a missed `ended` broadcast (Redis pub/sub is best-effort) leaves a game this node's stale
   * copy will never see finish. So a non-owner looks again every `nonOwnerRecheckMs`, reloading its
   * copy from the durable log first: a finished game unregisters, and an orphaned one is claimed.
   */
  private scheduleRecheck(gameId: string): void {
    if (!this.ownership || this.rechecks.has(gameId) || !this.subscriptions.has(gameId)) return;
    const timer = setTimeout(() => {
      this.rechecks.delete(gameId);
      this.reloadBeforeNextPass.add(gameId);
      void this.attemptMove(gameId);
    }, this.nonOwnerRecheckMs);
    timer.unref?.();
    this.rechecks.set(gameId, timer);
  }

  /** Stop all subscriptions and clear state for graceful shutdown. */
  stop(): void {
    for (const timer of this.rechecks.values()) clearTimeout(timer);
    this.rechecks.clear();
    this.reloadBeforeNextPass.clear();
    for (const unsub of this.subscriptions.values()) {
      unsub();
    }
    this.subscriptions.clear();
    this.inFlight.clear();
    this.pendingRerun.clear();
  }
}
