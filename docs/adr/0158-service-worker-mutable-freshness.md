# ADR-0158: Revalidate mutable service-worker resources

Status: Accepted engineering correction; owner manually merges the PR.

Date: 2026-10-05

## Context

Launch Preparation D02 was NEEDS_EVIDENCE on main `c31ecc2fc7f50a150695fa7ec6b8f6e5af89671e`. Fable + Astra engineering remediation remains closed. The production page requests `/locale-init.js` and the stylesheet requests `/piece/cburnett/*.svg`; these public files have fixed, mutable URLs outside `APP_SHELL`. Vite copies them unchanged. A real Chromium deployment test showed old bytes surviving a new worker's activation and page reload, even though installation refreshed `/icon.svg`.

## Decision

Keep cache-first only for the content-hashed `/assets/` paths matching the existing Nginx immutable contract. Other same-origin non-navigation GET resources use network-first with HTTP cache revalidation (`cache: 'no-cache'`). Cache successful responses before resolving the fetch; on network failure, use the cached response or the established 503 fallback. HTTP errors remain network responses and do not overwrite successful cached bytes. A successful `text/html` response for a file URL other than `.html`/`.htm` is the Nginx SPA fallback, not valid asset bytes: use the cached asset or 503 without caching that HTML. Deliberate HTML document URLs remain eligible for caching.

Retain the existing cache name so the newly installed worker can use previously cached resources offline. Freshness no longer depends on manually changing that name or changing worker bytes on each asset deployment. Navigation and API/WebSocket exclusion branches remain unchanged. No third-party origin is admitted to caching.

## Consequences and verification

Mutable resources require online revalidation; genuinely hashed resources retain cache-first behavior. Offline support still requires a prior online visit. This does not guarantee freshness while offline, during a failed rollout, before the corrected worker controls a client, or while a server itself returns obsolete bytes.

`packages/web/e2e/service-worker-update.spec.ts` serves actual production output on an isolated localhost origin and uses native Chromium service workers and Cache Storage. It covers A-to-B worker install/activation, same-name runtime persistence versus app-shell refresh, unchanged-worker B-to-C asset deployment, locale bootstrap and piece SVG bytes, immutable network-hit counts, API exclusion and offline assets/navigation. The final test fails against the original worker. The bounded evidence record is [D02 launch verification](../audits/LAUNCH_D02_VERIFICATION_2026-10-05.md); it does not certify the deployed Nginx/cluster topology or public launch.
