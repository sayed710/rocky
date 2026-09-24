/**
 * Rendering for the coaching sidebar section (M15 inc 21, ADR-0129).
 *
 * Five sections, each either an answer or a reason there is none. Two rules this file exists to
 * keep:
 *
 * **An empty section says why it is empty.** The server distinguishes five reasons and this renders
 * four of them differently, because "this server does not do tactics", "the engine is down" and
 * "there is no tactic here" are three different things to tell a reader and only the middle one is
 * worth waiting out. The two that render as nothing at all — `not_requested` and `cancelled` —
 * describe the reader's own request rather than the position, so a row for them would be noise.
 *
 * **Nothing here derives an answer the server withheld.** The puzzle section says a tactic is
 * present and how hard it is, and cannot say more, because the response carries no solution
 * (ADR-0129 §3). The endgame section names the position and its objective, and carries no solution
 * or evaluation for the same reason (ADR-0095). Neither should ever grow a "show me" affordance
 * that implies one is a request away.
 */
import type {
  CoachOmissionReason,
  CoachPuzzle,
  CoachResponse,
  CoachSection,
  EndgamePosition,
  MistakePredictionResponse,
  MoveExplanationResponse,
  OpeningContinuationView,
  OpeningExplorationResponse,
} from '../api/models.js';
import {
  classificationLabel,
  describeMoveOutcome,
  lossLabel,
} from './assess-view.js';

export const COACH_MESSAGES = {
  idle: 'Get coaching advice for the current position.',
  running: 'Coaching position…',
  positionChanged: 'Position changed. Ask coach again.',
  signedOut: 'Sign in for coaching.',
  rateLimited: 'Too many coaching requests. Try again shortly.',
  unavailable: 'Coaching is unavailable right now.',
  activeGame: 'Coaching is unavailable while you are playing a live human game.',
  unsupportedVariant: 'Coaching is not available for this variant.',
  rejected: 'This position cannot be coached.',
  failed: 'Could not coach the position.',
  noMove: 'Play or select a move to receive move-specific coaching.',
  noSections: 'No coaching advice available for this position.',
  // Omission reason human wording
  notApplicable: 'Nothing to say here',
  unsupported: 'Not available on this server',
  temporarilyUnavailable: 'Temporarily unavailable',
} as const;

/**
 * @param reason - why a section is empty.
 * @returns the wording to show, or `null` when the section should not appear at all.
 *
 * `not_requested` and `cancelled` return `null` deliberately: the first means the reader did not
 * ask this question, the second that they stopped waiting for it. Neither is news about the
 * position, and a row explaining either would push the sections that *are* answers further down.
 */
export function omissionReasonLabel(reason: CoachOmissionReason): string | null {
  switch (reason) {
    case 'not_requested':
    case 'cancelled':
      return null;
    case 'not_applicable':
      return COACH_MESSAGES.notApplicable;
    case 'unsupported':
      return COACH_MESSAGES.unsupported;
    case 'unavailable':
      return COACH_MESSAGES.temporarilyUnavailable;
  }
}

/**
 * Render the full coaching result into the container.
 *
 * @returns an informational note if all sections were quiet/omitted, or `null`.
 */
export function renderCoachResult(
  container: HTMLElement,
  resultEl: HTMLElement,
  result: CoachResponse,
): string | null {
  container.innerHTML = '';
  const doc = container.ownerDocument ?? document;
  let renderedCount = 0;

  // 1. Mistake Prediction
  if (renderMistakeSection(doc, container, result.mistake)) {
    renderedCount += 1;
  }

  // 2. Move Explanation
  if (renderExplanationSection(doc, container, result.explanation)) {
    renderedCount += 1;
  }

  // 3. Opening Exploration
  if (renderOpeningSection(doc, container, result.opening)) {
    renderedCount += 1;
  }

  // 4. Puzzle Detection (Tactic)
  if (renderPuzzleSection(doc, container, result.puzzle)) {
    renderedCount += 1;
  }

  // 5. Endgame Identification
  if (renderEndgameSection(doc, container, result.endgame)) {
    renderedCount += 1;
  }

  resultEl.hidden = false;
  return renderedCount === 0 ? COACH_MESSAGES.noSections : null;
}

/**
 * Render the move assessment section.
 *
 * @param doc - the owning document, a parameter so this works under the test double.
 * @param container - the rows container to append into.
 * @param section - the section, present or omitted.
 * @returns whether anything was appended.
 */
