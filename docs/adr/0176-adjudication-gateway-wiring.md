# ADR 0176: Adjudication Through the Live Gateway (Issue #124)

- **Status**: Proposed / Bounded Scope (Issue #124). Behind `ADJUDICATION_ENABLED`, off by default; no rollout authority.
- **Date**: 2026-11-05
- **References**: Issue #124, [ADR 0174](0174-durable-adjudication-persistence.md), [ADR 0175](0175-adjudication-worker.md), [ADR 0149](0149-autonomous-flag-expiry.md), `packages/realtime-gateway/src/authority.ts`, `packages/realtime-gateway/src/protocol.ts`, `services/gateway/src/adjudication-worker.ts`, `services/gateway/src/serve.ts`, `packages/realtime-gateway/test/adjudication-authority.test.ts`, `services/gateway/test/adjudication-gateway.integration.test.ts`.

## Context

ADR 0174 makes adjudication durable and ADR 0175 executes it, but the live game still applies every
command directly. Wiring the two into the gateway must not change anything while the feature is off,
and when it is on, the owner of a game must remain the only writer of its hot copy and broadcasts.

## Decision

1. **Admission port.** `GameAuthorityOptions.adjudication` (an `AdjudicationAdmission`, satisfied by
   `PgAdjudicationStore.startAdjudication`) switches the authority to the adjudicated path. Absent, the
   authority behaves exactly as before; the existing suites run unchanged.
2. **Admitted, not applied.** With the port, the owner refuses any command while a proof is pending,
   checks seat and turn, and admits the command (a server expiry or flag claim as its prepared
   operation, a player command for the store to arbitrate the way the domain does). Only
   `AdjudicationStarted` becomes durable; the room receives a `state` showing `adjudication: 'proving'`.
   A domain refusal maps to `illegal_move`/`invalid_command`; any other failure is an uncertain
   commit and marks the copy for reload.
3. **Owner publishes.** The worker reports each settlement or release with the server-only command
   `adjudicationChanged` (actor `system:adjudication`), routed to the owner exactly like a server expiry
   (ADR 0149). The owner folds the durable suffix into its copy and publishes its move, ready and ending
   broadcasts and a `state` (`stopped` while the clocks are stopped, the field absent once released).
   Before deciding any command the owner also folds whatever the log holds beyond its copy, so a lost
   or late notice cannot leave a game looking proving or stopped once the next command arrives.
4. **Recorded releases.** `AdjudicationClocksStarted` is never appended live, so a hot copy or a cold
   rebuild re-derives it with `Game.prepareClockRelease` and refuses a logged release that differs from
   the stop it records.
5. **Protocol.** `StateView.adjudication` is optional and present only for a proving or stopped game.
6. **Service.** `ADJUDICATION_ENABLED=1` (requires `DATABASE_URL`) constructs the store, the admission
   and the worker on every replica; `ADJUDICATION_RULES_VERSION` names the rules lineage.

## Consequences

- Off by default. Enabling it requires migrations 0053/0054, `prepareAdjudicationGuard`, a web client
  that understands the new `state` field, and the owner's rollout approval (Issue #124 HOLD).
- With it on, every command waits for its proof: latency is the proof time plus one worker pass.
