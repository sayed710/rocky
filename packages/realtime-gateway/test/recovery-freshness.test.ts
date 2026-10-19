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
import { LocalCommandRouter, type CommandRouter } from '../src/command-router';
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
  public existsGate?: Gate;
  public beforeAppendGate?: Gate;
  public afterAppendGate?: Gate;
  public beforeLoadGate?: Gate;
  public nextLoadGate?: Gate;
  public appends = 0;
  public loads = 0;

  constructor(private readonly inner: EventLog) {}

  async exists(id: string): Promise<boolean> {
    if (this.existsGate) {
      const gate = this.existsGate;
      this.existsGate = undefined;
      gate.isEntered = true;
      await gate.release.done;
    }
    return this.inner.exists(id);
  }

  async load(id: string): Promise<readonly LoggedEvent[]> {
    if (this.beforeLoadGate) {
      const gate = this.beforeLoadGate;
      this.beforeLoadGate = undefined;
      gate.isEntered = true;
      await gate.release.done;
    }
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

test('G1 ended during the join read: S receives joined then ended broadcast, no state frame', async () => {
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

  const endedMsg = spec.last('ended');
  assert.ok(endedMsg);
  assert.equal(endedMsg.stateRevision, revN + 1);

  // Buffer replay delivers the ended broadcast; no catch-up state frame is emitted.
  assert.equal(spec.all('state').length, 0);
});

test('G2 same-node draw offer during the join read: spectator receives state frame with drawOffer w via buffer', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, deferredLog);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  const gameId = 'game-g2';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

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

  // White sends offerDraw through gateway (sendStateToRoom pushes to room and into in-flight joinBuffers).
  alice.deliver({ t: 'offerDraw', gameId });
  await flush();

  // Evict game from authority so readRecovery uses the loaded snapshot (drawOffer null) instead of the resident record.
  authority.evict(gameId);

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

test('G3 nothing changed: no frames other than joined/presence after the join', async () => {
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
  assert.equal(c2.all('move').length, 0);
  assert.equal(c2.all('ended').length, 0);
  for (const msg of c2.sent) {
    assert.ok(msg.t === 'joined' || msg.t === 'presence', `unexpected message type: ${msg.t}`);
  }
});

test('G4 two moves during the gated join read: S receives joined(N) then move N+1 then move N+2, in order, each exactly once', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice');
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-g4';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

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
  await awaitGate(gate, 'spectator join read');

  // Writer commits two moves while read is gated.
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  gate.release.resolve();
  await flush();

  const joined = spec.last('joined');
  assert.ok(joined);
  assert.equal(joined.state.stateRevision, 0);
  assert.equal(joined.state.ply, 0);

  const moves = spec.all('move');
  assert.equal(moves.length, 2);
  assert.equal(moves[0]!.stateRevision, 1);
  assert.equal(moves[0]!.uci, 'e2e4');
  assert.equal(moves[1]!.stateRevision, 2);
  assert.equal(moves[1]!.uci, 'e7e5');

  const joinedIdx = spec.sent.findIndex((m) => m.t === 'joined');
  const move1Idx = spec.sent.findIndex((m) => m.t === 'move' && m.stateRevision === 1);
  const move2Idx = spec.sent.findIndex((m) => m.t === 'move' && m.stateRevision === 2);
  assert.ok(joinedIdx >= 0 && move1Idx > joinedIdx && move2Idx > move1Idx);
});

test('G5 commit BEFORE the load snapshot but after the join started: deduplicates against snapshot rev N+1', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice');
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-g5';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Player A joins so room exists and edge is warm.
  const playerA = new InMemoryConnection('alice-conn');
  gateway.handleConnection(playerA);
  playerA.deliver({ t: 'join', gameId, token: 'tok-alice' });
  await flush();
  assert.ok(playerA.last('joined'));

  // Arm beforeLoadGate: pauses BEFORE calling inner.load.
  const gate = createGate();
  deferredLog.beforeLoadGate = gate;

  const spec = new InMemoryConnection('spec-conn');
  gateway.handleConnection(spec);
  spec.deliver({ t: 'join', gameId });
  await awaitGate(gate, 'beforeLoadGate in join');

  // Commit one move while paused before inner.load.
  // The buffer already holds move N+1 (since buffer started at join initiation).
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  gate.release.resolve();
  await flush();

  const joined = spec.last('joined');
  assert.ok(joined);
  assert.equal(joined.state.stateRevision, 1);
  assert.equal(joined.state.ply, 1);

  // The move was in the snapshot; buffer de-duplication must ensure S does NOT receive it again.
  assert.equal(spec.all('move').length, 0);
});

