/**
 * @packageDocumentation
 * Bounded Stage M durable adjudication persistence (Issue #124, ADR 0174).
 *
 * Implements:
 * - PgAdjudicationStore transaction APIs: startAdjudication, claimAdjudication,
 *   renewAdjudication, settleAdjudication, and reconcileAdjudication.
 * - Same-client creation coordinator helper composeCreationAdjudication.
 * - Short READ COMMITTED transactions with strict advisory game fence.
 * - Private controller binding seam for settlement evidence outside DB transactions/locks.
 * - Lease, capability, generation, and permit lifecycle management.
 */

import { randomBytes } from 'node:crypto';
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
} from '@chess-platform/game';
import { CURRENT_EVENT_VERSION, type StoredEvent } from '../event-store';
import {
  AdjudicationClaimExpiredError,
  AdjudicationConflictError,
  AdjudicationFenceError,
  PersistenceError,
} from '../errors';
import {
  MAX_BIGINT,
  sha256,
  validateLeaseMs,
  type AdjudicationClaimGrant,
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

function computeNextGeneration(row: AdjudicationDbRow): string {
  const prior = BigInt(row.generation);
  const next = row.claim_id !== null ? prior + 1n : (prior === 0n ? 1n : prior);
  if (next > MAX_BIGINT) {
    throw new RangeError('generation overflow');
  }
  return next.toString();
}

function checkLiveClaimRetry(
  row: AdjudicationDbRow,
  intent: ClaimIntent,
  executorId: string,
  dbNow: Date,
): boolean {
  if (row.claim_id !== intent.claimId || row.executor_id !== executorId) {
    return false;
  }
  const hash = sha256(intent.capability);
  if (!row.capability_hash || !row.capability_hash.equals(hash)) {
    return false;
  }
  if (!row.lease_until || row.lease_until <= dbNow) {
    throw new AdjudicationClaimExpiredError('Adjudication claim lease has expired');
  }
  return true;
}

async function reconcileExistingStart(
  client: PoolClient,
  existing: AdjudicationDbRow,
  events: readonly StoredEvent[],
  params: StartAdjudicationParams,
): Promise<StartAdjudicationResult> {
  const baseEvents = events.filter((e) => e.seq <= existing.base_revision);
  if (baseEvents.length === 0) {
    throw new AdjudicationConflictError('Corrupted event history for existing adjudication');
  }
  const baseGame = Game.fromEvents(baseEvents.map((e) => e.event));
  const adm = resolveAdmissionPrepared(baseGame, params);
  if (adm.kind === 'noop') {
    throw new AdjudicationConflictError('Different operation for existing adjudication operationId results in no-op');
  }
  const candidateStarted: AdjudicationStartedEvent = Object.freeze({
    type: 'AdjudicationStarted',
    gameId: adm.operation.gameId,
    operationId: adm.operation.operationId,
    baseRevision: adm.operation.baseRevision,
    at: adm.operation.at,
    rulesVersion: adm.operation.rulesVersion,
    prepared: adm.operation,
    ...(adm.operation.clockPolicy ? { clockPolicy: adm.operation.clockPolicy } : {}),
  });
  const acct = deriveAcceptanceAccounting(baseEvents, candidateStarted);
  assertIdenticalStartRetry(existing, adm.operation, acct, candidateStarted);
  await client.query('COMMIT');
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

  stepJob(operationId: string, totalWorkBudget: number): JobStepResult {
    return this.stepProofJob(operationId, totalWorkBudget);
  }

  getJob(operationId: string): Readonly<AdjudicationJobView> | undefined {
    return this.getProofJob(operationId);
  }

  async startAdjudication(params: StartAdjudicationParams): Promise<StartAdjudicationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await acquireGameLockAndCheckIsolation(client, params.gameId);

      const opId = params.prepared ? params.prepared.operationId : params.context.operationId;
      const existing = await loadAdjudicationRow(client, params.gameId, opId, true);
      const events = await loadDurableEvents(client, params.gameId);
      if (events.length === 0) {
        throw new PersistenceError(`Game ${params.gameId} not found`);
      }
      const durableGame = Game.fromEvents(events.map((e) => e.event));

      if (existing) {
        return await reconcileExistingStart(client, existing, events, params);
      }

      const activeCheck = await client.query<{ operation_id: string }>(
        `SELECT operation_id FROM game_adjudications WHERE game_id = $1 AND execution_state <> 'completed'`,
        [params.gameId],
      );
      if (activeCheck.rowCount && activeCheck.rowCount > 0) {
        throw new AdjudicationConflictError('Another adjudication operation is currently active for this game');
      }

      const adm = resolveAdmissionPrepared(durableGame, params);
      if (adm.kind === 'noop') {
        await client.query('COMMIT');
        return { status: 'noop', reason: adm.reason };
      }
      const prepared = adm.operation;
      const startedEvent: AdjudicationStartedEvent = Object.freeze({
        type: 'AdjudicationStarted',
        gameId: prepared.gameId,
        operationId: prepared.operationId,
        baseRevision: prepared.baseRevision,
        at: prepared.at,
        rulesVersion: prepared.rulesVersion,
        prepared,
        ...(prepared.clockPolicy ? { clockPolicy: prepared.clockPolicy } : {}),
      });

      const acct = deriveAcceptanceAccounting(events, startedEvent);
      await insertStartedAdjudicationRow(client, params.gameId, startedEvent, acct);

      const startedSeq = prepared.baseRevision + 1;
      await client.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [params.gameId, startedSeq, startedEvent.type, CURRENT_EVENT_VERSION, JSON.stringify(startedEvent)],
      );

      await client.query('DELETE FROM pregame_deadlines WHERE game_id = $1', [params.gameId]);
      await client.query('DELETE FROM flag_deadlines WHERE game_id = $1', [params.gameId]);

      await client.query('COMMIT');
      return {
        status: 'started',
        operationId: prepared.operationId,
        startedSeq,
        prepared,
      };
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async claimAdjudication(params: ClaimAdjudicationParams): Promise<AdjudicationClaimGrant> {
    validateLeaseMs(params.leaseMs);
    const intent: ClaimIntent = Object.freeze({
      claimId: params.claimId ?? (params.existingGrant ? params.existingGrant.claimId : (await this.pool.query<{ id: string }>('SELECT gen_random_uuid()::text AS id')).rows[0]!.id),
      capability: params.capability ?? (params.existingGrant ? params.existingGrant.capabilityForQuery() : randomBytes(32)),
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await acquireGameLockAndCheckIsolation(client, params.gameId);

      const row = await loadAdjudicationRow(client, params.gameId, params.operationId, true);
      if (!row) throw new PersistenceError(`Adjudication operation ${params.operationId} not found`);
      if (row.execution_state !== 'proving') {
        throw new AdjudicationConflictError(`Cannot claim adjudication in state "${row.execution_state}"`);
      }

      const events = await loadDurableEvents(client, params.gameId);
      const head = events.at(-1)?.seq ?? -1;
      if (head !== row.started_seq) {
        throw new AdjudicationConflictError('Stream head does not match expected Started sequence');
      }

      const timeRes = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const dbNow = timeRes.rows[0]!.now;

      if (row.generation !== params.expectedGeneration) {
        if (checkLiveClaimRetry(row, intent, params.executorId, dbNow)) {
          await client.query('COMMIT');
          const { AdjudicationClaimGrant: GrantClass } = await import('./adjudication-types');
          return new GrantClass({
            gameId: params.gameId,
            operationId: params.operationId,
            claimId: intent.claimId,
            executorId: params.executorId,
            generation: row.generation,
            leaseUntil: row.lease_until!,
            capability: intent.capability,
          });
        }
        throw new AdjudicationConflictError(`Generation mismatch: expected ${params.expectedGeneration}, actual ${row.generation}`);
      }

      if (row.claim_id !== null && row.lease_until && row.lease_until > dbNow) {
        if (checkLiveClaimRetry(row, intent, params.executorId, dbNow)) {
          await client.query('COMMIT');
          const { AdjudicationClaimGrant: GrantClass } = await import('./adjudication-types');
          return new GrantClass({
            gameId: params.gameId,
            operationId: params.operationId,
            claimId: intent.claimId,
            executorId: params.executorId,
            generation: row.generation,
            leaseUntil: row.lease_until,
            capability: intent.capability,
          });
        }
        throw new AdjudicationConflictError('Active unexpired lease held by another claim');
      }

      const nextGen = computeNextGeneration(row);
      const leaseUntil = new Date(dbNow.getTime() + params.leaseMs);
      const capHash = sha256(intent.capability);

      await client.query(
        `UPDATE game_adjudications SET
           generation = $3,
           claim_id = $4,
           executor_id = $5,
           capability_hash = $6,
           lease_until = $7
         WHERE game_id = $1 AND operation_id = $2`,
        [params.gameId, params.operationId, nextGen, intent.claimId, params.executorId, capHash, leaseUntil],
      );

      await client.query('COMMIT');
      const { AdjudicationClaimGrant: GrantClass } = await import('./adjudication-types');
      return new GrantClass({
        gameId: params.gameId,
        operationId: params.operationId,
        claimId: intent.claimId,
        executorId: params.executorId,
        generation: nextGen,
        leaseUntil,
        capability: intent.capability,
      });
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async renewAdjudication(params: RenewAdjudicationParams): Promise<AdjudicationClaimGrant> {
    validateLeaseMs(params.extensionMs);
    const { grant } = params;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await acquireGameLockAndCheckIsolation(client, grant.gameId);

      const row = await loadAdjudicationRow(client, grant.gameId, grant.operationId, true);
      if (!row) throw new PersistenceError(`Adjudication operation ${grant.operationId} not found`);
      if (row.execution_state !== 'proving') {
        throw new AdjudicationConflictError(`Cannot renew adjudication in state "${row.execution_state}"`);
      }

      const hash = sha256(grant.capabilityForQuery());
      if (
        row.claim_id !== grant.claimId ||
        row.executor_id !== grant.executorId ||
        row.generation !== grant.generation ||
        !row.capability_hash ||
        !row.capability_hash.equals(hash)
      ) {
        throw new AdjudicationConflictError('Adjudication grant identity mismatch on renewal');
      }

      const timeRes = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const dbNow = timeRes.rows[0]!.now;
      if (!row.lease_until || row.lease_until <= dbNow) {
        throw new AdjudicationClaimExpiredError('Cannot renew an expired lease');
      }

      const events = await loadDurableEvents(client, grant.gameId);
      const head = events.at(-1)?.seq ?? -1;
      if (head !== row.started_seq) {
        throw new AdjudicationConflictError('Stream head does not match expected Started sequence');
      }

      const newLeaseUntil = new Date(row.lease_until.getTime() + params.extensionMs);
      await client.query(
        `UPDATE game_adjudications SET lease_until = $3 WHERE game_id = $1 AND operation_id = $2`,
        [grant.gameId, grant.operationId, newLeaseUntil],
      );

      await client.query('COMMIT');
      const { AdjudicationClaimGrant: GrantClass } = await import('./adjudication-types');
      return new GrantClass({
        gameId: grant.gameId,
        operationId: grant.operationId,
        claimId: grant.claimId,
        executorId: grant.executorId,
        generation: grant.generation,
        leaseUntil: newLeaseUntil,
        capability: grant.capabilityForQuery(),
      });
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    } finally {
      client.release();
    }
  }

  private async prepareSettlementOutsideLock(
    params: SettleAdjudicationParams,
  ): Promise<RetainedSettlement> {
    const existing = this.#seam.getRetainedSettlement(params.gameId, params.operationId);
    if (existing) {
      this.#seam.assertMatchingRetainedGrant(existing, params.grant);
      return existing;
    }

    const client = await this.pool.connect();
    let durableEvents: StoredEvent[];
    try {
      durableEvents = await loadDurableEvents(client, params.gameId);
    } finally {
      client.release();
    }

    if (durableEvents.length === 0) {
      throw new PersistenceError(`Game ${params.gameId} not found`);
    }
    const durableGame = Game.fromEvents(durableEvents.map((e) => e.event));
    if (durableGame.adjudication?.operationId !== params.operationId) {
      throw new AdjudicationConflictError('Durable game pending adjudication does not match settlement operation');
    }

    return this.#seam.evaluateSettlement(
      durableGame,
      params.operationId,
      params.resolutionAt,
      params.grant,
    );
  }

  async settleAdjudication(params: SettleAdjudicationParams): Promise<AdjudicationSettlementReceipt> {
    const retained = await this.prepareSettlementOutsideLock(params);
    const settlement = retained.settlement;
    const { grant } = params;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await acquireGameLockAndCheckIsolation(client, params.gameId);

      const row = await loadAdjudicationRow(client, params.gameId, params.operationId, true);
      if (!row) throw new PersistenceError(`Adjudication operation ${params.operationId} not found`);

      if (row.execution_state === 'completed') {
        assertIdenticalSettlementRetry(row, grant, settlement.batch);
        await client.query('COMMIT');
        return row.settlement_receipt!;
      }

      if (row.execution_state !== 'proving') {
        throw new AdjudicationConflictError(`Cannot settle adjudication in state "${row.execution_state}"`);
      }

      const hash = sha256(grant.capabilityForQuery());
      if (
        row.claim_id !== grant.claimId ||
        row.executor_id !== grant.executorId ||
        row.generation !== grant.generation ||
        !row.capability_hash ||
        !row.capability_hash.equals(hash)
      ) {
        throw new AdjudicationConflictError('Adjudication grant identity mismatch on settlement');
      }

      const curXact = (await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid;
      if (row.start_permit_xact_id === curXact) {
        throw new AdjudicationFenceError('Started event must commit before settlement in a subsequent transaction');
      }

      const timeRes = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const dbNow = timeRes.rows[0]!.now;
      if (!row.lease_until || row.lease_until <= dbNow) {
        throw new AdjudicationClaimExpiredError('Adjudication claim lease has expired prior to settlement');
      }

      const events = await loadDurableEvents(client, params.gameId);
      const head = events.at(-1)?.seq ?? -1;
      if (head !== row.started_seq) {
        throw new AdjudicationConflictError('Stream head does not match expected Started sequence');
      }

      const envelopes = settlement.batch.map((event) => ({
        type: event.type,
        event_version: CURRENT_EVENT_VERSION,
        payload: event,
      }));

      await client.query(
        `UPDATE game_adjudications SET
           settlement_permit_xact_id = pg_current_xact_id(),
           settlement_permit_claim_id = $3,
           settlement_permit_generation = $4,
           settlement_permit_start_seq = $5,
           settlement_permit_end_seq = $6,
           settlement_permit_envelopes = $7::jsonb,
           settlement_permit_cursor = 0
         WHERE game_id = $1 AND operation_id = $2`,
        [
          params.gameId,
          params.operationId,
          grant.claimId,
          BigInt(grant.generation).toString(),
          row.started_seq + 1,
          row.started_seq + settlement.batch.length,
          JSON.stringify(envelopes),
        ],
      );

      let seq = row.started_seq;
      for (const event of settlement.batch) {
        seq += 1;
        await client.query(
          `INSERT INTO game_events (game_id, seq, type, event_version, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [params.gameId, seq, event.type, CURRENT_EVENT_VERSION, JSON.stringify(event)],
        );
      }

      await client.query('DELETE FROM pregame_deadlines WHERE game_id = $1', [params.gameId]);
      await client.query('DELETE FROM flag_deadlines WHERE game_id = $1', [params.gameId]);

      const isStopped = settlement.resolved.clockCompletion?.kind === 'stopped';
      const isTerminal = settlement.resolved.clockCompletion?.kind === 'terminal' || settlement.batch.some((e) => e.type === 'GameEnded');

      if (isStopped || isTerminal) {
        await client.query(
          'UPDATE game_adjudications SET is_current_stop = false WHERE game_id = $1 AND is_current_stop = true',
          [params.gameId],
        );
      }

      const receipt: AdjudicationSettlementReceipt = Object.freeze({
        gameId: params.gameId,
        operationId: params.operationId,
        startedSeq: row.started_seq,
        finalSeq: seq,
        eventCount: settlement.batch.length,
        completedAt: dbNow.getTime(),
        resolvedEvent: settlement.resolved,
      });

      await client.query(
        `UPDATE game_adjudications SET
           execution_state = 'completed',
           final_seq = $3,
           settlement_batch = $4::jsonb,
           settlement_receipt = $5::jsonb,
           completed_at = clock_timestamp(),
           completed_generation = $6,
           completed_claim_id = $7,
           completed_executor_id = $8,
           completed_capability_hash = $9,
           stopped_clock = $10::jsonb,
           is_current_stop = $11
         WHERE game_id = $1 AND operation_id = $2`,
        [
          params.gameId,
          params.operationId,
          seq,
          JSON.stringify(settlement.batch),
          JSON.stringify(receipt),
          BigInt(grant.generation).toString(),
          grant.claimId,
          grant.executorId,
          hash,
          isStopped && settlement.game.stoppedClock ? JSON.stringify(settlement.game.stoppedClock) : null,
          isStopped,
        ],
      );

      const finalCheck = await client.query<{
        lease_until: Date;
        claim_id: string;
        executor_id: string;
        capability_hash: Buffer;
        now2: Date;
      }>(
        `SELECT lease_until, claim_id, executor_id, capability_hash, clock_timestamp() AS now2
         FROM game_adjudications WHERE game_id = $1 AND operation_id = $2`,
        [params.gameId, params.operationId],
      );
      const postRow = finalCheck.rows[0]!;
      if (
        postRow.claim_id !== grant.claimId ||
        postRow.executor_id !== grant.executorId ||
        !postRow.capability_hash.equals(hash) ||
        postRow.lease_until <= postRow.now2
      ) {
        throw new AdjudicationClaimExpiredError('Adjudication lease expired during settlement write execution');
      }

      await client.query('COMMIT');
      return receipt;
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async reconcileAdjudication(gameId: string, operationId: string): Promise<ReconcileAdjudicationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await acquireGameLockAndCheckIsolation(client, gameId);

      const timeRes = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const dbNow = timeRes.rows[0]!.now;

      const row = await loadAdjudicationRow(client, gameId, operationId);
      if (!row) {
        await client.query('COMMIT');
        return { status: 'absent' };
      }

      if (row.execution_state === 'completed' && row.settlement_receipt && row.final_seq !== null) {
        await client.query('COMMIT');
        return { status: 'completed', receipt: row.settlement_receipt, finalSeq: row.final_seq };
      }

      const isLive = row.lease_until !== null && row.lease_until > dbNow;
      await client.query('COMMIT');
      return {
        status: 'proving',
        generation: row.generation,
        leaseStatus: isLive ? 'live' : 'expired',
        claimId: row.claim_id,
        executorId: row.executor_id,
        leaseUntil: row.lease_until,
      };
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    } finally {
      client.release();
    }
  }
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
