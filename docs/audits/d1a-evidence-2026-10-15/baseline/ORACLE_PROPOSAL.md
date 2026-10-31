# D1-A current-main deterministic reproduction — oracle proposal

Baseline selected after fresh status/worktrees/branches/fetch-prune and GitHub/main comparison: `4ccf8f48869335e06ac1b1de467d2161869f8fd7`. Inspection checkout remains clean at dbf44d9a4207af6cf6096935693198a8a4954ff0; it is not falsely presented as main. No production file changes, checkout switch or new worktree/project/session/worker.

Harness and frozen source/build/log outputs live only in this directory. run.mjs extracts exact Git objects from main into frozen-src, records source blob and SHA256 identities, bundles with already-installed esbuild and direct core/game aliases, then executes the Node test runner. Production GameAuthority, RealtimeGateway, InMemoryEventLog, InMemoryPubSub, InMemoryConnection, GameSync, WsClient and wire codec are exercised; existing fake socket/scheduler are test-only controls. No package installs, DB/Redis/services, socket network or credentials. This is a hermetic seam reproduction, not PostgreSQL/Redis ownership/MVCC proof.

## Setup and controlled schedule

One writer authority and one passive edge authority share the production in-memory append log and pubsub. Edge publicly hydrates creation at0, then writer commits e2e4/e7e5 before edge join/resume. Edge has no subscribed client during those commits. Warm-cache recovery must serve at least the already-completed writer state; no concurrent-last-millisecond guarantee is tested. Public spectator join avoids readiness writes/ownership changes. Independent cold authority/reload controls verify the same log really contains newer state.

Draw offer/decline and terminal commands keep the same ply but advance actual event seq. Draw publications remain absent; no invented requirement for complete draw broadcast history or D2 fanout. Terminal snapshot recovery differs from missed ended publication. Client cases feed actual production-derived snapshots via actual codec/WsClient/FakeSocket into GameSync on one valid active socket; role/membership acknowledgment is a separate equal-revision control. Snapshot revision is asserted only after explicit full snapshots, not incorrectly inferred from live move state that GameSync does not revision-stamp.

## Proposed cases and expected baseline classification (NOT executed yet)

| ID | Oracle |
|---|---|
| F01 | CONTROL: creation0, moves1/2, same-ply draw offer3/decline4/resign5, exact loaded seq; no new draw broadcast claim. |
| F02 | CONTROL: move+terminal batch frames own-prefix1/2, legal map only intermediate move prefix; final state2 terminal; reload reproduces frames. |
| F03 | CONTROL: malformed integer revisions rejected by revision codec; legacy absent stamp accepted only default/legacy mode. |
| F04 | CONTROL: cold edge returns current terminal snapshot and actual existing broadcast history (draw entries excluded). |
| S01 | CANDIDATE RED: warm non-writer join after completed moves must return current stateRevision/board. |
| S02 | CANDIDATE RED: warm non-writer resume after completed moves must return current stateRevision/board. |
| S03 | CANDIDATE RED: resume lastPly0 includes already-committed move broadcasts; no requirement for nonbroadcast draw entries. |
| S04 | CANDIDATE RED: same-ply draw offer already committed before recovery is represented in returned snapshot. |
| S05 | CANDIDATE RED: terminal command already committed before recovery is represented in returned snapshot. |
| C01 | CANDIDATE RED: fresh full snapshot2 followed by warm-edge resumed0 must not lower full snapshot revision, ply or move list. |
| C02 | CANDIDATE RED: draw snapshot3 followed by older same-ply state2 must not erase draw offer. |
| C03 | CANDIDATE RED: terminal snapshot followed by older live resumed snapshot must not reopen game. |
| F05 | CONTROL: reconnect on a new valid socket with equal revision accepts joined role/membership acknowledgment and preserves durable state. |
| F06 | CHARACTERIZATION: GameSync currently ignores resumed.missed; obsolete snapshot plus later missed frame does not animate/apply it. This pass documents a limitation, not implemented replay. |
| F07 | CONTROL: equal/newer ordinary full state does not confirm uncertain request; exact matching commandConfirmed does, without resend. Terminal/ready intent settlement is not removed. |

A missing API, wrong import, invalid frame, illegal setup move, failed expected history or undecoded message is SETUP_FAILURE, not behavioral RED. Each case prepares and asserts valid controls before its desired invariant assertion; observations include actual messages/state. The actual contract assertion remains failing on a reproduced defect; it is not inverted to turn stale behavior into GREEN. Node child exit1 is expected if candidate assertions fail, but not assumed to prove the right failure. run.json/raw TAP/observations retain actual classification and runner exit; no CI claim.

Review focus: boundary between D1-A server freshness and deferred D1-B client revision floor; absence of owner fencing; chronological server oracle without impossible latest-at-receipt requirement; role-envelope equal revision acceptance; actual-prefix frame shapes and exact R-03 receipt identity. No D1-A implementation, D2 draw distribution, cache policy or fencing work is authorized.
