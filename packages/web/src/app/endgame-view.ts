/**
 * Rendering for the endgame trainer (M15 inc 20, ADR-0128).
 *
 * Two things this file must never do. It must not show the learner the solution before they have
 * attempted the position — `/next` does not send one, and nothing here may derive one. And it must
 * not render a decided game as an evaluation: a move that ends the game arrives as the `terminal`
 * branch, which has a result and no score (ADR-0116).
 */
import type {
  EndgameAttemptResult,
  EndgamePosition,
} from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';
import { applyAutoDirection, applyLtrIsolation } from '../i18n/bidi.js';
import { mountBoard } from './board.js';

export const ENDGAME_MESSAGES = {
  idle: 'Pick a training endgame to begin.',
  loading: 'Loading a training position…',
  judging: 'Checking your move…',
  signedOut: 'Sign in to train endgames.',
  unavailable: 'Endgame training is unavailable right now.',
  rateLimited: 'Too many attempts. Try again shortly.',
  rejected: 'That move cannot be played in this position.',
  failed: 'Could not load the endgame trainer.',
  noMatch: 'No training position matches those filters.',
  yourMove: 'Play the move you think is best.',
} as const;

export function getEndgameMessage(key: keyof typeof ENDGAME_MESSAGES, i18n?: I18nManager): string {
  if (!i18n) return ENDGAME_MESSAGES[key];
  switch (key) {
    case 'idle': return i18n.t('learning.endgames.msgIdle');
    case 'loading': return i18n.t('learning.endgames.msgLoading');
    case 'judging': return i18n.t('learning.endgames.msgJudging');
    case 'signedOut': return i18n.t('learning.endgames.msgSignedOut');
    case 'unavailable': return i18n.t('learning.endgames.msgUnavailable');
    case 'rateLimited': return i18n.t('learning.endgames.msgRateLimited');
    case 'rejected': return i18n.t('learning.endgames.msgRejected');
    case 'failed': return i18n.t('learning.endgames.msgFailed');
    case 'noMatch': return i18n.t('learning.endgames.msgNoMatch');
    case 'yourMove': return i18n.t('learning.endgames.msgYourMove');
  }
}

/** Objective wording the learner reads, kept out of the render functions so it stays consistent. */
const OBJECTIVE_LABEL: Record<EndgamePosition['objective'], string> = {
  mate: 'Deliver checkmate',
  win: 'Win the position',
  draw: 'Hold the draw',
};

const CLASSIFICATION_LABEL: Record<EndgameAttemptResult['classification'], string> = {
  optimal: 'Best move',
  acceptable: 'Playable, but not best',
  throws_result: 'Throws the result away',
};

export function renderEndgamePositionRows(
  doc: Document,
  rows: HTMLElement,
  position: EndgamePosition,
  i18n?: I18nManager,
): void {
  rows.innerHTML = '';
  rows.appendChild(row(doc, i18n?.t('learning.endgames.rowEndgame') ?? 'Endgame', position.name, 'auto'));

  const objLabel = position.objective === 'mate'
    ? (i18n?.t('learning.endgames.deliverCheckmate') ?? OBJECTIVE_LABEL['mate'])
    : position.objective === 'win'
      ? (i18n?.t('learning.endgames.winPosition') ?? OBJECTIVE_LABEL['win'])
      : (i18n?.t('learning.endgames.holdDraw') ?? OBJECTIVE_LABEL['draw']);
  rows.appendChild(row(doc, i18n?.t('learning.endgames.rowObjective') ?? 'Objective', objLabel));

  const turnLabel = position.sideToMove === 'w'
    ? (i18n?.t('learning.endgames.rowWhite') ?? 'White')
    : (i18n?.t('learning.endgames.rowBlack') ?? 'Black');
  rows.appendChild(row(doc, i18n?.t('learning.endgames.rowToMove') ?? 'To move', turnLabel));

  rows.appendChild(row(doc, i18n?.t('learning.endgames.rowLevel') ?? 'Level', position.difficulty));
  if (position.technique) {
    rows.appendChild(row(doc, i18n?.t('learning.endgames.rowTechnique') ?? 'Technique', position.technique, 'auto'));
  }
}

