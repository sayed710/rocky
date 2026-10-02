/**
 * The tournament commentary section: what it renders, and what it must never let a reader confuse.
 *
 * Two properties are worth the file. The first is that facts and prose stay apart — a reader looking
 * at a result, a standing or an engine evaluation must be able to tell it from a sentence a model
 * wrote, and the view is the last place that distinction could be lost. The second is that a gap in
 * the narrative is visible: byes, voids and double forfeits reach the reader in the results but are
 * withheld from the model, so a recap covering fewer games than the round contained has to say so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMENTARY_MESSAGES,
  renderGameCommentary as renderGameCommentaryBase,
  renderRoundRecap as renderRoundRecapBase,
} from '../src/app/tournament-commentary-view.js';
import { createI18nManager, type I18n } from '../src/i18n/index.js';
import type { TournamentGameCommentary, TournamentRoundRecap } from '../src/api/models.js';

const testI18n = createI18nManager();

function renderGameCommentary(
  doc: Document,
  container: HTMLElement,
  commentary: TournamentGameCommentary,
  i18n: I18n = testI18n,
): void {
  renderGameCommentaryBase(doc, container, commentary, i18n);
}

function renderRoundRecap(
  doc: Document,
  container: HTMLElement,
  recap: TournamentRoundRecap,
  i18n: I18n = testI18n,
): void {
  renderRoundRecapBase(doc, container, recap, i18n);
}
import { FakeElement } from './support/analysis-fixtures.js';

/**
 * The repo's DOM double rather than a real one: these renderers take the owning document as a
 * parameter for exactly this reason, and the double is what every other view test here asserts
 * against.
 *
 * @returns a document that mints fake elements, and the container to render into.
 */
function mount(): { doc: Document; container: HTMLElement; root: FakeElement } {
  const root = new FakeElement('host');
  const doc = {
    createElement: (_tag: string) => new FakeElement(),
  } as unknown as Document;
  return { doc, container: root as unknown as HTMLElement, root };
}

/**
 * @param el - a rendered container.
 * @returns every character rendered under it, labels and values alike, so a leak into any cell is
 * visible to an assertion.
 */
function allText(el: FakeElement): string {
  /**
   * @param node - a node in the fake tree.
   * @returns its own text plus every descendant's.
   */
  const walk = (node: { textContent: string; children: unknown[] }): string =>
    `${node.textContent} ${node.children.map((c) => walk(c as typeof node)).join(' ')}`;
  return walk(el as unknown as { textContent: string; children: unknown[] });
}

/**
 * @param el - a rendered container.
 * @param className - the class to look for.
 * @returns every descendant carrying that class.
 */
function byClass(el: FakeElement, className: string): FakeElement[] {
  const found: FakeElement[] = [];
  /**
   * @param node - a node in the fake tree; collected if its class matches.
   */
  const walk = (node: FakeElement): void => {
    if (node.className === className) found.push(node);
    for (const child of node.children) walk(child);
  };
  walk(el);
  return found;
}

const PROSE = 'Alice squeezed a long endgame and never let the rook get active.';

const COMMENTARY: TournamentGameCommentary = {
  tournamentId: 't1',
  gameId: 'g1',
  round: 2,
  white: 'alice',
  black: 'bob',
  result: '1-0',
  tournamentResult: null,
  termination: 'resign',
  ply: 41,
  fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
  variant: 'standard',
  finalMove: { uci: 'b8c6', san: 'Nc6' },
  citation: {
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
    move: 'b8c6',
    evalKind: 'cp',
    evalValue: 24,
    evalLabel: '+0.24',
    bestLine: ['b8c6', 'f1b5'],
    depth: 18,
  },
  commentary: PROSE,
  providerId: 'openai',
  model: 'gpt-4o-mini',
};

const RECAP_PROSE = 'Alice leads after a decisive win on board one.';

/**
 * @param overrides - fields to change for the case under test.
 * @returns a two-pairing round recap in which every game was narrated.
 */
