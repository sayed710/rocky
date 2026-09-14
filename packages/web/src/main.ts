/**
 * App entry point.
 *
 * All wiring lives in the composition root (`./app`); this module handles only
 * environment concerns: running the bootstrap when the DOM is ready and on
 * navigation, and registering the service worker for PWA installability. It
 * contains no application logic.
 */
import { bootstrap, createLifecycle } from './app/index.js';
import { buildSearchUrl, parseSearchMode } from './app/search-results.js';

if (typeof document !== 'undefined') {
  const lifecycle = createLifecycle(() => bootstrap(document));

  const run = (): void => {
    lifecycle.run();
  };

  // Bound once on document — survives bootstrap re-runs (which replace the
  // section contents but not these top-level listeners).

  // Theme toggle.
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (target instanceof HTMLElement && target.closest('#theme-toggle')) {
      lifecycle.getCurrentTheme()?.toggle();
    }
  });

  // SPA nav links (prevent full page reloads, re-run bootstrap for new route).
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const link = target.closest('a[data-route]');
    if (!(link instanceof HTMLAnchorElement)) return;
    // Let the browser handle modified clicks (open in new tab/window),
    // links targeting another browsing context, and downloads normally.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (link.target && link.target !== '_self') return;
    if (link.hasAttribute('download')) return;
    e.preventDefault();
    const href = link.getAttribute('href');
    if (href) {
      history.pushState(null, '', href);
      run();
    }
  });

  // Header search. Bound once on document like the handlers above: the form sits in the nav, which
  // `bootstrap` never replaces, so binding it per run would stack one listener per navigation and a
  // single submit would push that many history entries.
  document.addEventListener('submit', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement) || target.id !== 'search-form') return;
    e.preventDefault();
    // The form is revealed only when capabilities report `search: true` (ADR-0132 §5). A hidden
    // form cannot be submitted by a visitor, so this covers the paths that are not a visitor: a
    // programmatic `submit()`, an extension, or a stale page whose capabilities said otherwise. The
    // gate lives on the element that carries it rather than on a second copy of the flag here.
    if (target.hidden) return;
    const input = document.getElementById('search-input') as HTMLInputElement | null;
    const mode = parseSearchMode(new URLSearchParams(location.search).get('mode'));
    history.pushState(null, '', buildSearchUrl(input?.value.trim() ?? '', mode));
    run();
  });

  // Browser back/forward.
  window.addEventListener('popstate', () => {
    run();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }

  // Register the service worker for PWA installability.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        // Log registration failures so SW breakage is visible (m1).
        console.warn('[Rookzen] Service worker registration failed:', err);
      });
    });
  }
}
