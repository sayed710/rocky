/**
 * Lobby controller — a pure, DOM-free orchestrator that manages the seek list
 * and seek creation/cancellation lifecycle.
 *
 * It fetches open seeks from the API, exposes callbacks for list updates,
 * and forwards create/cancel actions to the `SeeksApi`. Like
 * {@link GameController}, it never touches the DOM; the bootstrap layer wires
 * callbacks to DOM elements.
 *
 * This module is the "lobby view" wiring that M6 requires. It imports from the
 * API layer (`GambitClient`) only — no chess rules, no networking internals.
 */
import type { GambitClient } from '../api/client.js';
import type {
  SeekView,
  CreateSeekRequest,
  Variant,
  TimeControl,
  SeekColor,
  BotLevel,
  CreateBotGameRequest,
  SocialPlayer,
} from '../api/models.js';

/** The outcome of a bot-game create: the new game's id, or why it failed. */
export type BotGameResult =
  | { readonly ok: true; readonly gameId: string }
  | { readonly ok: false; readonly message: string };

/** Callbacks the bootstrap wires to DOM elements. */
export interface LobbyCallbacks {
  /** Called when the seek list is refreshed (full replacement). */
  onSeeks: (seeks: readonly SeekView[], names?: ReadonlyMap<string, SocialPlayer>) => void;
  /** Called when a seek is being created (for UI spinner/disabled state). */
  onCreatePending: (pending: boolean) => void;
  /** Called when an error occurs (for UI error display). */
  onError: (message: string) => void;
  /** Called when a seek created by the current user is matched. */
  onGameMatched?: (gameId: string) => void;
}

/** Construction-time wiring for {@link LobbyController}. */
export interface LobbyControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: LobbyCallbacks;
  /** Auto-refresh interval in milliseconds (0 = disabled). */
  readonly refreshIntervalMs?: number;
  /** Whether the user is authenticated (gates create-seek). */
  readonly isAuthenticated?: () => boolean;
  /** Releases route-owned resources when this controller is disposed. */
  readonly onDispose?: () => void;
  /** Injected timer (for tests). */
  readonly setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (id: ReturnType<typeof setInterval>) => void;
}

/**
 * Manages the lobby seek list lifecycle: fetching, creating, and cancelling seeks.
 *
 * The controller is framework-independent and DOM-free. It owns the refresh
 * timer and drives the UI through callbacks. The caller is responsible for
 * connecting callbacks to DOM elements in the bootstrap layer.
 */
export class LobbyController {
  private readonly client: GambitClient;
  private readonly callbacks: LobbyCallbacks;
  private readonly refreshIntervalMs: number;
  private readonly isAuthenticated: (() => boolean) | undefined;
  private readonly onDispose: () => void;
  private readonly _setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly _clearInterval: (id: ReturnType<typeof setInterval>) => void;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private seeks: readonly SeekView[] = [];
  private requestGeneration = 0;
  private disposed = false;

  /** Wire up a new controller from options; does not start the refresh timer. */
  constructor(opts: LobbyControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 10_000;
    this.isAuthenticated = opts.isAuthenticated;
    this.onDispose = opts.onDispose ?? (() => {});
    this._setInterval = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = opts.clearInterval ?? ((id) => clearInterval(id));
  }

