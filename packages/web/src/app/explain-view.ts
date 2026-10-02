/**
 * Rendering for the Move Explanation block in the game sidebar (ADR-0117).
 *
 * Design mode: **Operate** (`packages/web/DESIGN.md`) — a player is reading this with a game in
 * front of them, so scanability and staying out of the board's way outrank expression. The block
 * lives inside the existing Engine panel rather than becoming a second surface, and reuses the
 * shared `.panel-row` list treatment so an explanation's evidence reads exactly like an analysis
 * line.
 *
 * **Prose and evidence are separate elements, and the evidence comes first.** The engine fact is the
 * verifiable part and the sentence is an interpretation of it; putting the number above the
 * paragraph means the reader meets what is checkable before what is asserted. Nothing here ever
 * parses `explanation` to recover a fact — every number rendered comes from `citation`.
 */

import type { MoveExplanationResponse, MoveOutcome } from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';
import type { MessageKey } from '../i18n/catalog/index.js';

export const EXPLAIN_MESSAGE_KEYS = {
  idle: 'ai.explain.idle',
  noMove: 'ai.explain.noMove',
  signedOut: 'ai.explain.signedOut',
  running: 'ai.explain.running',
  rateLimited: 'ai.explain.rateLimited',
  unavailable: 'ai.explain.unavailable',
  activeGame: 'ai.explain.activeGame',
  rejected: 'ai.explain.rejected',
  failed: 'ai.explain.failed',
} as const satisfies Record<string, MessageKey>;

export type ExplainMessageKey = keyof typeof EXPLAIN_MESSAGE_KEYS;

export function explainMessage(key: ExplainMessageKey, i18n: I18nManager): string {
  return i18n.t(EXPLAIN_MESSAGE_KEYS[key]);
}

/** Human wording for a terminal result, from the structured reason — never from prose. */
export function describeOutcome(
  outcome: Extract<MoveOutcome, { kind: 'terminal' }>,
  i18n: I18nManager,
): string {
  const winner =
    outcome.result === '1-0' ? i18n.t('game.player.white') : outcome.result === '0-1' ? i18n.t('game.player.black') : null;
  switch (outcome.reason) {
    case 'checkmate':
      return winner ? i18n.t('ai.explain.outcome.checkmateWinner', { winner }) : i18n.t('ai.explain.outcome.checkmate');
    case 'stalemate':
      return i18n.t('ai.explain.outcome.stalemate');
    case 'insufficient_material':
      return i18n.t('ai.explain.outcome.insufficientMaterial');
    case 'fifty_move':
      return i18n.t('ai.explain.outcome.fiftyMove');
    case 'variant_win':
      return winner ? i18n.t('ai.explain.outcome.variantWinWinner', { winner }) : i18n.t('ai.explain.outcome.variantWin');
    case 'variant_draw':
      return i18n.t('ai.explain.outcome.variantDraw');
    default:
      // A reason this client does not know yet still has an authoritative result, so show that
      // rather than nothing. Falling back to an evaluation would be the original defect again.
      return i18n.t('ai.explain.outcome.gameOver', { result: outcome.result });
  }
}

/** What the move achieved, as a single scannable value. */
function outcomeLabel(outcome: MoveOutcome, i18n: I18nManager): string {
  return outcome.kind === 'terminal' ? describeOutcome(outcome, i18n) : outcome.evalLabel;
}

/**
 * Render the structured engine evidence: what the move achieved, and what the engine preferred.
 *
 * Two rows at most, and the second is omitted when the move *is* the engine's choice — a row saying
 * "best move: the move you just asked about" is noise, and the absence is itself the answer.
 */
export function renderEvidence(
  container: HTMLElement,
  result: MoveExplanationResponse,
  i18n: I18nManager,
): void {
  container.innerHTML = '';
  const doc = container.ownerDocument ?? document;
  const { citation } = result;

  container.appendChild(
    evidenceRow(doc, result.move, outcomeLabel(citation.moveOutcome, i18n)),
  );

  const playedTheBest = citation.bestMove !== null && citation.bestMove === result.move;
  if (!playedTheBest && citation.bestMove !== null) {
    container.appendChild(
      evidenceRow(doc, citation.bestMove, citation.evalLabel, i18n.t('ai.explain.enginePrefers')),
    );
  }
}

function evidenceRow(
  doc: Document,
  move: string,
  value: string,
  prefix?: string,
): HTMLElement {
  const row = doc.createElement('div');
  row.className = 'panel-row';

  const main = doc.createElement('div');
  main.className = 'row-main';

  const moveEl = doc.createElement('span');
  moveEl.className = 'explain-move';
  moveEl.textContent = prefix ? `${prefix} ${move}` : move;

  const valueEl = doc.createElement('span');
  valueEl.className = 'explain-value';
  valueEl.textContent = value;

  main.appendChild(moveEl);
  main.appendChild(valueEl);
  row.appendChild(main);
  return row;
}

/** The model's prose. Plain text only — never `innerHTML`, since this is third-party generated. */
export function renderProse(el: HTMLElement, result: MoveExplanationResponse): void {
  el.textContent = result.explanation;
}

/**
 * Attribution for the prose.
 *
 * Present because the paragraph above is machine-written and the reader is entitled to know that,
 * and to know it is a different kind of claim from the numbers above it. Provider and model are the
 * only provider-facing values the API returns; there is no usage or cost to show.
 */
export function renderSource(
  el: HTMLElement,
  result: MoveExplanationResponse,
  i18n: I18nManager,
): void {
  el.textContent = i18n.t('ai.generatedBy', { provider: result.providerId, model: result.model });
}

/** Show or hide the whole result group, and mark it busy while a request is in flight. */
export function setResultVisible(el: HTMLElement, visible: boolean): void {
  el.hidden = !visible;
}

/**
 * Busy state via `aria-busy` rather than a "Loading…" row.
 *
 * DESIGN.md forbids the placeholder row: it changes the list's length and then changes it back,
 * which moves everything below it twice for no information.
 */
export function setBusy(el: HTMLElement, busy: boolean): void {
  el.setAttribute('aria-busy', busy ? 'true' : 'false');
}

export function renderNote(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? '';
}

export function renderError(el: HTMLElement, text: string | null): void {
  if (text === null) {
    el.textContent = '';
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.hidden = false;
}

/** Clear every rendered part. Used on remount so a previous game's answer cannot survive. */
export function clearExplanation(parts: {
  readonly evidence: HTMLElement;
  readonly prose: HTMLElement;
  readonly source: HTMLElement;
  readonly result: HTMLElement;
}): void {
  parts.evidence.innerHTML = '';
  parts.prose.textContent = '';
  parts.source.textContent = '';
  parts.result.hidden = true;
}
