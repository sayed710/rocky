/**
 * The lifecycle shared by every on-demand "ask the server about the last move" control.
 *
 * `ExplainController` and `AssessController` are the same machine with a different request: read the
 * current target, spend real server work on it, and make sure the answer that lands still describes
 * the move on the board. Extracted rather than copied, because the one defect the independent review
 * of PR #135 found was exactly a copy-paste divergence — `AnalysisController.abortInFlight` bumped
 * the generation and `ExplainController.abortInFlight` did not, so a response already resolved and
 * merely awaiting its microtask painted over a cleared panel. A third hand-maintained copy would be
 * a third chance for the same class of bug.
 *
 * Two behaviours carry over from `AnalysisController` and matter more here, because these requests
 * cost engine searches:
 *
 * - **A repeat request is ignored, not superseded.** The API still cannot observe a client
 *   disconnect (ADR-0113), so aborting does not stop the work already bought. Superseding on every
 *   click would multiply real cost while merely looking responsive.
 * - **A target change supersedes.** The answer describes a move the player has moved past, so it is
 *   aborted, discarded, and never re-run — nobody asked about every half-move.
 */
import type { GambitClient } from '../api/client.js';

export type RequestPhase = 'idle' | 'loading' | 'result' | 'error';

export type RequestFailure =
  /** 429 — the caller's own per-user limit, deliberately low because each call costs real work. */
  | 'rate-limited'
  /** 503 — not configured, or the subsystem behind it is unavailable. */
  | 'unavailable'
  /** 401 — the feature requires a signed-in caller. */
  | 'unauthenticated'
  /** 409 — account-wide fair-play guard rejected a request after another tab started a game. */
  | 'active-game'
  /** 422 — the position or move was rejected. A bug on our side if a player sees it. */
  | 'rejected'
  /** Anything else: transport, timeout, decode. */
  | 'failed';

/** The move to ask about: the position it was played from, and the move itself in full UCI. */
export interface MoveTarget {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
}

export interface MoveRequestCallbacks<T> {
  onPhase: (phase: RequestPhase) => void;
  onResult: (result: T) => void;
  onFailure: (failure: RequestFailure) => void;
  /** The displayed or pending answer no longer describes the move on the board. */
  onInvalidated: () => void;
}

export interface MoveRequestControllerOptions<T> {
  readonly client: GambitClient;
  readonly callbacks: MoveRequestCallbacks<T>;
  /** Read at request time so it can never be stale. `null` when there is no move to ask about. */
  readonly getTarget: () => MoveTarget | null;
  /** The one thing that differs between features: which endpoint answers. */
  readonly send: (client: GambitClient, target: MoveTarget, signal: AbortSignal) => Promise<T>;
}

/**
 * Classify a rejection from its structured status and reason.
 *
 * Never reads a message: the API deliberately returns fixed strings for subsystem failures precisely
 * so that nothing a vendor or an engine said reaches a user, and re-deriving meaning from that text
 * would defeat it. There is no `unsupported-variant` case — these controls are gated on the
 * capability's variant list before they are ever offered.
 */
/** Recognize the account-wide fair-play conflict even when it arrives from another session. */
export function classifyRequestFailure(err: unknown): RequestFailure {
  const status = (err as { status?: unknown } | null)?.status;
  const reason = (err as { details?: { reason?: unknown } } | null)?.details?.reason;
  if (status === 409 && reason === 'active_human_game') return 'active-game';
  if (status === 429) return 'rate-limited';
  if (status === 503) return 'unavailable';
  if (status === 401) return 'unauthenticated';
  if (status === 422 || status === 400) return 'rejected';
  return 'failed';
}

export class MoveRequestController<T> {
  private readonly client: GambitClient;
  private readonly callbacks: MoveRequestCallbacks<T>;
  private readonly getTarget: () => MoveTarget | null;
  private readonly send: MoveRequestControllerOptions<T>['send'];

  private generation = 0;
  private pending = false;
  private inFlight: AbortController | null = null;
  private disposed = false;
  /** The move the displayed or pending answer belongs to, as `fen|move`. */
  private answeredKey: string | null = null;

  constructor(opts: MoveRequestControllerOptions<T>) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.getTarget = opts.getTarget;
    this.send = opts.send;
  }

  /** True while a request is on the wire. The view disables its control on this. */
  get isPending(): boolean {
    return this.pending;
  }

  async run(): Promise<void> {
    if (this.disposed || this.pending) return;

    const target = this.getTarget();
    if (!target || target.fen === '' || target.move === '') return;

    const generation = ++this.generation;
    const controller = new AbortController();
    this.inFlight = controller;
    this.pending = true;
    this.answeredKey = keyOf(target);
    this.callbacks.onPhase('loading');

    try {
      const result = await this.send(this.client, target, controller.signal);
      if (!this.isCurrent(generation)) return;
      // Settle before reporting: a listener told the phase is `result` re-derives the control's
      // enabled state from `isPending`, and the honest answer once the result exists is "not
      // pending". Clearing only in `finally` left it disabled with no further event to re-enable it.
      this.settle(controller);
      this.callbacks.onResult(result);
      this.callbacks.onPhase('result');
    } catch (err: unknown) {
      if (!this.isCurrent(generation) || controller.signal.aborted) return;
      this.settle(controller);
      this.callbacks.onFailure(classifyRequestFailure(err));
      this.callbacks.onPhase('error');
    } finally {
      this.settle(controller);
    }
  }

  /**
   * Tell the controller which move the board is showing now.
   *
   * Invalidates only when the target actually differs from the answered one, so the position
   * callbacks that fire on every snapshot — including ones re-reporting the same state — do not wipe
   * an answer the player is still reading.
   */
  targetChanged(): void {
    if (this.disposed) return;
    const target = this.getTarget();
    const key = target ? keyOf(target) : null;
    if (this.answeredKey === null || key === this.answeredKey) return;

    this.answeredKey = null;
    this.abortInFlight();
    this.callbacks.onInvalidated();
    this.callbacks.onPhase('idle');
  }

  dispose(): void {
    this.disposed = true;
    this.abortInFlight();
    this.answeredKey = null;
  }

  private abortInFlight(): void {
    // The generation bump is not redundant beside the abort, and this is the line the independent
    // review of PR #135 found missing: `abort()` alone races a response that has already resolved
    // and is only waiting for its microtask. That response would still pass `isCurrent`, so an
    // answer about the move the player has just moved past would paint over the cleared panel. The
    // real transport rejects an aborted request first, which is why only a test driving the
    // controller directly can see it.
    this.generation += 1;
    this.inFlight?.abort();
    this.settleAll();
  }

  private settle(controller: AbortController): void {
    if (this.inFlight === controller) {
      this.inFlight = null;
      this.pending = false;
    }
  }

  private settleAll(): void {
    this.inFlight = null;
    this.pending = false;
  }

  /** A result is current only if it is the newest request and the controller still exists. */
  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
}

/**
 * Identity of an answer: the same move from the same position, **under the same rules**.
 *
 * The variant is part of the key because it is part of the request, and an answer is only still
 * valid for a target the request would produce again. A game's variant does not change mid-mount
 * today, so no current path reaches the case this closes — but a key that omits a field the request
 * carries is a key that will be wrong the first time that stops being true, and the whole job of
 * this key is deciding what to throw away. Raised in the CodeRabbit review of PR #136.
 */
function keyOf(target: MoveTarget): string {
  return `${target.variant}|${target.fen}|${target.move}`;
}
