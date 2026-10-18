/**
 * D1-A: Server-side game recovery freshness test suite.
 *
 * Verifies that join and resume requests serve the freshest committed prefix
 * from the durable log rather than stale resident cache on warm edge nodes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameEvent, TimeControl } from '@chess-platform/game';
import { GameAuthority } from '../src/authority';
import type { EventLog, LoggedEvent } from '../src/event-log';
import { InMemoryEventLog } from '../src/event-log';
import { InMemoryPubSub, gameChannel } from '../src/pubsub';
import { RealtimeGateway } from '../src/gateway';
import { InMemoryConnection } from '../src/transport';
import { FakeTokenVerifier } from './fake-token-verifier';
import { LocalCommandRouter } from '../src/command-router';
import type { Broadcast, ServerMessage } from '../src/protocol';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function barrier(): { done: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  return { done, resolve };
}

interface Gate {
  isEntered: boolean;
  get entered(): boolean;
  readonly release: { done: Promise<void>; resolve: () => void };
}

function createGate(): Gate {
  return {
    isEntered: false,
    get entered(): boolean {
      return this.isEntered;
    },
    release: barrier(),
  };
}

async function awaitGate(gate: Gate, label: string): Promise<void> {
  for (let i = 0; i < 10 && !gate.isEntered; i++) {
    await flush();
  }
  assert.ok(gate.isEntered, `precondition: ${label} load was not reached`);
}

class RecordingConnection extends InMemoryConnection {
  public isClosedBySelf = false;
  public attemptedAfterClose: ServerMessage[] = [];

  override close(code?: number, reason?: string): void {
    this.isClosedBySelf = true;
    super.close(code, reason);
  }

  override send(msg: ServerMessage): void {
    if (this.isClosedBySelf) {
      this.attemptedAfterClose.push(msg);
      return;
    }
    super.send(msg);
  }
}

class DeferredLog implements EventLog {
  public beforeAppendGate?: Gate;
  public afterAppendGate?: Gate;
  public nextLoadGate?: Gate;
  public appends = 0;
  public loads = 0;

  constructor(private readonly inner: EventLog) {}

  exists(id: string): Promise<boolean> {
    return this.inner.exists(id);
  }

  async load(id: string): Promise<readonly LoggedEvent[]> {
    this.loads++;
    const snapshot = await this.inner.load(id);
    if (this.nextLoadGate) {
      const gate = this.nextLoadGate;
      this.nextLoadGate = undefined;
      gate.isEntered = true;
      await gate.release.done;
    }
    return snapshot;
  }

  async append(gameId: string, expectedSeq: number, events: readonly GameEvent[]): Promise<number> {
    if (this.beforeAppendGate) {
      const gate = this.beforeAppendGate;
      this.beforeAppendGate = undefined;
      gate.isEntered = true;
      await gate.release.done;
    }
    this.appends++;
    const res = await this.inner.append(gameId, expectedSeq, events);
    if (this.afterAppendGate) {
      const gate = this.afterAppendGate;
      this.afterAppendGate = undefined;
      gate.isEntered = true;
      await gate.release.done;
    }
    return res;
  }
}

test('S01: warm-edge join after writer moves returns latest stateRevision, ply, and moves matching cold witness', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-s01';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Warm the edge with initial revision 0 snapshot.
  const spectator1 = new InMemoryConnection('spec1');
  gateway.handleConnection(spectator1);
  spectator1.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(spectator1.last('joined'));
  assert.equal(spectator1.last('joined')!.state.stateRevision, 0);
  assert.equal(spectator1.last('joined')!.state.ply, 0);

  // Writer commits two moves to durable log (revision 1 then 2).
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  // A new spectator joins the warm edge.
  const spectator2 = new InMemoryConnection('spec2');
  gateway.handleConnection(spectator2);
  spectator2.deliver({ t: 'join', gameId });
  await flush();

  const joined = spectator2.last('joined');
  assert.ok(joined, 'spectator2 must receive joined');
  assert.equal(joined.state.stateRevision, 2);
  assert.equal(joined.state.ply, 2);

  // Verify against a cold witness authority reading from the same log.
  const witness = new GameAuthority(new InMemoryPubSub(), () => 1000, store);
  await witness.ensureLoaded(gameId);
  const witnessState = witness.getState(gameId);
  assert.equal(joined.state.stateRevision, witnessState.stateRevision);
  assert.equal(joined.state.ply, witnessState.ply);
  assert.deepEqual(joined.state.moves, witnessState.moves);
});

test('S02 & S03: warm-edge resume (lastPly 0) after writer moves returns latest rev, ply, and missed broadcasts', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-s02';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Warm edge via spectator join.
  const spectator = new InMemoryConnection('spec');
  gateway.handleConnection(spectator);
  spectator.deliver({ t: 'join', gameId });
  await flush();

  // Writer commits moves.
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  // Spectator resumes with lastPly 0.
  spectator.deliver({ t: 'resume', gameId, lastPly: 0 });
  await flush();

  const resumed = spectator.last('resumed');
  assert.ok(resumed, 'spectator must receive resumed');
  assert.equal(resumed.state.stateRevision, 2);
  assert.equal(resumed.state.ply, 2);

  // S03: missed contains exactly the writer's two move broadcasts with stateRevision 1 and 2.
  const moveBroadcasts = resumed.missed.filter((m) => m.t === 'move');
  assert.equal(moveBroadcasts.length, 2);
  assert.equal(moveBroadcasts[0]!.stateRevision, 1);
  assert.equal(moveBroadcasts[0]!.ply, 1);
  assert.equal(moveBroadcasts[0]!.uci, 'e2e4');
  assert.equal(moveBroadcasts[1]!.stateRevision, 2);
  assert.equal(moveBroadcasts[1]!.ply, 2);
  assert.equal(moveBroadcasts[1]!.uci, 'e7e5');
});

test('S04: same-ply draw offer by writer is reflected in resumed state', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-s04';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Warm edge.
  const spectator = new InMemoryConnection('spec');
  gateway.handleConnection(spectator);
  spectator.deliver({ t: 'join', gameId });
  await flush();

  // Writer plays two moves (ply 2, rev 2) and offers draw (ply 2, rev 3).
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });
  await writer.apply(gameId, 'alice', { kind: 'offerDraw' });

  spectator.deliver({ t: 'resume', gameId, lastPly: 2 });
  await flush();

  const resumed = spectator.last('resumed');
  assert.ok(resumed);
  assert.equal(resumed.state.stateRevision, 3);
  assert.equal(resumed.state.ply, 2);
  assert.equal(resumed.state.drawOffer, 'w');
});

test('S05: same-ply resignation by writer is reflected in resumed state and ended broadcast', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-s05';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Warm edge.
  const spectator = new InMemoryConnection('spec');
  gateway.handleConnection(spectator);
  spectator.deliver({ t: 'join', gameId });
  await flush();

  // Writer plays two moves (ply 2, rev 2) and resigns (ply 2, rev 3).
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });
  await writer.apply(gameId, 'alice', { kind: 'resign' });

  spectator.deliver({ t: 'resume', gameId, lastPly: 0 });
  await flush();

  const resumed = spectator.last('resumed');
  assert.ok(resumed);
  assert.equal(resumed.state.stateRevision, 3);
  assert.equal(resumed.state.ply, 2);
  assert.equal(resumed.state.status.over, true);

  const lastMissed = resumed.missed[resumed.missed.length - 1];
  assert.ok(lastMissed);
  assert.equal(lastMissed.t, 'ended');
});

test('N1: no resident mutation: detached read does not install resident state, and readRecovery leaves has(id) false', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-n1';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Warm edge.
  const spectator = new InMemoryConnection('spec');
  gateway.handleConnection(spectator);
  spectator.deliver({ t: 'join', gameId });
  await flush();
  assert.equal(edge.getState(gameId).stateRevision, 0);

  // Writer advances game.
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  // Spectator resumes; edge delivers rev 2.
  spectator.deliver({ t: 'resume', gameId, lastPly: 0 });
  await flush();
  assert.equal(spectator.last('resumed')?.state.stateRevision, 2);

  // Assert resident authority snapshot was NOT mutated/installed by the detached read.
  assert.equal(edge.getState(gameId).stateRevision, 0);

  // readRecovery on an authority with no resident slot leaves has(id) false.
  const freshAuthority = new GameAuthority(pubsub, () => 1000, store);
  assert.equal(freshAuthority.has(gameId), false);
  const read = await freshAuthority.readRecovery(gameId, 0);
  assert.equal(read.state.stateRevision, 2);
  assert.equal(freshAuthority.has(gameId), false);
});

test('Control A1: owner append paused before inner append: resume returns rev 2; single append and confirmation', async () => {
  const innerStore = new InMemoryEventLog();
  const deferredLog = new DeferredLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const owner = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(owner, pubsub, new FakeTokenVerifier());

  const gameId = 'game-ctrl-a1';
  await owner.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });
  await owner.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await owner.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  const spectator = new InMemoryConnection('spec');
  gateway.handleConnection(spectator);
  spectator.deliver({ t: 'join', gameId });
  await flush();

  // Track pubsub broadcasts.
  const busBroadcasts: Broadcast[] = [];
  pubsub.subscribe(gameChannel(gameId), (b) => busBroadcasts.push(b));

  // Configure gate pausing BEFORE inner append.
  const gate = createGate();
  deferredLog.beforeAppendGate = gate;

  const appendsBefore = deferredLog.appends;
  const commandPromise = owner.apply(gameId, 'alice', { kind: 'move', uci: 'g1f3' }, { requestId: 'r03-exact' });

  await awaitGate(gate, 'owner before-append');

  // While paused before append, spectator resumes.
  spectator.deliver({ t: 'resume', gameId, lastPly: 0 });
  await flush();

  const resumed = spectator.last('resumed');
  assert.ok(resumed);
  assert.equal(resumed.state.stateRevision, 2);

  // Release and drain.
  gate.release.resolve();
  await commandPromise;
  await flush();

  assert.equal(deferredLog.appends, appendsBefore + 1);
  assert.equal(busBroadcasts.filter((b) => b.t === 'commandConfirmed' && b.requestId === 'r03-exact').length, 1);
  assert.equal(busBroadcasts.filter((b) => b.t === 'move' && b.uci === 'g1f3').length, 1);
  assert.equal(owner.getState(gameId).stateRevision, 3);

  // Follow-up command succeeds without concurrency error.
  const followUp = await owner.apply(gameId, 'bob', { kind: 'move', uci: 'b8c6' });
  assert.equal(followUp.state.stateRevision, 4);
});

test('Control A2: owner append paused after inner append returns: resume returns rev in {2,3} and coherent; single append and confirmation', async () => {
  const innerStore = new InMemoryEventLog();
  const deferredLog = new DeferredLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const owner = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(owner, pubsub, new FakeTokenVerifier());

  const gameId = 'game-ctrl-a2';
  await owner.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });
  await owner.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await owner.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  const spectator = new InMemoryConnection('spec');
  gateway.handleConnection(spectator);
  spectator.deliver({ t: 'join', gameId });
  await flush();

  const busBroadcasts: Broadcast[] = [];
  pubsub.subscribe(gameChannel(gameId), (b) => busBroadcasts.push(b));

  const gate = createGate();
  deferredLog.afterAppendGate = gate;

  const appendsBefore = deferredLog.appends;
  const commandPromise = owner.apply(gameId, 'alice', { kind: 'move', uci: 'g1f3' }, { requestId: 'r03-exact' });

  await awaitGate(gate, 'owner after-append');

  spectator.deliver({ t: 'resume', gameId, lastPly: 0 });
  await flush();

  const resumed = spectator.last('resumed');
  assert.ok(resumed);
  assert.ok(resumed.state.stateRevision === 2 || resumed.state.stateRevision === 3);
  assert.equal(resumed.state.moves.length, resumed.state.ply);
  assert.equal(resumed.missed.filter((m) => m.t === 'move').length, resumed.state.ply);

  gate.release.resolve();
  await commandPromise;
  await flush();

  assert.equal(deferredLog.appends, appendsBefore + 1);
  assert.equal(busBroadcasts.filter((b) => b.t === 'commandConfirmed' && b.requestId === 'r03-exact').length, 1);
  assert.equal(busBroadcasts.filter((b) => b.t === 'move' && b.uci === 'g1f3').length, 1);
  assert.equal(owner.getState(gameId).stateRevision, 3);

  const followUp = await owner.apply(gameId, 'bob', { kind: 'move', uci: 'b8c6' });
  assert.equal(followUp.state.stateRevision, 4);
});

test('Control B: commit after read captured prefix: resume returns rev in {2,3} and coherent', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-ctrl-b';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  const spectator = new InMemoryConnection('spec');
  gateway.handleConnection(spectator);
  spectator.deliver({ t: 'join', gameId });
  await flush();

  // Evict game from edge authority so resume triggers a cold load on both main and implementation.
  edge.evict(gameId);

  // Gate the edge's next load AFTER the inner load returned its snapshot.
  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  spectator.deliver({ t: 'resume', gameId, lastPly: 0 });
  await awaitGate(gate, 'edge resume');

  // Writer commits g1f3 (rev 3) while edge's read is gated.
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'g1f3' });

  gate.release.resolve();
  await flush();

  const resumed = spectator.last('resumed');
  assert.ok(resumed);
  assert.ok(resumed.state.stateRevision === 2 || resumed.state.stateRevision === 3);
  assert.equal(resumed.missed.filter((m) => m.t === 'move').length, resumed.state.ply);
  assert.equal(resumed.state.moves.length, resumed.state.ply);
});

test('Control C1: close during gated join load: no frame after close, roomCount 0, hasLocalSessions false, onGameLoaded not called', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  let onGameLoadedCalls = 0;
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier(), () => 1000, undefined, () => {
    onGameLoadedCalls++;
  });

  const gameId = 'game-c1';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  const conn = new RecordingConnection('c1');
  gateway.handleConnection(conn);
  conn.deliver({ t: 'join', gameId });
  await awaitGate(gate, 'join load');

  conn.close();
  gate.release.resolve();
  await flush();

  assert.equal(conn.attemptedAfterClose.length, 0);
  assert.equal(gateway.roomCount, 0);
  assert.equal(gateway.hasLocalSessions(gameId), false);
  assert.equal(onGameLoadedCalls, 0);
  assert.equal(deferredLog.loads, 1);
});

test('Control C1b: close during readRecovery load on warm edge: no frame after close, connection not in room, onGameLoaded unchanged', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  let onGameLoadedCalls = 0;
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier(), () => 1000, undefined, () => {
    onGameLoadedCalls++;
  });

  const gameId = 'game-c1b';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Warm edge via initial spectator.
  const spec0 = new InMemoryConnection('spec0');
  gateway.handleConnection(spec0);
  spec0.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(spec0.last('joined'));
  assert.equal(gateway.roomCount, 1);
  assert.equal(onGameLoadedCalls, 1);

  // Slot is now warm in memory. The NEXT load will be from readRecovery for the new spectator.
  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  const specNew = new RecordingConnection('spec-new');
  gateway.handleConnection(specNew);
  specNew.deliver({ t: 'join', gameId });
  await awaitGate(gate, 'specNew readRecovery join');

  specNew.close();
  gate.release.resolve();
  await flush();

  assert.equal(specNew.attemptedAfterClose.length, 0);
  assert.equal(gateway.roomCount, 1);
  assert.equal(onGameLoadedCalls, 1);

  // Verify specNew was not added to the room: when spec0 leaves, roomCount drops to 0.
  spec0.close();
  await flush();
  assert.equal(gateway.roomCount, 0);
  assert.equal(gateway.hasLocalSessions(gameId), false);
});

test('Control C2: socket replacement during gated join load delivers exactly one joined to new connection', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice');
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-c2';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  const c1 = new RecordingConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId, token: 'tok-alice' });
  await awaitGate(gate, 'c1 join');

  c1.close();

  const c2 = new RecordingConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId, token: 'tok-alice' });

  gate.release.resolve();
  await flush();

  assert.equal(c1.attemptedAfterClose.length, 0);
  const joined2 = c2.all('joined');
  assert.equal(joined2.length, 1);
  assert.equal(joined2[0]!.role, 'white');
  assert.equal(gateway.roomCount, 1);
});

test('Control C3: token revoked during gated join load rejects with unauthorized', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  let valid = true;
  const verifier = { verify: (t: string) => (valid && t === 'tok-alice' ? { userId: 'alice' } : null) };
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-c3';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  const conn = new RecordingConnection('c3');
  gateway.handleConnection(conn);
  conn.deliver({ t: 'join', gameId, token: 'tok-alice' });
  await awaitGate(gate, 'c3 join');

  // Revoke token while load is in-flight.
  valid = false;

  gate.release.resolve();
  await flush();

  assert.equal(conn.last('joined'), undefined);
  assert.equal(conn.last('reject')?.code, 'unauthorized');
});

test('Control C4: resume pending when session closes drops resumed frame and tears down room', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-c4';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const conn = new RecordingConnection('c4');
  gateway.handleConnection(conn);
  conn.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(conn.last('joined'));

  // Evict game from edge authority so resume triggers a cold load on both main and implementation.
  edge.evict(gameId);

  const loadsBefore = deferredLog.loads;
  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  conn.deliver({ t: 'resume', gameId, lastPly: 0 });
  await awaitGate(gate, 'c4 resume');

  conn.close();
  gate.release.resolve();
  await flush();

  assert.equal(conn.attemptedAfterClose.length, 0);
  assert.equal(gateway.roomCount, 0);
  assert.equal(gateway.hasLocalSessions(gameId), false);
  assert.equal(deferredLog.loads, loadsBefore + 1);
});

test('Control C5: superseded intent: two resumes on one session emits exactly one resumed frame', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(authority, pubsub, new FakeTokenVerifier());

  const gameId = 'game-c5';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const conn = new InMemoryConnection('c5');
  gateway.handleConnection(conn);
  conn.deliver({ t: 'join', gameId });
  await flush();

  // First resume will be gated.
  const gate1 = createGate();
  deferredLog.nextLoadGate = gate1;

  conn.deliver({ t: 'resume', gameId, lastPly: 0 });
  await awaitGate(gate1, 'c5 resume 1');

  // Second resume supersedes the first.
  conn.deliver({ t: 'resume', gameId, lastPly: 0 });
  await flush();

  // Release first load.
  gate1.release.resolve();
  await flush();

  const resumedFrames = conn.all('resumed');
  assert.equal(resumedFrames.length, 1);
});

test('R03: while resume load is gated on non-owner edge, writer applies command: exactly one commandConfirmed on bus, no outcomeUnknown', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-r03';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const spectator = new InMemoryConnection('spec');
  gateway.handleConnection(spectator);
  spectator.deliver({ t: 'join', gameId });
  await flush();

  const busBroadcasts: Broadcast[] = [];
  pubsub.subscribe(gameChannel(gameId), (b) => busBroadcasts.push(b));

  // Evict game from edge authority so resume triggers a cold load on both main and implementation.
  edge.evict(gameId);

  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  spectator.deliver({ t: 'resume', gameId, lastPly: 0 });
  await awaitGate(gate, 'r03 resume');

  // Writer applies a command with requestId.
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' }, { requestId: 'r03-c' });

  gate.release.resolve();
  await flush();

  assert.equal(busBroadcasts.filter((b) => b.t === 'commandConfirmed' && b.requestId === 'r03-c').length, 1);
  assert.equal(spectator.all('outcomeUnknown').length, 0);
});

test('R1 resident-newer branch: owner authority serves gateway warm; writer applies move during gated load; resume returns rev 3 from resident', async () => {
  const innerStore = new InMemoryEventLog();
  const deferredLog = new DeferredLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const owner = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(owner, pubsub, new FakeTokenVerifier());

  const gameId = 'game-r1';
  await owner.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });
  await owner.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await owner.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  // Warm gateway and establish spectator membership at rev 2.
  const spectator = new InMemoryConnection('spec');
  gateway.handleConnection(spectator);
  spectator.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(spectator.last('joined'));
  assert.equal(owner.getState(gameId).stateRevision, 2);

  // Gate the owner's next load AFTER the inner snapshot is taken.
  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  spectator.deliver({ t: 'resume', gameId, lastPly: 0 });
  await awaitGate(gate, 'owner resume load');

  // Once gate is entered (inner snapshot captured at rev 2), owner applies a move:
  // rev goes 2 -> 3, committed to resident record and store.
  await owner.apply(gameId, 'alice', { kind: 'move', uci: 'g1f3' });
  assert.equal(owner.getState(gameId).stateRevision, 3);

  // Release the readRecovery load.
  gate.release.resolve();
  await flush();

  const resumed = spectator.last('resumed');
  assert.ok(resumed);
  assert.equal(resumed.state.stateRevision, 3);
  assert.equal(resumed.state.ply, 3);
  assert.equal(resumed.state.moves.length, 3);
  const moveBroadcasts = resumed.missed.filter((m) => m.t === 'move');
  assert.equal(moveBroadcasts.length, 3);
});

test('F1: read failure during readRecovery on warm slot rejects join and resume with invalid_command', async () => {
  const store = new InMemoryEventLog();
  let failLoad = false;
  const failingLog: EventLog = {
    exists: (id) => store.exists(id),
    append: (id, expectedSeq, events) => store.append(id, expectedSeq, events),
    load: async (id) => {
      if (failLoad) throw new Error('disk read failed');
      return store.load(id);
    },
  };
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, failingLog);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-f1';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Warm edge slot with initial join.
  const spec1 = new InMemoryConnection('spec1');
  gateway.handleConnection(spec1);
  spec1.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(spec1.last('joined'));

  // Test join failure on warm slot:
  failLoad = true;
  const spec2 = new InMemoryConnection('spec2');
  gateway.handleConnection(spec2);
  spec2.deliver({ t: 'join', gameId });
  await flush();

  assert.equal(spec2.last('joined'), undefined);
  const joinReject = spec2.last('reject');
  assert.ok(joinReject);
  assert.equal(joinReject.code, 'invalid_command');
  assert.equal(joinReject.message, 'failed to load game');

  // Test resume failure on warm slot:
  spec1.deliver({ t: 'resume', gameId, lastPly: 0 });
  await flush();

  assert.equal(spec1.last('resumed'), undefined);
  const resumeReject = spec1.last('reject');
  assert.ok(resumeReject);
  assert.equal(resumeReject.code, 'invalid_command');
  assert.equal(resumeReject.message, 'failed to load game');
});

test('readRecovery throwing unknown_game on warm slot rejects join and resume with unknown_game', async () => {
  const store = new InMemoryEventLog();
  let returnEmpty = false;
  const emptyLog: EventLog = {
    exists: (id) => store.exists(id),
    append: (id, expectedSeq, events) => store.append(id, expectedSeq, events),
    load: async (id) => {
      if (returnEmpty) return [];
      return store.load(id);
    },
  };
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, emptyLog);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-unknown-err';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Warm edge slot with initial join.
  const spec1 = new InMemoryConnection('spec1');
  gateway.handleConnection(spec1);
  spec1.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(spec1.last('joined'));

  // With warm slot, return [] on next readRecovery read.
  returnEmpty = true;

  // Test join:
  const spec2 = new InMemoryConnection('spec2');
  gateway.handleConnection(spec2);
  spec2.deliver({ t: 'join', gameId });
  await flush();

  assert.equal(spec2.last('joined'), undefined);
  const joinReject = spec2.last('reject');
  assert.ok(joinReject);
  assert.equal(joinReject.code, 'unknown_game');
  assert.equal(joinReject.message, `no such game ${gameId}`);

  // Test resume:
  spec1.deliver({ t: 'resume', gameId, lastPly: 0 });
  await flush();

  assert.equal(spec1.last('resumed'), undefined);
  const resumeReject = spec1.last('reject');
  assert.ok(resumeReject);
  assert.equal(resumeReject.code, 'unknown_game');
  assert.equal(resumeReject.message, `no such game ${gameId}`);
});

test('Cold control: a never-loaded edge join returns the same state as the cold witness', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-cold-ctrl';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  const spectator = new InMemoryConnection('cold-spec');
  gateway.handleConnection(spectator);
  spectator.deliver({ t: 'join', gameId });
  await flush();

  const joined = spectator.last('joined');
  assert.ok(joined);

  const witness = new GameAuthority(new InMemoryPubSub(), () => 1000, store);
  await witness.ensureLoaded(gameId);
  const witnessState = witness.getState(gameId);

  assert.equal(joined.state.stateRevision, witnessState.stateRevision);
  assert.equal(joined.state.ply, witnessState.ply);
  assert.deepEqual(joined.state.moves, witnessState.moves);
});

test('E1 eviction during recovery read: reloads and player command succeeds without unknown_game', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, deferredLog);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice');
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  const gameId = 'game-e1';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Arm the next-load gate on the warm authority.
  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  const player = new InMemoryConnection('alice-conn');
  gateway.handleConnection(player);
  player.deliver({ t: 'join', gameId, token: 'tok-alice' });
  await awaitGate(gate, 'player join recovery read');

  // Evict game while readRecovery is in-flight.
  authority.evict(gameId);

  gate.release.resolve();
  await flush();

  assert.equal(player.all('joined').length, 1);
  assert.equal(authority.has(gameId), true);

  player.deliver({ t: 'move', gameId, uci: 'e2e4', clientSeq: 1 });
  await flush();

  assert.equal(player.last('reject'), undefined);
  const moveMsg = player.last('move');
  assert.ok(moveMsg);
  assert.equal(moveMsg.uci, 'e2e4');
});

test('G1 ended during the join read: spectator receives joined then updated state frame with status.over true', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const owner = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice');
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-g1';
  await owner.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Player A joins so the room exists and edge is warm.
  const playerA = new InMemoryConnection('alice-conn');
  gateway.handleConnection(playerA);
  playerA.deliver({ t: 'join', gameId, token: 'tok-alice' });
  await flush();
  assert.ok(playerA.last('joined'));

  // Arm next-load gate.
  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  // Spectator S joins.
  const spec = new InMemoryConnection('spec-conn');
  gateway.handleConnection(spec);
  spec.deliver({ t: 'join', gameId });
  await awaitGate(gate, 'spectator join recovery read');

  // While spectator's join read is gated, White resigns (rev N -> N+1, ended).
  await owner.apply(gameId, 'alice', { kind: 'resign' });

  gate.release.resolve();
  await flush();

  const joined = spec.last('joined');
  assert.ok(joined);
  assert.equal(joined.state.status.over, false);
  const revN = joined.state.stateRevision;

  const stateMsg = spec.last('state');
  assert.ok(stateMsg);
  assert.equal(stateMsg.state.stateRevision, revN + 1);
  assert.equal(stateMsg.state.status.over, true);
});

test('G2 same-node draw offer during the join read: spectator receives catch-up state frame showing drawOffer w', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const owner = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(edge, pubsub, verifier, () => 1000, new LocalCommandRouter(owner));

  const gameId = 'game-g2';
  await owner.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Both players seated via gateway.
  const alice = new InMemoryConnection('alice-conn');
  gateway.handleConnection(alice);
  alice.deliver({ t: 'join', gameId, token: 'tok-alice' });
  const bob = new InMemoryConnection('bob-conn');
  gateway.handleConnection(bob);
  bob.deliver({ t: 'join', gameId, token: 'tok-bob' });
  await flush();
  assert.ok(alice.last('joined'));
  assert.ok(bob.last('joined'));

  // Arm next-load gate.
  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  // Spectator joins.
  const spec = new InMemoryConnection('spec-conn');
  gateway.handleConnection(spec);
  spec.deliver({ t: 'join', gameId });
  await awaitGate(gate, 'spectator join read');

  // White sends offerDraw through gateway (sendStateToRoom only notifies existing room members).
  alice.deliver({ t: 'offerDraw', gameId });
  await flush();

  gate.release.resolve();
  await flush();

  const joined = spec.last('joined');
  assert.ok(joined);
  assert.equal(joined.state.drawOffer, null);

  const stateMsg = spec.last('state');
  assert.ok(stateMsg);
  assert.equal(stateMsg.state.drawOffer, 'w');
  assert.ok(stateMsg.state.stateRevision > joined.state.stateRevision);
});

test('G3 no catch-up frame when nothing changed: warm join with no concurrent commit -> zero state frames', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, store);
  const gateway = new RealtimeGateway(authority, pubsub, new FakeTokenVerifier());

  const gameId = 'game-g3';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(c1.last('joined'));

  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await flush();

  assert.ok(c2.last('joined'));
  assert.equal(c2.all('state').length, 0);
});

test('K1 cold join loads once for its snapshot: loads === 2 (one cold hydration + one catch-up)', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-k1';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  // Edge has never loaded gameId. Spectator joins.
  const spec = new InMemoryConnection('spec');
  gateway.handleConnection(spec);
  spec.deliver({ t: 'join', gameId });
  await flush();

  // Exactly 2 loads: 1 cold hydration in ensureLoaded + 1 in catchUpJoin.
  assert.equal(deferredLog.loads, 2);

  const witness = new GameAuthority(new InMemoryPubSub(), () => 1000, store);
  await witness.ensureLoaded(gameId);
  const joined = spec.last('joined');
  assert.ok(joined);
  assert.equal(joined.state.stateRevision, witness.getState(gameId).stateRevision);
  assert.equal(joined.state.ply, 2);
});

test('K2 cold resume: exactly 1 load for the resume and correct resumed state/missed', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-k2';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  const spec = new InMemoryConnection('spec');
  gateway.handleConnection(spec);
  spec.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(spec.last('joined'));

  // Writer commits another move while edge is idle.
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  // Evict edge authority so resume is cold, while session is kept.
  edge.evict(gameId);
  const loadsBefore = deferredLog.loads;

  spec.deliver({ t: 'resume', gameId, lastPly: 1 });
  await flush();

  // Exactly 1 load for cold resume (ensureLoaded only, no second recovery load).
  assert.equal(deferredLog.loads, loadsBefore + 1);

  const resumed = spec.last('resumed');
  assert.ok(resumed);
  assert.equal(resumed.state.ply, 2);
  assert.equal(resumed.missed.length, 1);
  assert.equal(resumed.missed[0]!.t, 'move');
});
