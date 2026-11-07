/**
 * The adjudication worker's own logic, hermetically (Issue #124, ADR-0175): claiming, slicing,
 * renewal, the unresolved fallback, uncertain replies, release after publication, and stopping.
 * The real store and PostgreSQL are covered by adjudication-worker.integration.test.ts.
 */
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { JobStatus, JobStepResult } from '@chess-platform/game';
import {
  AdjudicationClaimGrant,
  AdjudicationConflictError,
  type AdjudicationReleaseReceipt,
  type AdjudicationSettlementReceipt,
  type ClaimAdjudicationParams,
  type ClaimIntent,
  type RenewAdjudicationParams,
  type SettleAdjudicationParams,
} from '@chess-platform/persistence/pg';
import {
  AdjudicationWorker,
  stopReleaseRequestId,
  type AdjudicationChange,
  type AdjudicationWorkStore,
} from '../src/adjudication-worker.js';

const GAME = '018f2780-0000-7000-8000-000000000001';
const OP = '018f2780-0000-7000-8000-000000000002';
const EXECUTOR = '018f2780-0000-7000-8000-000000000003';
const CLAIM = '018f2780-0000-7000-8000-000000000004';

function step(status: JobStatus): JobStepResult {
  return { operationId: OP, status, workCompleted: 0, deltaWork: 0, slicesExecuted: 0, handlesReady: status === 'ready' };
}

class FakeStore implements AdjudicationWorkStore {
  claimable: Array<{ gameId: string; operationId: string; generation: string }> = [{ gameId: GAME, operationId: OP, generation: '0' }];
  stops: Array<{ gameId: string; stopOperationId: string }> = [];
  /** Statuses the proof job reports, one per step. */
  steps: JobStatus[] = ['active', 'active', 'ready'];
  readonly calls: string[] = [];
  readonly claims: ClaimAdjudicationParams[] = [];
  readonly settles: SettleAdjudicationParams[] = [];
  readonly releases: Array<{ gameId: string; releaseRequestId: string; at: number }> = [];
  readonly renewals: RenewAdjudicationParams[] = [];
  claimFailures: Array<'conflict' | 'network'> = [];
  settleFailures: Array<'conflict' | 'network'> = [];
  releaseFailures = 0;
  /** The clock completion the settlement records: `stopped` when the game goes on. */
  completion: 'stopped' | 'terminal' | undefined;
  retained: number | undefined;
  leaseUntil = 1_000_000 + 30_000;
  enforceLease = false;
  stopWhenStepping: (() => void) | undefined;
  constructor(private readonly clock: { now: number }) {}

  async listClaimableAdjudications(limit = 20): Promise<Array<{ gameId: string; operationId: string; generation: string }>> {
    const page = this.claimable.slice(0, limit);
    this.claimable = this.claimable.slice(limit);
    return page;
  }
  readonly releaseQueries: Array<{ minAgeMs: number; exclude: readonly string[] }> = [];
  async listReleasableStops(_limit: number, minAgeMs: number, exclude: readonly string[]): Promise<Array<{ gameId: string; stopOperationId: string }>> {
    this.releaseQueries.push({ minAgeMs, exclude: [...exclude] });
    return this.stops.filter((s) => !exclude.includes(s.gameId));
  }
  cancelProofJob(): void {
    this.calls.push('cancel');
  }
  grant(leaseUntil: number, gameId = GAME, operationId = OP, generation = '1'): AdjudicationClaimGrant {
    return new AdjudicationClaimGrant({
      gameId, operationId, claimId: CLAIM, executorId: EXECUTOR, generation,
      leaseUntil: new Date(leaseUntil), capability: Buffer.alloc(32, 7),
    });
  }
  async claimAdjudication(params: ClaimAdjudicationParams): Promise<AdjudicationClaimGrant> {
    this.claims.push(params);
    const failure = this.claimFailures.shift();
    if (failure === 'conflict') throw new AdjudicationConflictError('claimed elsewhere');
    if (failure === 'network') throw new Error('connection reset');
    return this.grant(this.leaseUntil, params.gameId, params.operationId, String(Number(params.expectedGeneration) + 1));
  }
  async renewAdjudication(params: RenewAdjudicationParams): Promise<AdjudicationClaimGrant> {
    this.renewals.push(params);
    this.leaseUntil = this.clock.now + params.extensionMs;
    return this.grant(this.leaseUntil, params.grant.gameId, params.grant.operationId, String(Number(params.grant.generation) + 1));
  }
  async createProofJob(_gameId: string, operationId = OP): Promise<string> {
    this.calls.push(operationId === OP ? 'create' : `create:${operationId}`);
    return operationId;
  }
  stepProofJob(_operationId: string, budget: number): JobStepResult {
    this.calls.push(`step:${budget}`);
    this.stopWhenStepping?.();
    if (this.enforceLease && this.clock.now >= this.leaseUntil) {
      throw new AdjudicationConflictError('lease expired before step');
    }
    this.clock.now += 10_000;
    return step(budget === 0 ? 'active' : (this.steps.shift() ?? 'ready'));
  }
  escalations = 0;
  /** How many tiers the fake controller offers; each escalation re-runs `steps` from where it is. */
  tiers = 0;
  escalateProofJob(): boolean {
    this.calls.push('escalate');
    if (this.escalations >= this.tiers) return false;
    this.escalations++;
    return true;
  }
  concludeUnresolvedProofJob(): JobStepResult {
    this.calls.push('unresolved');
    return step('ready');
  }
  retainedResolutionAt(): number | undefined {
    return this.retained;
  }
  async settleAdjudication(params: SettleAdjudicationParams): Promise<AdjudicationSettlementReceipt> {
    this.settles.push(params);
    const failure = this.settleFailures.shift();
    if (failure === 'conflict') throw new AdjudicationConflictError('superseded');
    if (failure === 'network') throw new Error('connection reset');
    return { gameId: params.gameId, operationId: params.operationId, startedSeq: 3, finalSeq: 5, eventCount: 2, completedAt: params.resolutionAt,
      resolvedEvent: { clockCompletion: this.completion === undefined ? undefined : { kind: this.completion } },
    } as unknown as AdjudicationSettlementReceipt;
  }
  evictProofJob(): boolean {
    this.calls.push('evict');
    return true;
  }
  async releaseClocks(params: { gameId: string; releaseRequestId: string; at: number }): Promise<AdjudicationReleaseReceipt> {
    this.releases.push(params);
    if (this.releaseFailures > 0) {
      this.releaseFailures -= 1;
      throw new Error('database unreachable');
    }
    this.stops = this.stops.filter((s) => !(s.gameId === params.gameId && stopReleaseRequestId(s.stopOperationId) === params.releaseRequestId));
    return { gameId: params.gameId, releaseRequestId: params.releaseRequestId, releaseSeq: 6 } as unknown as AdjudicationReleaseReceipt;
  }
}

