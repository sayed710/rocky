import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessTokenService } from '@chess-platform/api';
import { GameAuthority, InMemoryPubSub, InMemoryConnection, RealtimeGateway } from '@chess-platform/realtime-gateway';
import { GameSync } from '../src/net/game-sync.js';
import { WsClient } from '../src/net/ws-client.js';
import { MemoryTokenStore, SessionManager } from '../src/net/session.js';
import type { SessionChannel } from '../src/net/session.js';
import type { AuthResponse } from '../src/api/models.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';
import { NetworkError, httpErrorFrom } from '../src/net/errors.js';

const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

async function harness(anonymous = false) {
  let now = 1_000;
  let serverNow: number | null = null;
  let sequence = 0;
  let refreshes = 0;
  let doRefresh: (() => Promise<AuthResponse>) | undefined;
  const tokens = new AccessTokenService({ secret: 'test-only-secret-with-at-least-32-bytes', ttlSec: 60,
    clock: { now: () => serverNow ?? now }, ids: { next: () => String(++sequence) } });
  const issue = (userId = 'alice'): AuthResponse => ({
    user: { id: userId, handle: userId, country: null, createdAt: '2020-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: tokens.issue({ userId, handle: userId, roles: ['user'] }).token,
      tokenType: 'Bearer', expiresIn: 60, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  const channel: SessionChannel = { onmessage: null, postMessage: () => {}, close: () => {} };
  const session = new SessionManager({ store: new MemoryTokenStore(), now: () => now,
    expiryLeewayMs: 5_000, channel,
    refresh: async () => { refreshes++; return doRefresh ? doRefresh() : issue(); } });
  const tokenA = issue();
  if (!anonymous) session.adopt(tokenA, false);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => now);
  await authority.createGame({ gameId: 'g1', players: { white: 'alice', black: 'bob' }, rated: false,
    timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' } });
  const gateway = new RealtimeGateway(authority, pubsub, { verify: (token) => {
    const identity = tokens.identify(token); return identity ? { userId: identity.userId } : null;
  } }, () => now);
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  const client = new WsClient({ url: 'wss://example.test/ws', factory: factory.factory, scheduler,
    heartbeatMs: 0, reconnect: { baseDelayMs: 10, jitter: 'none' } });
  const sync = new GameSync(client, { gameId: 'g1', session, scheduler,
    ...(!anonymous ? { token: tokenA.tokens.accessToken } : {}) });
  let serverConnection: InMemoryConnection | null = null;
  const exchange = (): InMemoryConnection => {
    const connection = new InMemoryConnection();
    serverConnection = connection;
    gateway.handleConnection(connection);
    for (const frame of factory.last.sent) connection.deliver(JSON.parse(frame));
    for (const frame of connection.sent) factory.last.emit(frame);
    return connection;
  };
  sync.start(); factory.last.open(); await flush();
  const first = exchange();
  assert.equal(first.last('joined')?.role, anonymous ? 'spectator' : 'white', 'initial server-assigned role');
  return { session, sync, factory, scheduler, client, tokens, tokenA, issue, exchange, first,
    closeServer: () => serverConnection?.close(),
    peerAdopt: (auth: AuthResponse) => channel.onmessage?.({ data: { type: 'session_adopted', auth } } as MessageEvent),
    refreshes: () => refreshes, advance: (ms: number) => { now += ms; },
    expireOnServerOnly: () => { serverNow = now + 60_000; },
    setRefresh: (callback: () => Promise<AuthResponse>) => { doRefresh = callback; },
    reconnect: async () => {
      serverConnection?.close(); serverConnection = null;
      factory.last.serverClose(); scheduler.runNext(); factory.last.open(); await flush();
    } };
}

test('R-04 control: reconnect before token expiry restores the player without refresh', async () => {
  const h = await harness();
  try {
    h.advance(10_000); await h.reconnect();
    assert.equal(h.exchange().last('joined')?.role, 'white');
    assert.equal(h.refreshes(), 0);
  } finally { dispose(h); }
});

test('server-expired but locally fresh token is refreshed before explicit recovery rejoin', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  h.expireOnServerOnly();
  assert.equal(h.session.isAccessTokenExpired(), false, 'browser still considers the token fresh');
  await h.reconnect();
  assert.equal(h.exchange().last('reject')?.code, 'unauthorized', 'real verifier rejects server-expired token');
  h.closeServer(); h.sync.networkOnline(); h.factory.last.open(); await flush();
  assert.equal(h.refreshes(), 1);
  assert.equal(h.exchange().last('joined')?.role, 'white');
});

test('server-rejected fresh credentials retain identity during refresh backoff without resending the token', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  await h.reconnect();
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'unauthorized', message: 'rejected' });
  h.setRefresh(async () => { throw new NetworkError(); });
  h.sync.networkOnline(); h.factory.last.open(); await flush();
  assert.equal(h.refreshes(), 1);
  assert.equal(h.factory.last.sent.length, 0);
  assert.equal(h.session.current?.user.id, 'alice');
  h.sync.networkOnline(); await flush();
  assert.equal(h.refreshes(), 1, 'explicit retry cannot bypass manager cooldown');
  h.advance(10_000); h.setRefresh(async () => h.issue());
  h.scheduler.runNext(); await flush();
  assert.equal(h.exchange().last('joined')?.role, 'white');
});

