import type { Variant } from '@chess-platform/core';
import type { CoachOmissionReason, CoachOutcome, CoachSection } from '../coach/coach-service.js';
import {
  endgameNextView,
  mistakePredictionView,
  openingExplorationView,
  type CoachPuzzleView,
  type EndgameNextView,
  type MistakeMoveOutcomeView,
  type MistakePredictionView,
  type MoveExplanationCitationView,
  type MoveOutcomeView,
  type OpeningExplorationView,
} from '../presenters.js';

export const STUDY_PARTNER_COACHING_VERSION = 1 as const;

export interface StudyPartnerExplanationView {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
  readonly explanation: string;
  readonly citation: MoveExplanationCitationView;
}

export type StudyPartnerSection<T> =
  | { readonly kind: 'present'; readonly value: T }
  | { readonly kind: 'omitted'; readonly reason: CoachOmissionReason };

export interface StudyPartnerCoachingV1 {
  readonly version: typeof STUDY_PARTNER_COACHING_VERSION;
  readonly fen: string;
  readonly variant: Variant;
  readonly move: string;
  readonly mistake: StudyPartnerSection<MistakePredictionView>;
  readonly explanation: StudyPartnerSection<StudyPartnerExplanationView>;
  readonly opening: StudyPartnerSection<OpeningExplorationView>;
  readonly puzzle: StudyPartnerSection<CoachPuzzleView>;
  readonly endgame: StudyPartnerSection<EndgameNextView>;
}

function projectSection<Input, Output>(
  section: CoachSection<Input> | StudyPartnerSection<Input>,
  present: (value: Input) => Output,
): StudyPartnerSection<Output> {
  return section.kind === 'present'
    ? { kind: 'present', value: present(section.value) }
    : { kind: 'omitted', reason: section.reason };
}

function explanationView(value: StudyPartnerExplanationView): StudyPartnerExplanationView {
  return {
    fen: value.fen,
    variant: value.variant,
    move: value.move,
    explanation: value.explanation,
    citation: {
      moveOutcome: citationMoveOutcomeView(value.citation.moveOutcome),
      evalKind: value.citation.evalKind,
      evalValue: value.citation.evalValue,
      evalLabel: value.citation.evalLabel,
      bestMove: value.citation.bestMove,
      bestLine: [...value.citation.bestLine],
      depth: value.citation.depth,
    },
  };
}

function puzzleView(value: CoachPuzzleView): CoachPuzzleView {
  return {
    kind: 'puzzle',
    fen: value.fen,
    variant: value.variant,
    difficulty: value.difficulty,
  };
}

