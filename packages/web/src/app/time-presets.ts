/**
 * Shared time-control mappings for lobby game creation.
 *
 * Pure and DOM-free: both lobby game-creation surfaces render the repository's
 * canonical ladder and call {@link presetToTimeControl}, keeping the wire
 * mapping and speed labels unit-tested in one place.
 */
import type { TimeControl } from '../api/models.js';

export interface TimePreset {
  /** Stable id and display label, e.g. `5+3`. */
  readonly id: string;
  /** Initial time in minutes. */
  readonly minutes: number;
  /** Increment per move in seconds. */
  readonly increment: number;
}

/** The curated repository ladder: bullet → classical. */
export const TIME_PRESETS = [
  { id: '1+0', minutes: 1, increment: 0 },
  { id: '2+1', minutes: 2, increment: 1 },
  { id: '3+0', minutes: 3, increment: 0 },
  { id: '3+2', minutes: 3, increment: 2 },
  { id: '5+0', minutes: 5, increment: 0 },
  { id: '5+3', minutes: 5, increment: 3 },
  { id: '10+0', minutes: 10, increment: 0 },
  { id: '10+5', minutes: 10, increment: 5 },
  { id: '15+10', minutes: 15, increment: 10 },
  { id: '30+20', minutes: 30, increment: 20 },
] as const satisfies readonly TimePreset[];

/** The exact presets exposed by the Create-a-Game Web V2 flow. */
export const CREATE_GAME_PRESETS = TIME_PRESETS;

export type CreateGamePresetId = (typeof CREATE_GAME_PRESETS)[number]['id'];

export const CUSTOM_PRESET_ID = 'custom';

/** The untimed choice. Not a preset: it has no minutes/increment to render. */
export const UNLIMITED_TIME_ID = 'unlimited';

/**
 * The only wire shape the server accepts for an untimed game: `parseTimeControl`
 * rejects `kind: 'unlimited'` carrying any non-zero duration.
 */
export const UNLIMITED_TIME_CONTROL: TimeControl = {
  initialMs: 0,
  incrementMs: 0,
  delayMs: 0,
  kind: 'unlimited',
};

/** Product bounds retained from the repository's original custom-time flow. */
export const CUSTOM_LIMITS = {
  minMinutes: 0.5,
  maxMinutes: 180,
  minuteStep: 0.5,
  minIncrement: 0,
  maxIncrement: 60,
} as const;

/** Preselected preset — a rapid game most players reach for. */
export const DEFAULT_PRESET_ID = '10+0';

export type SpeedLabel = 'Bullet' | 'Blitz' | 'Rapid' | 'Classical' | 'Correspondence';

/**
 * Build a `TimeControl` from a minutes/increment pair. `sudden_death` when there
 * is no increment, otherwise `increment`. Values are clamped to whole
 * milliseconds; half-minute (30s) initial times round correctly.
 */
export function presetToTimeControl(minutes: number, increment: number): TimeControl {
  const initialMs = Math.round(minutes * 60_000);
  const incrementMs = Math.round(increment * 1_000);
  return {
    initialMs,
    incrementMs,
    delayMs: 0,
    kind: incrementMs > 0 ? 'increment' : 'sudden_death',
  };
}

export type CustomTimeErrorCode = 'minutes_range' | 'increment_range';

export type CustomTimeValidation =
  | { readonly ok: true; readonly timeControl: TimeControl }
  | {
      readonly ok: false;
      readonly field: 'minutes' | 'increment';
      readonly code: CustomTimeErrorCode;
    };

/** Validate and map the custom inputs before any seek request can be created. */
export function validateCustomTime(minutes: number, increment: number): CustomTimeValidation {
  const minutesValid =
    Number.isFinite(minutes) &&
    minutes >= CUSTOM_LIMITS.minMinutes &&
    minutes <= CUSTOM_LIMITS.maxMinutes &&
    Number.isInteger(minutes / CUSTOM_LIMITS.minuteStep);
  if (!minutesValid) {
    return {
      ok: false,
      field: 'minutes',
      code: 'minutes_range',
    };
  }

  const incrementValid =
    Number.isFinite(increment) &&
    Number.isInteger(increment) &&
    increment >= CUSTOM_LIMITS.minIncrement &&
    increment <= CUSTOM_LIMITS.maxIncrement;
  if (!incrementValid) {
    return {
      ok: false,
      field: 'increment',
      code: 'increment_range',
    };
  }

  return { ok: true, timeControl: presetToTimeControl(minutes, increment) };
}

/**
 * Speed bucket for display only — mirrors the server's estimator
 * (`initial + 40 × increment`, in seconds, with `unlimited` short-circuiting
 * to the correspondence bucket exactly as the server's `classifySpeed` does).
 * The authoritative `speed` on a created seek still comes from the server.
 */
export function estimateSpeed(tc: TimeControl): SpeedLabel {
  // Before the arithmetic: an untimed control carries zero durations, which
  // would otherwise estimate into the shortest bucket rather than the longest.
  if (tc.kind === 'unlimited') return 'Correspondence';
  const estimateSeconds = (tc.initialMs + 40 * tc.incrementMs) / 1000;
  if (estimateSeconds < 180) return 'Bullet';
  if (estimateSeconds < 480) return 'Blitz';
  if (estimateSeconds < 1500) return 'Rapid';
  return 'Classical';
}
