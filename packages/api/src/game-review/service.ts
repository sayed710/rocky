import { Position, colorOf, isSquareAttacked, opposite, squareFromName, typeOf } from '@chess-platform/core';
import type { OpeningDatabase } from '@chess-platform/ai-features';
import type { EngineResult } from '@chess-platform/engine';
import type { AnalysisPort } from '../analysis/service.js';
import type { RequestedAnalysisLimits } from '../analysis/limits.js';
import type {
  MistakePredictionInput,
  MistakePredictionOutcome,
} from '../analysis/mistake-prediction-service.js';
import { RequestScopedAnalysis } from '../coach/request-scoped-analysis.js';
import { HttpError } from '../http/errors.js';
import type { FinishedGameForReview, FinishedGameReviewArchive } from './finished-game-review.js';
import {
  classifyGameReviewMove,
  emptyGameReviewSummary,
  type GameReviewClassification,
  type GameReviewSummary,
  type ReviewAlternative,
} from './classification.js';

/** A full instant review is intentionally bounded to keep one request within the engine budget. */
export const MAX_REVIEWED_PLAYER_MOVES = 40;

/** Total engine-work ceiling for one accepted review, independent of client connection lifetime. */
export const DEFAULT_GAME_REVIEW_DEADLINE_MS = 120_000;

/** Exact evidence policy required to compare the played move with one alternative. */
export const GAME_REVIEW_ANALYSIS_LIMITS = { multiPv: 2 } as const satisfies RequestedAnalysisLimits;

/** Pluggable adapter that predicts whether a move was a mistake given engine evidence. */
export interface MoveAssessmentService {
  /**
   * Assess one played move from request-scoped evidence.
   *
   * When supplied, `onAccepted` runs after the adapter's validation and before any engine work it
   * owns; Game Review omits it because the outer review request already owns quota admission.
   */
  predict(
    input: MistakePredictionInput,
    onAccepted?: () => Promise<void>,
  ): Promise<MistakePredictionOutcome>;
}

/** A single assessed player move produced by the review engine. */
export interface GameReviewMove {
  readonly ply: number;
  readonly san: string;
  readonly move: string;
  readonly fenBefore: string;
  readonly assessment: MistakePredictionOutcome;
  readonly classification: GameReviewClassification;
}

/**
 * The complete outcome of one engine-grounded player review.
 *
 * Discriminated on `isPartial`: when false the entire game was analysed; when true the review was
 * capped at {@link MAX_REVIEWED_PLAYER_MOVES} and `cutoffReason` names the cause.
 */
export type GameReviewOutcome = {
  readonly gameId: string;
  readonly variant: string;
  readonly playerColor: 'white' | 'black';
  readonly result: '1-0' | '0-1' | '1/2-1/2';
  readonly termination: string;
  readonly moves: readonly GameReviewMove[];
  readonly summary: GameReviewSummary;
  readonly totalPlayerMoves: number;
  readonly analyzedPlayerMoves: number;
} & (
  | { readonly isPartial: false; readonly cutoffReason?: never }
  | { readonly isPartial: true; readonly cutoffReason: 'move_limit' }
);

/** Construction-time wiring for {@link GameReviewService}. */
export interface GameReviewServiceOptions {
  readonly archive: FinishedGameReviewArchive;
  readonly analysis: AnalysisPort;
  /** Built over the request-scoped analysis port, never the shared library Coach. */
  readonly createMoveAssessment: (analysis: AnalysisPort) => MoveAssessmentService;
  /** The bounded bundled book marks only a known opening prefix; it never invents opening theory. */
  readonly openingDatabase?: OpeningDatabase;
  /** Injectable only for deterministic tests; production owns the default ceiling. */
  readonly deadlineMs?: number;
}

/**
 * Produces a player's engine-grounded review only after a game is durable and over.
 *
 * For long games exceeding the engine move budget, the service returns a bounded partial review
 * with explicit partial-review metadata, ensuring callers never mistake an incomplete set of
 * findings for a complete assessment. A cancelled or unavailable engine operation fails the
 * request, so callers never mistake an interrupted engine run for an assessment.
 */
