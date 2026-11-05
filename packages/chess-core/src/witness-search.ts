/**
 * @packageDocumentation
 * Positive-Only Resumable Witness Discovery Session (Issue #124, Stage 2).
 *
 * References:
 * - Upstream reference code: chasolver (MIT License, Copyright (c) 2021-2026 Miguel Ambrona).
 *
 * Implements a deterministic, selective explicit-stack DFS finder with finite per-call
 * and per-attempt work limits. Both sides cooperate toward an exact canonical checkmate witness.
 *
 * Soundness boundary:
 * - This lane NEVER produces 'impossible' or 'dead'.
 * - Result is strictly 'reachable' (with verified legal witness) or 'pending'.
 * - Depth/width/attempt/time/capacity limits always remain pending.
 * - Discovered witnesses are verified via raw independent legal replay without 50-move/repetition pruning.
 * - Transportable witness length is bounded by MAX_WITNESS_LENGTH (500).
 */

import { opposite, typeOf } from './board';
import { cloneMove, canonicalStateKey } from './cooperative-search';
import { cloneState } from './fen';
import { applyMove, findKing, generateLegalMoves, inCheck } from './movegen';
import { validateAdmittedProofState } from './proof-admission';
import type { Color, Move, PositionState } from './types';

/** Maximum transportable witness path length at finder/controller mint boundary. */
export const MAX_WITNESS_LENGTH = 500;

export const DEFAULT_MAX_RETAINED_FRAMES = 500;

export interface WitnessCounters {
  workUnits: number;
  legalGenerations: number;
  scoringWork: number;
  candidateEvaluations: number;
  candidatesApplied: number;
  backtrackSteps: number;
  cycleRejections: number;
  attemptsStarted: number;
  attemptsCompleted: number;
  maxDepthReached: number;
  retainedFrames: number;
  replayWork: number;
}

export type WitnessPendingReason =
  | 'slice_exhausted'
  | 'attempts_exhausted'
  | 'resource_limit'
  | 'cancelled'
  | 'unsupported_state'
  | 'unsupported_variant';

export type WitnessSearchResult =
  | {
      readonly status: 'reachable';
      readonly winner: Color;
      readonly witness: readonly Move[];
      readonly counters: WitnessCounters;
    }
  | {
      readonly status: 'pending';
      readonly winner: Color;
      readonly reason: WitnessPendingReason;
      readonly counters: WitnessCounters;
    };

export interface WitnessAttemptConfig {
  readonly maxDepth: number;
  readonly maxBranching: number;
  readonly attemptWorkLimit: number;
}

export interface WitnessSearchOptions {
  readonly attempts?: readonly WitnessAttemptConfig[];
  readonly maxRetainedFrames?: number;
  readonly maxWitnessLength?: number;
  /**
   * Guided cooperative playouts run before the depth-first attempts (default
   * {@link DEFAULT_PLAYOUTS}); `false` disables them. They only ever propose a witness, which the
   * same independent replay verifies, so they can make the finder faster but never less sound.
   */
  readonly playouts?: PlayoutConfig | false;
}

/**
 * Guided cooperative playouts: whole games in which the winner heads for the loser's king (and
 * checks every move of its own for mate) while the loser runs its king to a corner, crowds it with
 * its own pieces and never takes the winner's material. Seeded from the root position, so a given
 * position always explores the same playouts.
 */
export interface PlayoutConfig {
  /** Playouts to try before falling back to the depth-first attempts. */
  readonly count: number;
  /** Plies per playout; a witness is at most this long. */
  readonly maxPlies: number;
}

export const DEFAULT_PLAYOUTS: PlayoutConfig = Object.freeze({ count: 40, maxPlies: 120 });

export interface WitnessVerificationResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly terminalState?: PositionState;
}

/** Default progressive attempts schedule: deepens if shallow attempts exhaust allocation. */
export const DEFAULT_ATTEMPTS: readonly WitnessAttemptConfig[] = Object.freeze([
  Object.freeze({ maxDepth: 4, maxBranching: 4, attemptWorkLimit: 1024 }),
  Object.freeze({ maxDepth: 8, maxBranching: 6, attemptWorkLimit: 8192 }),
  Object.freeze({ maxDepth: 12, maxBranching: 8, attemptWorkLimit: 32768 }),
]);

