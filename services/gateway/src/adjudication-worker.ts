/**
 * @packageDocumentation
 * Durable adjudication worker (Issue #124, ADR-0175).
 *
 * An accepted adjudication is a durable obligation (`game_adjudications`, ADR-0174): the command is
 * suspended behind `AdjudicationStarted` until a proof settles it. This worker is the executor. Each
 * pass it
 *
 * 1. reads proving operations nobody holds a live lease on and claims each (one claim intent per
 *    attempt, reused once when the reply is uncertain, so a lost reply recovers the committed lease);
 * 2. runs the proof in bounded slices outside every transaction, yielding between slices and renewing
 *    the lease before it can lapse; a proof that exhausts its resource limit settles as unresolved,
 *    which never declares a dead position;
 * 3. settles with the claim, at the instant a retained evaluation already fixed or else now, retrying
 *    an uncertain settlement with the same grant;
 * 4. releases every current stop whose settlement is published (observed-release-v1), with a request
 *    id derived from the stop so racing or retried releases collapse into one.
 *
 * Correctness lives in the database fence and the store, never here: two workers on two replicas may
 * race for one operation and only the live claim can settle; a worker that dies mid-proof leaves an
 * expired lease the next pass reclaims at a higher generation. Nothing constructs this worker unless
 * the operator enables adjudication (off by default; rollout is on HOLD in Issue #124).
 */

import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { JobStepResult } from '@chess-platform/game';
import { ADJUDICATION_ACTOR } from '@chess-platform/realtime-gateway';
import type { Counter, Logger } from '@chess-platform/api';
import {
  AdjudicationConflictError,
  PgAdjudicationStore,
  type AdjudicationClaimGrant,
  type AdjudicationReleaseReceipt,
  type AdjudicationSettlementReceipt,
  type ClaimAdjudicationParams,
  type ClaimIntent,
  type RenewAdjudicationParams,
  type SettleAdjudicationParams,
} from '@chess-platform/persistence/pg';
import { routedExpiry, type RoutedExpiryOptions } from './deadline-expiry.js';

/** Exactly what the worker uses of `PgAdjudicationStore`. */
export interface AdjudicationWorkStore {
  listClaimableAdjudications(limit: number): Promise<Array<{ gameId: string; operationId: string; generation: string }>>;
  listReleasableStops(limit: number, minAgeMs: number, excludeGameIds: readonly string[]): Promise<Array<{ gameId: string; stopOperationId: string }>>;
  claimAdjudication(params: ClaimAdjudicationParams): Promise<AdjudicationClaimGrant>;
  renewAdjudication(params: RenewAdjudicationParams): Promise<AdjudicationClaimGrant>;
  createProofJob(gameId: string, operationId: string): Promise<string>;
  stepProofJob(operationId: string, totalWorkBudget: number): JobStepResult;
  concludeUnresolvedProofJob(operationId: string): JobStepResult;
  retainedResolutionAt(gameId: string, operationId: string): number | undefined;
  settleAdjudication(params: SettleAdjudicationParams): Promise<AdjudicationSettlementReceipt>;
  cancelProofJob(operationId: string): void;
  evictProofJob(operationId: string): boolean;
  releaseClocks(params: { gameId: string; releaseRequestId: string; at: number }): Promise<AdjudicationReleaseReceipt>;
}

/** What changed in a game's durable log, so the owner can reload and publish it. */
export type AdjudicationChange =
  | { readonly kind: 'settled'; readonly gameId: string; readonly receipt: AdjudicationSettlementReceipt }
  | { readonly kind: 'released'; readonly gameId: string; readonly receipt: AdjudicationReleaseReceipt };

export interface AdjudicationWorkerOptions {
  readonly store: AdjudicationWorkStore;
  /** This process's executor identity (a UUID), recorded with every claim it takes. */
  readonly executorId: string;
  /**
   * Notify the game's owner of a durable change, so it folds the log into its copy and broadcasts
   * promptly. A failed notice is retried every pass while this process runs, and a stop is not
   * released while its game has one outstanding. Delivery does not depend on it: an owner whose copy
   * shows a game proving or stopped re-reads the log on its own (ADR-0176).
   */
  readonly publish: (change: AdjudicationChange) => Promise<void>;
  /** Lease length per claim and renewal (default 30 s). */
  readonly leaseMs?: number;
  /** Proof work per slice; the loop yields to other work between slices (default 2 000). */
  readonly sliceBudget?: number;
  /** Delay between passes once nothing more is waiting (default 250 ms). */
  readonly pollMs?: number;
  /** Operations and stops read per pass (default 20). */
  readonly pageSize?: number;
  /** Ceiling for the delay after consecutive failed passes (default 30 s). */
  readonly maxBackoffMs?: number;
  /**
   * A stop is released only once its settlement is this old (default 1 s), so the replica that
   * settled it publishes first even when another replica's worker sees it.
   */
  readonly releaseGraceMs?: number;

