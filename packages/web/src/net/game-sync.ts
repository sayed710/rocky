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
import type { Scheduler, WsClient } from './ws-client.js';
import { isTransientRefreshFailure, NoSessionError } from './session.js';
import type { SessionManager } from './session.js';
import type {
  EndedBroadcast,
  GameStatus,
  LegalMoves,
  MoveBroadcast,
  MoveView,
  ReadyView,
  RejectMessage,
  OutcomeUnknownMessage,
  Role,
  ServerMessage,
  SimpleCommand,
  StateView,
  WsColor,
} from './ws-protocol.js';
import { colorForRole, opposite } from './ws-protocol.js';

/** PostgreSQL INTEGER limit (0..2147483647), matching ADR-0161 durable stateRevision. */
const MAX_STATE_REVISION = 2_147_483_647;

/** Validate whether a value is a valid committed stateRevision sequence number. */
export function isStateRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_STATE_REVISION;
}

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
  /** True after the gateway acknowledges a join on the active socket. */
  readonly connected: boolean;
  /** Automatic recovery exhausted, or a rejected join requires an explicit retry. */
  readonly recoveryAvailable: boolean;
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
  /** A rejection or active unresolved command uncertainty. */
  readonly lastReject: RejectMessage | OutcomeUnknownMessage | null;
  /** The action currently awaiting server acknowledgment. */
  readonly pendingAction: SimpleCommand | null;
}

export interface GameSyncOptions {
  readonly gameId: string;
  /** Access token for authenticated join; omitted for anonymous spectators. */
  readonly token?: string;
  /** Production authentication lifecycle; static tokens remain a non-browser test seam. */
  readonly session?: SessionManager;
  /** Timer seam for bounded authentication recovery. */
  readonly scheduler?: Scheduler;
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
    recoveryAvailable: false,
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
  private readonly session: SessionManager | undefined;
  private readonly scheduler: Scheduler;
  private joinEpoch = 0;
  private resolvingToken = false;
  private awaitingJoin = false;
  private retryHandle: unknown = null;
  private retryAttempt = 0;
  private suspended = false;
  private terminalJoinFailure = false;
  private authorizedUserId: string | null = null;
  private joiningAccessToken: string | undefined;
  private rejectedAccessToken: string | undefined;
  private state: GameSyncState;
  private clientSeq = 0;
  /** Bounded exact receipts also cover a confirmation arriving before the unknown notice. */
  private readonly confirmedRequests = new Set<string>();
  private readonly uncertainRequests = new Map<string, OutcomeUnknownMessage>();
  /** At capacity, retain a conservative aggregate warning rather than silently forgetting outcomes. */
  private uncertaintyOverflow = false;
  private latestCommandReject: RejectMessage | null = null;
  private joinReject: RejectMessage | null = null;
  private rejectDuringUncertainty = false;
  private joined = false;
  private readonly listeners = new Set<GameSyncListener>();
  private unsubscribe: (() => void) | null = null;
  private reconnectLastPly: number | null = null;
  /**
   * Highest committed stateRevision observed for this game across snapshots
   * (joined/state/resumed) and live events (move/ready/ended).
   * Initialized to `null` (legacy mode). Once observed, un-stamped frames are
   * rejected (failclosed) to prevent silent ordering downgrades.
   */
  private stateRevisionFloor: number | null = null;

