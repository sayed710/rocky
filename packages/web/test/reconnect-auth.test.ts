import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessTokenService } from '@chess-platform/api';
import {
  AdjudicationJobController,
  Game,
  prepareAuthoritativeCommand,
  type AdjudicationStartedEvent,
  type PreparedOperation,
} from '@chess-platform/game';
import {
  ADJUDICATION_ACTOR,
  GameAuthority,
  InMemoryEventLog,
  InMemoryPubSub,
  InMemoryConnection,
  RealtimeGateway,
  decode,
  type AdjudicationAdmission,
  type ClientMessage,
} from '@chess-platform/realtime-gateway';
import { GameSync } from '../src/net/game-sync.js';
import { WsClient } from '../src/net/ws-client.js';
import { MemoryTokenStore, SessionManager } from '../src/net/session.js';
import type { SessionChannel } from '../src/net/session.js';
import type { AuthResponse } from '../src/api/models.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';
import { NetworkError, httpErrorFrom } from '../src/net/errors.js';

const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

function startedFor(op: PreparedOperation): AdjudicationStartedEvent {
  return {
    type: 'AdjudicationStarted',
    gameId: op.gameId,
    operationId: op.operationId,
    baseRevision: op.baseRevision,
    at: op.at,
    rulesVersion: op.rulesVersion,
    prepared: op,
    ...(op.clockPolicy ? { clockPolicy: op.clockPolicy } : {}),
  };
}

class FakeAdmission implements AdjudicationAdmission {
  readonly rulesVersion = 'rocky-adjudication@1';
  readonly clockPolicy = 'observed-release-v1' as const;
  readonly requests: Array<Parameters<AdjudicationAdmission['start']>[0]> = [];
  failWith: Error | undefined;
  constructor(private readonly log: InMemoryEventLog) {}
  async start(params: Parameters<AdjudicationAdmission['start']>[0]): Promise<{ status: 'started' | 'noop' }> {
    this.requests.push(params);
    if (this.failWith) throw this.failWith;
    const logged = await this.log.load(params.gameId);
    const game = Game.fromEvents(logged.map((e) => e.event));
    let op: PreparedOperation;
    if ('prepared' in params) {
      op = params.prepared;
    } else {
      const adm = prepareAuthoritativeCommand(game, params.command, params.context);
      if (adm.kind === 'noop') return { status: 'noop' };
      op = adm.operation;
    }
    await this.log.append(params.gameId, logged.length - 1, [startedFor(op)]);
    return { status: 'started' };
  }
}

async function settleAndRelease(
  log: InMemoryEventLog,
  gameId: string,
  at: number,
  releaseAt?: number,
): Promise<void> {
  const logged = await log.load(gameId);
  const game = Game.fromEvents(logged.map((e) => e.event));
  const pending = game.adjudication;
  if (!pending) throw new Error('No pending adjudication to settle');
  const ctrl = new AdjudicationJobController();
  ctrl.createJob(pending.prepared, game);
  while (ctrl.getJob(pending.operationId)!.status === 'active') {
    ctrl.stepJob(pending.operationId, 1000);
  }
  const settled = ctrl.settleJob(game, pending.operationId, at);
  await log.append(gameId, logged.length - 1, settled.batch);
  if (releaseAt !== undefined) {
    const released = settled.game.prepareClockRelease({
      releaseRequestId: `stop:${pending.operationId}`,
      at: releaseAt,
    });
    await log.append(gameId, logged.length - 1 + settled.batch.length, [released.event]);
  }
}

interface HarnessOptions {
  readonly anonymous?: boolean;
  readonly adjudication?: boolean;
}

