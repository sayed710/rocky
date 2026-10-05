# Launch Preparation D02 — current production cache freshness

Baseline: `c31ecc2fc7f50a150695fa7ec6b8f6e5af89671e` (fetched and verified before modification).

**D02 was reproduced and narrowly corrected. Fable + Astra engineering remediation remains closed.** Historical audit rows are unchanged. This is bounded Launch Preparation evidence, not public-launch approval.

## Actual asset model

| Class | Production paths / behavior |
|---|---|
| Content-hashed immutable | Vite emits `/assets/index-BNUlepaa.css` and `/assets/index-D0P8rhKp.js` for the baseline build. Changed bundle content gets a different URL; Nginx's eight-character hash pattern supplies immutable caching. Source maps are hashed too but are not ordinary page requests. |
| Unhashed versioned | No separately versioned fixed-URL resource is used by the current normal page. |
| Unhashed mutable runtime | `/locale-init.js` in index.html; twelve `/piece/cburnett/*.svg` URLs in CSS. Vite copies public files without hashing them. These are outside APP_SHELL. |
| App shell | `/`, `/index.html`, manifest and three icons are refreshed by cache.addAll during install. Icons/manifest are also same-origin GET resources. |
| Worker script | `/sw.js` is registered after window load; the browser checks worker bytes. Unchanged bytes do not trigger a new install even when other files change. No build-time worker revision injection exists. |
| API/network | `/v1/` is excluded; WebSocket upgrades are network resources. Cross-origin resources are outside the same-origin caching branch. |

Sources: `packages/web/index.html`, `src/main.ts`, `src/style.css`, `public/`, `vite.config.ts`, and `docker/web/nginx.conf.template`. The Nginx mutable-resource header is `no-cache`; Cache Storage cache-first bypassed HTTP revalidation.

## Browser deployment proof

The committed Playwright spec serves the real Vite `dist` output through a small HTTP fixture with the relevant production cache headers, using an isolated origin and native Chromium service-worker/Cache Storage behavior. It appends harmless revision comments to the actual locale bootstrap, white-king SVG and icon bytes; no worker cache semantics are mocked. It leaves hashed assets unchanged as an immutable control. This models an update to production-reachable files at their existing URLs without claiming that every deployment changes them.

1. Visit A through the actual built page/bootstrap, wait for service-worker control, request mutable and hashed resources, and prove their Cache Storage entries exist.
2. Serve B. Append a deployment comment to worker bytes to cause an actual install/activate/controllerchange while retaining the same production cache name and policy.
3. Verify app-shell icon B, reload, then request locale and piece bytes. Against the baseline worker, both return **A**. The app-shell control already returned B, proving install occurred and distinguishing refreshed shell entries from runtime entries surviving in the same cache.
4. Against the correction, both return B. The unchanged hashed resource is served without another server hit; API response becomes B and remains absent from Cache Storage.
5. Serve C while worker bytes remain B; request update and reload. Mutable runtime and icon resources return C without a new installation.
6. Disconnect the context. Cached mutable C and hashed bytes still load; navigation to `/about` uses the offline shell.

Initial syntax/setup errors receive no behavioral credit. The first valid RED run failed on locale A after B activation. A later run of the final test against the original worker independently failed on both locale A and piece A. The corrected final test passed.

## Narrow correction and adversarial checks

[ADR-0158](../adr/0158-service-worker-mutable-freshness.md) records the policy. Content-hashed paths retain cache-first; mutable resources revalidate online and use cache on network failure. Successful mutable writes finish before the response promise completes, making immediate offline fallback deterministic. Existing navigation, non-GET, API/WebSocket and origin boundaries remain.

Three executable worker mutations were applied only to generated dist, then restored: all resources immutable failed stale-byte assertions; all resources mutable failed the immutable network-hit assertion; removing mutable offline fallback failed on `Offline` instead of C bytes. Survivors 0; invalid mutations 0. Restored browser test passed 1/1. Temporary mutation tooling/logs are outside the PR.

Focused Chromium acceptance: 15/15 (deployment, offline-navigation and public-documents), retries 0, failures/skips/cancellations 0. Full build/lint, hermetic 4007/4007 across all 19 workspaces (web 1476/1476), scripts 315/315 and the eight repository guards passed. Discovery guards were updated to explicitly account for the new backend-free browser spec; their initial count failures received no passing credit. Final external gates are recorded in the PR handoff after execution.

Independent hierarchy: the legacy Gemini CLI was rejected as unsupported (not fallback evidence); the supported Antigravity Gemini 3.8 Flash High invocation returned genuine HTTP 429 RESOURCE_EXHAUSTED. Claude Sonnet 4.6 Thinking was retried without its unsupported effort argument, then also returned genuine HTTP 429 RESOURCE_EXHAUSTED. Neither returned a review. Authorized strict Codex self-review checked worker lifecycle, Nginx hash classification, successful cache-write completion, offline/API/origin preservation, fixture fidelity and the complete diff; no remaining actionable finding at this checkpoint. Exact-final-head external Qodo/Greptile/CI evidence remains separate.

## Boundaries

This establishes the local production asset/update policy in Chromium. It does not claim deployed Nginx/Compose/Helm acceptance, Firefox/Safari/real-device behavior, service-worker installation under every network failure, freshness before worker control or while offline, atomic multi-file rollout, automatic cleanup of accumulated hashed assets, or whole-product launch readiness. Existing cache names and the deliberately limited offline shell remain. The owner performs any merge.
