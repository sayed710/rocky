/**
 * Stage A: Durable head/suffix reads and bounded durable operations.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameEvent, TimeControl } from '@chess-platform/game';
import { Game } from '@chess-platform/game';
import {
  GameAuthority,
  AuthorityError,
  AuthorityCommitError,
  type GameAuthorityOptions,
} from '../src/authority';
import type { EventLog, LoggedEvent } from '../src/event-log';
import { InMemoryEventLog } from '../src/event-log';
import { InMemoryPubSub } from '../src/pubsub';
import { RealtimeGateway } from '../src/gateway';
import { InMemoryConnection } from '../src/transport';
import { FakeTokenVerifier } from './fake-token-verifier';
import type { CommandRouter } from '../src/command-router';
import type { ServerMessage } from '../src/protocol';

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
  for (let i = 0; i < 20 && !gate.isEntered; i++) {
    await flush();
  }
  assert.ok(gate.isEntered, `precondition: ${label} was not reached`);
}

class ManualScheduler {
  private tasks: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];

  get pendingCount(): number {
    return this.tasks.filter((t) => !t.cancelled).length;
  }

  schedule = (fn: () => void, ms: number): (() => void) => {
    const task = { fn, ms, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };

  fire(): void {
    const active = this.tasks.filter((t) => !t.cancelled);
    this.tasks = this.tasks.filter((t) => t.cancelled);
    for (const t of active) {
      t.fn();
    }
  }
}

class CountingLog implements EventLog {
  public loads = 0;
  public headCount = 0;
  public loadSinces = 0;
  public batchHeads = 0;
  public appends = 0;
  public existsCount = 0;

  public headGate?: Gate;
  public loadSinceGate?: Gate;
  public beforeLoadSinceGate?: Gate;
  public loadGate?: Gate;
  public nextLoadGate?: Gate;
  public appendGate?: Gate;
  public existsGate?: Gate;

  public corruptSuffix = false;
  public suffixMutation?: (suffix: readonly LoggedEvent[]) => readonly LoggedEvent[];
  public hangLoad = false;
  public hangHead = false;
  public hangLoadSince = false;
  public hangAppend = false;

  public lastLoadSignal?: AbortSignal;
  public lastHeadSignal?: AbortSignal;
  public lastLoadSinceSignal?: AbortSignal;
  public lastAppendSignal?: AbortSignal;

  constructor(public readonly inner: InMemoryEventLog) {}

  resetCounts(): void {
    this.loads = 0;
    this.headCount = 0;
    this.loadSinces = 0;
    this.batchHeads = 0;
    this.appends = 0;
    this.existsCount = 0;
  }

  async exists(gameId: string, signal?: AbortSignal): Promise<boolean> {
    this.existsCount++;
    signal?.throwIfAborted();
    if (this.existsGate) {
      const g = this.existsGate;
      this.existsGate = undefined;
      g.isEntered = true;
      await g.release.done;
    }
    return this.inner.exists(gameId, signal);
  }

  async load(gameId: string, signal?: AbortSignal): Promise<readonly LoggedEvent[]> {
    this.loads++;
    this.lastLoadSignal = signal;
    signal?.throwIfAborted();
    if (this.hangLoad) {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    if (this.loadGate) {
      const g = this.loadGate;
      this.loadGate = undefined;
      g.isEntered = true;
      await g.release.done;
    }
    const res = await this.inner.load(gameId, signal);
    if (this.nextLoadGate) {
      const g = this.nextLoadGate;
      this.nextLoadGate = undefined;
      g.isEntered = true;
      await g.release.done;
    }
    return res;
  }

  async head(gameId: string, signal?: AbortSignal): Promise<number> {
    this.headCount++;
    this.lastHeadSignal = signal;
    signal?.throwIfAborted();
    if (this.hangHead) {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    let res: number;
    if (typeof this.inner.head === 'function') {
      res = await this.inner.head(gameId, signal);
    } else {
      const log = await this.inner.load(gameId);
      res = log.length === 0 ? -1 : log.length - 1;
    }
    if (this.headGate) {
      const g = this.headGate;
      this.headGate = undefined;
      g.isEntered = true;
      await g.release.done;
    }
    return res;
  }

  async loadSince(gameId: string, afterSeq: number, signal?: AbortSignal): Promise<readonly LoggedEvent[]> {
    this.loadSinces++;
    this.lastLoadSinceSignal = signal;
    signal?.throwIfAborted();
    if (this.hangLoadSince) {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    if (this.beforeLoadSinceGate) {
      const g = this.beforeLoadSinceGate;
      this.beforeLoadSinceGate = undefined;
      g.isEntered = true;
      await g.release.done;
    }
    let res: readonly LoggedEvent[];
    if (typeof this.inner.loadSince === 'function') {
      res = await this.inner.loadSince(gameId, afterSeq, signal);
    } else {
      const log = await this.inner.load(gameId);
      res = log.filter((e) => e.seq > afterSeq);
    }
    if (this.loadSinceGate) {
      const g = this.loadSinceGate;
      this.loadSinceGate = undefined;
      g.isEntered = true;
      await g.release.done;
    }
    if (this.corruptSuffix && res.length > 0) {
      return res.map((e, idx) => ({ ...e, seq: e.seq + 10 + idx }));
    }
    if (this.suffixMutation) return this.suffixMutation(res);
    return res;
  }

  async heads(gameIds: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, number>> {
    this.batchHeads++;
    signal?.throwIfAborted();
    if (typeof this.inner.heads === 'function') {
      return this.inner.heads(gameIds, signal);
    }
    const map = new Map<string, number>();
    for (const id of gameIds) {
      const log = await this.inner.load(id);
      map.set(id, log.length === 0 ? -1 : log.length - 1);
    }
    return map;
  }

  async append(gameId: string, expectedSeq: number, events: readonly GameEvent[], signal?: AbortSignal): Promise<number> {
    this.appends++;
    this.lastAppendSignal = signal;
    signal?.throwIfAborted();
    if (this.hangAppend) {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    if (this.appendGate) {
      const g = this.appendGate;
      this.appendGate = undefined;
      g.isEntered = true;
      await g.release.done;
    }
    return this.inner.append(gameId, expectedSeq, events, signal);
  }
}

// ---------------------------------------------------------------------------
// DA1 - DA9: Durable Read Optimizations
// ---------------------------------------------------------------------------

test('DA1: Warm join (edge already resident and fresh)', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-da1';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Edge joins once to become resident and fresh at rev 0.
  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(c1.last('joined'));

  // Reset counts before the warm join under test.
  store.resetCounts();

  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await flush();

  assert.equal(store.loads, 0, '0 full loads');
  assert.equal(store.headCount, 1, '1 head');
  assert.deepEqual(c2.last('joined')!.state, writer.getState(gameId), "joined state equals the writer's state");
});

test('DA2: Cold join', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-da2';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  assert.equal(edge.has(gameId), false);
  store.resetCounts();

  const c = new InMemoryConnection('c');
  gateway.handleConnection(c);
  c.deliver({ t: 'join', gameId });
  await flush();

  assert.equal(store.loads, 1, '1 full load (hydration)');
  assert.equal(store.headCount, 1, '1 head');
  assert.equal(c.last('joined')!.state.stateRevision, 0);
});

test('DA3: Non-owner resident behind: edge joined at rev 0; writer commits 3 moves; a second connection joins', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-da3';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Edge joins at rev 0
  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(c1.last('joined'));

  // Writer commits 3 moves
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'g1f3' });

  store.resetCounts();

  // A second connection joins
  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await flush();

  assert.equal(store.headCount, 1, '1 head');
  assert.equal(store.loadSinces, 1, '1 loadSince');
  assert.equal(store.loads, 0, '0 full loads');

  const joined = c2.last('joined');
  assert.ok(joined);
  const writerState = writer.getState(gameId);
  assert.deepEqual(joined.state.stateRevision, writerState.stateRevision);
  assert.deepEqual(joined.state.ply, writerState.ply);
  assert.deepEqual(joined.state.moves, writerState.moves);
  assert.deepEqual(joined.state.drawOffer, writerState.drawOffer);
  assert.deepEqual(joined.state.fenHash, writerState.fenHash);

  // Resume variant
  c1.deliver({ t: 'resume', gameId, lastPly: 0 });
  await flush();
  const resumed = c1.last('resumed');
  assert.ok(resumed);
  const freshRebuild = await new GameAuthority(pubsub, () => 1000, store).readRecovery(gameId, 0);
  assert.deepEqual(resumed.missed, freshRebuild.missed, 'missed deep-equals the missed list from a fresh full rebuild');
});

test('DA4: Commit racing between head and loadSince (gate loadSince; writer commits 2 more; release)', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-da4';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();

  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  // Gate loadSince before snapshot
  const gate = createGate();
  store.beforeLoadSinceGate = gate;

  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await awaitGate(gate, 'loadSince');

  // Writer commits 2 more moves while gated
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });
  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'g1f3' });

  gate.release.resolve();
  await flush();

  const joined = c2.last('joined');
  assert.ok(joined);
  assert.ok(joined.state.stateRevision >= 1);
  assert.equal(joined.state.stateRevision, 3);
  assert.equal(joined.state.ply, joined.state.moves.length);

  const freshRebuild = await new GameAuthority(pubsub, () => 1000, store).readRecovery(gameId, 0);
  assert.deepEqual(freshRebuild.state.stateRevision, joined.state.stateRevision);
});

test('DA5: Same-node command commits on the edge while head is gated', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-da5';
  await edge.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const white = new InMemoryConnection('white');
  gateway.handleConnection(white);
  white.deliver({ t: 'join', gameId, token: 'tok-alice' });
  await flush();

  const headGate = createGate();
  store.headGate = headGate;

  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await awaitGate(headGate, 'head');

  // Commit on edge while head is gated
  await edge.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  const residentRev = edge.getState(gameId).stateRevision;

  headGate.release.resolve();
  await flush();

  const joined = c2.last('joined');
  assert.ok(joined);
  assert.ok(joined.state.stateRevision >= residentRev, "result is not older than the edge's resident");
});

test('DA6: Eviction while head is gated', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-da6';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();

  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  const headGate = createGate();
  store.headGate = headGate;

  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await awaitGate(headGate, 'head');

  // Evict while head is gated
  edge.evict(gameId);

  headGate.release.resolve();
  await flush();

  const joined = c2.last('joined');
  assert.ok(joined);
  assert.equal(joined.state.stateRevision, 1);
  assert.equal(edge.has(gameId), true, 'join re-hydrates after an eviction during its read');
});

test('DA7: Resident replaced by reload during gated loadSince', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-da7';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();

  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  const gate = createGate();
  store.loadSinceGate = gate;

  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await awaitGate(gate, 'loadSince');

  // Writer commits move 2 and edge reloads
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });
  await edge.reloadFromLog(gameId);

  gate.release.resolve();
  await flush();

  // The suffix read built a detached record at revision 1, but the reloaded resident (revision 2)
  // is newer and must win; serving the detached record would hand c2 an older snapshot.
  const joined = c2.last('joined');
  assert.ok(joined);
  const writerState = writer.getState(gameId);
  assert.equal(writerState.stateRevision, 2);
  assert.equal(joined.state.stateRevision, 2, 'the newer reloaded resident wins over the detached suffix record');
  assert.deepEqual(joined.state.moves, writerState.moves);
  assert.equal(joined.state.fenHash, writerState.fenHash);
});

test('DA8: Non-contiguous suffix', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-da8';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();

  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  store.corruptSuffix = true;
  store.resetCounts();

  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await flush();

  assert.equal(store.loads, 1, 'falls back to full load');
  const joined = c2.last('joined');
  assert.ok(joined);
  assert.equal(joined.state.stateRevision, 2);
  assert.equal(joined.state.ply, 2);
});

/** An edge store exposing only the required EventLog methods (plus `head` when asked). */
function withoutCapabilities(store: CountingLog, keepHead: boolean): EventLog {
  const base: EventLog = {
    append: (gameId, expectedSeq, events, signal) => store.append(gameId, expectedSeq, events, signal),
    load: (gameId, signal) => store.load(gameId, signal),
    exists: (gameId, signal) => store.exists(gameId, signal),
  };
  return keepHead ? { ...base, head: (gameId, signal) => store.head(gameId, signal) } : base;
}