async function harness(param: boolean | HarnessOptions = false) {
  const options = typeof param === 'boolean' ? { anonymous: param } : param;
  const anonymous = options.anonymous ?? false;
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
  const log = new InMemoryEventLog();
  const admission = options.adjudication ? new FakeAdmission(log) : undefined;
  const authority = new GameAuthority(pubsub, () => now, log, {
    ...(admission ? { adjudication: admission } : {}),
  });
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
  let emittedFrames = 0;
  const exchange = async (): Promise<InMemoryConnection> => {
    const connection = new InMemoryConnection();
    serverConnection = connection;
    emittedFrames = 0;
    gateway.handleConnection(connection);
    for (const frame of factory.last.sent) connection.deliver(JSON.parse(frame));
    await flush();
    while (emittedFrames < connection.sent.length) {
      factory.last.emit(connection.sent[emittedFrames++]);
    }
    return connection;
  };
  const deliverLast = async (): Promise<void> => {
    const raw = factory.last.sent.at(-1);
    if (!raw) throw new Error('No sent frame');
    const decoded = decode(raw);
    if (!decoded) throw new Error('Failed to decode frame');
    if (!serverConnection) throw new Error('No active server connection');
    serverConnection.deliver(decoded);
    await flush();
    while (emittedFrames < serverConnection.sent.length) {
      factory.last.emit(serverConnection.sent[emittedFrames++]);
    }
  };
  const deliver = async (msg: ClientMessage): Promise<void> => {
    if (!serverConnection) throw new Error('No active server connection');
    serverConnection.deliver(msg);
    await flush();
    while (emittedFrames < serverConnection.sent.length) {
      factory.last.emit(serverConnection.sent[emittedFrames++]);
    }
  };
  sync.start(); factory.last.open(); await flush();
  const first = await exchange();
  assert.equal(first.last('joined')?.role, anonymous ? 'spectator' : 'white', 'initial server-assigned role');
  return { session, sync, factory, scheduler, client, tokens, tokenA, issue, exchange, first,
    authority, log, admission, deliverLast, deliver,
    closeServer: () => serverConnection?.close(),
    peerAdopt: (auth: AuthResponse) => channel.onmessage?.({ data: { type: 'session_adopted', auth } } as MessageEvent),
    refreshes: () => refreshes, advance: (ms: number) => { now += ms; },
    expireOnServerOnly: () => { serverNow = now + 60_000; },
    setRefresh: (callback: () => Promise<AuthResponse>) => { doRefresh = callback; },
    reconnect: async () => {
      serverConnection?.close(); serverConnection = null;
      factory.last.serverClose(); scheduler.runNext(); factory.last.open(); await flush();
    },
    settleAndReport: async (at: number, releaseAt?: number) => {
      await settleAndRelease(log, 'g1', at, releaseAt);
      await authority.apply('g1', ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });
      await flush();
      if (serverConnection) {
        while (emittedFrames < serverConnection.sent.length) {
          factory.last.emit(serverConnection.sent[emittedFrames++]);
        }
      }
    },
  };
}

test('R-04 control: reconnect before token expiry restores the player without refresh', async () => {
  const h = await harness();
  try {
    h.advance(10_000); await h.reconnect();
    assert.equal((await h.exchange()).last('joined')?.role, 'white');
    assert.equal(h.refreshes(), 0);
  } finally { dispose(h); }
});

test('server-expired but locally fresh token is refreshed before explicit recovery rejoin', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  h.expireOnServerOnly();
  assert.equal(h.session.isAccessTokenExpired(), false, 'browser still considers the token fresh');
  await h.reconnect();
  assert.equal((await h.exchange()).last('reject')?.code, 'unauthorized', 'real verifier rejects server-expired token');
  h.closeServer(); h.sync.networkOnline(); h.factory.last.open(); await flush();
  assert.equal(h.refreshes(), 1);
  assert.equal((await h.exchange()).last('joined')?.role, 'white');
});

test('server-rejected fresh credentials retain identity during refresh backoff without resending the token', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  await h.reconnect();
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'unauthorized', message: 'rejected' });
  h.setRefresh(async () => { throw new NetworkError(); });
  h.sync.retryRecovery(); h.factory.last.open(); await flush();
  assert.equal(h.refreshes(), 1);
  assert.equal(h.factory.last.sent.length, 0);
  assert.equal(h.session.current?.user.id, 'alice');
  h.sync.retryRecovery(); await flush();
  assert.equal(h.refreshes(), 1, 'explicit retry cannot bypass manager cooldown');
  h.advance(10_000); h.setRefresh(async () => h.issue());
  h.scheduler.runNext(); await flush();
  assert.equal((await h.exchange()).last('joined')?.role, 'white');
});

