# Rookzen Visual Excellence — Authoritative Handoff

Status: **audit and direction phase complete; implementation intentionally not started**  
Canonical repository: `C:\Users\hp\shatarang`  
Canonical commit reviewed: `d0a05bbc900e8d18f80c30f6e802222f440ddbf4`  
Prepared: 2026-09-06 (Africa/Cairo)

## 1. Mission and non-negotiables

The objective is to move Rookzen from a capable but generic chess client to a distinctive, calm, player-first global chess product. The work must preserve chess readability and accessibility while establishing an authored visual identity.

Non-negotiables from the owner-approved brief:

- Product name: **Rookzen** (provisional); the legacy **Gambit** identity is not authoritative.
- Product loop: **play → review → learn → improve → community**.
- AI is a feature, not the whole identity.
- Personality: calm, welcoming, clear, modern, dark-first, progressively disclosed.
- Approved core palette: Rook `#242224`, Stone `#E9E4DE`, Burgundy `#934A54`, Dusty Rose `#C6A0A2`, Silver `#A6A6A7`.
- Reviewable derivatives already documented: Deep Burgundy `#83414B`, Light Stone `#F5F1ED`, Mid Stone `#91888B`.
- Avoid teal/green/purple-led branding, gradients, glows, generic SaaS card walls, heavy pill styling, emoji-first iconography, and decorative Arabic.
- Source Sans 3 and Noto Sans Arabic are candidates, not final owner-approved fonts.
- The simple rook mark is provisional, not a final logo.
- Accessibility, RTL, mobile, keyboard use, and reduced motion are product requirements, not cleanup tasks.
- No production implementation, permanent system choice, merge, push, branch mutation, worktree deletion, or overwrite of foreign work is authorized in this phase.

## 2. Repository and git state

Read-only preflight completed before audit work:

- Repository: `C:\Users\hp\shatarang`
- Current branch: `main`
- `HEAD`: `d0a05bbc900e8d18f80c30f6e802222f440ddbf4`
- `origin/main`: `d0a05bbc900e8d18f80c30f6e802222f440ddbf4`
- Canonical worktree: clean
- Canonical remote used: `https://github.com/edwardnewgate710/rocky.git`
- A stale `old-origin` remote exists and was not used.
- The allowed read-only refresh `git fetch --prune origin` was completed.

Dirty foreign worktrees detected and preserved exactly as found:

- `C:\Users\hp\rocky-claude-node-test-signature-b` — three modified documentation/test files.
- `C:\Users\hp\shatarang-gemini-board-a11y` — modified board view and test.
- `C:\Users\hp\shatarang-gemini-long-game-review` — five modified API/web files.
- `C:\Users\hp\shatarang-gemini-refresh-safety` — four modified web files.
- `C:\Users\hp\shatarang-gemini-seek-lifecycle` — two modified API files.

No foreign worktree was cleaned, reset, deleted, amended, committed, rebased, or reused for preview work.

## 3. Claude artifact recovery

The interrupted Claude session was found at:

`C:\Users\hp\AppData\Local\Temp\claude\C--Users-hp-shatarang\fd592d83-6a74-4184-8ac5-b3d5aadd6a1d\scratchpad\design`

It was copied without modification to:

`C:\Users\hp\rookzen-visual-recovery\recovered-claude\design`

Recovery verification:

- Source files: **265**
- Recovered files: **265**
- Relative-path + SHA-256 manifest comparison: **exact match**
- Extension inventory: 225 PNG, 16 JSON, 9 ERR, 5 HTML, 5 MJS, 4 Markdown, 1 JS.

High-value recovered artifacts include:

- `evidence-brief.md` — Claude’s consolidated evidence brief.
- `visual-shots.mjs` and `dark-shots.mjs` — capture scripts.
- `shots/` — the full rendered route/state evidence set.
- `shots/log.json` — capture log.
- `agent-b/` — CSS detector inputs/outputs, DOM snapshots, measurements, screenshots, and error logs.
- `agent-c/` — focus/motion/state probes, screenshots, state, and partial results.
- `codex-lane1-brief.md`, `codex-lane2-brief.md`, `codex-lane3-brief.md` — intended audit lane prompts.
- `previews/` — an incomplete Claude-era preview scaffold.