const suffixFallbackCases: ReadonlyArray<{
  name: string;
  mutate?: (suffix: readonly LoggedEvent[]) => readonly LoggedEvent[];
  edgeStore?: (store: CountingLog) => EventLog;
  heads: number;
  loadSinces: number;
}> = [
  { name: 'mid-suffix gap', mutate: (s) => [s[0]!, ...s.slice(2)], heads: 1, loadSinces: 1 },
  { name: 'duplicate seq', mutate: (s) => [s[0]!, s[0]!, ...s.slice(1)], heads: 1, loadSinces: 1 },
  { name: 'empty suffix while head is ahead', mutate: () => [], heads: 1, loadSinces: 1 },
  { name: 'store with head but no loadSince', edgeStore: (s) => withoutCapabilities(s, true), heads: 1, loadSinces: 0 },
  { name: 'store with neither head nor loadSince', edgeStore: (s) => withoutCapabilities(s, false), heads: 0, loadSinces: 0 },
];

for (const c of suffixFallbackCases) {
  test(`DA10 (${c.name}): recovery falls back to a full load and serves a coherent current snapshot`, async () => {
    const innerStore = new InMemoryEventLog();
    const store = new CountingLog(innerStore);
    const pubsub = new InMemoryPubSub();
    const writer = new GameAuthority(pubsub, () => 1000, store);
    const edge = new GameAuthority(pubsub, () => 1000, c.edgeStore ? c.edgeStore(store) : store);
    const gateway = new RealtimeGateway(edge, pubsub, new FakeTokenVerifier());

    const gameId = `game-da10-${c.name.replace(/\W+/g, '-')}`;
    await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

    // The edge becomes resident at revision 0, then the writer commits three moves.
    const c1 = new InMemoryConnection('c1');
    gateway.handleConnection(c1);
    c1.deliver({ t: 'join', gameId });
    await flush();
    assert.ok(c1.last('joined'));
    await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
    await writer.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });
    await writer.apply(gameId, 'alice', { kind: 'move', uci: 'g1f3' });

    store.suffixMutation = c.mutate;
    store.resetCounts();

    const c2 = new InMemoryConnection('c2');
    gateway.handleConnection(c2);
    c2.deliver({ t: 'join', gameId });
    await flush();

    assert.equal(store.headCount, c.heads, 'head checks');
    assert.equal(store.loadSinces, c.loadSinces, 'suffix reads');
    assert.equal(store.loads, 1, 'exactly one full-load fallback');
    assert.equal(c2.all('reject').length, 0);
    const writerState = writer.getState(gameId);
    assert.equal(writerState.stateRevision, 3);
    const joined = c2.last('joined');
    assert.ok(joined, 'the join is served, not rejected');
    assert.equal(joined.state.stateRevision, writerState.stateRevision);
    assert.deepEqual(joined.state.moves, writerState.moves);
    assert.equal(joined.state.fenHash, writerState.fenHash);
    assert.deepEqual(joined.state.drawOffer, writerState.drawOffer);

    // The resume path takes the same fallback; its missed broadcasts match a fresh full rebuild.
    c1.deliver({ t: 'resume', gameId, lastPly: 0 });
    await flush();
    const resumed = c1.last('resumed');
    assert.ok(resumed);
    assert.equal(resumed.state.stateRevision, writerState.stateRevision);
    const fresh = await new GameAuthority(pubsub, () => 1000, innerStore).readRecovery(gameId, 0);
    assert.equal(fresh.missed.length, 3);
    assert.deepEqual(resumed.missed, fresh.missed);
  });
}

