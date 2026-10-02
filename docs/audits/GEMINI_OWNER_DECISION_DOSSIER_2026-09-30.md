# Gemini Planning Artifact: Owner-Decision Dossier

> **Codex adjudication — 2026-10-02:** Independent Codex review of this entire historical document against current main `07946b9b03538ed73a3f7b773e7ad5a327d83805` is complete. Read the [current-main correction and disposition ledger](CODEX_GEMINI_PLANNING_ADJUDICATION_2026-10-02.md) before using any claim or sequence below. The original Gemini snapshot, recommendations and then-pending review status are preserved as historical evidence, not current implementation instructions or owner approval.


> [!IMPORTANT]
> **STATUS AND AUTHORITY NOTICE**
> - **Gemini-Generated Planning/Review Artifact**: This document was produced during Gemini read-only implementation-planning audits on 2026-09-30.
> - **Evidence Snapshot, Not Project Truth Forever**: Observations and repository inspections reflect commit `553751c628f69436600987ddbf649a13f2b9eb2d` (`origin/main`).
> - **Pending Independent Codex Adjudication**: Codex will independently adjudicate whether each item listed in this dossier is genuinely an owner decision or an engineering implementation choice.
> - **NOT an Owner-Approved Product Decision**: The repository owner has NOT selected any options in this document. All checkboxes remain unselected (`[ ]`).
> - **Recommendations Labelled as Planning Proposals Only**: All recommendations are labelled *"Gemini recommendation — pending Codex review and owner decision"* and carry no implementation authority.
> - **NOT Authorization for Implementation**: This document does not authorize implementation without prior owner approval.
> - **Historical Findings Reverification**: Findings must be reverified against current `origin/main`.
> - **Current Repository Truth Wins**: Current repository and GitHub evidence strictly supersedes any statement in this document.

---

## 1. Executive Summary & Boundaries

This dossier identifies potential owner-level product, policy, and visual decisions that will shape upcoming implementation PRs. It cleanly separates:
1. **Candidate Owner Decisions** (D-01 through D-17, subject to Codex adjudication).
2. **Legal-Counsel-Only Questions** (strictly separate from product decisions).
3. **Engineering Facts & Technical Invariants** (items already resolved or governed by engineering standard practice).

### Visual Boundary Classification
* **[V1 - Functional Implementation]:** Engineering proceeds using existing design tokens (`var(--cb-stone-*)`, `var(--cb-burgundy-*)`) and layout primitives without requiring visual design approval.
* **[V2 - Provisional Implementation]:** Provisional implementation allowed behind feature flags, in test fixtures, or using neutral layouts; owner may refine before release.
* **[V3 - Visual Gate]:** UI component placement or visual chrome layout requires explicit owner visual approval prior to end-user rendering.

---

## 2. Master Decision Dossier (Candidate Owner Decisions)

> [!NOTE]
> Codex will independently adjudicate whether each candidate item below is a genuine owner decision or an engineering implementation choice.

---

### Group 1: Immediate Scaffolding Gates (i18n & Policy Scaffolding)

```
================================================================================
DECISION ID: D-01
TITLE: Language Auto-Detection vs Explicit User Choice
CANDIDATE CLASSIFICATION: OWNER PRODUCT DECISION
VISUAL BOUNDARY: V1 (Functional logic, no UI required)
================================================================================
```
* **Why Required:** Determines whether Rookzen’s locale management service automatically switches a first-time visitor's shell to Arabic based on `navigator.languages` / browser headers, or stays strictly English until the user explicitly toggles the language.
* **Current Verified State:** Web app currently hardcodes English strings throughout `packages/web/src/ui/`. No `LocaleManager` exists. No browser header inspection exists.
* **Options:**
  * **Option A:** Strict Explicit Preference. Default all first-time sessions to English (`en`). Only switch to Arabic (`ar`) if the user explicitly activates Arabic via the language switcher. Persist choice in `localStorage`.
    * *Pros:* Zero accidental bidi disruption; completely predictable first-time rendering; safe for shared devices.
    * *Cons:* Arabic-first users must take one manual action to see Arabic.
  * **Option B:** Browser Auto-Detection with English Fallback. Inspect `navigator.languages` on first visit. If an Arabic locale (`ar`, `ar-*`) precedes English, set initial locale to `ar`. Persist explicit changes in `localStorage`.
    * *Pros:* Native localized experience for Arabic-speaking users without extra clicks.
    * *Cons:* May surprise bilingual users whose OS is Arabic but prefer chess notation in English; requires robust client-side hydrate synchronization.
  * **Option C:** Geo-IP / Header Detection on server gateway.
    * *Pros:* Server-rendered locale matching.
    * *Cons:* Over-engineered for a static SPA; fails on VPNs; violates minimal-dependency rules.
* **Recommended Default:** **Option A (Strict Explicit Preference)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before `LocaleManager` initialization logic is finalized in i18n PR 1.
* **Dependencies:** None.
* **Reversibility:** High. Modifying initial resolution order in `LocaleManager` is a 5-line change.

---

```
================================================================================
DECISION ID: D-05
TITLE: Client-Side URL Localization Strategy
CANDIDATE CLASSIFICATION: OWNER PRODUCT DECISION
VISUAL BOUNDARY: V1 (Router architecture)
================================================================================
```
* **Why Required:** Determines whether locale changes are reflected in route paths (e.g., `/ar/lobby`, `/ar/game/:id`) or handled purely via client-side state/storage without URL prefixes.
* **Current Verified State:** `packages/web/src/router.ts` uses clean, flat, unprefixed routes: `/`, `/lobby`, `/game/:id`, `/analysis`, `/review/:id`, `/tournaments`.
* **Options:**
  * **Option A:** State/Storage Only, Unprefixed URLs. URLs remain `/lobby`, `/game/:id`. Locale is managed in memory and synced to `localStorage['cb_locale']`.
    * *Pros:* Zero route disruption; shareable game links (`/game/:id`) open in recipient's preferred language; simplifies `router.ts` and deep-linking.
    * *Cons:* Cannot force a specific language when sharing a URL.
  * **Option B:** Locale-Prefixed Routes. Routes become `/:lang/lobby`, `/:lang/game/:id`, with root `/` redirecting based on active locale.
    * *Pros:* Explicit SEO localization; language state is bookmarkable and shareable.
    * *Cons:* Major refactor of `router.ts`, navigation helpers, canonical link headers, and WebSocket reconnection handlers; breaks existing links without redirects.
