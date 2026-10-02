# ADR-0153 — Public document routes and source disclosure build metadata

**Status:** Proposed for owner review
**Date:** 2026-10-02

## Context

The Fable + Astra audit (`docs/audits/FABLE_ASTRA_FULL_AUDIT.md`) found no Privacy, Terms or Fair
Play surface and no discoverable link to the source repository. The Codex adjudication
(`docs/audits/CODEX_GEMINI_PLANNING_ADJUDICATION_2026-10-02.md`) confirmed both against main:
`packages/web/src/app/router.ts` had no such routes, and neither `Dockerfile.web` nor
`packages/web/vite.config.ts` carried any repository URL or commit SHA into the build. The
historical Gemini claim that the production image already embedded them was wrong.

The same documents separate three kinds of responsibility, and this ADR keeps to the first:

1. **Engineering:** routes, an accessible document surface, and truthful build metadata.
2. **Owner:** the published policy text, where the pages are linked from (D-06) and how
   registration refers to them (D-07).
3. **Legal review:** whether any of this is sufficient for any legal purpose.

## Decision

### 1. Four typed public routes, one surface

`/privacy`, `/terms`, `/fair-play` and `/about` are one `Route` variant,
`{ name: 'public-document', document: PublicDocumentId }`. The id is also the exact path segment,
so `parseRoute` and `routeToPath` are the same lookup in both directions. Extra segments, case
variants (`/About`) and near-miss spellings (`/fair_play`, `/legal`) stay on the existing 404
surface. The query string is ignored as on every other route. No session is required, and the
sign-in form is hidden on these routes as it is on the 404 page.

All four render into one `<section id="public-document">` through one renderer,
`packages/web/src/app/public-document.ts`, driven by a typed spec per page (title key, intro
keys, sections of paragraph keys). There is no controller per page.

### 2. Document structure

Each page is an `<article>` labelled by its title. The title is an `<h2>` because the topbar brand
is already the page's one `<h1>` and every route surface starts at `<h2>`. Sections are labelled
`<section>` elements with `<h3>` headings. All copy is a typed `MessageKey` written with
`textContent`. Nothing uses `innerHTML`, nothing renders Markdown, and nothing fetches a policy
body. A locale change re-translates the existing nodes in place, which keeps focus. The document
title reads `{page} · {brand}` while mounted and is restored on dispose.

Focus moves to the title only after in-app navigation (link, search submit, back/forward), which
`main.ts` signals with `inAppNavigation`. A direct load leaves focus where the browser puts it.

### 3. Content boundary: publication state only

Privacy, Terms and Fair Play show their title and a "Publication status" section saying that the
authoritative text has not been published and that the page is not the final published policy.
They make no promise, obligation, consent statement, retention period, sanction rule, age or
jurisdiction claim. `packages/web/test/public-document.test.ts` fails if a `publicDocument.*`
catalog string matches a list of such claims. The pages exist so the routes, structure and
delivery can be built and tested now. Their presence does **not** satisfy the policy-publication
release gate.

### 4. Source metadata trust boundary

`packages/web/src/app/source-metadata.ts` owns three things:

- **Repository identity is a source-controlled constant:** `https://github.com/sayed710/rocky`.
  It is not a build or runtime input. Accepting a URL from the environment would put an
  unvalidated value into an `href` for no benefit. A fork that publishes its own source changes
  the constant in its own source, which is the source it is publishing.
- **Build revision is the only injected value.** It is read once, at build time, from
  `VITE_GIT_SHA` by `resolveBuildRevision` in `packages/web/vite.config.ts`. It is embedded with
  Vite `define` as the compile-time constant `__ROOKZEN_SOURCE_REVISION__`. Nothing reads
  `import.meta.env`, so no other `VITE_*` variable in the environment reaches the bundle through
  this path. `.env` files are not consulted.