test('DA9: Same-ply draw offer committed remotely after hydration', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-da9';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();

  // Writer commits draw offer
  await writer.apply(gameId, 'alice', { kind: 'offerDraw' });

  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await flush();

  const joined = c2.last('joined');
  assert.ok(joined);
  assert.equal(joined.state.drawOffer, 'w');
  assert.equal(joined.state.stateRevision, 1);
});

// ---------------------------------------------------------------------------
// Deadline tests (DT1 - DT9)
// ---------------------------------------------------------------------------

test('DT1: A hung hydration load with durableReadTimeoutMs set', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();
  const edge = new GameAuthority(pubsub, () => 1000, store, {
    durableReadTimeoutMs: 1000,
    schedule: scheduler.schedule,
  });
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-dt1';
  await new GameAuthority(pubsub, () => 1000, store).createGame({
    gameId,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: false,
  });

  store.hangLoad = true;

  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();

  assert.equal(c1.sent.length, 0, 'before fire() there is no frame');

  scheduler.fire();
  await flush();

  const reject = c1.last('reject');
  assert.ok(reject, 'client receives reject');
  assert.equal(reject.code, 'invalid_command');
  assert.match(reject.message, /failed to load game/);
  assert.equal(store.lastLoadSignal?.aborted, true, "store's signal is aborted");

  // Later join after store is un-hung succeeds
  store.hangLoad = false;
  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await flush();

  assert.ok(c2.last('joined'), 'later join succeeds, queue not stuck');
});

