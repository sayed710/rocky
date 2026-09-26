# ADR-0010: Single-owner game authority with command forwarding

**Status:** Accepted  
**Date:** 2026-07-13  
**Supersedes:** None  
**Related:** [ADR-0008](0008-redis-pubsub.md) (Redis pub/sub fanout), [ADR-0009](0009-kubernetes-helm.md) (Kubernetes Helm chart, §3 single-gateway-replica constraint)

## Context

M14 increments 1–4 delivered a local Docker Compose stack, durable Postgres-backed
game authority, Redis pub/sub cross-node fanout, and a Kubernetes Helm chart. The
gateway is currently pinned to `replicas: 1` because **game-command ownership is not
coordinated across gateway replicas** (ADR-0009 §3).

### The problem

Redis Pub/Sub (ADR-0008) distributes **broadcasts** only; it does not coordinate
**game-command ownership**. Each gateway node runs its own `GameAuthority` instance
with an in-memory hot cache of game state. When two players in the same game connect
to different gateway nodes:

1. Both nodes load the game from the durable Postgres event log into their local
   `GameAuthority`.
2. Player A (on node 1) makes a move. Node 1's authority validates, appends to the
   event log, and broadcasts via Redis pub/sub. Node 2 receives the broadcast and
   fans it out to Player B.
3. Player B (on node 2) now makes a move. Node 2's authority validates against its
   **stale local copy** of the game state (it received the broadcast but did not
   apply the move to its own `Game` aggregate — pub/sub delivers `Broadcast` messages
   to rooms, not to the authority). The optimistic event-store append fails with an
   `EventLogConcurrencyError` because the expected seq no longer matches the Postgres
   log head (node 1 already advanced it).

The result: **spurious move rejections** for any player whose gateway node does not
own the game.

### Protocol constraint

The current WebSocket endpoint is **generic** (`/ws`). The game ID arrives in the
`join` message, not in the URL path or a query parameter. This means a load balancer
**cannot hash by game ID** without protocol or routing changes — at connection time,
the game ID is not yet known.

## Decision options considered

### Option 1: Sticky per-game routing

**Mechanism:** All WebSocket connections for the same game are routed to the same
gateway node. The load balancer hashes the game ID to select a backend.

**Requirements:**
- The game ID must be available at **connection time** for the load balancer to hash.
  Currently it is not — it arrives in the `join` message after the WebSocket upgrade.
- Options to expose it:
  - **Path-based routing:** change the endpoint to `/ws/{gameId}` and configure the
    L7 load balancer (nginx/ingress) to hash on the path segment.
  - **Query-parameter routing:** use `/ws?game={gameId}` and hash on the query param.
  - **Application-level redirect:** the first node receives the `join`, looks up or
    assigns an owner, and sends a `redirect` message with the owning node's URL. The
    client reconnects to the owner. This adds a round-trip and requires the client to
    handle redirects.

**Pros:**
- Simple mental model: one node owns all connections for a game.
- No inter-node command forwarding needed.
- No Redis-based ownership registry needed.

**Cons:**
- **Protocol change required.** Either the URL scheme changes (breaking existing
  clients) or a redirect mechanism is added (extra latency, client complexity).
- **Load imbalance.** A popular game (e.g., a tournament broadcast with 100k
  spectators) hashes to one node, creating a hotspot. The architecture explicitly
  decouples fanout from ownership to avoid this (ARCHITECTURE.md §3).
- **Reconnect fragility.** If the owning node restarts, all clients must reconnect
  and may be re-routed to a different node. The game must be re-loaded from the
  durable log on the new owner. This works but adds latency.
- **No partial migration.** If a node is overloaded, games on it cannot be gradually
  migrated; all connections must be re-routed.

### Option 2: Sharded / single-owner game authority with command forwarding

**Mechanism:** One gateway node is designated the **owner** of each game. The owner
holds the authoritative `GameAuthority` instance and processes all commands. Non-owner
nodes **forward** game commands to the owner via a reliable inter-node channel instead
of rejecting them.

**Ownership registry:** A lightweight Redis-based registry maps `gameId → nodeId`.
Ownership is acquired on first `join` (first node to claim a game wins) and released
on graceful shutdown or lease expiry. The registry is a coordination primitive, not a
command transport.

**Command forwarding:** When a non-owner node receives a `move` or other game command,
it looks up the owner, forwards the command via a reliable channel, and relays the
result back to the client. The client sees a normal acceptance/rejection — it does not
know which node processed the command.

**Reliable transport:** Redis Pub/Sub is fire-and-forget (ADR-0008) and unsuitable for
command forwarding (a lost command means a silently dropped move). We use **Redis
request/response lists** (`RPUSH`/`BLPOP`) or a similar reliable queue per game. The
owner processes commands from its queue in order. This is separate from the pub/sub
broadcast channel, which remains fire-and-forget for fanout.

**Pros:**
- **No protocol change.** The WebSocket endpoint stays `/ws`. The game ID still
  arrives in the `join` message. No client-side changes.
- **No load balancer changes.** Any node can accept any connection. The load balancer
  can use round-robin or least-connections.