test('refresh returning a previously rejected token cannot resend it or create an unbounded loop', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  await h.reconnect();
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'unauthorized', message: 'rejected' });
  h.setRefresh(async () => h.tokenA);
  h.sync.retryRecovery(); h.factory.last.open(); await flush();
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
    const connection = await h.exchange();
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
  assert.equal((await h.exchange()).last('joined')?.role, 'white');
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
  h.advance(10_000); await h.reconnect(); await h.exchange();
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
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'illegal_move', message: 'Earlier gesture refused.' });
  h.expireOnServerOnly(); await h.reconnect();
  assert.equal((await h.exchange()).last('reject')?.code, 'unauthorized');
  assert.equal(h.sync.getState().connected, false);
  assert.equal(h.sync.getState().myColor, null);
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.match(h.sync.getState().lastReject?.message ?? '', /Earlier gesture refused/);
  assert.match(h.sync.getState().lastReject?.message ?? '', /Join rejected/);
  assert.equal(h.sync.submitMove('d2d4'), null);
  h.closeServer(); h.sync.networkOnline(); h.factory.last.open(); await flush();
  assert.equal((await h.exchange()).last('joined')?.role, 'white');
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.match(h.sync.getState().lastReject?.message ?? '', /Earlier gesture refused/);
  assert.doesNotMatch(h.sync.getState().lastReject?.message ?? '', /Join rejected/);
  h.factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'original-move' });
  assert.equal(h.sync.getState().lastReject?.t, 'reject');
  assert.equal(h.sync.getState().lastReject?.message, 'Earlier gesture refused.');
  assertNoReplay(h);
});

test('R-03 + R-04: successful reauthorization clears only the join refusal, then an exact receipt clears uncertainty', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  unknownMove(h);
  h.expireOnServerOnly(); await h.reconnect(); await h.exchange();
  h.closeServer(); h.sync.networkOnline(); h.factory.last.open(); await flush(); await h.exchange();
  assert.equal(h.sync.getState().connected, true);
  assert.equal(h.sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.doesNotMatch(h.sync.getState().lastReject?.message ?? '', /rejected/i);
  h.factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'original-move' });
  assert.equal(h.sync.getState().lastReject, null, 'successful join refusal cannot survive its uncertainty');
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
    assert.equal((await h.exchange()).last('joined')?.role, boundary === 'logout' ? 'spectator' : 'black');
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
  h.scheduler.runNext(); await flush(); await h.exchange();
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
  assert.equal((await h.exchange()).last('joined')?.role, 'black');
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
  assert.equal((await h.exchange()).last('joined')?.role, 'white');
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
  assert.equal((await h.exchange()).last('joined')?.role, 'white');
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
  assert.equal((await h.exchange()).last('joined')?.role, 'white');
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
  assert.equal((await h.exchange()).last('joined')?.role, 'spectator');
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
  await h.exchange();
  assert.equal(h.sync.getState().connected, false);
  assert.equal(h.sync.getState().myColor, null);
});

test('anonymous spectator reconnect stays anonymous without refresh', async (t) => {
  const h = await harness(true); t.after(() => dispose(h));
  h.advance(60_000); await h.reconnect();
  assert.equal((await h.exchange()).last('joined')?.role, 'spectator');
  assert.equal(h.refreshes(), 0);
  assert.equal(h.sync.getState().connected, true);
  assert.equal(h.sync.submitMove('e2e4'), null);
  assert.equal(h.sync.resign(), false);
  assert.equal(h.sync.offerDraw(), false);
  assert.equal(h.sync.acceptDraw(), false);
  assert.equal(h.sync.declineDraw(), false);
  assert.equal(h.sync.claimFlag(), false);
  assert.equal(h.sync.abort(), false);
  const server = await h.exchange();
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
  assert.equal((await h.exchange()).last('joined')?.role, 'spectator');
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
  assert.equal((await h.exchange()).last('joined')?.role, 'spectator');
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
  assert.equal((await h.exchange()).last('joined')?.role, 'black');
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
  assert.equal((await h.exchange()).last('joined')?.role, 'white');
});

