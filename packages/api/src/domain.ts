/**
 * @packageDocumentation
 * Shared domain enumerations and parsers. The canonical lists mirror the domain
 * packages and the seeded lookup tables in the persistence migration, so the API
 * validates against exactly the values the engine and database accept.
 */

import type { Variant } from '@chess-platform/core';
import type { TimeControl } from '@chess-platform/game';
import { SPEEDS, type Role, type SeekColor, type Speed } from '@chess-platform/persistence';
import { HttpError } from './http/errors';
import { asObject, oneOf } from './http/validate';

/** Every playable variant (mirrors `Variant` in @chess-platform/core). */
export const VARIANTS: readonly Variant[] = [
  'standard',
  'chess960',
  'kingofthehill',
  'atomic',
  'crazyhouse',
  'threecheck',
  'horde',
  'racingkings',
];

/**
 * The variants a *new game* may be created with.
 *
 * As of ADR-0137 this is every variant, because Chess960 — the one entry ADR-0123 withheld — can now
 * be created truthfully: the server draws a starting-position id and records it on the `GameCreated`
 * event, so a stored `chess960` game says which of the 960 arrangements it actually used.
 *
 * **It stays a separate list from `VARIANTS` even while the two agree.** They answer different
 * questions — what the enum can *name* versus what may be *created* — and they were last equal
 * before a variant with nothing behind it turned out to be creatable. Collapsing them now would
 * delete the distinction that caught that, and re-deriving it later is not the same as never having
 * lost it.
 *
 * Written out rather than derived as `[...VARIANTS]`, for the same reason `OFFERED_VARIANTS` is in
 * the web client: a variant added to `VARIANTS` tomorrow would otherwise become creatable the moment
 * it is named, which is exactly how a hollow variant became playable in the first place. Naming what
 * is creatable means a new one has to be let in deliberately.
 *
 * **This list is the only creatability gate, and that is a change worth stating plainly.** Under
 * ADR-0123 there was a second one: `Game.create` refused `chess960` outright, so this list was the
 * friendlier of two checks and losing it would have cost a status code rather than the rule. That is
 * no longer true. `Game.create` now validates the Chess960 *starting-position* contract — an id is
 * required for that variant and refused for every other — and then creates a game for whatever
 * `Variant` it was handed. Delete or bypass this list and there is nothing behind it.
 *
 * The one place a variant still gets checked outside a request is seek acceptance, which re-reads this
 * list because a stored row can carry a value no request could (ADR-0137 §6). Raised in the CodeRabbit
 * review of PR #12, against a comment that had gone stale in exactly the way that gets a real guard
 * deleted by someone trusting a backstop that is not there.
 */
export const CREATABLE_VARIANTS: readonly Variant[] = [
  'standard',
  'chess960',
  'kingofthehill',
  'atomic',
  'crazyhouse',
  'threecheck',
  'horde',
  'racingkings',
];

/** Every assignable role (mirrors `Role` in @chess-platform/persistence). */
export const ROLES: readonly Role[] = [
  'user',
  'coach',
  'tournament_director',
  'moderator',
  'admin',
];

/** Clock kinds accepted for a time control. */
export const TIME_CONTROL_KINDS: readonly TimeControl['kind'][] = [
  'increment',
  'delay',
  'sudden_death',
  'unlimited',
];

/** Seek color preferences (mirrors `SeekColor` in @chess-platform/persistence). */
export const SEEK_COLORS: readonly SeekColor[] = ['white', 'black', 'random'];

/** Handles: 3–30 chars, alphanumerics plus `_` and `-`. */
export const HANDLE_PATTERN = /^[A-Za-z0-9_-]{3,30}$/;

/** RFC-4122 UUID (any version/variant), the shape of every id column in the schema. */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a path/param value is a well-formed UUID. Rejects malformed ids
 * with a 422 at the edge, before they reach a `UUID` column where the driver
 * would otherwise raise an opaque cast error (surfacing as a 500).
 */
export function parseUuid(value: string, key = 'id'): string {
  if (!UUID_PATTERN.test(value)) {
    throw HttpError.validation(`"${key}" must be a UUID`, { [key]: 'must be a UUID' });
  }
  return value;
}

/** Parse a variant code from an arbitrary string. */
export function parseVariant(value: string, key = 'variant'): Variant {
  return oneOf(value, VARIANTS, key);
}

/**
 * Parse a variant for a route that goes on to create a game.
 *
 * Use this wherever the value ends up in `Game.create` — seeks, bot games, tournaments — and plain
 * `parseVariant` wherever it only describes a position to read.
 */
export function parseCreatableVariant(value: string, key = 'variant'): Variant {
  return oneOf(value, CREATABLE_VARIANTS, key);
}

/** Parse a speed class; with a variant it names one rating pool (ADR-0150). There is no default. */
export function parseSpeed(value: string, key = 'speed'): Speed {
  return oneOf(value, SPEEDS, key);
}

/** Parse a role code from an arbitrary string. */
export function parseRole(value: string, key = 'role'): Role {
  return oneOf(value, ROLES, key);
}

/** Parse a seek color preference from an arbitrary string. */
export function parseSeekColor(value: string, key = 'color'): SeekColor {
  return oneOf(value, SEEK_COLORS, key);
}

const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — generous correspondence ceiling.

/** Validate and normalize a time-control object from a request body. */
export function parseTimeControl(raw: unknown, field = 'timeControl'): TimeControl {
  const obj = asObject(raw, field);
  const kind = oneOf(String(obj['kind'] ?? ''), TIME_CONTROL_KINDS, `${field}.kind`);
  const initialMs = duration(obj['initialMs'], `${field}.initialMs`);
  const incrementMs = duration(obj['incrementMs'], `${field}.incrementMs`);
  const delayMs = duration(obj['delayMs'], `${field}.delayMs`);

  if (kind === 'unlimited') {
    if (initialMs !== 0 || incrementMs !== 0 || delayMs !== 0) {
      throw HttpError.validation('unlimited time control must have zero durations', {
        [field]: 'initialMs/incrementMs/delayMs must be 0 for unlimited',
      });
    }
  } else if (initialMs <= 0) {
    throw HttpError.validation('time control requires a positive initialMs', {
      [`${field}.initialMs`]: 'must be > 0',
    });
  }
  if (kind === 'increment' && delayMs !== 0) {
    throw HttpError.validation('increment time control cannot set delayMs', {
      [`${field}.delayMs`]: 'must be 0 for increment',
    });
  }
  if (kind === 'delay' && incrementMs !== 0) {
    throw HttpError.validation('delay time control cannot set incrementMs', {
      [`${field}.incrementMs`]: 'must be 0 for delay',
    });
  }
  return { initialMs, incrementMs, delayMs, kind };
}

function duration(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw HttpError.validation(`"${key}" must be a non-negative integer`, {
      [key]: 'non-negative integer (milliseconds)',
    });
  }
  if (value > MAX_DURATION_MS) {
    throw HttpError.validation(`"${key}" exceeds the maximum`, { [key]: `max ${MAX_DURATION_MS}` });
  }
  return value;
}
