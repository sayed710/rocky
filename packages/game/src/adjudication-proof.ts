/**
 * @packageDocumentation
 * Game-owned opaque evidence adapter and job controller (Issue #124, Stage 2).
 *
 * Implements a private WeakMap-registered handle boundary. Handles are minted ONLY
 * from internally invoked core proof analyses and domain-owned controller sessions.
 * Reject literal, cloned, JSON-deserialized, or cross-operation evidence handles.
 * Registry records are deeply frozen and never escape mutable.
 *
 * Private mint authority:
 * - NO unchecked mint functions are exported.
 * - AdjudicationJobController is defined in this registry lexical module.
 * - Genuine internally owned engines and retained verification alone reach the private mint callback.
 */

import {
  analyzeDeadPosition,
  analyzeWinnability,
  isCanonicalMoveMatch,
  isStaticallyUnwinnable,
  CooperativeSearchSession,
  CooperativeWitnessSession,
  MAX_WITNESS_LENGTH,
  Position,
  type AnalysisOptions,
  type Color,
  type Move,
  type ProofProvenance,
  type Variant,
} from '@chess-platform/core';
import {
  clonePreparedOperation,
  type PreparedIntent,
  type PreparedOperation,
} from './prepared-command';
import { Game, GameError, type RepetitionHistory } from './game';
import {
  type AdjudicationEvidenceBundle,
  type SettlementResult,
  settlePrepared,
} from './adjudication-lifecycle';
import {
  resolveRequiredProofRoles,
  type RequiredProofRole,
} from './adjudication-requirements';
import {
  deriveTurnLineageId,
  validateClockPolicy,
} from './adjudication-completion';

/** The question evaluated by proof analysis. */
export type ProofQuestion =
  | { readonly kind: 'global_deadness' }
  | { readonly kind: 'directional_reachability'; readonly winner: Color }
  | { readonly kind: 'successor_deadness'; readonly successorFen: string }
  | { readonly kind: 'terminal_authorization' };

/**
 * Public opaque evidence handle.
 * Live settlement accepts ONLY registered handles from this module's private WeakMap.
 */
export interface AdjudicationEvidenceHandle {
  readonly operationId: string;
  readonly questionKind:
    | 'global_deadness'
    | 'directional_reachability'
    | 'successor_deadness'
    | 'terminal_authorization';
  readonly targetWinner?: Color;
  readonly successorFen?: string;
}

export type VerifiedDeadOutcome = {
  readonly kind: 'dead';
  readonly provenance: ProofProvenance;
  readonly white: { readonly status: 'impossible'; readonly provenance: ProofProvenance };
  readonly black: { readonly status: 'impossible'; readonly provenance: ProofProvenance };
};

export type VerifiedEvidenceOutcome =
  | VerifiedDeadOutcome
  | { readonly kind: 'winnable'; readonly winner: Color; readonly witnessUci: readonly string[] }
  | { readonly kind: 'impossible'; readonly winner: Color; readonly provenance: ProofProvenance }
  | { readonly kind: 'terminal_authorization'; readonly termination: string }
  | { readonly kind: 'unresolved'; readonly reason: 'resource_limit' };

/** Verified evidence outcome held securely in the private WeakMap. */
export interface VerifiedEvidenceRecord {
  readonly gameId: string;
  readonly operationId: string;
  readonly baseRevision: number;
  readonly baseFen: string;
  readonly variant: Variant;
  readonly rulesVersion: string;
  readonly question: ProofQuestion;
  readonly outcome: VerifiedEvidenceOutcome;
}

export type JobStatus = 'active' | 'ready' | 'cancelled' | 'resource_limit' | 'settled';

export interface ControllerOptions {
  readonly maxJobs?: number;
}

const DEFAULT_MAX_JOBS = 100;

export interface AdjudicationJobView {
  readonly operationId: string;
  readonly gameId: string;
  readonly status: JobStatus;
  readonly requiredRoles: readonly RequiredProofRole[];
  readonly workCompleted: number;
  readonly slicesExecuted: number;
  readonly generationWork: number;
  readonly exactWork: number;
  readonly completionWork: number;
  readonly scoringWork: number;
  readonly replayWork: number;
  readonly handlesReady: boolean;
}

export interface JobStepResult {
  readonly operationId: string;
  readonly status: JobStatus;
  readonly workCompleted: number;
  readonly deltaWork: number;
  readonly slicesExecuted: number;
  readonly handlesReady: boolean;
}

export interface AllStepResult {
  readonly totalDeltaWork: number;
  readonly jobResults: readonly JobStepResult[];
}

/** Process-local WeakMap for authentic evidence handles. */
const evidenceRegistry = new WeakMap<object, VerifiedEvidenceRecord>();

function verifyWitnessReplay(pos: Position, winner: Color, witness: readonly Move[]): readonly string[] {
  let cur = pos;
  const uciMoves: string[] = [];
  for (const m of witness) {
    const legals = cur.legalMoves();
    const matched = legals.find(l => isCanonicalMoveMatch(l, m));
    if (!matched) {
      throw new GameError('Candidate mate witness failed canonical legal replay verification');
    }
    const uci = cur.toUci(matched);
    uciMoves.push(uci);
    cur = cur.play(matched);
  }
  const status = cur.status();
  if (!status.over || status.reason !== 'checkmate' || status.winner !== winner) {
    throw new GameError('Candidate mate witness failed canonical legal replay verification');
  }
  return Object.freeze(uciMoves);
}

function deepFreezeOutcome(outcome: VerifiedEvidenceRecord['outcome']): VerifiedEvidenceRecord['outcome'] {
  if (outcome.kind === 'dead') {
    return Object.freeze({
      kind: 'dead',
      provenance: outcome.provenance,
      white: Object.freeze({ status: 'impossible', provenance: outcome.white.provenance }),
      black: Object.freeze({ status: 'impossible', provenance: outcome.black.provenance }),
    });
  }
  if (outcome.kind === 'winnable') {
    return Object.freeze({
      kind: 'winnable',
      winner: outcome.winner,
      witnessUci: Object.freeze([...outcome.witnessUci]),
    });
  }
  if (outcome.kind === 'impossible') {
    return Object.freeze({
      kind: 'impossible',
      winner: outcome.winner,
      provenance: outcome.provenance,
    });
  }
  if (outcome.kind === 'unresolved') {
    return Object.freeze({ kind: 'unresolved', reason: outcome.reason });
  }
  return Object.freeze({
    kind: 'terminal_authorization',
    termination: outcome.termination,
  });
}

function deepFreezeQuestion(question: ProofQuestion): ProofQuestion {
  if (question.kind === 'global_deadness') {
    return Object.freeze({ kind: 'global_deadness' });
  }
  if (question.kind === 'successor_deadness') {
    return Object.freeze({ kind: 'successor_deadness', successorFen: question.successorFen });
  }
  if (question.kind === 'directional_reachability') {
    return Object.freeze({ kind: 'directional_reachability', winner: question.winner });
  }
  return Object.freeze({ kind: 'terminal_authorization' });
}

function deepCloneEvidenceRecord(record: VerifiedEvidenceRecord): VerifiedEvidenceRecord {
  return Object.freeze({
    gameId: record.gameId,
    operationId: record.operationId,
    baseRevision: record.baseRevision,
    baseFen: record.baseFen,
    variant: record.variant,
    rulesVersion: record.rulesVersion,
    question: deepFreezeQuestion(record.question),
    outcome: deepFreezeOutcome(record.outcome),
  });
}