test('G6 commandConfirmed published during the gated join read is delivered to S exactly once', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-g6';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Warm edge via spectator
  const spec0 = new InMemoryConnection('spec0');
  gateway.handleConnection(spec0);
  spec0.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(spec0.last('joined'));

  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  const spec = new InMemoryConnection('spec-conn');
  gateway.handleConnection(spec);
  spec.deliver({ t: 'join', gameId });
  await awaitGate(gate, 'spectator join read');

  // Writer applies with requestId 'r-g6'
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' }, { requestId: 'r-g6' });

  gate.release.resolve();
  await flush();

  const joined = spec.last('joined');
  assert.ok(joined);

  const confirmed = spec.all('commandConfirmed');
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0]!.requestId, 'r-g6');
});

test('G7 unauthorized join during a gated read rejects and cleans up pubsub subscription', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  let valid = true;
  const verifier = { verify: (t: string) => (valid && t === 'tok-alice' ? { userId: 'alice' } : null) };
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-g7';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Player A joins so room exists.
  const alice = new InMemoryConnection('alice-conn');
  gateway.handleConnection(alice);
  alice.deliver({ t: 'join', gameId, token: 'tok-alice' });
  await flush();
  assert.ok(alice.last('joined'));

  const initialSubCount = pubsub.subscriberCount(gameChannel(gameId));

  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  const conn = new RecordingConnection('bad-conn');
  gateway.handleConnection(conn);
  conn.deliver({ t: 'join', gameId, token: 'tok-alice' });
  await awaitGate(gate, 'bad join load');

  // During gated load, token is revoked AND a move is committed to pubsub.
  valid = false;
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  // While load is in flight, an extra subscriber was added for the buffer.
  assert.equal(pubsub.subscriberCount(gameChannel(gameId)), initialSubCount + 1);

  gate.release.resolve();
  await flush();

  // Reject unauthorized delivered
  assert.equal(conn.last('joined'), undefined);
  assert.equal(conn.last('reject')?.code, 'unauthorized');
  // No buffered frames delivered
  assert.equal(conn.all('move').length, 0);

  // Gateway cleaned up the buffer's pubsub subscription in finally
  assert.equal(pubsub.subscriberCount(gameChannel(gameId)), initialSubCount);
});

test('K1 cold join loads once for its snapshot: loads === 1 (cold hydration only, no second recovery load)', async () => {
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

  // Exactly 1 load: cold hydration in ensureLoaded.
  assert.equal(deferredLog.loads, 1);

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

test('D1: draw-only command routed to owner does not regress spectator to stale edge state', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const router: CommandRouter = {
    route: (gameId, userId, cmd) => writer.apply(gameId, userId, cmd),
  };
  const gateway = new RealtimeGateway(edge, pubsub, verifier, () => 1000, router);

  const gameId = 'game-d1';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Edge is warm at an OLD revision (rev 0).
  const alice = new InMemoryConnection('alice-conn');
  gateway.handleConnection(alice);
  alice.deliver({ t: 'join', gameId, token: 'tok-alice' });
  await flush();
  assert.ok(alice.last('joined'));
  assert.equal(edge.getState(gameId).stateRevision, 0);

  // Players move on writer (rev goes 0 -> 2).
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });
  assert.equal(writer.getState(gameId).stateRevision, 2);
  assert.equal(edge.getState(gameId).stateRevision, 0);

  // Spectator joins edge (fresh snapshot rev 2).
  const spec = new InMemoryConnection('spec-conn');
  gateway.handleConnection(spec);
  spec.deliver({ t: 'join', gameId });
  await flush();
  const joined = spec.last('joined');
  assert.ok(joined);
  assert.equal(joined.state.stateRevision, 2);

  // White sends offerDraw through edge gateway (routed to writer, which returns result.state with rev 3, drawOffer 'w').
  alice.deliver({ t: 'offerDraw', gameId });
  await flush();

  const stateMsg = spec.last('state');
  assert.ok(stateMsg);
  assert.equal(stateMsg.state.drawOffer, 'w');
  assert.ok(stateMsg.state.stateRevision > joined.state.stateRevision);
  assert.equal(stateMsg.state.stateRevision, 3);
});

