import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';
import type { AuthSession } from '../src/app/auth-controller.js';
import type { AuthResponse } from '../src/api/models.js';

class FakeElement {
  textContent = '';
  classList = new Set<string>();
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  type = 'button';
  id = '';
  focused = false;
  onclick: ((event: Event) => void) | null = null;
  readonly listeners: Record<string, ((e: any) => void)[]> = {};
  readonly children: FakeElement[] = [];

  constructor(id: string = '') {
    this.id = id;
  }

  addEventListener = (type: string, fn: any) => {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  };

  removeEventListener = (type: string, fn: any) => {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((cb) => cb !== fn);
  };

  focus = () => {
    this.focused = true;
  };

  setAttribute = () => {};
  getAttribute = () => null;

  appendChild = (child: FakeElement) => {
    this.children.push(child);
    return child;
  };

  removeChild = (child: FakeElement) => {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    return child;
  };

  querySelectorAll = () => [];
  querySelector = () => null;
  style: Record<string, string> = {};

  click() {
    if (this.disabled) return;
    const event = new Event('click');
    this.onclick?.(event);
    this.listeners['click']?.forEach((fn) => fn(event));
  }
}

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

  dispatchEvent(event: Event): boolean {
    const listeners = this.listeners.get(event.type);
    if (listeners) {
      for (const fn of listeners) {
        fn(event);
      }
    }
    return true;
  }
}

const GAME_ELEMENT_IDS = [
  'board',
  'status',
  'flip',
  'clock',
  'clock-white',
  'clock-black',
  'meta-connection',
  'meta-role',
  'meta-white',
  'meta-white-name',
  'meta-black',
  'meta-black-name',
  'meta-spectators',
  'meta-variant',
  'meta-time',
  'meta-live-status',
  'game-actions',
  'action-error',
  'action-offer-draw',
  'action-claim-flag',
  'action-resign',
  'action-abort',
  'confirm-resign',
  'confirm-resign-yes',
  'confirm-resign-no',
  'confirm-abort',
  'confirm-abort-yes',
  'confirm-abort-no',
  'draw-offer-received',
  'action-accept-draw',
  'action-decline-draw',
  'analysis',
  'analysis-heading',
  'analysis-run',
  'analysis-lines',
  'analysis-note',
  'analysis-error',
  'analysis-results',
  'analysis-reached',
  'analysis-limits',
] as const;

function createGameDocument(): {
  readonly doc: Document;
  readonly elements: Map<string, FakeElement>;
} {
  const elements = new Map<string, FakeElement>();
  for (const id of GAME_ELEMENT_IDS) {
    const el = new FakeElement(id);
    if (
      id === 'game-actions' ||
      id === 'action-error' ||
      id === 'confirm-resign' ||
      id === 'confirm-abort' ||
      id === 'draw-offer-received' ||
      id === 'analysis' ||
      id === 'analysis-error' ||
      id === 'analysis-reached' ||
      id === 'analysis-limits'
    ) {
      el.hidden = true;
    }
    elements.set(id, el);
  }

  const doc = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => new FakeElement(),
  } as unknown as Document;

  return { doc, elements };
}

function createTestApp(sockets: FakeSocketFactory, transport?: FakeTransport) {
  return createApp({
    config: {
      apiBaseUrl: 'https://api.test',
      wsUrl: 'wss://api.test/ws',
    },
    wsFactory: sockets.factory,
    httpTransport: transport ?? new FakeTransport(() => json(200, {})),
  });
}

function gameServices(app: ReturnType<typeof createTestApp>) {
  return {
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    i18n: app.i18n,
  };
}

test('mountGame opens WebSocket immediately when token is provided', () => {
  const sockets = new FakeSocketFactory();
  const app = createTestApp(sockets);
  const { doc, elements } = createGameDocument();
  const boardEl = elements.get('board')! as unknown as HTMLElement;

  const mounted = mountGame({
    doc,
    boardEl,
    gameId: 'g-test-1',
    ...gameServices(app),
    token: 'test-token',
    restorePromise: Promise.resolve(null),
  });

  assert.equal(sockets.sockets.length, 1);
  sockets.last.open();
  assert.deepEqual(sockets.last.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.t === 'join'), {
    t: 'join',
    gameId: 'g-test-1',
    token: 'test-token',
  });
  assert.ok(mounted.board);
  assert.ok(mounted.controller);
  assert.ok(mounted.connectivity);
  mounted.controller.dispose();
  mounted.board.dispose();
  mounted.connectivity.dispose();
  app.dispose();
});