/** Strictly private handle minter: directly sets private WeakMap record. */
function mintHandle(
  prepared: PreparedOperation,
  question: ProofQuestion,
  outcome: VerifiedEvidenceRecord['outcome'],
): AdjudicationEvidenceHandle {
  const handle: AdjudicationEvidenceHandle = Object.freeze({
    operationId: prepared.operationId,
    questionKind: question.kind,
    ...(question.kind === 'directional_reachability' ? { targetWinner: question.winner } : {}),
    ...(question.kind === 'successor_deadness' ? { successorFen: question.successorFen } : {}),
  });

  const record: VerifiedEvidenceRecord = Object.freeze({
    gameId: prepared.gameId,
    operationId: prepared.operationId,
    baseRevision: prepared.baseRevision,
    baseFen: prepared.baseFen,
    variant: prepared.variant,
    rulesVersion: prepared.rulesVersion,
    question: deepFreezeQuestion(question),
    outcome: deepFreezeOutcome(outcome),
  });

  evidenceRegistry.set(handle, record);
  return handle;
}

function evaluateGlobalDeadness(
  prepared: PreparedOperation,
  question: ProofQuestion & { kind: 'global_deadness' },
  options?: AnalysisOptions,
): AdjudicationEvidenceHandle | null {
  const pos = Position.fromFen(prepared.baseFen, prepared.variant);
  const deadRes = analyzeDeadPosition(pos.snapshot(), options);
  if (deadRes.isDead === true) {
    return mintHandle(prepared, question, {
      kind: 'dead',
      provenance: deadRes.white.provenance,
      white: { status: 'impossible', provenance: deadRes.white.provenance },
      black: { status: 'impossible', provenance: deadRes.black.provenance },
    });
  }
  if (deadRes.isDead === false) {
    const uciWitness = verifyWitnessReplay(pos, deadRes.winner, deadRes.witness);
    return mintHandle(prepared, question, {
      kind: 'winnable',
      winner: deadRes.winner,
      witnessUci: uciWitness,
    });
  }
  return null;
}

function evaluateDirectionalReachability(
  prepared: PreparedOperation,
  question: ProofQuestion & { kind: 'directional_reachability' },
  options?: AnalysisOptions,
): AdjudicationEvidenceHandle | null {
  const pos = Position.fromFen(prepared.baseFen, prepared.variant);
  const winRes = analyzeWinnability(pos.snapshot(), question.winner, options);
  if (winRes.status === 'impossible') {
    return mintHandle(prepared, question, {
      kind: 'impossible',
      winner: question.winner,
      provenance: winRes.provenance,
    });
  }
  if (winRes.status === 'reachable') {
    const uciWitness = verifyWitnessReplay(pos, question.winner, winRes.witness);
    return mintHandle(prepared, question, {
      kind: 'winnable',
      winner: question.winner,
      witnessUci: uciWitness,
    });
  }
  return null;
}

function evaluateSuccessorDeadness(
  prepared: PreparedOperation,
  question: ProofQuestion & { kind: 'successor_deadness' },
  options?: AnalysisOptions,
): AdjudicationEvidenceHandle | null {
  if (prepared.intent.kind !== 'move') {
    throw new GameError('Successor deadness question is only valid for move operations');
  }
  if (prepared.intent.successorFen !== question.successorFen) {
    throw new GameError('Successor deadness question FEN does not match prepared move successor FEN');
  }
  const pos = Position.fromFen(question.successorFen, prepared.variant);
  const deadRes = analyzeDeadPosition(pos.snapshot(), options);
  if (deadRes.isDead === true) {
    return mintHandle(prepared, question, {
      kind: 'dead',
      provenance: deadRes.white.provenance,
      white: { status: 'impossible', provenance: deadRes.white.provenance },
      black: { status: 'impossible', provenance: deadRes.black.provenance },
    });
  }
  if (deadRes.isDead === false) {
    const uciWitness = verifyWitnessReplay(pos, deadRes.winner, deadRes.witness);
    return mintHandle(prepared, question, {
      kind: 'winnable',
      winner: deadRes.winner,
      witnessUci: uciWitness,
    });
  }
  return null;
}

/**
 * Evaluates a proof question for an admitted prepared operation using the core engine.
 * Minting a handle occurs ONLY if definitive impossibility or verified reachable mate is proven.
 * Returns null if analysis is pending/incomplete.
 */
export function evaluatePreparedProof(
  prepared: PreparedOperation,
  question: ProofQuestion,
  options?: AnalysisOptions,
): AdjudicationEvidenceHandle | null {
  if (question.kind === 'global_deadness') {
    return evaluateGlobalDeadness(prepared, question, options);
  }
  if (question.kind === 'directional_reachability') {
    return evaluateDirectionalReachability(prepared, question, options);
  }
  if (question.kind === 'successor_deadness') {
    return evaluateSuccessorDeadness(prepared, question, options);
  }
  return null;
}

function assertOperationMetadataMatch(
  record: VerifiedEvidenceRecord,
  prepared: PreparedOperation,
): void {
  if (record.gameId !== prepared.gameId) {
    throw new GameError(`Evidence gameId mismatch: expected "${prepared.gameId}", got "${record.gameId}"`);
  }
  if (record.operationId !== prepared.operationId) {
    throw new GameError(`Evidence operationId mismatch: expected "${prepared.operationId}", got "${record.operationId}"`);
  }
  if (record.baseRevision !== prepared.baseRevision) {
    throw new GameError(`Evidence baseRevision mismatch: expected ${prepared.baseRevision}, got ${record.baseRevision}`);
  }
  if (record.baseFen !== prepared.baseFen) {
    throw new GameError('Evidence baseFen mismatch');
  }
  if (record.variant !== prepared.variant) {
    throw new GameError(`Evidence variant mismatch: expected ${prepared.variant}, got ${record.variant}`);
  }
  if (record.rulesVersion !== prepared.rulesVersion) {
    throw new GameError(`Evidence rulesVersion mismatch: expected "${prepared.rulesVersion}", got "${record.rulesVersion}"`);
  }
}

function assertQuestionMatch(
  recordQuestion: ProofQuestion,
  expectedQuestion: ProofQuestion,
): void {
  if (recordQuestion.kind !== expectedQuestion.kind) {
    throw new GameError(`Evidence question kind mismatch: expected ${expectedQuestion.kind}, got ${recordQuestion.kind}`);
  }
  if (
    recordQuestion.kind === 'directional_reachability' &&
    expectedQuestion.kind === 'directional_reachability' &&
    recordQuestion.winner !== expectedQuestion.winner
  ) {
    throw new GameError(
      `Evidence directional target color mismatch: expected ${expectedQuestion.winner}, got ${recordQuestion.winner}`,
    );
  }
  if (
    recordQuestion.kind === 'successor_deadness' &&
    expectedQuestion.kind === 'successor_deadness' &&
    recordQuestion.successorFen !== expectedQuestion.successorFen
  ) {
    throw new GameError('Evidence successor FEN mismatch');
  }
}

