/**
 * @packageDocumentation
 * Cohesive helpers for Stage M adjudication persistence (Issue #124).
 *
 * Implements:
 * - Advisory game locking and READ COMMITTED isolation verification.
 * - Route-specific domain admission and preparation (including ready no-op handling).
 * - Full domain-derived acceptance accounting derivation.
 * - Comprehensive retry equality assertions for Start and Settle.
 * - START and SETTLEMENT permit SQL execution.
 */

import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import {
  Game,
  GameError,
  prepareAbort,
  prepareAuthoritativeCommand,
  prepareCreationAdmission,
  prepareDrawAccept,
  prepareDrawDecline,
  prepareDrawOffer,
  prepareFlagExpiry,
  prepareMove,
  prepareNoShowExpiry,
  prepareReady,
  prepareResign,
  type AdjudicationStartedEvent,
  type PreparedOperation,
} from '@chess-platform/game';
import { CURRENT_EVENT_VERSION, upcast, type StoredEvent } from '../event-store';
import {
  AdjudicationConflictError,
  AdjudicationFenceError,
} from '../errors';
import {
  sha256,
  type AcceptanceAccounting,
  type AdjudicationClaimGrant,
  type AdjudicationDbRow,
  type StartAdjudicationParams,
} from './adjudication-types';

