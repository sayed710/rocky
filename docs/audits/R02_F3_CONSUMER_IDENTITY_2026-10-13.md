# R-02 PR1: F3 consumer instance identity

## Scope and preflight

Only R-02 F3 is implemented. Authorized worktree:
`C:/Users/hp/rocky-fix-r02-f3-consumer-20261013`, branch
`fix/r02-f3-consumer-20261013`. Initial status was clean. Mandatory status,
worktree list, branch listing and fetch/prune completed before edits. Local HEAD,
fetched origin/main, live remote main and merged PR #109 agree on
`9dda14b4775157d035201a9fee3e536b022543f7`.

Original evidence `C:/Users/hp/rocky-r02-red-20261013/r02-evidence/REPORT.md`
was read only; SHA-256
`f7bb80365fce7e6daf37ed0ebb30f716529dceb2e479277bb1282c9d3ef2cb6e`.
Its baseline `dd7fec5` is historical, not current-main proof. PROJECT_STATE and
the D3/D4/R-03/R-04 verification records were read. Historical Fable/Astra
closure is not reopened or credited as fixing R-02.

## Current-main RED before production edits

New tests import unchanged production consumer/authority and control only Redis
connection/command completions and EventLog append timing. After root server
build, separate gateway installation and test compilation:

```text
npx --prefix services/gateway tsc -p services/gateway/tsconfig.test.json
node --test --test-concurrency=1 services/gateway/dist-test/test/consumer-lifecycle.test.js
6 tests: 1 passed, 5 failed, 0 skipped/cancelled; exit 1.
```

- Stop without replacement passes: A settles with one BLPOP.
- Delayed rejection after stop/start, including stop-all/restart, fails:
  `obsolete A must settle despite B membership`: false versus true.
- Five replacements fail: `all replaced promises must settle`: 0 versus 5.
- Held `not_owner` result after B registers fails:
  `A callback must not delete B`: false versus true.
- Admitted old work retains its response, but its obsolete loop fails to settle.

With fresh labeled Redis and REDIS_URL supplied, compiled
`consumer-lifecycle.integration.test.js` also failed 0/1, exit 1:
`obsolete real A must settle after B registers`: false versus true.
Actual CLIENT LIST established A's server-side BLPOP; genuine ioredis disconnect
reached status `end`. Only propagation of that real rejection was held until B
registered. This is not a synthetic connection/setup failure.

Both RED logs remain in ignored `test-results/r02/`. Permanent tests retain these
schedules and add controls; original evidence was not modified.

## Repair and compatibility

OwnerCommandConsumer captures `{gameId, conn}` per loop. Liveness and disconnect
handling compare the exact connection, never mere game-ID membership. Obsolete
`not_owner` callbacks stop only their own still-current instance. Expiry cleanup
is suppressed only while a different current consumer exists; without B, R-04
still evicts the temporary unwatched ended copy.

Already-popped envelopes retain existing START/FINISH/SETTLE Lua and response
delivery. Admitted work can finish; unowned queued work retains its exact identity
and deadline for handoff. No early discard, replay, cancellation of admitted
work or replacement disconnection is introduced. D3 tickets, operation lanes,
release epochs and reload debt, and D4 serialized slot lifetimes are unchanged.
No domain, persistence, deployment, revision-contract, F4 or cache-policy edit.

## Review corrections and failure accounting

Initial genuine agy 1.3.4 review used `gemini-3.8-flash-high`, effort `high`,
read-only; project `ff46ccfc-34a0-4fd7-ac19-efcee7b44009`, conversation
`48a9659d-3b2a-452f-9660-b05b90e5979f`, 2026-10-13
11:08:44–11:17:33 UTC, completed with `readOnlyViolation:false`.
It identified an over-broad expiry guard and missing no-replacement/malformed/
real-Redis cleanup controls. No fallback model. This is pre-correction review,
not final approval.

A disposable compiled no-replacement variant first failed all three cleanup
assertions (not_owner, duplicate/done, admitted): residency true versus false.
Permanent parameterized controls now require eviction without B and retained
residency with B. A real Redis control verifies no-B eviction and exact handoff.

The first complete Linux Redis/PG gateway run failed 164/166, zero skips or
cancellations. One failure counted Node 22's deferred MockTimers warning as a
consumer error. A diagnostic captured that warning and the single transport
error separately; the assertion now counts exactly the transport error without
disabling warnings. The other failure was unchanged flag readiness alongside
Redis ETIMEDOUT through Docker Desktop host forwarding. One focused unchanged
flag test passed on direct task-container networking; the original cause is
unproven. Corrected full Linux run uses that direct network with unchanged
test/runtime settings and passes 172/172. No flag or production-network fix.

An initial diagnostic misquoted the name filter and selected unrelated source
files without prerequisites; its setup/module failures and skip have no product
RED or acceptance credit. Correct focused Node 22 execution reproduced only
the warning-accounting failure. The first summary probe also failed to recognize
PowerShell's mojibake reporter glyph; corrected anchored summary parsing counts
complete reporter lines, never numbers embedded in test names.

## Local verification

| Gate | Verified result |
|---|---|
| Corrected focused F3 + D3 + R-03 | 67/67 |
| Complete clean-install Linux gateway, real Redis/PG | 172/172 |
| Workspace build/lint and 19-workspace tests | build/lint pass; 4,164/4,164 |
| PostgreSQL persistence / API / backup-restore scripts | 210/210; 109/109; 2/2 |
| Guard script tests / load-harness contracts | 333/333; 86/86 |
| Actual Nginx trusted-edge / web-delivery | 8/8; 12/12 |
| Linux POSIX API / load | 2/2; 1/1 |
| Eight repository guards | pass |

All positive counted suites have zero failures, skips, cancellations and TODOs.
The corrected gateway run uses the existing Dockerfile.gateway-test, whose clean
Linux dependency installation and production build order are unchanged. Native
gateway dependencies were also reinstalled with npm ci. Source-backed scripts
and logs are retained in ignored `test-results/r02/`; the baseline REDs and failed
Linux/diagnostic runs remain separate, not subtracted from acceptance counts.
Final pushed-head CI and fresh review attestation are reported in the PR handoff,
not preemptively recorded as successful here.

## Limits and remaining findings

Boundary-controlled schedules and actual Redis/PG suites are not deployed
multi-process cluster, production load or long-duration memory certification.
Old admitted work intentionally finishes under the existing contract; this PR
does not implement durable fencing or recovery.

F1 terminal ownership retirement, F2 authority-cache policy and F4 abandoned
claim metadata remain open and unchanged. F1/F2 need owner-approved semantics;
F4 remains a separate confirmed defect. No merge or deployment is authorized.
Final pushed-head CI, substantive Qodo Bugs/Rules/actionable gaps zero, fresh
Greptile zero actionable findings, resolved threads and HEAD equality remain
separate delivery gates; this source checkpoint does not claim their completion.