function renderMistakeSection(
  doc: Document,
  container: HTMLElement,
  section: CoachSection<MistakePredictionResponse>,
): boolean {
  if (section.kind === 'omitted') {
    const label = omissionReasonLabel(section.reason);
    if (!label) return false;
    const block = createSectionBlock(doc, 'Move assessment');
    block.appendChild(omittedRow(doc, label));
    container.appendChild(block);
    return true;
  }

  const outcome = section.value;
  const block = createSectionBlock(doc, 'Move assessment');
  block.appendChild(row(doc, classificationLabel(outcome.classification), lossLabel(outcome.centipawnLoss), 'assess-verdict'));
  block.appendChild(row(doc, outcome.move, describeMoveOutcome(outcome.after)));

  const playedTheBest = outcome.bestMove !== null && outcome.bestMove === outcome.move;
  if (!playedTheBest && outcome.bestMove !== null) {
    block.appendChild(row(doc, `Engine prefers ${outcome.bestMove}`, outcome.before.evalLabel));
  }

  container.appendChild(block);
  return true;
}

/**
 * Render the engine explanation section.
 *
 * @param doc - the owning document, a parameter so this works under the test double.
 * @param container - the rows container to append into.
 * @param section - the section, present or omitted.
 * @returns whether anything was appended.
 */
function renderExplanationSection(
  doc: Document,
  container: HTMLElement,
  section: CoachSection<MoveExplanationResponse>,
): boolean {
  if (section.kind === 'omitted') {
    const label = omissionReasonLabel(section.reason);
    if (!label) return false;
    const block = createSectionBlock(doc, 'Move explanation');
    block.appendChild(omittedRow(doc, label));
    container.appendChild(block);
    return true;
  }

  const explanation = section.value;
  const block = createSectionBlock(doc, 'Move explanation');

  const prose = doc.createElement('p');
  prose.className = 'coach-prose';
  prose.textContent = explanation.explanation;
  block.appendChild(prose);

  const { citation } = explanation;
  const citationMoveOutcome =
    citation.moveOutcome.kind === 'terminal'
      ? `Game over — ${citation.moveOutcome.result}`
      : citation.moveOutcome.evalLabel;

  block.appendChild(row(doc, explanation.move, citationMoveOutcome));

  const playedTheBest = citation.bestMove !== null && citation.bestMove === explanation.move;
  if (!playedTheBest && citation.bestMove !== null) {
    block.appendChild(row(doc, `Engine prefers ${citation.bestMove}`, citation.evalLabel));
  }

  const source = doc.createElement('p');
  source.className = 'count';
  source.textContent = `Generated by ${explanation.providerId} · ${explanation.model}`;
  block.appendChild(source);

  container.appendChild(block);
  return true;
}

/**
 * Render the opening identification section.
 *
 * @param doc - the owning document, a parameter so this works under the test double.
 * @param container - the rows container to append into.
 * @param section - the section, present or omitted.
 * @returns whether anything was appended.
 */
function renderOpeningSection(
  doc: Document,
  container: HTMLElement,
  section: CoachSection<OpeningExplorationResponse>,
): boolean {
  if (section.kind === 'omitted') {
    const label = omissionReasonLabel(section.reason);
    if (!label) return false;
    const block = createSectionBlock(doc, 'Opening');
    block.appendChild(omittedRow(doc, label));
    container.appendChild(block);
    return true;
  }

  const opening = section.value;
  const block = createSectionBlock(doc, 'Opening');

  if (opening.name !== null) block.appendChild(row(doc, 'Opening', opening.name));
  if (opening.eco !== null) block.appendChild(row(doc, 'ECO', opening.eco));
  block.appendChild(row(doc, 'Book depth', `${opening.matchedMoves} ${opening.matchedMoves === 1 ? 'ply' : 'plies'}`));
  block.appendChild(row(doc, 'Position', opening.outOfBook ? 'Out of book' : 'In book'));

  for (const continuation of opening.continuations) {
    block.appendChild(row(doc, continuationLabel(continuation), continuationName(continuation)));
  }

  container.appendChild(block);
  return true;
}

/**
 * Render the tactic section.
 *
 * @param doc - the owning document, a parameter so this works under the test double.
 * @param container - the rows container to append into.
 * @param section - the section, present or omitted.
 * @returns whether anything was appended.
 *
 * Renders presence and difficulty only. The response carries no solution and this must never imply one is a click away.
 */
function renderPuzzleSection(
  doc: Document,
  container: HTMLElement,
  section: CoachSection<CoachPuzzle>,
): boolean {
  if (section.kind === 'omitted') {
    const label = omissionReasonLabel(section.reason);
    if (!label) return false;
    const block = createSectionBlock(doc, 'Tactic');
    block.appendChild(omittedRow(doc, label));
    container.appendChild(block);
    return true;
  }

  // Presence and difficulty, and there is nothing else to render: `CoachPuzzle` has four fields
  // and none of them is a solution. This is the prompt — "there is something here, go and find it"
  // — and adding the move would make it the answer instead.
  const puzzle = section.value;
  const block = createSectionBlock(doc, 'Tactic');
  block.appendChild(row(doc, 'Tactic', 'Present'));
  block.appendChild(row(doc, 'Difficulty', capitalize(puzzle.difficulty)));

  container.appendChild(block);
  return true;
}