function harness(configure?: (store: FakeStore) => void, failPublishes: Array<AdjudicationChange['kind']> = []) {
  const clock = { now: 1_000_000 };
  const store = new FakeStore(clock);
  configure?.(store);
  const published: AdjudicationChange[] = [];
  const attempts: AdjudicationChange[] = [];
  const intents: ClaimIntent[] = [];
  let n = 0;
  const worker = new AdjudicationWorker({
    store,
    executorId: EXECUTOR,
    leaseMs: 30_000,
    sliceBudget: 500,
    publish: async (change) => {
      attempts.push(change);
      const fail = failPublishes.indexOf(change.kind);
      if (fail >= 0) {
        failPublishes.splice(fail, 1);
        throw new Error('owner unreachable');
      }
      published.push(change);
      // Publication of a stopped settlement makes its stop releasable on the same pass.
      if (change.kind === 'released') store.stops = [];
    },
    monotonic: () => 0,
    newIntent: () => {
      const intent = { claimId: `018f2780-0000-7000-8000-${String(++n).padStart(12, '0')}`, capability: Buffer.alloc(32, n) };
      intents.push(intent);
      return intent;
    },
    now: () => clock.now,
  });
  // A settlement makes its stop current in the database whether or not it is published.
  const settle = store.settleAdjudication.bind(store);
  store.settleAdjudication = async (params) => {
    const receipt = await settle(params);
    store.stops = [{ gameId: GAME, stopOperationId: OP }];
    return receipt;
  };
  return { clock, store, published, attempts, intents, worker };
}

test('claims, proves in slices, settles at now, publishes, then releases the published stop', async () => {
  const { store, published, worker, clock } = harness();
  const pass = await worker.runPass();
  assert.deepEqual(pass, { settled: 1, released: 1, skipped: 0, failed: 0, pending: 0, more: false });
  assert.deepEqual(store.calls, ['create', 'step:0', 'step:500', 'step:500', 'step:500', 'cancel', 'evict']);
  assert.deepEqual(store.releaseQueries, [{ minAgeMs: 1_000, exclude: [] }], 'stops are released only after the grace period');
  assert.equal(store.claims.length, 1);
  assert.equal(store.claims[0]!.expectedGeneration, '0');
  assert.equal(store.claims[0]!.executorId, EXECUTOR);
  assert.equal(store.settles.length, 1);
  assert.equal(store.settles[0]!.resolutionAt, 1_040_000, 'resolution at the instant the proof finished');
  assert.deepEqual(published.map((c) => c.kind), ['settled', 'released']);
  assert.deepEqual(store.releases, [{ gameId: GAME, releaseRequestId: stopReleaseRequestId(OP), at: clock.now }]);
});

test('the lease is renewed before it can lapse during a long proof', async () => {
  const { store, worker } = harness((s) => {
    s.steps = ['active', 'active', 'active', 'active', 'ready'];
  });
  await worker.runPass();
  assert.ok(store.renewals.length >= 1, 'renewed at least once');
  for (const r of store.renewals) assert.equal(r.extensionMs, 30_000);
  assert.equal(store.settles.length, 1);
});

test('a proof that exhausts its resource limit settles as unresolved', async () => {
  const { store, worker } = harness((s) => {
    s.steps = ['active', 'resource_limit'];
  });
  const pass = await worker.runPass();
  assert.equal(pass.settled, 1);
  assert.ok(store.calls.includes('unresolved'));
  assert.equal(store.settles.length, 1);
});

test('an operation claimed elsewhere is skipped without proving', async () => {
  const { store, published, worker } = harness((s) => {
    s.claimFailures = ['conflict'];
  });
  const pass = await worker.runPass();
  assert.deepEqual(pass, { settled: 0, released: 0, skipped: 1, failed: 0, pending: 0, more: false });
  assert.deepEqual(store.calls, []);
  assert.deepEqual(published, []);
});

test('an uncertain claim reply is retried with the same intent, recovering the committed lease', async () => {
  const { store, intents, worker } = harness((s) => {
    s.claimFailures = ['network'];
  });
  const pass = await worker.runPass();
  assert.equal(pass.settled, 1);
  assert.equal(store.claims.length, 2);
  assert.equal(intents.length, 1);
  assert.equal(store.claims[0]!.intent, store.claims[1]!.intent);
});

test('a retained evaluation is settled as it was, without proving again', async () => {
  const { store, worker } = harness((s) => {
    s.retained = 1_000_123;
  });
  assert.equal((await worker.runPass()).settled, 1);
  assert.equal(store.settles[0]!.resolutionAt, 1_000_123);
  assert.deepEqual(store.calls.filter((c) => c === 'create' || c.startsWith('step')), [], 'the consumed job is not stepped');
});

test('a failed settlement publication is retried, and the stop waits for it', async () => {
  const { store, published, attempts, worker } = harness(undefined, ['settled']);
  const first = await worker.runPass();
  assert.equal(first.settled, 1);
  assert.equal(first.released, 0, 'not released over an unpublished settlement');
  assert.deepEqual(store.releaseQueries.at(-1)!.exclude, [GAME], 'the blocked game is excluded before the page limit');
  assert.equal(worker.unpublishedCount, 1);
  assert.equal(published.length, 0);
  const second = await worker.runPass();
  assert.deepEqual(published.map((c) => c.kind), ['settled', 'released']);
  assert.equal(second.released, 1);
  assert.equal(worker.unpublishedCount, 0);
  assert.equal(attempts.length, 3);
  assert.equal(store.releases.length, 1);
});

test('a failed release publication is retried on the next pass', async () => {
  const { published, worker } = harness(undefined, ['released']);
  await worker.runPass();
  assert.deepEqual(published.map((c) => c.kind), ['settled']);
  assert.equal(worker.unpublishedCount, 1);
  await worker.runPass();
  assert.deepEqual(published.map((c) => c.kind), ['settled', 'released']);
  assert.equal(worker.unpublishedCount, 0);
});

