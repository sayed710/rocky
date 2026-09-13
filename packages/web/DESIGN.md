---
name: Rookzen
description: A calm, player-first chess platform for play, learning, analysis, competition, and community.
colors:
  dark-neutral: "#242224"
  light-stone: "#f5f1ed"
  stone-text: "#e9e4de"
  muted-silver: "#a6a6a7"
  light-muted: "#686466"
  board-light: "#e9e4de"
  board-dark: "#91888b"
  burgundy-accent: "#934a54"
  burgundy-deep: "#83414b"
  dusty-rose-selection: "#c6a0a2"
  selection-edge: "#242224"
  ember: "#e5484d"
  ember-deep: "#b42318"
  hint-green: "#14551e80"
  last-move: "#9bc70068"
  premove-blue: "#141ec866"
  panel-tint: "#e9e4de0d"
  panel-tint-strong: "#e9e4de17"
  light-panel-tint: "#2422240d"
  light-panel-tint-strong: "#24222414"
  scrim: "#000000b8"
  promo-tile: "#fafafa"
  promo-tile-ink: "#111111"
typography:
  title:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.4
  small:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1
  numeric:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tabular-nums"
rounded:
  base: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.stone-text}"
    typography: "{typography.body}"
    rounded: "{rounded.base}"
    padding: "6px 14px"
  button-hover:
    backgroundColor: "{colors.panel-tint}"
    textColor: "{colors.stone-text}"
    rounded: "{rounded.base}"
  panel-row:
    backgroundColor: "{colors.panel-tint}"
    typography: "{typography.small}"
    rounded: "{rounded.base}"
    padding: "8px 12px"
  clock:
    backgroundColor: "{colors.panel-tint-strong}"
    typography: "{typography.numeric}"
    rounded: "{rounded.base}"
    padding: "8px 12px"
  board-square-light:
    backgroundColor: "{colors.board-light}"
  board-square-dark:
    backgroundColor: "{colors.board-dark}"
---

# Design System: Rookzen

## 1. Overview

**Creative North Star: "The Calm Modern Study"**

Rookzen's UI is a calm, modern place to play and improve: dark neutral and stone surfaces keep the position readable, burgundy gives primary actions a deliberate identity, and dusty rose carries selection and focus. Chrome remains restrained: no shadows at rest, no card stacks, no gradient flourishes, and no AI-themed visual noise.

This system explicitly rejects two aesthetics named in PRODUCT.md: the **generic SaaS dashboard** (cards everywhere, gradient heroes, tool-for-work chrome — Rookzen is a game, not a B2B console) and the **cluttered, gamified chess site** (badge walls, streak counters, and noisy gamification competing with the board). Precision reads as premium here; decoration reads as noise.

**Key Characteristics:**
- Dark neutral by default (`#242224`), with a true stone light mode
- Stone board coloring that belongs to the approved identity while preserving square legibility
- Burgundy for primary action; dusty rose for active, selected, and focused state
- Fully flat at rest; elevation appears only as a response to touch
- A single 6px radius used everywhere — no radius scale to keep track of
- Source Sans 3 candidate first, followed by resilient system fallbacks

## 2. Colors

The palette is deliberately narrow: dark neutral and light stone surfaces, two stone board tones, burgundy action states, dusty rose selection/focus, one danger color, and translucent overlays for board feedback and panel depth.

### Primary
- **Burgundy** (`#934A54`, deepened through `#83414B` and `#72373F`): the brand action color for primary controls and the rook mark. It is not reused for errors or game-state verdicts.
- **Dusty Rose** (`#C6A0A2`, deepened to `#83414B` on light surfaces): selection, active state, links, and focus rings.

### Secondary
- **Board Light** (`#E9E4DE`) / **Board Dark** (`#91888B`): the stone square pairing. A dark-neutral contrast edge preserves selection and focus visibility across both tones.