test('mountGame waits for restorePromise when token is omitted and starts spectator or authenticated socket', async () => {
  const sockets = new FakeSocketFactory();
  const app = createTestApp(sockets);
  const { doc, elements } = createGameDocument();
  const boardEl = elements.get('board')! as unknown as HTMLElement;

  let resolveRestore!: (session: AuthSession | null) => void;
  const restorePromise = new Promise<AuthSession | null>((resolve) => {
    resolveRestore = resolve;
  });

  const mounted = mountGame({
    doc,
    boardEl,
    gameId: 'g-test-2',
    ...gameServices(app),
    restorePromise,
  });

  assert.equal(sockets.sockets.length, 0);

  const authResponse: AuthResponse = {
    user: {
      id: 'u1',
      handle: 'player1',
      country: null,
      createdAt: '2026-01-01T00:00:00Z',
      roles: ['user'],
    },
    tokens: {
      accessToken: 'restored-token',
      tokenType: 'Bearer',
      expiresIn: 300,
      refreshExpiresAt: '2026-01-01T01:00:00Z',
    },
  };
  app.api.session.adopt(authResponse);
  resolveRestore({ handle: 'player1', userId: 'u1' });

  await restorePromise;
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sockets.sockets.length, 1);
  sockets.last.open();
  assert.deepEqual(sockets.last.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.t === 'join'), {
    t: 'join',
    gameId: 'g-test-2',
    token: 'restored-token',
  });
  mounted.controller.dispose();
  mounted.board.dispose();
  mounted.connectivity.dispose();
  app.dispose();
});

test('mountGame starts socket even if restorePromise rejects', async () => {
  const sockets = new FakeSocketFactory();
  const app = createTestApp(sockets);
  const { doc, elements } = createGameDocument();
  const boardEl = elements.get('board')! as unknown as HTMLElement;

  let rejectRestore!: (err: Error) => void;
  const restorePromise = new Promise<AuthSession | null>((_, reject) => {
    rejectRestore = reject;
  });

  const mounted = mountGame({
    doc,
    boardEl,
    gameId: 'g-test-3',
    ...gameServices(app),
    restorePromise,
  });

  assert.equal(sockets.sockets.length, 0);

  rejectRestore(new Error('session expired'));

  await restorePromise.catch(() => null);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sockets.sockets.length, 1);
  sockets.last.open();
  assert.deepEqual(sockets.last.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.t === 'join'), {
    t: 'join',
    gameId: 'g-test-3',
  });
  mounted.controller.dispose();
  mounted.board.dispose();
  mounted.connectivity.dispose();
  app.dispose();
});

test('disposing connectivity before restorePromise settles prevents delayed socket start', async () => {
  const sockets = new FakeSocketFactory();
  const app = createTestApp(sockets);
  const { doc, elements } = createGameDocument();
  const boardEl = elements.get('board')! as unknown as HTMLElement;

  let resolveRestore!: (session: AuthSession | null) => void;
  const restorePromise = new Promise<AuthSession | null>((resolve) => {
    resolveRestore = resolve;
  });

  const mounted = mountGame({
    doc,
    boardEl,
    gameId: 'g-test-4',
    ...gameServices(app),
    restorePromise,
  });

  assert.equal(sockets.sockets.length, 0);

  mounted.connectivity.dispose();

  resolveRestore(null);
  await restorePromise;
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sockets.sockets.length, 0);
  mounted.controller.dispose();
  mounted.board.dispose();
  app.dispose();
});

