# Launch Preparation A06 — manual accessibility verification — 2026-10-06

**A06 CLOSED — bounded manual accessibility evidence complete.** The specified A06 journeys passed with NVDA 2026.2 and Chrome 154.0.8037.98 on Windows 11 Home 10.0.26300 after the corrections below. This closes the six manual categories in the [checklist](LAUNCH_A06_MANUAL_ACCESSIBILITY_CHECKLIST_2026-10-05.md). Implementation review/CI and owner integration are separate delivery gates. A07, O06 and public-launch approval remain separate.

## Source and environment

- Tested main/base: `096aa99aa8c2596252950982bc9a79657a969378`; isolated branch `codex/launch-a06-manual-evidence`. Existing work and raw ignored evidence were preserved. Fresh fetches during testing confirmed the same main.
- Final manually served implementation: `e08adbbc90244300eb959c036e856408c843cf66`. Earlier genuine observations remain credited across additive corrections. The correction table identifies the first corrected revision, not a claim that every journey ran on that revision. English completion used b3a6974; Arabic completion used 082256e with promotion retakes on f5bfc33; the broad zoom/low-vision pass used bbb7a35; changed primary-focus and remaining abort/promotion scenarios used e08adbb. Later documentation-only commits do not change the manually tested application. Final PR revision and remote parity belong in the PR delivery record; a commit cannot embed its own final hash.
- Supported repository Docker Compose topology: web/Nginx, API, gateway with real Stockfish, PostgreSQL, Redis and trust worker. Origin `http://127.0.0.1:4306/`. Healthy services and full served build SHA were verified before evidence. No replacement backend or fabricated review/rating responses were used for manual evidence.
- Disposable local accounts; development console email suppresses tokens. A bounded local email-verification fixture permitted password sign-in. This provides no production email-delivery or O06 credit. Supporting CDP preparation used ordinary legal moves and actual seeks, without changing outcomes, ratings or authoritative legality.
- NVDA portable 2026.2, eSpeak NG, English (Great Britain), Max variant, rate 30, pitch 40, inflection 75, volume 100, rate boost off; automatic language switching on, automatic dialect switching off, language-change reporting on. Arabic appears in the installed voice inventory. Settings inspected through native NVDA UI; no settings change applied.
- OS scaling 125% (120 DPI); physical screen 1920×1080. Maximized Chrome window 1920×1020 physical / 1536×816 logical. At actual 200% page zoom content viewport was 768×337 CSS pixels. Earlier smaller windows were also used; off-desktop content was not credited until maximized and inspected through real scrolling.
- Browser Use/CDP established exact URLs and loaded-page identity. Native Windows computer use operated Chrome keyboard, NVDA and Speech Viewer. Route boundaries used fresh single-tab direct-open windows at the CDP-confirmed destination. DOM/accessibility-tree inspection and automated tests provide supporting evidence only.

## English and Arabic A–F

All rows passed after applicable retakes. The table records actual native keyboard/NVDA outcomes. [Selected genuine Speech Viewer excerpts](LAUNCH_A06_NVDA_EXCERPTS_2026-10-06.md) retain bounded provenance; raw cumulative transcripts remain ignored locally.

