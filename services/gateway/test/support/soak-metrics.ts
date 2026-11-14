/**
 * Deterministic PRNG, resource sampling, ply-bucketing, and phase correlation
 * for adjudication soak integration testing (Issue #124).
 *
 * Implements bounded, typed measurement of:
 * - Deterministic PRNG streams derived from explicit validated SOAK_SEED
 * - Active proof slice wall duration and CPU time (distinguished from wall elapsed)
 * - Validation costs bucketed by game ply (0-39, 40-79, 80-119, 120+)
 * - Fault timeline correlation (lease takeover, lossy commits, cold restarts)
 * - Process memory sampling (RSS and JS heap)
 * - Bounded retention for tail latency investigation
 */

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export interface SoakConfig {
  readonly seed: number;
  readonly games: number;
  readonly plies: number;
  readonly thinkMs: number;
  readonly timeoutMs: number;
}

export type Prng = () => number;

export type PlyBucket = '0-39' | '40-79' | '80-119' | '120+';

export const PLY_BUCKETS: readonly PlyBucket[] = ['0-39', '40-79', '80-119', '120+'];

export type MoveObservationProvenance = 'move_broadcast' | 'state_broadcast' | 'recovery_response';

export interface MoveLatencyProvenanceCounts {
  readonly move_broadcast: number;
  readonly state_broadcast: number;
  readonly recovery_response: number;
}

export interface MetricSummary {
  readonly n: number;
  readonly total: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly reservoirSize: number;
  readonly isSampled: boolean;
}

export interface MoveLatencySummary extends MetricSummary {
  readonly provenance: MoveLatencyProvenanceCounts;
  readonly note: string;
}

export interface MemoryStats {
  readonly rssPeakMB: number;
  readonly heapPeakMB: number;
  readonly rssEndMB: number;
  readonly heapEndMB: number;
  readonly externalMB: number;
  readonly processModel: string;
  readonly note: string;
}

export interface FaultEvent {
  readonly name: string;
  readonly startMs: number;
  readonly finiteDurationMs?: number;
  endMs?: number;
}

export interface ClaimTimelineRecord {
  readonly executorId: string;
  readonly generation: string;
  readonly claimedAtMonotonicMs: number;
  readonly leaseDeadlineEpochMs: number;
}

export interface ClaimEvidenceInput {
  readonly gameId: string;
  readonly operationId: string;
  readonly executorId: string;
  readonly generation: string;
  readonly leaseUntil: Date;
}

export interface PhaseEvidence {
  admissionStartMs: number;
  admissionDurationMs: number;
  hasBoundStart?: boolean;
  readonly firstClaimAtMs?: number;
  readonly firstExecutorId?: string;
  readonly lastClaimAtMs?: number;
  readonly lastExecutorId?: string;
  readonly claimsCount: number;
  readonly claims: readonly ClaimTimelineRecord[];
  readonly isTakeover: boolean;
  readonly claimGapWallMs: number;
  readonly activeProofSliceWallMs: number;
  readonly activeProofCpuMs: number;
  readonly proofSteps: number;
  readonly proofSlices: number;
  readonly settleAttempts: number;
  readonly settleDbWallMs: number;
  readonly settleCommittedAtMs?: number;
  releaseDurationMs?: number;
  releaseCommittedAtMs?: number;
  totalWallMs: number;
}

export interface MovePositionContext {
  readonly fen: string;
  readonly uci: string;
  readonly gameIndex: number;
  readonly gameSeed: number;
  readonly attempt: number;
  readonly basePly: number;
}

export interface TailSample {
  readonly operationId: string;
  readonly gameId: string;
  readonly basePly: number;
  readonly resultPly: number;
  wallDurationMs: number;
  readonly activeProofCpuMs: number;
  readonly activeProofSliceWallMs: number;
  readonly proofSteps: number;
  readonly proofSlices: number;
  readonly roles: readonly string[];
  readonly questionKind: string;
  readonly isCausalTakeover: boolean;
  readonly faultAssociated: boolean;
  readonly faultReasons: readonly string[];
  readonly evidence: PhaseEvidence;
  readonly positionContext?: MovePositionContext;
}

export interface MoveTailSample {
  readonly gameId: string;
  readonly basePly: number;
  readonly resultPly: number;
  readonly latencyMs: number;
  readonly faultAssociated: boolean;
  readonly faultReasons: readonly string[];
  readonly positionContext?: MovePositionContext;
  readonly provenance?: MoveObservationProvenance;
}

export function parsePositiveInt(val: string | undefined, defaultVal: number, name: string): number {
  if (val === undefined) return defaultVal;
  const trimmed = val.trim();
  if (trimmed === '') {
    throw new RangeError(`${name} was provided as blank/empty string; expected positive integer`);
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new RangeError(`${name} must be a positive integer; received "${val}"`);
  }
  return num;
}

export function parseSeed(val: string | undefined, defaultVal: number): number {
  if (val === undefined) return defaultVal;
  const trimmed = val.trim();
  if (trimmed === '') {
    throw new RangeError('SOAK_SEED was provided as blank/empty string; expected integer 0..4294967295');
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num < 0 || num > 0xffffffff) {
    throw new RangeError(`SOAK_SEED must be an unsigned 32-bit integer (0 to 4294967295); received "${val}"`);
  }
  return num;
}

export function parseTimeoutMs(val: string | undefined, defaultVal = 900_000): number {
  if (val === undefined) return defaultVal;
  const trimmed = val.trim();
  if (trimmed === '') {
    throw new RangeError('SOAK_TIMEOUT_MS was provided as blank/empty string; expected integer 10000..3600000');
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num < 10_000 || num > 3_600_000) {
    throw new RangeError(`SOAK_TIMEOUT_MS must be an integer between 10000 and 3600000; received "${val}"`);
  }
  return num;
}

export function parseSoakConfig(env: NodeJS.ProcessEnv): SoakConfig {
  return {
    seed: parseSeed(env['SOAK_SEED'], 1337),
    games: parsePositiveInt(env['SOAK_GAMES'], 6, 'SOAK_GAMES'),
    plies: parsePositiveInt(env['SOAK_PLIES'], 16, 'SOAK_PLIES'),
    thinkMs: parsePositiveInt(env['SOAK_THINK_MS'], 150, 'SOAK_THINK_MS'),
    timeoutMs: parseTimeoutMs(env['SOAK_TIMEOUT_MS'], 900_000),
  };
}

/** 32-bit Mulberry32 PRNG returning [0, 1). */
export function createPrng(seed: number): Prng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function deriveFaultSeed(masterSeed: number): number {
  return (Math.imul(masterSeed, 0x85ebca6b) ^ 0xc2b2ae35) >>> 0;
}

export function deriveGameSeed(masterSeed: number, gameIndex: number): number {
  return (Math.imul(masterSeed ^ (gameIndex + 1), 0x27d4eb2d) + 0x165667b1) >>> 0;
}

/** Anchors move selection to game index and committed basePly so retries do not shift RNG draws. */
export function derivePlyMovePrng(gameSeed: number, basePly: number, attempt = 0): Prng {
  const plySeed = (Math.imul(gameSeed ^ (basePly + 1), 0x3c6ef35f) + Math.imul(attempt, 0x1b873593)) >>> 0;
  return createPrng(plySeed);
}

export function plyBucket(ply: number): PlyBucket {
  if (ply < 40) return '0-39';
  if (ply < 80) return '40-79';
  if (ply < 120) return '80-119';
  return '120+';
}

export function isFaultAssociated(
  windowStartMs: number,
  windowEndMs: number,
  faults: readonly FaultEvent[],
  isTakeover: boolean,
): { faultAssociated: boolean; faultReasons: string[] } {
  const reasons: string[] = [];
  if (isTakeover) {
    reasons.push('lease_takeover');
  }
  for (const fault of faults) {
    const faultStart = fault.startMs;
    const faultEnd = fault.endMs ?? (fault.finiteDurationMs ? faultStart + fault.finiteDurationMs : Infinity);
    if (Math.max(windowStartMs, faultStart) <= Math.min(windowEndMs, faultEnd)) {
      reasons.push(fault.name);
    }
  }
  return {
    faultAssociated: reasons.length > 0,
    faultReasons: reasons,
  };
}

export class BoundedReservoir {
  readonly #reservoir: number[] = [];
  readonly #capacity: number;
  readonly #rnd: Prng;
  #count = 0;
  #total = 0;
  #min = Infinity;
  #max = -Infinity;

  constructor(capacity = 1024, seed = 0x9e3779b9) {
    this.#capacity = capacity;
    this.#rnd = createPrng(seed);
  }

