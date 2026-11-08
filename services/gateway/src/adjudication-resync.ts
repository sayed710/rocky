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
 * A game with nothing new costs one read; a notice that did arrive makes the pass a no-op.
 */

import { ADJUDICATION_ACTOR, type CommandRouter, type GameAuthority } from '@chess-platform/realtime-gateway';
import type { Counter, Logger } from '@chess-platform/api';

export interface AdjudicationResyncOptions {
  readonly authority: Pick<GameAuthority, 'adjudicatingGames'>;
  readonly router: CommandRouter;
  /** Bounded source of locally watched games observed in proving/stopped states (e.g. RealtimeGateway). */
  readonly watched?: { watchedAdjudicatingGames(): Iterable<string> };
  /** Delay between passes (default 1 s). */
  readonly intervalMs?: number;
  readonly logger?: Logger;
  readonly failuresCounter?: Counter;
}

export class AdjudicationResync {
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;

  constructor(private readonly options: AdjudicationResyncOptions) {
    const interval = options.intervalMs ?? 1_000;
    if (!Number.isSafeInteger(interval) || interval <= 0) throw new RangeError('intervalMs must be a positive safe integer');
    this.#intervalMs = interval;
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

  /** Fold the log into every resident or watched game this replica knows that is proving or stopped. */
  async runPass(): Promise<number> {
    let failed = 0;
    const candidates = new Set<string>(this.options.authority.adjudicatingGames());
    if (this.options.watched) {
      for (const gameId of this.options.watched.watchedAdjudicatingGames()) {
        candidates.add(gameId);
      }
    }
    for (const gameId of candidates) {
      try {
        await this.options.router.route(gameId, ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });
      } catch (error) {
        failed += 1;
        this.options.failuresCounter?.inc();
        this.options.logger?.warn('Adjudication resync failed for a game; it is retried next pass', {
          gameId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return failed;
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
