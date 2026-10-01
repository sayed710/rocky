/**
 * Search view renderers — pure DOM helpers that take a container plus search results
 * and write DOM using `el()` and existing styling classes.
 */
import { el } from './dom.js';
import { renderEmpty } from './render-helpers.js';
import { applyAutoDirection } from '../i18n/bidi.js';
import type { I18n } from '../i18n/manager.js';
import type { SearchRow, SearchEntityType } from './search-results.js';

/**
 * Formats a search entity type for display.
 *
 * @param type - The entity type to format.
 * @param i18n - Optional internationalization manager.
 * @returns The formatted display string.
 */
export function formatEntityType(type: SearchEntityType | null, i18n: I18n): string {
  switch (type) {
    case 'game':
      return i18n.t('search.typeGame');
    case 'player':
      return i18n.t('search.typePlayer');
    case 'tournament':
      return i18n.t('search.typeTournament');
    default:
      return i18n.t('search.typeResult');
  }
}

/**
 * Renders search results into the given container.
 *
 * @param container - The DOM element to render into.
 * @param hits - The list of search results.
 * @param i18n - Internationalization manager.
 */
export function renderSearchResults(
  container: HTMLElement,
  hits: readonly SearchRow[],
  i18n: I18n,
): void {
  container.innerHTML = '';
  if (hits.length === 0) {
    renderEmpty(container, {
      mark: '🔍',
      title: i18n.t('search.emptyResultsTitle'),
      body: i18n.t('search.emptyResultsBody'),
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const hit of hits) {
    const nameNode = hit.href
      ? el(doc, 'a', { href: hit.href, class: 'row-link' }, hit.label)
      : el(doc, 'span', {}, hit.label);
    applyAutoDirection(nameNode);

    // `.panel-row` is space-between and takes exactly two children. The subtitle belongs to the
    // title, so it travels with it inside `.row-main`; handed to the row as a third child it would
    // fly to the opposite edge, detached from the thing it describes. Same rule as teams, forum
    // threads and achievements — see DESIGN.md.
    let leading: HTMLElement;
    if (hit.subtitle) {
      const subtitleEl = el(doc, 'span', { class: 'count' }, hit.subtitle);
      applyAutoDirection(subtitleEl);
      leading = el(doc, 'span', { class: 'row-main' }, nameNode, subtitleEl);
    } else {
      leading = el(doc, 'span', { class: 'row-main' }, nameNode);
    }

    const typeSpan = el(doc, 'span', { class: 'count' }, formatEntityType(hit.type, i18n));
    container.appendChild(el(doc, 'div', { class: 'panel-row' }, leading, typeSpan));
  }
}

/**
 * Renders the initial search prompt when no search has been performed.
 *
 * @param container - The DOM element to render into.
 * @param i18n - Internationalization manager.
 */
export function renderSearchPrompt(container: HTMLElement, i18n: I18n): void {
  renderEmpty(container, {
    mark: '🔍',
    title: i18n.t('search.promptTitle'),
    body: i18n.t('search.promptBody'),
  });
}

/**
 * What the search route shows on a deployment that has search switched off.
 *
 * Reached by a deep link or a shared URL, since the header form is hidden on such a deployment
 * (ADR-0132 §5). It says the feature is off rather than issuing a request that is guaranteed to
 * answer 503 and showing the visitor the server's refusal — a 503 reads as "broken", and this is
 * not broken, it is configured.
 *
 * @param container - The DOM element to render into.
 * @param i18n - Internationalization manager.
 */
export function renderSearchUnavailable(container: HTMLElement, i18n: I18n): void {
  renderEmpty(container, {
    mark: '🔍',
    title: i18n.t('search.unavailableTitle'),
    body: i18n.t('search.unavailableBody'),
  });
}

/**
 * What the route shows when the capability answer never arrived.
 *
 * Distinct from {@link renderSearchUnavailable}, which is a claim about how the deployment is
 * configured. A failed or malformed `GET /v1/capabilities` is not evidence of that, and saying so
 * would be inventing a fact — the same class of mistake as offering a control that cannot work,
 * pointed the other way.
 *
 * Reload rather than a retry button, because `loadCapabilities` memoises for the page's lifetime
 * with deliberately no reset seam: within this page there is nothing left to retry.
 *
 * @param container - The DOM element to render into.
 * @param i18n - Internationalization manager.
 */
export function renderSearchUndetermined(container: HTMLElement, i18n: I18n): void {
  renderEmpty(container, {
    mark: '🔍',
    title: i18n.t('search.undeterminedTitle'),
    body: i18n.t('search.undeterminedBody'),
  });
}
