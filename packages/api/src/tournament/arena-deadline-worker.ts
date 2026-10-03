import type { TournamentsRepository } from '@chess-platform/persistence';
import type { Logger } from '../ports/logger';
import type { Metrics } from '../ports/metrics';
import type { ArenaService } from './arena.service';

/** Uses the deadline-worker rotating page/stop-drain pattern (ADR-0149).
 * Entries remain durable until finished; a crash never consumes work. Row locks
 * serialize decisions, so no lease or queue claim is necessary. */
export class ArenaDeadlineWorker {
  private cursor: string | null = null;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<{ scanned: number; failed: number }> | undefined;

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
    await this.running?.catch(() => {});
  }

  /** Deterministic test/operator hook; concurrent passes coalesce. */
  runPass(): Promise<{ scanned: number; failed: number }> {
    if (this.running) return this.running;
    const pass = this.pass();
    this.running = pass;
    void pass.finally(() => { this.running = undefined; }).catch(() => {});
    return pass;
  }

  private async pass(): Promise<{ scanned: number; failed: number }> {
    const size = this.options.pageSize ?? 50;
    const ids = await this.repo.listArenaWorkAfter(this.cursor, size);
    this.cursor = ids.length === size ? ids.at(-1)! : null;
    let failed = 0;
    for (const id of ids) {
      try { await this.arenas.reconcile(id); }
      catch (error) {
        failed++;
        this.options.metrics?.counter('arena_deadline_failures_total').inc();
        // At most one sampled failure log per bounded pass; identifiers never become metric labels.
        if (failed === 1) this.options.logger?.warn('Arena deadline reconciliation failed; work remains durable', {
          tournamentId: id,
          repairRequired: error instanceof Error && error.message.includes('operator repair required'),
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
      void this.runPass().catch(() => {
        this.options.metrics?.counter('arena_deadline_failures_total').inc();
        this.options.logger?.warn('Arena deadline scan failed; retrying on next poll');
      }).finally(() => this.schedule(this.options.pollMs ?? 1_000));
    }, delay);
    this.timer.unref?.();
  }
}
