/**
 * Achievements view — a pure DOM helper, in the same shape as the teams and forum renderers.
 *
 * The design system names "badge walls, streak counters, and achievement noise" as something to
 * avoid, so this section deliberately renders as the one List Row treatment every other list uses:
 * no tiles, no medals, no icons, no colour per tier, no progress bar. Tier is a word in the muted
 * metadata voice, because it is real data that costs nothing to state and would cost a new colour
 * scale to show.
 *
 * Achievement names and descriptions come from a static catalogue in the repository rather than
 * from users, but they still go through `el()` as text nodes like everything else — the rule is the
 * treatment of the sink, not a judgement about the source.
 */
import { el } from './dom.js';
import { renderEmpty } from './render-helpers.js';
import { progressLabel } from './achievements-helpers.js';
import type { PlayerAchievement } from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';

export function renderAchievements(
  container: HTMLElement,
  achievements: readonly PlayerAchievement[],
  i18n?: I18nManager,
): void {
  container.replaceChildren();
  if (achievements.length === 0) {
    renderEmpty(container, {
      title: i18n ? i18n.t('profile.achievements.emptyTitle') : 'No achievements available',
      body: i18n ? i18n.t('profile.achievements.emptyBody') : 'Achievements will appear here once the catalogue is published.',
      inline: true,
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const achievement of achievements) {
    // `.panel-row` is `space-between`, so it takes exactly two children. The name and what earns it
    // travel together as the leading child; the standing trails.
    const leading = el(
      doc,
      'span',
      { class: 'row-main' },
      el(doc, 'span', { dir: 'auto' }, achievement.name),
      el(doc, 'span', { class: 'count', dir: 'auto' }, achievement.description),
    );
    const standing = el(
      doc,
      'span',
      { class: 'count achievement-standing' },
      `${achievement.tier} · ${progressLabel(achievement, i18n)}`,
    );
    container.appendChild(el(doc, 'div', { class: 'panel-row' }, leading, standing));
  }
}
