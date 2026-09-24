/** DOM-free lifecycle controller for on-demand tactic discovery. */
import type { GambitClient } from '../api/client.js';
import type { PuzzleGenerationResponse } from '../api/models.js';
import { classifyFailure } from './analysis-controller.js';

export type PuzzlePhase = 'idle' | 'loading' | 'result' | 'error';
export type PuzzleFailure =
  | 'rate-limited'
  | 'unavailable'
  | 'unauthenticated'
  | 'active-game'
  | 'unsupported-variant'
  | 'rejected'
  | 'failed';

export interface PuzzleControllerOptions {
  readonly client: GambitClient;
  readonly getPosition: () => { readonly fen: string; readonly variant: string } | null;
  readonly callbacks: {
    onPhase: (phase: PuzzlePhase) => void;
    onResult: (result: PuzzleGenerationResponse) => void;
    onFailure: (failure: PuzzleFailure) => void;
    onInvalidated: () => void;
  };
}

export class PuzzleController {
  private readonly client: GambitClient;
  private readonly getPosition: PuzzleControllerOptions['getPosition'];
  private readonly callbacks: PuzzleControllerOptions['callbacks'];
  private generation = 0;
  private pending = false;
  private inFlight: AbortController | null = null;
  private disposed = false;
  private targetKey: string | null = null;

  constructor(options: PuzzleControllerOptions) {
    this.client = options.client;
    this.getPosition = options.getPosition;
    this.callbacks = options.callbacks;
  }

  get isPending(): boolean { return this.pending; }

  async find(): Promise<void> {
    if (this.disposed || this.pending) return;
    const position = this.getPosition();
    if (!position || position.fen === '') return;

    const generation = ++this.generation;
    const controller = new AbortController();
    this.pending = true;
    this.inFlight = controller;
    this.targetKey = key(position);
    this.callbacks.onPhase('loading');
    try {
      const result = await this.client.analysis.findPuzzle(position, controller.signal);
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

  positionChanged(position: { readonly fen: string; readonly variant: string }): void {
    if (this.disposed || this.targetKey === null || this.targetKey === key(position)) return;
    this.abortInFlight();
    this.targetKey = null;
    this.callbacks.onInvalidated();
    this.callbacks.onPhase('idle');
  }

  dispose(): void {
    this.disposed = true;
    this.abortInFlight();
    this.targetKey = null;
  }

  private settle(controller: AbortController): void {
    if (this.inFlight === controller) {
      this.inFlight = null;
      this.pending = false;
    }
  }

  private abortInFlight(): void {
    this.generation += 1;
    this.inFlight?.abort();
    this.inFlight = null;
    this.pending = false;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
}

function key(position: { readonly fen: string; readonly variant: string }): string {
  return `${position.variant}\u0000${position.fen}`;
}
