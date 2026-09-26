/**
 * The `/endgames` route: what it renders, what it refuses to render, and what it cleans up.
 *
 * The load-bearing assertion is the first one. `/next` sends no solution, and this route must not
 * derive one — showing the best move beside the exercise is the defect ADR-0095 fixed for lesson
 * steps, and it would make the trainer pointless.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountEndgames } from '../src/app/endgame-mount.js';
import { GambitClient } from '../src/api/client.js';
import { FakeTransport, json } from './support/fake-transport.js';
import type { HttpRequest, HttpResponse } from '../src/ports/http.js';
import { FakeElement } from './support/analysis-fixtures.js';

const POSITION = {
  id: 'kq-vs-k-01',
  type: 'KQ_vs_K',
  name: 'Queen vs King mate',
  fen: '7k/8/6Q1/8/8/8/8/4K3 w - - 0 1',
  sideToMove: 'w',
  objective: 'mate',
  difficulty: 'beginner',
  technique: 'Box the king, then bring the king up.',
};

const ELEMENT_IDS = [
  'endgame-next', 'endgame-submit', 'endgame-move', 'endgame-form', 'endgame-note',
  'endgame-error', 'endgame-result', 'endgame-rows', 'endgame-position-rows', 'endgame-board',
] as const;

/**
 * @param respond - answers each request; the route only ever calls the two endgame endpoints.
 * @returns the fake document, its element map, and the transport for assertions.
 */
function setup(
  respond: (request: HttpRequest, index: number) => HttpResponse,
  isAuthenticated: () => boolean = () => true,
) {
  const elements = new Map<string, FakeElement>();
  const layout = new FakeElement('endgame-layout');
  for (const id of ELEMENT_IDS) {
    const el = new FakeElement(id);
    if (id === 'endgame-error' || id === 'endgame-result') el.hidden = true;
    elements.set(id, el);
  }
  const doc = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (selector: string) => selector === '.endgame-layout' ? layout : null,
    createElement: () => new FakeElement(),
  } as unknown as Document;

  const transport = new FakeTransport().onEach(respond);
  const client = new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 'none' },
    sleep: async () => undefined,
  });
  client.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  const mounted = mountEndgames({ doc, client, isAuthenticated });
  return { elements, layout, transport, mounted };
}

/**
 * Fire the form's submit listener directly.
 *
 * FakeElement models the listener map but has no dispatchEvent, and the route binds submit on
 * the form so that Enter in the move input plays the move.
 */
function submit(form: FakeElement): void {
  form.listeners['submit']?.forEach((fn) => fn({ preventDefault: () => {} } as unknown as Event));
}

/** @returns a promise resolving once the microtask queue has drained and renders have run. */
const settled = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * @param el - a rows container.
 * @returns the left-hand label of each row, which is what these tests assert on: the set of rows
 * rendered is the contract, and reading the labels catches a row appearing or vanishing.
 */
/**
 * @param el - a rows container.
 * @returns every piece of text under it, labels and values alike.
 *
 * `labels()` alone is not enough for the no-solution assertion: reading only the left cell would
 * pass a response whose best move was rendered into a value. Raised in the CodeRabbit review of
 * PR #151.
 */
function allText(el: FakeElement): string {
  const walk = (node: { textContent: string; children: unknown[] }): string =>
    `${node.textContent} ${node.children.map((c) => walk(c as typeof node)).join(' ')}`;
  return walk(el as unknown as { textContent: string; children: unknown[] });
}

/**
 * @param el - a rows container.
 * @returns the left-hand label of each row. The set of rows rendered is the contract, so reading
 * the labels catches one appearing or vanishing; use `allText` when the values matter too.
 */
function labels(el: FakeElement): string[] {
  return el.children.map((row) => (row.children[0] as { textContent: string }).textContent);
}

test('signed-out and authenticated empty states hide the trainer layout', () => {
  for (const authed of [false, true]) {
    const { elements, layout, mounted } = setup(() => json(200, POSITION), () => authed);
    try {
      assert.equal(layout.hidden, true, 'no position means no board or move form');
      assert.equal(elements.get('endgame-next')!.disabled, !authed);
      assert.equal(
        elements.get('endgame-note')!.textContent,
        authed ? 'Pick a training endgame to begin.' : 'Sign in to train endgames.',
      );
    } finally {
      mounted.dispose();
    }
  }
});