### Tertiary
- **Ember** (`#e5484d`, dark mode) / **Ember Deep** (`#b42318`, light mode): danger/error state. Ember is reserved for error and destructive meaning and must never stand in for selection or neutral interaction.

### Neutral
- **Dark Neutral** (`#242224`): default dark background.
- **Light Stone** (`#F5F1ED`): explicit light-theme background.
- **Stone Text** (`#E9E4DE`): primary text on dark surfaces.
- **Muted Silver** (`#A6A6A7`) / **Light Muted** (`#686466`): secondary text values that retain normal-text contrast.
- **Panel Tint** / **Panel Tint Strong**: theme-aware overlays used to lift list rows and clocks slightly without a resting shadow.

### Board Feedback (functional, not decorative)
- **Hint Green** (`#14551e80`): legal-destination dot/ring on the board.
- **Last Move** (`#9bc70068`): highlights the two squares of the most recent move.
- **Premove Blue** (`#141ec866`): highlights a queued premove.

### Named Rules
**The Role-Bound Color Rule.** Burgundy means brand and primary action; dusty rose means selected, active, or focused; Ember means error or danger; review verdicts retain their semantic palette. Never make one color carry two unrelated states.

## 3. Typography

**Body Font:** Source Sans 3 candidate, then system-ui and sans-serif fallbacks
**Label/Numeric Font:** the same stack; weight and feature settings carry the distinction

**Character:** One typeface, doing all the work through weight, size, and `font-variant-numeric: tabular-nums` rather than a second family. Nothing about this system is a typographic showcase — the board is the visual centerpiece, and type stays out of its way.

### Hierarchy
- **Title** (700, 1.25rem, 1.2 line-height): the wordmark and ordinary section headings (`Open seeks`, `Profile`). The lobby may step to 1.5rem to make the play entry clear; decorative display type remains out of scope.
- **Body** (400, 16px, 1.4 line-height): default running text, form labels, status messages.
- **Small** (400, 0.875rem, 1.4 line-height): list-row content — seek rows, rating rows, recent-game rows.
- **Label** (400, 0.75rem, 1 line-height, ~70% opacity): the tiny "White"/"Black" clock-side labels.
- **Numeric** (600, 1.5rem, 1 line-height, tabular-nums): clock time only. The one place weight and size step up, because misreading a clock under time pressure is the one typographic failure that actually costs a competitive player a game.

### Named Rules
**The Board-Dominance Rule.** The board remains the largest, highest-contrast element on game screens. A compact play-first introduction may establish hierarchy on the lobby, but type never becomes poster-scale decoration.

**The Aligned-Figures Rule.** `font-variant-numeric: tabular-nums` belongs to any column of numbers the eye reads down, not only to the clock. The **Numeric role** — 600 weight at 1.5rem — remains clock-only; the figure setting is a separate legibility property, and conflating the two is what made this need saying. Proportional digits make a stack of numbers ragged, so a reader comparing them has to re-find the decimal point on every row. Currently: the clock, and the analysis panel's evaluation column (`.analysis-eval`), which sets tabular figures at ordinary `Small` weight and size. A new number column may use tabular figures; it may not use the Numeric role. Raised in the Qodo review of PR #133, where the two were read as the same rule.

## 4. Elevation

Flat at rest, everywhere. Depth on static layouts comes from theme-aware Panel Tint overlays and outline rings. Restrained elevation appears **only as a response to interaction**: hover and focus/active states on buttons and the promotion picker get a soft, low-spread shadow that resting elements never have.

### Shadow Vocabulary
- **Interactive Lift** (`box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28)`): applied only on `:hover`/`:focus-visible`/`:active` for buttons and the promotion-choice picker. Never applied to a resting element.

### Named Rules
**The Flat-at-Rest Rule.** No element carries a shadow in its default state. Shadows exist purely as interaction feedback — the instant the pointer or focus leaves, the shadow leaves with it.

## 5. Components

