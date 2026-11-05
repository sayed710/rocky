/**
 * @packageDocumentation
 * Types, interfaces, and grant identities for adjudication persistence (Stage M, Issue #124).
 */

import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import type {
  AdjudicationClockBasis,
  AdjudicationClockPolicy,
  AdjudicationResolvedEvent,
  AuthoritativeCommandContext,
  AuthoritativePlayerCommand,
  ClockState,
  GameStoppedClockState,
  PreparedOperation,
  SettlementResult,
} from '@chess-platform/game';
import {
  AdjudicationConflictError,
} from '../errors';

export const MAX_BIGINT = 9223372036854775807n;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function isValidUuid(id: string): boolean {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

export function validateLeaseMs(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 3_600_000) {
    throw new RangeError(`leaseMs must be a positive safe integer <= 3600000, got ${String(leaseMs)}`);
  }
}

export function validateGenerationString(gen: string): bigint {
  if (typeof gen !== 'string' || !/^(0|[1-9][0-9]*)$/.test(gen)) {
    throw new AdjudicationConflictError(`Invalid generation string "${gen}"`);
  }
  const val = BigInt(gen);
  if (val > MAX_BIGINT) {
    throw new RangeError(`generation overflow: ${gen}`);
  }
  return val;
}

function assertValidGrantUuids(init: AdjudicationClaimGrantInit): void {
  if (!isValidUuid(init.gameId)) {
    throw new AdjudicationConflictError('Invalid UUID in claim grant identity');
  }
  if (!isValidUuid(init.operationId)) {
    throw new AdjudicationConflictError('Invalid UUID in claim grant identity');
  }
  if (!isValidUuid(init.claimId)) {
    throw new AdjudicationConflictError('Invalid UUID in claim grant identity');
  }
  if (!isValidUuid(init.executorId)) {
    throw new AdjudicationConflictError('Invalid UUID in claim grant identity');
  }
}

function assertValidGrantCapability(capability: Buffer): void {
  if (!Buffer.isBuffer(capability)) {
    throw new AdjudicationConflictError('Claim capability must be a Buffer');
  }
  if (capability.length !== 32) {
    throw new AdjudicationConflictError('Claim capability must be exactly 32 bytes');
  }
}

export interface AdjudicationClaimGrantInit {
  readonly gameId: string;
  readonly operationId: string;
  readonly claimId: string;
  readonly executorId: string;
  readonly generation: string;
  readonly leaseUntil: Date;
  readonly capability: Buffer;
}

/** Immutable grant identity. Capability is a private Buffer never serialized or logged. */
export class AdjudicationClaimGrant {
  readonly gameId: string;
  readonly operationId: string;
  readonly claimId: string;
  readonly executorId: string;
  readonly generation: string;
  readonly leaseUntil: Date;
  readonly #capability: Buffer;

  constructor(init: AdjudicationClaimGrantInit) {
    assertValidGrantUuids(init);
    assertValidGrantCapability(init.capability);
    validateGenerationString(init.generation);

    this.gameId = init.gameId;
    this.operationId = init.operationId;
    this.claimId = init.claimId;
    this.executorId = init.executorId;
    this.generation = init.generation;
    this.leaseUntil = new Date(init.leaseUntil.getTime());
    this.#capability = Buffer.from(init.capability);
    Object.freeze(this);
  }

