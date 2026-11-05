/**
 * @packageDocumentation
 * Adjudication lifecycle state machine and settlement builder (Issue #124, Stage 1).
 *
 * Implements:
 * - Deterministic phases: idle -> proving -> settling -> ended.
 * - One deterministic resolution plan builder for live settlement and replay.
 * - validateAdjudicationAppendBatch for atomic settlement batches.
 * - settlePrepared to bind verified evidence handles into resolution events and effects.
 */

import {
  isFrozenDeadPosition,
  opposite,
  Position,
  repetitionKey,
  type Color,
  type Variant,
} from '@chess-platform/core';
import type {
  AdjudicationClockCompletionDescriptor,
  AdjudicationClockPolicy,
  AdjudicationClocksStartedEvent,
  AdjudicationEffect,
  AdjudicationResolvedEvent,
  GameEndedEvent,
  GameEvent,
  GameSource,
  MovePlayedEvent,
  RecordedGlobalOutcome,
  RecordedImpossible,
  RecordedReachable,
  RecordedUnresolved,
  RecordedResolutionEvidence,
} from './events';
import { charge, resumeClockSameTurn, validateDeadline, validateTimestamp, type ClockState, type TimeControl } from './clock';
import { GameError } from './clock';
import { canMate, type Game, type RepetitionHistory } from './game';
import { resolveLegalMove, type PreparedIntent, type PreparedOperation } from './prepared-command';
import {
  getRegisteredEvidence,
  type AdjudicationEvidenceHandle,
} from './adjudication-proof';
import {
  applyCompletedTurn,
  type AdjudicationClockBasis,
} from './adjudication-clock-accounting';
import {
  assertClockCompletionDescriptorMatch,
  buildClockCompletionDescriptor,
  deriveTurnLineageId,
  type GameStoppedClockState,
} from './adjudication-completion';
import { validateStandaloneRecordedReleaseBatch } from './adjudication-release';

/** Adjudication phase of the game aggregate. */
export type AdjudicationPhase = 'idle' | 'proving' | 'settling' | 'ended';

/** Reconstructible pending state while blocked in proving or settling. */
export interface PendingAdjudicationState {
  readonly operationId: string;
  readonly baseRevision: number;
  readonly startedSeq: number;
  readonly acceptedAt: number;
  readonly rulesVersion: string;
  readonly prepared: PreparedOperation;
  readonly originalClock: ClockState;
  readonly thinkingElapsedAtA: number;
  readonly originalNoShowAt: number | null;
  readonly remainingNoShowTimeAtA: number | null;
  readonly resolutionAt?: number;
  readonly cursor: number;
  readonly expectedEffects: readonly AdjudicationEffect[];
  readonly clockPolicy?: AdjudicationClockPolicy;
  readonly originalBasis?: AdjudicationClockBasis | null;
}

export interface ResolutionContext {
  readonly pending: PendingAdjudicationState;
  readonly basePosition: Position;
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly repetition: RepetitionHistory;
  readonly drawOffer: Color | null;
  readonly ready: { readonly w: boolean; readonly b: boolean };
  readonly source: GameSource | null;
  readonly noShowAt: number | null;
  readonly ply: number;
  readonly clockPolicy?: AdjudicationClockPolicy;
  readonly stoppedClock?: GameStoppedClockState | null;
}

/** Deeply clones and freezes an effect, preventing balance/payload aliasing. */
export function deepCloneEffect(e: GameEvent): AdjudicationEffect {
  if (e.type === 'MovePlayed') {
    return Object.freeze({
      ...e,
      remaining: Object.freeze({ ...e.remaining }),
    });
  }
  return Object.freeze({ ...e }) as AdjudicationEffect;
}

function assertMoveRemainingMatch(actual: MovePlayedEvent, expected: MovePlayedEvent, cursor: number): void {
  if (actual.remaining.w !== expected.remaining.w || actual.remaining.b !== expected.remaining.b) {
    throw new GameError(`MovePlayed remaining clock mismatch at cursor ${cursor}`);
  }
}

function assertMoveCoreMatch(actual: MovePlayedEvent, expected: MovePlayedEvent, cursor: number): void {
  if (actual.ply !== expected.ply) throw new GameError(`MovePlayed ply mismatch at cursor ${cursor}: expected ${expected.ply}, got ${actual.ply}`);
  if (actual.uci !== expected.uci) throw new GameError(`MovePlayed uci mismatch at cursor ${cursor}: expected "${expected.uci}", got "${actual.uci}"`);
  if (actual.san !== expected.san) throw new GameError(`MovePlayed san mismatch at cursor ${cursor}: expected "${expected.san}", got "${actual.san}"`);
  if (actual.by !== expected.by) throw new GameError(`MovePlayed mover mismatch at cursor ${cursor}: expected "${expected.by}", got "${actual.by}"`);
  if (actual.moveTimeMs !== expected.moveTimeMs) throw new GameError(`MovePlayed moveTimeMs mismatch at cursor ${cursor}: expected ${expected.moveTimeMs}, got ${actual.moveTimeMs}`);
  if (actual.at !== expected.at) throw new GameError(`MovePlayed timestamp at mismatch at cursor ${cursor}: expected ${expected.at}, got ${actual.at}`);
}

function assertMovePlayedMatch(actual: GameEvent, expected: MovePlayedEvent, cursor: number): void {
  if (actual.type !== 'MovePlayed') {
    throw new GameError(`Settling effect type mismatch at cursor ${cursor}: expected "MovePlayed", got "${actual.type}"`);
  }
  assertMoveCoreMatch(actual, expected, cursor);
  assertMoveRemainingMatch(actual, expected, cursor);
}

function assertGameEndedMatch(actual: GameEvent, expected: GameEndedEvent, cursor: number): void {
  if (actual.type !== 'GameEnded') {
    throw new GameError(`Settling effect type mismatch at cursor ${cursor}: expected "GameEnded", got "${actual.type}"`);
  }
  if (actual.result !== expected.result) throw new GameError(`GameEnded result mismatch at cursor ${cursor}: expected "${expected.result}", got "${actual.result}"`);
  if (actual.termination !== expected.termination) throw new GameError(`GameEnded termination mismatch at cursor ${cursor}: expected "${expected.termination}", got "${actual.termination}"`);
  if (actual.winner !== expected.winner) throw new GameError(`GameEnded winner mismatch at cursor ${cursor}: expected "${expected.winner}", got "${actual.winner}"`);
  if (actual.at !== expected.at) throw new GameError(`GameEnded timestamp at mismatch at cursor ${cursor}: expected ${expected.at}, got ${actual.at}`);
}