| Journey | English observation | Arabic/RTL observation |
| --- | --- | --- |
| A — guest shell | Product, headings, main/navigation landmarks, signed-out identity, language/theme controls; Skip to board and meaningful grid coordinates in both perspectives. | Real language selector established Arabic/RTL; localized headings/navigation/identity, disabled create/sign-in requirement, skip/grid in both perspectives. |
| B — authentication | Required/protected labels, registration email requirement, invalid-email/required constraints, real refusal, disposable registration and successful password sign-in. | Equivalent native flow with localized client errors and successful registration/sign-in; actual corrected refusal spoke Arabic (S06). Browser-owned constraints remained English with this Chrome UI language. |
| C — Create Game/bot | Native selected-state changes; presets, Unlimited/Custom, invalid minutes, contradictory 2000/1000 rating bounds, mode/color, Chess960, advanced options, Cancel/Escape focus return. Bot name, Club description/options, Tab/Shift-Tab browser boundary with background inert, Escape return. | Equivalent native selected-state changes, localized associated validation/focus and advanced controls. Bot name, Club description/all options reached. S12–S14 retain control speech. |
| D — seeks | Actual same-opponent casual/rated rows, own Cancel/opponent Play; native activation accepted a real seek. Corrected empty-list polling remained quiet. | Same-opponent 10-minute casual/5-minute rated plus own cancellation context; native Cancel/acceptance worked. Empty-list cancellation checked again. |
| E — game | Arrow/Enter e2→e4 without typing coordinates; Black e7→e5 in rotated perspective; piece/empty, selected/legal/last-move semantics; separate illegal e2→e5 refusal. Role, both color-labeled clocks, turn/check, resign/abort confirm/cancel, draw decline/accept focus, promotion Cancel/Queen, actual checkmate/result. | Equivalent native moves/semantics, both clocks/role, illegal refusal/actions. Native Bb5+ and draw outcome; promotion all five controls, Cancel/Queen, resignation 0-1, native Black Qh4# localized checkmate. Rotated squares retain chess meaning. |
| F — history/review | Native finished-game link activated, exact destination reopened stably; result/history read. Actual local-engine review heading/row and native Enter announced e5/best e7e5 (S05). | Native profile/history/link, actual engine review e4/Nf3 with best e2e4/g1f3; e5/best e7e5 and negative-cp retake (S07/S11). Selected review reached the position before that move. |

## RTL and mixed direction

Actual NVDA/Speech Viewer sequences identified `e4`, `Nf3`, `0-1`, `5+0`, usernames and actual ratings in surrounding Arabic context. Time control came from the actual bot dialog (S09). Classical `1500 (RD 290)` came from an actual rated four-ply draw/profile (S10), without a forged rating. Five-minute ratings changed legitimately after a timeout and were not treated as 1500 fixtures.

LTR technical tokens remained visually intact in RTL prose. Negative review centipawns required the correction below. Actual native copy/paste of selected review SAN `2. e5` into the empty local search input retained code points 50,46,32,101,53; the input was cleared. No directional controls were added to copied notation. Handles/identifiers were read in the original UI and excluded from committed excerpts.

Speech Viewer supplies actual utterance text and semantic sequence, not an audio-quality evaluation. No Arabic pronunciation-quality, braille or second screen-reader claim.

## Real Chrome 200% and practical low vision

Native Chrome zoom controls on stable known routes visibly confirmed Chrome's own 200% indication (menu/zoom bubble). CSS scaling and Playwright viewport emulation are not counted as browser zoom. These five surface groups were inspected in English/Arabic and both themes, with real scrolling and keyboard focus:

| Surface | Observation at actual 200% |
| --- | --- |
| Guest/auth | Shell/nav, labels, input/button focus, disabled controls/errors readable/reachable; Arabic refusal alert inspected in both themes. |
| Create/bot | Expanded custom/rating errors, advanced controls/actions reached through native keyboard/scroll; all bot options/actions reached and dismissal returned focus. |
| Seeks/game | Own/opponent context readable; board geometry preserved with bounded scrolling, coordinates/color-labeled clocks readable. Abort/resign confirm/cancel and draw reached. Four promotion pieces plus Cancel reachable after containment correction. |
| Finished/history/review | Result, profile ratings/history/link reached; review headings, move/classification/value rows, selected state/actions readable/reachable. |
| About/policy | Full 40-character build SHA/repository readable with wrapping; EN/AR policy copy/publication state inspected to the end. Policy content was not approved or rewritten. |

Normal/muted text, links, buttons, disabled/selected states, focus, alerts, clocks, coordinates, history/review were inspected in both themes. Primary-button focus was corrected and genuinely retested in both languages/themes at 200%. Custom-time failure was real form validation. HTTP 500 was a real failed proxy request in the supported web build/preview configuration on loopback port 4316 with an unavailable local upstream, source `bbb7a355247b01105c9cb078e7e247ea56db199e`; alert inspected at actual 200% in both languages/themes. It was not injected DOM text or a stale error.

The intrinsic two-dimensional board may require scrolling; this is a bounded practical inspection. Native Ctrl+0 reset Chrome to 100%, visibly confirmed by Chrome's own 100% bubble.

## Defects, corrections and genuine retakes

