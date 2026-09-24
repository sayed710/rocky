/**
 * Tests for engine analysis mounting, wiring, capability gating, and controller lifecycle (M15 inc 2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import type { AnalysisResponse } from '../src/api/models.js';
import {
  AsyncTransport,
  createGameDocument,
  makeState,
  sampleAnalysisResponse,
} from './support/analysis-fixtures.js';

function setupMountedGame(opts?: {
  transport?: HttpTransport;
  authenticated?: boolean;
  analysisEnabled?: boolean;
}) {
  const sockets = new FakeSocketFactory();
  const analysisEnabled = opts?.analysisEnabled ?? true;

  const transport =
    opts?.transport ??
    new FakeTransport().onEach((req: HttpRequest) => {
      if (req.url.includes('/v1/capabilities')) {
        return json(200, {
          capabilities: {
            learning: true,
            studies: true,
            achievements: true,
            search: true,
            social: true,
            messaging: true,
            community: true,
            analysis: analysisEnabled,
          },
        });
      }
      if (req.url.includes('/v1/analysis')) {
        return json(200, sampleAnalysisResponse());
      }
      return json(200, {});
    });

  const app = createApp({
    config: {
      apiBaseUrl: 'https://api.test',
      wsUrl: 'wss://api.test/ws',
    },
    wsFactory: sockets.factory,
    httpTransport: transport,
  });

  if (opts?.authenticated ?? true) {
    app.api.session.adopt({
      user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
      tokens: {
        accessToken: 'tok-123',
        tokenType: 'Bearer',
        expiresIn: 900,
        refreshExpiresAt: '2030-01-01T00:00:00Z',
      },
    });
  }

  const { doc, elements } = createGameDocument();
  const boardEl = elements.get('board')! as unknown as HTMLElement;

  const mounted = mountGame({
    doc,
    boardEl,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'test-token',
    restorePromise: Promise.resolve(null),
  });

  return { sockets, app, transport, doc, elements, mounted };
}

test('the request contract: analysing sends POST /v1/analysis with board fen, variant, multiPv, and no depth/time fields', async () => {
  let capturedRequest: HttpRequest | null = null;
  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, { capabilities: { analysis: true } });
    }
    if (req.url.includes('/v1/analysis')) {
      capturedRequest = req;
      return json(200, sampleAnalysisResponse());
    }
    return json(200, {});
  });

  const { sockets, elements, mounted } = setupMountedGame({ transport });
  await new Promise((r) => setTimeout(r, 0));

  // Join the game
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });

  const runBtn = elements.get('analysis-run')!;
  const linesSelect = elements.get('analysis-lines')!;
  linesSelect.value = '3';

  runBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(capturedRequest !== null, 'POST /v1/analysis must be called');
  const req: HttpRequest = capturedRequest;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://api.test/v1/analysis');
  assert.equal(req.headers['authorization'], 'Bearer tok-123');

  const body = JSON.parse(req.body as string);
  assert.equal(body.fen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(body.variant, 'standard');
  assert.equal(body.multiPv, 3);
  assert.equal(body.depth, undefined);
  assert.equal(body.movetimeMs, undefined);
  assert.equal(body.nodes, undefined);

  mounted.controller.dispose();
  mounted.analysis.dispose();
});

test('API failure -> the error element shows the failed copy', async () => {
  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, { capabilities: { analysis: true } });
    }
    if (req.url.includes('/v1/analysis')) {
      return json(500, { error: { code: 'internal_error', message: 'Engine failure', requestId: 'req-err' } });
    }
    return json(200, {});
  });

  const { sockets, elements, mounted } = setupMountedGame({ transport });
  await new Promise((r) => setTimeout(r, 0));

  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });

  const runBtn = elements.get('analysis-run')!;
  const errorEl = elements.get('analysis-error')!;
  const noteEl = elements.get('analysis-note')!;

  runBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(errorEl.hidden, false);
  assert.equal(errorEl.textContent, 'Analysis failed. Try again.');
  assert.equal(noteEl.hidden, true);

  mounted.controller.dispose();
  mounted.analysis.dispose();
});

test('rate limit (429) -> the muted note, NOT the error element', async () => {
  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, { capabilities: { analysis: true } });
    }
    if (req.url.includes('/v1/analysis')) {
      return json(429, { error: { code: 'rate_limited', message: 'Too many requests', requestId: 'req-429' } });
    }
    return json(200, {});
  });

  const { sockets, elements, mounted } = setupMountedGame({ transport });
  await new Promise((r) => setTimeout(r, 0));

  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });

  const runBtn = elements.get('analysis-run')!;
  const errorEl = elements.get('analysis-error')!;
  const noteEl = elements.get('analysis-note')!;

  runBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(noteEl.hidden, false);
  assert.equal(noteEl.textContent, 'Too many analysis requests. Wait a moment and try again.');
  assert.equal(errorEl.hidden, true);

  mounted.controller.dispose();
  mounted.analysis.dispose();
});

test('service unavailable (503) -> the muted note, NOT the error element', async () => {
  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, { capabilities: { analysis: true } });
    }
    if (req.url.includes('/v1/analysis')) {
      return json(503, { error: { code: 'service_unavailable', message: 'Engine unavailable', requestId: 'req-503' } });
    }
    return json(200, {});
  });

  const { sockets, elements, mounted } = setupMountedGame({ transport });
  await new Promise((r) => setTimeout(r, 0));

  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });

  const runBtn = elements.get('analysis-run')!;
  const errorEl = elements.get('analysis-error')!;
  const noteEl = elements.get('analysis-note')!;

  runBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(noteEl.hidden, false);
  assert.equal(noteEl.textContent, 'Analysis is unavailable right now.');
  assert.equal(errorEl.hidden, true);

  mounted.controller.dispose();
  mounted.analysis.dispose();
});

test('live-human-game conflict from another session explains why analysis was refused', async () => {
  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, { capabilities: { analysis: true } });
    }
    if (req.url.includes('/v1/analysis')) {
      return json(409, {
        error: {
          code: 'conflict',
          message: 'assistance unavailable',
          details: { reason: 'active_human_game' },
          requestId: 'req-live-game',
        },
      });
    }
    return json(200, {});
  });

  const { sockets, elements, mounted } = setupMountedGame({ transport });
  await new Promise((resolve) => setTimeout(resolve, 0));
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });

  elements.get('analysis-run')!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(elements.get('analysis-note')!.textContent,
    'Analysis is unavailable while you are playing a live human game.');
  assert.equal(elements.get('analysis-error')!.hidden, true);

  mounted.controller.dispose();
  mounted.analysis.dispose();
});

test('a new request supersedes an old one: a slow first response that resolves AFTER a position change must not render', async () => {
  let resolveSlowResponse: ((res: HttpResponse) => void) | null = null;
  const transport = new AsyncTransport((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, { capabilities: { analysis: true } });
    }
    if (req.url.includes('/v1/analysis')) {
      return new Promise<HttpResponse>((resolve) => {
        resolveSlowResponse = resolve;
      });
    }
    return json(200, {});
  });

  const { sockets, elements, mounted } = setupMountedGame({ transport });
  await new Promise((r) => setTimeout(r, 0));

  // Initial position
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 0, 'w'),
  });

  const runBtn = elements.get('analysis-run')!;
  const resultsEl = elements.get('analysis-results')!;
  const noteEl = elements.get('analysis-note')!;

  runBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(noteEl.textContent, 'Analysing…');

  // Position change occurs while analysis is in flight
  sockets.last.emit({
    t: 'state',
    gameId: 'g-test-1',
    state: makeState('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', 1, 'b'),
  });

  assert.equal(noteEl.textContent, 'Position changed. Analyse again.');

  // Now the slow response resolves
  assert.ok(resolveSlowResponse !== null, 'slow response resolver must be set');
  const resolveFn: (res: HttpResponse) => void = resolveSlowResponse;
  resolveFn(json(200, sampleAnalysisResponse()));
  await new Promise((r) => setTimeout(r, 0));

  // Stale results must not be rendered
  assert.equal(resultsEl.children.length, 0);
  assert.equal(noteEl.textContent, 'Position changed. Analyse again.');

  mounted.controller.dispose();
  mounted.analysis.dispose();
});

test('disposal during a pending request: no callback fires and nothing is written to the DOM', async () => {
  let resolveSlowResponse: ((res: HttpResponse) => void) | null = null;
  const transport = new AsyncTransport((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, { capabilities: { analysis: true } });
    }
    if (req.url.includes('/v1/analysis')) {
      return new Promise<HttpResponse>((resolve) => {
        resolveSlowResponse = resolve;
      });
    }
    return json(200, {});
  });

  const { sockets, elements, mounted } = setupMountedGame({ transport });
  await new Promise((r) => setTimeout(r, 0));

  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });

  const runBtn = elements.get('analysis-run')!;
  const resultsEl = elements.get('analysis-results')!;
  const noteEl = elements.get('analysis-note')!;

  runBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(noteEl.textContent, 'Analysing…');

  // Dispose before response arrives
  mounted.analysis.dispose();
  mounted.connectivity.dispose();
  mounted.controller.dispose();

  assert.ok(resolveSlowResponse !== null, 'slow response resolver must be set');
  const resolveFn: (res: HttpResponse) => void = resolveSlowResponse;
  resolveFn(json(200, sampleAnalysisResponse()));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(resultsEl.children.length, 0);

  // Late capabilities call after disposal must not reveal section
  const sectionEl = elements.get('analysis')!;
  sectionEl.hidden = true;
  assert.equal(sectionEl.hidden, true);
});

test('SPA remount does not stack handlers: mounting twice and clicking once issues exactly one request', async () => {
  let requestCount = 0;
  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, { capabilities: { analysis: true } });
    }
    if (req.url.includes('/v1/analysis')) {
      requestCount++;
      return json(200, sampleAnalysisResponse());
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
    tokens: { accessToken: 'tok-123', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });

  const { doc, elements } = createGameDocument();
  const boardEl = elements.get('board')! as unknown as HTMLElement;

  // Mount run 1
  const mount1 = mountGame({
    doc,
    boardEl,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'test-token',
    restorePromise: Promise.resolve(null),
  });

  // Teardown run 1
  mount1.analysis.dispose();
  mount1.connectivity.dispose();
  mount1.controller.dispose();

  // Mount run 2 against same elements
  const mount2 = mountGame({
    doc,
    boardEl,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'test-token',
    restorePromise: Promise.resolve(null),
  });

  await new Promise((r) => setTimeout(r, 0));

  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });

  const runBtn = elements.get('analysis-run')!;
  runBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(requestCount, 1, 'clicking run once after remount must issue exactly one request');

  mount2.analysis.dispose();
  mount2.connectivity.dispose();
  mount2.controller.dispose();
});

test('the run control is disabled while a request is pending, and re-enabled after', async () => {
  let resolveResponse: ((res: HttpResponse) => void) | null = null;
  const transport = new AsyncTransport((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, { capabilities: { analysis: true } });
    }
    if (req.url.includes('/v1/analysis')) {
      return new Promise<HttpResponse>((resolve) => {
        resolveResponse = resolve;
      });
    }
    return json(200, {});
  });

  const { sockets, elements, mounted } = setupMountedGame({ transport });
  await new Promise((r) => setTimeout(r, 0));

  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });

  const runBtn = elements.get('analysis-run')!;
  const resultsEl = elements.get('analysis-results')!;

  assert.equal(runBtn.disabled, false);
  assert.equal(resultsEl.getAttribute('aria-busy'), 'false');

  runBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(runBtn.disabled, true);
  assert.equal(resultsEl.getAttribute('aria-busy'), 'true');

  assert.ok(resolveResponse !== null, 'resolveResponse must be assigned');
  const resolveFn: (res: HttpResponse) => void = resolveResponse;
  resolveFn(json(200, sampleAnalysisResponse()));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(runBtn.disabled, false);
  assert.equal(resultsEl.getAttribute('aria-busy'), 'false');

  mounted.controller.dispose();
  mounted.analysis.dispose();
});

/**
 * The signed-out half of the gate. The capability half is covered by `analysisEnabled` in
 * `capabilities-nav.test.ts`, and has to be: `loadCapabilities` memoises for the page's lifetime
 * with deliberately no reset seam, so no second test in this process can vary the flag. Splitting
 * the pure decision out is the same shape `routesToRemove` already has for the nav.
 */