test('refresh returning a previously rejected token cannot resend it or create an unbounded loop', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  await h.reconnect();
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'unauthorized', message: 'rejected' });
  h.setRefresh(async () => h.tokenA);
  h.sync.networkOnline(); h.factory.last.open(); await flush();
  for (let attempt = 0; attempt < 3; attempt++) { h.advance(4_000); h.scheduler.runNext(); await flush(); }
  assert.equal(h.refreshes(), 4);
  assert.equal(h.scheduler.pending, 0);
  assert.equal(h.factory.last.sent.length, 0);
  assert.equal(h.sync.getState().recoveryAvailable, true);
  assert.equal(h.session.current?.user.id, 'alice');
});

test('R-04: mounted game reconnect after expiry obtains a current token and restores the player', async () => {
  const h = await harness();
  try {
    h.advance(60_000);
    assert.deepEqual(h.tokens.verify(h.tokenA.tokens.accessToken), { ok: false, reason: 'expired' });
    await h.reconnect();
    const connection = h.exchange();
    assert.equal(connection.last('joined')?.role, 'white',
      `gateway rejected reconnect: ${connection.last('reject')?.code}`);
    assert.equal(h.refreshes(), 1);
  } finally { dispose(h); }
});

function dispose(h: Awaited<ReturnType<typeof harness>>): void {
  h.closeServer(); h.sync.stop(); h.client.close(); h.session.dispose();
}

function unknownMove(h: Awaited<ReturnType<typeof harness>>, requestId = 'original-move'): void {
  const pending = h.sync.submitMove('e2e4');
  assert.ok(pending);
  h.factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1',
    ref: pending.clientSeq, requestId, message: `Unknown ${requestId}.` });
}

function assertNoReplay(h: Awaited<ReturnType<typeof harness>>): void {
  const commands = h.factory.sockets.flatMap((socket) => socket.sent.map((frame) => JSON.parse(frame)))
    .filter((frame) => frame.t === 'move' || frame.t === 'offerDraw');
  assert.equal(commands.length, 1, 'only the original gesture may send a command');
}

test('R-03 + R-04: expiry refresh retains uncertainty, gates commands and accepts exact late confirmation', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  unknownMove(h);
  const obsolete = h.factory.last;
  let release!: (auth: AuthResponse) => void;
  h.setRefresh(() => new Promise((resolve) => { release = resolve; }));
  h.advance(60_000); await h.reconnect();
  assert.equal(h.sync.getState().connected, false);
  assert.equal(h.sync.submitMove('d2d4'), null);
  assert.equal(h.sync.offerDraw(), false);
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown');
  obsolete.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'original-move' });
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown', 'obsolete socket cannot settle the request');
  release(h.issue()); await flush();
  assert.equal(h.sync.getState().connected, false, 'refresh alone does not authorize');
  assert.equal(h.exchange().last('joined')?.role, 'white');
  assert.equal(h.sync.getState().connected, true);
  assert.equal(h.sync.getState().pending, null);
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown', 'unchanged authorized snapshot is not a receipt');
  h.factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'unrelated' });
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown');
  h.factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'original-move' });
  assert.equal(h.sync.getState().lastReject, null);
  assert.equal(h.refreshes(), 1);
  assertNoReplay(h);
});

