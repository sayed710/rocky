import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';
import type { HttpRequest } from '../src/ports/http.js';
import { createGameDocument, makeFinishedState, makeState } from './support/analysis-fixtures.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('active human play hides every game-page assistance control', async (t) => {
  const sockets = new FakeSocketFactory();
  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, {
        capabilities: {
          analysis: true,
          puzzleGeneration: true,
          moveExplanation: true,
          mistakePrediction: true,
          openingExplorer: true,
          coach: true,
        },
      });
    }
    return json(200, {});
  });
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: transport,
  });
  t.after(() => app.dispose());
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
  });
  t.after(() => {
    mounted.analysis.dispose();
    mounted.connectivity.dispose();
    mounted.controller.dispose();
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState(FEN, 1, 'b', [{ ply: 1, uci: 'e2e4', san: 'e4', by: 'w' }]),
  });

  const assistanceIds = ['analysis', 'puzzle', 'explain', 'assess', 'opening', 'coach'];
  const botGameVisibility = new Map(
    assistanceIds.map((id) => [id, elements.get(id)!.hidden]),
  );

  sockets.last.emit({
    t: 'state',
    gameId: 'g-test-1',
    state: makeState(
      FEN,
      1,
      'b',
      [{ ply: 1, uci: 'e2e4', san: 'e4', by: 'w' }],
      { white: 'u1', black: 'u2' },
    ),
  });

  for (const id of assistanceIds) {
    assert.equal(elements.get(id)!.hidden, true, id);
  }
  for (const id of ['analysis-run', 'puzzle-run', 'explain-run', 'assess-run', 'opening-run', 'coach-run']) {
    assert.equal(elements.get(id)!.disabled, true, id);
  }

  sockets.last.emit({
    t: 'state',
    gameId: 'g-test-1',
    state: makeFinishedState(
      FEN,
      1,
      'b',
      [{ ply: 1, uci: 'e2e4', san: 'e4', by: 'w' }],
      { white: 'u1', black: 'u2' },
    ),
  });

  for (const id of assistanceIds) {
    assert.equal(
      elements.get(id)!.hidden,
      botGameVisibility.get(id),
      `${id} after terminal state`,
    );
  }
});
