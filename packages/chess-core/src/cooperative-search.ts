/**
 * @packageDocumentation
 * Exact Resumable Cooperative Graph Search for Helpmate Reachability (FIDE 5.2.2).
 *
 * References:
 * - Published conference article: Miguel Ambrona, "A Practical Algorithm for Chess Unwinnability",
 *   11th International Conference on Fun with Algorithms (FUN 2022),
 *   LIPIcs Vol. 226, pp. 2:1-2:20, DOI: 10.4230/LIPIcs.FUN.2022.2.
 * - Verified author full 25-page version: https://chasolver.org/FUN22-full.pdf
 *   (SHA256: 502eebe3bfd5892de47c6bb8debdd5e75a6387856bb0d74e8052b3bd9ddbdf8d; page 7, Section 2.1 Lemmas 5 and 6).
 * - Upstream reference code: chasolver (MIT License, Copyright (c) 2021-2026 Miguel Ambrona).
 *
 * Traverses the exact legal state transition graph under clock-free semantics
 * (excluding halfmove and fullmove counters) using pure legal move generation.
 *
 * Terminal classification:
 * - Checkmate for intended winner: `reachable` with an exact root-to-checkmate witness.
 * - Entire reachable state space closed with zero checkmates: `impossible`.
 *   - `closed_graph`: raw all-edge closed graph exhaustion.
 *   - `closed_graph_material_pruned`: closed modulo qualified material lemma discharges (Lemmas 5 and 6).
 * - Bounded step limit exhausted / capacity reached: `pending` with a resumable session state.
 *
 * Never calls `Position.prototype.status()` to ensure no premature 50-move or
 * repetition pruning pollutes the clock-free helpmate reachability oracle.
 */

import { colorOf, fileOf, opposite, rankOf, typeOf } from './board';
import { cloneState } from './fen';
import { applyMove, generateLegalMoves, inCheck } from './movegen';
import { validateAdmittedProofState } from './proof-admission';
import type { Color, Move, Piece, PieceType, PositionState } from './types';
import type {
  CooperativeSearchOptions,
  PendingReason,
  ProofProvenance,
  WinnabilityImpossibleResult,
  WinnabilityReachableResult,
  WinnabilityResult,
} from './unwinnability-types';

/**
 * Builds a collision-free canonical state key under clock-free graph semantics.
 * Retains piece placement, turn, full rook-file castling rights, en passant, and variant.
 * Explicitly excludes halfmove and fullmove counters.
 */
export function canonicalStateKey(state: PositionState): string {
  let placement = '';
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const sq = (r << 4) | f;
      const piece = state.board[sq];
      if (piece === null) {
        empty++;
      } else {
        if (empty > 0) {
          placement += String(empty);
          empty = 0;
        }
        placement += piece;
      }
    }
    if (empty > 0) {
      placement += String(empty);
    }
    if (r > 0) placement += '/';
  }

  const c = state.castling;
  const castlingStr = `${c.w.k},${c.w.q},${c.b.k},${c.b.q}`;
  return `${placement} ${state.turn} ${castlingStr} ${state.epSquare} ${state.variant}`;
}

export function cloneMove(move: Move): Move {
  return {
    from: move.from,
    to: move.to,
    piece: move.piece,
    captured: move.captured,
    promotion: move.promotion,
    drop: move.drop,
    castleRook: move.castleRook,
    flags: move.flags,
  };
}

export function cloneReachableResult(res: WinnabilityReachableResult): WinnabilityReachableResult {
  return {
    status: 'reachable',
    winner: res.winner,
    witness: res.witness.map(cloneMove),
    steps: res.steps,
  };
}

export function cloneImpossibleResult(res: WinnabilityImpossibleResult): WinnabilityImpossibleResult {
  return {
    status: 'impossible',
    winner: res.winner,
    provenance: res.provenance,
    steps: res.steps,
    materialPrunedCount: res.materialPrunedCount,
  };
}

export function cloneWinnabilityResult(res: WinnabilityResult): WinnabilityResult {
  if (res.status === 'reachable') {
    return cloneReachableResult(res);
  }
  if (res.status === 'impossible') {
    return cloneImpossibleResult(res);
  }
  return {
    status: 'pending',
    winner: res.winner,
    reason: res.reason,
    steps: res.steps,
    session: res.session,
  };
}

interface ColorMaterialCounts {
  knights: number;
  bishops: number;
  rooks: number;
  queens: number;
  bishops0: number;
  bishops1: number;
}