  record(val: number): void {
    this.#count++;
    this.#total += val;
    if (val < this.#min) this.#min = val;
    if (val > this.#max) this.#max = val;
    if (this.#reservoir.length < this.#capacity) {
      this.#reservoir.push(val);
    } else {
      const idx = Math.floor(this.#rnd() * this.#count);
      if (idx < this.#capacity) {
        this.#reservoir[idx] = val;
      }
    }
  }

  get summary(): MetricSummary {
    if (this.#count === 0) {
      return { n: 0, total: 0, min: 0, max: 0, p50: 0, p90: 0, p99: 0, reservoirSize: 0, isSampled: false };
    }
    const s = [...this.#reservoir].sort((a, b) => a - b);
    const at = (p: number): number => {
      const idx = Math.min(s.length - 1, Math.floor(p * s.length));
      return +(s[idx]!.toFixed(1));
    };
    return {
      n: this.#count,
      total: Math.round(this.#total),
      min: +(this.#min.toFixed(1)),
      max: +(this.#max.toFixed(1)),
      p50: at(0.5),
      p90: at(0.9),
      p99: at(0.99),
      reservoirSize: this.#reservoir.length,
      isSampled: this.#count > this.#capacity,
    };
  }
}

export class TopKCollector<T> {
  readonly #items: T[] = [];
  readonly #capacity: number;
  readonly #scoreFn: (item: T) => number;
  readonly #keyFn?: (item: T) => string;

  constructor(capacity: number, scoreFn: (item: T) => number, keyFn?: (item: T) => string) {
    this.#capacity = capacity;
    this.#scoreFn = scoreFn;
    this.#keyFn = keyFn;
  }

  record(item: T): void {
    const score = this.#scoreFn(item);
    const key = this.#keyFn ? this.#keyFn(item) : undefined;
    const existingIdx = key !== undefined
      ? this.#items.findIndex((x) => this.#keyFn!(x) === key)
      : this.#items.indexOf(item);

    if (existingIdx !== -1) {
      this.#items[existingIdx] = item;
      this.#items.sort((a, b) => this.#scoreFn(b) - this.#scoreFn(a));
      return;
    }

    if (this.#items.length < this.#capacity) {
      this.#items.push(item);
      this.#items.sort((a, b) => this.#scoreFn(b) - this.#scoreFn(a));
      return;
    }

    const lowest = this.#scoreFn(this.#items[this.#items.length - 1]!);
    if (score > lowest) {
      this.#items[this.#items.length - 1] = item;
      this.#items.sort((a, b) => this.#scoreFn(b) - this.#scoreFn(a));
    }
  }

  get items(): readonly T[] {
    return this.#items;
  }
}

interface ActiveOperation {
  readonly operationId: string;
  readonly gameId: string;
  basePly: number;
  resultPly: number;
  admissionStartAt: number;
  admissionDurationMs: number;
  hasBoundStart: boolean;
  readonly claims: ClaimTimelineRecord[];
  isTakeover: boolean;
  claimGapWallMs: number;
  activeProofSliceWallMs: number;
  activeProofCpuMs: number;
  steps: number;
  slices: number;
  roles: readonly string[];
  questionKind: string;
  settleAttempts: number;
  settleDbWallMs: number;
  settleCommittedAtMs?: number;
  releaseDurationMs?: number;
  releaseCommittedAtMs?: number;
  positionContext?: MovePositionContext;
}

export class MemorySampler {
  #peakRss = 0;
  #peakHeap = 0;
  #timer: NodeJS.Timeout | undefined;

  start(intervalMs = 200): void {
    this.#sample();
    this.#timer = setInterval(() => this.#sample(), intervalMs);
  }

  #sample(): void {
    const mem = process.memoryUsage();
    if (mem.rss > this.#peakRss) this.#peakRss = mem.rss;
    if (mem.heapUsed > this.#peakHeap) this.#peakHeap = mem.heapUsed;
  }

  stop(): MemoryStats {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#sample();
    const final = process.memoryUsage();
    const toMB = (bytes: number) => +(bytes / (1024 * 1024)).toFixed(1);
    return {
      rssPeakMB: toMB(this.#peakRss),
      heapPeakMB: toMB(this.#peakHeap),
      rssEndMB: toMB(final.rss),
      heapEndMB: toMB(final.heapUsed),
      externalMB: toMB(final.external),
      processModel: 'single-process-two-replica-instances',
      note: 'Process memory sampled locally; resource limits must be verified from external runner receipt.',
    };
  }
}

/**
 * Coordinates simulated replica loss at an active proof boundary.
 *
 * Prevents the graceful-drain race where worker.stop() finishes in-flight
 * proofs before shutting down, ensuring the operation remains abandoned
 * in PostgreSQL in 'proving' state for successor takeover verification.
 */
export class WorkerLossBarrier {
  #armed = false;
  #triggered = false;
  #target?: { readonly gameId: string; readonly operationId: string };
  #pauseResolve?: (target: { readonly gameId: string; readonly operationId: string }) => void;
  #pauseReject?: (err: Error) => void;
  readonly #pausePromise: Promise<{ readonly gameId: string; readonly operationId: string }>;
  #releaseResolve?: () => void;
  readonly #releasePromise: Promise<void>;

  constructor() {
    this.#pausePromise = new Promise((resolve, reject) => {
      this.#pauseResolve = resolve;
      this.#pauseReject = reject;
    });
    this.#pausePromise.catch(() => {});
    this.#releasePromise = new Promise((resolve) => {
      this.#releaseResolve = resolve;
    });
  }

  arm(): void {
    this.#armed = true;
  }

  get isArmed(): boolean {
    return this.#armed;
  }

  get isTriggered(): boolean {
    return this.#triggered;
  }

  get target(): { readonly gameId: string; readonly operationId: string } | undefined {
    return this.#target;
  }

  async interceptProofBoundary(gameId: string, operationId: string, status?: string): Promise<void> {
    if (!this.#armed || this.#triggered) return;
    if (status !== undefined && status !== 'active') return;
    this.#triggered = true;
    this.#target = { gameId, operationId };
    this.#pauseResolve?.(this.#target);
    await this.#releasePromise;
  }

  async waitForPause(timeoutMs = 30_000): Promise<{ readonly gameId: string; readonly operationId: string }> {
    if (this.#target) return this.#target;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for worker proof boundary after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.#pausePromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  release(): void {
    this.#releaseResolve?.();
  }

  abort(reason = 'aborted'): void {
    this.#armed = false;
    this.#pauseReject?.(new Error(reason));
    this.#releaseResolve?.();
  }
}

export type MoveFailureOutcome = 'ambiguous_commit' | 'definite_failure';

export interface DurableMoveLedgerEntry {
  readonly ply: number;
  readonly uci: string;
}

export interface ObservedMoveRecord {
  readonly gameId: string;
  readonly ply: number;
  readonly uci: string;
}

interface PendingMoveRecord {
  readonly gameId: string;
  readonly basePly: number;
  readonly expectedPly: number;
  readonly atMs: number;
  readonly positionContext?: MovePositionContext;
  readonly uci?: string;
  isAmbiguous?: boolean;
}

export interface StartAdjudicationRequestInput {
  readonly gameId: string;
  readonly operationId: string;
  readonly basePly: number;
  readonly atMs: number;
  readonly uci?: string;
}

interface UnresolvedStartEvidence {
  readonly gameId: string;
  readonly operationId: string;
  readonly basePly: number;
  readonly entryAtMs: number;
  readonly uci?: string;
  readonly positionContext?: MovePositionContext;
}

export interface StateMoveIdentityLike {
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly by: string;
}

export interface StateViewSnapshotLike {
  readonly fen: string;
  readonly stateRevision: number;
  readonly adjudication?: 'proving' | 'stopped';
  readonly ply: number;
  readonly turn: string;
  readonly clock: { readonly w: number; readonly b: number };
  readonly turnStartedAt: number | null;
  readonly status: { readonly over: boolean };
  readonly drawOffer: string | null;
  readonly moves?: readonly StateMoveIdentityLike[];
}

export interface ReplayedGameLike {
  readonly fen: string;
  readonly adjudication: unknown;
  readonly isBlocked?: boolean;
  readonly stoppedClock?: unknown | null;
  readonly ply: number;
  readonly turn: string;
  readonly status: { readonly over: boolean };
  readonly drawOffer: string | null;
  snapshot(): {
    readonly clock: {
      readonly remaining: { readonly w: number; readonly b: number };
      readonly turnStartedAt: number | null;
    };
    readonly moves?: readonly StateMoveIdentityLike[];
  };
}

function assertCoreStateViewFields(
  view: StateViewSnapshotLike,
  replayed: ReplayedGameLike,
  expectedEventsCount: number,
  label: 'owner' | 'recovery',
): void {
  assert.equal(view.fen, replayed.fen, `${label} copy equals replay fen`);
  assert.equal(view.stateRevision, expectedEventsCount - 1, `${label} stateRevision equals logged head seq`);
  assert.equal(view.ply, replayed.ply, `${label} ply equals replay ply`);
  assert.equal(view.turn, replayed.turn, `${label} turn equals replay turn`);
  assert.deepEqual(view.status, replayed.status, `${label} status equals replay status`);
  assert.equal(view.drawOffer, replayed.drawOffer, `${label} drawOffer equals replay drawOffer`);

  const snap = replayed.snapshot();
  assert.equal(view.clock.w, snap.clock.remaining.w, `${label} white clock matches replay snapshot`);
  assert.equal(view.clock.b, snap.clock.remaining.b, `${label} black clock matches replay snapshot`);
  assert.equal(view.turnStartedAt, snap.clock.turnStartedAt, `${label} turnStartedAt matches replay snapshot`);

  if (view.moves !== undefined && snap.moves !== undefined) {
    assert.deepEqual(
      view.moves.map((m) => ({ ply: m.ply, uci: m.uci, san: m.san, by: m.by })),
      snap.moves.map((m) => ({ ply: m.ply, uci: m.uci, san: m.san, by: m.by })),
      `${label} moves match replay snapshot`,
    );
  }
}

export function assertStateViewMatchesReplay(
  view: StateViewSnapshotLike,
  replayed: ReplayedGameLike,
  loggedEventsCount: number,
): void {
  assertCoreStateViewFields(view, replayed, loggedEventsCount, 'owner');
  assert.equal(view.adjudication, undefined, 'released or ended, never stuck');
  assert.equal(replayed.adjudication, null, 'replayed adjudication must be null');
}

export function assertRecoveryStateMatchesReplayPrefix(
  view: StateViewSnapshotLike,
  replayed: ReplayedGameLike,
  prefixEventsCount: number,
): void {
  assertCoreStateViewFields(view, replayed, prefixEventsCount, 'recovery');
  const expectedAdjudication: 'proving' | 'stopped' | undefined = replayed.isBlocked
    ? 'proving'
    : replayed.stoppedClock !== null && replayed.stoppedClock !== undefined
      ? 'stopped'
      : undefined;
  assert.equal(view.adjudication, expectedAdjudication, 'recovery adjudication phase matches replay prefix');
}

export class SoakMetricsTracker {
  readonly #pendingMoves = new Map<string, PendingMoveRecord>();
  readonly #observedPlys = new Set<string>();
  readonly #observedMovesByGame = new Map<string, ObservedMoveRecord[]>();
  readonly #activeOps = new Map<string, ActiveOperation>();
  readonly #unresolvedStarts = new Map<string, UnresolvedStartEvidence>();
  readonly #settledAwaitingRelease = new Map<string, TailSample>();
  readonly #completedSamples = new Map<string, TailSample>();
  readonly #completedOps = new Set<string>();
  readonly #gameBasePly = new Map<string, number>();
  readonly #gamePositionContexts = new Map<string, MovePositionContext>();
  readonly #provingSince = new Map<string, number>();
  readonly #stoppedSince = new Map<string, number>();
  readonly #faults: FaultEvent[] = [];

  readonly #moveLatencies = new BoundedReservoir(2048, 0x1111);
  readonly #provingDurations = new BoundedReservoir(1024, 0x2222);
  readonly #stoppedDurations = new BoundedReservoir(1024, 0x3333);
  readonly #activeProofCpu = new BoundedReservoir(2048, 0x4444);
  readonly #activeProofSliceWall = new BoundedReservoir(2048, 0x5555);

  readonly #startDurationsByBucket = new Map<PlyBucket, BoundedReservoir>();
  readonly #settleDurationsByBucket = new Map<PlyBucket, BoundedReservoir>();
  readonly #storeMetrics = new Map<string, BoundedReservoir>();

  readonly #topProvingWall: TopKCollector<TailSample>;
  readonly #topProofCpu: TopKCollector<TailSample>;
  readonly #topMoveLatencies: TopKCollector<MoveTailSample>;

  readonly #provenanceCounts: { [K in MoveObservationProvenance]: number } = {
    move_broadcast: 0,
    state_broadcast: 0,
    recovery_response: 0,
  };

  #matchedMovesCount = 0;
  #settledCommittedCount = 0;
  #successorTakeoversCount = 0;

  constructor(topKCapacity = 10) {
    for (const b of PLY_BUCKETS) {
      this.#startDurationsByBucket.set(b, new BoundedReservoir(512));
      this.#settleDurationsByBucket.set(b, new BoundedReservoir(512));
    }
    this.#topProvingWall = new TopKCollector<TailSample>(
      topKCapacity,
      (item) => item.wallDurationMs,
      (item) => item.operationId,
    );
    this.#topProofCpu = new TopKCollector<TailSample>(
      topKCapacity,
      (item) => item.activeProofCpuMs,
      (item) => item.operationId,
    );
    this.#topMoveLatencies = new TopKCollector<MoveTailSample>(
      topKCapacity,
      (item) => item.latencyMs,
      (item) => `${item.gameId}:${item.resultPly}`,
    );
  }

  setGameBasePly(gameId: string, basePly: number): void {
    this.#gameBasePly.set(gameId, basePly);
  }

  getGameBasePly(gameId: string): number {
    return this.#gameBasePly.get(gameId) ?? 0;
  }

  getObservedMoveCount(gameId: string): number {
    return this.#observedMovesByGame.get(gameId)?.length ?? 0;
  }

  getObservedMovesForGame(gameId: string): readonly ObservedMoveRecord[] {
    return this.#observedMovesByGame.get(gameId) ?? [];
  }

  recordFaultStart(name: string, atMs: number, finiteDurationMs?: number): void {
    this.#faults.push({ name, startMs: atMs, finiteDurationMs });
  }

  recordFaultEnd(name: string, atMs: number): void {
    const existing = [...this.#faults].reverse().find((f) => f.name === name && f.endMs === undefined);
    if (existing) {
      existing.endMs = atMs;
    }
  }

  onMovePending(gameId: string, basePly: number, atMs: number, context?: MovePositionContext): void {
    const expectedPly = basePly + 1;
    if (this.#observedPlys.has(`${gameId}:${expectedPly}`)) {
      return;
    }
    const uci = context?.uci;
    const key = uci ? `${gameId}:${expectedPly}:${uci}` : `${gameId}:${expectedPly}`;
    const existing = this.#pendingMoves.get(key);

    const retainsContext = existing?.isAmbiguous === true;
    const effectiveAtMs = retainsContext && existing ? existing.atMs : atMs;
    const effectiveContext = retainsContext && existing?.positionContext ? existing.positionContext : context;

    this.#pendingMoves.set(key, {
      gameId,
      basePly,
      expectedPly,
      atMs: effectiveAtMs,
      positionContext: effectiveContext,
      uci,
      isAmbiguous: retainsContext,
    });
    this.#gameBasePly.set(gameId, basePly);
    if (context) {
      if (this.#gamePositionContexts.size >= 512) {
        const oldest = this.#gamePositionContexts.keys().next().value;
        if (oldest) this.#gamePositionContexts.delete(oldest);
      }
      this.#gamePositionContexts.set(`${gameId}:${basePly}`, context);
    }
  }

  #recordMatchedMove(
    match: { gameId: string; resultPly: number; provenance: MoveObservationProvenance; uci?: string },
    pending: PendingMoveRecord,
    atMs: number,
  ): number | undefined {
    const identityKey = `${match.gameId}:${match.resultPly}`;
    if (this.#observedPlys.has(identityKey)) {
      return undefined;
    }
    this.#observedPlys.add(identityKey);

    const latency = atMs - pending.atMs;
    this.#moveLatencies.record(latency);
    this.#matchedMovesCount++;
    this.#provenanceCounts[match.provenance]++;

    const effectiveUci = match.uci ?? pending.uci ?? '';
    const records = this.#observedMovesByGame.get(match.gameId) ?? [];
    records.push({ gameId: match.gameId, ply: match.resultPly, uci: effectiveUci });
    this.#observedMovesByGame.set(match.gameId, records);

    const faultCheck = isFaultAssociated(pending.atMs, atMs, this.#faults, false);
    this.#topMoveLatencies.record({
      gameId: match.gameId,
      basePly: pending.basePly,
      resultPly: match.resultPly,
      latencyMs: +(latency.toFixed(1)),
      faultAssociated: faultCheck.faultAssociated,
      faultReasons: faultCheck.faultReasons,
      positionContext: pending.positionContext,
      provenance: match.provenance,
    });
    return latency;
  }