interface ActorAtPayload {
  readonly by: string;
  readonly at: number;
}

function assertActorAndAt(actual: GameEvent, expected: ActorAtPayload, cursor: number): void {
  const act = actual as unknown as ActorAtPayload;
  if (act.by !== expected.by || act.at !== expected.at) {
    throw new GameError(`Control effect mismatch at cursor ${cursor}`);
  }
}

function assertLifecycleControlMatch(actual: GameEvent, expected: GameEvent, cursor: number): void {
  if (actual.type !== expected.type) {
    throw new GameError(`Settling effect type mismatch at cursor ${cursor}: expected "${expected.type}", got "${actual.type}"`);
  }
  if (actual.type === 'DrawOffered' || actual.type === 'DrawDeclined' || actual.type === 'PlayerReady') {
    assertActorAndAt(actual, expected as unknown as ActorAtPayload, cursor);
  }
}

/** Asserts that an actual event during settling matches the expected declared effect payload. */
export function assertEffectsMatch(actual: GameEvent, expected: GameEvent, cursor: number): void {
  if (expected.type === 'MovePlayed') {
    assertMovePlayedMatch(actual, expected, cursor);
  } else if (expected.type === 'GameEnded') {
    assertGameEndedMatch(actual, expected, cursor);
  } else {
    assertLifecycleControlMatch(actual, expected, cursor);
  }
}

function assertBatchCompletePlan(before: Game, batch: readonly GameEvent[]): void {
  for (const [idx, event] of batch.entries()) {
    if (event.type === 'AdjudicationResolved') {
      const remainingEffects = batch.slice(idx + 1);
      const isManaged = before.clockPolicy === 'observed-release-v1' || event.clockCompletion !== undefined;
      if (isManaged) {
        if (remainingEffects.length < event.effects.length) {
          throw new GameError('Append batch truncated: declared resolution effects omitted from batch leaving incomplete settling state');
        }
        if (remainingEffects.length > event.effects.length) {
          throw new GameError('Append batch cannot append events after declared resolution suffix');
        }
      } else if (remainingEffects.length < event.effects.length) {
        throw new GameError('Append batch truncated: declared resolution effects omitted from batch leaving incomplete settling state');
      }
    }
  }
}

/**
 * Validates that an append batch respects atomic adjudication lifecycle rules.
 * - A batch may end in `proving`.
 * - A resolution and ALL its declared effects must occur in the SAME batch.
 * - A batch must NEVER commit from `settling` or end in `settling`.
 */
export function validateAdjudicationAppendBatch(before: Game, batch: readonly GameEvent[]): void {
  if (batch.length === 0) {
    throw new GameError('Append batch cannot be empty');
  }
  if (before.phase === 'settling') {
    throw new GameError('Append batch cannot commit from an already settling state');
  }

  const releaseCount = batch.filter(e => e.type === 'AdjudicationClocksStarted').length;
  if (releaseCount > 0) {
    if (batch.length !== 1) {
      throw new GameError('AdjudicationClocksStarted must occupy a standalone append batch; cannot be combined with other events or resolution effects');
    }
    const releaseEvent = batch[0] as AdjudicationClocksStartedEvent;
    validateStandaloneRecordedReleaseBatch(before, releaseEvent);
    return;
  }

  assertBatchCompletePlan(before, batch);
  const folded = before.withEvents(batch);

  if (folded.phase === 'settling') {
    throw new GameError('Append batch leaves adjudication in an incomplete settling state');
  }
}

function resolveTerminalEnding(pos: Position, at: number): GameEndedEvent | null {
  const posStatus = pos.status();
  if (!posStatus.over) return null;

  if (posStatus.reason === 'checkmate' || posStatus.reason === 'variant_win') {
    return {
      type: 'GameEnded',
      result: posStatus.winner === 'w' ? '1-0' : '0-1',
      termination: posStatus.reason === 'checkmate' ? 'checkmate' : 'variant',
      winner: posStatus.winner,
      at,
    };
  }

  if (posStatus.reason === 'variant_draw') {
    return {
      type: 'GameEnded',
      result: '1/2-1/2',
      termination: 'variant',
      winner: null,
      at,
    };
  }

  return {
    type: 'GameEnded',
    result: '1/2-1/2',
    termination: posStatus.reason,
    winner: null,
    at,
  };
}

function resolveCheapDeadEnding(pos: Position, at: number): GameEndedEvent | null {
  if (isFrozenDeadPosition(pos.snapshot())) {
    return { type: 'GameEnded', result: '1/2-1/2', termination: 'dead_position', winner: null, at };
  }
  return null;
}

function resolveRootPrecedenceEnding(pos: Position, at: number): GameEndedEvent | null {
  const term = resolveTerminalEnding(pos, at);
  if (term) return term;
  return resolveCheapDeadEnding(pos, at);
}

function resolveSuccessorEvidenceEnding(
  succEvidence: RecordedResolutionEvidence['successor'],
  expectedFen: string,
  at: number,
): GameEndedEvent | null {
  if (!succEvidence || succEvidence.fen !== expectedFen) {
    throw new GameError('Cannot settle non-terminal move: verified successor deadness evidence is required');
  }
  if (succEvidence.outcome.status === 'dead') {
    return { type: 'GameEnded', result: '1/2-1/2', termination: 'dead_position', winner: null, at };
  }
  if (succEvidence.outcome.status === 'reachable' || succEvidence.outcome.status === 'unresolved') {
    return null;
  }
  throw new GameError('Successor evidence is inconclusive');
}

function resolveSuccessorPositionEnding(
  pos: Position,
  repetitionCount: number,
  succEvidence: RecordedResolutionEvidence['successor'] | undefined,
  at: number,
): GameEndedEvent | null {
  const termEnding = resolveTerminalEnding(pos, at);
  if (termEnding) return termEnding;

  if (repetitionCount >= 3) {
    return { type: 'GameEnded', result: '1/2-1/2', termination: 'threefold', winner: null, at };
  }

  const cheapDeadEnding = resolveCheapDeadEnding(pos, at);
  if (cheapDeadEnding) return cheapDeadEnding;

  return resolveSuccessorEvidenceEnding(succEvidence, pos.fen(), at);
}

