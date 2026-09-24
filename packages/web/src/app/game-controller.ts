/**
 * Game view controller — a pure, DOM-free orchestrator that bridges
 * {@link GameSync} state to the board UI.
 *
 * It subscribes to {@link GameSync} state changes, projects the current FEN
 * from the authoritative snapshot + live move ledger (using the view-only
 * {@link applyMove} mover), and exposes callbacks for position / status / turn /
 * clock updates. Move submissions are forwarded to {@link GameSync}.
 *
 * This module is the "game view" wiring that M6 requires. It imports from the
 * networking layer (`GameSync`, `GameSyncState`) and the presentation core
 * (`applyMove`) — appropriate for the app composition layer — but never touches
 * the DOM. The concrete DOM wiring (connecting these callbacks to `BoardView`)
 * lands in a later increment.
 */
import type { GameSync, GameSyncState, PresenceInfo } from '../net/game-sync.js';
import type { WsColor, Role, Variant, TimeControl } from '../net/ws-protocol.js';
import { applyMove } from '../core/mover.js';
import type { PromotionRole } from '../core/interaction.js';
import { interpolateRemaining } from '@chess-platform/realtime-gateway/latency';
import { isHumanGamePlayers } from '@chess-platform/game';

/**
 * The unified UI state for game actions, projected from authoritative server state.
 */
export interface GameActionState {
  readonly isPlayer: boolean;
  readonly isHumanGame: boolean;
  readonly connected: boolean;
  readonly isOver: boolean;
  readonly canAbort: boolean;
  readonly drawOffer: 'none' | 'sent' | 'received';
  readonly lastReject: string | null;
  readonly pendingAction: GameSyncState['pendingAction'];
}

export interface GameMetadataState {
  readonly connected: boolean;
  readonly role: Role | null;
  readonly myColor: WsColor | null;
  readonly variant: Variant | null;
  /**
   * The Chess960 starting-position id this game began from, or `null` — for every other variant, for
   * a Chess960 game whose id predates the field, and before the first snapshot arrives.
   *
   * Carried alongside `variant` because it is the same kind of fact: fixed at creation, unchanging
   * for the life of the game, and shown in the metadata strip rather than acted on.
   */
  readonly chess960StartId: number | null;
  readonly timeControl: TimeControl | null;
  readonly presence: PresenceInfo | null;
}

/**
 * Callbacks the controller invokes when the projected game state changes.
 * The consumer (e.g. `bootstrap` or a future game-view module) wires these to
 * the DOM `BoardView` and status elements.
 */
export interface GameControllerCallbacks {
  /** Called when the projected FEN changes (snapshot applied or move replayed). */
  onPosition: (fen: string) => void;
  /** Called when the side-to-move / my-turn status changes. */
  onTurn: (myTurn: boolean) => void;
  /** Called when the clock values change (ms remaining for white / black). */
  onClock: (whiteMs: number, blackMs: number) => void;
  /** Called when the game status changes (e.g. "playing", "checkmate 1-0"). */
  onStatus: (text: string) => void;
  /**
   * Called when the last move changes (from/to squares), so the board can
   * highlight it. Called with `null` when there are no moves yet.
   */
  onLastMove?: (from: string | null, to: string | null) => void;
  /**
   * Called when {@link GameController.lastReplayedMove} changes, including when it becomes `null`.
   *
   * Separate from {@link onPosition} because the two are not the same event: a resync at the
   * position already on screen changes the explainable move without changing the FEN.
   */
  onExplainableChange?: () => void;
  /**
   * Called when the controller's color is first resolved from the server's
   * `joined` message (via `GameSyncState.myColor`). The bootstrap uses this
   * to set board orientation. Called once, with `null` for spectators.
   */
  onColor?: (color: WsColor | null) => void;
  /**
   * Called when the availability or status of game actions changes.
   */
  onActionState?: (state: GameActionState) => void;
  /**
   * Called when metadata or presence changes.
   */
  onMetadata?: (state: GameMetadataState) => void;
}

/**
 * Options for constructing a {@link GameController}.
 */
