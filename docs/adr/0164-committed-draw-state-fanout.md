# ADR 0164: Committed Draw-State Cross-Node Fanout

- **Status**: Delegated technical direction approved; local implementation verified; final review pending
- **Date**: 2026-10-26
- **Deciders**: Root technical approval under owner-delegated correction scope
- **Consulted**: Pi, OpenCode (independent read-only reviews), native boundary review
- **References**: [ADR 0161](0161-durable-state-revision-foundation.md), [ADR 0163](0163-known-gap-client-recovery.md), PR #130

## Context

`DrawOffered` and `DrawDeclined` persist state revisions at unchanged ply. The authoritative game coordinator
publishes broadcasts only for `MovePlayed`, `GameEnded`, and `PlayerReady`. In multi-gateway topologies, gateway
`onSimpleCommand` routes draw actions to authority and delivers the returned full state only to the ingress node's
local room and join buffers. Observers and players connected via peer gateways receive zero cross-node notification.
When a subsequent `MovePlayed` advances ply, remote clients detect an unobserved revision gap and enter client-side
known-gap recovery (ADR 0163), stalling commands and triggering unexpected input gating.

Qodo finding 3 proposed relaxing client gap detection on contiguous ply. However, independent triage (Pi, OpenCode)
verified that intermediate `PlayerReady` events also advance revisions; accepting contiguous ply revision skips would
forfeit full-state synchronization and player-readiness invariants. The defect is server-side publication omission,
not client recovery policy.

## Decision

Extend room PubSub to publish authoritative committed draw state across gateway nodes without widening domain event schemas
or loosening client recovery guarantees.

### 1. Authoritative Publication Scope
- Narrowly extend room PubSub `Broadcast` type union (`GameBroadcast | TournamentUpdateBroadcast | StateMessage`) to carry existing `StateMessage` payloads. Neither `GameBroadcast`, `ApplyResult.broadcasts`, event replay history, nor `resumed.missed` are modified.
- Authority publishes exactly one complete `StateMessage` per successful commit containing `DrawOffered` or `DrawDeclined` (exact one authority publication, not guaranteeing single final delivery if ingress fallback operates), immediately after durable append and hot-record update inside serialized execution, before subsequent commands execute.
- Use committed `viewOf` state once for PubSub fanout and routed command return. Failed commits, malformed heads, and no-ops emit no publication. No additional full-state push is emitted for ordinary move-only commits; no per-recipient read loops are introduced.

### 2. Gateway Equal-Head Reconciliation
- Adjust gateway state receiver filter from `stateRevision <= observedRevision` to `stateRevision < observedRevision`. This allows complete equal-head state frames to reconcile room-level callbacks when a join-buffer callback observes the frame first.
- Client-side monotonic floor invariants, terminal status, session IDs, and uncertainty flags remain authoritative guards against rollback. No new role-bearing frames or synthetic joins are introduced.

### 3. Fallback and Compatibility Retention
- Retain gateway local draw-state response fallback and D1-A bounded stale-result refresh as an OpenCode recommendation and orchestrator choice, not consensus (Pi preferred removing duplicate fallback). While routed results may cause one redundant local full snapshot bounded per committed draw response, retention preserves resilience against delayed or unobserved PubSub delivery without altering D1-A subsystems; PubSub provides no reliable Redis-delivery guarantee. Full-history payload cost scales with move history and the number of committed draw commands. Revisit duplicate pruning separately only with empirical evidence.

## Traceability Requirements

- **Q3-01 Remote Visibility**: Remote clients observe draw offer/decline state across nodes prior to subsequent moves.
- **Q3-02 Non-Gated Continuation**: Ordered draw updates followed by contiguous moves execute without artificial gap recovery.
- **Q3-03 Conservative Fencing**: Unobserved intermediate `PlayerReady` or omitted publications fail closed to gap recovery.
- **Q3-04 Execution Serialization**: State publication occurs post-durable commit and is fenced before next command execution.
- **Q3-05 Invariant Protection**: Stale, duplicate, or equal-head frames cannot regress client floors, clocks, or roles.
- **Q3-06 Recovery Preservation**: Client gap recovery attempt limits, backoff, and manual retry (ADR 0163) remain unchanged.

## Verification and Test Obligations (Required, Not Claimed)

The following tests are required prior to implementation acceptance (review and tests pending, not claimed complete):
1. **Authority Serialization**: Verify publish ordering after durable append; verify zero emission on append failure, invalid head, or no-op.
2. **Multi-Node Cross-Gateway Verification**: Complementary two-layer coverage jointly verifying remote draw visibility and zero client gap resumes: (a) deterministic multi-gateway harness with `GameSync`/`WsClient` confirming zero gap resumes under synthetic in-memory PubSub and shared event log, and (b) 3-gateway integration confirming cross-node draw fanout and origin-forwarded decline under real PostgreSQL and Redis PubSub with `InMemoryConnection` transport (explicitly distinguishing synthetic broker and transport layers without claiming end-to-end real Redis + browser socket certification).
3. **Ordering and Reconciliation**: Join-buffer-first delivery with equal revision reconciliation; duplicate frame idempotence without rollback; reordered or dropped state preserving safe fail-closed recovery.
4. **Full Regression Verification**: Standalone clean gateway install/build/test, full monorepo build/lint/test across all 19 workspaces, ADR/topology guards, and real PostgreSQL/Redis service integration (distinguished from synthetic broker mocks).

## Consequences and Scope Boundaries

- **Successor Boundary**: ADR 0163 remains historically accurate as a web-only increment; ADR 0164 addresses root-cause multi-node fanout. Overall D1 and silent publication loss remain open.
- **Strict Invariants**: No changes to database schema, event models, wire protocol versions, client codecs, dependencies, or permissions.
- **Governance**: Delegated technical direction approved under owner-delegated scope; local implementation verified; final independent review, immutable commit binding, renewed exact-head CI and mandatory provider evidence pending. Owner alone merges.
