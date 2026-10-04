# Arabic / RTL product-shell release evidence

Starting main: `755c6759023f4f222e005c0aa37eb18c49c2fabd` (owner-merged PR #91 / Increment 89). Implementation is isolated on `codex/arabic-product-shell`; the canonical checkout is untouched.

## Historical reconciliation and scope

The original [Fable/Astra audit](FABLE_ASTRA_FULL_AUDIT.md), [visual handoff](ROOKZEN_VISUAL_HANDOFF.md), [recovery index](RECOVERY_INDEX.md), [audit index](README.md), [project state](../PROJECT_STATE.md) and [Arabic owner context](../PRODUCT_BRAND_CONTEXT_AR.md) were reconciled with this main. Historical screenshots are provenance, not current acceptance.

| Historical observation | Verified current-main state and disposition |
| --- | --- |
| Gambit/teal shell, missing Rookzen identity | Rookzen wordmark, Burgundy & Stone dark-first tokens, manifest/icons already present; retained. |
| Arabic missing | Typed English catalogue, locale metadata, storage, declarative bindings and bidi utilities already exist. Production Arabic catalogue and visible selector were missing; implemented here. |
| Severe forced-RTL board/mobile breakage | Main already has logical shell spacing, bounded responsive grid and explicit LTR board direction. These were exercised with real Arabic at five widths; no blanket redesign was needed. |
| Public documents absent | About, Privacy, Terms and Fair-play routes already exist. Existing authorized placeholders are translated; final policy text remains owner/legal work. |
| Mobile navigation density | Existing wrapping navigation retained and tested for containment. A new navigation IA, logo or typography identity is outside this PR. |

Both production catalogues have **929/929 typed client-owned keys** with exact placeholder parity. Arabic uses Modern Standard Arabic and standard chess terms; Rookzen, Chess960, ECO and technical data remain invariant. No English spreads, weakened catalogue types or injected directional Unicode controls. The invariant-template allowlist is explicit in `arabic-release.test.ts`.

Coverage includes existing navigation, auth/recovery/verification, lobby/create-game, game/actions/review/export/AI labels, profile/security/ratings, competition/search/community, Learn/courses/endgames/studies, public documents, not-found and capability/empty/error states. Server-authored course/study/community content and provider-generated prose retain their original bytes and auto direction; the client catalogue does not translate external content. Capability-disabled features stay disabled.

The 13 built-in achievement names/descriptions and three tiers are localized with English source parity against the domain catalogue; unknown external achievement entries retain their API copy. Tournament matchup/standing labels, study visibility/roles and known AI difficulty/objective/mate-relation enums are localized too. Future server-owned difficulty labels retain their bytes.

## Direction, persistence, mixed content and accessibility

The labelled native header selector works anonymously. Explicit EN/AR choices persist under `rookzen_locale_v1`; malformed/unsupported/blocked storage defaults safely to English. A same-origin blocking `/locale-init.js` applies validated document `lang`/`dir` before stylesheet/body parsing; bootstrap then localizes text. No account or browser-language inference is required. SPA-owned listeners are disposed.

All boards receive the application locale, including lesson, endgame and study boards. Accessible square/piece/highlight/promotion names update in place. Board geometry remains LTR and player orientation remains independent. The skip link now focuses the existing roving board tab stop directly; it previously only established a native fragment starting point. Keyboard arrows retain physical square geometry. Locale changes preserve focused square and open promotion-button nodes. Existing live regions, dialog behavior, reduced-motion CSS and landmarks remain; navigation gains a translated accessible name and the new selector has a 44px minimum height.

Existing isolated SAN/UCI/FEN/PGN, coordinates, ratings, clocks, time controls, IDs and source disclosure are retained. Shared text-node/`bdi` rendering additionally isolates auth/conversation handles, team names, result tokens, review moves, learning FEN, session IP/date, tournament clocks/results, achievement ratios and AI moves/evaluations/provider/model disclosures. Technical inputs use LTR; unknown user text uses auto direction. Translated string-built board attributes are escaped. Hostile text remains text, never executable HTML. Copy/paste contains original token bytes.

## Browser and visual evidence

Chromium exercises Arabic routes at **1440, 1024, 768, 390 and 320px**; a real harness game has two connected authenticated players. The suite checks visible translated content, unchanged capability gates, document attributes, board bounds, horizontal containment, native selector focus, SPA/reload persistence and normalized geometry of all 64 squares before/after locale change. Create-game evidence waits for the actual open `#create-game-form`; profile evidence waits for the loaded handle and ratings region. Mixed-content checks assert DOM isolation and original text for SAN/UCI/FEN/PGN, handles, ratings, result, evaluation, URL, UUID, SHA, time control and clocks, plus actual game-status and session renderers.

| Surface | English desktop / mobile | Arabic desktop / mobile |
| --- | --- | --- |
| Open create-game/lobby | [1440](arabic-rtl-evidence/lobby-en-1440.png) / [390](arabic-rtl-evidence/lobby-en-390.png) | [1440](arabic-rtl-evidence/lobby-ar-1440.png) / [390](arabic-rtl-evidence/lobby-ar-390.png) |
| Connected live game | [1440](arabic-rtl-evidence/live-game-en-1440.png) / [390](arabic-rtl-evidence/live-game-en-390.png) | [1440](arabic-rtl-evidence/live-game-ar-1440.png) / [390](arabic-rtl-evidence/live-game-ar-390.png) |
| Loaded self-profile | [1440](arabic-rtl-evidence/profile-en-1440.png) / [390](arabic-rtl-evidence/profile-en-390.png) | [1440](arabic-rtl-evidence/profile-ar-1440.png) / [390](arabic-rtl-evidence/profile-ar-390.png) |

Capture: `GAMBIT_E2E_BACKEND=1 ROOKZEN_CAPTURE_EVIDENCE=1 npm run e2e --workspace @chess-platform/web -- arabic-live-game --retries=0` after building. Local execution uses a temporary config and direct Node preview supervisor with owned ports 4213/4214/4215 because unrelated existing preview/backend processes occupy the defaults; those processes were left untouched. The temporary config is not shipped.

Screenshots support visual containment only. Automated DOM semantics, focus and keyboard checks are accessibility evidence; no manual screen-reader, physical-device or non-Chromium certification is claimed.

## Local validation and final PR boundary

Post-commit strict Codex review was authorized after fresh Gemini and Claude attempts both returned genuine 429 individual-quota exhaustion without reviewing files. It reproduced an unknown endgame reason `toString` rendering inherited function text in the real DOM. The own-property lookup correction passed the unchanged focused browser assertion (1/1). Arabic review also corrected the imperative for winning from a position and used the feminine study-private label. Final-head review and complete re-execution must cover the corrective commit too; the earlier attempts/results are historical.

Local gate counts and falsification evidence are recorded after completion below. The exact committed-head independent reviewer, CI, Qodo, Greptile, unresolved threads, Git equality and open/unmerged state are verified separately on the PR. This source document does not claim owner merge approval or whole-product launch readiness.

| Positive local gate | Result |
| --- | --- |
| Complete repository build / lint | Passed |
| Eight `check:*` guards | All passed |
| Script tests | 315/315 |
| Hermetic tests across all 19 workspaces | 4,007/4,007; web subset 1,476/1,476 |
| Complete Chromium browser suite, backend enabled | 267/267; retries 0; local workers 1 |
| Positive failures / skips / cancellations | 0 / 0 / 0 |

Twelve deliberate regressions compiled/executed and failed their intended assertions: missing Arabic registration, missing choice persistence, untranslated navigation, wrong pre-paint direction, unisolated result classification, missing promotion locale listener, missing skip-focus handler, mirrored board CSS, untranslated built-in achievement name, untranslated tournament matchup, unisolated AI evaluation and untranslated AI difficulty. **12 attempts / 12 valid / 12 intended kills / 0 survivors / 0 invalid**; every mutated source was restored byte-for-byte. The canonical geometry assertions were strengthened so EN/AR equality cannot pass with both boards mirrored.

Earlier unsuccessful runs are not credited: corrected outdated English-only/fake-DOM/discovery expectations, an incomplete live-focus fixture and fragment-only skip test; one full run also obtained an empty preview HTTP404 while local builds overlapped. One later full run passed140/267 before the owned preview became unavailable (connection reset/refused); two other full runs passed266/267 with Chromium closed before one test context was created. The unchanged focused search reproduction passed1/1. Causes of those process terminations remain unproven. The final positive267/267 browser run uses one local worker, owns its build/preview exclusively and does not relax assertions, add retries, or change production limits. The repository CI worker ceiling remains unchanged. A mistaken test-support export invocation was a compile failure, not RED evidence; later real-DOM AI isolation and endgame terminal-label reproductions failed their behavioral assertions before correction. An earlier API test-file termination had no assertion/cause record; the unchanged focused file passed5/5 and the later full API suite passed1,248/1,248. Exact committed-head re-execution and attribution belong to the PR attestation.