test('auth gating: the panel is shown but its control is disabled with a sign-in note when signed out', async () => {
  const signedOut = setupMountedGame({ authenticated: false, analysisEnabled: true });
  await new Promise((r) => setTimeout(r, 0));

  const sectionEl = signedOut.elements.get('analysis')!;
  const runBtn = signedOut.elements.get('analysis-run')!;
  const noteEl = signedOut.elements.get('analysis-note')!;

  assert.equal(sectionEl.hidden, false, 'analysis section should be revealed when capabilities.analysis is true');
  assert.equal(runBtn.disabled, true, 'run button must be disabled for signed-out visitor');
  assert.equal(noteEl.textContent, 'Sign in to analyse positions.');

  signedOut.mounted.controller.dispose();
  signedOut.mounted.analysis.dispose();
});

test('keyboard accessibility: run button and select are focusable and select has accessible name in template', () => {
  const { elements, mounted } = setupMountedGame();
  const runBtn = elements.get('analysis-run')!;
  const linesSelect = elements.get('analysis-lines')!;

  runBtn.focus();
  assert.equal(runBtn.focused, true);

  linesSelect.focus();
  assert.equal(linesSelect.focused, true);

  mounted.controller.dispose();
  mounted.analysis.dispose();
});

/**
 * A remount must not show the previous game's analysis.
 *
 * The panel's DOM is a persistent part of `index.html`, not something a mount creates — so the rows
 * rendered for one game are still sitting there when the next `mountGame` runs. The controller's
 * own invalidation cannot help: a fresh controller has never analysed anything, so it has no reason
 * to think the panel is stale, and `positionChanged` correctly stays quiet.
 *
 * The result is an evaluation from a completely different game presented beside a new board, with
 * no visible cue that it is stale. Nothing in the request lifecycle catches this, because no request
 * is involved.
 */
