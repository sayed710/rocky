/**
 * @packageDocumentation
 * The `games` projection as a pure function of one committed event stream (docs/DATABASE.md §4.2,
 * ADR-0147). Live projection, failure retry and rebuild all fold the whole stream through
 * {@link projectGameStream}, so a row is always exactly what its log prefix says.
 */

import { classifySpeed, type GameSource, type ResultString, type Termination } from '@chess-platform/game';
import type { Variant } from '@chess-platform/core';
import type { StoredEvent } from './event-store';
import { PersistenceError } from './errors';
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
  /** The pregame lifecycle `GameCreated` recorded, or `null` for a game without one (ADR-0148). */
  readonly source: GameSource | null;
  readonly plyCount: number;
  readonly lastSeq: number;
  readonly result: ResultString | null;
  readonly termination: Termination | null;
  readonly endedAt: Date | null;
}

/**
 * Fold a complete committed stream (ascending `seq` from 0) into its projection.
 *
 * Throws {@link PersistenceError} for a stream no authority could have written: a gap, a first event
 * that is not `GameCreated`, a second creation, or anything after `GameEnded`. Such a stream is
 * reported and retried by the projector, never partially projected.
 */
export function projectGameStream(gameId: string, stream: readonly StoredEvent[]): GameProjection {
  const created = stream[0]?.event;
  if (created?.type !== 'GameCreated') throw corrupt(gameId, 'stream does not start with GameCreated');
  if (!isTimeControlShaped(created.timeControl)) throw corrupt(gameId, 'GameCreated has no readable time control');
  if (typeof created.players?.white !== 'string' || typeof created.players?.black !== 'string') {
    throw corrupt(gameId, 'GameCreated has no readable players');
  }
  if (!Number.isFinite(created.at)) throw corrupt(gameId, 'GameCreated has no readable timestamp');
  const source = created.source ?? null;
  if (source !== null && source !== 'seek' && source !== 'tournament') {
    throw corrupt(gameId, `GameCreated has an unknown source ${JSON.stringify(source)}`);
  }

  let plyCount = 0;
  let ending: { result: ResultString; termination: Termination; at: number } | null = null;
  for (const [index, { seq, event }] of stream.entries()) {
    if (seq !== index) throw corrupt(gameId, `expected seq ${index}, found ${seq}`);
    if (ending) throw corrupt(gameId, `${event.type} at seq ${seq} follows GameEnded`);
    if (event.type === 'GameCreated' && index > 0) throw corrupt(gameId, `second GameCreated at seq ${seq}`);
    if (event.type === 'MovePlayed') {
      if (event.ply !== plyCount + 1) throw corrupt(gameId, `move at seq ${seq} has ply ${event.ply}, expected ${plyCount + 1}`);
      plyCount = event.ply;
    }
    if (event.type === 'GameEnded') {
      if (!Number.isFinite(event.at)) throw corrupt(gameId, `GameEnded at seq ${seq} has no readable timestamp`);
      ending = { result: event.result, termination: event.termination, at: event.at };
    }
  }

  return {
    id: gameId,
    variant: created.variant,
    rated: created.rated,
    speed: classifySpeed(created.timeControl),
    white: created.players.white,
    black: created.players.black,
    startedAt: new Date(created.at),
    source,
    plyCount,
    lastSeq: stream.length - 1,
    result: ending?.result ?? null,
    termination: ending?.termination ?? null,
    endedAt: ending ? new Date(ending.at) : null,
  };
}

function isTimeControlShaped(tc: unknown): tc is Parameters<typeof classifySpeed>[0] {
  if (typeof tc !== 'object' || tc === null) return false;
  const { kind, initialMs, incrementMs } = tc as Record<string, unknown>;
  return kind === 'unlimited' || (Number.isFinite(initialMs) && Number.isFinite(incrementMs));
}

function corrupt(gameId: string, reason: string): PersistenceError {
  return new PersistenceError(`game ${gameId}: ${reason}`);
}
