/**
 * Leaderboard controller — a pure, DOM-free orchestrator for the leaderboard lifecycle.
 *
 * Fetches top players in the selected rating pool (variant and speed) from the REST client adapter and attempts
 * optional handle resolution via GraphQL (`client.graphql.resolvePlayers`). If handle resolution
 * fails or is unavailable, it gracefully degrades to showing un-linked short IDs without failing
 * the page request.
 *
 * Uses `requestGeneration` and `disposed` state guards to ensure out-of-order async resolution
 * or post-teardown completions never paint results or errors. The latest request still clears its
 * loading state so persistent route markup cannot remain busy after teardown.
 */
import type { GambitClient } from '../api/client.js';
import type { LeaderboardEntry, Speed, Variant, SocialPlayer } from '../api/models.js';

export interface LeaderboardCallbacks {
  onResults: (
    entries: readonly LeaderboardEntry[],
    names: ReadonlyMap<string, SocialPlayer>,
    variant: Variant,
    speed: Speed,
  ) => void;
  onLoading: (loading: boolean) => void;
  onError: (message: string) => void;
}

export interface LeaderboardControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: LeaderboardCallbacks;
  /** Maximum number of leaderboard entries to fetch (default 100). */
  readonly limit?: number;
}

export class LeaderboardController {
  private readonly client: GambitClient;
  private readonly callbacks: LeaderboardCallbacks;
  private readonly limit: number;
  private requestGeneration = 0;
  private disposed = false;

  constructor(opts: LeaderboardControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.limit = opts.limit ?? 100;
  }

  /** Load the leaderboard for one rating pool. */
  async loadLeaderboard(variant: Variant, speed: Speed): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);

    try {
      const entries = await this.client.leaderboard(variant, speed, { limit: this.limit });
      if (!this.isCurrent(generation)) return;

      let names: ReadonlyMap<string, SocialPlayer> = new Map();
      try {
        const userIds = entries.map((e) => e.userId);
        if (userIds.length > 0) {
          names = await this.client.graphql.resolvePlayers(userIds);
        }
      } catch {
        // Optional handle resolution read-layer failure does not fail the page request
      }

      if (!this.isCurrent(generation)) return;

      this.callbacks.onResults(entries, names, variant, speed);
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === this.requestGeneration) {
        this.callbacks.onLoading(false);
      }
    }
  }

  /** Permanently dispose the controller, cancelling pending result and error callbacks. */
  dispose(): void {
    this.disposed = true;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }
}
