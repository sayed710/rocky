import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameEvent, TimeControl } from '@chess-platform/game';
import { Game } from '@chess-platform/game';
import {
  GameAuthority,
  AuthorityError,
  AuthorityCommitError,
} from '../src/authority';
import type { EventLog, LoggedEvent } from '../src/event-log';
import { InMemoryEventLog } from '../src/event-log';
import { InMemoryPubSub, gameChannel } from '../src/pubsub';
import { RealtimeGateway } from '../src/gateway';
import { InMemoryConnection } from '../src/transport';
import { FakeTokenVerifier } from './fake-token-verifier';
import type { Broadcast } from '../src/protocol';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class ManualScheduler {
  tasks: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];

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

  fire(targetMs?: number): void {
    const active = this.tasks.filter((t) => !t.cancelled && (targetMs === undefined || t.ms === targetMs));
    for (const t of active) {
      t.cancelled = true;
      t.fn();
    }
  }
}

interface AppendGate {
  isEntered: boolean;
  resolve?: () => void;
  reject?: (err: unknown) => void;
  ignoreAbort?: boolean;
}

interface LoadGate {
  isEntered: boolean;
  resolve?: (events: readonly LoggedEvent[]) => void;
  reject?: (err: unknown) => void;
  ignoreAbort?: boolean;
}

class GatedEventStore implements EventLog {
  loads = 0;
  appends = 0;
  appendGate?: AppendGate;
  loadGate?: LoadGate;
  syncThrowAppend?: Error;
  syncThrowLoad?: Error;

  constructor(readonly inner: InMemoryEventLog = new InMemoryEventLog()) {}

  async exists(gameId: string, signal?: AbortSignal): Promise<boolean> {
    return this.inner.exists(gameId, signal);
  }

  async load(gameId: string, signal?: AbortSignal): Promise<readonly LoggedEvent[]> {
    this.loads++;
    if (this.syncThrowLoad) {
      throw this.syncThrowLoad;
    }
    if (this.loadGate) {
      this.loadGate.isEntered = true;
      const g = this.loadGate;
      return new Promise<readonly LoggedEvent[]>((res, rej) => {
        g.resolve = (val) => res(val);
        g.reject = (err) => rej(err);
        if (!g.ignoreAbort && signal) {
          signal.addEventListener('abort', () => rej(signal.reason ?? new Error('aborted')), { once: true });
        }
      });
    }
    return this.inner.load(gameId, signal);
  }

  async append(gameId: string, expectedSeq: number, events: readonly GameEvent[], signal?: AbortSignal): Promise<number> {
    this.appends++;
    if (this.syncThrowAppend) {
      throw this.syncThrowAppend;
    }
    if (this.appendGate) {
      this.appendGate.isEntered = true;
      const g = this.appendGate;
      return new Promise<number>((res, rej) => {
        g.resolve = () => {
          // A late COMMIT: the simulated store ignores the (possibly aborted) signal.
          this.inner.append(gameId, expectedSeq, events).then(res, rej);
        };
        g.reject = rej;
        if (!g.ignoreAbort && signal) {
          signal.addEventListener('abort', () => rej(signal.reason ?? new Error('aborted')), { once: true });
        }
      });
    }
    return this.inner.append(gameId, expectedSeq, events, signal);
  }
}

