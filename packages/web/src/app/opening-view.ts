/**
 * Structured, prose-free rendering for opening identification (M15 inc 19, ADR-0127).
 *
 * Every row is a field the server sent. There is deliberately no row for a win rate, a game count
 * or a popularity figure: the bundled dataset's statistics are illustrative rather than measured, so
 * the server publishes none and this file must not manufacture one from what it does publish.
 */
import type { OpeningContinuationView, OpeningExplorationResponse } from '../api/models.js';

export const OPENING_MESSAGES = {
  idle: 'Identify the opening played in this game.',
  running: 'Looking up the opening…',
  sequenceChanged: 'The game has moved on. Identify again.',
  signedOut: 'Sign in to identify openings.',
  noOpening: 'No known opening matches this move order.',
  unsupportedVariant: 'Opening identification covers standard chess only.',
  noMoves: 'No moves have been played yet.',
  noSequence: 'The full move order for this game is not available.',
  beyondOpening: 'This game is past the opening phase the book covers.',
  rateLimited: 'Too many opening look-ups. Try again shortly.',
  unavailable: 'Opening identification is unavailable right now.',
  activeGame: 'Opening identification is unavailable while you are playing a live human game.',
  rejected: 'This move sequence cannot be identified.',
  failed: 'Could not identify the opening.',
} as const;

/**
 * Render the result, returning the note that belongs beside it (or `null` when the rows say
 * everything). A `found: false` answer is the server declining to name an opening, so it produces
 * a message and no rows — never a nearest guess.
 */
export function renderOpeningResult(
  rows: HTMLElement,
  resultEl: HTMLElement,
  result: OpeningExplorationResponse,
): string | null {
  rows.innerHTML = '';
  if (!result.found) {
    resultEl.hidden = true;
    return OPENING_MESSAGES.noOpening;
  }

  const doc = rows.ownerDocument ?? document;
  if (result.name !== null) rows.appendChild(row(doc, 'Opening', result.name));
  if (result.eco !== null) rows.appendChild(row(doc, 'ECO', result.eco));
  rows.appendChild(row(doc, 'Book depth', plies(result.matchedMoves)));
  rows.appendChild(row(doc, 'Position', result.outOfBook ? 'Out of book' : 'In book'));
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
function plies(count: number): string {
  return `${count} ${count === 1 ? 'ply' : 'plies'}`;
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
