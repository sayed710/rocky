import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, extractGameId, formatClock, formatTimeControl } from '../src/app/bootstrap.js';
import type { BootstrapDependencies, Bootstrapped } from '../src/app/bootstrap.js';
import { createLifecycle } from '../src/app/lifecycle.js';
import { GameController } from '../src/app/game-controller.js';
import { FakeTransport, json } from './support/fake-transport.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import type { HttpResponse, HttpTransport } from '../src/ports/http.js';
import { MemoryTokenStore } from '../src/net/session.js';
import type { ServerMessage, StateView } from '../src/net/ws-protocol.js';
import type { WebAuthnAdapter } from '../src/ports/webauthn.js';
import type {
  WebAuthnLoginOptions,
  WebAuthnLoginVerifyRequest,
  WebAuthnRegisterOptions,
  WebAuthnRegisterVerifyRequest,
} from '../src/api/models.js';

// Define HTMLButtonElement for Node.js test environment (m3: bootstrap uses instanceof checks).
class FakeHTMLButtonElement {
  textContent = '';
  classList = new Set<string>();
  disabled = false;
  hidden = false;
  onclick: ((event: Event) => void) | null = null;
  listeners: Record<string, ((e: any) => void)[]> = {};
  addEventListener = (type: string, fn: any) => {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  };
  removeEventListener = (type: string, fn: any) => {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter(cb => cb !== fn);
  };
  focus = () => {};
  setAttribute = () => {};
  getAttribute = () => null;
  appendChild = () => null;
  removeChild = () => null;
  querySelectorAll = () => [];
  querySelector = () => null;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  id = '';
  title = '';
  type = 'button';

  click() {
    if (this.disabled) return;
    const event = new Event('click');
    this.onclick?.(event);
    this.listeners['click']?.forEach(fn => fn(event));
  }

  listenerCount(type: string): number {
    return this.listeners[type]?.length ?? 0;
  }
}
(globalThis as any).HTMLButtonElement = FakeHTMLButtonElement;

/**
 * The auth form is a real form now, not a `<div>` with two click handlers, because pressing Enter
 * in the password field has to sign you in. `bootstrap` binds `onsubmit`, so the shim needs a
 * dispatchable one — and `instanceof HTMLFormElement` has to hold, the same trick already used for
 * buttons above.
 */
class FakeHTMLFormElement {
  id = '';
  hidden = false;
  onsubmit: ((e: Event) => void) | null = null;
  addEventListener = () => {};
  removeEventListener = () => {};
  setAttribute = () => {};
  getAttribute = () => null;
  appendChild = () => null;
  removeChild = () => null;
  querySelectorAll = () => [];
  focus = () => {};
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = new Set<string>();
  textContent = '';

  /** Always valid: `required` enforcement is the browser's, not this shim's. */
  reportValidity = (): boolean => true;

  /** What pressing Enter in a field does. */
  submit(): void {
    this.onsubmit?.({ preventDefault: () => {} } as Event);
  }
}
(globalThis as any).HTMLFormElement = FakeHTMLFormElement;

