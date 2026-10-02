/**
 * Profile controller — a pure, DOM-free orchestrator that manages the user
 * profile view lifecycle.
 *
 * It fetches the user's profile, ratings, and recent games from the API,
 * exposes callbacks for state updates, and handles refresh. Like
 * {@link GameController} and {@link LobbyController}, it never touches the DOM;
 * the bootstrap layer wires callbacks to DOM elements.
 */
import type { GambitClient } from '../api/client.js';
import type { UserProfile, GameSummary } from '../api/models.js';

/** Callbacks the bootstrap wires to DOM elements. */
export interface ProfileCallbacks {
  onProfile: (profile: UserProfile) => void;
  onGames: (games: readonly GameSummary[]) => void;
  onError: (message: string) => void;
}

export interface ProfileControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: ProfileCallbacks;
  /** Number of recent games to fetch (default 20). */
  readonly gameLimit?: number;
  readonly onDispose?: () => void;
}

/**
 * Manages the profile view: fetching user profile, ratings, and recent games.
 *
 * The controller is framework-independent and DOM-free. It drives the UI
 * through callbacks. The caller connects callbacks to DOM elements in the
 * bootstrap layer.
 */
export class ProfileController {
  private readonly client: GambitClient;
  private readonly callbacks: ProfileCallbacks;
  private readonly gameLimit: number;
  private readonly onDispose?: (() => void) | undefined;
  private profile: UserProfile | null = null;
  private games: readonly GameSummary[] = [];
  private requestGeneration = 0;
  private disposed = false;

  constructor(opts: ProfileControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.gameLimit = opts.gameLimit ?? 20;
    this.onDispose = opts.onDispose;
  }

  /** Current profile (snapshot). */
  get currentProfile(): UserProfile | null {
    return this.profile;
  }

  /** Current games list (snapshot). */
  get currentGames(): readonly GameSummary[] {
    return this.games;
  }

  /** Fetch the profile and games for a user by handle. */
  async load(handle: string): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    try {
      const profile = await this.client.users.byHandle(handle);
      if (!this.isCurrent(generation)) return;
      this.profile = profile;
      this.callbacks.onProfile(profile);

      const games = await this.client.users.games(handle, { limit: this.gameLimit });
      if (!this.isCurrent(generation)) return;
      this.games = games;
      this.callbacks.onGames(games);
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Fetch the authenticated user's own profile. */
  async loadSelf(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    try {
      const self = await this.client.users.me();
      if (!this.isCurrent(generation)) return;
      await this.load(self.handle);
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Invalidate pending requests and clear the current profile snapshots. */
  reset(): void {
    if (this.disposed) return;
    this.requestGeneration++;
    this.profile = null;
    this.games = [];
  }

  /** Permanently dispose the controller. */
  dispose(): void {
    this.disposed = true;
    this.onDispose?.();
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }
}
