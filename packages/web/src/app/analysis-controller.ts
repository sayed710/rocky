/**
 * Engine analysis controller — a pure, DOM-free orchestrator for the game sidebar's analysis panel.
 *
 * Follows {@link SessionsController}'s generation guard, `disposed` flag and callback shape, because
 * they sit under the same route disposal and a second lifecycle idiom here would be one more thing
 * to get wrong. It adds an `AbortController`, which the sessions list does not need: an analysis
 * request occupies an engine worker, so a request nobody is waiting for should at least stop
 * occupying a browser connection and can never be allowed to paint over a newer one.
 *
 * ## Why a repeat request is ignored rather than superseding
 *
 * The API cannot observe a client disconnect (ADR-0113), so aborting an in-flight analysis does
 * **not** free the engine worker still searching for it. Superseding on every click would therefore
 * double real engine load on the server while looking responsive in the browser. So a request that
 * is already pending wins: further requests are no-ops until it settles, and the view disables the
 * control to make that visible rather than silent.
 *
 * A **position change** is the opposite case and does supersede — the in-flight result describes a
 * position the player is no longer looking at, so it is aborted and discarded. It is deliberately
 * not re-run: analysis is on demand, and re-analysing on every move would put a request on the wire
 * for each half-move of a blitz game without anyone asking for one.
 */
import type { GambitClient } from '../api/client.js';
import type { AnalysisResponse } from '../api/models.js';

/** What the panel is doing right now. Exactly one of these is true at any moment. */
export type AnalysisPhase = 'idle' | 'loading' | 'result' | 'error';

/** A failure the panel has to say something specific about. */
export type AnalysisFailure =
  /** 429 — the caller's own rate limit. Retrying immediately will fail again. */
  | 'rate-limited'
  /** 503 — not configured, saturated, or the engine is unavailable. Transient or permanent. */
  | 'unavailable'
  /** 401 — analysis needs a signed-in caller. */
  | 'unauthenticated'
  /** 409 — another tab or session may be playing a live human game. */
  | 'active-game'
  /**
   * 422 naming the variant — this deployment has no engine for the game being watched, and never
   * will within this page. Distinct from `rejected` because it is permanent: the control should stop
   * being offered rather than fail identically on every click.
   */
  | 'unsupported-variant'
  /** 422 — the position or limits were rejected. A bug on our side if the user sees it. */
  | 'rejected'
  /** Anything else: transport, timeout, decode. */
  | 'failed';

export interface AnalysisCallbacks {
  /** Called whenever the phase changes, with the payload that phase carries. */
  onPhase: (phase: AnalysisPhase) => void;
  /** Called with a fresh result. Never called for a superseded or disposed request. */
  onResult: (result: AnalysisResponse) => void;
  /** Called when a request fails, with the classified reason. */
  onFailure: (failure: AnalysisFailure) => void;
  /**
   * Called when a pending or displayed result stops describing the position on the board, so the
   * view can clear it rather than leave a stale evaluation next to a changed position.
   */
  onInvalidated: () => void;
}

export interface AnalysisControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: AnalysisCallbacks;
  /** The position to analyse, read at request time so it is never stale. */
  readonly getPosition: () => { readonly fen: string; readonly variant: string } | null;
}

/**
 * Classify a rejection into something the panel can explain.
 *
 * Reads `status` structurally rather than by `instanceof`, so a transport that surfaces its own
 * error class still classifies correctly, and no engine-internal message is ever read or shown —
 * the panel says what it means from the status alone.
 */
/** Preserve the active-human-game refusal as a distinct, actionable client state. */
export function classifyFailure(err: unknown): AnalysisFailure {
  const failure = err as { status?: unknown; details?: Record<string, unknown> } | null;
  const status = failure?.status;
  if (status === 429) return 'rate-limited';
  if (status === 503) return 'unavailable';
  if (status === 401) return 'unauthenticated';
  if (status === 409 && failure?.details?.['reason'] === 'active_human_game') return 'active-game';
  if (status === 422 || status === 400) {
    // The API answers an unsupported variant with a validation error naming `variant`, and a bad
    // position with one naming `fen`. Telling them apart matters because only one of them can ever
    // succeed on a retry: a deployment that installs Stockfish alone cannot analyse Atomic or
    // Crazyhouse at all, so offering the control again on the same game would fail identically every
    // time. Read from `details`, never from the message, which is prose the server may reword.
    return failure?.details && 'variant' in failure.details ? 'unsupported-variant' : 'rejected';
  }
  return 'failed';
}

