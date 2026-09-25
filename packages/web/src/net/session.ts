/**
 * Session / authentication abstraction.
 *
 * The M4 contract issues a short-lived access token plus an opaque, single-use
 * refresh token. This module owns that lifecycle on the client:
 *
 *  - a pluggable {@link TokenStore} (in-memory by default) so *where* tokens live
 *    is a choice, not a hard dependency;
 *  - a {@link SessionManager} that adopts auth responses, tracks access-token
 *    expiry, hands out `Authorization` headers, and refreshes proactively (before
 *    expiry) with a **single-flight** guard so concurrent requests trigger at
 *    most one refresh.
 *
 * Refresh is injected as a plain function, not the whole API client, to avoid a
 * dependency cycle and keep the manager unit-testable in isolation.
 *
 * M12 inc 2: Neither the refresh token NOR the access token is persisted to
 * storage. Both live in memory only. The browser flow relies on an httpOnly
 * cookie (set by the API on login/refresh) that is sent automatically with
 * `credentials: 'include'`. On reload, `AuthController.restore()` calls
 * `client.auth.refresh()` which uses the cookie to obtain a fresh access token
 * and populate the in-memory `SessionManager`.
 */
import type { AuthResponse, SelfUser, TokenPair } from '../api/models.js';
import { ApiError, HttpError } from './errors.js';

/**
 * Whether a refresh failed without the server rejecting the session: the transport failed or timed
 * out, or the server answered 429/5xx. Such a failure says nothing about the refresh cookie, so the
 * local session must survive it. Anything else — a 400/401/403, an undecodable body, an abort (the
 * refresh carries no caller signal, so only the environment can abort it), an unknown error — fails
 * closed and is treated as a genuine rejection.
 *
 * A timeout can land after the server already rotated the refresh token. The browser then still
 * holds the old cookie, and the next attempt is answered 401 by reuse detection — a definitive
 * rejection that clears the session as before. That ambiguity is inherent to rotation.
 */
export function isTransientRefreshFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.kind === 'network' || error.kind === 'timeout') return true;
  return error.kind === 'http' && (error.status === 429 || error.status >= 500);
}

/** Backoff after consecutive transient refresh failures: 1s doubling to a 30s ceiling. */
const REFRESH_BACKOFF_BASE_MS = 1_000;
const REFRESH_BACKOFF_MAX_MS = 30_000;

/** The last transient refresh failure and when the next refresh request may be sent. */
interface RefreshCooldown {
  readonly error: unknown;
  readonly failures: number;
  readonly retryAt: number;
}

/** A cookie refresh paired with its browser-wide mutation order. */
export interface OrderedAuthResponse {
  readonly auth: AuthResponse;
  readonly cookieOrder: number;
}

/** A refresh call guarded by the lifecycle generation captured before it was queued. */
export type RefreshFn = (
  refreshToken?: string,
  expectedGeneration?: number,
) => Promise<AuthResponse | OrderedAuthResponse>;

/**
 * Full in-memory session (includes the refresh token for the refresh call).
 * The refresh token is never persisted to storage — only kept in memory.
 */
export interface StoredSession {
  readonly user: SelfUser;
  readonly tokens: TokenPair;
  /** Epoch-ms when the access token expires (derived from `tokens.expiresIn`). */
  readonly accessTokenExpiresAt: number;
}

export interface TokenStore {
  load(): StoredSession | null;
  save(session: StoredSession): void;
  clear(): void;
}

/** Default store: keeps the session in memory only (cleared on reload). */
export class MemoryTokenStore implements TokenStore {
  private session: StoredSession | null = null;
  load(): StoredSession | null {
    return this.session;
  }
  save(session: StoredSession): void {
    this.session = session;
  }
  clear(): void {
    this.session = null;
  }
}

/** The subset of the Web Storage API we depend on (localStorage/sessionStorage). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Raised when an operation needs a session but none is present. */
export class NoSessionError extends Error {
  constructor(message = 'no active session') {
    super(message);
    this.name = 'NoSessionError';
  }
}

/**
 * Cross-tab messaging channel abstraction for multi-tab session synchronization.
 * Uses BroadcastChannel when available in browser environments.
 */
export interface SessionChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

/**
 * Reason or trigger for a session reset across tabs.
 *
 * - `logout`: Voluntary explicit user sign-out (e.g. user clicked log out or reset local session).
 *   All peer tabs must immediately clear their session unconditionally.
 * - `invalidation`: Involuntary failed token refresh (e.g. revoked/expired session or concurrent race loser;
 *   never a transient transport/server failure).
 *   Peer tabs that hold an active, valid successor session must NOT be cleared by a loser tab.
 */
export type SessionResetCause = 'logout' | 'invalidation';

/**
 * Options configuring local and cross-tab session reset semantics.
 */