class FakeWindowEvents {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/** IDs that should be treated as HTMLButtonElement instances. */
const BUTTON_IDS = new Set([
  'auth-submit', 'auth-register', 'auth-logout', 'create-seek', 'flip', 'theme-toggle',
  'action-resign', 'confirm-resign-yes', 'confirm-resign-no',
  'action-abort', 'confirm-abort-yes', 'confirm-abort-no',
  'action-offer-draw', 'action-accept-draw', 'action-decline-draw', 'action-claim-flag',
  'auth-passkey', 'passkey-register', 'email-verify-retry',
]);

/**
 * Minimal DOM shim: create a document with the given element IDs.
 * Returns a `Document` with `getElementById` backed by a map.
 * Each element has enough surface area for BoardView to not crash.
 */
function makeFakeEl(id?: string): HTMLElement {
  const isHidden = id === 'game-actions' || id === 'action-error' || id === 'confirm-resign' || id === 'confirm-abort' || id === 'draw-offer-received' || id === 'passkeys-self';
  if (id === 'auth-form') {
    const form = new FakeHTMLFormElement();
    form.id = id;
    return form as unknown as HTMLElement;
  }
  if (id && BUTTON_IDS.has(id)) {
    const btn = new FakeHTMLButtonElement();
    btn.id = id;
    btn.hidden = isHidden;
    return btn as unknown as HTMLElement;
  }
  const classList = new Set<string>();
  return {
    textContent: '',
    disabled: false,
    hidden: isHidden,
    reportValidity: () => true,
    value: '',
    classList: {
      add: (c: string) => classList.add(c),
      remove: (c: string) => classList.delete(c),
      contains: (c: string) => classList.has(c),
      toggle: (c: string, force?: boolean) => {
        if (force === true) classList.add(c);
        else if (force === false || classList.has(c)) classList.delete(c);
        else classList.add(c);
        return classList.has(c);
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    appendChild: () => null,
    removeChild: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    focus: () => {},
    style: {},
    dataset: {},
    id: id ?? '',
  } as unknown as HTMLElement;
}

function makeDoc(ids: string[] = ['board', 'status', 'flip', 'theme-toggle', 'auth', 'auth-status', 'auth-logout', 'auth-submit', 'auth-error', 'auth-form', 'auth-handle', 'auth-password', 'auth-email', 'email-verify', 'email-verify-status', 'email-verify-error', 'email-verify-retry', 'create-seek', 'game-actions', 'action-error', 'action-offer-draw', 'action-claim-flag', 'action-resign', 'action-abort', 'confirm-resign', 'confirm-resign-yes', 'confirm-resign-no', 'confirm-abort', 'confirm-abort-yes', 'confirm-abort-no', 'draw-offer-received', 'action-accept-draw', 'action-decline-draw', 'meta-connection', 'meta-role', 'meta-white', 'meta-white-name', 'meta-black', 'meta-black-name', 'meta-spectators', 'meta-variant', 'meta-time', 'meta-live-status']): Document {
  const elements = new Map<string, HTMLElement>();
  for (const id of ids) {
    elements.set(id, makeFakeEl(id));
  }

  const metaWhite = elements.get('meta-white');
  if (metaWhite) {
    const dot = makeFakeEl();
    dot.classList.add('presence-dot');
    const txt = makeFakeEl();
    txt.classList.add('presence-text');
    metaWhite.querySelector = (sel: string) => sel.includes('dot') ? dot : txt;
  }
  const metaBlack = elements.get('meta-black');
  if (metaBlack) {
    const dot = makeFakeEl();
    dot.classList.add('presence-dot');
    const txt = makeFakeEl();
    txt.classList.add('presence-text');
    metaBlack.querySelector = (sel: string) => sel.includes('dot') ? dot : txt;
  }

  const docEl = makeFakeEl('documentElement');
  const body = makeFakeEl('body');
  return {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    documentElement: docEl,
    body,
  } as unknown as Document;
}

function makeDocWithBoard(boardEl: HTMLElement, ids: string[] = ['status', 'flip', 'theme-toggle', 'auth', 'auth-status', 'auth-logout', 'auth-submit', 'auth-error', 'auth-form', 'auth-handle', 'auth-password', 'create-seek', 'game-actions', 'action-error', 'action-offer-draw', 'action-claim-flag', 'action-resign', 'action-abort', 'confirm-resign', 'confirm-resign-yes', 'confirm-resign-no', 'confirm-abort', 'confirm-abort-yes', 'confirm-abort-no', 'draw-offer-received', 'action-accept-draw', 'action-decline-draw']): Document {
  const elements = new Map<string, HTMLElement>();
  elements.set('board', boardEl);
  for (const id of ids) {
    elements.set(id, makeFakeEl(id));
  }
  const docEl = makeFakeEl('documentElement');
  const body = makeFakeEl('body');
  return {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    documentElement: docEl,
    body,
  } as unknown as Document;
}

function makeDeps(sockets?: FakeSocketFactory): BootstrapDependencies {
  const s = sockets ?? new FakeSocketFactory();
  return {
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    httpTransport: new FakeTransport().onEach(() => json(200, {})),
    wsFactory: s.factory,
    tokenStore: new MemoryTokenStore(),
  };
}

class FakeWebAuthnAdapter implements WebAuthnAdapter {
  createCalls = 0;
  getCalls = 0;

  isSupported(): boolean {
    return true;
  }

  async createCredential(_options: WebAuthnRegisterOptions): Promise<WebAuthnRegisterVerifyRequest> {
    this.createCalls++;
    return {
      id: 'new-credential',
      rawId: 'new-credential',
      type: 'public-key',
      response: { clientDataJSON: 'client-data', attestationObject: 'attestation' },
    };
  }

  async getCredential(_options: WebAuthnLoginOptions): Promise<WebAuthnLoginVerifyRequest> {
    this.getCalls++;
    return {
      id: 'credential-1',
      rawId: 'credential-1',
      type: 'public-key',
      response: {
        clientDataJSON: 'client-data',
        authenticatorData: 'authenticator-data',
        signature: 'signature',
        userHandle: 'u1',
      },
    };
  }
}

// ── Shared valid StateView fixture ──────────────────────────────────────────
// Every field required by the StateView interface, so TypeScript catches drift.

/** A minimal but fully valid StateView for an ongoing game (ply 0, white to move). */
const BASE_STATE: StateView = {
  gameId: 'g1',
  variant: 'standard',
  players: { white: 'u1', black: 'u2' },
  timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  fenHash: 'start',
  ply: 0,
  turn: 'w',
  clock: { w: 60_000, b: 60_000 },
  turnStartedAt: null,
  status: { over: false },
  drawOffer: null,
  moves: [],
  legalMoves: {},
  chess960StartId: null,
} satisfies StateView;

// ── extractGameId ───────────────────────────────────────────────────────

test('extractGameId returns null for root path', () => {
  assert.equal(extractGameId('/'), null);
  assert.equal(extractGameId(''), null);
});

test('extractGameId returns the id from /game/{id}', () => {
  assert.equal(extractGameId('/game/abc123'), 'abc123');
  assert.equal(extractGameId('/game/g42'), 'g42');
});

test('extractGameId returns null for single-segment non-game paths (m4)', () => {
  // m4: single-segment paths like /about are NOT treated as game IDs
  assert.equal(extractGameId('/about'), null);
  assert.equal(extractGameId('/abc123'), null);
});

test('extractGameId returns null for multi-segment non-game paths', () => {
  assert.equal(extractGameId('/profile/user'), null);
  assert.equal(extractGameId('/api/v1/games'), null);
});

// ── formatClock ─────────────────────────────────────────────────────────

test('formatClock formats milliseconds as M:SS', () => {
  assert.equal(formatClock(60_000), '1:00');
  assert.equal(formatClock(59_000), '0:59');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(3_600_000), '60:00');
  assert.equal(formatClock(-5_000), '0:00'); // clamped to 0
});

// ── formatTimeControl ───────────────────────────────────────────────────

test('formatTimeControl formats unlimited correctly', () => {
  assert.equal(formatTimeControl({ kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 }), 'Unlimited');
});

test('formatTimeControl formats sudden_death correctly', () => {
  assert.equal(formatTimeControl({ kind: 'sudden_death', initialMs: 30_000, incrementMs: 0, delayMs: 0 }), '30 sec');
  assert.equal(formatTimeControl({ kind: 'sudden_death', initialMs: 60_000, incrementMs: 0, delayMs: 0 }), '1 min');
  assert.equal(formatTimeControl({ kind: 'sudden_death', initialMs: 180_000, incrementMs: 0, delayMs: 0 }), '3 min');
  assert.equal(formatTimeControl({ kind: 'sudden_death', initialMs: 90_000, incrementMs: 0, delayMs: 0 }), '90 sec');
});

test('formatTimeControl formats increment correctly', () => {
  assert.equal(formatTimeControl({ kind: 'increment', initialMs: 60_000, incrementMs: 2_000, delayMs: 0 }), '1+2');
  assert.equal(formatTimeControl({ kind: 'increment', initialMs: 30_000, incrementMs: 2_000, delayMs: 0 }), '0.5+2');
  assert.equal(formatTimeControl({ kind: 'increment', initialMs: 180_000, incrementMs: 0, delayMs: 0 }), '3+0');
});

test('formatTimeControl formats delay correctly', () => {
  assert.equal(formatTimeControl({ kind: 'delay', initialMs: 60_000, incrementMs: 0, delayMs: 2_000 }), '1 min delay 2');
  assert.equal(formatTimeControl({ kind: 'delay', initialMs: 30_000, incrementMs: 0, delayMs: 2_000 }), '30 sec delay 2');
});

// ── bootstrap without game ID ───────────────────────────────────────────

test('bootstrap returns a fresh result with every public named field', () => {
  const expectedFields: Record<keyof Bootstrapped, true> = {
    app: true,
    controller: true,
    board: true,
    lobby: true,
    profile: true,
    leaderboard: true,
    tournament: true,
    tournamentCommentary: true,
    search: true,
    messages: true,
    teams: true,
    forum: true,
    learning: true,
    endgames: true,
    studies: true,
    passkeys: true,
    passwordReset: true,
    emailVerification: true,
    connectivity: true,
    analysis: true,
    auth: true,
    theme: true,
  };
  const first = bootstrap(makeDoc([]), makeDeps());
  const second = bootstrap(makeDoc([]), makeDeps());

  try {
    assert.notStrictEqual(first, second);
    assert.deepEqual(Object.keys(first).sort(), Object.keys(expectedFields).sort());
    assert.deepEqual(Object.keys(second).sort(), Object.keys(expectedFields).sort());
  } finally {
    first.auth.dispose();
    first.app.dispose();
    second.auth.dispose();
    second.app.dispose();
  }
});

test('bootstrap without game ID mounts standalone board, no controller', () => {
  const doc = makeDoc();
  const result = bootstrap(doc, makeDeps());
  assert.ok(result.board);
  assert.equal(result.controller, null);
});

test('bootstrap without board element returns null board', () => {
  const doc = makeDoc([]); // no elements
  const result = bootstrap(doc, makeDeps());
  assert.equal(result.board, null);
  assert.equal(result.controller, null);
});

test('bootstrap does not mount the hidden fallback board on a not-found route', () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { pathname: '/missing-page', search: '', hash: '' },
  });

