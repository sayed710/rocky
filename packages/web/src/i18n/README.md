# Rookzen Web Localization Subsystem (`packages/web/src/i18n`)

Internal, production-grade typed localization and bidirectional text isolation system for Rookzen.

## Architecture

This subsystem is built with zero third-party dependencies, adhering to Rookzen's performance, accessibility, and architectural purity standards.

### Modules

| Module | Responsibility |
| :--- | :--- |
| `types.ts` | Core types (`Locale`, `Direction`, `LocaleMetadata`, `InterpolationParams`). |
| `metadata.ts` | Locale constants, direction mapping (`ltr`/`rtl`), and `resolveLocale()` normalization. |
| `interpolate.ts` | Deterministic parameter substitution for `{param}` placeholders without `eval()`. |
| `catalog/en.ts` | Authoritative canonical English catalog containing 100% of user-visible copy. |
| `catalog/index.ts` | Strongly typed `MessageKey` union derived from `enMessages` and `isMessageKey` type guard. |
| `manager.ts` | `I18n` class and `createI18n()` factory for runtime message resolution and subscriptions. |
| `document.ts` | Authoritative synchronization of `<html lang dir>` attributes. |
| `storage.ts` | Versioned, resilient persistence (`rookzen_locale_v1`) with fallback on invalid values. |
| `bidi.ts` | DOM isolation primitives for chess notation (SAN, UCI, FEN, clocks, ratings, evaluations). |
| `shell.ts` | Declarative shell localization scanning `[data-i18n*]` attributes. |

## Usage

### 1. Translating a string in a controller or view

```typescript
import { createI18n } from '../i18n/index.js';

const i18n = app.i18n;

// Simple string
const title = i18n.t('game.actions.offerDraw');

// Interpolated string
const text = i18n.t('lobby.challengeAria', { creator: 'magnus' });
```

### 2. Declarative Shell Markup

In `packages/web/index.html`:

```html
<!-- Text content -->
<button data-i18n="game.actions.resign">Resign</button>

<!-- ARIA label -->
<button data-i18n-aria-label="shell.themeToggle">🌙</button>

<!-- Form placeholder -->
<input data-i18n-placeholder="nav.searchPlaceholder" />
```

### 3. Chess Bidi Isolation

Chess notation, FEN, clocks, and evaluations must NEVER contain invisible directional Unicode marks (e.g. LRM/RLM/LRI) because they corrupt copy/paste into chess engines and PGN readers.

Instead, isolate at the DOM layout layer:

```typescript
import { createLtrElement, applyLtrIsolation, wrapLtrHtml } from '../i18n/index.js';

// Creating an isolated element
const uciSpan = createLtrElement(doc, 'span', 'e2e4', 'chess-uci');

// Applying isolation in-place to an existing node
applyLtrIsolation(statsElement);

// Wrapping in safe HTML
const markup = wrapLtrHtml('Nf3+'); // <bdi dir="ltr" class="bidi-ltr">Nf3+</bdi>
```

Corresponding CSS in `style.css`:
```css
.bidi-ltr {
  direction: ltr;
  unicode-bidi: isolate;
}
```

## Constraints & Invariants

1. **Default Locale:** The active production runtime locale remains `en` by default.
2. **No Auto-Detection:** Browser `navigator.language` is intentionally not auto-detected; locale selection requires explicit user action.
3. **Chessboard Invariance:** Logical chessboard orientation is independent of document direction (`dir="rtl"`). `.cb-board` retains `direction: ltr`.
4. **Compile-Time Safety:** All message keys must exist in `enMessages`.