| Defect / corrected revision | Correction and genuine retake |
| --- | --- |
| Repeated unchanged empty-seek speech — `93415e7709a1b3b2187f3744b85743b5e5a2d19b` | Preserve unchanged empty-state DOM. Actual NVDA polling retake no longer repeated the message. |
| Clock color labels erased — `6658df5bcdf32e0fc8c8b1fbe3b5e23623a1749c` | Update numeric clock text without destroying labels. Native running-clock/role reading repeated, both perspectives and later 200% games. |
| Focus lost on disappearing draw controls — `0fce5deca0ae1e4c87a34be6c9f7fc228ad0644d`, refined `5878fdf53ee9a55b9c1a4ecde63d01fc75a601a0` | Focus stable status after browse-mode draw action. Native decline/accept retakes read resulting turn/check or agreement state. |
| Missing check feedback — `b3a69741f88ade8f46bebc0abd7040d4e68ccf7b` | Authoritative SAN-based localized check status. Native English Bxc6+/Arabic Bb5+ retakes announced check (S03); native Qh4# terminal speech verified. |
| English password refusal in Arabic — `082256ece7d18cb41c20d15552f095e7bfc65a1d` | Localize HTTP401 credential refusal; preserve step-up/email precedence. Real Arabic refusal repeated (S06). |
| Promotion positioned against viewport — `f5bfc33e17bcace501bec94cc1e58c1b12a276a9` | Anchor overlay to board. Real 100%/200% promotion repeated, all five controls, Cancel/Queen, both locales/themes; AR light 200% all-control traversal repeated on final implementation (S14). |
| RTL negative centipawns — `bbb7a355247b01105c9cb078e7e247ea56db199e` | Isolate cp text LTR. Actual AR `-1 cp` visually correct; native Enter announced e5/best e7e5 (S11). |
| Filled-button focus blended in light theme — `e08adbbc90244300eb959c036e856408c843cf66` | Add 3px outline gap, retaining identity tokens. Native Tab from opponent link focused real Play; distinct ring verified EN/AR dark/light at actual 200%. |

Eight defects, nine additive implementation commits. Corrections received focused regressions and native retakes. Automated fixtures provide support only. Final primary-focus regressions: RED two light failures/two dark passes; GREEN 7/7 including existing seek-rating cases, zero skips/retries. Final full web 1484/1484, zero failures/skips; web lint and supported Compose rebuild passed. Broader repository/PR gates are recorded separately when completed.

### Complete local delivery checks

Full repository build/lint, all 19 hermetic workspace suites, script tests 324/324, load-harness tests 86/86 and all eight repository guards passed. Complete backend Chromium acceptance passed 278/278, with zero failures, skips or retries. Its initial run passed 277 and failed the old Arabic-clock assertion, which still expected a single unlabelled combined clock. The test now checks both localized color labels, each numeric clock and its LTR computed direction across the existing release widths; production source did not change for this correction. The full subsequent run passed. Real Nginx web-delivery acceptance passed 12/12, with zero failures/skips/cancellations. Its first invocation stopped before tests because the gateway's separate dependency installation was missing; the supported gateway `npm ci` resolved that setup issue. PR-specific CI and reviewer results remain separate.

## Evidence boundaries and limitations

- Selected excerpts are actual cumulative Speech Viewer selections captured through native text/UIA, whitespace-normalized. When the Viewer was cropped to a title strip, refreshed focused native RichEdit text supplied its transcript; no full Viewer screenshot is claimed.
- Interrupted/expired games and failed capture/setup attempts received no successful-step credit. One five-minute game expired before an attempted Black move; a fresh longer game supplied that actual move. Stable direct-open recovery preserved prior genuine observations.
- Some special positions used ordinary legal CDP preparation. Only subsequent specified native NVDA/keyboard scenarios get manual credit. E2E fixtures/snapshots do not replace this pass.
- Full historical PROJECT_STATE reading was not completed before earlier manual continuation; relevant current entries/checklist were read. This preparatory sequencing deviation is not disguised as a full pre-test read.
- Coverage is limited to the specified journeys/themes and measured workstation. No exhaustive WCAG conformance, production email delivery, assistive-technology certification, public-launch or permanent visual/IA approval is implied.