function recap(overrides: Partial<TournamentRoundRecap> = {}): TournamentRoundRecap {
  return {
    tournamentId: 't1',
    round: 1,
    results: [
      { white: 'alice', black: 'bob', result: 'white_win' },
      { white: 'carol', black: 'dave', result: 'draw' },
    ],
    standings: [
      { rank: 1, player: 'alice', points: 2 },
      { rank: 2, player: 'carol', points: 1.5 },
    ],
    pairingsNarrated: 2,
    narrative: RECAP_PROSE,
    providerId: 'openai',
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

test('the generated prose is labelled as generated and kept out of the facts', () => {
  const { doc, container, root } = mount();
  renderGameCommentary(doc, container, COMMENTARY);

  const narrative = byClass(root, 'commentary-narrative');
  assert.equal(narrative.length, 1, 'the prose has its own block');
  const block = allText(narrative[0]!);
  assert.ok(block.includes(COMMENTARY_MESSAGES.generated));
  assert.ok(block.includes(PROSE));

  // And no fact block contains it. A view that appended the prose into the citation would still
  // "render the commentary", and a reader would have no way to tell the measurement from the story.
  for (const section of byClass(root, 'commentary-section')) {
    assert.equal(allText(section).includes(PROSE), false, 'prose leaked into a facts block');
  }
});

test('the citation shows the depth it was measured at', () => {
  const { doc, container, root } = mount();
  renderGameCommentary(doc, container, COMMENTARY);

  const text = allText(root);
  assert.ok(text.includes(COMMENTARY_MESSAGES.citation));
  assert.ok(text.includes('+0.24'));
  assert.ok(text.includes('18'));
});

test('the provider and the model are never rendered as facts about the chess', () => {
  const { doc, container, root } = mount();
  renderGameCommentary(doc, container, COMMENTARY);
  const gameText = allText(root);
  renderRoundRecap(doc, container, recap());

  // Asserted over every rendered character rather than over a field list, because a field added
  // later is one nobody would have thought to name here.
  const text = `${gameText} ${allText(root)}`;
  assert.equal(text.includes('openai'), false);
  assert.equal(text.includes('gpt-4o-mini'), false);
});

test('prose is set as text, so nothing a model wrote can become markup', () => {
  const { doc, container, root } = mount();
  const injected = '<img src=x onerror="alert(1)">';
  renderGameCommentary(doc, container, { ...COMMENTARY, commentary: injected });

  // The double has no HTML parser, so the assertion is about which property was written: a renderer
  // reaching for `innerHTML` would leave the markup there, where this proves it is not.
  const prose = byClass(root, 'commentary-prose');
  assert.equal(prose.length, 1);
  assert.equal(prose[0]!.textContent, injected);
  assert.equal(prose[0]!.innerHTML, '');
});

test('a round every game of which was narrated carries no partial note', () => {
  const { doc, container, root } = mount();
  renderRoundRecap(doc, container, recap());

  assert.equal(byClass(root, 'commentary-partial').length, 0);
  assert.ok(allText(root).includes('Standings after round 2'));
});

test('a bye is shown in the results, and the reader is told the prose skipped it', () => {
  const { doc, container, root } = mount();
  renderRoundRecap(
    doc,
    container,
    recap({
      results: [
        { white: 'alice', black: 'bob', result: 'white_win' },
        { white: 'carol', black: null, result: 'bye' },
      ],
      pairingsNarrated: 1,
    }),
  );

  const text = allText(root);
  assert.ok(text.includes('Bye'), 'the bye is a published fact');
  assert.ok(text.includes('carol'));
  const note = byClass(root, 'commentary-partial');
  assert.equal(note.length, 1, 'a recap covering fewer games than the round must say so');
  assert.equal(note[0]!.textContent, COMMENTARY_MESSAGES.partial);
});

test('a double forfeit is shown and counted as unnarrated', () => {
  const { doc, container, root } = mount();
  renderRoundRecap(
    doc,
    container,
    recap({
      results: [{ white: 'alice', black: 'bob', result: 'double_forfeit' }],
      standings: [{ rank: 1, player: 'alice', points: 0 }],
      pairingsNarrated: 0,
    }),
  );

  assert.ok(allText(root).includes('Both forfeited'));
  assert.equal(byClass(root, 'commentary-partial').length, 1);
});

test('rendering twice replaces the previous answer rather than stacking on it', () => {
  const { doc, container, root } = mount();
  renderRoundRecap(doc, container, recap());
  renderRoundRecap(doc, container, recap({ round: 3, narrative: 'A quieter round.' }));

  const text = allText(root);
  assert.ok(text.includes('A quieter round.'));
  assert.equal(text.includes(RECAP_PROSE), false);
  assert.equal(byClass(root, 'commentary-narrative').length, 1);
});

test('a tournament result that agrees with the game is not repeated', () => {
  const { doc, container, root } = mount();
  renderGameCommentary(doc, container, { ...COMMENTARY, tournamentResult: 'white_win' });

  // `1-0` and `white_win` are the same outcome in two vocabularies. Showing both would invite a
  // reader to look for a difference that is not there.
  assert.equal(allText(root).includes('Recorded by the tournament'), false);
});

test('a tournament result that disagrees with the game is shown beside it', () => {
  const { doc, container, root } = mount();
  renderGameCommentary(doc, container, { ...COMMENTARY, tournamentResult: 'double_forfeit' });

  // Two true statements about different things: the game ended 1-0 and the tournament scored it a
  // double forfeit. A reader seeing the standings elsewhere deserves to be told which is which.
  const text = allText(root);
  assert.ok(text.includes('1-0'));
  assert.ok(text.includes('Recorded by the tournament'));
  // The reader's wording, not the aggregate's token: recap rows say 'Both forfeited' for the same
  // value, and one vocabulary should not be shown two ways in one feature.
  assert.ok(text.includes('Both forfeited'));
  assert.equal(text.includes('double_forfeit'), false);
});

test('a pairing the tournament has not scored yet says nothing about it', () => {
  const { doc, container, root } = mount();
  renderGameCommentary(doc, container, COMMENTARY);

  assert.equal(allText(root).includes('Recorded by the tournament'), false);
});

test('a result token this build does not recognise is shown as itself, not guessed at', () => {
  const { doc, container, root } = mount();
  renderGameCommentary(doc, container, { ...COMMENTARY, tournamentResult: 'adjudicated' });

  // A server that knows a value this client does not is a server ahead of it. Inventing a label
  // would be the client asserting a fact it does not have, so the token passes through unchanged.
  assert.ok(allText(root).includes('adjudicated'));
});

test('an unfamiliar result token survives the recap table as it survives the commentary', () => {
  const { doc, container, root } = mount();
  renderRoundRecap(
    doc,
    container,
    // A server ahead of this build. The union types the field, which is a compile-time guarantee and
    // says nothing about what arrives over the wire.
    recap({ results: [{ white: 'alice', black: 'bob', result: 'adjudicated' as never }], pairingsNarrated: 0 }),
  );

  const text = allText(root);
  assert.ok(text.includes('adjudicated'), 'the row rendered as empty text instead of the token');
  assert.ok(text.includes('alice vs bob'));
});