### Buttons
- **Shape:** 6px radius (`{rounded.base}`), same as every other rounded element in the system — there is no separate button radius scale.
- **Default:** transparent background, 1px border in the current text color (`currentColor`), `padding: 6px 14px`.
- **Primary:** a filled Burgundy treatment is reserved for a single clear conversion or recovery action, such as game review or returning from 404. It must retain 4.5:1 text contrast in resting, hover, and active states and must not turn every action bar into competing filled buttons.
- **Row action** (`padding: 2px 10px`, `Label` typography): the compact form used *only* for a control that sits inside a list row — the seek-list cancel, and the accept/decline/cancel/unblock controls in the social lists. Identical shape, border, hover and focus treatment; padding and type step down so a control never out-weighs the row it belongs to. This is a size, not a second button style, and it is the only size variant that exists. A control outside a row uses the default.
- **Hover / Focus:** `Panel Tint` background fill plus **Interactive Lift** shadow on hover; a 3px Dusty Rose outline on `:focus-visible`. Both are additive to the flat default, never a permanent state.
- **Ghost / disabled:** disabled buttons (e.g. "Create seek" before sign-in) keep the same shape but drop to reduced opacity with a `title` tooltip explaining why — never hidden entirely.
- **Grouping in an action bar:** when several buttons share a bar, spacing and copy establish hierarchy. Do not apply the primary treatment to multiple peers; if every action seems primary, reduce or regroup the actions.

### List Rows (seeks, ratings, recent games)
- **Shape:** `Panel Tint` background, 6px radius, `padding: 8px 12px` (seek rows) or `6px 12px` (rating/game rows), `Small` typography.
- **Behavior:** every list in the app — the seek list, the ratings list, the recent-games list — uses the identical row treatment. No card, no border, no per-list variation.

### The Board
- **Squares:** Board Light / Board Dark fills, no radius on individual squares; the 6px radius and `overflow: hidden` live on the board container only.
- **Selection:** a 3px inset two-tone ring — 1px dark-neutral `Selection Edge` outside and 2px Dusty Rose inside. The edge clears the 3:1 WCAG 1.4.11 floor against both stone square tones; do not drop it to simplify the ring.
- **Legal destinations:** Hint Green dot (empty square) or ring (capture) — shape difference is intentional and colorblind-relevant: a player who can't distinguish the hue can still distinguish dot vs. ring.
- **Last move / premove:** full-square translucent tint (Last Move / Premove Blue), applied as a pseudo-element so it never displaces the piece glyph.
- **Promotion picker:** a `Scrim` (`rgba(0,0,0,0.72)`) over the affected file, with square choice buttons on a near-white `Promo Tile` (`#fafafa`) fill. Its focus ring uses the deep selection token so it remains distinct on the tile.

### Clock
- **Style:** `Panel Tint Strong` background, 6px radius, `Numeric` typography, `padding: 8px 12px`.
- **Active state:** the side to move renders in Dusty Rose, sharing the selected/active role without borrowing the Burgundy action color.

### Navigation
- Plain text links (Stone Text at reduced opacity, full strength on hover), no underline and no resting pill background. The wordmark doubles as the home link.
- **Search field** (`.nav-search`): the one control that sits in the nav. It shares the form-control treatment used by the create-a-game panel: `Panel Tint Strong`, transparent 1px border, 6px radius, `Small` type, Dusty Rose focus ring, and a 44px minimum target on coarse pointers.
- **Learn subnavigation** (`.subnav`): Courses, Endgame Trainer, and Studies remain reachable through a horizontally scrollable row. Every link retains visible focus, an `aria-current` state on its active list page, and a 44px coarse-pointer target.

