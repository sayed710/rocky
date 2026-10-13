# ADR-0161: Durable state revision foundation

Date: 2026-10-13
Status: Owner-authorized implementation; manual merge and final review gates pending.
Baseline: `bf0ce91fae99e06daae8348a913c5632c815e94b` after PRs [#110](https://github.com/sayed710/rocky/pull/110) and [#111](https://github.com/sayed710/rocky/pull/111).

## Decision

Use the accepted `stateRevision` name, with no `rev` alias. It is the committed
per-game `game_events.seq`, bounded by PostgreSQL INTEGER: 0 through 2147483647.
`GameCreated` is revision 0. Every subsequent persisted event increments the
revision, including readiness, draw and ending events at the same ply. Repeated
readiness emits no event and retains the head. Sequence exhaustion rejects a
command before append; idempotent readiness remains available.

The server requires the stamp on full `StateView` snapshots (inside `joined`,
`state`, `resumed`, and command results) and existing `move`, `ready`, `ended`
event frames. Each event frame is computed from its own committed prefix.
For a fifty-move command yielding MovePlayed at H+1 and GameEnded at H+2,
the move frame can still carry legal moves; the complete command snapshot is
terminal with an empty legal map and revision H+2. Live and hydrated frames
use the same payload construction. No new draw broadcast is introduced.

Append must return the exact expected head before state, broadcasts or exact
command receipts become visible. A malformed return can follow a successful
commit, so it preserves the existing ambiguous-commit/stale-reload path.
Creation rejects a malformed head without exposing a snapshot. Hydration
validates actual LoggedEvent.seq values: creation at zero, contiguous ascending
integers, no duplicates, gaps, fractions or values outside the database range.
The retained head is the final stored sequence, rather than an array-length
substitute. The committed games projection passes its already validated
terminal `lastSeq` through its internal ending notification as well.

## Compatibility

The web mirror permits legacy absence, exports explicit legacy/revisioned
snapshot types and a validated stamp guard, and keeps default decoding legacy
compatible. A supplied invalid revision never downgrades to legacy. Revisioned
snapshots and supported events require complete field shapes; event stamps are
positive, snapshot stamps nonnegative. `decodeServer(frame, 'revision')` rejects
missing stamps on these messages. Revisioned `resumed.missed` must contain
consistently stamped supported frames; legacy entries cannot mix into it.

| Client/server | Behavior |
| --- | --- |
| Existing client / revised server | Existing message types and fields remain; additive stamps are ignored by the old codec. |
| Revised client / old server | Default codec accepts legacy absence. Revision-only decoding reports unavailable via null; no synchronization guarantee is inferred. |
| Revised client / revised server | Codec validates stamps and revisioned shapes. GameSync activation/recovery remains deferred. |

`clientSeq`, `requestId`, `broadcastSeq`, ply, Redis claim generations and future
PostgreSQL fencing epochs remain separate. Equal state revisions do not confirm
an uncertain command; exact command receipts still identify requestId.

## Evidence and boundaries

The fresh baseline build passed. The initial executable REV-01 through REV-05
and COMP-01 specification compiled, then yielded eight behavioral failures and
one passing bounds-control test. Failures covered missing stamps, the live
batch-prefix legal-map mismatch, ignored persisted sequences, accepted wrong
append heads, and unchecked revisioned wire frames. Additional deterministic
tests cover append barriers, capacity and coercible malformed enum values.
Existing R-03/R-04/D3/D4, variant, readiness and terminal suites remain regression
gates. Exact-head test/reviewer evidence belongs in the PR handoff.

This foundation does not implement D1 coherent recovery, D2 draw fanout,
complete revision replay, stale-state rejection, recovery negotiation, cache
freshness or reliable cross-gateway reconciliation. `resumed.missed` remains
last-ply broadcast history, omits draw events, and GameSync still does not use
it for replay animation. Stamps cannot prevent late external PostgreSQL writes
or substitute for durable writer fencing. R-02 lifecycle/cache work and Helm
recovery remain separate.

References: [open findings](../audits/OPEN_FINDINGS_TRACKER.md),
[D4 ADR-0159](0159-stable-game-slot-hydration.md),
[D3 ADR-0160](0160-execution-time-ownership-admission.md),
[server protocol](../../packages/realtime-gateway/src/protocol.ts),
[authority tests](../../packages/realtime-gateway/test/state-revision.test.ts),
[web codec tests](../../packages/web/test/state-revision.test.ts).
