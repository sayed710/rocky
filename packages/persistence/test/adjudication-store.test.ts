/**
 * @packageDocumentation
 * Hermetic unit tests for AdjudicationStore types, grants, validations, and invariants (Issue #124 Stage M).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { randomBytes } from 'node:crypto';
import {
  AdjudicationClaimGrant,
  AdjudicationClaimExpiredError,
  AdjudicationConflictError,
  AdjudicationFenceError,
  PgAdjudicationStore,
  PgFencedNoShowCandidates,
} from '../src/pg';
import { AdjudicationCompletionSeam } from '../src/pg/adjudication-completion-seam';
import { PersistenceError } from '../src/errors';
import {
  Game,
  AdjudicationJobController,
  type AdjudicationStartedEvent,
  type PreparedOperation,
  type SettlementResult,
} from '@chess-platform/game';
import {
  assertIdenticalStartRetry,
  assertIdenticalSettlementRetry,
  resolveAdmissionPrepared,
} from '../src/pg/adjudication-helpers';
import {
  sha256,
  type AcceptanceAccounting,
  type AdjudicationDbRow,
} from '../src/pg/adjudication-types';

const VALID_UUID_1 = '018f2780-0000-7000-8000-000000000001';
const VALID_UUID_2 = '018f2780-0000-7000-8000-000000000002';
const VALID_UUID_3 = '018f2780-0000-7000-8000-000000000003';
const VALID_UUID_4 = '018f2780-0000-7000-8000-000000000004';

test('AdjudicationClaimGrant validates UUIDs, 32-byte capability, and decimal generation', () => {
  const cap = randomBytes(32);
  const now = new Date();
  const grant = new AdjudicationClaimGrant({
    gameId: VALID_UUID_1,
    operationId: VALID_UUID_2,
    claimId: VALID_UUID_3,
    executorId: VALID_UUID_4,
    generation: '42',
    leaseUntil: now,
    capability: cap,
  });

  assert.equal(grant.gameId, VALID_UUID_1);
  assert.equal(grant.operationId, VALID_UUID_2);
  assert.equal(grant.claimId, VALID_UUID_3);
  assert.equal(grant.executorId, VALID_UUID_4);
  assert.equal(grant.generation, '42');
  assert.equal(grant.leaseUntil.getTime(), now.getTime());
  assert.deepEqual(grant.capabilityForQuery(), cap);

  // Capability defensive copy
  const copy = grant.capabilityForQuery();
  copy[0] = (copy[0]! ^ 0xff);
  assert.notDeepEqual(grant.capabilityForQuery(), copy);
});

test('AdjudicationClaimGrant redacts raw capability in JSON and util.inspect', () => {
  const cap = randomBytes(32);
  const grant = new AdjudicationClaimGrant({
    gameId: VALID_UUID_1,
    operationId: VALID_UUID_2,
    claimId: VALID_UUID_3,
    executorId: VALID_UUID_4,
    generation: '0',
    leaseUntil: new Date('2026-11-03T12:00:00Z'),
    capability: cap,
  });

  const jsonStr = JSON.stringify(grant);
  assert.match(jsonStr, /"capability":"\[REDACTED\]"/);
  assert.doesNotMatch(jsonStr, new RegExp(cap.toString('hex')));

  const inspected = inspect(grant);
  assert.match(inspected, /capability:\s*'\[REDACTED\]'/);
  assert.doesNotMatch(inspected, new RegExp(cap.toString('hex')));
});

test('AdjudicationClaimGrant rejects malformed UUIDs and non-32-byte capabilities', () => {
  const cap = randomBytes(32);
  const shortCap = randomBytes(16);
  const now = new Date();

  assert.throws(
    () => new AdjudicationClaimGrant({ gameId: 'invalid-uuid', operationId: VALID_UUID_2, claimId: VALID_UUID_3, executorId: VALID_UUID_4, generation: '0', leaseUntil: now, capability: cap }),
    AdjudicationConflictError,
  );
  assert.throws(
    () => new AdjudicationClaimGrant({ gameId: VALID_UUID_1, operationId: 'invalid-uuid', claimId: VALID_UUID_3, executorId: VALID_UUID_4, generation: '0', leaseUntil: now, capability: cap }),
    AdjudicationConflictError,
  );
  assert.throws(
    () => new AdjudicationClaimGrant({ gameId: VALID_UUID_1, operationId: VALID_UUID_2, claimId: 'invalid-uuid', executorId: VALID_UUID_4, generation: '0', leaseUntil: now, capability: cap }),
    AdjudicationConflictError,
  );
  assert.throws(
    () => new AdjudicationClaimGrant({ gameId: VALID_UUID_1, operationId: VALID_UUID_2, claimId: VALID_UUID_3, executorId: 'invalid-uuid', generation: '0', leaseUntil: now, capability: cap }),
    AdjudicationConflictError,
  );
  assert.throws(
    () => new AdjudicationClaimGrant({ gameId: VALID_UUID_1, operationId: VALID_UUID_2, claimId: VALID_UUID_3, executorId: VALID_UUID_4, generation: '0', leaseUntil: now, capability: shortCap }),
    AdjudicationConflictError,
  );
  assert.throws(
    () => new AdjudicationClaimGrant({ gameId: VALID_UUID_1, operationId: VALID_UUID_2, claimId: VALID_UUID_3, executorId: VALID_UUID_4, generation: '-1', leaseUntil: now, capability: cap }),
    AdjudicationConflictError,
  );
  assert.throws(
    () => new AdjudicationClaimGrant({ gameId: VALID_UUID_1, operationId: VALID_UUID_2, claimId: VALID_UUID_3, executorId: VALID_UUID_4, generation: '9999999999999999999999999', leaseUntil: now, capability: cap }),
    RangeError,
  );
});

test('typed adjudication persistence errors inherit from PersistenceError', () => {
  const conflict = new AdjudicationConflictError('conflict');
  const expired = new AdjudicationClaimExpiredError('expired');
  const fence = new AdjudicationFenceError('fence');

  assert.ok(conflict instanceof PersistenceError);
  assert.ok(expired instanceof PersistenceError);
  assert.ok(fence instanceof PersistenceError);
  assert.equal(conflict.name, 'AdjudicationConflictError');
  assert.equal(expired.name, 'AdjudicationClaimExpiredError');
  assert.equal(fence.name, 'AdjudicationFenceError');
});

test('PgFencedNoShowCandidates rejects invalid loadedHead bounds', async () => {
  const fakePool = {} as unknown as import('pg').Pool;
  const candidates = new PgFencedNoShowCandidates(fakePool);

  await assert.rejects(
    () => candidates.dismiss(VALID_UUID_1, -1),
    RangeError,
  );
  await assert.rejects(
    () => candidates.dismiss(VALID_UUID_1, 1.5),
    RangeError,
  );
  await assert.rejects(
    () => candidates.reschedule(VALID_UUID_1, -1, new Date()),
    RangeError,
  );
  await assert.rejects(
    () => candidates.reschedule(VALID_UUID_1, 1.5, new Date()),
    RangeError,
  );
});

test('crafted prototype, genuine instance with override, and subclass cannot supply controller authority', () => {
  // 1. Crafted real-prototype object (probe case 1: Object.create(AdjudicationJobController.prototype))
  const craftedProto = Object.create(AdjudicationJobController.prototype);
  craftedProto.settleJob = () => {
    throw new Error('crafted settleJob must never be invoked');
  };
  assert.throws(
    () => Reflect.construct(AdjudicationCompletionSeam, [craftedProto]),
    AdjudicationConflictError,
  );

  // 2. Genuine instance with own overridden method (probe case 2: new AdjudicationJobController() with own settleJob)
  const genuineWithOverride = new AdjudicationJobController();
  genuineWithOverride.settleJob = () => {
    throw new Error('overridden settleJob must never be invoked');
  };
  assert.throws(
    () => Reflect.construct(AdjudicationCompletionSeam, [genuineWithOverride]),
    AdjudicationConflictError,
  );

  // 3. Controller subclass (probe case 3)
  class SubclassController extends AdjudicationJobController {
    override settleJob(): SettlementResult {
      throw new Error('subclass settleJob must never be invoked');
    }
  }
  assert.throws(
    () => Reflect.construct(AdjudicationCompletionSeam, [new SubclassController()]),
    AdjudicationConflictError,
  );
});

test('PgAdjudicationStore rejects caller-supplied seam and exposes no mutable controller or seam getters', () => {
  const fakePool = {} as unknown as import('pg').Pool;
  const seam = new AdjudicationCompletionSeam();

  // Constructor rejects caller-supplied seam
  assert.throws(
    () => Reflect.construct(PgAdjudicationStore, [fakePool, seam]),
    AdjudicationConflictError,
  );

  // Store instance exposes no controller or seam getters
  const store = new PgAdjudicationStore(fakePool);
  assert.equal('controller' in store, false);
  assert.equal('seam' in store, false);

  // Seam exposes no mutable controller getter or evaluateSettlementWithController
  assert.equal('controller' in seam, false);
  assert.equal('evaluateSettlementWithController' in seam, false);
});

test('genuine private proof job produces and retains fixed verified result for retry', () => {
  const seam = new AdjudicationCompletionSeam();
  const cap = randomBytes(32);
  const grant = new AdjudicationClaimGrant({
    gameId: VALID_UUID_1,
    operationId: VALID_UUID_2,
    claimId: VALID_UUID_3,
    executorId: VALID_UUID_4,
    generation: '1',
    leaseUntil: new Date(Date.now() + 60_000),
    capability: cap,
  });

  const mateFen = '4k3/4Q3/4K3/8/8/8/8/8 b - - 0 1';
  const created = Game.create({
    gameId: VALID_UUID_1,
    players: { white: VALID_UUID_3, black: VALID_UUID_4 },
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    initialFen: mateFen,
    rated: false,
    at: 1000,
  });

  const resignOp: PreparedOperation = {
    operationId: VALID_UUID_2,
    gameId: VALID_UUID_1,
    baseRevision: 0,
    baseFen: mateFen,
    variant: 'standard',
    rulesVersion: 'standard@1.0.0',
    intent: { kind: 'resign', color: 'b' },
    at: 1100,
  };

  const startedEvent: AdjudicationStartedEvent = {
    type: 'AdjudicationStarted',
    gameId: VALID_UUID_1,
    operationId: VALID_UUID_2,
    baseRevision: 0,
    at: 1100,
    rulesVersion: 'standard@1.0.0',
    prepared: resignOp,
  };

  const gameAfterStarted = Game.fromEvents([...created.events, startedEvent]);

  // Genuine private job creation and stepping through bounded entrypoints
  const jobId = seam.createProofJob(resignOp, gameAfterStarted);
  assert.equal(jobId, VALID_UUID_2);

  const jobView = seam.getProofJob(VALID_UUID_2);
  assert.ok(jobView);
  assert.equal(jobView.operationId, VALID_UUID_2);

  const stepResult = seam.stepAllProofJobs(1000);
  assert.ok(stepResult.totalDeltaWork >= 0);

  // Evaluate settlement produces genuine settlement result
  const retained1 = seam.evaluateSettlement(gameAfterStarted, VALID_UUID_2, 1200, grant);
  assert.ok(retained1.settlement);
  assert.equal(retained1.operationId, VALID_UUID_2);
  assert.equal(retained1.settlement.batch.length > 0, true);
  assert.equal(retained1.settlement.batch[0]?.type, 'AdjudicationResolved');

  // Same-process retry returns exact same retained instance without re-executing settleJob
  const retained2 = seam.evaluateSettlement(gameAfterStarted, VALID_UUID_2, 1200, grant);
  assert.strictEqual(retained1, retained2);

  // Retained settlement credentials mismatch with current claim grant rejects
  const mismatchedGrant = new AdjudicationClaimGrant({
    gameId: VALID_UUID_1,
    operationId: VALID_UUID_2,
    claimId: VALID_UUID_4,
    executorId: VALID_UUID_3,
    generation: '2',
    leaseUntil: new Date(Date.now() + 60_000),
    capability: cap,
  });
  assert.throws(
    () => seam.evaluateSettlement(gameAfterStarted, VALID_UUID_2, 1200, mismatchedGrant),
    AdjudicationConflictError,
  );
});

test('creating proof work strictly requires matching store-owned durable accepted pending context', () => {
  const seam = new AdjudicationCompletionSeam();
  const mateFen = '4k3/4Q3/4K3/8/8/8/8/8 b - - 0 1';
  const created = Game.create({
    gameId: VALID_UUID_1,
    players: { white: VALID_UUID_3, black: VALID_UUID_4 },
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    initialFen: mateFen,
    rated: false,
    at: 1000,
  });

  const resignOp: PreparedOperation = {
    operationId: VALID_UUID_2,
    gameId: VALID_UUID_1,
    baseRevision: 0,
    baseFen: mateFen,
    variant: 'standard',
    rulesVersion: 'standard@1.0.0',
    intent: { kind: 'resign', color: 'b' },
    at: 1100,
  };

  // 1. Arbitrary game without pending adjudication rejects
  assert.throws(
    () => seam.createProofJob(resignOp, created.game),
    AdjudicationConflictError,
  );

  // 2. Game with mismatched operationId rejects
  const startedEvent: AdjudicationStartedEvent = {
    type: 'AdjudicationStarted',
    gameId: VALID_UUID_1,
    operationId: VALID_UUID_3,
    baseRevision: 0,
    at: 1100,
    rulesVersion: 'standard@1.0.0',
    prepared: { ...resignOp, operationId: VALID_UUID_3 },
  };
  const gameWithOtherOp = Game.fromEvents([...created.events, startedEvent]);
  assert.throws(
    () => seam.createProofJob(resignOp, gameWithOtherOp),
    AdjudicationConflictError,
  );
});

test('resolveAdmissionPrepared identifies ready no-ops without creating jobs', () => {
  const { game } = Game.create({
    gameId: VALID_UUID_1,
    players: { white: VALID_UUID_3, black: VALID_UUID_4 },
    timeControl: { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 },
    rated: false,
    at: 1000,
  });

  // Ready on an unsourced game returns a genuine no-op
  const adm = resolveAdmissionPrepared(game, {
    gameId: VALID_UUID_1,
    command: { kind: 'ready' },
    context: {
      operationId: VALID_UUID_2,
      color: 'w',
      at: 1100,
      rulesVersion: 'standard@1.0.0',
    },
  });

  assert.equal(adm.kind, 'noop');
  assert.equal(adm.reason, 'unsourced');
});

test('assertIdenticalStartRetry strictly verifies immutable identity, envelope, and accounting', () => {
  const prepared: PreparedOperation = {
    operationId: VALID_UUID_2,
    gameId: VALID_UUID_1,
    baseRevision: 0,
    baseFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    variant: 'standard',
    rulesVersion: 'standard@1.0.0',
    intent: { kind: 'resign', color: 'w' },
    at: 1100,
  };

  const acct: AcceptanceAccounting = {
    originalClock: { turnStartedAt: null, remaining: { w: 180000, b: 180000 } },
    thinkingElapsedAtA: 0,
    originalNoShowAt: null,
    remainingNoShowTimeAtA: null,
    originalBasis: null,
  };

  const expectedStartedEvent: AdjudicationStartedEvent = {
    type: 'AdjudicationStarted',
    gameId: VALID_UUID_1,
    operationId: VALID_UUID_2,
    baseRevision: 0,
    at: 1100,
    rulesVersion: 'standard@1.0.0',
    prepared,
  };

  const validRow: AdjudicationDbRow = {
    game_id: VALID_UUID_1,
    operation_id: VALID_UUID_2,
    base_revision: 0,
    started_seq: 1,
    started_type: 'AdjudicationStarted',
    started_version: 1,
    started_payload: JSON.parse(JSON.stringify(expectedStartedEvent)),
    prepared,
    accepted_at: '1100',
    rules_version: 'standard@1.0.0',
    clock_policy: null,
    original_clock: acct.originalClock,
    thinking_elapsed_at_a: '0',
    original_no_show_at: null,
    remaining_no_show_time_at_a: null,
    original_basis: null,
    execution_state: 'proving',
    generation: '0',
    claim_id: null,
    executor_id: null,
    capability_hash: null,
    lease_until: null,
    start_permit_xact_id: '100',
    start_permit_consumed: false,
    settlement_batch: null,
    settlement_receipt: null,
    final_seq: null,
    stopped_clock: null,
    is_current_stop: false,
    completed_generation: null,
    completed_claim_id: null,
    completed_executor_id: null,
    completed_capability_hash: null,
  };

  // Identical passes without throwing
  assert.doesNotThrow(() => assertIdenticalStartRetry(validRow, prepared, acct));

  // Altered accounting throws
  const alteredAcct: AcceptanceAccounting = { ...acct, thinkingElapsedAtA: 5000 };
  assert.throws(
    () => assertIdenticalStartRetry(validRow, prepared, alteredAcct),
    AdjudicationConflictError,
  );

  // Altered started_payload throws
  const alteredPayloadRow: AdjudicationDbRow = {
    ...validRow,
    started_payload: { ...expectedStartedEvent, at: 9999 },
  };
  assert.throws(
    () => assertIdenticalStartRetry(alteredPayloadRow, prepared, acct),
    AdjudicationConflictError,
  );

  // Altered started_version throws
  const alteredVersionRow: AdjudicationDbRow = { ...validRow, started_version: 2 };
  assert.throws(
    () => assertIdenticalStartRetry(alteredVersionRow, prepared, acct),
    AdjudicationConflictError,
  );

  // Altered started_type throws
  const alteredTypeRow: AdjudicationDbRow = { ...validRow, started_type: 'WrongType' };
  assert.throws(
    () => assertIdenticalStartRetry(alteredTypeRow, prepared, acct),
    AdjudicationConflictError,
  );
});

test('assertIdenticalSettlementRetry checks credentials and exact batch content', () => {
  const cap = randomBytes(32);
  const grant = new AdjudicationClaimGrant({
    gameId: VALID_UUID_1,
    operationId: VALID_UUID_2,
    claimId: VALID_UUID_3,
    executorId: VALID_UUID_4,
    generation: '1',
    leaseUntil: new Date(Date.now() + 60_000),
    capability: cap,
  });

  const batch = [{ type: 'AdjudicationResolved', payload: { outcome: '1-0' } }];

  const validRow: AdjudicationDbRow = {
    game_id: VALID_UUID_1,
    operation_id: VALID_UUID_2,
    base_revision: 0,
    started_seq: 1,
    started_type: 'AdjudicationStarted',
    started_version: 1,
    started_payload: {},
    prepared: {} as unknown as PreparedOperation,
    accepted_at: '1100',
    rules_version: 'standard@1.0.0',
    clock_policy: null,
    original_clock: { turnStartedAt: null, remaining: { w: 0, b: 0 } },
    thinking_elapsed_at_a: '0',
    original_no_show_at: null,
    remaining_no_show_time_at_a: null,
    original_basis: null,
    execution_state: 'completed',
    generation: '1',
    claim_id: VALID_UUID_3,
    executor_id: VALID_UUID_4,
    capability_hash: grant.capabilityForQuery(),
    lease_until: null,
    start_permit_xact_id: '100',
    start_permit_consumed: true,
    settlement_batch: batch,
    settlement_receipt: {
      gameId: VALID_UUID_1,
      operationId: VALID_UUID_2,
      startedSeq: 1,
      finalSeq: 2,
      eventCount: 1,
      completedAt: 1200,
      resolvedEvent: batch[0] as unknown as import('@chess-platform/game').AdjudicationResolvedEvent,
    },
    final_seq: 2,
    stopped_clock: null,
    is_current_stop: false,
    completed_generation: '1',
    completed_claim_id: VALID_UUID_3,
    completed_executor_id: VALID_UUID_4,
    completed_capability_hash: sha256(grant.capabilityForQuery()),
  };

  assert.doesNotThrow(() => assertIdenticalSettlementRetry(validRow, grant, batch));

  // Altered batch throws
  const alteredBatch = [{ type: 'AdjudicationResolved', payload: { outcome: '0-1' } }];
  assert.throws(
    () => assertIdenticalSettlementRetry(validRow, grant, alteredBatch),
    AdjudicationConflictError,
  );
});
