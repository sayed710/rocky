/**
 * Game synchronization layer — client state synchronization over {@link WsClient}.
 *
 * `GameSync` turns the raw message stream into an authoritative, observable
 * client-side game state. It:
 *   - joins on first connect and, after a drop, **resumes** from the last seen
 *     ply so the server can replay what was missed;
 *   - keeps the last full authoritative {@link StateView} snapshot plus the live
 *     move ledger (ply/turn/clock/status) applied from move/ended broadcasts;
 *   - detects a ply gap (a missed broadcast) and requests a resync;
 *   - tracks an optimistic pending move by `clientSeq` and clears it when the
 *     matching broadcast confirms it or a {@link RejectMessage} rolls it back.
 *
 * It performs no chess rules and no rendering: legality and board projection
 * stay with `@chess-platform/core` / the UI. `fen` is only valid at
 * `snapshot.ply`; consumers replay `moves` after it with the view-only mover.
 */
import type { WsClient } from './ws-client.js';
import type {
  EndedBroadcast,
  GameStatus,
  LegalMoves,
  MoveBroadcast,
  MoveView,
  ReadyView,
  RejectMessage,
  Role,
  ServerMessage,
  SimpleCommand,
  StateView,
  WsColor,
} from './ws-protocol.js';
import { colorForRole, opposite } from './ws-protocol.js';

export interface PresenceInfo {
  readonly white: boolean;
  readonly black: boolean;
  readonly spectators: number;
}

export interface PendingMove {
  readonly uci: string;
  readonly clientSeq: number;
}

/** Observable, authoritative client-side game state. */
export interface GameSyncState {
  readonly gameId: string;
  /** True while the underlying socket is open. */
  readonly connected: boolean;
  readonly role: Role | null;
  /** Our wire color, or null when spectating / unknown. */
  readonly myColor: WsColor | null;
  /** Last full authoritative snapshot; `fen` is valid at `snapshot.ply`. */
  readonly snapshot: StateView | null;
  /** Full authoritative move ledger (snapshot moves + live broadcasts). */
  readonly moves: readonly MoveView[];
  readonly ply: number;
  readonly turn: WsColor | null;
  readonly clock: { readonly w: number; readonly b: number } | null;
  /** Server timestamp (ms) when turn started (anchor for interpolation). */
  readonly turnStartedAt: number | null;
  readonly status: GameStatus | null;
  readonly drawOffer: WsColor | null;
  readonly fenHash: string | null;
  readonly presence: PresenceInfo | null;
  /**
   * Durable readiness per seat, or `null` for a game without a pregame lifecycle (ADR-0148). From
   * the snapshot and `ready` broadcasts; transient `presence` never changes it.
   */
  readonly ready: ReadyView | null;
  /**
   * Authoritative legal-move map for the side to move (origin square → legal
   * destination squares), from the latest server snapshot or move broadcast.
   * Refreshed on every MoveBroadcast via the push-based `legalMoves` field;
   * empty (`{}`) once the game is over. The frontend consumes this — it never
   * derives legality itself.
   */
  readonly legalMoves: LegalMoves;
  /** Our un-acknowledged optimistic move, if any. */
  readonly pending: PendingMove | null;
  /** The most recent rejection (e.g. for surfacing a rollback reason). */
  readonly lastReject: RejectMessage | null;
  /** The action currently awaiting server acknowledgment. */
  readonly pendingAction: SimpleCommand | null;
}

export interface GameSyncOptions {
  readonly gameId: string;
  /** Access token for authenticated join; omitted for anonymous spectators. */
  readonly token?: string;
}

export type GameSyncListener = (state: GameSyncState) => void;

/**
 * The clock anchor as a number, or null for "no anchor".
 *
 * `decodeServer()` validates only the `t` discriminant and casts the rest, so every other field is
 * a claim about the frame rather than a fact about it. That was harmless while the wire values were
 * only rendered; this one is multiplied into a countdown ten times a second, and `undefined` here
 * yields `NaN` remaining and a `NaN:NaN` clock face. A gateway that predates ADR-0103 sends exactly
 * that frame, which a rolling deploy makes an ordinary Tuesday rather than a malformed-input edge
 * case. Coerced once here, at the boundary, so nothing downstream has to re-check it.
 */