test('DT2: Resume with a hung read: reject, then recovery', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();
  const edge = new GameAuthority(pubsub, () => 1000, store, {
    durableReadTimeoutMs: 1000,
    schedule: scheduler.schedule,
  });
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-dt2';
  await new GameAuthority(pubsub, () => 1000, store).createGame({
    gameId,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: false,
  });

  const c = new InMemoryConnection('c');
  gateway.handleConnection(c);
  c.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(c.last('joined'));

  store.hangHead = true;
  c.deliver({ t: 'resume', gameId, lastPly: 0 });
  await flush();

  assert.equal(c.all('reject').length, 0);
  scheduler.fire();
  await flush();

  assert.ok(c.last('reject'), 'resume rejected on timeout');

  // Recovery
  store.hangHead = false;
  c.deliver({ t: 'resume', gameId, lastPly: 0 });
  await flush();
  assert.ok(c.last('resumed'), 'later resume succeeds');
});

test('DT3: Hung head: join reject', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();
  const edge = new GameAuthority(pubsub, () => 1000, store, {
    durableReadTimeoutMs: 1000,
    schedule: scheduler.schedule,
  });
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-dt3';
  await new GameAuthority(pubsub, () => 1000, store).createGame({
    gameId,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: false,
  });

  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(c1.last('joined'));

  store.hangHead = true;
  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await flush();

  scheduler.fire();
  await flush();

  const reject = c2.last('reject');
  assert.ok(reject);
  assert.equal(reject.code, 'invalid_command');
  assert.match(reject.message, /failed to load game/);
  assert.equal(store.lastHeadSignal?.aborted, true, 'head signal aborted');
});

