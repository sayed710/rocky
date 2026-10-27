import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimeControl } from '@chess-platform/game';
import { GameAuthority, AuthorityCommitError, AuthorityError } from '../src/authority';
import { InMemoryEventLog, type EventLog } from '../src/event-log';
import { InMemoryPubSub, gameChannel, type PubSub, type Unsubscribe } from '../src/pubsub';
import { RealtimeGateway } from '../src/gateway';
import { InMemoryConnection } from '../src/transport';
import type { Broadcast, ServerMessage, StateMessage } from '../src/protocol';
import { FakeTokenVerifier } from './fake-token-verifier';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
const params = { gameId: 'draw-fanout', timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: false };
const flush = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

const isStateMessage = (msg: { t: string }): msg is StateMessage => msg.t === 'state';
const isJoinedMessage = (msg: ServerMessage): msg is Extract<ServerMessage, { t: 'joined' }> => msg.t === 'joined';

class ReverseOrderPubSub implements PubSub {
  private readonly subs = new Map<string, ((msg: Broadcast) => void)[]>();

  publish(channel: string, msg: Broadcast): void {
    const list = this.subs.get(channel);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) list[i]!(msg);
  }

  subscribe(channel: string, handler: (msg: Broadcast) => void): Unsubscribe {
    let list = this.subs.get(channel);
    if (!list) { list = []; this.subs.set(channel, list); }
    list.push(handler);
    return () => {
      const cur = this.subs.get(channel);
      if (!cur) return;
      const idx = cur.indexOf(handler);
      if (idx !== -1) cur.splice(idx, 1);
      if (cur.length === 0) this.subs.delete(channel);
    };
  }
}