### Messages (inbox and conversation thread)
- **Inbox rows** reuse the one List Row treatment above — `.panel-row` inside `.panel-list`, exactly as the seek, ratings, tournament and search lists do. There is no messages-specific row.
- **Message bubble** (`.message-item`): `Panel Tint` fill, 6px radius, `padding: 8px 12px`, and `max-width: 80%`. The header uses the muted text role, with the sender stepping up to full-strength Stone Text so it reads before the timestamp.
- **Authorship** is carried by **side and fill only** — the caller's own messages sit `flex-end` on `Panel Tint Strong`, everyone else's sit `flex-start` on `Panel Tint`. It does not borrow Burgundy or Dusty Rose for a second meaning.
- **Deleted messages** render placeholder text in Muted Silver italic rather than the original body. A tombstone gets no border, badge, or color of its own.
- **Composer** (`.composer-form`): shares the standard form-control treatment and declares only `flex: 1` for width. Its send button remains default because the row has only one action.

### Teams (list and detail)
- **Team rows** reuse the one List Row treatment — `.panel-row` inside `.panel-list`, as every other list does. There is no teams-specific row.
- **Row composition** is the part worth stating, because `.panel-row` is `space-between`: a row holds exactly **two** children, never three. The identifying half (`.row-main` — the team name, plus its description in `.count` when there is one) travels as a single leading child; a status tag trails. Handing the row three loose children flings the description to the opposite edge, detached from the name it belongs to. The description carries `min-width: 0` and ellipsis so a long one shortens rather than widening the row.
- **Status is stated only when it is true.** A `private` tag appears on private teams; public teams carry no tag, because a "public" label on almost every row is noise that teaches the eye to skip the column.
- **`.count` is the row-metadata voice**, not only a number — timestamps, descriptions, visibility and roles all use it. It is `Small` in the theme's muted text token, and its job is to sit beside primary content without competing.
- **Member rows** show the handle as a link, and a role only for `owner` and `admin`. Rendering "member" on the majority of rows is the same noise as a "public" tag.
- **Search field** (`.team-search`): shares the single form-control treatment, declaring only `flex: 1`. Same rule as the nav search field and the message composer.
- **The action bar** (`.team-actions`) holds at most one control, so it needs no grouping rule — but that control is the **default** button style, like every other standalone button. When no action is available the bar is empty and a sentence explains why: private teams say joining is by request, owners say ownership must be transferred first, signed-out visitors are asked to sign in. An explanation is the state; a disabled button that can never enable is not.

### Team forum (thread list and thread)
- **Thread rows** are the one List Row treatment, composed the same way team rows are: exactly two children, because `.panel-row` is `space-between`. The title and its author travel together in `.row-main`; thread state trails.
- **State tags are earned, not default.** A row carries `pinned`, `locked`, or both — never "open" or "unpinned". Tagging the normal case teaches the eye to skip the column, which is exactly when a real `locked` tag stops being read.
- **Posts reuse the message bubble** (`.message-item`, `.message-header`, `.message-body`) rather than a forum-specific block. A forum post and a direct message are the same object — someone said something at a time — and the system has one treatment for that. Authorship is carried by side and fill, never by the accent, exactly as in Messages.
- **A deleted post keeps its row and loses its body**, rendered as placeholder text in the `.message-tombstone` italic. A thread deleted the same way keeps its row and shows a placeholder title. A tombstone is a state, not an emphasis: no border, badge or colour of its own.
- **`edited` is metadata, not a badge.** It sits in the muted `.count` meta line beside the timestamp, and is suppressed on a tombstone where it would be noise about content nobody can see.
- **Composers** (`.thread-form` for a new thread, `.composer-form` for a reply) share the single form-control treatment and declare only their widths. The thread form wraps rather than crushing two fields and a button onto one line at 320px.
- **A composer that would fail is not shown.** When the viewer cannot post, the form is hidden and a sentence names the actual obstacle — signed out, not a member, or the thread is locked. Where two obstacles are true, the one that would still block them after the other cleared is the one worth stating. A disabled composer that can never enable is worse than an explanation.

