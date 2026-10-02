# Gemini Planning Artifact: Post-Gate P1 Implementation Sequencing

> **Codex adjudication — 2026-10-02:** Independent Codex review of this entire historical document against current main `07946b9b03538ed73a3f7b773e7ad5a327d83805` is complete. Read the [current-main correction and disposition ledger](CODEX_GEMINI_PLANNING_ADJUDICATION_2026-10-02.md) before using any claim or sequence below. The original Gemini snapshot, recommendations and then-pending review status are preserved as historical evidence, not current implementation instructions or owner approval.


> [!IMPORTANT]
> **STATUS AND AUTHORITY NOTICE**
> - **Gemini-Generated Planning/Review Artifact**: This document was produced during Gemini read-only implementation-planning audits on 2026-09-30.
> - **Evidence Snapshot, Not Project Truth Forever**: Observations reflect repository commit `553751c628f69436600987ddbf649a13f2b9eb2d` (`origin/main`), with read-only awareness of active PR #76 (`295aa32261271b68d164e243bbf8a7457dff8360`).
> - **Pending Independent Codex Adjudication**: All technical recommendations and sequencing proposals are subject to independent review by Codex.
> - **NOT an Owner-Approved Priority Decision**: The sequencing and batching presented here represent planning recommendations, not approved owner roadmap commitments.
> - **NOT Authorization for Implementation**: This document does not authorize implementation without prior owner approval.
> - **Historical Findings Reverification**: Findings must be reverified against current `origin/main`.
> - **Current Repository Truth Wins**: Current repository and GitHub evidence strictly supersedes any statement in this document.

---

## 1. Context and Dependency Landscape