* **Recommended Default:** **Option A (State/Storage Only, Unprefixed URLs)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Router route-matching logic is updated in i18n PR 1.
* **Dependencies:** None.
* **Reversibility:** Medium (Switching from A to B later requires routing table modifications; switching B to A breaks shared URLs).

---

```
================================================================================
DECISION ID: D-06
TITLE: Public Policy & Disclosure Navigation Placement
CANDIDATE CLASSIFICATION: OWNER PRODUCT & VISUAL DECISION
VISUAL BOUNDARY: V3 (Persistent chrome placement requires owner visual sign-off)
================================================================================
```
* **Why Required:** The release gate requires public, discoverable access to Privacy Policy, Terms of Service, Fair Play Policy, and AGPL source code disclosure. Engineering must know where links live in the UI chrome.
* **Current Verified State:** The web shell is an application-style dark layout with a fixed top header (`.cb-topbar`) and full-viewport main canvas (`.cb-app-shell__content`). There is **no persistent footer** anywhere in the app.
* **Options:**
  * **Option A:** Contextual Placement. Add policy links into the user/utility dropdown menu, inside the registration/login dialogs, and create a public `/about` or `/legal` hub route. Keep the active game/lobby screen free of persistent footer clutter.
    * *Pros:* Preserves viewport real estate for the chessboard and lobby seeks; zero visual regression on mobile play.
    * *Cons:* Requires 2 clicks to find from game view.
  * **Option B:** Persistent Global Footer. Add a slim static footer (`.cb-footer`) containing links across all routes (or non-game routes).
    * *Pros:* Traditional web convention; high visibility.
    * *Cons:* Squeezes vertical height on mobile viewports; requires custom exceptions for `/game/:id` where the board must fit viewport height without scrolling.
  * **Option C:** Lobby-Only Footer. Render a footer only on the home/lobby view, suppressed during live games.
    * *Pros:* Balance between discoverability and board canvas purity.
    * *Cons:* Inconsistent shell layout across routes.
* **Recommended Default:** **Option A (Contextual Menu + Auth Card + `/about` Hub)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Policy PR 2 (UI Integration). Policy PR 1 (scaffolding) creates routes independently.
* **Dependencies:** None.
* **Reversibility:** High. Moving link components between chrome slots is purely declarative.

---

```
================================================================================
DECISION ID: D-07
TITLE: Registration / Auth Terms & Privacy Consent Mechanism
CANDIDATE CLASSIFICATION: OWNER PRODUCT DECISION (WITH LEGAL COUNSEL REVIEW)
VISUAL BOUNDARY: V2 (Provisional auth card links allowed)
================================================================================
```
* **Why Required:** When a user creates an account, how should their acceptance of the Terms of Service and Privacy Policy be captured?
* **Current Verified State:** Registration form (`packages/web/src/ui/auth/`) collects username, email, and password. It currently contains no policy text, no disclaimer, and no checkbox.
* **Options:**
  * **Option A:** Affirmative Mandatory Checkbox. Require an explicit `<input type="checkbox" required>` with copy: *"I agree to the Terms of Service and acknowledge the Privacy Policy"*. The registration button remains disabled until checked.
    * *Pros:* Highest legal defense against claims of non-agreement; unambiguous user consent recordable with timestamp in account DB.
    * *Cons:* Adds 1 click of friction to user onboarding.
  * **Option B:** Informational Browsewrap Notice. Neutral notice below the submit button: *"By creating an account, you agree to our Terms of Service and Privacy Policy"*, with links opening in new tabs.
    * *Pros:* Zero friction; standard modern SaaS pattern.
    * *Cons:* Weaker enforceability in certain jurisdictions compared to explicit clickwrap.
* **Recommended Default:** **Option A (Affirmative Mandatory Checkbox)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Auth UI integration PR.
* **Dependencies:** D-06 (routes must exist to link to).
* **Reversibility:** High. Modifying registration form validation and submission schema takes <1 hour.

---

### Group 2: Feature-Specific Gates (P1 Implementation & Visual Mounting)

```
================================================================================
DECISION ID: D-02
TITLE: Language Switcher UI Placement and Presentation
CANDIDATE CLASSIFICATION: OWNER VISUAL DECISION
VISUAL BOUNDARY: V3 (Must wait for owner visual approval before landing in production chrome)
================================================================================
```
* **Why Required:** Users need an accessible control to toggle between English and Arabic.
* **Current Verified State:** Topbar contains: Logo/Brand, Nav Links (`Lobby`, `Tournaments`), Connection Status Indicator, and User Profile badge. No language control exists.
* **Codex option-label correction:** Gemini originally described A as topbar-only and recommended desktop A/mobile B, while the response sheet called that combination A. For a single unambiguous response, A now consistently denotes the combination; the original distinction is recorded here. No selection is made.
* **Options (Codex-harmonized D-02 labels):**
  * **Option A:** Desktop Topbar / Mobile Menu. On desktop, a compact button in the topbar utility area (adjacent to user menu) reading `"عربي"` when in English, and `"English"` when in Arabic; on mobile, the same control is a menu row.
    * *Historical Gemini tradeoffs for the former topbar-only A:* Single-click switching; universally discoverable; accessible without opening menus; consumes 48px–64px horizontal space in the topbar (critical on mobile).
    * *Codex clarification for harmonized A:* Desktop retains a direct control; mobile requires opening the menu and avoids adding the toggle to its topbar. Exact sizes and breakpoint require design/measurement, not the historical estimates.
  * **Option B:** User/Settings Menu Only (All Viewports). Place a "Language / اللغة" row inside the existing user avatar menu dropdown (and mobile drawer).
    * *Pros:* Keeps topbar uncluttered on small viewports.
    * *Cons:* Discovered only after opening the menu; anonymous/unauthenticated users must have access to a guest menu.
  * **Option C:** Settings Surface Only. Language selection lives exclusively inside the Settings dialog (`/settings`).
    * *Pros:* Centralizes all preferences.
    * *Cons:* Highest friction to change language; poor UX for a first-time Arabic visitor who cannot read English to navigate to Settings.