  capabilityForQuery(): Buffer {
    return Buffer.from(this.#capability);
  }

  toJSON(): object {
    return {
      gameId: this.gameId,
      operationId: this.operationId,
      claimId: this.claimId,
      executorId: this.executorId,
      generation: this.generation,
      leaseUntil: this.leaseUntil.toISOString(),
      capability: '[REDACTED]',
    };
  }

  [inspect.custom](): object {
    return this.toJSON();
  }
}

/** Immutable settlement receipt returned upon successful adjudication settlement. */
export interface AdjudicationSettlementReceipt {
  readonly gameId: string;
  readonly operationId: string;
  readonly startedSeq: number;
  readonly finalSeq: number;
  readonly eventCount: number;
  readonly completedAt: number;
  readonly resolvedEvent: AdjudicationResolvedEvent;
}

export type StartAdjudicationParams =
  | {
      readonly gameId: string;
      readonly command: AuthoritativePlayerCommand;
      readonly context: AuthoritativeCommandContext;
      readonly prepared?: undefined;
    }
  | {
      readonly gameId: string;
      readonly prepared: PreparedOperation;
      readonly command?: undefined;
      readonly context?: undefined;
    };

export type StartAdjudicationResult =
  | { readonly status: 'noop'; readonly reason: string }
  | { readonly status: 'started'; readonly operationId: string; readonly startedSeq: number; readonly prepared: PreparedOperation }
  | { readonly status: 'proving'; readonly operationId: string; readonly startedSeq: number; readonly prepared: PreparedOperation }
  | { readonly status: 'completed'; readonly operationId: string; readonly receipt: AdjudicationSettlementReceipt };

export interface ClaimIntent {
  readonly claimId: string;
  readonly capability: Buffer;
}

export interface ClaimAdjudicationParams {
  readonly gameId: string;
  readonly operationId: string;
  readonly executorId: string;
  readonly expectedGeneration: string;
  readonly leaseMs: number;
  /** From `PgAdjudicationStore.newClaimIntent()`; reuse it to recover a claim whose reply was lost. */
  readonly intent: ClaimIntent;
}

export interface RenewAdjudicationParams {
  readonly grant: AdjudicationClaimGrant;
  readonly extensionMs: number;
}

export interface SettleAdjudicationParams {
  readonly gameId: string;
  readonly operationId: string;
  readonly grant: AdjudicationClaimGrant;
  readonly resolutionAt: number;
}

export type ReconcileAdjudicationResult =
  | { readonly status: 'absent' }
  | {
      readonly status: 'proving';
      readonly generation: string;
      readonly leaseStatus: 'live' | 'expired';
      readonly claimId: string | null;
      readonly executorId: string | null;
      readonly leaseUntil: Date | null;
    }
  | {
      readonly status: 'completed';
      readonly receipt: AdjudicationSettlementReceipt;
      readonly finalSeq: number;
    };

export interface AdjudicationDbRow {
  game_id: string;
  operation_id: string;
  base_revision: number;
  started_seq: number;
  started_type: string;
  started_version: number;
  started_payload: unknown;
  prepared: PreparedOperation;
  accepted_at: string;
  rules_version: string;
  clock_policy: AdjudicationClockPolicy | null;
  original_clock: ClockState;
  thinking_elapsed_at_a: string;
  original_no_show_at: string | null;
  remaining_no_show_time_at_a: string | null;
  original_basis: AdjudicationClockBasis | null;
  execution_state: 'proving' | 'settling' | 'completed';
  generation: string;
  claim_id: string | null;
  executor_id: string | null;
  capability_hash: Buffer | null;
  lease_until: Date | null;
  start_permit_xact_id: string;
  start_permit_consumed: boolean;
  settlement_batch: unknown[] | null;
  settlement_receipt: AdjudicationSettlementReceipt | null;
  final_seq: number | null;
  stopped_clock: GameStoppedClockState | null;
  is_current_stop: boolean;
  completed_generation: string | null;
  completed_claim_id: string | null;
  completed_executor_id: string | null;
  completed_capability_hash: Buffer | null;
}

/**
 * A settlement evaluated outside every transaction, kept so a retry (rolled back, expired claim
 * replaced by a successor, or lost COMMIT reply) never re-runs a consumed proof job. It is bound to
 * the operation and resolution instant, not to a claim: claim authority is checked in the database.
 */
export interface RetainedSettlement {
  readonly gameId: string;
  readonly operationId: string;
  readonly settlement: SettlementResult;
  readonly resolutionAt: number;
}

export interface AcceptanceAccounting {
  readonly originalClock: ClockState;
  readonly thinkingElapsedAtA: number;
  readonly originalNoShowAt: number | null;
  readonly remainingNoShowTimeAtA: number | null;
  readonly originalBasis: AdjudicationClockBasis | null;
}