test('transient gateway hydration rejection retries the pending join with a bound', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  await h.reconnect();
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'invalid_command', message: 'failed to load game' });
  assert.equal(h.scheduler.pending, 1);
  h.advance(1_000); h.scheduler.runNext(); await flush();
  assert.equal((await h.exchange()).last('joined')?.role, 'white');
});

test('explicit recovery can reopen a server-rejected join without reload or session replacement', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  await h.reconnect();
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'unauthorized', message: 'invalid or expired token' });
  const sockets = h.factory.sockets.length;
  h.sync.retryRecovery();
  assert.equal(h.factory.sockets.length, sockets + 1);
  h.factory.last.open(); await flush();
  assert.equal((await h.exchange()).last('joined')?.role, 'white');
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
  h.sync.retryRecovery(); await flush();
  assert.equal((await h.exchange()).last('joined')?.role, 'white');
  assert.equal(h.sync.getState().recoveryAvailable, false);
});

test('unknown game rejection stays terminal without a reconnect storm', async (t) => {
  const h = await harness(); t.after(() => dispose(h)); await h.reconnect();
  h.factory.last.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'unknown_game', message: 'unknown game' });
  const sockets = h.factory.sockets.length;
  h.sync.retryRecovery();
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
  assert.equal((await h.exchange()).last('joined')?.role, 'white');
  assert.equal(h.refreshes(), 2);
});

test('successful rejoin uses a snapshot, never resubmits a pending move, and accepts a new move', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  assert.ok(h.sync.submitMove('e2e4'));
  h.advance(60_000); await h.reconnect();
  assert.equal(h.factory.last.sent.filter((frame) => JSON.parse(frame).t === 'move').length, 0);
  const connection = await h.exchange();
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
  const connection = await h.exchange();
  assert.equal(h.sync.getState().ply, 1);
  const resume = JSON.parse(h.factory.last.sent.at(-1)!);
  assert.deepEqual(resume, { t: 'resume', gameId: 'g1', lastPly: 0 } as const);
  connection.deliver(resume); await flush();
  const resumed = connection.last('resumed'); assert.ok(resumed);
  h.factory.last.emit(resumed);
  assert.equal(h.sync.getState().ply, 1);
  assert.equal(h.sync.getState().connected, true);
});

test('a permanently refused hydration (a pre-#127 atomic game, option ii) stops after three join retries on the same socket', async (t) => {
  const h = await harness(); t.after(() => dispose(h));
  await h.reconnect();
  const socket = h.factory.last;
  const sockets = h.factory.sockets.length;
  const joins = (): number => socket.sent.filter((frame) => (JSON.parse(frame) as { t: string }).t === 'join').length;
  const refuse = (): void => socket.emit({ t: 'reject', gameId: 'g1', ref: null, code: 'invalid_command', message: 'failed to load game' });
  assert.equal(joins(), 1);
  refuse();
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(h.scheduler.pending, 1, `retry ${attempt + 1} is scheduled`);
    h.advance(10_000); h.scheduler.runNext(); await flush();
    refuse();
  }
  assert.equal(joins(), 4, 'the first join plus three bounded retries, then no more');
  assert.equal(h.scheduler.pending, 0);
  assert.equal(h.factory.sockets.length, sockets, 'no reconnect storm: no new socket is opened');
  assert.equal(h.sync.getState().connected, false);
  assert.equal(h.sync.getState().recoveryAvailable, true, 'the player can retry explicitly');
});