  #cleanupPendingForPly(gameId: string, ply: number): void {
    const prefix = `${gameId}:${ply}`;
    for (const k of [...this.#pendingMoves.keys()]) {
      if (k === prefix || k.startsWith(`${prefix}:`)) {
        this.#pendingMoves.delete(k);
      }
    }
  }

  onMoveBroadcast(gameId: string, broadcastPly: number, atMs: number, uci?: string): number | undefined {
    if (this.#observedPlys.has(`${gameId}:${broadcastPly}`)) {
      return undefined;
    }

    let matchedKey: string | undefined;
    let pending: PendingMoveRecord | undefined;

    if (uci !== undefined) {
      const exactKey = `${gameId}:${broadcastPly}:${uci}`;
      pending = this.#pendingMoves.get(exactKey);
      if (pending) {
        matchedKey = exactKey;
      }
    }
    if (!pending) {
      const fallbackKey = `${gameId}:${broadcastPly}`;
      const candidate = this.#pendingMoves.get(fallbackKey);
      if (candidate && (uci === undefined || candidate.uci === undefined || candidate.uci === uci)) {
        pending = candidate;
        matchedKey = fallbackKey;
      }
    }
    if (!pending && uci === undefined) {
      for (const [k, p] of this.#pendingMoves.entries()) {
        if (p.gameId === gameId && p.expectedPly === broadcastPly) {
          pending = p;
          matchedKey = k;
          break;
        }
      }
    }

    if (!pending || !matchedKey) return undefined;

    this.#pendingMoves.delete(matchedKey);
    this.#cleanupPendingForPly(gameId, broadcastPly);
    return this.#recordMatchedMove(
      { gameId, resultPly: broadcastPly, provenance: 'move_broadcast', uci },
      pending,
      atMs,
    );
  }