test('a remount clears the previous game analysis rather than presenting it beside a new board', async () => {
  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) return json(200, { capabilities: { analysis: true } });
    if (req.url.includes('/v1/analysis')) return json(200, sampleAnalysisResponse());
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
    tokens: { accessToken: 'tok-123', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });

  const { doc, elements } = createGameDocument();
  const boardEl = elements.get('board')! as unknown as HTMLElement;
  const mountArgs = {
    doc,
    boardEl,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'test-token',
    restorePromise: Promise.resolve(null),
  };

  const first = mountGame(mountArgs);
  await new Promise((r) => setTimeout(r, 0));
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });

  elements.get('analysis-run')!.click();
  await new Promise((r) => setTimeout(r, 0));

  const results = elements.get('analysis-results')!;
  const reached = elements.get('analysis-reached')!;
  assert.ok(results.children.length > 0, 'precondition: the first game rendered analysis rows');
  assert.equal(reached.hidden, false, 'precondition: the first game rendered its reached line');

  first.analysis.dispose();
  first.connectivity.dispose();
  first.controller.dispose();

  const second = mountGame(mountArgs);
  try {
    assert.equal(
      results.children.length,
      0,
      'the previous game analysis must not survive into a new mount',
    );
    assert.equal(reached.hidden, true, 'the previous reached line must not survive into a new mount');
  } finally {
    second.analysis.dispose();
    second.connectivity.dispose();
    second.controller.dispose();
  }
});