test('DT4: Hung loadSince: join reject', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store, {
    durableReadTimeoutMs: 1000,
    schedule: scheduler.schedule,
  });
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-dt4';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(c1.last('joined'));

  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  store.hangLoadSince = true;
  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await flush();

  scheduler.fire();
  await flush();

  const reject = c2.last('reject');
  assert.ok(reject);
  assert.equal(reject.code, 'invalid_command');
  assert.match(reject.message, /failed to load game/);
  assert.equal(store.lastLoadSinceSignal?.aborted, true, 'loadSince signal aborted');
});

test('DT5: A hung read inside the overtaken draw-state refresh counts as a failed attempt', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();
  const writer = new GameAuthority(pubsub, () => 1000, store);
  const edge = new GameAuthority(pubsub, () => 1000, store, {
    durableReadTimeoutMs: 1000,
    schedule: scheduler.schedule,
  });
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
  const failedCalls: { gameId: string; error: unknown }[] = [];
  const gateway = new RealtimeGateway(
    edge,
    pubsub,
    verifier,
    () => 1000,
    router,
    undefined,
    undefined,
    (gameId, err) => failedCalls.push({ gameId, error: err }),
  );

  const gameId = 'game-dt5';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const white = new InMemoryConnection('white');
  gateway.handleConnection(white);
  white.deliver({ t: 'join', gameId, token: 'tok-alice' });
  const spec = new InMemoryConnection('spec');
  gateway.handleConnection(spec);
  spec.deliver({ t: 'join', gameId });
  await flush();

  const gate = createGate();
  drawGate = gate;
  white.deliver({ t: 'offerDraw', gameId });
  await awaitGate(gate, 'offerDraw');

  await writer.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await flush();

  store.hangHead = true;
  gate.release.resolve();
  await flush();

  // 3 attempts; fire scheduler for each attempt
  for (let i = 0; i < 3; i++) {
    scheduler.fire();
    await flush();
  }

  assert.equal(failedCalls.length, 1, 'onStateRefreshFailed called exactly once');
  assert.equal(failedCalls[0]!.gameId, gameId);
  assert.equal(white.all('reject').length, 0);
  assert.equal(white.all('outcomeUnknown').length, 0);
});

