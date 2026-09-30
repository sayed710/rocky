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

Per owner directives:
- The active production runtime locale MUST remain `en` (`ltr`) by default.
- There must be NO automatic browser language detection (`navigator.language`).
- There must be NO visible language switcher, production Arabic catalog, or URL route changes in this increment.
- Zero third-party localization libraries should be added; an internal, typed, minimal implementation is preferred.
- Chessboard logical orientation must remain strictly decoupled from document reading direction.

## Decision

1. **Zero-dependency internal typed message architecture (`packages/web/src/i18n`):**
   - Implemented an internal localization system with zero external runtime dependencies.
   - Core types (`types.ts`) define `Locale` (`'en' | 'ar'`), `Direction` (`'ltr' | 'rtl'`), and `InterpolationParams`.
   - `metadata.ts` enforces `DEFAULT_LOCALE = 'en'`, `SUPPORTED_LOCALES = ['en', 'ar']`, and provides `resolveLocale()` which normalizes language tags (e.g. `'en-US'` -> `'en'`, `'ar-EG'` -> `'ar'`) and safely falls back to `'en'` for invalid or unsupported inputs.
   - `interpolate.ts` provides safe, deterministic placeholder substitution (`{param}`) with regex replacement and parameter escaping, avoiding `eval()`, `Function()`, or unsafe template execution.

2. **Authoritative canonical English catalog (`catalog/en.ts` & `catalog/index.ts`):**
   - Established `enMessages` containing 100% of current user-visible English copy across application shell, auth, lobby, game actions, review, analysis, opening explorer, coach, profile, leaderboard, tournaments, learning, endgames, studies, teams, forums, and messages.
   - `MessageKey` is derived directly as `keyof typeof enMessages`. Compile-time TypeScript exhaustiveness and runtime type guard `isMessageKey()` guarantee that missing, mistyped, or invalid message keys cannot be consumed.

3. **Application I18n Manager & Composition Integration (`manager.ts` & `app/composition.ts`):**
   - Created `I18n` class with `t(key, params)` lookup, `getLocale()`, `getDirection()`, `setLocale()`, and `onLocaleChange()` subscription.
   - Missing keys throw deterministic errors in development/testing and safely fall back to the raw key in production.
   - Injected `i18n` instance into `AppDependencies` and composed into `App` composition root, ensuring zero global mutable singleton state.

4. **DOM Document Language & Shell Localization Plumbing (`document.ts` & `shell.ts`):**
   - `applyDocumentLocale(locale, doc)` acts as the single authoritative owner of `document.documentElement.lang` and `dir`.
   - `localizeShell(doc, i18n)` provides declarative shell translation via `data-i18n`, `data-i18n-aria-label`, `data-i18n-placeholder`, and `data-i18n-title` attributes, while retaining fallback text in `index.html` for pre-hydration / SSR resilience.

5. **Safe Locale Preference Storage Abstraction (`storage.ts`):**
   - `LocaleStorage` wraps `KeyValueStorage` under key `rookzen_locale_v1`.
   - Validates stored data using `isSupportedLocale()`. Any missing, corrupt, or invalid stored preference safely and silently resolves to `DEFAULT_LOCALE` (`en`).
   - Browser auto-detection (`navigator.language`) is explicitly omitted to ensure deterministic user choice.

6. **Chess Bidi Isolation Primitives (`bidi.ts` & `style.css`):**
   - Isolated mixed-direction chess tokens using DOM isolation primitives: `<bdi dir="ltr" class="bidi-ltr">`, `createLtrElement()`, `applyLtrIsolation()`, and `wrapLtrHtml()`.
   - Added `.bidi-ltr { direction: ltr; unicode-bidi: isolate; }` to `style.css`.
   - `isChessNotation()` detects SAN, UCI, FEN, clocks, engine evaluations (`+0.45`, `-1.20`, `#3`), time controls (`3+2`), and rating stats (`2450 (±25)`).
   - Crucially, directional isolation is enforced at the DOM layout layer without inserting invisible Unicode control marks (LRM/RLM/LRI) into text nodes, ensuring that copied PGN, FEN, or UCI values remain clean and valid for chess engines and external tools.

## Consequences

### Positive
- The application is structurally ready for bidirectional and multilingual rendering (including Arabic RTL) with zero architectural redesign needed.
- English UI strings are strongly typed and centralized, preventing copywriting drift and accidental omissions.
- Zero bundle bloat: the entire localization subsystem is approximately 3 KB minified and requires zero external npm packages.
- Strict compile-time and test-time guardrails prevent missing catalog keys.

### Negative / Trade-offs
- Adding new UI features requires defining message keys in `enMessages` rather than inlining string literals in markup or renderers.
- Statically verified template substrings in tests require awareness of `data-i18n` attribute placement.