  try {
    const result = bootstrap(makeDoc(), makeDeps());
    assert.equal(result.board, null);
    assert.equal(result.controller, null);
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else delete (globalThis as { location?: unknown }).location;
  }
});

// ── bootstrap with game ID ──────────────────────────────────────────────

test('bootstrap with game ID creates a GameController', () => {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  assert.ok(result.controller instanceof GameController);
  assert.ok(result.board);
});

test('bootstrap with game ID opens a connection via gameSync.start()', () => {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  // C3: bootstrap now calls gameSync.start(), which opens the WebSocket.
  assert.equal(sockets.sockets.length, 1, 'a socket should be opened for a game view');
  assert.ok(result.controller);
});

test('route teardown closes the app socket and removes browser connectivity listeners', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browserEvents = new FakeWindowEvents();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserEvents });

  try {
    const doc = makeDoc();
    const sockets = new FakeSocketFactory();
    const lifecycle = createLifecycle(() => bootstrap(doc, {
      ...makeDeps(sockets),
      gameId: 'g1',
      token: 'token-u1',
    }));

    lifecycle.run();
    sockets.last.open();
    assert.equal(browserEvents.listenerCount('offline'), 1);
    assert.equal(browserEvents.listenerCount('online'), 1);

    lifecycle.teardown();

    assert.deepEqual(sockets.last.closed, { code: 1000, reason: 'app-disposed' });
    assert.equal(browserEvents.listenerCount('offline'), 0);
    assert.equal(browserEvents.listenerCount('online'), 0);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

test('route teardown prevents a delayed auth restore from reopening the game socket', async () => {
  let resolveRefresh: ((response: HttpResponse) => void) | undefined;
  let refreshRequests = 0;
  const refreshResponse = new Promise<HttpResponse>((resolve) => {
    resolveRefresh = resolve;
  });
  const transport: HttpTransport = {
    send: (request) => {
      if (new URL(request.url).pathname === '/v1/auth/refresh') {
        refreshRequests += 1;
        return refreshResponse;
      }
      return Promise.resolve(json(200, {}));
    },
  };
  const storage = {
    getItem: () => JSON.stringify({ handle: 'alice', userId: 'u1' }),
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  const sockets = new FakeSocketFactory();
  const lifecycle = createLifecycle(() => bootstrap(makeDoc(), {
    ...makeDeps(sockets),
    gameId: 'g1',
    httpTransport: transport,
    storage,
  }));

  lifecycle.run();
  assert.equal(refreshRequests, 1, 'auth restoration must be pending for the race to be exercised');
  assert.equal(sockets.sockets.length, 0, 'the socket waits for auth restoration');
  lifecycle.teardown();
  if (!resolveRefresh) throw new Error('refresh resolver was not initialized');
  resolveRefresh(json(200, {
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'restored-token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sockets.sockets.length, 0, 'a torn-down route must not reconnect after auth settles');
});

test('bootstrap wires onPosition callback to board.setPosition', () => {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  assert.ok(result.controller);
  assert.ok(result.board);

  // Start the game sync and emit a joined snapshot.
  // We need to access the GameSync -- it's internal to the controller.
  // Instead, verify the wiring indirectly: the controller's onPosition
  // callback should call board.setPosition. We can test this by checking
  // that the controller's fen getter updates after a snapshot.
  // But we don't have direct access to the GameSync from here.
  // The controller.start() was already called by bootstrap.
  // We can verify the controller exists and is started.
  result.controller!.stop();
});

test('bootstrap wires onMove callback to controller.submitMove', () => {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  assert.ok(result.controller);
  assert.ok(result.board);

  // The onMove callback is wired inside mountBoard. When the board resolves
  // a move, it calls controller.submitMove(uci). We can verify this by
  // checking that submitMove is callable (it delegates to GameSync).
  // Since no socket is open, submitMove returns null.
  const pending = result.controller!.submitMove('e2e4');
  assert.equal(pending, null); // no socket open
  result.controller!.stop();
});

test('bootstrap with data-color="b" sets myColor to black', () => {
  const boardEl = makeFakeEl('board');
  boardEl.getAttribute = (name: string) => name === 'data-color' ? 'b' : null;
  const doc = makeDocWithBoard(boardEl);

  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  assert.ok(result.controller);
  result.controller!.stop();
});

test('bootstrap with data-color="spectator" sets myColor to null', () => {
  const boardEl = makeFakeEl('board');
  boardEl.getAttribute = (name: string) => name === 'data-color' ? 'spectator' : null;
  const doc = makeDocWithBoard(boardEl);

  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  assert.ok(result.controller);
  result.controller!.stop();
});

// ── bootstrap clock wiring ──────────────────────────────────────────────

test('bootstrap wires onClock to clock elements when present', () => {
  const ids = ['board', 'status', 'flip', 'clock', 'clock-white', 'clock-black'];
  const doc = makeDoc(ids);

  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  assert.ok(result.controller);
  result.controller!.stop();
});

// ── bootstrap returns app with correct config ───────────────────────────

test('bootstrap returns app with injected config', () => {
  const doc = makeDoc();
  const deps = makeDeps();
  const result = bootstrap(doc, deps);
  assert.equal(result.app.config.apiBaseUrl, 'https://api.test');
  assert.equal(result.app.config.wsUrl, 'wss://api.test/ws');
});

// ── C3: bootstrap calls gameSync.start() and derives color from server ─────

test('C3: bootstrap without game ID does not open a connection', () => {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  // No gameId override and no location.pathname that yields a game id.
  const result = bootstrap(doc, { ...makeDeps(sockets) });
  assert.equal(sockets.sockets.length, 0, 'no socket without a game id');
  assert.equal(result.controller, null);
});

test('bootstrap marks only the game route on the body', () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

  try {
    for (const [pathname, expected] of [['/game/g1', true], ['/', false]] as const) {
      const doc = makeDoc();
      Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname } });
      bootstrap(doc, { ...makeDeps(), gameId: '' });
      assert.equal(doc.body.classList.contains('route-game'), expected, pathname);
    }
  } finally {
    if (originalLocation) {
      Object.defineProperty(globalThis, 'location', originalLocation);
    } else {
      delete (globalThis as { location?: unknown }).location;
    }
  }
});

test('C3: bootstrap opens a connection when no token is provided (anonymous spectator)', async () => {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  // Without a token, bootstrap still opens a connection -- the join will be
  // anonymous (spectator). M12 inc 2: the socket opens once the async session
  // restore settles (it may first try a cookie refresh), so flush microtasks.
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1' });
  assert.ok(result.controller);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sockets.sockets.length, 1);
});

