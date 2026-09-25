/**
 * Auth controller — a pure, DOM-free orchestrator that manages the
 * authentication session lifecycle (login, register, logout).
 *
 * It wraps the `GambitClient` auth/session API surface, exposes callbacks
 * for session state changes, and provides an `isAuthenticated` predicate
 * that the lobby controller (and other consumers) use to gate
 * auth-required actions like create-seek.
 *
 * Like {@link LobbyController} and {@link ProfileController}, it never
 * touches the DOM; the bootstrap layer wires callbacks to DOM elements.
 *
 * This module satisfies the C4/M2 identity entry: the existing auth stack
 * (`GambitClient.auth`) is fully built server-side — this controller is
 * the UI-side wiring that makes it reachable from the frontend.
 *
 * M12 inc 2: The access token is NO LONGER persisted to storage. Only the
 * user's handle and ID are persisted — enough to restore the UI state across
 * reloads. On reload, `restore()` calls `client.auth.refresh()` which uses
 * the httpOnly cookie to get a fresh access token. If the cookie is expired
 * or absent, the session is not restored (user must log in again).
 */
import type { GambitClient } from '../api/client.js';
import type { RegisterRequest } from '../api/models.js';
import type { KeyValueStorage } from '../net/session.js';
import { HttpError } from '../net/errors.js';
import { isTransientRefreshFailure, NoSessionError } from '../net/session.js';
import { NativeWebAuthnAdapter } from '../ports/webauthn.js';
import type { WebAuthnAdapter } from '../ports/webauthn.js';

/** Callbacks the bootstrap wires to DOM elements. */
export interface AuthCallbacks {
  /** Called when the session state changes (login, logout, restore). */
  onSessionChange: (session: AuthSession | null) => void;
  /** Called when an auth action is pending (for UI spinner/disabled state). */
  onPending: (pending: boolean) => void;
  /** Called when an error occurs (for UI error display). */
  onError: (message: string) => void;
  /**
   * Called with `true` when sign-in needs the emailed code as well as the password, and with
   * `false` once it is no longer needed. Optional: without it the error message still explains.
   */
  onStepUp?: (required: boolean) => void;
}