  /** Returns true when this generation is still the live request and the controller is alive. */
  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }

  /** Current seek list (snapshot). */
  get currentSeeks(): readonly SeekView[] {
    return this.seeks;
  }

  /** Fetch and publish the seek list, then optionally enrich unresolved creator names. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    try {
      const seeks = await this.client.seeks.list();
      if (!this.isCurrent(generation)) return;

      const openSeeks = seeks.filter((s) => s.gameId === null);
      const namesMap = new Map<string, SocialPlayer>();

      // Populate from REST seek.creatorHandle so normal runtime never depends on GraphQL
      for (const seek of openSeeks) {
        if (seek.creatorHandle) {
          namesMap.set(seek.creatorId, { id: seek.creatorId, handle: seek.creatorHandle });
        }
      }

      this.seeks = seeks;

      // Look for a matched seek (our backend only returns them if we are the creator)
      const matched = this.seeks.find((s) => s.gameId !== null);
      if (matched && this.callbacks.onGameMatched) {
        this.callbacks.onGameMatched(matched.gameId!);
      }

      // Filter out matched seeks before passing to the UI
      this.callbacks.onSeeks(openSeeks, namesMap);

      const unresolvedIds = [
        ...new Set(openSeeks.filter((s) => !namesMap.has(s.creatorId)).map((s) => s.creatorId)),
      ];
      const graphql = this.client.graphql;
      if (unresolvedIds.length > 0 && graphql?.resolvePlayers) {
        void (async () => {
          let gqlNames: ReadonlyMap<string, SocialPlayer>;
          try {
            gqlNames = await graphql.resolvePlayers(unresolvedIds);
          } catch {
            return;
          }
          if (!this.isCurrent(generation)) return;

          const enrichedNames = new Map(namesMap);
          for (const [id, player] of gqlNames) {
            enrichedNames.set(id, player);
          }
          if (enrichedNames.size > namesMap.size) {
            this.callbacks.onSeeks(openSeeks, enrichedNames);
          }
        })().catch((err: unknown) => {
          if (this.isCurrent(generation)) {
            this.callbacks.onError(err instanceof Error ? err.message : String(err));
          }
        });
      }
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Start the auto-refresh timer and do an immediate fetch. */
  start(): void {
    if (this.disposed || this.timerId !== null) return;
    void this.refresh();
    if (this.refreshIntervalMs > 0) {
      this.timerId = this._setInterval(() => void this.refresh(), this.refreshIntervalMs);
    }
  }

  /** Stop the auto-refresh timer. */
  stop(): void {
    if (this.timerId !== null) {
      this._clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /** Create a new seek. Returns the created seek on success. */
  async createSeek(params: {
    variant: Variant;
    timeControl: TimeControl;
    rated?: boolean;
    color?: SeekColor;
    minRating?: number | null;
    maxRating?: number | null;
  }): Promise<SeekView | null> {
    if (this.disposed) return null;
    // M2: gate create-seek on session presence — POST /v1/seeks requires bearer auth.
    if (this.isAuthenticated !== undefined && !this.isAuthenticated()) {
      this.callbacks.onError('Sign in to create a seek.');
      return null;
    }
    this.callbacks.onCreatePending(true);
    try {
      const body: CreateSeekRequest = {
        variant: params.variant,
        timeControl: params.timeControl,
        ...(params.rated !== undefined ? { rated: params.rated } : {}),
        ...(params.color !== undefined ? { color: params.color } : {}),
        ...(params.minRating !== undefined ? { minRating: params.minRating } : {}),
        ...(params.maxRating !== undefined ? { maxRating: params.maxRating } : {}),
      };
      const seek = await this.client.seeks.create(body);
      if (this.disposed) return null;
      // Refresh the list to include the new seek.
      await this.refresh();
      return this.disposed ? null : seek;
    } catch (err) {
      if (!this.disposed) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
      return null;
    } finally {
      if (!this.disposed) this.callbacks.onCreatePending(false);
    }
  }

  /**
   * Start a game against an engine bot.
   *
   * Unlike {@link createSeek}, the failure is *returned* rather than pushed through
   * `callbacks.onError`. The caller is a modal dialog that owns its own error region, and
   * `onError` feeds the lobby's `#lobby-error` — which sits behind that modal, where the player
   * cannot see it. Returning the message lets the caller put it where the eye already is, and keeps
   * the background seek-refresh failures that also use `onError` from overwriting it.
   */
  async createBotGame(params: {
    level: BotLevel;
    variant: Variant;
    timeControl: TimeControl;
    color?: SeekColor;
  }): Promise<BotGameResult> {
    if (this.disposed) return { ok: false, message: 'Lobby is no longer active.' };
    if (this.isAuthenticated !== undefined && !this.isAuthenticated()) {
      return { ok: false, message: 'Sign in to play the computer.' };
    }
    try {
      const body: CreateBotGameRequest = {
        level: params.level,
        variant: params.variant,
        timeControl: params.timeControl,
        ...(params.color !== undefined ? { color: params.color } : {}),
      };
      const game = await this.client.games.createVsBot(body);
      if (this.disposed) return { ok: false, message: 'Lobby is no longer active.' };
      return { ok: true, gameId: game.id };
    } catch (err) {
      if (this.disposed) return { ok: false, message: 'Lobby is no longer active.' };
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Cancel (delete) a seek by ID. */
  async cancelSeek(id: string): Promise<boolean> {
    if (this.disposed) return false;
    try {
      await this.client.seeks.cancel(id);
      if (this.disposed) return false;
      await this.refresh();
      return !this.disposed;
    } catch (err) {
      if (!this.disposed) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
      return false;
    }
  }

  /** Accept an open seek. */
  async acceptSeek(id: string): Promise<boolean> {
    if (this.disposed) return false;
    if (this.isAuthenticated !== undefined && !this.isAuthenticated()) {
      this.callbacks.onError('Sign in to accept a seek.');
      return false;
    }
    try {
      const seek = await this.client.seeks.accept(id);
      if (this.disposed) return false;
      if (seek.gameId && this.callbacks.onGameMatched) {
        this.callbacks.onGameMatched(seek.gameId);
      }
      return true;
    } catch (err) {
      if (!this.disposed) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
      return false;
    }
  }

  /** Permanently dispose the controller: stop the timer and ignore future calls. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestGeneration++;
    this.stop();
    this.onDispose();
  }
}