  onStateBroadcast(
    gameId: string,
    statePly: number,
    atMs: number,
    moves?: readonly DurableMoveLedgerEntry[],
  ): number | undefined {
    return this.#onStateObserved(
      { gameId, statePly, atMs, provenance: 'state_broadcast' },
      moves,
    );
  }

  onRecoveryResponse(
    gameId: string,
    recoveryPly: number,
    atMs: number,
    moves?: readonly DurableMoveLedgerEntry[],
  ): number | undefined {
    return this.#onStateObserved(
      { gameId, statePly: recoveryPly, atMs, provenance: 'recovery_response' },
      moves,
    );
  }

  #onStateObserved(
    obs: {
      readonly gameId: string;
      readonly statePly: number;
      readonly atMs: number;
      readonly provenance: MoveObservationProvenance;
    },
    moves?: readonly DurableMoveLedgerEntry[],
  ): number | undefined {
    let lastLatency: number | undefined;
    const hasLedger = moves !== undefined;
    const ledgerMap = hasLedger ? new Map(moves.map((m) => [m.ply, m.uci])) : undefined;

    for (const key of [...this.#pendingMoves.keys()]) {
      const pending = this.#pendingMoves.get(key);
      if (!pending || pending.gameId !== obs.gameId || pending.expectedPly > obs.statePly) {
        continue;
      }

      let matchedUci: string | undefined;
      if (hasLedger) {
        if (!ledgerMap!.has(pending.expectedPly)) {
          continue;
        }
        const durableUci = ledgerMap!.get(pending.expectedPly);
        if (pending.uci !== undefined && durableUci !== pending.uci) {
          continue;
        }
        matchedUci = durableUci;
      } else {
        if (pending.uci !== undefined) {
          continue;
        }
      }

      this.#pendingMoves.delete(key);
      this.#cleanupPendingForPly(obs.gameId, pending.expectedPly);
      const latency = this.#recordMatchedMove(
        {
          gameId: obs.gameId,
          resultPly: pending.expectedPly,
          provenance: obs.provenance,
          uci: matchedUci,
        },
        pending,
        obs.atMs,
      );
      if (latency !== undefined) {
        lastLatency = latency;
      }
    }
    return lastLatency;
  }

  onMoveFailed(
    gameId: string,
    basePly: number,
    outcome: MoveFailureOutcome = 'definite_failure',
    uci?: string,
  ): void {
    const expectedPly = basePly + 1;
    if (uci !== undefined) {
      const key = `${gameId}:${expectedPly}:${uci}`;
      const target = this.#pendingMoves.get(key);
      if (target) {
        if (outcome === 'ambiguous_commit') {
          target.isAmbiguous = true;
        } else if (!target.isAmbiguous) {
          this.#pendingMoves.delete(key);
        }
      }
      return;
    }

    const prefix = `${gameId}:${expectedPly}`;
    for (const [k, p] of this.#pendingMoves.entries()) {
      if (k === prefix || k.startsWith(`${prefix}:`)) {
        if (outcome === 'ambiguous_commit') {
          p.isAmbiguous = true;
        } else if (!p.isAmbiguous) {
          this.#pendingMoves.delete(k);
        }
      }
    }
    if (outcome === 'definite_failure') {
      const hasAmbiguous = [...this.#pendingMoves.values()].some(
        (p) => p.gameId === gameId && p.basePly === basePly && p.isAmbiguous,
      );
      if (!hasAmbiguous) {
        this.#gamePositionContexts.delete(`${gameId}:${basePly}`);
      }
    }
  }

  onProvingState(gameId: string, isProving: boolean, atMs: number): void {
    if (isProving && !this.#provingSince.has(gameId)) {
      this.#provingSince.set(gameId, atMs);
    } else if (!isProving && this.#provingSince.has(gameId)) {
      const dur = atMs - this.#provingSince.get(gameId)!;
      this.#provingDurations.record(dur);
      this.#provingSince.delete(gameId);
    }
  }

  onStoppedState(gameId: string, isStopped: boolean, atMs: number): void {
    if (isStopped && !this.#stoppedSince.has(gameId)) {
      this.#stoppedSince.set(gameId, atMs);
    } else if (!isStopped && this.#stoppedSince.has(gameId)) {
      const dur = atMs - this.#stoppedSince.get(gameId)!;
      this.#stoppedDurations.record(dur);
      this.#stoppedSince.delete(gameId);
    }
  }

  get unresolvedStartsCount(): number {
    return this.#unresolvedStarts.size;
  }

  recordStartRequest(req: StartAdjudicationRequestInput): void {
    if (this.#unresolvedStarts.has(req.operationId)) {
      return;
    }

    const expectedPly = req.basePly + 1;
    let positionContext: MovePositionContext | undefined;
    if (req.uci !== undefined) {
      const candidateKey = `${req.gameId}:${expectedPly}:${req.uci}`;
      const candidate = this.#pendingMoves.get(candidateKey);
      if (candidate?.positionContext && candidate.positionContext.uci === req.uci) {
        positionContext = candidate.positionContext;
      }
    } else {
      const contextless = this.#pendingMoves.get(`${req.gameId}:${expectedPly}`);
      if (contextless && contextless.uci === undefined) {
        positionContext = contextless.positionContext;
      }
    }

    if (this.#unresolvedStarts.size >= 512) {
      const oldest = this.#unresolvedStarts.keys().next().value;
      if (oldest) this.#unresolvedStarts.delete(oldest);
    }
    this.#unresolvedStarts.set(req.operationId, {
      gameId: req.gameId,
      operationId: req.operationId,
      basePly: req.basePly,
      entryAtMs: req.atMs,
      uci: req.uci,
      positionContext,
    });
  }

  clearUnresolvedStart(operationId: string): void {
    this.#unresolvedStarts.delete(operationId);
  }

  recordStartNoop(operationId: string): void {
    this.clearUnresolvedStart(operationId);
  }

  recordStartAttempt(durationMs: number, basePly: number): void {
    const bucket = plyBucket(basePly);
    this.#startDurationsByBucket.get(bucket)!.record(durationMs);
    this.#getStoreMetric('startAdjudication').record(durationMs);
  }

  recordStartAdmitted(gameId: string, operationId: string, basePly: number, durationMs: number): void {
    const unresolved = this.#unresolvedStarts.get(operationId);
    if (unresolved) {
      this.#unresolvedStarts.delete(operationId);
    }
    const op = this.#activeOps.get(operationId);
    if (op) {
      if (op.admissionDurationMs === 0) {
        op.admissionDurationMs = durationMs;
      }
      if (!op.positionContext && unresolved?.positionContext) {
        op.positionContext = unresolved.positionContext;
      }
      return;
    }

    if (
      this.#completedOps.has(operationId) ||
      this.#settledAwaitingRelease.has(operationId) ||
      this.#completedSamples.has(operationId)
    ) {
      const settledSample = this.#completedSamples.get(operationId) ?? this.#settledAwaitingRelease.get(operationId);
      if (settledSample && settledSample.evidence.admissionDurationMs === 0) {
        settledSample.evidence.admissionDurationMs = +(durationMs.toFixed(1));
        const startMs = settledSample.evidence.hasBoundStart
          ? settledSample.evidence.admissionStartMs
          : (unresolved ? unresolved.entryAtMs : performance.now() - durationMs);
        settledSample.evidence.admissionStartMs = +(startMs.toFixed(1));
        settledSample.evidence.hasBoundStart = true;
        const endWall = settledSample.evidence.releaseCommittedAtMs ?? settledSample.evidence.settleCommittedAtMs;
        if (endWall !== undefined) {
          settledSample.wallDurationMs = +(
            Math.max(settledSample.wallDurationMs, endWall - startMs).toFixed(1)
          );
          settledSample.evidence.totalWallMs = settledSample.wallDurationMs;
        }
        this.#topProvingWall.record(settledSample);
        this.#topProofCpu.record(settledSample);
      }
      return;
    }

    const positionContext = unresolved?.positionContext;
    const admissionStartAt = unresolved ? unresolved.entryAtMs : performance.now() - durationMs;
    const effectiveBasePly = unresolved ? unresolved.basePly : basePly;
    this.#activeOps.set(operationId, {
      operationId,
      gameId,
      basePly: effectiveBasePly,
      resultPly: effectiveBasePly + 1,
      admissionStartAt,
      admissionDurationMs: durationMs,
      hasBoundStart: true,
      claims: [],
      isTakeover: false,
      claimGapWallMs: 0,
      activeProofSliceWallMs: 0,
      activeProofCpuMs: 0,
      steps: 0,
      slices: 0,
      roles: [],
      questionKind: 'unknown/inferred',
      settleAttempts: 0,
      settleDbWallMs: 0,
      positionContext,
    });
  }

  recordClaim(claim: ClaimEvidenceInput): void {
    const now = performance.now();
    let op = this.#activeOps.get(claim.operationId);
    if (!op) {
      const unresolved = this.#unresolvedStarts.get(claim.operationId);
      if (unresolved) {
        this.#unresolvedStarts.delete(claim.operationId);
      }
      const basePly = unresolved ? unresolved.basePly : this.getGameBasePly(claim.gameId);
      op = {
        operationId: claim.operationId,
        gameId: claim.gameId,
        basePly,
        resultPly: basePly + 1,
        admissionStartAt: unresolved ? unresolved.entryAtMs : now,
        admissionDurationMs: 0,
        hasBoundStart: unresolved !== undefined,
        claims: [],
        isTakeover: false,
        claimGapWallMs: 0,
        activeProofSliceWallMs: 0,
        activeProofCpuMs: 0,
        steps: 0,
        slices: 0,
        roles: [],
        questionKind: 'unknown/inferred',
        settleAttempts: 0,
        settleDbWallMs: 0,
        positionContext: unresolved?.positionContext,
      };
      this.#activeOps.set(claim.operationId, op);
    }
    const claimRecord: ClaimTimelineRecord = {
      executorId: claim.executorId,
      generation: claim.generation,
      claimedAtMonotonicMs: now,
      leaseDeadlineEpochMs: claim.leaseUntil.getTime(),
    };
    if (op.claims.length > 0) {
      const prevClaim = op.claims[op.claims.length - 1]!;
      if (prevClaim.executorId !== claim.executorId) {
        if (!op.isTakeover) {
          this.#successorTakeoversCount++;
        }
        op.isTakeover = true;
        op.claimGapWallMs += Math.max(0, now - prevClaim.claimedAtMonotonicMs);
      }
    }
    op.claims.push(claimRecord);
  }

  recordStep(operationId: string, wallMs: number, cpuMs: number, deltaWork: number): void {
    const op = this.#activeOps.get(operationId);
    if (op) {
      op.activeProofSliceWallMs += wallMs;
      op.activeProofCpuMs += cpuMs;
      op.steps += deltaWork;
      op.slices += 1;
    }
  }

  recordRoles(operationId: string, roles: readonly string[], questionKind: string): void {
    const op = this.#activeOps.get(operationId);
    if (op) {
      op.roles = roles;
      op.questionKind = questionKind;
    }
  }

  recordSettleAttempt(operationId: string, durationMs: number): void {
    const op = this.#activeOps.get(operationId);
    const basePly = op ? op.basePly : 0;
    const bucket = plyBucket(basePly);
    this.#settleDurationsByBucket.get(bucket)!.record(durationMs);
    this.#getStoreMetric('settleAdjudication').record(durationMs);
    if (op) {
      op.settleAttempts++;
      op.settleDbWallMs += durationMs;
    }
  }

  recordSettlementCommitted(operationId: string): void {
    const op = this.#activeOps.get(operationId);
    if (!op) return;
    const endMs = performance.now();
    const totalWall = endMs - op.admissionStartAt;
    op.settleCommittedAtMs = endMs;
    this.#activeProofCpu.record(op.activeProofCpuMs);
    this.#activeProofSliceWall.record(op.activeProofSliceWallMs);

    const faultCheck = isFaultAssociated(op.admissionStartAt, endMs, this.#faults, op.isTakeover);
    const firstClaim = op.claims[0];
    const lastClaim = op.claims[op.claims.length - 1];

    const tailSample: TailSample = {
      operationId: op.operationId,
      gameId: op.gameId,
      basePly: op.basePly,
      resultPly: op.resultPly,
      wallDurationMs: +(totalWall.toFixed(1)),
      activeProofCpuMs: +(op.activeProofCpuMs.toFixed(1)),
      activeProofSliceWallMs: +(op.activeProofSliceWallMs.toFixed(1)),
      proofSteps: op.steps,
      proofSlices: op.slices,
      roles: op.roles,
      questionKind: op.questionKind,
      isCausalTakeover: op.isTakeover,
      faultAssociated: faultCheck.faultAssociated,
      faultReasons: faultCheck.faultReasons,
      evidence: {
        admissionStartMs: +(op.admissionStartAt.toFixed(1)),
        admissionDurationMs: +(op.admissionDurationMs.toFixed(1)),
        hasBoundStart: op.hasBoundStart,
        firstClaimAtMs: firstClaim ? +(firstClaim.claimedAtMonotonicMs.toFixed(1)) : undefined,
        firstExecutorId: firstClaim?.executorId,
        lastClaimAtMs: lastClaim ? +(lastClaim.claimedAtMonotonicMs.toFixed(1)) : undefined,
        lastExecutorId: lastClaim?.executorId,
        claimsCount: op.claims.length,
        claims: op.claims,
        isTakeover: op.isTakeover,
        claimGapWallMs: +(op.claimGapWallMs.toFixed(1)),
        activeProofSliceWallMs: +(op.activeProofSliceWallMs.toFixed(1)),
        activeProofCpuMs: +(op.activeProofCpuMs.toFixed(1)),
        proofSteps: op.steps,
        proofSlices: op.slices,
        settleAttempts: op.settleAttempts,
        settleDbWallMs: +(op.settleDbWallMs.toFixed(1)),
        settleCommittedAtMs: +(endMs.toFixed(1)),
        totalWallMs: +(totalWall.toFixed(1)),
      },
      positionContext: op.positionContext,
    };

    this.#topProvingWall.record(tailSample);
    this.#topProofCpu.record(tailSample);
    this.#settledCommittedCount++;
    this.#activeOps.delete(operationId);
    this.#unresolvedStarts.delete(operationId);

    if (this.#settledAwaitingRelease.size >= 256) {
      const oldest = this.#settledAwaitingRelease.keys().next().value;
      if (oldest) this.#settledAwaitingRelease.delete(oldest);
    }
    this.#settledAwaitingRelease.set(operationId, tailSample);
    if (this.#completedSamples.size >= 256) {
      const oldestSample = this.#completedSamples.keys().next().value;
      if (oldestSample) this.#completedSamples.delete(oldestSample);
    }
    this.#completedSamples.set(operationId, tailSample);
    if (this.#completedOps.size >= 1024) {
      const oldestCompleted = this.#completedOps.values().next().value;
      if (oldestCompleted) this.#completedOps.delete(oldestCompleted);
    }
    this.#completedOps.add(operationId);
    this.#gamePositionContexts.delete(`${op.gameId}:${op.basePly}`);
  }

  recordReleaseAttempt(durationMs: number): void {
    this.#getStoreMetric('releaseClocks').record(durationMs);
  }

  recordReleaseCommitted(stopOperationId: string, durationMs: number): void {
    const now = performance.now();
    const tailSample = this.#settledAwaitingRelease.get(stopOperationId) ?? this.#completedSamples.get(stopOperationId);
    if (tailSample) {
      const releaseDuration = +(durationMs.toFixed(1));
      const releaseCommittedAt = +(now.toFixed(1));
      const updatedTotalWall = +(Math.max(tailSample.wallDurationMs, now - tailSample.evidence.admissionStartMs).toFixed(1));
      tailSample.evidence.releaseDurationMs = releaseDuration;
      tailSample.evidence.releaseCommittedAtMs = releaseCommittedAt;
      tailSample.evidence.totalWallMs = updatedTotalWall;
      tailSample.wallDurationMs = updatedTotalWall;
      this.#settledAwaitingRelease.delete(stopOperationId);
      this.#topProvingWall.record(tailSample);
      this.#topProofCpu.record(tailSample);
    }
  }

  recordStoreCall(name: string, durationMs: number): void {
    this.#getStoreMetric(name).record(durationMs);
  }

  #getStoreMetric(name: string): BoundedReservoir {
    let m = this.#storeMetrics.get(name);
    if (!m) {
      m = new BoundedReservoir(1024);
      this.#storeMetrics.set(name, m);
    }
    return m;
  }

  get matchedMovesCount(): number {
    return this.#matchedMovesCount;
  }

  get settledCommittedCount(): number {
    return this.#settledCommittedCount;
  }

  get activeOpsCount(): number {
    return this.#activeOps.size;
  }

  get successorTakeoversCount(): number {
    return this.#successorTakeoversCount;
  }

  get positionContextsCount(): number {
    return this.#gamePositionContexts.size;
  }

  get moveLatencyProvenanceCounts(): MoveLatencyProvenanceCounts {
    return { ...this.#provenanceCounts };
  }

  getOperationClaims(operationId: string): readonly ClaimTimelineRecord[] | undefined {
    const active = this.#activeOps.get(operationId);
    if (active) return active.claims;
    const settled = this.#completedSamples.get(operationId) ?? this.#settledAwaitingRelease.get(operationId);
    return settled?.evidence.claims;
  }

  isOperationSettled(operationId: string): boolean {
    return (
      this.#completedOps.has(operationId) ||
      this.#settledAwaitingRelease.has(operationId) ||
      this.#completedSamples.has(operationId)
    );
  }

  getOperationQueuedMs(operationId: string): number | undefined {
    const active = this.#activeOps.get(operationId);
    if (active) {
      if (!active.hasBoundStart || active.claims.length === 0) return undefined;
      return +(Math.max(0, active.claims[0]!.claimedAtMonotonicMs - active.admissionStartAt).toFixed(1));
    }
    const settled = this.#completedSamples.get(operationId) ?? this.#settledAwaitingRelease.get(operationId);
    if (!settled || !settled.evidence.hasBoundStart || settled.evidence.firstClaimAtMs === undefined) {
      return undefined;
    }
    return +(Math.max(0, settled.evidence.firstClaimAtMs - settled.evidence.admissionStartMs).toFixed(1));
  }

  getMoveLatencyQuantiles(): MoveLatencySummary {
    const summary = this.#moveLatencies.summary;
    return {
      ...summary,
      provenance: this.moveLatencyProvenanceCounts,
      note: 'Latency is in-process simulated-player API/pubsub visibility, excluding network/browser/WebSocket recovery time.',
    };
  }

  getProvingWallQuantiles(): MetricSummary {
    return this.#provingDurations.summary;
  }

  getStoppedQuantiles(): MetricSummary {
    return this.#stoppedDurations.summary;
  }

  getActiveProofCpuQuantiles(): MetricSummary {
    return this.#activeProofCpu.summary;
  }

  getActiveProofSliceWallQuantiles(): MetricSummary {
    return this.#activeProofSliceWall.summary;
  }

  getValidationCostByPly(): Record<PlyBucket, { startAdjudication: MetricSummary; settleAdjudication: MetricSummary }> {
    const result = {} as Record<PlyBucket, { startAdjudication: MetricSummary; settleAdjudication: MetricSummary }>;
    for (const b of PLY_BUCKETS) {
      result[b] = {
        startAdjudication: this.#startDurationsByBucket.get(b)!.summary,
        settleAdjudication: this.#settleDurationsByBucket.get(b)!.summary,
      };
    }
    return result;
  }

  getStoreMs(): Record<string, MetricSummary> {
    return Object.fromEntries(
      [...this.#storeMetrics].map(([k, m]) => [k, m.summary]),
    );
  }

  getTopMoveLatency(): readonly MoveTailSample[] {
    return this.#topMoveLatencies.items;
  }

  getTopProvingWall(): readonly TailSample[] {
    return this.#topProvingWall.items;
  }

  getTopProofCpu(): readonly TailSample[] {
    return this.#topProofCpu.items;
  }
}

export type LossyTransactionPurpose = 'move_admission' | 'other_admission';

export interface LossyTransactionScope {
  readonly purpose: LossyTransactionPurpose;
  readonly gameId: string;
  readonly operationId: string;
  readonly commandKind: string;
  readonly uci?: string;
  readonly basePly?: number;
  readonly onInjected?: (injection: LostCommitInjectionRecord) => void;
}

export interface MoveRouteCorrelation {
  readonly gameId: string;
  readonly uci: string;
  readonly basePly: number;
  operationId?: string;
  injected?: LostCommitInjectionRecord;
}

export interface LossyCommitControl {
  enabled: boolean;
  targetMinLost: number;
  rate: number;
  targetGameId?: string;
  targetOperationId?: string;
  maxLost?: number;
  requireInsertInTx?: boolean;
}

export type LostCommitRouteOutcome =
  | 'pending'
  | 'uncertain_error'
  | 'unexpected_success'
  | 'non_uncertain_error';

export interface LostCommitInjectionRecord {
  readonly gameId: string;
  readonly operationId: string;
  readonly purpose: LossyTransactionPurpose;
  readonly commandKind: string;
  readonly uci: string;
  readonly basePly?: number;
  readonly hadInsertInTx: boolean;
  readonly injectedAtMs: number;
  routeOutcome: LostCommitRouteOutcome;
  routeErrorName?: string;
  admissionVerified?: boolean;
  durableVerified: boolean;
  durableResultPly?: number;
  durableStartedSeq?: number;
  durableResolvedSeq?: number;
}

export interface LossyCommitCounter {
  lost: number;
  readonly injectedOperationIds?: Set<string>;
  readonly injections?: LostCommitInjectionRecord[];
  onInjected?: (record: LostCommitInjectionRecord) => void;
}

export interface DurableLostCommitAdmissionEvidence {
  readonly gameId: string;
  readonly operationId: string;
  readonly executionState: string;
  readonly startedSeq: number | null;
  readonly events: readonly {
    readonly seq: number;
    readonly type: string;
    readonly payload: unknown;
  }[];
}

export type DurableLostCommitAdmissionVerificationResult =
  | {
      readonly valid: true;
      readonly startedSeq: number;
      readonly executionState: 'proving' | 'completed';
    }
  | {
      readonly valid: false;
      readonly reason: string;
    };

export interface DurableLostCommitEvidence extends DurableLostCommitAdmissionEvidence {
  readonly finalSeq: number | null;
}

export type DurableLostCommitVerificationResult =
  | {
      readonly valid: true;
      readonly resultPly: number;
      readonly startedSeq: number;
      readonly resolvedSeq: number;
    }
  | {
      readonly valid: false;
      readonly reason: string;
    };

const lossyTransactionStorage = new AsyncLocalStorage<LossyTransactionScope>();
const moveRouteCorrelationStorage = new AsyncLocalStorage<MoveRouteCorrelation>();

/** Runs an async operation inside a scoped transaction purpose for lossy COMMIT targeting. */
export function runWithLossyTransactionScope<T>(
  scope: LossyTransactionScope,
  fn: () => Promise<T>,
): Promise<T> {
  return lossyTransactionStorage.run(scope, fn);
}

/** Returns the active transaction scope, if any. */
export function getCurrentLossyTransactionScope(): LossyTransactionScope | undefined {
  return lossyTransactionStorage.getStore();
}

/** Runs a routed move attempt inside an AsyncLocalStorage correlation slot. */
export function runWithMoveRouteCorrelation<T>(
  correlation: MoveRouteCorrelation,
  fn: () => Promise<T>,
): Promise<T> {
  return moveRouteCorrelationStorage.run(correlation, fn);
}

/** Returns the active move route correlation slot, if any. */
export function getCurrentMoveRouteCorrelation(): MoveRouteCorrelation | undefined {
  return moveRouteCorrelationStorage.getStore();
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

function extractSqlText(sql: unknown): string | undefined {
  if (typeof sql === 'string') return sql;
  if (isPlainRecord(sql) && typeof sql['text'] === 'string') {
    return sql['text'];
  }
  return undefined;
}

type SqlCommandKind = 'BEGIN' | 'COMMIT' | 'ROLLBACK' | 'INSERT' | 'OTHER';

function classifySqlCommand(sqlText: string | undefined): SqlCommandKind {
  if (sqlText === undefined) return 'OTHER';
  const upper = sqlText.trim().toUpperCase();
  if (upper === 'BEGIN' || upper === 'BEGIN;' || upper.startsWith('BEGIN ') || upper.startsWith('START TRANSACTION')) {
    return 'BEGIN';
  }
  if (upper === 'COMMIT' || upper === 'COMMIT;' || upper.startsWith('COMMIT ')) {
    return 'COMMIT';
  }
  if (upper === 'ROLLBACK' || upper === 'ROLLBACK;' || upper.startsWith('ROLLBACK ')) {
    return 'ROLLBACK';
  }
  if (upper.startsWith('INSERT')) {
    return 'INSERT';
  }
  return 'OTHER';
}

function isEligibleMoveAdmissionScope(
  scope: LossyTransactionScope | undefined,
  control: LossyCommitControl,
): scope is LossyTransactionScope & { readonly uci: string } {
  if (!scope) return false;
  if (scope.purpose !== 'move_admission' || scope.commandKind !== 'move') return false;
  if (scope.gameId.length === 0 || scope.operationId.length === 0) return false;
  if (typeof scope.uci !== 'string' || scope.uci.length === 0) return false;
  if (control.targetGameId !== undefined && scope.gameId !== control.targetGameId) return false;
  if (control.targetOperationId !== undefined && scope.operationId !== control.targetOperationId) return false;
  return true;
}

/**
 * Wraps a pg Pool so only scoped move-admission COMMIT replies are dropped after PostgreSQL
 * commits them. Ordinary worker transactions, out-of-scope transactions, duplicate retries of
 * an already-injected operationId, and underlying query failures are never misattributed.
 */
export function lossyCommits<
  P extends { connect: (...args: never[]) => Promise<object>; query: (...args: never[]) => unknown },
>(
  pool: P,
  control: LossyCommitControl,
  counter: LossyCommitCounter,
  faultRnd: () => number,
): P {
  const seenInjectedOps = counter.injectedOperationIds ?? new Set<string>();

  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        const queryVal = Reflect.get(target, 'query', target);
        return typeof queryVal === 'function' ? queryVal.bind(target) : queryVal;
      }
      if (prop !== 'connect') return Reflect.get(target, prop, receiver);

      const origConnect = target.connect;

      return async (...connectArgs: never[]) => {
        const client = await origConnect.apply(target, connectArgs);
        let inTx = false;
        let sawInsertInTx = false;

        return new Proxy(client, {
          get(c, p, r) {
            if (p !== 'query') {
              const member = Reflect.get(c, p, c);
              return typeof member === 'function' ? member.bind(c) : Reflect.get(c, p, r);
            }
            const origQuery = Reflect.get(c, 'query', c);
            if (typeof origQuery !== 'function') return origQuery;

            return async (...args: unknown[]) => {
              const cmd = classifySqlCommand(extractSqlText(args[0]));
              if (cmd === 'BEGIN') {
                inTx = true;
                sawInsertInTx = false;
              }
              const res: unknown = await (Reflect.apply(origQuery, c, args) as Promise<unknown>);
              if (cmd === 'ROLLBACK') {
                inTx = false;
                sawInsertInTx = false;
                return res;
              }
              if (cmd === 'INSERT' && inTx) {
                sawInsertInTx = true;
              }
              if (cmd === 'COMMIT') {
                const hadInsert = sawInsertInTx;
                inTx = false;
                sawInsertInTx = false;
                const scope = lossyTransactionStorage.getStore();
                if (
                  control.enabled &&
                  isEligibleMoveAdmissionScope(scope, control) &&
                  (!control.requireInsertInTx || hadInsert) &&
                  !seenInjectedOps.has(scope.operationId) &&
                  (control.maxLost === undefined || counter.lost < control.maxLost)
                ) {
                  const shouldDrop =
                    counter.lost < control.targetMinLost ||
                    (control.rate > 0 && faultRnd() < control.rate);
                  if (shouldDrop) {
                    seenInjectedOps.add(scope.operationId);
                    counter.lost++;
                    const record: LostCommitInjectionRecord = {
                      gameId: scope.gameId,
                      operationId: scope.operationId,
                      purpose: scope.purpose,
                      commandKind: scope.commandKind,
                      uci: scope.uci,
                      basePly: scope.basePly,
                      hadInsertInTx: hadInsert,
                      injectedAtMs: performance.now(),
                      routeOutcome: 'pending',
                      admissionVerified: false,
                      durableVerified: false,
                    };
                    counter.injections?.push(record);
                    scope.onInjected?.(record);
                    counter.onInjected?.(record);
                    throw new Error('connection lost after COMMIT');
                  }
                }
              }
              return res;
            };
          },
        });
      };
    },
  });
}