export interface SessionResetOptions {
  /** Whether to broadcast the reset over the cross-tab channel. Default true. */
  readonly broadcast?: boolean;
  /** Cause of the reset. Defaults to 'logout' (voluntary explicit sign-out). */
  readonly cause?: SessionResetCause;
  /** Access token of the session that was reset, if known. Used by peers for freshness checks. */
  readonly token?: string;
}

/**
 * Type-guard that narrows `val` to {@link AuthResponse}.
 *
 * Performs a structural duck-type check rather than a branded type check so
 * it works across serialization boundaries (e.g. postMessage payloads from
 * peer tabs where the prototype chain is lost).
 */
function isAuthResponse(val: unknown): val is AuthResponse {
  if (!val || typeof val !== 'object') return false;
  const cand = val as Record<string, unknown>;
  const user = cand['user'];
  const tokens = cand['tokens'];
  return (
    typeof user === 'object' &&
    user !== null &&
    typeof (user as Record<string, unknown>)['id'] === 'string' &&
    typeof (user as Record<string, unknown>)['handle'] === 'string' &&
    Array.isArray((user as Record<string, unknown>)['roles']) &&
    typeof tokens === 'object' &&
    tokens !== null &&
    typeof (tokens as Record<string, unknown>)['accessToken'] === 'string' &&
    (tokens as Record<string, unknown>)['tokenType'] === 'Bearer' &&
    typeof (tokens as Record<string, unknown>)['expiresIn'] === 'number' &&
    Number.isFinite((tokens as Record<string, unknown>)['expiresIn']) &&
    (tokens as Record<string, unknown>)['refreshExpiresAt'] !== undefined &&
    typeof (tokens as Record<string, unknown>)['refreshExpiresAt'] === 'string'
  );
}

/** Build the cross-tab auth payload without copying the refresh-token secret. */
function toChannelAuthResponse(auth: AuthResponse): AuthResponse {
  return {
    user: auth.user,
    tokens: {
      accessToken: auth.tokens.accessToken,
      tokenType: auth.tokens.tokenType,
      expiresIn: auth.tokens.expiresIn,
      refreshExpiresAt: auth.tokens.refreshExpiresAt,
    },
  };
}

/**
 * Returns `true` when running in a real browser (not Node.js or Deno).
 *
 * Used to gate the automatic `BroadcastChannel` creation so that the
 * `SessionManager` can be imported in server-side / test environments without
 * throwing on `window` or `BroadcastChannel` access.
 */
function isBrowserEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    (typeof process === 'undefined' || typeof process.versions !== 'object' || !process.versions?.node)
  );
}

/** Construction-time options for {@link SessionManager}. */
export interface SessionManagerOptions {
  readonly refresh: RefreshFn;
  readonly store?: TokenStore;
  readonly now?: () => number;
  /** Treat the access token as expired this many ms before its real expiry. Default 30000. */
  readonly expiryLeewayMs?: number;
  /** Cross-tab session sync channel. Pass null to disable or custom channel for tests. */
  readonly channel?: SessionChannel | null;
  /** Shared metadata storage for logout barriers. Defaults to browser localStorage when available. */
  readonly barrierStorage?: KeyValueStorage | null;
  /** Stable per-tab channel identity override used by deterministic tests. */
  readonly channelSource?: string;
}

/** Mutation classes ordered so security-sensitive logout wins a concurrent adoption. */
type SessionMutationKind = 'invalidation' | 'adoption' | 'logout';

/** Causal revision attached to each cross-tab mutation. */
interface SessionRevision {
  readonly clock: Readonly<Record<string, number>>;
  readonly source: string;
  readonly kind: SessionMutationKind;
  /** Shared logout epoch; absent only on messages from older clients. */
  readonly barrier?: string;
  /** Browser-wide order of cookie-writing authentications, when coordinated by a current client. */
  readonly cookieOrder?: number;
}

const MUTATION_PRIORITY: Readonly<Record<SessionMutationKind, number>> = {
  invalidation: 0,
  adoption: 1,
  logout: 2,
};

/** Bound untrusted cross-tab metadata so it cannot grow every later broadcast indefinitely. */
const MAX_CHANNEL_CLOCK_ENTRIES = 64;
const MAX_CHANNEL_SOURCE_LENGTH = 128;
const CHANNEL_BARRIER_KEY = 'rookzen-session-logout-barrier';
const INITIAL_CHANNEL_BARRIER = '0000000000000000:initial';
const CHANNEL_BARRIER_PATTERN = /^\d{16}:[A-Za-z0-9._-]{1,128}$/;

/** Read a vector-clock counter without consulting attacker-controlled prototype properties. */
function clockCounter(clock: Readonly<Record<string, number>>, source: string): number {
  return Object.prototype.hasOwnProperty.call(clock, source) ? (clock[source] ?? 0) : 0;
}