export interface GameControllerOptions {
  readonly gameSync: GameSync;
  readonly callbacks: GameControllerCallbacks;
  /** Injected timer (for tests). */
  readonly setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (id: ReturnType<typeof setInterval>) => void;
  /** Injected clock (for tests). Defaults to Date.now. */
  readonly now?: () => number;
  /** Countdown tick interval in ms (default 100ms). */
  readonly tickIntervalMs?: number;
}

/**
 * Pure, DOM-free game view controller.
 *
 * Create via the composition root, then call {@link GameController.start} to
 * begin listening to `GameSync` state. Call {@link GameController.stop} to
 * unsubscribe. Call {@link GameController.submitMove} to forward a move
 * intention to the server via `GameSync`.
 */
export class GameController {
  private readonly gameSync: GameSync;
  private readonly callbacks: GameControllerCallbacks;
  private readonly _setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly _clearInterval: (id: ReturnType<typeof setInterval>) => void;
  private readonly now: () => number;
  private readonly tickIntervalMs: number;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private lastState: GameSyncState | null = null;

  private unsubscribe: (() => void) | null = null;
  private currentFen = '';
  /** Backing field for {@link lastReplayedMove}. */
  private lastReplayed: { readonly fen: string; readonly uci: string } | null = null;
  private currentMyTurn: boolean | undefined = undefined;
  private currentLastMove: { from: string; to: string } | null | undefined = undefined;
  private currentClock: { w: number; b: number } | undefined = undefined;
  private lastEmittedSec: { w: number; b: number } | undefined = undefined;
  private currentActionState: GameActionState | undefined = undefined;
  private currentMetadataState: GameMetadataState | undefined = undefined;
  private colorEmitted = false;

  constructor(options: GameControllerOptions) {
    this.gameSync = options.gameSync;
    this.callbacks = options.callbacks;
    this._setInterval = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = options.clearInterval ?? ((id) => clearInterval(id));
    this.now = options.now ?? (() => Date.now());
    this.tickIntervalMs = options.tickIntervalMs ?? 100;
  }

  /** Start listening to GameSync state changes. */
  start(): void {
    this.unsubscribe = this.gameSync.subscribe((state) => this.handleState(state));
    // Emit the current state immediately (may be pre-join, empty).
    this.handleState(this.gameSync.getState());
  }

  /** Stop listening to state changes and stop GameSync. */
  stop(): void {
    this.stopTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.gameSync.stop();
  }

  /** Teardown the controller (alias for {@link stop}). */
  dispose(): void {
    this.stop();
  }

  /** The current projected FEN (valid at the latest applied ply). */
  get fen(): string {
    return this.currentFen;
  }

  /**
   * The last move this controller replayed, with the position it was played from — or `null` when
   * there is no such move.
   *
   * `null` is common and not an error. The server's snapshot is authoritative *at its own ply*, and
   * `MoveView` carries no per-move FEN, so the position before a move is recoverable only for moves
   * this controller applied itself. Joining a game mid-play therefore has nothing to explain until
   * the next move arrives, and a finished game reviewed from a snapshot has nothing to explain at
   * all.
   *
   * That limit is deliberate rather than worked around: recovering earlier positions means either a
   * parallel move-history model on the client or replaying from a starting position the server does
   * not send (and which Chess960 does not have a fixed value for). Explaining arbitrary past moves is
   * its own increment; this is the honest subset that needs no new state.
   */
  get lastReplayedMove(): { readonly fen: string; readonly uci: string } | null {
    return this.lastReplayed;
  }

  /**
   * The full authoritative UCI move sequence from ply 1, or `null` when there is not one.
   *
   * Unlike {@link lastReplayedMove} this is available for a game joined mid-play: the gateway's
   * snapshot carries the whole ledger, so every `MoveView.uci` back to the first is on the wire
   * even when the position each was played from is not.
   *
   * `null` rather than a best effort when the ledger is not a contiguous run from ply 1. An
   * opening is identified by a sequence read from the start, so a gap — or a ledger that begins
   * part-way through — would name an opening for moves that were never played in that order. There
   * is no partial answer to give, and giving one would be wrong rather than incomplete.
   */
  get moveSequence(): readonly string[] | null {
    const state = this.lastState;
    if (state === null || state.snapshot === null) return null;
    const moves = state.moves;
    for (let i = 0; i < moves.length; i++) {
      if (moves[i]!.ply !== i + 1) return null;
    }
    return moves.map((move) => move.uci);
  }