function deriveMoveEffects(
  context: ResolutionContext,
  succEvidence: RecordedResolutionEvidence['successor'] | undefined,
  resolutionAt: number,
): readonly AdjudicationEffect[] {
  const intent = context.pending.prepared.intent as { kind: 'move'; uci: string };
  const mover = context.basePosition.turn;
  const moveObj = resolveLegalMove(context.basePosition, intent.uci);
  const san = context.basePosition.toSan(moveObj);
  const succPos = context.basePosition.play(moveObj);

  let moveTimeMs = context.pending.thinkingElapsedAtA;
  let remaining: { readonly w: number; readonly b: number };

  if (context.pending.clockPolicy === 'observed-release-v1' && context.pending.originalBasis) {
    const turnComp = applyCompletedTurn(
      context.pending.originalBasis,
      resolutionAt,
      context.timeControl,
      {
        clearNoShow: true,
        nextLineage: {
          policy: 'observed-release-v1',
        },
      },
    );
    if (turnComp.flagged) {
      throw new GameError(`Cannot play move: clock expired for ${mover}`);
    }
    moveTimeMs = turnComp.moveTimeMs;
    remaining = Object.freeze({ ...turnComp.nextBasis.turnBaseBalances });
  } else {
    const charged = charge(context.pending.originalClock, mover, resolutionAt, context.timeControl, context.pending.thinkingElapsedAtA);
    remaining = Object.freeze({ ...charged.clock.remaining });
  }

  const moveEvent: MovePlayedEvent = {
    type: 'MovePlayed',
    ply: context.ply + 1,
    uci: intent.uci,
    san,
    by: mover,
    moveTimeMs,
    remaining,
    at: resolutionAt,
  };

  const key = repetitionKey(succPos.snapshot());
  const repCount = (context.repetition.get(key) ?? 0) + 1;
  const succEnding = resolveSuccessorPositionEnding(succPos, repCount, succEvidence, resolutionAt);
  if (succEnding) return [moveEvent, succEnding];
  return [moveEvent];
}

function deriveNegotiationEffects(
  intent: PreparedIntent,
  resolutionAt: number,
): readonly AdjudicationEffect[] {
  if (intent.kind === 'resign') {
    return [{
      type: 'GameEnded',
      result: intent.color === 'w' ? '0-1' : '1-0',
      termination: 'resignation',
      winner: opposite(intent.color),
      at: resolutionAt,
    }];
  }
  if (intent.kind === 'offerDraw') {
    return [{ type: 'DrawOffered', by: intent.color, at: resolutionAt }];
  }
  if (intent.kind === 'declineDraw') {
    return [{ type: 'DrawDeclined', by: intent.color, at: resolutionAt }];
  }
  if (intent.kind === 'acceptDraw') {
    return [{ type: 'GameEnded', result: '1/2-1/2', termination: 'agreement', winner: null, at: resolutionAt }];
  }
  if (intent.kind === 'abort') {
    return [{ type: 'GameEnded', result: '*', termination: 'aborted', winner: null, at: resolutionAt }];
  }
  throw new GameError(`Unhandled negotiation intent kind ${(intent as { kind: string }).kind}`);
}

function deriveTimeoutOutcomeEnding(
  timeout: NonNullable<RecordedResolutionEvidence['timeout']>,
  prepared: PreparedOperation,
  at: number,
): GameEndedEvent {
  // An exhausted proof falls back to exactly the unmanaged flag rule: a loss on time unless the
  // winner's material cannot mate at all. It never decides more than that rule would.
  const unresolvedDraw = timeout.outcome.status === 'unresolved' && !canMate(prepared.baseFen, timeout.winner, prepared.variant);
  if (timeout.outcome.status === 'impossible' || unresolvedDraw) {
    return { type: 'GameEnded', result: '1/2-1/2', termination: 'insufficient_material', winner: null, at };
  }
  if (timeout.outcome.status === 'reachable' || timeout.outcome.status === 'unresolved') {
    return {
      type: 'GameEnded',
      result: timeout.winner === 'w' ? '1-0' : '0-1',
      termination: 'timeout',
      winner: timeout.winner,
      at,
    };
  }
  throw new GameError('Pending directional evidence cannot settle');
}

function deriveTimeoutEffects(
  context: ResolutionContext,
  evidence: RecordedResolutionEvidence | undefined,
  resolutionAt: number,
): readonly AdjudicationEffect[] {
  const intent = context.pending.prepared.intent as { kind: 'expireFlag'; flagged: Color };
  const prospectiveWinner = opposite(intent.flagged);
  if (!evidence?.timeout) {
    throw new GameError('Timeout resolution requires directional evidence');
  }
  if (evidence.timeout.winner !== prospectiveWinner) {
    throw new GameError('Timeout evidence winner mismatch');
  }
  return [deriveTimeoutOutcomeEnding(evidence.timeout, context.pending.prepared, resolutionAt)];
}

function deriveLifecycleEffects(
  intent: PreparedIntent,
  resolutionAt: number,
): readonly AdjudicationEffect[] {
  if (intent.kind === 'creationAdmission') return [];
  if (intent.kind === 'ready') {
    return intent.isNoop ? [] : [{ type: 'PlayerReady', by: intent.color, at: resolutionAt }];
  }
  if (intent.kind === 'expireNoShow') {
    return [Object.freeze({
      type: 'GameEnded' as const,
      result: intent.ending.result,
      termination: intent.ending.termination,
      winner: intent.ending.winner,
      at: resolutionAt,
    })];
  }
  return deriveNegotiationEffects(intent, resolutionAt);
}

function deriveRawPlan(
  context: ResolutionContext,
  evidence: RecordedResolutionEvidence | undefined,
  resolutionAt: number,
): readonly AdjudicationEffect[] {
  const rootEnding = resolveRootPrecedenceEnding(context.basePosition, resolutionAt);
  if (rootEnding) return [rootEnding];

  if (evidence?.base?.status === 'dead') {
    return [{
      type: 'GameEnded',
      result: '1/2-1/2',
      termination: 'dead_position',
      winner: null,
      at: resolutionAt,
    }];
  }

  const kind = context.pending.prepared.intent.kind;
  if (kind === 'move') {
    return deriveMoveEffects(context, evidence?.successor, resolutionAt);
  }
  if (kind === 'expireFlag') {
    if (!evidence?.base) {
      throw new GameError('Cannot settle timeout without verified base deadness evidence when root is inconclusive');
    }
    return deriveTimeoutEffects(context, evidence, resolutionAt);
  }
  return deriveLifecycleEffects(context.pending.prepared.intent, resolutionAt);
}