* **Recommended Default:** **Desktop topbar / mobile menu combination (historically A/B; now harmonized as Option A)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Prior to i18n PR 2 (UI Integration).
* **Dependencies:** D-01.
* **Reversibility:** High.

---

```
================================================================================
DECISION ID: D-04
TITLE: Arabic Webfont Bundling Strategy
CANDIDATE CLASSIFICATION: OWNER PRODUCT & PERFORMANCE DECISION
VISUAL BOUNDARY: V2 (Can use system font stack provisionally)
================================================================================
```
* **Why Required:** Arabic typography requires proper baseline, diacritic rendering, and glyph shaping. We must decide whether to bundle a custom webfont (e.g., self-hosted `Noto Sans Arabic` ~120KB WOFF2) or rely strictly on system font fallbacks.
* **Current Verified State:** `packages/web/src/styles/` specifies system fonts: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`. Service Worker (`sw.js`) caches local static assets.
* **Options:**
  * **Option A:** High-Quality System Font Stack (Zero Bundle Overhead). Define Arabic typography stack: `system-ui, -apple-system, "Segoe UI", Tahoma, Arial, sans-serif` with tuned `line-height: 1.5` and `font-feature-settings`.
    * *Pros:* 0 KB added to PWA cache; instantaneous loading; native OS rendering (San Francisco Arabic on Apple, Segoe UI Arabic on Windows, Roboto on Android).
    * *Cons:* Minor rendering variance across operating systems.
  * **Option B:** Self-Hosted Bundled Noto Sans Arabic WOFF2. Bundle subsetted WOFF2 files into `packages/web/public/fonts/` and precache in `sw.js`.
    * *Pros:* Identical typographic rendering across all platforms and OS versions.
    * *Cons:* Adds 80KB–140KB to initial PWA bundle; increases offline cache footprint; potential Flash of Unstyled Text (FOUT).
  * **Option C:** Google Fonts CDN fetch from `fonts.googleapis.com`.
    * *Cons:* Strictly disallowed by architectural invariants (violates offline PWA requirements, adds external tracking/latency dependency).
* **Recommended Default:** **Option A (Tuned System Font Stack)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before i18n PR 2 (CSS/Theme integration).
* **Dependencies:** None.
* **Reversibility:** High. Changing `@font-face` or `var(--cb-font-family)` is a single CSS variable update.

---

```
================================================================================
DECISION ID: D-08
TITLE: Direct Friend Challenges — Rated vs Casual Eligibility
CANDIDATE CLASSIFICATION: OWNER PRODUCT DECISION
VISUAL BOUNDARY: V1 (Form selector logic)
================================================================================
```
* **Why Required:** When a user creates a direct challenge link or challenges an online friend, can that game be played as a rated game affecting their pool rating, or must all direct challenges be casual (unrated)?
* **Current Verified State:** PR #76 establishes explicit `(variant, speed)` pools and truthful rating calculations. Currently, open lobby seeks are rated by default. Direct friend challenges do not yet exist.
* **Options:**
  * **Option A:** Casual-Only for Direct Challenges. All direct friend challenges and challenge links are strictly Casual (`rated: false`).
    * *Pros:* Eliminates rating manipulation, booster accounts, and collusion; completely isolates rating pools to random lobby matchmaking.
    * *Cons:* Friends cannot play rated games against each other.
  * **Option B:** User Choice: Rated or Casual. Challenge creation dialog includes a toggle: `[Rated | Casual]`. Rated challenges check pool rating requirements and update the respective `(variant, speed)` pool.
    * *Pros:* Standard platform expectation (matches Lichess/Chess.com).
    * *Cons:* Opens vector for rating boosting between puppet accounts; requires rating ceiling/floor sanity checks.
  * **Option C:** Provisional Rated with Anti-Collusion Restrictions. Rated allowed, but maximum N rated games per day between the same two user IDs.
    * *Pros:* Allows friendly competition while capping boosting risk.
    * *Cons:* Adds backend state tracking and complex rate-limiting rules.
* **Recommended Default:** **Option A (Casual-Only initially)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Direct Challenge PR domain model and API contract are implemented.
* **Dependencies:** PR #76 (for rating pool contracts if Option B is chosen).
* **Reversibility:** High. Adding a `rated: boolean` toggle to a challenge schema is forward-compatible.

---

```
================================================================================
DECISION ID: D-09
TITLE: Rematch Capability — Color Inversion & Setting Inheritance
CANDIDATE CLASSIFICATION: OWNER PRODUCT DECISION
VISUAL BOUNDARY: V1 (Post-game button and state machine)
================================================================================
```
* **Why Required:** When a game concludes, the post-game card needs a "Rematch" action. How are parameters (colors, time controls, rated status) negotiated?
* **Current Verified State:** `packages/web/src/ui/game/` renders game over state (`Resign`, `Draw offer`, `Result banner`). No rematch event or UI button currently exists.
* **Options:**
  * **Option A:** Strict Inverted Rematch. Clicking "Rematch" proposes an identical game (same variant, same time control, same rated/casual status) with **strictly swapped colors** (White becomes Black). Proposing player waits until opponent accepts; if accepted, both auto-navigate to new game.
    * *Pros:* Simplest, cleanest protocol; conforms to universal chess etiquette; zero negotiation UI needed.
    * *Cons:* Cannot change time control without leaving to lobby.
  * **Option B:** Negotiated Rematch. Players can alter time control or rated status before accepting.
    * *Pros:* High flexibility.
    * *Cons:* Over-complicated UI; high abandonment rate during negotiation.
* **Recommended Default:** **Option A (Strict Inverted Rematch)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Rematch PR implementation.
* **Dependencies:** Game conclusion lifecycle events (`game:ended`).
* **Reversibility:** High.

---

```
================================================================================
DECISION ID: D-10
TITLE: Incoming Direct Challenge Notification UX
CANDIDATE CLASSIFICATION: OWNER PRODUCT & VISUAL DECISION
VISUAL BOUNDARY: V3 (Notification chrome behavior)
================================================================================
```
* **Why Required:** When Player A challenges Player B directly while Player B is browsing the lobby or analysis board, how does Player B receive and respond to the challenge?
* **Current Verified State:** WebSocket gateway delivers events. Notifications currently exist only as inline status text or basic toast.
* **Options:**
  * **Option A:** Non-Modal Floating Toast / Notification Tray. A non-modal notification banner slides in at the top-right (top-left in RTL) showing: *"UserX challenged you to 3+2 Blitz [Accept] [Decline]"*, with a 30-second expiry countdown.
    * *Pros:* Non-blocking; does not disrupt active analysis or board navigation; auto-dismisses on expiry.
    * *Cons:* Might be missed if user is not looking at notification corner.
  * **Option B:** Modal Interruption Dialog. A centered modal dialog blocks the screen with challenge details.
    * *Pros:* Impossible to miss.
    * *Cons:* Highly intrusive; disrupts user during active analysis or game replay.
  * **Option C:** Lobby Seek Card Badge Only. Direct challenges only appear as pinned items in the lobby seek list.
    * *Pros:* Completely passive.
    * *Cons:* Invisible if the user is on `/analysis` or `/tournaments`.
* **Recommended Default:** **Option A (Non-Modal Floating Toast with Expiry Timer)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Direct Challenge UI PR.
* **Dependencies:** Direct Challenge domain model.
* **Reversibility:** High.

---

```
================================================================================
DECISION ID: D-15
TITLE: Historical Game Review Proposal — wrong client-worker premise
CANDIDATE CLASSIFICATION: OWNER PRODUCT & PERFORMANCE DECISION
VISUAL BOUNDARY: V2 (Engine progress indicators and evaluation charts)
================================================================================
```
**Codex adjudication — original D-15 premise and worker-specific recommendations below are superseded.** At both SHAs, finished-game review is `POST /v1/games/:id/review`, using server `GameReviewService` / `AnalysisPort`, limited to the first 40 moves **by the authenticated reviewed player**, not a global 80-ply cap. Longer games return `isPartial`, `totalPlayerMoves`, `analyzedPlayerMoves`, and `cutoffReason: 'move_limit'`. The server default deadline is 120 seconds. It does not freeze a client analysis worker. See [evidence and corrected decision boundary](CODEX_GEMINI_PLANNING_ADJUDICATION_2026-10-02.md#game-review-correction).

**Corrected, unselected decision scope:** Whether to extend bounded server review beyond the current partial-review contract. A = proposed server critical-moment selection; B = proposed explicit server resume/pagination API and UI; C = proposed server budget/depth adaptation. None exists by virtue of this dossier; engineering must assess admission, cancellation, ownership and evidence quality before a separately authorized implementation. The current partial fallback is already implemented.

**Original Gemini D-15 (historical only):**

* **Why Required:** Full-game analysis currently evaluates up to ply 80 (40 full moves). In longer games (e.g., 70 moves), moves 41+ currently lack engine evaluation. We must decide how to handle games exceeding 40 moves within web-worker performance limits.
* **Current Verified State:** Analysis engine web worker operates on client CPU. Running depth 18 across 100 plies can freeze lower-end devices or take over 60 seconds.
* **Options:**
  * **Option A:** Critical Moments & Tactical Swings Across Full Game. Run rapid shallow scan (depth 12) across the *entire* game to locate turning points, blunders, and evaluation swings, then deepen evaluation (depth 18) only on those critical moments (up to 40 selected plies total).
    * *Pros:* Full game coverage regardless of length; provides meaningful learning insights; stays within fixed compute/battery budget.
    * *Cons:* Some quiet endgame moves receive shallow evaluations.
  * **Option B:** Explicit UI Pagination / "Analyze Remaining Moves" Button. Retain depth 18 for moves 1–40. If game > 40 moves, display a clear UI prompt: *"[Analyze Moves 41–80]"* triggering incremental worker evaluation on user demand.
    * *Pros:* Completely transparent; user chooses when to spend CPU cycles; zero wasted background compute.
    * *Cons:* Requires two clicks to see full analysis on long games.
  * **Option C:** Dynamic Depth Scaling. Automatically reduce engine depth based on game length (e.g., depth 18 for ≤40 moves, depth 14 for 41–60 moves, depth 12 for >60 moves).
    * *Pros:* Fully automated single-pass analysis.
    * *Cons:* Inconsistent accuracy between short and long games.
* **Recommended Default:** **Option B (Explicit "Analyze Remaining Moves" on demand) as interim, moving to Option A as permanent enhancement** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Game Review Optimization PR.
* **Dependencies:** Web worker Stockfish/analysis wrapper.
* **Reversibility:** High.

---

```
================================================================================
DECISION ID: D-16
TITLE: Settings Surface Launch Scope vs Deferred Preferences
CANDIDATE CLASSIFICATION: OWNER PRODUCT DECISION
VISUAL BOUNDARY: V2 (Provisional settings dialog layout)
================================================================================
```
* **Why Required:** The settings surface can expand indefinitely. We must fix the exact boundary of what settings are required for the initial release gate vs deferred to subsequent milestones.
* **Current Verified State:** Settings are scattered or implicit. Dark theme is default. Sound is hardcoded or tied to browser audio context.
* **Options:**
  * **Option A:** Essential Launch Core. Scope launch settings strictly to:
    1. Language (`English` / `العربية`)
    2. Theme (`Dark` / `Light` / `System`)
    3. Sound Effects (`Enabled` / `Disabled`, Volume slider)
    4. Board Highlights (Show legal moves: `on`/`off`; Show last move: `on`/`off`)
    *All other preferences (piece sets, board themes, custom clocks, auto-queen) deferred to P2.*
    * *Pros:* Minimal surface; rapid implementation; rock-solid stability; avoids visual clutter.
    * *Cons:* Power users cannot customize piece graphics immediately.
  * **Option B:** Expanded Chess Preferences. Include custom board colorways, piece SVGs, coordinates display (inside/outside/none), and move confirmation in addition to Option A.
    * *Pros:* Feature parity with mature platforms.
    * *Cons:* Requires sourcing, licensing, and testing multiple SVG piece sets; expands test matrix significantly.
* **Recommended Default:** **Option A (Essential Launch Core)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Settings UI PR.
* **Dependencies:** D-01, D-02 (Language setting integration).
* **Reversibility:** High. Settings schema is additive.

---

```
================================================================================
DECISION ID: D-17
TITLE: Mobile Navigation Architecture & Touch Hierarchy
CANDIDATE CLASSIFICATION: OWNER PRODUCT & VISUAL DECISION
VISUAL BOUNDARY: V3 (Structural shell navigation on mobile screens)
================================================================================
```
* **Why Required:** On viewports < 768px, horizontal topbar links (`Lobby`, `Tournaments`, Language, User) overflow. A coherent mobile navigation pattern is required that guarantees 44px+ touch targets and zero occlusion of the board canvas.
* **Current Verified State:** `packages/web/src/ui/` has basic responsive media queries, but lacks a dedicated mobile navigation drawer or bottom navigation bar.
* **Options:**
  * **Option A:** Collapsible Topbar with Hamburger Drawer. Topbar keeps Logo, Connection dot, and a 48px Hamburger menu icon. Tapping opens an off-canvas drawer containing all navigation links, language switcher, settings, and legal links.
    * *Pros:* Keeps bottom of viewport completely clear for chess board controls and move clocks; standard responsive web pattern.
    * *Cons:* Navigation requires 2 taps.
  * **Option B:** Bottom Tab Bar. A fixed bottom navigation bar (`Lobby`, `Play`, `Tournaments`, `Profile`) pinned at screen bottom.
    * *Pros:* Thumb-friendly ergonomics on mobile phones.
    * *Cons:* Severely reduces vertical height available for the chessboard; risks accidental touches during fast blitz play; complicates virtual keyboard handling.
  * **Option C:** Compact Scrolling Topbar with horizontal chips.
    * *Pros:* No drawer needed.
    * *Cons:* Poor usability; hides items offscreen; clumsy with RTL bidi mixing.
* **Recommended Default:** **Option A (Collapsible Topbar Hamburger Drawer)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Mobile Polish & Touch Targets PR.
* **Dependencies:** D-02, D-06.
* **Reversibility:** Medium (Switching navigation container component requires minor CSS adjustments).

---

### Group 3: Release Gates & Policy Enforcement (Before Public Launch)

```
================================================================================
DECISION ID: D-03
TITLE: Arabic Chess Terminology & Production Copy Approval
CANDIDATE CLASSIFICATION: OWNER PRODUCT DECISION
VISUAL BOUNDARY: V2 (Can use provisional catalog in tests/staging)
================================================================================
```
* **Why Required:** Standardized Modern Standard Arabic (الفصحى) chess terminology has dialectical variations. Owner must formally approve the specific glossary used in production customer-facing strings.
* **Current Verified State:** PR 1 will provide typed translation infrastructure with English strings and test fixtures. Arabic production catalog (`packages/web/src/i18n/locales/ar.json`) requires owner sign-off.
* **Options:**
  * **Option A:** Classic Standard Lexicon:
    * Blitz: `خاطف`
    * Rapid: `سريع`
    * Bullet: `رصاصة`
    * Resign: `استسلام`
    * Draw: `تعادل`
    * Checkmate: `كش مات`
    * Stalemate: `مات مخنوق / تعادل بالجمود`
    * Casual: `ودي`
    * Rated: `مصنف`
    * Spectate: `مشاهدة`
  * **Option B:** Modern Transliterated Hybrid:
    * Blitz: `بليتز`
    * Bullet: `بوليت`
    * Rapid: `رابيد`
    * Resign: `انسحاب`
    * Casual: `غير مصنف`
  * **Option C:** Owner-Specified Custom Glossary. Owner provides an authoritative terminology CSV or overrides Option A.
* **Recommended Default:** **Option A (Classic Standard Lexicon)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before i18n PR 3 (Production Arabic Catalog integration).
* **Dependencies:** i18n PR 1 (Typed keys must be defined first).
* **Reversibility:** High. Updating `ar.json` is a pure JSON data edit with zero code changes.

---

```
================================================================================
DECISION ID: D-11
TITLE: Account Deletion Semantics & Historical Game Retention
CANDIDATE CLASSIFICATION: OWNER PRODUCT & POLICY DECISION (WITH LEGAL COUNSEL REVIEW)
VISUAL BOUNDARY: V1 (Backend domain logic & account management surface)
================================================================================
```
* **Why Required:** When a user deletes their account, what happens to their historical games, ratings history, and event-store logs?
* **Current Verified State:** The platform uses an append-only event store and Postgres relational projection. Game events record `whitePlayerId` and `blackPlayerId`.
* **Options:**
  * **Option A:** Pseudonymization / Handle Scrubbing. Personal data (email, password hash, session tokens, IP logs) is permanently deleted. Public username/handle is replaced everywhere with `[deleted]` (or `[حساب محذوف]`). Historical games, move lists, timestamps, and rating changes remain intact in the immutable game archive.
    * *Pros:* Prevents corruption of opponent game histories; preserves tournament standings and rating integrity across the platform; fully compatible with immutable event sourcing.
    * *Cons:* Requires clear disclosure in Privacy Policy explaining that played chess games form a public historical record.
  * **Option B:** Hard Deletion & Game Unlinking. Delete all games where the user was a participant, or null out all references.
    * *Pros:* Absolute purge.
    * *Cons:* Completely breaks opponent match history, invalidates PGN archives, and mathematically corrupts historical rating calculations for all past opponents.
* **Recommended Default:** **Option A (Pseudonymization / Handle Scrubbing)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Account Deletion / Data Privacy PR.
* **Dependencies:** User account service domain schema.
* **Reversibility:** Low (Hard purging is irreversible; pseudonymization is industry standard).

---

```
================================================================================
DECISION ID: D-12
TITLE: Personal Data Export Format & Scope
CANDIDATE CLASSIFICATION: OWNER PRODUCT DECISION
VISUAL BOUNDARY: V1 (Download endpoint and user surface trigger)
================================================================================
```
* **Why Required:** Users must be able to export their personal data and game records. We must fix the export file format and data schema.
* **Current Verified State:** No export endpoint exists. PGN serializer is an engineering fact for game views.
* **Options:**
  * **Option A:** Dual Export (Multi-Game PGN + JSON Profile). A single `.zip` (or direct `.json` + `.pgn` downloads) containing:
    1. `games.pgn`: All played games in standard PGN format (readable by ChessBase, Lichess, etc.).
    2. `account_data.json`: Profile info, account creation date, ratings history per pool, and user settings.
    * *Pros:* Delivers maximum utility to chess players (PGN is universal) while providing full machine-readable personal data.
    * *Cons:* Requires packaging zip stream on server.
  * **Option B:** Single PGN Archive Only. Download all games as a single concatenated PGN file.
    * *Pros:* Simplest implementation.
    * *Cons:* Omits profile metadata, rating history, and preferences.
* **Recommended Default:** **Option A (Dual Export: PGN + JSON)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Account Data Export PR.
* **Dependencies:** PGN export serializer (Engineering Fact).
* **Reversibility:** High.

---

```
================================================================================
DECISION ID: D-13
TITLE: User Reporting Categories & Moderation Workflow
CANDIDATE CLASSIFICATION: OWNER PRODUCT DECISION
VISUAL BOUNDARY: V1 (Report dialog form)
================================================================================
```
* **Why Required:** Users need an in-game and profile mechanism to report bad actors. Engineering must implement the submission form and backend moderation ingestion queue.
* **Current Verified State:** No reporting tables or UI modal exist.
* **Options:**
  * **Option A:** Structured Categories + Operator Queue Only:
    1. `Suspected Engine / Cheating`
    2. `Harassment / Offensive Chat`
    3. `Stalling / Intentional Disconnection`
    4. `Inappropriate Username`
    Reports are stored in a dedicated `moderation_reports` table for operator review. Zero automated bans or restrictions triggered directly by reports.
    * *Pros:* Eliminates report abuse and malicious coordinated flagging between players; simple, clean data model.
    * *Cons:* Requires human operator to review reports.
  * **Option B:** Automated Temporary Cooldowns on High-Volume Flags. If a user receives > N reports in 1 hour, automatically apply a temporary chat mute or 1-hour matchmaking timeout pending review.
    * *Pros:* Fast containment of active spammers.
    * *Cons:* High vulnerability to griefing and false-positive brigades.
* **Recommended Default:** **Option A (Structured Categories + Operator Queue Only)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Moderation & Reporting PR.
* **Dependencies:** None.
* **Reversibility:** High.

---

```
================================================================================
DECISION ID: D-14
TITLE: Anti-Cheat Engine Review Output Action Policy
CANDIDATE CLASSIFICATION: OWNER PRODUCT & LEGAL RISK DECISION
VISUAL BOUNDARY: V1 (Moderator dashboard/action flags)
================================================================================
```
* **Why Required:** When post-game analysis or server heuristics flag a game with high engine correlation (e.g., 98% top-engine match, 5 centipawn loss across 40 moves), what automated action is taken?
* **Current Verified State:** Analysis engine runs client-side. Server-side anti-cheat heuristics are unconfigured.
* **Options:**
  * **Option A:** Strict Review Flagging / No Automated Bans. Anti-cheat triggers flag the account in the internal database (`flagged_for_review = true`). No automated rating refunds, no instant bans, and no visible public badge until an operator confirms.
    * *Pros:* Zero false-positive bans; eliminates player outrage and legal friction; allows stealth observation.
    * *Cons:* Blatant cheaters might play several games before manual review.
  * **Option B:** Automated Shadowban / Pool Isolation. Automatically isolate accounts with extreme engine correlation into a separate cheater matchmaking pool without notification.
    * *Pros:* Instantly protects honest players without confrontation.
    * *Cons:* High engineering complexity; risks isolating innocent players playing book openings.
* **Recommended Default:** **Option A (Strict Review Flagging / Operator Queue)** — *Gemini recommendation — pending Codex review and owner decision.*
* **Decision Deadline:** Before Anti-Cheat Backend Integration.
* **Dependencies:** Game analysis data pipeline.
* **Reversibility:** High.

---

## 3. Legal-Counsel-Only Questions (Strictly Separate)

> [!IMPORTANT]
> The following items are **strictly legal-review questions**. Engineering and product owners must not make authoritative legal determinations on these points.

1. **AGPL-3.0 Network User Source Disclosure Sufficiency:**
   * *Question for Counsel:* Does placing a direct hyperlink in the application navigation/about view linking to the exact GitHub commit repository SHA satisfy Section 13 ("Remote Network Interaction; To Public License") of the GNU AGPL v3, or must the application also offer a direct server-hosted `.tar.gz` source download endpoint?
2. **GDPR / Right-to-Erasure vs Immutable Event-Sourced Ledger:**
   * *Question for Counsel:* In an append-only event-sourced system, does replacing a user’s identifying username with a pseudonymized marker (`[deleted]`) and purging all personal profile/contact metadata in the read-model projection satisfy GDPR Article 17 ("Right to Erasure"), given that chess move records and historical tournament results are preserved for public platform integrity?
3. **Fair Play & Anti-Cheat Heuristic Disclosure:**
   * *Question for Counsel:* To avoid giving engine-assisted players actionable reverse-engineering insights, is it legally sufficient for the Fair Play Policy to state that *"Rookzen employs proprietary behavioral and statistical methods to detect unauthorized assistance, and accounts may be closed at our sole discretion without disclosure of specific detection heuristics"*?

---

## 4. Things Engineering Should Not Ask Owner Again (Pending Codex Verification)

> [!NOTE]
> Codex will independently verify whether the items below are settled engineering invariants and architectural facts that do not require owner input:

* **Helm Tournament Reporter Parity:** `tournamentReporter.enabled: true` in `helm/values.yaml` is pure deployment configuration parity with Docker Compose.
* **Opponent Rating in Seek Rows:** Pure correctness follow-up to PR #76. Lobby seek cards will display creator rating from the explicit `(variant, speed)` pool matching the seek.
* **Game PGN Serializer:** Standard PGN specification (Seven Tag Roster + SAN move text) is a read-only serializer.
* **Illegal-Move Feedback:** Standard accessibility & UX interaction (`interaction.ts` emitting `illegal`, CSS board shake cue, and `#status` aria-live polite announcement).
* **Board Physical Geometry in RTL:** Permanently pinned in PR #78 as `.cb-board { direction: ltr; }`. Square `a1` remains bottom-left for White.
* **Skip-Link Geometry in RTL:** Permanently pinned in PR #78 using logical properties (`inset-inline-start: 8px`).
* **Unicode Bidirectional Isolation:** Technical requirement under the Unicode Bidirectional Algorithm (UBA) to wrap usernames, ratings, SAN notation, and clocks in `<bdi>` or `unicode-bidi: isolate`.