test('B1: abandoned join closes and drops pubsub subscription before gate release', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(authority, pubsub, new FakeTokenVerifier());

  const gameId = 'game-b1';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Warm authority slot with an initial spectator.
  const spec0 = new InMemoryConnection('spec0');
  gateway.handleConnection(spec0);
  spec0.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(spec0.last('joined'));

  const preJoinSubs = pubsub.subscriberCount(gameChannel(gameId));

  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  const conn = new RecordingConnection('abandoned-conn');
  gateway.handleConnection(conn);
  conn.deliver({ t: 'join', gameId });
  await awaitGate(gate, 'join load');

  // While load is gated, the connection closes.
  conn.close();

  // Assert subscriberCount drops back to pre-join value BEFORE releasing gate.
  assert.equal(pubsub.subscriberCount(gameChannel(gameId)), preJoinSubs);

  // Release gate and flush.
  gate.release.resolve();
  await flush();

  // No frames delivered to conn after close.
  assert.equal(conn.sent.length, 0);
  assert.equal(conn.attemptedAfterClose.length, 0);
});

test('B2: second join on same session supersedes and stops the first join buffer', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(authority, pubsub, new FakeTokenVerifier());

  const gameId = 'game-b2';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Warm authority slot with an initial spectator.
  const spec0 = new InMemoryConnection('spec0');
  gateway.handleConnection(spec0);
  spec0.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(spec0.last('joined'));

  const preJoinSubs = pubsub.subscriberCount(gameChannel(gameId));

  const gate1 = createGate();
  deferredLog.nextLoadGate = gate1;

  const conn = new InMemoryConnection('superseding-conn');
  gateway.handleConnection(conn);
  conn.deliver({ t: 'join', gameId });
  await awaitGate(gate1, 'first join load');

  // First join buffer is active (+1 subscriber).
  assert.equal(pubsub.subscriberCount(gameChannel(gameId)), preJoinSubs + 1);

  // Deliver second join for the same game on the same session.
  conn.deliver({ t: 'join', gameId });

  // On warm slot, startJoinBuffer runs synchronously, stopping the first buffer and starting the second.
  // Assert only one extra subscriber exists before releasing gate1.
  assert.equal(pubsub.subscriberCount(gameChannel(gameId)), preJoinSubs + 1);

  gate1.release.resolve();
  await flush();
});

test('U1: join an unknown game id is rejected unknown_game and subscriberCount returns to pre-join value after drain', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, store);
  const gateway = new RealtimeGateway(authority, pubsub, new FakeTokenVerifier());

  const unknownId = 'game-unknown-u1';
  const preJoinSubs = pubsub.subscriberCount(gameChannel(unknownId));
  const conn = new InMemoryConnection('unknown-conn');
  gateway.handleConnection(conn);

  conn.deliver({ t: 'join', gameId: unknownId });
  await flush();

  assert.equal(pubsub.subscriberCount(gameChannel(unknownId)), preJoinSubs);
  assert.equal(conn.last('joined'), undefined);
  const reject = conn.last('reject');
  assert.ok(reject);
  assert.equal(reject.code, 'unknown_game');
});

