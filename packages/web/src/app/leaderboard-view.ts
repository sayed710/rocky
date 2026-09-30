/**
 * Leaderboard view renderers — pure DOM helpers that take a container plus data
 * and write DOM using `el()` and existing styling classes.
 */
import { el } from './dom.js';
import { renderEmpty } from './render-helpers.js';
import { shortId } from '../api/graphql.js';
import { OFFERED_VARIANTS, SPEEDS } from '../api/models.js';
import { SPEED_LABELS, VARIANT_LABELS } from './variant-labels.js';
import type { LeaderboardEntry, Speed, Variant, SocialPlayer } from '../api/models.js';

export function renderLeaderboard(
  container: HTMLElement,
  entries: readonly LeaderboardEntry[],
  names: ReadonlyMap<string, SocialPlayer>,
): void {
  container.innerHTML = '';
  if (entries.length === 0) {
    container.setAttribute('role', 'status');
    renderEmpty(container, {
      title: 'No leaderboard entries',
      body: 'No ratings have been recorded in this variant and time control yet.',
    });
    return;
  }

  container.setAttribute('role', 'list');

  const doc = container.ownerDocument;
  entries.forEach((entry, index) => {
    const rank = index + 1;
    const rankSpan = el(doc, 'span', { class: 'leaderboard-rank' }, `#${rank}`);

    const resolved = names.get(entry.userId);
    const playerNode = resolved
      ? el(
          doc,
          'a',
          {
            href: `/profile/${encodeURIComponent(resolved.handle)}`,
            'data-route': 'profile',
            class: 'row-link',
          },
          resolved.handle,
        )
      : el(doc, 'span', { class: 'leaderboard-player-unresolved' }, shortId(entry.userId));

    const rowMain = el(doc, 'span', { class: 'row-main' }, rankSpan, playerNode);
    const statsSpan = el(doc, 'span', { class: 'count' }, `${entry.rating} (±${entry.rd})`);

    const row = el(doc, 'div', { class: 'panel-row', role: 'listitem' }, rowMain, statsSpan);
    container.appendChild(row);
  });
}

export function renderVariantSelector(
  selectEl: HTMLSelectElement,
  selectedVariant: Variant,
): void {
  selectEl.innerHTML = '';
  const doc = selectEl.ownerDocument;
  for (const v of OFFERED_VARIANTS) {
    const option = el(doc, 'option', { value: v }, VARIANT_LABELS[v]);
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
export function renderChooseSpeed(container: HTMLElement): void {
  container.innerHTML = '';
  container.setAttribute('role', 'status');
  renderEmpty(container, {
    title: 'Choose a time control',
    body: 'Each variant and time control has its own ratings. Pick a time control to see its standings.',
  });
}

export function renderSpeedSelector(selectEl: HTMLSelectElement, selectedSpeed: Speed | null): void {
  selectEl.innerHTML = '';
  const doc = selectEl.ownerDocument;
  const prompt = el(doc, 'option', { value: '', disabled: '' }, 'Choose…');
  prompt.selected = selectedSpeed === null;
  selectEl.appendChild(prompt);
  for (const s of SPEEDS) {
    const option = el(doc, 'option', { value: s }, SPEED_LABELS[s]);
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
