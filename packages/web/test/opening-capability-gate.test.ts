/**
 * The opening capability gate, in its own file because `loadCapabilities` memoises per module —
 * a second payload inside `opening-mount.test.ts` would never be fetched, so a capability-off
 * assertion there would pass against the cached capability-on answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { openingExplorerEnabled } from '../src/app/capabilities-nav.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { json } from './support/fake-transport.js';
import type { HttpRequest } from '../src/ports/http.js';
import { AsyncTransport, createGameDocument, makeState } from './support/analysis-fixtures.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('opening identification fails closed when its capability is absent, false or malformed', () => {
  assert.equal(openingExplorerEnabled(null), false);
  assert.equal(openingExplorerEnabled(undefined), false);
  assert.equal(openingExplorerEnabled({}), false, 'a payload with no capabilities object');
  assert.equal(
    openingExplorerEnabled({ capabilities: { analysis: true } }),
    false,
    'an older server that does not publish the flag is not permission to offer the control',
  );
  assert.equal(openingExplorerEnabled({ capabilities: { openingExplorer: false } }), false);
  assert.equal(openingExplorerEnabled({ capabilities: { openingExplorer: 'yes' } }), false);
  assert.equal(openingExplorerEnabled({ capabilities: { openingExplorer: true } }), true);
});

/**
 * The flag is read on its own, never inferred from `analysis`.
 *
 * A deployment with a working engine and an empty opening dataset reports exactly this, and the
 * control has to stay off — the inverse of the case `opening-mount.test.ts` covers.
 */
test('an engine-capable deployment with the opening feature off keeps the section hidden', async () => {
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) {
      return json(200, {
        capabilities: { analysis: true, openingExplorer: false },
        analysisVariants: ['standard'],
        puzzleVariants: [],
      });
    }
    return json(200, {});
  });
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
  try {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    sockets.last.open();
    sockets.last.emit({
      t: 'joined',
      gameId: 'g-test-1',
      role: 'white',
      state: makeState(FEN, 1, 'b', [{ ply: 1, uci: 'e2e4', san: 'e4', by: 'w' }]),
    });

    assert.equal(elements.get('opening')!.hidden, true, 'the section stays hidden');
    assert.equal(
      elements.get('analysis')!.hidden,
      false,
      'while the engine panel is revealed, proving the two gates are independent',
    );

    elements.get('opening-run')!.click();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    assert.equal(
      transport.calls.filter((request) => request.url.endsWith('/v1/openings/explore')).length,
      0,
      'and activating the hidden control still sends nothing',
    );
  } finally {
    mounted.analysis.dispose();
    mounted.connectivity.dispose();
    mounted.controller.dispose();
    app.dispose();
  }
});
