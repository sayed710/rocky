/**
 * DOM rendering for the engine analysis panel in the game sidebar (M15 inc 2).
 *
 * DOM-only render module mirroring `sessions-view.ts`. No network, no state machine —
 * the controller owns state, this renders it.
 */
import type { AnalysisResponse } from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';
import { enMessages } from '../i18n/catalog/en.js';
import { formatEvaluation, formatPrincipalVariation, formatSeconds } from './analysis-format.js';
import { applyLtrIsolation } from '../i18n/bidi.js';

export const ANALYSIS_MESSAGES = {
  idle: enMessages['game.analysis.idle'],
  loading: enMessages['game.analysis.loading'],
  positionChanged: enMessages['game.analysis.positionChanged'],
  signedOut: enMessages['game.analysis.signedOut'],
  rateLimited: enMessages['game.analysis.rateLimited'],
  unavailable: enMessages['game.analysis.unavailable'],
  unauthenticated: enMessages['game.analysis.unauthenticated'],
  activeGame: enMessages['game.analysis.activeGame'],
  unsupportedVariant: enMessages['game.analysis.unsupportedVariant'],
  rejected: enMessages['game.analysis.rejected'],
  failed: enMessages['game.analysis.failed'],
} as const;

export function getAnalysisMessage(key: keyof typeof ANALYSIS_MESSAGES, i18n: I18nManager): string {
  switch (key) {
    case 'idle': return i18n.t('game.analysis.idle');
    case 'loading': return i18n.t('game.analysis.loading');
    case 'positionChanged': return i18n.t('game.analysis.positionChanged');
    case 'signedOut': return i18n.t('game.analysis.signedOut');
    case 'rateLimited': return i18n.t('game.analysis.rateLimited');
    case 'unavailable': return i18n.t('game.analysis.unavailable');
    case 'unauthenticated': return i18n.t('game.analysis.unauthenticated');
    case 'activeGame': return i18n.t('game.analysis.activeGame');
    case 'unsupportedVariant': return i18n.t('game.analysis.unsupportedVariant');
    case 'rejected': return i18n.t('game.analysis.rejected');
    case 'failed': return i18n.t('game.analysis.failed');
  }
}

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
    applyLtrIsolation(evalEl);

    const movesEl = doc.createElement('span');
    movesEl.className = 'analysis-moves';
    movesEl.textContent = formatPrincipalVariation(line.moves);
    applyLtrIsolation(movesEl);

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
export function renderReached(el: HTMLElement, result: AnalysisResponse, i18n: I18nManager): void {
  const first = result.lines[0];
  if (!first) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.textContent = i18n.t('game.analysis.reachedDepth', {
    depth: String(first.depth),
    time: formatSeconds(first.timeMs),
  });
  el.hidden = false;
}

/**
 * Render the applied limits from `result.applied`.
 * Applied limits represent what was requested and enforced, distinct from reached depth.
 */
export function renderLimits(el: HTMLElement, result: AnalysisResponse, i18n: I18nManager): void {
  const linesCount = result.applied.multiPv;
  const linesLabel = linesCount === 1 ? i18n.t('game.analysis.oneLine') : `${linesCount} lines`;
  el.textContent = i18n.t('game.analysis.limits', {
    depth: String(result.applied.depth),
    movetime: formatSeconds(result.applied.movetimeMs),
    lines: linesLabel,
  });
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