test('WF1 (late COMMIT): append gated; fire the deadline', async () => {
  const store = new GatedEventStore();
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();

  const stalledEvents: Array<{ gameId: string; op: 'append' | 'create' }> = [];
  const settledEvents: Array<{ gameId: string; op: 'append' | 'create'; outcome: 'committed' | 'failed' }> = [];

  const authority = new GameAuthority(pubsub, () => 1000, store, {
    durableWriteTimeoutMs: 1000,
    schedule: scheduler.schedule,
    onDurableWriteStalled: (gameId, op) => stalledEvents.push({ gameId, op }),
    onDurableWriteSettled: (gameId, op, outcome) => settledEvents.push({ gameId, op, outcome }),
  });

  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  const gameId = 'wf1-game';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const alice = new InMemoryConnection('alice');
  const bob = new InMemoryConnection('bob');
  gateway.handleConnection(alice);
  gateway.handleConnection(bob);

  alice.deliver({ t: 'join', gameId, token: 'tok-alice' });
  bob.deliver({ t: 'join', gameId, token: 'tok-bob' });
  await flush();

  const broadcasts: Broadcast[] = [];
  pubsub.subscribe(gameChannel(gameId), (m) => broadcasts.push(m));

  // Gate the append and ignore abort so it stays pending past the deadline
  store.appendGate = { isEntered: false, ignoreAbort: true };

  // 1. First command
  alice.deliver({ t: 'move', gameId, clientSeq: 1, uci: 'e2e4' });
  await flush();
  assert.equal(store.appendGate.isEntered, true, 'append gate was reached');
  const appendsBefore = store.appends;

  // Fire the write deadline
  scheduler.fire(1000);
  await flush();

  // The caller gets outcomeUnknown (via gateway: t: 'outcomeUnknown', never 'reject')
  assert.equal(alice.all('reject').length, 0, 'must never be reject');
  assert.equal(alice.all('outcomeUnknown').length, 1, 'must receive outcomeUnknown');
  assert.equal(authority.stalledWriteCount(), 1, 'stalledWriteCount === 1');
  assert.deepEqual(stalledEvents, [{ gameId, op: 'append' }], 'stalled hook fired once');

  // A second command on the same game issued now is refused at once with unavailable invalid_command and is NOT executed
  bob.deliver({ t: 'move', gameId, clientSeq: 2, uci: 'e7e5' });
  await flush();
  const lastBobReject = bob.last('reject');
  assert.ok(lastBobReject, 'second command refused at once');
  assert.equal(lastBobReject?.code, 'invalid_command');
  assert.ok(
    lastBobReject?.message?.includes('unavailable: an earlier durable write has not settled'),
    `expected unavailable message, got: ${lastBobReject?.message}`,
  );
  assert.equal(store.appends, appendsBefore, 'second command was NOT executed (append count unchanged)');

  // Then release the gate with SUCCESS
  store.appendGate.resolve?.();
  store.appendGate = undefined;
  await flush();

  // The move is in authority state, broadcast once, stalled cleared, settled hook fired with 'committed'
  assert.equal(authority.stalledWriteCount(), 0, 'stalled cleared');
  assert.deepEqual(settledEvents, [{ gameId, op: 'append', outcome: 'committed' }]);
  assert.equal(authority.getState(gameId).ply, 1, 'move is in authority state');
  const moveBroadcasts = broadcasts.filter((b) => b.t === 'move' && b.uci === 'e2e4');
  assert.equal(moveBroadcasts.length, 1, 'broadcast once');

  // A third command executes normally on the reconciled state
  bob.deliver({ t: 'move', gameId, clientSeq: 3, uci: 'e7e5' });
  await flush();
  assert.equal(authority.getState(gameId).ply, 2, 'third command executed normally on reconciled state');
});

test('WF2 (late failure): Same, but the gate releases with an I/O error (not appendRejected)', async () => {
  const store = new GatedEventStore();
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();

  const settledEvents: Array<{ gameId: string; op: 'append' | 'create'; outcome: 'committed' | 'failed' }> = [];

  const authority = new GameAuthority(pubsub, () => 1000, store, {
    durableWriteTimeoutMs: 1000,
    durableReadTimeoutMs: 1000,
    schedule: scheduler.schedule,
    onDurableWriteSettled: (gameId, op, outcome) => settledEvents.push({ gameId, op, outcome }),
  });

  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  const gameId = 'wf2-game';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const alice = new InMemoryConnection('alice');
  const bob = new InMemoryConnection('bob');
  gateway.handleConnection(alice);
  gateway.handleConnection(bob);

  alice.deliver({ t: 'join', gameId, token: 'tok-alice' });
  bob.deliver({ t: 'join', gameId, token: 'tok-bob' });
  await flush();

  store.appendGate = { isEntered: false, ignoreAbort: true };

  alice.deliver({ t: 'move', gameId, clientSeq: 1, uci: 'e2e4' });
  await flush();

  // Fire write deadline
  scheduler.fire(1000);
  await flush();

  // Caller got outcomeUnknown, not reject
  assert.equal(alice.all('reject').length, 0, 'no false definite reject sent for timed-out command');
  assert.equal(alice.all('outcomeUnknown').length, 1);

  // Gate releases with an I/O error (not appendRejected)
  const loadsBefore = store.loads;
  store.appendGate.reject?.(new Error('disk I/O failure'));
  store.appendGate = undefined;
  await flush();

  // Durable reconciliation (refreshSlot) runs before any later command
  assert.ok(store.loads > loadsBefore, 'refreshSlot loaded from store');
  assert.deepEqual(settledEvents, [{ gameId, op: 'append', outcome: 'failed' }], 'settled hook fired with failed');
  assert.equal(authority.stalledWriteCount(), 0, 'stall cleared');

  // State equals durable log (ply 0)
  assert.equal(authority.getState(gameId).ply, 0, 'state matches durable log');
});