/** Project the production Coach result without provider metadata or withheld answers. */
export function studyPartnerCoaching(outcome: CoachOutcome): StudyPartnerCoachingV1 {
  if (outcome.move === null) throw new Error('Study Partner coaching requires a move');
  const mistake = projectSection(outcome.mistake, mistakePredictionView);
  const explanation = projectSection(outcome.explanation, explanationView);
  const opening = projectSection(outcome.opening, openingExplorationView);
  const puzzle = projectSection(outcome.puzzle, puzzleView);
  const endgame = projectSection(outcome.endgame, endgameNextView);
  return {
    version: STUDY_PARTNER_COACHING_VERSION,
    fen: outcome.fen,
    variant: outcome.variant as Variant,
    move: outcome.move,
    mistake,
    explanation,
    opening,
    puzzle,
    endgame,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === 'string' && values.includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function hasPosition(value: Record<string, unknown>): boolean {
  return typeof value['fen'] === 'string'
    && typeof value['variant'] === 'string'
    && typeof value['move'] === 'string';
}

function isEvaluation(value: unknown): boolean {
  return isRecord(value)
    && isOneOf(value['evalKind'], ['cp', 'mate'] as const)
    && isFiniteNumber(value['evalValue'])
    && typeof value['evalLabel'] === 'string';
}

function isTerminalMoveOutcome(value: Record<string, unknown>): boolean {
  return value['kind'] === 'terminal'
    && isOneOf(value['reason'], [
      'checkmate',
      'stalemate',
      'insufficient_material',
      'fifty_move',
      'threefold',
      'variant_win',
      'variant_draw',
      'dead_position',
    ] as const)
    && (value['reason'] === 'dead_position'
      ? value['result'] === '1/2-1/2'
      : isOneOf(value['result'], ['1-0', '0-1', '1/2-1/2'] as const));
}

function isCitationMoveOutcome(value: unknown): value is MoveOutcomeView {
  return isRecord(value)
    && (value['kind'] === 'evaluation' ? isEvaluation(value) : isTerminalMoveOutcome(value));
}

function isMistakeMoveOutcome(value: unknown): value is MistakeMoveOutcomeView {
  return isRecord(value)
    && (value['kind'] === 'evaluation'
      ? isEvaluation(value)
      : isTerminalMoveOutcome(value) && typeof value['label'] === 'string');
}

function citationMoveOutcomeView(value: MoveOutcomeView): MoveOutcomeView {
  return value.kind === 'evaluation'
    ? {
        kind: 'evaluation',
        evalKind: value.evalKind,
        evalValue: value.evalValue,
        evalLabel: value.evalLabel,
      }
    : { kind: 'terminal', reason: value.reason, result: value.result };
}

function mistakeMoveOutcomeView(value: MistakeMoveOutcomeView): MistakeMoveOutcomeView {
  return value.kind === 'evaluation'
    ? {
        kind: 'evaluation',
        evalKind: value.evalKind,
        evalValue: value.evalValue,
        evalLabel: value.evalLabel,
      }
    : { kind: 'terminal', reason: value.reason, result: value.result, label: value.label };
}

function storedMistakePredictionView(value: MistakePredictionView): MistakePredictionView {
  return { ...mistakePredictionView(value), after: mistakeMoveOutcomeView(value.after) };
}

function isMistakePrediction(value: unknown): value is MistakePredictionView {
  if (!isRecord(value) || !hasPosition(value) || !isRecord(value['before'])) return false;
  return isOneOf(value['classification'], ['ok', 'inaccuracy', 'mistake', 'blunder'] as const)
    && isEvaluation(value['before'])
    && isMistakeMoveOutcome(value['after'])
    && (value['centipawnLoss'] === null || isFiniteNumber(value['centipawnLoss']))
    && isNullableString(value['bestMove'])
    && isStringArray(value['bestLine'])
    && isFiniteNumber(value['depth']);
}

function isExplanation(value: unknown): value is StudyPartnerExplanationView {
  if (!isRecord(value) || !hasPosition(value) || typeof value['explanation'] !== 'string') return false;
  const citation = value['citation'];
  return isRecord(citation)
    && isCitationMoveOutcome(citation['moveOutcome'])
    && isEvaluation(citation)
    && isNullableString(citation['bestMove'])
    && isStringArray(citation['bestLine'])
    && isFiniteNumber(citation['depth']);
}

function isOpeningContinuation(value: unknown): boolean {
  return isRecord(value)
    && typeof value['move'] === 'string'
    && isNullableString(value['san'])
    && isNullableString(value['eco'])
    && isNullableString(value['name']);
}

function isOpening(value: unknown): value is OpeningExplorationView {
  return isRecord(value)
    && isStringArray(value['moves'])
    && typeof value['found'] === 'boolean'
    && isNullableString(value['eco'])
    && isNullableString(value['name'])
    && Number.isInteger(value['matchedMoves'])
    && typeof value['matchedMoves'] === 'number'
    && value['matchedMoves'] >= 0
    && typeof value['outOfBook'] === 'boolean'
    && Array.isArray(value['continuations'])
    && value['continuations'].every(isOpeningContinuation);
}

function isPuzzle(value: unknown): value is CoachPuzzleView {
  return isRecord(value)
    && value['kind'] === 'puzzle'
    && typeof value['fen'] === 'string'
    && typeof value['variant'] === 'string'
    && isOneOf(value['difficulty'], ['easy', 'medium', 'hard', 'brilliant'] as const);
}

function isEndgame(value: unknown): value is EndgameNextView {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && isOneOf(value['type'], [
      'KQ_vs_K',
      'KR_vs_K',
      'KP_vs_K',
      'KBB_vs_K',
      'KBN_vs_K',
      'KNN_vs_K',
      'KRB_vs_K',
      'KQ_vs_KR',
      'Lucena',
      'Philidor',
      'Opposition',
      'KRP_vs_KR',
      'KQP_vs_KQ',
      'KPP_vs_K',
      'KBP_vs_K',
      'KNP_vs_K',
    ] as const)
    && typeof value['name'] === 'string'
    && typeof value['fen'] === 'string'
    && isOneOf(value['sideToMove'], ['w', 'b'] as const)
    && isOneOf(value['objective'], ['mate', 'win', 'draw'] as const)
    && isOneOf(value['difficulty'], ['beginner', 'intermediate', 'advanced'] as const)
    && isNullableString(value['technique']);
}

const COACH_OMISSION_REASONS = [
  'not_requested',
  'not_applicable',
  'unsupported',
  'unavailable',
  'cancelled',
] as const satisfies readonly CoachOmissionReason[];

function storedSection<T>(
  section: unknown,
  isValue: (value: unknown) => value is T,
  present: (value: T) => T,
): StudyPartnerSection<T> {
  if (!isRecord(section)) throw new Error('invalid stored Study Partner coaching section');
  if (section['kind'] === 'omitted' && isOneOf(section['reason'], COACH_OMISSION_REASONS)) {
    return { kind: 'omitted', reason: section['reason'] };
  }
  if (section['kind'] === 'present' && isValue(section['value'])) {
    return { kind: 'present', value: present(section['value']) };
  }
  throw new Error('invalid stored Study Partner coaching section');
}

/** The DB is server-owned; this guard rejects corrupt or unknown projection versions at its edge. */
export function storedStudyPartnerCoaching(value: unknown): StudyPartnerCoachingV1 {
  if (!isRecord(value) || value['version'] !== STUDY_PARTNER_COACHING_VERSION) {
    throw new Error('unsupported stored Study Partner coaching projection');
  }
  const fen = value['fen'];
  const variant = value['variant'];
  const move = value['move'];
  if (typeof fen !== 'string' || typeof variant !== 'string' || typeof move !== 'string') {
    throw new Error('invalid stored Study Partner coaching projection');
  }
  if (variant !== 'standard') {
    throw new Error('invalid stored Study Partner coaching variant');
  }
  const mistake = storedSection(value['mistake'], isMistakePrediction, storedMistakePredictionView);
  const explanation = storedSection(value['explanation'], isExplanation, explanationView);
  const opening = storedSection(value['opening'], isOpening, openingExplorationView);
  const puzzle = storedSection(value['puzzle'], isPuzzle, puzzleView);
  const endgame = storedSection(value['endgame'], isEndgame, endgameNextView);
  return {
    version: STUDY_PARTNER_COACHING_VERSION,
    fen,
    variant: 'standard',
    move,
    mistake,
    explanation,
    opening,
    puzzle,
    endgame,
  };
}
