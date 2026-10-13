# R-02 F4: abandoned claim metadata retirement

## Authorization and fresh baseline

Owner authorized F4 only after manually merging #110 and #111. Mandatory status,
worktrees, branch listing, fetch/prune, GitHub merges, F3 source and overlap checks
preceded edits. Fetched/live/GitHub main agreed on
`bf0ce91fae99e06daae8348a913c5632c815e94b`. New isolated worktree:
`C:/Users/hp/rocky-fix-r02-f4-abandoned-20261013`, branch
`fix/r02-f4-abandoned-claim-cleanup`. The previous F3 checkout and Codex 2 revision
checkout were not modified. Open #107 has deployment/script-only scope.

Read project rules/state, audit index, permanent tracker, Fable/Astra historical
architecture/security/reliability context, D3/D4 ADRs and source/tests, R-03/R-04
verification, merged F3 evidence and prior F4 scope. Historical `dd7fec5` findings
were revalidated, not adopted as current-main proof. Deferred statuses are unchanged.

## Genuine RED before production edits

After clean root/gateway installs and baseline build, new permanent tests imported
unchanged production router/registry/authority and controlled only external log or
lease I/O. Each schedule uses promises/barriers or manual timer/monotonic advancement,
not arbitrary sleeps. Private retention observation avoids adding a diagnostics API.

| Baseline execution | Result |
|---|---|
| Existing focused F3/D3/R-03 regressions | 65/65 |
| New deterministic F4 tests | 11: 5 pass, 6 assertion failures |
| Actual Redis/PostgreSQL F4 tests | 2: 1 pass, 1 assertion failure |
| Complete clean Linux Node 22 Redis/PG gateway | 185: 178 pass, 7 F4 assertion failures |
| 19-workspace hermetic baseline | 4,164/4,164 |

Zero skips/cancellations/TODOs in these runs. Intentional failures get no passing
credit. RED includes failed reload/release, twelve distinct IDs retaining 12 stale
entries, failed pending reload without replacement, failed Redis release,
releaseAll shutdown and confirmed renewal loss. Existing old/new generation
success/failure isolation controls pass; not every release schedule was broken.

Real-service tests use actual Redis leases and migrated PostgreSQL durable games.
Failure is injected **after actual PG reads**, not a real database outage. After
twelve failures/releases, stale debt is `12 != 0`; the later generation assertion
is not reached. The replacement control commits local b1c3 then actual
Redis-forwarded e7e5 with durable seqs `[0,1,2]` and no obsolete gesture replay.

Reproducer entry points after supplying disposable `REDIS_URL`/`DATABASE_URL` and
building/installing the repository dependencies:

```text
npx --prefix services/gateway tsc -p services/gateway/tsconfig.test.json
node --test services/gateway/dist-test/test/claim-metadata.test.js
node --test services/gateway/dist-test/test/claim-metadata.integration.test.js
```

## Failure mechanism and minimal repair

`onClaimed` records fresh router reload debt and a strictly increasing generation.
A failed reload removes its settled promise by identity but retains retry debt.
The old release hook stopped the consumer only. No future successful reload is
guaranteed for permanently released game IDs, so stale/generation entries accumulate.

The only production behavior change deletes that game's `staleAfterClaim` and
`claimGeneration` inside the synchronous registry release hook before stopping its
consumer. Registry tickets/local ownership are already invalidated, even if later
Redis release I/O fails. Confirmed renewal loss uses the same synchronous hook.
Successor claims cannot interleave with this deletion; it is lifecycle-owned
retirement, not generic map clearing, a sweep or a retention timeout.

`rehydrations` is deliberately untouched on release. Pending work retains its
promise until settlement; a replacement installs its own lookup while old callers
retain theirs. Existing generation guards block old success from settling new
debt; exact promise identity blocks old finally/rejection from deleting B's reload.
Claim counters are never reset/reused. Local expiry or consumer-only stop is not
permanent abandonment. Failure while still owned remains retryable.

Cleanup neither marks the authority record fresh nor evicts/splits a busy D4 slot.
Old immutable D3 tickets still reject before mutation; fresh B reloads and commits.
F3 loop/callback identity, R-03 START/FINISH/SETTLE and exact identities/unknown
outcomes, R-04 authorization/expiry cleanup and all existing policy code are unchanged.

