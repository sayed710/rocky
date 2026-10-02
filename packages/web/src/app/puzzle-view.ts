/** Structured, prose-free rendering for tactic discovery. */
import type { PuzzleEvidence, PuzzleGenerationResponse } from '../api/models.js';
import { formatEvaluation, formatPrincipalVariation } from './analysis-format.js';

import type { I18nManager } from '../i18n/manager.js';
import type { MessageKey } from '../i18n/catalog/index.js';

export const PUZZLE_MESSAGE_KEYS = {
  idle: 'ai.puzzle.idle',
  running: 'ai.puzzle.running',
  positionChanged: 'ai.puzzle.positionChanged',
  signedOut: 'ai.puzzle.signedOut',
  noTactic: 'ai.puzzle.noTactic',
  insufficient: 'ai.puzzle.insufficient',
  terminal: 'ai.puzzle.terminal',
  rateLimited: 'ai.puzzle.rateLimited',
  unavailable: 'ai.puzzle.unavailable',
  activeGame: 'ai.puzzle.activeGame',
  unsupportedVariant: 'ai.puzzle.unsupportedVariant',
  rejected: 'ai.puzzle.rejected',
  failed: 'ai.puzzle.failed',
} as const satisfies Record<string, MessageKey>;

export type PuzzleMessageKey = keyof typeof PUZZLE_MESSAGE_KEYS;

export function puzzleMessage(key: PuzzleMessageKey, i18n: I18nManager): string {
  return i18n.t(PUZZLE_MESSAGE_KEYS[key]);
}

export function renderPuzzleResult(
  rows: HTMLElement,
  resultEl: HTMLElement,
  result: PuzzleGenerationResponse,
  i18n: I18nManager,
): string | null {
  rows.innerHTML = '';
  if (result.kind === 'insufficient') {
    resultEl.hidden = true;
    return result.reason === 'terminal_position'
      ? i18n.t('ai.puzzle.terminal')
      : i18n.t('ai.puzzle.insufficient');
  }

  const doc = rows.ownerDocument ?? document;
  if (result.kind === 'puzzle') {
    rows.appendChild(row(doc, i18n.t('ai.puzzle.label.solution'), result.solutionMove));
    rows.appendChild(row(doc, i18n.t('ai.puzzle.label.line'), formatPrincipalVariation(result.solutionLine)));
    rows.appendChild(row(doc, i18n.t('ai.puzzle.label.evidence'), evidenceLabel(result.evidence, i18n)));
    rows.appendChild(row(doc, i18n.t('ai.puzzle.label.difficulty'), result.difficulty));
  } else {
    rows.appendChild(row(doc, i18n.t('ai.puzzle.label.bestMove'), result.bestMove));
    rows.appendChild(row(doc, i18n.t('ai.puzzle.label.alternative'), result.comparisonMove));
    rows.appendChild(row(doc, i18n.t('ai.puzzle.label.evidence'), evidenceLabel(result.evidence, i18n)));
    rows.appendChild(row(
      doc,
      i18n.t('ai.puzzle.label.evaluations'),
      `${formatEvaluation(result.bestEvaluation, result.fen)} / ${formatEvaluation(result.comparisonEvaluation, result.fen)}`,
    ));
  }
  resultEl.hidden = false;
  return result.kind === 'no_tactic' ? i18n.t('ai.puzzle.noTactic') : null;
}

export function clearPuzzle(rows: HTMLElement, result: HTMLElement): void {
  rows.innerHTML = '';
  result.hidden = true;
  result.setAttribute('aria-busy', 'false');
}

export function setPuzzleBusy(result: HTMLElement, busy: boolean): void {
  result.setAttribute('aria-busy', busy ? 'true' : 'false');
}

export function renderPuzzleNote(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? '';
  el.hidden = text === null;
}

export function renderPuzzleError(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? '';
  el.hidden = text === null;
}

function evidenceLabel(evidence: PuzzleEvidence, i18n: I18nManager): string {
  if (evidence.kind === 'centipawn_gap') return i18n.t('ai.puzzle.pawnGap', { gap: (evidence.gapCp / 100).toFixed(2) });
  const relation = evidence.relation.replaceAll('_', ' ');
  if (evidence.distanceGap === null) return relation;
  const unit = evidence.distanceGap === 1 ? i18n.t('ai.puzzle.move') : i18n.t('ai.puzzle.moves');
  return i18n.t('ai.puzzle.distanceGap', {
    relation,
    count: String(evidence.distanceGap),
    unit,
  });
}

function row(doc: Document, labelText: string, valueText: string): HTMLElement {
  const item = doc.createElement('div');
  item.className = 'panel-row';
  const label = doc.createElement('span');
  label.className = 'puzzle-label';
  label.textContent = labelText;
  const value = doc.createElement('span');
  value.className = 'puzzle-value';
  value.textContent = valueText;
  item.appendChild(label);
  item.appendChild(value);
  return item;
}
