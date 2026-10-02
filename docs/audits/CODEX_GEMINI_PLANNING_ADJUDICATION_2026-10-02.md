# Codex adjudication of Gemini planning — 2026-10-02

**Adjudicator:** Codex, independently inspecting all five Gemini documents and repository evidence. This substantive adjudication was not delegated to Gemini.

**Historical target:** `553751c628f69436600987ddbf649a13f2b9eb2d`, Gemini's 2026-09-30 planning snapshot. **Current main inspected:** `07946b9b03538ed73a3f7b773e7ad5a327d83805`. **Preservation PR starting head:** `5ef877bc375979a2fc595973da59a39b66de40e2` (#80).

Read the [audit governance](README.md), [original audit](FABLE_ASTRA_FULL_AUDIT.md), [visual handoff](ROOKZEN_VISUAL_HANDOFF.md), [recovery provenance](RECOVERY_INDEX.md), [project history](../PROJECT_STATE.md) and [recorded owner context](../PRODUCT_BRAND_CONTEXT_AR.md) together. No tracked `ROCKY_OWNER_DECISIONS.md` is present in this repository snapshot; the owner-context companion is available. Historical local Windows evidence paths remain provenance, not contributor navigation.

This ledger distinguishes factual verification from product authorization. It neither selects owner options nor creates new release requirements, sanctions, legal conclusions or feature authorization. All owner-response checkboxes remain unselected. Original Gemini assertions are preserved and explicitly superseded where wrong; their then-pending Codex status is historical. This ledger completes that pending adjudication at the stated main SHA. Future main changes require reverification.

## Entire-document adjudication

| Historical document | Codex disposition |
|---|---|
| [Planning index](GEMINI_PLANNING_INDEX_2026-09-30.md) | Provenance and original correction chronology remain useful historical context. Five repository navigation links were broken and are repaired. Pending-review/next-implementation instructions are superseded by this completed ledger and merged work. No owner sign-off follows from preservation. |
| [Localization](GEMINI_I18N_PLANNING_2026-09-30.md) | Infrastructure, runtime migration, semantic relocalization and bidi foundations are already merged via #81. Proposed names, JSON catalogs, storage key and blanket hardcoded-English inventory do not describe current main. Production Arabic, approved copy and end-to-end acceptance remain open. Permanent placement/detection/typography choices remain unselected. |
| [Policy/disclosure](GEMINI_POLICY_DISCLOSURE_PLANNING_2026-09-30.md) | Policy/source surfaces remain genuinely open. Auth/storage and Docker metadata claims were factually wrong even at the historical target, not merely made stale by later work. Scaffolding/publication separation is still useful; proposed env plumbing and route paths are proposals, not existing capability. Engineering cannot certify legal sufficiency. |
| [P1 sequencing](GEMINI_P1_SEQUENCING_2026-09-30.md) | All 14 entries adjudicated below. #76 is merged; #81/#83 complete several tasks. Historical waves omit Arabic PR 3 and wrongly delay casual challenges. Corrected sequencing is explicitly proposed and separates remaining release gates, open engineering follow-ups, owner decisions and deferred scope. |
| [Owner dossier](GEMINI_OWNER_DECISION_DOSSIER_2026-09-30.md) | All 17 candidates adjudicated below. Existing engineering baselines do not equal owner-selected options. D-02 labels harmonized explicitly; D-15 corrected to server/API architecture. D-13/D-14 backend/deployment absence is superseded. Historical deadlines, numeric effort claims and legal/performance certainties are not established facts. |

## Merged prerequisite and capability evidence