export async function acquireGameLockAndCheckIsolation(client: PoolClient, gameId: string): Promise<void> {
  const isoRes = await client.query<{ transaction_isolation: string }>(
    "SELECT current_setting('transaction_isolation') AS transaction_isolation",
  );
  if (isoRes.rows[0]?.transaction_isolation !== 'read committed') {
    throw new AdjudicationFenceError('READ COMMITTED transaction isolation required');
  }
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('rocky:game-adjudication:' || $1::text, 0))`,
    [gameId],
  );
}

export async function loadAdjudicationRow(
  client: PoolClient,
  gameId: string,
  operationId: string,
  forUpdate = false,
): Promise<AdjudicationDbRow | null> {
  const sql = `SELECT * FROM game_adjudications WHERE game_id = $1 AND operation_id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`;
  const res = await client.query<AdjudicationDbRow>(sql, [gameId, operationId]);
  return res.rows[0] ?? null;
}

export async function loadDurableEvents(client: PoolClient, gameId: string): Promise<StoredEvent[]> {
  const res = await client.query<{
    game_id: string;
    seq: number;
    type: string;
    event_version: number;
    payload: unknown;
    server_ts: Date;
  }>(
    `SELECT game_id, seq, type, event_version, payload, server_ts
     FROM game_events WHERE game_id = $1 ORDER BY seq ASC`,
    [gameId],
  );
  return res.rows.map((row) => ({
    gameId: row.game_id,
    seq: Number(row.seq),
    version: Number(row.event_version),
    event: upcast(row.type, Number(row.event_version), row.payload),
    serverTs: row.server_ts.getTime(),
  }));
}

function deriveCanonicalNonMovePrepared(
  game: Game,
  p: PreparedOperation,
): { kind: 'noop'; reason: string } | { kind: 'prepared'; operation: PreparedOperation } {
  const i = p.intent;
  if (i.kind === 'creationAdmission') {
    return { kind: 'prepared', operation: prepareCreationAdmission(game, { operationId: p.operationId, rulesVersion: p.rulesVersion, at: p.at, clockPolicy: p.clockPolicy }) };
  }
  if (i.kind === 'ready') {
    const res = prepareReady(game, { color: i.color, at: p.at, operationId: p.operationId, rulesVersion: p.rulesVersion, clockPolicy: p.clockPolicy });
    if (res.kind === 'noop') return { kind: 'noop', reason: res.reason };
    return { kind: 'prepared', operation: res };
  }
  if (i.kind === 'resign') {
    return { kind: 'prepared', operation: prepareResign(game, { color: i.color, at: p.at, operationId: p.operationId, rulesVersion: p.rulesVersion, clockPolicy: p.clockPolicy }) };
  }
  if (i.kind === 'offerDraw') {
    return { kind: 'prepared', operation: prepareDrawOffer(game, { color: i.color, at: p.at, operationId: p.operationId, rulesVersion: p.rulesVersion, clockPolicy: p.clockPolicy }) };
  }
  if (i.kind === 'acceptDraw') {
    return { kind: 'prepared', operation: prepareDrawAccept(game, { color: i.color, at: p.at, operationId: p.operationId, rulesVersion: p.rulesVersion, clockPolicy: p.clockPolicy }) };
  }
  if (i.kind === 'declineDraw') {
    return { kind: 'prepared', operation: prepareDrawDecline(game, { color: i.color, at: p.at, operationId: p.operationId, rulesVersion: p.rulesVersion, clockPolicy: p.clockPolicy }) };
  }
  if (i.kind === 'abort') {
    return { kind: 'prepared', operation: prepareAbort(game, { color: i.color, at: p.at, operationId: p.operationId, rulesVersion: p.rulesVersion, clockPolicy: p.clockPolicy }) };
  }
  if (i.kind === 'expireFlag') {
    return { kind: 'prepared', operation: prepareFlagExpiry(game, { flagged: i.flagged, at: p.at, operationId: p.operationId, rulesVersion: p.rulesVersion, clockPolicy: p.clockPolicy }) };
  }
  if (i.kind === 'expireNoShow') {
    return { kind: 'prepared', operation: prepareNoShowExpiry(game, { at: p.at, operationId: p.operationId, rulesVersion: p.rulesVersion, clockPolicy: p.clockPolicy }) };
  }
  throw new GameError(`Unknown prepared intent kind`);
}

function deriveCanonicalPrepared(
  game: Game,
  p: PreparedOperation,
): { kind: 'noop'; reason: string } | { kind: 'prepared'; operation: PreparedOperation } {
  if (p.intent.kind === 'move') {
    const op = prepareMove(game, {
      uci: p.intent.uci,
      at: p.at,
      operationId: p.operationId,
      rulesVersion: p.rulesVersion,
      clockPolicy: p.clockPolicy,
    });
    return { kind: 'prepared', operation: op };
  }
  return deriveCanonicalNonMovePrepared(game, p);
}

export function resolveAdmissionPrepared(
  game: Game,
  params: StartAdjudicationParams,
): { kind: 'noop'; reason: string } | { kind: 'prepared'; operation: PreparedOperation } {
  if (params.prepared) {
    if (game.isBlocked) throw new GameError('Game adjudication is currently pending');
    if (params.prepared.gameId !== game.id) throw new GameError('Prepared gameId mismatch');
    if (params.prepared.baseRevision !== game.eventSequence) throw new GameError('Prepared baseRevision mismatch');
    const canon = deriveCanonicalPrepared(game, params.prepared);
    if (canon.kind === 'noop') {
      return { kind: 'noop', reason: canon.reason };
    }
    if (!isDeepStrictEqual(params.prepared, canon.operation)) {
      throw new AdjudicationConflictError('Prepared operation diverges from authoritative domain derivation');
    }
    return { kind: 'prepared', operation: canon.operation };
  }

  const adm = prepareAuthoritativeCommand(game, params.command, params.context);
  if (adm.kind === 'noop') {
    return { kind: 'noop', reason: adm.reason };
  }
  return { kind: 'prepared', operation: adm.operation };
}

export function deriveAcceptanceAccounting(
  durableEvents: readonly StoredEvent[],
  startedEvent: AdjudicationStartedEvent,
): AcceptanceAccounting {
  const foldEvents = [...durableEvents.map((e) => e.event), startedEvent];
  const afterStarted = Game.fromEvents(foldEvents);
  const pending = afterStarted.adjudication;
  if (!pending) {
    throw new GameError('Failed to derive domain pending adjudication state');
  }
  return Object.freeze({
    originalClock: pending.originalClock,
    thinkingElapsedAtA: pending.thinkingElapsedAtA,
    originalNoShowAt: pending.originalNoShowAt,
    remainingNoShowTimeAtA: pending.remainingNoShowTimeAtA,
    originalBasis: pending.originalBasis ?? null,
  });
}

export function normalizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertIdenticalStartMetadata(row: AdjudicationDbRow, prepared: PreparedOperation): void {
  if (row.game_id !== prepared.gameId) {
    throw new AdjudicationConflictError('Start retry gameId mismatch');
  }
  if (row.operation_id !== prepared.operationId) {
    throw new AdjudicationConflictError('Start retry operationId mismatch');
  }
  if (row.base_revision !== prepared.baseRevision) {
    throw new AdjudicationConflictError('Start retry baseRevision mismatch');
  }
  if (row.started_seq !== prepared.baseRevision + 1) {
    throw new AdjudicationConflictError('Start retry startedSeq mismatch');
  }
  if (row.rules_version !== prepared.rulesVersion) {
    throw new AdjudicationConflictError('Start retry rulesVersion mismatch');
  }
  if ((row.clock_policy ?? undefined) !== (prepared.clockPolicy ?? undefined)) {
    throw new AdjudicationConflictError('Start retry clockPolicy mismatch');
  }
  if (!isDeepStrictEqual(normalizeJson(row.prepared), normalizeJson(prepared))) {
    throw new AdjudicationConflictError('Start retry prepared operation envelope mismatch');
  }
}

function assertIdenticalStartedEnvelope(
  row: AdjudicationDbRow,
  started: AdjudicationStartedEvent,
): void {
  if (row.started_type !== started.type) {
    throw new AdjudicationConflictError('Start retry started_type mismatch');
  }
  if (row.started_version !== CURRENT_EVENT_VERSION) {
    throw new AdjudicationConflictError('Start retry started_version mismatch');
  }
  if (!isDeepStrictEqual(normalizeJson(row.started_payload), normalizeJson(started))) {
    throw new AdjudicationConflictError('Start retry started_payload mismatch');
  }
}

function assertIdenticalStartAccounting(row: AdjudicationDbRow, acct: AcceptanceAccounting): void {
  if (!isDeepStrictEqual(normalizeJson(row.original_clock), normalizeJson(acct.originalClock))) {
    throw new AdjudicationConflictError('Start retry originalClock mismatch');
  }
  if (BigInt(row.thinking_elapsed_at_a) !== BigInt(acct.thinkingElapsedAtA)) {
    throw new AdjudicationConflictError('Start retry thinkingElapsedAtA mismatch');
  }
  const rowNoShow = row.original_no_show_at !== null ? row.original_no_show_at.toString() : null;
  const acctNoShow = acct.originalNoShowAt !== null ? acct.originalNoShowAt.toString() : null;
  if (rowNoShow !== acctNoShow) {
    throw new AdjudicationConflictError('Start retry originalNoShowAt mismatch');
  }
  const rowRem = row.remaining_no_show_time_at_a !== null ? row.remaining_no_show_time_at_a.toString() : null;
  const acctRem = acct.remainingNoShowTimeAtA !== null ? acct.remainingNoShowTimeAtA.toString() : null;
  if (rowRem !== acctRem) {
    throw new AdjudicationConflictError('Start retry remainingNoShowTimeAtA mismatch');
  }
  if (!isDeepStrictEqual(normalizeJson(row.original_basis), normalizeJson(acct.originalBasis))) {
    throw new AdjudicationConflictError('Start retry originalBasis mismatch');
  }
}

export function assertIdenticalStartRetry(
  row: AdjudicationDbRow,
  prepared: PreparedOperation,
  acct: AcceptanceAccounting,
  candidateStarted?: AdjudicationStartedEvent,
): void {
  assertIdenticalStartMetadata(row, prepared);
  const started = candidateStarted ?? {
    type: 'AdjudicationStarted',
    gameId: prepared.gameId,
    operationId: prepared.operationId,
    baseRevision: prepared.baseRevision,
    at: prepared.at,
    rulesVersion: prepared.rulesVersion,
    prepared,
    ...(prepared.clockPolicy ? { clockPolicy: prepared.clockPolicy } : {}),
  };
  assertIdenticalStartedEnvelope(row, started);
  assertIdenticalStartAccounting(row, acct);
}

export function assertIdenticalSettlementRetry(
  row: AdjudicationDbRow,
  grant: AdjudicationClaimGrant,
  expectedBatch: readonly unknown[],
): void {
  const hash = sha256(grant.capabilityForQuery());
  if (
    row.completed_claim_id !== grant.claimId ||
    row.completed_executor_id !== grant.executorId ||
    row.completed_generation !== grant.generation ||
    !row.completed_capability_hash ||
    !row.completed_capability_hash.equals(hash)
  ) {
    throw new AdjudicationConflictError('Settlement credentials do not match completed adjudication');
  }
  if (!row.settlement_receipt) {
    throw new AdjudicationConflictError('Completed adjudication missing receipt');
  }
  if (!isDeepStrictEqual(row.settlement_batch, expectedBatch)) {
    throw new AdjudicationConflictError('Settlement batch conflicts with completed adjudication');
  }
}

export async function executeAtomicStart(
  client: PoolClient,
  gameId: string,
  startedEvent: AdjudicationStartedEvent,
  acct: AcceptanceAccounting,
): Promise<number> {
  const sql = 'SELECT adjudication_start_atomic($1, $2::jsonb, $3::jsonb) AS started_seq';
  const res = await client.query<{ started_seq: number }>(sql, [
    gameId,
    JSON.stringify(startedEvent),
    JSON.stringify(acct),
  ]);
  return res.rows[0]!.started_seq;
}

export async function insertStartedAdjudicationRow(
  client: PoolClient,
  gameId: string,
  startedEvent: AdjudicationStartedEvent,
  acct: AcceptanceAccounting,
): Promise<void> {
  await executeAtomicStart(client, gameId, startedEvent, acct);
}
