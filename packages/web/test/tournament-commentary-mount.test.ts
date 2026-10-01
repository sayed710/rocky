/**
 * The commentary panel on the tournament page: what it offers, and what it takes back.
 *
 * Two properties are worth the file.
 *
 * **Both endpoints are reachable.** The feature has two halves — a recap of a round and commentary
 * on a finished game — and the first draft shipped a control for only the first, leaving the game
 * half reachable from the client library and from nowhere a person could click. Raised in the Qodo
 * review of PR #153.
 *
 * **Whatever the mount appends, its `dispose` removes.** The controls container comes from
 * `getElementById` and belongs to the page, and `lifecycle.ts` tears down and re-bootstraps on every
 * SPA navigation. Without symmetry, a second visit leaves a second button carrying the same id,
 * shadowing the first for `getElementById`, with a listener still holding a disposed controller.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTournamentCommentary as mountTournamentCommentaryBase } from '../src/app/competition-mounts.js';
import { createI18nManager } from '../src/i18n/index.js';
import { COMMENTARY_MESSAGES } from '../src/app/tournament-commentary-view.js';
import type { GambitClient } from '../src/api/client.js';

const testI18n = createI18nManager();

function mountTournamentCommentary(
  doc: Document,
  client: GambitClient,
  tournamentId: string,
  loadFlags?: (api: GambitClient) => Promise<unknown>,
) {
  return mountTournamentCommentaryBase(doc, client, tournamentId, testI18n, loadFlags);
}
import type { TournamentRound } from '../src/api/models.js';
import { FakeElement } from './support/analysis-fixtures.js';

const PANEL_IDS = [
  'tournament-commentary-panel',
  'tournament-commentary-controls',
  'tournament-commentary-status',
  'tournament-commentary-result',
] as const;

/** Two rounds, one launched game each. */
const TWO_ROUNDS: readonly TournamentRound[] = [
  { roundIndex: 0, pairings: [{ kind: 'game', white: 'w', black: 'b', gameId: 'g1' }] },
  { roundIndex: 1, pairings: [{ kind: 'game', white: 'w', black: 'b', gameId: 'g2' }] },
];

interface Recorded {
  readonly recaps: { tournamentId: string; round: number }[];
  readonly games: { tournamentId: string; gameId: string }[];
}

/**
 * @param elements - the panel's elements, by id.
 * @returns a document that serves them and mints fake elements for anything created.
 */
function makeDocument(elements: Map<string, FakeElement>): Document {
  return {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (_tag: string) => new FakeElement(),
  } as unknown as Document;
}

/**
 * Mount the commentary panel over a client and a capability read the test controls.
 *
 * @param options - the capability flag, the rounds to serve, and an optional failure to throw.
 * @returns the mount, its elements, what the client was asked for, and the controls container.
 */
function mount(options: {
  readonly enabled?: boolean;
  readonly rounds?: readonly TournamentRound[];
  readonly fails?: unknown;
} = {}) {
  const elements = new Map<string, FakeElement>();
  for (const id of PANEL_IDS) {
    const el = new FakeElement(id);
    if (id === 'tournament-commentary-panel' || id === 'tournament-commentary-result') el.hidden = true;
    elements.set(id, el);
  }
  const doc = makeDocument(elements);

  const recorded: Recorded = { recaps: [], games: [] };
  const client = {
    tournaments: {
      rounds: async (_id: string) => options.rounds ?? TWO_ROUNDS,
      gameCommentary: async (tournamentId: string, gameId: string, _signal?: AbortSignal) => {
        recorded.games.push({ tournamentId, gameId });
        if (options.fails !== undefined) throw options.fails;
        return {
          tournamentId,
          gameId,
          round: 0,
          white: 'alice',
          black: 'bob',
          result: '1-0',
          tournamentResult: null,
          termination: 'resign',
          ply: 3,
          fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
          variant: 'standard',
          finalMove: { uci: 'b8c6', san: 'Nc6' },
          citation: {
            fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
            move: 'b8c6',
            evalKind: 'cp',
            evalValue: 24,
            evalLabel: '+0.24',
            bestLine: ['b8c6'],
            depth: 18,
          },
          commentary: 'A sharp finish.',
          providerId: 'stub',
          model: 'stub-1',
        };
      },
      roundRecap: async (tournamentId: string, round: number, _signal?: AbortSignal) => {
        recorded.recaps.push({ tournamentId, round });
        if (options.fails !== undefined) throw options.fails;
        return {
          tournamentId,
          round,
          results: [{ white: 'alice', black: 'bob', result: 'white_win' as const }],
          standings: [{ rank: 1, player: 'alice', points: 1 }],
          pairingsNarrated: 1,
          narrative: 'A decisive round.',
          providerId: 'stub',
          model: 'stub-1',
        };
      },
    },
  } as unknown as GambitClient;

  /** @returns a capabilities payload carrying only the flag this panel reads. */
  const loadFlags = async (): Promise<unknown> => ({
    capabilities: { tournamentCommentary: options.enabled ?? true },
  });

  const mounted = mountTournamentCommentary(doc, client, 't1', loadFlags);
  return { mounted, elements, recorded, controls: elements.get('tournament-commentary-controls')! };
}

/** Let the capability read and the rounds read settle. */
const settle = (): Promise<void> => new Promise((done) => { setTimeout(done, 0); });

