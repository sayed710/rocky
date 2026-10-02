/**
 * A deployment without move explanation never offers the control.
 *
 * Its own file, and not by preference. `loadCapabilities` memoises the answer for the lifetime of
 * the module with deliberately no reset seam — a second unmemoised reader would reintroduce the
 * per-navigation refetch that memo exists to prevent — so the first payload fetched in a process is
 * the one every later test in that process sees. `node --test` isolates per file, which makes a file
 * the unit of "one capability answer". `analysis-variant-gate.test.ts` exists for the same reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';
import type { HttpRequest } from '../src/ports/http.js';
import { createGameDocument } from './support/analysis-fixtures.js';

test('the explain block stays hidden when the deployment does not serve move explanation', async () => {
  const sockets = new FakeSocketFactory();
  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      // Analysis on, explanation off — the case a deployment with an engine and no AI provider is
      // in, and the one where offering the control would answer 503 on every click.
      return json(200, {
        capabilities: { analysis: true, moveExplanation: false },
        analysisVariants: ['standard'],
      });
    }
    return json(200, {});
  });

  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: transport,
  });

  const { doc, elements } = createGameDocument();
  mountGame({
    doc,
    boardEl: elements.get('board')! as unknown as HTMLElement,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => undefined,
    client: app.api,
    token: 'test-token',
    restorePromise: Promise.resolve(null),
    i18n: app.i18n,
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(elements.get('explain')!.hidden, true, 'the control is never offered');
  assert.equal(elements.get('analysis')!.hidden, false, 'while analysis, which is on, still is');
});