## Required schedules and preserved controls

- F4-01/02: failed reload/release and twelve distinct-game cumulative retirement.
- F4-03/04/05/06: old success/rejection while B has unresolved debt/promise; B's
  valid hydration/admission; pending A release with/without replacement. Both
  controlled and actual Redis/PG schedules preserve promise identity and no replay.
- F4-07: stop/replacement alone keeps owned retry debt; unchanged permanent F3
  obsolete disconnect/not_owner/admitted-callback and real Redis restart tests.
- F4-08: overlapping release/claim preserves busy D4 lifecycle and invalidates D3
  old ticket; unchanged D3 renewal/operation-lane/ABA and D4 hydration suites.
- F4-09: explicit no-replay controls plus actual forwarded successor; unchanged
  R-03 exact identity, admitted completion, known/unknown and lost-ack regressions.
- Extra: failed Redis release, shutdown releaseAll, local safety-margin expiry
  retains debt until confirmed renewal loss. No F1/F2 terminal/cache policy tests
  are rewritten to imply those policies are implemented.

## Failure accounting and independent review

Setup failures remain separate: new test regexp slash typo (TS1005/1109), integration
event narrowing typo (TS2339), initial disposable PG image missing vector extension
(migration failures, 0/2), and Linux load-POSIX invocation missing deploy test files
(zero executed tests, correctly refused by zero-skip). Corrected fixtures use a
separate task-owned pgvector image with real migrations; load-POSIX receives a
read-only deploy directory mount. None are product RED or production fixes.

First Gemini pre-review fingerprint was contaminated by this agent concurrently
adding test files; `readOnlyViolation=true` is retained without acceptance credit.
Frozen pre-review: agy 1.3.4, Gemini 3.8 Flash High/high, project
`0493e5a1-715b-4c74-b48b-b675d4673c18`, conversation
`e54c86b3-c0b8-4839-995d-c6dd070b0abb`, 14:22:39–14:29:56 UTC,
`readOnlyViolation=false`. Frozen post-fix review used the same genuine model/effort,
project `90eaed3f-292e-4b09-b1b8-039dea30a31e`, conversation
`755b6715-50d6-493d-8f0a-7dbba5541822`, 14:31:56–14:41:43 UTC,
`readOnlyViolation=false`, zero actionable code findings. Static review, not
independent test execution. No fallback model. Post-review prose mistakenly calls
#110 the F3 prerequisite (actually #111) and mislabels F4-09 in its matrix; those
claims are not adopted. The final exact-head review must reconcile those facts.

## Corrected local verification

| Gate | Verified result |
|---|---|
| Focused F4 + F3/D3/R-03 + actual Redis F3 | 80/80 |
| Complete clean-install Linux Node 22 real Redis/PG gateway | 185/185 |
| Renewed workspace build/lint and 19-workspace tests | build/lint pass; 4,164/4,164 |
| PostgreSQL persistence / API / backup-restore | 210/210; 109/109; 2/2 |
| Guard script tests / load harness | 333/333; 86/86 |
| Actual Nginx trusted-edge / web delivery | 8/8; 12/12 |
| Linux POSIX API / load | 2/2; 1/1 |
| Eight guards / native gateway build/lint | pass |
| Root/gateway production dependency audit | zero vulnerabilities |

Positive counted suites have zero failures/skips/cancellations/TODOs. Supporting
modules were re-executed, not inherited from #111's report. Full gateway uses the
unchanged Dockerfile.gateway-test with clean reproducible Linux installation and
direct task-container networking. Raw logs/count summaries preserve failed runs
and SHA-256 fingerprints in the authorized worktree's ignored evidence bundle.
Final exact-head independent/CI/Qodo/Greptile/thread gates belong to the PR handoff,
not preemptively claimed here. F4 remains a candidate until owner merge.

## Limits

This proves process-local entry lifetime, not byte/heap/frequency/load bounds,
long-duration memory certification, distributed recovery/fencing or deployed
partition correctness. F1 terminal policy, F2 cache policy, R-01 revision/D1/D2,
PostgreSQL fences and Helm #107 remain outside scope. Owner alone decides merge;
no main push, force push, deployment or other worktree edits are authorized.
