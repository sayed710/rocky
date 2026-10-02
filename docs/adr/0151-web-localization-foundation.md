# ADR-0151 — Web localization foundation and chess bidi isolation

**Status:** Proposed for owner review  
**Date:** 2026-09-30

## Context

Rookzen is designed to be modern, calm, dark-first, and fully accessible across desktop and mobile devices. Arabic (RTL) support is a foundational product requirement documented in `docs/PRODUCT_BRAND_CONTEXT_AR.md` and `docs/audits/ROOKZEN_VISUAL_HANDOFF.md`.

However, the existing web application (`packages/web`) contained hardcoded English string literals distributed across the application shell (`index.html`), view renderers, and controllers. Prior to this increment:
- There was no typed message catalog contract or runtime message system.
- There was no document language/direction management abstraction (`<html lang="en" dir="ltr">`).
- There was no bidi isolation infrastructure for mixed-direction chess content. Chess notation (SAN, UCI, FEN, PGN movetext), clock digits, engine numeric evaluations, and player rating differentials were rendered as unisolated plain text strings.
- In mixed-direction or future RTL environments, naive rendering of chess tokens risks directional bleed, visual inversion of notation tokens, or corruption of copied PGN/UCI values if ad-hoc Unicode direction marks (LRM/RLM) are embedded into user-copyable strings.
- Unknown-direction user content (player handles, comments, titles) had no auto-direction isolation.

Per owner directives:
- The active production runtime locale MUST remain `en` (`ltr`) by default.
- Production remains strictly English-only in this increment; no production Arabic catalog ships, and Arabic metadata/types are preparatory only.
- There must be NO automatic browser language detection (`navigator.language`).
- There must be NO visible language switcher, URL route prefixes, or permanent font decisions in this increment.
- Zero third-party localization libraries should be added; an internal, typed, minimal implementation is preferred.
- Chessboard logical orientation must remain strictly decoupled from document reading direction.

## Decision

1. **Zero-dependency internal typed message architecture (`packages/web/src/i18n`):**
   - Implemented an internal localization system with zero external runtime dependencies.
   - Core types (`types.ts`) define `Locale` (`'en' | 'ar'`), `Direction` (`'ltr' | 'rtl'`), and `InterpolationParams`.
   - `metadata.ts` enforces `DEFAULT_LOCALE = 'en'`, `SUPPORTED_LOCALES = ['en', 'ar']`, and provides `resolveLocale()` which normalizes language tags (e.g. `'en-US'` -> `'en'`, `'ar-EG'` -> `'ar'`) and safely falls back to `'en'` for invalid or unsupported inputs.
   - `interpolate.ts` provides safe, deterministic placeholder substitution (`{param}`) with regex replacement and parameter escaping, avoiding `eval()`, `Function()`, or unsafe template execution.

2. **Authoritative canonical English catalog (`catalog/en.ts` & `catalog/index.ts`):**
   - Established `enMessages` containing client-owned static and localizable UI copy across the application shell, navigation, auth, lobby, game actions, review, analysis, opening explorer, coach, profile, leaderboard, tournaments, learning, endgames, studies, teams, forums, and messages.
   - User-generated content (player handles, chat messages, study descriptions, forum posts) and server-provided free-form domain data are explicitly domain-owned and excluded from the catalog.
   - `MessageKey` is derived directly as `keyof typeof enMessages`. Compile-time TypeScript exhaustiveness and runtime type guard `isMessageKey()` guarantee that missing, mistyped, or invalid message keys cannot be consumed.

3. **Application I18n Manager & Composition Integration (`manager.ts` & `app/composition.ts`):**
   - Created `I18n` class with `t(key, params)` lookup, `locale`, `setLocale()`, and `onLocaleChange()` subscription.
   - Distinguishes supported locale metadata from runtime-available catalogs: a locale can only be activated if its catalog is registered via `this.catalogs.has(locale)`. In production, where no Arabic catalog is registered, attempts to activate `ar` safely fall back to `en`.
   - Missing keys fall back safely to the raw key in production (default `strict: false`), with configurable `strict: true` mode for test/development environments.
   - Injected `i18n` instance into `AppDependencies` and composed into `App` composition root. When injected, instance identity is preserved.
   - Eliminates all module-global mutable state: each `bootstrap()` call creates and returns an independent `shellLocalization` lifecycle handle.