test('R-03 + R-04: fresh reconnect preserves multiple unknown outcomes and refusal ordering', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  assert.equal(h.sync.offerDraw(), true);
  for (const requestId of ['draw-first', 'draw-second']) h.factory.last.emit({ t: 'outcomeUnknown',
    code: 'outcome_unknown', gameId: 'g1', ref: null, requestId, action: 'offerDraw', message: 'Unknown draw.' });
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'invalid_command', message: 'New gesture refused.' });
  h.advance(10_000); await h.reconnect(); h.exchange();
  assert.match(h.sync.getState().lastReject?.message ?? '', /2 command outcomes remain unknown/);
  assert.match(h.sync.getState().lastReject?.message ?? '', /New gesture refused/);
  h.factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'draw-second' });
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown');
  h.factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'draw-first' });
  assert.equal(h.sync.getState().lastReject?.t, 'reject');
  assert.equal(h.refreshes(), 0);
  assertNoReplay(h);
});

test('R-03 + R-04: rejected reconnect retains uncertainty alongside authentication refusal', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  unknownMove(h);
  h.expireOnServerOnly(); await h.reconnect();
  assert.equal(h.exchange().last('reject')?.code, 'unauthorized');
  assert.equal(h.sync.getState().connected, false);
  assert.equal(h.sync.getState().myColor, null);
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.match(h.sync.getState().lastReject?.message ?? '', /Latest command rejected/);
  assert.equal(h.sync.submitMove('d2d4'), null);
  h.closeServer(); h.sync.networkOnline(); h.factory.last.open(); await flush();
  assert.equal(h.exchange().last('joined')?.role, 'white');
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown');
  assertNoReplay(h);
});

for (const boundary of ['logout', 'account switch'] as const) {
  test(`R-03 + R-04: ${boundary} during uncertain-command refresh cannot restore old privileges or replay`, async (t) => {
    const h = await harness(); t.after(() => dispose(h));
    unknownMove(h);
    let release!: (auth: AuthResponse) => void;
    h.setRefresh(() => new Promise((resolve) => { release = resolve; }));
    h.advance(60_000); await h.reconnect();
    const obsolete = h.factory.last;
    h.sync.logoutRequested();
    assert.equal(h.sync.submitMove('d2d4'), null);
    assert.equal(h.sync.getState().myColor, null);
    if (boundary === 'logout') h.session.reset();
    else h.session.adopt(h.issue('bob'), false);
    h.sync.sessionChanged(boundary === 'logout' ? null : 'bob');
    h.factory.last.open(); await flush();
    release(h.issue()); await flush();
    obsolete.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'original-move' });
    assert.equal(h.sync.getState().connected, false, 'old completion does not authorize');
    assert.equal(h.exchange().last('joined')?.role, boundary === 'logout' ? 'spectator' : 'black');
    assert.equal(h.sync.getState().myColor, boundary === 'logout' ? null : 'b');
    assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown');
    h.factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'original-move' });
    assert.equal(h.sync.getState().lastReject, null);
    assertNoReplay(h);
  });
}

test('R-03 + R-04: transient refresh retains unknown outcomes until recovery without anonymous fallback', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  unknownMove(h);
  h.setRefresh(async () => { throw new NetworkError(); });
  h.advance(60_000); await h.reconnect();
  assert.equal(h.factory.last.sent.length, 0);
  assert.equal(h.session.current?.user.id, 'alice');
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown');
  h.advance(10_000); h.setRefresh(async () => h.issue());
  h.scheduler.runNext(); await flush(); h.exchange();
  assert.equal(h.sync.getState().role, 'white');
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown');
  assertNoReplay(h);
});

test('R-03 + R-04: switched seat readiness cannot reconcile the original seat request', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  h.factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: null,
    requestId: 'original-white-ready', action: 'ready', readyColor: 'w', message: 'Unknown readiness.' });
  h.session.adopt(h.issue('bob'), false); h.sync.sessionChanged('bob');
  h.closeServer(); h.factory.last.open(); await flush();
  assert.equal(h.exchange().last('joined')?.role, 'black');
  h.factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: false, b: true }, serverTs: 1 });
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown');
  h.factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: true, b: true }, serverTs: 2 });
  assert.equal(h.sync.getState().lastReject, null);
  const commands = h.factory.sockets.flatMap((socket) => socket.sent.map((frame) => JSON.parse(frame)))
    .filter((frame) => ['move', 'offerDraw', 'ready'].includes(frame.t));
  assert.equal(commands.length, 0, 'reconciliation never manufactures a command');
});

test('near-expiry reconnect uses proactive session leeway', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  h.advance(55_000); await h.reconnect();
  assert.equal(h.exchange().last('joined')?.role, 'white');
  assert.equal(h.refreshes(), 1);
});