interface MaterialInventory {
  totalPawns: number;
  winner: ColorMaterialCounts;
  loser: ColorMaterialCounts;
}

function createEmptyColorCounts(): ColorMaterialCounts {
  return { knights: 0, bishops: 0, rooks: 0, queens: 0, bishops0: 0, bishops1: 0 };
}

function updatePieceCounts(counts: ColorMaterialCounts, type: PieceType, sq: number): void {
  if (type === 'n') {
    counts.knights++;
  } else if (type === 'b') {
    counts.bishops++;
    const sqColor = (rankOf(sq) + fileOf(sq)) % 2;
    if (sqColor === 0) counts.bishops0++;
    else counts.bishops1++;
  } else if (type === 'r') {
    counts.rooks++;
  } else if (type === 'q') {
    counts.queens++;
  }
}

function collectMaterialInventory(
  board: readonly (Piece | null)[],
  winner: Color,
): MaterialInventory {
  let totalPawns = 0;
  const winnerCounts = createEmptyColorCounts();
  const loserCounts = createEmptyColorCounts();

  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const p = board[sq];
    if (p === null) continue;
    const t = typeOf(p);
    if (t === 'p') {
      totalPawns++;
      continue;
    }
    const target = colorOf(p) === winner ? winnerCounts : loserCounts;
    updatePieceCounts(target, t, sq);
  }

  return { totalPawns, winner: winnerCounts, loser: loserCounts };
}

function isBareKing(inv: MaterialInventory): boolean {
  const w = inv.winner;
  return w.knights === 0 && w.bishops === 0 && w.rooks === 0 && w.queens === 0;
}

function isLemma5Unwinnable(inv: MaterialInventory): boolean {
  const w = inv.winner;
  const l = inv.loser;
  return (
    w.knights === 1 &&
    w.bishops === 0 &&
    w.rooks === 0 &&
    w.queens === 0 &&
    l.knights === 0 &&
    l.bishops === 0 &&
    l.rooks === 0
  );
}

function isSingleColorBishop(w: ColorMaterialCounts): number | null {
  if (w.bishops === 0) return null;
  if (w.bishops0 > 0 && w.bishops1 === 0) return 0;
  if (w.bishops1 > 0 && w.bishops0 === 0) return 1;
  return null;
}

function isLemma6Unwinnable(inv: MaterialInventory): boolean {
  const w = inv.winner;
  const l = inv.loser;
  if (w.knights !== 0 || w.rooks !== 0 || w.queens !== 0) return false;
  const winnerBishopColor = isSingleColorBishop(w);
  if (winnerBishopColor === null) return false;
  if (l.knights !== 0) return false;

  const loserOppositeBishops = winnerBishopColor === 0 ? l.bishops1 : l.bishops0;
  return loserOppositeBishops === 0;
}

export function isPawnFreeMaterialUnwinnable(state: PositionState, winner: Color): boolean {
  const inv = collectMaterialInventory(state.board, winner);
  if (inv.totalPawns > 0) return false;
  return isBareKing(inv) || isLemma5Unwinnable(inv) || isLemma6Unwinnable(inv);
}