- **PR #76:** merged 2026-09-30, merge commit `3a10e3cd3b6edbce57de463676d5734dbb641c4e`, **M15 Increment 78**. Explicit variant × speed pools, durable exactly-once application and truthful pool consumers exist. The historical active head `295aa322...` is not a current prerequisite. See [rating application](../../packages/persistence/src/pg/ratings-applier.ts), [profile rendering](../../packages/web/src/app/profile-mount.ts) and the Increment 78 project-state entry.
- **PR #81:** merged as `8f7a06a88b9465566dd3fd7f2dbd9b949cca2203`, **Increment 80**. See the localization evidence below. Merging infrastructure did not approve permanent owner choices or finish Arabic publication.
- **PR #83:** merged as current main `07946b9b03538ed73a3f7b773e7ad5a327d83805`, **Increment 81**. [Report routes](../../packages/api/src/routes.ts), [report domain](../../packages/persistence/src/player-reports.ts), [migration 0047](../../packages/persistence/migrations/0047_player_reports.sql), [transactional report repository](../../packages/persistence/src/pg/player-reports.ts), [first-admin bootstrap](../../packages/persistence/src/pg/first-admin.ts), [trust worker](../../services/gateway/src/trust-worker.ts), [analyzer composition](../../packages/api/src/trust-analyzers.ts), [Helm values](../../deploy/helm/gambit/values.yaml) and [durable launcher](../../packages/api/src/tournament/durable-launcher.ts) prove durable intake, CAS triage/audit, first admin, singleton worker topology, default tournament reporter and launch race fixes.
- **PR #82:** merged as `06390437...` between the historical target and current main. Community write admission already exists; a historical lack-of-abuse-budget statement is not evidence of current absence. The recorded implementation is **Increment 79**.

PR numbers above denote merged repository history, not outstanding external blockers. These are source-verifiable capabilities, not proof of production deployment on a real cluster or approval of further product policy.

## Localization adjudication

[I18n manager](../../packages/web/src/i18n/manager.ts), [typed English catalog](../../packages/web/src/i18n/catalog/en.ts), [storage](../../packages/web/src/i18n/storage.ts), [document attributes](../../packages/web/src/i18n/document.ts), [bidi helpers](../../packages/web/src/i18n/bidi.ts), [runtime integration notes](../../packages/web/src/i18n/README.md), and controller/view mounts establish:

- `I18n` / `createI18nManager`, typed `MessageKey`, interpolation, subscriptions, English fallback and catalog availability checks exist. The historical proposed `LocaleManager`, `locales/en.json`, `ar.json` and `ar-test.json` filenames are not current module contracts.
- Current locale storage is **`rookzen_locale_v1`**, not the proposed `cb_locale`. Production registers English; Arabic test catalogs do not establish a production Arabic catalog. Requests for an unregistered Arabic locale remain English.
- Runtime copy is substantially migrated to typed messages; semantic relocalization preserves pending requests, ownership, focus, announcements and private review state. Do not describe all runtime localization as absent or rebuild it.
- Document `lang`/`dir` and DOM-level LTR/auto-direction isolation exist. Chessboard geometry remains LTR under RTL. This does not establish complete Arabic rendering, copy quality or every future surface's bidi correctness.
- The historical “production Arabic catalog PR 3” remains an explicit release-gate workstream: approved translations/terminology, count/plural handling where needed, approved accessible language selection and full Arabic browser/RTL acceptance. Current interpolation is parameter substitution, not proof of a complete Arabic six-category plural engine.
- No production visible language switcher or browser auto-detection is shipped by #81. English default and clean URLs are implemented engineering baselines, not evidence that the owner selected D-01/D-05 permanently. Font candidates and permanent placement remain proposals. #81 is not an English-only launch-scope change.

## Policy and data-practice corrections

The historical target and current main were both inspected using `git show`/`git grep` and current source. The following supersedes Gemini's inaccurate “verified” inventory:

