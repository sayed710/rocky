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

/** Exactly what the worker uses of `PgAdjudicationStore`. */
export interface AdjudicationWorkStore {
  listClaimableAdjudications(limit: number): Promise<Array<{ gameId: string; operationId: string; generation: string }>>;
  listReleasableStops(limit: number, minAgeMs: number, excludeGameIds: readonly string[]): Promise<Array<{ gameId: string; stopOperationId: string }>>;
  claimAdjudication(params: ClaimAdjudicationParams): Promise<AdjudicationClaimGrant>;
  renewAdjudication(params: RenewAdjudicationParams): Promise<AdjudicationClaimGrant>;
  createProofJob(gameId: string, operationId: string): Promise<string>;
  stepProofJob(operationId: string, totalWorkBudget: number): JobStepResult;
  escalateProofJob(operationId: string): boolean;
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
  /**
   * Proof time one operation gets per pass (default 200 ms). An unfinished proof keeps its claim and
   * resumes on the next pass after every other operation's turn, so one long proof cannot hold up
   * the other games.
   */
  readonly proofSliceMs?: number;
  /** Monotonic milliseconds for proof time slices (default `performance.now`). */
  readonly monotonic?: () => number;
  /** Delay between passes once nothing more is waiting (default 250 ms). */
  readonly pollMs?: number;
  /** Operations and stops read per pass (default 20). */
  readonly pageSize?: number;
  /** Ceiling for the delay after consecutive failed passes (default 30 s). */
  readonly maxBackoffMs?: number;
  /**
   * The release sweep takes a stop only once its settlement is this old (default 1 s), so the replica
   * that settled it publishes first even when another replica's worker sees it. The settling worker
   * itself does not wait: it releases right after its notice is delivered.
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
  /** Proofs claimed by this worker that need more time; they resume next pass. */
  readonly pending: number;
  /** A page was full, or a proof is pending, so more work is waiting. */
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
  readonly #proofSliceMs: number;
  readonly #monotonic: () => number;
  /** Operations this worker holds a claim on whose proof needs more time, in claim order. */
  readonly #inFlight = new Map<string, { gameId: string; grant: AdjudicationClaimGrant }>();
  /** Publications that failed, by game; retried every pass. Only the latest per game matters. */
  readonly #unpublished = new Map<string, AdjudicationChange>();
  /** Stops released right after their own settlement during the current pass. */
  #releasedNow = 0;

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
    this.#proofSliceMs = positive(options.proofSliceMs ?? 200, 'proofSliceMs');
    this.#monotonic = options.monotonic ?? (() => performance.now());
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
    this.#releasedNow = 0;
    failed += await this.#flushPublications();
    const tally = (outcome: 'settled' | 'skipped' | 'pending'): void => {
      if (outcome === 'settled') settled += 1;
      else if (outcome === 'skipped') skipped += 1;
    };
    // Proofs this worker already holds go first, each for one more slice, in claim order.
    for (const [operationId, held] of [...this.#inFlight]) {
      if (this.#halting) break;
      try {
        tally(await this.#continue(held.gameId, operationId, held.grant));
      } catch (error) {
        failed += 1;
        this.#fail('Adjudication failed for an operation; it is retried once its lease lapses', error, { gameId: held.gameId, operationId });
      }
    }
    const claimable = await this.#store.listClaimableAdjudications(this.#pageSize);
    for (const op of claimable) {
      if (this.#halting) break;
      try {
        tally(await this.#adjudicate(op.gameId, op.operationId, op.generation));
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
    released += this.#releasedNow;
    const pending = this.#inFlight.size;
    const more = claimable.length === this.#pageSize || stops.length === this.#pageSize || pending > 0;
    return { settled, released, skipped, failed, pending, more };
  }

  async #adjudicate(gameId: string, operationId: string, generation: string): Promise<'settled' | 'skipped' | 'pending'> {
    const claimed = await this.#claim(gameId, operationId, generation);
    if (claimed === null) return 'skipped';
    return this.#continue(gameId, operationId, claimed);
  }

  /**
   * Prove for one time slice and settle when ready. An unfinished proof keeps its claim and its local
   * job and is resumed next pass; any other outcome drops the local job.
   */
  async #continue(gameId: string, operationId: string, held: AdjudicationClaimGrant): Promise<'settled' | 'skipped' | 'pending'> {
    let keep = false;
    try {
      // A settlement this process already evaluated (its write failed) is retried as it was,
      // without proving again: the proof job it consumed cannot be stepped any more.
      const retained = this.#store.retainedResolutionAt(gameId, operationId);
      let grant = held;
      if (retained === undefined) {
        const proved = await this.#prove(gameId, operationId, held);
        if (proved === null) return 'skipped';
        if (proved.status === 'pending') {
          this.#inFlight.set(operationId, { gameId, grant: proved.grant });
          keep = true;
          return 'pending';
        }
        grant = proved.grant;
      }
      this.#inFlight.delete(operationId);
      const resolutionAt = retained ?? this.#now();
      const receipt = await this.#settle({ gameId, operationId, grant, resolutionAt });
      this.options.settledCounter?.inc();
      const published = await this.#publish({ kind: 'settled', gameId, receipt });
      // A move that leaves the game running stopped its clocks. Once players have been told,
      // release them now instead of waiting for the grace period and the next pass; that wait
      // would be free thinking time. A failed release falls back to the release sweep.
      if (published && receipt.resolvedEvent.clockCompletion?.kind === 'stopped' && !this.#halting) {
        try {
          await this.#release(gameId, operationId);
          this.#releasedNow += 1;
        } catch (error) {
          this.#fail('Immediate clock release failed; the release sweep retries it', error, { gameId, operationId });
        }
      }
      return 'settled';
    } catch (error) {
      // Superseded: another executor holds or completed the operation.
      if (error instanceof AdjudicationConflictError) return 'skipped';
      throw error;
    } finally {
      if (!keep) {
        this.#inFlight.delete(operationId);
        // Never keep a local job past its claim: it would hold controller capacity indefinitely.
        this.#dropJob(operationId);
      }
    }
  }

  /**
   * Run the proof for at most one time slice, renewing the lease. An exhausted timeout question is
   * escalated while a tier remains; only then is a question concluded unresolved. Returns null when
   * halted, `pending` when the slice ran out, `ready` when the job can settle.
   */
  async #prove(
    gameId: string,
    operationId: string,
    claimed: AdjudicationClaimGrant,
  ): Promise<{ status: 'ready' | 'pending'; grant: AdjudicationClaimGrant } | null> {
    let grant = claimed;
    const started = this.#monotonic();
    await this.#store.createProofJob(gameId, operationId);
    let step = this.#store.stepProofJob(operationId, 0);
    while (step.status === 'active' || step.status === 'resource_limit') {
      if (this.#halting) return null;
      grant = await this.#renewIfDue(grant);
      if (step.status === 'resource_limit') {
        step = this.#store.escalateProofJob(operationId)
          ? this.#store.stepProofJob(operationId, 0)
          // An exhausted question settles as unresolved (never a dead position); the rest go on.
          : this.#store.concludeUnresolvedProofJob(operationId);
        continue;
      }
      if (this.#monotonic() - started >= this.#proofSliceMs) return { status: 'pending', grant };
      await yieldToLoop();
      step = this.#store.stepProofJob(operationId, this.#sliceBudget);
    }
    if (step.status !== 'ready') {
      throw new Error(`proof job ended ${step.status}, not ready`);
    }
    return { status: 'ready', grant };
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

  /** Publish once; a failure is kept and retried every pass until it succeeds. Returns whether it was delivered. */
  async #publish(change: AdjudicationChange): Promise<boolean> {
    try {
      await this.options.publish(change);
      this.#unpublished.delete(change.gameId);
      return true;
    } catch (error) {
      this.#unpublished.set(change.gameId, change);
      this.#fail('Publication of an adjudication change failed; it is retried every pass', error, { gameId: change.gameId });
      return false;
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