What was **not recovered**:

- No complete final assessment from Claude’s three visual subagents.
- No owner approval of a permanent design direction.
- No complete successful Agent C result; `agent-c/results.json` was overwritten by a later disabled-button timeout.
- No valid contrast results from `agent-b/measure.json`; its contrast colors are `#NaN…` and ratios are null.
- No successful URL detector run; paired logs show a missing Puppeteer dependency.

The exhaustive per-file record, including original path, recovery path, type, timestamp, SHA-256, description, and confidence, is in `C:\Users\hp\rookzen-visual-recovery\RECOVERY_INDEX.md`.

## 4. Screenshot and state matrix

The recovered screenshot matrix covers the canonical UI at the reviewed commit rather than a proposed redesign. The 225 PNGs include repeated and diagnostic captures; the recovery index enumerates every file.

Representative route/state coverage:

| Area | Desktop/tablet | Mobile | Theme/state evidence |
|---|---|---|---|
| Anonymous landing | 1440, 1024, 768 | 390, 320 | dark/light toggle captures, auth-first landing, disabled play entry |
| Signed-in lobby | 1440, 1024, 768 | 390, 320 | empty lobby, open-seek rows, create-game entry |
| Create game | 1440, 1024, 768 | 390, 320 | time presets, mode/color/options, long mobile flow |
| Live game | 1440, 1024, 768 | 390, 320 | active board, player turn, clocks/actions, long sidebar |
| Finished game | desktop variants | mobile variants | completed state, review entry |
| Review | 1440, 1024, 768 | 390, 320 | verdict colors/glyphs, accuracy, move annotations |
| Profile | desktop/tablet | mobile | social/security sections and empty states |
| Learn/courses/endgames/studies | desktop/tablet | mobile | available and unavailable-content states |
| Search/messages/teams/tournaments/leaderboard | desktop/tablet | mobile where captured | capability-gated and empty states |
| Board mechanics | diagnostic sizes | diagnostic mobile | selection, legal targets, capture, promotion, orientation, focus |
| Accessibility probes | desktop | 390/320 | keyboard focus, coarse targets, reduced motion, forced RTL |
| RTL | 1440 forced RTL | 390 forced RTL | documented off-canvas/blank failure on current main |

Naming caveat: some recovered filenames with `light` in the name show a toggled dark surface. Interpret the rendered pixels and capture log, not the filename alone.

New direction-preview evidence is separate from the recovered Claude set:

- `C:\Users\hp\Documents\Codex\2026-09-06\new-chat\outputs\rookzen-previews\index.html`
- `direction-a-overview.png`
- `direction-b-overview.png`
- `direction-c-overview.png`
- `direction-a-arabic-overview.png`

Each direction contains desktop landing, lobby, active game, and post-game review; four differentiated mobile compositions; and an Arabic/RTL proof surface. These are standalone static concept studies, not production code and not a permanent system decision.

## 5. Files and components inspected

Primary product/design sources:

- `docs/PRODUCT_BRAND_CONTEXT_AR.md` — authoritative brand and product direction.
- `packages/web/PRODUCT.md` — stale legacy product framing.
- `packages/web/DESIGN.md` — stale Gambit/teal design contract.
- `packages/web/index.html` — route surfaces, navigation, game tools, profile, dialogs, and live regions.
- `packages/web/src/style.css` — full visual system, responsive behavior, states, motion, focus, board, review, and route styling.
- `packages/web/src/ui/board-view.ts` — board rendering, keyboard focus, coordinates, orientation, pieces, and move-state classes.
- Relevant tests and PR diffs touching board semantics, shell, seek lifecycle, and long-game review.

Principal components/surfaces audited:

- Global topbar/navigation, search, status, account/theme controls.
- Anonymous landing and authentication.
- Lobby, seeks, ratings, create-game controls.
- Live board, player context, clocks, move state, game actions, connection metadata.
- Engine/tactic/assessment/opening/coach tools.
- Review and notation.
- Learn, courses, endgames, studies.
- Profile, social, passkeys, sessions, games.
- Messages, teams, tournaments, leaderboard, search.
- Empty/error/unavailable states and dialogs.

## 6. Independent visual assessment