test('H1: coalesced hydration, commit BEFORE J1 joins', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-h1';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Arm nextLoadGate (pauses AFTER the inner snapshot).
  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  // Spectator J2 joins E; wait until the gate is entered (E's hydration snapshot is fixed at rev N).
  const j2 = new InMemoryConnection('j2');
  gateway.handleConnection(j2);
  j2.deliver({ t: 'join', gameId });
  await awaitGate(gate, 'J2 hydration snapshot');

  // The writer commits one move (rev N+1) NOW, before J1 exists.
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  // Then spectator J1 joins E (its buffer starts after that commit; its ensureLoaded coalesces onto J2's gated hydration).
  const j1 = new InMemoryConnection('j1');
  gateway.handleConnection(j1);
  j1.deliver({ t: 'join', gameId });

  // Release the gate; drain.
  gate.release.resolve();
  await flush();

  // Expect: J1's joined.state.stateRevision === N+1 (it must take a fresh recovery read, because the
  // resident record's load began before J1's buffer), and J1 receives no move N+1 frame afterwards
  // (it is already in the snapshot). J2 may get joined N followed by move N+1.
  const j1Joined = j1.last('joined');
  assert.ok(j1Joined, 'J1 must have received joined');
  assert.equal(j1Joined.state.stateRevision, 1, 'J1 must take fresh recovery read at rev N+1');
  assert.equal(j1Joined.state.ply, 1);
  const j1Moves = j1.sent.filter((m) => m.t === 'move');
  assert.equal(j1Moves.length, 0, 'J1 receives no move N+1 frame afterwards (already in snapshot)');

  const j2Joined = j2.last('joined');
  assert.ok(j2Joined, 'J2 must have received joined');
  const j2Moves = j2.sent.filter((m) => m.t === 'move');
  const j2Rev = j2Joined.state.stateRevision === 1 ? 1 : (j2Moves.length === 1 ? j2Moves[0]!.stateRevision : 0);
  assert.equal(j2Rev, 1, 'J2 must reach stateRevision 1');
});

test('H2: coalesced hydration, commit BEFORE resume', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
  const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

  const gameId = 'game-h2';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // An already-joined spectator R on E.
  const r = new InMemoryConnection('r');
  gateway.handleConnection(r);
  r.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(r.last('joined'));
  assert.equal(r.last('joined')!.state.stateRevision, 0);

  // E then evicted so the next request hydrates cold.
  edge.evict(gameId);
  assert.equal(edge.has(gameId), false);

  // Arm nextLoadGate.
  const gate = createGate();
  deferredLog.nextLoadGate = gate;

  // Spectator J2 joins (hydration gated at rev N).
  const j2 = new InMemoryConnection('j2');
  gateway.handleConnection(j2);
  j2.deliver({ t: 'join', gameId });
  await awaitGate(gate, 'J2 hydration snapshot');

  // Writer commits N+1.
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  // R sends resume lastPly 0 (its marker is taken after the gated load began).
  r.deliver({ t: 'resume', gameId, lastPly: 0 });

  // Release; drain.
  gate.release.resolve();
  await flush();

  // Expect R's resumed.state.stateRevision === N+1.
  const resumed = r.last('resumed');
  assert.ok(resumed, 'R must have received resumed');
  assert.equal(resumed.state.stateRevision, 1, 'R must resume with fresh stateRevision N+1');
  assert.equal(resumed.state.ply, 1);
});

test('M1: authority loadMarker and residentLoadedAfter lifecycle', async () => {
  const store = new InMemoryEventLog();
  const deferredLog = new DeferredLog(store);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, deferredLog);

  const gameId = 'game-m1';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Evict to make it cold:
  authority.evict(gameId);
  assert.equal(authority.has(gameId), false);

  // Take marker BEFORE cold ensureLoaded:
  const beforeMarker = authority.loadMarker();
  const loaded = await authority.ensureLoaded(gameId);
  assert.equal(loaded, true);

  // residentLoadedAfter with marker before load -> true:
  assert.equal(authority.residentLoadedAfter(gameId, beforeMarker), true);

  // With a marker taken AFTER the load -> false:
  const afterMarker = authority.loadMarker();
  assert.equal(authority.residentLoadedAfter(gameId, afterMarker), false);

  // A stale/reloading slot -> false:
  const gate = createGate();
  deferredLog.nextLoadGate = gate;
  const reloadPromise = authority.reloadFromLog(gameId);
  await awaitGate(gate, 'M1 reload');
  // While reloading, slot.reloads > 0 and record is stale:
  assert.equal(authority.residentLoadedAfter(gameId, beforeMarker), false);
  gate.release.resolve();
  await reloadPromise;
});