/**
 * Verifies Stage 1 admission durability for an injected lost-COMMIT move admission:
 * exact uncertain route outcome and persisted matching AdjudicationStarted event.
 */
export function verifyLostCommitAdmissionStarted(
  record: LostCommitInjectionRecord,
  evidence: DurableLostCommitAdmissionEvidence,
): DurableLostCommitAdmissionVerificationResult {
  if (record.gameId !== evidence.gameId || record.operationId !== evidence.operationId) {
    return { valid: false, reason: 'gameId or operationId mismatch between injection and durable evidence' };
  }
  if (record.routeOutcome !== 'uncertain_error') {
    return {
      valid: false,
      reason: `routeOutcome was "${record.routeOutcome}", expected "uncertain_error"`,
    };
  }
  if (evidence.executionState !== 'proving' && evidence.executionState !== 'completed') {
    return {
      valid: false,
      reason: `durable execution_state was "${evidence.executionState}", expected "proving" or "completed"`,
    };
  }
  if (evidence.startedSeq === null || !Number.isSafeInteger(evidence.startedSeq) || evidence.startedSeq < 0) {
    return { valid: false, reason: 'missing or invalid startedSeq on admitted adjudication' };
  }

  const startedEvent = evidence.events.find((e) => e.seq === evidence.startedSeq);
  if (!startedEvent || startedEvent.type !== 'AdjudicationStarted' || !isPlainRecord(startedEvent.payload)) {
    return {
      valid: false,
      reason: `missing durable AdjudicationStarted event at startedSeq=${evidence.startedSeq} (found=${startedEvent?.type ?? 'none'})`,
    };
  }
  if (startedEvent.payload['gameId'] !== record.gameId) {
    return {
      valid: false,
      reason: `AdjudicationStarted gameId "${String(startedEvent.payload['gameId'])}" does not match injected gameId "${record.gameId}"`,
    };
  }
  if (startedEvent.payload['operationId'] !== record.operationId) {
    return {
      valid: false,
      reason: `AdjudicationStarted operationId "${String(startedEvent.payload['operationId'])}" does not match injected operationId "${record.operationId}"`,
    };
  }
  const prepared = startedEvent.payload['prepared'];
  if (isPlainRecord(prepared)) {
    if (prepared['gameId'] !== undefined && prepared['gameId'] !== record.gameId) {
      return {
        valid: false,
        reason: `AdjudicationStarted prepared gameId "${String(prepared['gameId'])}" does not match injected gameId "${record.gameId}"`,
      };
    }
    if (prepared['operationId'] !== undefined && prepared['operationId'] !== record.operationId) {
      return {
        valid: false,
        reason: `AdjudicationStarted prepared operationId "${String(prepared['operationId'])}" does not match injected operationId "${record.operationId}"`,
      };
    }
  }
  const intent = isPlainRecord(prepared) && isPlainRecord(prepared['intent']) ? prepared['intent'] : undefined;
  if (!intent || intent['kind'] !== 'move' || intent['uci'] !== record.uci) {
    return {
      valid: false,
      reason: `AdjudicationStarted prepared intent (${String(intent?.['kind'])}:${String(intent?.['uci'])}) does not match admitted move UCI "${record.uci}"`,
    };
  }

  return {
    valid: true,
    startedSeq: evidence.startedSeq,
    executionState: evidence.executionState,
  };
}