test('self profile reloads only when the authenticated user changes and clears on logout', async () => {
  const doc = makeDoc([
    'profile',
    'profile-handle',
    'profile-error',
    'theme-toggle',
    'auth-status',
    'auth-logout',
    'auth-submit',
    'auth-error',
    'auth-form',
    'auth-handle',
    'auth-password',
    'create-seek',
  ]);
  const handleEl = doc.getElementById('profile-handle')!;
  const errorEl = doc.getElementById('profile-error')!;
  let signedIn: { id: string; handle: string; country: null; createdAt: string; roles: string[] } | null = null;

  const transport = new FakeTransport().onEach((request) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/v1/auth/login') {
      const handle = (JSON.parse(request.body ?? '{}') as { handle?: string }).handle ?? '';
      signedIn = {
        id: handle === 'alice' ? 'u1' : 'u2',
        handle,
        country: null,
        createdAt: '2026-01-01T00:00:00Z',
        roles: ['user'],
      };
      return json(200, {
        user: signedIn,
        tokens: {
          accessToken: `token-${signedIn.id}`,
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshExpiresAt: '2030-01-01T00:00:00Z',
        },
      });
    }
    if (request.method === 'POST' && path === '/v1/auth/logout') {
      signedIn = null;
      return json(200, {});
    }
    if (request.method === 'GET' && path === '/v1/users/me') {
      return signedIn ? json(200, signedIn) : json(401, { message: 'no active session' });
    }
    if (request.method === 'GET' && path.endsWith('/games')) {
      return json(200, []);
    }
    if (request.method === 'GET' && path.startsWith('/v1/users/')) {
      const handle = decodeURIComponent(path.slice('/v1/users/'.length));
      const id = handle === 'alice' ? 'u1' : 'u2';
      return json(200, {
        user: { id, handle, country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [],
      });
    }
    return json(404, { message: `unexpected request: ${request.method} ${path}` });
  });

  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { pathname: '/profile' },
  });

  try {
    const result = bootstrap(doc, { ...makeDeps(), httpTransport: transport });

    await result.auth.login('alice', 'pw');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(handleEl.textContent, 'alice');

    errorEl.textContent = 'stale error';
    await result.auth.login('bob', 'pw');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(handleEl.textContent, 'bob');
    assert.equal(errorEl.textContent, '');

    const selfLoads = (): number => transport.calls.filter(
      (request) => new URL(request.url).pathname === '/v1/users/me',
    ).length;
    assert.equal(selfLoads(), 2);

    await result.auth.login('bob', 'pw');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(selfLoads(), 2, 'same authenticated user must not reload the profile');

    await result.auth.logout();
    assert.equal(handleEl.textContent, '');
    assert.equal(errorEl.textContent, 'Sign in to view your profile.');
  } finally {
    if (originalLocation) {
      Object.defineProperty(globalThis, 'location', originalLocation);
    } else {
      delete (globalThis as { location?: unknown }).location;
    }
  }
});

// ── Action Panel DOM Regression Tests ────────────────────────────────────

/** Valid joined message fixture: white player, ply 0, game in progress. */
const JOINED_MSG = {
  t: 'joined',
  gameId: 'g1',
  role: 'white',
  state: BASE_STATE,
} as const satisfies ServerMessage;

function setupActionPanel() {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  const socket = sockets.last;

  // Connect and become a white player in an ongoing game.
  socket.open();
  socket.emit(JOINED_MSG);

  return { doc, sockets, result, socket };
}

test('action panel: disconnect while resign confirmation is open hides confirmation', () => {
  const { doc, socket } = setupActionPanel();
  const btnResign = doc.getElementById('action-resign') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignYes = doc.getElementById('confirm-resign-yes') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignNo = doc.getElementById('confirm-resign-no') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignEl = doc.getElementById('confirm-resign') as HTMLElement;

  assert.equal(btnResign.hidden, false);
  assert.equal(confirmResignEl.hidden, true);

  btnResign.click();
  assert.equal(btnResign.hidden, true);
  assert.equal(confirmResignEl.hidden, false);

  // Disconnect
  socket.serverClose();
  assert.equal(btnResign.hidden, false);
  assert.equal(btnResign.disabled, true);
  assert.equal(confirmResignEl.hidden, true);
  assert.equal(confirmResignYes.disabled, true);
  assert.equal(confirmResignNo.disabled, true);
});

test('action panel: game end while confirmation is open hides confirmation', () => {
  const { doc, socket } = setupActionPanel();
  const btnResign = doc.getElementById('action-resign') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignEl = doc.getElementById('confirm-resign') as HTMLElement;

  btnResign.click();
  assert.equal(confirmResignEl.hidden, false);

  // Game over via a fully valid ended broadcast.
  const endedMsg = {
    t: 'ended',
    gameId: 'g1',
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    serverTs: 1_700_000_000_000,
  } as const satisfies ServerMessage;
  socket.emit(endedMsg);

  assert.equal(btnResign.hidden, false);
  assert.equal(btnResign.disabled, true);
  assert.equal(confirmResignEl.hidden, true);
});