test('L1 delayed draw response: late draw response does not send older state after newer move', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);

  let drawGate: Gate | undefined;
  const router: CommandRouter = {
    route: async (gameId, userId, cmd) => {
      const res = await writer.apply(gameId, userId, cmd);
      if (cmd.kind === 'offerDraw' && drawGate) {
        const gate = drawGate;
        drawGate = undefined;
        gate.isEntered = true;
        await gate.release.done;
      }
      return res;
    },
  };

  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(writer, pubsub, verifier, () => 1000, router);

  const gameId = 'game-l1';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const white = new InMemoryConnection('white');
  gateway.handleConnection(white);
  white.deliver({ t: 'join', gameId, token: 'tok-alice' });

  const black = new InMemoryConnection('black');
  gateway.handleConnection(black);
  black.deliver({ t: 'join', gameId, token: 'tok-bob' });

  const spec = new InMemoryConnection('spec');
  gateway.handleConnection(spec);
  spec.deliver({ t: 'join', gameId });
  await flush();

  assert.ok(white.last('joined'));
  assert.ok(black.last('joined'));
  assert.ok(spec.last('joined'));

  // White sends offerDraw, writer commits rev N (1), router response is held.
  const gate = createGate();
  drawGate = gate;
  white.deliver({ t: 'offerDraw', gameId });
  await awaitGate(gate, 'draw offer committed');

  // Another command commits and broadcasts a move with rev N+1 (2) through pubsub.
  white.deliver({ t: 'move', gameId, clientSeq: 1, uci: 'e2e4' });
  await flush();

  const specMove = spec.last('move');
  assert.ok(specMove, 'spectator must have received move broadcast');
  assert.equal(specMove.stateRevision, 2);

  // Release the held draw response (which carried rev 1).
  gate.release.resolve();
  await flush();

  // The spectator must not receive any state frame with revision lower than the move's.
  const moveIndex = spec.sent.indexOf(specMove);
  const subsequentStates = spec.sent.slice(moveIndex + 1).filter((m): m is ServerMessage & { t: 'state' } => m.t === 'state');
  assert.ok(
    subsequentStates.every((s) => s.state.stateRevision >= specMove.stateRevision),
    "no state frame with revision lower than the move's",
  );
});

test('L2 normal draw offer still delivered: spectator receives state frame with drawOffer set', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const router: CommandRouter = {
    route: (gameId, userId, cmd) => writer.apply(gameId, userId, cmd),
  };
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(writer, pubsub, verifier, () => 1000, router);

  const gameId = 'game-l2';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const white = new InMemoryConnection('white');
  gateway.handleConnection(white);
  white.deliver({ t: 'join', gameId, token: 'tok-alice' });

  const black = new InMemoryConnection('black');
  gateway.handleConnection(black);
  black.deliver({ t: 'join', gameId, token: 'tok-bob' });

  const spec = new InMemoryConnection('spec');
  gateway.handleConnection(spec);
  spec.deliver({ t: 'join', gameId });
  await flush();

  white.deliver({ t: 'offerDraw', gameId });
  await flush();

  const stateMsg = spec.last('state');
  assert.ok(stateMsg, 'spectator must receive state frame');
  assert.equal(stateMsg.state.drawOffer, 'w');
  assert.equal(stateMsg.state.stateRevision, 1);
});

