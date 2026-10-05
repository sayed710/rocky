# Fable + Astra final closure — 2026-10-05

**FABLE + ASTRA ENGINEERING REMEDIATION IS CLOSED ON CURRENT MAIN.**

Final main SHA: `d42bcea3b2bb20abf25f212ff402767d18ec095f` (`fix: suppress durable ended-game seek receipts (#93)`), owner-merged. This document is documentation only. It changes no production code, tests, configuration, policy content or visual decision.

## What closed it

PR #93 fixed the last required technical P1, **C02** (creator redirected to an already-ended game). Verified on this main:

- `PgSeeksRepository` receipt SQL (`packages/persistence/src/pg/repositories.ts`, `listOpen`) now excludes the creator's accepted seek when `game_events` already holds a `GameEnded` row for `s.game_id`. The check is a correlated `NOT EXISTS` inside the existing receipt statement, so it holds before the games projection catches up.
- `packages/api/test/seek-terminal-receipts.integration.test.ts` covers this through the production router for resignation, abort and checkmate before projection, without hiding live receipts or open seeks.
- `packages/persistence/test/games-projector.integration.test.ts` was updated alongside it.
- Design record: [ADR-0157](../adr/0157-durable-seek-match-receipts.md). Behavioral evidence: [SEEK_TERMINAL_RECEIPTS_VERIFICATION_2026-10-05.json](SEEK_TERMINAL_RECEIPTS_VERIFICATION_2026-10-05.json).

This closure rests on that source and test inspection plus the evidence recorded by #93. No new test run is claimed here.

## Closure state

| Measure | Value |
|---|---|
| CURRENT_ACTIONABLE_P0 | 0 |
| required CURRENT_ACTIONABLE_P1 | 0 |
| RESOLVED | 60 |
| OWNER_DEPENDENCY | 11 |
| NEEDS_EVIDENCE | 7 |
| INTENTIONALLY_DEFERRED_P2 | 12 |
| INTENTIONALLY_DEFERRED_P3 | 11 |
| OBSOLETE | 1 |
| Total normalized findings | 102 |

No required technical P0/P1 remediation remains. RESOLVED is the pinned ledger's 59 plus C02.

## Relationship to the pinned ledger

[FABLE_ASTRA_CURRENT_REMEDIATION_2026-10-05.md](FABLE_ASTRA_CURRENT_REMEDIATION_2026-10-05.md) is a **historical snapshot pinned to main `3aa2010` before #93**. It still lists C02 as `CURRENT_ACTIONABLE_P1` (RESOLVED 59). It is deliberately **not rewritten**: it must not be read as having been audited after #93. The only change from that snapshot is C02 moving to RESOLVED via #93; all other dispositions are carried forward unchanged. The original [Fable/Astra audit](FABLE_ASTRA_FULL_AUDIT.md) is likewise untouched.

## Public launch is not approved

Engineering closure is not a launch decision. Public launch is **not automatically approved**. The owner dependencies and evidence items below are separate from engineering closure, and none is a required technical defect.

## Remaining 11 owner dependencies

Taken from the pinned ledger's `OWNER_DEPENDENCY` rows. No policy, legal or visual content is invented here.

| ID | Item | Next action | Public-launch effect |
|---|---|---|---|
| U07 | Tournament operator web UI / public arena product | Owner chooses public/operated scope; use existing API workflow or authorize a scoped UI | Conditional on a public tournament promise |
| S09 | Final logo, fonts, board/status palette and permanent visual redesign | Review final identity; the existing palette/wordmark are not final logo/font authorization | Owner sign-off if required by release plan |
| S10 | Final navigation IA / dedicated mobile menu | Approve any structural IA change before implementation | Owner release/taste decision |
| P03 | Final Privacy, Terms and Fair-play substance | Owner/legal supply and approve all three final policies; engineering publishes authorized text | Yes |
| P04 | Discoverable policy/source links and registration reference/consent | Owner chooses link placement and registration reference, then authorizes small wiring | Yes for discoverable policy/source links; consent conditional |
| P05 | Deletion/retention and personal-data export | Approve retention/deletion and personal export scope; no invented purge promise | Owner/legal determines applicable release requirement |
| P06 | Sanctions/refunds/enforcement policy | Approve a proportionate operator process; no automatic bans implied | Owner operational fair-play policy |
| O07 | Actual backup schedule/storage/retention and safe live ratings-primary DR | Operator establishes backup policy and rehearses physical or approved ordering-safe primary recovery | Yes for an operated public service |
| O08 | Moderation staffing and operator readiness | Appoint operators and exercise runbooks without inventing sanction policy | Yes when community/trust surfaces ship |
| F01 | Friend challenge/rematch | Owner approves eligibility/color/settings/delivery contract before scoped implementation | No for Minimum Credible; conditional on owner promise |
| F02 | Unified settings / sound / custom board-piece scope | Owner defines settings scope; preserve working individual controls | No for Minimum Credible |

## The 7 NEEDS_EVIDENCE items

These are **evidence, deployment or manual-certification items. They are not confirmed required engineering defects** and do not reopen engineering remediation. Each needs evidence that cannot come from code or hermetic CI.

| ID | Item | Evidence needed |
|---|---|---|
| A06 | Manual screen reader (including RTL order), low-vision and 200% zoom | Manual assessment; no certification is claimed |
| A07 | Physical mobile/orientation and Firefox/Safari behavior | Real-device and non-Chromium acceptance; current evidence is Chromium only |
| O06 | Real cluster/CNI/Helm rollout/alerts, production TLS/email/passkeys | Deployment acceptance in the intended environment |
| O09 | Full deployed Compose/ingress browser journey (game → rating → history → review) | Deployed-topology smoke; layered CI acceptance exists but is not this |
| O10 | Windows Signature B mechanism/root cause | Cause unproven; Linux CI mitigation present; no demonstrated Linux product blocker |
| D02 | Service-worker static/unhashed cache freshness | Bounded stale-client test before claiming a defect |
| D03 | Historical compose Lighthouse accessibility 0.93 vs harness ≥0.95 | Measure the deployed production shell; current main CI passes at 0.96 |

## Deferred, not blocking

The 12 `INTENTIONALLY_DEFERRED_P2` and 11 `INTENTIONALLY_DEFERRED_P3` items stay deferred, as in the pinned ledger. They are not closure blockers and are not promoted by this document. The one `OBSOLETE` row (X01) stays obsolete.
