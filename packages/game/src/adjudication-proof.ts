/**
 * @packageDocumentation
 * Game-owned opaque evidence adapter (Issue #124, Stage 1).
 *
 * Implements a private WeakMap-registered handle boundary. Handles are minted ONLY
 * from internally invoked core proof analyses. Reject literal, cloned, JSON-deserialized,
 * or cross-operation evidence handles. Registry records are deeply frozen and never escape mutable.
 */

import {
  analyzeDeadPosition,
  analyzeWinnability,
  Position,
  type AnalysisOptions,
  type Color,
  type Move,
  type ProofProvenance,
  type Variant,
} from '@chess-platform/core';
import type { PreparedOperation } from './prepared-command';
import { GameError } from './game';

/** The question evaluated by proof analysis. */
export type ProofQuestion =
  | { readonly kind: 'global_deadness' }
  | { readonly kind: 'directional_reachability'; readonly winner: Color }
  | { readonly kind: 'successor_deadness'; readonly successorFen: string };

/**
 * Public opaque evidence handle.
 * Live settlement accepts ONLY registered handles from this module's private WeakMap.
 */
export interface AdjudicationEvidenceHandle {
  readonly operationId: string;
  readonly questionKind: 'global_deadness' | 'directional_reachability' | 'successor_deadness';
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
  | { readonly kind: 'impossible'; readonly winner: Color; readonly provenance: ProofProvenance };

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

/** Process-local WeakMap for authentic evidence handles. */
const evidenceRegistry = new WeakMap<object, VerifiedEvidenceRecord>();

function verifyWitnessReplay(pos: Position, winner: Color, witness: readonly Move[]): readonly string[] {
  let cur = pos;
  const uciMoves: string[] = [];
  for (const m of witness) {
    const legals = cur.legalMoves();
    const matched = legals.find(l => l.from === m.from && l.to === m.to && l.promotion === m.promotion);
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
  return Object.freeze({
    kind: 'impossible',
    winner: outcome.winner,
    provenance: outcome.provenance,
  });
}

function deepFreezeQuestion(question: ProofQuestion): ProofQuestion {
  if (question.kind === 'global_deadness') {
    return Object.freeze({ kind: 'global_deadness' });
  }
  if (question.kind === 'successor_deadness') {
    return Object.freeze({ kind: 'successor_deadness', successorFen: question.successorFen });
  }
  return Object.freeze({ kind: 'directional_reachability', winner: question.winner });
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
  return evaluateSuccessorDeadness(prepared, question, options);
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