test('repeated socket opens share refresh with authenticated requests and only join the current socket', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  let release!: (auth: AuthResponse) => void;
  h.setRefresh(() => new Promise((resolve) => { release = resolve; }));
  h.advance(60_000); await h.reconnect();
  const obsolete = h.factory.last;
  const request = h.session.validAccessToken();
  await h.reconnect(); h.factory.last.open();
  assert.equal(h.refreshes(), 1);
  assert.equal(h.factory.last.sent.length, 0);
  release(h.issue()); await request; await flush();
  assert.equal(obsolete.sent.length, 0);
  assert.equal(h.factory.last.sent.filter((frame) => JSON.parse(frame).t === 'join').length, 1);
  assert.equal(h.exchange().last('joined')?.role, 'white');
});

test('transient refresh failure retains identity, respects cooldown, and later recovers', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  h.setRefresh(async () => { throw new NetworkError(); });
  h.advance(60_000); await h.reconnect();
  assert.equal(h.sync.getState().connected, false);
  assert.equal(h.factory.last.sent.length, 0, 'never send stale credentials or anonymous join');
  assert.equal(h.session.current?.user.id, 'alice');
  assert.equal(h.sync.submitMove('e2e4'), null);
  await h.reconnect();
  assert.equal(h.refreshes(), 1, 'repeated reconnect respects session cooldown');
  h.setRefresh(async () => h.issue()); h.advance(10_000);
  h.scheduler.runNext(); await flush();
  assert.equal(h.exchange().last('joined')?.role, 'white');
  assert.equal(h.refreshes(), 2);
});

test('definitive refresh denial requires a new anonymous server authorization', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  h.setRefresh(async () => { throw httpErrorFrom(401, { error: { code: 'unauthorized', message: 'denied', requestId: 'test' } }); });
  h.advance(60_000); await h.reconnect();
  assert.equal(h.session.current === null, true);
  assert.equal(h.factory.last.sent.length, 0);
  assert.equal(h.sync.getState().connected, false);
  assert.equal(h.sync.getState().myColor, null);
  h.factory.last.open(); await flush();
  assert.equal(h.factory.last.sent.some((frame) => JSON.parse(frame).token !== undefined), false);
  assert.equal(h.exchange().last('joined')?.role, 'spectator');
  assert.equal(h.sync.resign(), false);
});

for (const boundary of ['logout', 'account adoption', 'route disposal'] as const) {
  test(`in-flight refresh cannot join after ${boundary}`, async (t) => {
    const h = await harness(); t.after(() => dispose(h));
    let release!: (auth: AuthResponse) => void;
    h.setRefresh(() => new Promise((resolve) => { release = resolve; }));
    h.advance(60_000); await h.reconnect();
    if (boundary === 'logout') { h.sync.logoutRequested(); h.session.reset(false); }
    if (boundary === 'account adoption') h.session.adopt(h.issue('bob'), false);
    if (boundary === 'route disposal') h.sync.stop();
    release(h.issue()); await flush();
    assert.equal(h.factory.last.sent.length, 0);
    assert.equal(h.sync.getState().connected, false);
    if (boundary === 'account adoption') assert.equal(h.session.current?.user.id, 'bob');
  });
}

test('server-rejected join never publishes connected player state', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  await h.reconnect();
  assert.equal(h.sync.getState().connected, false, 'open is not authorization');
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'unauthorized', message: 'invalid or expired token' });
  assert.equal(h.sync.getState().connected, false);
  assert.equal(h.sync.getState().myColor, null);
  assert.equal(h.sync.getState().lastReject?.code, 'unauthorized');
  assert.equal(h.sync.resign(), false);
});

test('a logout barrier observed during joined delivery cannot restore the cleared player', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  await h.reconnect();
  const capture = h.session.captureGeneration.bind(h.session);
  h.session.captureGeneration = () => {
    h.session.reset(false); h.sync.sessionChanged(null);
    return capture();
  };
  h.exchange();
  assert.equal(h.sync.getState().connected, false);
  assert.equal(h.sync.getState().myColor, null);
});

