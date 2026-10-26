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
import { VARIANTS } from '../api/models.js';

/** PostgreSQL INTEGER limit (0..2147483647), matching ADR-0161 durable stateRevision. */
const MAX_STATE_REVISION = 2_147_483_647;

/** Bounded attempts for known-gap recovery (fixed episode budget) before exposing manual retry. */
const MAX_GAP_RECOVERY_ATTEMPTS = 3;

/** Conservative timeout (ms) for a single read-only recovery attempt. */
const GAP_RECOVERY_TIMEOUT_MS = 2_000;

/** Base delay (ms) for exponential backoff between recovery attempts. */
const GAP_RECOVERY_BASE_DELAY_MS = 1_000;

/** Validate whether a value is a valid committed stateRevision sequence number. */
export function isStateRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_STATE_REVISION;
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
  /**
   * Known-gap recovery debt is active (undischarged required revision or ply).
   * Persists through flight, backoff, and exhaustion until discharged by an accepted sufficient snapshot.
   */
  readonly recovering: boolean;
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
    recovering: false,
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
  /** Known required stateRevision from observed gap frames, retained separately from stateRevisionFloor. */
  private targetRevision: number | null = null;
  /** Known required ply from observed gap frames, retained separately from state.ply. */
  private targetPly: number | null = null;
  /** Whether a logical gap-recovery attempt is currently in flight. */
  private gapRecoveryPending = false;
  /** Timer handle for recovery timeout or backoff. */
  private gapRecoveryHandle: unknown = null;
  /** Number of recovery attempts used in the current recovery episode. */
  private gapRecoveryAttempt = 0;
  /** Epoch for fencing obsolete recovery callbacks across lifecycle/reconnect/cancellation. */
  private recoveryEpoch = 0;
  /** Monotonic counter for accepted snapshots to fence reentrant/nested snapshot applications. */
  private snapshotVersion = 0;

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
    const socket = this.client.generation;
    const joinEpoch = this.joinEpoch;
    const isManualRecovery = this.client.state === 'open' && this.state.connected && this.hasIncompleteRecovery();
    if (isManualRecovery) {
      this.clearGapRecovery();
      this.gapRecoveryAttempt = 0;
    }
    const epoch = this.recoveryEpoch;
    this.patch({ recoveryAvailable: false });
    if (!this.unsubscribe || this.suspended || this.terminalJoinFailure || this.client.generation !== socket
      || this.joinEpoch !== joinEpoch || this.recoveryEpoch !== epoch) {
      return;
    }
    if (this.client.state === 'open' && !this.state.connected) {
      this.clearAuthRetry();
      this.retryAttempt = 0;
      this.joinCurrentSocket();
      return;
    }
    if (isManualRecovery) {
      if (this.client.state === 'open' && this.state.connected && this.hasIncompleteRecovery()) {
        this.dispatchGapRecovery();
      }
      return;
    }
    if (this.client.state === 'closed') this.client.connect();
    else this.client.reconnectNow();
  }

  /** Revoke player privileges before asynchronous logout can refresh credentials. */
  logoutRequested(): void {
    // Initial restoration may still be pending; start() must inherit this barrier.
    this.invalidateJoin();
    this.clearGapRecovery();
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
          this.clearGapRecovery();
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
    if (!this.unsubscribe) return;
    this.invalidateJoin();
    this.clearGapRecovery();
    this.unsubscribe();
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
    if (this.hasIncompleteRecovery()) return false;
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
        if (this.hasIncompleteRecovery() && !this.isValidRecoverySnapshot(msg.state)) {
          return;
        }
        this.awaitingJoin = false;
        this.rejectedAccessToken = undefined;
        this.joinReject = null;
        const reconnectPly = this.reconnectLastPly;
        this.reconnectLastPly = null;
        this.joined = true;

        const joinEpoch = this.joinEpoch;
        const socket = this.client.generation;
        const recoveryEpoch = this.recoveryEpoch;
        const hadIncompleteRecovery = this.hasIncompleteRecovery();

        const freshness = this.snapshotFreshness(msg.state);
        let accepted = false;
        if (freshness === 'newer') {
          accepted = this.applySnapshot(msg.state, msg.role);
        } else if (freshness === 'equal') {
          // Equal-revision join reauthorizes the connection and reconciles the input gate without
          // claiming uncertain command completion.
          accepted = this.reconcileEqualSnapshot(msg.state, msg.role);
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
            recoveryAvailable: this.hasIncompleteRecovery()
              ? (this.gapRecoveryAttempt >= MAX_GAP_RECOVERY_ATTEMPTS || this.state.recoveryAvailable)
              : false,
          });
          accepted = !this.suspended && this.joinEpoch === joinEpoch
            && this.client.generation === socket && this.recoveryEpoch === recoveryEpoch;
        }
        if (!this.unsubscribe || this.suspended || this.joinEpoch !== joinEpoch
          || this.client.generation !== socket || this.client.state !== 'open') {
          return;
        }
        if (hadIncompleteRecovery) {
          if (this.hasIncompleteRecovery()) {
            if (this.recoveryEpoch === recoveryEpoch) {
              this.triggerGapRecovery();
            }
          }
          return;
        }
        if (!accepted) {
          return;
        } else if (reconnectPly !== null && reconnectPly < msg.state.ply) {
          this.client.send({ t: 'resume', gameId: this.gameId, lastPly: reconnectPly });
        }
        break;
      }
      case 'state': {
        if (this.hasIncompleteRecovery() && !this.isValidRecoverySnapshot(msg.state)) {
          break;
        }
        const freshness = this.snapshotFreshness(msg.state);
        if (freshness === 'newer') {
          this.applySnapshot(msg.state, this.state.role);
        } else if (freshness === 'equal') {
          // Reconcile position and release optimistic input without claiming uncertain command completion
          this.reconcileEqualSnapshot(msg.state);
        }
        break;
      }
      case 'resumed': {
        if (this.hasIncompleteRecovery() && !this.isValidRecoverySnapshot(msg.state)) {
          break;
        }
        const freshness = this.snapshotFreshness(msg.state);
        if (freshness === 'newer') {
          this.applySnapshot(msg.state, this.state.role);
        } else if (freshness === 'equal') {
          this.reconcileEqualSnapshot(msg.state);
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
      case 'ready': {
        // Readiness only grows, so merging keeps a late or reordered broadcast from undoing a seat.
        if (msg.gameId !== this.gameId) break;
        const joinEpoch = this.joinEpoch;
        const socket = this.client.generation;
        let hasRevisionGap = false;
        if (isStateRevision(msg.stateRevision)) {
          if (this.stateRevisionFloor !== null && msg.stateRevision < this.stateRevisionFloor) {
            // Stale ready broadcast: drop without altering floor or state
            break;
          }
          if (this.stateRevisionFloor !== null && msg.stateRevision > this.stateRevisionFloor + 1) {
            // Revision gap in ready broadcast (intervening pregame draw/event)
            hasRevisionGap = true;
            this.retainGapDebt(msg.stateRevision, null);
          } else {
            this.stateRevisionFloor = Math.max(this.stateRevisionFloor ?? 0, msg.stateRevision);
          }
        }
        const recoveryEpoch = this.recoveryEpoch;
        // Readiness is strictly monotonic (boolean OR) and already-safe (R-03); it never rolls back
        // position or ordering guarantees. Un-stamped ready frames safely merge readiness without
        // advancing or downgrading the state revision floor.
        this.reconcileUncertainty(msg.ready, false);
        this.patch({
          ready: mergeReady(this.state.ready, readyView(msg.ready)),
          lastReject: this.commandNotice(),
          ...(hasRevisionGap ? {
            recovering: true,
            recoveryAvailable: this.gapRecoveryAttempt >= MAX_GAP_RECOVERY_ATTEMPTS || this.state.recoveryAvailable,
          } : {}),
        });
        if (!this.unsubscribe || this.suspended || this.joinEpoch !== joinEpoch
          || this.client.generation !== socket || this.recoveryEpoch !== recoveryEpoch) {
          break;
        }
        if (hasRevisionGap) {
          this.triggerGapRecovery();
        }
        break;
      }
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

  private applySnapshot(view: StateView, role: Role | null): boolean {
    if (this.hasIncompleteRecovery() && !this.isValidRecoverySnapshot(view)) {
      return false;
    }
    if (isStateRevision(view.stateRevision)) {
      this.stateRevisionFloor = Math.max(this.stateRevisionFloor ?? 0, view.stateRevision);
    }
    const myColor = role ? colorForRole(role) : this.state.myColor;
    const ready = view.ready === undefined
      ? this.state.ready
      : view.ready === null
        ? null
        : mergeReady(this.state.ready, readyView(view.ready));
    // A position/draw state cannot identify which request produced it. Only
    // terminal state or monotonic durable readiness safely settles the intent.
    this.reconcileUncertainty(ready, view.status.over);
    if (view.status.over || !this.rejectDuringUncertainty) this.latestCommandReject = null;
    if (view.status.over) this.rejectDuringUncertainty = false;
    const joinEpoch = this.joinEpoch;
    const socket = this.client.generation;
    const version = ++this.snapshotVersion;
    const recoveryEpoch = this.recoveryEpoch;
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
      ready,
      legalMoves: view.legalMoves,
      // Reconcile the displayed position and release the optimistic input gate.
      // An unchanged snapshot cannot prove cancellation: retain the uncertainty
      // notice, and never resend the old intent. A new gesture is a new request.
      pending: null,
      pendingAction: null,
      lastReject: this.commandNotice(),
      connected: true,
      recoveryAvailable: this.hasIncompleteRecovery()
        ? (this.gapRecoveryAttempt >= MAX_GAP_RECOVERY_ATTEMPTS || this.state.recoveryAvailable)
        : false,
    });
    if (!this.unsubscribe || this.suspended || this.joinEpoch !== joinEpoch
      || this.client.generation !== socket || this.snapshotVersion !== version
      || this.state.snapshot !== view || this.recoveryEpoch !== recoveryEpoch) {
      return false;
    }
    this.onSnapshotAccepted(view, recoveryEpoch);
    return true;
  }

  /**
   * Reconcile an equal-revision snapshot (joined, state, or resumed).
   *
   * Equal snapshots confirm the game at the current revision head:
   * - Releases the optimistic input gate (`pending: null`, `pendingAction: null`).
   * - Monotonically merges readiness (`mergeReady`).
   * - Reconciles original-seat readiness uncertainty (`reconcileUncertainty`).
   * - Clears ordinary obsolete errors when safe, but preserves unresolved `outcomeUnknown`
   *   and refusals received during uncertainty (`rejectDuringUncertainty`).
   * - Reauthorizes connection and role if `role` is provided (e.g. on `joined`).
   */
  private reconcileEqualSnapshot(view: StateView, role?: Role | null): boolean {
    if (this.hasIncompleteRecovery() && !this.isValidRecoverySnapshot(view)) {
      return false;
    }
    const ready = view.ready === undefined
      ? this.state.ready
      : view.ready === null
        ? null
        : mergeReady(this.state.ready, readyView(view.ready));
    this.reconcileUncertainty(ready, view.status.over);
    if (view.status.over || !this.rejectDuringUncertainty) this.latestCommandReject = null;
    if (view.status.over) this.rejectDuringUncertainty = false;

    const myColor = role ? colorForRole(role) : this.state.myColor;
    const joinEpoch = this.joinEpoch;
    const socket = this.client.generation;
    const version = ++this.snapshotVersion;
    const recoveryEpoch = this.recoveryEpoch;
    this.patch({
      ...(role !== undefined ? {
        role,
        myColor,
        connected: true,
        recoveryAvailable: this.hasIncompleteRecovery()
          ? (this.gapRecoveryAttempt >= MAX_GAP_RECOVERY_ATTEMPTS || this.state.recoveryAvailable)
          : false } : {}),
      snapshot: view,
      moves: view.moves,
      ply: view.ply,
      turn: view.turn,
      clock: view.clock,
      turnStartedAt: clockAnchor(view.turnStartedAt),
      status: view.status,
      drawOffer: view.drawOffer,
      fenHash: view.fenHash,
      ready,
      legalMoves: view.legalMoves,
      pending: null,
      pendingAction: null,
      lastReject: this.commandNotice(),
    });
    if (!this.unsubscribe || this.suspended || this.joinEpoch !== joinEpoch
      || this.client.generation !== socket || this.snapshotVersion !== version
      || this.state.snapshot !== view || this.recoveryEpoch !== recoveryEpoch) {
      return false;
    }
    this.onSnapshotAccepted(view, recoveryEpoch);
    return true;
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
    const hasPlyGap = msg.ply !== this.state.ply + 1;
    const hasRevisionGap = isStateRevision(msg.stateRevision) &&
      this.stateRevisionFloor !== null && msg.stateRevision > this.stateRevisionFloor + 1;
    if (hasPlyGap || hasRevisionGap) {
      const targetRev = isStateRevision(msg.stateRevision) ? msg.stateRevision : null;
      this.recordGap(targetRev, msg.ply);
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
    let hasRevisionGap = false;
    if (isStateRevision(msg.stateRevision)) {
      if (this.stateRevisionFloor !== null && msg.stateRevision <= this.stateRevisionFloor) {
        // Stale or duplicate ended broadcast: drop without sending recovery or altering state
        return;
      }
      hasRevisionGap = this.stateRevisionFloor !== null && msg.stateRevision > this.stateRevisionFloor + 1;
      this.stateRevisionFloor = Math.max(this.stateRevisionFloor ?? 0, msg.stateRevision);
      if (hasRevisionGap) {
        // Retain gap debt BEFORE notifying, so gap is recorded even if listener stops.
        this.retainGapDebt(msg.stateRevision, null);
      }
    } else if (this.stateRevisionFloor !== null) {
      // Failclosed: missing stamp after revisioned state observed
      return;
    }
    const joinEpoch = this.joinEpoch;
    const socket = this.client.generation;
    const recoveryEpoch = this.recoveryEpoch;
    this.reconcileUncertainty(null, true);
    this.latestCommandReject = null;
    this.rejectDuringUncertainty = false;
    this.patch({
      status: { over: true, result: msg.result, termination: msg.termination, winner: msg.winner },
      legalMoves: {},
      pendingAction: null,
      lastReject: null,
      ...(hasRevisionGap ? {
        recovering: true,
        recoveryAvailable: this.gapRecoveryAttempt >= MAX_GAP_RECOVERY_ATTEMPTS || this.state.recoveryAvailable,
      } : {}),
    });
    if (!this.unsubscribe || this.suspended || this.joinEpoch !== joinEpoch
      || this.client.generation !== socket || this.recoveryEpoch !== recoveryEpoch) {
      return;
    }
    if (hasRevisionGap) {
      // Ending lacks ply; request bounded authoritative snapshot recovery.
      this.triggerGapRecovery();
    }
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

  /** Whether known-gap recovery has an undischarged required revision or ply. */
  private hasIncompleteRecovery(): boolean {
    return this.targetRevision !== null || this.targetPly !== null;
  }

  private clearGapRecoveryTimer(): void {
    if (this.gapRecoveryHandle !== null) {
      const handle = this.gapRecoveryHandle;
      this.gapRecoveryHandle = null;
      this.scheduler.clearTimeout(handle);
    }
  }

  private clearGapRecovery(): void {
    this.recoveryEpoch++;
    this.clearGapRecoveryTimer();
    this.gapRecoveryPending = false;
  }

  private recordGap(revision: number | null, ply: number | null): void {
    if (revision !== null && isStateRevision(revision)) {
      this.targetRevision = Math.max(this.targetRevision ?? 0, revision);
    }
    if (ply !== null && typeof ply === 'number' && Number.isSafeInteger(ply) && ply >= 0) {
      this.targetPly = Math.max(this.targetPly ?? 0, ply);
    }
    this.triggerGapRecovery();
  }

  /**
   * Coalesce recovery triggers: if an attempt is in-flight or backoff delay is running,
   * retain the raised target without resetting the episode or dispatching duplicate requests.
   */
  private triggerGapRecovery(): void {
    if (!this.hasIncompleteRecovery()) return;
    if (this.gapRecoveryPending || this.gapRecoveryHandle !== null) {
      if (!this.state.recovering) this.patch({ recovering: true });
      return;
    }
    if (this.gapRecoveryAttempt >= MAX_GAP_RECOVERY_ATTEMPTS) {
      if (!this.state.recovering || !this.state.recoveryAvailable) {
        this.patch({ recovering: true, recoveryAvailable: true });
      }
      return;
    }
    this.dispatchGapRecovery();
  }

  private dispatchGapRecovery(): void {
    if (!this.unsubscribe || this.suspended || !this.state.connected || this.client.state !== 'open') {
      if (this.hasIncompleteRecovery() && !this.state.recovering) {
        this.patch({ recovering: true });
      }
      return;
    }
    if (this.gapRecoveryAttempt >= MAX_GAP_RECOVERY_ATTEMPTS) {
      this.gapRecoveryPending = false;
      this.clearGapRecoveryTimer();
      this.patch({ recovering: true, recoveryAvailable: true });
      return;
    }

    const epoch = this.recoveryEpoch;
    const socket = this.client.generation;
    this.gapRecoveryPending = true;
    this.patch({ recovering: true, recoveryAvailable: false });

    // Fencing: synchronous listeners may have called stop() or discharged the target.
    if (epoch !== this.recoveryEpoch || socket !== this.client.generation) {
      return;
    }
    if (!this.unsubscribe || this.suspended || this.client.state !== 'open' || !this.hasIncompleteRecovery()) {
      this.gapRecoveryPending = false;
      return;
    }

    this.gapRecoveryAttempt++;
    const sent = this.client.send({ t: 'resume', gameId: this.gameId, lastPly: this.state.ply });

    // Post-send boundary recheck: client.send may synchronously trigger error/close/stop/replacement.
    if (epoch !== this.recoveryEpoch || socket !== this.client.generation) {
      return;
    }
    if (!this.unsubscribe || this.suspended || this.client.state !== 'open' || !this.hasIncompleteRecovery()) {
      this.gapRecoveryPending = false;
      return;
    }

    if (!sent) {
      this.gapRecoveryPending = false;
      if (this.gapRecoveryAttempt >= MAX_GAP_RECOVERY_ATTEMPTS) {
        this.patch({ recovering: true, recoveryAvailable: true });
      } else {
        this.scheduleGapRecoveryBackoff();
      }
      return;
    }

    this.clearGapRecoveryTimer();
    const myHandle = this.scheduler.setTimeout(() => {
      if (!this.unsubscribe || this.suspended || epoch !== this.recoveryEpoch
        || socket !== this.client.generation || this.client.state !== 'open'
        || this.gapRecoveryHandle !== myHandle) {
        return;
      }
      this.gapRecoveryHandle = null;
      // Fixed timeout ends the logical in-flight attempt; preserves debt until sufficient snapshot.
      this.gapRecoveryPending = false;
      if (this.gapRecoveryAttempt >= MAX_GAP_RECOVERY_ATTEMPTS) {
        this.patch({ recovering: true, recoveryAvailable: true });
      } else {
        this.scheduleGapRecoveryBackoff();
      }
    }, GAP_RECOVERY_TIMEOUT_MS);
    this.gapRecoveryHandle = myHandle;
  }

  private scheduleGapRecoveryBackoff(): void {
    const epoch = this.recoveryEpoch;
    const socket = this.client.generation;
    const delay = GAP_RECOVERY_BASE_DELAY_MS * (2 ** Math.max(0, this.gapRecoveryAttempt - 1));
    this.clearGapRecoveryTimer();
    const myHandle = this.scheduler.setTimeout(() => {
      if (!this.unsubscribe || this.suspended || epoch !== this.recoveryEpoch
        || socket !== this.client.generation || this.client.state !== 'open'
        || this.gapRecoveryHandle !== myHandle) {
        return;
      }
      this.gapRecoveryHandle = null;
      if (this.hasIncompleteRecovery()) {
        this.dispatchGapRecovery();
      }
    }, delay);
    this.gapRecoveryHandle = myHandle;
  }

  private isValidPlayers(players: unknown): boolean {
    if (typeof players !== 'object' || players === null || Array.isArray(players)) return false;
    const p = players as Record<string, unknown>;
    return typeof p.white === 'string' && typeof p.black === 'string';
  }

  private isValidTimeControl(tc: unknown): boolean {
    if (typeof tc !== 'object' || tc === null || Array.isArray(tc)) return false;
    const t = tc as Record<string, unknown>;
    const hasValidTimes = typeof t.initialMs === 'number' && Number.isFinite(t.initialMs) && t.initialMs >= 0
      && typeof t.incrementMs === 'number' && Number.isFinite(t.incrementMs) && t.incrementMs >= 0
      && typeof t.delayMs === 'number' && Number.isFinite(t.delayMs) && t.delayMs >= 0;
    if (!hasValidTimes) return false;
    return t.kind === 'increment' || t.kind === 'delay' || t.kind === 'sudden_death' || t.kind === 'unlimited';
  }

  private isValidClock(clock: unknown): boolean {
    if (typeof clock !== 'object' || clock === null || Array.isArray(clock)) return false;
    const c = clock as Record<string, unknown>;
    return typeof c.w === 'number' && Number.isFinite(c.w) && typeof c.b === 'number' && Number.isFinite(c.b);
  }

  private isValidStatus(status: unknown): boolean {
    if (typeof status !== 'object' || status === null || Array.isArray(status)) return false;
    const s = status as Record<string, unknown>;
    if (typeof s.over !== 'boolean') return false;
    if (!s.over) return true;
    const validResults: readonly string[] = ['1-0', '0-1', '1/2-1/2', '*'];
    const validTerminations: readonly string[] = [
      'checkmate', 'resignation', 'timeout', 'stalemate', 'agreement',
      'insufficient_material', 'fifty_move', 'threefold', 'variant', 'aborted', 'no_show',
    ];
    if (typeof s.result !== 'string' || !validResults.includes(s.result)) return false;
    if (typeof s.termination !== 'string' || !validTerminations.includes(s.termination)) return false;
    return s.winner === null || s.winner === 'w' || s.winner === 'b';
  }

  private isValidMoveLedger(moves: unknown, ply: number): boolean {
    if (!Array.isArray(moves) || moves.length !== ply) return false;
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      if (typeof m !== 'object' || m === null || Array.isArray(m)) return false;
      const item = m as Record<string, unknown>;
      if (item.ply !== i + 1) return false;
      if (typeof item.uci !== 'string' || typeof item.san !== 'string') return false;
      if (item.by !== 'w' && item.by !== 'b') return false;
    }
    return true;
  }

  private isValidLegalMoves(legalMoves: unknown): boolean {
    if (typeof legalMoves !== 'object' || legalMoves === null || Array.isArray(legalMoves)) return false;
    for (const val of Object.values(legalMoves as Record<string, unknown>)) {
      if (!Array.isArray(val) || !val.every((sq) => typeof sq === 'string')) return false;
    }
    return true;
  }

  private isValidOptionalFields(v: Record<string, unknown>): boolean {
    if (v.stateRevision !== undefined && !isStateRevision(v.stateRevision)) return false;
    if (v.turnStartedAt !== undefined && v.turnStartedAt !== null && (typeof v.turnStartedAt !== 'number' || !Number.isFinite(v.turnStartedAt))) return false;
    if (v.ready !== undefined && v.ready !== null) {
      if (typeof v.ready !== 'object' || Array.isArray(v.ready)) return false;
      const ready = v.ready as Record<string, unknown>;
      if (typeof ready.w !== 'boolean' || typeof ready.b !== 'boolean') return false;
    }
    if (v.chess960StartId !== undefined && v.chess960StartId !== null && (typeof v.chess960StartId !== 'number' || !Number.isInteger(v.chess960StartId))) return false;
    return true;
  }

  private isValidRecoverySnapshot(view: unknown): view is StateView {
    if (typeof view !== 'object' || view === null || Array.isArray(view)) return false;
    const v = view as Record<string, unknown>;
    if (v.gameId !== this.gameId) return false;
    if (typeof v.variant !== 'string' || !VARIANTS.some((cand) => cand === v.variant)) return false;
    if (!this.isValidPlayers(v.players)) return false;
    if (!this.isValidTimeControl(v.timeControl)) return false;
    if (typeof v.ply !== 'number' || !Number.isSafeInteger(v.ply) || v.ply < 0) return false;
    if (typeof v.fen !== 'string' || typeof v.fenHash !== 'string') return false;
    if (v.turn !== 'w' && v.turn !== 'b') return false;
    if (!this.isValidClock(v.clock)) return false;
    if (!this.isValidStatus(v.status)) return false;
    if (!this.isValidMoveLedger(v.moves, v.ply)) return false;
    if (!this.isValidLegalMoves(v.legalMoves)) return false;
    if (v.drawOffer !== null && v.drawOffer !== 'w' && v.drawOffer !== 'b') return false;
    return this.isValidOptionalFields(v);
  }

  private isSnapshotSufficient(view: StateView): boolean {
    if (!this.isValidRecoverySnapshot(view)) return false;
    if (this.targetRevision !== null) {
      if (!isStateRevision(view.stateRevision) || view.stateRevision < this.targetRevision) {
        return false;
      }
    }
    if (this.targetPly !== null) {
      if (view.ply < this.targetPly) {
        return false;
      }
    }
    return true;
  }

  private retainGapDebt(targetRevision: number | null, targetPly: number | null): void {
    if (targetRevision !== null) {
      this.targetRevision = Math.max(this.targetRevision ?? 0, targetRevision);
    }
    if (targetPly !== null) {
      this.targetPly = Math.max(this.targetPly ?? 0, targetPly);
    }
  }

  private dischargeRecoveryTarget(): void {
    this.recoveryEpoch++;
    this.targetRevision = null;
    this.targetPly = null;
    this.gapRecoveryPending = false;
    this.gapRecoveryAttempt = 0;
    this.clearGapRecoveryTimer();
    this.patch({ recovering: false, recoveryAvailable: false });
  }

  private onSnapshotAccepted(view: StateView, epoch: number): void {
    if (!this.unsubscribe || this.suspended || !this.hasIncompleteRecovery()) return;
    if (this.state.snapshot !== view) return;
    if (this.recoveryEpoch !== epoch) return;
    if (this.isSnapshotSufficient(view)) {
      this.dischargeRecoveryTarget();
    }
  }

  private patch(patch: Partial<GameSyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener(this.state);
  }
}