### Achievements (profile section)
- **This is the section the anti-gamification rule is about, so it is worth being exact.** The Don't below forbids a *badge wall* — tiles, medals, tier colours and trophy iconography competing for attention. A list of rows is not a wall. The section renders as the one List Row treatment every other list uses — `.panel-row`, `.row-main` and `.count`, unchanged — and adds no colour, icon, shape or radius of its own. Its only new CSS is two layout properties on the trailing half (see below). If a future change to this section needs a new colour, icon or shape, that is the signal it has drifted into what the rule prohibits.
- **Row composition** is the shared two-child rule: the name and the description that says what earns it travel together in `.row-main`; the standing trails in `.count`. The description ellipsises rather than widening the row.
- **The trailing standing does not shrink** (`.achievement-standing`: `flex-shrink: 0`, `white-space: nowrap`). It is several words where the teams and forum rows trail with one, and measured at 320px it wrapped to three lines and took the row from 32px to 51px. The description is the half that should give way, because it already ellipsises. A trailing tag longer than a single word needs this; `private` and `locked` do not.
- **Tier is a word, never a colour.** `bronze`/`silver`/`gold` sit in the muted `.count` voice beside the progress. Rendering tier as three metal colours would add a second, third and fourth accent to a system that has exactly one, and would encode meaning in hue alone.
- **There is no progress bar.** A hairline fill was considered and rejected: it is the most recognisably gamified element in the set, and it would be a new visual primitive the system has no rule for. `7 / 10` carries the same fact in the voice the system already speaks.
- **An unlocked row says `Unlocked`, not `10 / 10`.** Same principle as state tags being earned rather than default — a finished count reads as a task still in hand.
- **The section hides itself when the deployment has no achievements service.** Every route answers 503 when `ACHIEVEMENTS_ENABLED` is unset, and that is identical on every profile, so an empty heading everywhere is worse than no section. A load that fails for one profile does show its error, because that one a visitor can retry.

### Promotion picker

- **The tiles carry piece artwork, not letters.** Each choice is a `.cb-promo-choice` combined with the shared `.cb-p-*` class, so the queen offered in the dialog is the same Cburnett drawing that will appear on the board a moment later. An earlier version drew Unicode characters; the switch to the SVG set is why the rule carries no `font-size` and the buttons have no text content.
- **No rule reaching these buttons may use the `background` shorthand** — not the tile rule, and not the generic `button` rules either. The artwork arrives as a `background-image` from `.cb-p-*`, and the shorthand resets it to none. The artwork arrives as a `background-image` from `.cb-p-*`, and the shorthand resets that to none. At equal specificity the later rule wins, so for a while the dialog rendered four identical blank tiles with nothing to tell the queen from the knight — correct markup, correct classes, every test green, and the failure visible only on screen. `packages/web/test/style-contract.test.ts` now asserts it, because this is the edit a future tidy-up is most likely to make.
- **The generic button rules are the subtle half.** `button:not(:disabled):hover` is specificity (0,2,1) against `.cb-p-*` at (0,1,0), so its shorthand erased the piece on hover even though a later `.cb-promo-choice:hover` rule set the fill back — a higher-specificity rule reset a property the later one never restored. `packages/web/test/style-contract.test.ts` asserts the rule across every selector that can match the element, because checking the two obviously-named rules is what missed this.
- **The tile also owns the sizing.** `background-size: contain`, `no-repeat` and `center` live here rather than being inherited: `.cb-piece` carries them for pieces on the board, and this button is not one.
- **The near-white tile works for both colours** because the Cburnett pieces are drawn with a heavy contrasting outline — a white queen is white with a black edge, not a pale silhouette a pale tile would swallow. The focus ring over it is `--sel-deep`, since plain `--sel` measures only 2.5:1 there.

### Search results