/** Compares all canonical Move fields strictly to reject tampered move metadata. */
export function isCanonicalMoveMatch(a: Move, b: Move): boolean {
  if (a.from !== b.from || a.to !== b.to || a.piece !== b.piece) return false;
  if (a.promotion !== b.promotion || a.captured !== b.captured || a.drop !== b.drop) return false;
  if (a.flags !== b.flags || a.castleRook !== b.castleRook) return false;
  return true;
}

/** Verifies that a candidate witness sequence plays out to target checkmate with full canonical matching. */
export function verifyWitnessPath(
  root: PositionState,
  winner: Color,
  witness: readonly Move[],
): WitnessVerificationResult {
  let current = cloneState(root);
  for (const move of witness) {
    const legals = generateLegalMoves(current);
    const match = legals.find(l => isCanonicalMoveMatch(l, move));
    if (!match) {
      return { valid: false, reason: 'Illegal or non-canonical move in witness sequence' };
    }
    current = applyMove(current, match);
  }
  const opponent = opposite(winner);
  if (current.turn !== opponent || !inCheck(current, opponent)) {
    return { valid: false, reason: 'Terminal position not in check for loser' };
  }
  if (generateLegalMoves(current).length !== 0) {
    return { valid: false, reason: 'Terminal position has legal replies (not mate)' };
  }
  return { valid: true, terminalState: current };
}

const PLAYOUT_VALUE: Readonly<Record<string, number>> = Object.freeze({ p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 });

function chebyshevDist(a: number, b: number): number {
  return Math.max(Math.abs((a >> 4) - (b >> 4)), Math.abs((a & 7) - (b & 7)));
}

function cornerDist(sq: number): number {
  const r = sq >> 4;
  const f = sq & 7;
  return Math.min(Math.max(r, f), Math.max(r, 7 - f), Math.max(7 - r, f), Math.max(7 - r, 7 - f));
}

/** FNV-1a over the root key: a stable seed per position. */
function seedFromKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff || 1;
}

interface PlayoutCursor {
  index: number;
  ply: number;
  state: PositionState;
  path: Move[];
  rng: number;
  /** Legal moves of the current ply while they are being evaluated, one per work unit. */
  moves: Move[] | null;
  next: number;
  best: Move | null;
  bestScore: number;
}

function manhattanDist(sq1: number, sq2: number): number {
  return Math.abs((sq1 >> 4) - (sq2 >> 4)) + Math.abs((sq1 & 7) - (sq2 & 7));
}

function scoreWinnerMove(move: Move, oppKingSq: number): number {
  let score = 0;
  if (move.promotion) {
    score += move.promotion === 'q' ? 40_000 : 20_000;
  }
  if (move.captured) {
    score += 5_000;
  }
  if (oppKingSq >= 0) {
    const dBefore = manhattanDist(move.from, oppKingSq);
    const dAfter = manhattanDist(move.to, oppKingSq);
    score += (dBefore - dAfter) * 100;
  }
  return score;
}

function scoreLoserMove(move: Move, winKingSq: number): number {
  let score = 0;
  if (move.captured) {
    const t = typeOf(move.captured);
    if (t === 'q' || t === 'r' || t === 'b' || t === 'n') {
      score -= 50_000;
    }
  }
  if (typeOf(move.piece) === 'k' && winKingSq >= 0) {
    const dBefore = manhattanDist(move.from, winKingSq);
    const dAfter = manhattanDist(move.to, winKingSq);
    score += (dBefore - dAfter) * 100;
  }
  return score;
}

function compareCanonicalMoves(a: Move, b: Move): number {
  if (a.from !== b.from) return a.from - b.from;
  if (a.to !== b.to) return a.to - b.to;
  const pA = a.promotion ?? '';
  const pB = b.promotion ?? '';
  return pA.localeCompare(pB);
}

interface ScoredCandidate {
  readonly move: Move;
  readonly score: number;
}

function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  return compareCanonicalMoves(a.move, b.move);
}