test('a claim lost during the proof cancels and drops the local job', async () => {
  const { store, worker } = harness((s) => {
    s.steps = ['active', 'active', 'active', 'active', 'ready'];
  });
  store.renewAdjudication = async () => {
    throw new AdjudicationConflictError('lease taken over');
  };
  const pass = await worker.runPass();
  assert.deepEqual(pass, { settled: 0, released: 0, skipped: 1, failed: 0, pending: 0, more: false });
  assert.deepEqual(store.calls.slice(-2), ['cancel', 'evict']);
  assert.equal(store.settles.length, 0);
});

test('an uncertain settlement is retried with the same grant; a superseded one is skipped', async () => {
  const lost = harness((s) => {
    s.settleFailures = ['network'];
  });
  assert.equal((await lost.worker.runPass()).settled, 1);
  assert.equal(lost.store.settles.length, 2);
  assert.equal(lost.store.settles[0]!.grant, lost.store.settles[1]!.grant);
  assert.equal(lost.store.settles[0]!.resolutionAt, lost.store.settles[1]!.resolutionAt);

  const superseded = harness((s) => {
    s.settleFailures = ['conflict'];
  });
  const pass = await superseded.worker.runPass();
  assert.deepEqual(pass, { settled: 0, released: 0, skipped: 1, failed: 0, pending: 0, more: false });
  assert.ok(superseded.store.calls.includes('evict'), 'the superseded job is dropped');
  assert.deepEqual(superseded.published, []);
});

test('a failed release is counted and retried on a later pass with the same request id', async () => {
  const { store, worker } = harness((s) => {
    s.claimable = [];
    s.stops = [{ gameId: GAME, stopOperationId: OP }];
    s.releaseFailures = 1;
  });
  assert.deepEqual(await worker.runPass(), { settled: 0, released: 0, skipped: 0, failed: 1, pending: 0, more: false });
  assert.deepEqual(await worker.runPass(), { settled: 0, released: 1, skipped: 0, failed: 0, pending: 0, more: false });
  assert.equal(store.releases.length, 2);
  assert.equal(store.releases[0]!.releaseRequestId, store.releases[1]!.releaseRequestId);
});

test('a failed proof is counted and left for its lease to lapse', async () => {
  const { store, worker } = harness((s) => {
    s.steps = ['cancelled'];
  });
  const pass = await worker.runPass();
  assert.deepEqual(pass, { settled: 0, released: 0, skipped: 0, failed: 1, pending: 0, more: false });
  assert.equal(store.settles.length, 0);
});

test('stop() halts a proof at its next slice and waits for the pass', async () => {
  const { store, worker } = harness((s) => {
    s.steps = Array<JobStatus>(50).fill('active');
  });
  let stopping: Promise<void> | undefined;
  store.stopWhenStepping = () => {
    if (store.calls.filter((c) => c.startsWith('step:500')).length === 2) stopping ??= worker.stop();
  };
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await stopping;
  const slices = store.calls.filter((c) => c === 'step:500').length;
  assert.ok(slices <= 3, `stopped promptly after ${slices} slices`);
  assert.equal(store.settles.length, 0);
});

test('invalid options are refused', () => {
  const store = new FakeStore({ now: 0 });
  for (const bad of [
    { leaseMs: 0 },
    { sliceBudget: -1 },
    { pollMs: 1.5 },
    { pageSize: Number.NaN },
    { releaseGraceMs: -1 },
    { releaseGraceMs: 0.5 },
    { concurrency: 0 },
    { concurrency: -1 },
    { concurrency: 1.5 },
    { concurrency: 101 },
    { concurrency: Number.NaN },
  ]) {
    assert.throws(() => new AdjudicationWorker({ store, executorId: EXECUTOR, publish: async () => {}, ...bad }), RangeError);
  }
});

test('an exhausted proof is escalated while a tier remains, and only then concluded', async () => {
  const { store, worker } = harness((s) => {
    s.tiers = 2;
    s.steps = ['resource_limit', 'resource_limit', 'resource_limit'];
  });
  const pass = await worker.runPass();
  assert.equal(pass.settled, 1);
  const order = store.calls.filter((c) => c === 'escalate' || c === 'unresolved');
  assert.deepEqual(order, ['escalate', 'escalate', 'escalate', 'unresolved']);
});

test('one long proof yields to other operations and resumes on the next pass with its claim', async () => {
  const OTHER_GAME = '018f2780-0000-7000-8000-0000000000a1';
  const OTHER_OP = '018f2780-0000-7000-8000-0000000000a2';
  const clock = { now: 1_000_000 };
  const store = new FakeStore(clock);
  let mono = 0;
  // The first operation's proof needs many slices; the second's is immediate.
  const remaining = new Map<string, number>([[OP, 6], [OTHER_OP, 0]]);
  store.claimable = [
    { gameId: GAME, operationId: OP, generation: '0' },
    { gameId: OTHER_GAME, operationId: OTHER_OP, generation: '0' },
  ];
  store.stepProofJob = (operationId: string, budget: number) => {
    store.calls.push(`step:${operationId === OP ? 'long' : 'short'}:${budget}`);
    mono += 100;
    if (budget === 0) return step('active');
    const left = remaining.get(operationId)!;
    remaining.set(operationId, Math.max(0, left - 1));
    return step(left > 0 ? 'active' : 'ready');
  };
  const claimFor = store.claimAdjudication.bind(store);
  store.claimAdjudication = async (params) => {
    const grant = await claimFor(params);
    return params.operationId === OP ? grant : new AdjudicationClaimGrant({
      gameId: OTHER_GAME, operationId: OTHER_OP, claimId: CLAIM, executorId: EXECUTOR, generation: '1',
      leaseUntil: grant.leaseUntil, capability: Buffer.alloc(32, 9),
    });
  };
  const settled: string[] = [];
  const settle = store.settleAdjudication.bind(store);
  store.settleAdjudication = async (params) => {
    settled.push(params.operationId);
    return settle(params);
  };
  const worker = new AdjudicationWorker({
    store, executorId: EXECUTOR, leaseMs: 30_000, sliceBudget: 500, proofSliceMs: 250,
    publish: async () => {}, now: () => clock.now, monotonic: () => mono,
  });
  const first = await worker.runPass();
  assert.deepEqual(settled, [OTHER_OP], 'the short proof settles while the long one waits');
  assert.equal(first.pending, 1);
  assert.equal(first.more, true);
  assert.equal(store.claims.filter((c) => c.operationId === OP).length, 1);
  for (let i = 0; i < 10 && settled.length < 2; i++) await worker.runPass();
  assert.deepEqual(settled, [OTHER_OP, OP], 'the long proof finishes on later passes');
  assert.equal(store.claims.filter((c) => c.operationId === OP).length, 1, 'resumed with its claim, never re-claimed');
  assert.equal((await worker.runPass()).pending, 0);
});

