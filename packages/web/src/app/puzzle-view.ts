/** Structured, prose-free rendering for tactic discovery. */
import type { PuzzleEvidence, PuzzleGenerationResponse } from '../api/models.js';
import { formatEvaluation, formatPrincipalVariation } from './analysis-format.js';

export const PUZZLE_MESSAGES = {
  idle: 'Find a tactic in the position on the board.',
  running: 'Searching for a tactic…',
  positionChanged: 'Position changed. Search again.',
  signedOut: 'Sign in to find tactics.',
  noTactic: 'No tactic met the server’s fixed evidence threshold.',
  insufficient: 'The engine returned insufficient evidence for a conclusion.',
  terminal: 'This position is already decided.',
  rateLimited: 'Too many tactic searches. Try again shortly.',
  unavailable: 'Tactic search is unavailable right now.',
  activeGame: 'Tactic search is unavailable while you are playing a live human game.',
  unsupportedVariant: 'Tactic search is not available for this variant.',
  rejected: 'This position cannot be searched for tactics.',
  failed: 'Could not search for a tactic.',
} as const;

export function renderPuzzleResult(
  rows: HTMLElement,
  resultEl: HTMLElement,
  result: PuzzleGenerationResponse,
): string | null {
  rows.innerHTML = '';
  if (result.kind === 'insufficient') {
    resultEl.hidden = true;
    return result.reason === 'terminal_position' ? PUZZLE_MESSAGES.terminal : PUZZLE_MESSAGES.insufficient;
  }

  const doc = rows.ownerDocument ?? document;
  if (result.kind === 'puzzle') {
    rows.appendChild(row(doc, 'Solution', result.solutionMove));
    rows.appendChild(row(doc, 'Line', formatPrincipalVariation(result.solutionLine)));
    rows.appendChild(row(doc, 'Evidence', evidenceLabel(result.evidence)));
    rows.appendChild(row(doc, 'Difficulty', result.difficulty));
  } else {
    rows.appendChild(row(doc, 'Best move', result.bestMove));
    rows.appendChild(row(doc, 'Alternative', result.comparisonMove));
    rows.appendChild(row(doc, 'Evidence', evidenceLabel(result.evidence)));
    rows.appendChild(row(
      doc,
      'Evaluations',
      `${formatEvaluation(result.bestEvaluation, result.fen)} / ${formatEvaluation(result.comparisonEvaluation, result.fen)}`,
    ));
  }
  resultEl.hidden = false;
  return result.kind === 'no_tactic' ? PUZZLE_MESSAGES.noTactic : null;
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

function evidenceLabel(evidence: PuzzleEvidence): string {
  if (evidence.kind === 'centipawn_gap') return `${(evidence.gapCp / 100).toFixed(2)} pawn gap`;
  const relation = evidence.relation.replaceAll('_', ' ');
  if (evidence.distanceGap === null) return relation;
  const unit = evidence.distanceGap === 1 ? 'move' : 'moves';
  return `${relation} · ${evidence.distanceGap} ${unit}`;
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