test('connectivity registers and unregisters window online and offline listeners', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browserEvents = new FakeWindowEvents();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserEvents });

  try {
    const sockets = new FakeSocketFactory();
    const app = createTestApp(sockets);
    const { doc, elements } = createGameDocument();
    const boardEl = elements.get('board')! as unknown as HTMLElement;

    const mounted = mountGame({
      doc,
      boardEl,
      gameId: 'g-test-5',
      ...gameServices(app),
      token: 'tok-5',
      restorePromise: Promise.resolve(null),
    });

    assert.equal(browserEvents.listenerCount('offline'), 1);
    assert.equal(browserEvents.listenerCount('online'), 1);

    sockets.last.open();
    browserEvents.dispatchEvent(new Event('offline'));
    assert.deepEqual(sockets.last.closed, { code: 4001, reason: 'network-offline' });

    browserEvents.dispatchEvent(new Event('online'));
    assert.equal(sockets.sockets.length, 2, 'online retries without waiting for reconnect backoff');

    mounted.connectivity.dispose();

    assert.equal(browserEvents.listenerCount('offline'), 0);
    assert.equal(browserEvents.listenerCount('online'), 0);

    mounted.controller.dispose();
    mounted.board.dispose();
    app.dispose();
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
});

test('action buttons and confirmations wiring and focus behavior', () => {
  const sockets = new FakeSocketFactory();
  const app = createTestApp(sockets);
  const { doc, elements } = createGameDocument();
  const boardEl = elements.get('board')! as unknown as HTMLElement;

  const mounted = mountGame({
    doc,
    boardEl,
    gameId: 'g-test-6',
    ...gameServices(app),
    token: 'tok-6',
    restorePromise: Promise.resolve(null),
  });

  const btnResign = elements.get('action-resign')!;
  const confirmResign = elements.get('confirm-resign')!;
  const confirmResignYes = elements.get('confirm-resign-yes')!;
  const confirmResignNo = elements.get('confirm-resign-no')!;

  btnResign.click();
  assert.equal(btnResign.hidden, true);
  assert.equal(confirmResign.hidden, false);
  assert.equal(confirmResignYes.disabled, false);
  assert.equal(confirmResignNo.disabled, false);
  assert.equal(confirmResignYes.focused, true);

  confirmResignNo.click();
  assert.equal(confirmResign.hidden, true);
  assert.equal(btnResign.hidden, false);
  assert.equal(btnResign.focused, true);

  const btnAbort = elements.get('action-abort')!;
  const confirmAbort = elements.get('confirm-abort')!;
  const confirmAbortYes = elements.get('confirm-abort-yes')!;
  const confirmAbortNo = elements.get('confirm-abort-no')!;

  btnAbort.click();
  assert.equal(btnAbort.hidden, true);
  assert.equal(confirmAbort.hidden, false);
  assert.equal(confirmAbortYes.disabled, false);
  assert.equal(confirmAbortNo.disabled, false);
  assert.equal(confirmAbortYes.focused, true);

  confirmAbortNo.click();
  assert.equal(confirmAbort.hidden, true);
  assert.equal(btnAbort.hidden, false);
  assert.equal(btnAbort.focused, true);

  mounted.controller.dispose();
  mounted.board.dispose();
  mounted.connectivity.dispose();
  app.dispose();
});

test('disposing and remounting does not stack persistent game action handlers', () => {
  const sockets = new FakeSocketFactory();
  const { doc, elements } = createGameDocument();
  const boardEl = elements.get('board')! as unknown as HTMLElement;

  const firstApp = createTestApp(sockets);
  const first = mountGame({
    doc,
    boardEl,
    gameId: 'g-test-first',
    ...gameServices(firstApp),
    token: 'tok-first',
    restorePromise: Promise.resolve(null),
  });
  let firstCalls = 0;
  first.controller.offerDraw = (): boolean => {
    firstCalls += 1;
    return true;
  };
  first.controller.dispose();
  first.board.dispose();
  first.connectivity.dispose();
  firstApp.dispose();

  const secondApp = createTestApp(sockets);
  const second = mountGame({
    doc,
    boardEl,
    gameId: 'g-test-second',
    ...gameServices(secondApp),
    token: 'tok-second',
    restorePromise: Promise.resolve(null),
  });
  let secondCalls = 0;
  second.controller.offerDraw = (): boolean => {
    secondCalls += 1;
    return true;
  };

  elements.get('action-offer-draw')!.click();

  assert.equal(firstCalls, 0, 'the disposed route must not retain its click handler');
  assert.equal(secondCalls, 1, 'the active route owns exactly one click handler');

  second.controller.dispose();
  second.board.dispose();
  second.connectivity.dispose();
  secondApp.dispose();
});
