# ADR 0176: Adjudication Through the Live Gateway (Issue #124)

- **Status**: Proposed / Bounded Scope (Issue #124). Behind `ADJUDICATION_ENABLED`, off by default; no rollout authority.
- **Date**: 2026-11-05
- **References**: Issue #124, [ADR 0174](0174-durable-adjudication-persistence.md), [ADR 0175](0175-adjudication-worker.md), [ADR 0149](0149-autonomous-flag-expiry.md), `packages/realtime-gateway/src/authority.ts`, `packages/realtime-gateway/src/protocol.ts`, `services/gateway/src/adjudication-worker.ts`, `services/gateway/src/serve.ts`, `services/gateway/src/adjudication-resync.ts`, `packages/realtime-gateway/test/adjudication-authority.test.ts`, `services/gateway/test/adjudication-gateway.integration.test.ts`.

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
   Delivery does not rest on notices at all: only a game that is proving or stopped can be changed
   by the worker. Every pass, `AdjudicationResync` unions candidates from resident authority proving/stopped state
   (`authority.adjudicatingGames()`) and bounded locally watched room hints (`watched.watchedAdjudicatingGames()`),
   supplemented by a bounded fair round-robin batch of locally watched rooms (`watched.localGameIds()`),
   and routes `adjudicationChanged` through the canonical `CommandRouter`. The command router directs the command to
   the current owner, or claims ownership via Redis router fallback if the previous owner died, folding the durable log
   and broadcasting whatever the worker committed. A worker that dies between its commit and notice, or an owner that dies
   before notice delivery (including silent admission), is therefore covered with no publication table, cursor, or time-window scan.
4. **Recorded releases.** `AdjudicationClocksStarted` is never appended live, so a hot copy or a cold
   rebuild re-derives it with `Game.prepareClockRelease` and refuses a logged release that differs from
   the stop it records.
5. **Protocol.** `StateView.adjudication` is optional and present only for a proving or stopped game.
6. **Service.** `ADJUDICATION_ENABLED=1` (requires `DATABASE_URL`) constructs the store, the admission
   and the worker on every replica; `ADJUDICATION_RULES_VERSION` names the rules lineage.

## Consequences

- Off by default. Enabling it requires migrations 0053/0054 and additive 0055 poll indexes, `prepareAdjudicationGuard`,
  a web client that understands the new `state` field, and the owner's explicit production rollout approval
  (Issue #124 HOLD under ADR 0174 §7 owner-approved scope exceptions and lone-king lemma). Lower pure domain and search
  APIs remain ungated, while gateway integration stays off by default.
- With it on, every command waits for its proof: latency is the proof time plus one worker pass.

## Recovery and Delivery Boundaries (Qodo 1852461 & 1857452 Remediation)

1. **Owner death, pre-admission discovery, and bounded observed hints (`AdjudicationResync`, `RealtimeGateway`)**:
   `AdjudicationResync.runPass()` routes `adjudicationChanged` through the canonical `CommandRouter` across candidates from both resident authority copies (`authority.adjudicatingGames()`) and bounded locally watched room hints (`watched.watchedAdjudicatingGames()`), removing the legacy unused `ownership` option. `RealtimeGateway` tracks ephemeral hints when room state frames show `adjudication: 'proving' | 'stopped'`, and clears them when the game is released (`adjudication === undefined`), ended, or when room sessions teardown (`room.size === 0` and join buffers empty). Bounded observed-room hints may also exist during join buffering. These hints are never treated as authoritative Game mutations and bypass no ownership or rehydration fencing; they enable survivor replicas to discover and recover games where clients connected before remote admission. When an owner dies, the survivor acquires canonical ownership via Redis router fallback, rehydrates from the durable log, and broadcasts settled/released states without waiting for player action.

2. **Durable adjudication suffix-scoped reload replay (`GameAuthority.refreshSlot`)**:
   During takeover reload (`authority.reloadFromLog` / `refreshSlot`), broadcast re-emission is strictly scoped by `hasAdjudicationRecoveryEvidence(previous, newRecord)`. Broadcasts and updated state are emitted only when the prior resident was actively proving/stopped or when the newly validated durable suffix contains genuine adjudication lifecycle events (`AdjudicationStarted`, `AdjudicationResolved`, `AdjudicationClocksStarted`). For ordinary games without adjudication, ordinary reloads (such as losing append races, failed appends, or malformed heads) publish zero broadcasts, preserving no-rebroadcast and slot revival semantics unchanged.

3. **Unwatched remote ended copy eviction (`OwnerCommandConsumer`)**:
   `OwnerCommandConsumer.processCommand` extends server-notice cleanup to recognize `(envelope.userId === ADJUDICATION_ACTOR && envelope.cmd.kind === 'adjudicationChanged')`. When a remote owner loads an unwatched ended game solely to fold a forwarded adjudication notice, `releaseExpiryCopy` evicts the ended copy from memory before replying to the forwarding replica. Preexisting resident copies, watched games with active client sessions, and newer connection fencing remain protected.

4. **Independent per-recipient and per-handler delivery isolation (`Room`, `PubSub`)**:
   - `Room.fanout` catches exceptions on individual member connection sends (`m.conn.send`), ensuring a failing local socket cannot suppress delivery to healthy same-room peers. Point-to-point `Room.sendTo` remains direct.
   - `RedisPubSub.publish` and `InMemoryPubSub.publish` catch exceptions per local subscriber callback. A throwing local subscriber cannot abort remaining local subscribers or suppress step 2 remote Redis fanout. Diagnostic logs strictly redact payloads, moves, FEN strings, and raw Error objects.
   - Best-effort Redis pub/sub semantics remain best-effort without an outbox redesign or durable delivery acknowledgment ledger. `GameAuthority` and `RealtimeGateway.ensureRoom` do not swallow publication failures.

5. **Silent admission recovery via bounded fair periodic check of locally watched rooms (Qodo 1857452 finding 3f11e6cf)**:
   If an owner replica commits `AdjudicationStarted` to PostgreSQL but dies before publishing the proving state frame to Redis, and the worker notice is subsequently lost, survivor replicas where clients pre-connected have neither resident authority proving state nor observed phase hints. `RealtimeGateway.localGameIds()` exposes the set of locally watched rooms and pending join buffers. When a `watched` source is provided to `AdjudicationResync`, `localGameIds` is required. `AdjudicationResync.runPass()` supplements its fast priority candidates (`authority.adjudicatingGames()` and optional `watched.watchedAdjudicatingGames()`) with a bounded batch (`fallbackBatchSize`, default 8) of locally watched rooms selected via an in-memory rotation queue. The queue retains relative FIFO order for surviving rooms across passes, prunes departed rooms, appends new arrivals behind waiting survivors, and rotates chosen/inspected rooms to the back. This eliminates index-shifting starvation under room churn, guaranteeing that retained rooms receive their turn within bounded passes without requiring a persistent arrival ledger or database schema changes. The queue is bounded strictly by currently watched rooms and clears completely when all rooms close. Forwarding `adjudicationChanged` for normal games is a no-op (no suffix in durable log, zero broadcasts published, ordinary commands unaffected); for silently admitted games, the survivor replica claims ownership via Redis fallback, rehydrates from PostgreSQL, and broadcasts the missed move and state frames to connected clients. Global game table scans, unbounded outboxes, and polling of unwatched games remain strictly prohibited.