  constructor(client: WsClient, options: GameSyncOptions) {
    this.client = client;
    this.gameId = options.gameId;
    this.token = options.token;
    this.session = options.session;
    this.scheduler = options.scheduler ?? {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.state = initialState(options.gameId);
  }

  getState(): GameSyncState {
    return this.state;
  }

  /** The highest confirmed stateRevision observed so far, or null in legacy mode. */
  get stateRevision(): number | null {
    return this.stateRevisionFloor;
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

  /** Retry after network restoration or an explicit recovery action. */
  networkOnline(): void {
    if (!this.unsubscribe || this.suspended || this.terminalJoinFailure) return;
    this.patch({ recoveryAvailable: false });
    if (this.client.state === 'open' && !this.state.connected) {
      this.clearAuthRetry();
      this.retryAttempt = 0;
      this.joinCurrentSocket();
      return;
    }
    if (this.client.state === 'closed') this.client.connect();
    else this.client.reconnectNow();
  }

  /** Revoke player privileges before asynchronous logout can refresh credentials. */
  logoutRequested(): void {
    // Initial restoration may still be pending; start() must inherit this barrier.
    this.invalidateJoin();
    this.suspended = true;
    this.terminalJoinFailure = false;
    this.authorizedUserId = null;
    this.joiningAccessToken = undefined;
    this.rejectedAccessToken = undefined;
    this.joinReject = null;
    this.patch({ connected: false, recoveryAvailable: false, role: null, myColor: null, pending: null,
      pendingAction: null, lastReject: this.commandNotice() });
    if (this.unsubscribe) this.client.close(1000, 'session-changed');
  }

  /** A completed session boundary requires a fresh server-authorized join. */
  sessionChanged(_userId: string | null): void {
    this.logoutRequested();
    this.suspended = false;
    if (this.unsubscribe) this.client.connect();
  }

  /** Wire up the client and open the connection. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.client.on({
      open: () => this.handleOpen(),
      message: (msg) => this.handleMessage(msg),
      statechange: (state) => {
        if (state !== 'open') {
          this.invalidateJoin();
          this.patch({ connected: false });
        }
      },
    });
    if (!this.suspended) this.client.connect();
  }

  /**
   * Tear down: unsubscribe from the client. Does NOT close the shared
   * `WsClient` — the composition root owns the connection lifecycle (M5).
   * Stopping one GameSync must not kill the app-wide socket and every other
   * GameSync on it.
   */
  stop(): void {
    this.invalidateJoin();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.patch({ connected: false });
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
    if (!this.canCommand()) return null;
    if (this.state.myColor === null) return null;
    if (this.state.status?.over) return null;
    if (this.state.turn !== this.state.myColor) return null;
    if (this.state.pending !== null) return null;
    const clientSeq = this.clientSeq + 1;
    const sent = this.client.send({ t: 'move', gameId: this.gameId, uci, clientSeq });
    if (!sent) return null;
    this.clientSeq = clientSeq;
    const pending: PendingMove = { uci, clientSeq };
    this.latestCommandReject = null;
    this.rejectDuringUncertainty = false;
    this.patch({ pending, lastReject: this.commandNotice() });
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
    if (!this.canCommand()) return false;
    if (this.state.pending !== null || this.state.pendingAction !== null || this.state.status?.over) return false;
    const sent = this.client.send({ t: action, gameId: this.gameId });
    if (sent) {
      this.latestCommandReject = null;
      this.rejectDuringUncertainty = false;
      this.patch({ pendingAction: action, lastReject: this.commandNotice() });
    }
    return sent;
  }

  private handleOpen(): void {
    this.invalidateJoin();
    if (this.suspended || this.terminalJoinFailure) return;
    this.patch({ recoveryAvailable: false });
    if (this.joined) {
      this.reconnectLastPly = this.state.ply;
    }
    this.retryAttempt = 0;
    this.joinCurrentSocket();
  }

  private canCommand(): boolean {
    if (!this.state.connected) return false;
    if (!this.session) return true;
    this.session.captureGeneration(); // Observe persisted cross-tab logout barriers too.
    return this.session.current?.user.id === this.authorizedUserId;
  }

  private clearAuthRetry(): void {
    if (this.retryHandle !== null) this.scheduler.clearTimeout(this.retryHandle);
    this.retryHandle = null;
  }

  private invalidateJoin(): void {
    this.joinEpoch++;
    this.resolvingToken = false;
    this.awaitingJoin = false;
    this.clearAuthRetry();
  }

  private scheduleJoinRetry(session: SessionManager | undefined): void {
    if (this.retryAttempt >= 3) {
      this.patch({ recoveryAvailable: true });
      return;
    }
    const epoch = this.joinEpoch;
    const socket = this.client.generation;
    const delay = Math.max(1_000 * 2 ** this.retryAttempt++, session?.refreshRetryDelayMs ?? 0);
    this.clearAuthRetry();
    this.retryHandle = this.scheduler.setTimeout(() => {
      this.retryHandle = null;
      if (this.unsubscribe && !this.suspended && epoch === this.joinEpoch
        && socket === this.client.generation && this.client.state === 'open') this.joinCurrentSocket();
    }, delay);
  }

  private joinCurrentSocket(): void {
    if (!this.unsubscribe || this.suspended || this.client.state !== 'open'
      || this.resolvingToken || this.awaitingJoin || this.state.connected) return;
    const epoch = this.joinEpoch;
    const socket = this.client.generation;
    const active = (): boolean => Boolean(this.unsubscribe) && !this.suspended
      && epoch === this.joinEpoch && socket === this.client.generation && this.client.state === 'open';
    const sendJoin = (token: string | undefined, userId: string | null): void => {
      if (!active()) return;
      this.resolvingToken = false;
      this.authorizedUserId = userId;
      this.joiningAccessToken = token;
      this.awaitingJoin = true;
      if (!this.client.send({ t: 'join', gameId: this.gameId, ...(token !== undefined ? { token } : {}) })) {
        this.awaitingJoin = false;
        this.patch({ recoveryAvailable: true });
      }
    };
    const session = this.session;
    if (!session) {
      if (this.token !== undefined && this.token === this.rejectedAccessToken) {
        this.patch({ recoveryAvailable: true });
        return;
      }
      sendJoin(this.token, null);
      return;
    }
    session.captureGeneration();
    const initial = session.current;
    const serverRejected = initial !== null && initial.tokens.accessToken === this.rejectedAccessToken;
    const needsRefresh = serverRejected || session.isAccessTokenExpired(initial);
    // A fresh in-memory session is validated in this same turn by the manager's
    // expiry contract. Only the refresh path needs an asynchronous continuation.
    if (initial && !needsRefresh) {
      sendJoin(initial.tokens.accessToken, initial.user.id);
      return;
    }
    if (!initial) {
      sendJoin(undefined, null);
      return;
    }
    this.resolvingToken = true;
    // Gateway unauthorized is the same credential-recovery boundary as an HTTP 401.
    // refreshNow retains the manager's single flight, cooldown and reset barriers.
    const tokenRequest = serverRejected
      ? session.refreshNow().then((current) => current.tokens.accessToken)
      : session.validAccessToken();
    void tokenRequest.then((token) => {
      if (!active()) return;
      session.captureGeneration();
      const current = session.current;
      if (!token || !current || current.user.id !== initial.user.id
        || current.tokens.accessToken !== token || token === this.rejectedAccessToken
        || session.isAccessTokenExpired(current)) {
        throw new NoSessionError();
      }
      sendJoin(token, current?.user.id ?? null);
    }).catch((error: unknown) => {
      if (!active()) return;
      this.resolvingToken = false;
      session.captureGeneration();
      if (!active()) return;
      const current = session.current;
      if (error instanceof NoSessionError && current?.user.id === initial.user.id) {
        if (!session.isAccessTokenExpired(current) && current.tokens.accessToken !== this.rejectedAccessToken) {
          // A peer supplied fresh credentials; the superseded result never publishes its token.
          this.invalidateJoin();
          this.retryAttempt = 0;
          this.joinCurrentSocket();
        } else {
          this.scheduleJoinRetry(session);
        }
      } else if (isTransientRefreshFailure(error)) {
        this.scheduleJoinRetry(session);
      } else if (!current) {
        this.sessionChanged(null);
      } else if (error instanceof NoSessionError) {
        this.sessionChanged(current.user.id);
      }
    });
  }

  /**
   * Evaluates the ordering freshness of an incoming StateView snapshot against our observed floor.
   *
   * Ordering invariants (ADR-0161 / RZ-GAMESYNC-ORDERING-20261018-34):
   * 1. Monotonic stateRevision: If the snapshot carries a valid stateRevision:
   *    - Strictly greater than floor -> 'newer'.
   *    - Equal to floor -> 'equal'.
   *    - Strictly less than floor -> 'stale'.
   * 2. Failclosed against silent legacy downgrades: Once revisioned state has been observed
   *    (`this.stateRevisionFloor !== null`), subsequent snapshots lacking `stateRevision` are
   *    classified as 'stale' (failclosed) so un-stamped frames cannot downgrade ordering guarantees.
   * 3. Pure legacy compatibility: If no revision has ever been observed (`this.stateRevisionFloor === null`),
   *    snapshots from legacy gateways are classified as 'newer'.
   * 4. Terminal monotonicity: A terminal game (`status.over === true`) cannot be reopened by an
   *    active (`over: false`) snapshot regardless of protocol mode -> always 'stale'.
   */
  private snapshotFreshness(view: StateView): 'newer' | 'equal' | 'stale' {
    if (this.state.status?.over && !view.status.over) {
      return 'stale';
    }
    if (isStateRevision(view.stateRevision)) {
      if (this.stateRevisionFloor === null) return 'newer';
      if (view.stateRevision > this.stateRevisionFloor) return 'newer';
      if (view.stateRevision === this.stateRevisionFloor) return 'equal';
      return 'stale';
    }
    // Snapshot has no stateRevision:
    if (this.stateRevisionFloor !== null) {
      // Failclosed: revisioned state already observed; missing stamps must not silently downgrade ordering guarantees.
      return 'stale';
    }
    // All-legacy gateway:
    return 'newer';
  }

  private handleMessage(msg: ServerMessage): void {
    if ('gameId' in msg && msg.gameId !== this.gameId) return;
    if (msg.t !== 'joined' && msg.t !== 'reject' && !this.state.connected) return;
    switch (msg.t) {
      case 'joined': {
        if (!this.awaitingJoin && !this.state.connected) return;
        if (this.session) {
          const epoch = this.joinEpoch;
          const socket = this.client.generation;
          const userId = this.authorizedUserId;
          this.session.captureGeneration();
          // Observing a durable logout barrier can synchronously reset the route.
          if (epoch !== this.joinEpoch || socket !== this.client.generation || this.suspended
            || this.client.state !== 'open' || (this.session.current?.user.id ?? null) !== userId) return;
        }
        this.awaitingJoin = false;
        this.rejectedAccessToken = undefined;
        this.joinReject = null;
        const reconnectPly = this.reconnectLastPly;
        this.reconnectLastPly = null;
        this.joined = true;

        const freshness = this.snapshotFreshness(msg.state);
        if (freshness === 'newer') {
          this.applySnapshot(msg.state, msg.role);
        } else if (freshness === 'equal') {
          // Equal-revision join reauthorizes the connection and reconciles the input gate without
          // claiming uncertain command completion.
          const myColor = msg.role ? colorForRole(msg.role) : this.state.myColor;
          this.patch({
            role: msg.role,
            myColor,
            snapshot: msg.state,
            moves: msg.state.moves,
            ply: msg.state.ply,
            turn: msg.state.turn,
            clock: msg.state.clock,
            turnStartedAt: clockAnchor(msg.state.turnStartedAt),
            status: msg.state.status,
            drawOffer: msg.state.drawOffer,
            fenHash: msg.state.fenHash,
            ready: msg.state.ready === undefined ? this.state.ready : readyView(msg.state.ready),
            legalMoves: msg.state.legalMoves,
            pending: null,
            pendingAction: null,
            lastReject: this.commandNotice(),
            connected: true,
            recoveryAvailable: false,
          });
        } else {
          // Stale snapshot:
          // Preserve legitimate join/reconnect authorization and role establishment without
          // overwriting newer local state, clearing pending intent, or claiming command completion.
          const myColor = msg.role ? colorForRole(msg.role) : this.state.myColor;
          this.patch({
            role: msg.role,
            myColor,
            lastReject: this.commandNotice(),
            connected: true,
            recoveryAvailable: false,
          });
        }
        if (reconnectPly !== null && reconnectPly < msg.state.ply) {
          this.client.send({ t: 'resume', gameId: this.gameId, lastPly: reconnectPly });
        }
        break;
      }
      case 'state': {
        const freshness = this.snapshotFreshness(msg.state);
        if (freshness === 'newer') {
          this.applySnapshot(msg.state, this.state.role);
        } else if (freshness === 'equal') {
          // Reconcile position and release optimistic input without claiming uncertain command completion
          this.patch({
            snapshot: msg.state,
            moves: msg.state.moves,
            ply: msg.state.ply,
            turn: msg.state.turn,
            clock: msg.state.clock,
            turnStartedAt: clockAnchor(msg.state.turnStartedAt),
            status: msg.state.status,
            drawOffer: msg.state.drawOffer,
            fenHash: msg.state.fenHash,
            ready: msg.state.ready === undefined ? this.state.ready : readyView(msg.state.ready),
            legalMoves: msg.state.legalMoves,
            pending: null,
            pendingAction: null,
            lastReject: this.commandNotice(),
          });
        }
        break;
      }
      case 'resumed': {
        const freshness = this.snapshotFreshness(msg.state);
        if (freshness === 'newer') {
          this.applySnapshot(msg.state, this.state.role);
        } else if (freshness === 'equal') {
          this.patch({
            snapshot: msg.state,
            moves: msg.state.moves,
            ply: msg.state.ply,
            turn: msg.state.turn,
            clock: msg.state.clock,
            turnStartedAt: clockAnchor(msg.state.turnStartedAt),
            status: msg.state.status,
            drawOffer: msg.state.drawOffer,
            fenHash: msg.state.fenHash,
            ready: msg.state.ready === undefined ? this.state.ready : readyView(msg.state.ready),
            legalMoves: msg.state.legalMoves,
            pending: null,
            pendingAction: null,
            lastReject: this.commandNotice(),
          });
        }
        break;
      }
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
        if (msg.gameId !== this.gameId) break;
        if (isStateRevision(msg.stateRevision)) {
          if (this.stateRevisionFloor !== null && msg.stateRevision < this.stateRevisionFloor) {
            // Stale ready broadcast: drop without altering floor or state
            break;
          }
          this.stateRevisionFloor = Math.max(this.stateRevisionFloor ?? 0, msg.stateRevision);
        }
        // Readiness is strictly monotonic (boolean OR) and already-safe (R-03); it never rolls back
        // position or ordering guarantees. Un-stamped ready frames safely merge readiness without
        // advancing or downgrading the state revision floor.
        this.reconcileUncertainty(msg.ready, false);
        this.patch({ ready: mergeReady(this.state.ready, readyView(msg.ready)), lastReject: this.commandNotice() });
        break;
      case 'reject':
        this.applyReject(msg);
        break;
      case 'outcomeUnknown':
        // Retain the pending intent. Uncertainty is not rollback and never
        // resends the command. Resume asks only for authoritative state.
        if (msg.gameId === this.gameId && (msg.ref === null || msg.ref <= this.clientSeq)) {
          if (!this.confirmedRequests.has(msg.requestId)) {
            if (this.latestCommandReject) this.rejectDuringUncertainty = true;
            this.uncertainRequests.set(msg.requestId, msg);
            if (this.uncertainRequests.size > 32) {
              const oldest = this.uncertainRequests.keys().next().value!;
              this.uncertaintyOverflow = true;
              this.uncertainRequests.delete(oldest);
            }
            this.patch({ lastReject: this.commandNotice() });
          }
          this.client.send({ t: 'resume', gameId: this.gameId, lastPly: this.state.ply });
        }
        break;
      case 'commandConfirmed':
        if (msg.gameId !== this.gameId) break;
        this.confirmedRequests.add(msg.requestId);
        if (this.confirmedRequests.size > 32) this.confirmedRequests.delete(this.confirmedRequests.values().next().value!);
        if (this.uncertainRequests.delete(msg.requestId)) {
          this.patch({ lastReject: this.commandNotice() });
          this.client.send({ t: 'resume', gameId: this.gameId, lastPly: this.state.ply });
        }
        break;
      case 'pong':
        // Latency is tracked by WsClient; nothing to synchronize here.
        break;
    }
  }

  private applySnapshot(view: StateView, role: Role | null): void {
    if (isStateRevision(view.stateRevision)) {
      this.stateRevisionFloor = Math.max(this.stateRevisionFloor ?? 0, view.stateRevision);
    }
    const myColor = role ? colorForRole(role) : this.state.myColor;
    // A position/draw state cannot identify which request produced it. Only
    // terminal state or monotonic durable readiness safely settles the intent.
    this.reconcileUncertainty(view.ready, view.status.over);
    if (view.status.over || !this.rejectDuringUncertainty) this.latestCommandReject = null;
    if (view.status.over) this.rejectDuringUncertainty = false;
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
      // A snapshot from a gateway older than ADR-0148 has no field at all: keep what is known rather
      // than reopening the board. An explicit `null` means the game has no readiness.
      ready: view.ready === undefined ? this.state.ready : readyView(view.ready),
      legalMoves: view.legalMoves,
      // Reconcile the displayed position and release the optimistic input gate.
      // An unchanged snapshot cannot prove cancellation: retain the uncertainty
      // notice, and never resend the old intent. A new gesture is a new request.
      pending: null,
      pendingAction: null,
      lastReject: this.commandNotice(),
      connected: true,
      recoveryAvailable: false,
    });
  }