test('a loaded position shows the objective and never the solution', async () => {
  const { elements, layout, mounted } = setup((request) =>
    request.url.endsWith('/v1/endgames/next') ? json(200, POSITION) : json(200, {}),
  );
  try {
    elements.get('endgame-next')!.click();
    await settled();
    assert.equal(layout.hidden, false, 'the trainer appears only with a loaded position');

    const rows = labels(elements.get('endgame-position-rows')!);
    assert.deepEqual(rows, ['Endgame', 'Objective', 'To move', 'Level', 'Technique']);

    // Over every rendered character, not just the labels: a best move or an evaluation put into a
    // value cell is exactly as much of a leak, and reading only the left column would miss it.
    const rendered = `${allText(elements.get('endgame-position-rows')!)} ${allText(elements.get('endgame-board')!)}`;
    assert.doesNotMatch(
      rendered,
      /solution|best move|mate in|centipawn|depth|principal|\beval\b/i,
      'nothing on the page hints that an answer was delivered with the exercise',
    );
    // And the concrete values from this catalogue entry's own solution never appear either.
    for (const leak of ['g6g7', 'g6h7', '+2', 'Mate in']) {
      assert.equal(rendered.includes(leak), false, `"${leak}" leaked into the exercise`);
    }
    assert.equal(elements.get('endgame-result')!.hidden, true, 'no verdict before an attempt');
    // The prompt has to survive the `refresh()` at the end of `onPosition`: it is in the set of
    // notes the mount owns so a remount can clear it, which is exactly what made it overwritable.
    assert.equal(
      elements.get('endgame-note')!.textContent,
      'Play the move you think is best.',
      'a loaded board asks for a move, not for a position',
    );
  } finally {
    mounted.dispose();
  }
});

test('a judged attempt renders the engine verdict', async () => {
  const { elements, mounted } = setup((request) => {
    if (request.url.endsWith('/v1/endgames/next')) return json(200, POSITION);
    return json(200, {
      kind: 'judged',
      id: 'kq-vs-k-01',
      move: 'g6a6',
      fenAfter: 'x',
      classification: 'acceptable',
      goalPreserved: true,
      evalBefore: { type: 'mate', value: 2 },
      evalAfter: { type: 'mate', value: 1 },
      loss: { kind: 'centipawns', value: 0 },
      betterMove: 'g6g7',
      bestLine: ['g6g7', 'h8h7'],
      depth: 16,
      mateDistanceAfter: 1,
    });
  });
  try {
    elements.get('endgame-next')!.click();
    await settled();
    (elements.get('endgame-move') as unknown as { value: string }).value = 'g6a6';
    submit(elements.get('endgame-form')!);
    await settled();

    const rows = labels(elements.get('endgame-rows')!);
    assert.deepEqual(rows, [
      'Your move', 'Verdict', 'Goal', 'Before', 'After', 'Cost', 'Engine prefers', 'Line', 'Depth',
    ]);
    assert.equal(elements.get('endgame-result')!.hidden, false);
  } finally {
    mounted.dispose();
  }
});

/**
 * A move that ends the game has a result, not a score.
 *
 * The terminal branch must render as a game result — never as an evaluation, and never with a
 * fabricated 0.00 standing in for the score it does not have.
 */
test('a terminal attempt renders the result and no evaluation', async () => {
  const { elements, mounted } = setup((request) => {
    if (request.url.endsWith('/v1/endgames/next')) return json(200, POSITION);
    return json(200, {
      kind: 'terminal',
      id: 'kq-vs-k-01',
      move: 'e1d2',
      fenAfter: 'x',
      classification: 'throws_result',
      goalPreserved: false,
      terminal: { reason: 'stalemate', result: '1/2-1/2' },
    });
  });
  try {
    elements.get('endgame-next')!.click();
    await settled();
    (elements.get('endgame-move') as unknown as { value: string }).value = 'e1d2';
    submit(elements.get('endgame-form')!);
    await settled();

    const rows = labels(elements.get('endgame-rows')!);
    assert.deepEqual(rows, ['Your move', 'Verdict', 'Goal', 'Game']);
    assert.equal(rows.includes('Before'), false, 'a decided game has no evaluation to show');
    assert.equal(rows.includes('Cost'), false);
  } finally {
    mounted.dispose();
  }
});

test('no move is sent before a position has been loaded', async () => {
  const { elements, transport, mounted } = setup(() => json(200, POSITION));
  try {
    (elements.get('endgame-move') as unknown as { value: string }).value = 'e2e4';
    submit(elements.get('endgame-form')!);
    await settled();
    assert.equal(
      transport.calls.filter((r) => r.url.endsWith('/v1/endgames/attempt')).length,
      0,
    );
  } finally {
    mounted.dispose();
  }
});

