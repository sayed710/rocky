/**
 * The adjudication worker's own logic, hermetically (Issue #124, ADR-0175): claiming, slicing,
 * renewal, the unresolved fallback, uncertain replies, release after publication, and stopping.
 * The real store and PostgreSQL are covered by adjudication-worker.integration.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  retained: number | undefined;
  leaseUntil = 1_000_000 + 30_000;
  stopWhenStepping: (() => void) | undefined;
  constructor(private readonly clock: { now: number }) {}

  async listClaimableAdjudications(): Promise<Array<{ gameId: string; operationId: string; generation: string }>> {
    const page = this.claimable;
    this.claimable = [];
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
  #grant(leaseUntil: number): AdjudicationClaimGrant {
    return new AdjudicationClaimGrant({
      gameId: GAME, operationId: OP, claimId: CLAIM, executorId: EXECUTOR, generation: '1',
      leaseUntil: new Date(leaseUntil), capability: Buffer.alloc(32, 7),
    });
  }
  async claimAdjudication(params: ClaimAdjudicationParams): Promise<AdjudicationClaimGrant> {
    this.claims.push(params);
    const failure = this.claimFailures.shift();
    if (failure === 'conflict') throw new AdjudicationConflictError('claimed elsewhere');
    if (failure === 'network') throw new Error('connection reset');
    return this.#grant(this.leaseUntil);
  }
  async renewAdjudication(params: RenewAdjudicationParams): Promise<AdjudicationClaimGrant> {
    this.renewals.push(params);
    this.leaseUntil = this.clock.now + params.extensionMs;
    return this.#grant(this.leaseUntil);
  }
  async createProofJob(): Promise<string> {
    this.calls.push('create');
    return OP;
  }
  stepProofJob(_operationId: string, budget: number): JobStepResult {
    this.calls.push(`step:${budget}`);
    this.stopWhenStepping?.();
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
    return { gameId: GAME, operationId: OP, startedSeq: 3, finalSeq: 5, eventCount: 2, completedAt: params.resolutionAt } as AdjudicationSettlementReceipt;
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
  for (const bad of [{ leaseMs: 0 }, { sliceBudget: -1 }, { pollMs: 1.5 }, { pageSize: Number.NaN }, { releaseGraceMs: -1 }, { releaseGraceMs: 0.5 }]) {
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