/**
 * Verifies durable PostgreSQL evidence proving an injected lost-COMMIT move admission
 * resulted in an uncertain route outcome and persisted the exact admitted operation's move
 * in accordance with settlePrepared ([resolved, ...resolved.effects] written at startedSeq+1..finalSeq).
 */
export function verifyLostCommitDurableEvidence(
  record: LostCommitInjectionRecord,
  evidence: DurableLostCommitEvidence,
): DurableLostCommitVerificationResult {
  const admissionCheck = verifyLostCommitAdmissionStarted(record, evidence);
  if (!admissionCheck.valid) {
    return admissionCheck;
  }
  if (evidence.executionState !== 'completed') {
    return {
      valid: false,
      reason: `durable execution_state was "${evidence.executionState}", expected "completed"`,
    };
  }
  if (
    evidence.finalSeq === null ||
    !Number.isSafeInteger(evidence.finalSeq) ||
    evidence.finalSeq <= admissionCheck.startedSeq
  ) {
    return { valid: false, reason: 'missing or invalid startedSeq/finalSeq bounds on completed adjudication' };
  }
  if (evidence.finalSeq < admissionCheck.startedSeq + 2) {
    return {
      valid: false,
      reason: `completed move adjudication finalSeq=${evidence.finalSeq} must be >= startedSeq+2 (${admissionCheck.startedSeq + 2})`,
    };
  }

  // settlePrepared builds batch [resolved, ...resolved.effects]; appendSettlementBatch inserts resolved at startedSeq + 1
  const resolvedSeq = admissionCheck.startedSeq + 1;
  const resolvedEvent = evidence.events.find((e) => e.seq === resolvedSeq);
  if (!resolvedEvent || resolvedEvent.type !== 'AdjudicationResolved' || !isPlainRecord(resolvedEvent.payload)) {
    return {
      valid: false,
      reason: `missing durable AdjudicationResolved event at startedSeq+1 (${resolvedSeq}, found=${resolvedEvent?.type ?? 'none'})`,
    };
  }
  if (
    typeof resolvedEvent.payload['gameId'] === 'string' &&
    resolvedEvent.payload['gameId'] !== record.gameId
  ) {
    return { valid: false, reason: 'AdjudicationResolved gameId does not match injected gameId' };
  }
  if (
    resolvedEvent.payload['operationId'] !== record.operationId ||
    resolvedEvent.payload['startedSeq'] !== admissionCheck.startedSeq
  ) {
    return { valid: false, reason: 'AdjudicationResolved operationId or startedSeq mismatch' };
  }

  const rawEffects = resolvedEvent.payload['effects'];
  if (!Array.isArray(rawEffects) || rawEffects.length === 0) {
    return { valid: false, reason: 'AdjudicationResolved missing non-empty declared effects array' };
  }
  if (evidence.finalSeq !== resolvedSeq + rawEffects.length) {
    return {
      valid: false,
      reason: `finalSeq=${evidence.finalSeq} does not match resolvedSeq+effects.length (${resolvedSeq + rawEffects.length})`,
    };
  }

  for (const [idx, effect] of rawEffects.entries()) {
    if (!isPlainRecord(effect) || typeof effect['type'] !== 'string') {
      return { valid: false, reason: `AdjudicationResolved declared effect[${idx}] missing valid type` };
    }
    if (effect['type'] === 'GameEnded' && idx !== rawEffects.length - 1) {
      return { valid: false, reason: 'AdjudicationResolved declared GameEnded must be final effect' };
    }
    const effectSeq = resolvedSeq + 1 + idx;
    const persisted = evidence.events.find((e) => e.seq === effectSeq);
    if (!persisted || persisted.type !== effect['type'] || !isPlainRecord(persisted.payload)) {
      return {
        valid: false,
        reason: `persisted event at seq=${effectSeq} (found=${persisted?.type ?? 'none'}) does not match declared effect[${idx}] type "${effect['type']}"`,
      };
    }
  }

  const declaredMoves = rawEffects
    .map((effect, idx) => ({ effect, idx }))
    .filter((entry): entry is { effect: Record<string, unknown>; idx: number } =>
      isPlainRecord(entry.effect) && entry.effect['type'] === 'MovePlayed',
    );
  if (declaredMoves.length !== 1) {
    return {
      valid: false,
      reason: `AdjudicationResolved declared effects contain ${declaredMoves.length} MovePlayed entries, expected 1`,
    };
  }

  const { effect: declaredMove, idx: declaredMoveIdx } = declaredMoves[0]!;
  if (declaredMove['uci'] !== record.uci) {
    return {
      valid: false,
      reason: `declared MovePlayed UCI "${String(declaredMove['uci'])}" != "${record.uci}"`,
    };
  }
  const declaredPly = declaredMove['ply'];
  if (typeof declaredPly !== 'number' || !Number.isSafeInteger(declaredPly)) {
    return { valid: false, reason: 'declared MovePlayed missing valid integer ply' };
  }
  if (record.basePly !== undefined && declaredPly !== record.basePly + 1) {
    return { valid: false, reason: `declared MovePlayed ply ${declaredPly} != expected ${record.basePly + 1}` };
  }

  const moveSeq = resolvedSeq + 1 + declaredMoveIdx;
  const moveEvent = evidence.events.find((e) => e.seq === moveSeq);
  if (!moveEvent || moveEvent.type !== 'MovePlayed' || !isPlainRecord(moveEvent.payload)) {
    return {
      valid: false,
      reason: `missing durable MovePlayed event at expected seq=${moveSeq} in (${resolvedSeq}..${evidence.finalSeq}]`,
    };
  }
  if (moveEvent.payload['uci'] !== record.uci) {
    return { valid: false, reason: `MovePlayed UCI "${String(moveEvent.payload['uci'])}" != "${record.uci}"` };
  }
  const resultPly = moveEvent.payload['ply'];
  if (resultPly !== declaredPly) {
    return { valid: false, reason: `persisted MovePlayed ply ${String(resultPly)} != declared ply ${declaredPly}` };
  }
  if (typeof declaredMove['san'] === 'string' && moveEvent.payload['san'] !== declaredMove['san']) {
    return { valid: false, reason: 'persisted MovePlayed san does not match declared effect san' };
  }
  if (typeof declaredMove['by'] === 'string' && moveEvent.payload['by'] !== declaredMove['by']) {
    return { valid: false, reason: 'persisted MovePlayed by does not match declared effect by' };
  }

  return {
    valid: true,
    resultPly: declaredPly,
    startedSeq: admissionCheck.startedSeq,
    resolvedSeq,
  };
}