// ── Adjudication Reconnect & Recovery (Issue #124, ADR-0176) ────────────────

test('ADJ-REC-01: proving phase survives socket disconnect, reconnect, and resubscribe with actions gated and no command replay', async (t) => {
  const h = await harness({ adjudication: true }); t.after(() => dispose(h));
  const pending = h.sync.submitMove('e2e4');
  assert.ok(pending);
  await h.deliverLast();
  assert.equal(h.sync.getState().adjudication, 'proving');
  assert.equal(h.sync.getState().connected, true);

  // While proving, commands are gated
  assert.equal(h.sync.submitMove('d2d4'), null);
  assert.equal(h.sync.offerDraw(), false);
  assert.equal(h.sync.resign(), false);
  assert.equal(h.sync.abort(), false);
  assert.equal(h.sync.claimFlag(), false);

  const obsolete = h.factory.last;
  await h.reconnect();
  assert.equal(h.sync.getState().connected, false);
  assert.equal(h.sync.getState().adjudication, 'proving', 'proving phase retained through disconnect');

  // Obsolete socket delivery cannot alter active state
  obsolete.emit({ t: 'state', gameId: 'g1', state: { ...h.sync.getState().snapshot!, adjudication: undefined } });
  assert.equal(h.sync.getState().adjudication, 'proving');

  const conn2 = await h.exchange();
  assert.equal(conn2.last('joined')?.role, 'white');
  assert.equal(h.sync.getState().connected, true);
  assert.equal(h.sync.getState().adjudication, 'proving', 'proving phase restored from authoritative joined snapshot');

  // After reconnect, commands remain gated
  assert.equal(h.sync.submitMove('d2d4'), null);
  assert.equal(h.sync.offerDraw(), false);
  assert.equal(h.sync.resign(), false);

  assertNoReplay(h);
});

test('ADJ-REC-02: stopped phase survives disconnect and reconnect with null clock anchor (paused clocks)', async (t) => {
  const h = await harness({ adjudication: true }); t.after(() => dispose(h));
  assert.ok(h.sync.submitMove('e2e4'));
  await h.deliverLast();
  assert.equal(h.sync.getState().adjudication, 'proving');

  // Settle adjudication without clock release -> enters stopped clocks phase
  await h.settleAndReport(2100);
  assert.equal(h.sync.getState().adjudication, 'stopped');
  assert.equal(h.sync.getState().turnStartedAt, null, 'turnStartedAt is null when clocks are paused');
  assert.ok(h.sync.getState().clock !== null);

  await h.reconnect();
  assert.equal(h.sync.getState().connected, false);
  assert.equal(h.sync.getState().adjudication, 'stopped', 'stopped phase retained during disconnect');

  const conn2 = await h.exchange();
  assert.equal(conn2.last('joined')?.role, 'white');
  assert.equal(h.sync.getState().connected, true);
  assert.equal(h.sync.getState().adjudication, 'stopped', 'stopped phase restored from joined snapshot');
  assert.equal(h.sync.getState().turnStartedAt, null, 'turnStartedAt remains null after reconnect');
});

