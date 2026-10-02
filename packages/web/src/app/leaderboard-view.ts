import { el } from './dom.js';
import { renderEmpty } from './render-helpers.js';
import { shortId } from '../api/graphql.js';
import { OFFERED_VARIANTS, SPEEDS } from '../api/models.js';
import { getSpeedLabel, getVariantLabel } from './variant-labels.js';
import type { I18n } from '../i18n/manager.js';
import type { LeaderboardEntry, Speed, Variant, SocialPlayer } from '../api/models.js';

export function renderLeaderboard(
  container: HTMLElement,
  entries: readonly LeaderboardEntry[],
  names: ReadonlyMap<string, SocialPlayer>,
  i18n: I18n,
): void {
  container.innerHTML = '';
  if (entries.length === 0) {
    container.setAttribute('role', 'status');
    renderEmpty(container, {
      title: i18n.t('leaderboard.emptyEntriesTitle'),
      body: i18n.t('leaderboard.emptyEntriesBody'),
    });
    return;
  }

  container.setAttribute('role', 'list');

  const doc = container.ownerDocument;
  entries.forEach((entry, index) => {
    const rank = index + 1;
    const rankSpan = el(doc, 'span', { class: 'leaderboard-rank bidi-ltr', dir: 'ltr' }, `#${rank}`);

    const resolved = names.get(entry.userId);
    const playerNode = resolved
      ? el(
          doc,
          'a',
          {
            href: `/profile/${encodeURIComponent(resolved.handle)}`,
            'data-route': 'profile',
            class: 'row-link',
            dir: 'auto',
          },
          resolved.handle,
        )
      : el(doc, 'span', { class: 'leaderboard-player-unresolved' }, shortId(entry.userId));

    const rowMain = el(doc, 'span', { class: 'row-main' }, rankSpan, playerNode);
    const statsSpan = el(doc, 'span', { class: 'count bidi-ltr', dir: 'ltr' }, `${entry.rating} (±${entry.rd})`);

    const row = el(doc, 'div', { class: 'panel-row', role: 'listitem' }, rowMain, statsSpan);
    container.appendChild(row);
  });
}

export function renderVariantSelector(
  selectEl: HTMLSelectElement,
  selectedVariant: Variant,
  i18n: I18n,
): void {
  selectEl.innerHTML = '';
  const doc = selectEl.ownerDocument;
  for (const v of OFFERED_VARIANTS) {
    const option = el(doc, 'option', { value: v }, getVariantLabel(v, i18n));
    if (v === selectedVariant) {
      option.selected = true;
    }
    selectEl.appendChild(option);
  }
}

export function bindVariantSelector(
  selectEl: HTMLSelectElement,
  onChange: (variant: Variant) => void,
): () => void {
  const handler = (e: Event) => {
    const target = e.target as HTMLSelectElement;
    const variant = target.value as Variant;
    if (OFFERED_VARIANTS.includes(variant)) {
      onChange(variant);
    }
  };
  selectEl.addEventListener('change', handler);
  return () => selectEl.removeEventListener('change', handler);
}

/**
 * Every rating pool is a variant and a speed, and the page does not pick a speed for the viewer:
 * until one is chosen the results say so instead of showing some default pool.
 */
export function renderChooseSpeed(container: HTMLElement, i18n: I18n): void {
  container.innerHTML = '';
  container.setAttribute('role', 'status');
  renderEmpty(container, {
    title: i18n.t('leaderboard.chooseSpeedTitle'),
    body: i18n.t('leaderboard.chooseSpeedBody'),
  });
}

export function renderSpeedSelector(
  selectEl: HTMLSelectElement,
  selectedSpeed: Speed | null,
  i18n: I18n,
): void {
  selectEl.innerHTML = '';
  const doc = selectEl.ownerDocument;
  const prompt = el(
    doc,
    'option',
    { value: '', disabled: '' },
    i18n.t('leaderboard.choosePrompt'),
  );
  prompt.selected = selectedSpeed === null;
  selectEl.appendChild(prompt);
  for (const s of SPEEDS) {
    const option = el(doc, 'option', { value: s }, getSpeedLabel(s, i18n));
    option.selected = s === selectedSpeed;
    selectEl.appendChild(option);
  }
}

export function bindSpeedSelector(selectEl: HTMLSelectElement, onChange: (speed: Speed) => void): () => void {
  const handler = (e: Event) => {
    const speed = (e.target as HTMLSelectElement).value as Speed;
    if (SPEEDS.includes(speed)) onChange(speed);
  };
  selectEl.addEventListener('change', handler);
  return () => selectEl.removeEventListener('change', handler);
}