### Executive assessment

Current main is a disciplined, accessibility-aware engineering interface, but not yet a distinctive Rookzen product. It reads like a capable internal/open-source chess client: sparse, generic, native-control-heavy, and visibly tied to the old Gambit/teal/wood identity.

Scores from the independent assessment:

- Overall visual excellence: **5.1/10**
- Design-system discipline: **7.2/10**
- Rookzen brand fidelity: **1.5/10**
- Chess-first focus: **6.5/10 desktop game / 3.5/10 mobile shell / 3/10 non-game routes**

This is not a margin-polish gap. It requires brand migration, navigation/IA restructuring, a better player/game hierarchy, and a deliberate grammar for non-board pages.

### Hierarchy

- The live board is correctly dominant on desktop; the 792px recovered board is the strongest surface.
- Game-information hierarchy is weak. Player identities and ratings are not composed around the board; operational metadata appears before the opponents.
- Two clocks exist in the DOM but read visually as one combined line rather than two independent time-critical objects.
- Engine, tactic, assess, opening, and coach appear as five equal modules, creating a tool stack instead of a coherent review journey.
- The anonymous landing prioritizes authentication over the product promise and immediate play.
- Signed-in lobby is visually skeletal without a board or strong default action.
- Profile mixes player identity, social, security, and session management in one long undifferentiated page.

### Information architecture

- The topbar exposes nine destinations plus search/account/theme controls with near-equal weight.
- Capability hiding removes unavailable items but does not provide meaningful grouping.
- At 390px the global header reaches 207px, turning the first viewport into a wrapped site map.
- Recommended information groups: **Play, Learn, Compete, Community**, with search/messages/profile as utilities.
- During a game, global chrome should recede in favor of board, players, clocks, notation, and game actions.
- Review should transform the same board workspace rather than append a long series of peer tools.

### Typography

- Current `system-ui` typography is functional but has no recognizable Rookzen voice.
- The ramp is controlled, but 12px and 14px secondary text dominates, producing a grey texture.
- The legacy “No Hero” rule is sensible during play but suppresses useful hierarchy on landing, lobby, profile, learning, and empty pages.
- Source Sans 3 / Noto Sans Arabic remain candidates only. No production font loading or Arabic UI currently exists.

### Color and surfaces

- Dark main is calm and avoids gratuitous elevation, but the teal accent and classic wood board contradict approved brand direction.
- Light mode is low-definition grey-on-grey; panels and controls do not separate roles clearly.
- Many content types share the same translucent rectangle treatment.
- Review uses seven saturated verdict hues and glyph categories, departing from the restrained system and relying too heavily on color.
- Burgundy must not be used as a thin focus ring or small text on Rook; `#934A54` on `#242224` is only **2.52:1**.
- Dusty Rose on Rook is **6.73:1** and is a safer dark-surface focus candidate.
- Stone on Rook is **12.50:1**; Silver on Rook **6.50:1**; Stone on Burgundy **4.96:1**; Deep Burgundy on Light Stone **6.62:1**.

### Chess-first focus and cognitive load

- Board rendering is the most mature subsystem: Cburnett SVGs, responsive sizing, coordinates, promotion artwork, roving focus, and shape-redundant legal/capture states.
- The game shell lacks player strips, independent clocks, live notation, and a visibly encoded check state.
- Desktop game load is moderate-high because metadata and analysis compete with the board.
- Mobile game load is high because global navigation precedes the board and essential controls fall below a very long page.
- New/casual players face low local density but high ambiguity: why join and how to play are not communicated clearly.

### Persona red flags

- Competitive player: combined clocks, absent player context, no live notation, analytics competing with active play.
- Improvement-oriented player: analysis feels like five tools rather than one guided learning flow.
- New/casual player: account administration precedes the product promise.
- Mobile player: 207px header and long stacked sidebar displace essential play controls.
- Arabic/RTL player: no real Arabic UI/font support and a documented forced-RTL layout failure.
- Low-vision/color-vision player: tiny coordinates and multicolor review verdicts require stronger non-color redundancy.
- Security-conscious player: passkeys/sessions are mixed into the social/profile stream.

## 7. CSS and design-system findings

Quantitative inventory of `packages/web/src/style.css`:

- 1,955 lines.
- Approximately 409 selector occurrences and 348 unique selectors.
- Seven selectors contain IDs; one `!important` is the global `[hidden]` rule.
- Specificity is currently healthy-to-moderate; the risk is continued exception growth inside one global monolith.
- 208 spacing declarations with 42 complete values; `8px`, `16px`, `12px`, `4px`, and `6px` dominate.
- 60 font-size declarations and seven distinct sizes; 14px and 12px dominate.
- 25 radius declarations: twenty use 6px, four are circles, one auth card uses 8px.
- Six shadow declarations; elevation is restrained.
- Roughly 45 unique custom-property names and 74 definitions/overrides.
- Twelve media blocks but only four unique conditions: `min-width:720px`, `max-width:420px`, `pointer:coarse`, and `prefers-reduced-motion:reduce`.
- No dedicated mobile navigation breakpoint.
- Motion is mostly 120–160ms generic `ease`; one 1.6s seek pulse; no piece-move transition.
- The z-index system is small and coherent.

Strengths to preserve:

- Flat-at-rest restraint and minimal elevation.
- Consistent control, row, focus, numeric, and spacing conventions.
- Tokenized colors and limited specificity.
- Strong board engineering and accessibility intent.
- Capability-gated navigation and tools.

System liabilities:

- `PRODUCT.md` and `DESIGN.md` encode stale Gambit/teal truth.
- Literal spacing, radius, and font values are repeated rather than implemented as reusable tokens.
- Button classes `.primary` and `.destructive` exist in markup without matching visual CSS on main.
- Select controls are substantially native and incompletely normalized.
- Page, group, row, control, selected, and urgent surfaces lack distinct semantic roles.
- Board cue and review colors are not integrated into the approved brand system.

## 8. Automated detector reconciliation

Recovered detector evidence must be interpreted narrowly:

- The source detector produced three advisories: one 8px auth radius, one fluid `clamp(0.6rem, 1.8vw, 0.78rem)` size, and one 13px size.
- An independent exact rerun against the recovered DOM returned no new findings.
- The URL detector outputs cannot be treated as successful; paired error logs report a missing Puppeteer dependency.
- `agent-b/measure.json` contains reliable geometry but corrupt contrast fields (`#NaN…`, null ratios).
- Detector silence does not contradict the visual critique. The important failures are hierarchy, brand fidelity, mobile IA, RTL behavior, semantic grouping, and chess context—not merely lintable CSS outliers.

## 9. Accessibility, RTL, mobile, and motion findings

### Accessibility

- Keyboard/focus intent is strong: skip link, visible focus, roving board focus, live regions, dialogs, and reduced-motion overrides exist.
- PR #50 improves board semantics but currently has one failing end-to-end assertion caused by old label expectations.
- Recovered captures contain roughly **22–25 controls below 44px** at relevant mobile/coarse sizes.
- Legal/capture states use useful shape redundancy.
- No visibly encoded check class was found in the canonical renderer path.
- Illegal-move feedback is too quiet or absent in recovered interaction evidence.

### RTL and Arabic

- Forced RTL on current main is a **P0 layout failure**: the desktop two-column game composition pushes the board off-canvas; the 390px capture is nearly blank apart from the skip link.
- Current UI is English-only and has no Arabic font integration.
- Bidirectional isolation is incomplete outside limited time-control strings; SAN/player names/mixed text need explicit treatment.
- Board orientation must remain a player/game control independent of interface direction.
- The direction previews demonstrate a feasible mirrored shell with the board itself left geometrically stable.

### Mobile and responsive behavior

- Header heights measured at approximately 60px (1440), 102px (1024), 138px (768), and 207px (390).
- At the 720px desktop-grid breakpoint, the board can shrink to roughly 336px at a 768px viewport while the sidebar remains 260px.
- Recovered mobile pages reach roughly 2,100px at 390 and 1,985px at 320; clocks/actions/analysis can sit far below the board.
- At 320, squares are approximately 36px.
- A verified 200% zoom pass is **NOT RECOVERED**.
- Wrapping the desktop navigation is not a viable mobile navigation strategy.

### Motion