test('ADJ-REC-03: missed adjudication settlement and release recover via authoritative resume on reconnect', async (t) => {
  const h = await harness({ adjudication: true }); t.after(() => dispose(h));
  assert.ok(h.sync.submitMove('e2e4'));
  await h.deliverLast();
  assert.equal(h.sync.getState().adjudication, 'proving');
  assert.equal(h.sync.getState().ply, 0);

  // Disconnect socket while proving
  h.closeServer();
  h.factory.last.serverClose();
  h.scheduler.runNext();

  // While disconnected, worker settles and releases the clock
  await h.settleAndReport(2100, 2200);

  // Reconnect transport
  h.factory.last.open();
  await flush();

  // Server responds to join with updated state at ply 1 and cleared adjudication
  const connection = await h.exchange();
  assert.equal(connection.last('joined')?.role, 'white');

  // Because client missed ply 0 -> 1, client sends resume
  const lastRaw = h.factory.last.sent.at(-1)!;
  const resume = decode(lastRaw);
  assert.ok(resume !== null && resume.t === 'resume');
  assert.equal(resume.lastPly, 0);

  connection.deliver(resume);
  await flush();
  const resumed = connection.last('resumed');
  assert.ok(resumed);
  h.factory.last.emit(resumed);

  assert.equal(h.sync.getState().ply, 1);
  assert.equal(h.sync.getState().turn, 'b');
  assert.equal(h.sync.getState().adjudication, null);
  assert.equal(h.sync.getState().connected, true);

  // Pending move and uncertainty notices are cleared upon recovery
  assert.equal(h.sync.getState().pending, null);
  assert.equal(h.sync.getState().lastReject, null);

  // While turn is black, move is gated by turn, but non-move player action is unblocked
  assert.equal(h.sync.submitMove('d2d4'), null, 'cannot move when it is opponent turn');
  assert.equal(h.sync.offerDraw(), true, 'new player action is accepted once adjudication settles');
  assert.equal(h.sync.getState().pendingAction, 'offerDraw');

  // Verify the action was transmitted once over the wire
  const lastSent = JSON.parse(h.factory.last.sent.at(-1)!);
  assert.deepEqual(lastSent, { t: 'offerDraw', gameId: 'g1' });
  assert.equal(h.sync.offerDraw(), false, 'cannot send second action while previous action is pending');
});

test('ADJ-REC-04: stale socket frames and stale revisions cannot revert active proving phase on reconnect', async (t) => {
  const h = await harness({ adjudication: true }); t.after(() => dispose(h));
  assert.ok(h.sync.submitMove('e2e4'));
  await h.deliverLast();
  assert.equal(h.sync.getState().adjudication, 'proving');
  const provingRevision = h.sync.stateRevision;
  assert.ok(provingRevision !== null && provingRevision > 0);

  await h.reconnect();

  const staleSnapshot = {
    ...h.sync.getState().snapshot!,
    stateRevision: 0,
    adjudication: undefined,
  };
  h.factory.last.emit({ t: 'state', gameId: 'g1', state: staleSnapshot });
  assert.equal(h.sync.getState().adjudication, 'proving');
  assert.equal(h.sync.stateRevision, provingRevision);

  await h.exchange();
  assert.equal(h.sync.getState().adjudication, 'proving');
});

test('ADJ-REC-05: malformed adjudication value in snapshot is rejected by recovery snapshot validation', async (t) => {
  const h = await harness({ adjudication: true }); t.after(() => dispose(h));
  await h.reconnect();
  await h.exchange();

  h.factory.last.emit({
    t: 'move',
    gameId: 'g1',
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    clock: { w: 300_000, b: 300_000 },
    serverTs: 1000,
    stateRevision: 5,
    fenHash: 'hash',
    legalMoves: {},
  });
  assert.equal(h.sync.getState().recovering, true);

  const mockMoves = [
    { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' as const },
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' as const },
    { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' as const },
  ];

  const malformedSnapshot = {
    ...h.sync.getState().snapshot!,
    ply: 3,
    moves: mockMoves,
    stateRevision: 5,
    adjudication: 'unsupported_phase' as unknown as 'proving',
  };
  h.factory.last.emit({ t: 'resumed', gameId: 'g1', state: malformedSnapshot, missed: [] });
  assert.equal(h.sync.getState().recovering, true, 'debt persists when snapshot is malformed');
  assert.notEqual(h.sync.getState().adjudication, 'unsupported_phase');

  const validSnapshot = {
    ...h.sync.getState().snapshot!,
    ply: 3,
    moves: mockMoves,
    stateRevision: 5,
    adjudication: 'proving' as const,
  };
  h.factory.last.emit({ t: 'resumed', gameId: 'g1', state: validSnapshot, missed: [] });
  assert.equal(h.sync.getState().recovering, false, 'debt discharged with valid snapshot');
  assert.equal(h.sync.getState().adjudication, 'proving');
});
