import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import type { PuzzleGenerationResponse } from '../src/api/models.js';
import { AsyncTransport, createGameDocument, makeState } from './support/analysis-fixtures.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PUZZLE: PuzzleGenerationResponse = {
  kind: 'puzzle',
  fen: FEN,
  variant: 'standard',
  evidence: { kind: 'centipawn_gap', gapCp: 270 },
  bestMove: 'e2e4',
  comparisonMove: 'd2d4',
  bestEvaluation: { type: 'cp', value: 350 },
  comparisonEvaluation: { type: 'cp', value: 80 },
  depth: 16,
  solutionMove: 'e2e4',
  solutionLine: ['e2e4', 'e7e5'],
  difficulty: 'easy',
};

function setup(transport: HttpTransport) {
  const sockets = new FakeSocketFactory();
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: transport,
  });
  app.api.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  const { doc, elements } = createGameDocument();
  const mounted = mountGame({
    doc,
    boardEl: elements.get('board')! as unknown as HTMLElement,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'token',
    restorePromise: Promise.resolve(null),
    i18n: app.i18n,
  });
  return { sockets, elements, mounted, app };
}

function capabilities(): HttpResponse {
  return json(200, {
    capabilities: { analysis: true, puzzleGeneration: true },
    analysisVariants: ['standard'],
    puzzleVariants: ['standard'],
  });
}

function join(sockets: FakeSocketFactory): void {
  sockets.last.open();
  sockets.last.emit({ t: 'joined', gameId: 'g-test-1', role: 'white', state: makeState(FEN) });
}

function cleanup(mounted: ReturnType<typeof mountGame>, app: ReturnType<typeof createApp>): void {
  mounted.analysis.dispose();
  mounted.connectivity.dispose();
  mounted.controller.dispose();
  app.dispose();
}

function renderedText(el: { children: Array<{ textContent: string; children: unknown[] }> }): string {
  const walk = (node: { textContent: string; children: unknown[] }): string =>
    `${node.textContent}${node.children.map((child) => walk(child as typeof node)).join('')}`;
  return el.children.map((child) => walk(child)).join(' ');
}

test('Find tactic sends the exact board target, shows loading, and renders structured success', async () => {
  let resolvePuzzle: ((response: HttpResponse) => void) | undefined;
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) return capabilities();
    if (request.url.endsWith('/v1/analysis/puzzle')) {
      return new Promise<HttpResponse>((resolve) => { resolvePuzzle = resolve; });
    }
    return json(200, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    join(sockets);
    const button = elements.get('puzzle-run')!;
    assert.equal(elements.get('puzzle')!.hidden, false);
    button.click();
    button.click();
    await Promise.resolve();
    assert.equal(button.disabled, true);
    assert.equal(elements.get('puzzle-note')!.textContent, 'Searching for a tactic…');
    const requests = transport.calls.filter((request) => request.url.endsWith('/v1/analysis/puzzle'));
    assert.equal(requests.length, 1, 'repeat click must not start a second engine search');
    assert.deepEqual(JSON.parse(String(requests[0]!.body)), { fen: FEN, variant: 'standard' });

    resolvePuzzle?.(json(200, PUZZLE));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(elements.get('puzzle-result')!.hidden, false);
    const text = renderedText(elements.get('puzzle-rows')!);
    assert.match(text, /Solutione2e4/);
    assert.match(text, /Evidence2\.70 pawn gap/);
  } finally {
    cleanup(mounted, app);
  }
});

for (const [kind, response, message] of [
  ['no tactic', {
    kind: 'no_tactic' as const,
    fen: FEN,
    variant: 'standard' as const,
    evidence: { kind: 'centipawn_gap' as const, gapCp: 80 },
    bestMove: 'e2e4',
    comparisonMove: 'd2d4',
    bestEvaluation: { type: 'cp' as const, value: 120 },
    comparisonEvaluation: { type: 'cp' as const, value: 40 },
    depth: 16,
  }, 'No tactic met the server’s fixed evidence threshold.'],
  ['insufficient evidence', {
    kind: 'insufficient' as const,
    fen: FEN,
    variant: 'standard',
    reason: 'not_enough_lines',
    bestMove: 'e2e4',
    comparisonMove: null,
  }, 'The engine returned insufficient evidence for a conclusion.'],
] as const) {
  test(`Find tactic renders ${kind} without claiming a puzzle`, async () => {
    const transport = new FakeTransport().onEach((request) =>
      request.url.endsWith('/v1/analysis/puzzle') ? json(200, response) : capabilities());
    const { sockets, elements, mounted, app } = setup(transport);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      join(sockets);
      elements.get('puzzle-run')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(elements.get('puzzle-note')!.textContent, message);
      if (kind === 'insufficient evidence') assert.equal(elements.get('puzzle-result')!.hidden, true);
    } finally {
      cleanup(mounted, app);
    }
  });
}

test('Find tactic renders a safe rate-limit state without server prose', async () => {
  const transport = new FakeTransport().onEach((request) =>
    request.url.endsWith('/v1/analysis/puzzle')
      ? json(429, { error: { code: 'rate_limited', message: 'secret server prose', requestId: 'r1' } })
      : capabilities());
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    join(sockets);
    elements.get('puzzle-run')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(elements.get('puzzle-note')!.textContent, 'Too many tactic searches. Try again shortly.');
    assert.equal(elements.get('puzzle-error')!.textContent.includes('secret'), false);
  } finally {
    cleanup(mounted, app);
  }
});

test('Find tactic labels mate distance in engine moves, not plies', async () => {
  const response: PuzzleGenerationResponse = {
    kind: 'no_tactic',
    fen: FEN,
    variant: 'standard',
    evidence: { kind: 'mate', relation: 'faster_mate', distanceGap: 2 },
    bestMove: 'e2e4',
    comparisonMove: 'd2d4',
    bestEvaluation: { type: 'mate', value: 3 },
    comparisonEvaluation: { type: 'mate', value: 5 },
    depth: 16,
  };
  const transport = new FakeTransport().onEach((request) =>
    request.url.endsWith('/v1/analysis/puzzle') ? json(200, response) : capabilities());
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    join(sockets);
    elements.get('puzzle-run')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = renderedText(elements.get('puzzle-rows')!);
    assert.match(text, /faster mate · 2 moves/);
    assert.doesNotMatch(text, /ply/);
  } finally {
    cleanup(mounted, app);
  }
});
