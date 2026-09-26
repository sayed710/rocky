import type { GambitClient } from '../api/client.js';
import type { SearchMode } from '../api/models.js';
import { SearchController } from './search-controller.js';
import type { SearchCallbacks } from './search-controller.js';
import { buildSearchUrl, parseSearchMode } from './search-results.js';
import {
  renderSearchPrompt,
  renderSearchResults,
  renderSearchUnavailable,
  renderSearchUndetermined,
} from './search-view.js';
import {
  loadCapabilities,
  searchEnabled,
  searchExplicitlyDisabled,
  semanticSearchEnabled,
} from './capabilities-nav.js';

interface SearchElements {
  readonly mode: HTMLElement | null;
  readonly input: HTMLInputElement | null;
  readonly results: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface SearchRenderState {
  resultsRendered: boolean;
}

interface SearchRequest {
  readonly rawQuery: string;
  readonly query: string;
  readonly mode: SearchMode;
}

interface SearchModeOption {
  readonly value: SearchMode;
  readonly label: string;
  /**
   * Whether this mode needs the deployment to have composed semantic search (ADR-0132).
   *
   * Declared per mode rather than derived from a name list, so a fourth mode has to answer the
   * question rather than inherit an answer. Keyword is the only one served by the search repository
   * alone; the other two need a vector repository and an embedding provider, which the server gates
   * on a different env var and can therefore be missing while keyword search works.
   */
  readonly needsSemanticSearch: boolean;
}

const SEARCH_MODES: readonly SearchModeOption[] = [
  { value: 'keyword', label: 'Keyword', needsSemanticSearch: false },
  { value: 'semantic', label: 'Semantic (experimental)', needsSemanticSearch: true },
  { value: 'hybrid', label: 'Hybrid (experimental)', needsSemanticSearch: true },
];

/** The modes this deployment can actually serve. */
function availableModes(semanticAvailable: boolean): readonly SearchModeOption[] {
  return SEARCH_MODES.filter((option) => semanticAvailable || !option.needsSemanticSearch);
}

function searchElements(doc: Document): SearchElements {
  return {
    mode: doc.getElementById('search-mode'),
    input: doc.getElementById('search-input') as HTMLInputElement | null,
    results: doc.getElementById('search-results'),
    error: doc.getElementById('search-error'),
  };
}

function currentSearchRequest(): SearchRequest {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const rawQuery = params.get('q') ?? '';
  return {
    rawQuery,
    query: rawQuery.trim(),
    mode: parseSearchMode(params.get('mode')),
  };
}

function navigateToSearchMode(query: string, mode: SearchMode): void {
  history.pushState(null, '', buildSearchUrl(query, mode));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * @param currentQuery - read at change time, not at render time.
 *
 * Closing over the query captured when the route mounted discarded anything typed since: fill the
 * header box, click **Semantic** without pressing enter, and the navigation carried the old term
 * while the remount reset the box to match it. Tracked from M15 Increment 24 and fixed here.
 */
function createModeInput(
  doc: Document,
  option: SearchModeOption,
  activeMode: SearchMode,
  currentQuery: () => string,
): HTMLInputElement {
  const input = doc.createElement('input');
  input.type = 'radio';
  input.name = 'search-mode-option';
  input.value = option.value;
  input.checked = option.value === activeMode;
  input.addEventListener('change', () => {
    if (input.checked) navigateToSearchMode(currentQuery(), option.value);
  });
  return input;
}

function createModeControl(
  doc: Document,
  option: SearchModeOption,
  activeMode: SearchMode,
  currentQuery: () => string,
): HTMLLabelElement {
  const control = doc.createElement('label');
  control.className = 'cg-seg';
  const label = doc.createElement('span');
  label.className = 'cg-seg-label';
  label.textContent = option.label;
  control.append(createModeInput(doc, option, activeMode, currentQuery), label);
  return control;
}

function renderModeSelector(
  doc: Document,
  container: HTMLElement,
  activeMode: SearchMode,
  currentQuery: () => string,
  modes: readonly SearchModeOption[],
): void {
  container.innerHTML = '';
  for (const option of modes) {
    container.appendChild(createModeControl(doc, option, activeMode, currentQuery));
  }
}

function resetSearchSurface(elements: SearchElements): void {
  // Search route elements persist across bootstrap runs, including interrupted loading states.
  if (elements.results) {
    elements.results.setAttribute('aria-busy', 'false');
    // The previous query's hits belong to the previous query. They used to survive only until the
    // new request settled; now that every path waits for the capability answer first, they would
    // sit under a new URL for as long as that takes — and on a deployment with search off they
    // would sit above a notice saying there is no search. Raised by the CodeRabbit review of
    // PR #155. Emptied here, where the surface is already being reset for a new mount.
    elements.results.innerHTML = '';
  }
  if (elements.error) elements.error.textContent = '';
}

function setSearchLoading(
  elements: SearchElements,
  state: SearchRenderState,
  loading: boolean,
): void {
  if (!elements.results) return;
  elements.results.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (loading) {
    state.resultsRendered = false;
    return;
  }
  if (!state.resultsRendered) elements.results.innerHTML = '';
}

function createSearchCallbacks(elements: SearchElements): SearchCallbacks {
  const state: SearchRenderState = { resultsRendered: false };
  return {
    onResults: (hits) => {
      state.resultsRendered = true;
      if (elements.error) elements.error.textContent = '';
      if (elements.results) renderSearchResults(elements.results, hits);
    },
    onLoading: (loading) => setSearchLoading(elements, state, loading),
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };
}

/**
 * Mount the `/search` route.
 *
 * The whole surface is gated on the deployment's published capabilities (ADR-0132), which arrive
 * asynchronously, so nothing is offered until they do: no mode controls, no prompt, no request.
 * Never rendered and then removed — a control that exists for 200ms is a control that can be used.
 *
 * `search` gates everything here and `semanticSearch` gates the two extra modes on top of it, so the
 * three states are: search off, an honest unavailable notice and no request at all; search on and
 * semantic off, keyword alone; both on, all three modes. A visitor who deep-links to a mode this
 * deployment cannot serve is moved to keyword rather than shown a 503.
 *
 * @param loadFlags - injectable because `loadCapabilities` memoises for the page's lifetime with no
 * reset seam, so a test cannot vary the answer twice in one process. Same reason, same shape, as
 * `mountTournamentDetail` in `competition-mounts.ts`.
 */
export function mountSearch(
  doc: Document,
  client: GambitClient,
  loadFlags: (api: GambitClient) => Promise<unknown> = loadCapabilities,
): SearchController {
  const elements = searchElements(doc);
  const request = currentSearchRequest();
  resetSearchSurface(elements);

  // The persistent header form is bound once in main.ts; route mounts only refresh its value.
  if (elements.input) elements.input.value = request.rawQuery;
  // Nothing is offered before the server has said what it serves. No modes, no prompt, no request —
  // every one of those is an advertisement, and on a deployment with search off every one of them
  // would be false. `loadCapabilities` is memoised for the page, so this is one request per visit.
  if (elements.mode) {
    elements.mode.innerHTML = '';
    elements.mode.hidden = true;
  }

  const controller = new SearchController({
    client,
    callbacks: createSearchCallbacks(elements),
  });

  void loadFlags(client)
    .catch(() => undefined)
    .then((flags) => {
      // The flags can outlive the route on a fast navigation; `search` refuses on its own after
      // disposal, but the renders below would not.
      if (controller.isDisposed) return;

      // Keyword search is gated too, not only the semantic modes. `SEARCH_ENABLED=0` removes the
      // repository and every mode answers 503, so a request here is guaranteed to fail and the
      // honest thing to show is that the feature is off rather than the server's refusal.
      //
      // This is why keyword now waits for the answer, reversing an earlier decision in this
      // increment that let it start immediately: knowing whether a request is pointless requires
      // having asked. The cost is one memoised round trip on the first search of a visit.
      if (!searchEnabled(flags)) {
        // Fail closed either way, but do not tell the visitor the deployment is configured a way
        // we have no evidence for: only an explicit `false` is the server saying so.
        if (elements.results) {
          if (searchExplicitlyDisabled(flags)) renderSearchUnavailable(elements.results);
          else renderSearchUndetermined(elements.results);
        }
        return;
      }

      const semanticAvailable = semanticSearchEnabled(flags);

      // A mode this deployment cannot serve falls back to keyword, and `replaceState` rather than
      // `pushState` keeps it from becoming a back-button destination.
      const mode: SearchMode =
        request.mode === 'keyword' || semanticAvailable ? request.mode : 'keyword';
      if (mode !== request.mode) {
        history.replaceState(null, '', buildSearchUrl(request.query, mode));
      }

      if (elements.mode) {
        elements.mode.hidden = false;
        renderModeSelector(
          doc,
          elements.mode,
          mode,
          // Read when a mode is chosen, not now. The visitor may have typed since this rendered,
          // and `main.ts`'s submit handler already reads the box the same way — switching mode
          // should carry the same term pressing enter would.
          () => elements.input?.value.trim() ?? request.query,
          availableModes(semanticAvailable),
        );
      }

      if (request.query) void controller.search(request.query, mode);
      else if (elements.results) renderSearchPrompt(elements.results);
    });

  return controller;
}
