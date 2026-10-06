# Launch Preparation A07 — mobile, Firefox and Safari verification — 2026-10-06

**A07 REMAINS OPEN — physical mobile/orientation evidence and real Safari evidence unavailable.** Release Firefox evidence (dimension B) passed in English and Arabic/RTL after one correction. No physical phone or tablet, no adb/remote-debugging target and no macOS, iPhone, iPad or already-authorized real-device cloud was available, so dimensions A and C are recorded as external dependencies. Playwright WebKit ran as supporting compatibility evidence only and is not Safari.

## Source and environment

- Starting and current main: `8f1fd4171e83ef264954c1d246656e7c0eb060c5` (PR #100 owner-merged; local HEAD, `origin/main` and GitHub `main` identical; no open PRs). Isolated branch `claude/launch-a07-cross-browser-mobile-evidence`.
- Tested implementation: the working tree of this branch (main plus the board correction below), built with `npm run build` and served by the repository e2e harness (`packages/e2e-harness`) behind `vite preview` on `http://localhost:4173`. The harness is an in-process backend: real WebSocket game sessions, seeks, clocks, ratings, profile/history and engine analysis; it advertises `gameReview: false`, so post-game review was exercised on the deployed stack in O09, not here.
- Windows 11 Home 10.0.26300; display scaling 125% (DPR 1.25).
- **Mozilla Firefox 157.0** (release, en-US, x64), installed for this task through winget from Mozilla's official CDN (`download-installer.cdn.mozilla.net/pub/firefox/releases/157.0/win64/en-US/`), installer SHA-256 `58c90afab6e4b9a6b34d2958fe06d1a143dd9226ea8834377e5cd45e815936d7` verified; `firefox.exe` Authenticode **Valid**, signer `CN=Mozilla Corporation`. Driven through WebDriver BiDi (puppeteer-core 25.12.0, kept outside the repository). `navigator.userAgent` reported `Firefox/157.0`.
- Supporting engines (not release browsers): Playwright 1.61.1 Firefox (patched Gecko, "Juggler") and **Playwright WebKit 26.5** (Windows port, build v2311). Chromium is the existing CI engine.
- Disposable harness accounts only (`a07…` handles, `example.test` addresses).

## Availability matrix

| Dimension | Required evidence | Available here | Outcome |
| --- | --- | --- | --- |
| A — physical mobile + orientation | Real phone/tablet, physically rotated | None: no Android/Apple PnP/WPD device present, no `adb`, no remote-debugging target | **NOT AVAILABLE / EXTERNAL DEPENDENCY** |
| B — real Firefox | Release Mozilla Firefox | Firefox 157.0 (official, signature-verified) | **PASS** after FAIL → FIX → RETEST |
| C — real Safari | macOS Safari, real iPhone/iPad Safari, or an authorized real-device cloud | None: Windows-only host, no Apple device, no authorized cloud; nothing was purchased or registered | **NOT AVAILABLE / EXTERNAL DEPENDENCY** |

Viewport changes below (390×844 ⇄ 844×390, 320×640, 570×214) were applied with WebDriver BiDi `setViewport` in release Firefox. They are **supporting responsive evidence, not physical rotation**, and do not credit dimension A. Release Firefox on this display enforces a 500 CSS-px minimum window width, so phone widths could not be reached with real window resizing.

## B — release Firefox 157.0 journeys

One scripted journey per locale, Firefox as the White player, a Chromium second player accepting the seek and playing Black. On the corrected build: 11 complete journeys at 17/17 (English 5, Arabic 6), plus 2 Arabic runs that stalled on the script race described below.

| Step | English | Arabic/RTL |
| --- | --- | --- |
| Guest landing | `dir=ltr`, no horizontal overflow at 1280×815 | Language selector → `lang=ar`, `dir=rtl`, mirrored shell, no overflow |
| Authentication | UI registration (handle/email/password, Register) → "Signed in as …" | Same, localized; identity `bdi`-isolated |
| Create Game | Panel opens, White chosen, no overflow; labels fully visible at 1440/390/320 | Same in RTL |
| Seeks | Own seek listed; opponent acceptance navigates both players to the same `/game/<id>` | Same |
| Active game / board | 64 squares, first rendered square `a8` (White orientation) | `a8` first and `a1` bottom-left under `dir=rtl`: orientation follows player colour, not text direction |
| Board interaction | Click-to-move a2→a4→a5, opponent h7→h5→h4 applied over WebSocket | Same |
| Clocks | White clock running (`9:59 → 9:57`) | Same, localized clock labels |
| Portrait/landscape (supporting) | 390×844 → 844×390 → 390×844 mid-game: square board (358/249 px), no overflow, identical position, Resign reachable | Same (board 358/246 px); sidebar scrolls within its column |
| Promotion | b7×a8 opens the chooser; Knight underpromotion → `a8, white knight` | `a8، حصان أبيض` |
| Finished game | Resign confirm → `Black wins by resignation (0-1)`; clocks stop | `فوز الأسود بالاستسلام (0-1)` |
| Review / analysis | Game review correctly hidden (`gameReview:false`); engine **Analyse** returns 3 lines | Same |
| Profile / history | Profile games list populated, no overflow | Same, `dir=rtl` |
| About / public document | Article renders at 1280 and 320 without overflow | Same, RTL prose |
| Service worker | `/about` controlled by the worker; with the preview server **killed**, `/fair-play` reloaded from the offline shell (`serverDown:true`, `controlled:true`) | — |
| Account security | `#passkeys-self` visible with active sessions `(1)`; `PublicKeyCredential.parseCreationOptionsFromJSON` present; achievements `0 of 12 · 0 points` | — |

Two early runs stalled because the script clicked the Chromium opponent's Accept before its session had hydrated. The existing seek-acceptance spec waits for `#auth-logout`; after the script did the same, all later runs passed. That stall was on the Chromium side and is not a Firefox observation.

## Defect found and corrected

**Promotion chooser on a short landscape viewport (Firefox) — FAIL → FIX → RETEST → PASS.**

- *Observed:* at 570×214 (the A06 1140×428-at-200% shape) release Firefox 157 and Playwright Gecko both left the focused Queen choice at y 155–273 in a 214 px viewport: 59 px of the focused control below the fold (WCAG 2.4.11 focus not obscured). Chromium reveals the whole control. Board sizing is width-driven below 720 px by design, so the 538 px board and page scroll are expected; the difference is focus scrolling, where Firefox leaves a partly visible focused element in place.
- *Second issue, same surface, engine-independent:* while the chooser covered the board, the roving square beneath it kept `tabindex=0`, so Shift+Tab from the first choice reached a square hidden behind the dialog. A unit test reproduced this (RED: `e7` still tabbable).
- *Fix* (`packages/web/src/ui/board-view.ts`): squares render `tabindex=-1` while the chooser exists, opening the chooser re-renders once (render already preserves the overlay), and the chooser scrolls each focused choice to `block/inline: nearest` on `focusin`. Every close path already re-renders, restoring the roving square.
- *Regression coverage:* `packages/web/test/board-a11y.test.ts` › "an open promotion chooser takes the covered squares out of the tab order until it closes", covering the open state, the reveal call and restoration after cancel. Mutation check: removing the reveal turns it RED.
- *Retest:* Playwright Gecko `game-responsive.spec.ts` 4/4 in isolation after the fix (before: both locales failed at 570×214 with bottom 272.9/273.1 > 215); release Firefox journeys above; Chromium focused promotion/keyboard/create-game specs 86/86.

## Investigated and not product defects

| Playwright Gecko failure (before fix: 257/278 passed) | Release Firefox 157 finding | Classification |
| --- | --- | --- |
| Create Game "King of the Hill"/"Racing Kings"/"Unlimited" label fit (15 tests) | `scrollWidth == clientWidth` and the label box lies inside its chip at 1440/390; only `scrollHeight 18 > clientHeight 17` for a 16.8 px line box with `overflow: visible`. Screenshots show the full text; Chromium layout is identical. | Test proxy: Gecko counts the font content area beyond `line-height: 1.2` as scrollable overflow. No clipping. |
| Promotion bounds at 570×214 (2) | Reproduced | **Corrected above** |
| Leaderboard select `43.99994 ≥ 44` | `min-height: 44px` declared | Gecko 1/60-px layout-unit rounding in `boundingBox()` |
| Offline public-document reload `NS_ERROR_OFFLINE` | Passes with the server genuinely stopped | Playwright Gecko offline emulation blocks before the service worker |
| Active sessions panel hidden; achievements count empty (2) | Panel visible with sessions; achievements rendered | Harness session flakes under parallel Gecko workers |
| Repeat runs: setup move clicks not applied | All setup moves applied in every release-Firefox run | Gecko timing flake under parallel workers |

An early release-Firefox probe suggested Tab from the Queen skipped Rook/Bishop/Knight. The puppeteer-driven window never had document focus (`document.hasFocus() === false` even on a `data:` page, with or without `focusmanager.testmode`), and in that state no `focusin`/`focusout` events fired. **That observation is not credited.** Playwright Gecko, which emulates a focused window, passed the full Queen → Rook → Bishop → Knight → Cancel order. Native Windows computer use grants browsers read-only access, so genuine OS-keyboard Firefox focus-order evidence was not available here.

## Supporting WebKit (Playwright WebKit 26.5 — not Safari)

The full 278-test backend-gated suite ran once on Playwright WebKit 26.5 on Windows, on the corrected build: **237 passed, 41 failed** (4 workers). Re-running the 41 failures single-worker: **8 passed** (load-sensitive, including every Arabic-shell `dir="rtl"` case) and **33 failed deterministically**. None of this is Safari evidence, and no product change was made for WebKit-only results.

| Deterministic WebKit failures | Count | Assessment |
| --- | --- | --- |
| Tab does not focus the skip link, public-document title or Create Game radios (`rtl-layout-reliability` ×8, `public-documents` focus ×4, `create-game` keyboard ×2) | 14 | WebKit's default keyboard model does not Tab-focus links/buttons; Safari behaves the same unless "Press Tab to highlight each item" is enabled. Platform default, not an app regression; real-Safari keyboard evidence still needed. |
| Create Game request/rejection/resume flows, email verification, password recovery, teams, bot request (all drive `page.route` mocked responses) | 13 | Mocked fulfilment, cookie or timing behaviour of the Windows WebKit port; unconfirmed, Safari relevance unknown. |
| Offline navigation / offline public document / service-worker update (`WebKit encountered an internal error`, `Load failed`) and PGN download | 4 | Windows WebKit port networking/offline/download limitations. Release Firefox passed the equivalent offline check with the server genuinely stopped. |
| Theme background and lobby failure-text contrast (`rgba(0,0,0,0)`, "expected opaque colour") | 2 | `getComputedStyle(body)` returns empty custom properties and transparent/black values, but the page **paints** the correct dark background and light text (screenshot), and the same `var(--bg)` resolves on a child element. Computed-style API discrepancy in this build, not a visible defect. |

**Safari: not tested.** These WebKit results neither establish nor rule out Safari behaviour.

## Durable automation decision

CI stays Chromium-only. A Firefox/WebKit Playwright project was evaluated on the full 278-test suite. Gecko produced 21 failures, of which only the promotion pair was a product defect; the rest were measurement-proxy differences (sub-pixel, scrollable-overflow rounding) and timing flakes under parallel workers. Adding the engine to CI would need per-engine assertion forks and retries that weaken the zero-skip, zero-flake contract without adding defect-finding power beyond what this audit recorded. The corrected behaviour is pinned by the hermetic unit test above, which runs on every CI build. Revisit with a small dedicated cross-engine smoke project if a future engine-specific regression escapes.

## Validation

On the final source:

- `npm run build`: pass. `npm run lint`: pass (19 workspaces).
- `npm test`: all 19 hermetic workspaces with zero skips; web 1485/1485 (main 1484 plus the new regression).
- `npm run test:scripts`: 324/324, zero skips.
- Full Chromium acceptance (`GAMBIT_E2E_BACKEND=1 npm run e2e`): 278/278 passed, zero skips, zero retries.
- Focused board unit suites 85/85 during the RED → GREEN cycle; the regression was RED before the fix and RED again under the mutation.
- No delivery, Nginx, service-worker or CI configuration changed, so Nginx delivery was not re-run.

## Limitations

- No physical device was used; all mobile-shaped evidence is viewport-based and supporting only. Physical rotation, real touch, on-screen keyboard behaviour and mobile browser chrome (dynamic toolbars, `dvh`) remain unverified.
- No Safari of any kind was used. Playwright WebKit on Windows differs from Apple Safari in networking, focus defaults, fonts and platform integration.
- Release Firefox evidence is Windows desktop Firefox 157.0 only; Firefox for Android was not tested.
- Keyboard focus order in release Firefox is not credited (see above). Release Firefox journeys used pointer clicks and DOM-level focus.
- Post-game review was not exercised against a review-capable backend in Firefox; O09 covers it on the deployed stack in Chromium.
- This is bounded evidence for the listed journeys, engines and versions. It does not claim that Rookzen supports all devices and browsers.

**A07 REMAINS OPEN — physical mobile/orientation evidence (A) and real Safari evidence (C) unavailable on this host.** Closing it requires an owner-provided physical Android/iOS device for A and a real Safari environment for C (macOS Safari, iPhone/iPad Safari, or an owner-authorized real-device cloud). A06 remains closed; O06 remains untouched and last.