/**
 * Validates that an evidence handle is a genuine, registered handle minted for the exact
 * game, operation, revision, FEN, variant, rules version, and question.
 * Throws GameError on literal objects, spread clones, JSON clones, or cross-operation reuse.
 * Returns a detached, deeply frozen defensive copy of the verified record.
 */
export function getRegisteredEvidence(
  handle: unknown,
  prepared: PreparedOperation,
  expectedQuestion: ProofQuestion,
): VerifiedEvidenceRecord {
  if (typeof handle !== 'object' || handle === null) {
    throw new GameError('Evidence handle must be a non-null registered object');
  }

  const record = evidenceRegistry.get(handle);
  if (!record) {
    throw new GameError('Evidence handle is unauthentic, unregistered, cloned, or serialized');
  }

  assertOperationMetadataMatch(record, prepared);
  assertQuestionMatch(record.question, expectedQuestion);
  return deepCloneEvidenceRecord(record);
}

// ---------------------------------------------------------------------------
// Controller implementation in registry lexical module
// ---------------------------------------------------------------------------

interface FinderLaneState {
  readonly finder: CooperativeWitnessSession;
  prevWorkUnits: number;
  prevLegalGenerations: number;
  prevScoringWork: number;
  prevReplayWork: number;
}

interface ExactLaneState {
  readonly exact: CooperativeSearchSession;
  prevWorkUnits: number;
}

interface SlicedLanes {
  readonly pos: Position;
  readonly wFinder: FinderLaneState;
  readonly bFinder: FinderLaneState;
  readonly wExact: ExactLaneState;
  readonly bExact: ExactLaneState;
  wExactProv?: ProofProvenance;
  bExactProv?: ProofProvenance;
  wFinderRetired?: boolean;
  bFinderRetired?: boolean;
  wExactRetired?: boolean;
  bExactRetired?: boolean;
}

interface TimeoutLanes {
  readonly pos: Position;
  readonly winner: Color;
  readonly finder: FinderLaneState;
  readonly exact: ExactLaneState;
  exactProv?: ProofProvenance;
  finderRetired?: boolean;
  exactRetired?: boolean;
}

interface DomainCompletionCursor {
  readonly role: 'base' | 'successor' | 'timeout';
  readonly winner: Color;
  readonly candidateWitness: readonly Move[];
  readonly pos: Position;
  currentPos: Position;
  currentIndex: number;
  readonly uciMoves: string[];
}

interface JobRecord {
  readonly operationId: string;
  readonly gameId: string;
  readonly prepared: PreparedOperation;
  readonly repetition?: ReadonlyMap<string, number>;
  status: JobStatus;
  requiredRoles: readonly RequiredProofRole[];
  lastComputedBaseOutcome: 'dead' | 'not_dead' | null | undefined;

  staticBaseChecked: boolean;
  baseLanes: SlicedLanes | null;
  succLanes: SlicedLanes | null;
  timeoutLanes: TimeoutLanes | null;
  completionCursor: DomainCompletionCursor | null;

  baseHandle?: AdjudicationEvidenceHandle;
  succHandle?: AdjudicationEvidenceHandle;
  timeoutHandle?: AdjudicationEvidenceHandle;
  terminalHandle?: AdjudicationEvidenceHandle;
  baseOutcome: 'dead' | 'not_dead' | null;

  nextLaneIndex: number;
  workCompleted: number;
  slicesExecuted: number;
  generationWork: number;
  exactWork: number;
  completionWork: number;
  scoringWork: number;
  replayWork: number;
}

function areMoveIntentsMatching(a: PreparedIntent & { kind: 'move' }, b: PreparedIntent): boolean {
  return (
    b.kind === 'move' &&
    a.mover === b.mover &&
    a.uci === b.uci &&
    a.san === b.san &&
    a.successorFen === b.successorFen
  );
}

function areExpireNoShowMatching(
  a: PreparedIntent & { kind: 'expireNoShow' },
  b: PreparedIntent,
): boolean {
  if (b.kind !== 'expireNoShow') return false;
  return (
    a.ending.result === b.ending.result &&
    a.ending.termination === b.ending.termination &&
    a.ending.winner === b.ending.winner &&
    a.ending.at === b.ending.at
  );
}

function areSimpleIntentsMatching(a: PreparedIntent, b: PreparedIntent): boolean {
  if (a.kind === 'move') return areMoveIntentsMatching(a, b);
  if (a.kind === 'creationAdmission') return b.kind === 'creationAdmission';
  if (a.kind === 'expireFlag') return b.kind === 'expireFlag' && a.flagged === b.flagged;
  if (a.kind === 'ready') return b.kind === 'ready' && a.color === b.color && a.isNoop === b.isNoop;
  if (a.kind === 'expireNoShow') return areExpireNoShowMatching(a, b);
  if (b.kind !== a.kind) return false;
  return (a as { color?: Color }).color === (b as { color?: Color }).color;
}

function areIntentsMatching(a: PreparedIntent, b: PreparedIntent): boolean {
  if (a.kind !== b.kind) return false;
  return areSimpleIntentsMatching(a, b);
}

function assertIdenticalPreparedCore(a: PreparedOperation, b: PreparedOperation): void {
  if (a.operationId !== b.operationId) throw new GameError('Conflicting prepared operation: operationId mismatch');
  if (a.gameId !== b.gameId) throw new GameError('Conflicting prepared operation: gameId mismatch');
  if (a.baseRevision !== b.baseRevision) throw new GameError('Conflicting prepared operation: baseRevision mismatch');
  if (a.baseFen !== b.baseFen) throw new GameError('Conflicting prepared operation: baseFen mismatch');
  if (a.variant !== b.variant) throw new GameError('Conflicting prepared operation: variant mismatch');
  if (a.rulesVersion !== b.rulesVersion) throw new GameError('Conflicting prepared operation: rulesVersion mismatch');
}

function assertIdenticalPreparedContext(a: PreparedOperation, b: PreparedOperation): void {
  if (a.at !== b.at) throw new GameError('Conflicting prepared operation: timestamp at mismatch');
  if (!areIntentsMatching(a.intent, b.intent)) throw new GameError('Conflicting prepared operation: intent mismatch');
  if (a.clockPolicy !== b.clockPolicy) throw new GameError('Conflicting prepared operation: clockPolicy mismatch');
  if (a.parentStopId !== b.parentStopId) throw new GameError('Conflicting prepared operation: parentStopId mismatch');
  if (a.turnLineageId !== b.turnLineageId) throw new GameError('Conflicting prepared operation: turnLineageId mismatch');
}

function assertIdenticalPrepared(a: PreparedOperation, b: PreparedOperation): void {
  assertIdenticalPreparedCore(a, b);
  assertIdenticalPreparedContext(a, b);
}

function initFinderLane(pos: Position, winner: Color): FinderLaneState {
  return {
    finder: new CooperativeWitnessSession(pos.snapshot(), winner),
    prevWorkUnits: 0,
    prevLegalGenerations: 0,
    prevScoringWork: 0,
    prevReplayWork: 0,
  };
}

function initExactLane(pos: Position, winner: Color): ExactLaneState {
  return {
    exact: new CooperativeSearchSession(pos.snapshot(), winner),
    prevWorkUnits: 0,
  };
}