---

## 5. Implementation Unblock Matrix

| Decision ID | Decision Title | Blocks Which PR / Milestone? | Can Engineering Start Before Decision? | Latest Safe Decision Point |
| :---: | :--- | :--- | :---: | :--- |
| **D-01** | Language Auto-Detection | i18n PR 1 (LocaleManager) | **YES** (Build with Option A default) | Before PR 1 merge |
| **D-05** | URL Localization Strategy | i18n PR 1 (Router scaffolding) | **YES** (Build with Option A clean URLs) | Before PR 1 merge |
| **D-06** | Policy Surface Placement | Policy PR 2 (UI Integration) | **YES** (Build PR 1 routes & scaffolding) | Before PR 2 starts |
| **D-07** | Registration Consent UX | Auth Policy Integration | **YES** (Build schema with configurable flag) | Before Auth UI polish |
| **D-02** | Language Switcher UI | i18n PR 2 (Shell Integration) | **YES** (Build headless toggle hook first) | Before PR 2 UI mounting |
| **D-04** | Arabic Webfont Bundling | i18n PR 2 (Typography CSS) | **YES** (Use system font stack in PR 1/2) | Before release candidate |
| **D-08** | Challenge Rating Eligibility | Friend Challenge Domain PR | **YES** (Build challenge schema & WebSocket) | Before rated pool hookup |
| **D-09** | Rematch Inversion Rules | Rematch Feature PR | **YES** (Build state machine scaffolding) | Before UI button mount |
| **D-10** | Incoming Challenge UX | Friend Challenge UI PR | **YES** (Build backend invite delivery) | Before UI toast mount |
| **D-15** | Game Review 40-Move Engine | Game Review Optimization PR | **YES** (Refactor worker architecture) | Before review UI update |
| **D-16** | Settings Surface Scope | Settings Dialog PR | **YES** (Build settings store & persistence) | Before dialog UI mount |
| **D-17** | Mobile Navigation Shell | Mobile Ergonomics & Polish PR | **YES** (Audit touch targets & responsive CSS)| Before layout refactor |
| **D-03** | Arabic Copy & Chess Terms | i18n PR 3 (Production Catalog) | **YES** (PR 1/2 use test strings/en catalog) | Before PR 3 merge |
| **D-11** | Account Deletion Semantics | Account Privacy & Deletion PR | **YES** (Build user deletion request schema) | Before DB purge execution |
| **D-12** | Personal Data Export Scope | Account Export PR | **YES** (Build PGN serializer component) | Before export endpoint |
| **D-13** | Reporting Categories & Queue | Reporting & Moderation PR | **YES** (Build report modal component) | Before backend migration |
| **D-14** | Anti-Cheat Output Policy | Anti-Cheat Telemetry Pipeline | **YES** (Build heuristic collector) | Before policy action code |

