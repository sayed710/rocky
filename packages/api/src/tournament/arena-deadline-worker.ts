import type { TournamentsRepository } from '@chess-platform/persistence';
import type { Logger } from '../ports/logger';
import type { Metrics } from '../ports/metrics';
import type { ArenaService } from './arena.service';
import { arenaFailureFields } from './arena-diagnostics';

/** Uses the deadline-worker rotating page/stop-drain pattern (ADR-0149).
 * Entries remain durable until finished; a crash never consumes work. Row locks
 * serialize decisions, so no lease or queue claim is necessary. */
export class ArenaDeadlineWorker {
  private cursor: string | null = null;
  private ceiling: string | null = null;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<{ scanned: number; failed: number }> | undefined;
  private controller: AbortController | undefined;

  constructor(private readonly repo: TournamentsRepository, private readonly arenas: ArenaService,
    private readonly options: { pollMs?: number; pageSize?: number; logger?: Logger; metrics?: Metrics;
      schedule?: typeof setTimeout; cancel?: typeof clearTimeout } = {}) {
    for (const value of [options.pollMs ?? 1_000, options.pageSize ?? 50]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid Arena worker bound');
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) (this.options.cancel ?? clearTimeout)(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.running?.catch(() => {});
  }

  /** Deterministic test/operator hook; concurrent passes coalesce. */
  runPass(): Promise<{ scanned: number; failed: number }> {
    if (this.running) return this.running;
    const controller = new AbortController();
    this.controller = controller;
    const pass = this.pass(controller.signal);
    this.running = pass;
    void pass.finally(() => { this.running = undefined; this.controller = undefined; }).catch(() => {});
    return pass;
  }

  private async pass(signal: AbortSignal): Promise<{ scanned: number; failed: number }> {
    const size = this.options.pageSize ?? 50;
    // PostgreSQL membership sequence, not an ID maximum: later middle-ID
    // arrivals cannot extend this cycle. Restart resets the cursor and safely
    // captures a new durable boundary; no row is claimed or consumed here.
    if (this.cursor === null) this.ceiling = await this.repo.arenaWorkCeiling(signal);
    if (this.ceiling === null) return { scanned: 0, failed: 0 };
    const ids = await this.repo.listArenaWorkAfter(this.cursor, size, signal, this.ceiling);
    this.cursor = ids.length === size ? ids.at(-1)! : null;
    let failed = 0;
    for (const id of ids) {
      if (signal.aborted) break;
      try { await this.arenas.reconcile(id, signal); }
      catch (error) {
        if (signal.aborted) break;
        failed++;
        this.options.metrics?.counter('arena_deadline_failures_total').inc();
        // At most one sampled failure log per bounded pass; identifiers never become metric labels.
        if (failed === 1) this.options.logger?.warn('Arena deadline reconciliation failed; work remains durable', {
          tournamentId: id,
          operation: 'reconcile', ...arenaFailureFields(error),
        });
      }
    }
    this.options.metrics?.counter('arena_deadline_reconciliations_total').inc(ids.length);
    return { scanned: ids.length, failed };
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = (this.options.schedule ?? setTimeout)(() => {
      this.timer = undefined;
      void this.runPass().catch(error => {
        if (this.stopped) return;
        this.options.metrics?.counter('arena_deadline_failures_total').inc();
        this.options.logger?.warn('Arena deadline scan failed; retrying on next poll', { operation: 'scan', ...arenaFailureFields(error) });
      }).finally(() => this.schedule(this.options.pollMs ?? 1_000));
    }, delay);
    this.timer.unref?.();
  }
}