/**
 * Render the endgame identification section.
 *
 * @param doc - the owning document, a parameter so this works under the test double.
 * @param container - the rows container to append into.
 * @param section - the section, present or omitted.
 * @returns whether anything was appended.
 *
 * Name, objective, technique and difficulty — the field list `/v1/endgames/next` publishes. No solution, no evaluation.
 */
function renderEndgameSection(
  doc: Document,
  container: HTMLElement,
  section: CoachSection<EndgamePosition>,
): boolean {
  if (section.kind === 'omitted') {
    const label = omissionReasonLabel(section.reason);
    if (!label) return false;
    const block = createSectionBlock(doc, 'Endgame');
    block.appendChild(omittedRow(doc, label));
    container.appendChild(block);
    return true;
  }

  // Name, objective, technique, difficulty — the exact field list `/v1/endgames/next` publishes,
  // because the server hands this section that endpoint's own view. No solution and no evaluation:
  // a reader who recognises they are in the Lucena position should be told that and left to play it.
  const endgame = section.value;
  const block = createSectionBlock(doc, 'Endgame');
  block.appendChild(row(doc, 'Position', endgame.name));
  block.appendChild(row(doc, 'Objective', capitalize(endgame.objective)));
  if (endgame.technique !== null) {
    block.appendChild(row(doc, 'Technique', endgame.technique));
  }
  block.appendChild(row(doc, 'Difficulty', capitalize(endgame.difficulty)));

  container.appendChild(block);
  return true;
}

/**
 * Empty the section back to its unasked state.
 *
 * @param rows - the rows to clear.
 * @param result - the result group to hide and mark not-busy.
 */
export function clearCoach(rows: HTMLElement, result: HTMLElement): void {
  rows.innerHTML = '';
  result.hidden = true;
  result.setAttribute('aria-busy', 'false');
}

/**
 * @param result - the result group.
 * @param busy - whether work is in flight. Announced through `aria-busy` so a screen reader knows
 * the region is about to change rather than reading the previous answer as current.
 */
export function setCoachBusy(result: HTMLElement, busy: boolean): void {
  result.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/**
 * @param el - the note element, a polite live region.
 * @param text - the note, or `null` to hide it. Hidden rather than blanked so an empty line does
 * not sit in the layout.
 */
export function renderCoachNote(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? '';
  el.hidden = text === null;
}

/**
 * @param el - the error element, an assertive live region.
 * @param text - the message, or `null` to clear it.
 */
export function renderCoachError(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? '';
  el.hidden = text === null;
}

/**
 * @param doc - the owning document.
 * @param titleText - the section heading.
 * @returns an empty section block carrying its title, unattached.
 */
function createSectionBlock(doc: Document, titleText: string): HTMLElement {
  const section = doc.createElement('div');
  section.className = 'coach-section';
  const title = doc.createElement('h3');
  title.className = 'coach-section-title';
  title.textContent = titleText;
  section.appendChild(title);
  return section;
}

/**
 * One label/value row in the shared panel language.
 *
 * @param doc - the owning document, a parameter so this works under the test double.
 * @param labelText - the left column.
 * @param valueText - the right column, set as text so nothing from the server can be markup.
 * @param extraClass - an optional modifier on the label.
 * @returns the row, unattached.
 */
function row(doc: Document, labelText: string, valueText: string, extraClass?: string): HTMLElement {
  const item = doc.createElement('div');
  item.className = 'panel-row';
  const label = doc.createElement('span');
  label.className = extraClass ? `coach-label ${extraClass}` : 'coach-label';
  label.textContent = labelText;
  const value = doc.createElement('span');
  value.className = 'coach-value';
  value.textContent = valueText;
  item.appendChild(label);
  item.appendChild(value);
  return item;
}

/**
 * @param doc - the owning document.
 * @param text - the wording for why the section is empty.
 * @returns a single-cell row, styled apart from an answer so it cannot be mistaken for one.
 */
function omittedRow(doc: Document, text: string): HTMLElement {
  const item = doc.createElement('div');
  item.className = 'panel-row';
  const textEl = doc.createElement('span');
  textEl.className = 'coach-omitted';
  textEl.textContent = text;
  item.appendChild(textEl);
  return item;
}

/**
 * @param c - a continuation from the opening book.
 * @returns its SAN where the dataset has one, and the UCI otherwise — never a blank.
 */
function continuationLabel(c: OpeningContinuationView): string {
  return c.san ?? c.move;
}

/**
 * @param c - a continuation from the opening book.
 * @returns the opening it leads to: its name, its ECO code, or an empty string when the dataset
 * carries neither. Not every continuation is itself a named opening.
 */
function continuationName(c: OpeningContinuationView): string {
  return c.name ?? c.eco ?? '';
}

/**
 * @param str - a lower-case token from the server, such as `win` or `hard`.
 * @returns it with an initial capital, for reading as a label rather than as a wire value.
 */
function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