---

## 6. Recommended Decision Order for Owner

### Batch 1: Immediate Scaffolding Sign-Off (Unblocks i18n PR 1 & Policy PR 1)
* `D-01` (Language Auto-Detection)
* `D-05` (URL Localization Strategy)
* `D-06` (Policy Link Placement)
* `D-07` (Registration Consent UX)

### Batch 2: Feature Scoping Sign-Off (Unblocks Specific P1 PRs)
* `D-02` (Language Switcher UI Placement)
* `D-04` (Arabic Webfont Bundling Strategy)
* `D-08` (Direct Friend Challenges — Rated vs Casual)
* `D-09` (Rematch Color & Setting Rules)
* `D-10` (Incoming Challenge Notification UX)
* `D-15` (Game Review Engine 40-Move Limit)
* `D-16` (Settings Surface Launch Scope)
* `D-17` (Mobile Navigation Architecture)

### Batch 3: Release Gates & Production Policy Enforcement (Before Public Launch)
* `D-03` (Arabic Chess Terminology Approval)
* `D-11` (Account Deletion & Game History Retention)
* `D-12` (Personal Data Export Scope & Format)
* `D-13` (User Reporting Taxonomy & Review Policy)
* `D-14` (Anti-Cheat Engine Action Policy)

---

## 7. Owner Response Sheet