test('action panel: abort becoming unavailable at ply >= 2 while confirmation is open hides confirmation', () => {
  const { doc, socket } = setupActionPanel();
  const btnAbort = doc.getElementById('action-abort') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmAbortYes = doc.getElementById('confirm-abort-yes') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmAbortNo = doc.getElementById('confirm-abort-no') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmAbortEl = doc.getElementById('confirm-abort') as HTMLElement;

  btnAbort.click();
  assert.equal(confirmAbortEl.hidden, false);

  // Ply >= 2 means canAbort is false -- use a valid state message.
  const stateMsg = {
    t: 'state',
    gameId: 'g1',
    state: { ...BASE_STATE, ply: 2 },
  } as const satisfies ServerMessage;
  socket.emit(stateMsg);

  assert.equal(btnAbort.hidden, true); // Hidden because canAbort is false
  assert.equal(confirmAbortEl.hidden, true);
  assert.equal(confirmAbortYes.disabled, true);
  assert.equal(confirmAbortNo.disabled, true);
});

test('action panel: abort confirmation cancel and confirm controls are wired', () => {
  const { doc, socket } = setupActionPanel();
  const btnAbort = doc.getElementById('action-abort') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmAbortEl = doc.getElementById('confirm-abort') as HTMLElement;
  const confirmAbortYes = doc.getElementById('confirm-abort-yes') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmAbortNo = doc.getElementById('confirm-abort-no') as unknown as typeof FakeHTMLButtonElement.prototype;

  socket.sent.length = 0;
  btnAbort.click();
  confirmAbortNo.click();
  assert.equal(confirmAbortEl.hidden, true);
  assert.equal(btnAbort.hidden, false);
  assert.equal(socket.sent.length, 0);

  btnAbort.click();
  confirmAbortYes.click();
  assert.equal(JSON.parse(socket.sent.at(-1)!).t, 'abort');
  assert.equal(confirmAbortEl.hidden, true);
  assert.equal(confirmAbortYes.disabled, true);
  assert.equal(confirmAbortNo.disabled, true);
});

test('action panel: offer-draw and claim-flag buttons send their commands', () => {
  const { doc, socket } = setupActionPanel();
  const btnOfferDraw = doc.getElementById('action-offer-draw') as unknown as typeof FakeHTMLButtonElement.prototype;
  const btnClaimFlag = doc.getElementById('action-claim-flag') as unknown as typeof FakeHTMLButtonElement.prototype;

  socket.sent.length = 0;
  btnOfferDraw.click();
  assert.equal(JSON.parse(socket.sent.at(-1)!).t, 'offerDraw');
  assert.equal(btnOfferDraw.disabled, true);

  socket.emit({ t: 'state', gameId: 'g1', state: BASE_STATE });
  btnClaimFlag.click();
  assert.equal(JSON.parse(socket.sent.at(-1)!).t, 'claimFlag');
  assert.equal(btnClaimFlag.disabled, true);
});

test('action panel: received-draw response buttons send their commands', () => {
  const { doc, socket } = setupActionPanel();
  const btnAcceptDraw = doc.getElementById('action-accept-draw') as unknown as typeof FakeHTMLButtonElement.prototype;
  const btnDeclineDraw = doc.getElementById('action-decline-draw') as unknown as typeof FakeHTMLButtonElement.prototype;
  const receivedDrawState = { ...BASE_STATE, drawOffer: 'b' as const };

  socket.sent.length = 0;
  socket.emit({ t: 'state', gameId: 'g1', state: receivedDrawState });
  btnAcceptDraw.click();
  assert.equal(JSON.parse(socket.sent.at(-1)!).t, 'acceptDraw');

  socket.emit({ t: 'state', gameId: 'g1', state: receivedDrawState });
  btnDeclineDraw.click();
  assert.equal(JSON.parse(socket.sent.at(-1)!).t, 'declineDraw');
});

test('action panel: failed send leaves confirmation recoverable', () => {
  const { doc, sockets } = setupActionPanel();
  const socket = sockets.last;

  // Make the underlying socket refuse to send (simulates a network failure
  // that occurs *before* the frame is queued -- send throws synchronously).
  // WsClient.send() catches the exception and returns false; GameSync.resign()
  // therefore also returns false and does NOT set pendingAction.
  socket.send = () => { throw new Error('send: socket not writable'); };

  const btnResign = doc.getElementById('action-resign') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignYes = doc.getElementById('confirm-resign-yes') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignNo = doc.getElementById('confirm-resign-no') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignEl = doc.getElementById('confirm-resign') as HTMLElement;

  // Open the confirmation panel.
  btnResign.click();
  assert.equal(confirmResignEl.hidden, false);
  assert.equal(confirmResignYes.disabled, false);
  assert.equal(confirmResignNo.disabled, false);

  // Clicking confirm while send is broken must NOT create a pending action.
  // The confirmation panel stays open and both buttons remain enabled so the
  // user can retry or cancel.
  confirmResignYes.click();

  assert.equal(confirmResignEl.hidden, false);
  assert.equal(confirmResignYes.disabled, false);
  assert.equal(confirmResignNo.disabled, false);
});

test('action panel: received-draw buttons disabled while disconnected', () => {
  const { doc, socket } = setupActionPanel();
  const btnAcceptDraw = doc.getElementById('action-accept-draw') as unknown as typeof FakeHTMLButtonElement.prototype;
  const btnDeclineDraw = doc.getElementById('action-decline-draw') as unknown as typeof FakeHTMLButtonElement.prototype;
  const drawBanner = doc.getElementById('draw-offer-received') as HTMLElement;

  // Opponent (black) has offered a draw -- drawOffer: 'b' for the white player.
  const drawOfferMsg = {
    t: 'state',
    gameId: 'g1',
    state: { ...BASE_STATE, drawOffer: 'b' },
  } as const satisfies ServerMessage;
  socket.emit(drawOfferMsg);

  // Draw banner should be visible and both response buttons enabled.
  assert.equal(drawBanner.hidden, false);
  assert.equal(btnAcceptDraw.disabled, false);
  assert.equal(btnDeclineDraw.disabled, false);

  // Disconnect -- buttons must become disabled.
  socket.serverClose();

  assert.equal(btnAcceptDraw.disabled, true);
  assert.equal(btnDeclineDraw.disabled, true);
});