/**
 * Render the training position: the board, the objective, and nothing else.
 *
 * No solution, no evaluation, no "mate in N" — the server sends none of it, and inventing any of it
 * here would defeat the exercise (ADR-0095).
 *
 * @param doc - the owning document.
 * @param boardEl - the element the read-only board mounts into.
 * @param rows - the container for the position's descriptive rows.
 * @param position - what the server selected.
 * @param i18n - optional i18n manager for localization.
 * @returns the mounted board, so the caller can tear it down before mounting the next one.
 */
export function renderEndgamePosition(
  doc: Document,
  boardEl: HTMLElement,
  rows: HTMLElement,
  position: EndgamePosition,
  i18n?: I18nManager,
): { dispose: () => void } {
  const board = mountBoard({ boardEl });
  board.setTurn(false);
  board.setPosition(position.fen);

  renderEndgamePositionRows(doc, rows, position, i18n);
  return board;
}

/**
 * Render the verdict on an attempted move.
 *
 * @returns the note to display beside the rows, or `null` when the rows say it all.
 */
export function renderEndgameVerdict(
  doc: Document,
  rows: HTMLElement,
  resultEl: HTMLElement,
  result: EndgameAttemptResult,
  i18n?: I18nManager,
): string | null {
  rows.innerHTML = '';
  rows.appendChild(row(doc, i18n?.t('learning.endgames.rowYourMove') ?? 'Your move', result.move, 'ltr'));

  const verdictLabel = result.classification === 'optimal'
    ? (i18n?.t('learning.endgames.bestMove') ?? CLASSIFICATION_LABEL['optimal'])
    : result.classification === 'acceptable'
      ? (i18n?.t('learning.endgames.playableNotBest') ?? CLASSIFICATION_LABEL['acceptable'])
      : (i18n?.t('learning.endgames.throwsResult') ?? CLASSIFICATION_LABEL['throws_result']);
  rows.appendChild(row(doc, i18n?.t('learning.endgames.rowVerdict') ?? 'Verdict', verdictLabel));

  const goalLabel = result.goalPreserved
    ? (i18n?.t('learning.endgames.stillAlive') ?? 'Still alive')
    : (i18n?.t('learning.endgames.lost') ?? 'Lost');
  rows.appendChild(row(doc, i18n?.t('learning.endgames.rowGoal') ?? 'Goal', goalLabel));

  if (result.kind === 'terminal') {
    // A decided game has a result, not a score. Rendering an evaluation here — even a zero — would
    // describe a finished position as an equal one.
    rows.appendChild(row(doc, i18n?.t('learning.endgames.rowGame') ?? 'Game', terminalLabel(result.terminal.reason, result.terminal.result), 'ltr'));
    resultEl.hidden = false;
    return null;
  }

  rows.appendChild(row(doc, i18n?.t('learning.endgames.rowBefore') ?? 'Before', evaluationLabel(result.evalBefore, i18n), 'ltr'));
  rows.appendChild(row(doc, i18n?.t('learning.endgames.rowAfter') ?? 'After', evaluationLabel(result.evalAfter, i18n), 'ltr'));
  rows.appendChild(row(doc, i18n?.t('learning.endgames.rowCost') ?? 'Cost', lossLabel(result, i18n)));

  if (result.betterMove !== null) {
    rows.appendChild(row(doc, i18n?.t('learning.endgames.rowEnginePrefers') ?? 'Engine prefers', result.betterMove, 'ltr'));
  }

  if (result.bestLine.length > 0) {
    rows.appendChild(row(doc, i18n?.t('learning.endgames.rowLine') ?? 'Line', result.bestLine.join(' '), 'ltr'));
  }

  rows.appendChild(row(doc, i18n?.t('learning.endgames.rowDepth') ?? 'Depth', String(result.depth), 'ltr'));

  resultEl.hidden = false;
  return null;
}