/** Validate a revision received across the untyped BroadcastChannel boundary. */
function isSessionRevision(value: unknown): value is SessionRevision {
  if (!value || typeof value !== 'object') return false;
  const revision = value as Record<string, unknown>;
  const clock = revision['clock'];
  if (!clock || typeof clock !== 'object' || Array.isArray(clock)) return false;
  const clockEntries = Object.entries(clock as Record<string, unknown>);
  return (
    typeof revision['source'] === 'string' &&
    revision['source'].length > 0 &&
    revision['source'].length <= MAX_CHANNEL_SOURCE_LENGTH &&
    clockEntries.length > 0 &&
    clockEntries.length <= MAX_CHANNEL_CLOCK_ENTRIES &&
    clockEntries.every(([source, counter]) => (
      source.length > 0 &&
      source.length <= MAX_CHANNEL_SOURCE_LENGTH &&
      Number.isSafeInteger(counter) &&
      (counter as number) > 0 &&
      (counter as number) < Number.MAX_SAFE_INTEGER
    )) &&
    typeof revision['source'] === 'string' &&
    clockCounter(clock as Record<string, number>, revision['source']) > 0 &&
    (revision['barrier'] === undefined || (
      typeof revision['barrier'] === 'string' && CHANNEL_BARRIER_PATTERN.test(revision['barrier'])
    )) &&
    (revision['cookieOrder'] === undefined || (
      Number.isSafeInteger(revision['cookieOrder']) &&
      (revision['cookieOrder'] as number) > 0 &&
      (revision['cookieOrder'] as number) < Number.MAX_SAFE_INTEGER
    )) &&
    (revision['kind'] === 'invalidation' || revision['kind'] === 'adoption' || revision['kind'] === 'logout')
  );
}

/** Determine whether one vector clock is before, after, equal to, or concurrent with another. */
function compareCausality(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): 'before' | 'after' | 'equal' | 'concurrent' {
  let leftAhead = false;
  let rightAhead = false;
  for (const source of new Set([...Object.keys(left), ...Object.keys(right)])) {
    leftAhead ||= clockCounter(left, source) > clockCounter(right, source);
    rightAhead ||= clockCounter(right, source) > clockCounter(left, source);
  }
  if (leftAhead && rightAhead) return 'concurrent';
  if (leftAhead) return 'after';
  if (rightAhead) return 'before';
  return 'equal';
}

/** Break ties between concurrent mutations so every tab converges on the same event. */
function compareConcurrentRevisions(left: SessionRevision, right: SessionRevision): number {
  const priority = MUTATION_PRIORITY[left.kind] - MUTATION_PRIORITY[right.kind];
  if (priority !== 0) return priority;
  const sourceProgress = clockCounter(left.clock, left.source) - clockCounter(right.clock, right.source);
  if (sourceProgress !== 0) return sourceProgress;
  if (left.source === right.source) return 0;
  return left.source < right.source ? -1 : 1;
}