- **`.row-link` is the shared row-link primitive.** It was called `.tournament-link` while it was styling forum threads, message conversations, team rows, member rows and search results — six call sites, one of which was a tournament. Renamed for the same reason `.team-row-main` became `.row-main` (ADR-0089 §7): a shared primitive named after its first consumer invites someone to add a second, per-entity variant beside it rather than reuse it.
- **Row composition** is the shared two-child rule, and search is its fourth consumer. The title and its subtitle travel together in `.row-main`; the entity type (`Player`, `Game`, `Tournament`) trails in `.count`. The subtitle carries what the row is — `Standard · Blitz · 1-0` for a game, `Arena · Running` for a tournament — and ellipsises rather than widening the row.
- **No loading row.** The results list never contains a placeholder row. A `.panel-row` reading "Loading…" is a counterfeit result: a screen reader announces it as one, and a sighted reader sees a row-shaped thing that is not a row. `aria-busy` on the results container carries the state instead. This is affordable because a search is now a single request (ADR-0094) rather than a query plus up to ten hydrating fetches.

### Learning (courses, lessons, steps)
- **Course and lesson lists** use the one List Row treatment (`.panel-row`, `.row-main` and `.count`). A course row trails its difficulty (`Beginner`, `Intermediate`, `Advanced`) in the muted `.count` voice. A lesson row trails **nothing** — an `Open →` affordance on every row was removed for the same reason a `public` tag is not rendered on public teams: a column that says the same thing on every row teaches the eye to skip it, and the title is already the link.
- **Single scrolling lesson page.** All steps of a lesson render on one page in `orderIndex` order. No multi-step wizard chrome, step tabs, or prev/next pagination buttons.
- **A step is a block separated by a hairline, not a card.** A step holds a board, prose and a form, so unlike everything else in a list it cannot be a `.panel-row` — it needs a container. That container is deliberately *not* a card: no `--panel` fill, no radius, no border box. Steps are separated by spacing plus a single `border-bottom: 1px solid var(--panel-strong)`, dropped on the last one. A panel fill and a 6px radius repeated down a page is a card stack, which §1 of this document rules out in as many words; the first implementation of this section shipped exactly that and was replaced. If a future step type seems to need a fill to hold itself together, that is the signal it is carrying too much, not that the rule should bend.
- **Move steps** render a read-only board (`setTurn(false)`) and accept SAN inputs via a text field (`.step-san-input`) sharing the single form-control style.
- **Quiz options are default buttons, full width** (`.quiz-option-btn`). They inherit the standard shape, border, hover, focus and type; no option receives the primary treatment because every answer must look equally choosable.
- **Attempt feedback** uses words (`Done`, `Try again`) in the muted `.count` voice without borrowing brand, selection, or danger colors for ordinary status. `Done` is driven by `completedAt`, never by whether the last attempt was correct — a completed step stays done even if the learner later answers it wrongly, which the domain permits.
- **Service unavailability (503)** degrades quietly with a plain sentence (`Learning service unavailable.`) in muted text voice.

### Leaderboard

- **Leaderboard standings rows** reuse the single List Row treatment (`.panel-row`, `.row-main` and `.count`).
- **Row composition** follows the standard two-child rule: rank (`#1`, `#2`) and the player handle or `shortId` travel together in `.row-main`; rating and rating deviation (`2100 (±35)`) trail in `.count`.
- **Link Policy**: Resolved handles render as links to the player profile (`.row-link`, `data-route="profile"`). Bare, unresolved user IDs render as plain text fallback without links to avoid broken profile navigations.
- **Variant Selector**: The `<select id="leaderboard-variant-select">` uses the single `cg-select` form control treatment, declaring options from `OFFERED_VARIANTS` with human-readable `VARIANT_LABELS`.

### Passkeys (account security profile section)

- **Account security rows** reuse the single List Row treatment (`.panel-row` inside `.panel-list`).
- **Row composition** follows the standard two-child rule used by `appendPanelRow`: passkey name and creation date share the leading label span; the compact `Delete` button trails inside `.panel-row-actions`. Its visible label stays concise, while the shared row helper gives it a contextual accessible name that includes the passkey label.
- **Row actions**: Compact row action uses `padding: 2px 10px` and `Label` typography, matching the cancel/unblock action standard.
- **Passkey register action**: Standalone button (`#passkey-register`, "Add passkey") uses the default button style and one 8px spacing step before the credential list.
- **Passkey sign-in button**: `#auth-passkey` ("Sign in with passkey") sits beside the password auth buttons on `#auth-form` and uses the standard button style without a password field requirement. The `.auth-actions` row wraps at narrow widths rather than shrinking any action label onto multiple lines.
- **Self-profile only**: the account security section stays hidden on public player profiles and is revealed only for the signed-in player's own profile.

