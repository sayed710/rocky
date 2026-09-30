/**
 * Rendering for the tournament commentary section (M15 inc 22, ADR-0130).
 *
 * One rule shapes this file: **the facts and the prose are never mixed.** The server keeps them in
 * separate fields precisely so a reader can tell a recorded result from a sentence a model wrote
 * about it, and a view that interleaved them would throw that distinction away at the last step.
 * So the results table, the standings and the engine citation render as data, the narrative renders
 * in its own block under a label that says what it is, and nothing here derives a fact from prose.
 *
 * The second rule follows from the first: **a gap in the narrative is shown, not hidden.** Byes,
 * voids and double forfeits reach the reader in the results but are withheld from the model, which
 * has no vocabulary for them. When that happens the recap covers fewer games than the round
 * contained, and `pairingsNarrated` is how the server says so — a UI that ignored it would present
 * a partial account as a complete one.
 */
import type {
  RoundRecapPairing,
  RoundRecapResult,
  TournamentGameCommentary,
  TournamentRoundRecap,
} from '../api/models.js';
import { isChessNotation, applyLtrIsolation, applyAutoDirection } from '../i18n/bidi.js';

export const COMMENTARY_MESSAGES = {
  idle: 'Ask for commentary on a finished game, or a recap of a completed round.',
  running: 'Writing commentary…',
  signedOut: 'Sign in for commentary.',
  rateLimited: 'Too many commentary requests. Try again shortly.',
  unavailable: 'Commentary is unavailable right now.',
  unsupportedVariant: 'Commentary is not available for this variant.',
  rejected: 'This game or round cannot be commentated.',
  notReady: 'That game is still being played, or that round is not finished yet.',
  failed: 'Could not write the commentary.',
  generated: 'Generated commentary',
  citation: 'Engine evaluation',
  partial: 'The narrative covers only the decided games in this round.',
} as const;

/** How the tournament's result vocabulary reads to a person. */
const RESULT_LABELS: Record<RoundRecapResult, string> = {
  white_win: '1-0',
  black_win: '0-1',
  draw: '½-½',
  double_forfeit: 'Both forfeited',
  bye: 'Bye',
  void: 'Void',
};

/**
 * The reader's wording for a tournament result.
 *
 * The same mapping the recap rows use. Rendering `commentary.tournamentResult` straight put an
 * internal token like `black_win` on screen beside recap rows that said `0-1` for the same thing —
 * one vocabulary shown two ways in one feature. Raised in the CodeRabbit review of PR #153.
 *
 * An unknown value falls through to itself rather than to a guess: a token this build does not
 * recognise is a server that knows something this client does not, and inventing a label for it
 * would be the client asserting a fact it does not have.
 *
 * @param result - the aggregate's recorded value.
 * @returns the label to show.
 */
function resultLabel(result: string): string {
  return RESULT_LABELS[result as RoundRecapResult] ?? result;
}

/**
 * Whether a game result and a tournament result describe the same outcome.
 *
 * The two vocabularies differ — the log speaks PGN, the aggregate speaks its own scoring terms —
 * so agreement is a mapping rather than an equality. Anything outside the mapping (a bye, a void,
 * a double forfeit) is by definition not what the game log said.
 *
 * @param gameResult - how the game ended.
 * @param tournamentResult - what the tournament recorded.
 * @returns whether they agree.
 */
function sameOutcome(gameResult: string, tournamentResult: string): boolean {
  if (tournamentResult === 'white_win') return gameResult === '1-0';
  if (tournamentResult === 'black_win') return gameResult === '0-1';
  if (tournamentResult === 'draw') return gameResult === '1/2-1/2';
  return false;
}

/**
 * Whether a pairing is one the narrator could describe.
 *
 * The same rule the server applies, and it must stay the same rule: this decides which rows are
 * counted against `pairingsNarrated` when explaining the gap to the reader.
 *
 * @param pairing - one row of the round.
 * @returns whether it is a played game with a stateable result.
 */
function isNarratable(pairing: RoundRecapPairing): boolean {
  if (pairing.black === null) return false;
  return pairing.result === 'white_win' || pairing.result === 'black_win' || pairing.result === 'draw';
}

/**
 * Render commentary on a finished game.
 *
 * @param doc - the owning document, a parameter so this works under the test double.
 * @param container - the element to fill; cleared first.
 * @param commentary - the server's answer.
 */