test('Q3durable heldappend offer: serialization barrier holds next move until draw state publishes', async (context) => {
  const backing = new InMemoryEventLog();
  let holdAppend: Promise<void> | null = null;
  let releaseAppend: (() => void) | null = null;
  context.after(() => { releaseAppend?.(); });

  const store: EventLog = {
    append: async (id, head, events) => {
      if (holdAppend) await holdAppend;
      return backing.append(id, head, events);
    },
    load: (id) => backing.load(id), exists: (id) => backing.exists(id),
  };

  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1_000, store);
  const gParams = { ...params, gameId: 'held-append' };
  await authority.createGame(gParams);

  await authority.apply(gParams.gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await authority.apply(gParams.gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  const published: Broadcast[] = [];
  pubsub.subscribe(gameChannel(gParams.gameId), (msg) => published.push(msg));

  const offerRes = await authority.apply(gParams.gameId, 'alice', { kind: 'offerDraw' });
  assert.equal(offerRes.state.stateRevision, 3);
  assert.equal(offerRes.state.ply, 2);
  assert.equal(offerRes.state.drawOffer, 'w');

  holdAppend = new Promise<void>((r) => { releaseAppend = r; });
  const declinePromise = authority.apply(gParams.gameId, 'bob', { kind: 'declineDraw' });
  const movePromise = authority.apply(gParams.gameId, 'alice', { kind: 'move', uci: 'g1f3' });

  await flush();
  assert.equal(published.length, 1, 'only offer published before decline ack; queued move held');

  releaseAppend!();
  holdAppend = null;
  const [declineRes, moveRes] = await Promise.all([declinePromise, movePromise]);

  assert.equal(declineRes.state.stateRevision, 4);
  assert.equal(declineRes.state.ply, 2, 'draw decline has unchanged ply');
  assert.equal(declineRes.state.drawOffer, null, 'projection state cleared draw offer to null');

  assert.equal(moveRes.state.stateRevision, 5);
  assert.equal(moveRes.state.ply, 3);

  assert.equal(published.length, 3, 'offer r3, decline r4, move r5 published in order');
  const [pubOffer, pubDecline, pubMove] = published;
  assert.ok(isStateMessage(pubOffer!) && pubOffer.state.stateRevision === 3 && pubOffer.state.drawOffer === 'w');
  assert.ok(isStateMessage(pubDecline!) && pubDecline.state.stateRevision === 4 && pubDecline.state.drawOffer === null);
  assert.equal(pubDecline.state.ply, 2);
  assert.ok(pubMove!.t === 'move' && pubMove.stateRevision === 5);

  const missed = authority.getMissedSince(gParams.gameId, 0);
  assert.ok(missed.length > 0);
  for (const b of missed) assert.notEqual(b.t, 'state', 'history/resume excludes full state');
  assert.equal(published.filter(isStateMessage).length, 2, 'exactly one state publication per draw action');
});

test('Q3failed append and malformedreturnedhead for draw: precommit refusal and corrupt head handled', async () => {
  const backing = new InMemoryEventLog();
  let failAppend = false;
  let corruptHead = false;

  const store: EventLog = {
    append: async (id, head, events) => {
      if (failAppend && events.some((e) => e.type === 'DrawOffered')) {
        throw new Error('deliberate append failure');
      }
      const actual = await backing.append(id, head, events);
      return corruptHead ? actual + 1 : actual;
    },
    load: (id) => backing.load(id), exists: (id) => backing.exists(id),
  };

  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1_000, store);
  const gParams = { ...params, gameId: 'fail-draw', source: 'seek' as const, noShowAfterMs: 60_000 };
  await authority.createGame(gParams);

  const published: Broadcast[] = [];
  pubsub.subscribe(gameChannel(gParams.gameId), (msg) => published.push(msg));

  await authority.apply(gParams.gameId, 'alice', { kind: 'ready' });
  const pubCountAfterReady = published.length;
  const repeatedReady = await authority.apply(gParams.gameId, 'alice', { kind: 'ready' });
  assert.deepEqual(repeatedReady.events, []);
  assert.deepEqual(repeatedReady.broadcasts, []);
  assert.equal(published.length, pubCountAfterReady, 'readiness no-op does not publish full state');

  await assert.rejects(authority.apply(gParams.gameId, 'bob', { kind: 'declineDraw' }), AuthorityError);
  await assert.rejects(authority.apply(gParams.gameId, 'charlie', { kind: 'offerDraw' }), AuthorityError);
  assert.equal(published.filter(isStateMessage).length, 0, 'rejected commands do not publish state');

  failAppend = true;
  await assert.rejects(
    authority.apply(gParams.gameId, 'alice', { kind: 'offerDraw' }),
    /deliberate append failure/,
  );
  assert.equal(published.filter(isStateMessage).length, 0, 'no state published on pre-commit failure');
  const precommitLog = await backing.load(gParams.gameId);
  assert.ok(!precommitLog.some((e) => e.event.type === 'DrawOffered'), 'pre-commit failure not committed');
  failAppend = false;

  corruptHead = true;
  published.length = 0;
  await assert.rejects(
    authority.apply(gParams.gameId, 'alice', { kind: 'offerDraw' }, { requestId: 'ambiguous-draw-req' }),
    AuthorityCommitError,
  );
  assert.deepEqual(published, [], 'assert published none on ambiguous commit');

  const committedLog = await backing.load(gParams.gameId);
  assert.equal(committedLog[committedLog.length - 1]?.event.type, 'DrawOffered', 'backing store committed');

  authority.evict(gParams.gameId);
  assert.equal(await authority.ensureLoaded(gParams.gameId), true);
  assert.equal(authority.getState(gParams.gameId).drawOffer, 'w', 'reload reconciles committed state');
});