- Current piece movement jumps instantly; short spatial movement could improve comprehension.
- Most state/dialog changes are instant; this contributes to an engineering-demo feel.
- Reduced-motion behavior is a current strength and must remain absolute.
- Future motion should be functional, interruptible, and quiet: 120ms fast states, about 160ms normal transitions, and a proposed 180–220ms piece movement using authored easing. No decorative ambient motion is recommended.

## 10. Active PR status and usefulness

Open PRs reviewed against the canonical base:

| PR | Head | State | Visual relevance | Reuse recommendation |
|---|---|---|---|---|
| #46 `gemini/rookzen-play-first-shell` | `4fb3b415` | mergeable; checks green | Rookzen name, Burgundy & Stone, dark-first bootstrap, nav grouping, lobby-before-auth, 404, primary style | **Selective reuse only.** Strongest visual base, but incomplete and not the permanent system. |
| #47 `gemini/seek-lifecycle` | `23f0712` | mergeable; checks green | Adds handle/rating/color context to seek/lobby rows | Reuse product model and row information after visual-system alignment. |
| #48 `gemini/concurrent-refresh-safety` | `8c25ba3` | mergeable; checks green | Auth/session behavior; little visual impact | Preserve independently; not a design-direction input. |
| #49 trusted edge | current open head | mergeable; checks green | No meaningful frontend visual work | No design reuse needed. |
| #50 `gemini/board-accessibility-semantics` | `137d06a` | mergeable; one M6 failure | Better semantic board state/labels | Reuse after updating stale E2E label assertions and re-verifying keyboard/AT behavior. |
| #51 database-only | current open head | mergeable; checks green | No frontend visual work | No design reuse needed. |
| #52 `gemini/long-game-review-fallback` | `4810a05` | mergeable; checks green | Partial review model/note support | Reuse model behavior; redesign the review surface around a coherent post-game journey. |

PR #46 deserves special care:

- Good: visible Rookzen migration, approved core palette, dark-first intent, improved grouping, play-first lobby, first filled primary variant.
- Incomplete: no core live-game hierarchy redesign, mobile navigation remains dense, emoji/icon debt remains, Source Sans is declared but not loaded, legacy design docs remain stale.
- Risk: functional green/yellow/blue board cues and rainbow review colors remain outside the new palette.
- Risk: OS-light CSS followed by bootstrap dark preference may flash.
- Risk: actual primary entry actions are not consistently assigned the new primary class.
- Risk: dusty-rose/light-stone pairings in some roles do not meet contrast when used alone.

PR interactions:

- #47 and #52 both touch four contract/model files despite #52’s stated “zero overlap.” A current merge-tree check produced no conflict markers, but behavioral reconciliation is still required.
- #46 and #50 are complementary in intent—visual shell vs semantics—but should be integrated under the approved system rather than merged as a de facto design decision.

## 11. Recovered subagent status

Claude-era final subagent assessments: **NOT RECOVERED**.

Recovered lane material:

- Lane briefs for three intended audit agents.
- Agent B detector scripts, DOMs, screenshots, outputs, and errors.
- Agent C focus/motion scripts, screenshots, state, and partial/failed results.
- Claude evidence brief and screenshot corpus.

New independent audit lanes completed during takeover:

- Design/CSS forensics: independent visual critique, heuristic scoring, quantitative CSS inventory, token proposal, evidence reconciliation.
- Accessibility/RTL/mobile/motion: priority failures, recovered evidence validation, PR #50 implications, responsive and bidi recommendations.
- Active-PR/detector reconciliation: current PR status, overlap, checks, usefulness, #46 palette risks, detector limitations.

These lanes were deliberately separated so conclusions were not copied from Claude’s brief before independent inspection.

## 12. Three proposed design directions

All three directions are intentionally dark-first and use only the approved palette plus documented reviewable derivatives. None is a permanent selection.

### A — The Quiet Match Room

Idea: a calm, tactile chess room where silence and generous spacing create confidence.

- Typography: humanist sans candidate pairing; mixed case, moderate weight.
- Shape: soft but restrained 8–12px surfaces.
- Surfaces: layered ink/stone planes with subtle hairlines; no ambient card wall.
- Motion: physical and restrained; short piece/state transitions.
- Hierarchy: board first; secondary tools wait for intent.
- Best for: welcoming global identity, casual-to-serious breadth, strong Arabic adaptation.
- Risk: without tighter game density, it can feel too leisurely for competitive players.