export class GameReviewService {
  private readonly archive: FinishedGameReviewArchive;
  private readonly analysis: AnalysisPort;
  private readonly createMoveAssessment: (analysis: AnalysisPort) => MoveAssessmentService;
  private readonly openingDatabase: OpeningDatabase | undefined;
  private readonly deadlineMs: number;

  /** Configure the authoritative archive, exact engine policy, and bounded execution deadline. */
  constructor(options: GameReviewServiceOptions) {
    this.archive = options.archive;
    this.analysis = options.analysis;
    this.createMoveAssessment = options.createMoveAssessment;
    this.openingDatabase = options.openingDatabase;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_GAME_REVIEW_DEADLINE_MS;
    if (!Number.isFinite(this.deadlineMs) || this.deadlineMs <= 0) {
      throw new RangeError('game review deadline must be a positive finite number');
    }
  }

  /** Whether this deployment can run the review's exact evidence policy for `variant`. */
  supportsVariant(variant: string): boolean {
    return this.analysis.canSatisfyLimits(GAME_REVIEW_ANALYSIS_LIMITS)
      && this.analysis.supportsMultiPv(variant, GAME_REVIEW_ANALYSIS_LIMITS.multiPv);
  }

  /**
   * Produce one ownership-checked, quota-admitted review.
   *
   * `onAccepted` runs exactly once after ownership, variant, and non-empty-game validation but
   * before engine work. Games over the move budget return the first
   * {@link MAX_REVIEWED_PLAYER_MOVES} player moves with explicit partial-review metadata;
   * cancellation or deadline failures return no interrupted engine result.
   */
  async review(
    input: { readonly gameId: string; readonly userId: string; readonly signal: AbortSignal },
    onAccepted: () => Promise<void>,
  ): Promise<GameReviewOutcome> {
    throwIfReviewCancelled(input.signal);
    const game = await this.archive.finishedGameForReview(input.gameId);
    if (!game || game.gameId !== input.gameId) throw HttpError.notFound('completed game not found');

    const playerColor = playerColorFor(game, input.userId);
    if (!playerColor) throw HttpError.notFound('completed game not found');

    if (!this.supportsVariant(game.variant)) {
      throw HttpError.validation('unsupported variant', { variant: 'unsupported variant' });
    }

    const moves = game.moves.filter((move) => move.by === (playerColor === 'white' ? 'w' : 'b'));
    if (moves.length === 0) throw HttpError.validation('game has no moves to review');

    const totalPlayerMoves = moves.length;
    const isPartial = totalPlayerMoves > MAX_REVIEWED_PLAYER_MOVES;
    const analyzedMoves = isPartial ? moves.slice(0, MAX_REVIEWED_PLAYER_MOVES) : moves;

    // Archive/ownership/length validation is complete before quota is spent. One accepted review
    // consumes one quota unit even though it contains several fixed-policy engine assessments.
    throwIfReviewCancelled(input.signal);
    await onAccepted();

    const bookPly = knownBookPly(game, this.openingDatabase);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.deadlineMs);