test('WF3 (ignores abort forever): The append never settles', async () => {
  const store = new GatedEventStore();
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();

  const authority = new GameAuthority(pubsub, () => 1000, store, {
    durableWriteTimeoutMs: 1000,
    durableReadTimeoutMs: 1000,
    schedule: scheduler.schedule,
  });

  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  const gameId = 'wf3-game';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const alice = new InMemoryConnection('alice');
  const bob = new InMemoryConnection('bob');
  gateway.handleConnection(alice);
  gateway.handleConnection(bob);
  alice.deliver({ t: 'join', gameId, token: 'tok-alice' });
  bob.deliver({ t: 'join', gameId, token: 'tok-bob' });
  await flush();

  store.appendGate = { isEntered: false, ignoreAbort: true };

  // First command starts and hangs
  alice.deliver({ t: 'move', gameId, clientSeq: 1, uci: 'e2e4' });
  await flush();

  // Second command queued BEFORE deadline
  bob.deliver({ t: 'resign', gameId });
  await flush();

  assert.equal(authority.pendingCommandCount(gameId), 2, 'two commands in queue');

  // Fire write deadline
  scheduler.fire(1000);
  await flush();

  // Caller 1 got outcomeUnknown
  assert.equal(alice.all('outcomeUnknown').length, 1);

  // Command 2 queued BEFORE the deadline is refused with unavailable
  const bobReject = bob.last('reject');
  assert.ok(bobReject, 'queued command refused');
  assert.equal(bobReject?.code, 'invalid_command');
  assert.ok(bobReject?.message?.includes('unavailable: an earlier durable write has not settled'));

  // New commands are refused at once (an immediate rejection, never queued)
  const pendingAtStall = authority.pendingCommandCount(gameId);
  await assert.rejects(
    authority.apply(gameId, 'alice', { kind: 'resign' }),
    (e: unknown) => e instanceof AuthorityError && e.code === 'invalid_command' && e.message.includes('unavailable'),
  );
  assert.equal(authority.pendingCommandCount(gameId), pendingAtStall, 'the refused command was not queued');

  // A join or resume on that game is rejected 'failed to load game' within its read deadline
  const charlie = new InMemoryConnection('charlie');
  verifier.allow('tok-charlie', 'charlie');
  gateway.handleConnection(charlie);
  charlie.deliver({ t: 'join', gameId, token: 'tok-charlie' });
  await flush();
  const charlieReject = charlie.last('reject');
  assert.ok(charlieReject, 'join rejected');
  assert.equal(charlieReject?.code, 'invalid_command');
  assert.equal(charlieReject?.message, 'failed to load game');

  assert.equal(authority.stalledWriteCount(), 1, 'stalledWriteCount === 1 stays');

  // No growth: 50 further commands neither enqueue nor accumulate
  const pendingBefore = authority.pendingCommandCount(gameId);
  for (let i = 0; i < 50; i++) {
    await assert.rejects(
      authority.apply(gameId, 'alice', { kind: 'resign' }),
      (e: unknown) => e instanceof AuthorityError && e.code === 'invalid_command' && e.message.includes('unavailable'),
    );
  }
  assert.equal(authority.pendingCommandCount(gameId), pendingBefore, 'slot.pending unchanged');
});

test('WF4: A queued command whose turn arrives after cancellation', async () => {
  const store = new GatedEventStore();
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();

  const authority = new GameAuthority(pubsub, () => 1000, store, {
    durableWriteTimeoutMs: 1000,
    schedule: scheduler.schedule,
  });

  const gameId = 'wf4-game';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  store.appendGate = { isEntered: false, ignoreAbort: true };

  // Command 1 hangs
  const p1 = authority.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await flush();

  // Command 2 queued before deadline
  const p2 = authority.apply(gameId, 'bob', { kind: 'move', uci: 'e7e5' });
  await flush();

  // Attach the expectations before the deadline fires, so neither rejection is ever unhandled.
  const p1Rejects = assert.rejects(p1, AuthorityCommitError);
  const p2Rejects = assert.rejects(p2, (e: unknown) => e instanceof AuthorityError && e.message.includes('unavailable'));

  // Fire write deadline: cancels p2 and rejects p1 caller
  scheduler.fire(1000);
  await flush();

  await p1Rejects;
  await p2Rejects;

  // Store recovers: release Command 1 with success
  const appendsBefore = store.appends;
  store.appendGate.resolve?.();
  store.appendGate = undefined;
  await flush();

  // p2 never executes (append count for p2 was never invoked)
  assert.equal(store.appends, appendsBefore, 'p2 never executed an append after store recovered');
  assert.equal(authority.getState(gameId).ply, 1, 'only p1 committed');
});

