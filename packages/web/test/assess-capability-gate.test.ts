/**
 * A deployment without mistake prediction never offers the control.
 *
 * Its own file, and not by preference. `loadCapabilities` memoises the answer for the lifetime of
 * the module with deliberately no reset seam — a second unmemoised reader would reintroduce the
 * per-navigation refetch the memo exists to prevent — so the first payload fetched in a process is
 * the one every later test in that process sees. `node --test` isolates per file, which makes a file
 * the unit of "one capability answer". `explain-capability-gate.test.ts` and
 * `analysis-variant-gate.test.ts` exist for the same reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';
import type { HttpRequest } from '../src/ports/http.js';
import { createGameDocument } from './support/analysis-fixtures.js';

test('the assess block stays hidden when the deployment does not serve mistake prediction', async () => {
  const sockets = new FakeSocketFactory();
  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      // A server predating this feature omits the flag entirely, which is the case that matters:
      // the gate is fail-closed, so an absent flag hides the control rather than offering one whose
      // every click would 404 or 503.
      return json(200, {
        capabilities: { analysis: true, moveExplanation: true },
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
  const mounted = mountGame({
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

  assert.equal(elements.get('assess')!.hidden, true, 'the control is never offered');
  assert.equal(elements.get('explain')!.hidden, false, 'while explanation, which is on, still is');
  assert.equal(elements.get('analysis')!.hidden, false);

  // `controller` too: it owns the GameSync reconnect timers and the clock interval, and a file that
  // leaves them running never exits however green its assertions are.
  mounted.analysis.dispose();
  mounted.controller.dispose();
  mounted.connectivity.dispose();
});