  readonly newIntent?: () => ClaimIntent;
  readonly now?: () => number;
  readonly logger?: Logger;
  readonly settledCounter?: Counter;
  readonly releasedCounter?: Counter;
  readonly failuresCounter?: Counter;
}

export interface AdjudicationPass {
  readonly settled: number;
  readonly released: number;
  readonly skipped: number;
  readonly failed: number;
  /** A page was full, so more work is probably waiting. */
  readonly more: boolean;
}

/** The release request id for a stop: one per stop, so every racing or retried release is the same. */
export function stopReleaseRequestId(stopOperationId: string): string {
  return `stop:${stopOperationId}`;
}

export class AdjudicationWorker {
  readonly #store: AdjudicationWorkStore;
  readonly #leaseMs: number;
  readonly #sliceBudget: number;
  readonly #pollMs: number;
  readonly #pageSize: number;
  readonly #maxBackoffMs: number;
  readonly #newIntent: () => ClaimIntent;
  readonly #now: () => number;
  #stopped = true;
  /** Set by stop(): a proof in progress returns at its next slice. */
  #halting = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #consecutiveErrors = 0;
  readonly #releaseGraceMs: number;
  /** Publications that failed, by game; retried every pass. Only the latest per game matters. */
  readonly #unpublished = new Map<string, AdjudicationChange>();

  constructor(private readonly options: AdjudicationWorkerOptions) {
    this.#store = options.store;
    this.#leaseMs = positive(options.leaseMs ?? 30_000, 'leaseMs');
    this.#sliceBudget = positive(options.sliceBudget ?? 2_000, 'sliceBudget');
    this.#pollMs = positive(options.pollMs ?? 250, 'pollMs');
    this.#pageSize = positive(options.pageSize ?? 20, 'pageSize');
    this.#maxBackoffMs = positive(options.maxBackoffMs ?? 30_000, 'maxBackoffMs');
    this.#newIntent = options.newIntent ?? (() => PgAdjudicationStore.newClaimIntent());
    this.#now = options.now ?? (() => Date.now());
    this.#releaseGraceMs = nonnegative(options.releaseGraceMs ?? 1_000, 'releaseGraceMs');
  }

  /** Games with a publication still outstanding (for observability and tests). */
  get unpublishedCount(): number {
    return this.#unpublished.size;
  }

  /** Start passing at once, so work left by a process that stopped resumes immediately. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#halting = false;
    this.#schedule(0);
  }

  /** Stop scheduling and wait for an in-flight pass. A proof in progress stops at its next slice. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#halting = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  /** One bounded pass: settle what is claimable, then release what is published and stopped. */
  async runPass(): Promise<AdjudicationPass> {
    let settled = 0;
    let released = 0;
    let skipped = 0;
    let failed = 0;
    failed += await this.#flushPublications();
    const claimable = await this.#store.listClaimableAdjudications(this.#pageSize);
    for (const op of claimable) {
      if (this.#halting) break;
      try {
        const outcome = await this.#adjudicate(op.gameId, op.operationId, op.generation);
        if (outcome === 'settled') settled += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        this.#fail('Adjudication failed for an operation; it is retried once its lease lapses', error, op);
      }
    }
    // Players must see the settlement first: never release over an outstanding notice. Those games
    // are excluded before the page limit, so they cannot starve the stops behind them.
    const stops = await this.#store.listReleasableStops(this.#pageSize, this.#releaseGraceMs, [...this.#unpublished.keys()]);
    for (const stop of stops) {
      try {
        await this.#release(stop.gameId, stop.stopOperationId);
        released += 1;
      } catch (error) {
        failed += 1;
        this.#fail('Clock release failed for a stop; it is retried on a later pass', error, stop);
      }
    }
    const more = claimable.length === this.#pageSize || stops.length === this.#pageSize;
    return { settled, released, skipped, failed, more };
  }

  async #adjudicate(gameId: string, operationId: string, generation: string): Promise<'settled' | 'skipped'> {
    const claimed = await this.#claim(gameId, operationId, generation);
    if (claimed === null) return 'skipped';
    try {
      // A settlement this process already evaluated (its write failed) is retried as it was,
      // without proving again: the proof job it consumed cannot be stepped any more.
      const retained = this.#store.retainedResolutionAt(gameId, operationId);
      const grant = retained === undefined ? await this.#prove(gameId, operationId, claimed) : claimed;
      if (grant === null) return 'skipped';
      const resolutionAt = retained ?? this.#now();
      const receipt = await this.#settle({ gameId, operationId, grant, resolutionAt });
      this.options.settledCounter?.inc();
      await this.#publish({ kind: 'settled', gameId, receipt });
      return 'settled';
    } catch (error) {
      // Superseded: another executor holds or completed the operation.
      if (error instanceof AdjudicationConflictError) return 'skipped';
      throw error;
    } finally {
      // Never keep a local job past its claim: it would hold controller capacity indefinitely.
      this.#dropJob(operationId);
    }
  }