test('L3 no leak: after all sessions close, observedRevision has no entry for the game', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(writer, pubsub, verifier);

  const gameId = 'game-l3';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const white = new InMemoryConnection('white');
  gateway.handleConnection(white);
  white.deliver({ t: 'join', gameId, token: 'tok-alice' });

  const spec = new InMemoryConnection('spec');
  gateway.handleConnection(spec);
  spec.deliver({ t: 'join', gameId });
  await flush();

  // White offers a draw, sending state to room and populating observedRevision.
  white.deliver({ t: 'offerDraw', gameId });
  await flush();

  // Active game has an entry in observedRevision.
  assert.equal(gateway.observedRevisionFor(gameId), 1);

  // Close all sessions.
  white.close();
  spec.close();
  await flush();

  // Entry is cleaned up.
  assert.equal(gateway.observedRevisionFor(gameId), undefined);

  // Join buffer only (without a room):
  const orphanConn = new InMemoryConnection('orphan');
  gateway.handleConnection(orphanConn);
  const orphanGameId = 'game-l3-orphan';
  orphanConn.deliver({ t: 'join', gameId: orphanGameId });
  // Publish a broadcast while join is pending to populate observedRevision.
  pubsub.publish(gameChannel(orphanGameId), {
    t: 'move',
    gameId: orphanGameId,
    stateRevision: 1,
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'test',
    legalMoves: {},
    clock: { w: 300000, b: 300000 },
    serverTs: 1000,
  });
  assert.equal(gateway.observedRevisionFor(orphanGameId), 1);

  // Close connection before join completes:
  orphanConn.close();
  await flush();
  assert.equal(gateway.observedRevisionFor(orphanGameId), undefined);
});

test("R1' readiness during a delayed draw response: detached refresh delivers draw offer", async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  let drawGate: Gate | undefined;
  const router: CommandRouter = {
    route: async (gameId, userId, cmd) => {
      const res = await writer.apply(gameId, userId, cmd);
      if (cmd.kind === 'offerDraw' && drawGate) {
        const gate = drawGate;
        drawGate = undefined;
        gate.isEntered = true;
        await gate.release.done;
      }
      return res;
    },
  };

  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(edge, pubsub, verifier, () => 1000, router);

  const gameId = 'game-r1-draw';
  await writer.createGame({
    gameId,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: true,
    source: 'seek',
    noShowAfterMs: 60_000,
  });

  const white = new InMemoryConnection('white');
  gateway.handleConnection(white);
  white.deliver({ t: 'join', gameId, token: 'tok-alice' });
  await flush();
  assert.ok(white.last('joined'));

  const spec = new InMemoryConnection('spec');
  gateway.handleConnection(spec);
  spec.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(spec.last('joined'));

  // White sends offerDraw; writer commits offer (rev 2), router response held.
  const gate = createGate();
  drawGate = gate;
  white.deliver({ t: 'offerDraw', gameId });
  await awaitGate(gate, 'offerDraw committed on writer');

  // Black's seat joins and commits readiness (ready broadcast, rev bumps to 3) while white's offerDraw response is held.
  const black = new InMemoryConnection('black');
  gateway.handleConnection(black);
  black.deliver({ t: 'join', gameId, token: 'tok-bob' });
  await flush();

  const blackReady = spec.last('ready');
  assert.ok(blackReady, 'spectator must receive black ready broadcast');
  assert.equal(blackReady.stateRevision, 3);

  // Release the held draw response.
  gate.release.resolve();
  await flush();

  // The spectator must end with a state frame whose drawOffer is 'w' and whose stateRevision is >= the ready broadcast's revision.
  const lastState = spec.last('state');
  assert.ok(lastState, 'spectator must receive state frame with draw offer');
  assert.equal(lastState.state.drawOffer, 'w');
  assert.ok(
    lastState.state.stateRevision >= blackReady.stateRevision,
    `state revision ${lastState.state.stateRevision} must be >= ready broadcast revision ${blackReady.stateRevision}`,
  );
});

test('CR1 regression: remote draw offer committed before cold resume is reflected in resumed state', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-cr1';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Spectator joins on edge.
  const conn = new InMemoryConnection('c1');
  gateway.handleConnection(conn);
  conn.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(conn.last('joined'));

  // Edge is evicted after join so the next request hydrates cold.
  edge.evict(gameId);
  assert.equal(edge.has(gameId), false);

  // A remote draw offer is committed on the writer BEFORE the cold resume request on edge.
  await writer.apply(gameId, 'alice', { kind: 'offerDraw' });
  assert.equal(writer.getState(gameId).drawOffer, 'w');
  assert.equal(writer.getState(gameId).stateRevision, 1);

  // Client on edge sends resume.
  conn.deliver({ t: 'resume', gameId, lastPly: 0 });
  await flush();

  // Resumed state reflects the committed draw offer and revision.
  const resumed = conn.last('resumed');
  assert.ok(resumed, 'client must receive resumed frame');
  assert.equal(resumed.state.drawOffer, 'w', 'resumed state must include committed drawOffer');
  assert.equal(resumed.state.stateRevision, 1, 'resumed stateRevision must include the draw offer');
});