test('Q3joinbuffer-first: room subscriber permits equal revision while rejecting strictly lower', async (context) => {
  let clock = 1_000;
  const now = () => (clock += 10);
  const pubsub = new ReverseOrderPubSub();
  const authority = new GameAuthority(pubsub, now);
  const verifier = new FakeTokenVerifier().allow('token-alice', 'alice').allow('token-bob', 'bob');
  const gateway = new RealtimeGateway(authority, pubsub, verifier, now);

  const gParams = { ...params, gameId: 'joinbuffer-first' };
  await authority.createGame(gParams);

  const connect = (id: string) => {
    const c = new InMemoryConnection(id);
    gateway.handleConnection(c);
    return c;
  };

  const originalReadRecovery = authority.readRecovery.bind(authority);
  let deferRecovery = false;
  let resolveRecovery!: () => void;
  const recoveryBarrier = new Promise<void>((r) => { resolveRecovery = r; });

  context.mock.method(authority, 'readRecovery', async (...args: Parameters<typeof originalReadRecovery>) => {
    if (deferRecovery) await recoveryBarrier;
    return originalReadRecovery(...args);
  });

  const aliceConn = connect('alice-conn');
  const bobConn = connect('bob-conn');
  context.after(() => {
    aliceConn.close();
    bobConn.close();
    resolveRecovery();
    context.mock.restoreAll();
  });

  aliceConn.deliver({ t: 'join', gameId: gParams.gameId, token: 'token-alice' });
  await flush();
  assert.ok(aliceConn.sent.some((m) => m.t === 'joined'), 'alice successfully joined room');

  deferRecovery = true;
  bobConn.deliver({ t: 'join', gameId: gParams.gameId, token: 'token-bob' });
  await flush();

  await authority.apply(gParams.gameId, 'alice', { kind: 'offerDraw' });
  await flush();

  const aliceStateMsgs = aliceConn.sent.filter(isStateMessage);
  assert.equal(aliceStateMsgs.length, 1, 'original member receives full state at equal revision');
  assert.equal(aliceStateMsgs[0]!.state.stateRevision, 1);
  assert.equal(aliceStateMsgs[0]!.state.drawOffer, 'w');

  resolveRecovery();
  await flush();

  const bobJoined = bobConn.sent.find(isJoinedMessage);
  assert.ok(bobJoined, 'pending new join completes joined message');
  assert.equal(bobJoined.state.stateRevision, 1);
  assert.equal(bobJoined.state.drawOffer, 'w');

  await authority.apply(gParams.gameId, 'bob', { kind: 'declineDraw' });
  await flush();

  const aliceAfterDecline = aliceConn.sent.filter(isStateMessage);
  assert.equal(aliceAfterDecline.length, 2);
  assert.equal(aliceAfterDecline[1]!.state.stateRevision, 2);
  assert.equal(aliceAfterDecline[1]!.state.drawOffer, null);

  const olderFrame = aliceAfterDecline[0]!;
  assert.equal(olderFrame.state.stateRevision, 1);
  pubsub.publish(gameChannel(gParams.gameId), olderFrame);
  await flush();
  assert.equal(aliceConn.sent.filter(isStateMessage).length, 2, 'stale strictly lower state ignored');

  const currentFrame = aliceAfterDecline[1]!;
  assert.equal(currentFrame.state.stateRevision, 2);
  pubsub.publish(gameChannel(gParams.gameId), currentFrame);
  await flush();
  assert.equal(aliceConn.sent.filter(isStateMessage).length, 2, 'equal revision duplicate deduped');
});