function initSlicedLanes(fen: string, variant: PreparedOperation['variant']): SlicedLanes {
  const pos = Position.fromFen(fen, variant);
  return {
    pos,
    wFinder: initFinderLane(pos, 'w'),
    bFinder: initFinderLane(pos, 'b'),
    wExact: initExactLane(pos, 'w'),
    bExact: initExactLane(pos, 'b'),
  };
}

function initTimeoutLanes(fen: string, variant: PreparedOperation['variant'], winner: Color): TimeoutLanes {
  const pos = Position.fromFen(fen, variant);
  return {
    pos,
    winner,
    finder: initFinderLane(pos, winner),
    exact: initExactLane(pos, winner),
  };
}

function resolveGameFromContext(
  gameOrContext?: Game | { game?: Game; repetition?: RepetitionHistory },
): Game | null {
  if (!gameOrContext) return null;
  if (gameOrContext instanceof Game) return gameOrContext;
  if (typeof gameOrContext === 'object' && 'game' in gameOrContext && gameOrContext.game instanceof Game) {
    return gameOrContext.game;
  }
  throw new GameError('Unsupported unauthenticated context: Game instance is required');
}

function assertDetailedPendingMismatch(adj: ReturnType<Game['snapshot']>['adjudication'] & object, prepared: PreparedOperation): void {
  if (adj.rulesVersion !== prepared.rulesVersion) {
    throw new GameError(`Context game rulesVersion does not match prepared: expected "${adj.rulesVersion}", got "${prepared.rulesVersion}"`);
  }
  if (adj.prepared.at !== prepared.at) {
    throw new GameError(`Context game acceptance time does not match prepared: expected ${adj.prepared.at}, got ${prepared.at}`);
  }
  if (!areIntentsMatching(adj.prepared.intent, prepared.intent)) {
    throw new GameError('Context game intent does not match prepared operation intent');
  }
  if (adj.prepared.clockPolicy !== prepared.clockPolicy) {
    throw new GameError(`Context game clockPolicy does not match prepared: expected "${String(adj.prepared.clockPolicy)}", got "${String(prepared.clockPolicy)}"`);
  }
  if (adj.prepared.parentStopId !== prepared.parentStopId) {
    throw new GameError(`Context game parentStopId does not match prepared: expected "${String(adj.prepared.parentStopId)}", got "${String(prepared.parentStopId)}"`);
  }
  if (adj.prepared.turnLineageId !== prepared.turnLineageId) {
    throw new GameError(`Context game turnLineageId does not match prepared: expected "${String(adj.prepared.turnLineageId)}", got "${String(prepared.turnLineageId)}"`);
  }
}

function assertUnstartedPolicy(game: Game, prepared: PreparedOperation): void {
  if (game.clockPolicy !== null) {
    if (prepared.clockPolicy !== game.clockPolicy) {
      throw new GameError(`Context game clockPolicy does not match prepared: expected "${game.clockPolicy}", got "${String(prepared.clockPolicy)}"`);
    }
    return;
  }
  if (prepared.clockPolicy !== undefined) {
    validateClockPolicy(prepared.clockPolicy);
  }
}

function assertUnstartedNonStoppedLineage(game: Game, prepared: PreparedOperation): void {
  if (prepared.parentStopId !== null && prepared.parentStopId !== undefined) {
    throw new GameError('Context game parentStopId must be null for non-stopped game');
  }
  if (prepared.turnLineageId === null || prepared.turnLineageId === undefined) {
    return;
  }
  const canonical = deriveTurnLineageId(game.id, game.ply);
  if (typeof prepared.turnLineageId !== 'string' || prepared.turnLineageId !== canonical) {
    throw new GameError('Context game turnLineageId must be null or canonical for non-stopped game');
  }
}

function assertUnstartedClockMetadata(game: Game, prepared: PreparedOperation): void {
  assertUnstartedPolicy(game, prepared);
  if (game.stoppedClock !== null) {
    if (prepared.parentStopId !== game.stoppedClock.stopId) {
      throw new GameError(`Context game parentStopId does not match prepared: expected "${game.stoppedClock.stopId}", got "${String(prepared.parentStopId)}"`);
    }
    if (prepared.turnLineageId !== game.stoppedClock.turnLineageId) {
      throw new GameError(`Context game turnLineageId does not match prepared: expected "${game.stoppedClock.turnLineageId}", got "${String(prepared.turnLineageId)}"`);
    }
    return;
  }
  if (game.releasedClock !== null) {
    if (prepared.parentStopId !== game.releasedClock.consumedStopId) {
      throw new GameError(`Context game parentStopId does not match prepared: expected "${game.releasedClock.consumedStopId}", got "${String(prepared.parentStopId)}"`);
    }
    if (prepared.turnLineageId !== game.releasedClock.turnLineageId) {
      throw new GameError(`Context game turnLineageId does not match prepared: expected "${game.releasedClock.turnLineageId}", got "${String(prepared.turnLineageId)}"`);
    }
    return;
  }
  assertUnstartedNonStoppedLineage(game, prepared);
}

function assertContextMatchesGame(game: Game, snap: ReturnType<Game['snapshot']>, prepared: PreparedOperation): void {
  if (snap.position.fen() !== prepared.baseFen) {
    throw new GameError('Context game position FEN does not match prepared operation base');
  }
  const adj = game.adjudication;
  if (adj !== null) {
    if (adj.operationId !== prepared.operationId || adj.baseRevision !== prepared.baseRevision || game.eventSequence !== adj.startedSeq) {
      throw new GameError('Context game revision does not match prepared operation base');
    }
    assertDetailedPendingMismatch(adj, prepared);
    return;
  }
  if (game.eventSequence !== prepared.baseRevision) {
    throw new GameError('Context game revision does not match prepared operation base');
  }
  assertUnstartedClockMetadata(game, prepared);
}

function extractAndValidateContext(
  prepared: PreparedOperation,
  gameOrContext?: Game | { game?: Game; repetition?: RepetitionHistory },
): ReadonlyMap<string, number> | undefined {
  const game = resolveGameFromContext(gameOrContext);
  if (!game) return undefined;

  const snap = game.snapshot();
  if (snap.gameId !== prepared.gameId) {
    throw new GameError(`Context gameId "${snap.gameId}" does not match prepared "${prepared.gameId}"`);
  }
  if (snap.variant !== prepared.variant) {
    throw new GameError(`Context variant "${snap.variant}" does not match prepared "${prepared.variant}"`);
  }
  assertContextMatchesGame(game, snap, prepared);
  return snap.repetition ? new Map(snap.repetition) : undefined;
}

function isFinderTerminal(finder: CooperativeWitnessSession): boolean {
  const st = finder.getStatus();
  if (st.status === 'reachable') return true;
  return st.reason !== 'slice_exhausted';
}

function isExactTerminal(exact: CooperativeSearchSession): boolean {
  const st = exact.getStatus();
  if (st.status !== 'pending') return true;
  return st.reason !== 'budget_exhausted';
}

function assertGameMatchesJobPrepared(game: Game, job: JobRecord): void {
  if (game.id !== job.gameId) {
    throw new GameError(`Cannot settle job: Game id mismatch: expected "${job.gameId}", got "${game.id}"`);
  }
  const pending = game.adjudication;
  if (!pending) {
    throw new GameError('Cannot settle job: Game has no pending adjudication');
  }
  const snap = game.snapshot();
  if (snap.position.fen() !== job.prepared.baseFen) {
    throw new GameError('Cannot settle job: Game baseFen mismatch with job');
  }
  if (snap.eventSequence !== pending.startedSeq) {
    throw new GameError('Cannot settle job: Game eventSequence mismatch with pending adjudication');
  }
  assertIdenticalPrepared(job.prepared, pending.prepared);
}

