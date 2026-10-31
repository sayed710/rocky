import type { GameReviewResponse } from '../api/models.js';

export type GameReviewPhase = 'idle' | 'loading' | 'result' | 'error';

interface ReviewOwner {
  readonly gameId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly abortController: AbortController;
}

export interface GameReviewControllerOptions {
  readonly gameId: string;
  readonly sessionId: string | null;
  readonly requestReview: (gameId: string, signal: AbortSignal) => Promise<GameReviewResponse>;
  readonly callbacks: {
    onPhase: (phase: GameReviewPhase) => void;
    onResult: (review: GameReviewResponse) => void;
    onFailure: (error: unknown) => void;
    onInvalidated: () => void;
  };
}

/**
 * Owns the private completed-game review request and the identity allowed to publish its answer.
 *
 * Abort limits wasted work, but it is not the correctness boundary: a response may already be
 * queued when cancellation happens. The game, authenticated session, generation, and concrete
 * request controller must all still match immediately before a result reaches the view.
 */
export class GameReviewController {
  private readonly gameId: string;
  private readonly requestReview: GameReviewControllerOptions['requestReview'];
  private readonly callbacks: GameReviewControllerOptions['callbacks'];
  private sessionId: string | null;
  private generation = 0;
  private pending = false;
  private inFlight: AbortController | null = null;
  private disposed = false;

  /** Capture the immutable game and initial session ownership for this mounted route. */
  constructor(options: GameReviewControllerOptions) {
    this.gameId = options.gameId;
    this.sessionId = options.sessionId;
    this.requestReview = options.requestReview;
    this.callbacks = options.callbacks;
  }

  /** Whether the current owner has an unsettled request. */
  get isPending(): boolean {
    return this.pending;
  }

  /** Request a review for this mount and its current authenticated session. */
  async review(): Promise<void> {
    const owner = this.startRequest();
    if (!owner) return;

    try {
      const completedReview = await this.requestReview(owner.gameId, owner.abortController.signal);
      this.accept(owner, completedReview);
    } catch (error: unknown) {
      this.reject(owner, error);
    } finally {
      this.settle(owner.abortController);
    }
  }

  /** Invalidate private state whenever the authenticated identity changes, including sign-out. */
  sessionChanged(sessionId: string | null): void {
    if (this.disposed || this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.invalidate();
  }

  /** Abandon route-owned work and clear anything it rendered. */
  dispose(): void {
    if (this.disposed) return;
    this.invalidate();
    this.disposed = true;
  }

  /** Start one generation only when this live mount has an authenticated owner. */
  private startRequest(): ReviewOwner | null {
    if (this.disposed || this.pending || this.sessionId === null) return null;
    const abortController = new AbortController();
    const owner = {
      gameId: this.gameId,
      sessionId: this.sessionId,
      generation: ++this.generation,
      abortController,
    };
    this.inFlight = abortController;
    this.pending = true;
    this.callbacks.onPhase('loading');
    return owner;
  }

  /** Commit a response only after every captured ownership identity still matches. */
  private accept(owner: ReviewOwner, completedReview: GameReviewResponse): void {
    if (!this.isCurrent(owner)) return;
    this.settle(owner.abortController);
    if (completedReview.gameId !== owner.gameId) {
      this.callbacks.onFailure(new Error('game review response identity mismatch'));
      this.callbacks.onPhase('error');
      return;
    }
    this.callbacks.onResult(completedReview);
    this.callbacks.onPhase('result');
  }

  /** Publish only failures belonging to the still-current, non-aborted request. */
  private reject(owner: ReviewOwner, error: unknown): void {
    if (!this.isCurrent(owner) || owner.abortController.signal.aborted) return;
    this.settle(owner.abortController);
    this.callbacks.onFailure(error);
    this.callbacks.onPhase('error');
  }

  /** Advance the generation, abort work, and synchronously clear private presentation state. */
  invalidate(): void {
    this.generation += 1;
    this.inFlight?.abort();
    this.inFlight = null;
    this.pending = false;
    this.callbacks.onInvalidated();
    this.callbacks.onPhase('idle');
  }

  /** Release pending state only when settling the controller that still owns it. */
  private settle(abortController: AbortController): void {
    if (this.inFlight !== abortController) return;
    this.inFlight = null;
    this.pending = false;
  }

  /** Verify route, session, generation, and concrete request-controller identity. */
  private isCurrent(owner: ReviewOwner): boolean {
    return !this.disposed
      && owner.gameId === this.gameId
      && owner.sessionId === this.sessionId
      && owner.generation === this.generation
      && this.inFlight === owner.abortController;
  }
}
