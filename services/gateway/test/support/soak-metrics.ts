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
}

export interface ReplayedGameLike {
  readonly fen: string;
  readonly adjudication: unknown;
  readonly ply: number;
  readonly turn: string;
  readonly status: { readonly over: boolean };
  readonly drawOffer: string | null;
  snapshot(): {
    readonly clock: {
      readonly remaining: { readonly w: number; readonly b: number };
      readonly turnStartedAt: number | null;
    };
  };
}

export function assertStateViewMatchesReplay(
  view: StateViewSnapshotLike,
  replayed: ReplayedGameLike,
  loggedEventsCount: number,
): void {
  assert.equal(view.fen, replayed.fen, 'owner copy equals replay fen');
  assert.equal(view.stateRevision, loggedEventsCount - 1, 'owner stateRevision equals logged head seq');
  assert.equal(view.adjudication, undefined, 'released or ended, never stuck');
  assert.equal(replayed.adjudication, null, 'replayed adjudication must be null');
  assert.equal(view.ply, replayed.ply, 'owner ply equals replay ply');
  assert.equal(view.turn, replayed.turn, 'owner turn equals replay turn');
  assert.deepEqual(view.status, replayed.status, 'owner status equals replay status');
  assert.equal(view.drawOffer, replayed.drawOffer, 'owner drawOffer equals replay drawOffer');

  const snap = replayed.snapshot();
  assert.equal(view.clock.w, snap.clock.remaining.w, 'owner white clock matches replay snapshot');
  assert.equal(view.clock.b, snap.clock.remaining.b, 'owner black clock matches replay snapshot');
  assert.equal(view.turnStartedAt, snap.clock.turnStartedAt, 'owner turnStartedAt matches replay snapshot');
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