export class AdjudicationJobController {
  readonly #maxJobs: number;
  readonly #jobs = new Map<string, JobRecord>();
  readonly #jobHandles = new Map<string, AdjudicationEvidenceBundle>();
  #jobCursor = 0;

  constructor(options?: ControllerOptions) {
    if (options?.maxJobs !== undefined) {
      const val = options.maxJobs;
      if (typeof val !== 'number' || !Number.isSafeInteger(val) || val <= 0) {
        throw new RangeError(`maxJobs must be a positive safe integer, got ${String(val)}`);
      }
      this.#maxJobs = val;
    } else {
      this.#maxJobs = DEFAULT_MAX_JOBS;
    }
  }

  createJob(
    prepared: PreparedOperation,
    gameOrContext?: Game | { game?: Game; repetition?: RepetitionHistory },
  ): string {
    const existing = this.#jobs.get(prepared.operationId);
    if (existing) {
      assertIdenticalPrepared(existing.prepared, prepared);
      extractAndValidateContext(existing.prepared, gameOrContext);
      return existing.operationId;
    }

    if (this.#jobs.size >= this.#maxJobs) {
      throw new GameError('Job controller at capacity');
    }
    const cloned = clonePreparedOperation(prepared);
    const repetition = extractAndValidateContext(cloned, gameOrContext);
    const reqs = resolveRequiredProofRoles(cloned, null, repetition);

    const record: JobRecord = {
      operationId: cloned.operationId,
      gameId: cloned.gameId,
      prepared: cloned,
      repetition,
      status: reqs.isRootEnding ? 'ready' : 'active',
      requiredRoles: reqs.requiredRoles,
      lastComputedBaseOutcome: null,
      staticBaseChecked: false,
      baseLanes: null,
      succLanes: null,
      timeoutLanes: null,
      completionCursor: null,
      baseOutcome: null,
      nextLaneIndex: 0,
      workCompleted: 0,
      slicesExecuted: 0,
      generationWork: 0,
      exactWork: 0,
      completionWork: 0,
      scoringWork: 0,
      replayWork: 0,
    };

    if (reqs.isRootEnding) {
      this.#initTerminalRootJob(record);
    }

    this.#jobs.set(cloned.operationId, record);
    return cloned.operationId;
  }