/**
 * Empty the verdict back to its unanswered state.
 *
 * @param rows - the verdict rows to clear.
 * @param resultEl - the result group to hide and mark not-busy.
 */
export function clearEndgame(rows: HTMLElement, resultEl: HTMLElement): void {
  rows.innerHTML = '';
  resultEl.hidden = true;
  resultEl.setAttribute('aria-busy', 'false');
}

/**
 * @param resultEl - the result group.
 * @param busy - whether work is in flight. Announced through `aria-busy` so a screen reader knows
 * the region is about to change rather than reading the previous verdict as current.
 */
export function setEndgameBusy(resultEl: HTMLElement, busy: boolean): void {
  resultEl.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/**
 * @param el - the note element, a polite live region.
 * @param text - the note, or `null` to hide it. Hidden rather than blanked so an empty line does
 * not sit in the layout.
 */
export function renderEndgameNote(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? '';
  el.hidden = text === null;
}

/**
 * @param el - the error element, an assertive live region.
 * @param text - the message, or `null` to clear it.
 */
export function renderEndgameError(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? '';
  el.hidden = text === null;
}

/** `{kind:'decisive'}` has no number to show, and must not be given one. */
function lossLabel(result: Extract<EndgameAttemptResult, { kind: 'judged' }>, i18n?: I18nManager): string {
  if (result.loss.kind === 'decisive') {
    return i18n?.t('learning.endgames.costDecisive') ?? 'Decisive — the goal is gone';
  }
  const pawns = result.loss.value / 100;
  if (pawns === 0) {
    return i18n?.t('learning.endgames.costNothing') ?? 'Nothing';
  }
  return i18n?.t('learning.endgames.costPawns', { pawns: pawns.toFixed(2) }) ?? `${pawns.toFixed(2)} pawns`;
}

/**
 * @param evaluation - an engine evaluation from the mover's perspective.
 * @returns it in the reader's terms — a mate distance, or pawns to two places. A mate is never
 * rendered as a number of pawns, because it is not one.
 */
function evaluationLabel(
  evaluation: { readonly type: 'cp' | 'mate'; readonly value: number },
  i18n?: I18nManager,
): string {
  if (evaluation.type === 'mate') {
    if (evaluation.value >= 0) {
      return i18n?.t('learning.endgames.evalMate', { count: String(evaluation.value) }) ?? `Mate in ${evaluation.value}`;
    }
    return i18n?.t('learning.endgames.evalMated', { count: String(Math.abs(evaluation.value)) }) ?? `Mated in ${Math.abs(evaluation.value)}`;
  }
  const pawns = evaluation.value / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

/**
 * @param reason - why the game ended, in the server's vocabulary.
 * @param result - the score.
 * @returns the pair as one readable phrase.
 */
function terminalLabel(reason: string, result: string): string {
  return `${reason.replaceAll('_', ' ')} · ${result}`;
}

/**
 * One label/value row in the shared panel language.
 *
 * @param doc - the owning document, a parameter so this works under the test double.
 * @param labelText - the left column.
 * @param valueText - the right column, set as text so nothing from the server can be markup.
 * @returns the row, unattached.
 */
function row(
  doc: Document,
  labelText: string,
  valueText: string,
  isolate: 'auto' | 'ltr' | 'none' = 'none',
): HTMLElement {
  const item = doc.createElement('div');
  item.className = 'panel-row';
  const label = doc.createElement('span');
  label.className = 'endgame-label';
  label.textContent = labelText;
  const value = doc.createElement('span');
  value.className = 'endgame-value';
  value.textContent = valueText;
  if (isolate === 'auto') {
    applyAutoDirection(value);
  } else if (isolate === 'ltr') {
    applyLtrIsolation(value);
  }
  item.appendChild(label);
  item.appendChild(value);
  return item;
}