Following the authoritative Fable + Astra reconciliation, the platform's execution path is structured around three milestones:
1. **Technical Launch Blocker:** Durable ratings application with explicit `(variant, speed)` pools and truthful rating consumers (actively underway in **PR #76**).
2. **Owner-Dependent Release Gates:**
   * EN/AR shell localization and mixed-direction text readiness.
   * Privacy, Terms, Fair Play, and public AGPL source code disclosure.
3. **P1 Implementation Sequence:** Material functional gaps that must be resolved prior to public platform launch.

```mermaid
flowchart TD
    subgraph Blocker["Technical Blocker"]
        PR76["PR #76: Durable Ratings & Pool System<br/>(Active Work)"]
    end

    subgraph Gates["Owner-Dependent Release Gates"]
        G_I18N["EN/AR Shell Localization<br/>(i18n PR 1 Scaffolding)"]
        G_POL["Policy & Source Disclosure<br/>(Policy PR 1 Scaffolding)"]
    end

    subgraph P1_Ind["P1 Workstreams Independent of PR #76"]
        P1_HELM["Helm Reporter Parity"]
        P1_UNAVAIL["Unavailable-Capability Pages"]
        P1_PGN["Game PGN Serializer & Export"]
        P1_ILL["Illegal-Move Feedback"]
        P1_DEL["Account Deletion Request Scaffolding"]
        P1_REP["Reporting Form & Queue Scaffolding"]
    end

    subgraph P1_Dep["P1 Workstreams Dependent on PR #76"]
        P1_SEEK["Opponent Rating in Seek Rows"]
        P1_CHAL_R["Rated Direct Friend Challenges"]
        P1_PROF["Profile Multi-Pool Ratings Display"]
    end

    PR76 -.-> P1_SEEK
    PR76 -.-> P1_CHAL_R
    PR76 -.-> P1_PROF
```

---

## 2. Historical P1 Capability Inventory (2026-09-30; superseded below)

Every P1 item from historical audits was reverified against fresh `origin/main` (`553751c628f69436600987ddbf649a13f2b9eb2d`):

| Capability / Finding | Verified Main Status | PR #76 Dependency? | Owner Decision Required? |
| :--- | :--- | :--- | :--- |
| **Helm Tournament Reporter** | Present in Docker Compose; omitted in Helm `values.yaml`. | **NO** (Pure config) | **NO** (Engineering deployment parity) |
| **Opponent Rating in Seeks** | Seek cards lack pool-accurate rating display. | **YES** (Needs PR #76 pool rating) | **NO** (Pure correctness follow-up) |
| **Game PGN Export** | No client PGN download serializer. | **NO** (Reads game event log) | **NO** (Engineering fact, standard PGN) |
| **Illegal-Move Feedback** | Invalid drag/click lacks a11y & visual feedback. | **NO** (Pure client UI) | **NO** (Interaction design, see note below) |
| **Unavailable Capability Pages** | Dead links or missing views for unready features. | **NO** (Client routing) | **NO** (Standard explanatory UI) |
| **Rematch Capability** | Post-game screen lacks rematch trigger. | **NO** (Game lifecycle) | **YES** (`D-09`: Color swap & settings rules) |
| **Direct Friend Challenges** | No direct invite link or targeted challenge. | **PARTIAL** (Casual = No; Rated = Yes) | **YES** (`D-08`: Casual vs rated; `D-10`: UX) |
| **Settings Surface** | Settings scattered; lacks centralized dialog. | **NO** (Client preferences) | **YES** (`D-16`: Launch scope vs deferred) |
| **Mobile Navigation & Touch** | Topbar overflows on mobile; touch targets < 44px. | **NO** (Responsive shell) | **YES** (`D-17`: Drawer vs bottom tab bar) |
| **Game Review 40-Move Limit** | Engine evaluation stops at ply 80 (move 40). | **NO** (Web worker engine) | **YES** (`D-15`: Tactical scan vs pagination) |
| **Account Deletion** | No mechanism for users to delete accounts. | **NO** (User account service) | **YES** (`D-11`: Pseudonymization vs purge) |
| **Personal Data Export** | No self-service data export. | **NO** (User account service) | **YES** (`D-12`: Export bundle scope & format) |
| **User Reporting & Moderation** | No in-game report form or review queue. | **NO** (Moderation service) | **YES** (`D-13`: Categories & review policy) |
| **Anti-Cheat Heuristic Action** | Analysis pipeline unlinked to penalty policy. | **NO** (Async analysis pipeline)| **YES** (`D-14`: Flagging vs automated bans) |

---

## 3. Critical Technical Clarifications & Invariants

To avoid regressions and duplicated effort during sequencing, the following engineering facts are pinned:

1. **Illegal-Move Feedback Must Not Introduce Hardcoded Strings:**
   * When implementing screen-reader announcements (`aria-live="#status"`) and visual feedback for illegal moves, engineering must NOT introduce new hardcoded English strings.
   * If i18n PR 1 has landed, use typed keys (e.g., `t('game.illegal_move')`). If i18n has not yet landed, provide non-verbal visual cues (board shake/square flash) and prepare the aria-live key hook.
2. **Direct Friend Challenges: Casual vs Rated Decoupling:**
   * A **strictly casual** direct challenge flow has **zero dependency on PR #76**. It can be engineered, tested, and shipped immediately using basic challenge tokens.
   * A **rated** direct challenge flow depends strictly on PR #76 merging first to establish valid `(variant, speed)` rating pools.
3. **Mobile Navigation Architecture is Confirmed Defect, but Pattern is Owner Choice:**
   * The defect (topbar overflow and touch target sizing < 44px on viewports < 768px) is physically verified.
   * However, the structural solution (Hamburger drawer vs persistent bottom tab bar) is an owner visual and ergonomic decision (`D-17`). Engineering must not unilaterally force a bottom tab bar onto the board view.
4. **Strict Boundary Against Promoting Deferred P2/P3 Scope:**
   * Items intentionally deferred in the Fable + Astra reconciliation (e.g., multi-engine selection, advanced study partner voice modes, custom board colorways, advanced community clubs) must remain deferred. They are not required for launch.

---

## 4. Historical Gemini Sequencing (superseded; not an execution checklist)

> [!NOTE]
> All sequences below are **planning recommendations** prepared by Gemini and are subject to Codex adjudication and owner authorization.

```mermaid
flowchart TD
    subgraph Wave1["Wave 1: Immediate Scaffolding & Zero-Dependency Quick Wins"]
        W1_A["i18n PR 1: Locale Infrastructure"]
        W1_B["Policy PR 1: Route Scaffolding"]
        W1_C["Helm Reporter Parity (values.yaml)"]
        W1_D["PGN Export Serializer & Button"]
        W1_E["Explanatory Unavailable-Capability Pages"]
    end

    subgraph Wave2["Wave 2: Core Gameplay Ergonomics & Release Gates"]
        W2_A["Illegal-Move Feedback (a11y & visual)"]
        W2_B["Rematch State Machine (Post-Game Card)"]
        W2_C["i18n PR 2: Shell & Surface String Migration"]
        W2_D["Policy PR 2: Content Publication (Pending Owner)"]
    end

    subgraph Wave3["Wave 3: Post-PR #76 Integrations & Direct Challenges"]
        W3_A["Opponent Pool Rating Display in Seek Rows"]
        W3_B["Direct Friend Challenges (Casual Flow)"]
        W3_C["Direct Friend Challenges (Rated Pool Integration)"]
        W3_D["Settings Central Surface Dialog"]
    end

    subgraph Wave4["Wave 4: Trust, Safety & Account Lifecycle"]
        W4_A["Account Deletion & Historical Pseudonymization"]
        W4_B["Personal Data Export (PGN + JSON)"]
        W4_C["User Reporting Modal & Moderation Ingestion Queue"]
        W4_D["Mobile Ergonomics, Touch Targets & Nav Drawer"]
        W4_E["Game Review Moves 41+ Worker Evaluation"]
    end

    Wave1 --> Wave2
    Wave2 --> Wave3
    Wave3 --> Wave4
```

### Detailed Wave Breakdown

* **Wave 1 (Immediate Scaffolding & Quick Wins - Zero Blockers):**
  * `i18n-pr1`: LocaleManager, typed keys, storage abstraction, tests (no visible strings).
  * `policy-pr1`: Clean routes (`/privacy`, `/terms`, `/fair-play`, `/about`), view scaffolding, repo disclosure plumbing.
  * `deploy-helm-parity`: Enable `tournamentReporter.enabled: true` in `helm/values.yaml` to match Compose.
  * `pgn-export`: Add standard Seven Tag Roster PGN serializer and download action to finished game card.
  * `unavailable-routes`: Provide clean, informative placeholder views explaining upcoming capabilities for unlinked routes.

* **Wave 2 (Ergonomics & Release Gate Progression):**
  * `illegal-move-feedback`: Audio/visual shake and polite `#status` live announcement for illegal move attempts.
  * `rematch-flow`: Post-game rematch button proposing color-swapped game with identical time controls.
  * `i18n-pr2`: Full migration of hardcoded UI strings to `t(key)` and mounting of language toggle.
  * `policy-pr2`: Ingestion of approved policy text once owner/legal supply copy.

* **Wave 3 (Post-PR #76 Integrations):**
  * *Prerequisite:* PR #76 merged to `main`.
  * `seek-opponent-ratings`: Update lobby seek cards to show creator pool ratings accurately.
  * `friend-challenges`: Generate shareable challenge URLs and direct user-to-user challenges.
  * `settings-surface`: Mount launch settings dialog (Theme, Language, Sound, Move Cues).

* **Wave 4 (Trust, Safety & Mobile Polish):**
  * `account-deletion`: User-facing deletion request triggering PII scrubbing while preserving game moves as `[deleted]`.
  * `data-export`: Self-service download of account data and multi-game PGN bundle.
  * `reporting-moderation`: In-game player reporting modal feeding internal operator review table.
  * `mobile-ergonomics`: 44px+ touch target enforcement and mobile navigation drawer.
  * `game-review-depth`: Extended web worker evaluation for games exceeding 40 moves.

## 5. Codex corrected current-main sequence

Read the [all-14-item disposition table](CODEX_GEMINI_PLANNING_ADJUDICATION_2026-10-02.md#p1-capability-disposition). PR #76 is merged; PR #81 already supplies i18n infrastructure/runtime migration/bidi; PR #83 already supplies the report/triage backend, first-admin bootstrap, trust analyzers and Helm reporter parity. Do not implement these twice.

1. **Remaining release-gate work:** Production Arabic catalog (historical **i18n PR 3**) with owner-approved terminology, approved switcher/typography choices, count/plural handling where required and full Arabic browser/bidi acceptance; policy/source scaffolding and approved publication with discoverable links. These streams can proceed independently; scaffolding or English-only runtime migration is not release-gate completion.
2. **Open engineering follow-ups:** Seek creator's pool rating display, finished-game PGN download (reuse the existing studies serializer where appropriate), explicit illegal-gesture feedback. Existing not-found and unavailable views must be inspected surface by surface, not rebuilt as wholly missing.
3. **Owner-scoped gameplay work:** Casual direct challenges and rematch need product/UX scope, not a rating prerequisite. Rated direct challenges use the **already-merged** rating pools plus their own authorization/anti-abuse contracts. Casual challenges have no dependency on rating integration.
4. **Owner/policy-dependent work:** Settings scope, mobile pattern only if current evidence warrants a structural change, account deletion/retention, personal export, report/triage **web UI**, and sanction/appeal policy. Backend reporting and trust deployment are already implemented; they do not establish owner approval of new sanctions.
5. **Long-game review proposals:** Any extension is a server/API budget and contract change, not web-worker work. Current partial review is already supported. Critical-moment scanning, resume/pagination and depth changes remain proposals; no option is selected.

No wave ordering here promotes historical P2/P3 proposals into launch blockers. Current responsive CSS and 44px target rules also mean the historical blanket mobile-defect claim needs fresh measurements before changes.
