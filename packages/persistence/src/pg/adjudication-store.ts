/**
 * @packageDocumentation
 * Bounded Stage M durable adjudication persistence (Issue #124, ADR-0174). Unwired: nothing in
 * the running application constructs this store yet.
 *
 * Implements:
 * - PgAdjudicationStore transaction APIs: startAdjudication, claimAdjudication,
 *   renewAdjudication, settleAdjudication, and reconcileAdjudication.
 * - Same-client creation coordinator helper composeCreationAdjudication.
 * - Short READ COMMITTED transactions with strict advisory game fence.
 * - Private controller binding seam for settlement evidence outside DB transactions/locks.
 * - Lease, capability, generation, and permit lifecycle management.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import {
  Game,
  prepareCreationAdmission,
  type AdjudicationJobView,
  type AdjudicationStartedEvent,
  type AllStepResult,
  type GameEvent,
  type JobStepResult,
  type PreparedOperation,
} from '@chess-platform/game';
import { CURRENT_EVENT_VERSION, type StoredEvent } from '../event-store';
import {
  AdjudicationClaimExpiredError,
  AdjudicationConflictError,
  AdjudicationFenceError,
  PersistenceError,
} from '../errors';
import {
  AdjudicationClaimGrant,
  validateLeaseMs,
  type AdjudicationDbRow,
  type AdjudicationSettlementReceipt,
  type ClaimAdjudicationParams,
  type ClaimIntent,
  type ReconcileAdjudicationResult,
  type RenewAdjudicationParams,
  type RetainedSettlement,
  type SettleAdjudicationParams,
  type StartAdjudicationParams,
  type StartAdjudicationResult,
} from './adjudication-types';
import {
  AdjudicationCompletionSeam,
} from './adjudication-completion-seam';
import {
  acquireGameLockAndCheckIsolation,
  assertIdenticalSettlementRetry,
  assertIdenticalStartRetry,
  deriveAcceptanceAccounting,
  insertStartedAdjudicationRow,
  loadAdjudicationRow,
  loadDurableEvents,
  normalizeJson,
  resolveAdmissionPrepared,
} from './adjudication-helpers';
import {
  assertClaimRequest,
  assertLiveGrant,
  databaseNow,
  loadProvingRowAtHead,
  recoverClaim,
  loadRelease,
  writeClaim,
  writeRelease,
  writeSettlement,
  type AdjudicationReleaseReceipt,
} from './adjudication-operations';

export type { AdjudicationReleaseReceipt } from './adjudication-operations';

export {
  AdjudicationClaimExpiredError,
  AdjudicationConflictError,
  AdjudicationFenceError,
  PersistenceError,
};

export {
  AdjudicationClaimGrant,
  type AdjudicationClaimGrantInit,
  type AdjudicationSettlementReceipt,
  type ClaimAdjudicationParams,
  type ClaimIntent,
  type ReconcileAdjudicationResult,
  type RenewAdjudicationParams,
  type RetainedSettlement,
  type SettleAdjudicationParams,
  type StartAdjudicationParams,
  type StartAdjudicationResult,
} from './adjudication-types';

export type {
  AdjudicationJobView,
  AllStepResult,
  JobStepResult,
} from '@chess-platform/game';

async function rollbackQuietly(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

function reconcileExistingStart(
  existing: AdjudicationDbRow,
  events: readonly StoredEvent[],
  params: StartAdjudicationParams,
): StartAdjudicationResult {
  const baseEvents = events.filter((e) => e.seq <= existing.base_revision);
  if (baseEvents.length === 0) {
    throw new AdjudicationConflictError('Corrupted event history for existing adjudication');
  }
  const baseGame = Game.fromEvents(baseEvents.map((e) => e.event));
  const adm = resolveAdmissionPrepared(baseGame, params);
  if (adm.kind === 'noop') {
    throw new AdjudicationConflictError('Different operation for existing adjudication operationId results in no-op');
  }
  const candidateStarted = startedEventFor(adm.operation);
  const acct = deriveAcceptanceAccounting(baseEvents, candidateStarted);
  assertIdenticalStartRetry(existing, adm.operation, acct, candidateStarted);
  if (existing.execution_state === 'completed') {
    if (!existing.settlement_receipt) {
      throw new AdjudicationConflictError('Completed adjudication missing receipt');
    }
    return { status: 'completed', operationId: existing.operation_id, receipt: existing.settlement_receipt };
  }
  return {
    status: 'proving',
    operationId: existing.operation_id,
    startedSeq: existing.started_seq,
    prepared: existing.prepared,
  };
}

export class PgAdjudicationStore {
  readonly #seam: AdjudicationCompletionSeam;

  constructor(private readonly pool: Pool) {
    if (arguments.length > 1) {
      throw new AdjudicationConflictError('Unauthorized seam: PgAdjudicationStore accepts no external seam or controller');
    }
    this.#seam = new AdjudicationCompletionSeam();
  }

  async createProofJob(gameId: string, operationId: string): Promise<string> {
    const client = await this.pool.connect();
    let durableEvents: StoredEvent[];
    try {
      durableEvents = await loadDurableEvents(client, gameId);
    } finally {
      client.release();
    }

    if (durableEvents.length === 0) {
      throw new PersistenceError(`Game ${gameId} not found`);
    }
    const durableGame = Game.fromEvents(durableEvents.map((e) => e.event));
    const pending = durableGame.adjudication;
    if (!pending || pending.operationId !== operationId) {
      throw new AdjudicationConflictError('Durable game pending adjudication does not match proof job operation');
    }
    return this.#seam.createProofJob(pending.prepared, durableGame);
  }

  stepProofJob(operationId: string, totalWorkBudget: number): JobStepResult {
    return this.#seam.stepProofJob(operationId, totalWorkBudget);
  }

  stepAllProofJobs(totalWorkBudget: number): AllStepResult {
    return this.#seam.stepAllProofJobs(totalWorkBudget);
  }

  getProofJob(operationId: string): Readonly<AdjudicationJobView> | undefined {
    return this.#seam.getProofJob(operationId);
  }

  cancelProofJob(operationId: string): void {
    this.#seam.cancelProofJob(operationId);
  }

  evictProofJob(operationId: string): boolean {
    return this.#seam.evictProofJob(operationId);
  }

  /** Conclude an exhausted proof question as unresolved: it never declares a dead position. */
  concludeUnresolvedProofJob(operationId: string): JobStepResult {
    return this.#seam.concludeUnresolvedProofJob(operationId);
  }

  /** Proving operations nobody holds a live lease on, oldest first: work a worker may claim. */
  async listClaimableAdjudications(limit: number): Promise<Array<{ gameId: string; operationId: string; generation: string }>> {
    const rows = await this.pool.query<{ game_id: string; operation_id: string; generation: string }>(
      `SELECT game_id, operation_id, generation::text AS generation FROM game_adjudications
       WHERE execution_state = 'proving' AND (lease_until IS NULL OR lease_until <= clock_timestamp())
       ORDER BY created_at, game_id LIMIT $1`,
      [limit],
    );
    return rows.rows.map((r) => ({ gameId: r.game_id, operationId: r.operation_id, generation: r.generation }));
  }

  /** Games whose latest completion is a current stop with no adjudication proving: ready to release. */
  async listReleasableStops(limit: number): Promise<Array<{ gameId: string; stopOperationId: string }>> {
    const rows = await this.pool.query<{ game_id: string; operation_id: string }>(
      `SELECT a.game_id, a.operation_id FROM game_adjudications a
       WHERE a.is_current_stop AND NOT EXISTS (
         SELECT 1 FROM game_adjudications p WHERE p.game_id = a.game_id AND p.execution_state = 'proving')
       ORDER BY a.completed_at, a.game_id LIMIT $1`,
      [limit],
    );
    return rows.rows.map((r) => ({ gameId: r.game_id, stopOperationId: r.operation_id }));
  }

  stepJob(operationId: string, totalWorkBudget: number): JobStepResult {
    return this.stepProofJob(operationId, totalWorkBudget);
  }

  getJob(operationId: string): Readonly<AdjudicationJobView> | undefined {
    return this.getProofJob(operationId);
  }

  /**
   * Run `work` in one short READ COMMITTED transaction holding the game's adjudication fence.
   * Proof work never runs inside it.
   */
  async #inGameTransaction<T>(gameId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await acquireGameLockAndCheckIsolation(client, gameId);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Accept a command for adjudication: one transaction appends the obligation row and its exact
   * Started event. An identical retry (including after a lost COMMIT reply) answers with the
   * recorded state; a differing request for the same operation id conflicts.
   */
  async startAdjudication(params: StartAdjudicationParams): Promise<StartAdjudicationResult> {
    const operationId = params.prepared ? params.prepared.operationId : params.context.operationId;
    return this.#inGameTransaction(params.gameId, async (client) => {
      const existing = await loadAdjudicationRow(client, params.gameId, operationId, true);
      const events = await loadDurableEvents(client, params.gameId);
      if (events.length === 0) throw new PersistenceError(`Game ${params.gameId} not found`);
      if (existing) return reconcileExistingStart(existing, events, params);

      const active = await client.query(
        "SELECT 1 FROM game_adjudications WHERE game_id = $1 AND execution_state = 'proving'",
        [params.gameId],
      );
      if (active.rows.length > 0) {
        throw new AdjudicationConflictError('Another adjudication operation is currently active for this game');
      }
      const adm = resolveAdmissionPrepared(Game.fromEvents(events.map((e) => e.event)), params);
      if (adm.kind === 'noop') return { status: 'noop', reason: adm.reason };

      const prepared = adm.operation;
      const startedEvent = startedEventFor(prepared);
      await insertStartedAdjudicationRow(client, params.gameId, startedEvent, deriveAcceptanceAccounting(events, startedEvent));
      await client.query(
        'INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, $3, $4, $5::jsonb)',
        [params.gameId, prepared.baseRevision + 1, startedEvent.type, CURRENT_EVENT_VERSION, JSON.stringify(startedEvent)],
      );
      return { status: 'started', operationId, startedSeq: prepared.baseRevision + 1, prepared };
    });
  }

  /**
   * A fresh claim intent. Keep it until the claim's outcome is known: retrying
   * {@link claimAdjudication} with the same intent after a lost reply recovers the grant that
   * committed, while a new intent can never be mistaken for it.
   */
  static newClaimIntent(): ClaimIntent {
    return Object.freeze({ claimId: randomUUID(), capability: randomBytes(32) });
  }

  /** Take (or, with the same intent, recover) the lease on a proving operation. */
  async claimAdjudication(params: ClaimAdjudicationParams): Promise<AdjudicationClaimGrant> {
    assertClaimRequest(params);
    return this.#inGameTransaction(params.gameId, async (client) => {
      const row = await loadProvingRowAtHead(client, params.gameId, params.operationId);
      const now = await databaseNow(client);
      return recoverClaim(row, params, now) ?? writeClaim(client, row, params, now);
    });
  }

  /**
   * Extend a live lease to at most `extensionMs` past database now (never shortening it), so a
   * retried renewal after a lost reply cannot stack extensions.
   */
  async renewAdjudication(params: RenewAdjudicationParams): Promise<AdjudicationClaimGrant> {
    validateLeaseMs(params.extensionMs);
    const { grant } = params;
    return this.#inGameTransaction(grant.gameId, async (client) => {
      const row = await loadProvingRowAtHead(client, grant.gameId, grant.operationId);
      const now = await databaseNow(client);
      assertLiveGrant(row, grant, now);
      const leaseUntil = new Date(Math.max(row.lease_until!.getTime(), now.getTime() + params.extensionMs));
      await client.query(
        'UPDATE game_adjudications SET lease_until = $3 WHERE game_id = $1 AND operation_id = $2',
        [grant.gameId, grant.operationId, leaseUntil],
      );
      return new AdjudicationClaimGrant({
        gameId: grant.gameId,
        operationId: grant.operationId,
        claimId: grant.claimId,
        executorId: grant.executorId,
        generation: grant.generation,
        leaseUntil,
        capability: grant.capabilityForQuery(),
      });
    });
  }

  /** Evaluate the settlement once, outside every transaction and lock, and retain it for retries. */
  private async prepareSettlementOutsideLock(params: SettleAdjudicationParams): Promise<RetainedSettlement> {
    const existing = this.#seam.getRetainedSettlement(params.gameId, params.operationId);
    if (existing) {
      if (existing.resolutionAt !== params.resolutionAt) {
        throw new AdjudicationConflictError(
          'A settlement for this operation was already evaluated at another resolution instant; use retainedResolutionAt()',
        );
      }
      return existing;
    }
    const durableEvents = await this.#readEvents(params.gameId);
    const durableGame = Game.fromEvents(durableEvents.map((e) => e.event));
    if (durableGame.adjudication?.operationId !== params.operationId) {
      throw new AdjudicationConflictError('Durable game pending adjudication does not match settlement operation');
    }
    return this.#seam.evaluateSettlement(durableGame, params.gameId, params.operationId, params.resolutionAt);
  }

  async #readEvents(gameId: string): Promise<StoredEvent[]> {
    const client = await this.pool.connect();
    let events: StoredEvent[];
    try {
      events = await loadDurableEvents(client, gameId);
    } finally {
      client.release();
    }
    if (events.length === 0) throw new PersistenceError(`Game ${gameId} not found`);
    return events;
  }

  /** The stored receipt when the operation is already completed by this grant; null while proving. */
  async #completedReceipt(params: SettleAdjudicationParams): Promise<AdjudicationSettlementReceipt | null> {
    const client = await this.pool.connect();
    let row: AdjudicationDbRow | null;
    try {
      row = await loadAdjudicationRow(client, params.gameId, params.operationId);
    } finally {
      client.release();
    }
    if (!row) throw new PersistenceError(`Adjudication operation ${params.operationId} not found`);
    if (row.execution_state !== 'completed') return null;
    this.#assertCompletedBy(row, params, this.#seam.getRetainedSettlement(params.gameId, params.operationId)?.settlement.batch);
    return row.settlement_receipt!;
  }

  /**
   * A completed operation can never use a retained evaluation again, so it is dropped before the
   * credentials are compared: a conflict (another grant completed it) must not leak the entry.
   */
  #assertCompletedBy(row: AdjudicationDbRow, params: SettleAdjudicationParams, batch: readonly unknown[] | undefined): void {
    this.#seam.clearRetainedSettlement(params.gameId, params.operationId);
    assertIdenticalSettlementRetry(row, params.grant, batch);
  }

  /** The grant is the current live claim. A short fenced read; no proof work runs inside it. */
  async #assertGrantIsCurrent(params: SettleAdjudicationParams): Promise<void> {
    await this.#inGameTransaction(params.gameId, async (client) => {
      const row = await loadProvingRowAtHead(client, params.gameId, params.operationId);
      assertLiveGrant(row, params.grant, await databaseNow(client));
    });
  }

  /**
   * The resolution instant of an evaluation this store already holds for the operation, if any. A
   * successor whose predecessor's settlement transaction failed after evaluation settles with it.
   */
  retainedResolutionAt(gameId: string, operationId: string): number | undefined {
    return this.#seam.getRetainedSettlement(gameId, operationId)?.resolutionAt;
  }

  /**
   * Settle a proven operation with the current live claim. Safe to retry with the same grant after
   * any failure, including a lost COMMIT reply and a restart that lost the retained evaluation: a
   * completed operation answers with its stored receipt when this grant completed it.
   */
  async settleAdjudication(params: SettleAdjudicationParams): Promise<AdjudicationSettlementReceipt> {
    if (params.grant.gameId !== params.gameId || params.grant.operationId !== params.operationId) {
      throw new AdjudicationConflictError('Grant does not belong to this operation');
    }
    const done = await this.#completedReceipt(params);
    if (done) return done;
    // Only the current live claim may consume the proof job and fix the resolution instant; the
    // in-transaction check below still catches a lease lost in between.
    if (!this.#seam.getRetainedSettlement(params.gameId, params.operationId)) {
      await this.#assertGrantIsCurrent(params);
    }

    const { settlement } = await this.prepareSettlementOutsideLock(params);
    const receipt = await this.#inGameTransaction(params.gameId, async (client) => {
      const row = await loadAdjudicationRow(client, params.gameId, params.operationId, true);
      if (row?.execution_state === 'completed') {
        this.#assertCompletedBy(row, params, settlement.batch);
        return row.settlement_receipt!;
      }
      const proving = await loadProvingRowAtHead(client, params.gameId, params.operationId);
      return writeSettlement(client, params, proving, settlement);
    });
    this.#seam.clearRetainedSettlement(params.gameId, params.operationId);
    return receipt;
  }

  /**
   * Release the game's current managed stop at `at` (the authoritative instant S). Idempotent by
   * `releaseRequestId`: a retry after any failure, including a lost COMMIT reply, answers with the
   * release that committed and never releases twice.
   */
  async releaseClocks(params: {
    readonly gameId: string;
    readonly releaseRequestId: string;
    readonly at: number;
  }): Promise<AdjudicationReleaseReceipt> {
    if (typeof params.releaseRequestId !== 'string' || params.releaseRequestId.length === 0 || params.releaseRequestId.length > 200) {
      throw new AdjudicationConflictError('releaseRequestId must be a non-empty string of at most 200 characters');
    }
    return this.#inGameTransaction(params.gameId, async (client) => {
      const existing = await loadRelease(client, params.gameId, params.releaseRequestId);
      if (existing) return existing;
      const events = await loadDurableEvents(client, params.gameId);
      if (events.length === 0) throw new PersistenceError(`Game ${params.gameId} not found`);
      return writeRelease(client, Game.fromEvents(events.map((e) => e.event)), params);
    });
  }

  /** Read-only status of one operation, for recovery after any uncertain outcome. */
  async reconcileAdjudication(gameId: string, operationId: string): Promise<ReconcileAdjudicationResult> {
    return this.#inGameTransaction(gameId, async (client) => {
      const row = await loadAdjudicationRow(client, gameId, operationId);
      if (!row) return { status: 'absent' };
      if (row.execution_state === 'completed') {
        return { status: 'completed', receipt: row.settlement_receipt!, finalSeq: row.final_seq! };
      }
      const now = await databaseNow(client);
      return {
        status: 'proving',
        generation: row.generation,
        leaseStatus: row.lease_until !== null && row.lease_until > now ? 'live' : 'expired',
        claimId: row.claim_id,
        executorId: row.executor_id,
        leaseUntil: row.lease_until,
      };
    });
  }
}