export class AnalysisController {
  private readonly client: GambitClient;
  private readonly callbacks: AnalysisCallbacks;
  private readonly getPosition: AnalysisControllerOptions['getPosition'];

  private generation = 0;
  private pending = false;
  private inFlight: AbortController | null = null;
  private disposed = false;
  /** The FEN the currently displayed or pending result belongs to. */
  private analysedFen: string | null = null;

  constructor(opts: AnalysisControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.getPosition = opts.getPosition;
  }

  /** True while a request is on the wire. The view disables its control on this. */
  get isPending(): boolean {
    return this.pending;
  }

  /**
   * Analyse the position currently on the board.
   *
   * A no-op while a request is pending — see the module docblock for why this coalesces rather than
   * superseding. Also a no-op with no position, which is the state before the first snapshot lands.
   */
  async analyse(lines: number): Promise<void> {
    if (this.disposed || this.pending) return;

    const position = this.getPosition();
    if (!position || position.fen === '') return;

    const generation = ++this.generation;
    const controller = new AbortController();
    this.inFlight = controller;
    this.pending = true;
    this.analysedFen = position.fen;
    this.callbacks.onPhase('loading');

    try {
      const result = await this.client.analysis.analyse(
        { fen: position.fen, variant: position.variant, multiPv: lines },
        controller.signal,
      );
      if (!this.isCurrent(generation)) return;
      // Settle *before* reporting. A listener told the phase is `result` will ask whether a request
      // is still pending — the run control's enabled state is exactly that question — and the honest
      // answer at the moment the result exists is no. Clearing this in `finally` alone left
      // `isPending` true throughout the terminal callbacks, so a view that re-derived its state from
      // the controller disabled its control and never got another event to re-enable it.
      this.settle(controller);
      this.callbacks.onResult(result);
      this.callbacks.onPhase('result');
    } catch (err: unknown) {
      // A request this controller aborted is not a failure the user needs told about — the reason it
      // was aborted (a new position, or teardown) has already produced the right message.
      if (!this.isCurrent(generation) || controller.signal.aborted) return;
      this.settle(controller);
      this.callbacks.onFailure(classifyFailure(err));
      this.callbacks.onPhase('error');
    } finally {
      // Idempotent, and still needed: the early returns above skip the explicit settle.
      this.settle(controller);
    }
  }

  /** Mark this request finished, unless a newer one has already taken its place. */
  private settle(controller: AbortController): void {
    if (this.inFlight === controller) {
      this.inFlight = null;
      this.pending = false;
    }
  }

  /**
   * Tell the controller the board is showing a different position.
   *
   * Invalidates only when the FEN actually differs from the one analysed, so the position callbacks
   * that fire on every snapshot — including ones that re-report the same FEN — do not wipe a result
   * the player is still reading.
   */
  positionChanged(fen: string): void {
    if (this.disposed) return;
    if (this.analysedFen === null || fen === this.analysedFen) return;

    this.abortInFlight();
    this.analysedFen = null;
    this.callbacks.onInvalidated();
    this.callbacks.onPhase('idle');
  }

  /**
   * Permanently dispose. Aborts anything in flight and guarantees no further callback, so a
   * response arriving after an SPA navigation cannot write into a torn-down view.
   */
  dispose(): void {
    this.disposed = true;
    this.abortInFlight();
    this.pending = false;
    this.analysedFen = null;
  }

  private abortInFlight(): void {
    // Bumping the generation as well as aborting: `abort()` alone races a response that has already
    // resolved and is only waiting for its microtask, which would still be `isCurrent` without this.
    this.generation++;
    if (this.inFlight) {
      this.inFlight.abort();
      this.inFlight = null;
    }
    this.pending = false;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
}
