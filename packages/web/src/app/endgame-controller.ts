/** DOM-free lifecycle controller for on-demand endgame training (M15 inc 20). */
import type { GambitClient } from '../api/client.js';
import type {
  EndgameAttemptResult,
  EndgameNextRequest,
  EndgamePosition,
} from '../api/models.js';
import { classifyFailure } from './analysis-controller.js';

export type EndgamePhase = 'idle' | 'loading' | 'position' | 'attempting' | 'result' | 'error';
export type EndgameFailure =
  | 'rate-limited'
  | 'unavailable'
  | 'unauthenticated'
  | 'active-game'
  | 'unsupported-variant'
  | 'rejected'
  | 'failed';

export interface EndgameCallbacks {
  readonly onPhase: (phase: EndgamePhase) => void;
  readonly onPosition: (position: EndgamePosition) => void;
  readonly onAttemptResult: (result: EndgameAttemptResult) => void;
  readonly onFailure: (failure: EndgameFailure) => void;
  readonly onInvalidated: () => void;
}

export interface EndgameControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: EndgameCallbacks;
}

export class EndgameController {
  private readonly client: GambitClient;
  private readonly callbacks: EndgameCallbacks;
  private generation = 0;
  private pending = false;
  private inFlight: AbortController | null = null;
  private disposed = false;
  private currentPos: EndgamePosition | null = null;

  constructor(options: EndgameControllerOptions) {
    this.client = options.client;
    this.callbacks = options.callbacks;
  }

  /** Whether a look-up or attempt is in flight. */
  get isPending(): boolean {
    return this.pending;
  }

  /** Current loaded position, if any. */
  get currentPosition(): EndgamePosition | null {
    return this.currentPos;
  }

  /** Fetch the next endgame position. */
  async next(filter?: EndgameNextRequest): Promise<void> {
    if (this.disposed || this.pending) return;

    const generation = ++this.generation;
    const controller = new AbortController();
    this.pending = true;
    this.inFlight = controller;
    this.currentPos = null;
    this.callbacks.onInvalidated();
    this.callbacks.onPhase('loading');

    try {
      const result = await this.client.analysis.nextEndgame(filter ?? {}, controller.signal);
      if (!this.isCurrent(generation)) return;
      this.settle(controller);
      this.currentPos = result;
      this.callbacks.onPosition(result);
      this.callbacks.onPhase('position');
    } catch (error: unknown) {
      if (!this.isCurrent(generation) || controller.signal.aborted) return;
      this.settle(controller);
      this.callbacks.onFailure(classifyFailure(error));
      this.callbacks.onPhase('error');
    } finally {
      this.settle(controller);
    }
  }

  /** Submit an attempt for the current position. */
  async attempt(move: string): Promise<void> {
    if (this.disposed || this.pending) return;
    if (!this.currentPos) return;

    const generation = ++this.generation;
    const controller = new AbortController();
    this.pending = true;
    this.inFlight = controller;
    this.callbacks.onPhase('attempting');

    try {
      const result = await this.client.analysis.attemptEndgame(
        { id: this.currentPos.id, move },
        controller.signal,
      );
      if (!this.isCurrent(generation)) return;
      this.settle(controller);
      this.callbacks.onAttemptResult(result);
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

  /** Abandon the controller: abort any request and ignore anything that arrives afterwards. */
  dispose(): void {
    this.disposed = true;
    this.abortInFlight();
    this.currentPos = null;
  }

  /**
   * Release the pending flag, but only for the request that still owns it.
   *
   * @param controller - the request finishing. A superseded one must not clear a flag a newer
   * request set, which is why this compares identity.
   */
  private settle(controller: AbortController): void {
    if (this.inFlight === controller) {
      this.inFlight = null;
      this.pending = false;
    }
  }

  /**
   * Abandon whatever is open.
   *
   * Bumping the generation matters even beside the `abort()`: a response that has already resolved
   * and queued as a microtask is past the point where aborting the request can stop it.
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