### Notation Pane (studies viewer)
- **Inline move text with indented variations.** Chess move trees render as inline wrapping move text (`1. e4 e5 2. Nf3 Nc6`) with indented blocks for variations, one step per nesting level, without bullets or list markers. This is the one place the app follows chess convention over its own list idiom — the same argument §1 makes for keeping classic board colours. Moves are not rendered as one per `.panel-row`.
- **Mainline weight is unbolded.** `font-weight: 600` is strictly reserved for the clock's `Numeric` role. The mainline is distinguished from variations by indentation, structure, and muted voice, never by bold font weight.
- **Selection uses the theme-aware `--sel` token as an outline, never a text-bearing fill.** The selected move carries a **2px** outline; keyboard focus keeps the standard **3px** ring, so both states remain distinguishable. Dusty Rose on the dark background and Deep Burgundy on Light Stone both exceed the 3:1 indicator floor.
- **Accessible move buttons.** Each move in the tree is a focusable `<button class="notation-move">` control with an accessible `aria-label` (e.g. `Move 2 White Nf3!`). On coarse pointers (`@media (pointer: coarse)`), move targets expand to a minimum 44px hit area to ensure touch accessibility.
- **NAG fusion and comment prose.** PGN NAG codes 1–6 fuse to the move glyph (`Bb5!`). Comments follow moves as inline prose in the muted `.count` voice (`#8f8f8c`). Positional assessment NAGs outside 1–6 render as empty strings to avoid unestablished system font glyphs.

## 6. Do's and Don'ts

### Do:
- **Do** keep the board as the single largest, highest-contrast element on every screen — nothing else scales up to compete with it.
- **Do** use Burgundy for brand and primary action, and Dusty Rose for active/selected/focused state.
- **Do** use the theme-aware `--sel` token for selection and focus. Explicit light mode remaps it to Deep Burgundy so the indicator remains compliant on Light Stone and the near-white promotion tile.
- **Do** keep every list (seeks, ratings, games, and any future list) on the identical `panel-row` treatment — one row style for the whole app.
- **Do** reserve shadows for interaction feedback only (`Interactive Lift` on hover/focus/active) — resting layouts stay flat.
- **Do** keep legal-move/last-move/premove board cues distinguishable by shape as well as color (dot vs. ring, full-square tint vs. outline) so they read without relying on hue alone.
- **Do** use Ember/Ember Deep for error and danger states exclusively — never reuse the brand or selection tokens for error text.

### Don't:
- **Don't** build a generic SaaS-dashboard look — no card grids, no gradient hero banners, no tool-for-work chrome. This is a game, not a B2B console.
- **Don't** add gamification clutter — no badge walls, streak counters, or achievement noise competing with the board or the game state. Achievements themselves are not banned and do exist on the profile; what is banned is giving them tiles, medals, tier colours, icons or a progress bar. See the Achievements component above for where that line falls.
- **Don't** introduce additional accent colors "for variety." Burgundy, Dusty Rose, and Ember already have distinct semantic jobs; new hues require a new functional meaning and an accessible token contract.
- **Don't** add a resting-state shadow to any card, panel, or list row — shadows only ever respond to interaction.
- **Don't** introduce a new border-radius value. Everything rounded in this system uses the same 6px — a second radius reads as inconsistency, not craft.
- **Don't** reuse the dark-mode `Panel Tint` unmodified in light mode. The `--panel` / `--panel-strong` tokens resolve to stone overlays on Dark Neutral and dark-neutral overlays on Light Stone; use those tokens rather than a raw fill.
