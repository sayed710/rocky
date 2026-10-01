/**
 * The per-variant analysis gate, driven through the real mount.
 *
 * In its own file on purpose. `loadCapabilities` memoises for the lifetime of the module with
 * deliberately no reset seam (see `capabilities-nav.ts`), so the first capability payload any test in
 * a process fetches is the one every later test sees. `node --test` isolates per file, so this file
 * owns the memo and can state what the deployment advertises.
 *
 * What it protects: ADR-0113 registers only engines whose binary is configured, and the API image
 * carries Stockfish alone — so `analysis: true` coexists with a 422 for Atomic, Crazyhouse, King of
 * the Hill, Three-Check, Horde and Racing Kings. Offering the control on those and retracting it
 * after the first failed click is not good enough; DESIGN.md's rule is that a control which would
 * fail is not shown, with a sentence naming the obstacle. Raised in the Qodo review of PR #133 and
 * kept open across the first, reactive fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';
import type { HttpRequest } from '../src/ports/http.js';
import { createGameDocument, makeState, sampleAnalysisResponse } from './support/analysis-fixtures.js';

/** Stockfish-only, which is what the production image actually is. */
function stockfishOnlyTransport() {
  return new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, {
        capabilities: { analysis: true },
        analysisVariants: ['standard', 'chess960'],
      });
    }
    if (req.url.includes('/v1/analysis')) return json(200, sampleAnalysisResponse());
    return json(200, {});
  });
}

async function mountWithVariant(variant: string) {
  const transport = stockfishOnlyTransport();
  const sockets = new FakeSocketFactory();
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: transport,
  });
  app.api.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: {
      accessToken: 'tok-123',
      tokenType: 'Bearer',
      expiresIn: 900,
      refreshExpiresAt: '2030-01-01T00:00:00Z',
    },
  });

  const { doc, elements } = createGameDocument();
  const mounted = mountGame({
    doc,
    boardEl: elements.get('board')! as unknown as HTMLElement,
    gameId: 'g-gate-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'test-token',
    restorePromise: Promise.resolve(null),
    i18n: app.i18n,
  });

  await new Promise((r) => setTimeout(r, 0));
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-gate-1',
    role: 'white',
    state: { ...makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), variant },
  });
  await new Promise((r) => setTimeout(r, 0));

  return { elements, mounted, transport };
}

test('a variant the deployment cannot analyse never offers the control', async () => {
  const { elements, mounted, transport } = await mountWithVariant('atomic');
  try {
    assert.equal(
      elements.get('analysis-run')!.disabled,
      true,
      'an unanalysable variant must not offer the control at all',
    );
    assert.equal(
      elements.get('analysis-note')!.textContent,
      'This deployment has no engine for this variant.',
    );
    assert.equal(
      transport.calls.filter((c) => c.url.includes('/v1/analysis')).length,
      0,
      'and no request may be spent discovering it',
    );
  } finally {
    mounted.controller.dispose();
    mounted.analysis.dispose();
  }
});

/** The counterpart, so the gate cannot pass by refusing everything. */
test('a variant the deployment can analyse still offers the control', async () => {
  const { elements, mounted } = await mountWithVariant('standard');
  try {
    assert.equal(
      elements.get('analysis-run')!.disabled,
      false,
      'standard is analysable in a Stockfish deployment and must be offered',
    );
  } finally {
    mounted.controller.dispose();
    mounted.analysis.dispose();
  }
});