export interface ProjectedBaseState {
  readonly source: GameSource | null;
  readonly ply: number;
  readonly ready: { readonly w: boolean; readonly b: boolean };
  readonly timeControl: TimeControl;
  readonly sideToMove: Color;
  readonly historicalNoShowAt: number | null;
}

export interface ProjectedObligations {
  readonly resumedClock: ClockState;
  readonly resumedNoShowAt: number | null;
}

interface EffectSummary {
  readonly terminal: boolean;
  readonly moveEffect: MovePlayedEvent | null;
  readonly readyW: boolean;
  readonly readyB: boolean;
}

function projectEffectSummary(
  effects: readonly AdjudicationEffect[],
  baseReady: { readonly w: boolean; readonly b: boolean },
): EffectSummary {
  let terminal = false;
  let moveEffect: MovePlayedEvent | null = null;
  let readyW = baseReady.w;
  let readyB = baseReady.b;
  for (const e of effects) {
    if (e.type === 'GameEnded') {
      terminal = true;
    } else if (e.type === 'MovePlayed') {
      moveEffect = e;
    } else if (e.type === 'PlayerReady') {
      if (e.by === 'w') readyW = true;
      if (e.by === 'b') readyB = true;
    }
  }
  return { terminal, moveEffect, readyW, readyB };
}

function isNoShowObligationActive(
  source: GameSource | null,
  summary: EffectSummary,
  projectedPly: number,
  remainingNoShow: number | null,
): boolean {
  if (summary.terminal || projectedPly > 0 || source === null || remainingNoShow === null) {
    return false;
  }
  if (source === 'tournament' && summary.readyW && summary.readyB) {
    return false;
  }
  return true;
}

function projectSurvivingNoShowAt(
  pending: PendingAdjudicationState,
  summary: EffectSummary,
  resolutionAt: number,
  base: ProjectedBaseState,
): number | null {
  const projectedPly = summary.moveEffect ? base.ply + 1 : base.ply;
  if (!isNoShowObligationActive(base.source, summary, projectedPly, pending.remainingNoShowTimeAtA)) {
    return base.historicalNoShowAt;
  }
  const deadline = resolutionAt + (pending.remainingNoShowTimeAtA as number);
  validateTimestamp(deadline, 'Surviving no-show deadline');
  return deadline;
}

function assertSurvivingMoveClock(
  tc: TimeControl,
  moveEffect: MovePlayedEvent,
  resolutionAt: number,
): void {
  if (tc.kind === 'unlimited') return;
  const opponent = opposite(moveEffect.by);
  const delay = tc.kind === 'delay' ? tc.delayMs : 0;
  const opponentDeadline = resolutionAt + delay + moveEffect.remaining[opponent];
  validateDeadline(opponentDeadline, 'Surviving opponent flag deadline');
}

function assertSurvivingSameTurnClock(
  tc: TimeControl,
  origClock: ClockState,
  sideToMove: Color,
  resumedAnchor: number | null,
): void {
  if (tc.kind === 'unlimited' || resumedAnchor === null) return;
  const delay = tc.kind === 'delay' ? tc.delayMs : 0;
  const flagDeadline = resumedAnchor + delay + origClock.remaining[sideToMove];
  validateDeadline(flagDeadline, 'Surviving flag deadline');
}

function projectSurvivingClock(
  pending: PendingAdjudicationState,
  summary: EffectSummary,
  resolutionAt: number,
  base: ProjectedBaseState,
): ClockState {
  if (summary.terminal) {
    return pending.originalClock;
  }
  if (summary.moveEffect) {
    assertSurvivingMoveClock(base.timeControl, summary.moveEffect, resolutionAt);
    return pending.originalClock;
  }
  const resumedClock = resumeClockSameTurn(pending.originalClock, pending.acceptedAt, resolutionAt);
  assertSurvivingSameTurnClock(base.timeControl, pending.originalClock, base.sideToMove, resumedClock.turnStartedAt);
  return resumedClock;
}

export function projectSurvivingObligations(
  pending: PendingAdjudicationState,
  effects: readonly AdjudicationEffect[],
  resolutionAt: number,
  base: ProjectedBaseState,
): ProjectedObligations {
  const summary = projectEffectSummary(effects, base.ready);
  const resumedClock = projectSurvivingClock(pending, summary, resolutionAt, base);
  const resumedNoShowAt = projectSurvivingNoShowAt(pending, summary, resolutionAt, base);
  return { resumedClock, resumedNoShowAt };
}

/**
 * Derives the exact resolution effect plan deterministically from the pending operation,
 * base position state, resolution time R, and structured recorded evidence.
 * Validates that actual surviving obligations (non-discarded flag and no-show deadlines) are representable.
 */
export function deriveResolutionPlan(
  context: ResolutionContext,
  evidence: RecordedResolutionEvidence | undefined,
  resolutionAt: number,
): readonly AdjudicationEffect[] {
  const plan = deriveRawPlan(context, evidence, resolutionAt);
  if (context.pending.clockPolicy !== 'observed-release-v1') {
    projectSurvivingObligations(
      context.pending,
      plan,
      resolutionAt,
      {
        source: context.source,
        ply: context.ply,
        ready: context.ready,
        timeControl: context.timeControl,
        sideToMove: context.basePosition.turn,
        historicalNoShowAt: context.noShowAt,
      },
    );
  }
  return plan;
}

