import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { GameSync } from '../src/net/game-sync.js';
import { SessionManager } from '../src/net/session.js';
import { NetworkError } from '../src/net/errors.js';
import type { AuthResponse } from '../src/api/models.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';
import { createGameDocument, makeState } from './support/analysis-fixtures.js';

test('exhausted refresh recovery exposes a localized retry that restores the player and preserves focus', async () => {
  const sockets = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  let now = 0;
  let recovered = false;
  const auth = (token: string): AuthResponse => ({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2020-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: token, tokenType: 'Bearer', expiresIn: 60, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  const session = new SessionManager({ now: () => now, channel: null, refresh: async () => {
    if (!recovered) throw new NetworkError();
    return auth('fresh-token');
  } });
  session.adopt(auth('initial-token'), false);
  const app = createApp({ config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory, httpTransport: new FakeTransport(() => json(200, { capabilities: {} })) });
  const client = Object.create(app.api) as typeof app.api;
  Object.defineProperty(client, 'session', { value: session });
  const { doc, elements } = createGameDocument();
  const mounted = mountGame({ doc, boardEl: elements.get('board')! as unknown as HTMLElement,
    gameId: 'g-test-1', client, token: 'initial-token', restorePromise: Promise.resolve(null), i18n: app.i18n,
    getAccessToken: () => session.current?.tokens.accessToken,
    createGameSync: (options) => new GameSync(app.ws, { ...options, scheduler }), createGameOracle: app.createGameOracle });
  const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
  try {
    const state = makeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    sockets.last.open(); sockets.last.emit({ t: 'joined', gameId: 'g-test-1', role: 'white', state });
    now = 60_000; app.ws.networkOffline(); app.ws.reconnectNow(); sockets.last.open(); await flush();
    for (let attempt = 0; attempt < 3; attempt++) { now += 30_000; scheduler.runNext(); await flush(); }
    const button = elements.get('game-reconnect')!;
    assert.equal(button.hidden, false);
    assert.equal(elements.get('meta-connection')!.textContent, 'Unable to connect');
    assert.equal(button.textContent, 'Try again');
    app.i18n.setLocale('ar');
    assert.equal(elements.get('meta-connection')!.textContent, 'تعذر الاتصال');
    assert.equal(button.textContent, app.i18n.t('emailVerification.retry'));
    Object.defineProperty(doc, 'activeElement', { configurable: true, value: button });
    recovered = true; now += 30_000; button.click(); await flush();
    assert.equal(button.hidden, true);
    assert.equal(elements.get('status')!.focused, true);
    assert.equal(sockets.last.sent.filter((frame) => JSON.parse(frame).t === 'join').length, 1);
    sockets.last.emit({ t: 'joined', gameId: 'g-test-1', role: 'white', state });
    assert.equal(elements.get('meta-connection')!.textContent, app.i18n.t('game.connection.connected'));
  } finally {
    mounted.dispose?.(); mounted.controller.dispose(); mounted.board.dispose(); mounted.connectivity.dispose();
    mounted.analysis.dispose(); app.dispose(); session.dispose();
  }
  assert.equal(elements.get('game-reconnect')!.listeners['click']?.length, 0);
});