/** The route's DOM lives in `index.html` and outlives the mount. */
test('disposal unbinds the controls so a second mount does not double-fire', async () => {
  const { elements, transport, mounted } = setup(() => json(200, POSITION));
  elements.get('endgame-next')!.click();
  await settled();
  const before = transport.calls.length;

  mounted.dispose();
  elements.get('endgame-next')!.click();
  await settled();

  assert.equal(transport.calls.length, before, 'a disposed mount listens to nothing');
});

/**
 * Session restore is asynchronous, so a visitor who lands here signed in arrives before their
 * session does. Without a session hook the route stays in its signed-out state until they navigate
 * away, and a logout leaves the controls live. Raised in the Qodo review of PR #151.
 */
test('authentication transitions reach the controls while the route stays mounted', async () => {
  let authed = false;
  const { elements, layout, mounted } = setup(() => json(200, POSITION), () => authed);
  try {
    assert.equal(elements.get('endgame-next')!.disabled, true, 'signed out to begin with');
    assert.equal(elements.get('endgame-note')!.textContent, 'Sign in to train endgames.');
    assert.equal(layout.hidden, true);

    authed = true;
    mounted.onSessionChange();

    assert.equal(elements.get('endgame-next')!.disabled, false);
    assert.equal(elements.get('endgame-note')!.textContent, 'Pick a training endgame to begin.');
    assert.equal(layout.hidden, true, 'signing in does not invent a position');

    elements.get('endgame-next')!.click();
    await settled();
    assert.equal(layout.hidden, false, 'the authenticated position is visible');

    authed = false;
    mounted.onSessionChange();
    assert.equal(elements.get('endgame-next')!.disabled, true, 'and a logout disables it again');
    assert.equal(layout.hidden, true, 'logout hides the loaded position');
    assert.equal(elements.get('endgame-note')!.textContent, 'Sign in to train endgames.');
  } finally {
    mounted.dispose();
  }
});

/**
 * A failed reload must take the board down with it.
 *
 * The controller drops its position when a new one is requested; if the request then fails, a mount
 * that cleared only the verdict left submission enabled against a position nothing owned, where an
 * attempt silently did nothing.
 */
test('a failed reload clears the position rather than leaving a dead board', async () => {
  let calls = 0;
  const { elements, layout, transport, mounted } = setup(() => {
    calls += 1;
    return calls === 1
      ? json(200, POSITION)
      : json(503, { error: { code: 'service_unavailable', message: 'nope', requestId: 'r' } });
  });
  try {
    elements.get('endgame-next')!.click();
    await settled();
    assert.ok(elements.get('endgame-position-rows')!.children.length > 0, 'a position is loaded');
    assert.equal(layout.hidden, false);

    elements.get('endgame-next')!.click();
    assert.equal(layout.hidden, true, 'the old layout disappears as soon as its position is invalidated');
    await settled();

    assert.equal(layout.hidden, true, 'failure leaves the empty layout hidden');
    assert.equal(elements.get('endgame-note')!.textContent, 'Endgame training is unavailable right now.');
    assert.equal(elements.get('endgame-position-rows')!.children.length, 0, 'the board is gone');
    assert.equal(elements.get('endgame-submit')!.disabled, true, 'and so is submission');

    const before = transport.calls.length;
    (elements.get('endgame-move') as unknown as { value: string }).value = 'g6a6';
    submit(elements.get('endgame-form')!);
    await settled();
    assert.equal(transport.calls.length, before, 'nothing is sent for a position that is gone');
  } finally {
    mounted.dispose();
  }
});

/** The two engine searches an attempt costs are work in flight, and must be announced as such. */
test('the result region reports busy while a move is being judged', async () => {
  let resolveAttempt: ((r: HttpResponse) => void) | undefined;
  const { elements, mounted } = setup((request) => {
    if (request.url.endsWith('/v1/endgames/next')) return json(200, POSITION);
    return new Promise<HttpResponse>((resolve) => { resolveAttempt = resolve; }) as unknown as HttpResponse;
  });
  try {
    elements.get('endgame-next')!.click();
    await settled();
    (elements.get('endgame-move') as unknown as { value: string }).value = 'g6a6';
    submit(elements.get('endgame-form')!);
    await settled();

    assert.equal(elements.get('endgame-result')!.getAttribute('aria-busy'), 'true');
    assert.equal(elements.get('endgame-note')!.textContent, 'Checking your move…');
    assert.ok(resolveAttempt, 'the attempt is still open');
  } finally {
    mounted.dispose();
  }
});