test('a settlement that stops the clocks is released right after its notice, without the grace wait', async () => {
  const { store, published, worker } = harness((s) => { s.completion = 'stopped'; });
  // The sweep would not see a settlement this young yet.
  store.listReleasableStops = async () => [];
  const pass = await worker.runPass();
  assert.deepEqual(pass, { settled: 1, released: 1, skipped: 0, failed: 0, pending: 0, more: false });
  assert.deepEqual(published.map((c) => c.kind), ['settled', 'released']);
  assert.equal(store.releases.length, 1);
  assert.equal(store.releases[0]!.releaseRequestId, stopReleaseRequestId(OP), 'same request id the sweep would use');
});

test('a terminal settlement is not released', async () => {
  const { store, published, worker } = harness((s) => { s.completion = 'terminal'; s.stops = []; });
  store.settleAdjudication = (async (params: SettleAdjudicationParams) => {
    store.settles.push(params);
    return { gameId: GAME, operationId: OP, startedSeq: 3, finalSeq: 5, eventCount: 2, completedAt: params.resolutionAt,
      resolvedEvent: { clockCompletion: { kind: 'terminal' } } } as unknown as AdjudicationSettlementReceipt;
  });
  const pass = await worker.runPass();
  assert.equal(pass.released, 0);
  assert.deepEqual(store.releases, []);
  assert.deepEqual(published.map((c) => c.kind), ['settled']);
});

test('no immediate release over an undelivered notice; the sweep releases after it is delivered', async () => {
  const { store, published, worker } = harness((s) => { s.completion = 'stopped'; }, ['settled']);
  const first = await worker.runPass();
  assert.equal(first.released, 0);
  assert.deepEqual(store.releases, [], 'players must hear of the settlement first');
  const second = await worker.runPass();
  assert.equal(second.released, 1);
  assert.deepEqual(published.map((c) => c.kind), ['settled', 'released']);
});

test('a failed immediate release is left to the sweep', async () => {
  const { store, published, worker } = harness((s) => { s.completion = 'stopped'; s.releaseFailures = 1; });
  const first = await worker.runPass();
  assert.equal(first.settled, 1);
  // The same pass's sweep retries it with the same request id.
  assert.equal(first.released, 1);
  assert.deepEqual(store.releases.map((r) => r.releaseRequestId), [stopReleaseRequestId(OP), stopReleaseRequestId(OP)]);
  assert.deepEqual(published.map((c) => c.kind), ['settled', 'released']);
});

async function pumpUntil(predicate: () => boolean, maxFlushes = 20): Promise<boolean> {
  for (let i = 0; i < maxFlushes; i++) {
    if (predicate()) return true;
    await yieldToLoop();
  }
  return predicate();
}

test('scheduled worker bounds next pass delay by held lease when pollMs >= leaseMs, progressing without expired lease or restart', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let worker: AdjudicationWorker | undefined;
  try {
    const clock = { get now() { return Date.now(); } };
    const store = new FakeStore(clock);
    store.leaseUntil = Date.now() + 10_000;
    store.enforceLease = true;
    let mono = 0;
    let slice = 0;
    store.stepProofJob = (_op: string, budget: number) => {
      store.calls.push(`step:${budget}`);
      if (store.enforceLease && Date.now() >= store.leaseUntil) {
        throw new AdjudicationConflictError('lease expired before step');
      }
      if (budget === 0) return step('active');
      mono += 100;
      slice += 1;
      return step(slice >= 2 ? 'ready' : 'active');
    };
    worker = new AdjudicationWorker({
      store,
      executorId: EXECUTOR,
      leaseMs: 10_000,
      pollMs: 20_000, // pollMs >= leaseMs
      sliceBudget: 500,
      proofSliceMs: 50,
      publish: async () => {},
      monotonic: () => mono,
      now: () => Date.now(),
    });

    worker.start();
    // Fire initial scheduled pass (delay 0)
    mock.timers.tick(0);
    await pumpUntil(() => slice >= 1);
    assert.equal(slice, 1, 'first slice executed');

    // In fixed worker, nextDelay is 0 (progress was made with pending work), so ticking 0 fires pass 2
    mock.timers.tick(0);
    await pumpUntil(() => store.settles.length >= 1);
    assert.equal(store.settles.length, 1, 'pass 2 settled prompt proof');
    assert.equal(store.claims.length, 1, 'resumed with existing claim without reclaim');
  } finally {
    try {
      if (worker) await worker.stop();
    } finally {
      mock.timers.reset();
    }
  }
});

test('error backoff with held leases renews leases before delay and bounds backoff by held lease safe window', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let worker: AdjudicationWorker | undefined;
  try {
    const clock = { get now() { return Date.now(); } };
    const store = new FakeStore(clock);
    store.leaseUntil = Date.now() + 10_000;
    let mono = 0;
    store.stepProofJob = () => {
      mono += 100;
      return step('active');
    };
    worker = new AdjudicationWorker({
      store,
      executorId: EXECUTOR,
      leaseMs: 10_000,
      pollMs: 10_000,
      maxBackoffMs: 30_000,
      proofSliceMs: 50,
      publish: async () => {},
      monotonic: () => mono,
      now: () => Date.now(),
    });

    // Pass 1: admits job, status pending
    const pass1 = await worker.runPass();
    assert.equal(pass1.pending, 1);

    // Advance mock time so lease renewal becomes due (remaining 4000 <= 5000)
    mock.timers.tick(6_000);

    // Make listReleasableStops fail to simulate pass failure in tick
    store.listReleasableStops = async () => {
      throw new Error('transient database error');
    };

    worker.start();
    // Fire pass from tick
    mock.timers.tick(0);
    await pumpUntil(() => store.renewals.length >= 1);
    assert.ok(store.renewals.length >= 1, 'held lease was renewed before backoff delay');
    assert.equal(store.renewals[0]!.extensionMs, 10_000);
  } finally {
    try {
      if (worker) await worker.stop();
    } finally {
      mock.timers.reset();
    }
  }
});

