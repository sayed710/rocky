/**
 * @packageDocumentation
 * The `games` projection as a pure function of one committed event stream (docs/DATABASE.md §4.2,
 * ADR-0147). Live projection, failure retry and rebuild all fold the whole stream through
 * {@link projectGameStream}, so a row is always exactly what its log prefix says.
 */

import {
  classifySpeed,
  Game,
  type AdjudicationEffect,
  type AdjudicationResolvedEvent,
  type GameCreatedEvent,
  type ResultString,
  type Termination,
} from '@chess-platform/game';
import type { Variant } from '@chess-platform/core';
import type { StoredEvent } from './event-store';
import { CorruptGameStreamError } from './errors';
import type { Speed } from './repositories';

/** Every `games` column the event log determines. `opening_eco` is not in the log and is not projected. */
export interface GameProjection {
  readonly id: string;
  readonly variant: Variant;
  readonly rated: boolean;
  readonly speed: Speed;
  /** Seat references exactly as `GameCreated` recorded them; the store decides whether each is a user. */
  readonly white: string;
  readonly black: string;
  readonly startedAt: Date;
  readonly plyCount: number;
  readonly lastSeq: number;
  readonly result: ResultString | null;
  readonly termination: Termination | null;
  readonly endedAt: Date | null;
}

interface StreamFoldResult {
  readonly plyCount: number;
  readonly ending: { readonly result: ResultString; readonly termination: Termination; readonly at: number } | null;
}

interface LifecycleState {
  phase: 'idle' | 'proving' | 'settling';
  operationId: string | null;
  startedSeq: number | null;
  rulesVersion: string | null;
  intentKind: string | null;
  expectedEffects: AdjudicationEffect[];
}

function isTimeControlShaped(tc: unknown): tc is Parameters<typeof classifySpeed>[0] {
  if (typeof tc !== 'object' || tc === null) return false;
  const { kind, initialMs, incrementMs } = tc as Record<string, unknown>;
  return kind === 'unlimited' || (Number.isFinite(initialMs) && Number.isFinite(incrementMs));
}

function corrupt(gameId: string, reason: string): CorruptGameStreamError {
  return new CorruptGameStreamError(gameId, reason);
}

function validateStreamHeader(gameId: string, created: unknown): GameCreatedEvent {
  const event = created as GameCreatedEvent | undefined;
  if (event?.type !== 'GameCreated') throw corrupt(gameId, 'stream does not start with GameCreated');
  if (!isTimeControlShaped(event.timeControl)) throw corrupt(gameId, 'GameCreated has no readable time control');
  if (typeof event.players?.white !== 'string' || typeof event.players?.black !== 'string') {
    throw corrupt(gameId, 'GameCreated has no readable players');
  }
  if (!Number.isFinite(event.at)) throw corrupt(gameId, 'GameCreated has no readable timestamp');
  return event;
}

function assertStartedLifecycle(gameId: string, event: StoredEvent['event'], seq: number, lc: LifecycleState): void {
  if (event.type !== 'AdjudicationStarted') return;
  if (lc.phase !== 'idle') throw corrupt(gameId, 'AdjudicationStarted while already proving or settling');
  lc.phase = 'proving';
  lc.operationId = event.operationId;
  lc.startedSeq = seq;
  lc.rulesVersion = event.rulesVersion;
  lc.intentKind = event.prepared?.intent?.kind ?? null;
}

function assertResolvedEffects(gameId: string, event: AdjudicationResolvedEvent, lc: LifecycleState): void {
  if (event.effects.length === 0) {
    if (lc.intentKind === 'move' || lc.intentKind === 'resign') {
      throw corrupt(gameId, `AdjudicationResolved zero effects cannot swallow ${lc.intentKind}`);
    }
    lc.phase = 'idle';
    lc.operationId = null;
    lc.startedSeq = null;
    return;
  }
  lc.phase = 'settling';
  lc.expectedEffects = [...event.effects];
}

function assertResolvedLifecycle(gameId: string, event: StoredEvent['event'], lc: LifecycleState): void {
  if (event.type !== 'AdjudicationResolved') return;
  if (lc.phase !== 'proving') throw corrupt(gameId, 'AdjudicationResolved without matching AdjudicationStarted');
  if (event.operationId !== lc.operationId) throw corrupt(gameId, 'AdjudicationResolved operationId mismatch');
  if (event.startedSeq !== lc.startedSeq) throw corrupt(gameId, 'AdjudicationResolved startedSeq mismatch');
  if (event.rulesVersion !== lc.rulesVersion) throw corrupt(gameId, 'AdjudicationResolved rulesVersion mismatch');
  assertResolvedEffects(gameId, event, lc);
}

