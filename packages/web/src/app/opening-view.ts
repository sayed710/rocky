/**
 * Structured, prose-free rendering for opening identification (M15 inc 19, ADR-0127).
 *
 * Every row is a field the server sent. There is deliberately no row for a win rate, a game count
 * or a popularity figure: the bundled dataset's statistics are illustrative rather than measured, so
 * the server publishes none and this file must not manufacture one from what it does publish.
 */
import type { OpeningContinuationView, OpeningExplorationResponse } from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';
import type { MessageKey } from '../i18n/catalog/index.js';

export const OPENING_MESSAGE_KEYS = {
  idle: 'ai.opening.idle',
  running: 'ai.opening.running',
  sequenceChanged: 'ai.opening.sequenceChanged',
  signedOut: 'ai.opening.signedOut',
  noOpening: 'ai.opening.noOpening',
  unsupportedVariant: 'ai.opening.unsupportedVariant',
  noMoves: 'ai.opening.noMoves',
  noSequence: 'ai.opening.noSequence',
  beyondOpening: 'ai.opening.beyondOpening',
  rateLimited: 'ai.opening.rateLimited',
  unavailable: 'ai.opening.unavailable',
  activeGame: 'ai.opening.activeGame',
  rejected: 'ai.opening.rejected',
  failed: 'ai.opening.failed',
} as const satisfies Record<string, MessageKey>;

export type OpeningMessageKey = keyof typeof OPENING_MESSAGE_KEYS;

export function openingMessage(key: OpeningMessageKey, i18n: I18nManager): string {
  return i18n.t(OPENING_MESSAGE_KEYS[key]);
}

/**
 * Render the result, returning the note that belongs beside it (or `null` when the rows say
 * everything). A `found: false` answer is the server declining to name an opening, so it produces
 * a message and no rows — never a nearest guess.
 */
export function renderOpeningResult(
  rows: HTMLElement,
  resultEl: HTMLElement,
  result: OpeningExplorationResponse,
  i18n: I18nManager,
): string | null {
  rows.innerHTML = '';
  if (!result.found) {
    resultEl.hidden = true;
    return openingMessage('noOpening', i18n);
  }

  const doc = rows.ownerDocument ?? document;
  if (result.name !== null) rows.appendChild(row(doc, i18n.t('ai.opening.label.opening'), result.name));
  if (result.eco !== null) rows.appendChild(row(doc, i18n.t('ai.opening.label.eco'), result.eco));
  rows.appendChild(row(doc, i18n.t('ai.opening.label.bookDepth'), plies(result.matchedMoves, i18n)));
  rows.appendChild(row(doc, i18n.t('ai.opening.label.position'), result.outOfBook ? i18n.t('ai.opening.outOfBook') : i18n.t('ai.opening.inBook')));
  for (const continuation of result.continuations) {
    rows.appendChild(row(doc, moveLabel(continuation), continuationName(continuation)));
  }
  resultEl.hidden = false;
  return null;
}

/**
 * Empty the section back to its unanswered state.
 *
 * @param rows - the row container to empty.
 * @param result - the result group to hide and mark not-busy.
 */
export function clearOpening(rows: HTMLElement, result: HTMLElement): void {
  rows.innerHTML = '';
  result.hidden = true;
  result.setAttribute('aria-busy', 'false');
}

/**
 * @param result - the result group.
 * @param busy - whether a look-up is running, announced through `aria-busy` so a screen reader
 * knows the region is about to change rather than reading a stale answer.
 */
export function setOpeningBusy(result: HTMLElement, busy: boolean): void {
  result.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/**
 * @param el - the note element, a polite live region.
 * @param text - the note, or `null` to hide it. Hidden rather than blank so an empty line does not
 * sit in the layout between the button and the rows.
 */
export function renderOpeningNote(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? '';
  el.hidden = text === null;
}

/**
 * @param el - the error element, an assertive live region.
 * @param text - the message, or `null` to clear it.
 */
export function renderOpeningError(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? '';
  el.hidden = text === null;
}

/** Plies, said plainly. `matchedMoves` counts half-moves, and calling them "moves" would halve it. */
export function plies(count: number, i18n: I18nManager): string {
  return count === 1 ? i18n.t('ai.opening.ply', { count: '1' }) : i18n.t('ai.opening.plies', { count: String(count) });
}

/** SAN when the dataset has it, UCI when it does not — never a SAN derived here from the UCI. */
function moveLabel(continuation: OpeningContinuationView): string {
  return continuation.san ?? continuation.move;
}

/**
 * @param continuation - one book move.
 * @returns its opening name, falling back to the ECO code and then to nothing. Never a name
 * assembled here — an unnamed line stays unnamed.
 */
function continuationName(continuation: OpeningContinuationView): string {
  return continuation.name ?? continuation.eco ?? '';
}

/**
 * One label/value row in the shared panel language.
 *
 * @param doc - the owning document, taken as a parameter so this works under the test double.
 * @param labelText - the left column.
 * @param valueText - the right column, set as text so nothing from the server can be markup.
 * @returns the row element, unattached.
 */
function row(doc: Document, labelText: string, valueText: string): HTMLElement {
  const item = doc.createElement('div');
  item.className = 'panel-row';
  const label = doc.createElement('span');
  label.className = 'opening-label';
  label.textContent = labelText;
  const value = doc.createElement('span');
  value.className = 'opening-value';
  value.textContent = valueText;
  item.appendChild(label);
  item.appendChild(value);
  return item;
}
