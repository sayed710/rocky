/**
 * @packageDocumentation
 * Chess clock model. Pure, deterministic functions so a game's clock can be
 * reconstructed exactly by replaying its event log (each move records the time
 * charged, not a wall-clock read).
 *
 * Supports Fischer increment and Bronstein/simple delay, which are equivalent
 * for remaining-time accounting: `charged = max(0, elapsed - delay)`.
 */

import type { Color } from '@chess-platform/core';

/** A time control specification. All durations are milliseconds. */
export interface TimeControl {
  /** Base thinking time per side. Use 0 together with `kind: 'unlimited'`. */
  readonly initialMs: number;
  /** Fischer increment added after each move. */
  readonly incrementMs: number;
  /** Delay before a move starts consuming time (Bronstein/US delay). */
  readonly delayMs: number;
  readonly kind: 'increment' | 'delay' | 'sudden_death' | 'unlimited';
}

/** Mutable-by-copy clock state for both sides. */
export interface ClockState {
  readonly remaining: { readonly w: number; readonly b: number };
  /** Timestamp (ms since epoch) when the side to move's turn began, or null before the first move. */
  readonly turnStartedAt: number | null;
}

/** Construct an initial clock for a time control. */
export function initClock(tc: TimeControl, startedAt: number | null = null): ClockState {
  return {
    remaining: { w: tc.initialMs, b: tc.initialMs },
    turnStartedAt: startedAt,
  };
}

/** Classify a time control into a speed bucket (Lichess-style estimate). */
export function classifySpeed(tc: TimeControl): 'ultrabullet' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence' {
  if (tc.kind === 'unlimited') return 'correspondence';
  // Estimated game duration assumes ~40 moves.
  const estimate = tc.initialMs + 40 * tc.incrementMs;
  if (estimate < 30_000) return 'ultrabullet';
  if (estimate < 180_000) return 'bullet';
  if (estimate < 480_000) return 'blitz';
  if (estimate < 1_500_000) return 'rapid';
  if (estimate < 21_600_000) return 'classical';
  return 'correspondence';
}

/** Result of charging a mover's clock for the time they spent. */
export interface ClockCharge {
  readonly clock: ClockState;
  /** Wall-clock time the mover spent this turn. */
  readonly moveTimeMs: number;
  /** Chargeable time after applying delay. */
  readonly chargedMs: number;
  /** True if the mover ran out of time (their move is too late / flag fell). */
  readonly flagged: boolean;
}

/**
 * Charge `mover`'s clock at time `now`, applying delay, and — only if they did
 * not flag — the increment. If the mover flagged, their remaining is clamped to
 * 0 and no increment is applied.
 *
 * @param clock   Current clock state.
 * @param mover   Side that just moved.
 * @param now     Timestamp of the move.
 * @param tc      Time control (for increment/delay).
 * @param moveTimeMs Optional explicit elapsed time (for deterministic replay).
 */
export function charge(
  clock: ClockState,
  mover: Color,
  now: number,
  tc: TimeControl,
  moveTimeMs?: number,
): ClockCharge {
  if (tc.kind === 'unlimited') {
    return { clock, moveTimeMs: moveTimeMs ?? 0, chargedMs: 0, flagged: false };
  }
  const elapsed = moveTimeMs ?? (clock.turnStartedAt === null ? 0 : Math.max(0, now - clock.turnStartedAt));
  const chargeable = Math.max(0, elapsed - (tc.kind === 'delay' ? tc.delayMs : 0));
  const before = clock.remaining[mover];
  let after = before - chargeable;

  const flagged = after <= 0;
  if (flagged) {
    after = 0;
  } else if (tc.kind === 'increment') {
    after += tc.incrementMs;
  }

  const remaining = mover === 'w'
    ? { w: after, b: clock.remaining.b }
    : { w: clock.remaining.w, b: after };

  return {
    clock: { remaining, turnStartedAt: now },
    moveTimeMs: elapsed,
    chargedMs: chargeable,
    flagged,
  };
}

/**
 * The first instant at which {@link hasFlagged} holds for the side to move, or `null` while no clock
 * runs (unlimited, or no anchor yet). For every `now` at or after the anchor,
 * `hasFlagged(clock, side, now, tc) === (now >= flagDeadline(clock, side, tc))`: the side flags once
 * the elapsed time, less any delay, uses up what remains. The `flag_deadlines` trigger (migration
 * 0043) computes exactly this from the stored `MovePlayed`, and a parity test holds them together.
 */
export function flagDeadline(clock: ClockState, sideToMove: Color, tc: TimeControl): number | null {
  if (tc.kind === 'unlimited' || clock.turnStartedAt === null) return null;
  const remaining = clock.remaining[sideToMove];
  if (remaining <= 0) return clock.turnStartedAt;
  return clock.turnStartedAt + (tc.kind === 'delay' ? tc.delayMs : 0) + remaining;
}

/**
 * Would the side to move flag if they let time run until `now` without moving?
 * Used for opponent flag claims.
 */
export function hasFlagged(clock: ClockState, sideToMove: Color, now: number, tc: TimeControl): boolean {
  if (tc.kind === 'unlimited' || clock.turnStartedAt === null) return false;
  const elapsed = Math.max(0, now - clock.turnStartedAt);
  const chargeable = Math.max(0, elapsed - (tc.kind === 'delay' ? tc.delayMs : 0));
  return clock.remaining[sideToMove] - chargeable <= 0;
}