/**
 * Tracks correlated move-admission lost-COMMIT injections, enforces uncertain route outcomes,
 * and counts committed moves only after matching durable PostgreSQL evidence is verified.
 */
export class LostCommitTracker {
  readonly #records = new Map<string, LostCommitInjectionRecord>();
  #uncertainRouteCount = 0;
  #verifiedCommittedCount = 0;
  #lastFailureReason: string | undefined;

  recordInjection(record: LostCommitInjectionRecord): boolean {
    if (this.#records.has(record.operationId)) {
      return false;
    }
    this.#records.set(record.operationId, record);
    return true;
  }

  recordRouteOutcome(
    operationId: string,
    outcome: Exclude<LostCommitRouteOutcome, 'pending'>,
    errorName?: string,
  ): void {
    const existing = this.#records.get(operationId);
    if (!existing) {
      throw new Error(`Cannot record route outcome for unknown lost-COMMIT operation ${operationId}`);
    }
    if (existing.routeOutcome !== 'pending') {
      return;
    }
    existing.routeOutcome = outcome;
    existing.routeErrorName = errorName;
    if (outcome === 'uncertain_error') {
      this.#uncertainRouteCount++;
    }
  }

  verifyAdmissionStartedDetailed(
    operationId: string,
    evidence: DurableLostCommitAdmissionEvidence,
  ): DurableLostCommitAdmissionVerificationResult {
    const existing = this.#records.get(operationId);
    if (!existing) {
      const reason = `unknown lost-COMMIT operationId ${operationId}`;
      this.#lastFailureReason = reason;
      return { valid: false, reason };
    }
    const check = verifyLostCommitAdmissionStarted(existing, evidence);
    if (!check.valid) {
      this.#lastFailureReason = check.reason;
      return check;
    }
    existing.admissionVerified = true;
    existing.durableStartedSeq = check.startedSeq;
    this.#lastFailureReason = undefined;
    return check;
  }

  verifyDurableEvidenceDetailed(
    operationId: string,
    evidence: DurableLostCommitEvidence,
  ): DurableLostCommitVerificationResult {
    const existing = this.#records.get(operationId);
    if (!existing) {
      const reason = `unknown lost-COMMIT operationId ${operationId}`;
      this.#lastFailureReason = reason;
      return { valid: false, reason };
    }
    if (existing.durableVerified) {
      return {
        valid: true,
        resultPly: existing.durableResultPly ?? (existing.basePly !== undefined ? existing.basePly + 1 : 0),
        startedSeq: existing.durableStartedSeq ?? evidence.startedSeq ?? 0,
        resolvedSeq: existing.durableResolvedSeq ?? (evidence.startedSeq !== null ? evidence.startedSeq + 1 : 0),
      };
    }
    const check = verifyLostCommitDurableEvidence(existing, evidence);
    if (!check.valid) {
      this.#lastFailureReason = check.reason;
      return check;
    }
    existing.durableVerified = true;
    existing.durableResultPly = check.resultPly;
    existing.durableStartedSeq = check.startedSeq;
    existing.durableResolvedSeq = check.resolvedSeq;
    this.#verifiedCommittedCount++;
    this.#lastFailureReason = undefined;
    return check;
  }

