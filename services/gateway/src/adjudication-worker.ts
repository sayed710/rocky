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
  /**
   * Operations worked on at once within a pass (default 4). Proof work still runs on one thread;
   * this overlaps database round trips across games while proof slices cooperatively yield to
   * the event loop.
   */
  readonly concurrency?: number;
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

const MAX_CONTROLLER_CAPACITY = 100;
const DEFAULT_CONCURRENCY = 4;

interface InFlightJob {
  readonly gameId: string;
  readonly operationId: string;
  grant: AdjudicationClaimGrant;
  jobInitialized: boolean;
  renewing?: Promise<AdjudicationClaimGrant>;
}

interface GameNoticeQueue {
  readonly items: AdjudicationChange[];
  drainer?: Promise<boolean>;
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
  readonly #concurrency: number;
  readonly #newIntent: () => ClaimIntent;
  readonly #now: () => number;
  #stopped = true;
  /** Set by stop(): a proof in progress returns at its next slice. */
  #halting = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #renewalTimer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #runningRenewal: Promise<void> | undefined;
  #consecutiveErrors = 0;
  readonly #releaseGraceMs: number;
  readonly #proofSliceMs: number;
  readonly #monotonic: () => number;
  /** Operations this worker holds a claim on whose proof needs more time, in claim order. */
  readonly #inFlight = new Map<string, InFlightJob>();
  /** Publications that failed, by game; retried in strict FIFO order every pass. */
  readonly #unpublished = new Map<string, GameNoticeQueue>();
  /** Stops released right after their own settlement during the current pass. */
  #releasedNow = 0;

  // Clean-code-guard narrow intentional exception: Constructor contains 12 decisions (11 declarative ?? defaults
  // plus baseline configuration assignment without behavioral branching). Preserves standard configuration pattern.
  // Revisit trigger: extract an options-resolution record if options exceed 15 or behavioral branching is introduced.
  constructor(private readonly options: AdjudicationWorkerOptions) {
    this.#store = options.store;
    this.#leaseMs = positive(options.leaseMs ?? 30_000, 'leaseMs');
    this.#sliceBudget = positive(options.sliceBudget ?? 2_000, 'sliceBudget');
    this.#pollMs = positive(options.pollMs ?? 250, 'pollMs');
    this.#pageSize = positive(options.pageSize ?? 20, 'pageSize');
    this.#maxBackoffMs = positive(options.maxBackoffMs ?? 30_000, 'maxBackoffMs');
    this.#concurrency = positiveBounded(options.concurrency ?? DEFAULT_CONCURRENCY, 'concurrency', MAX_CONTROLLER_CAPACITY);
    this.#newIntent = options.newIntent ?? (() => PgAdjudicationStore.newClaimIntent());
    this.#now = options.now ?? (() => Date.now());
    this.#releaseGraceMs = nonnegative(options.releaseGraceMs ?? 1_000, 'releaseGraceMs');
    this.#proofSliceMs = positive(options.proofSliceMs ?? 200, 'proofSliceMs');
    this.#monotonic = options.monotonic ?? (() => performance.now());
  }

  /** Total publications still outstanding across all games (for observability and tests). */
  get unpublishedCount(): number {
    let total = 0;
    for (const queue of this.#unpublished.values()) {
      total += queue.items.length;
    }
    return total;
  }