> [!IMPORTANT]
> **All options below are unselected (`[ ]`). The owner has not made any selections.**
> Gemini recommendations are indicated as planning proposals pending Codex review and owner decision.

```markdown
### BATCH 1: IMMEDIATE SCAFFOLDING
D-01 (Language Auto-Detection):
  [ ] Option A: Strict explicit user choice (Default English) [Gemini Recommendation]
  [ ] Option B: Auto-detect via navigator.languages on first visit
  [ ] Custom: _____________________________________________

D-05 (URL Localization):
  [ ] Option A: State-only, clean unprefixed URLs (/lobby, /game/:id) [Gemini Recommendation]
  [ ] Option B: Route-prefixed URLs (/:lang/lobby, /:lang/game/:id)
  [ ] Custom: _____________________________________________

D-06 (Policy Link Placement):
  [ ] Option A: Contextual (User menu + Auth modals + /about hub) [Gemini Recommendation]
  [ ] Option B: Persistent global bottom footer
  [ ] Option C: Lobby-only footer
  [ ] Custom: _____________________________________________

D-07 (Registration Consent UX):
  [ ] Option A: Affirmative mandatory checkbox [Gemini Recommendation]
  [ ] Option B: Informational browsewrap notice below submit button
  [ ] Custom: _____________________________________________

---

### BATCH 2: FEATURE SCOPING
D-02 (Language Switcher UI):
  [ ] Option A: Desktop Topbar / Mobile Menu [Gemini Recommendation]
  [ ] Option B: User/Settings Menu Only (All Viewports)
  [ ] Option C: Settings Surface Only
  [ ] Custom: _____________________________________________

D-04 (Arabic Webfont Strategy):
  [ ] Option A: Tuned system font stack (0 KB bundle weight) [Gemini Recommendation]
  [ ] Option B: Bundle Noto Sans Arabic WOFF2 (~120 KB into PWA cache)
  [ ] Custom: _____________________________________________

D-08 (Direct Challenge Rated Status):
  [ ] Option A: Strictly Casual (unrated) for initial release [Gemini Recommendation]
  [ ] Option B: User choice (Rated or Casual toggle)
  [ ] Custom: _____________________________________________

D-09 (Rematch Rules):
  [ ] Option A: Strict inverted rematch (same settings, swap colors) [Gemini Recommendation]
  [ ] Option B: Negotiable settings
  [ ] Custom: _____________________________________________

D-10 (Incoming Challenge Notification):
  [ ] Option A: Non-modal floating toast with 30s expiry timer [Gemini Recommendation]
  [ ] Option B: Centered blocking modal dialog
  [ ] Custom: _____________________________________________

D-15 (Game Review Engine Ceiling):
  [ ] Option B: Proposed server resume/pagination API + explicit UI [Historical Gemini interim preference, corrected architecture]
  [ ] Option A: Proposed server critical-moment selection
  [ ] Option C: Proposed server budget/depth adaptation
  [ ] Custom: _____________________________________________

D-16 (Settings Surface Scope):
  [ ] Option A: Core 4 (Theme, Language, Sound, Move Cues) [Gemini Recommendation]
  [ ] Option B: Expanded (Custom piece sets, board colorways, auto-queen)
  [ ] Custom: _____________________________________________

D-17 (Mobile Navigation):
  [ ] Option A: Topbar with Hamburger off-canvas drawer [Gemini Recommendation]
  [ ] Option B: Fixed bottom tab bar
  [ ] Custom: _____________________________________________

---

### BATCH 3: RELEASE GATES
D-03 (Arabic Chess Terminology):
  [ ] Option A: Classic Standard Lexicon (خاطف، استسلام، ودي، مصنف) [Gemini Recommendation]
  [ ] Option B: Transliterated Modern Hybrid (بليتز، انسحاب، غير مصنف)
  [ ] Custom: _____________________________________________

D-11 (Account Deletion Semantics):
  [ ] Option A: Pseudonymize handle to [deleted], retain games in archive [Gemini Recommendation]
  [ ] Option B: Hard purge of user games
  [ ] Custom: _____________________________________________

D-12 (Data Export Scope):
  [ ] Option A: Dual export (Standard PGN file + JSON profile) [Gemini Recommendation]
  [ ] Option B: PGN archive only
  [ ] Custom: _____________________________________________

D-13 (Reporting Categories):
  [ ] Option A: 4 standard categories + Operator review queue only [Gemini Recommendation]
  [ ] Option B: Automated cooldowns on report thresholds
  [ ] Custom: _____________________________________________

D-14 (Anti-Cheat Action Policy):
  [ ] Option A: Operator review queue only (no automated bans) [Gemini Recommendation]
  [ ] Option B: Automated shadowban into cheater pool
  [ ] Custom: _____________________________________________
```

## 8. Codex disposition of owner decisions

The [17-row owner-decision adjudication](CODEX_GEMINI_PLANNING_ADJUDICATION_2026-10-02.md#owner-decision-adjudication) supersedes the historical deadlines/unblock matrix and unsupported effort, performance, legal and abuse-elimination claims. Existing engineering baselines do not prove formal owner selection of A/B/C. No checkbox has been selected. D-13's backend and D-14's deployment are already merged, while workflow/sanction policy and later web UI remain separate. D-15 is a potential server-budget enhancement, not an absent partial-review capability.