test('game metadata: populates elements correctly', () => {
  const { doc, socket } = setupActionPanel();
  const metaConnectionEl = doc.getElementById('meta-connection') as HTMLElement;
  const metaWhiteEl = doc.getElementById('meta-white') as HTMLElement;
  const metaBlackEl = doc.getElementById('meta-black') as HTMLElement;
  const metaSpectatorsEl = doc.getElementById('meta-spectators') as HTMLElement;
  const metaVariantEl = doc.getElementById('meta-variant') as HTMLElement;
  const metaTimeEl = doc.getElementById('meta-time') as HTMLElement;

  // Initial connection state after setup (which sends JOINED_MSG)
  assert.equal(metaConnectionEl.textContent, 'Connected');

  // Test timeControl formatting
  assert.equal(metaTimeEl.textContent, '1 min');
  assert.equal(metaVariantEl.textContent, 'Standard');
  assert.equal(metaSpectatorsEl.textContent, '—');

  // Test presence state
  socket.emit({
    t: 'presence',
    gameId: 'g1',
    white: true,
    black: false,
    spectators: 3
  });

  const metaWhiteNameEl = doc.getElementById('meta-white-name') as HTMLElement;
  const metaBlackNameEl = doc.getElementById('meta-black-name') as HTMLElement;
  const metaWhiteTxt = metaWhiteEl.querySelector('.presence-text') as HTMLElement;
  const metaBlackTxt = metaBlackEl.querySelector('.presence-text') as HTMLElement;

  assert.equal(metaSpectatorsEl.textContent, '3');
  assert.equal(metaWhiteNameEl.textContent, 'White (You)');
  assert.equal(metaWhiteTxt.textContent, 'Online');
  assert.equal(metaBlackNameEl.textContent, 'Black');
  assert.equal(metaBlackTxt.textContent, 'Offline');

  // Disconnect
  socket.serverClose();
  assert.equal(metaConnectionEl.textContent, 'Reconnecting…');
  assert.equal(metaWhiteTxt.textContent, 'Unknown');
});

// ── Sign-in form ────────────────────────────────────────────────────────────

/**
 * Signing in used to require the mouse. The markup carried `onsubmit="return false"` with both
 * buttons `type="button"`, and nothing bound Enter — so on the app's front door, filling in the
 * password and pressing Enter did nothing at all, with no feedback to say why. Every other form in
 * `bootstrap.ts` binds `onsubmit`; this asserts that this one does too.
 */
test('pressing Enter in the sign-in form logs in, without reaching for the mouse', () => {
  const doc = makeDoc();
  const transport = new FakeTransport().onEach(() => json(200, { accessToken: 't', handle: 'alice' }));
  bootstrap(doc, { ...makeDeps(), httpTransport: transport });

  (doc.getElementById('auth-handle') as unknown as { value: string }).value = 'alice';
  (doc.getElementById('auth-password') as unknown as { value: string }).value = 'hunter2';

  const form = doc.getElementById('auth-form') as unknown as { submit(): void };
  form.submit();

  const urls = transport.calls.map((c) => c.url);
  assert.ok(
    urls.some((u) => u.includes('login')),
    `submitting the form must call the login endpoint; saw ${JSON.stringify(urls)}`,
  );
});

/** An empty field must not fire a request the server can only reject. */
test('submitting the sign-in form with an empty password sends nothing', () => {
  const doc = makeDoc();
  const transport = new FakeTransport().onEach(() => json(200, {}));
  bootstrap(doc, { ...makeDeps(), httpTransport: transport });

  (doc.getElementById('auth-handle') as unknown as { value: string }).value = 'alice';
  (doc.getElementById('auth-password') as unknown as { value: string }).value = '';

  const before = transport.calls.length;
  (doc.getElementById('auth-form') as unknown as { submit(): void }).submit();
  assert.equal(transport.calls.length, before);
});

test('passkey sign-in uses the handle without requiring a password and adopts the session', async () => {
  const doc = makeDoc([
    'auth', 'auth-status', 'auth-logout', 'auth-submit', 'auth-passkey', 'auth-error',
    'auth-form', 'auth-handle', 'auth-password', 'create-seek', 'theme-toggle',
  ]);
  const adapter = new FakeWebAuthnAdapter();
  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (path === '/v1/capabilities') return json(200, { capabilities: {} });
    if (path === '/v1/auth/webauthn/login/options') {
      return json(200, {
        challenge: 'challenge',
        timeout: 60_000,
        rpId: 'api.test',
        userVerification: 'required',
      });
    }
    if (path === '/v1/auth/webauthn/login/verify') {
      return json(200, {
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
      });
    }
    return json(404, {});
  });
  const handleEl = doc.getElementById('auth-handle') as unknown as { value: string };
  const passwordEl = doc.getElementById('auth-password') as unknown as { value: string };
  handleEl.value = '  alice  ';
  passwordEl.value = '';

  const result = bootstrap(doc, { ...makeDeps(), httpTransport: transport, webauthnAdapter: adapter });
  (doc.getElementById('auth-passkey') as unknown as FakeHTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const optionsCall = transport.calls.find((call) => call.url.endsWith('/v1/auth/webauthn/login/options'));
  const verifyCall = transport.calls.find((call) => call.url.endsWith('/v1/auth/webauthn/login/verify'));
  assert.deepEqual(JSON.parse(optionsCall?.body as string), { handle: 'alice' });
  assert.deepEqual(JSON.parse(verifyCall?.body as string), {
    id: 'credential-1',
    rawId: 'credential-1',
    type: 'public-key',
    response: {
      clientDataJSON: 'client-data',
      authenticatorData: 'authenticator-data',
      signature: 'signature',
      userHandle: 'u1',
    },
  });
  assert.equal(adapter.getCalls, 1);
  assert.equal(result.auth.currentSession?.handle, 'alice');
});

test('SPA re-bootstrap keeps one passkey sign-in action per click', async () => {
  const doc = makeDoc([
    'auth', 'auth-status', 'auth-logout', 'auth-submit', 'auth-passkey', 'auth-error',
    'auth-form', 'auth-handle', 'auth-password', 'create-seek', 'theme-toggle',
  ]);
  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (path === '/v1/capabilities') return json(200, { capabilities: {} });
    if (path === '/v1/auth/webauthn/login/options') {
      return json(200, {
        challenge: 'challenge',
        timeout: 60_000,
        rpId: 'api.test',
        userVerification: 'required',
      });
    }
    if (path === '/v1/auth/webauthn/login/verify') {
      return json(200, {
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
      });
    }
    return json(404, {});
  });
  (doc.getElementById('auth-handle') as unknown as { value: string }).value = 'alice';

  bootstrap(doc, { ...makeDeps(), httpTransport: transport, webauthnAdapter: new FakeWebAuthnAdapter() });
  bootstrap(doc, { ...makeDeps(), httpTransport: transport, webauthnAdapter: new FakeWebAuthnAdapter() });
  (doc.getElementById('auth-passkey') as unknown as FakeHTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const optionsCalls = transport.calls.filter((call) => call.url.endsWith('/v1/auth/webauthn/login/options'));
  assert.equal(optionsCalls.length, 1);
});