  verifyDurableEvidence(operationId: string, evidence: DurableLostCommitEvidence): boolean {
    return this.verifyDurableEvidenceDetailed(operationId, evidence).valid;
  }

  get lastFailureReason(): string | undefined {
    return this.#lastFailureReason;
  }

  get injectedCount(): number {
    return this.#records.size;
  }

  get uncertainRouteCount(): number {
    return this.#uncertainRouteCount;
  }

  get verifiedCommittedCount(): number {
    return this.#verifiedCommittedCount;
  }

  getRecord(operationId: string): LostCommitInjectionRecord | undefined {
    return this.#records.get(operationId);
  }

  getInjections(): readonly LostCommitInjectionRecord[] {
    return [...this.#records.values()];
  }
}

export interface ReplicaIdentity {
  readonly executorId: string;
}

export interface ReplicaPublicationGuard {
  markDisposed(): void;
  readonly isDisposed: boolean;
  readonly publishCount: number;
  readonly appendCount: number;
  readonly broadcastCount: number;
  readonly authorityApplyCount: number;
  readonly staleBlockedCount: number;
  readonly staleAuthorityBlockedCount: number;
  readonly staleAppendBlockedCount: number;
  readonly staleBroadcastBlockedCount: number;
  wrapPublish<TChange extends { readonly gameId: string }>(
    publish: (change: TChange) => Promise<void>,
  ): (change: TChange) => Promise<void>;
  wrapAsyncCall<TArgs extends unknown[], TResult>(
    action: 'authority.apply' | 'eventStore.append' | 'startAdjudication',
    fn: (...args: TArgs) => Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult>;
  wrapSyncBroadcast<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult;
}

/** Guards a replica's publication, authority apply, and event append callbacks against stale/disposed execution. */
export function createReplicaPublicationGuard<R extends ReplicaIdentity>(
  slotIndex: number,
  getActiveReplica: (slotIndex: number) => R | undefined,
  getOwnReplica: () => R | undefined,
): ReplicaPublicationGuard {
  let disposed = false;
  let publishCount = 0;
  let appendCount = 0;
  let broadcastCount = 0;
  let authorityApplyCount = 0;
  let staleBlockedCount = 0;
  let staleAuthorityBlockedCount = 0;
  let staleAppendBlockedCount = 0;
  let staleBroadcastBlockedCount = 0;

  const checkActive = (action: string, onBlocked?: () => void): void => {
    const own = getOwnReplica();
    if (disposed || own === undefined || getActiveReplica(slotIndex) !== own) {
      staleBlockedCount++;
      onBlocked?.();
      throw new Error(
        `Stale replica ${own?.executorId ?? 'uninitialized'} (slot ${slotIndex}) blocked from ${action}`,
      );
    }
  };

  return {
    markDisposed(): void {
      disposed = true;
    },
    get isDisposed(): boolean {
      return disposed;
    },
    get publishCount(): number {
      return publishCount;
    },
    get appendCount(): number {
      return appendCount;
    },
    get broadcastCount(): number {
      return broadcastCount;
    },
    get authorityApplyCount(): number {
      return authorityApplyCount;
    },
    get staleBlockedCount(): number {
      return staleBlockedCount;
    },
    get staleAuthorityBlockedCount(): number {
      return staleAuthorityBlockedCount;
    },
    get staleAppendBlockedCount(): number {
      return staleAppendBlockedCount;
    },
    get staleBroadcastBlockedCount(): number {
      return staleBroadcastBlockedCount;
    },
    wrapPublish<TChange extends { readonly gameId: string }>(
      publish: (change: TChange) => Promise<void>,
    ): (change: TChange) => Promise<void> {
      return async (change: TChange): Promise<void> => {
        checkActive(`publishing for game ${change.gameId}`);
        publishCount++;
        return publish(change);
      };
    },
    wrapAsyncCall<TArgs extends unknown[], TResult>(
      action: 'authority.apply' | 'eventStore.append' | 'startAdjudication',
      fn: (...args: TArgs) => Promise<TResult>,
    ): (...args: TArgs) => Promise<TResult> {
      return async (...args: TArgs): Promise<TResult> => {
        checkActive(action, () => {
          if (action === 'authority.apply') staleAuthorityBlockedCount++;
          else if (action === 'eventStore.append') staleAppendBlockedCount++;
        });
        if (action === 'authority.apply') authorityApplyCount++;
        else if (action === 'eventStore.append') appendCount++;
        return fn(...args);
      };
    },
    wrapSyncBroadcast<TArgs extends unknown[], TResult>(
      fn: (...args: TArgs) => TResult,
    ): (...args: TArgs) => TResult {
      return (...args: TArgs): TResult => {
        checkActive('broadcasting', () => {
          staleBroadcastBlockedCount++;
        });
        broadcastCount++;
        return fn(...args);
      };
    },
  };
}

export type RouteGatePhase = 'active' | 'draining' | 'fenced' | 'aborted';

/**
 * Coordinates in-process route boundary pause, in-flight command drain, draining-worker
 * bypass, and cutover fencing for a replica slot during cold restart.
 */
export class ReplicaRouteGate {
  readonly #slotIndex: number;
  #phase: RouteGatePhase = 'active';
  #inFlight = 0;
  #pausedWaiters = 0;
  #blockedStaleRoutes = 0;
  #abortError: Error | undefined;
  #resumePromise: Promise<void> | undefined;
  #resumeResolve: (() => void) | undefined;
  #resumeReject: ((err: Error) => void) | undefined;
  #drainResolvers: Array<() => void> = [];

  constructor(slotIndex: number) {
    this.#slotIndex = slotIndex;
  }

  get phase(): RouteGatePhase {
    return this.#phase;
  }

  get inFlightCount(): number {
    return this.#inFlight;
  }

  get pausedWaitersCount(): number {
    return this.#pausedWaiters;
  }

  get blockedStaleRoutesCount(): number {
    return this.#blockedStaleRoutes;
  }

  #ensureResumePromise(): Promise<void> {
    if (!this.#resumePromise) {
      this.#resumePromise = new Promise<void>((resolve, reject) => {
        this.#resumeResolve = resolve;
        this.#resumeReject = reject;
      });
      this.#resumePromise.catch(() => {});
    }
    return this.#resumePromise;
  }

  #notifyDrained(): void {
    if (this.#inFlight > 0 || this.#drainResolvers.length === 0) return;
    const resolvers = this.#drainResolvers;
    this.#drainResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  async #waitForDrain(): Promise<void> {
    if (this.#inFlight === 0) return;
    await new Promise<void>((resolve) => {
      this.#drainResolvers.push(resolve);
    });
  }

  #throwIfAborted(): void {
    if (this.#phase === 'aborted') {
      throw this.#abortError!;
    }
  }

  /** Pause new non-bypass work on this slot and drain commands already dispatched. */
  async pauseAndDrain(): Promise<void> {
    this.#throwIfAborted();
    this.#ensureResumePromise();
    if (this.#phase === 'active') {
      this.#phase = 'draining';
    }
    await this.#waitForDrain();
    this.#throwIfAborted();
  }

  /** Drain any remaining bypass calls after workers/resync stop, then fence the slot. */
  async drainAndFence(): Promise<void> {
    this.#throwIfAborted();
    this.#ensureResumePromise();
    if (this.#phase === 'active') {
      this.#phase = 'draining';
    }
    await this.#waitForDrain();
    this.#throwIfAborted();
    this.#phase = 'fenced';
  }

  /** Resume routing once the fresh replica is installed in this slot. */
  resume(): void {
    if (this.#phase === 'aborted') return;
    this.#phase = 'active';
    const resolve = this.#resumeResolve;
    this.#resumePromise = undefined;
    this.#resumeResolve = undefined;
    this.#resumeReject = undefined;
    resolve?.();
  }

  /**
   * Terminally abort this gate on failure/teardown: reject all paused waiters,
   * reject future routes so stale work cannot dispatch, and drain genuine in-flight calls.
   */
  async abort(reason = 'aborted'): Promise<void> {
    if (this.#phase !== 'aborted') {
      this.#phase = 'aborted';
      this.#abortError = new Error(`Slot ${this.#slotIndex} route gate aborted: ${reason}`);
      const reject = this.#resumeReject;
      this.#resumePromise = undefined;
      this.#resumeResolve = undefined;
      this.#resumeReject = undefined;
      reject?.(this.#abortError);
    }
    await this.#waitForDrain();
  }

  async route<R extends { readonly getStats?: () => { readonly disposed: boolean } }, T>(
    isDrainBypass: boolean,
    getReplica: () => R,
    dispatch: (replica: R) => Promise<T>,
  ): Promise<T> {
    if (this.#phase === 'aborted') {
      this.#blockedStaleRoutes++;
      throw this.#abortError!;
    }
    if (!isDrainBypass) {
      while (this.#phase !== 'active') {
        this.#throwIfAborted();
        const waitPromise = this.#ensureResumePromise();
        this.#pausedWaiters++;
        try {
          await waitPromise;
        } finally {
          this.#pausedWaiters--;
        }
      }
    } else if (this.#phase === 'fenced') {
      this.#blockedStaleRoutes++;
      throw new Error(`Slot ${this.#slotIndex} cutover fenced: stale bypass route rejected`);
    }

    const replica = getReplica();
    if (replica.getStats?.().disposed) {
      this.#blockedStaleRoutes++;
      throw new Error(`Slot ${this.#slotIndex} replica is disposed: stale route rejected`);
    }

    this.#inFlight++;
    try {
      return await dispatch(replica);
    } finally {
      this.#inFlight--;
      if (this.#inFlight === 0) {
        this.#notifyDrained();
      }
    }
  }
}
