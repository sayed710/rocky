/**
 * Pure helpers for the achievements section of the profile page.
 *
 * The section is a list of rows and a count, so the only thing that can be wrong here is a number.
 * Two facts make that non-trivial, and both come from the contract and the domain rather than taste:
 *
 * - `target` is optional (`PlayerAchievementView` in `packages/api/src/openapi/schemas.ts`) and is
 *   absent for one-shot achievements. The domain reads an absent target as 1 — `resolveAward` in
 *   `packages/achievements/src/award.ts` returns `definition.target ?? 1` — so this file must read
 *   it the same way, or a one-shot achievement renders as `0 / undefined`.
 * - `unlockedAt` is the only authority on whether something is unlocked. Progress reaching the
 *   target is what *causes* an unlock, but the two are stored separately and written by the award
 *   worker together; deriving one from the other would show a badge as earned in the window between
 *   a lowered catalogue target and the next award.
 */
import type { AchievementSummary, PlayerAchievement } from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';

/**
 * An absent target means one step, matching `resolveAward`. A target at or below zero would make
 * the label read `7 / 0`, so it collapses to the same one-step reading.
 */
function targetOf(achievement: PlayerAchievement): number {
  const target = achievement.target;
  if (target === undefined || target <= 0) return 1;
  return target;
}

/**
 * Unlocked strictly by `unlockedAt`, never by progress reaching the target. See the file header for
 * why the two are not interchangeable.
 *
 * Module-private: nothing outside needs the predicate on its own, and exporting it only so a test
 * could assert it directly would be an export with no caller. `progressLabel` is where the rule is
 * observable, and that is where it is tested.
 */
function isUnlocked(achievement: PlayerAchievement): boolean {
  return achievement.unlockedAt !== null;
}

/**
 * The trailing text on a row.
 *
 * An unlocked achievement says so rather than showing `10 / 10`, which reads as a task still in
 * hand. Progress is clamped into its own range on the way out: the writer clamps on award, but the
 * read contract does not guarantee it, and a catalogue target lowered after the fact leaves stored
 * rows above their own target.
 */
export function progressLabel(achievement: PlayerAchievement, i18n: I18nManager): string {
  if (isUnlocked(achievement)) return i18n.t('profile.achievements.unlocked');
  const target = targetOf(achievement);
  const shown = achievement.progress < 0 ? 0 : Math.min(achievement.progress, target);
  return `${shown} / ${target}`;
}

/**
 * The one-line count beside the section heading.
 *
 * The denominator is what is actually on screen, not the size of the catalogue. Hidden achievements
 * are withheld until earned, so an earned one joins both sides of the ratio at once — the count
 * stays truthful without ever revealing how many secrets remain.
 *
 * `pointsTotal` is server-computed over the whole catalogue rather than summed from the rows here,
 * because the rows are one page and the total is not.
 */
export function summaryLabel(
  summary: AchievementSummary,
  achievements: readonly PlayerAchievement[],
  i18n: I18nManager,
): string {
  const points = summary.pointsTotal === 1
    ? i18n.t('profile.achievements.pointsOne')
    : i18n.t('profile.achievements.pointsOther', { count: summary.pointsTotal });
  return i18n.t('profile.achievements.summary', {
    unlocked: summary.unlockedCount,
    total: achievements.length,
    points,
  });
}