  #initTerminalRootJob(record: JobRecord): void {
    const basePos = Position.fromFen(record.prepared.baseFen, record.prepared.variant);
    const status = basePos.status();
    let rootHandle: AdjudicationEvidenceHandle;
    if (status.over && status.reason === 'checkmate') {
      rootHandle = mintHandle(record.prepared, { kind: 'global_deadness' }, {
        kind: 'winnable',
        winner: status.winner,
        witnessUci: Object.freeze([]),
      });
      record.baseHandle = rootHandle;
      record.baseOutcome = 'not_dead';
    } else {
      rootHandle = mintHandle(record.prepared, { kind: 'terminal_authorization' }, {
        kind: 'terminal_authorization',
        termination: status.over ? status.reason : 'terminal',
      });
      record.terminalHandle = rootHandle;
      record.baseOutcome = null;
    }
    record.status = 'ready';
    this.#markReady(record);
  }

  getJob(operationId: string): Readonly<AdjudicationJobView> | undefined {
    const job = this.#jobs.get(operationId);
    if (!job) return undefined;
    return Object.freeze({
      operationId: job.operationId,
      gameId: job.gameId,
      status: job.status,
      requiredRoles: Object.freeze(
        job.requiredRoles.map(r => Object.freeze({ role: r.role, question: deepFreezeQuestion(r.question) })),
      ),
      workCompleted: job.workCompleted,
      slicesExecuted: job.slicesExecuted,
      generationWork: job.generationWork,
      exactWork: job.exactWork,
      completionWork: job.completionWork,
      scoringWork: job.scoringWork,
      replayWork: job.replayWork,
      handlesReady: job.status === 'ready',
    });
  }

  cancelJob(operationId: string): void {
    const job = this.#jobs.get(operationId);
    if (!job || job.status === 'ready' || job.status === 'settled') return;
    job.status = 'cancelled';
    this.#cancelJobSessions(job);
  }

  #cancelJobSessions(job: JobRecord): void {
    job.completionCursor = null;
    job.baseLanes?.wFinder.finder.cancel();
    job.baseLanes?.bFinder.finder.cancel();
    job.baseLanes?.wExact.exact.cancel();
    job.baseLanes?.bExact.exact.cancel();
    job.succLanes?.wFinder.finder.cancel();
    job.succLanes?.bFinder.finder.cancel();
    job.succLanes?.wExact.exact.cancel();
    job.succLanes?.bExact.exact.cancel();
    job.timeoutLanes?.finder.finder.cancel();
    job.timeoutLanes?.exact.exact.cancel();
  }

  evictJob(operationId: string): boolean {
    const job = this.#jobs.get(operationId);
    if (!job) return false;
    if (job.status === 'active') {
      throw new GameError('Cannot evict active adjudication job');
    }
    this.#jobs.delete(operationId);
    this.#jobHandles.delete(operationId);
    return true;
  }

  stepJob(operationId: string, totalWorkBudget: number): JobStepResult {
    const job = this.#jobs.get(operationId);
    if (!job) throw new GameError(`Job not found: ${operationId}`);

    if (job.status !== 'active' || totalWorkBudget <= 0 || !Number.isSafeInteger(totalWorkBudget)) {
      return this.#buildStepResult(job, 0);
    }

    let budgetRemaining = totalWorkBudget;
    if (!job.staticBaseChecked) {
      budgetRemaining = this.#checkStaticBase(job, budgetRemaining);
    }

    if (job.status === 'active' && budgetRemaining > 0) {
      budgetRemaining = this.#stepActiveLanes(job, budgetRemaining);
    }

    job.slicesExecuted++;
    this.#checkReadiness(job);
    const delta = totalWorkBudget - budgetRemaining;
    return this.#buildStepResult(job, delta);
  }

  #checkStaticBase(job: JobRecord, budget: number): number {
    job.staticBaseChecked = true;
    job.workCompleted++;
    const pos = Position.fromFen(job.prepared.baseFen, job.prepared.variant);
    const snap = pos.snapshot();
    const wDead = isStaticallyUnwinnable(snap, 'w');
    const bDead = isStaticallyUnwinnable(snap, 'b');

    if (wDead && bDead) {
      job.baseHandle = mintHandle(job.prepared, { kind: 'global_deadness' }, {
        kind: 'dead',
        provenance: 'static_certificate',
        white: { status: 'impossible', provenance: 'static_certificate' },
        black: { status: 'impossible', provenance: 'static_certificate' },
      });
      job.baseOutcome = 'dead';
    }
    return budget - 1;
  }

  #stepActiveLanes(job: JobRecord, budget: number): number {
    let remaining = budget;
    let consecutiveZero = 0;
    while (remaining > 0 && job.status === 'active') {
      const lane = this.#selectLaneToStep(job);
      if (!lane) break;
      const used = lane.step(1);
      if (used === 0) {
        consecutiveZero++;
        if (consecutiveZero >= 4) break;
        continue;
      }
      consecutiveZero = 0;
      remaining -= used;
      this.#checkReadiness(job);
    }
    return remaining;
  }

  #selectSecondaryLaneToStep(job: JobRecord): { step(b: number): number } | null {
    const hasSucc = job.requiredRoles.some(r => r.role === 'successor');
    if (hasSucc && !job.succHandle) {
      if (job.succLanes && this.#areSlicedLanesExhausted(job.succLanes)) {
        job.status = 'resource_limit';
        return null;
      }
      return this.#stepSuccLane(job);
    }
    const hasTimeout = job.requiredRoles.some(r => r.role === 'timeout');
    if (hasTimeout && !job.timeoutHandle) {
      if (job.timeoutLanes && this.#isTimeoutExhausted(job.timeoutLanes)) {
        job.status = 'resource_limit';
        return null;
      }
      return this.#stepTimeoutLane(job);
    }
    return null;
  }

  #selectLaneToStep(job: JobRecord): { step(b: number): number } | null {
    if (job.completionCursor !== null) {
      return { step: (b: number) => this.#stepCompletionCursor(job, b) };
    }
    if (job.baseOutcome === null) {
      if (job.baseLanes && this.#areSlicedLanesExhausted(job.baseLanes)) {
        job.status = 'resource_limit';
        return null;
      }
      return this.#stepBaseLane(job);
    }
    return this.#selectSecondaryLaneToStep(job);
  }

  #stepBaseLane(job: JobRecord): { step(b: number): number } {
    if (!job.baseLanes) {
      job.baseLanes = initSlicedLanes(job.prepared.baseFen, job.prepared.variant);
    }
    const lanes = job.baseLanes;
    return {
      step: (b: number) => this.#stepGlobalUnit(job, lanes, b),
    };
  }

  #stepSuccLane(job: JobRecord): { step(b: number): number } {
    const succFen = (job.prepared.intent as { successorFen: string }).successorFen;
    if (!job.succLanes) {
      job.succLanes = initSlicedLanes(succFen, job.prepared.variant);
    }
    const lanes = job.succLanes;
    return {
      step: (b: number) => this.#stepGlobalUnit(job, lanes, b),
    };
  }

  #stepTimeoutLane(job: JobRecord): { step(b: number): number } {
    const winnerRole = job.requiredRoles.find(r => r.role === 'timeout')?.question;
    const winColor = (winnerRole as { winner: Color }).winner;
    if (!job.timeoutLanes) {
      job.timeoutLanes = initTimeoutLanes(job.prepared.baseFen, job.prepared.variant, winColor);
    }
    const lanes = job.timeoutLanes;
    const idx = job.nextLaneIndex % 2;
    job.nextLaneIndex++;
    return {
      step: (b: number) => this.#stepTimeoutUnit(job, lanes, idx, b),
    };
  }

  #initCompletion(
    job: JobRecord,
    winner: Color,
    witness: readonly Move[],
    role: 'base' | 'successor' | 'timeout',
  ): void {
    const targetFen = role === 'successor'
      ? (job.prepared.intent as { successorFen: string }).successorFen
      : job.prepared.baseFen;
    const pos = Position.fromFen(targetFen, job.prepared.variant);

    job.completionCursor = {
      role,
      winner,
      candidateWitness: witness,
      pos,
      currentPos: pos,
      currentIndex: 0,
      uciMoves: [],
    };
  }

  #stepCompletionMove(cursor: DomainCompletionCursor): void {
    const candMove = cursor.candidateWitness[cursor.currentIndex];
    const legals = cursor.currentPos.legalMoves();
    const matched = legals.find(l => isCanonicalMoveMatch(l, candMove));
    if (!matched) {
      throw new GameError('Candidate mate witness failed canonical legal replay verification');
    }
    const uci = cursor.currentPos.toUci(matched);
    cursor.uciMoves.push(uci);
    cursor.currentPos = cursor.currentPos.play(matched);
    cursor.currentIndex++;
  }

  #finishCompletion(job: JobRecord, cursor: DomainCompletionCursor): void {
    const status = cursor.currentPos.status();
    if (!status.over || status.reason !== 'checkmate' || status.winner !== cursor.winner) {
      throw new GameError('Candidate mate witness failed canonical legal replay verification');
    }
    const q: ProofQuestion = cursor.role === 'timeout'
      ? { kind: 'directional_reachability', winner: cursor.winner }
      : cursor.role === 'base'
      ? { kind: 'global_deadness' }
      : { kind: 'successor_deadness', successorFen: (job.prepared.intent as { successorFen: string }).successorFen };

    const handle = mintHandle(job.prepared, q, {
      kind: 'winnable',
      winner: cursor.winner,
      witnessUci: cursor.uciMoves,
    });

    if (cursor.role === 'base') {
      job.baseHandle = handle;
      job.baseOutcome = 'not_dead';
    } else if (cursor.role === 'successor') {
      job.succHandle = handle;
    } else {
      job.timeoutHandle = handle;
    }
    job.completionCursor = null;
  }

  #stepCompletionCursor(job: JobRecord, budget: number): number {
    let remaining = budget;
    while (remaining > 0 && job.completionCursor !== null) {
      const cursor = job.completionCursor;
      job.workCompleted++;
      job.completionWork++;
      job.replayWork++;
      remaining--;

      if (cursor.currentIndex < cursor.candidateWitness.length) {
        this.#stepCompletionMove(cursor);
      } else {
        this.#finishCompletion(job, cursor);
      }
    }
    return budget - remaining;
  }

  #areSlicedLanesExhausted(lanes: SlicedLanes): boolean {
    const wF = lanes.wFinderRetired || isFinderTerminal(lanes.wFinder.finder);
    const bF = lanes.bFinderRetired || isFinderTerminal(lanes.bFinder.finder);
    const wE = lanes.wExactRetired || isExactTerminal(lanes.wExact.exact);
    const bE = lanes.bExactRetired || isExactTerminal(lanes.bExact.exact);
    return !!(wF && bF && wE && bE);
  }

  #checkLanesExhaustion(job: JobRecord, lanes: SlicedLanes): void {
    if (job.completionCursor !== null) return;
    const role: 'base' | 'successor' = lanes === job.baseLanes ? 'base' : 'successor';
    const hasHandle = role === 'base' ? !!job.baseHandle : !!job.succHandle;
    if (!hasHandle && this.#areSlicedLanesExhausted(lanes)) {
      job.status = 'resource_limit';
    }
  }

  #stepGlobalFinderLane(job: JobRecord, lanes: SlicedLanes, color: Color, budget: number): number {
    const state = color === 'w' ? lanes.wFinder : lanes.bFinder;
    const retired = color === 'w' ? lanes.wFinderRetired : lanes.bFinderRetired;
    if (retired || isFinderTerminal(state.finder)) return 0;
    return this.#stepGlobalFinder(job, lanes, color, budget);
  }

  #stepGlobalExactLane(job: JobRecord, lanes: SlicedLanes, color: Color, budget: number): number {
    const state = color === 'w' ? lanes.wExact : lanes.bExact;
    const retired = color === 'w' ? lanes.wExactRetired : lanes.bExactRetired;
    if (retired || isExactTerminal(state.exact)) return 0;
    return this.#stepGlobalExact(job, lanes, color, budget);
  }

  #stepGlobalUnit(
    job: JobRecord,
    lanes: SlicedLanes,
    budget: number,
  ): number {
    const idx = job.nextLaneIndex % 4;
    job.nextLaneIndex++;
    if (idx === 0) return this.#stepGlobalFinderLane(job, lanes, 'w', budget);
    if (idx === 1) return this.#stepGlobalFinderLane(job, lanes, 'b', budget);
    if (idx === 2) return this.#stepGlobalExactLane(job, lanes, 'w', budget);
    return this.#stepGlobalExactLane(job, lanes, 'b', budget);
  }

  #stepGlobalFinder(
    job: JobRecord,
    lanes: SlicedLanes,
    color: Color,
    budget: number,
  ): number {
    const finderState = color === 'w' ? lanes.wFinder : lanes.bFinder;
    const res = finderState.finder.resume(budget);
    const counters = finderState.finder.counters;
    const deltaWork = counters.workUnits - finderState.prevWorkUnits;
    const deltaGen = counters.legalGenerations - finderState.prevLegalGenerations;
    const deltaScoring = counters.scoringWork - finderState.prevScoringWork;
    const deltaReplay = counters.replayWork - finderState.prevReplayWork;

    finderState.prevWorkUnits = counters.workUnits;
    finderState.prevLegalGenerations = counters.legalGenerations;
    finderState.prevScoringWork = counters.scoringWork;
    finderState.prevReplayWork = counters.replayWork;

    job.workCompleted += deltaWork;
    job.generationWork += deltaGen;
    job.scoringWork += deltaScoring;
    job.replayWork += deltaReplay;

    const role: 'base' | 'successor' = lanes === job.baseLanes ? 'base' : 'successor';

    if (res.status === 'reachable') {
      if (res.witness.length > MAX_WITNESS_LENGTH) {
        if (color === 'w') lanes.wFinderRetired = true;
        else lanes.bFinderRetired = true;
        this.#checkLanesExhaustion(job, lanes);
      } else {
        this.#initCompletion(job, res.winner, res.witness, role);
      }
    } else if (isFinderTerminal(finderState.finder)) {
      if (color === 'w') lanes.wFinderRetired = true;
      else lanes.bFinderRetired = true;
      this.#checkLanesExhaustion(job, lanes);
    }
    return deltaWork;
  }

  #handleExactReachable(job: JobRecord, lanes: SlicedLanes, color: Color, witness: readonly Move[]): void {
    const role: 'base' | 'successor' = lanes === job.baseLanes ? 'base' : 'successor';
    if (witness.length > MAX_WITNESS_LENGTH) {
      if (color === 'w') lanes.wExactRetired = true;
      else lanes.bExactRetired = true;
      this.#checkLanesExhaustion(job, lanes);
    } else {
      this.#initCompletion(job, color, witness, role);
    }
  }

  #handleExactImpossible(job: JobRecord, lanes: SlicedLanes, color: Color, provenance: ProofProvenance): void {
    const role: 'base' | 'successor' = lanes === job.baseLanes ? 'base' : 'successor';
    if (color === 'w') lanes.wExactProv = provenance;
    else lanes.bExactProv = provenance;
    if (lanes.wExactProv && lanes.bExactProv) {
      this.#mintVerifiedDead(job, lanes, role);
    }
  }

  #stepGlobalExact(
    job: JobRecord,
    lanes: SlicedLanes,
    color: Color,
    budget: number,
  ): number {
    const exactState = color === 'w' ? lanes.wExact : lanes.bExact;
    const before = exactState.exact.getWorkUnits();
    const res = exactState.exact.resumeWork(budget);
    const delta = exactState.exact.getWorkUnits() - before;
    exactState.prevWorkUnits = exactState.exact.getWorkUnits();
    job.workCompleted += delta;
    job.exactWork += delta;

    if (res.status === 'reachable' && res.witness) {
      this.#handleExactReachable(job, lanes, color, res.witness);
      return delta;
    }
    if (res.status === 'impossible' && res.provenance) {
      this.#handleExactImpossible(job, lanes, color, res.provenance);
    } else if (isExactTerminal(exactState.exact)) {
      if (color === 'w') lanes.wExactRetired = true;
      else lanes.bExactRetired = true;
      this.#checkLanesExhaustion(job, lanes);
    }
    return delta;
  }

  #mintVerifiedDead(job: JobRecord, lanes: SlicedLanes, role: 'base' | 'successor'): void {
    const prov: ProofProvenance = lanes.wExactProv === 'closed_graph_material_pruned' || lanes.bExactProv === 'closed_graph_material_pruned'
      ? 'closed_graph_material_pruned'
      : 'closed_graph';

    const q: ProofQuestion = role === 'base'
      ? { kind: 'global_deadness' }
      : { kind: 'successor_deadness', successorFen: (job.prepared.intent as { successorFen: string }).successorFen };

    const handle = mintHandle(job.prepared, q, {
      kind: 'dead',
      provenance: prov,
      white: { status: 'impossible', provenance: lanes.wExactProv! },
      black: { status: 'impossible', provenance: lanes.bExactProv! },
    });
    if (role === 'base') {
      job.baseHandle = handle;
      job.baseOutcome = 'dead';
    } else {
      job.succHandle = handle;
    }
  }

  #isTimeoutExhausted(lanes: TimeoutLanes): boolean {
    const fDone = lanes.finderRetired || isFinderTerminal(lanes.finder.finder);
    const eDone = lanes.exactRetired || isExactTerminal(lanes.exact.exact);
    return !!(fDone && eDone);
  }

  #checkTimeoutExhaustion(job: JobRecord, lanes: TimeoutLanes): void {
    if (job.completionCursor !== null || job.timeoutHandle) return;
    if (this.#isTimeoutExhausted(lanes)) {
      job.status = 'resource_limit';
    }
  }

  #stepTimeoutUnit(job: JobRecord, lanes: TimeoutLanes, idx: number, budget: number): number {
    if (idx === 0) {
      if (lanes.finderRetired || isFinderTerminal(lanes.finder.finder)) return 0;
      return this.#stepTimeoutFinder(job, lanes, budget);
    }
    if (lanes.exactRetired || isExactTerminal(lanes.exact.exact)) return 0;
    return this.#stepTimeoutExact(job, lanes, budget);
  }

  #stepTimeoutFinder(job: JobRecord, lanes: TimeoutLanes, budget: number): number {
    const res = lanes.finder.finder.resume(budget);
    const counters = lanes.finder.finder.counters;
    const deltaWork = counters.workUnits - lanes.finder.prevWorkUnits;
    const deltaGen = counters.legalGenerations - lanes.finder.prevLegalGenerations;
    const deltaScoring = counters.scoringWork - lanes.finder.prevScoringWork;
    const deltaReplay = counters.replayWork - lanes.finder.prevReplayWork;

    lanes.finder.prevWorkUnits = counters.workUnits;
    lanes.finder.prevLegalGenerations = counters.legalGenerations;
    lanes.finder.prevScoringWork = counters.scoringWork;
    lanes.finder.prevReplayWork = counters.replayWork;

    job.workCompleted += deltaWork;
    job.generationWork += deltaGen;
    job.scoringWork += deltaScoring;
    job.replayWork += deltaReplay;

    if (res.status === 'reachable') {
      if (res.witness.length > MAX_WITNESS_LENGTH) {
        lanes.finderRetired = true;
        this.#checkTimeoutExhaustion(job, lanes);
      } else {
        this.#initCompletion(job, lanes.winner, res.witness, 'timeout');
      }
    } else if (isFinderTerminal(lanes.finder.finder)) {
      lanes.finderRetired = true;
      this.#checkTimeoutExhaustion(job, lanes);
    }
    return deltaWork;
  }

  #stepTimeoutExact(job: JobRecord, lanes: TimeoutLanes, budget: number): number {
    const before = lanes.exact.exact.getWorkUnits();
    const res = lanes.exact.exact.resumeWork(budget);
    const delta = lanes.exact.exact.getWorkUnits() - before;
    lanes.exact.prevWorkUnits = lanes.exact.exact.getWorkUnits();
    job.workCompleted += delta;
    job.exactWork += delta;

    if (res.status === 'reachable' && res.witness) {
      if (res.witness.length > MAX_WITNESS_LENGTH) {
        lanes.exactRetired = true;
        this.#checkTimeoutExhaustion(job, lanes);
      } else {
        this.#initCompletion(job, lanes.winner, res.witness, 'timeout');
      }
    } else if (res.status === 'impossible' && res.provenance) {
      const q: ProofQuestion = { kind: 'directional_reachability', winner: lanes.winner };
      job.timeoutHandle = mintHandle(job.prepared, q, {
        kind: 'impossible',
        winner: lanes.winner,
        provenance: res.provenance,
      });
    } else if (isExactTerminal(lanes.exact.exact)) {
      lanes.exactRetired = true;
      this.#checkTimeoutExhaustion(job, lanes);
    }
    return delta;
  }

  #checkReadiness(job: JobRecord): void {
    if (job.status !== 'active') return;
    if (job.baseOutcome !== job.lastComputedBaseOutcome) {
      const reqs = resolveRequiredProofRoles(job.prepared, job.baseOutcome, job.repetition);
      job.requiredRoles = reqs.requiredRoles;
      job.lastComputedBaseOutcome = job.baseOutcome;
    }

    if (job.baseHandle && job.baseOutcome === 'dead') {
      this.#markReady(job);
      return;
    }
    if (!job.baseHandle) return;

    const needsSucc = job.requiredRoles.some(r => r.role === 'successor');
    if (needsSucc && !job.succHandle) return;

    const needsTimeout = job.requiredRoles.some(r => r.role === 'timeout');
    if (needsTimeout && !job.timeoutHandle) return;

    this.#markReady(job);
  }

  #markReady(job: JobRecord): void {
    job.status = 'ready';
    const bundle: AdjudicationEvidenceBundle = Object.freeze({
      ...(job.baseHandle ? { base: job.baseHandle } : {}),
      ...(job.succHandle ? { successor: job.succHandle } : {}),
      ...(job.timeoutHandle ? { timeout: job.timeoutHandle } : {}),
      ...(job.terminalHandle ? { terminal: job.terminalHandle } : {}),
    });
    this.#jobHandles.set(job.operationId, bundle);
  }

  /**
   * Conclude the question a job ran out of resources on as unresolved (Issue #124). The job then
   * resumes any remaining question, or becomes ready. An unresolved outcome never declares a dead
   * position, so settlement applies the ordinary rules, as without proofs. Only a job whose search
   * is exhausted (`resource_limit`) can be concluded this way.
   */
  concludeUnresolved(operationId: string): JobStepResult {
    const job = this.#jobs.get(operationId);
    if (!job) throw new GameError(`Job not found: ${operationId}`);
    if (job.status !== 'resource_limit') {
      throw new GameError(`Only an exhausted job can be concluded unresolved: ${job.status}`);
    }
    const unresolved = { kind: 'unresolved', reason: 'resource_limit' } as const;
    if (!job.baseHandle) {
      job.baseHandle = mintHandle(job.prepared, { kind: 'global_deadness' }, unresolved);
      job.baseOutcome = 'not_dead';
    } else if (job.requiredRoles.some(r => r.role === 'successor') && !job.succHandle) {
      const successorFen = (job.prepared.intent as { successorFen: string }).successorFen;
      job.succHandle = mintHandle(job.prepared, { kind: 'successor_deadness', successorFen }, unresolved);
    } else {
      const timeout = job.requiredRoles.find(r => r.role === 'timeout');
      if (!timeout || job.timeoutHandle) throw new GameError('Exhausted job has no unresolved question');
      job.timeoutHandle = mintHandle(job.prepared, timeout.question, unresolved);
    }
    job.status = 'active';
    this.#checkReadiness(job);
    return this.#buildStepResult(job, 0);
  }

  settleJob(game: Game, operationId: string, at: number): SettlementResult {
    const job = this.#jobs.get(operationId);
    if (!job) throw new GameError(`Job not found: ${operationId}`);
    if (job.status !== 'ready') {
      throw new GameError(`Job is not ready to settle: ${job.status}`);
    }
    const bundle = this.#jobHandles.get(operationId);
    if (!bundle) throw new GameError('No evidence bundle for ready job');

    assertGameMatchesJobPrepared(game, job);

    const result = settlePrepared(game, bundle, at);
    job.status = 'settled';
    return result;
  }

  #buildStepResult(job: JobRecord, deltaWork: number): JobStepResult {
    return Object.freeze({
      operationId: job.operationId,
      status: job.status,
      workCompleted: job.workCompleted,
      deltaWork,
      slicesExecuted: job.slicesExecuted,
      handlesReady: job.status === 'ready',
    });
  }

  stepAll(totalWorkBudget: number): AllStepResult {
    if (typeof totalWorkBudget !== 'number' || !Number.isSafeInteger(totalWorkBudget) || totalWorkBudget <= 0) {
      return Object.freeze({ totalDeltaWork: 0, jobResults: Object.freeze([]) });
    }
    let active = Array.from(this.#jobs.values()).filter(j => j.status === 'active');
    if (active.length === 0) {
      return Object.freeze({ totalDeltaWork: 0, jobResults: Object.freeze([]) });
    }

    let remaining = totalWorkBudget;
    let consecutiveZero = 0;
    const resultsMap = new Map<string, JobStepResult>();

    while (remaining > 0 && active.length > 0) {
      const jobIndex = this.#jobCursor % active.length;
      this.#jobCursor = (this.#jobCursor + 1) % active.length;
      const job = active[jobIndex];
      const res = this.stepJob(job.operationId, 1);
      if (res.deltaWork > 0) {
        remaining -= res.deltaWork;
        consecutiveZero = 0;
      } else {
        consecutiveZero++;
        if (consecutiveZero >= active.length) break;
      }
      resultsMap.set(job.operationId, res);
      if (res.status !== 'active') {
        active = Array.from(this.#jobs.values()).filter(j => j.status === 'active');
      }
    }

    const totalDelta = totalWorkBudget - remaining;
    return Object.freeze({
      totalDeltaWork: totalDelta,
      jobResults: Object.freeze(Array.from(resultsMap.values())),
    });
  }
}

export { verifyWitnessReplay };
