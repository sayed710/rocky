/**
 * @packageDocumentation
 * Statement-level steps of the adjudication store (Issue #124, ADR 0174). Every function here runs
 * on a client already inside a READ COMMITTED transaction that holds the game's adjudication fence,
 * and never evaluates proof work. The database (migration 0053) re-checks every rule it can see;
 * these checks exist to give callers typed errors before a statement is refused.
 */

import type { PoolClient } from 'pg';
import type { SettlementResult } from '@chess-platform/game';
import { CURRENT_EVENT_VERSION } from '../event-store';
import { AdjudicationClaimExpiredError, AdjudicationConflictError, PersistenceError } from '../errors';
import {
  AdjudicationClaimGrant,
  MAX_BIGINT,
  isValidUuid,
  sha256,
  validateLeaseMs,
  type AdjudicationDbRow,
  type AdjudicationSettlementReceipt,
  type ClaimAdjudicationParams,
  type SettleAdjudicationParams,
} from './adjudication-types';
import { loadAdjudicationRow } from './adjudication-helpers';

/** Database time, read after the fence was acquired so a wait cannot make it stale. */
export async function databaseNow(client: PoolClient): Promise<Date> {
  return (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
}

async function streamHead(client: PoolClient, gameId: string): Promise<number | null> {
  return (await client.query<{ head: number | null }>(
    'SELECT max(seq) AS head FROM game_events WHERE game_id = $1',
    [gameId],
  )).rows[0]!.head;
}

/** The locked row of an operation that is still proving with nothing after its Started event. */
export async function loadProvingRowAtHead(
  client: PoolClient,
  gameId: string,
  operationId: string,
): Promise<AdjudicationDbRow> {
  const row = await loadAdjudicationRow(client, gameId, operationId, true);
  if (!row) throw new PersistenceError(`Adjudication operation ${operationId} not found`);
  if (row.execution_state !== 'proving') {
    throw new AdjudicationConflictError(`Adjudication is ${row.execution_state}, not proving`);
  }
  if ((await streamHead(client, gameId)) !== row.started_seq) {
    throw new AdjudicationConflictError('Stream head does not match the Started sequence');
  }
  return row;
}

/** Shape checks on a claim request, before any connection is taken. */
export function assertClaimRequest(params: ClaimAdjudicationParams): void {
  validateLeaseMs(params.leaseMs);
  const { intent } = params;
  const validIntent = intent !== undefined && isValidUuid(intent.claimId)
    && Buffer.isBuffer(intent.capability) && intent.capability.length === 32;
  if (!validIntent) {
    throw new AdjudicationConflictError('A claim requires an intent from PgAdjudicationStore.newClaimIntent()');
  }
  if (!isValidUuid(params.executorId)) {
    throw new AdjudicationConflictError('Invalid executor id');
  }
}

function grantFor(params: ClaimAdjudicationParams, generation: string, leaseUntil: Date): AdjudicationClaimGrant {
  return new AdjudicationClaimGrant({
    gameId: params.gameId,
    operationId: params.operationId,
    claimId: params.intent.claimId,
    executorId: params.executorId,
    generation,
    leaseUntil,
    capability: params.intent.capability,
  });
}

function rowHoldsIntent(row: AdjudicationDbRow, params: ClaimAdjudicationParams): boolean {
  return row.claim_id === params.intent.claimId
    && row.executor_id === params.executorId
    && row.capability_hash !== null
    && row.capability_hash.equals(sha256(params.intent.capability));
}

/**
 * The grant this exact intent already holds (a retry after a lost reply), or null when the request
 * may take the claim. Anything else is a conflict: a stale expected generation, or a live lease
 * held by another intent.
 */
export function recoverClaim(
  row: AdjudicationDbRow,
  params: ClaimAdjudicationParams,
  now: Date,
): AdjudicationClaimGrant | null {
  const live = row.lease_until !== null && row.lease_until > now;
  if (rowHoldsIntent(row, params)) {
    if (!live) throw new AdjudicationClaimExpiredError('This claim committed but its lease has expired');
    return grantFor(params, row.generation, row.lease_until!);
  }
  if (row.generation !== params.expectedGeneration) {
    throw new AdjudicationConflictError(`Generation mismatch: expected ${params.expectedGeneration}, actual ${row.generation}`);
  }
  if (live) throw new AdjudicationConflictError('A live lease is held by another claim');
  return null;
}

/** Take the claim with a strictly greater generation and a lease measured from database time. */
export async function writeClaim(
  client: PoolClient,
  row: AdjudicationDbRow,
  params: ClaimAdjudicationParams,
  now: Date,
): Promise<AdjudicationClaimGrant> {
  const next = BigInt(row.generation) + 1n;
  if (next > MAX_BIGINT) throw new RangeError('generation overflow');
  const leaseUntil = new Date(now.getTime() + params.leaseMs);
  await client.query(
    `UPDATE game_adjudications
     SET generation = $3, claim_id = $4, executor_id = $5, capability_hash = $6, lease_until = $7
     WHERE game_id = $1 AND operation_id = $2`,
    [params.gameId, params.operationId, next.toString(), params.intent.claimId, params.executorId,
      sha256(params.intent.capability), leaseUntil],
  );
  return grantFor(params, next.toString(), leaseUntil);
}

/** The grant is the row's current claim and its lease is still live at database `now`. */
export function assertLiveGrant(row: AdjudicationDbRow, grant: AdjudicationClaimGrant, now: Date): void {
  const sameClaim = row.claim_id === grant.claimId
    && row.executor_id === grant.executorId
    && row.generation === grant.generation
    && row.capability_hash !== null
    && row.capability_hash.equals(sha256(grant.capabilityForQuery()));
  if (!sameClaim) throw new AdjudicationConflictError('The grant is not the current claim of this operation');
  if (row.lease_until === null || row.lease_until <= now) {
    throw new AdjudicationClaimExpiredError('The claim lease has expired');
  }
}

/** Open the SETTLEMENT permit and append the batch; the database consumes it event by event. */
async function appendSettlementBatch(
  client: PoolClient,
  params: SettleAdjudicationParams,
  row: AdjudicationDbRow,
  settlement: SettlementResult,
): Promise<number> {
  const envelopes = settlement.batch.map((payload) => ({ type: payload.type, event_version: CURRENT_EVENT_VERSION, payload }));
  const finalSeq = row.started_seq + settlement.batch.length;
  await client.query(
    `UPDATE game_adjudications SET
       settlement_permit_xact_id = pg_current_xact_id(), settlement_permit_claim_id = $3,
       settlement_permit_generation = $4, settlement_permit_start_seq = $5, settlement_permit_end_seq = $6,
       settlement_permit_envelopes = $7::jsonb, settlement_permit_cursor = 0
     WHERE game_id = $1 AND operation_id = $2`,
    [params.gameId, params.operationId, params.grant.claimId, params.grant.generation,
      row.started_seq + 1, finalSeq, JSON.stringify(envelopes)],
  );
  let seq = row.started_seq;
  for (const event of settlement.batch) {
    seq += 1;
    await client.query(
      'INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [params.gameId, seq, event.type, CURRENT_EVENT_VERSION, JSON.stringify(event)],
    );
  }
  return finalSeq;
}

/**
 * Mark the operation completed. A stopped completion becomes the one current stop; a stop or an
 * ending supersedes an earlier stop. Completing a running game restores its queues (trigger), and
 * the row guard re-checks the claim is still live at this instant.
 */
async function completeOperation(
  client: PoolClient,
  receipt: AdjudicationSettlementReceipt,
  settlement: SettlementResult,
): Promise<void> {
  const stopped = settlement.resolved.clockCompletion?.kind === 'stopped';
  if (stopped && !settlement.game.stoppedClock) {
    throw new AdjudicationConflictError('Stopped completion without a stopped clock state');
  }
  if (stopped || settlement.batch.some((e) => e.type === 'GameEnded')) {
    await client.query('UPDATE game_adjudications SET is_current_stop = false WHERE game_id = $1 AND is_current_stop', [receipt.gameId]);
  }
  await client.query(
    `UPDATE game_adjudications SET
       execution_state = 'completed', final_seq = $3, settlement_batch = $4::jsonb, settlement_receipt = $5::jsonb,
       completed_at = clock_timestamp(), completed_generation = generation, completed_claim_id = claim_id,
       completed_executor_id = executor_id, completed_capability_hash = capability_hash,
       stopped_clock = $6::jsonb, is_current_stop = $7
     WHERE game_id = $1 AND operation_id = $2`,
    [receipt.gameId, receipt.operationId, receipt.finalSeq, JSON.stringify(settlement.batch), JSON.stringify(receipt),
      stopped ? JSON.stringify(settlement.game.stoppedClock) : null, stopped],
  );
}

/** Append and complete a proving operation with the caller's live claim. */
export async function writeSettlement(
  client: PoolClient,
  params: SettleAdjudicationParams,
  row: AdjudicationDbRow,
  settlement: SettlementResult,
): Promise<AdjudicationSettlementReceipt> {
  const now = await databaseNow(client);
  assertLiveGrant(row, params.grant, now);
  const finalSeq = await appendSettlementBatch(client, params, row, settlement);
  const receipt: AdjudicationSettlementReceipt = Object.freeze({
    gameId: params.gameId,
    operationId: params.operationId,
    startedSeq: row.started_seq,
    finalSeq,
    eventCount: settlement.batch.length,
    completedAt: now.getTime(),
    resolvedEvent: settlement.resolved,
  });
  await completeOperation(client, receipt, settlement);
  return receipt;
}
