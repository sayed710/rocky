/**
 * Shared DOM rendering and formatting helpers used by bootstrap and views.
 */
import type { TimeControl } from '../net/ws-protocol.js';

import type { I18nManager } from '../i18n/manager.js';

/** Format clock milliseconds as `M:SS`. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Format a time control into a human-readable string. */
export function formatTimeControl(
  tc: Pick<TimeControl, 'kind' | 'initialMs' | 'incrementMs' | 'delayMs'>,
  i18n?: I18nManager,
): string {
  const t = i18n ? i18n.t.bind(i18n) : null;
  if (tc.kind === 'unlimited') return t ? t('timeControl.unlimited') : 'Unlimited';
  if (tc.kind === 'sudden_death') {
    const sec = tc.initialMs / 1000;
    if (sec >= 60 && sec % 60 === 0) {
      const count = String(sec / 60);
      return t ? t('timeControl.min', { count }) : `${count} min`;
    }
    const count = String(sec);
    return t ? t('timeControl.sec', { count }) : `${count} sec`;
  }
  if (tc.kind === 'increment') {
    return `${tc.initialMs / 60000}+${tc.incrementMs / 1000}`;
  }
  if (tc.kind === 'delay') {
    const sec = tc.initialMs / 1000;
    const base = sec >= 60 && sec % 60 === 0
      ? (t ? t('timeControl.min', { count: String(sec / 60) }) : `${sec / 60} min`)
      : (t ? t('timeControl.sec', { count: String(sec) }) : `${sec} sec`);
    const delay = String(tc.delayMs / 1000);
    return t ? t('timeControl.delay', { base, delay }) : `${base} delay ${delay}`;
  }
  return t ? t('timeControl.unknown') : 'Unknown';
}

/** Options for {@link renderEmpty}. */
export interface EmptyStateOptions {
  /** Optional decorative glyph (a chess piece symbol); hidden from a11y. */
  readonly mark?: string;
  readonly title: string;
  readonly body: string;
  /** Optional call-to-action rendered as a SPA nav link. */
  readonly cta?: { readonly label: string; readonly href: string; readonly route: string };
  /** Lighter, left-aligned variant for small sub-sections (no panel). */
  readonly inline?: boolean;
}

/**
 * Render a first-run / no-data empty state into a container, replacing its
 * contents. Empty states name the next action rather than leaving blank space.
 */
export function renderEmpty(container: HTMLElement, opts: EmptyStateOptions): void {
  container.innerHTML = '';
  const doc = container.ownerDocument ?? document;
  const wrap = doc.createElement('div');
  wrap.className = opts.inline ? 'empty empty-inline' : 'empty';

  if (opts.mark && !opts.inline) {
    const mark = doc.createElement('div');
    mark.className = 'empty-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = opts.mark;
    wrap.appendChild(mark);
  }

  const title = doc.createElement('p');
  title.className = 'empty-title';
  title.textContent = opts.title;
  wrap.appendChild(title);

  const body = doc.createElement('p');
  body.className = 'empty-body';
  body.textContent = opts.body;
  wrap.appendChild(body);

  if (opts.cta) {
    const link = doc.createElement('a');
    link.className = 'empty-cta';
    link.href = opts.cta.href;
    link.dataset.route = opts.cta.route;
    link.textContent = opts.cta.label;
    wrap.appendChild(link);
  }

  container.appendChild(wrap);
}

/** A row action: a label plus what it does. */
export interface RowAction {
  readonly label: string;
  readonly run: () => void;
  /** Severs a relationship; separated from the connective actions by position. */
  readonly destructive?: boolean;
  /**
   * Opens a conversation rather than changing a relationship. Set apart from the relationship
   * controls by position for the same reason `destructive` is: a row of interchangeable-looking
   * verbs reads as rival calls to action, and this system's only lever for that is placement.
   */
  readonly communicative?: boolean;
}

/**
 * Render one `panel-row` — the single row treatment every list in the app
 * shares. Actions are optional; a row without them is a plain label.
 */
export function appendPanelRow(
  container: HTMLElement,
  label: string,
  actions: readonly RowAction[],
  busy: boolean,
): void {
  const doc = container.ownerDocument ?? document;
  const row = doc.createElement('div');
  row.className = 'panel-row';

  const name = doc.createElement('span');
  name.textContent = label;
  name.setAttribute('dir', 'auto');
  row.appendChild(name);

  if (actions.length > 0) {
    const group = doc.createElement('div');
    group.className = 'panel-row-actions';
    for (const action of actions) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.disabled = busy;
      // The accessible name has to say who the action applies to: a column of
      // buttons all reading "Accept" is unusable without the surrounding row.
      button.setAttribute('aria-label', `${action.label} ${label}`);
      button.addEventListener('click', action.run);
      group.appendChild(button);
    }
    row.appendChild(group);
  }

  container.appendChild(row);
}