### B — The Competitive Table

Idea: a faster, denser match-day interface where clocks, pairing, and game state are broadcast clearly.

- Typography: condensed sans candidate for headlines/clocks; compact uppercase microcopy.
- Shape: square 2–4px language.
- Surfaces: compact geometry, stronger alignment, fewer decorative planes.
- Motion: surgical—mostly state changes and fast piece movement.
- Hierarchy: clocks/player strips/game actions immediately legible.
- Best for: rated play, tournament trust, experienced players, compact mobile game surfaces.
- Risk: could become austere or intimidating if used unchanged on onboarding/community pages.

### C — The Annotated Game

Idea: a contemporary chess-publication experience where commentary, notation, and board share one reading plane.

- Typography: editorial serif candidate for page/story headings plus UI sans for controls and notation.
- Shape: rule-led, near-square surfaces.
- Surfaces: hairlines and vertical reading rhythm rather than cards.
- Motion: measured page turns and progressive annotation reveals.
- Hierarchy: strongest post-game review, learning, study, and explanation experience.
- Best for: improvement loop, review, studies, courses, editorial distinction.
- Risk: serif/editorial treatment may slow live competitive surfaces and requires careful Arabic typographic equivalence.

## 13. Recommended direction

Recommend a deliberate hybrid, with **A as the global foundation**:

- Use **A** for brand voice, global shell, surface warmth, onboarding, community, typography tone, Arabic adaptation, and overall spacing discipline.
- Use **B** for the active-game workspace: player strips, independent clocks, compact notation, game actions, responsive shell, and mobile bottom navigation.
- Use **C** for review/learn/study: editorial explanation, annotated moves, accuracy narrative, and post-game progression.

Why this is strongest:

- A best matches the approved calm/welcoming/global personality.
- B solves the most consequential current usability failures without making the whole product feel like tournament software.
- C gives the play→review→learn loop a distinctive identity rather than another analytics dashboard.
- One shared Burgundy & Stone token system can support all three modes while varying density, typography role, and information hierarchy.
- The hybrid maps visual tone to user intent: welcome calmly, play decisively, learn reflectively.

This recommendation remains provisional pending owner review of the previews and the explicit approval gate below.

## 14. Proposed token and component architecture

No implementation has occurred. The following is a reviewable architecture proposal.

### Primitive and semantic color roles

- Primitive owner-approved colors remain immutable facts.
- Add reviewed neutral steps and interaction overlays only after contrast/state testing.
- Semantic roles: `surface.canvas`, `surface.raised`, `surface.sunken`, `surface.control`, `surface.control-selected`, `text.primary`, `text.secondary`, `text.disabled`, `border.subtle`, `border.control`, `border.strong`.
- Primary action: Burgundy background with Stone text.
- Dark-surface focus: Dusty Rose, not Burgundy.
- Board roles: light, dark, selected, last move, premove, legal, capture, check; every state must work on both squares and use shape as well as color.
- Status danger/warning/success/info should not be aliases of brand colors.

### Spacing and typography

- Layout spacing proposal: 0, 4, 8, 12, 16, 24, 32, 48, 64px.
- Treat 1/2/3/6px as border/focus/optical dimensions rather than layout spacing.
- Proposed type roles: 12/16 label, 14/20 body small, 16/24 body, 18/24 small title, 22/28 title, 28/34 non-play display, 24px and 32px tabular clocks.
- Candidate Latin/Arabic pair requires real mixed-direction testing before approval.

### Components

- Buttons: primary, secondary, ghost, danger.
- Rows: default and interactive.
- Fields: default, invalid, disabled.
- Navigation: grouped desktop navigation and true mobile composition.
- Game: player strip, independent clock states, move list, game status, action group, connection disclosure.
- Analysis: tabs/steps around one board, not peer panels.
- Feedback: page empty, section empty, page error, inline status.
- Profile: player identity, social, and account/security groups.

## 15. UNKNOWN / NOT RECOVERED / still unverified