    try {
      const reviewSignal = AbortSignal.any([input.signal, deadline.signal]);
      const scoped = new RequestScopedAnalysis(this.analysis, reviewSignal);
      const assessor = this.createMoveAssessment(scoped);
      const reviewed: GameReviewMove[] = [];
      const summary = emptyGameReviewSummary();
      for (const move of analyzedMoves) {
        throwIfReviewCancelled(input.signal, deadline.signal);
        // The review owns this fixed two-line pre-move search. Passing the same evidence into the
        // predictor preserves the normal mistake verdict while avoiding a duplicate first search.
        const before = await scoped.analyze({
          fen: move.fenBefore,
          variant: game.variant,
          multiPv: GAME_REVIEW_ANALYSIS_LIMITS.multiPv,
        });
        const assessment = await assessor.predict({
          fen: move.fenBefore,
          variant: game.variant,
          move: move.uci,
          analysisBefore: before.lines,
        });
        throwIfReviewCancelled(input.signal, deadline.signal);
        const classification = classifyGameReviewMove({
          assessment,
          mover: move.by,
          isBook: move.ply <= bookPly,
          offeredMaterial: offersMaterial(move.fenBefore, move.uci, game.variant),
          alternative: reviewAlternative(before.lines),
        });
        reviewed.push({
          ply: move.ply,
          san: move.san,
          move: move.uci,
          fenBefore: move.fenBefore,
          assessment,
          classification,
        });
        summary[classification] += 1;
      }

      const base = {
        gameId: game.gameId,
        variant: game.variant,
        playerColor,
        result: game.result,
        termination: game.termination,
        moves: reviewed,
        summary,
        totalPlayerMoves,
        analyzedPlayerMoves: reviewed.length,
      };

      return isPartial
        ? { ...base, isPartial: true, cutoffReason: 'move_limit' as const }
        : { ...base, isPartial: false };
    } catch (error: unknown) {
      throwIfReviewCancelled(input.signal, deadline.signal);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Translate either ownership cancellation source into the stable public service error. */
function throwIfReviewCancelled(client: AbortSignal, deadline?: AbortSignal): void {
  if (client.aborted) throw HttpError.unavailable('game review was cancelled');
  if (deadline?.aborted) throw HttpError.unavailable('game review deadline exceeded');
}

/** Return the length of the known standard-opening prefix, or zero when no book applies. */
function knownBookPly(game: FinishedGameForReview, database: OpeningDatabase | undefined): number {
  if (game.variant !== 'standard' || !database) return 0;
  const result = database.lookup(game.moves.map((move) => move.uci as import('@chess-platform/ai-features').MoveUci));
  return result.kind === 'found' ? result.matchedMoves : 0;
}

/** Select the MultiPV-2 line by identity rather than relying on engine response order. */
function reviewAlternative(lines: readonly EngineResult[]): ReviewAlternative | null {
  const alternative = lines.find((line) => line.multipv === 2);
  const move = alternative?.principalVariation[0];
  if (!alternative || !move) return null;
  return {
    move,
    evaluation: { kind: alternative.evaluation.type, value: alternative.evaluation.value },
  };
}

/** A material offer is a candidate for a brilliant move only when the engine itself chose it. */
function offersMaterial(fen: string, uci: string, variant: FinishedGameForReview['variant']): boolean {
  if ((variant !== 'standard' && variant !== 'chess960') || uci.includes('@')) return false;
  try {
    const before = Position.fromFen(fen, variant);
    const mover = before.turn;
    const from = squareFromName(uci.slice(0, 2));
    const to = squareFromName(uci.slice(2, 4));
    const movingPiece = before.snapshot().board[from];
    if (!movingPiece || colorOf(movingPiece) !== mover || pieceValue(typeOf(movingPiece)) < 300) return false;
    const after = before.play(uci);
    const offeredPiece = after.snapshot().board[to];
    return offeredPiece !== null
      && colorOf(offeredPiece) === mover
      && isSquareAttacked(after.snapshot(), to, opposite(mover));
  } catch {
    // The durable archive itself is reconstructed from legal events. This defensive branch makes a
    // partially corrupted test/durable record lose only its optional brilliant label, never the
    // complete ownership-safe review that remains engine-grounded.
    return false;
  }
}

/** Map piece roles to the coarse material scale used only for sacrifice candidacy. */
function pieceValue(piece: 'p' | 'n' | 'b' | 'r' | 'q' | 'k'): number {
  switch (piece) {
    case 'q': return 900;
    case 'r': return 500;
    case 'b':
    case 'n': return 300;
    case 'p': return 100;
    case 'k': return 0;
  }
}

/** Resolve a participant's color without revealing whether a non-participant's game exists. */
function playerColorFor(game: FinishedGameForReview, userId: string): 'white' | 'black' | undefined {
  if (game.white === userId) return 'white';
  if (game.black === userId) return 'black';
  return undefined;
}