type FramePhase = 'init' | 'scoring' | 'inserting' | 'shifting' | 'selecting' | 'exploring';

interface Frame {
  readonly state: PositionState;
  readonly depth: number;
  readonly moveFromParent: Move | null;
  readonly stateKey: string;
  phase: FramePhase;
  rawLegals: Move[] | null;
  scoringIndex: number;
  pendingCandidate: ScoredCandidate | null;
  insertCompareIndex: number;
  insertTargetIndex: number;
  shiftWriteIndex: number;
  scoredCandidates: ScoredCandidate[];
  selectionIndex: number;
  candidates: Move[] | null;
  candidateIndex: number;
}

function createFrame(
  state: PositionState,
  depth: number,
  moveFromParent: Move | null,
  stateKey: string,
): Frame {
  return {
    state,
    depth,
    moveFromParent,
    stateKey,
    phase: 'init',
    rawLegals: null,
    scoringIndex: 0,
    pendingCandidate: null,
    insertCompareIndex: 0,
    insertTargetIndex: 0,
    shiftWriteIndex: 0,
    scoredCandidates: [],
    selectionIndex: 0,
    candidates: null,
    candidateIndex: 0,
  };
}

interface ReconstructionCursor {
  currentStackIndex: number;
  destination: Move[];
  writeIndex: number;
}

interface VerificationCursor {
  readonly candidateWitness: readonly Move[];
  readonly winner: Color;
  currentIndex: number;
  currentState: PositionState;
}

