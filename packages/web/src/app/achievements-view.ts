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
import { isMessageKey } from '../i18n/catalog/index.js';
import { renderInterpolatedText } from '../i18n/bidi.js';

export function renderAchievements(
  container: HTMLElement,
  achievements: readonly PlayerAchievement[],
  i18n: I18nManager,
): void {
  container.replaceChildren();
  if (achievements.length === 0) {
    renderEmpty(container, {
      title: i18n.t('profile.achievements.emptyTitle'),
      body: i18n.t('profile.achievements.emptyBody'),
      inline: true,
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const achievement of achievements) {
    const nameKey = `profile.achievements.catalog.${achievement.key}.name`;
    const descriptionKey = `profile.achievements.catalog.${achievement.key}.description`;
    // `.panel-row` is `space-between`, so it takes exactly two children. The name and what earns it
    // travel together as the leading child; the standing trails.
    const leading = el(
      doc,
      'span',
      { class: 'row-main' },
      el(doc, 'span', { dir: 'auto' }, isMessageKey(nameKey) ? i18n.t(nameKey) : achievement.name),
      el(doc, 'span', { class: 'count', dir: 'auto' }, isMessageKey(descriptionKey) ? i18n.t(descriptionKey) : achievement.description),
    );
    const standing = el(
      doc,
      'span',
      { class: 'count achievement-standing' },
    );
    renderInterpolatedText(standing, '{tier} · {progress}', {
      tier: i18n.t(`profile.achievements.tier.${achievement.tier}`),
      progress: progressLabel(achievement, i18n),
    });
    container.appendChild(el(doc, 'div', { class: 'panel-row' }, leading, standing));
  }
}
