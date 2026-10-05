# A06 accessibility preparation and owner checklist — 2026-10-05

**A06 READY_FOR_MANUAL_EVIDENCE. It is not closed.**

Starting/current main: `ceab1365fa912f01895dfc226a5f0377767f4598` (includes PR #98 history links). Work was performed in the clean isolated `codex/launch-a06-accessibility-certification` worktree already supplied for this task. The canonical checkout was inspected for preflight only. Final PR HEAD and exact-head review/CI results belong in the PR handoff; a document cannot embed its own commit SHA without becoming stale.

## Evidence boundary

No screen reader was used. Standard NVDA installation paths and the running/installed app inventory did not expose NVDA; this is not an exhaustive claim that no portable installation exists. No NVDA version, speech transcript, English spoken journey, Arabic spoken order or pronunciation result is available. No screen reader was downloaded or installed.

The bundled Windows computer-use runtime could list Chrome, but stopped before inspecting the new browser window because it could not establish the browser URL confidently enough to enforce its policy. No subsequent Windows UI input was attempted. Actual 200% browser zoom and the practical rendered low-vision pass are **not verified**. Headless screenshots, narrow viewports and contrast calculations receive supporting credit only.

Environment: Windows 11 Home `10.0.26300`; Node `24.15.0`, npm `11.12.1`. Installed Chrome executable reports `154.0.8037.95`, but no completed manual journey used it. The supporting Linux Lighthouse runner used Playwright Chromium `149.0.7827.55`; its tool image was the existing `rocky-d03-audit:c8df3e0`, serving this worktree's newly built `packages/web/dist` read-only. That image is tooling, not evidence that its older application source was tested.

The independent Gemini CLI invocation failed authentication with `IneligibleTierError`, reason `UNSUPPORTED_CLIENT`; it also reported an untrusted-directory restriction. No model review completed and no reasoning level was established. These are authentication/configuration failures, not quota fallbacks: Claude/Codex fallback review is not credited. The owner must restore the requested review lane and obtain exact-final-head review before accepting that requirement as satisfied.

## Current accessibility map (diagnostic, not manual certification)

Source contract inspected: `packages/web/index.html`, `src/app/bootstrap.ts`, `route-surface.ts`, `router.ts`, `board.ts`, `ui/board-view.ts`, `create-game-panel.ts`, `play-bot-dialog.ts`, `lobby-mount.ts`, `profile-mount.ts`, `game-mount.ts`, `game-review-controller.ts`, `public-document.ts`, i18n document/bidi/catalogue files and `src/style.css`. Existing unit and browser coverage supports the observations below; actual speech and perception remain untested.

| Surface | Current semantic/name/keyboard contract | Focus, announcements, direction and remaining manual check |
|---|---|---|
| Global identity | Document title `Rookzen`; brand is an h1 link; header and named Main navigation are native; one persistent main contains route sections | Public documents set their page-specific title. Other routes retain product identity. Confirm route identity is understandable in speech. |
| Language | Native labelled `#locale-select`; English/Arabic options carry language/direction attributes | Locale manager updates html `lang`/`dir` and translated names in place. Exercise the actual selector; DOM direction does not prove speech order. |
| Skip/navigation | `#skip-board` is a native link, exposed only on game routes; normal navigation uses links | Activation targets the board's roving cell; CSS exposes the focused link. There is no general lobby skip-to-main link. Assess landmark/heading navigation and whether repetitive shell navigation impedes the journeys. |
| Guest/auth | Visible h2 names auth section; native labels, username/password autocomplete, required handle/password, explicitly described registration email requirement | Error alert and auth status live region; step-up code focuses when requested. Actual label/error association, submit focus and successful-state announcement require speech verification. |
| Create a game | Inline disclosure, **not a modal**; named form, native fieldsets/legends/radios, associated custom-time/rating errors and invalid state | Opens on selected time radio; Escape/cancel restores trigger; More options exposes advanced fields. Time summary is live; numeric controls/presets use LTR. Do not demand modal containment for this inline form. |
| Bot dialog | Native `dialog` with heading name, native options and labelled controls | Native modal interaction, dismissal/return focus and contained error feedback require owner keyboard/speech confirmation. |
| Seeks | List/listitem rows, opponent profile links, labelled accept/cancel buttons, atomically named rating | Owned seek waiting/cancel differs from other-player Play; render preserves/replaces focused seek controls and focuses empty status if the final row disappears. Listen to variant, speed, time and rated/casual distinction, including multiple seeks from one player. |
| Active game | Named chess grid and game-info aside; metadata identifies role, players, variant and time; action group uses buttons | Connection/presence live updates; turn/result and illegal-move status regions. Result/action handlers may focus status. Confirm announcements do not duplicate/conflict. |
| Board | Grid, eight rows, 64 named square/piece/empty cells, row/column indices, selected/current/described states; one roving tab stop | Arrows, Home/End, Ctrl+Home/End, PageUp/PageDown, Enter/Space; promotion choices and cancel. Focus survives rendering; board CSS stays LTR and orientation follows chess perspective. Test with NVDA's actual browse/focus modes, not just keyboard events. |
| Clocks | White/Black labels and text time values; read without depending on colour | No per-tick speech certification is claimed. Inspect both readable clocks and how active/remaining time is discovered. Clock/chess technical content has LTR treatment. |
| Resign/abort/review | Native actions, inline confirmation buttons with explicit names; review heading, live note/error and move buttons | Confirm entry/cancellation/terminal focus and terminal result speech, and activate review rows to hear SAN/best-move status. |
| Profile/history | Heading, named ratings/history areas; history rows are native `/game/:id` links from PR #98 | Links retain keyboard/open-in-new-tab semantics; result tokens use LTR `bdi`. Reopen a real finished game, then review it. |
| Leaderboard | Heading, labelled pool selectors and rendered result rows | Ratings have technical isolation; verify selected pool/loading/error/empty context and logical reading order. |
| Public documents | Named article, h2 title/h3 subsections, native source links and description list | In-app navigation focuses title; revision/URL isolated LTR; long source strings wrap. Policies still have authorized publication-state copy. |
| Missing/unavailable | Heading and native Return to Play link; route sections hide inactive surfaces; feature/error/status copy is contextual | Confirm recovery by keyboard and comprehension of unavailable/empty states; automated recovery is not speech proof. |
| Low vision/reflow | Existing logical spacing, bounded grids, wrapping, responsive auth/create-game, visible focus treatments and light/dark tokens | The error-ink defect below is fixed. Full rendered state inspection, clipping/overlap, focus visibility and real zoom remain pending. Disabled/selected/coordinate/review states must be inspected explicitly. |

## Confirmed defect and correction

The default dark error ink `#e5484d` on `#242224` was 4.036:1, below 4.5:1 for its 14px text. The current rendered `#lobby-error` failure state also produced Lighthouse's exact `color-contrast` finding (4.03:1). The previous D03 audit had recorded this limitation, so its healthy-shell result was not assumed to cover it.

Only the semantic dark error token changes to `#ff858a`; brand/background/board/action/focus tokens and light error ink remain unchanged. This also corrects consumers `.cg-field-error` and `.game-review-blunder strong`. Regression tests read the actual CSS tokens, composite panel backgrounds, check both themes and assert those consumer mappings. The old ink fails the new test before correction; the test retains that historic value as a negative control. The corrected ink is 6.75:1 on the page and at least 4.5:1 on the tested base/panel/strong/nested panel surfaces. This is a bounded readability correction, not permanent identity approval.

Four rendered browser cases additionally require a visible, nonempty lobby alert after a controlled HTTP500 seek response, correct English/Arabic locale and dark/light theme, and computed text/background contrast >=4.5:1. Removing the corrected ink causes the dark-theme checks to fail. Actual low-vision perception and the manual repeat of this failure state remain pending.

No further current fixable defect was established by the completed automated assessment. This is not a claim that unperformed manual journeys would find none.

[Sanitized contrast evidence](a06-evidence/contrast-verification.json) includes the actual failed node, corrected audit result and source/build CSS hashes. [Corrected rendered error state](a06-evidence/green-error-state.png) is a headless supporting capture, not manual low-vision or zoom certification. Reproduce through the existing web build and four `app-loads.spec.ts` failure cases; the M6 workflow pins Lighthouse11.4.0 and its desktop >=0.95 command. To audit the failure state directly, run preview with `E2E_API_URL` pointing to a confirmed unused loopback port, wait for the visible HTTP500 lobby alert, then use that same Lighthouse command against preview. A nonzero command, missing/new-report failure or runtime error gets no passing gate credit.

## Supporting validation

Baseline before production changes:

- `npm ci`: completed; no reported dependency vulnerabilities.
- `npm run build` and `npm run lint`: passed.
- `npm test`: all 19 hermetic workspaces passed with zero skips; web portion 1476/1476.
- `npm test --workspace @chess-platform/web`: 1476 passed, zero failures/skips.
- `npm run test:scripts`: 324 passed, zero failures/skips.
- `$env:GAMBIT_E2E_BACKEND='1'; npm run e2e --workspace @chess-platform/web`: 268 total; 266 passed directly, two recovered on retry (account-security sessions and blank search). Includes RTL reliability, Arabic live game, shell, auth/create game, keyboard, game actions, history/review and M6 bot/human acceptance.
- Lighthouse 11.4.0 Windows failure-state report: accessibility 0.96, contrast audit failed. Command exited nonzero during temporary-profile cleanup (`EPERM`); **not a passing command/gate**. Its completed contrast finding is supporting defect reproduction only.

Final checks and any exact-head CI/review findings are recorded in the PR handoff. The completed focused run was 138/138 (a11y, board-a11y, style-contract), zero skips. Final full browser acceptance was 272 total: 271 passed directly, one recovered on retry after Windows worker exit `3221226505` in PGN download. Four added contrast cases passed. The Linux Lighthouse failure-state run exited zero, verified the delivered corrected CSS, and scored **1.00**, with zero failed accessibility audits, warnings or runtime errors. It clears the existing >=0.95 desktop gate for this deliberately unavailable-backend shell; it does not certify healthy gameplay or manual usability.

The local Nginx delivery attempt initially cancelled 12 cases because gateway health never started; the gateway service's separate dependencies/build were missing. No passing delivery evidence is credited to that attempt. After `npm ci --prefix services/gateway` and `npm run build --prefix services/gateway`, `node scripts/nginx-web-delivery-acceptance.mjs` passed 12/12 with zero skips. Final `npm test` passed all 19 hermetic workspaces (web1477/1477, zero skips), and final lint passed.

## Exact owner-assisted manual procedure

Run on the final PR HEAD (record the full SHA before testing; new production pushes invalidate the manual record). Use a real Windows desktop Chrome and NVDA installation. Use the approved local/deployed test environment; do not claim the hermetic harness verifies production email/passkeys. Use two disposable test players for real seeks/games; keep credentials and identifiers out of committed evidence.

Record tester/date, OS build, browser name/full version, NVDA name/full version, installed English/Arabic voice and voice-switch settings, window/viewport dimensions, tested SHA, locale, route, guest/player/spectator state and actual observed speech. NVDA Speech Viewer is acceptable when it represents genuine NVDA output. Sanitize any retained excerpts. If a voice cannot pronounce Arabic, state the voice limitation and separately assess navigation/state semantics; do not invent pronunciation quality.

Use keyboard throughout. NVDA heading/landmark navigation and Tab should agree with understandable content order. In the board, record the actual NVDA mode and any necessary browse/focus-mode switch; do not equate injected keyboard events with this check.

| Journey | English pass, then repeat after changing the actual language selector to Arabic |
|---|---|
| A — `/`, guest | Listen to product identity/language; find header/nav/main and content headings. Reach Language, sign-in/register and Play/Create game. Check tab order and landmark names. On a game route activate Skip to board and confirm actual focus/speech. |
| B — auth on `/` | Read labels, required handle/password and email's registration condition. Submit missing/invalid data and a safely refused login; record actual errors and focus. Sign in successfully and hear changed identity/state. Exercise registration only in the approved test environment. Never retain entered credentials. |
| C — Create a game | Open by keyboard; hear selected time, rated/casual, colour and variant (More options). Change each; reveal custom time, enter invalid values and hear associated error. Verify corrected error text visually. Escape/cancel must return focus to Create a game. Also test bot native dialog name, initial focus, Tab/Shift+Tab containment, Escape and return focus. |
| D — seeks | With two players, distinguish opponent/variant/speed/time/rated/casual and own waiting/cancel versus another player's Play. Navigate rows/links/actions and accept a seek by keyboard. Include same opponent with different controls; ensure the actions remain distinguishable with their context. |
| E — `/game/:id`, active | Identify players/colours, turn and both clocks. Navigate board squares and hear coordinate plus piece/empty, selected/legal states. Enter `e2e4` using board keyboard input, receive move/status; attempt `e2e5` from a starting position to hear illegal feedback. Test a legal check, terminal checkmate where reachable, promotion choice/cancel, resign/abort confirmation and draw actions. Test both White and Black perspectives; RTL must not change square meaning. |
| F — finished/history/review | Hear result; Tab to a native history game link on `/profile` or `/profile/:handle`, press Enter to reopen, and confirm terminal state. Activate Review my game and navigate heading/move buttons/status; select a row and hear SAN/best-move feedback. Record unavailable-engine behaviour if the approved environment cannot review; it leaves the successful-review journey incomplete. |

For Arabic, verify the selector actually changes document language/direction; listen to semantic reading order, not visual position. Record navigation, headings, auth/create-game, game/status and review order. Check visual and spoken mixed content `e4`, `Nf3`, `0-1`, `5+0`, `1500`, usernames and any visible identifiers. Board perspective must stay based on chess colour; copied notation must keep original bytes. Isolation observed in source/DOM alone is not spoken intelligibility evidence.

### Actual zoom and practical low vision

In native Chrome set **page zoom to 200% using the browser menu or Ctrl+plus**, and confirm the menu visibly reports 200%. Record that observation and the browser/window dimensions; use representative desktop windows such as 1280x720 and 1440x900 physical pixels with OS display scaling documented. Browser viewport emulation, CSS `zoom`, device scale factor, pinch magnification or scaled screenshots do not count. Start from 100%, repeat every surface below in English and Arabic, then reset to 100%.

1. `/` lobby and auth, with an empty list and populated seeks.
2. Expanded Create a game, More options, custom-time/rating errors and the bot dialog.
3. Active `/game/:id`, both player perspectives, clocks/actions/confirmations and focused board/promotion controls.
4. `/profile` history, then reopen a finished game and post-game review with real move rows.
5. `/about` (long repository/revision text) and a policy publication-state page.

For each, tab through controls and scroll all content. Record no essential clipping, overlap, missing labels/status/error copy or unreachable controls. Ordinary text should reflow without horizontal document scrolling; describe any intrinsically two-dimensional board exception rather than distorting chess geometry. Focus must remain visible, dialogs usable, clocks/coordinates distinguishable and navigation reachable.

Practically inspect normal/muted text, links, buttons, disabled/selected states, focus rings, alerts/errors (including the corrected HTTP500/custom-time cases), turn/status, clocks, coordinates, history and review rows in both themes. Record actual readability/colour-independent cues and any difficulty. Automated contrast is supporting evidence only. Fix in-scope defects, add focused regressions where practical, and repeat the failed manual scenario before accepting it.

### Completion rule

Every journey needs an actual observation and pass/fail result; an unchecked step is unresolved. Retain sanitized evidence with the environment/SHA above. Only after English and Arabic screen-reader journeys, RTL/mixed-content reading order, actual 200% zoom and practical low-vision inspection pass may an owner-backed verification audit state a bounded A06 closure. Until then the status remains **READY_FOR_MANUAL_EVIDENCE**.

A07 (physical devices/orientation and Firefox/Safari) and O06 (cluster/Helm/CNI/TLS/email/passkeys) remain separate. This is not broad WCAG conformance, final visual/navigation approval or public-launch approval. The owner alone merges the PR.