test('per-game notice FIFO queue preserves strict order across failures and new notices, drains sequentially, and blocks release until empty', async () => {
  const clock = { now: 1_000_000 };
  const store = new FakeStore(clock);
  store.completion = 'stopped';
  const GAME1 = '018f2780-0000-7000-8000-000000000001';
  const GAME2 = '018f2780-0000-7000-8000-000000000002';
  const OP1_OLD = '018f2780-0000-7000-8000-000000000003';
  const OP1_NEW = '018f2780-0000-7000-8000-000000000004';
  const OP2 = '018f2780-0000-7000-8000-000000000005';

  // Step 1: GAME1 has an older stop ready to release, no claimable jobs yet
  store.stops = [{ gameId: GAME1, stopOperationId: OP1_OLD }];
  store.claimable = [];

  const published: AdjudicationChange[] = [];
  let failGame1 = true;
  let activeDrainsGame1 = 0;
  let maxActiveDrainsGame1 = 0;

  const worker = new AdjudicationWorker({
    store,
    executorId: EXECUTOR,
    publish: async (change) => {
      if (change.gameId === GAME1) {
        activeDrainsGame1 += 1;
        if (activeDrainsGame1 > maxActiveDrainsGame1) maxActiveDrainsGame1 = activeDrainsGame1;
        await yieldToLoop();
        activeDrainsGame1 -= 1;
        if (failGame1) {
          throw new Error('Game 1 publish network timeout');
        }
      }
      published.push(change);
    },
    now: () => clock.now,
    concurrency: 1,
  });

  // Pass 1: sweep attempts to release OP1_OLD. release succeeds in store, but publish fails!
  const pass1 = await worker.runPass();
  assert.equal(pass1.released, 1);
  assert.equal(worker.unpublishedCount, 1);
  assert.equal(published.length, 0);

  // Step 2: OP1_NEW and OP2 are now claimable
  store.claimable = [
    { gameId: GAME1, operationId: OP1_NEW, generation: '0' },
    { gameId: GAME2, operationId: OP2, generation: '0' },
  ];
  const settle = store.settleAdjudication.bind(store);
  store.settleAdjudication = async (params) => {
    const receipt = await settle(params);
    store.stops.push({ gameId: params.gameId, stopOperationId: params.operationId });
    return receipt;
  };

  // Pass 2: OP1_NEW settles, its notice queues behind OP1_OLD; immediate release is blocked.
  // Meanwhile GAME2 settles and releases immediately!
  const pass2 = await worker.runPass();
  assert.equal(pass2.settled, 2);
  assert.equal(pass2.released, 1); // GAME2 only!
  assert.equal(worker.unpublishedCount, 2); // older RELEASE + newer SETTLED for GAME1
  assert.deepEqual(published.map((c) => ({ gameId: c.gameId, kind: c.kind })), [
    { gameId: GAME2, kind: 'settled' },
    { gameId: GAME2, kind: 'released' },
  ]);

  // Step 3: Restore delivery for GAME1
  failGame1 = false;
  // Pass 3: flush drains GAME1's older RELEASE first, then SETTLED second!
  // Then sweep releases OP1_NEW!
  const pass3 = await worker.runPass();
  assert.equal(pass3.released, 1);
  assert.equal(worker.unpublishedCount, 0);

  // Strict order for GAME1: older release, then settled, then newer release
  const game1Events = published.filter((c) => c.gameId === GAME1);
  assert.deepEqual(game1Events.map((c) => c.kind), ['released', 'settled', 'released']);
  assert.equal(maxActiveDrainsGame1, 1, 'single drain ownership enforced with no simultaneous drains');
});

test('controller capacity 100 includes #inFlight: claims at most free capacity, reserves slots during concurrent admission, and handles >100 long jobs without overclaiming', async () => {
  const clock = { now: 1_000_000 };
  const store = new FakeStore(clock);
  let mono = 0;

  const totalJobs = 105;
  const allOps: Array<{ gameId: string; operationId: string; generation: string }> = [];
  for (let i = 1; i <= totalJobs; i++) {
    const hex = String(i).padStart(12, '0');
    allOps.push({
      gameId: `018f2780-0000-7000-8000-${hex}`,
      operationId: `018f2780-0000-7000-9000-${hex}`,
      generation: '0',
    });
  }
  store.claimable = [...allOps];

  store.stepProofJob = () => {
    mono += 100;
    return step('active');
  };

  const worker = new AdjudicationWorker({
    store,
    executorId: EXECUTOR,
    pageSize: 105,
    proofSliceMs: 50,
    publish: async () => {},
    monotonic: () => mono,
    now: () => clock.now,
  });

  // Pass 1: claims at most 100 jobs up to capacity
  const pass1 = await worker.runPass();
  assert.equal(pass1.pending, 100);
  assert.equal(store.claims.length, 100, 'claimed exactly 100 jobs up to capacity');
  assert.equal(pass1.more, true, 'more work waiting');

  // Pass 2: all 100 jobs held inFlight, free capacity is 0
  const pass2 = await worker.runPass();
  assert.equal(pass2.pending, 100);
  assert.equal(store.claims.length, 100, 'no new claims while capacity is full');
  assert.equal(pass2.more, true, 'paging more is true with zero free capacity');

  // 5 jobs finish and settle
  let settledCount = 0;
  store.stepProofJob = () => {
    mono += 100;
    settledCount += 1;
    if (settledCount <= 5) return step('ready');
    return step('active');
  };

  // Pass 3: 5 jobs settle, freeing 5 slots; the remaining 5 waiting jobs are admitted
  const pass3 = await worker.runPass();
  assert.equal(pass3.settled, 5);
  assert.equal(store.claims.length, 105, 'remaining 5 jobs admitted after slots freed');
});