test("CR2 boundary characterization: D2 boundary: a remote draw offer committed after the read's snapshot is not delivered cross-node", async () => {
  // D2 boundary characterization: draw offers produce no cross-node pubsub broadcast.
  // A remote draw offer committed after the read's snapshot is therefore neither in the snapshot
  // nor delivered via pubsub. This assertion must flip when cross-node draw distribution (D2) lands.

  // 1. Cold path: gate ensureLoaded hydration after its snapshot
  {
    const store = new InMemoryEventLog();
    const deferredLog = new DeferredLog(store);
    const pubsub = new InMemoryPubSub();
    const writer = new GameAuthority(pubsub, () => 1000, store);
    const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
    const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
    const gateway = new RealtimeGateway(edge, pubsub, verifier);

    const gameId = 'game-cr2-cold';
    await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

    const conn = new InMemoryConnection('c-cold');
    gateway.handleConnection(conn);
    conn.deliver({ t: 'join', gameId });
    await flush();
    assert.ok(conn.last('joined'));

    // Evict so resume hydrates cold
    edge.evict(gameId);
    assert.equal(edge.has(gameId), false);

    const gate = createGate();
    deferredLog.nextLoadGate = gate;

    conn.deliver({ t: 'resume', gameId, lastPly: 0 });
    await awaitGate(gate, 'cold ensureLoaded snapshot');

    // Commit remote draw offer while gated (after snapshot taken at rev 0)
    await writer.apply(gameId, 'alice', { kind: 'offerDraw' });
    assert.equal(writer.getState(gameId).drawOffer, 'w');

    gate.release.resolve();
    await flush();

    const resumed = conn.last('resumed');
    assert.ok(resumed);
    assert.equal(resumed.state.drawOffer, null, 'cold resumed snapshot omits draw offer committed after snapshot');
    assert.equal(resumed.state.stateRevision, 0);
    assert.equal(conn.all('state').length, 0, 'no state frame reaches edge client afterwards');
  }

  // 2. Warm path: gate readRecovery after its snapshot
  {
    const store = new InMemoryEventLog();
    const deferredLog = new DeferredLog(store);
    const pubsub = new InMemoryPubSub();
    const writer = new GameAuthority(pubsub, () => 1000, store);
    const edge = new GameAuthority(pubsub, () => 1000, deferredLog);
    const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
    const gateway = new RealtimeGateway(edge, pubsub, verifier);

    const gameId = 'game-cr2-warm';
    await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

    const conn = new InMemoryConnection('c-warm');
    gateway.handleConnection(conn);
    conn.deliver({ t: 'join', gameId });
    await flush();
    assert.ok(conn.last('joined'));

    // Edge remains warm. Arm gate for readRecovery.
    const gate = createGate();
    deferredLog.nextLoadGate = gate;

    conn.deliver({ t: 'resume', gameId, lastPly: 0 });
    await awaitGate(gate, 'warm readRecovery snapshot');

    // Commit remote draw offer while gated (after snapshot taken at rev 0)
    await writer.apply(gameId, 'alice', { kind: 'offerDraw' });
    assert.equal(writer.getState(gameId).drawOffer, 'w');

    gate.release.resolve();
    await flush();

    const resumed = conn.last('resumed');
    assert.ok(resumed);
    assert.equal(resumed.state.drawOffer, null, 'warm resumed snapshot omits draw offer committed after snapshot');
    assert.equal(resumed.state.stateRevision, 0);
    assert.equal(conn.all('state').length, 0, 'no state frame reaches edge client afterwards');
  }
});