  private applyMove(msg: MoveBroadcast): void {
    if (isStateRevision(msg.stateRevision)) {
      if (this.stateRevisionFloor !== null && msg.stateRevision <= this.stateRevisionFloor) {
        // Stale or duplicate move broadcast: drop before ply gap logic so stale broadcasts don't loop
        return;
      }
    } else if (this.stateRevisionFloor !== null) {
      // Failclosed: missing stamp after revisioned state observed
      return;
    } else {
      // All-legacy gateway: drop duplicate or lower ply before ply gap logic
      if (msg.ply <= this.state.ply) {
        return;
      }
    }
    if (this.state.status?.over) {
      return;
    }
    if (msg.ply !== this.state.ply + 1) {
      // Sequence gap — we missed at least one broadcast. Ask the server to resync.
      this.client.send({ t: 'resume', gameId: this.gameId, lastPly: this.state.ply });
      return;
    }
    if (isStateRevision(msg.stateRevision)) {
      this.stateRevisionFloor = Math.max(this.stateRevisionFloor ?? 0, msg.stateRevision);
    }
    const move: MoveView = { ply: msg.ply, uci: msg.uci, san: msg.san, by: msg.by };
    const pending = this.state.pending;
    const confirmsPending = pending !== null && this.state.myColor === msg.by && pending.uci === msg.uci;
    if (!this.rejectDuringUncertainty) this.latestCommandReject = null;
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
      lastReject: this.commandNotice(),
    });
  }

  private applyEnded(msg: EndedBroadcast): void {
    if (isStateRevision(msg.stateRevision)) {
      if (this.stateRevisionFloor !== null && msg.stateRevision <= this.stateRevisionFloor) {
        // Stale or duplicate ended broadcast
        return;
      }
      this.stateRevisionFloor = Math.max(this.stateRevisionFloor ?? 0, msg.stateRevision);
    } else if (this.stateRevisionFloor !== null) {
      // Failclosed: missing stamp after revisioned state observed
      return;
    }
    this.reconcileUncertainty(null, true);
    this.latestCommandReject = null;
    this.rejectDuringUncertainty = false;
    this.patch({
      status: { over: true, result: msg.result, termination: msg.termination, winner: msg.winner },
      legalMoves: {},
      pendingAction: null,
      lastReject: null,
    });
  }

  private applyReject(msg: RejectMessage): void {
    if (this.awaitingJoin) {
      if (msg.code === 'unauthorized') this.rejectedAccessToken = this.joiningAccessToken;
      this.awaitingJoin = false;
      // A refused rejoin cannot settle commands admitted on the previous socket.
      // Keep their exact uncertainty visible alongside the authorization refusal.
      this.joinReject = msg;
      this.patch({ connected: false, recoveryAvailable: false, role: null, myColor: null,
        pending: null, pendingAction: null, lastReject: this.commandNotice() });
      if (msg.code === 'invalid_command') {
        // Gateway hydration may fail transiently before any authorization is granted.
        this.scheduleJoinRetry(this.session);
      } else {
        this.invalidateJoin();
        this.terminalJoinFailure = msg.code === 'unknown_game';
        this.patch({ recoveryAvailable: !this.terminalJoinFailure });
        this.client.close(1000, 'join-rejected');
      }
      return;
    }
    const pending = this.state.pending;
    const rollsBack = pending !== null && (msg.ref === null || msg.ref === pending.clientSeq);
    this.latestCommandReject = msg;
    this.rejectDuringUncertainty = this.uncertainRequests.size > 0 || this.uncertaintyOverflow;
    this.patch({
      lastReject: this.commandNotice(),
      pending: rollsBack ? null : pending,
      pendingAction: null,
    });
  }

  private reconcileUncertainty(ready: StateView['ready'], over: boolean): void {
    if (over) {
      this.uncertainRequests.clear();
      this.uncertaintyOverflow = false;
      return;
    }
    for (const [id, request] of this.uncertainRequests) {
      if (request.ref === null && request.action === 'ready' && request.readyColor && ready?.[request.readyColor] === true) {
        this.uncertainRequests.delete(id);
      }
    }
  }

  /** The existing UI displays message; retain both uncertainty and the latest definite refusal. */
  private commandNotice(): RejectMessage | OutcomeUnknownMessage | null {
    const latest = [...this.uncertainRequests.values()].at(-1);
    if (!latest && !this.uncertaintyOverflow) return this.joinReject ?? this.latestCommandReject;
    const notice: OutcomeUnknownMessage = latest ?? {
      t: 'outcomeUnknown', code: 'outcome_unknown', gameId: this.gameId, ref: null,
      requestId: '', message: 'Earlier command outcomes remain unknown.',
    };
    const messages = [notice.message];
    if (this.uncertainRequests.size > 1) messages.push(`${this.uncertainRequests.size} command outcomes remain unknown.`);
    if (latest && this.uncertaintyOverflow) messages.push('Additional earlier command outcomes remain unknown.');
    if (this.latestCommandReject) messages.push(`Latest command rejected: ${this.latestCommandReject.message}`);
    if (this.joinReject) messages.push(`Join rejected: ${this.joinReject.message}`);
    return { ...notice, message: messages.join(' ') };
  }

  private patch(patch: Partial<GameSyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener(this.state);
  }
}
