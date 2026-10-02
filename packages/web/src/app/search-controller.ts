/**
 * Search controller — a pure, DOM-free orchestrator for the search query lifecycle.
 *
 * One request per query. Hits arrive carrying their own title and subtitle (ADR-0094), so there is
 * no per-result hydration to orchestrate: a page of ten used to cost up to twelve requests and only
 * painted once every one of them settled.
 *
 * It mirrors {@link TournamentController}'s requestGeneration stale-response guard.
 */
import type { GambitClient } from '../api/client.js';
import type { SearchMode } from '../api/models.js';
import type { SearchRow } from './search-results.js';
import { toSearchRow } from './search-results.js';

export interface SearchCallbacks {
  onResults: (hits: readonly SearchRow[], total: number) => void;
  onLoading: (loading: boolean) => void;
  onError: (message: string) => void;
}

export interface SearchControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: SearchCallbacks;
  readonly onDispose?: (() => void) | undefined;
}

export class SearchController {
  private readonly client: GambitClient;
  private readonly callbacks: SearchCallbacks;
  private readonly onDispose: (() => void) | undefined;
  private requestGeneration = 0;
  private disposed = false;

  constructor(opts: SearchControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.onDispose = opts.onDispose;
  }

  async search(q: string, mode?: SearchMode): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const searchRes = await this.client.search.query({
        q,
        ...(mode !== undefined ? { mode } : {}),
        limit: 10,
      });
      if (!this.isCurrent(generation)) return;

      const rows = searchRes.results.map(toSearchRow);

      this.callbacks.onResults(rows, searchRes.total);
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose?.();
  }

  /**
   * Whether {@link dispose} has been called.
   *
   * `search` already refuses to run after disposal, so this exists for the *other* thing a mount
   * does after an await: touch the DOM. `mountSearch` resolves the capability flags asynchronously
   * and renders the mode selector when they arrive, which on a fast navigation can land after the
   * route it belongs to is gone. Reading it here rather than reassigning `dispose` on the instance
   * keeps the disposal contract in the class that owns it.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }
}