function assertResolvedIdentities(context: ResolutionContext, event: AdjudicationResolvedEvent): void {
  if (event.gameId !== context.pending.prepared.gameId) {
    throw new GameError(`AdjudicationResolved gameId mismatch: expected "${context.pending.prepared.gameId}", got "${event.gameId}"`);
  }
  if (event.operationId !== context.pending.operationId) {
    throw new GameError(`AdjudicationResolved operationId mismatch: expected "${context.pending.operationId}", got "${event.operationId}"`);
  }
  if (event.startedSeq !== context.pending.startedSeq) {
    throw new GameError(`AdjudicationResolved startedSeq mismatch: expected ${context.pending.startedSeq}, got ${event.startedSeq}`);
  }
  if (event.rulesVersion !== context.pending.rulesVersion) {
    throw new GameError(`AdjudicationResolved rulesVersion mismatch: expected "${context.pending.rulesVersion}", got "${event.rulesVersion}"`);
  }
  validateTimestamp(event.at, 'AdjudicationResolved timestamp');
  if (event.at < context.pending.acceptedAt) {
    throw new GameError(`AdjudicationResolved timestamp ${event.at} precedes started timestamp ${context.pending.acceptedAt}`);
  }
}

function assertDeclaredLifecycleShape(effects: readonly AdjudicationEffect[]): void {
  for (const [idx, effect] of effects.entries()) {
    if (
      (effect.type as string) === 'AdjudicationStarted' ||
      (effect.type as string) === 'AdjudicationResolved' ||
      (effect.type as string) === 'GameCreated' ||
      (effect.type as string) === 'AdjudicationClocksStarted'
    ) {
      throw new GameError(`Forbidden nested lifecycle event ${effect.type}`);
    }
    if (effect.type === 'GameEnded' && idx !== effects.length - 1) {
      throw new GameError('Terminal GameEnded effect must be the final declared effect in adjudication plan');
    }
  }
}

function assertNoSwallowedPlan(effects: readonly AdjudicationEffect[], kind: string): void {
  if (effects.length === 0 && (kind === 'move' || kind === 'resign')) {
    throw new GameError(`No-op resolution cannot swallow ${kind === 'resign' ? 'resignation' : kind}`);
  }
}

function checkEmptyWitnessValid(pos: Position, winner: Color): boolean {
  const status = pos.status();
  return status.over && status.reason === 'checkmate' && status.winner === winner;
}

function replaySingleWitnessMove(pos: Position, uci: string): Position {
  if (typeof uci !== 'string' || uci.length < 4 || uci.length > 5) {
    throw new GameError(`Invalid UCI move format "${uci}"`);
  }
  const legals = pos.legalMoves();
  const matched = legals.find(l => pos.toUci(l) === uci);
  if (!matched) {
    throw new GameError(`Candidate mate witness move "${uci}" failed legal replay verification`);
  }
  return pos.play(matched);
}

/**
 * Witnesses this process has already verified, keyed by everything the verdict depends on: the
 * variant, the full FEN (which names every castling rook and the check counters), the winner and the
 * moves. Legal moves and checkmate do not depend on move history, so a witness verified once is
 * valid for every later replay of the same recorded evidence. Without this, every replay of a game
 * re-verified every earlier witness move by move, a cost that grew with the square of the game's
 * length and dominated each admission, settlement and release (Issue #124 soak). Bounded; the
 * oldest entry is dropped first. Only successes are kept, so a forged witness is always rejected.
 */
const VERIFIED_WITNESS_CAPACITY = 4096;
const verifiedWitnesses = new Set<string>();

function witnessKey(pos: Position, winner: Color, witness: readonly string[]): string {
  // A JSON tuple keeps element boundaries: ['a b'] and ['a', 'b'] can never share a key.
  return JSON.stringify([pos.variant, pos.fen(), winner, witness]);
}

/** Replays a candidate mate witness move sequence and verifies checkmate for the claimed winner. */
export function verifyUciWitnessReplay(pos: Position, winner: Color, witness: readonly string[]): void {
  if (!Array.isArray(witness)) throw new GameError('Witness move sequence must be an array');
  if (witness.length > 500) throw new GameError('Witness move sequence exceeds maximum length');
  if (witness.length === 0) {
    if (checkEmptyWitnessValid(pos, winner)) return;
    throw new GameError('Witness move sequence cannot be empty for a non-checkmated root');
  }
  const key = witnessKey(pos, winner, witness);
  if (verifiedWitnesses.has(key)) return;
  replayWitness(pos, winner, witness);
  if (verifiedWitnesses.size >= VERIFIED_WITNESS_CAPACITY) {
    verifiedWitnesses.delete(verifiedWitnesses.values().next().value as string);
  }
  verifiedWitnesses.add(key);
}

function replayWitness(pos: Position, winner: Color, witness: readonly string[]): void {
  let cur = pos;
  for (const uci of witness) {
    cur = replaySingleWitnessMove(cur, uci);
  }
  const status = cur.status();
  if (!status.over || status.reason !== 'checkmate' || status.winner !== winner) {
    throw new GameError('Candidate mate witness failed checkmate verification for claimed winner');
  }
}

function validateRecordedProvenance(prov: unknown): void {
  if (prov !== 'static_certificate' && prov !== 'closed_graph' && prov !== 'closed_graph_material_pruned') {
    throw new GameError(`Unknown evidence provenance "${prov}"`);
  }
}

function validateSideImpossible(side: unknown, colorName: string): void {
  if (typeof side !== 'object' || side === null) {
    throw new GameError(`Dead outcome requires ${colorName} record`);
  }
  const s = side as Record<string, unknown>;
  if (s.status !== 'impossible') {
    throw new GameError(`Dead outcome requires ${colorName} impossible`);
  }
  validateRecordedProvenance(s.provenance);
}

function validateRecordedDeadOutcome(rec: Record<string, unknown>): void {
  validateSideImpossible(rec.white, 'white');
  validateSideImpossible(rec.black, 'black');
}

/** An unresolved outcome carries exactly its status and the one supported reason. */
function validateRecordedUnresolved(rec: Record<string, unknown>): void {
  const keys = Object.keys(rec).sort();
  if (rec.reason !== 'resource_limit' || keys.length !== 2 || keys[0] !== 'reason' || keys[1] !== 'status') {
    throw new GameError('Invalid recorded unresolved outcome');
  }
}

function validateRecordedGlobalOutcome(outcome: unknown, pos: Position): void {
  if (typeof outcome !== 'object' || outcome === null) {
    throw new GameError('Missing recorded global outcome');
  }
  const rec = outcome as Record<string, unknown>;
  if (rec.status === 'dead') {
    validateRecordedDeadOutcome(rec);
  } else if (rec.status === 'reachable') {
    verifyUciWitnessReplay(pos, rec.winner as Color, rec.witness as readonly string[]);
  } else if (rec.status === 'unresolved') {
    validateRecordedUnresolved(rec);
  } else {
    throw new GameError(`Invalid recorded outcome status "${rec.status}"`);
  }
}