function isPositiveSafeInteger(n: unknown): boolean {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

interface VisitedRecord {
  state: PositionState;
  parentKey: string | null;
  moveFromParent: Move | null;
  depth: number;
}

interface ExactReconstructionCursor {
  currentKey: string | null;
  destination: Move[];
  writeIndex: number;
}

const DEFAULT_MAX_RETAINED_STATES = 50000;
const MIN_ALLOWED_CAPACITY = 1;

/**
 * Resumable graph search session for proving winnability or unwinnability.
 */
export class CooperativeSearchSession {
  private readonly ownedRoot: PositionState | null;
  private readonly intendedWinner: Color;
  private readonly opponent: Color;
  private maxRetainedStates: number;

  private readonly visited = new Map<string, VisitedRecord>();
  private readonly queue: string[] = [];
  private queueHead = 0;
  private totalSteps = 0;
  private materialPrunedCount = 0;
  private totalWorkUnits = 0;

  private currentEdges: Move[] | null = null;
  private currentEdgeIndex = 0;

  private finalizedResult: WinnabilityResult | null = null;
  private exactReconstruction: ExactReconstructionCursor | null = null;

  constructor(root: PositionState, intendedWinner: Color, options?: CooperativeSearchOptions) {
    this.intendedWinner = intendedWinner;
    this.opponent = opposite(intendedWinner);

    if (options?.maxRetainedStates !== undefined) {
      const cap = options.maxRetainedStates;
      if (
        typeof cap !== 'number' ||
        !Number.isFinite(cap) ||
        !Number.isInteger(cap) ||
        cap < MIN_ALLOWED_CAPACITY
      ) {
        throw new RangeError(
          `maxRetainedStates must be a finite positive integer (>= ${MIN_ALLOWED_CAPACITY}), got ${String(cap)}`,
        );
      }
      this.maxRetainedStates = cap;
    } else {
      this.maxRetainedStates = DEFAULT_MAX_RETAINED_STATES;
    }

    const admission = validateAdmittedProofState(root);
    if (!admission.ok) {
      this.ownedRoot = null;
      this.finalizedResult = Object.freeze({
        status: 'pending',
        winner: intendedWinner,
        reason: admission.reason ?? 'unsupported_state',
        steps: 0,
        session: this,
      });
      return;
    }

    this.ownedRoot = cloneState(root);

    if (this.isTerminalCheckmate(this.ownedRoot)) {
      this.finalizedResult = Object.freeze({
        status: 'reachable',
        winner: intendedWinner,
        witness: Object.freeze([]),
        steps: 0,
      });
      return;
    }

    const rootKey = canonicalStateKey(this.ownedRoot);
    this.visited.set(rootKey, {
      state: cloneState(this.ownedRoot),
      parentKey: null,
      moveFromParent: null,
      depth: 0,
    });
    this.queue.push(rootKey);
  }

  get root(): PositionState | null {
    return this.ownedRoot ? cloneState(this.ownedRoot) : null;
  }

  setCapacity(newMaxStates: number): void {
    if (
      typeof newMaxStates !== 'number' ||
      !Number.isFinite(newMaxStates) ||
      !Number.isInteger(newMaxStates) ||
      newMaxStates < MIN_ALLOWED_CAPACITY
    ) {
      throw new RangeError(
        `newMaxStates must be a finite positive integer (>= ${MIN_ALLOWED_CAPACITY}), got ${String(newMaxStates)}`,
      );
    }
    if (newMaxStates <= this.maxRetainedStates) {
      throw new RangeError(
        `newMaxStates (${newMaxStates}) must be strictly greater than current capacity (${this.maxRetainedStates})`,
      );
    }
    this.maxRetainedStates = newMaxStates;
  }

  getCapacity(): number {
    return this.maxRetainedStates;
  }

  get maxStates(): number {
    return this.maxRetainedStates;
  }

  getVisitedCount(): number {
    return this.visited.size;
  }

  get discoveredStates(): number {
    return this.visited.size;
  }

  get expandedStates(): number {
    return this.totalSteps;
  }

  get totalWork(): number {
    return this.totalWorkUnits;
  }

  getWorkUnits(): number {
    return this.totalWorkUnits;
  }

  get materialDischarges(): number {
    return this.materialPrunedCount;
  }

  getStatus(): WinnabilityResult {
    if (this.finalizedResult) {
      return this.finalizedResult;
    }

    const reason: PendingReason =
      this.visited.size >= this.maxRetainedStates ? 'resource_limit' : 'budget_exhausted';

    return Object.freeze({
      status: 'pending',
      winner: this.intendedWinner,
      reason,
      steps: this.totalSteps,
      session: this,
    });
  }

  cancel(): void {
    if (this.finalizedResult) return;
    this.exactReconstruction = null;
    this.finalizedResult = Object.freeze({
      status: 'pending',
      winner: this.intendedWinner,
      reason: 'cancelled',
      steps: this.totalSteps,
      session: this,
    });
  }

  private isTerminalCheckmate(state: PositionState): boolean {
    if (state.turn !== this.opponent || !inCheck(state, this.opponent)) {
      return false;
    }
    return generateLegalMoves(state).length === 0;
  }

  private prepareCurrentEdges(currState: PositionState): boolean {
    if (isPawnFreeMaterialUnwinnable(currState, this.intendedWinner)) {
      this.materialPrunedCount++;
      return false;
    }
    const legals = generateLegalMoves(currState);
    if (legals.length === 0) {
      return false;
    }
    this.currentEdges = legals;
    this.currentEdgeIndex = 0;
    return true;
  }

  private expandNextEdge(
    currKey: string,
    currState: PositionState,
  ): { mateWitness?: Move[]; hitCapacity?: boolean } {
    const move = this.currentEdges![this.currentEdgeIndex];
    const nextState = applyMove(currState, move);

    if (this.isTerminalCheckmate(nextState)) {
      return { mateWitness: this.reconstructWitness(currKey, move) };
    }

    const nextKey = canonicalStateKey(nextState);
    if (!this.visited.has(nextKey)) {
      if (this.visited.size >= this.maxRetainedStates) {
        return { hitCapacity: true };
      }
      const parentRecord = this.visited.get(currKey)!;
      this.visited.set(nextKey, {
        state: nextState,
        parentKey: currKey,
        moveFromParent: move,
        depth: parentRecord.depth + 1,
      });
      this.queue.push(nextKey);
    }

    this.currentEdgeIndex++;
    return {};
  }

  private advanceQueueNode(steps: number): void {
    this.queueHead += steps;
    this.currentEdges = null;
    this.currentEdgeIndex = 0;
    this.totalSteps += steps;
  }

  private processCurrentNodeEdges(currKey: string, currState: PositionState): WinnabilityResult | null {
    while (this.currentEdgeIndex < this.currentEdges!.length) {
      const edgeResult = this.expandNextEdge(currKey, currState);
      if (edgeResult.mateWitness) {
        this.finalizedResult = Object.freeze({
          status: 'reachable',
          winner: this.intendedWinner,
          witness: Object.freeze(edgeResult.mateWitness.map(m => Object.freeze(cloneMove(m)))),
          steps: this.totalSteps,
        });
        return cloneWinnabilityResult(this.finalizedResult);
      }
      if (edgeResult.hitCapacity) {
        return Object.freeze({
          status: 'pending',
          winner: this.intendedWinner,
          reason: 'resource_limit',
          steps: this.totalSteps,
          session: this,
        });
      }
    }
    return null;
  }

  private finalizeImpossibleResult(): WinnabilityResult {
    const provenance: ProofProvenance =
      this.materialPrunedCount > 0 ? 'closed_graph_material_pruned' : 'closed_graph';

    this.finalizedResult = Object.freeze({
      status: 'impossible',
      winner: this.intendedWinner,
      provenance,
      steps: this.totalSteps,
      materialPrunedCount: this.materialPrunedCount > 0 ? this.materialPrunedCount : undefined,
    });
    return this.finalizedResult;
  }

  private stepMaterialOrMovePrep(currState: PositionState): boolean {
    this.totalWorkUnits++;
    if (isPawnFreeMaterialUnwinnable(currState, this.intendedWinner)) {
      this.materialPrunedCount++;
      return false;
    }
    const legals = generateLegalMoves(currState);
    if (legals.length === 0) {
      return false;
    }
    this.currentEdges = legals;
    this.currentEdgeIndex = 0;
    return true;
  }

  private expandNextEdgeForWork(
    currKey: string,
    currState: PositionState,
  ): { mateFound?: Move; hitCapacity?: boolean } {
    const move = this.currentEdges![this.currentEdgeIndex];
    const nextState = applyMove(currState, move);

    if (this.isTerminalCheckmate(nextState)) {
      return { mateFound: move };
    }

    const nextKey = canonicalStateKey(nextState);
    if (!this.visited.has(nextKey)) {
      if (this.visited.size >= this.maxRetainedStates) {
        return { hitCapacity: true };
      }
      const parentRecord = this.visited.get(currKey)!;
      this.visited.set(nextKey, {
        state: nextState,
        parentKey: currKey,
        moveFromParent: move,
        depth: parentRecord.depth + 1,
      });
      this.queue.push(nextKey);
    }

    this.currentEdgeIndex++;
    return {};
  }

  /**
   * Publication Array Integrity Qualification:
   * Moves are individually copied and frozen in charged reconstruction steps (O(1) per step).
   * Native Object.freeze(destination) seals the destination array upon completion outside the
   * enforced search unit ledger with O(witness.length) integrity work, bounded strictly by
   * parentRecord.depth + 1 (the discovered state chain length, uncapped by 500).
   * Repeated reads (getStatus, resumeWork(0)) are zero-copy cached returns.
   */
  private stepExactReconstruction(): WinnabilityResult | null {
    this.totalWorkUnits++;
    const cursor = this.exactReconstruction!;
    if (cursor.writeIndex >= 0 && cursor.currentKey !== null) {
      const entry = this.visited.get(cursor.currentKey);
      if (entry && entry.moveFromParent) {
        cursor.destination[cursor.writeIndex] = Object.freeze(cloneMove(entry.moveFromParent));
        cursor.writeIndex--;
        cursor.currentKey = entry.parentKey;
      } else {
        cursor.currentKey = null;
      }
      return null;
    }

    const fullWitness = Object.freeze(cursor.destination);
    this.exactReconstruction = null;
    this.finalizedResult = Object.freeze({
      status: 'reachable',
      winner: this.intendedWinner,
      witness: fullWitness,
      steps: this.totalSteps,
    });
    return this.finalizedResult;
  }

  private stepSingleEdge(currKey: string, currState: PositionState): WinnabilityResult | null {
    this.totalWorkUnits++;
    const edgeResult = this.expandNextEdgeForWork(currKey, currState);
    if (edgeResult.mateFound) {
      const parentRecord = this.visited.get(currKey)!;
      const totalLength = parentRecord.depth + 1;
      const destination = new Array<Move>(totalLength);
      destination[totalLength - 1] = Object.freeze(cloneMove(edgeResult.mateFound));
      this.exactReconstruction = {
        currentKey: currKey,
        destination,
        writeIndex: totalLength - 2,
      };
      return null;
    }
    if (edgeResult.hitCapacity) {
      return Object.freeze({
        status: 'pending',
        winner: this.intendedWinner,
        reason: 'resource_limit',
        steps: this.totalSteps,
        session: this,
      });
    }
    return null;
  }

  resume(stepBudget: number): WinnabilityResult {
    if (this.finalizedResult) {
      return cloneWinnabilityResult(this.finalizedResult);
    }
    if (!isPositiveSafeInteger(stepBudget)) {
      return cloneWinnabilityResult(this.getStatus());
    }

    let stepsThisCall = 0;
    while (this.queueHead < this.queue.length && stepsThisCall < stepBudget) {
      const currKey = this.queue[this.queueHead];
      const currState = this.visited.get(currKey)!.state;

      if (this.currentEdges === null && !this.prepareCurrentEdges(currState)) {
        this.advanceQueueNode(1);
        stepsThisCall++;
        continue;
      }

      const interruption = this.processCurrentNodeEdges(currKey, currState);
      if (interruption) return cloneWinnabilityResult(interruption);

      this.advanceQueueNode(1);
      stepsThisCall++;
    }

    if (this.queueHead >= this.queue.length) {
      this.finalizeImpossibleResult();
      return cloneWinnabilityResult(this.finalizedResult!);
    }
    return cloneWinnabilityResult(this.getStatus());
  }

  private canContinueWork(startWork: number, workBudget: number): boolean {
    const hasWork = this.exactReconstruction !== null || this.queueHead < this.queue.length;
    return hasWork && (this.totalWorkUnits - startWork) < workBudget;
  }

  private processQueueHeadWork(startWork: number, workBudget: number): WinnabilityResult | null {
    if (this.exactReconstruction !== null) {
      return this.stepExactReconstruction();
    }
    const currKey = this.queue[this.queueHead];
    const currState = this.visited.get(currKey)!.state;

    if (this.currentEdges === null) {
      const hasEdges = this.stepMaterialOrMovePrep(currState);
      if (!hasEdges) {
        this.advanceQueueNode(1);
        return null;
      }
      if ((this.totalWorkUnits - startWork) >= workBudget) {
        return this.getStatus();
      }
    }

    const interruption = this.stepSingleEdge(currKey, currState);
    if (interruption) return interruption;

    if (this.currentEdgeIndex >= this.currentEdges!.length) {
      this.advanceQueueNode(1);
    }
    return null;
  }

  resumeWork(workBudget: number): WinnabilityResult {
    if (this.finalizedResult) {
      return this.finalizedResult;
    }
    if (!isPositiveSafeInteger(workBudget)) {
      return this.getStatus();
    }

    const startWork = this.totalWorkUnits;
    while (this.canContinueWork(startWork, workBudget)) {
      const interruption = this.processQueueHeadWork(startWork, workBudget);
      if (interruption) return interruption;
    }

    if (this.queueHead >= this.queue.length) {
      return this.finalizeImpossibleResult();
    }
    return this.getStatus();
  }

  private reconstructWitness(lastVisitedKey: string, lastMove: Move): Move[] {
    const parentRecord = this.visited.get(lastVisitedKey);
    const totalLength = (parentRecord ? parentRecord.depth : 0) + 1;
    const path: Move[] = new Array<Move>(totalLength);
    path[totalLength - 1] = cloneMove(lastMove);
    let writeIdx = totalLength - 2;
    let currKey: string | null = lastVisitedKey;

    while (currKey !== null && writeIdx >= 0) {
      const entry = this.visited.get(currKey);
      if (!entry) break;
      if (entry.moveFromParent !== null) {
        path[writeIdx] = cloneMove(entry.moveFromParent);
        writeIdx--;
      }
      currKey = entry.parentKey;
    }

    return path;
  }
}