export function renderGameCommentary(
  doc: Document,
  container: HTMLElement,
  commentary: TournamentGameCommentary,
): void {
  container.innerHTML = '';

  const facts = section(doc, `Round ${String(commentary.round + 1)}`);
  facts.appendChild(row(doc, `${commentary.white} vs ${commentary.black}`, commentary.result));
  // Shown only when the tournament scored the game differently from the way it ended. Two true
  // statements about different things, and a reader seeing '1-0' beside a forfeit in the
  // standings deserves to be told which is which rather than left to reconcile them.
  if (commentary.tournamentResult !== null && !sameOutcome(commentary.result, commentary.tournamentResult)) {
    facts.appendChild(row(doc, 'Recorded by the tournament', resultLabel(commentary.tournamentResult)));
  }
  facts.appendChild(row(doc, 'Ended by', commentary.termination));
  facts.appendChild(row(doc, 'Final move', `${commentary.finalMove.san} (${commentary.finalMove.uci})`));
  facts.appendChild(row(doc, 'Moves played', String(commentary.ply)));
  container.appendChild(facts);

  // The citation is a measurement, so it is labelled as one and carries the depth it was measured
  // at. The server refuses to publish a citation with no search behind it, so a depth shown here is
  // always a depth something actually reached.
  const citation = section(doc, COMMENTARY_MESSAGES.citation);
  citation.appendChild(row(doc, 'Evaluation', commentary.citation.evalLabel));
  citation.appendChild(row(doc, 'Depth', String(commentary.citation.depth)));
  if (commentary.citation.bestLine.length > 0) {
    citation.appendChild(row(doc, 'Best line', commentary.citation.bestLine.join(' ')));
  }
  container.appendChild(citation);

  container.appendChild(narrative(doc, commentary.commentary));
}

/**
 * Render a round recap.
 *
 * @param doc - the owning document, a parameter so this works under the test double.
 * @param container - the element to fill; cleared first.
 * @param recap - the server's answer.
 */
export function renderRoundRecap(
  doc: Document,
  container: HTMLElement,
  recap: TournamentRoundRecap,
): void {
  container.innerHTML = '';

  const results = section(doc, `Round ${String(recap.round + 1)} results`);
  for (const pairing of recap.results) {
    const opponent = pairing.black === null ? '—' : pairing.black;
    results.appendChild(
      // Through `resultLabel`, not straight into the table: the union makes the index total at
      // compile time only, and a server ahead of this build can still send a token it does not know.
      // Indexing directly rendered that as empty text here while the commentary above rendered it as
      // itself — one value, two behaviours. Raised in the CodeRabbit review of PR #153.
      row(doc, `${pairing.white} vs ${opponent}`, resultLabel(pairing.result)),
    );
  }
  container.appendChild(results);

  const standings = section(doc, `Standings after round ${String(recap.round + 1)}`);
  for (const standing of recap.standings) {
    standings.appendChild(
      row(doc, `${String(standing.rank)}. ${standing.player}`, String(standing.points)),
    );
  }
  container.appendChild(standings);

  container.appendChild(narrative(doc, recap.narrative));

  // Counted from the rows rather than trusted from the field alone: the note is about what the
  // reader can see, so it appears exactly when the table in front of them holds a pairing the prose
  // below it could not have mentioned.
  const narratable = recap.results.filter(isNarratable).length;
  if (recap.pairingsNarrated < recap.results.length || narratable < recap.results.length) {
    const note = doc.createElement('p');
    note.className = 'commentary-partial';
    note.textContent = COMMENTARY_MESSAGES.partial;
    container.appendChild(note);
  }
}

/**
 * The generated prose, in its own block and labelled as generated.
 *
 * Set with `textContent`, so nothing a model wrote can become markup, and kept apart from every
 * fact above it so a reader is never asked to guess which is which.
 *
 * @param doc - the owning document.
 * @param text - the model's prose.
 * @returns the block, unattached.
 */
function narrative(doc: Document, text: string): HTMLElement {
  const block = doc.createElement('div');
  block.className = 'commentary-narrative';
  const label = doc.createElement('h3');
  label.className = 'commentary-section-title';
  label.textContent = COMMENTARY_MESSAGES.generated;
  const prose = doc.createElement('p');
  prose.className = 'commentary-prose';
  prose.setAttribute('dir', 'auto');
  prose.textContent = text;
  block.appendChild(label);
  block.appendChild(prose);
  return block;
}

/**
 * @param doc - the owning document.
 * @param titleText - the heading.
 * @returns an empty titled block, unattached.
 */
function section(doc: Document, titleText: string): HTMLElement {
  const block = doc.createElement('div');
  block.className = 'commentary-section';
  const title = doc.createElement('h3');
  title.className = 'commentary-section-title';
  title.textContent = titleText;
  block.appendChild(title);
  return block;
}

/**
 * One label/value row in the shared panel language.
 *
 * @param doc - the owning document.
 * @param labelText - the left column.
 * @param valueText - the right column, set as text so nothing from the server can be markup.
 * @returns the row, unattached.
 */
function row(doc: Document, labelText: string, valueText: string): HTMLElement {
  const item = doc.createElement('div');
  item.className = 'panel-row';
  const label = doc.createElement('span');
  label.className = 'commentary-label';
  label.textContent = labelText;
  applyAutoDirection(label);
  const value = doc.createElement('span');
  value.className = 'commentary-value';
  value.textContent = valueText;
  if (isChessNotation(valueText)) {
    applyLtrIsolation(value);
  }
  item.appendChild(label);
  item.appendChild(value);
  return item;
}