test('anonymous spectator reconnect stays anonymous without refresh', async (t) => {
  const h = await harness(true); t.after(() => dispose(h));
  h.advance(60_000); await h.reconnect();
  assert.equal(h.exchange().last('joined')?.role, 'spectator');
  assert.equal(h.refreshes(), 0);
  assert.equal(h.sync.getState().connected, true);
  assert.equal(h.sync.submitMove('e2e4'), null);
  assert.equal(h.sync.resign(), false);
  assert.equal(h.sync.offerDraw(), false);
  assert.equal(h.sync.acceptDraw(), false);
  assert.equal(h.sync.declineDraw(), false);
  assert.equal(h.sync.claimFlag(), false);
  assert.equal(h.sync.abort(), false);
  const server = h.exchange();
  server.deliver({ t: 'resign', gameId: 'g1' });
  assert.equal(server.last('reject')?.code, 'not_a_player', 'real gateway independently denies spectator commands');
});

test('logout request suspends rejoin before the session logout refresh settles', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  let release!: (auth: AuthResponse) => void;
  h.setRefresh(() => new Promise((resolve) => { release = resolve; }));
  h.advance(60_000); await h.reconnect();
  const socket = h.factory.last;
  h.sync.logoutRequested();
  release(h.issue()); await flush(); h.sync.networkOnline();
  assert.equal(socket.sent.length, 0);
  assert.equal(h.factory.last, socket, 'online cannot resurrect a logged-out join');
  assert.equal(h.sync.getState().connected, false);
});

test('completed logout immediately revokes commands and only a fresh join grants spectator access', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  const old = h.factory.last;
  h.sync.logoutRequested();
  assert.equal(h.sync.submitMove('e2e4'), null);
  assert.equal(h.sync.resign(), false);
  assert.equal(h.sync.getState().role, null);
  h.session.reset(false); h.sync.sessionChanged(null);
  old.emit({ t: 'joined', gameId: 'g1', role: 'white', state: h.sync.getState().snapshot });
  assert.equal(h.sync.getState().connected, false);
  h.factory.last.open(); await flush();
  assert.equal(h.factory.last.sent.some((frame) => JSON.parse(frame).token !== undefined), false);
  assert.equal(h.sync.getState().role, null, 'transport open does not authorize spectator access');
  assert.equal(h.exchange().last('joined')?.role, 'spectator');
  assert.equal(h.sync.getState().myColor, null);
  assert.equal(h.sync.submitMove('e2e4'), null);
});

test('an anonymous access rejection never restores the previous player or bypasses server restrictions', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  h.session.reset(false); h.sync.sessionChanged(null);
  h.factory.last.open(); await flush();
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'unauthorized', message: 'access denied' });
  assert.equal(h.sync.getState().connected, false);
  assert.equal(h.sync.getState().role, null);
  assert.equal(h.sync.resign(), false);
});

test('late refresh completion after completed logout cannot restore spectator privileges to player', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  let release!: (auth: AuthResponse) => void;
  h.setRefresh(() => new Promise((resolve) => { release = resolve; }));
  h.advance(60_000); await h.reconnect();
  const obsolete = h.factory.last;
  h.sync.logoutRequested(); h.session.reset(false); h.sync.sessionChanged(null);
  h.factory.last.open(); await flush();
  assert.equal(h.exchange().last('joined')?.role, 'spectator');
  release(h.issue()); await flush();
  obsolete.emit({ t: 'joined', gameId: 'g1', role: 'white', state: h.sync.getState().snapshot });
  assert.equal(h.session.current === null, true);
  assert.equal(h.sync.getState().role, 'spectator');
  assert.equal(h.sync.submitMove('e2e4'), null);
  assert.equal(h.factory.last.sent.filter((frame) => JSON.parse(frame).t === 'join').length, 1);
});

test('account replacement requires a new socket and the server assigns the new seat', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  const obsolete = h.factory.last;
  h.session.adopt(h.issue('bob'), false); h.sync.sessionChanged('bob');
  obsolete.emit({ t: 'joined', gameId: 'g1', role: 'white', state: h.sync.getState().snapshot });
  h.factory.last.open(); await flush();
  assert.equal(h.exchange().last('joined')?.role, 'black');
  assert.equal(h.sync.getState().myColor, 'b');
});

test('same-account peer adoption supersedes an in-flight refresh and starts a current join', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  let release!: (auth: AuthResponse) => void;
  let adoptions = 0;
  h.session.onAdopted(() => { adoptions++; });
  h.setRefresh(() => new Promise((resolve) => { release = resolve; }));
  h.advance(60_000); await h.reconnect();
  const peer = h.issue(); h.peerAdopt(peer);
  assert.equal(adoptions, 1, 'the actual cross-tab adoption path is exercised');
  release(h.issue()); await flush();
  assert.equal(h.session.current?.tokens.accessToken === peer.tokens.accessToken, true);
  assert.equal(h.factory.last.sent.filter((frame) => JSON.parse(frame).t === 'join').length, 1);
  assert.equal(h.exchange().last('joined')?.role, 'white');
});