- **Correctness.** Exactly one node processes commands for a game. No stale-authority
  rejections.
- **Spectator scaling preserved.** 100k spectators can still spread across all gateway
  nodes; only command processing is pinned to the owner. Broadcasts fan out via
  pub/sub to all nodes holding subscribers (unchanged from ADR-0008).
- **Graceful owner failover.** If the owner node restarts, another node acquires
  ownership on the next command, rehydrates from the durable log, and continues. The
  client experiences a brief delay, not a rejection.

**Cons:**
- **Extra hop for non-owner commands.** A move from a non-owner node adds one
  inter-node round-trip (~1–3ms in a data center). Acceptable for chess (human move
  latency is 100ms+).
- **Redis as a dependency for command path.** If Redis is down, non-owner nodes cannot
  forward commands. The owner node can still process local commands. This is
  acceptable: Redis is already a hard dependency for pub/sub fanout.
- **Ownership registry complexity.** A new component to maintain, with lease/expiry
  semantics. Simpler than sticky routing's protocol change, but not zero-cost.

## Decision

**Choose Option 2: single-owner game authority with command forwarding.**

### Rationale

1. **No protocol change.** The current `/ws` endpoint and `join`-message-based game
   association are preserved. Clients require no changes. This is the decisive factor:
   Option 1 requires either a URL scheme change or a redirect mechanism, both of which
   are breaking or add complexity.

2. **Preserves spectator scaling.** The architecture's core insight (ARCHITECTURE.md
   §3) is that fanout scales with spectators while state ownership scales with active
   games. Option 2 maintains this decoupling: any node can serve spectators, only
   command processing is pinned.

3. **Correctness without load balancer cooperation.** The load balancer does not need
   to understand game semantics. Round-robin or least-connections suffices. This
   avoids coupling between the application and the infrastructure layer.

4. **Practical to implement incrementally.** The ownership registry and forwarding
   layer are additive — they sit alongside the existing pub/sub and authority code
   without changing the domain package's interfaces.

## Design

### 1. Ownership registry (Redis)

**Per-game string keys with real TTLs** (not a hash). Redis has no per-hash-field TTL,
so a single `HSETNX game:owners` hash cannot expire individual games after a crash.
The acquiring node:

1. `SET game:owner:{gameId} {nodeId} NX EX {leaseSec}` — atomically claims ownership
   with a real key-level TTL (default 30s).
2. On success (`OK`), the node is the owner. It starts the owner command consumer for
   that game and loads the game from the durable log if not already cached.
3. On failure (key exists), the node reads the owner's `nodeId` via `GET` and enters
   forwarding mode for that game.

**Lease renewal:** The owner periodically runs a compare-and-expire Lua script
(`GET == self` then `EXPIRE`) every 15s. If the owner crashes, the key TTL expires
and another node can claim with `SET NX EX` on the next command.

**Graceful release:** On shutdown, the owner runs a compare-and-delete Lua script
(`GET == self` then `DEL`) so a successor can claim immediately without waiting for
lease expiry.

### 2. Command forwarding (Redis request/response queues)

Each game has a command queue: `game:cmd:{gameId}` (a Redis list).

- **Owner node:** `BLPOP game:cmd:{gameId}` in a dedicated consumer loop. For each
  dequeued command, it calls `authority.apply()`, then pushes the result to a
  per-request response queue (`game:resp:{requestId}`) included in the command
  envelope.

- **Non-owner node:** On receiving a `move` or game command from a client:
  1. Generate a unique `requestId`.
  2. `RPUSH game:cmd:{gameId}` a JSON envelope: `{requestId, gameId, userId, cmd}`.
  3. `BLPOP game:resp:{requestId}` with a timeout (default 5s).
  4. On response: relay the acceptance/rejection to the client.
  5. On timeout: return a `timeout` rejection to the client. The client can retry.

  Broadcasts (move notifications) still flow via pub/sub — the owner publishes after
  applying the command, and all nodes (including the forwarding node) receive the
  broadcast and fan it out to their local subscribers.

### 3. Authority changes

The `GameAuthority` class is unchanged — it already serializes commands per game and
publishes broadcasts. The new logic lives in the **gateway service** layer:

- An `OwnershipRegistry` class (in `services/gateway/src/ownership.ts`) wraps the
  Redis HSETNX/HDEL/TTL operations.
- A `CommandForwarder` class (in `services/gateway/src/command-forwarder.ts`) wraps
  the RPUSH/BLPOP queue operations.
- The `RealtimeGateway` (domain package) gains an optional `CommandRouter` port that
  the service implements. When a command arrives for a game the node doesn't own, the
  router forwards it; when the node owns the game, the router applies it locally.

### 4. Domain package: CommandRouter port

```typescript
/** Routes a game command to the owning node (local or forwarded). */
export interface CommandRouter {
  /**
   * Apply a command for `gameId`. If this node owns the game, it applies
   * locally. If not, it forwards to the owner and awaits the result.
   * Returns the ApplyResult or throws AuthorityError.
   */
  route(gameId: string, userId: string, cmd: Command): Promise<ApplyResult>;
}
```