function assertSettlingEffectMatch(gameId: string, event: StoredEvent['event'], expected: AdjudicationEffect): void {
  if (event.type !== expected.type) {
    throw corrupt(gameId, `settling effect type mismatch: expected ${expected.type}, got ${event.type}`);
  }
  if (event.type === 'MovePlayed' && expected.type === 'MovePlayed') {
    if (event.uci !== expected.uci || event.ply !== expected.ply) {
      throw corrupt(gameId, `settling move mismatch: expected ${expected.uci} ply ${expected.ply}, got ${event.uci} ply ${event.ply}`);
    }
  } else if (event.type === 'GameEnded' && expected.type === 'GameEnded') {
    if (event.result !== expected.result || event.termination !== expected.termination) {
      throw corrupt(gameId, `settling ending mismatch: expected ${expected.result}/${expected.termination}, got ${event.result}/${event.termination}`);
    }
  }
}

function assertSettlingProgress(gameId: string, event: StoredEvent['event'], lc: LifecycleState): void {
  if (event.type === 'AdjudicationStarted' || event.type === 'AdjudicationResolved') return;
  if (lc.phase === 'proving') {
    throw corrupt(gameId, `${event.type} forbidden while proving`);
  }
  if (lc.phase === 'settling') {
    const nextExpected = lc.expectedEffects.shift();
    if (!nextExpected) throw corrupt(gameId, 'extra event while settling');
    assertSettlingEffectMatch(gameId, event, nextExpected);
    if (lc.expectedEffects.length === 0) {
      lc.phase = 'idle';
      lc.operationId = null;
      lc.startedSeq = null;
    }
  }
}

function stepLifecycle(gameId: string, event: StoredEvent['event'], seq: number, lc: LifecycleState): void {
  assertStartedLifecycle(gameId, event, seq, lc);
  assertResolvedLifecycle(gameId, event, lc);
  assertSettlingProgress(gameId, event, lc);
}

function stepStreamEvent(
  gameId: string,
  stored: StoredEvent,
  index: number,
  acc: { plyCount: number; ending: { result: ResultString; termination: Termination; at: number } | null },
): void {
  const { seq, event } = stored;
  if (seq !== index) throw corrupt(gameId, `expected seq ${index}, found ${seq}`);
  if (acc.ending) throw corrupt(gameId, `${event.type} at seq ${seq} follows GameEnded`);
  if (event.type === 'GameCreated' && index > 0) throw corrupt(gameId, `second GameCreated at seq ${seq}`);
  if (event.type === 'MovePlayed') {
    if (event.ply !== acc.plyCount + 1) throw corrupt(gameId, `move at seq ${seq} has ply ${event.ply}, expected ${acc.plyCount + 1}`);
    acc.plyCount = event.ply;
  }
  if (event.type === 'GameEnded') {
    if (!Number.isFinite(event.at)) throw corrupt(gameId, `GameEnded at seq ${seq} has no readable timestamp`);
    acc.ending = { result: event.result, termination: event.termination, at: event.at };
  }
}

function validateLifecycleStream(gameId: string, stream: readonly StoredEvent[]): void {
  const hasLifecycle = stream.some(
    s => s.event.type === 'AdjudicationStarted' || s.event.type === 'AdjudicationResolved',
  );
  if (!hasLifecycle) return;

  try {
    const game = Game.fromEvents(stream.map(s => s.event));
    if (game.phase === 'settling') {
      throw corrupt(gameId, 'stream ends in incomplete settling state');
    }
  } catch (err) {
    if (err instanceof CorruptGameStreamError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw corrupt(gameId, message);
  }
}

function foldStreamEvents(gameId: string, stream: readonly StoredEvent[]): StreamFoldResult {
  validateLifecycleStream(gameId, stream);

  const acc = { plyCount: 0, ending: null as StreamFoldResult['ending'] };
  const lifecycle: LifecycleState = {
    phase: 'idle',
    operationId: null,
    startedSeq: null,
    rulesVersion: null,
    intentKind: null,
    expectedEffects: [],
  };

  for (const [index, stored] of stream.entries()) {
    stepStreamEvent(gameId, stored, index, acc);
    stepLifecycle(gameId, stored.event, stored.seq, lifecycle);
  }

  if (lifecycle.phase === 'settling') {
    throw corrupt(gameId, 'stream ends in incomplete settling state');
  }

  return acc;
}

/**
 * Fold a complete committed stream (ascending `seq` from 0) into its projection.
 *
 * Throws {@link CorruptGameStreamError} for a stream no authority could have written: a gap, a first event
 * that is not `GameCreated`, a second creation, or anything after `GameEnded`. Such a stream is
 * reported and retried by the projector, never partially projected.
 */
export function projectGameStream(gameId: string, stream: readonly StoredEvent[]): GameProjection {
  const created = validateStreamHeader(gameId, stream[0]?.event);
  const { plyCount, ending } = foldStreamEvents(gameId, stream);

  return {
    id: gameId,
    variant: created.variant,
    rated: created.rated,
    speed: classifySpeed(created.timeControl),
    white: created.players.white,
    black: created.players.black,
    startedAt: new Date(created.at),
    plyCount,
    lastSeq: stream.length - 1,
    result: ending?.result ?? null,
    termination: ending?.termination ?? null,
    endedAt: ending ? new Date(ending.at) : null,
  };
}