test('transient gateway hydration rejection retries the pending join with a bound', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  await h.reconnect();
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'invalid_command', message: 'failed to load game' });
  assert.equal(h.scheduler.pending, 1);
  h.advance(1_000); h.scheduler.runNext(); await flush();
  assert.equal(h.exchange().last('joined')?.role, 'white');
});

test('explicit recovery can reopen a server-rejected join without reload or session replacement', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  await h.reconnect();
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'unauthorized', message: 'invalid or expired token' });
  const sockets = h.factory.sockets.length;
  h.sync.networkOnline();
  assert.equal(h.factory.sockets.length, sockets + 1);
  h.factory.last.open(); await flush();
  assert.equal(h.exchange().last('joined')?.role, 'white');
});

test('bounded retries stop during a persistent refresh outage', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  h.setRefresh(async () => { throw new NetworkError(); });
  h.advance(60_000); await h.reconnect();
  for (let attempt = 0; attempt < 3; attempt++) {
    h.advance(30_000); h.scheduler.runNext(); await flush();
  }
  assert.equal(h.scheduler.pending, 0);
  assert.equal(h.refreshes(), 4);
  assert.equal(h.factory.last.sent.length, 0);
  assert.equal(h.session.current?.user.id, 'alice');
  assert.equal(h.sync.getState().recoveryAvailable, true);
  h.setRefresh(async () => h.issue()); h.advance(30_000);
  h.sync.networkOnline(); await flush();
  assert.equal(h.exchange().last('joined')?.role, 'white');
  assert.equal(h.sync.getState().recoveryAvailable, false);
});

test('unknown game rejection stays terminal without a reconnect storm', async (t) => {
  const h = await harness(); t.after(() => dispose(h)); await h.reconnect();
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'unknown_game', message: 'unknown game' });
  const sockets = h.factory.sockets.length;
  h.sync.networkOnline();
  assert.equal(h.factory.sockets.length, sockets);
  assert.equal(h.scheduler.pending, 0);
  assert.equal(h.sync.getState().recoveryAvailable, false);
});

test('bounded recovery waits for a long server cooldown before spending its next retry', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  h.setRefresh(async () => { throw httpErrorFrom(503, undefined, { retryAfterMs: 30_000 }); });
  h.advance(60_000); await h.reconnect();
  assert.equal(h.scheduler.nextDelayMs, 30_000);
  assert.equal(h.refreshes(), 1);
  h.setRefresh(async () => h.issue()); h.advance(30_000); h.scheduler.runNext(); await flush();
  assert.equal(h.exchange().last('joined')?.role, 'white');
  assert.equal(h.refreshes(), 2);
});

test('successful rejoin uses a snapshot, never resubmits a pending move, and accepts a new move', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  assert.ok(h.sync.submitMove('e2e4'));
  h.advance(60_000); await h.reconnect();
  assert.equal(h.factory.last.sent.filter((frame) => JSON.parse(frame).t === 'move').length, 0);
  const connection = h.exchange();
  assert.equal(h.sync.getState().pending, null);
  assert.deepEqual(h.sync.submitMove('e2e4'), { uci: 'e2e4', clientSeq: 2 });
  connection.deliver(JSON.parse(h.factory.last.sent.at(-1)!)); await flush();
  const move = connection.last('move'); assert.ok(move); h.factory.last.emit(move);
  assert.equal(h.sync.getState().ply, 1);
  assert.equal(h.sync.getState().pending, null);
});

test('refreshed player rejoin resumes from the last observed ply after a missed authoritative move', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  h.first.deliver({ t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 }); await flush();
  assert.equal(h.sync.getState().ply, 0, 'the controlled transport withholds the broadcast');
  h.advance(60_000); await h.reconnect();
  const connection = h.exchange();
  assert.equal(h.sync.getState().ply, 1);
  const resume = JSON.parse(h.factory.last.sent.at(-1)!);
  assert.deepEqual(resume, { t: 'resume', gameId: 'g1', lastPly: 0 } as const);
  connection.deliver(resume);
  const resumed = connection.last('resumed'); assert.ok(resumed);
  h.factory.last.emit(resumed);
  assert.equal(h.sync.getState().ply, 1);
  assert.equal(h.sync.getState().connected, true);
});