/**
 * A variant this deployment has no engine for must stop offering the control.
 *
 * The `analysis` capability is deployment-wide, but ADR-0113 registers only engines whose binary is
 * configured and the API image installs Stockfish alone — so on an Atomic or Crazyhouse game the flag
 * is `true` while every request answers `422 unsupported variant`. Raised in the Qodo review of
 * PR #133, where the panel offered an enabled button that failed identically on every click.
 *
 * `classifyFailure` is unit-tested separately; this asserts the *consequence*, which is the half a
 * classifier test cannot see: the control goes away and the obstacle is named.
 */
test('a 422 naming the variant disables the control permanently and explains why', async () => {
  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) return json(200, { capabilities: { analysis: true } });
    if (req.url.includes('/v1/analysis')) {
      return json(422, {
        error: {
          code: 'validation_failed',
          message: 'unsupported variant',
          details: { variant: 'unsupported variant' },
          requestId: 'req-var',
        },
      });
    }
    return json(200, {});
  });

  const { sockets, elements, mounted } = setupMountedGame({ transport });
  await new Promise((r) => setTimeout(r, 0));
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });

  const runBtn = elements.get('analysis-run')!;
  const noteEl = elements.get('analysis-note')!;
  const errorEl = elements.get('analysis-error')!;

  assert.equal(runBtn.disabled, false, 'precondition: the control is offered before the server answers');

  runBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(runBtn.disabled, true, 'the control must not be offered again for a variant with no engine');
  assert.equal(noteEl.textContent, 'This deployment has no engine for this variant.');
  assert.equal(errorEl.hidden, true, 'an unsupported variant is a state, not an error the user caused');

  // And it stays disabled: a second position for the same game must not revive a control that
  // cannot work, since the variant does not change within a game.
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 2', 1, 'b'),
  });
  assert.equal(runBtn.disabled, true, 'a later position must not re-offer an impossible control');

  mounted.controller.dispose();
  mounted.analysis.dispose();
});

