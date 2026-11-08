/**
 * @packageDocumentation
 * Owner-side delivery of adjudication changes (Issue #124, ADR-0176).
 *
 * The worker notifies a game's owner after it settles or releases, but a notice can be lost: the
 * worker's process can die between its commit and its notice, or the route can fail. Delivery must
 * not depend on it. Only a game that is proving or stopped can be changed by the worker, and each
 * replica knows exactly which of its resident games are in those states. Every pass routes
 * adjudicationChanged through the command router for each such game, which claims ownership or
 * forwards to the owner to fold the durable log and publish whatever the worker committed.
 *
 * In addition, each replica periodically inspects a bounded fair batch of locally watched rooms
 * (`localGameIds()`, covering rooms and active join buffers) to recover silently admitted games
 * where proving state publication was lost before owner death (Qodo 1857452 finding 3f11e6cf).
 * A game with nothing new costs one read; a notice that did arrive makes the pass a no-op.
 *
 * Rotation & fairness: Locally watched room IDs are maintained in an in-memory rotation queue
 * bounded strictly by the current set of watched rooms. Surviving rooms retain their relative
 * FIFO order across passes, departed rooms are pruned, new arrivals are appended behind waiting
 * survivors, and chosen/inspected rooms rotate to the back. This guarantees liveness and fair
 * coverage for retained rooms even under dynamic room churn, and clears cleanly when all rooms close.
 */

import { ADJUDICATION_ACTOR, type CommandRouter, type GameAuthority } from '@chess-platform/realtime-gateway';
import type { Counter, Logger } from '@chess-platform/api';

export interface AdjudicationResyncOptions {
  readonly authority: Pick<GameAuthority, 'adjudicatingGames'>;
  readonly router: CommandRouter;
  /** Bounded source of locally watched games (e.g. RealtimeGateway). */
  readonly watched?: {
    /** Required fallback source of locally watched rooms and join buffers. */
    localGameIds(): Iterable<string>;
    /** Optional fast hint of rooms observed in proving/stopped states. */
    watchedAdjudicatingGames?(): Iterable<string>;
  };
  /** Delay between passes (default 1 s). */
  readonly intervalMs?: number;
  /** Maximum number of fallback locally watched rooms to inspect per pass (default 8). */
  readonly fallbackBatchSize?: number;
  readonly logger?: Logger;
  readonly failuresCounter?: Counter;
}

export class AdjudicationResync {
  readonly #intervalMs: number;
  readonly #fallbackBatchSize: number;
  #watchedQueue: string[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;

  constructor(private readonly options: AdjudicationResyncOptions) {
    const interval = options.intervalMs ?? 1_000;
    if (!Number.isSafeInteger(interval) || interval <= 0) throw new RangeError('intervalMs must be a positive safe integer');
    this.#intervalMs = interval;
    const fallbackBatch = options.fallbackBatchSize ?? 8;
    if (!Number.isSafeInteger(fallbackBatch) || fallbackBatch <= 0) throw new RangeError('fallbackBatchSize must be a positive safe integer');
    this.#fallbackBatchSize = fallbackBatch;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  /** Fold the log into resident or watched games in adjudication, plus a bounded fair batch of local rooms. */
  async runPass(): Promise<number> {
    const fast = this.#fastCandidates();
    const fallback = this.#selectFallbackCandidates(fast);
    const candidates = [...fast, ...fallback];
    let failed = 0;
    for (const gameId of candidates) {
      const ok = await this.#routeCandidate(gameId);
      if (!ok) failed += 1;
    }
    return failed;
  }

  #fastCandidates(): Set<string> {
    const candidates = new Set<string>(this.options.authority.adjudicatingGames());
    if (this.options.watched?.watchedAdjudicatingGames) {
      for (const gameId of this.options.watched.watchedAdjudicatingGames()) {
        candidates.add(gameId);
      }
    }
    return candidates;
  }

  #syncWatchedQueue(): void {
    if (!this.options.watched) {
      this.#watchedQueue = [];
      return;
    }
    const current = new Set(this.options.watched.localGameIds());
    if (current.size === 0) {
      this.#watchedQueue = [];
      return;
    }
    const surviving = this.#watchedQueue.filter((id) => current.has(id));
    const known = new Set(surviving);
    const newArrivals: string[] = [];
    for (const id of current) {
      if (!known.has(id)) {
        newArrivals.push(id);
      }
    }
    newArrivals.sort();
    this.#watchedQueue = [...surviving, ...newArrivals];
  }

  #selectFallbackCandidates(fast: ReadonlySet<string>): string[] {
    this.#syncWatchedQueue();
    if (this.#watchedQueue.length === 0) return [];

    const selected: string[] = [];
    const budget = this.#fallbackBatchSize;
    const total = this.#watchedQueue.length;
    let inspected = 0;

    while (inspected < total && selected.length < budget) {
      const gameId = this.#watchedQueue.shift()!;
      inspected += 1;
      this.#watchedQueue.push(gameId);
      if (!fast.has(gameId)) {
        selected.push(gameId);
      }
    }
    return selected;
  }

  async #routeCandidate(gameId: string): Promise<boolean> {
    try {
      await this.options.router.route(gameId, ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });
      return true;
    } catch (error) {
      this.options.failuresCounter?.inc();
      this.options.logger?.warn('Adjudication resync failed for a game; it is retried next pass', {
        gameId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.runPass()
        .then(() => undefined, () => undefined)
        .finally(() => {
          this.#running = undefined;
          this.#schedule();
        });
    }, this.#intervalMs);
  }
}