The `RealtimeGateway` uses `CommandRouter.route()` instead of calling
`authority.apply()` directly. A `LocalCommandRouter` (used in tests and single-node
dev) delegates directly to `authority.apply()`. A `RedisCommandRouter` (used in
multi-node production) checks ownership and forwards when needed.

### 5. Single-node fallback

When `REDIS_URL` is absent, the gateway uses `LocalCommandRouter` (direct
`authority.apply()`), preserving the zero-config local dev experience — same pattern
as the pub/sub and event-log env gates.

### 6. Timeouts and retries

- **Forward timeout:** 5s (configurable via `CMD_FORWARD_TIMEOUT_MS`). If the owner
  doesn't respond, the client receives a `timeout` rejection and can retry.
- **Queue timeout:** The owner's `BLPOP` uses a 15s timeout, then re-enters the loop.
  This allows the owner to check for shutdown signals.
- **Ownership claim retry:** If `HSETNX` fails (another node owns it), the node reads
  the owner and forwards. If the owner's lease has expired (node crashed), the
  `BLPOP` on the response queue times out; the non-owner node re-attempts ownership
  claim, and if successful, applies the command locally.

### 7. Observability

- **Metrics (Prometheus):**
  - `gateway_owned_games` — gauge of games this node owns.
  - `gateway_forwarded_commands_total` — counter of commands forwarded to other nodes.
  - `gateway_forward_latency_seconds` — histogram of command forwarding round-trip.
  - `gateway_forward_timeouts_total` — counter of forward timeouts.
  - `gateway_ownership_claims_total` — counter of successful ownership claims.
  - `gateway_ownership_releases_total` — counter of ownership releases.

- **Structured logging:** Each forward includes `gameId`, `ownerNodeId`, `requestId`,
  `latencyMs`, and `outcome` (accepted/rejected/timeout).

- **Health endpoint:** The `/health` response includes `ownedGames` count and
  `ownershipRegistry: 'redis' | 'local'`.

### 8. Helm configuration

- `gateway.replicas` default changes from `1` to `2` (this increment).
- The critical constraint comment in `values.yaml` is updated to reflect that
  multi-node operation is now safe.
- New env vars added to the gateway ConfigMap/Deployment:
  - `CMD_FORWARD_TIMEOUT_MS` (default 5000)
  - `OWNERSHIP_LEASE_TTL_SEC` (default 30)
  - `OWNERSHIP_RENEWAL_INTERVAL_SEC` (default 15)
- The `REDIS_URL` env var is now **required** when `gateway.replicas > 1` (documented
  in values.yaml comments and validated at startup).

## Consequences

- **Positive:** The gateway can safely scale to 2+ replicas. Players in the same game
  on different nodes experience correct move processing without spurious rejections.
- **Positive:** No protocol or client changes. The `/ws` endpoint and `join` message
  are unchanged.
- **Positive:** Spectator fanout scaling is preserved — pub/sub remains the broadcast
  mechanism, unchanged from ADR-0008.
- **Positive:** Graceful owner failover via lease expiry. A crashed owner's games are
  claimed by another node within the lease TTL (30s default).
- **Negative:** Non-owner commands add one inter-node round-trip (~1–3ms). Acceptable
  for chess.
- **Negative:** Redis is now a dependency for the command path, not just broadcasts.
  If Redis is down, only the owner node can process commands. This is acceptable
  since Redis is already a hard dependency for pub/sub.
- **Negative:** The ownership registry and command forwarder are new components with
  their own failure modes (lease expiry races, queue timeouts). These are mitigated
  by timeouts, retries, and the durable event log as the ultimate source of truth.

## Future considerations

- **Sticky routing as an optimization:** If load imbalance becomes a problem (e.g.,
  many games cluster on one owner), sticky routing can be added **on top of** this
  design — the load balancer hashes by game ID to reduce forwarding, while the
  ownership registry remains as a fallback. This is additive and non-breaking.
- **Redis Streams for command queues:** If `BLPOP` polling proves inefficient at
  scale, Redis Streams (`XREADGROUP`) can replace the list-based queue with consumer
  groups, providing at-least-once delivery and better observability.
- **Owner migration:** A planned drain (e.g., for node maintenance) can transfer
  ownership by having the old owner `HDEL` and the new owner `HSETNX` in a coordinated
  handshake. This is a future enhancement; today, lease expiry handles unplanned
  owner loss.
- **Sharded authority actors:** The architecture's long-term vision (ARCHITECTURE.md
  §3) is dedicated "Game Authority" shards separate from the realtime gateway. This
  increment's ownership registry is a stepping stone: the same `gameId → nodeId` map
  works whether the "node" is a gateway replica or a dedicated authority shard.

> **Amended in M15 Increment 69 (ADR-0080).** A `SET NX` that creates the owner key is always a new
> claim, even when a renewal that threw had left the game in this node's owned set: the lease had
> lapsed, so another node may have owned and advanced the game, and `onClaimed` must fire so the
> router reloads. The router's reload debt is also tied to the claim that recorded it. See the
> ADR-0080 amendment.