/** A store whose methods throw synchronously (no async wrapper), as a non-async EventLog may. */
class SyncThrowStore implements EventLog {
  syncThrowAppend?: Error;
  syncThrowLoad?: Error;
  constructor(readonly inner: InMemoryEventLog = new InMemoryEventLog()) {}
  exists(gameId: string, signal?: AbortSignal): Promise<boolean> {
    return this.inner.exists(gameId, signal);
  }
  load(gameId: string, signal?: AbortSignal): Promise<readonly LoggedEvent[]> {
    if (this.syncThrowLoad) throw this.syncThrowLoad;
    return this.inner.load(gameId, signal);
  }
  append(gameId: string, expectedSeq: number, events: readonly GameEvent[], signal?: AbortSignal): Promise<number> {
    if (this.syncThrowAppend) throw this.syncThrowAppend;
    return this.inner.append(gameId, expectedSeq, events, signal);
  }
}

test('WF5 (sync-throw, #5): append and load implementations that throw synchronously', async () => {
  const store = new SyncThrowStore();
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();

  const authority = new GameAuthority(pubsub, () => 1000, store, {
    durableWriteTimeoutMs: 1000,
    durableReadTimeoutMs: 1000,
    schedule: scheduler.schedule,
  });

  const gameId = 'wf5-game';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  let unhandled = false;
  const onUnhandled = () => {
    unhandled = true;
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    // 1. Sync throw in append
    store.syncThrowAppend = new Error('sync append failure');
    await assert.rejects(
      authority.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' }),
      AuthorityCommitError,
    );
    assert.equal(scheduler.pendingCount, 0, 'timer must be cancelled after sync throw in append');
    assert.equal(unhandled, false, 'no unhandledRejection on sync append throw');

    // 2. Sync throw in load
    store.syncThrowAppend = undefined;
    store.syncThrowLoad = new Error('sync load failure');
    await assert.rejects(
      authority.reloadFromLog(gameId),
      /sync load failure/,
    );
    assert.equal(scheduler.pendingCount, 0, 'timer must be cancelled after sync throw in load');
    assert.equal(unhandled, false, 'no unhandledRejection on sync load throw');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('WF6 (abandoned read): A read times out, then settles late with data', async () => {
  const store = new GatedEventStore();
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();

  const authority = new GameAuthority(pubsub, () => 1000, store, {
    durableReadTimeoutMs: 1000,
    schedule: scheduler.schedule,
  });

  const gameId = 'wf6-game';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });
  await authority.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  assert.equal(authority.getState(gameId).ply, 1);

  // Gate load with ignoreAbort
  store.loadGate = { isEntered: false, ignoreAbort: true };
  const reloadP = authority.reloadFromLog(gameId);
  await flush();
  assert.equal(store.loadGate.isEntered, true);

  const reloadRejects = assert.rejects(reloadP, (e: unknown) => e instanceof AuthorityError && /durable load timed out/.test(e.message));

  // Fire read deadline
  scheduler.fire(1000);
  await flush();

  await reloadRejects;
  assert.equal(authority.abandonedReadCount(), 1, 'abandonedReadCount is 1 while late read pending');

  // Settle late with data (empty log or different data)
  store.loadGate.resolve?.([]);
  store.loadGate = undefined;
  await flush();

  assert.equal(authority.abandonedReadCount(), 0, 'abandonedReadCount decrements to 0 after settling');
  // The late (empty) result was discarded: it did not clear the resident record, which a
  // successful read reporting "no events" would have done.
  assert.equal(authority.has(gameId), true, 'late empty result did not erase the resident record');
  // The timed-out reload leaves the copy fenced as untrusted; a fresh reload restores durable truth.
  assert.throws(() => authority.getState(gameId), /durable game reload is required/);
  assert.equal(await authority.reloadFromLog(gameId), true);
  assert.equal(authority.getState(gameId).ply, 1, 'durable state restored by a fresh reload');
});

test('CG1 (create late COMMIT): create append gated; the default create deadline fires (scheduler)', { timeout: 2000 }, async () => {
  const store = new GatedEventStore();
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();

  const authority = new GameAuthority(pubsub, () => 1000, store, {
    schedule: scheduler.schedule,
  });

  const gameId = 'cg1-game';
  store.appendGate = { isEntered: false, ignoreAbort: true };

  const createP = authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });
  await flush();
  assert.equal(store.appendGate.isEntered, true);

  // The caller gets an AuthorityCommitError (outcome unknown), NOT invalid_command
  const createRejects = assert.rejects(
    createP,
    (e: unknown) =>
      e instanceof AuthorityCommitError &&
      e.message === `game creation for ${gameId} timed out; the outcome is unknown and it may still commit`,
  );

  // Fire the default 75000ms create deadline
  scheduler.fire(75_000);
  await flush();

  await createRejects;

  // Release with success
  store.appendGate.resolve?.();
  store.appendGate = undefined;
  await flush();

  // Game exists and ensureLoaded works
  assert.equal(authority.has(gameId), true, 'game exists in authority');
  assert.equal(await authority.ensureLoaded(gameId), true, 'ensureLoaded works');
});