  /** Start passing at once, so work left by a process that stopped resumes immediately. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#halting = false;
    this.#schedule(0);
    this.#scheduleRenewal();
  }

  /** Stop scheduling and wait for an in-flight pass. A proof in progress stops at its next slice. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#halting = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#renewalTimer) clearTimeout(this.#renewalTimer);
    this.#renewalTimer = undefined;
    const inFlightRenewals = [...this.#inFlight.values()].map((h) => h.renewing).filter(Boolean);
    await Promise.allSettled([this.#running, this.#runningRenewal, ...inFlightRenewals]);
    for (const operationId of this.#inFlight.keys()) {
      this.#dropJob(operationId);
    }
    this.#inFlight.clear();
  }

  /** One bounded pass: settle what is claimable, then release what is published and stopped. */
  async runPass(): Promise<AdjudicationPass> {
    let settled = 0;
    let skipped = 0;
    let failed = 0;
    this.#releasedNow = 0;

    this.#scheduleRenewal();
    try {
      failed += await this.#flushPublications();
      const tally = (outcome: 'settled' | 'skipped' | 'pending'): void => {
        if (outcome === 'settled') settled += 1;
        else if (outcome === 'skipped') skipped += 1;
      };

      failed += await this.#sweepHeld(tally);
      const freeCapacity = Math.max(0, MAX_CONTROLLER_CAPACITY - this.#inFlight.size);
      const freshResult = await this.#admitFresh(freeCapacity, tally);
      failed += freshResult.failed;

      const stopsResult = await this.#sweepStops();
      failed += stopsResult.failed;
      const released = stopsResult.released + this.#releasedNow;

      const pending = this.#inFlight.size;
      const more =
        (freshResult.claimLimit > 0 && freshResult.claimableCount === freshResult.claimLimit) ||
        stopsResult.stopsCount === this.#pageSize ||
        pending > 0;
      return { settled, released, skipped, failed, pending, more };
    } finally {
      if (this.#stopped && this.#renewalTimer) {
        clearTimeout(this.#renewalTimer);
        this.#renewalTimer = undefined;
      }
    }
  }

  async #sweepHeld(onOutcome: (outcome: 'settled' | 'skipped' | 'pending') => void): Promise<number> {
    let failed = 0;
    const held = [...this.#inFlight.values()];
    await this.#eachBounded(held, async (item) => {
      if (!this.#inFlight.has(item.operationId)) {
        onOutcome('skipped');
        return;
      }
      try {
        onOutcome(await this.#continue(item));
      } catch (error) {
        failed += 1;
        this.#fail('Adjudication failed for an operation; it is retried once its lease lapses', error, {
          gameId: item.gameId,
          operationId: item.operationId,
        });
      }
    });
    return failed;
  }

  async #admitFresh(
    freeCapacity: number,
    onOutcome: (outcome: 'settled' | 'skipped' | 'pending') => void,
  ): Promise<{ failed: number; claimLimit: number; claimableCount: number }> {
    const claimLimit = Math.min(this.#pageSize, freeCapacity);
    if (claimLimit <= 0 || this.#halting) {
      return { failed: 0, claimLimit, claimableCount: 0 };
    }
    const claimable = await this.#store.listClaimableAdjudications(claimLimit);
    const fresh = this.#filterFresh(claimable);
    let failed = 0;
    let reservedSlots = 0;
    await this.#eachBounded(fresh, async (op) => {
      if (this.#inFlight.size + reservedSlots >= MAX_CONTROLLER_CAPACITY) {
        onOutcome('skipped');
        return;
      }
      reservedSlots += 1;
      try {
        onOutcome(await this.#adjudicate(op.gameId, op.operationId, op.generation));
      } catch (error) {
        failed += 1;
        this.#fail('Adjudication failed for an operation; it is retried once its lease lapses', error, op);
      } finally {
        reservedSlots -= 1;
      }
    });
    return { failed, claimLimit, claimableCount: claimable.length };
  }

  async #sweepStops(): Promise<{ released: number; failed: number; stopsCount: number }> {
    const stops = await this.#store.listReleasableStops(this.#pageSize, this.#releaseGraceMs, [...this.#unpublished.keys()]);
    let released = 0;
    let failed = 0;
    for (const stop of stops) {
      if (this.#halting) break;
      try {
        await this.#release(stop.gameId, stop.stopOperationId);
        released += 1;
      } catch (error) {
        failed += 1;
        this.#fail('Clock release failed for a stop; it is retried on a later pass', error, stop);
      }
    }
    return { released, failed, stopsCount: stops.length };
  }

  #filterFresh(
    claimable: ReadonlyArray<{ gameId: string; operationId: string; generation: string }>,
  ): Array<{ gameId: string; operationId: string; generation: string }> {
    const fresh: Array<{ gameId: string; operationId: string; generation: string }> = [];
    const seen = new Set<string>();
    for (const op of claimable) {
      if (this.#inFlight.has(op.operationId) || seen.has(op.operationId)) continue;
      seen.add(op.operationId);
      fresh.push(op);
    }
    return fresh;
  }

  /** Run `fn` over `items` in order, at most `concurrency` at a time, until halted. */
  async #eachBounded<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
    if (items.length === 0) return;
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < items.length && !this.#halting) {
        const item = items[next++]!;
        await fn(item);
      }
    };
    const count = Math.min(this.#concurrency, items.length);
    await Promise.all(Array.from({ length: count }, lane));
  }

  async #adjudicate(gameId: string, operationId: string, generation: string): Promise<'settled' | 'skipped' | 'pending'> {
    const claimed = await this.#claim(gameId, operationId, generation);
    if (claimed === null) return 'skipped';
    const heldJob: InFlightJob = {
      gameId,
      operationId,
      grant: claimed,
      jobInitialized: false,
    };
    this.#inFlight.set(operationId, heldJob);
    this.#scheduleRenewal();
    return this.#continue(heldJob);
  }

  #canReleaseImmediately(gameId: string, receipt: AdjudicationSettlementReceipt, published: boolean): boolean {
    if (this.#halting || !published) return false;
    if (this.#unpublished.has(gameId)) return false;
    return receipt.resolvedEvent.clockCompletion?.kind === 'stopped';
  }

  async #settleAndRelease(
    gameId: string,
    operationId: string,
    grant: AdjudicationClaimGrant,
    retained?: number,
  ): Promise<void> {
    const resolutionAt = retained !== undefined ? retained : this.#now();
    const receipt = await this.#settle({ gameId, operationId, grant, resolutionAt });
    this.options.settledCounter?.inc();
    const published = await this.#publish({ kind: 'settled', gameId, receipt });
    if (this.#canReleaseImmediately(gameId, receipt, published)) {
      try {
        await this.#release(gameId, operationId);
        this.#releasedNow += 1;
      } catch (error) {
        this.#fail('Immediate clock release failed; the release sweep retries it', error, { gameId, operationId });
      }
    }
  }

  #cleanupJob(operationId: string): void {
    const existed = this.#inFlight.delete(operationId);
    if (existed) {
      this.#dropJob(operationId);
    }
  }

  /**
   * Prove for one time slice and settle when ready. An unfinished proof keeps its claim and its local
   * job and is resumed next pass; any other outcome drops the local job.
   */
  async #continue(heldJob: InFlightJob): Promise<'settled' | 'skipped' | 'pending'> {
    if (!this.#inFlight.has(heldJob.operationId)) return 'skipped';
    const { gameId, operationId } = heldJob;
    let keep = false;
    try {
      heldJob.grant = await this.#renewHeldJob(heldJob);
      const retained = this.#store.retainedResolutionAt(gameId, operationId);
      let grant = heldJob.grant;
      if (retained === undefined) {
        const proved = await this.#prove(gameId, operationId, heldJob);
        if (proved === null) return 'skipped';
        if (proved.status === 'pending') {
          heldJob.grant = proved.grant;
          keep = true;
          this.#scheduleRenewal();
          return 'pending';
        }
        grant = proved.grant;
      }
      await this.#settleAndRelease(gameId, operationId, grant, retained);
      return 'settled';
    } catch (error) {
      if (error instanceof AdjudicationConflictError) return 'skipped';
      throw error;
    } finally {
      if (!keep) {
        this.#cleanupJob(operationId);
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
    heldJob: InFlightJob,
  ): Promise<{ status: 'ready' | 'pending'; grant: AdjudicationClaimGrant } | null> {
    let grant = heldJob.grant;
    const started = this.#monotonic();
    if (!heldJob.jobInitialized) {
      await this.#store.createProofJob(gameId, operationId);
      heldJob.jobInitialized = true;
    }
    let step = this.#store.stepProofJob(operationId, 0);
    while (step.status === 'active' || step.status === 'resource_limit') {
      if (this.#halting) return null;
      grant = await this.#renewHeldJob(heldJob);
      if (step.status === 'resource_limit') {
        step = this.#store.escalateProofJob(operationId)
          ? this.#store.stepProofJob(operationId, 0)
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

  /** Publish once; a failure is queued and retried every pass until it succeeds in strict FIFO order. */
  async #publish(change: AdjudicationChange): Promise<boolean> {
    let queue = this.#unpublished.get(change.gameId);
    if (!queue) {
      queue = { items: [] };
      this.#unpublished.set(change.gameId, queue);
    }
    queue.items.push(change);
    return this.#drainGame(change.gameId, queue);
  }

  /** Drain a single game's FIFO queue of unpublished changes; returns true if the queue is now empty. */
  async #drainGame(gameId: string, queue: GameNoticeQueue): Promise<boolean> {
    if (queue.drainer) {
      return queue.drainer;
    }
    const task = (async () => {
      try {
        while (queue.items.length > 0) {
          if (this.#halting) return false;
          const next = queue.items[0]!;
          try {
            await this.options.publish(next);
            queue.items.shift();
          } catch (error) {
            this.#fail('Publication of an adjudication change failed; it is retried every pass', error, { gameId });
            return false;
          }
        }
        this.#unpublished.delete(gameId);
        return true;
      } finally {
        queue.drainer = undefined;
      }
    })();
    queue.drainer = task;
    return task;
  }

  /** Retry every outstanding publication in per-game FIFO order; returns how many still failed. */
  async #flushPublications(): Promise<number> {
    let failed = 0;
    for (const [gameId, queue] of [...this.#unpublished.entries()]) {
      if (this.#halting) break;
      const ok = await this.#drainGame(gameId, queue);
      if (!ok) failed += 1;
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

  async #renewHeldJob(held: InFlightJob): Promise<AdjudicationClaimGrant> {
    const remaining = held.grant.leaseUntil.getTime() - this.#now();
    if (remaining > this.#leaseMs / 2) {
      return held.grant;
    }
    if (held.renewing) {
      return held.renewing;
    }
    const renewal = (async () => {
      try {
        const updated = await this.#store.renewAdjudication({
          grant: held.grant,
          extensionMs: this.#leaseMs,
        });
        held.grant = updated;
        return updated;
      } catch (error) {
        if (error instanceof AdjudicationConflictError) {
          this.#inFlight.delete(held.operationId);
          this.#dropJob(held.operationId);
          throw error;
        }
        this.#fail('Renewal of an adjudication lease failed', error, {
          gameId: held.gameId,
          operationId: held.operationId,
        });
        if (held.grant.leaseUntil.getTime() <= this.#now()) {
          this.#inFlight.delete(held.operationId);
          this.#dropJob(held.operationId);
        }
        throw error;
      } finally {
        held.renewing = undefined;
      }
    })();
    held.renewing = renewal;
    return renewal;
  }

  async #renewAllDueHeldJobs(): Promise<void> {
    for (const held of [...this.#inFlight.values()]) {
      if (this.#halting) break;
      try {
        await this.#renewHeldJob(held);
      } catch {
        // Logged and handled in #renewHeldJob
      }
    }
  }

  #scheduleRenewal(): void {
    if (this.#stopped || this.#inFlight.size === 0) return;
    if (this.#renewalTimer) clearTimeout(this.#renewalTimer);
    const now = this.#now();
    let earliestRemaining = Number.POSITIVE_INFINITY;
    for (const held of this.#inFlight.values()) {
      const remaining = held.grant.leaseUntil.getTime() - now;
      if (remaining < earliestRemaining) earliestRemaining = remaining;
    }
    const timeUntilDue = Math.max(10, Math.floor(earliestRemaining - this.#leaseMs / 2));
    const delay = Math.min(timeUntilDue, Math.max(50, Math.floor(this.#leaseMs / 4)));
    this.#renewalTimer = setTimeout(() => {
      this.#renewalTimer = undefined;
      const renewalTask = this.#renewAllDueHeldJobs().finally(() => {
        if (this.#runningRenewal === renewalTask) {
          this.#runningRenewal = undefined;
        }
        this.#scheduleRenewal();
      });
      this.#runningRenewal = renewalTask;
    }, delay);
  }

  #boundDelayForHeld(delayMs: number): number {
    if (this.#inFlight.size === 0) return delayMs;
    const now = this.#now();
    let earliestRemaining = Number.POSITIVE_INFINITY;
    for (const held of this.#inFlight.values()) {
      const remaining = held.grant.leaseUntil.getTime() - now;
      if (remaining < earliestRemaining) earliestRemaining = remaining;
    }
    const safeDelay = Math.max(0, Math.floor(earliestRemaining - this.#leaseMs / 2));
    return Math.min(delayMs, safeDelay);
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
      await this.#renewAllDueHeldJobs();
      const rawBackoff = Math.min(this.#maxBackoffMs, this.#pollMs * 2 ** this.#consecutiveErrors);
      this.#schedule(this.#boundDelayForHeld(rawBackoff));
      return;
    }
    this.#consecutiveErrors = 0;
    const progressed = pass.settled + pass.released > 0 || pass.pending > 0;
    const nextDelay = pass.more && progressed ? 0 : this.#pollMs;
    this.#schedule(this.#boundDelayForHeld(nextDelay));
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

function positiveBounded(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new RangeError(`${name} must be a positive safe integer <= ${max}`);
  }
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