  /** Run the proof to ready, renewing the lease; returns the current grant, or null when halted. */
  async #prove(gameId: string, operationId: string, claimed: AdjudicationClaimGrant): Promise<AdjudicationClaimGrant | null> {
    let grant = claimed;
    await this.#store.createProofJob(gameId, operationId);
    let step = this.#store.stepProofJob(operationId, 0);
    while (step.status === 'active' || step.status === 'resource_limit') {
      if (this.#halting) return null;
      grant = await this.#renewIfDue(grant);
      if (step.status === 'resource_limit') {
        // An exhausted question settles as unresolved (never a dead position); the rest go on.
        step = this.#store.concludeUnresolvedProofJob(operationId);
        continue;
      }
      await yieldToLoop();
      step = this.#store.stepProofJob(operationId, this.#sliceBudget);
    }
    if (step.status !== 'ready') {
      throw new Error(`proof job ended ${step.status}, not ready`);
    }
    return grant;
  }

  #dropJob(operationId: string): void {
    try {
      this.#store.cancelProofJob(operationId);
    } catch {
      /* not active, or already gone */
    }
    try {
      this.#store.evictProofJob(operationId);
    } catch {
      /* already gone */
    }
  }

  /** Publish once; a failure is kept and retried every pass until it succeeds. */
  async #publish(change: AdjudicationChange): Promise<void> {
    try {
      await this.options.publish(change);
      this.#unpublished.delete(change.gameId);
    } catch (error) {
      this.#unpublished.set(change.gameId, change);
      this.#fail('Publication of an adjudication change failed; it is retried every pass', error, { gameId: change.gameId });
    }
  }

  /** Retry every outstanding publication; returns how many still failed. */
  async #flushPublications(): Promise<number> {
    let failed = 0;
    for (const change of [...this.#unpublished.values()]) {
      if (this.#halting) break;
      try {
        await this.options.publish(change);
        if (this.#unpublished.get(change.gameId) === change) this.#unpublished.delete(change.gameId);
      } catch (error) {
        failed += 1;
        this.#fail('Publication of an adjudication change failed again; it is retried next pass', error, { gameId: change.gameId });
      }
    }
    return failed;
  }

  /** Claim with one intent, reusing it once when the reply is uncertain. A conflict means skip. */
  async #claim(gameId: string, operationId: string, expectedGeneration: string): Promise<AdjudicationClaimGrant | null> {
    const intent = this.#newIntent();
    const params: ClaimAdjudicationParams = {
      gameId, operationId, executorId: this.options.executorId, expectedGeneration, leaseMs: this.#leaseMs, intent,
    };
    try {
      return await this.#store.claimAdjudication(params);
    } catch (error) {
      if (error instanceof AdjudicationConflictError) return null;
      try {
        return await this.#store.claimAdjudication(params);
      } catch (retryError) {
        if (retryError instanceof AdjudicationConflictError) return null;
        throw retryError;
      }
    }
  }

  async #renewIfDue(grant: AdjudicationClaimGrant): Promise<AdjudicationClaimGrant> {
    if (grant.leaseUntil.getTime() - this.#now() > this.#leaseMs / 2) return grant;
    return this.#store.renewAdjudication({ grant, extensionMs: this.#leaseMs });
  }

  /** Settle, retrying once with the same grant: a lost COMMIT reply answers from the database. */
  async #settle(params: SettleAdjudicationParams): Promise<AdjudicationSettlementReceipt> {
    try {
      return await this.#store.settleAdjudication(params);
    } catch (error) {
      if (error instanceof AdjudicationConflictError) throw error;
      return this.#store.settleAdjudication(params);
    }
  }

  async #release(gameId: string, stopOperationId: string): Promise<void> {
    const receipt = await this.#store.releaseClocks({
      gameId, releaseRequestId: stopReleaseRequestId(stopOperationId), at: this.#now(),
    });
    this.options.releasedCounter?.inc();
    await this.#publish({ kind: 'released', gameId, receipt });
  }

  #fail(message: string, error: unknown, context: object): void {
    this.options.failuresCounter?.inc();
    this.options.logger?.error(message, { ...context, error: describe(error) });
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.#tick().finally(() => {
        this.#running = undefined;
      });
    }, delayMs);
  }

  async #tick(): Promise<void> {
    let pass: AdjudicationPass;
    try {
      pass = await this.runPass();
    } catch (error) {
      this.#consecutiveErrors += 1;
      this.#fail('Adjudication pass failed; retrying with backoff', error, {});
      this.#schedule(Math.min(this.#maxBackoffMs, this.#pollMs * 2 ** this.#consecutiveErrors));
      return;
    }
    this.#consecutiveErrors = 0;
    const progressed = pass.settled + pass.released > 0;
    this.#schedule(pass.more && progressed ? 0 : this.#pollMs);
  }
}

function nonnegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * Publish a durable adjudication change through the game's owner, exactly like a server expiry
 * (ADR-0176): the owner folds the new durable suffix into its copy and broadcasts it to the room.
 */
export function routedAdjudicationChange(options: RoutedExpiryOptions): (change: AdjudicationChange) => Promise<void> {
  const notify = routedExpiry(options, ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });
  return (change) => notify(change.gameId);
}