test('CG2 (create ignores abort): The create append never settles', { timeout: 2000 }, async () => {
  const store = new GatedEventStore();
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();

  const authority = new GameAuthority(pubsub, () => 1000, store, {
    durableCreateTimeoutMs: 500,
    schedule: scheduler.schedule,
  });

  const gameId = 'cg2-game';
  store.appendGate = { isEntered: false, ignoreAbort: true };

  const createP = authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });
  await flush();

  const createRejects = assert.rejects(createP, AuthorityCommitError);

  scheduler.fire(500);
  await flush();

  await createRejects;

  // Fenced; a further createGame with the same id is refused unavailable at once
  await assert.rejects(
    authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false }),
    (e: unknown) =>
      e instanceof AuthorityError &&
      e.code === 'invalid_command' &&
      e.message.includes(`game ${gameId} is unavailable: an earlier durable write has not settled`),
  );
});

test('CG3: create with an existing id (appendRejected)', async () => {
  const inner = new InMemoryEventLog();
  const store = new GatedEventStore(inner);
  const pubsub = new InMemoryPubSub();

  const authority = new GameAuthority(pubsub, () => 1000, store);
  const gameId = 'cg3-game';

  // Seed durable log with an existing event
  const { events } = Game.create({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false, at: 1000 });
  await inner.append(gameId, -1, events);

  // createGame against existing id triggers EventLogConcurrencyError (appendRejected === true)
  await assert.rejects(
    authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false }),
    (e: unknown) =>
      e instanceof AuthorityError &&
      !(e instanceof AuthorityCommitError) &&
      e.code === 'invalid_command' &&
      /cannot create game/.test(e.message),
  );
});

test('CG4: create with a generic I/O error', async () => {
  const store = new GatedEventStore();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, store);

  const gameId = 'cg4-game';
  store.appendGate = { isEntered: false };

  const createP = authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });
  await flush();

  const createRejects = assert.rejects(
    createP,
    (e: unknown) =>
      e instanceof AuthorityCommitError &&
      e.code === 'invalid_command' &&
      /cannot create game/.test(e.message),
  );

  // Reject with generic I/O error (no appendRejected property)
  store.appendGate.reject?.(new Error('network connection reset'));
  store.appendGate = undefined;
  await flush();

  await createRejects;
});

test('CG5: No options passed: createGame IS bounded: the scheduler receives a 75000 ms timer', async () => {
  const store = new GatedEventStore();
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();

  const authority = new GameAuthority(pubsub, () => 1000, store, {
    schedule: scheduler.schedule,
  });

  const gameId = 'cg5-game';
  store.appendGate = { isEntered: false, ignoreAbort: true };

  void authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false }).catch(() => {});
  await flush();

  const timer75k = scheduler.tasks.find((t) => t.ms === 75_000 && !t.cancelled);
  assert.ok(timer75k, 'scheduler must have received a 75000 ms timer');
});

test('CG6: Hooks that throw: Ignored', async () => {
  const store = new GatedEventStore();
  const pubsub = new InMemoryPubSub();
  const scheduler = new ManualScheduler();

  const authority = new GameAuthority(pubsub, () => 1000, store, {
    durableWriteTimeoutMs: 1000,
    schedule: scheduler.schedule,
    onDurableWriteStalled: () => {
      throw new Error('stalled hook boom');
    },
    onDurableWriteSettled: () => {
      throw new Error('settled hook boom');
    },
  });

  const gameId = 'cg6-game';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  store.appendGate = { isEntered: false, ignoreAbort: true };
  const p = authority.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await flush();

  const pRejects = assert.rejects(p, AuthorityCommitError);

  // Fire deadline -> triggers stalled hook (throws, ignored)
  scheduler.fire(1000);
  await flush();

  await pRejects;

  // Settle -> triggers settled hook (throws, ignored)
  store.appendGate.resolve?.();
  store.appendGate = undefined;
  await flush();

  assert.equal(authority.getState(gameId).ply, 1);
});