test('DT6: A hung append for a command with durableWriteTimeoutMs', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();
  const edge = new GameAuthority(pubsub, () => 1000, store, {
    durableWriteTimeoutMs: 1000,
    schedule: scheduler.schedule,
  });
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-dt6';
  await edge.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const white = new InMemoryConnection('white');
  gateway.handleConnection(white);
  white.deliver({ t: 'join', gameId, token: 'tok-alice' });
  await flush();

  store.hangAppend = true;
  white.deliver({ t: 'move', gameId, clientSeq: 1, uci: 'e2e4' });
  await flush();

  assert.equal(white.all('outcomeUnknown').length, 0);
  scheduler.fire();
  await flush();

  assert.equal(white.all('reject').length, 0, 'must not be reject');
  assert.ok(white.last('outcomeUnknown'), 'client receives outcomeUnknown');

  // The aborted append rejected, so the fence reconciled from the log: the move never committed.
  // A later command on the same game must then commit and reach the client.
  assert.equal(edge.stalledWriteCount(), 0, 'the fence cleared once the append settled');
  store.hangAppend = false;
  white.deliver({ t: 'resign', gameId });
  await flush();
  const ended = white.last('ended');
  assert.ok(ended, 'the later resign commits and is broadcast');
  assert.equal(ended.termination, 'resignation');
  assert.equal(ended.winner, 'b');
  const log = await innerStore.load(gameId);
  assert.deepEqual(log.map((e) => e.event.type).filter((t) => t === 'MovePlayed'), [], 'the timed-out move did not commit');
  assert.deepEqual(edge.getState(gameId).moves, []);
});

test('DT6b: Throwing write-stall hooks are reported and do not break the fence', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const scheduler = new ManualScheduler();
  const edge = new GameAuthority(new InMemoryPubSub(), () => 1000, store, {
    durableWriteTimeoutMs: 1000,
    schedule: scheduler.schedule,
    onDurableWriteStalled: () => { throw new Error('stall hook broke'); },
    onDurableWriteSettled: () => { throw new Error('settle hook broke'); },
  });
  const gameId = 'game-dt6b';
  await edge.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const reported: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { reported.push(args); };
  try {
    store.hangAppend = true;
    const move = edge.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
    const outcome = assert.rejects(move, (err: unknown) => err instanceof AuthorityCommitError);
    await flush();
    scheduler.fire();
    await outcome;
    await flush();
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(
    reported.map((args) => [String(args[0]), (args[1] as Error).message]),
    [
      ['[GameAuthority] onDurableWriteStalled hook threw:', 'stall hook broke'],
      ['[GameAuthority] onDurableWriteSettled hook threw:', 'settle hook broke'],
    ],
  );
  assert.equal(edge.stalledWriteCount(), 0, 'the fence still cleared after the append settled');
  store.hangAppend = false;
  const resigned = await edge.apply(gameId, 'alice', { kind: 'resign' });
  assert.equal(resigned.state.status.over, true, 'a later command commits');
});

test('DT7: No timers are left behind after a successful read', async () => {
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();
  const edge = new GameAuthority(pubsub, () => 1000, store, {
    durableReadTimeoutMs: 1000,
    durableWriteTimeoutMs: 1000,
    schedule: scheduler.schedule,
  });
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-dt7';
  await edge.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const c = new InMemoryConnection('c');
  gateway.handleConnection(c);
  c.deliver({ t: 'join', gameId });
  await flush();

  assert.ok(c.last('joined'));
  assert.equal(scheduler.pendingCount, 0, 'scheduler pending count returns to 0');
});

test('DT8: Eviction during a pending timed read: no unhandled rejection; a later join succeeds', async () => {
  // an eviction during a failed hydration retries once on a fresh generation (existing R-01 behaviour); each attempt is individually bounded
  const innerStore = new InMemoryEventLog();
  const store = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();
  const edge = new GameAuthority(pubsub, () => 1000, store, {
    durableReadTimeoutMs: 1000,
    schedule: scheduler.schedule,
  });
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-dt8';
  await new GameAuthority(pubsub, () => 1000, store).createGame({
    gameId,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: false,
  });

  store.hangLoad = true;
  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();

  edge.evict(gameId);
  scheduler.fire();
  await flush();

  assert.equal(c1.all('reject').length, 0, 'c1 has NO reject yet');
  assert.equal(scheduler.pendingCount, 1, "c1's retry is in flight under a fresh deadline");

  scheduler.fire();
  await flush();

  const reject1 = c1.last('reject');
  assert.ok(reject1);
  assert.equal(reject1.code, 'invalid_command');
  assert.equal(scheduler.pendingCount, 0);

  store.hangLoad = false;
  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await flush();

  assert.ok(c2.last('joined'));
  assert.equal(c2.last('reject'), undefined);
});

