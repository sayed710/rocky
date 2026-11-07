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
  readonly admissionStartMs: number;
  readonly admissionDurationMs: number;
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
}

export interface MoveTailSample {
  readonly gameId: string;
  readonly basePly: number;
  readonly resultPly: number;
  readonly latencyMs: number;
  readonly faultAssociated: boolean;
  readonly faultReasons: readonly string[];
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

  constructor(capacity: number, scoreFn: (item: T) => number) {
    this.#capacity = capacity;
    this.#scoreFn = scoreFn;
  }

  record(item: T): void {
    const score = this.#scoreFn(item);
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
  readonly basePly: number;
  readonly resultPly: number;
  readonly admissionStartAt: number;
  readonly admissionDurationMs: number;
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
      note: 'Process memory sampled locally. Container 512Mi/500m cgroup limits enforced externally by Docker CLI.',
    };
  }
}

export class SoakMetricsTracker {
  readonly #pendingMoves = new Map<string, { basePly: number; expectedPly: number; atMs: number }>();
  readonly #activeOps = new Map<string, ActiveOperation>();
  readonly #settledAwaitingRelease = new Map<string, TailSample>();
  readonly #gameBasePly = new Map<string, number>();
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

  #matchedMovesCount = 0;
  #settledCommittedCount = 0;
  #successorTakeoversCount = 0;

  constructor(topKCapacity = 10) {
    for (const b of PLY_BUCKETS) {
      this.#startDurationsByBucket.set(b, new BoundedReservoir(512));
      this.#settleDurationsByBucket.set(b, new BoundedReservoir(512));
    }
    this.#topProvingWall = new TopKCollector<TailSample>(topKCapacity, (item) => item.wallDurationMs);
    this.#topProofCpu = new TopKCollector<TailSample>(topKCapacity, (item) => item.activeProofCpuMs);
    this.#topMoveLatencies = new TopKCollector<MoveTailSample>(topKCapacity, (item) => item.latencyMs);
  }

  setGameBasePly(gameId: string, basePly: number): void {
    this.#gameBasePly.set(gameId, basePly);
  }

  getGameBasePly(gameId: string): number {
    return this.#gameBasePly.get(gameId) ?? 0;
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

  onMovePending(gameId: string, basePly: number, atMs: number): void {
    const expectedPly = basePly + 1;
    this.#pendingMoves.set(`${gameId}:${expectedPly}`, { basePly, expectedPly, atMs });
    this.#gameBasePly.set(gameId, basePly);
  }

  onMoveBroadcast(gameId: string, broadcastPly: number, atMs: number): number | undefined {
    const key = `${gameId}:${broadcastPly}`;
    const pending = this.#pendingMoves.get(key);
    if (pending === undefined) return undefined;
    this.#pendingMoves.delete(key);
    const latency = atMs - pending.atMs;
    this.#moveLatencies.record(latency);
    this.#matchedMovesCount++;
    const faultCheck = isFaultAssociated(pending.atMs, atMs, this.#faults, false);
    this.#topMoveLatencies.record({
      gameId,
      basePly: pending.basePly,
      resultPly: broadcastPly,
      latencyMs: +(latency.toFixed(1)),
      faultAssociated: faultCheck.faultAssociated,
      faultReasons: faultCheck.faultReasons,
    });
    return latency;
  }

  onMoveFailed(gameId: string, basePly: number): void {
    const expectedPly = basePly + 1;
    this.#pendingMoves.delete(`${gameId}:${expectedPly}`);
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

  recordStartAttempt(durationMs: number, basePly: number): void {
    const bucket = plyBucket(basePly);
    this.#startDurationsByBucket.get(bucket)!.record(durationMs);
    this.#getStoreMetric('startAdjudication').record(durationMs);
  }

  recordStartAdmitted(gameId: string, operationId: string, basePly: number, durationMs: number): void {
    this.#activeOps.set(operationId, {
      operationId,
      gameId,
      basePly,
      resultPly: basePly + 1,
      admissionStartAt: performance.now() - durationMs,
      admissionDurationMs: durationMs,
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
    });
  }

  recordClaim(claim: ClaimEvidenceInput): void {
    const now = performance.now();
    let op = this.#activeOps.get(claim.operationId);
    if (!op) {
      const basePly = this.getGameBasePly(claim.gameId);
      op = {
        operationId: claim.operationId,
        gameId: claim.gameId,
        basePly,
        resultPly: basePly + 1,
        admissionStartAt: now,
        admissionDurationMs: 0,
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
    };

    this.#topProvingWall.record(tailSample);
    this.#topProofCpu.record(tailSample);
    this.#settledCommittedCount++;
    this.#activeOps.delete(operationId);

    if (this.#settledAwaitingRelease.size >= 256) {
      const oldest = this.#settledAwaitingRelease.keys().next().value;
      if (oldest) this.#settledAwaitingRelease.delete(oldest);
    }
    this.#settledAwaitingRelease.set(operationId, tailSample);
  }

  recordReleaseAttempt(durationMs: number): void {
    this.#getStoreMetric('releaseClocks').record(durationMs);
  }

  recordReleaseCommitted(stopOperationId: string, durationMs: number): void {
    const now = performance.now();
    const tailSample = this.#settledAwaitingRelease.get(stopOperationId);
    if (tailSample) {
      const releaseDuration = +(durationMs.toFixed(1));
      const releaseCommittedAt = +(now.toFixed(1));
      const updatedTotalWall = +(Math.max(tailSample.wallDurationMs, now - tailSample.evidence.admissionStartMs).toFixed(1));
      tailSample.evidence.releaseDurationMs = releaseDuration;
      tailSample.evidence.releaseCommittedAtMs = releaseCommittedAt;
      tailSample.evidence.totalWallMs = updatedTotalWall;
      tailSample.wallDurationMs = updatedTotalWall;
      this.#settledAwaitingRelease.delete(stopOperationId);
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

  getMoveLatencyQuantiles(): MetricSummary {
    return this.#moveLatencies.summary;
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