test('exactly ONE full state per room member with pub-before-fallback and fallback-before-late-pub', async (context) => {
  let clock = 1_000;
  const now = () => (clock += 10);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, now);
  const verifier = new FakeTokenVerifier().allow('token-alice', 'alice').allow('token-bob', 'bob');
  const gateway = new RealtimeGateway(authority, pubsub, verifier, now);
  const gParams = { ...params, gameId: 'one-full-state' };
  await authority.createGame(gParams);

  const connect = (id: string) => {
    const c = new InMemoryConnection(id);
    gateway.handleConnection(c);
    return c;
  };

  const aliceConn = connect('alice-conn');
  const bobConn = connect('bob-conn');
  context.after(() => {
    aliceConn.close();
    bobConn.close();
  });

  aliceConn.deliver({ t: 'join', gameId: gParams.gameId, token: 'token-alice' });
  bobConn.deliver({ t: 'join', gameId: gParams.gameId, token: 'token-bob' });
  await flush();
  assert.ok(aliceConn.sent.some(isJoinedMessage));
  assert.ok(bobConn.sent.some(isJoinedMessage));

  // Scenario 1: pub-before-fallback
  aliceConn.deliver({ t: 'offerDraw', gameId: gParams.gameId });
  await flush();

  const aliceStates1 = aliceConn.sent.filter(isStateMessage);
  const bobStates1 = bobConn.sent.filter(isStateMessage);
  assert.equal(aliceStates1.length, 1, 'alice receives exactly one state message on offer');
  assert.equal(bobStates1.length, 1, 'bob receives exactly one state message on offer');
  assert.equal(aliceStates1[0]!.state.stateRevision, 1);
  assert.equal(bobStates1[0]!.state.stateRevision, 1);
  assert.equal(aliceStates1[0]!.state.drawOffer, 'w');
  assert.equal(bobStates1[0]!.state.drawOffer, 'w');

  // Scenario 2: fallback-before-late-pub
  const latePub: { run?: () => void } = {};
  const origPublish = pubsub.publish.bind(pubsub);
  pubsub.publish = (channel, msg) => {
    if (isStateMessage(msg)) {
      latePub.run = () => origPublish(channel, msg);
      return;
    }
    origPublish(channel, msg);
  };

  bobConn.deliver({ t: 'declineDraw', gameId: gParams.gameId });
  await flush();

  const aliceStates2 = aliceConn.sent.filter(isStateMessage);
  const bobStates2 = bobConn.sent.filter(isStateMessage);
  assert.equal(aliceStates2.length, 2, 'alice receives decline state from fallback');
  assert.equal(bobStates2.length, 2, 'bob receives decline state from fallback');
  assert.equal(aliceStates2[1]!.state.stateRevision, 2);
  assert.equal(bobStates2[1]!.state.stateRevision, 2);
  assert.equal(aliceStates2[1]!.state.drawOffer, null);

  assert.ok(latePub.run !== undefined, 'pubsub message was delayed');
  latePub.run();
  await flush();

  assert.equal(aliceConn.sent.filter(isStateMessage).length, 2, 'no duplicate state delivered to alice on late pub');
  assert.equal(bobConn.sent.filter(isStateMessage).length, 2, 'no duplicate state delivered to bob on late pub');
});

test('missing pubsub message still delivers full state via fallback', async (context) => {
  let clock = 1_000;
  const now = () => (clock += 10);
  const pubsub = new InMemoryPubSub();
  const origPublish = pubsub.publish.bind(pubsub);
  pubsub.publish = (channel, msg) => {
    if (isStateMessage(msg)) return;
    origPublish(channel, msg);
  };

  const authority = new GameAuthority(pubsub, now);
  const verifier = new FakeTokenVerifier().allow('token-alice', 'alice').allow('token-bob', 'bob');
  const gateway = new RealtimeGateway(authority, pubsub, verifier, now);
  const gParams = { ...params, gameId: 'missing-pub-fallback' };
  await authority.createGame(gParams);

  const connect = (id: string) => {
    const c = new InMemoryConnection(id);
    gateway.handleConnection(c);
    return c;
  };

  const aliceConn = connect('alice-conn');
  context.after(() => { aliceConn.close(); });

  aliceConn.deliver({ t: 'join', gameId: gParams.gameId, token: 'token-alice' });
  await flush();

  aliceConn.deliver({ t: 'offerDraw', gameId: gParams.gameId });
  await flush();

  const states = aliceConn.sent.filter(isStateMessage);
  assert.equal(states.length, 1, 'fallback delivers state even when pubsub message is missing');
  assert.equal(states[0]!.state.stateRevision, 1);
  assert.equal(states[0]!.state.drawOffer, 'w');
});