- **Validation:** a revision must be a full 40- or 64-character hexadecimal object name. The
  all-zero null name is refused. Abbreviated names, refs (`HEAD`, `main`) and anything else are
  refused too. The value is normalized to lowercase. The commit URL is the repository constant
  plus `/commit/<sha>`. Because the SHA is hex-only, appending it cannot change the origin or
  escape the path. The renderer also refuses any non-HTTPS `href` at the sink.

**Unavailable SHA semantics:**

| `VITE_GIT_SHA` at build time | Result |
|---|---|
| unset or empty | Build succeeds; `/about` says the build does not record its source revision. No revision is invented. |
| full commit SHA | Build succeeds; `/about` shows the SHA and links to that exact commit. |
| anything else | `vite build` fails. A pipeline that meant to stamp a revision cannot ship a build that claims none or the wrong one. |

Nothing is fetched at run time. No GitHub request is made to discover a revision, no secret is
involved, and no external service is required to render `/about`.

### 5. Build plumbing

`Dockerfile.web` declares `ARG VITE_GIT_SHA=` (empty default) after `npm ci`, so a new SHA does
not invalidate the dependency layer. A local `docker build` or `docker compose build` therefore
produces an image that honestly reports no revision. The build stays reproducible: the same
source and the same argument give the same bundle. The runtime image is unchanged
(`nginxinc/nginx-unprivileged`, non-root).

`.github/workflows/ci.yml` passes `github.sha`, the commit `actions/checkout` checked out (the
merge ref on a pull request). It then asserts the exact SHA is present in the image's JavaScript,
because an image that lost the argument would still serve a valid "unavailable" page and the
regression would otherwise be silent. `.github/workflows/release.yml` passes the released commit,
the same full SHA that already suffixes the release image tag. Compose and Helm are unchanged.
The value is fixed at image build time and has no runtime configuration.

### 6. External links

The repository and commit links open in the same tab with no `target`, so there is no opener to
abuse. They carry `rel="external noreferrer"`. They are underlined so they do not rely on colour
alone, and they are isolated as LTR tokens (`dir="ltr"`, `.bidi-ltr`) so a URL or SHA cannot
reorder the surrounding right-to-left text. Their accessible names are the URL and the SHA
themselves, under `<dt>` labels "Source repository" and "Build revision".

### 7. Delivery

The existing nginx SPA fallback (`try_files $uri $uri/ /index.html` in
`docker/web/nginx.conf.template`) already serves these routes with `no-cache` and the existing
security headers. `scripts/nginx-web-delivery-acceptance.mjs` now proves it for each path against
a real nginx container. The service worker's network-first navigation with an offline fallback to
the cached shell (`packages/web/public/sw.js`) also serves them, as
`packages/web/e2e/public-documents.spec.ts` shows. Neither file needed a change. The CSP has no
`navigate-to` or `form-action` restriction that a same-tab external link would hit.

Source maps (`build.sourcemap: true`) continue to ship. They expose the source of a public AGPL
repository and contain no build secret, since the only injected value is the public commit SHA.

## What this ADR deliberately does not decide

- **Policy text.** Authoritative Privacy, Terms and Fair Play content, and its legal review,
  belong to the owner and counsel. The catalog keys and spec make adding it a content change.
- **Discoverability (D-06).** No footer, topbar link group, avatar or settings menu, or legal hub
  is added. The routes are reachable directly and through any in-app link that a later decision
  places. Permanent placement remains open.
- **Registration consent (D-07).** No checkbox, notice or consent wording is added.
- **Legal sufficiency.** Showing a repository link and a revision is an engineering capability.
  Whether it satisfies AGPL-3.0 §13 or any other obligation is not determined here.
- **Production Arabic.** The surfaces are tested under a test-only Arabic catalog. No production
  Arabic translation is added.

## Consequences

- Publishing a policy means adding catalog text and, if needed, sections to the page's spec. The
  route, surface, metadata and tests already exist.
- The release gate stays open until owner-approved text, legal review and D-06/D-07 placement
  land. The UI says so on each policy page.
- An image built without `VITE_GIT_SHA` is valid and says so on `/about`. CI and release builds
  are required to carry the exact commit, and CI fails if the image does not contain it.