function validatePositiveInt(val: unknown, name: string): number {
  if (typeof val !== 'number' || !Number.isSafeInteger(val) || val <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return val;
}

function validateAndFreezeAttempts(attempts?: readonly WitnessAttemptConfig[]): readonly WitnessAttemptConfig[] {
  if (!attempts) return DEFAULT_ATTEMPTS;
  if (!Array.isArray(attempts) || attempts.length === 0) {
    throw new TypeError('attempts must be a non-empty array');
  }
  return Object.freeze(
    attempts.map((att, idx) => {
      if (typeof att !== 'object' || att === null) {
        throw new TypeError(`Attempt config at index ${idx} must be a non-null object`);
      }
      return Object.freeze({
        maxDepth: validatePositiveInt(att.maxDepth, `attempts[${idx}].maxDepth`),
        maxBranching: validatePositiveInt(att.maxBranching, `attempts[${idx}].maxBranching`),
        attemptWorkLimit: validatePositiveInt(att.attemptWorkLimit, `attempts[${idx}].attemptWorkLimit`),
      });
    }),
  );
}

function validateWitnessSearchOptions(options?: WitnessSearchOptions): {
  attempts: readonly WitnessAttemptConfig[];
  maxFrames: number;
  maxWitness: number;
  playouts: PlayoutConfig | null;
} {
  const attempts = validateAndFreezeAttempts(options?.attempts);
  let maxFrames = DEFAULT_MAX_RETAINED_FRAMES;
  if (options?.maxRetainedFrames !== undefined) {
    maxFrames = validatePositiveInt(options.maxRetainedFrames, 'maxRetainedFrames');
  }
  let maxWitness = MAX_WITNESS_LENGTH;
  if (options?.maxWitnessLength !== undefined) {
    const val = options.maxWitnessLength;
    if (typeof val !== 'number' || !Number.isSafeInteger(val) || val <= 0 || val > MAX_WITNESS_LENGTH) {
      throw new RangeError(
        `maxWitnessLength must be a positive safe integer <= ${MAX_WITNESS_LENGTH}, got ${String(val)}`,
      );
    }
    maxWitness = val;
  }
  let playouts: PlayoutConfig | null = DEFAULT_PLAYOUTS;
  if (options?.playouts !== undefined) {
    if (options.playouts === false) {
      playouts = null;
    } else {
      playouts = Object.freeze({
        count: validatePositiveInt(options.playouts.count, 'playouts.count'),
        maxPlies: validatePositiveInt(options.playouts.maxPlies, 'playouts.maxPlies'),
      });
    }
  }
  return { attempts, maxFrames, maxWitness, playouts };
}

export class CooperativeWitnessSession {
  private readonly rootState: PositionState;
  private readonly intendedWinner: Color;
  private readonly attempts: readonly WitnessAttemptConfig[];
  private readonly maxFrames: number;
  private readonly maxWitness: number;

  private currentAttemptIndex = 0;
  private attemptWork = 0;
  private stack: Frame[] = [];
  private pathKeys = new Set<string>();

  private isExhausted = false;
  private isCancelled = false;
  private admissionPending: WitnessPendingReason | null = null;
  private finalizedResult: WitnessSearchResult | null = null;
  private activeVerification: VerificationCursor | null = null;
  private reconstructionCursor: ReconstructionCursor | null = null;
  private resourceLimitEncountered = false;
  private lastPendingReason: WitnessPendingReason | null = null;
  private readonly playoutConfig: PlayoutConfig | null;
  private playout: PlayoutCursor | null = null;

  private countersInternal: WitnessCounters = {
    workUnits: 0,
    legalGenerations: 0,
    scoringWork: 0,
    candidateEvaluations: 0,
    candidatesApplied: 0,
    backtrackSteps: 0,
    cycleRejections: 0,
    attemptsStarted: 1,
    attemptsCompleted: 0,
    maxDepthReached: 0,
    retainedFrames: 1,
    replayWork: 0,
  };

  constructor(
    state: PositionState,
    intendedWinner: Color,
    options?: WitnessSearchOptions,
  ) {
    this.rootState = cloneState(state);
    this.intendedWinner = intendedWinner;

    const admission = validateAdmittedProofState(this.rootState);
    if (!admission.ok) {
      this.admissionPending = admission.reason === 'unsupported_variant'
        ? 'unsupported_variant'
        : 'unsupported_state';
      this.finalizedResult = Object.freeze({
        status: 'pending',
        winner: this.intendedWinner,
        reason: this.admissionPending,
        counters: Object.freeze(this.snapshotCounters()),
      });
    }

    const validated = validateWitnessSearchOptions(options);
    this.attempts = validated.attempts;
    this.maxFrames = validated.maxFrames;
    this.maxWitness = validated.maxWitness;
    this.playoutConfig = validated.playouts;

    if (!this.admissionPending) {
      this.initImmediateOrStack();
    }
  }

  private initImmediateOrStack(): void {
    if (this.isTerminalCheckmate(this.rootState)) {
      this.finalizedResult = Object.freeze({
        status: 'reachable',
        winner: this.intendedWinner,
        witness: Object.freeze([]),
        counters: Object.freeze(this.snapshotCounters()),
      });
      return;
    }
    this.initStackForAttempt();
    if (this.playoutConfig) {
      this.playout = {
        index: 0,
        ply: 0,
        state: cloneState(this.rootState),
        path: [],
        rng: seedFromKey(canonicalStateKey(this.rootState)),
        moves: null,
        next: 0,
        best: null,
        bestScore: -Infinity,
      };
    }
  }

  private nextRandom(cursor: PlayoutCursor): number {
    cursor.rng = (Math.imul(cursor.rng, 1103515245) + 12345) & 0x7fffffff;
    return cursor.rng / 0x7fffffff;
  }

  /** Start the next playout from the root, or leave the playout phase for the depth-first attempts. */
  private nextPlayout(cursor: PlayoutCursor): void {
    const config = this.playoutConfig!;
    cursor.index++;
    if (cursor.index >= config.count) {
      this.playout = null;
      return;
    }
    cursor.ply = 0;
    cursor.state = cloneState(this.rootState);
    cursor.path = [];
    cursor.moves = null;
  }

  /**
   * One unit of playout work: generate the current ply's moves, evaluate one of them, or play the
   * best. The winner tries every move for mate; the loser chooses a move that heads its king for a
   * corner and crowds it, never taking the winner's material or giving check. A mate found ends the
   * phase by handing its path to the independent replay verification.
   */
  private stepPlayout(cursor: PlayoutCursor): void {
    const config = this.playoutConfig!;
    this.debit(1);
    if (cursor.moves === null) {
      if (cursor.ply >= config.maxPlies || cursor.ply >= this.maxWitness) {
        this.nextPlayout(cursor);
        return;
      }
      this.countersInternal.legalGenerations++;
      const moves = generateLegalMoves(cursor.state);
      if (moves.length === 0) {
        this.nextPlayout(cursor);
        return;
      }
      cursor.moves = moves;
      cursor.next = 0;
      cursor.best = null;
      cursor.bestScore = -Infinity;
      return;
    }
    if (cursor.next < cursor.moves.length) {
      this.evaluatePlayoutMove(cursor, cursor.moves[cursor.next++]!);
      return;
    }
    cursor.path.push(cursor.best!);
    cursor.state = applyMove(cursor.state, cursor.best!);
    cursor.ply++;
    cursor.moves = null;
  }

  private evaluatePlayoutMove(cursor: PlayoutCursor, move: Move): void {
    this.countersInternal.candidateEvaluations++;
    const state = cursor.state;
    const winnerToMove = state.turn === this.intendedWinner;
    const next = applyMove(state, move);
    // Later playouts weigh chance more, so they explore further from the greedy line.
    let score = this.nextRandom(cursor) * (30 + 60 * (cursor.index % 5));
    if (winnerToMove) {
      if (this.isTerminalCheckmate(next)) {
        const witness = Object.freeze([...cursor.path, move].map((m) => Object.freeze(cloneMove(m))));
        this.playout = null;
        this.startVerification(witness);
        return;
      }
      const loserKing = findKing(state, opposite(this.intendedWinner));
      if (move.promotion) score += move.promotion === 'q' ? 400 : 50;
      if (move.captured) score += 60 + 10 * (PLAYOUT_VALUE[typeOf(move.captured)] ?? 0);
      if (loserKing >= 0) score += (chebyshevDist(move.from, loserKing) - chebyshevDist(move.to, loserKing)) * 25;
      if (typeOf(move.piece) === 'k') score -= 10;
    } else {
      if (move.captured) score -= 300 + 30 * (PLAYOUT_VALUE[typeOf(move.captured)] ?? 0);
      if (inCheck(next, this.intendedWinner)) score -= 200;
      if (typeOf(move.piece) === 'k') {
        score += (cornerDist(move.from) - cornerDist(move.to)) * 30;
      } else {
        const ownKing = findKing(state, state.turn);
        if (ownKing >= 0) score += (chebyshevDist(move.from, ownKing) - chebyshevDist(move.to, ownKing)) * 15;
        if (move.promotion) score -= 100;
      }
    }
    if (score > cursor.bestScore) {
      cursor.bestScore = score;
      cursor.best = move;
    }
  }

  private initStackForAttempt(): void {
    this.stack = [];
    this.pathKeys.clear();
    const rootKey = canonicalStateKey(this.rootState);
    this.stack.push(createFrame(cloneState(this.rootState), 0, null, rootKey));
    this.pathKeys.add(rootKey);
    this.attemptWork = 0;
  }

  private isTerminalCheckmate(state: PositionState): boolean {
    const opponent = opposite(this.intendedWinner);
    if (state.turn !== opponent) return false;
    if (!inCheck(state, opponent)) return false;
    return generateLegalMoves(state).length === 0;
  }

  private snapshotCounters(): WitnessCounters {
    return { ...this.countersInternal };
  }

  private debit(amount: number): void {
    this.countersInternal.workUnits += amount;
    this.attemptWork += amount;
  }

  private advanceAttempt(): boolean {
    this.debit(1);
    this.countersInternal.attemptsCompleted++;
    this.currentAttemptIndex++;
    if (this.currentAttemptIndex >= this.attempts.length) {
      this.isExhausted = true;
      return false;
    }
    this.countersInternal.attemptsStarted++;
    this.initStackForAttempt();
    return true;
  }

  private startReconstruction(stackIndex: number, finalMove: Move): void {
    const pathLength = stackIndex + 1;
    const destination = new Array<Move>(pathLength);
    destination[pathLength - 1] = Object.freeze(cloneMove(finalMove));
    this.reconstructionCursor = {
      currentStackIndex: stackIndex,
      destination,
      writeIndex: pathLength - 2,
    };
  }

  /**
   * Publication array integrity qualification:
   * Moves are individually copied and frozen in charged reconstruction steps (O(1) per step).
   * Native Object.freeze(candidate) seals the admitted destination array upon successful completion
   * outside the enforced search unit ledger with O(actual admitted length) integrity work, strictly
   * bounded by the configured maxWitnessLength (<= 500). Oversized candidates exceeding maxWitness
   * are rejected without freezing. Repeated reads (getStatus, resume(0)) are zero-copy cached returns.
   */
  private stepReconstruction(): void {
    if (!this.reconstructionCursor) return;
    this.debit(1);
    const cursor = this.reconstructionCursor;
    if (cursor.writeIndex >= 0) {
      const frame = this.stack[cursor.currentStackIndex];
      if (frame.moveFromParent) {
        cursor.destination[cursor.writeIndex] = Object.freeze(cloneMove(frame.moveFromParent));
      }
      cursor.writeIndex--;
      cursor.currentStackIndex--;
      return;
    }

    const candidate = cursor.destination;
    this.reconstructionCursor = null;

    if (candidate.length > this.maxWitness) {
      this.resourceLimitEncountered = true;
      this.lastPendingReason = 'resource_limit';
      return;
    }

    const fullWitness = Object.freeze(candidate);
    this.startVerification(fullWitness);
  }

  private startVerification(witness: readonly Move[]): void {
    this.activeVerification = {
      candidateWitness: witness,
      winner: this.intendedWinner,
      currentIndex: 0,
      currentState: cloneState(this.rootState),
    };
  }

  private stepVerification(): boolean {
    if (!this.activeVerification) return false;
    this.debit(1);
    this.countersInternal.replayWork++;

    const cursor = this.activeVerification;
    const legals = generateLegalMoves(cursor.currentState);
    const targetMove = cursor.candidateWitness[cursor.currentIndex];
    const match = legals.find(l => isCanonicalMoveMatch(l, targetMove));

    if (!match) {
      this.activeVerification = null;
      return false;
    }

    cursor.currentState = applyMove(cursor.currentState, match);
    cursor.currentIndex++;

    if (cursor.currentIndex >= cursor.candidateWitness.length) {
      return this.finalizeVerification(cursor);
    }
    return false;
  }

  private finalizeVerification(cursor: VerificationCursor): boolean {
    const opponent = opposite(cursor.winner);
    const isCheck = inCheck(cursor.currentState, opponent);
    const noReplies = isCheck && generateLegalMoves(cursor.currentState).length === 0;

    if (cursor.currentState.turn === opponent && noReplies) {
      this.finalizedResult = Object.freeze({
        status: 'reachable',
        winner: cursor.winner,
        witness: cursor.candidateWitness,
        counters: Object.freeze(this.snapshotCounters()),
      });
      this.activeVerification = null;
      return true;
    }

    this.activeVerification = null;
    return false;
  }

  private stepFrameInit(top: Frame): null {
    this.debit(1);
    this.countersInternal.legalGenerations++;
    const legals = generateLegalMoves(top.state);
    if (legals.length === 0) {
      top.phase = 'exploring';
      top.candidates = [];
      return null;
    }
    top.rawLegals = legals;
    top.scoringIndex = 0;
    top.pendingCandidate = null;
    top.insertCompareIndex = 0;
    top.scoredCandidates = [];
    top.phase = 'scoring';
    return null;
  }

  private stepFrameScoring(top: Frame): null {
    this.debit(1);
    this.countersInternal.scoringWork++;
    this.countersInternal.candidateEvaluations++;

    const m = top.rawLegals![top.scoringIndex];
    const oppKing = findKing(top.state, opposite(this.intendedWinner));
    const winKing = findKing(top.state, this.intendedWinner);
    const s = top.state.turn === this.intendedWinner
      ? scoreWinnerMove(m, oppKing)
      : scoreLoserMove(m, winKing);

    top.pendingCandidate = { move: m, score: s };
    top.insertCompareIndex = 0;
    top.phase = 'inserting';
    return null;
  }

  private finishCandidateInsertion(top: Frame): null {
    top.pendingCandidate = null;
    top.insertCompareIndex = 0;
    top.insertTargetIndex = 0;
    top.shiftWriteIndex = 0;
    top.scoringIndex++;
    if (top.scoringIndex >= top.rawLegals!.length) {
      top.phase = 'selecting';
      top.selectionIndex = 0;
      top.candidates = new Array<Move>(top.scoredCandidates.length);
    } else {
      top.phase = 'scoring';
    }
    return null;
  }

  private startCandidateShift(top: Frame, maxBranching: number): null {
    const oldLen = top.scoredCandidates.length;
    top.insertTargetIndex = top.insertCompareIndex;
    if (oldLen < maxBranching) {
      top.shiftWriteIndex = oldLen;
      top.scoredCandidates.length = oldLen + 1;
    } else {
      top.shiftWriteIndex = maxBranching - 1;
    }
    top.phase = 'shifting';
    return null;
  }

  private stepFrameShifting(top: Frame): null {
    this.debit(1);
    this.countersInternal.scoringWork++;

    if (top.shiftWriteIndex > top.insertTargetIndex) {
      top.scoredCandidates[top.shiftWriteIndex] = top.scoredCandidates[top.shiftWriteIndex - 1];
      top.shiftWriteIndex--;
      return null;
    }

    top.scoredCandidates[top.insertTargetIndex] = top.pendingCandidate!;
    return this.finishCandidateInsertion(top);
  }

  private stepFrameInserting(top: Frame, maxBranching: number): null {
    this.debit(1);
    this.countersInternal.scoringWork++;

    const item = top.pendingCandidate!;
    const list = top.scoredCandidates;
    if (list.length === 0) {
      list.push(item);
      return this.finishCandidateInsertion(top);
    }
    if (top.insertCompareIndex < list.length) {
      const cmp = compareScoredCandidates(item, list[top.insertCompareIndex]);
      if (cmp < 0) {
        return this.startCandidateShift(top, maxBranching);
      }
      top.insertCompareIndex++;
      if (top.insertCompareIndex < list.length) {
        return null;
      }
    }
    if (list.length < maxBranching) {
      list.push(item);
    }
    return this.finishCandidateInsertion(top);
  }

  private stepFrameSelecting(top: Frame): null {
    if (top.selectionIndex < top.candidates!.length) {
      this.debit(1);
      this.countersInternal.scoringWork++;
      top.candidates![top.selectionIndex] = Object.freeze(
        cloneMove(top.scoredCandidates[top.selectionIndex].move),
      );
      top.selectionIndex++;
    }
    if (top.selectionIndex >= top.candidates!.length) {
      top.rawLegals = null;
      top.scoredCandidates = [];
      top.candidateIndex = 0;
      top.phase = 'exploring';
    }
    return null;
  }

  private stepFrameExploring(top: Frame, attempt: WitnessAttemptConfig): WitnessSearchResult | null {
    if (top.candidateIndex < top.candidates!.length) {
      this.debit(1);
      this.countersInternal.candidatesApplied++;
      const move = top.candidates![top.candidateIndex++];
      const nextState = applyMove(top.state, move);

      if (this.isTerminalCheckmate(nextState)) {
        this.startReconstruction(this.stack.length - 1, move);
        return null;
      }

      const nextKey = canonicalStateKey(nextState);
      if (this.pathKeys.has(nextKey)) {
        this.countersInternal.cycleRejections++;
        return null;
      }
      if (top.depth + 1 >= attempt.maxDepth || this.stack.length >= this.maxFrames) {
        return null;
      }

      this.stack.push(createFrame(nextState, top.depth + 1, cloneMove(move), nextKey));
      this.pathKeys.add(nextKey);
      this.countersInternal.retainedFrames = Math.max(this.countersInternal.retainedFrames, this.stack.length);
      this.countersInternal.maxDepthReached = Math.max(this.countersInternal.maxDepthReached, top.depth + 1);
      return null;
    }

    this.debit(1);
    this.countersInternal.backtrackSteps++;
    const popped = this.stack.pop();
    if (popped) {
      this.pathKeys.delete(popped.stateKey);
    }
    return null;
  }

  private stepSearchIteration(attempt: WitnessAttemptConfig): WitnessSearchResult | null {
    if (this.activeVerification) {
      this.stepVerification();
      if (this.finalizedResult) return this.finalizedResult;
      return null;
    }

    if (this.playout) {
      this.stepPlayout(this.playout);
      return null;
    }

    if (this.reconstructionCursor) {
      this.stepReconstruction();
      if (this.finalizedResult) return this.finalizedResult;
      return null;
    }

    if (this.stack.length === 0 || this.attemptWork >= attempt.attemptWorkLimit) {
      const advanced = this.advanceAttempt();
      if (!advanced) {
        this.finalizedResult = Object.freeze({
          status: 'pending',
          winner: this.intendedWinner,
          reason: this.resourceLimitEncountered ? 'resource_limit' : 'attempts_exhausted',
          counters: Object.freeze(this.snapshotCounters()),
        });
        return this.finalizedResult;
      }
      return null;
    }

    const top = this.stack[this.stack.length - 1];
    return this.stepFramePhase(top, attempt);
  }

  private stepFramePhase(top: Frame, attempt: WitnessAttemptConfig): WitnessSearchResult | null {
    if (top.phase === 'init') {
      return this.stepFrameInit(top);
    }
    if (top.phase === 'scoring') {
      return this.stepFrameScoring(top);
    }
    if (top.phase === 'inserting') {
      return this.stepFrameInserting(top, attempt.maxBranching);
    }
    if (top.phase === 'shifting') {
      return this.stepFrameShifting(top);
    }
    if (top.phase === 'selecting') {
      return this.stepFrameSelecting(top);
    }
    return this.stepFrameExploring(top, attempt);
  }

  get counters(): WitnessCounters {
    return this.snapshotCounters();
  }

  cancel(): void {
    this.isCancelled = true;
    this.activeVerification = null;
    this.reconstructionCursor = null;
    if (!this.finalizedResult) {
      this.finalizedResult = Object.freeze({
        status: 'pending',
        winner: this.intendedWinner,
        reason: 'cancelled',
        counters: Object.freeze(this.snapshotCounters()),
      });
    }
  }

  getStatus(): WitnessSearchResult {
    if (this.finalizedResult) return this.finalizedResult;
    if (this.admissionPending) {
      return Object.freeze({ status: 'pending', winner: this.intendedWinner, reason: this.admissionPending, counters: Object.freeze(this.snapshotCounters()) });
    }
    if (this.isCancelled) {
      return Object.freeze({ status: 'pending', winner: this.intendedWinner, reason: 'cancelled', counters: Object.freeze(this.snapshotCounters()) });
    }
    if (this.isExhausted) {
      return Object.freeze({ status: 'pending', winner: this.intendedWinner, reason: this.resourceLimitEncountered ? 'resource_limit' : 'attempts_exhausted', counters: Object.freeze(this.snapshotCounters()) });
    }
    if (this.lastPendingReason) {
      return Object.freeze({ status: 'pending', winner: this.intendedWinner, reason: this.lastPendingReason, counters: Object.freeze(this.snapshotCounters()) });
    }
    return Object.freeze({ status: 'pending', winner: this.intendedWinner, reason: 'slice_exhausted', counters: Object.freeze(this.snapshotCounters()) });
  }

  private canResume(workBudget: number): boolean {
    if (this.finalizedResult || this.admissionPending) return false;
    if (this.isCancelled || this.isExhausted) return false;
    return typeof workBudget === 'number' && Number.isSafeInteger(workBudget) && workBudget > 0;
  }

  private canContinueSlice(startWork: number, budget: number): boolean {
    if (this.countersInternal.workUnits - startWork >= budget) return false;
    return !this.finalizedResult && !this.isExhausted && !this.isCancelled;
  }

  resume(workBudget: number): WitnessSearchResult {
    if (!this.canResume(workBudget)) {
      return this.getStatus();
    }

    const startWork = this.countersInternal.workUnits;
    while (this.canContinueSlice(startWork, workBudget)) {
      const attempt = this.attempts[this.currentAttemptIndex];
      const res = this.stepSearchIteration(attempt);
      if (res) return res;
    }

    return this.getStatus();
  }
}