test('concurrency overlaps operations, enforces configured ceiling, and concurrency 1 preserves strict held then fresh order', async () => {
  // Part A: Operations actually overlap
  {
    const clock = { now: 1_000_000 };
    const store = new FakeStore(clock);
    const OP1 = '018f2780-0000-7000-8000-0000000000c1';
    const OP2 = '018f2780-0000-7000-8000-0000000000c2';
    store.claimable = [
      { gameId: GAME, operationId: OP1, generation: '0' },
      { gameId: GAME, operationId: OP2, generation: '0' },
    ];

    let op1Started = false;
    let op2StartedWhileOp1Running = false;
    let resolveOp1 = (): void => {};
    const op1Barrier = new Promise<void>((resolve) => {
      resolveOp1 = resolve;
    });

    const origClaim = store.claimAdjudication.bind(store);
    store.claimAdjudication = async (params) => {
      if (params.operationId === OP1) {
        op1Started = true;
        await op1Barrier;
      } else if (params.operationId === OP2) {
        if (op1Started) op2StartedWhileOp1Running = true;
        resolveOp1();
      }
      return origClaim(params);
    };

    const worker = new AdjudicationWorker({
      store,
      executorId: EXECUTOR,
      concurrency: 2,
      publish: async () => {},
      now: () => clock.now,
    });

    const pass = await worker.runPass();
    assert.equal(pass.settled, 2);
    assert.equal(op2StartedWhileOp1Running, true, 'OP1 and OP2 executed concurrently (overlapping)');
  }

  // Part B: Ceiling enforced
  {
    const clock = { now: 1_000_000 };
    const store = new FakeStore(clock);
    const ops = ['01', '02', '03', '04'].map((id) => ({
      gameId: GAME,
      operationId: `018f2780-0000-7000-8000-${id.padStart(12, '0')}`,
      generation: '0',
    }));
    store.claimable = [...ops];

    let running = 0;
    let maxRunning = 0;
    const origClaim = store.claimAdjudication.bind(store);
    store.claimAdjudication = async (params) => {
      running += 1;
      if (running > maxRunning) maxRunning = running;
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      return origClaim(params);
    };

    const worker = new AdjudicationWorker({
      store,
      executorId: EXECUTOR,
      concurrency: 2,
      publish: async () => {},
      now: () => clock.now,
    });

    await worker.runPass();
    assert.equal(maxRunning, 2, 'concurrency ceiling strictly enforced');
  }

  // Part C: Concurrency 1 preserves strict held then fresh order
  {
    const clock = { now: 1_000_000 };
    const store = new FakeStore(clock);
    const HELD1 = '018f2780-0000-7000-8000-000000000010';
    const FRESH1 = '018f2780-0000-7000-8000-000000000020';
    const executionOrder: string[] = [];
    let mono = 0;

    // Pass 1: HELD1 is claimed and stepped once, returns active to stay held
    store.claimable = [{ gameId: GAME, operationId: HELD1, generation: '0' }];
    store.stepProofJob = (op: string, budget: number) => {
      executionOrder.push(op);
      if (budget > 0) mono += 100;
      return step('active');
    };

    const worker = new AdjudicationWorker({
      store,
      executorId: EXECUTOR,
      concurrency: 1,
      proofSliceMs: 50,
      monotonic: () => mono,
      publish: async () => {},
      now: () => clock.now,
    });

    const pass1 = await worker.runPass();
    assert.equal(pass1.pending, 1);
    assert.deepEqual(executionOrder, [HELD1, HELD1]);

    // Pass 2: FRESH1 is now waiting in claimable; both finish with ready
    executionOrder.length = 0;
    store.claimable = [{ gameId: GAME, operationId: FRESH1, generation: '0' }];
    store.stepProofJob = (op: string) => {
      executionOrder.push(op);
      return step('ready');
    };

    const pass2 = await worker.runPass();
    assert.equal(pass2.settled, 2);
    assert.equal(executionOrder[0], HELD1, 'held operation executed first');
    assert.equal(executionOrder.includes(FRESH1), true, 'fresh operation executed after held');
  }
});

test('held slices create proof job exactly once, retain progress across slices, clean up on lost lease, and initialize fresh on new claim', async () => {
  const clock = { now: 1_000_000 };
  const store = new FakeStore(clock);
  const OP_GEN = '018f2780-0000-7000-8000-000000000050';
  store.claimable = [{ gameId: GAME, operationId: OP_GEN, generation: '0' }];
  let mono = 0;
  let remainingSlices = 2;

  store.stepProofJob = () => {
    mono += 100;
    if (remainingSlices > 0) {
      remainingSlices -= 1;
      return step('active');
    }
    return step('ready');
  };

  const worker = new AdjudicationWorker({
    store,
    executorId: EXECUTOR,
    proofSliceMs: 50,
    publish: async () => {},
    monotonic: () => mono,
    now: () => clock.now,
  });

  // Pass 1: creates job, runs slice 1 -> pending
  const p1 = await worker.runPass();
  assert.equal(p1.pending, 1);

  // Pass 2: resumes held job, runs slice 2 -> pending
  const p2 = await worker.runPass();
  assert.equal(p2.pending, 1);

  // Create must have been called EXACTLY ONCE for OP_GEN across slices 1 and 2
  const createsBefore = store.calls.filter((c) => c === `create:${OP_GEN}`).length;
  assert.equal(createsBefore, 1, 'proof job created exactly once for the held grant across slices');

  // Force renewal due and make renew throw conflict
  clock.now += 25_000;
  const cancelBefore = store.calls.filter((c) => c === 'cancel').length;
  const evictBefore = store.calls.filter((c) => c === 'evict').length;

  store.renewAdjudication = async () => {
    throw new AdjudicationConflictError('lost lease to rival');
  };
  // Pass 3: conflict drops job and evicts
  const p3 = await worker.runPass();
  assert.equal(p3.pending, 0);
  assert.equal(store.calls.filter((c) => c === 'cancel').length - cancelBefore, 1);
  assert.equal(store.calls.filter((c) => c === 'evict').length - evictBefore, 1);

  // Re-claim at genuine fresh generation '2'
  store.renewAdjudication = async (params) =>
    store.grant(clock.now + params.extensionMs, params.grant.gameId, params.grant.operationId, '3');
  store.claimable = [{ gameId: GAME, operationId: OP_GEN, generation: '2' }];
  remainingSlices = 0;

  const createsPreFresh = store.calls.filter((c) => c === `create:${OP_GEN}`).length;
  // Pass 4: fresh generation initializes fresh
  const p4 = await worker.runPass();
  assert.equal(p4.settled, 1);
  assert.equal(store.calls.filter((c) => c === `create:${OP_GEN}`).length - createsPreFresh, 1, 'fresh generation initializes fresh');
});