function startedEventFor(prepared: PreparedOperation): AdjudicationStartedEvent {
  return Object.freeze({
    type: 'AdjudicationStarted',
    gameId: prepared.gameId,
    operationId: prepared.operationId,
    baseRevision: prepared.baseRevision,
    at: prepared.at,
    rulesVersion: prepared.rulesVersion,
    prepared,
    ...(prepared.clockPolicy ? { clockPolicy: prepared.clockPolicy } : {}),
  });
}

/** Composes adjudication start boundary on the same client during game creation. */
export async function composeCreationAdjudication(
  client: PoolClient,
  gameId: string,
  started: AdjudicationStartedEvent,
  preEventsInput?: readonly GameEvent[],
): Promise<void> {
  const preEvents = preEventsInput ?? (await loadDurableEvents(client, gameId)).map((e) => e.event);
  if (preEvents.length === 0) {
    throw new AdjudicationConflictError('Creation pre-Started events cannot be empty');
  }
  if (started.gameId !== gameId) {
    throw new AdjudicationConflictError('Creation AdjudicationStarted gameId mismatch');
  }
  if (started.baseRevision !== preEvents.length - 1) {
    throw new AdjudicationConflictError('Creation AdjudicationStarted baseRevision mismatch');
  }

  const preGame = Game.fromEvents(preEvents);
  const canon = prepareCreationAdmission(preGame, {
    operationId: started.prepared.operationId,
    rulesVersion: started.prepared.rulesVersion,
    at: started.prepared.at,
    clockPolicy: started.prepared.clockPolicy,
  });
  if (!isDeepStrictEqual(normalizeJson(started.prepared), normalizeJson(canon))) {
    throw new AdjudicationConflictError('Creation prepared operation diverges from domain derivation');
  }

  const durableStored: StoredEvent[] = preEvents.map((e, idx) => ({
    gameId,
    seq: idx,
    version: CURRENT_EVENT_VERSION,
    event: e,
    serverTs: started.at,
  }));
  const acct = deriveAcceptanceAccounting(durableStored, started);
  await insertStartedAdjudicationRow(client, gameId, started, acct);

  const startedSeq = started.baseRevision + 1;
  await client.query(
    `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [gameId, startedSeq, started.type, CURRENT_EVENT_VERSION, JSON.stringify(started)],
  );
}