  /**
   * Submit an intended move (UCI) to the server via GameSync. Returns the
   * pending move info, or `null` if the send failed (e.g. not a player or
   * socket not open).
   */
  submitMove(uci: string): { readonly uci: string; readonly clientSeq: number } | null {
    return this.gameSync.submitMove(uci);
  }

  resign(): boolean {
    if (!this.canResign()) return false;
    return this.gameSync.resign();
  }

  abort(): boolean {
    if (!this.canAbort()) return false;
    return this.gameSync.abort();
  }

  offerDraw(): boolean {
    if (!this.canOfferDraw()) return false;
    return this.gameSync.offerDraw();
  }

  acceptDraw(): boolean {
    if (!this.canRespondToDraw()) return false;
    return this.gameSync.acceptDraw();
  }

  declineDraw(): boolean {
    if (!this.canRespondToDraw()) return false;
    return this.gameSync.declineDraw();
  }

  claimFlag(): boolean {
    if (!this.canClaimFlag()) return false;
    return this.gameSync.claimFlag();
  }

  private canResign(): boolean {
    return this.currentActionState?.isPlayer === true &&
           this.currentActionState?.connected === true &&
           !this.currentActionState?.isOver &&
           this.currentActionState?.pendingAction === null;
  }

  private canAbort(): boolean {
    return this.canResign() && this.currentActionState?.canAbort === true;
  }

  private canOfferDraw(): boolean {
    return this.canResign() && this.currentActionState?.drawOffer === 'none';
  }

  private canRespondToDraw(): boolean {
    return this.canResign() && this.currentActionState?.drawOffer === 'received';
  }

  private canClaimFlag(): boolean {
    return this.canResign();
  }

  private startTimer(): void {
    if (this.timerId !== null) return;
    this.timerId = this._setInterval(() => this.tickClock(), this.tickIntervalMs);
  }