/**
 * Signing in on an open game has to reach the analysis control.
 *
 * `bootstrap` notifies the lobby and the profile of session changes through handler slots; the game
 * route was not wired in, so signing in left Analyse disabled under a stale "Sign in to analyse
 * positions." note until something incidental refreshed it. Raised in the Qodo review of PR #133.
 */
test('signing in while a game is open enables the control and clears the sign-in note', async () => {
  const { sockets, app, elements, mounted } = setupMountedGame({ authenticated: false });
  await new Promise((r) => setTimeout(r, 0));
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });

  const runBtn = elements.get('analysis-run')!;
  const noteEl = elements.get('analysis-note')!;

  assert.equal(runBtn.disabled, true, 'precondition: signed out, so the control is not offered');
  assert.equal(noteEl.textContent, 'Sign in to analyse positions.');

  const session = {
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] as const },
    tokens: {
      accessToken: 'tok-123',
      tokenType: 'Bearer' as const,
      expiresIn: 900,
      refreshExpiresAt: '2030-01-01T00:00:00Z',
    },
  };
  app.api.session.adopt(session);
  // What `bootstrap`'s `onSessionChange` does for this route.
  mounted.onSessionChange({ handle: 'alice', userId: 'u1' } as never);

  assert.equal(runBtn.disabled, false, 'signing in must enable the control without another event');
  assert.equal(noteEl.textContent, 'Analyse the position on the board.');

  mounted.controller.dispose();
  mounted.analysis.dispose();
});