| Claim | Historical target `553751c...` | Current main `07946b9b...` / evidence |
|---|---|---|
| Password hashes use Argon2id/bcrypt | Incorrect: default was `ScryptPasswordHasher`. | Default remains **scrypt**, injected by [bootstrap](../../packages/api/src/bootstrap.ts) with implementation in [auth/password.ts](../../packages/api/src/auth/password.ts). A pluggable hasher does not prove a deployment uses another algorithm. |
| Theme preference key is `cb_theme` | Incorrect: `gambit-theme`. | Still **`gambit-theme`** in [theme-toggle.ts](../../packages/web/src/app/theme-toggle.ts). |
| `sessionStorage` stores ephemeral game state | No such application game-state use found; only an abstract storage-interface comment mentions it. | No such game-state use found in web source. Do not disclose it as an implemented practice. Game state is not established by a generic storage interface. |
| Only UI preferences are stored locally | Incomplete: `gambit-session` stores handle and user ID. | [Auth controller](../../packages/web/src/app/auth-controller.ts) persists **handle + userId**, not tokens. [Session manager](../../packages/web/src/net/session.ts) keeps access tokens in memory; refresh credential is an HttpOnly cookie, with hashed refresh-token records server-side. JWT access and opaque refresh tokens must not be conflated. |
| `cb_locale` is upcoming storage | Historical proposal only. | Implemented locale key is **`rookzen_locale_v1`**. Also inventory create-game preferences **`gambit-create-game`**, shared logout barrier **`rookzen-session-logout-barrier`**, and auth-cookie ordering **`rookzen-auth-cookie-order`** in [create-game prefs](../../packages/web/src/app/create-game-prefs.ts), session manager and [API client](../../packages/web/src/api/client.ts). These are local browser metadata, not proof that personal tokens are persistently stored. |
| Production Docker already embeds Git SHA and repository URL | Incorrect: [historical web Dockerfile](https://github.com/sayed710/rocky/blob/553751c628f69436600987ddbf649a13f2b9eb2d/Dockerfile.web) supplies neither. | [Current web Dockerfile](../../Dockerfile.web) and [Vite config](../../packages/web/vite.config.ts) still provide no `VITE_GIT_SHA` / `VITE_REPO_URL` plumbing. These variables, helper and source-link UI remain proposed work. Existing engines/assets and license files in images do not imply this build metadata exists. |

Other material policy claims also need boundaries:

- Dedicated `/privacy`, `/terms`, `/fair-play`, `/about` or `/legal` surfaces are absent from the current [router](../../packages/web/src/app/router.ts); their existence is not implied by historical proposed route registration. The existing [LICENSE](../../LICENSE) and absence of a discoverable shell source link are engineering observations, not a legal sufficiency determination.
- Append-only game events and public summary queries are implemented, but **“permanently recorded” is not a verified retention policy**. Ownership/private review access differs from public game summaries. Report detail, moderator notes, audit records and analyzer evidence have their own access restrictions. A policy inventory must account for newly merged reports/trust work rather than declare every stored item public.
- The production composition uses [JsonLogger](../../packages/api/src/ports/logger.ts), not evidence of Sentry/Pino deployment. Metrics are present; nginx/logging infrastructure can record request metadata, but actual production IP/User-Agent collection, destinations, retention and operator settings must be inventoried in the deployed environment. The historical telemetry bullet is not a deployment audit.
- Historical D-07 enforceability rankings, invented consent phrases, “fully satisfies” legal language, D-11 absolute purge/retention promises and proprietary-detection wording are **unverified proposals**. No engineering option proves consent validity, erasure compliance or source-offer sufficiency. Owner-approved scope/text and appropriate legal review remain required; no proposed copy is publication-ready.

## Game Review correction

At both inspected SHAs, finished-game review uses **`POST /v1/games/:id/review`** → [GameReviewService](../../packages/api/src/game-review/service.ts) → [server analysis composition](../../packages/api/src/game-review/composition.ts), backed by the [durable completed-game archive](../../packages/api/src/game-review/finished-game-review.ts). The [client controller](../../packages/web/src/app/game-review-controller.ts) requests and owns the result; it does not run this review in a client Stockfish worker.

`MAX_REVIEWED_PLAYER_MOVES = 40` applies to moves made by the authenticated reviewed player. It is **not a global 80-ply cutoff or “all moves 41+ missing” rule**. Longer games already return bounded partial results with `isPartial`, `totalPlayerMoves`, `analyzedPlayerMoves` and `cutoffReason: 'move_limit'`. The default server deadline is 120,000 ms, with quota admission, ownership and cancellation boundaries. A stale route response-description mentioning excessive length does not supersede the service's actual partial-result behavior.

D-15 may ask whether to add server-side critical-moment selection, a new resume/pagination contract or an adapted server budget. None is implemented by this planning PR, and no new worker architecture is required by this ledger. Benchmark evidence is required before asserting client freezes, depth/latency savings or performance limits. The historical D-15 options are preserved but explicitly superseded; the corrected owner sheet remains unselected.

## P1 capability disposition

The original 14-item table is historical, not a current launch checklist. “Open” below means the described capability is not established by inspected source, not authorization to implement it or a new blanket launch blocker.

| Historical item | Current-main disposition and evidence |
|---|---|
| Helm tournament reporter | **Already implemented #83:** `gateway.tournamentReporter.enabled: true` in actual `deploy/helm/gambit/values.yaml`; resilient tournament launch/report paths exist. |
| Opponent rating in seeks | **Still open:** [lobby renderer](../../packages/web/src/app/lobby-mount.ts) shows creator handle, variant, speed/time and rated state, not a pool rating. #76 pool foundation is merged; no active-PR dependency remains. |
| Game PGN export | **Still open for finished-game download:** existing [studies PGN serializer](../../packages/studies/src/pgn-serialize.ts) and studies export route must not be described as no PGN support anywhere. No finished-game download flow found. |
| Illegal-move feedback | **Still open for explicit locally rejected gestures:** [BoardInteraction](../../packages/web/src/core/interaction.ts) returns select/deselect/none/move etc., not the claimed existing `illegal` event. Server failure UI/status already exists. Do not replace accessible text with nonverbal shake alone while awaiting i18n; typed localization is now available. |
| Unavailable capability pages | **Blanket absence superseded:** [bootstrap](../../packages/web/src/app/bootstrap.ts) has a not-found surface; [learning](../../packages/web/src/app/learning-mounts.ts) and [studies mounts](../../packages/web/src/app/studies-mounts.ts) render capability-unavailable states. Reverify any specific gap individually. |
| Rematch | **Still open:** no rematch protocol/button found in current game/web source. Product negotiation/color/settings scope remains D-09. Existing game conclusion is available. |
| Direct friend challenges | **Still open:** social follow/message functionality and bot/open seeks are not targeted human invitations. Casual flow never required #76; rated flow uses merged pools plus new challenge security/product contracts. |
| Settings surface | **Partially available:** theme, create-game preferences and account security controls exist; no unified proposed settings dialog found. D-16 scopes additions; sound/highlights/system-theme promises are not established capability. |
| Mobile navigation/touch | **Historical blanket defect unverified on current main:** responsive/wrapping/scrolling rules and 44px targets exist in [style.css](../../packages/web/src/style.css). No drawer/tab-bar pattern is owner-approved here. Fresh measurements precede any claimed current overflow or structural redesign. |
| Game Review ceiling | **Partial fallback already implemented; optional extension open:** server review as above, not client-worker work or a universal 80-ply cap. |
| Account deletion | **Still open:** no self-service account deletion lifecycle found in current routes. User-ID references in reports/audits/events must be included in retention design; scrub vs purge remains owner/legal scope, not approved SQL work. |
| Personal data export | **Still open:** no self-service complete account export found. Studies PGN export is not personal-account export. Scope/format remain D-12, with privacy/access controls. |
| Reporting/moderation | **Backend already implemented #83; web UI open:** durable `player_reports`, reasons **`cheating | harassment | spam | other`**, queue/detail/CAS transitions with authorization, party exclusions and audits. Historical `moderation_reports` table/category list is not the actual schema. No report or triage web surface found. |
| Anti-cheat action | **Server analysis/deployment already implemented #83; sanction policy open:** [analyze/store service](../../packages/api/src/anti-cheat/analysis-service.ts) and trust worker produce protected evidence. No described `flagged_for_review` account field, automated shadowban or report-threshold sanction is established by this flow. Evidence collection is not a penalty-policy approval. |

Existing [profile renderer](../../packages/web/src/app/profile-mount.ts) shows explicit pool ratings. Do not schedule profile multi-pool display as entirely missing. Preserve the distinction between operational backend foundations and later operator/reporting web UI.

## Owner-decision adjudication

All checkboxes stay `[ ]`. Engineering baseline choices already merged are not retroactive owner selections. Historical timing estimates (“5-line change”, “<1 hour”), font sizes, fixed breakpoint/toast TTL, anti-collusion “elimination” and certainty of zero false positives are recommendations or unsupported predictions, not verified acceptance criteria.

| ID | Codex disposition |
|---|---|
| D-01 detection | **Owner product choice remains open.** English default/no auto-detection is implemented; it no longer blocks building locale infrastructure. |
| D-02 placement | **Owner visual choice remains open.** No switcher, avatar dropdown, mobile menu/drawer or unified Settings surface exists in [the current shell](../../packages/web/index.html). Menu/Settings surfaces needed by an option are proposed work, including guest access. Option A is explicitly harmonized as Desktop Topbar / Mobile Menu; B and C have consistent all-viewport meanings. Original topbar-only A and composite recommendation are recorded, not silently rewritten. |
| D-03 terminology | **Owner copy approval remains required** for production Arabic. Example terminology is an unapproved draft, not a glossary or current catalog. |
| D-04 fonts | **Final font/visual choice open; implementation feasibility is engineering.** System fallbacks exist, PWA service worker exists; candidate font sizes/coverage need measurement. No fixed mandatory font or external-font policy is newly approved here. |
| D-05 URLs | **Current unprefixed routing is an implemented engineering baseline.** Adding locale-prefixed product URLs is a future owner-scoped change, not a prerequisite to #81. Actual routes do not include the proposed `/lobby`, `/analysis`, `/review/:id` pages as named route contracts. |
| D-06 policy links | **Owner placement choice open.** Routes/discoverability need implementation; global footer is not implied approval. Current shell class names differ from proposed `.cb-topbar` / `.cb-app-shell__content`. |
| D-07 consent | **Owner/legal publication and UX choice open.** Proposed checkbox/notice language and legal ranking are not approved copy or legal evidence; speculative configurable schema is not automatically required. |
| D-08 challenge eligibility | **Owner product choice open.** Casual/rated eligibility must not be selected here. Pools are merged; casual is independent. Casual-only does not eliminate all abuse or collusion. |
| D-09 rematch | **Owner product contract open.** Color/settings negotiation is a real choice; building an unapproved state machine is not automatically authorized. |
| D-10 notification | **Owner UX choice open.** Pattern and expiry are proposals, not evidence of an existing challenge delivery contract. |
| D-11 deletion/retention | **Owner/legal policy scope open; safe implementation is engineering.** Append-only history does not prove legal compliance, absolute purge feasibility or approved pseudonymization. |
| D-12 export | **Owner bundle scope open; serializer format/authorization are engineering.** A standalone game PGN and complete personal export are different tasks. |
| D-13 reporting | **Backend already merged; policy/web workflow decisions remain open.** Actual four reasons/schema are recorded engineering contracts, not evidence that the owner selected the dossier's different categories. No automatic sanction is inferred. |
| D-14 sanctions | **Owner/policy choice remains open.** Server analyzers and topology are implemented; proposed account flags, shadowbans and refunds are not. “No automated bans” does not imply zero review false positives. |
| D-15 review extension | **Optional product/server-budget choice, corrected architecture.** Current partial review exists. Resume, critical selection and budget adaptation require explicit new contracts; no client-worker rewrite deadline. |
| D-16 settings | **Owner scope choice open.** Existing preference/security surfaces are preserved; custom piece/board choices and other optional extras are not new launch requirements. |
| D-17 mobile pattern | **Owner visual choice only if a structural change is needed.** Accessible target sizes and responsive correctness are engineering requirements; current defects require measurements, not historical assertions. |

## Deferred scope and remaining gates

The historical audit distinguishes minimum credible launch, competitive V1 and P2/P3. Gemini's phrase “all material P1 gaps before public launch” does not turn every proposed wave into a newly approved gate. The remaining EN/AR publication and policy/source gates are not satisfied by scaffolding. Other genuinely open items retain their original priority and require scoped authorization.

Intentionally deferred recommendations such as multi-engine/variant expansion, advanced voice/dialect/study-partner breadth, custom board/piece systems, real semantic search, advanced clubs, native apps and large-scale infrastructure adoption remain deferred unless separately authorized. Some infrastructure (for example existing rollout/NetworkPolicy templates) already exists; a historical P3 label is not proof of its absence. No visual recommendation replaces the approved Burgundy & Stone identity or approves permanent typography/navigation.

## Seven original Greptile findings

| Finding / comment ID | Independent verification and disposition |
|---|---|
| Index local links / `4145299785` | **Valid, fixed:** all five `file:///docs/` repository links converted to relative Markdown targets; owner response anchor retained. |
| Policy auth/storage / `4145299799` | **Valid, corrected explicitly:** historical/current scrypt, theme key, absence of sessionStorage game-state use and locally stored handle/userId verified; current new metadata inventoried above. Original false inventory marked historical and unsafe to reuse. |
| Docker metadata / `4145299812` | **Valid, corrected explicitly:** neither inspected Docker/Vite snapshot supplies SHA/repo plumbing; original claim marked incorrect and proposed work remains open. |
| Review architecture / `4145299824` | **Valid, corrected explicitly:** server/API, 40 reviewed-player moves, existing partial metadata; old D-15 preserved/superseded and corrected sheet targets proposed server contracts. |
| Arabic PR 3 omission / `4145299834` | **Valid, fixed in corrected sequence:** production Arabic catalog and final acceptance scheduled as remaining release-gate work, with #81 infrastructure distinguished from publication. Original waves retained as historical. |
| Casual challenge prerequisite / `4145299843` | **Valid, fixed in corrected sequence:** casual independent; rated uses already-merged pools. Historical wave ordering is superseded, not repeated as a current blocker. |
| D-02 option mismatch / `4145299855` | **Valid, fixed with explicit label correction:** detailed choices and response sheet consistently use composite A, menu-only B, settings-only C; original mismatch recorded; none selected. |

## Integrity and review boundary

Historical path examples were checked against current files. Use these actual locations rather than copying projected paths as implementation contracts:

| Historical/projected reference | Verified current evidence |
|---|---|
| `packages/web/src/router.ts` | `packages/web/src/app/router.ts` |
| `packages/web/src/styles/` | `packages/web/src/style.css` |
| `packages/web/src/ui/lobby/`, `ui/game/`, `ui/auth/`, `ui/review/`, `ui/shell/` | Controllers/mounts under `src/app/`, flat components under `src/ui/`, and `packages/web/index.html`; the listed feature directories are not current paths. |
| `helm/values.yaml` | `deploy/helm/gambit/values.yaml`; reporter setting is `gateway.tournamentReporter.enabled`, not a new top-level key. |
| `locales/en.json`, `locales/ar.json`, `cb_locale`, `LocaleManager` | Current TypeScript catalog, `I18n` manager and `rookzen_locale_v1`; Arabic catalog remains proposed. |
| Existing `interaction.ts` event `illegal` | `packages/web/src/core/interaction.ts`; no such existing gesture variant. |
| Existing `/analysis`, `/review/:id`, `/settings`, `/lobby` routes | These names are proposals or UI surface descriptions, not current router registrations; current root `/` is the lobby and review is mounted in the game surface. |

This PR changes documentation only. Source links identify evidence in the integrated main snapshot; historical proposed/nonexistent paths remain labeled proposals and must not be copied as existing interfaces. The independent final model review checks the resulting documentation diff; it does not replace this Codex adjudication or owner/legal decisions. Exact-head CI and reviewer results belong to the final PR handoff and must be refreshed after any further push.