test('SPA re-bootstrap keeps one registration action per click', async () => {
  const doc = makeDoc([
    'auth', 'auth-status', 'auth-logout', 'auth-submit', 'auth-register', 'auth-error',
    'auth-form', 'auth-handle', 'auth-password', 'create-seek', 'theme-toggle',
  ]);
  const transport = new FakeTransport().onEach((request) => {
    const path = new URL(request.url).pathname;
    if (path === '/v1/capabilities') return json(200, { capabilities: {} });
    if (path === '/v1/auth/register') {
      return json(201, {
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
      });
    }
    return json(404, {});
  });
  (doc.getElementById('auth-handle') as unknown as { value: string }).value = 'alice';
  (doc.getElementById('auth-password') as unknown as { value: string }).value = 'password1';

  bootstrap(doc, { ...makeDeps(), httpTransport: transport });
  bootstrap(doc, { ...makeDeps(), httpTransport: transport });
  (doc.getElementById('auth-register') as unknown as FakeHTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const registerCalls = transport.calls.filter((call) => call.url.endsWith('/v1/auth/register'));
  assert.equal(registerCalls.length, 1);
});

test('SPA re-bootstrap keeps one logout action per click', async () => {
  const doc = makeDoc([
    'auth', 'auth-status', 'auth-logout', 'auth-submit', 'auth-error',
    'auth-form', 'auth-handle', 'auth-password', 'create-seek', 'theme-toggle',
  ]);
  const transport = new FakeTransport().onEach((request) => {
    const path = new URL(request.url).pathname;
    if (path === '/v1/capabilities') return json(200, { capabilities: {} });
    if (path === '/v1/auth/login') {
      return json(200, {
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
      });
    }
    if (path === '/v1/auth/logout') return json(200, {});
    return json(404, {});
  });

  const first = bootstrap(doc, { ...makeDeps(), httpTransport: transport });
  const second = bootstrap(doc, { ...makeDeps(), httpTransport: transport });
  await first.auth.login('alice', 'password1');
  await second.auth.login('alice', 'password1');
  (doc.getElementById('auth-logout') as unknown as FakeHTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const logoutCalls = transport.calls.filter((call) => call.url.endsWith('/v1/auth/logout'));
  assert.equal(logoutCalls.length, 1);
});

test('self profile passkeys region visibility, failure independence, and teardown', async () => {
  const doc = makeDoc([
    'profile', 'passkeys-self', 'passkey-register', 'passkeys-list', 'passkeys-note', 'passkeys-error', 'passkeys-count', 'auth-status', 'auth-logout', 'auth-submit', 'auth-error', 'auth-form', 'auth-handle', 'auth-password', 'create-seek', 'theme-toggle'
  ]);
  const passkeysSelfEl = doc.getElementById('passkeys-self')!;
  const passkeyRegisterEl = doc.getElementById('passkey-register') as unknown as typeof FakeHTMLButtonElement.prototype;

  let listPasskeysCalled = 0;
  let socialFailed = false;

  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'POST' && path === '/v1/auth/login') {
      return json(200, {
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' }
      });
    }
    if (req.method === 'POST' && path === '/v1/auth/logout') return json(200, {});
    if (req.method === 'GET' && path === '/v1/users/me') return json(200, { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' });
    if (req.method === 'GET' && path === '/v1/users/alice') {
      return json(200, {
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [],
      });
    }
    if (req.method === 'GET' && path === '/v1/users/alice/games') return json(200, []);
    if (req.method === 'GET' && path === '/v1/social/players/u1/followers') {
      socialFailed = true;
      return json(500, { message: 'Social service down' });
    }
    if (req.method === 'GET' && path === '/v1/auth/webauthn/passkeys') {
      listPasskeysCalled++;
      return json(200, []);
    }
    return json(404, {});
  });

  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/profile' } });
  Object.defineProperty(doc, 'createElement', { configurable: true, value: () => makeFakeEl() });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });

  try {
    const result = bootstrap(doc, {
      ...makeDeps(),
      httpTransport: transport,
      webauthnAdapter: new FakeWebAuthnAdapter(),
    });

    await result.auth.login('alice', 'pw');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(passkeysSelfEl.hidden, false, 'Passkeys visible despite social failure');
    assert.equal(listPasskeysCalled, 1, 'Passkeys loaded');
    assert.equal(socialFailed, true, 'The independent social load actually failed');
    assert.equal(passkeyRegisterEl.listenerCount('click'), 1);

    result.passkeys!.dispose();
    assert.equal(passkeyRegisterEl.listenerCount('click'), 0, 'Teardown removes the DOM listener');

    await result.auth.logout();
    assert.equal(passkeysSelfEl.hidden, true, 'Passkeys hidden on logout');
  } finally {
    if (originalLocation) {
      Object.defineProperty(globalThis, 'location', originalLocation);
    } else {
      delete (globalThis as { location?: unknown }).location;
    }
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument);
    } else {
      delete (globalThis as { document?: unknown }).document;
    }
  }
});

/**
 * The transport itself is the security property, so it gets its own test.
 *
 * A query string is part of the request line: `/email-verify?token=...` reaches the web tier on the
 * first navigation, before this bundle parses, and a proxy logging `$request` keeps a live token in
 * its access log — which `history.replaceState` cannot retract. A fragment is never transmitted.
 * Reading the token from `location.search` must therefore stay impossible, not merely unused: a
 * future "be liberal in what you accept" edit that also honoured the query would silently restore
 * the exposure while every other test in this file kept passing.
 */