function validateRecordedTimeoutDetails(outcome: unknown, expectedWinner: Color, basePos: Position): void {
  if (typeof outcome !== 'object' || outcome === null) {
    throw new GameError('Missing timeout outcome details');
  }
  const o = outcome as Record<string, unknown>;
  if (o.status === 'impossible') {
    validateRecordedProvenance(o.provenance);
  } else if (o.status === 'reachable') {
    if (o.winner !== expectedWinner) {
      throw new GameError('Timeout reachable winner mismatch');
    }
    verifyUciWitnessReplay(basePos, expectedWinner, o.witness as readonly string[]);
  } else if (o.status === 'unresolved') {
    validateRecordedUnresolved(o);
  } else {
    throw new GameError(`Invalid timeout outcome status "${o.status}"`);
  }
}

function validateRecordedTimeoutEvidence(
  timeout: unknown,
  intent: { kind: 'expireFlag'; flagged: Color },
  basePos: Position,
): void {
  if (typeof timeout !== 'object' || timeout === null) {
    throw new GameError('Missing recorded timeout outcome');
  }
  const rec = timeout as Record<string, unknown>;
  const prospectiveWinner = opposite(intent.flagged);
  if (rec.winner !== prospectiveWinner) {
    throw new GameError(`Timeout evidence winner mismatch: expected "${prospectiveWinner}", got "${rec.winner}"`);
  }
  validateRecordedTimeoutDetails(rec.outcome, prospectiveWinner, basePos);
}

export function isSuccessorCheapEnding(succPos: Position, repetition?: RepetitionHistory): boolean {
  if (resolveTerminalEnding(succPos, 0)) return true;
  if (repetition) {
    const key = repetitionKey(succPos.snapshot());
    if ((repetition.get(key) ?? 0) + 1 >= 3) return true;
  }
  return resolveCheapDeadEnding(succPos, 0) !== null;
}

function validateMoveSuccessorEvidence(
  context: ResolutionContext,
  succEvidence: RecordedResolutionEvidence['successor'] | undefined,
): void {
  const intent = context.pending.prepared.intent as { kind: 'move'; uci: string };
  const moveObj = resolveLegalMove(context.basePosition, intent.uci);
  const succPos = context.basePosition.play(moveObj);
  if (isSuccessorCheapEnding(succPos, context.repetition)) return;

  if (!succEvidence || succEvidence.fen !== succPos.fen()) {
    throw new GameError('Cannot settle non-terminal move: verified successor deadness evidence is required');
  }
  validateRecordedGlobalOutcome(succEvidence.outcome, succPos);
}

function validateRecordedResolutionEvidence(
  context: ResolutionContext,
  evidence: RecordedResolutionEvidence | undefined,
  at: number,
): void {
  if (resolveRootPrecedenceEnding(context.basePosition, at)) return;
  if (!evidence?.base) {
    throw new GameError('AdjudicationResolved missing required base evidence');
  }
  validateRecordedGlobalOutcome(evidence.base, context.basePosition);
  if (evidence.base.status === 'dead') return;
  const kind = context.pending.prepared.intent.kind;
  if (kind === 'move') {
    validateMoveSuccessorEvidence(context, evidence.successor);
  } else if (kind === 'expireFlag') {
    if (!evidence.timeout) {
      throw new GameError('AdjudicationResolved missing required timeout evidence');
    }
    validateRecordedTimeoutEvidence(
      evidence.timeout,
      context.pending.prepared.intent as { kind: 'expireFlag'; flagged: Color },
      context.basePosition,
    );
  }
}

function assertBundleNotEmpty(evidence: AdjudicationEvidenceInput): void {
  if (
    isEvidenceBundle(evidence) &&
    !evidence.base &&
    !evidence.successor &&
    !evidence.timeout &&
    !evidence.terminal
  ) {
    throw new GameError('Empty evidence bundle cannot authorize settlement');
  }
}

function assertSettleMoveEvidence(
  recorded: RecordedResolutionEvidence,
  context: ResolutionContext,
): void {
  if (!recorded.base) {
    throw new GameError('Settlement requires verified base deadness evidence: missing required base evidence');
  }
  if (recorded.base.status === 'dead') return;
  const intent = context.pending.prepared.intent as { kind: 'move'; uci: string };
  const moveObj = resolveLegalMove(context.basePosition, intent.uci);
  const succPos = context.basePosition.play(moveObj);
  if (!isSuccessorCheapEnding(succPos, context.repetition) && !recorded.successor) {
    throw new GameError('Settlement requires verified successor deadness evidence');
  }
}

function assertSettlePreparedEvidence(
  recorded: RecordedResolutionEvidence,
  context: ResolutionContext,
  isRootEnding: boolean,
): void {
  if (isRootEnding) return;
  if (!recorded.base) {
    throw new GameError('Settlement requires verified base deadness evidence: missing required base evidence');
  }
  if (recorded.base.status === 'dead') return;
  const kind = context.pending.prepared.intent.kind;
  if (kind === 'move') {
    assertSettleMoveEvidence(recorded, context);
  } else if (kind === 'expireFlag' && !recorded.timeout) {
    throw new GameError('Settlement missing required timeout evidence');
  }
}

/**
 * Validates a recorded resolution event against the pending context and returns the derived plan.
 * Declared effects must equal the derived plan field-for-field.
 */