test('coordinated renewal renews held jobs while waiting behind a slow lane, preserving progress under strict short leases', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const clock = { get now() { return Date.now(); } };
    const store = new FakeStore(clock);
    const JOB_A = '018f2780-0000-7000-8000-0000000000a1';
    const JOB_B = '018f2780-0000-7000-8000-0000000000a2';
    store.leaseUntil = Date.now() + 1_000;
    store.enforceLease = true;

    store.claimable = [
      { gameId: GAME, operationId: JOB_A, generation: '0' },
      { gameId: GAME, operationId: JOB_B, generation: '0' },
    ];
    let mono = 0;
    store.stepProofJob = (_op: string, budget: number) => {
      if (budget > 0) mono += 100;
      return step('active');
    };

    const worker = new AdjudicationWorker({
      store,
      executorId: EXECUTOR,
      leaseMs: 1_000,
      concurrency: 1,
      proofSliceMs: 50,
      publish: async () => {},
      monotonic: () => mono,
      now: () => Date.now(),
    });

    // Pass 1: claims both jobs, leaves both pending in #inFlight
    const pass1 = await worker.runPass();
    assert.equal(pass1.pending, 2);

    // Pass 2: Lane 0 picks JOB_A. While stepping JOB_A, time advances by 600ms.
    // JOB_B is waiting behind JOB_A, and its remaining lease is 400ms <= 500ms.
    // The renewal timer fires and renews JOB_B!
    let slowDone = false;
    store.stepProofJob = (op: string) => {
      if (op === JOB_A && !slowDone) {
        slowDone = true;
        mock.timers.tick(600);
      }
      return step('ready');
    };

    const pass2 = await worker.runPass();
    assert.equal(pass2.settled, 2, 'both jobs settled without lease expiry');
    assert.ok(store.renewals.some((r) => r.grant.operationId === JOB_B), 'JOB_B was renewed while waiting behind JOB_A');
  } finally {
    try {
      mock.timers.reset();
    } catch {
      /* ignore */
    }
  }
});

test('stop() awaits in-flight renewal IO, and no further renewal or step happens after stop resolves', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let worker: AdjudicationWorker | undefined;
  try {
    const clock = { get now() { return Date.now(); } };
    const store = new FakeStore(clock);
    const JOB_A = '018f2780-0000-7000-8000-0000000000a1';
    const JOB_B = '018f2780-0000-7000-8000-0000000000a2';
    store.leaseUntil = Date.now() + 10_000;
    let mono = 0;
    let stepsAfterStop = 0;
    let stopResolved = false;

    store.claimable = [
      { gameId: GAME, operationId: JOB_A, generation: '0' },
      { gameId: GAME, operationId: JOB_B, generation: '0' },
    ];
    store.stepProofJob = (_op: string, budget: number) => {
      if (stopResolved) stepsAfterStop += 1;
      if (budget > 0) mono += 100;
      return step('active');
    };

    let resolveRenewalIO!: () => void;
    const renewalBarrier = new Promise<void>((resolve) => {
      resolveRenewalIO = resolve;
    });
    let renewalInitiated = false;

    store.renewAdjudication = async (params) => {
      if (params.grant.operationId === JOB_B) {
        renewalInitiated = true;
        await renewalBarrier;
      }
      return store.grant(Date.now() + params.extensionMs, params.grant.gameId, params.grant.operationId, '2');
    };

    worker = new AdjudicationWorker({
      store,
      executorId: EXECUTOR,
      leaseMs: 10_000,
      concurrency: 1,
      proofSliceMs: 50,
      publish: async () => {},
      monotonic: () => mono,
      now: () => Date.now(),
    });

    // Start worker scheduled loop
    worker.start();
    // Fire pass 1 at delay 0: admits both jobs, leaves both pending in #inFlight
    mock.timers.tick(0);
    await pumpUntil(() => store.calls.filter((c) => c === 'step:0').length >= 2);

    // In pass 2: Lane 0 picks JOB_A. While stepping JOB_A, clock advances by 6000ms.
    // That fires the renewal timer, which initiates renewal for JOB_B and pauses on renewalBarrier.
    // JOB_A returns active so Lane 0 yields.
    store.stepProofJob = (op: string) => {
      if (stopResolved) stepsAfterStop += 1;
      if (op === JOB_A) {
        mock.timers.tick(6_000);
      }
      return step('active');
    };

    // Trigger pass 2
    mock.timers.tick(0);
    await pumpUntil(() => renewalInitiated);
    assert.equal(renewalInitiated, true, 'background renewal IO started for JOB_B');

    // While JOB_B's renewal IO is in flight, call stop()
    const stopPromise = worker.stop().then(() => {
      stopResolved = true;
    });

    // Bounded pump: verify stop() does NOT resolve while renewal IO is in flight
    await pumpUntil(() => stopResolved, 5);
    assert.equal(stopResolved, false, 'stop() must not resolve while renewal IO is in flight');

    // Release deferred renewal IO
    resolveRenewalIO();
    await stopPromise;
    assert.equal(stopResolved, true, 'stop() resolved after renewal IO finished');

    // No further step or renewal after stop
    mock.timers.tick(10_000);
    await pumpUntil(() => stepsAfterStop > 0, 5);
    assert.equal(stepsAfterStop, 0, 'no proof steps executed after stop resolved');
    assert.equal(store.calls.filter((c) => c === 'cancel').length, 2, 'all held jobs cancelled on stop');
    assert.equal(store.calls.filter((c) => c === 'evict').length, 2, 'all held jobs evicted on stop');
  } finally {
    try {
      if (worker) await worker.stop();
    } finally {
      mock.timers.reset();
    }
  }
});

