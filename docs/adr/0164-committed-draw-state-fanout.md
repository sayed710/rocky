# ADR 0164: Committed Draw-State Cross-Node Fanout (Server Foundation)

- **Status**: Delegated technical direction approved; split-specific review and verification pending
- **Date**: 2026-10-26
- **Deciders**: Root technical approval under owner-delegated correction scope
- **Consulted**: Pi, OpenCode (independent read-only reviews), native boundary review
- **References**: [ADR 0161](0161-durable-state-revision-foundation.md), `packages/realtime-gateway/src/authority.ts`, `packages/realtime-gateway/src/gateway.ts`

## Context

`DrawOffered` and `DrawDeclined` persist state revisions at unchanged ply. The authoritative game coordinator
publishes broadcasts only for `MovePlayed`, `GameEnded`, and `PlayerReady`. In multi-gateway topologies, gateway
`onSimpleCommand` routes draw actions to authority and delivers the returned full state only to the ingress node's
local room and join buffers. Observers and players connected via peer gateways receive zero cross-node notification,
omitting draw-state revisions across nodes until later moves advance state.

Independent triage (Pi, OpenCode) verified that intermediate events advance state revisions. Rather than relaxing
client revision checks, the root cause is server publication omission during draw commits. This foundation ADR
specifies the server-side fanout required to publish committed draw state across gateway nodes within a safe 3-PR stack.

## Decision

Extend room PubSub to publish authoritative committed draw state across gateway nodes without modifying domain event schemas
or client protocol message shapes.

### 1. Authoritative Publication Scope
- Narrowly extend room PubSub `Broadcast` type union (`GameBroadcast | TournamentUpdateBroadcast | StateMessage`) to carry existing `StateMessage` payloads. Neither `GameBroadcast`, `ApplyResult.broadcasts`, event replay history, nor `resumed.missed` are modified.
- Authority publishes exactly one complete `StateMessage` per successful commit containing `DrawOffered` or `DrawDeclined` (exact one authority publication, not guaranteeing single final delivery if ingress fallback operates), immediately after durable append and hot-record update inside serialized execution, before subsequent commands execute.
- Use committed `viewOf` state once for PubSub fanout and routed command return. Failed commits, malformed heads, and no-ops emit no publication. No additional full-state push is emitted for ordinary move-only commits; no per-recipient read loops are introduced.

### 2. Gateway Equal-Head Reconciliation
- Adjust gateway state receiver filter from `stateRevision <= observedRevision` to `stateRevision < observedRevision`. This allows complete equal-head state frames to reconcile room-level callbacks when a join-buffer callback observes the frame first.
- Existing client monotonic floor invariants, terminal status, session IDs, and uncertainty handling remain protected. No new role-bearing frames or synthetic joins are introduced.

### 3. Fallback and Compatibility Retention
- Retain gateway local draw-state response fallback and bounded stale-result refresh as an OpenCode recommendation and orchestrator choice, not consensus (Pi preferred removing duplicate fallback). While routed results may cause one redundant local full snapshot bounded per committed draw response, retention preserves resilience against delayed or unobserved PubSub delivery; PubSub provides no reliable Redis-delivery guarantee. Full-history payload cost scales with move history and the number of committed draw commands.

### 4. CI Workflow Trigger Scope
- Remove `branches: [main]` branch filters under `pull_request` in `.github/workflows/ci.yml` and `.github/workflows/pin-parity.yml` while preserving `push: branches: [main]`, path filters, and `permissions: contents: read`.
- This enables pull requests targeting stacked base branches to execute full CI workflows on `pull_request` synchronize events without requiring elevated permissions, `pull_request_target`, or altered security boundaries. Additional base branches consume CI minutes as an explicit bounded operational trade-off.

## Traceability Requirements

- **Q3-01 Remote Visibility (Server Foundation)**: Remote gateways and clients observe draw offer/decline state across nodes prior to subsequent moves.
- **Q3-02 Non-Gated Continuation (Client Companion / Stack)**: Ordered draw updates followed by contiguous moves execute without artificial gap recovery (verified in client stack).
- **Q3-03 Conservative Fencing (Client Companion / Stack)**: Unobserved intermediate readiness or omitted publications fail closed to recovery (verified in client stack).
- **Q3-04 Execution Serialization (Server Foundation)**: State publication occurs post-durable commit and is fenced before next command execution.
- **Q3-05 Invariant Protection (Server Foundation)**: Stale, duplicate, or equal-head frames cannot regress client floors, clocks, or roles.
- **Q3-06 Recovery Preservation (Server Foundation)**: Server changes remain compatible with existing baseline client admission and lifecycle recovery.

## Verification and Test Obligations (Required, Not Claimed)

1. **Authority Serialization**: Verify publish ordering after durable append; verify zero emission on append failure, invalid head, or no-op (`packages/realtime-gateway/test/draw-state-fanout.test.ts`).
2. **Multi-Gateway Integration**: Real 3-gateway suite under PostgreSQL and Redis PubSub with `InMemoryConnection` transport, verifying cross-node draw fanout, owner with no local room, forwarded decline, and next legal move (`services/gateway/test/recovery-freshness.integration.test.ts`).
3. **Ordering and Reconciliation**: Hermetic coverage of join-buffer-first delivery with equal revision reconciliation, duplicate frame idempotence, and origin disconnection while a forwarded route return is held (`recovery-freshness.test.ts`, `subscription-readiness.test.ts`, `packages/realtime-gateway/test/draw-state-fanout.test.ts`).
4. **Split Verification**: Fresh local verification on server base `S` (standalone `npm ci`/build/lint and workspace suites); full client and browser gates validated on companion layers.

## Consequences and Scope Boundaries

- **Split PR Architecture**: Establishes server foundation PR `S`. Client gap recovery features belong to stacked companion PR `C`.
- **Strict Invariants**: No changes to database schema, event models, wire protocol versions, client codecs, dependencies, or permissions. Silent final-publication loss remains open.
- **Governance**: Delegated technical direction approved under owner-delegated scope; split-specific review and verification pending. Owner alone merges.