- Final Latin and Arabic font families.
- Final logo/rook mark and production wordmark.
- Final semantic status palette.
- Final board square and cue palette.
- Final review verdict system and non-color redundancy.
- Final navigation labels/grouping and mobile-menu pattern.
- Production-rendered Arabic content and mixed Arabic/SAN/bidi behavior.
- 200% browser zoom verification.
- Screen-reader verification across the complete board/game flow.
- Full touch-device verification and orientation changes.
- Real active-PR screenshots on all target viewports.
- Long-match end-to-end replay at the reviewed base after future integration.
- Review-color comprehension testing with color-vision-diverse users.
- Whether owner prefers the hybrid recommendation or a pure direction.

## 16. Work still required after owner approval

The next agent should not begin this work until the owner approves a direction or hybrid.

1. Record the approved direction, type choices, density rules, and component mode mapping.
2. Reconcile `PRODUCT.md` and `DESIGN.md` with the authoritative brand context.
3. Convert the proposal into a small implementation plan, ordered by dependencies and reviewable slices.
4. Decide selective reuse from PRs #46, #47, #50, and #52; do not merge a PR merely because it approximates the direction.
5. Establish semantic tokens and contrast-tested board/status roles.
6. Build the game-focused shell first: player strips, clocks, notation, actions, and connection disclosure.
7. Replace wrapped mobile navigation with a dedicated accessible composition.
8. Implement Arabic/RTL architecture with bidi isolation and orientation independence.
9. Restructure landing/lobby and post-game review around the product loop.
10. Verify keyboard, screen reader, 200% zoom, coarse targets, RTL, reduced motion, and representative desktop/mobile sizes.
11. Run visual regression against approved concept references.
12. Re-audit active PRs immediately before integration because status and diffs may change.

## 17. Verification performed in this takeover

- Confirmed canonical clean state and exact base SHA.
- Refreshed remote refs with the explicitly allowed `git fetch --prune origin`.
- Preserved all dirty foreign worktrees.
- Verified 265/265 recovered files by relative-path + SHA-256 manifest equality.
- Reconciled recovered claims against source, screenshots, live PR metadata/checks, and independent calculations.
- Calculated key palette contrast ratios independently rather than using the corrupt recovered contrast JSON.
- Rendered and visually inspected the three standalone directions across desktop, four mobile compositions, and Arabic RTL proof.
- Checked preview hierarchy, clipping, board scaling, mobile composition, and real layout mirroring.
- Left the canonical repository unchanged.

## 18. Skills and constraints governing future work

Skills used during this phase and their concrete contribution:

- `superpowers:using-superpowers` — required skill-routing discipline.
- `superpowers:brainstorming` — treated this as architectural direction work and enforced the design-before-production gate.
- `superpowers:dispatching-parallel-agents` — separated independent audit lanes.
- `superpowers:verification-before-completion` — required evidence-backed completion claims.
- `design` — framed product-level visual coherence and token direction.
- `a11y-and-rtl` — bidi, focus, Arabic typography, keyboard, and accessibility criteria.
- `responsive-adaptive` — mobile composition, content prioritization, and breakpoint critique.
- `awwwards-motion-design` plus Arabic-mode guidance — motion-performance and reduced-motion criteria; decorative motion mandates were subordinated to the owner’s restrained product brief.
- `visual-verification` — rendered and inspected concrete direction boards.
- `impeccable` and its critique/audit/new-work references — structured forensic critique, detector reconciliation, and concept quality bar.
- `frontend-design` — ensured the previews were authored, distinct, responsive, and free of generic dashboard styling.

Operational note: the repository’s `AGENTS.md` asks for lean-ctx wrappers. The referenced full rules file was absent. The lean-ctx executable blocked PowerShell under its built-in allowlist; no configuration was changed. Read-only and documentation commands therefore used the direct shell only when necessary.

## 19. Explicit owner approval gate

**Stop here. Do not implement, merge, push, rewrite production design-system files, or treat any direction as permanent.**

Owner decision requested:

- Approve the recommended **A foundation + B play workspace + C review/learn** hybrid; or
- choose pure A, B, or C; or
- request a revised combination with named elements to retain/remove.

After approval, the next step is a bounded implementation plan—not production changes in the same approval turn unless the owner explicitly authorizes them.
