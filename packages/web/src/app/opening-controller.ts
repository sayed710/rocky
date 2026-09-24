/** DOM-free lifecycle controller for on-demand opening identification (M15 inc 19, ADR-0127). */
import type { GambitClient } from '../api/client.js';
import type { OpeningExplorationResponse } from '../api/models.js';
import { classifyFailure } from './analysis-controller.js';

/**
 * The server's ply ceiling, mirrored so the UI can decline rather than spend a refusal learning it.
 *
 * A second copy of a server constant, which this repository does not do casually — so it is not
 * left to drift. The API publishes the same number as `maxItems` on `OpeningExplorationRequest`,
 * and `opening-ply-ceiling.test.ts` reads it out of the committed `openapi.json` and fails if the
 * two disagree. The server remains the authority either way: exceeding it is a 422 regardless of
 * what this file believes.
 */
export const MAX_OPENING_PLIES = 60;

export type OpeningPhase = 'idle' | 'loading' | 'result' | 'error';
export type OpeningFailure =
  | 'rate-limited'
  | 'unavailable'
  | 'unauthenticated'
  | 'active-game'
  | 'unsupported-variant'
  | 'rejected'
  | 'failed';

/**
 * What a request is about.
 *
 * The move sequence, not a FEN — an opening is identified by the order the moves were played, and
 * two different sequences can reach the same position (the server answers them differently; see
 * ADR-0127). Keying staleness on the position would let a transposition's answer overwrite the
 * one on screen.
 */
export interface OpeningTarget {
  readonly variant: string;
  readonly moves: readonly string[];
}

export interface OpeningControllerOptions {
  readonly client: GambitClient;
  readonly getTarget: () => OpeningTarget | null;
  readonly callbacks: {
    onPhase: (phase: OpeningPhase) => void;
    onResult: (result: OpeningExplorationResponse) => void;
    onFailure: (failure: OpeningFailure) => void;
    onInvalidated: () => void;
  };
}

export class OpeningController {
  private readonly client: GambitClient;
  private readonly getTarget: OpeningControllerOptions['getTarget'];
  private readonly callbacks: OpeningControllerOptions['callbacks'];
  private generation = 0;
  private pending = false;
  private inFlight: AbortController | null = null;
  private disposed = false;
  private targetKey: string | null = null;

  constructor(options: OpeningControllerOptions) {
    this.client = options.client;
    this.getTarget = options.getTarget;
    this.callbacks = options.callbacks;
  }

  /** Whether a look-up is in flight; the button reads this to stay disabled while one is open. */
  get isPending(): boolean { return this.pending; }

  /**
   * Ask the server which opening this is.
   *
   * Repeat calls while one is in flight coalesce to nothing: the `pending` gate returns early, so a
   * reader leaning on the button spends one request rather than one per click.
   */
  async identify(): Promise<void> {
    if (this.disposed || this.pending) return;
    const target = this.getTarget();
    if (!target) return;

    const generation = ++this.generation;
    const controller = new AbortController();
    this.pending = true;
    this.inFlight = controller;
    this.targetKey = key(target);
    this.callbacks.onPhase('loading');
    try {
      const result = await this.client.analysis.exploreOpening(
        { variant: target.variant, moves: target.moves },
        controller.signal,
      );
      if (!this.isCurrent(generation)) return;
      this.settle(controller);
      this.callbacks.onResult(result);
      this.callbacks.onPhase('result');
    } catch (error: unknown) {
      if (!this.isCurrent(generation) || controller.signal.aborted) return;
      this.settle(controller);
      this.callbacks.onFailure(classifyFailure(error));
      this.callbacks.onPhase('error');
    } finally {
      this.settle(controller);
    }
  }

  /**
   * The game moved on.
   *
   * Only acts when the new sequence differs from the one the displayed result belongs to, so a
   * re-announced identical state does not throw away a result the reader is still looking at.
   */
  sequenceChanged(target: OpeningTarget): void {
    if (this.disposed || this.targetKey === null || this.targetKey === key(target)) return;
    this.abortInFlight();
    this.targetKey = null;
    this.callbacks.onInvalidated();
    this.callbacks.onPhase('idle');
  }

  /**
   * There is no longer any sequence to be about.
   *
   * The ledger outran the server's ceiling, stopped being a contiguous run from ply 1, or the
   * variant left standard. `sequenceChanged` cannot express this — it needs a target to compare —
   * so without this a result stays on screen describing a move order the game no longer has.
   */
  targetLost(): void {
    if (this.disposed || this.targetKey === null) return;
    this.abortInFlight();
    this.targetKey = null;
    this.callbacks.onInvalidated();
    this.callbacks.onPhase('idle');
  }

  /** Abandon the controller: abort any request and ignore anything that arrives afterwards. */
  dispose(): void {
    this.disposed = true;
    this.abortInFlight();
    this.targetKey = null;
  }

  /**
   * Release the pending flag, but only for the request that still owns it.
   *
   * @param controller - the request finishing. A superseded one must not clear the flag a newer
   * request set, which is why this compares identity rather than assuming.
   */
  private settle(controller: AbortController): void {
    if (this.inFlight === controller) {
      this.inFlight = null;
      this.pending = false;
    }
  }

  /**
   * Bumping the generation is what makes an in-flight response stale, and it has to happen even
   * though `abort()` is called beside it: a response already resolved and queued as a microtask is
   * past the point where aborting the request can stop it.
   */
  private abortInFlight(): void {
    this.generation += 1;
    this.inFlight?.abort();
    this.inFlight = null;
    this.pending = false;
  }

  /**
   * @param generation - the generation a request was issued under.
   * @returns whether its answer is still the one being waited for.
   */
  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
}

/**
 * The key is the whole question: the variant, then every move in order.
 *
 * A space separates them because neither a variant name nor a UCI move can contain one, so no two
 * distinct targets can produce the same key by shifting where the separator falls.
 */
function key(target: OpeningTarget): string {
  return `${target.variant} ${target.moves.join(' ')}`;
}