test('fresh room recreation allows full state at same head revision', async (context) => {
  let clock = 1_000;
  const now = () => (clock += 10);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, now);
  const verifier = new FakeTokenVerifier().allow('token-alice', 'alice').allow('token-bob', 'bob');
  const gateway = new RealtimeGateway(authority, pubsub, verifier, now);
  const gParams = { ...params, gameId: 'fresh-room-head' };
  await authority.createGame(gParams);

  const connect = (id: string) => {
    const c = new InMemoryConnection(id);
    gateway.handleConnection(c);
    return c;
  };

  const aliceConn = connect('alice-conn');
  aliceConn.deliver({ t: 'join', gameId: gParams.gameId, token: 'token-alice' });
  await flush();

  aliceConn.deliver({ t: 'offerDraw', gameId: gParams.gameId });
  await flush();
  assert.equal(aliceConn.sent.filter(isStateMessage).length, 1);

  aliceConn.close();
  await flush();
  assert.equal(gateway.roomCount, 0, 'room destroyed when member disconnects');

  const bobConn = connect('bob-conn');
  context.after(() => { bobConn.close(); });
  bobConn.deliver({ t: 'join', gameId: gParams.gameId, token: 'token-bob' });
  await flush();
  assert.ok(bobConn.sent.some(isJoinedMessage));

  const stateFrame: Broadcast = {
    t: 'state',
    gameId: gParams.gameId,
    state: authority.getState(gParams.gameId),
  };
  pubsub.publish(gameChannel(gParams.gameId), stateFrame);
  await flush();

  const bobStates = bobConn.sent.filter(isStateMessage);
  assert.equal(bobStates.length, 1, 'fresh room allows full state broadcast at same head revision');
  assert.equal(bobStates[0]!.state.stateRevision, 1);
});

