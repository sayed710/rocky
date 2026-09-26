# ADR-0008: Redis pub/sub for multi-node gateway fanout

**Status:** Accepted  
**Date:** 2026-07-11  
**Supersedes:** None  
**Related:** [ADR-0007](0007-local-stack.md) (local stack, single-node pub/sub)

## Context

M14 increment 1 shipped a local Docker Compose stack with `InMemoryPubSub` for
single-node operation. M14 increment 2 added a durable game authority via an
`EventLog` port + Postgres wiring. The remaining gap for horizontal scaling is
cross-node fanout: when multiple gateway nodes serve spectators for the same
game, a move applied on one node must reach subscribers on all other nodes.

The `PubSub` port already exists in `packages/realtime-gateway/src/pubsub.ts`
with `InMemoryPubSub` implemented and a `RedisPubSub` sketch documented as a
comment. This ADR records the decision to implement that sketch as production
code.

## Decision

Implement `RedisPubSub` as a concrete adapter satisfying the existing `PubSub`
interface, backed by Redis pub/sub.

### Key design choices

1. **Two Redis connections**: one dedicated to `SUBSCRIBE` (Redis blocks a
   connection in subscribe mode), one for `PUBLISH`. This is a Redis protocol
   requirement, not a design preference.

2. **Origin node-id tagging**: each published message is wrapped in a
   `RedisEnvelope` carrying the publishing node's id. When a node receives its
   own message back via Redis, it skips delivery — the node already fanned out
   locally before publishing. This prevents double-fanout.

3. **Ref-counted subscribe/unsubscribe**: multiple local subscribers on the
   same channel share a single Redis subscription. The Redis `SUBSCRIBE` is
   issued on the first local subscriber; `UNSUBSCRIBE` on the last
   unsubscribe. This prevents Redis from tracking thousands of duplicate
   channel subscriptions per node.

4. **Adapter in the service, not the domain package**: the `RedisPubSub` class
   in `packages/realtime-gateway` depends only on a `RedisLike` interface (a
   minimal abstraction over `ioredis` / `node-redis`). The concrete `ioredis`
   binding lives in `services/gateway/src/redis-pubsub.ts` — the infrastructure
   seam, not the dependency-free domain package. This mirrors the
   `EventLog`/Postgres pattern from M14 increment 2.

5. **`REDIS_URL` env gate**: when `REDIS_URL` is set, the gateway uses
   `RedisPubSub`; when absent, it falls back to `InMemoryPubSub` (single-node).
   This preserves the zero-config local dev experience.

6. **Graceful shutdown**: `RedisPubSub.close()` removes the message listener
   and quits both Redis connections. The gateway's shutdown handler calls
   `close` after terminating client sockets.

### Redis client library

`ioredis` is chosen over `node-redis` (v4) because:
- It has a simpler callback/event API that maps cleanly to the `RedisLike`
  interface.
- It is widely deployed and battle-tested in production WebSocket gateways.
- It supports both standalone and cluster mode, so a future migration to Redis
  Cluster for fanout scaling requires no adapter changes.

The dependency enters only in `services/gateway` — the domain package
(`realtime-gateway`) remains dependency-free.

## Consequences

- **Positive**: multi-node gateway scaling is now possible. Any gateway node
  can broadcast to subscribers on any other node. The `PubSub` interface is
  unchanged, so the gateway and authority code is identical between in-memory
  and Redis-backed deployments.

- **Positive**: the Redis adapter is testable hermetically using a `FakeRedis`
  that satisfies `RedisLike` — no real Redis needed for unit tests. Real-Redis
  integration tests are gated behind `REDIS_URL` (same pattern as the
  Postgres-gated persistence tests).

- **Negative**: `ioredis` is a new runtime dependency in the gateway service.
  This is acceptable: the domain packages remain dependency-free, and the
  service is the correct place for infrastructure dependencies.

- **Negative**: Redis pub/sub is fire-and-forget — messages published while a
  node is disconnected are lost. This is acceptable for game broadcasts (the
  authority's event log is the source of truth; a reconnecting client resyncs
  via `resume`/`lastPly`). If durable fanout is needed in the future, Redis
  Streams can replace pub/sub without changing the `PubSub` interface.

## Future considerations

- **Redis Streams**: if durable fanout is needed (e.g. for replay on
  reconnecting nodes), the `RedisLike` interface can be extended to support
  `XADD`/`XREAD` behind the same `PubSub` contract.
- **Redis Cluster**: `ioredis` supports cluster mode natively; the adapter
  requires no changes.
- **Rate limiting**: the same Redis connection can be reused for per-account
  login rate limiting (M4 identity hardening), as noted in PROJECT_STATE §5.

> **Amended in M15 Increment 69 (ADR-0080).** The subscriber connection runs without ioredis's
> ready check (`pubSubConnectionOptions` in `services/gateway/src/redis-pubsub.ts`): a SUBSCRIBE
> written during the handshake made the check's `INFO` fail, and ioredis reset the connection,
> dropping publishes. The publisher keeps the check.