function clockAnchor(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Readiness as the client trusts it: `null` unless both seats are booleans. `decodeServer()` checks
 * only `t`, and a gateway older than ADR-0148 sends no `ready` at all, which must read as "this game
 * has no readiness" rather than as two unready seats that would lock the board.
 */
function readyView(value: unknown): ReadyView | null {
  if (typeof value !== 'object' || value === null) return null;
  const { w, b } = value as { w?: unknown; b?: unknown };
  return typeof w === 'boolean' && typeof b === 'boolean' ? { w, b } : null;
}

function mergeReady(current: ReadyView | null, next: ReadyView | null): ReadyView | null {
  if (next === null) return current;
  if (current === null) return next;
  return { w: current.w || next.w, b: current.b || next.b };
}

function initialState(gameId: string): GameSyncState {
  return {
    gameId,
    connected: false,
    role: null,
    myColor: null,
    snapshot: null,
    moves: [],
    ply: 0,
    turn: null,
    clock: null,
    turnStartedAt: null,
    status: null,
    drawOffer: null,
    fenHash: null,
    presence: null,
    ready: null,
    legalMoves: {},
    pending: null,
    lastReject: null,
    pendingAction: null,
  };
}

export class GameSync {
  private readonly client: WsClient;
  private readonly gameId: string;
  private token: string | undefined;
  private state: GameSyncState;
  private clientSeq = 0;
  private joined = false;
  private readonly listeners = new Set<GameSyncListener>();
  private unsubscribe: (() => void) | null = null;
  private reconnectLastPly: number | null = null;

  constructor(client: WsClient, options: GameSyncOptions) {
    this.client = client;
    this.gameId = options.gameId;
    this.token = options.token;
    this.state = initialState(options.gameId);
  }

  getState(): GameSyncState {
    return this.state;
  }

  /** Estimated clock skew (ms; serverClock - clientClock) from the WebSocket client. */
  get skew(): number {
    return this.client.skew ?? 0;
  }

  subscribe(listener: GameSyncListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Set the access token used for the authenticated join. Must be called
   * before {@link start}. Used when the token is obtained asynchronously (e.g.
   * via the httpOnly refresh cookie on reload) after this GameSync is built.
   */
  setToken(token: string): void {
    this.token = token;
  }

  /** The browser reported the network went offline — drop into reconnect now. */
  networkOffline(): void {
    this.client.networkOffline();
  }

  /** The browser reported it is back online — retry the connection immediately. */
  networkOnline(): void {
    this.client.reconnectNow();
  }

  /** Wire up the client and open the connection. */
  start(): void {
    this.unsubscribe = this.client.on({
      open: () => this.handleOpen(),
      message: (msg) => this.handleMessage(msg),
      statechange: (state) => this.patch({ connected: state === 'open' }),
    });
    this.client.connect();
  }

  /**
   * Tear down: unsubscribe from the client. Does NOT close the shared
   * `WsClient` — the composition root owns the connection lifecycle (M5).
   * Stopping one GameSync must not kill the app-wide socket and every other
   * GameSync on it.
   */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Submit an intended move. Assigns the next `clientSeq`, records it as the
   * optimistic pending move, and sends it. Returns the pending move, or null if:
   * - we are not a player (`myColor === null`)
   * - the game is over (`status?.over`)
   * - it is not our turn (`turn !== myColor`)
   * - a move is already pending (`pending !== null` — one in-flight at a time)
   * - the send failed (e.g. socket not open)
   *
   * The turn/over/pending gates (M6) prevent noisy rejected moves and UI jank
   * from stale oracle destinations during the optimistic window.
   */
  submitMove(uci: string): PendingMove | null {
    if (this.state.myColor === null) return null;
    if (this.state.status?.over) return null;
    if (this.state.turn !== this.state.myColor) return null;
    if (this.state.pending !== null) return null;
    const clientSeq = this.clientSeq + 1;
    const sent = this.client.send({ t: 'move', gameId: this.gameId, uci, clientSeq });
    if (!sent) return null;
    this.clientSeq = clientSeq;
    const pending: PendingMove = { uci, clientSeq };
    this.patch({ pending, lastReject: null });
    return pending;
  }

  resign(): boolean {
    return this.sendAction('resign');
  }

  offerDraw(): boolean {
    return this.sendAction('offerDraw');
  }

  acceptDraw(): boolean {
    return this.sendAction('acceptDraw');
  }

  declineDraw(): boolean {
    return this.sendAction('declineDraw');
  }

  claimFlag(): boolean {
    return this.sendAction('claimFlag');
  }

  abort(): boolean {
    return this.sendAction('abort');
  }

  private sendAction(action: SimpleCommand): boolean {
    if (this.state.pending !== null || this.state.pendingAction !== null || this.state.status?.over) return false;
    const sent = this.client.send({ t: action, gameId: this.gameId });
    if (sent) this.patch({ pendingAction: action, lastReject: null });
    return sent;
  }

  private handleOpen(): void {
    if (this.joined) {
      this.reconnectLastPly = this.state.ply;
    }
    this.client.send({ t: 'join', gameId: this.gameId, ...(this.token !== undefined ? { token: this.token } : {}) });
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'joined': {
        const reconnectPly = this.reconnectLastPly;
        this.reconnectLastPly = null;
        this.joined = true;
        this.applySnapshot(msg.state, msg.role);
        if (reconnectPly !== null && reconnectPly < msg.state.ply) {
          this.client.send({ t: 'resume', gameId: this.gameId, lastPly: reconnectPly });
        }
        break;
      }
      case 'state':
        this.applySnapshot(msg.state, this.state.role);
        break;
      case 'resumed':
        // The snapshot is complete and authoritative; `missed` is only needed for
        // move-by-move animation, which is a UI concern (deferred to that increment).
        this.applySnapshot(msg.state, this.state.role);
        break;
      case 'move':
        this.applyMove(msg);
        break;
      case 'ended':
        this.applyEnded(msg);
        break;
      case 'presence':
        this.patch({ presence: { white: msg.white, black: msg.black, spectators: msg.spectators } });
        break;
      case 'ready':
        // Readiness only grows, so merging keeps a late or reordered broadcast from undoing a seat.
        this.patch({ ready: mergeReady(this.state.ready, readyView(msg.ready)) });
        break;
      case 'reject':
        this.applyReject(msg);
        break;
      case 'pong':
        // Latency is tracked by WsClient; nothing to synchronize here.
        break;
    }
  }

  private applySnapshot(view: StateView, role: Role | null): void {
    const myColor = role ? colorForRole(role) : this.state.myColor;
    this.patch({
      role: role ?? this.state.role,
      myColor,
      snapshot: view,
      moves: view.moves,
      ply: view.ply,
      turn: view.turn,
      clock: view.clock,
      turnStartedAt: clockAnchor(view.turnStartedAt),
      status: view.status,
      drawOffer: view.drawOffer,
      fenHash: view.fenHash,
      ready: readyView(view.ready),
      legalMoves: view.legalMoves,
      // A full authoritative snapshot supersedes any optimistic pending move.
      pending: null,
      pendingAction: null,
      lastReject: null,
    });
  }

  private applyMove(msg: MoveBroadcast): void {
    if (msg.ply !== this.state.ply + 1) {
      // Sequence gap — we missed at least one broadcast. Ask the server to resync.
      this.client.send({ t: 'resume', gameId: this.gameId, lastPly: this.state.ply });
      return;
    }
    const move: MoveView = { ply: msg.ply, uci: msg.uci, san: msg.san, by: msg.by };
    const pending = this.state.pending;
    const confirmsPending = pending !== null && this.state.myColor === msg.by && pending.uci === msg.uci;
    this.patch({
      moves: [...this.state.moves, move],
      ply: msg.ply,
      turn: opposite(msg.by),
      clock: msg.clock,
      turnStartedAt: clockAnchor(msg.serverTs),
      fenHash: msg.fenHash,
      drawOffer: null,
      // The broadcast carries the authoritative legal-move map for the
      // resulting position's side to move (empty if the game ended).
      legalMoves: msg.legalMoves,
      pending: confirmsPending ? null : pending,
      pendingAction: null,
      lastReject: null,
    });
  }

  private applyEnded(msg: EndedBroadcast): void {
    this.patch({
      status: { over: true, result: msg.result, termination: msg.termination, winner: msg.winner },
      legalMoves: {},
      pendingAction: null,
      lastReject: null,
    });
  }

  private applyReject(msg: RejectMessage): void {
    const pending = this.state.pending;
    const rollsBack = pending !== null && (msg.ref === null || msg.ref === pending.clientSeq);
    this.patch({
      lastReject: msg,
      pending: rollsBack ? null : pending,
      pendingAction: null,
    });
  }

  private patch(patch: Partial<GameSyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener(this.state);
  }
}
