/**
 * Rendering for the Assess-last-move block in the game sidebar (ADR-0118).
 *
 * Design mode: **Operate** (`packages/web/DESIGN.md`) — a player is reading this with a game in
 * front of them, so scanability and staying out of the board's way outrank expression. Like the
 * explain block, this lives inside the existing Engine panel rather than becoming a third surface,
 * and reuses the shared `.panel-row` treatment so a verdict reads exactly like an analysis line.
 *
 * **There is no prose here at all.** Every value on screen comes from a structured field of the
 * response: the classification, both evaluations, the centipawn loss, the terminal result and the
 * engine's preferred move. Nothing is parsed out of a sentence, because no sentence is fetched —
 * this feature makes no provider call (ADR-0118). "Explain last move" sits directly above and is
 * where prose belongs.
 *
 * **The classification is a word, never a colour.** DESIGN.md settles this: achievement tiers are
 * rendered as `bronze`/`silver`/`gold` in the muted voice rather than as three metals, because a
 * system with one accent cannot grow a second, third and fourth, and meaning encoded in hue alone
 * fails colourblind readers. `ok`/`inaccuracy`/`mistake`/`blunder` is the same shape of problem and
 * takes the same answer. In particular a blunder is **not** painted in Ember: Ember is reserved for
 * error and danger — something has gone wrong with the *application* — and a blunder is data the
 * player asked for, not a failure of the page.
 */

import type { MistakeMoveOutcome, MistakePredictionResponse } from '../api/models.js';

export const ASSESS_MESSAGES = {
  idle: 'Assess the last move played.',
  noMove: 'No move to assess yet.',
  signedOut: 'Sign in to assess moves.',
  running: 'Assessing…',
  rateLimited: 'Too many assessments. Try again shortly.',
  unavailable: 'Move assessment is unavailable right now.',
  activeGame: 'Move assessment is unavailable while you are playing a live human game.',
  rejected: 'This position cannot be assessed.',
  failed: 'Could not assess the move.',
} as const;

/** The word the player reads. Capitalised because it is a label, not a sentence. */
export function classificationLabel(classification: MistakePredictionResponse['classification']): string {
  switch (classification) {
    case 'ok':
      return 'Good move';
    case 'inaccuracy':
      return 'Inaccuracy';
    case 'mistake':
      return 'Mistake';
    case 'blunder':
      return 'Blunder';
    default:
      // An unknown classification from a newer server is shown as itself rather than swallowed: the
      // server said something, and inventing a friendlier word for it would be a guess.
      return classification;
  }
}

/** Human wording for a terminal result, from the structured reason — never from prose. */
export function describeMoveOutcome(outcome: MistakeMoveOutcome): string {
  if (outcome.kind === 'evaluation') return outcome.evalLabel;
  // The server sends a label built where the result vocabulary lives, so it is used as given. It is
  // never reconstructed from `reason` here — that would be a second wording free to disagree.
  return outcome.label;
}

/**
 * What the move cost, as a signed pawn figure — or an em dash when nothing was measured.
 *
 * Rendered as a negative number because it is a loss: a 150 cp loss reads `−1.50`, in the same
 * tabular column and the same sign convention as the evaluations above it. A *negative* loss means
 * the move improved on the engine's own line, so it reads as a gain and keeps its sign.
 *
 * `null` becomes `—` rather than `0.00`. Zero is a measurement; the em dash is the absence of one,
 * and the whole point of a nullable loss is that a won game and a forced mate have no centipawn
 * value to report (ADR-0118).
 */
export function lossLabel(centipawnLoss: number | null): string {
  if (centipawnLoss === null) return '—';
  const pawns = -centipawnLoss / 100;
  // `Object.is` keeps `-0` from rendering as `−0.00`, which reads as a tiny loss rather than none.
  const normalised = Object.is(pawns, -0) ? 0 : pawns;
  return normalised >= 0 ? `+${normalised.toFixed(2)}` : normalised.toFixed(2);
}

/**
 * Render the verdict.
 *
 * Three rows at most, in the order the reader needs them: what the move was, what it achieved, and
 * what the engine would have played. The third is omitted when the player found the engine's own
 * move — a row saying "the engine prefers the move you just played" is noise, and its absence is
 * itself the answer.
 */
export function renderVerdict(container: HTMLElement, result: MistakePredictionResponse): void {
  container.innerHTML = '';
  const doc = container.ownerDocument ?? document;

  container.appendChild(
    row(doc, classificationLabel(result.classification), lossLabel(result.centipawnLoss), 'assess-verdict'),
  );
  container.appendChild(row(doc, result.move, describeMoveOutcome(result.after)));

  const playedTheBest = result.bestMove !== null && result.bestMove === result.move;
  if (!playedTheBest && result.bestMove !== null) {
    container.appendChild(row(doc, `Engine prefers ${result.bestMove}`, result.before.evalLabel));
  }
}

function row(doc: Document, main: string, value: string, extraClass?: string): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'panel-row';

  const line = doc.createElement('div');
  line.className = 'row-main';

  const label = doc.createElement('span');
  label.className = extraClass ? `assess-move ${extraClass}` : 'assess-move';
  label.textContent = main;

  const figure = doc.createElement('span');
  figure.className = 'assess-value';
  figure.textContent = value;

  line.appendChild(label);
  line.appendChild(figure);
  el.appendChild(line);
  return el;
}

/** Show or hide the whole result group. */
export function setVerdictVisible(el: HTMLElement, visible: boolean): void {
  el.hidden = !visible;
}

/**
 * Busy state via `aria-busy` rather than a "Loading…" row.
 *
 * DESIGN.md forbids the placeholder row: it changes the list's length and then changes it back,
 * which moves everything below it twice for no information.
 */
export function setAssessBusy(el: HTMLElement, busy: boolean): void {
  el.setAttribute('aria-busy', busy ? 'true' : 'false');
}

export function renderAssessNote(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? '';
}

export function renderAssessError(el: HTMLElement, text: string | null): void {
  if (text === null) {
    el.textContent = '';
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.hidden = false;
}

/** Clear every rendered part. Used on remount so a previous game's verdict cannot survive. */
export function clearVerdict(parts: {
  readonly rows: HTMLElement;
  readonly result: HTMLElement;
}): void {
  parts.rows.innerHTML = '';
  parts.result.hidden = true;
}