export function validateRecordedResolution(
  context: ResolutionContext,
  event: AdjudicationResolvedEvent,
): readonly AdjudicationEffect[] {
  assertResolvedIdentities(context, event);
  assertDeclaredLifecycleShape(event.effects);
  assertNoSwallowedPlan(event.effects, context.pending.prepared.intent.kind);
  validateRecordedResolutionEvidence(context, event.evidence, event.at);

  const derivedPlan = deriveResolutionPlan(context, event.evidence, event.at);

  if (event.effects.length !== derivedPlan.length) {
    throw new GameError(
      `Declared adjudication effects do not match deterministic resolution plan: expected ${derivedPlan.length} effects, got ${event.effects.length}`,
    );
  }

  for (let i = 0; i < derivedPlan.length; i++) {
    assertEffectsMatch(event.effects[i]!, derivedPlan[i]!, i);
  }

  const hasEnding = derivedPlan.some(e => e.type === 'GameEnded');
  const moveEffect = derivedPlan.find(e => e.type === 'MovePlayed') as MovePlayedEvent | undefined;
  const resultingSide = moveEffect ? (moveEffect.by === 'w' ? 'b' : 'w') : context.basePosition.turn;
  const resultingPly = moveEffect ? moveEffect.ply : context.ply;
  const turnLineageId = deriveTurnLineageId(
    context.pending.prepared.gameId,
    resultingPly,
    context.pending.prepared.turnLineageId,
    moveEffect !== undefined,
  );
  const resolvedSeq = context.pending.startedSeq + 1;
  const expectedDescriptor = context.pending.clockPolicy === 'observed-release-v1'
    ? buildClockCompletionDescriptor({
        policy: 'observed-release-v1',
        isTerminal: hasEnding,
        operationId: context.pending.operationId,
        startedSeq: context.pending.startedSeq,
        resolvedSeq,
        effectCount: derivedPlan.length,
        resultingSideToMove: resultingSide,
        resultingPly,
        turnLineageId,
        parentStopId: context.pending.prepared.parentStopId ?? null,
      })
    : undefined;
  assertClockCompletionDescriptorMatch(event.clockCompletion, expectedDescriptor);

  return Object.freeze(derivedPlan.map(e => deepCloneEffect(e)));
}

export type AdjudicationEvidenceBundle = {
  readonly base?: AdjudicationEvidenceHandle;
  readonly successor?: AdjudicationEvidenceHandle;
  readonly timeout?: AdjudicationEvidenceHandle;
  readonly terminal?: AdjudicationEvidenceHandle;
};

/** Input evidence to settlePrepared. Can be a single handle, handle array, or bundle object. */
export type AdjudicationEvidenceInput =
  | AdjudicationEvidenceHandle
  | readonly AdjudicationEvidenceHandle[]
  | AdjudicationEvidenceBundle;

function findHandleInBundle(
  bundle: AdjudicationEvidenceBundle,
  kind: 'global_deadness' | 'directional_reachability' | 'successor_deadness' | 'terminal_authorization',
): AdjudicationEvidenceHandle | undefined {
  if (kind === 'terminal_authorization') return bundle.terminal;
  if (kind === 'successor_deadness') return bundle.successor;
  if (kind === 'directional_reachability') {
    if (bundle.timeout) return bundle.timeout;
    return bundle.base?.questionKind === 'directional_reachability' ? bundle.base : undefined;
  }
  return bundle.base?.questionKind === 'global_deadness' ? bundle.base : (bundle.base ?? undefined);
}

function isEvidenceBundle(evidence: unknown): evidence is AdjudicationEvidenceBundle {
  return typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence) && !('questionKind' in evidence);
}

function findEvidenceHandle(
  evidence: AdjudicationEvidenceInput,
  kind: 'global_deadness' | 'directional_reachability' | 'successor_deadness' | 'terminal_authorization',
): AdjudicationEvidenceHandle | undefined {
  if (Array.isArray(evidence)) {
    return evidence.find(h => h.questionKind === kind);
  }
  if (typeof evidence !== 'object' || evidence === null) return undefined;
  if ('questionKind' in evidence) {
    const handle = evidence as AdjudicationEvidenceHandle;
    return handle.questionKind === kind ? handle : undefined;
  }
  if (isEvidenceBundle(evidence)) {
    return findHandleInBundle(evidence, kind);
  }
  return undefined;
}

function extractGlobalOutcome(rec: ReturnType<typeof getRegisteredEvidence>): RecordedGlobalOutcome {
  if (rec.outcome.kind === 'dead') {
    return {
      status: 'dead',
      white: { status: 'impossible', provenance: rec.outcome.white.provenance },
      black: { status: 'impossible', provenance: rec.outcome.black.provenance },
    };
  }
  if (rec.outcome.kind === 'winnable') {
    return {
      status: 'reachable',
      winner: rec.outcome.winner,
      witness: rec.outcome.witnessUci,
    };
  }
  if (rec.outcome.kind === 'unresolved') {
    return { status: 'unresolved', reason: rec.outcome.reason };
  }
  throw new GameError('Pending global deadness evidence cannot settle');
}

function extractSuccessorOutcome(
  succHandle: AdjudicationEvidenceHandle,
  pending: PendingAdjudicationState,
): { fen: string; outcome: RecordedGlobalOutcome } {
  const intent = pending.prepared.intent as { kind: 'move'; successorFen: string };
  const succRec = getRegisteredEvidence(succHandle, pending.prepared, {
    kind: 'successor_deadness',
    successorFen: intent.successorFen,
  });
  return {
    fen: intent.successorFen,
    outcome: extractGlobalOutcome(succRec),
  };
}

function extractTimeoutOutcome(
  dirHandle: AdjudicationEvidenceHandle,
  pending: PendingAdjudicationState,
): { winner: Color; outcome: RecordedImpossible | RecordedReachable | RecordedUnresolved } {
  const intent = pending.prepared.intent as { kind: 'expireFlag'; flagged: Color };
  const prospectiveWinner = opposite(intent.flagged);
  const dirRec = getRegisteredEvidence(dirHandle, pending.prepared, {
    kind: 'directional_reachability',
    winner: prospectiveWinner,
  });
  if (dirRec.outcome.kind === 'impossible') {
    return {
      winner: prospectiveWinner,
      outcome: { status: 'impossible', provenance: dirRec.outcome.provenance },
    };
  }
  if (dirRec.outcome.kind === 'winnable') {
    return {
      winner: prospectiveWinner,
      outcome: { status: 'reachable', winner: prospectiveWinner, witness: dirRec.outcome.witnessUci },
    };
  }
  if (dirRec.outcome.kind === 'unresolved') {
    return { winner: prospectiveWinner, outcome: { status: 'unresolved', reason: dirRec.outcome.reason } };
  }
  throw new GameError('Pending directional evidence cannot settle');
}