/** The server's `details.reason` on a refused sign-in, when it gives one. */
function refusalReason(err: unknown): string | undefined {
  if (!(err instanceof HttpError)) return undefined;
  const reason = err.details?.['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * What to tell the person for a refused password sign-in. The step-up wording is the same whether
 * or not the handle exists, because the server's answer is.
 */
function signInError(err: unknown): string {
  switch (refusalReason(err)) {
    case 'step_up_required':
      return 'Additional verification is required. If this account has a verified email address, ' +
        'a sign-in code has been sent to it. Enter the code, or sign in with a passkey.';
    case 'email_unverified':
      return 'Verify your email address before signing in. We sent a new verification link.';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Session data persisted across reloads.
 *
 * M12 inc 2: Only the handle and userId are persisted — no access or refresh
 * token is written to storage. This is enough to restore the UI state; the
 * actual access token is obtained by calling refresh on reload, using the
 * httpOnly cookie.
 */
export interface AuthSession {
  /** The authenticated user's handle. */
  readonly handle: string;
  /** The authenticated user's ID. */
  readonly userId: string;
}

/**
 * Persisted session shape (stored in localStorage).
 * Only handle + userId — no tokens.
 */
interface PersistedAuth {
  readonly handle: string;
  readonly userId: string;
}

export interface AuthControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: AuthCallbacks;
  /** Injectable WebAuthn adapter (defaults to NativeWebAuthnAdapter). */
  readonly webauthnAdapter?: WebAuthnAdapter;
  /** Injected storage for session persistence (defaults to localStorage). */
  readonly storage?: KeyValueStorage;
  /** Storage key for the persisted session. */
  readonly storageKey?: string;
}

const DEFAULT_STORAGE_KEY = 'gambit-session';

/**
 * Manages the authentication session: login, register, logout, and restore.
 *
 * The controller is framework-independent and DOM-free. It persists only the
 * user's handle and ID to an injectable key-value store so that page reloads
 * can restore the UI state. The access token is kept in memory only (via the
 * SessionManager); the browser's durable refresh credential is an httpOnly cookie, while the
 * API-compatible JSON response may also be retained transiently in memory. It drives the UI
 * through callbacks.
 */
export class AuthController {
  private readonly client: GambitClient;
  private readonly callbacks: AuthCallbacks;
  private readonly webauthnAdapter: WebAuthnAdapter;
  private readonly storage: KeyValueStorage | undefined;
  private readonly storageKey: string;
  private session: AuthSession | null = null;
  /**
   * Logical generation counter protecting async operations (e.g. restore/login) from applying
   * stale results if the controller is reset or invalidated while a network call is in flight.
   */
  private sessionGeneration = 0;
  private pendingOperations = 0;
  private disposed = false;

  constructor(opts: AuthControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.webauthnAdapter = opts.webauthnAdapter ?? new NativeWebAuthnAdapter();
    this.storage = opts.storage;
    this.storageKey = opts.storageKey ?? DEFAULT_STORAGE_KEY;

    // This controller mirrors the session that `SessionManager` owns, so when a refresh fails and
    // that session goes away without the user asking — an expired refresh token, or the session
    // revoked from another device — the mirror has to go with it. Otherwise the header and account
    // controls keep showing a signed-in user whose every protected request 401s, until a reload.
    // Clears controller state without re-calling `session.reset()` to avoid broadcasting a spurious logout.
    this.client.session.onInvalidated(() => {
      if (!this.disposed) this.clearControllerSession();
    });

    // Peer-tab adoption: when another tab signs in or restores, mirror the new user session here.
    // Internal deduplication in `adoptSession` ensures this does not re-emit onSessionChange
    // when local authentication or background token rotation occurs.
    this.client.session.onAdopted?.((session) => {
      if (!this.disposed) {
        this.adoptSession(session.user);
      }
    });

    // Cross-tab reset: when another tab explicitly logs out or clears the session, clear local
    // state, remove persisted storage credentials, and inform the UI via onSessionChange(null).
    this.client.session.onReset?.(() => {
      if (!this.disposed) {
        this.clearControllerSession();
      }
    });
  }

  /** Current session (snapshot), or null when unauthenticated. */
  get currentSession(): AuthSession | null {
    return this.session;
  }

  /** Whether the user is currently authenticated. */
  isAuthenticated(): boolean {
    return this.session !== null;
  }

  /**
   * Restore a previously persisted session from storage, if any.
   *
   * M12 inc 2: Only the handle and userId are restored from storage. The
   * access token is obtained by calling `client.auth.refresh()`, which uses
   * the httpOnly cookie. If the cookie is expired or absent, the session is
   * not restored.
   */
  async restore(): Promise<AuthSession | null> {
    if (this.disposed) return null;
    if (!this.storage) return null;
    const generation = this.sessionGeneration;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedAuth;
      if (parsed && typeof parsed.handle === 'string' && typeof parsed.userId === 'string') {
        // Try to get a fresh access token via the httpOnly cookie.
        try {
          const refreshed = await this.client.auth.refresh();
          if (this.disposed || generation !== this.sessionGeneration) {
            // The manager guards adoption; this obsolete continuation owns no session to clear.
            return null;
          }
          return this.adoptSession(refreshed.user);
        } catch (error) {
          if (this.disposed || generation !== this.sessionGeneration) return null;
          // If another concurrent tab refreshed/restored while this request was in flight:
          if (this.client.session.isAuthenticated && this.client.session.current) {
            return this.adoptSession(this.client.session.current.user);
          }
          // An outage says nothing about the cookie: keep the hint so the next restore retries.
          if (isTransientRefreshFailure(error)) return null;
          // Cookie expired or absent — clear persisted state and return null.
          this.clearPersisted();
          return null;
        }
      }
    } catch {
      // Corrupted storage entry — clear it and return null.
      try {
        this.storage.removeItem(this.storageKey);
      } catch {
        // Storage unavailable — ignore.
      }
    }
    return null;
  }

  /**
   * Log in with handle + password, plus the emailed code when the server asked for one. Returns the
   * session on success.
   */
  async login(handle: string, password: string, code?: string): Promise<AuthSession | null> {
    if (this.disposed) return null;
    const managerGeneration = this.client.session.captureGeneration();
    const generation = this.sessionGeneration;
    this.beginPendingOperation();
    try {
      const trimmedCode = code?.trim() ?? '';
      const body = trimmedCode ? { handle, password, code: trimmedCode } : { handle, password };
      const result = await this.client.auth.login(body, managerGeneration);
      if (this.disposed || generation !== this.sessionGeneration) return null;
      return this.adoptSession(result.user);
    } catch (err) {
      if (!this.authOperationIsCurrent(generation, managerGeneration) || err instanceof NoSessionError) return null;
      if (refusalReason(err) === 'step_up_required') this.callbacks.onStepUp?.(true);
      this.callbacks.onError(signInError(err));
      return null;
    } finally {
      this.finishPendingOperation();
    }
  }

  /** Log in with passkey using the handle. Returns the session on success. */
  async loginWithPasskey(handle: string): Promise<AuthSession | null> {
    if (this.disposed) return null;
    const trimmed = handle.trim();
    if (!trimmed) {
      this.callbacks.onError('Please enter your handle to sign in with a passkey.');
      return null;
    }
    if (!this.webauthnAdapter.isSupported()) {
      this.callbacks.onError('Passkey sign-in is not supported on this browser.');
      return null;
    }
    const managerGeneration = this.client.session.captureGeneration();
    const generation = this.sessionGeneration;
    this.beginPendingOperation();
    try {
      const options = await this.client.auth.loginPasskeyOptions({ handle: trimmed });
      if (!this.authOperationIsCurrent(generation, managerGeneration)) return null;
      const assertion = await this.webauthnAdapter.getCredential(options);
      if (!this.authOperationIsCurrent(generation, managerGeneration)) return null;
      const result = await this.client.auth.verifyPasskeyLogin(assertion, managerGeneration);
      if (this.disposed || generation !== this.sessionGeneration) return null;
      return this.adoptSession(result.user);
    } catch (err) {
      if (!this.authOperationIsCurrent(generation, managerGeneration) || err instanceof NoSessionError) return null;
      // Do not expose account-existence details in client error copy.
      this.callbacks.onError('Sign in with passkey failed.');
      return null;
    } finally {
      this.finishPendingOperation();
    }
  }

  /**
   * Register a new account. Returns the session on success.
   *
   * An email is required: the password can sign in only once it is verified, and it receives the
   * sign-in code when the account is under attack. A blank one is refused here, before any request.
   */
  async register(handle: string, password: string, email?: string): Promise<AuthSession | null> {
    if (this.disposed) return null;
    const trimmed = email?.trim() ?? '';
    if (!trimmed) {
      this.callbacks.onError('An email address is required to create an account.');
      return null;
    }
    const managerGeneration = this.client.session.captureGeneration();
    const generation = this.sessionGeneration;
    this.beginPendingOperation();
    try {
      const body: RegisterRequest = { handle, password, email: trimmed };
      const result = await this.client.auth.register(body, managerGeneration);
      if (this.disposed || generation !== this.sessionGeneration) return null;
      return this.adoptSession(result.user);
    } catch (err) {
      if (!this.authOperationIsCurrent(generation, managerGeneration) || err instanceof NoSessionError) return null;
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      this.finishPendingOperation();
    }
  }

  /**
   * Ask for a new verification link for `handleOrEmail`, without a session. The message is the
   * same whether or not anything was sent, because the server's answer is.
   */
  async resendVerification(handleOrEmail: string): Promise<void> {
    if (this.disposed) return;
    const trimmed = handleOrEmail.trim();
    if (!trimmed) {
      this.callbacks.onError('Enter your handle or email to get a new verification link.');
      return;
    }
    this.beginPendingOperation();
    try {
      await this.client.auth.resendEmailVerification({ handleOrEmail: trimmed });
      this.callbacks.onError(
        'If that account has an unverified email address, a new verification link is on its way.',
      );
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
    } finally {
      this.finishPendingOperation();
    }
  }

  /** Log out and clear the persisted session. */
  async logout(): Promise<void> {
    if (this.disposed) return;
    const generation = this.sessionGeneration;
    this.beginPendingOperation();
    try {
      await this.client.auth.logout();
    } catch {
      // Server-side logout failure is non-fatal — clear locally regardless.
    } finally {
      if (!this.disposed) {
        // `AuthApi.logout()` clears the token manager before awaiting the server. If another tab
        // signs in after that boundary, its adoption is the newer state and must remain mirrored
        // here when the older logout request eventually settles.
        if (generation === this.sessionGeneration && !this.client.session.isAuthenticated) {
          this.clearControllerSession();
        }
      }
      this.finishPendingOperation();
    }
  }

  /** Mark an auth operation active, notifying the UI only on the idle-to-pending transition. */
  private beginPendingOperation(): void {
    this.pendingOperations++;
    if (this.pendingOperations === 1) this.callbacks.onPending(true);
  }

  /** Retire an auth operation and clear pending UI only after the final active operation settles. */
  private finishPendingOperation(): void {
    this.pendingOperations--;
    if (!this.disposed && this.pendingOperations === 0) this.callbacks.onPending(false);
  }

  /**
   * Clear local controller session state, storage, and notify UI subscribers without
   * invoking `SessionManager.reset()`.
   *
   * Concurrent state transitions:
   * Used when `SessionManager` has already cleared or invalidated its own session state
   * (e.g. via `onInvalidated` or `onReset`) so that the controller does not re-trigger
   * `SessionManager.reset()` and inadvertently broadcast a secondary `session_reset`
   * message with `cause: 'logout'`.
   */
  private clearControllerSession(): void {
    this.sessionGeneration++;
    this.session = null;
    this.clearPersisted();
    // Any session change ends a pending step-up, so a later sign-in starts without a stale code.
    this.callbacks.onStepUp?.(false);
    this.callbacks.onSessionChange(null);
  }

  /** Clear local session state without issuing server logout (e.g. after password reset confirm). */
  clearLocalSession(): void {
    this.clearControllerSession();
    this.client.session.reset({ broadcast: false, cause: 'invalidation' });
  }

  /** Permanently dispose the controller. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sessionGeneration++;
    this.client.session.dispose?.();
  }

  /** Check both controller and token-manager lifecycles before continuing a multi-step sign-in. */
  private authOperationIsCurrent(controllerGeneration: number, managerGeneration: number): boolean {
    return (
      !this.disposed &&
      controllerGeneration === this.sessionGeneration &&
      managerGeneration === this.client.session.captureGeneration()
    );
  }

  /**
   * Adopt user identity into local controller state and notify UI subscribers.
   *
   * Concurrent state transitions:
   * Deduplicates by checking whether the controller already holds the exact same user
   * session (matching handle and userId). This prevents duplicate `onSessionChange` events,
   * redundant storage persistence, and unnecessary downstream UI re-renders when:
   * 1. A controller method receives an auth result for the identity it already mirrors.
   * 2. Background token refreshes rotate credentials in memory for the currently signed-in user.
   *
   * Peer-tab adoptions for a newly signed-in user or different identity still transition cleanly.
   */
  private adoptSession(user: { handle: string; id: string }): AuthSession {
    if (this.session && this.session.userId === user.id && this.session.handle === user.handle) {
      return this.session;
    }
    this.session = {
      handle: user.handle,
      userId: user.id,
    };
    this.persist();
    // However the session arrived — password, passkey, registration, restore — step-up is over.
    this.callbacks.onStepUp?.(false);
    this.callbacks.onSessionChange(this.session);
    return this.session;
  }

  /**
   * Persist the current session's handle and userId to storage.
   *
   * Only handle and userId are written — never the access or refresh token.
   * Called after every successful `adoptSession` to keep the persisted state
   * in sync so that `restore()` can rebuild the UI on the next page load.
   */
  private persist(): void {
    if (!this.storage || !this.session) return;
    try {
      // M12 inc 2: persist only handle + userId — no tokens.
      const persisted: PersistedAuth = {
        handle: this.session.handle,
        userId: this.session.userId,
      };
      this.storage.setItem(this.storageKey, JSON.stringify(persisted));
    } catch {
      // Storage unavailable — session is in-memory only.
    }
  }

  /**
   * Remove the persisted session entry from storage.
   *
   * Called on logout, invalidation, and failed restore to ensure the persisted
   * state does not cause a spurious restore attempt on the next page load.
   * Storage failures are silently swallowed — if storage is unavailable the
   * stale entry will be ignored on next restore because the cookie will be gone.
   */
  private clearPersisted(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
      // Storage unavailable — ignore.
    }
  }
}
