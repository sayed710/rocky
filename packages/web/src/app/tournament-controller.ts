/**
 * Tournament controller — a pure, DOM-free orchestrator that manages the
 * tournament list, detail, standings, and live game viewing lifecycle.
 *
 * It mirrors {@link ProfileController}'s requestGeneration stale-response guard
 * and {@link LobbyController}'s injectable timer seams so polling is testable.
 */
import type { GambitClient } from '../api/client.js';
import type {
  TournamentSummary,
  TournamentDetail,
  TournamentStanding,
  TournamentLiveBoard,
  SocialPlayer,
} from '../api/models.js';

/** Callbacks the bootstrap layer wires to DOM elements. */
export interface TournamentCallbacks {
  onList: (items: readonly TournamentSummary[]) => void;
  onDetail: (detail: TournamentDetail) => void;
  onStandings: (
    standings: readonly TournamentStanding[],
    names: ReadonlyMap<string, { id: string; handle: string }>,
  ) => void;
  onLiveGames: (
    games: readonly TournamentLiveBoard[],
    names: ReadonlyMap<string, { id: string; handle: string }>,
  ) => void;
  onLoading: (loading: boolean) => void;
  onError: (message: string) => void;
}

export interface TournamentControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: TournamentCallbacks;
  readonly onDispose?: (() => void) | undefined;
  /** Live polling interval in milliseconds (default 5000ms). */
  readonly pollIntervalMs?: number;
  /** Injected timer (for tests). */
  readonly setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (id: ReturnType<typeof setInterval>) => void;
}

export class TournamentController {
  private readonly client: GambitClient;
  private readonly callbacks: TournamentCallbacks;
  private readonly onDispose: (() => void) | undefined;
  private readonly pollIntervalMs: number;
  private readonly _setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly _clearInterval: (id: ReturnType<typeof setInterval>) => void;
  private requestGeneration = 0;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private liveId: string | null = null;
  private pollInFlight = false;
  private disposed = false;

  constructor(opts: TournamentControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.onDispose = opts.onDispose;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this._setInterval = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = opts.clearInterval ?? ((id) => clearInterval(id));
  }

  /** Fetch the list of tournaments. */
  async loadList(limit?: number): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const items = await this.client.tournaments.list(limit);
      if (!this.isCurrent(generation)) return;
      this.callbacks.onList(items);
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.callbacks.onLoading(false);
      }
    }
  }

  /** Fetch tournament details, standings, and initial live games. */
  async loadDetail(id: string): Promise<void> {
    if (this.disposed) return;
    this.stopLive();
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const detail = await this.client.tournaments.byId(id);
      if (!this.isCurrent(generation)) return;
      this.callbacks.onDetail(detail);

      if (detail.state === 'running') {
        // When running, fetch live(id) which returns live games AND standings in a single call,
        // avoiding a redundant second request to /standings.
        const liveData = await this.client.tournaments.live(id);
        if (!this.isCurrent(generation)) return;
        const playerIds = [
          ...liveData.standings.map((s) => s.playerId),
          ...liveData.games.flatMap((g) => [g.white, g.black]),
        ];
        const names = await this.client.graphql.resolvePlayers(playerIds);
        if (!this.isCurrent(generation)) return;
        this.callbacks.onStandings(liveData.standings, names);
        this.callbacks.onLiveGames(liveData.games, names);
      } else {
        const standings = await this.client.tournaments.standings(id);
        if (!this.isCurrent(generation)) return;
        const playerIds = standings.map((s) => s.playerId);
        const names = await this.client.graphql.resolvePlayers(playerIds);
        if (!this.isCurrent(generation)) return;
        this.callbacks.onStandings(standings, names);
        this.callbacks.onLiveGames([], names);
      }
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.callbacks.onLoading(false);
      }
    }
  }

  /** Start polling the live endpoint for running games and standings updates. */
  startLive(id: string): void {
    if (this.disposed) return;
    this.stopLive();
    this.liveId = id;

    const poll = async () => {
      if (this.disposed || this.liveId !== id) return;
      // A poll makes two round trips (live, then name resolution). If one outlives the interval,
      // a second starts alongside it and whichever finishes last repaints — which can be the older
      // data. Skipping while one is in flight keeps the last paint the newest response, and stops a
      // slow backend from accumulating requests.
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      try {
        const liveData = await this.client.tournaments.live(id);
        if (this.disposed || this.liveId !== id) return;
        const playerIds = [
          ...liveData.standings.map((s) => s.playerId),
          ...liveData.games.flatMap((g) => [g.white, g.black]),
        ];
        const names = await this.client.graphql.resolvePlayers(playerIds);
        if (this.disposed || this.liveId !== id) return;
        this.callbacks.onStandings(liveData.standings, names);
        this.callbacks.onLiveGames(liveData.games, names);
      } catch (err) {
        if (!this.disposed && this.liveId === id) {
          this.callbacks.onError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        this.pollInFlight = false;
      }
    };

    if (this.pollIntervalMs > 0) {
      this.timerId = this._setInterval(() => void poll(), this.pollIntervalMs);
    }
  }

  /** Stop the live polling timer. */
  stopLive(): void {
    if (this.timerId !== null) {
      this._clearInterval(this.timerId);
      this.timerId = null;
    }
    this.liveId = null;
    this.pollInFlight = false;
  }

  /** Permanently dispose the controller. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLive();
    this.onDispose?.();
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }
}