test('DT9: The constructor rejects invalid timeout options', () => {
  const pubsub = new InMemoryPubSub();
  const store = new InMemoryEventLog();
  const now = () => 1000;

  assert.throws(() => new GameAuthority(pubsub, now, store, { durableReadTimeoutMs: 0 }), RangeError);
  assert.throws(() => new GameAuthority(pubsub, now, store, { durableReadTimeoutMs: -1 }), RangeError);
  assert.throws(() => new GameAuthority(pubsub, now, store, { durableReadTimeoutMs: 600001 }), RangeError);
  assert.throws(() => new GameAuthority(pubsub, now, store, { durableReadTimeoutMs: 1.5 }), RangeError);
  assert.throws(() => new GameAuthority(pubsub, now, store, { durableWriteTimeoutMs: 0 }), RangeError);
  assert.throws(() => new GameAuthority(pubsub, now, store, { durableWriteTimeoutMs: 600001 }), RangeError);
  assert.throws(() => new GameAuthority(pubsub, now, store, { durableWriteTimeoutMs: NaN }), RangeError);
});

// ---------------------------------------------------------------------------
// QR1h and CR2h
// ---------------------------------------------------------------------------

test('QR1h regression: cold resume whose hydration snapshot predates a remote draw offer delivers the committed offer (with head)', async () => {
  const innerStore = new InMemoryEventLog();
  const countingLog = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, innerStore);
  const edge = new GameAuthority(pubsub, () => 1000, countingLog);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-qr1h';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const conn = new InMemoryConnection('c-qr1h');
  gateway.handleConnection(conn);
  conn.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(conn.last('joined'));

  edge.evict(gameId);
  assert.equal(edge.has(gameId), false);

  const gate1 = createGate();
  countingLog.nextLoadGate = gate1;
  conn.deliver({ t: 'resume', gameId, lastPly: 0 });
  await awaitGate(gate1, 'cold hydration snapshot');

  await writer.apply(gameId, 'alice', { kind: 'offerDraw' });
  assert.equal(writer.getState(gameId).drawOffer, 'w');
  assert.equal(writer.getState(gameId).stateRevision, 1);

  gate1.release.resolve();
  await flush();
  await flush();
  await flush();

  assert.equal(conn.all('resumed').length, 1);
  const resumed = conn.last('resumed');
  assert.ok(resumed);
  assert.equal(resumed.state.drawOffer, 'w');
  assert.equal(resumed.state.stateRevision, 1);
  assert.equal(conn.all('reject').length, 0);
  assert.equal(edge.has(gameId), true);
});

test('CR2h boundary characterization: D2 boundary with head/suffix', async () => {
  // flips GREEN->changed in Stage C/D
  const innerStore = new InMemoryEventLog();
  const countingLog = new CountingLog(innerStore);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, innerStore);
  const edge = new GameAuthority(pubsub, () => 1000, countingLog);
  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(edge, pubsub, verifier);

  const gameId = 'game-cr2h';
  await writer.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const conn = new InMemoryConnection('c-cr2h');
  gateway.handleConnection(conn);
  conn.deliver({ t: 'join', gameId });
  await flush();
  assert.ok(conn.last('joined'));

  edge.evict(gameId);
  assert.equal(edge.has(gameId), false);

  const gate1 = createGate();
  countingLog.nextLoadGate = gate1;

  conn.deliver({ t: 'resume', gameId, lastPly: 0 });
  await awaitGate(gate1, 'cold hydration');

  const gate2 = createGate();
  countingLog.headGate = gate2;
  gate1.release.resolve();

  await awaitGate(gate2, 'final head read');

  // Commit remote draw offer while head is gated
  await writer.apply(gameId, 'alice', { kind: 'offerDraw' });
  assert.equal(writer.getState(gameId).drawOffer, 'w');

  gate2.release.resolve();
  await flush();

  const resumed = conn.last('resumed');
  assert.ok(resumed);
  // D2 boundary: the offer committed after the final head snapshot is not in `resumed`; Stage D reconciliation must later deliver it (this test is extended there)
  assert.equal(resumed.state.drawOffer, null);
  assert.equal(resumed.state.stateRevision, 0);
});