function randomChannelSource(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random()}`;
}

/** Create a fresh tie-breaker for each manager incarnation, including SPA remounts. */
function createChannelSource(): string {
  return randomChannelSource();
}

/** Resolve browser localStorage without making SessionManager unusable in restricted environments. */
function browserBarrierStorage(): KeyValueStorage | null {
  if (!isBrowserEnvironment()) return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Manages authentication token storage, proactive refresh, and cross-tab session synchronization.
 *
 * The manager maintains a single in-flight refresh promise so concurrent callers coalesce onto
 * one request. A monotonic `sessionGeneration` counter ensures that stale refresh responses from
 * a prior session never overwrite a freshly adopted or cleared session.
 *
 * Cross-tab synchronization is done through a BroadcastChannel: adoption events broadcast the
 * new session to peer tabs, and reset events (logout/invalidation) propagate the cleared state.
 * Causal revisions order delayed messages; explicit logout outranks a concurrent adoption, while
 * an adoption created after observing that logout has a larger revision and can sign in again.
 * The `adoptedHandler` is only invoked for genuine cross-tab messages — never for local API calls
 * — via the private {@link adoptFromChannel} method, preventing double-adoption.
 */
export class SessionManager {
  private readonly store: TokenStore;
  private readonly doRefresh: RefreshFn;
  private readonly now: () => number;
  private readonly leewayMs: number;
  private invalidatedHandler: (() => void) | null = null;
  private adoptedHandler: ((session: StoredSession) => void) | null = null;
  private resetHandler: (() => void) | null = null;
  private refreshInFlight: Promise<StoredSession> | null = null;
  /** Set after a transient refresh failure so an outage cannot become a refresh-request storm. */
  private refreshCooldown: RefreshCooldown | null = null;
  private readonly channelSource: string;
  private readonly barrierStorage: KeyValueStorage | null;
  private channelBarrier = INITIAL_CHANNEL_BARRIER;
  private appliedLogoutBarrier = INITIAL_CHANNEL_BARRIER;
  private channelClockCompacted = false;
  private channelClock: Record<string, number> = Object.create(null) as Record<string, number>;
  private lastChannelRevision: SessionRevision | null = null;
  /**
   * Monotonically increasing generation counter tracking local session lifecycle changes
   * (resets, adoptions, and disposals). In-flight refreshes capture the generation at initiation
   * and check it upon completion to ensure stale responses from an older session do not resurrect
   * or poison newly adopted or cleared sessions.
   */
  private sessionGeneration = 0;
  private disposed = false;
  private channel: SessionChannel | null = null;

  /** Initialize the session manager; opens the BroadcastChannel if running in a browser context. */
  constructor(options: SessionManagerOptions) {
    this.store = options.store ?? new MemoryTokenStore();
    this.doRefresh = options.refresh;
    this.now = options.now ?? ((): number => Date.now());
    this.leewayMs = options.expiryLeewayMs ?? 30_000;
    this.channelSource = options.channelSource ?? createChannelSource();
    this.barrierStorage = options.barrierStorage === undefined
      ? browserBarrierStorage()
      : options.barrierStorage;
    this.channelBarrier = this.readPersistedBarrier();

    if (options.channel !== undefined) {
      this.channel = options.channel;
    } else if (isBrowserEnvironment() && typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('gambit-session-sync');
      } catch {
        this.channel = null;
      }
    }

    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent): void => {
        this.handleChannelMessage(event.data);
      };
    }
  }

  /** Read the greatest valid logout barrier visible to this browser context. */
  private readPersistedBarrier(): string {
    try {
      const value = this.barrierStorage?.getItem(CHANNEL_BARRIER_KEY);
      return value && CHANNEL_BARRIER_PATTERN.test(value) ? value : INITIAL_CHANNEL_BARRIER;
    } catch {
      return this.channelBarrier;
    }
  }

  /** Persist a monotonic barrier without exposing authentication credentials. */
  private persistBarrier(barrier: string): void {
    try {
      const visible = this.readPersistedBarrier();
      this.barrierStorage?.setItem(CHANNEL_BARRIER_KEY, visible > barrier ? visible : barrier);
    } catch {
      // Storage can be unavailable; BroadcastChannel ordering remains the in-memory fallback.
    }
  }

  /** Clear local state when another tab advanced the durable logout barrier before its message arrived. */
  private synchronizeBarrier(): void {
    const persisted = this.readPersistedBarrier();
    if (persisted <= this.channelBarrier) return;
    this.channelBarrier = persisted;
    this.channelClock = Object.create(null) as Record<string, number>;
    this.channelClockCompacted = false;
    this.lastChannelRevision = null;
    this.applyReset();
    this.appliedLogoutBarrier = persisted;
    this.resetHandler?.();
  }

  /** Advance the shared barrier before broadcasting an explicit local logout. */
  private advanceLogoutBarrier(): void {
    const persisted = this.readPersistedBarrier();
    const current = persisted > this.channelBarrier ? persisted : this.channelBarrier;
    const separator = current.indexOf(':');
    const nextCounter = BigInt(current.slice(0, separator)) + 1n;
    this.channelBarrier = `${nextCounter.toString().padStart(16, '0')}:${this.channelSource}`;
    this.persistBarrier(this.channelBarrier);
    this.channelClock = Object.create(null) as Record<string, number>;
    this.channelClockCompacted = false;
    this.lastChannelRevision = null;
  }

  /** Admit only mutations created in the current logout epoch, while retaining legacy compatibility. */
  private acceptRevisionBarrier(revision: SessionRevision, kind: SessionMutationKind): boolean {
    if (revision.barrier === undefined) {
      this.synchronizeBarrier();
      // Once this browser has observed an epoch-aware logout, an older client cannot prove that
      // its adoption began afterwards. Fail closed instead of resurrecting that logged-out state.
      return kind !== 'adoption' || this.channelBarrier === INITIAL_CHANNEL_BARRIER;
    }
    if (kind === 'logout') {
      if (revision.barrier < this.channelBarrier) return false;
      if (revision.barrier > this.channelBarrier) {
        this.channelBarrier = revision.barrier;
        this.persistBarrier(revision.barrier);
        this.channelClock = Object.create(null) as Record<string, number>;
        this.channelClockCompacted = false;
        this.lastChannelRevision = null;
      }
      return true;
    }
    this.synchronizeBarrier();
    return revision.barrier === this.channelBarrier;
  }

  /**
   * Handle incoming cross-tab channel events.
   *
   * Enforces ordering and freshness invariants:
   * - `session_adopted`: Adopts fresh auth tokens received from a peer tab without re-broadcasting,
   *   unless its causal revision predates the last accepted mutation.
   * - `session_reset`:
   *   - If cause is 'invalidation' (involuntary failed refresh from a peer), preserves an in-flight
   *     refresh or a different-token successor, even when that successor still needs refresh. A
   *     legitimate concurrent refresh loser must never invalidate the winner's session.
   *   - If cause is 'logout' (or unspecified legacy), unconditionally clears the session.
   */
  private handleChannelMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, unknown>;
    if (msg['type'] === 'session_adopted' && isAuthResponse(msg['auth'])) {
      this.handleChannelAdoption(msg['auth'], msg['revision']);
    } else if (msg['type'] === 'session_reset') {
      this.handleChannelReset(msg);
    }
  }

  /** Apply a peer adoption only when its revision is newer than local session state. */
  private handleChannelAdoption(auth: AuthResponse, untrustedRevision: unknown): void {
    if (untrustedRevision !== undefined && !isSessionRevision(untrustedRevision)) return;
    const revision = isSessionRevision(untrustedRevision) ? untrustedRevision : null;
    if (!this.acceptIncomingRevision(revision, 'adoption')) return;
    this.adoptFromChannel(auth);
  }

  /** Apply a peer reset after both causal-order and refresh-race checks succeed. */
  private handleChannelReset(message: Record<string, unknown>): void {
    const cause = message['cause'] === 'invalidation' ? 'invalidation' : 'logout';
    const kind: SessionMutationKind = cause;
    const untrustedRevision = message['revision'];
    if (untrustedRevision !== undefined && !isSessionRevision(untrustedRevision)) return;
    const revision = isSessionRevision(untrustedRevision) ? untrustedRevision : null;
    if (revision && revision.kind !== kind) return;
    if (!this.acceptIncomingRevision(revision, kind)) return;
    if (cause === 'invalidation' && this.shouldPreserveAgainstInvalidation(message['token'])) return;
    if (cause === 'logout' && revision?.barrier === this.appliedLogoutBarrier) return;
    this.applyReset();
    if (cause === 'logout') this.appliedLogoutBarrier = revision?.barrier ?? this.channelBarrier;
    this.resetHandler?.();
  }

  /** Preserve a local request or rotated successor from a peer's failed refresh. */
  private shouldPreserveAgainstInvalidation(untrustedToken: unknown): boolean {
    if (this.refreshInFlight) return true;
    const current = this.store.load();
    const resetToken = typeof untrustedToken === 'string' ? untrustedToken : undefined;
    return current !== null && (!resetToken || current.tokens.accessToken !== resetToken);
  }

  /** Advance the local logical clock and record a mutation that originated in this tab. */
  private nextChannelRevision(kind: SessionMutationKind, cookieOrder?: number): SessionRevision {
    const nextCounter = clockCounter(this.channelClock, this.channelSource) + 1;
    if (kind === 'logout') {
      // Logout is a convergence barrier: compact prior causal metadata so a valid sign-out cannot
      // be rejected merely because many short-lived tabs have previously contributed clock entries.
      this.channelClock = Object.create(null) as Record<string, number>;
    }
    while (
      !Object.prototype.hasOwnProperty.call(this.channelClock, this.channelSource) &&
      Object.keys(this.channelClock).length >= MAX_CHANNEL_CLOCK_ENTRIES
    ) {
      const evicted = Object.keys(this.channelClock).find((source) => source !== this.channelSource);
      if (!evicted) break;
      delete this.channelClock[evicted];
      this.channelClockCompacted = true;
    }
    this.channelClock[this.channelSource] = nextCounter;
    const revision = {
      clock: { ...this.channelClock },
      source: this.channelSource,
      kind,
      barrier: this.channelBarrier,
      ...(cookieOrder !== undefined ? { cookieOrder } : {}),
    } as const;
    this.lastChannelRevision = revision;
    return revision;
  }

  /** Merge observed causal history without accepting the peer's state mutation. */
  private observeChannelClock(observed: Readonly<Record<string, number>>): boolean {
    if (clockCounter(observed, this.channelSource) > clockCounter(this.channelClock, this.channelSource)) {
      return false;
    }
    for (const [source, counter] of Object.entries(observed)) {
      if (!Object.prototype.hasOwnProperty.call(this.channelClock, source)) {
        while (Object.keys(this.channelClock).length >= MAX_CHANNEL_CLOCK_ENTRIES) {
          const evicted = Object.keys(this.channelClock).find((candidate) => (
            candidate !== this.channelSource && candidate !== source
          ));
          if (!evicted) break;
          delete this.channelClock[evicted];
          this.channelClockCompacted = true;
        }
      }
      this.channelClock[source] = Math.max(clockCounter(this.channelClock, source), counter);
    }
    return true;
  }

  /** Replace causal history at a logout barrier while retaining a safe local counter. */
  private compactToLogout(revision: SessionRevision): SessionRevision {
    const eventClock = { [revision.source]: clockCounter(revision.clock, revision.source) };
    const localClock = Object.create(null) as Record<string, number>;
    const ownCounter = clockCounter(this.channelClock, this.channelSource);
    localClock[revision.source] = eventClock[revision.source]!;
    if (this.channelSource !== revision.source) {
      localClock[this.channelSource] = Math.max(ownCounter, clockCounter(revision.clock, this.channelSource));
    }
    this.channelClock = localClock;
    // The accepted event is the sender's logout barrier only. Receiver-local history belongs in
    // future revisions it originates, not in the event used to judge the sender's later login.
    return { ...revision, clock: eventClock };
  }

  /** Accept only a causally newer peer mutation, with a conservative rolling-upgrade fallback. */
  private acceptIncomingRevision(
    revision: SessionRevision | null,
    legacyKind: SessionMutationKind,
  ): boolean {
    if (!revision) {
      this.synchronizeBarrier();
      if (legacyKind === 'adoption' && this.channelBarrier !== INITIAL_CHANNEL_BARRIER) return false;
      // A new client that has explicitly logged out must not be resurrected by
      // a delayed adoption from an older client that cannot prove freshness.
      if (legacyKind === 'adoption' && this.lastChannelRevision?.kind === 'logout') return false;
      if (legacyKind === 'logout') this.advanceLogoutBarrier();
      this.nextChannelRevision(legacyKind);
      return true;
    }
    if (revision.kind !== legacyKind) return false;
    if (clockCounter(revision.clock, this.channelSource) > clockCounter(this.channelClock, this.channelSource)) {
      return false;
    }
    if (legacyKind === 'logout' && revision.barrier === undefined) {
      // Upgrade a valid old-client logout into the same durable epoch boundary emitted by a
      // current client. This prevents a remount from forgetting the legacy tombstone.
      this.advanceLogoutBarrier();
      revision = { ...revision, barrier: this.channelBarrier };
    }
    if (!this.acceptRevisionBarrier(revision, legacyKind)) return false;
    if (this.lastChannelRevision) {
      const orderedCookieAdoption = (
        revision.kind === 'adoption' &&
        this.lastChannelRevision.kind === 'adoption' &&
        revision.cookieOrder !== undefined &&
        this.lastChannelRevision.cookieOrder !== undefined &&
        revision.cookieOrder !== this.lastChannelRevision.cookieOrder
      );
      if (orderedCookieAdoption && revision.cookieOrder! < this.lastChannelRevision.cookieOrder!) return false;
      if (!orderedCookieAdoption) {
        if (
          revision.kind === 'adoption' &&
          revision.cookieOrder === undefined &&
          this.channelClockCompacted &&
          !Object.prototype.hasOwnProperty.call(this.channelClock, revision.source)
        ) return false;
        const causality = compareCausality(revision.clock, this.lastChannelRevision.clock);
        if (causality === 'before' || causality === 'equal') return false;
        const adoptionCapturedAfterBarrier = (
          causality === 'concurrent' &&
          revision.kind === 'adoption' &&
          this.lastChannelRevision.kind === 'logout' &&
          revision.barrier !== undefined &&
          revision.barrier === this.lastChannelRevision.barrier
        );
        if (
          causality === 'concurrent' &&
          !adoptionCapturedAfterBarrier &&
          compareConcurrentRevisions(revision, this.lastChannelRevision) <= 0
        ) {
          return false;
        }
      }
    }
    if (legacyKind === 'logout') {
      this.lastChannelRevision = this.compactToLogout(revision);
      return true;
    }
    if (!this.observeChannelClock(revision.clock)) return false;
    this.lastChannelRevision = revision;
    return true;
  }

  /** Clear the local session and invalidate asynchronous work without creating a channel event. */
  private applyReset(): void {
    this.sessionGeneration++;
    this.store.clear();
    this.refreshInFlight = null;
    this.refreshCooldown = null;
  }

  /** Store one validated auth response without deciding its cross-tab revision. */
  private storeAuth(auth: AuthResponse): StoredSession {
    this.sessionGeneration++;
    this.refreshInFlight = null;
    this.refreshCooldown = null;
    const session: StoredSession = {
      user: auth.user,
      tokens: auth.tokens,
      accessTokenExpiresAt: this.now() + auth.tokens.expiresIn * 1000,
    };
    this.store.save(session);
    return session;
  }

  /**
   * Current session snapshot stored in memory, or null when unauthenticated.
   */
  get current(): StoredSession | null {
    return this.store.load();
  }

  /**
   * True if there is currently an active stored session.
   */
  get isAuthenticated(): boolean {
    return this.store.load() !== null;
  }

  /** Capture the current lifecycle generation for guarding a later asynchronous adoption. */
  captureGeneration(): number {
    this.synchronizeBarrier();
    return this.sessionGeneration;
  }

  /** Reject work queued for a session generation that has since been superseded. */
  assertGeneration(expectedGeneration: number): void {
    this.synchronizeBarrier();
    if (this.disposed || expectedGeneration !== this.sessionGeneration) {
      throw new NoSessionError('session changed while authentication was queued');
    }
  }

  /**
   * Persist tokens+user from an auth response, computing access-token expiry.
   *
   * Increments `sessionGeneration` and clears `refreshInFlight` so that any stale in-flight
   * refresh started before this adoption cannot overwrite the freshly adopted session.
   * Optionally broadcasts a `session_adopted` message to notify peer tabs.
   */
  adopt(
    auth: AuthResponse,
    broadcast = true,
    expectedGeneration?: number,
    cookieOrder?: number,
  ): StoredSession {
    this.synchronizeBarrier();
    if (this.disposed || (expectedGeneration !== undefined && expectedGeneration !== this.sessionGeneration)) {
      throw new NoSessionError('session changed while authentication was in flight');
    }
    const revision = this.nextChannelRevision('adoption', cookieOrder);
    const session = this.storeAuth(auth);
    if (broadcast && this.channel) {
      try {
        this.channel.postMessage({ type: 'session_adopted', auth: toChannelAuthResponse(auth), revision });
      } catch {
        // Channel closed or in error state.
      }
    }
    return session;
  }

  /**
   * Adopt a session received from a peer tab via cross-tab channel broadcast.
   *
   * Unlike the general-purpose {@link adopt} (used for local API calls), this
   * method additionally fires `adoptedHandler` to synchronize controller
   * identity. It never re-broadcasts, because the message already originated
   * from a peer tab — re-broadcasting would create a loop across all open tabs.
   *
   * This separation ensures that `adoptedHandler` is ONLY invoked for genuine
   * cross-tab adoption events, never for local login, register, or refresh
   * calls where the controller already drives the session update directly.
   */
  private adoptFromChannel(auth: AuthResponse): void {
    const session = this.storeAuth(toChannelAuthResponse(auth));
    this.adoptedHandler?.(session);
  }

  /**
   * Register the handler invoked when a session is adopted from a peer tab via
   * cross-tab channel broadcast. It is NOT called for local login, register, or
   * refresh calls — those are handled directly by the controller.
   */
  onAdopted(handler: (session: StoredSession) => void): void {
    this.adoptedHandler = handler;
  }

  /**
   * Register the handler for when a session is reset from a peer tab via channel broadcast.
   */
  onReset(handler: () => void): void {
    this.resetHandler = handler;
  }

  /**
   * Register the handler for an *involuntary* session loss: a refresh that failed because the
   * refresh token expired or the session was revoked from another device. A deliberate sign-out
   * does not call it, because the caller already knows.
   *
   * Late registration rather than a constructor option because the party that needs to know is the
   * {@link AuthController}, which is built from this client and so cannot exist before it.
   */
  onInvalidated(handler: () => void): void {
    this.invalidatedHandler = handler;
  }

  /**
   * Forget the local session (does not call the server).
   *
   * Bumps `sessionGeneration` to invalidate in-flight refresh requests, clears local store,
   * and optionally broadcasts a `session_reset` message tagged with cause and token for cross-tab sync.
   *
   * @param options - Structured {@link SessionResetOptions} or a boolean broadcast flag for backwards compatibility.
   */
  reset(options: boolean | SessionResetOptions = true): void {
    const broadcast = typeof options === 'boolean' ? options : (options.broadcast ?? true);
    const cause: SessionResetCause = typeof options === 'object' && options.cause ? options.cause : 'logout';
    const currentToken = this.store.load()?.tokens.accessToken;
    const token = typeof options === 'object' && options.token !== undefined ? options.token : currentToken;

    if (cause === 'logout') this.advanceLogoutBarrier();
    const revision = this.nextChannelRevision(cause === 'invalidation' ? 'invalidation' : 'logout');
    this.applyReset();
    if (cause === 'logout') this.appliedLogoutBarrier = this.channelBarrier;
    if (broadcast && this.channel) {
      try {
        this.channel.postMessage({
          type: 'session_reset',
          cause,
          token,
          revision,
        });
      } catch {
        // Channel closed or in error state.
      }
    }
  }

  /** Reset only if no newer session transition superseded the asynchronous caller. */
  resetIfGeneration(expectedGeneration: number, options: boolean | SessionResetOptions = true): boolean {
    this.synchronizeBarrier();
    if (this.disposed || expectedGeneration !== this.sessionGeneration) return false;
    this.reset(options);
    return true;
  }

  /**
   * Permanently close the cross-tab channel and invalidate any in-flight refresh requests.
   * Increments `sessionGeneration` so pending asynchronous responses cannot mutate state after disposal.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.applyReset();
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
      this.channel = null;
    }
  }

  /**
   * Whether the stored session's access token is expired or within the leeway window.
   *
   * @param session - The stored session to evaluate (defaults to loading current store).
   * @returns True if expired or near expiry (within `expiryLeewayMs`), or if no session exists.
   */
  isAccessTokenExpired(session: StoredSession | null = this.store.load()): boolean {
    if (!session) return true;
    return this.now() >= session.accessTokenExpiresAt - this.leewayMs;
  }

  /** `Authorization` header value for the current access token, or undefined. */
  authorizationHeader(): string | undefined {
    const session = this.store.load();
    return session ? `Bearer ${session.tokens.accessToken}` : undefined;
  }

  /**
   * Return a non-expired access token, refreshing proactively when the current
   * one is (near) expiry. Resolves to undefined when there is no session at all.
   * `ignoreBackoff` is passed to {@link refreshNow}.
   */
  async validAccessToken(ignoreBackoff = false): Promise<string | undefined> {
    const session = this.store.load();
    if (!session) return undefined;
    if (!this.isAccessTokenExpired(session)) return session.tokens.accessToken;
    const refreshed = await this.refreshNow(ignoreBackoff);
    return refreshed.tokens.accessToken;
  }

  /**
   * Restore from the httpOnly cookie, including when no in-memory session exists.
   * Discard the response before saving or broadcasting if a reset, adoption, or
   * disposal has superseded this request.
   */
  async restore(): Promise<StoredSession> {
    const generation = this.captureGeneration();
    const result = await this.doRefresh(undefined, generation);
    const auth = 'auth' in result ? result.auth : result;
    const cookieOrder = 'auth' in result ? result.cookieOrder : undefined;
    if (generation !== this.sessionGeneration) {
      throw new NoSessionError('session changed while restore was in flight');
    }
    return this.adopt(auth, true, generation, cookieOrder);
  }

  /** Back off exponentially, honouring a server `Retry-After`, both capped at the ceiling. */
  private startRefreshCooldown(error: unknown): void {
    const failures = (this.refreshCooldown?.failures ?? 0) + 1;
    const backoff = REFRESH_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 5);
    const retryAfter = error instanceof HttpError ? (error.retryAfterMs ?? 0) : 0;
    const delay = Math.min(REFRESH_BACKOFF_MAX_MS, Math.max(backoff, retryAfter));
    this.refreshCooldown = { error, failures, retryAt: this.now() + delay };
  }

  /**
   * Refresh the session now, coalescing concurrent callers onto one in-flight
   * refresh. On a definitive failure the local session is cleared, peers are told, and the error
   * rethrown; a transient failure ({@link isTransientRefreshFailure}) keeps the session and starts
   * a backoff during which further calls reject with that failure without sending a request.
   * `ignoreBackoff` sends one attempt anyway, for an explicit user action such as logout.
   *
   * Concurrent state transitions:
   * - If the manager adopts a newer session while the refresh is in flight, the
   *   in-flight refresh result is discarded to prevent stale overwrite.
   * - A failed refresh checks if a valid successor was adopted concurrently. If so,
   *   the session is preserved instead of being cleared.
   *
   * M12 inc 2: The refresh token is passed from the in-memory session if
   * available, but the browser flow relies on the httpOnly cookie (the
   * `RefreshFn` sends `credentials: 'include'` so the cookie is attached
   * automatically). The body token is omitted for the browser flow.
   */
  async refreshNow(ignoreBackoff = false): Promise<StoredSession> {
    const existing = this.refreshInFlight;
    if (existing) return existing;

    // Apply a peer logout persisted while its message was missed, even during a backoff.
    this.synchronizeBarrier();
    const session = this.store.load();
    if (!session) throw new NoSessionError('cannot refresh without a session');
    const cooldown = this.refreshCooldown;
    if (!ignoreBackoff && cooldown && this.now() < cooldown.retryAt) throw cooldown.error;

    const opGen = this.captureGeneration();

    const pending = (async (): Promise<StoredSession> => {
      try {
        // Pass the refresh token if available (non-browser path).
        // For the browser flow, the token is undefined and the cookie is sent.
        const result = await this.doRefresh(session.tokens.refreshToken, opGen);
        const auth = 'auth' in result ? result.auth : result;
        const cookieOrder = 'auth' in result ? result.cookieOrder : undefined;
        if (this.sessionGeneration !== opGen) {
          throw new NoSessionError('session was reset while refresh was in flight');
        }
        return this.adopt(auth, true, opGen, cookieOrder);
      } catch (error) {
        if (!(error instanceof NoSessionError)) {
          // If a concurrent tab refreshed and updated our store with a fresh successor token,
          // adopt that valid session rather than destroying it.
          const current = this.store.load();
          if (
            current &&
            current.tokens.accessToken !== session.tokens.accessToken &&
            !this.isAccessTokenExpired(current)
          ) {
            return current;
          }
        }
        if (this.sessionGeneration !== opGen) {
          if (error instanceof NoSessionError) {
            throw error;
          }
          throw new NoSessionError('session was reset while refresh was in flight');
        }
        // The server never rejected this session, so keep it (and every peer tab) intact. The
        // stale access token makes a later authenticated call retry the refresh once the backoff
        // has elapsed.
        if (isTransientRefreshFailure(error)) {
          this.startRefreshCooldown(error);
          throw error;
        }
        this.reset({ broadcast: true, cause: 'invalidation', token: session.tokens.accessToken });
        this.invalidatedHandler?.();
        throw error;
      }
    })();

    this.refreshInFlight = pending;
    pending
      .finally(() => {
        if (this.refreshInFlight === pending) {
          this.refreshInFlight = null;
        }
      })
      .catch(() => {});

    return pending;
  }
}
