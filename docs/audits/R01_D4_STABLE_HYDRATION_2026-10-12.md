# R-01 PR1: D4 stable hydration verification

Baseline: `84b3d9d253dffcedab601967d2814600f6234cf5`, freshly fetched main.
Branch: `fix/r01-d4-stable-hydration-20261012`.
Worktree: `C:/Users/hp/rocky-fix-r01-d4-hydration` (already existed, clean at baseline).

## Baseline RED

Fresh disposable Redis 7 and pgvector PostgreSQL 16, production authority/router/
registry/consumer and PostgreSQL EventStore. One Node process; in-memory client
transport/pubsub and minimal token verifier. Test-only database migrations were
explicitly authorized; no shared database, deployment or production migration.

1. Cold join A's actual durable ply-0 snapshot was held at the EventLog response seam.
2. Join B loaded the same game, then normal Redis ownership routing committed b1c3.
3. Releasing A reset both its joined snapshot and authority cache to ply 0.
4. Legal Black e7e5 failed with `not_your_turn`; PG retained seqs 0 and 1.
5. The desired assertion `cachePly === 1` failed (actual 0), exit 1.

The preserved original audit fixture and worktree were read only and unchanged.
This new reproduction used newly created disposable containers and current source.

## Implementation

[ADR-0159](../adr/0159-stable-game-slot-hydration.md) records the owner-approved
stable GameSlot design. Its queue outlives replaceable snapshots. Cold loading
coalesces, forced reloads perform their own later read, and commands select the
current resident inside the queue. Generation and identity guard delayed loads.
Deferred eviction preserves queued/running serialization, hides disposed records
from synchronous reads and rejects new commands until a current load restores them.
Empty/failed loads remain retryable without installing an empty game. Queued
command reconciliation does not cancel requested eviction.

ApplyOptions mechanically groups the existing admission hook and request ID.
Forwarded START_REQUEST timing, expiry, uncertainty, duplicate handling and exact
successful commandConfirmed publication remain unchanged. LocalCommandRouter has
no positional hook to convert and requires no source edit.

## Verification and limits

- Focused new authority schedules and existing authority regressions: 105 passed,
  zero failures/skips. Includes cold/forced load ordering, synchronous read guards,
  command/append versus deferred eviction, failed/missing reads, invalidated
  generations and admission/receipt behavior.
- Initial focused Redis/PG D4 + R-03 + ownership + flag/no-show suite: 50 passed,
  zero failures/skips. Three D4 scenarios prove normal and forwarded b1c3/e7e5
  commit once at durable seqs 1/2, forced takeover refresh after delayed ply 0,
  and release/reclaim requiring a fresh claim-generation read.
- Full root build/lint and 19-workspace zero-skip test orchestration passed before
  the final synchronous-read/disposal refinements. Final-head gates must be checked
  again before publication; these earlier results are not final-head approval.
- Initial Linux gateway full run: 115 passed, 1 failed, zero skips. Tournament
  readiness timed out with Redis connect ETIMEDOUT while using Docker Desktop's
  host forwarding. This run is not passing evidence. Final full validation uses
  direct disposable service container addresses to remove that forwarding hop.
- A subsequent clean Linux gateway run using direct disposable container addresses passed all 116 tests, zero failures/skips. A final complete run is still required after the last generation-handling refinement.
- Initial FakeRedis spectator sketch failed because it sent a move before the cold
  join subscribed; the failed test left its consumers running. The test now awaits
  joins and always stops consumers. The corrected authority suite completed.

All new D4 service tests are two independent gateway instances in one process,
with actual Redis/PG and controlled EventLog timing, not two serve.js processes,
process kills, real network partitions, browser acceptance or cluster certification.
Coalescing deliberately prevents the old second-join-through-first-read schedule;
the forced-load scenario separately proves refresh to committed ply 1 and legal
Black advancement to ply 2. No D1/D2/D3 or later remediation is claimed.

## Reviews and integration

Initial Gemini 3.8 Flash High/high effort review ran through agy 1.3.3 read-only.
It read baseline and draft while the primary process edited; its relay fingerprint
reported readOnlyViolation=true. This is not clean independent final-head evidence.
Useful disposal and pending-reload suggestions were corrected and tested. The
unchanged committed candidate requires fresh independent review plus CI, Qodo,
Greptile and resolved review threads before an owner-ready claim.

PR #106 was inspected read-only at d032985. Its UnownedForwardedRequest
releaseExpiryCopy addition is outside the modified options block and has not been
copied, reverted or integrated. A future #106 merge requires integrated-head
validation, including its cleanup regression. PR #107 was inspected read-only at
aa088982 and has no source overlap in this PR. No other owned branch was modified.

Local dependency removal was rejected by automatic approval review as blocked by
policy; no alternate deletion mechanism was attempted. The Linux gateway image
provides a separate clean dependency installation. Original fixture cleanup remains
outside scope. Required external review gates, publication and HEAD equality are
reported separately against the eventual final committed head; this document does
not claim they have completed.

## Qodo lifecycle corrections after initial publication

At published head a70043c, Qodo identified three valid D4 edge cases: a failed
forced read became missing for overlapping joiners because the queue tail swallowed
its rejection; eviction during creation discarded successful residency; and
ordinary load invalidation returned false, which joins interpreted as missing.
Four new schedules first failed (resident/cold failed-reload waiters, creation
eviction and forced-reload/eviction join). The corrections retain a separate
fallible forced-read result, distinguish loaded/missing/invalidated outcomes,
retry ordinary invalidation inside the existing queue, and revive successful
creation after its durable initial append. An additional cold-then-forced-failure
schedule verifies the cold continuation also propagates read errors and retries.
There is no change to the forwarded admission hook, exact receipt, routing or
later ownership policy. Earlier head CI/reviewer results are superseded and the
corrected head must complete renewed validation and external reviews.

Greptile independently confirmed the read-error issue and identified a valid test
quality gap: the real-service takeover scenario released the cold snapshot before
proving the asynchronous Redis claim had requested its forced reload. The takeover
and reclaim tests now signal after the actual production reload call queues its
read and await that signal before releasing the earlier snapshot. Product routing
and ownership behavior are unchanged by the scheduling instrumentation.