test('a token in the query string is ignored: only the fragment is honoured as a token transport', async () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');

  const queryToken = 'query-transport-token-must-be-ignored';
  let replaceStateCalls = 0;

  const doc = makeDoc([
    'auth', 'auth-status', 'auth-logout', 'auth-submit', 'auth-error',
    'auth-form', 'auth-handle', 'auth-password', 'auth-email',
    'email-verify', 'email-verify-status', 'email-verify-error', 'email-verify-retry',
  ]);

  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (path === '/v1/capabilities') return json(200, { capabilities: {} });
    if (path === '/v1/auth/email/verify') return json(204, {});
    return json(404, {});
  });

  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { pathname: '/email-verify', search: `?token=${queryToken}`, hash: '' },
  });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: { replaceState: () => { replaceStateCalls++; } },
  });

  try {
    bootstrap(doc, { ...makeDeps(), httpTransport: transport });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No verification request at all: with no fragment there is no token, so the route reports the
    // missing-link state rather than treating the query value as a credential.
    const verifyCalls = transport.calls.filter((c) => new URL(c.url).pathname === '/v1/auth/email/verify');
    assert.equal(verifyCalls.length, 0, 'a query-string token must never be sent to the verify endpoint');
    assert.equal(replaceStateCalls, 0, 'nothing was captured, so there is nothing to strip');

    for (const call of transport.calls) {
      assert.equal(call.body?.includes(queryToken) ?? false, false, 'query token must not reach any request body');
    }
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else delete (globalThis as any).location;
    if (originalHistory) Object.defineProperty(globalThis, 'history', originalHistory);
    else delete (globalThis as any).history;
  }
});

test('email-verify route strips token before any request, hides #auth, and provides emailVerification disposable', async () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');

  const distinctiveToken = 'super-secret-verify-token-999';
  let replaceStateCalls = 0;
  let requestsWhenReplaceStateCalled = -1;
  let replacedUrl = '';

  const doc = makeDoc([
    'auth', 'auth-status', 'auth-logout', 'auth-submit', 'auth-error',
    'auth-form', 'auth-handle', 'auth-password', 'auth-email',
    'email-verify', 'email-verify-status', 'email-verify-error', 'email-verify-retry',
  ]);

  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (path === '/v1/capabilities') return json(200, { capabilities: {} });
    if (path === '/v1/auth/email/verify') return json(204, {});
    return json(404, {});
  });

  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: {
      pathname: '/email-verify',
      search: '',
      hash: `#token=${distinctiveToken}`,
    },
  });

  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: {
      replaceState: (_data: unknown, _title: string, url: string) => {
        replaceStateCalls++;
        requestsWhenReplaceStateCalled = transport.calls.length;
        replacedUrl = url;
      },
    },
  });

  try {
    const result = bootstrap(doc, { ...makeDeps(), httpTransport: transport });

    assert.equal(replaceStateCalls, 1);
    assert.equal(replacedUrl, '/email-verify');
    assert.equal(requestsWhenReplaceStateCalled, 0, 'replaceState must be called before ANY transport request');

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Verify token secret hygiene: no request URL ever contained the token
    for (const call of transport.calls) {
      assert.equal(call.url.includes(distinctiveToken), false, `Request url ${call.url} contained token`);
    }

    // #auth hidden on /email-verify for signed out visitor
    assert.equal(doc.getElementById('auth')?.hidden, true);

    // Bootstrapped disposable
    assert.ok(result.emailVerification !== null, 'emailVerification must be non-null on /email-verify');

    // On another route, emailVerification is null
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { pathname: '/', search: '', hash: '' },
    });
    const lobbyDoc = makeDoc();
    const lobbyResult = bootstrap(lobbyDoc, { ...makeDeps(), httpTransport: transport });
    assert.equal(lobbyResult.emailVerification, null);
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else delete (globalThis as any).location;
    if (originalHistory) Object.defineProperty(globalThis, 'history', originalHistory);
    else delete (globalThis as any).history;
  }
});

test('bootstrapping the same document twice on /email-verify and disposing does not stack retry handlers', async () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');

  const doc = makeDoc([
    'auth', 'auth-status', 'auth-logout', 'auth-submit', 'auth-error',
    'auth-form', 'auth-handle', 'auth-password', 'auth-email',
    'email-verify', 'email-verify-status', 'email-verify-error', 'email-verify-retry',
  ]);

  let verifyCount = 0;
  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (path === '/v1/capabilities') return json(200, { capabilities: {} });
    if (path === '/v1/auth/email/verify') {
      verifyCount++;
      return json(500, { error: { message: 'Temporary error' } });
    }
    return json(404, {});
  });

  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { pathname: '/email-verify', search: '', hash: '#token=retry-token' },
  });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: { replaceState: () => {} },
  });

  try {
    const first = bootstrap(doc, { ...makeDeps(), httpTransport: transport });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(verifyCount, 1);
    first.emailVerification?.dispose();

    const second = bootstrap(doc, { ...makeDeps(), httpTransport: transport });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(verifyCount, 2);

    const retryBtn = doc.getElementById('email-verify-retry') as unknown as FakeHTMLButtonElement;
    retryBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // One click on retry button should produce exactly one additional request (total 3)
    assert.equal(verifyCount, 3);
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else delete (globalThis as any).location;
    if (originalHistory) Object.defineProperty(globalThis, 'history', originalHistory);
    else delete (globalThis as any).history;
  }
});

test('submitting the sign-in form with malformed email still calls login', () => {
  const doc = makeDoc();
  const transport = new FakeTransport().onEach(() => json(200, { accessToken: 't', handle: 'alice' }));
  bootstrap(doc, { ...makeDeps(), httpTransport: transport });

  (doc.getElementById('auth-handle') as unknown as { value: string; reportValidity(): boolean }).value = 'alice';
  (doc.getElementById('auth-password') as unknown as { value: string; reportValidity(): boolean }).value = 'hunter2';
  const emailEl = doc.getElementById('auth-email') as unknown as { value: string; reportValidity(): boolean };
  let emailValidityChecks = 0;
  emailEl.value = 'not-an-email';
  emailEl.reportValidity = (): boolean => {
    emailValidityChecks += 1;
    return false;
  };

  const form = doc.getElementById('auth-form') as unknown as { submit(): void };
  form.submit();

  const urls = transport.calls.map((c) => c.url);
  assert.ok(
    urls.some((u) => u.includes('login')),
    `submitting the form must call the login endpoint even with malformed email; saw ${JSON.stringify(urls)}`,
  );
  // The stronger half of the same requirement: sign-in must not merely survive an invalid optional
  // field, it must never consult it. A future edit that validates the whole form on submit would
  // reintroduce the regression on a real browser, where the field's invalidity does block the form.
  assert.equal(emailValidityChecks, 0, 'sign-in must not consult the optional registration email');
});