test('older state cannot regress last full state revision or room state', async (context) => {
  let clock = 1_000;
  const now = () => (clock += 10);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, now);
  const verifier = new FakeTokenVerifier().allow('token-alice', 'alice').allow('token-bob', 'bob');
  const gateway = new RealtimeGateway(authority, pubsub, verifier, now);
  const gParams = { ...params, gameId: 'no-state-regression' };
  await authority.createGame(gParams);

  const connect = (id: string) => {
    const c = new InMemoryConnection(id);
    gateway.handleConnection(c);
    return c;
  };

  const aliceConn = connect('alice-conn');
  const bobConn = connect('bob-conn');
  context.after(() => {
    aliceConn.close();
    bobConn.close();
  });

  aliceConn.deliver({ t: 'join', gameId: gParams.gameId, token: 'token-alice' });
  bobConn.deliver({ t: 'join', gameId: gParams.gameId, token: 'token-bob' });
  await flush();

  aliceConn.deliver({ t: 'offerDraw', gameId: gParams.gameId });
  await flush();
  bobConn.deliver({ t: 'declineDraw', gameId: gParams.gameId });
  await flush();

  const states = aliceConn.sent.filter(isStateMessage);
  assert.equal(states.length, 2);
  assert.equal(states[1]!.state.stateRevision, 2);

  const olderState: Broadcast = {
    t: 'state',
    gameId: gParams.gameId,
    state: states[0]!.state,
  };
  pubsub.publish(gameChannel(gParams.gameId), olderState);
  await flush();

  const statesAfterStale = aliceConn.sent.filter(isStateMessage);
  assert.equal(statesAfterStale.length, 2, 'stale older state rejected, does not regress room');
  assert.equal(statesAfterStale[statesAfterStale.length - 1]!.state.stateRevision, 2);
});
test('origin disconnect while routed draw offer response held: remote spectator receives state and room closes cleanly', { timeout: 5_000 }, async (context) => {
  const sharedLog = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const ownerAuthority = new GameAuthority(pubsub, () => 1_000, sharedLog);
  const gParams = { ...params, gameId: 'origin-disconnect-draw' };
  await ownerAuthority.createGame(gParams);

  let resolveBarrier!: () => void;
  const holdRouter = new Promise<void>((r) => { resolveBarrier = r; });
  let signalCommitted!: () => void;
  const committedSignal = new Promise<void>((r) => { signalCommitted = r; });

  const routerB = {
    route: async (id: string, user: string, cmd: Parameters<typeof ownerAuthority.apply>[2]) => {
      const res = await ownerAuthority.apply(id, user, cmd);
      if (cmd.kind === 'offerDraw') {
        signalCommitted();
        await holdRouter;
      }
      return res;
    },
  };

  const edgeB = new GameAuthority(pubsub, () => 1_000, sharedLog);
  const edgeC = new GameAuthority(pubsub, () => 1_000, sharedLog);
  const verifierB = new FakeTokenVerifier().allow('token-alice', 'alice');
  const verifierC = new FakeTokenVerifier();
  const gatewayB = new RealtimeGateway(edgeB, pubsub, verifierB, () => 1_000, routerB);
  const gatewayC = new RealtimeGateway(edgeC, pubsub, verifierC, () => 1_000);

  const connB = new InMemoryConnection('conn-b');
  const connC = new InMemoryConnection('conn-c');
  let pubsubStateCount = 0;
  const unsub = pubsub.subscribe(gameChannel(gParams.gameId), (msg) => {
    if (isStateMessage(msg)) pubsubStateCount++;
  });

  context.after(() => {
    connB.close();
    connC.close();
    resolveBarrier();
    unsub();
  });

  gatewayC.handleConnection(connC);
  connC.deliver({ t: 'join', gameId: gParams.gameId });
  gatewayB.handleConnection(connB);
  connB.deliver({ t: 'join', gameId: gParams.gameId, token: 'token-alice' });
  await flush();
  assert.ok(connC.sent.some(isJoinedMessage), 'spectator C join completed');
  assert.ok(connB.sent.some(isJoinedMessage), 'player B join completed');

  connB.deliver({ t: 'offerDraw', gameId: gParams.gameId });
  await committedSignal;
  await flush();

  const cStatesBefore = connC.sent.filter(isStateMessage);
  assert.equal(cStatesBefore.length, 1, 'remote spectator receives draw state before router return released');
  assert.equal(cStatesBefore[0]!.state.stateRevision, 1);
  assert.equal(cStatesBefore[0]!.state.drawOffer, 'w');
  assert.deepEqual(cStatesBefore[0]!.state, ownerAuthority.getState(gParams.gameId), 'remote full state matches owner state');
  assert.equal(pubsubStateCount, 1, 'exact one authority state publication for offer');

  connB.close();
  await flush();
  assert.equal(connC.sent.filter(isStateMessage).length, 1);

  resolveBarrier();
  await flush();

  assert.equal(connC.sent.filter(isStateMessage).length, 1, 'no duplicate state delivered to remote C');
  assert.equal(gatewayB.roomCount, 0, 'origin gateway room count is 0 after connection closed');

  await ownerAuthority.apply(gParams.gameId, 'bob', { kind: 'declineDraw' });
  await flush();

  const cStatesAfter = connC.sent.filter(isStateMessage);
  assert.equal(cStatesAfter.length, 2, 'remote spectator receives draw decline state');
  assert.equal(cStatesAfter[1]!.state.stateRevision, 2);
  assert.equal(cStatesAfter[1]!.state.drawOffer, null);
  assert.deepEqual(cStatesAfter[1]!.state, ownerAuthority.getState(gParams.gameId), 'remote full state matches owner declined state');
  assert.equal(pubsubStateCount, 2, 'exact one authority publish per draw');
});