function extractRecordedEvidence(
  evidence: AdjudicationEvidenceInput,
  pending: PendingAdjudicationState,
): RecordedResolutionEvidence {
  const result: {
    base?: RecordedGlobalOutcome;
    successor?: { fen: string; outcome: RecordedGlobalOutcome };
    timeout?: { winner: Color; outcome: RecordedImpossible | RecordedReachable | RecordedUnresolved };
  } = {};

  const termHandle = findEvidenceHandle(evidence, 'terminal_authorization');
  if (termHandle) {
    getRegisteredEvidence(termHandle, pending.prepared, { kind: 'terminal_authorization' });
    return Object.freeze(result);
  }

  const baseHandle = findEvidenceHandle(evidence, 'global_deadness');
  if (baseHandle) {
    const baseRec = getRegisteredEvidence(baseHandle, pending.prepared, { kind: 'global_deadness' });
    result.base = extractGlobalOutcome(baseRec);
  }

  const succHandle = findEvidenceHandle(evidence, 'successor_deadness');
  if (succHandle) {
    result.successor = extractSuccessorOutcome(succHandle, pending);
  }

  const dirHandle = findEvidenceHandle(evidence, 'directional_reachability');
  if (dirHandle) {
    result.timeout = extractTimeoutOutcome(dirHandle, pending);
  }

  return Object.freeze(result);
}

function validateDeclaredPlan(effects: readonly AdjudicationEffect[]): void {
  for (const [idx, effect] of effects.entries()) {
    if (effect.type === 'GameEnded' && idx !== effects.length - 1) {
      throw new GameError('Terminal GameEnded effect must be the final declared effect in adjudication plan');
    }
  }
}

/** Settlement result returned by settlePrepared. */
export interface SettlementResult {
  readonly resolved: AdjudicationResolvedEvent;
  readonly effects: readonly AdjudicationEffect[];
  readonly batch: readonly GameEvent[];
  readonly game: Game;
}

function assertSettlementPreconditions(
  game: Game,
  pending: PendingAdjudicationState | null,
  resolutionAt: number,
  evidence: AdjudicationEvidenceInput,
): void {
  if (game.phase !== 'proving') {
    throw new GameError(`Cannot settle adjudication: game is in phase "${game.phase}", expected "proving"`);
  }
  if (!pending) {
    throw new GameError('Missing pending adjudication state');
  }
  validateTimestamp(resolutionAt, 'Resolution timestamp');
  if (resolutionAt < pending.acceptedAt) {
    throw new GameError(`Resolution timestamp ${resolutionAt} cannot precede suspension timestamp ${pending.acceptedAt}`);
  }
  assertBundleNotEmpty(evidence);
}

function resolveSettlementClockCompletion(
  pending: PendingAdjudicationState,
  derivedPlan: readonly AdjudicationEffect[],
  s: ReturnType<Game['snapshot']>,
): AdjudicationClockCompletionDescriptor | undefined {
  if (pending.clockPolicy !== 'observed-release-v1') {
    return undefined;
  }
  const hasEnding = derivedPlan.some(e => e.type === 'GameEnded');
  const moveEffect = derivedPlan.find(e => e.type === 'MovePlayed') as MovePlayedEvent | undefined;
  const resultingSide = moveEffect ? (moveEffect.by === 'w' ? 'b' : 'w') : s.position.turn;
  const resultingPly = moveEffect ? moveEffect.ply : s.ply;
  const turnLineageId = deriveTurnLineageId(
    pending.prepared.gameId,
    resultingPly,
    pending.prepared.turnLineageId,
    moveEffect !== undefined,
  );
  return buildClockCompletionDescriptor({
    policy: 'observed-release-v1',
    isTerminal: hasEnding,
    operationId: pending.operationId,
    startedSeq: pending.startedSeq,
    resolvedSeq: pending.startedSeq + 1,
    effectCount: derivedPlan.length,
    resultingSideToMove: resultingSide,
    resultingPly,
    turnLineageId,
    parentStopId: pending.prepared.parentStopId ?? null,
  });
}

/**
 * Builds an atomic settlement batch from a pending game and verified evidence handle.
 * Binds resolution and declared effect events, validates the batch, and applies it.
 */
export function settlePrepared(
  game: Game,
  evidence: AdjudicationEvidenceInput,
  resolutionAt: number,
): SettlementResult {
  const pending = game.adjudication;
  assertSettlementPreconditions(game, pending, resolutionAt, evidence);
  const recordedEvidence = extractRecordedEvidence(evidence, pending!);
  const s = game.snapshot();
  const rootEnding = resolveRootPrecedenceEnding(s.position, resolutionAt);

  const context: ResolutionContext = {
    pending: pending!,
    basePosition: s.position,
    variant: s.variant,
    timeControl: s.timeControl,
    repetition: s.repetition,
    drawOffer: s.drawOffer,
    ready: s.ready,
    source: s.source,
    noShowAt: s.noShowAt,
    ply: s.ply,
    ...(pending!.clockPolicy ? { clockPolicy: pending!.clockPolicy } : {}),
    stoppedClock: game.stoppedClock,
  };
  assertSettlePreparedEvidence(recordedEvidence, context, rootEnding !== null);

  const derivedPlan = deriveResolutionPlan(context, recordedEvidence, resolutionAt);

  if ((pending!.prepared.intent.kind === 'move' || pending!.prepared.intent.kind === 'resign') && derivedPlan.length === 0) {
    throw new GameError(`No-op resolution cannot swallow ${pending!.prepared.intent.kind}`);
  }

  validateDeclaredPlan(derivedPlan);

  const clockCompletion = resolveSettlementClockCompletion(pending!, derivedPlan, s);

  const resolved: AdjudicationResolvedEvent = Object.freeze({
    type: 'AdjudicationResolved',
    gameId: pending!.prepared.gameId,
    operationId: pending!.operationId,
    baseRevision: pending!.baseRevision,
    startedSeq: pending!.startedSeq,
    at: resolutionAt,
    rulesVersion: pending!.rulesVersion,
    evidence: recordedEvidence,
    effects: Object.freeze(derivedPlan.map(e => deepCloneEffect(e))),
    ...(clockCompletion !== undefined ? { clockCompletion } : {}),
  });

  const batch: readonly GameEvent[] = Object.freeze([resolved, ...resolved.effects]);
  validateAdjudicationAppendBatch(game, batch);
  const updatedGame = game.withEvents(batch);

  return {
    resolved,
    effects: resolved.effects,
    batch,
    game: updatedGame,
  };
}
