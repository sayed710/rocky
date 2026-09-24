/**
 * DOM rendering for the engine analysis panel in the game sidebar (M15 inc 2).
 *
 * DOM-only render module mirroring `sessions-view.ts`. No network, no state machine —
 * the controller owns state, this renders it.
 */
import type { AnalysisResponse } from '../api/models.js';
import { formatEvaluation, formatPrincipalVariation, formatSeconds } from './analysis-format.js';

export const ANALYSIS_MESSAGES = {
  idle: 'Analyse the position on the board.',
  loading: 'Analysing…',
  positionChanged: 'Position changed. Analyse again.',
  signedOut: 'Sign in to analyse positions.',
  rateLimited: 'Too many analysis requests. Wait a moment and try again.',
  unavailable: 'Analysis is unavailable right now.',
  unauthenticated: 'Sign in to analyse positions.',
  activeGame: 'Analysis is unavailable while you are playing a live human game.',
  unsupportedVariant: 'This deployment has no engine for this variant.',
  rejected: 'This position could not be analysed.',
  failed: 'Analysis failed. Try again.',
} as const;

/**
 * Clear and render one `.panel-row` per line, in `multipv` order.
 * Row composition follows DESIGN.md's two-child rule:
 * leading `.row-main` containing `<span class="analysis-eval">` and `<span class="analysis-moves">`.
 * Trailing `.count` is omitted entirely.
 */
export function renderLines(container: HTMLElement, result: AnalysisResponse): void {
  container.innerHTML = '';
  const doc = container.ownerDocument ?? document;
  const sortedLines = [...result.lines].sort((a, b) => a.multipv - b.multipv);

  for (const line of sortedLines) {
    const row = doc.createElement('div');
    row.className = 'panel-row';

    const rowMain = doc.createElement('div');
    rowMain.className = 'row-main';

    const evalEl = doc.createElement('span');
    evalEl.className = 'analysis-eval';
    evalEl.textContent = formatEvaluation(line.evaluation, result.fen);

    const movesEl = doc.createElement('span');
    movesEl.className = 'analysis-moves';
    movesEl.textContent = formatPrincipalVariation(line.moves);

    rowMain.appendChild(evalEl);
    rowMain.appendChild(movesEl);
    row.appendChild(rowMain);

    container.appendChild(row);
  }
}

/**
 * Render the achieved search figures from `result.lines[0]`.
 * Hidden when there are no lines.
 */
export function renderReached(el: HTMLElement, result: AnalysisResponse): void {
  const first = result.lines[0];
  if (!first) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.textContent = `Reached depth ${first.depth} · ${formatSeconds(first.timeMs)}`;
  el.hidden = false;
}

/**
 * Render the applied limits from `result.applied`.
 * Applied limits represent what was requested and enforced, distinct from reached depth.
 */
export function renderLimits(el: HTMLElement, result: AnalysisResponse): void {
  const linesCount = result.applied.multiPv;
  const linesLabel = linesCount === 1 ? '1 line' : `${linesCount} lines`;
  el.textContent = `Limits: depth ${result.applied.depth} · ${formatSeconds(result.applied.movetimeMs)} · ${linesLabel}`;
  el.hidden = false;
}

/**
 * Toggle `aria-busy` on the results container.
 */
export function setBusy(container: HTMLElement, busy: boolean): void {
  container.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/**
 * Render text into the status note element and toggle `hidden`.
 */
export function renderNote(el: HTMLElement, text: string | null): void {
  if (text) {
    el.textContent = text;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

/**
 * Render text into the error alert element and toggle `hidden`.
 */
export function renderError(el: HTMLElement, text: string | null): void {
  if (text) {
    el.textContent = text;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

/**
 * Clear the lines in the container.
 */
export function clearLines(container: HTMLElement): void {
  container.innerHTML = '';
}
