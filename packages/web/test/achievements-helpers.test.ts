import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressLabel, summaryLabel } from '../src/app/achievements-helpers.js';
import type { AchievementSummary, PlayerAchievement } from '../src/api/models.js';
import { createI18nManager } from '../src/i18n/manager.js';

const i18n = createI18nManager();

/** Only `target` may be overridden to an explicit `undefined` — that absence is the case under test. */
type Overrides = Omit<Partial<PlayerAchievement>, 'target'> & { target?: number | undefined };

function achievement(overrides: Overrides = {}): PlayerAchievement {
  const { target, ...rest } = {
    key: 'games-10',
    name: 'Getting Started',
    description: 'Play 10 chess games.',
    category: 'games',
    tier: 'bronze' as const,
    points: 25,
    hidden: false,
    target: 10 as number | undefined,
    progress: 0,
    unlockedAt: null as string | null,
    ...overrides,
  };
  // `exactOptionalPropertyTypes` treats a present-but-undefined `target` as different from an
  // absent one, and the contract's optional field means absent. Omitting the key is the only way
  // to build the shape the API actually sends for a one-shot achievement.
  return { ...rest, ...(target !== undefined ? { target } : {}) };
}

test('an achievement with no target counts to one, matching the domain', () => {
  // `resolveAward` reads `definition.target ?? 1`. Reading `undefined` here instead would render
  // every one-shot achievement — first-game, first-win, speed-demon — as "0 / undefined".
  const oneShot = achievement({ target: undefined, progress: 0 });
  assert.equal(progressLabel(oneShot, i18n), '0 / 1');
});

test('a non-positive target counts to one rather than dividing the row by zero', () => {
  assert.equal(progressLabel(achievement({ target: 0, progress: 0 }), i18n), '0 / 1');
});

test('an unlocked achievement says so instead of showing a finished count', () => {
  const done = achievement({ progress: 10, unlockedAt: '2026-08-04T10:00:00Z' });
  assert.equal(progressLabel(done, i18n), 'Unlocked');
});

test('unlockedAt is the authority, not progress reaching the target', () => {
  // The award worker writes progress and the unlock together. Between a lowered catalogue target
  // and the next award, stored progress can sit at or above the target with no unlock granted —
  // and this row must not claim one the server never gave.
  const atTargetButNotAwarded = achievement({ progress: 10, target: 10, unlockedAt: null });
  assert.equal(progressLabel(atTargetButNotAwarded, i18n), '10 / 10');

  // And the reverse: awarded below target still reads as unlocked, so the label cannot be deriving
  // its answer from the numbers.
  const awardedBelowTarget = achievement({ progress: 3, target: 10, unlockedAt: '2026-08-04T10:00:00Z' });
  assert.equal(progressLabel(awardedBelowTarget, i18n), 'Unlocked');
});

test('progress past a lowered target reads as complete, never past the end', () => {
  // The writer clamps on award; the read contract does not promise it. A target lowered in the
  // catalogue after progress was stored leaves rows above their own target.
  assert.equal(progressLabel(achievement({ progress: 50, target: 10 }), i18n), '10 / 10');
});

test('negative progress floors at zero', () => {
  assert.equal(progressLabel(achievement({ progress: -1, target: 10 }), i18n), '0 / 10');
});

test('the summary counts against what is on screen, not the catalogue', () => {
  // Hidden achievements are withheld until earned, so they join both sides of the ratio at once.
  // Any fixed denominator would leak how many secrets exist.
  const summary: AchievementSummary = { unlockedCount: 2, pointsTotal: 35 };
  const shown = [achievement({ key: 'a' }), achievement({ key: 'b' }), achievement({ key: 'c' })];
  assert.equal(summaryLabel(summary, shown, i18n), '2 of 3 · 35 points');
});

test('one point is singular', () => {
  const summary: AchievementSummary = { unlockedCount: 1, pointsTotal: 1 };
  assert.equal(summaryLabel(summary, [achievement()], i18n), '1 of 1 · 1 point');
});