test('both halves of the feature are reachable: a recap per round and a commentary per game', async () => {
  const h = mount();
  await settle();

  assert.deepEqual(h.controls.children.map((c) => c.textContent), [
    'Recap round 1',
    'Commentate round 1, board 1',
    'Recap round 2',
    'Commentate round 2, board 1',
  ]);

  h.controls.children[3]!.click();
  await settle();
  assert.deepEqual(h.recorded.games, [{ tournamentId: 't1', gameId: 'g2' }]);
  assert.equal(h.recorded.recaps.length, 0);

  h.mounted.dispose();
});

test('a recap control asks for the round it names, not for round zero', async () => {
  const h = mount();
  await settle();

  h.controls.children[2]!.click();
  await settle();

  assert.deepEqual(h.recorded.recaps, [{ tournamentId: 't1', round: 1 }]);
  h.mounted.dispose();
});

test('a pairing with no launched game and a bye get no commentary control', async () => {
  const h = mount({
    rounds: [
      {
        roundIndex: 0,
        pairings: [
          { kind: 'game', white: 'w', black: 'b', gameId: null },
          { kind: 'bye', player: 'c' },
        ],
      },
    ],
  });
  await settle();

  // There is no game to commentate and no id to ask about, so offering a control would be offering
  // one that cannot be answered by anything.
  assert.deepEqual(h.controls.children.map((c) => c.textContent), ['Recap round 1']);
  h.mounted.dispose();
});

test('dispose removes every control it appended, because the container outlives the mount', async () => {
  const h = mount();
  await settle();
  assert.equal(h.controls.children.length, 4);

  h.mounted.dispose();

  assert.equal(h.controls.children.length, 0);
});

test('a second mount leaves exactly one set of controls, not two', async () => {
  const first = mount();
  await settle();
  first.mounted.dispose();

  // Re-bootstrapping the same page is what `lifecycle.ts` does on every SPA navigation.
  const second = mountTournamentCommentary(
    makeDocument(first.elements),
    { tournaments: { rounds: async () => TWO_ROUNDS } } as unknown as GambitClient,
    't1',
    async () => ({ capabilities: { tournamentCommentary: true } }),
  );
  await settle();

  assert.equal(first.controls.children.length, 4, 'the second mount added to what the first left behind');
  const ids = first.controls.children.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate element ids');
  second.dispose();
});

test('a deployment without the capability offers no controls and stays hidden', async () => {
  const h = mount({ enabled: false });
  await settle();

  assert.equal(h.elements.get('tournament-commentary-panel')!.hidden, true);
  assert.equal(h.controls.children.length, 0);
  h.mounted.dispose();
});

test('a game still being played reads as still being played, not as a failure', async () => {
  const h = mount({ fails: Object.assign(new Error('nope'), { status: 409 }) });
  await settle();

  h.controls.children[1]!.click();
  await settle();

  // 409 is this feature's ordinary answer, not a fault. The shared classifier maps it to `failed`,
  // whose wording would tell a reader something went wrong when nothing did.
  assert.equal(h.elements.get('tournament-commentary-status')!.textContent, COMMENTARY_MESSAGES.notReady);
  h.mounted.dispose();
});

test('signing out clears a rendered commentary', async () => {
  const h = mount();
  await settle();
  h.controls.children[1]!.click();
  await settle();
  const result = h.elements.get('tournament-commentary-result')!;
  assert.equal(result.hidden, false);

  h.mounted.sessionChanged(false);

  assert.equal(result.hidden, true);
  h.mounted.dispose();
});

test('a rounds read that fails says so, rather than offering an empty ready panel', async () => {
  const elements = new Map<string, FakeElement>();
  for (const id of PANEL_IDS) {
    const el = new FakeElement(id);
    if (id === 'tournament-commentary-panel' || id === 'tournament-commentary-result') el.hidden = true;
    elements.set(id, el);
  }
  const mounted = mountTournamentCommentary(
    makeDocument(elements),
    {
      tournaments: {
        /** @throws the failure this test is about. */
        rounds: async () => { throw new Error('network'); },
      },
    } as unknown as GambitClient,
    't1',
    async () => ({ capabilities: { tournamentCommentary: true } }),
  );
  await settle();

  // The capability read succeeded, so the panel is already visible and its status already says the
  // section is ready. Saying nothing about the failure leaves a reader looking at a panel that
  // claims to be ready with nothing in it to click.
  assert.equal(elements.get('tournament-commentary-panel')!.hidden, false);
  assert.equal(elements.get('tournament-commentary-controls')!.children.length, 0);
  assert.equal(elements.get('tournament-commentary-status')!.textContent, COMMENTARY_MESSAGES.failed);
  mounted.dispose();
});

test('a capability read that fails leaves the panel hidden and silent', async () => {
  const elements = new Map<string, FakeElement>();
  for (const id of PANEL_IDS) {
    const el = new FakeElement(id);
    if (id === 'tournament-commentary-panel' || id === 'tournament-commentary-result') el.hidden = true;
    elements.set(id, el);
  }
  const mounted = mountTournamentCommentary(
    makeDocument(elements),
    { tournaments: { rounds: async () => TWO_ROUNDS } } as unknown as GambitClient,
    't1',
    async () => { throw new Error('capabilities unreachable'); },
  );
  await settle();

  // The opposite answer, and deliberately: nothing was shown, so there is nothing to explain, and a
  // failure message on a hidden panel would be a message nobody sees attached to a section that may
  // not exist on this deployment at all.
  assert.equal(elements.get('tournament-commentary-panel')!.hidden, true);
  assert.equal(elements.get('tournament-commentary-status')!.textContent, '');
  mounted.dispose();
});
