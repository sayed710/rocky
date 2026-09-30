# Rookzen Web Localization Subsystem (`packages/web/src/i18n`)

Internal typed localization and bidirectional text isolation system for Rookzen.

## Architecture

This subsystem is built with zero third-party dependencies, adhering to Rookzen's performance, accessibility, and architectural purity standards.

### Modules

| Module | Responsibility |
| :--- | :--- |
| `types.ts` | Core types (`Locale`, `Direction`, `LocaleMetadata`, `InterpolationParams`). |
| `metadata.ts` | Locale constants, direction mapping (`ltr`/`rtl`), and `resolveLocale()` normalization. |
| `interpolate.ts` | Deterministic parameter substitution for `{param}` placeholders without `eval()`. |
| `catalog/en.ts` | Authoritative canonical English catalog containing client-owned UI copy. |
| `catalog/index.ts` | Strongly typed `MessageKey` union derived from `enMessages` and `isMessageKey` type guard. |
| `manager.ts` | `I18n` class and `createI18n()` factory for runtime message resolution and subscriptions. |
| `document.ts` | Scoped synchronization of `<html lang dir>` attributes on target Document. |
| `storage.ts` | Versioned, resilient persistence (`rookzen_locale_v1`) with fallback on invalid values. |
| `bidi.ts` | DOM isolation primitives for chess notation (SAN, UCI, FEN, PGN, clocks, ratings, evaluations) and auto-direction for user text. |
| `shell.ts` | Declarative shell localization scanning static `[data-i18n*]` attributes. |

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
<!-- Static text content -->
<button data-i18n="game.actions.resign">Resign</button>

<!-- ARIA label -->
<button data-i18n-aria-label="shell.themeToggle">🌙</button>

<!-- Form placeholder -->
<input data-i18n-placeholder="nav.searchPlaceholder" />
```

Note: Dynamic controller-owned elements (such as auth status, game status, connection indicator, review note) do NOT carry static `data-i18n` ownership, preventing shell scans from overwriting live state.

### 3. Chess Bidi & User Text Isolation

Chess notation, FEN, clocks, ratings, and evaluations must NEVER contain invisible directional Unicode marks (e.g. LRM/RLM/LRI) because they corrupt copy/paste into chess engines and PGN readers.

Instead, isolate at the DOM layout layer:

```typescript
import { createLtrElement, applyLtrIsolation, applyAutoDirection, wrapLtrHtml, wrapUserTextHtml } from '../i18n/index.js';

// Creating an isolated LTR chess notation element
const uciSpan = createLtrElement(doc, 'span', 'e2e4', 'chess-uci');

// Applying isolation in-place to an existing technical element
applyLtrIsolation(statsElement);

// Applying auto-direction to unknown-direction player or user text
applyAutoDirection(playerHandleElement);

// Wrapping in safe HTML
const markup = wrapLtrHtml('Nf3+'); // <bdi dir="ltr" class="bidi-ltr">Nf3+</bdi>
const userMarkup = wrapUserTextHtml('PlayerName'); // <bdi dir="auto">PlayerName</bdi>
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
2. **Catalog Availability Check:** A locale can only be activated at runtime if a catalog is registered (`this.catalogs.has(locale)`). Because no production Arabic catalog is registered in this increment, attempts to set `ar` safely remain `en`.
3. **No Auto-Detection:** Browser `navigator.language` is intentionally not auto-detected; locale selection requires explicit user action.
4. **No Visible Switcher:** No language switcher UI or locale route prefixes ship in this increment.
5. **Storage Key:** The canonical versioned key is `rookzen_locale_v1`.
6. **Chessboard Invariance:** Logical chessboard orientation is independent of document direction (`dir="rtl"`). `.cb-board` retains `direction: ltr`.
7. **Compile-Time Safety:** All message keys must exist in `enMessages`.