4. **DOM Document Language & Shell Localization Plumbing (`document.ts` & `shell.ts`):**
   - `applyDocumentLocale(locale, doc)` targets exclusively the supplied `Document` instance, updating `<html lang dir>` without mutating ambient globals.
   - Static HTML defaults truthfully to `<html lang="en" dir="ltr">`.
   - `localizeShell(doc, i18n)` provides declarative shell translation via `data-i18n`, `data-i18n-aria-label`, `data-i18n-placeholder`, and `data-i18n-title` attributes.
   - Dynamic controller-owned nodes (such as auth status, game status, connection indicator, review notes) do NOT carry static `data-i18n` ownership, preventing locale updates from wiping live controller state. Dynamic nodes are re-localized by their controllers on locale change.

5. **Safe Locale Preference Storage Abstraction (`storage.ts`):**
   - `LocaleStorage` wraps `KeyValueStorage` under canonical versioned key `rookzen_locale_v1`.
   - Validates stored data using `isSupportedLocale()`. Any missing, corrupt, or invalid stored preference safely and silently resolves to `DEFAULT_LOCALE` (`en`).
   - In production, a stored `ar` preference cannot activate without a registered Arabic catalog, avoiding an inconsistent "English in RTL" state.
   - Browser auto-detection (`navigator.language`) is explicitly omitted to ensure deterministic user choice.

6. **Chess Bidi & User Content Isolation Primitives (`bidi.ts` & `style.css`):**
   - Technical chess content is isolated using DOM layout primitives: `<bdi dir="ltr" class="bidi-ltr">`, `createLtrElement()`, `applyLtrIsolation()`, and `wrapLtrHtml()`.
   - Added `.bidi-ltr { direction: ltr; unicode-bidi: isolate; }` to `style.css`.
   - `isChessNotation()` and linear O(N) bounded `isPgnMovetext()` classify SAN, UCI, FEN, PGN movetext, clocks, engine evaluations (`+0.45`, `-1.20`, `#3`), time controls (`3+2`), and rating stats (`2450 (±25)`).
   - Directional isolation is enforced at the DOM layout layer without inserting invisible Unicode control marks (LRM/RLM/LRI) into text nodes, ensuring that copied PGN, FEN, or UCI values remain clean and valid for chess engines and external tools.
   - Unknown-direction user content (player handles, study comments, author names) is isolated using auto-direction (`dir="auto"`, `applyAutoDirection`, `createUserTextElement`, `wrapUserTextHtml`).

## Consequences

### Positive
- Client-owned UI copy is centralized in a strongly typed English catalog, preventing copywriting drift.
- The web application has architectural infrastructure for bidirectional rendering (including future Arabic RTL) with explicit DOM-level isolation for technical notation and auto-direction for user text.
- Zero bundle bloat: the entire localization subsystem is approximately 3 KB minified and requires zero external npm packages.
- Document and manager ownership contracts are strictly scoped to bootstrap instances without global state leaks.

### Negative / Trade-offs
- Adding new client-owned UI features requires defining message keys in `enMessages` rather than inlining string literals in markup or renderers.
- Dynamic controller nodes require explicit re-render subscriptions if they need to update when locale changes.

### English copy decisions verified during PR #81 correction (2026-10-02)

English remains the default. Lobby seek rows preserve the pre-migration raw variant and speed spelling (`standard · blitz`); other registered catalogs translate these labels. Two deliberate exceptions to exact English text parity are retained from the documented implementation: tournament detail uses human-readable variant labels, and premove announcements include the selected promotion piece (`e7–e8=Q`). The tournament decision is recorded in Increment 80, Finding M; the promotion suffix accurately identifies the technical move and is covered by the board bidi/promotion regressions. The PR description must disclose both exceptions.

Locale changes render semantic pending, message and result state without issuing new requests. Lesson attempts belong to a mount-owned set of stable step IDs; completion updates current controls, and disposal releases read-only boards and subscriptions. Default browser storage property access is guarded as well as storage operations. Missing persistence does not prevent startup or in-memory locale operations.