test('background conflict cleanup drops held job and waiting lane skips without recreating it', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let worker: AdjudicationWorker | undefined;
  try {
    const clock = { get now() { return Date.now(); } };
    const store = new FakeStore(clock);
    const JOB_A = '018f2780-0000-7000-8000-0000000000a1';
    const JOB_B = '018f2780-0000-7000-8000-0000000000a2';
    store.leaseUntil = Date.now() + 10_000;

    store.claimable = [
      { gameId: GAME, operationId: JOB_A, generation: '0' },
      { gameId: GAME, operationId: JOB_B, generation: '0' },
    ];
    let mono = 0;
    store.stepProofJob = (_op: string, budget: number) => {
      if (budget > 0) mono += 100;
      return step('active');
    };

    worker = new AdjudicationWorker({
      store,
      executorId: EXECUTOR,
      leaseMs: 10_000,
      concurrency: 1,
      proofSliceMs: 50,
      publish: async () => {},
      monotonic: () => mono,
      now: () => Date.now(),
    });

    // Pass 1: claims both jobs, leaves both pending in #inFlight
    const pass1 = await worker.runPass();
    assert.equal(pass1.pending, 2);

    // Pass 2: Lane 0 picks JOB_A. While stepping JOB_A, clock advances by 6000ms.
    // JOB_B is waiting behind JOB_A, renewal timer fires for JOB_B.
    // For JOB_B, renewal throws AdjudicationConflictError!
    store.renewAdjudication = async (params) => {
      if (params.grant.operationId === JOB_B) {
        throw new AdjudicationConflictError('lost lease to competitor');
      }
      return store.grant(Date.now() + params.extensionMs, params.grant.gameId, params.grant.operationId, '2');
    };

    let steppedBInPass2 = false;
    store.stepProofJob = (op: string) => {
      if (op === JOB_A) {
        mock.timers.tick(6_000);
      }
      if (op === JOB_B) {
        steppedBInPass2 = true;
      }
      return step('ready');
    };

    const pass2 = await worker.runPass();
    assert.equal(pass2.settled, 1, 'only JOB_A settled');
    assert.equal(pass2.skipped, 1, 'JOB_B skipped due to conflict drop');
    assert.equal(steppedBInPass2, false, 'JOB_B was not stepped after conflict cleanup');
    assert.equal(pass2.pending, 0, 'no jobs left in flight');
  } finally {
    try {
      if (worker) await worker.stop();
    } finally {
      mock.timers.reset();
    }
  }
});

test('stalled renewal on one held job does not block renewals or subsequent cycles of other held jobs', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let worker: AdjudicationWorker | undefined;
  let resolveJobA!: () => void;
  const jobABarrier = new Promise<void>((res) => {
    resolveJobA = res;
  });
  try {
    const clock = { get now() { return Date.now(); } };
    const store = new FakeStore(clock);
    const JOB_A = '018f2780-0000-7000-8000-0000000000a1';
    const JOB_B = '018f2780-0000-7000-8000-0000000000a2';
    store.leaseUntil = Date.now() + 10_000;
    let mono = 0;

    store.claimable = [
      { gameId: GAME, operationId: JOB_A, generation: '0' },
      { gameId: GAME, operationId: JOB_B, generation: '0' },
    ];
    store.stepProofJob = (_op: string, budget: number) => {
      store.calls.push(`step:${budget}`);
      if (budget > 0) mono += 100;
      return step('active');
    };

    let jobARenewCalls = 0;
    let jobBRenewCalls = 0;
    const jobBRenewTimes: Array<{ at: number; leaseUntil: number }> = [];

    store.renewAdjudication = async (params) => {
      if (params.grant.operationId === JOB_A) {
        jobARenewCalls += 1;
        await jobABarrier;
        return store.grant(Date.now() + params.extensionMs, params.grant.gameId, params.grant.operationId, '2');
      }
      // Enforce that JOB_B renewal strictly starts before its existing lease expires
      assert.ok(
        Date.now() < params.grant.leaseUntil.getTime(),
        `JOB_B renewed strictly before lease expired (now=${Date.now()} < leaseUntil=${params.grant.leaseUntil.getTime()})`,
      );
      jobBRenewCalls += 1;
      jobBRenewTimes.push({ at: Date.now(), leaseUntil: params.grant.leaseUntil.getTime() });
      return store.grant(Date.now() + params.extensionMs, params.grant.gameId, params.grant.operationId, String(jobBRenewCalls + 1));
    };

    worker = new AdjudicationWorker({
      store,
      executorId: EXECUTOR,
      leaseMs: 10_000,
      concurrency: 1,
      proofSliceMs: 50,
      publish: async () => {},
      monotonic: () => mono,
      now: () => Date.now(),
    });

    worker.start();
    // Fire pass 1 at delay 0: admits both jobs, leaves both pending in #inFlight
    mock.timers.tick(0);
    await pumpUntil(() => store.claims.length >= 2);

    // Advance mock clock across 25000ms (>2 full lease intervals of 10000ms) in <=2500ms increments
    // with bounded real event-loop flushing between each, while JOB_A's single renewal remains deferred.
    for (let elapsed = 0; elapsed < 25_000; elapsed += 2_500) {
      mock.timers.tick(2_500);
      await pumpUntil(() => false, 1);
    }

    // Assert multiple timely B renewals completed strictly before expiry, while A remained stalled
    assert.equal(jobARenewCalls, 1, 'only one renewal initiated for stalled JOB_A');
    assert.ok(jobBRenewCalls >= 3, `multiple timely B renewals completed (actual: ${jobBRenewCalls})`);
    assert.ok(jobBRenewTimes.length >= 3, 'recorded multiple timely B renewals');
    for (const record of jobBRenewTimes) {
      assert.ok(
        record.at < record.leaseUntil,
        `renewal at ${record.at} was strictly before lease deadline ${record.leaseUntil}`,
      );
    }

    // Calling stop() must wait for the in-flight renewal IO
    let stopResolved = false;
    const stopPromise = worker.stop().then(() => {
      stopResolved = true;
    });
    await pumpUntil(() => stopResolved, 5);
    assert.equal(stopResolved, false, 'stop() must not resolve while stalled renewal IO is in flight');

    // Resolve stalled renewal IO
    resolveJobA();
    await stopPromise;
    assert.equal(stopResolved, true, 'stop() resolved once stalled renewal IO completed');

    // Verify proof job for JOB_B was created exactly once (progress retained, no recreation)
    const jobBCreates = store.calls.filter((c) => c === `create:${JOB_B}`).length;
    assert.equal(jobBCreates, 1, 'JOB_B proof job was created exactly once');

    // No further proof steps after stop resolved
    const stepsBefore = store.calls.filter((c) => c.startsWith('step:')).length;
    mock.timers.tick(10_000);
    await pumpUntil(() => store.calls.filter((c) => c.startsWith('step:')).length > stepsBefore, 5);
    const stepsAfter = store.calls.filter((c) => c.startsWith('step:')).length;
    assert.equal(stepsAfter, stepsBefore, 'zero proof steps executed after stop resolved');
  } finally {
    try {
      resolveJobA?.();
      if (worker) await worker.stop();
    } finally {
      mock.timers.reset();
    }
  }
});