  private stopTimer(): void {
    if (this.timerId !== null) {
      this._clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private tickClock(): void {
    if (this.lastState !== null) {
      this.updateClockDisplay(this.lastState, false);
    }
  }

  private updateClockDisplay(state: GameSyncState, isAuthoritative = false): void {
    if (state.clock === null) return;

    let displayW = state.clock.w;
    let displayB = state.clock.b;

    if (state.status?.over === false && state.turn !== null && state.turnStartedAt !== null) {
      const nowMs = this.now();
      const skewMs = this.gameSync.skew;
      if (state.turn === 'w') {
        displayW = interpolateRemaining(state.clock.w, state.turnStartedAt, nowMs, skewMs);
      } else {
        displayB = interpolateRemaining(state.clock.b, state.turnStartedAt, nowMs, skewMs);
      }
    }

    const secW = Math.max(0, Math.floor(displayW / 1000));
    const secB = Math.max(0, Math.floor(displayB / 1000));

    const shouldEmit = isAuthoritative
      || this.lastEmittedSec === undefined
      || this.lastEmittedSec.w !== secW
      || this.lastEmittedSec.b !== secB;

    if (shouldEmit) {
      this.currentClock = { w: displayW, b: displayB };
      this.lastEmittedSec = { w: secW, b: secB };
      this.callbacks.onClock(displayW, displayB);
    }
  }

  /** Project authoritative game state into board, clock, and fair-play control visibility. */
  private handleState(state: GameSyncState): void {
    this.lastState = state;
    // --- Position projection ---
    if (state.snapshot !== null) {
      let fen = state.snapshot.fen;
      // The position immediately before the most recently replayed move, and that move in full.
      // Kept because explaining a move needs the position it was played *from*, and applying a move
      // is one-way — once `fen` advances, the position it came from is gone.
      let previousFen: string | null = null;
      let lastUci: string | null = null;
      // Replay only moves that came after the snapshot ply. The snapshot FEN
      // is already the position at snapshot.ply; the moves ledger includes
      // snapshot moves + live broadcasts, so we must skip the pre-snapshot ones.
      for (const move of state.moves) {
        if (move.ply > state.snapshot.ply) {
          previousFen = fen;
          // The whole UCI, promotion suffix included. The `onLastMove` highlight below deliberately
          // keeps only the two squares because that is all a highlight needs, but `e7e8q` and `e7e8n`
          // are different moves and an explanation of the wrong one would be wrong about everything
          // downstream of it.
          lastUci = move.uci;
          fen = applyMove(fen, {
            from: move.uci.slice(0, 2),
            to: move.uci.slice(2, 4),
            ...(move.uci.length > 4 ? { promotion: move.uci[4] as PromotionRole } : {}),
          });
        }
      }
      const replayed = previousFen !== null && lastUci !== null
        ? { fen: previousFen, uci: lastUci }
        : null;
      // Announced separately from `onPosition`, because the two can change independently. An
      // authoritative snapshot taken at the position already on screen clears the replayed move —
      // there is nothing after the snapshot ply to replay — while the FEN is unchanged, so
      // `onPosition` stays silent and a consumer keyed on it would keep offering to explain a move
      // it can no longer identify. Raised in the Qodo review of PR #135.
      const changed =
        (replayed === null) !== (this.lastReplayed === null) ||
        (replayed !== null &&
          this.lastReplayed !== null &&
          (replayed.fen !== this.lastReplayed.fen || replayed.uci !== this.lastReplayed.uci));
      this.lastReplayed = replayed;
      if (changed) this.callbacks.onExplainableChange?.();
      if (fen !== this.currentFen) {
        this.currentFen = fen;
        this.callbacks.onPosition(fen);
      }
    }

    // --- Color (emit once when resolved from server join) ---
    if (!this.colorEmitted && state.myColor !== null) {
      this.colorEmitted = true;
      this.callbacks.onColor?.(state.myColor);
    } else if (!this.colorEmitted && state.role !== null) {
      // Spectator: role is resolved but myColor is null.
      this.colorEmitted = true;
      this.callbacks.onColor?.(null);
    }

    // --- Turn ---
    // Derive myTurn from GameSyncState: it's our turn only when the server
    // assigned us a color, it's our color's turn, and no optimistic move is
    // pending (the pending===null term closes the stale-oracle race during
    // the optimistic window — see M6). Fire onTurn when the *derived* value
    // changes, not just when state.turn changes, because pending toggles
    // while turn stays constant.
    const myTurn = state.turn !== null
      && state.myColor !== null
      && state.turn === state.myColor
      && state.pending === null;
    if (myTurn !== this.currentMyTurn) {
      this.currentMyTurn = myTurn;
      this.callbacks.onTurn(myTurn);
    }

    // --- Clock (with change detection and live countdown timer) ---
    const isLive = state.status?.over === false && state.clock !== null && state.turn !== null && state.turnStartedAt !== null;
    if (isLive) {
      this.startTimer();
    } else {
      this.stopTimer();
    }
    this.updateClockDisplay(state, true);

    // --- Status ---
    const statusText = this.statusText(state);
    this.callbacks.onStatus(statusText);

    // --- Last move ---
    if (this.callbacks.onLastMove) {
      const lastMove = state.moves.length > 0
        ? { from: state.moves[state.moves.length - 1]!.uci.slice(0, 2), to: state.moves[state.moves.length - 1]!.uci.slice(2, 4) }
        : null;
      const changed = (this.currentLastMove === undefined) ||
        (lastMove === null && this.currentLastMove !== null) ||
        (lastMove !== null && (this.currentLastMove === null || this.currentLastMove === undefined ||
          lastMove.from !== this.currentLastMove.from || lastMove.to !== this.currentLastMove.to));
      if (changed) {
        this.currentLastMove = lastMove;
        this.callbacks.onLastMove(lastMove?.from ?? null, lastMove?.to ?? null);
      }
    }

    // --- Action State ---
    const isPlayer = state.myColor !== null;
    const players = state.snapshot?.players;
    const isHumanGame = players !== undefined && isHumanGamePlayers(players);
    const connected = state.connected;
    const isOver = state.status?.over ?? false;
    const canAbort = state.ply < 2;
    const drawOffer: 'none' | 'sent' | 'received' = state.myColor === null || state.drawOffer === null
      ? 'none'
      : state.drawOffer === state.myColor
        ? 'sent'
        : 'received';
    const lastReject = state.lastReject ? state.lastReject.message : null;
    const pendingAction = state.pendingAction;

    const actionChanged = this.currentActionState === undefined
      || this.currentActionState.isPlayer !== isPlayer
      || this.currentActionState.isHumanGame !== isHumanGame
      || this.currentActionState.connected !== connected
      || this.currentActionState.isOver !== isOver
      || this.currentActionState.canAbort !== canAbort
      || this.currentActionState.drawOffer !== drawOffer
      || this.currentActionState.lastReject !== lastReject
      || this.currentActionState.pendingAction !== pendingAction;

    if (actionChanged) {
      this.currentActionState = {
        isPlayer,
        isHumanGame,
        connected,
        isOver,
        canAbort,
        drawOffer,
        lastReject,
        pendingAction,
      };
      if (this.callbacks.onActionState) {
        this.callbacks.onActionState(this.currentActionState);
      }
    }

    // --- Metadata State ---
    const tc1 = this.currentMetadataState?.timeControl ?? null;
    const tc2 = state.snapshot?.timeControl ?? null;
    const timeControlChanged = tc1 === null && tc2 !== null
      || tc1 !== null && tc2 === null
      || (tc1 !== null && tc2 !== null && (
          tc1.kind !== tc2.kind ||
          tc1.initialMs !== tc2.initialMs ||
          tc1.incrementMs !== tc2.incrementMs ||
          tc1.delayMs !== tc2.delayMs
      ));

    const metadataChanged = this.currentMetadataState === undefined
      || this.currentMetadataState.connected !== state.connected
      || this.currentMetadataState.role !== state.role
      || this.currentMetadataState.myColor !== state.myColor
      || this.currentMetadataState.variant !== (state.snapshot?.variant ?? null)
      || this.currentMetadataState.chess960StartId !== (state.snapshot?.chess960StartId ?? null)
      || timeControlChanged
      || this.currentMetadataState.presence?.white !== state.presence?.white
      || this.currentMetadataState.presence?.black !== state.presence?.black
      || this.currentMetadataState.presence?.spectators !== state.presence?.spectators;

    if (metadataChanged) {
      this.currentMetadataState = {
        connected: state.connected,
        role: state.role,
        myColor: state.myColor,
        variant: state.snapshot?.variant ?? null,
        chess960StartId: state.snapshot?.chess960StartId ?? null,
        timeControl: state.snapshot?.timeControl ?? null,
        presence: state.presence ? { ...state.presence } : null,
      };
      if (this.callbacks.onMetadata) {
        this.callbacks.onMetadata(this.currentMetadataState);
      }
    }
  }

  private statusText(state: GameSyncState): string {
    if (state.status === null) return 'Waiting…';
    if (!state.status.over) {
      if (state.turn === null) return 'Waiting…';
      const turnLabel = state.turn === 'w' ? 'White' : 'Black';
      if (state.myColor === null) return `${turnLabel} to move`;
      const myTurn = state.turn === state.myColor;
      return myTurn ? 'Your move' : `${turnLabel} to move`;
    }
    // Game over
    const { result, termination, winner } = state.status;
    const winnerLabel = winner === 'w' ? 'White' : winner === 'b' ? 'Black' : null;
    if (termination === 'checkmate' && winnerLabel) return `Checkmate — ${winnerLabel} wins (${result})`;
    if (termination === 'resignation' && winnerLabel) return `${winnerLabel} wins by resignation (${result})`;
    if (termination === 'timeout' && winnerLabel) return `${winnerLabel} wins on time (${result})`;
    if (termination === 'stalemate') return `Stalemate (${result})`;
    if (termination === 'agreement') return `Draw by agreement (${result})`;
    if (termination === 'insufficient_material') return `Draw — insufficient material (${result})`;
    if (termination === 'fifty_move') return `Draw — fifty-move rule (${result})`;
    if (termination === 'threefold') return `Draw — threefold repetition (${result})`;
    if (termination === 'variant') return `Variant end (${result})`;
    if (termination === 'aborted') return 'Game aborted';
    return `${result}`;
  }
}
