/**
 * @packageDocumentation
 * Publish/subscribe fanout for authoritative broadcasts.
 *
 * The Game Authority publishes each applied move/terminal event to a per-game
 * channel; every gateway node holding subscribers for that game fans it out to
 * its local connections. This decoupling is what lets 100k spectators watch a
 * single game whose state is owned by one authoritative shard
 * (see `docs/ARCHITECTURE.md` §3).
 *
 * {@link InMemoryPubSub} is the single-process implementation used in tests and
 * for local/dev; {@link RedisPubSub} is the production seam (same interface,
 * backed by Redis pub/sub) — implemented below.
 */

import type { Broadcast } from './protocol';

/** A subscription handle; call to stop receiving messages on a channel. */
export type Unsubscribe = () => void;

/** Minimal pub/sub surface the gateway depends on. */
export interface PubSub {
  /** Publish a broadcast to all subscribers of `channel`. */
  publish(channel: string, msg: Broadcast): void;
  /** Subscribe to `channel`; returns an unsubscribe handle. */
  subscribe(channel: string, handler: (msg: Broadcast) => void): Unsubscribe;
}

/** Channel name for a game's authoritative event stream. */
export function gameChannel(gameId: string): string {
  return `game:${gameId}`;
}

/** Channel name for a live tournament's broadcast stream. */
export function tournamentChannel(tournamentId: string): string {
  return `tournament:${tournamentId}`;
}

/** Global channel carrying every game's terminal `ended` broadcast, for
 *  cross-cutting consumers (e.g. anti-cheat auto-analysis) that must observe
 *  all finished games without subscribing per game. */
export function gamesEndedChannel(): string {
  return 'games:ended';
}

/** Global channel carrying an `ended` broadcast once the `games` projection row for that ending
 *  has committed (ADR-0147). Consumers that read `games` subscribe here, not to
 *  {@link gamesEndedChannel}, which fires before the projection can have caught up. */
export function gamesProjectedEndedChannel(): string {
  return 'games:projected-ended';
}

/** In-process {@link PubSub}. Synchronous delivery, deterministic ordering. */
export class InMemoryPubSub implements PubSub {
  private readonly channels = new Map<string, Set<(msg: Broadcast) => void>>();

  publish(channel: string, msg: Broadcast): void {
    const subs = this.channels.get(channel);
    if (!subs) return;
    // Snapshot so a handler that (un)subscribes during delivery is safe.
    for (const handler of [...subs]) handler(msg);
  }

  subscribe(channel: string, handler: (msg: Broadcast) => void): Unsubscribe {
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(handler);
    return () => {
      const set = this.channels.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) this.channels.delete(channel);
    };
  }

  /** Number of active subscribers on a channel (diagnostics/tests). */
  subscriberCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}

// ── Redis adapter ───────────────────────────────────────────────────────────

/**
 * Minimal Redis client surface that {@link RedisPubSub} depends on. Both
 * `ioredis` and `node-redis` (v4+) satisfy this interface. The adapter uses
 * **two connections**: one dedicated to `SUBSCRIBE` (Redis blocks a connection
 * for subscriptions) and one for `PUBLISH`.
 *
 * The `subscribe`/`unsubscribe` methods on the sub client are expected to be
 * idempotent (both libraries handle duplicate subscribe calls gracefully).
 * The `on('message')` event fires for every message on any subscribed channel;
 * the adapter filters by channel internally.
 */
export interface RedisLike {
  /** Publish a message to a channel. Returns the number of receivers. */
  publish(channel: string, message: string): Promise<number> | number;
  /** Subscribe to a channel. */
  subscribe(channel: string): Promise<void> | void;
  /** Unsubscribe from a channel. */
  unsubscribe(channel: string): Promise<void> | void;
  /** Register a listener for messages arriving on subscribed channels. */
  on(event: 'message', listener: (channel: string, message: string) => void): void;
  /** Remove a previously registered message listener. */
  off(event: 'message', listener: (channel: string, message: string) => void): void;
  /** Close the connection. */
  quit(): Promise<void> | void;
}

/**
 * Wire envelope for Redis pub/sub messages. Wraps the {@link Broadcast} with
 * an `origin` node-id so each node can skip its own messages and avoid
 * double-fanout (the publishing node already delivered locally before
 * publishing to Redis).
 */
interface RedisEnvelope {
  /** Node-id of the publisher; used for self-delivery skip. */
  readonly origin: string;
  /** The broadcast payload. */
  readonly msg: Broadcast;
}

/**
 * Redis-backed {@link PubSub} for multi-node fanout.
 *
 * Design:
 * - **Two connections**: one for SUBSCRIBE (blocked), one for PUBLISH. This is
 *   a Redis protocol requirement — a connection in subscribe mode cannot
 *   publish.
 * - **Origin tagging**: each published message carries the publishing node's
 *   id. When a node receives its own message back via Redis, it skips delivery
 *   (the node already fanned out locally before publishing).
 * - **Ref-counted subscribe/unsubscribe**: multiple local subscribers on the
 *   same channel share a single Redis subscription. The Redis SUBSCRIBE is
 *   issued on the first local subscriber; UNSUBSCRIBE on the last unsubscribe.
 *   This prevents Redis from tracking thousands of duplicate channel
 *   subscriptions per node.
 * - **Channel-filtered delivery**: a single `on('message')` listener routes
 *   each incoming Redis message to the correct local handler set.
 */
export class RedisPubSub implements PubSub {
  private readonly subHandlers = new Map<string, Set<(msg: Broadcast) => void>>();
  private readonly messageListener: (channel: string, payload: string) => void;
  private closed = false;

  /**
   * @param pub Redis connection for PUBLISH commands.
   * @param sub Redis connection for SUBSCRIBE commands.
   * @param nodeId Unique identifier for this gateway node. Used to tag
   *   published messages and skip self-delivery.
   */
  constructor(
    private readonly pub: RedisLike,
    private readonly sub: RedisLike,
    private readonly nodeId: string,
  ) {
    this.messageListener = (channel: string, payload: string): void => {
      if (this.closed) return;
      const subs = this.subHandlers.get(channel);
      if (!subs) return;

      let envelope: RedisEnvelope;
      try {
        envelope = JSON.parse(payload) as RedisEnvelope;
      } catch {
        // Malformed payload — ignore rather than crash the gateway.
        return;
      }

      // Skip self-delivery: the publishing node already fanned out locally.
      if (envelope.origin === this.nodeId) return;

      for (const handler of [...subs]) {
        handler(envelope.msg);
      }
    };

    this.sub.on('message', this.messageListener);
  }

  publish(channel: string, msg: Broadcast): void {
    if (this.closed) return;

    // 1. Deliver to local subscribers synchronously (same as InMemoryPubSub).
    //    The gateway's only local-delivery path is pubsub.subscribe → publish;
    //    without this, the moving player and same-node spectators receive
    //    nothing. The self-origin skip in the message listener below prevents
    //    the Redis echo from double-delivering to these same handlers.
    const subs = this.subHandlers.get(channel);
    if (subs) {
      for (const handler of [...subs]) handler(msg);
    }

    // 2. Fan out to other nodes via Redis (fire-and-forget). Redis delivery is
    //    best-effort; a failed publish is logged but does not throw (the game
    //    state is authoritative, not the pub/sub layer).
    const envelope: RedisEnvelope = { origin: this.nodeId, msg };
    void Promise.resolve(this.pub.publish(channel, JSON.stringify(envelope))).catch((err: unknown) => {
      console.error(`[RedisPubSub] publish failed on channel ${channel}:`, err);
    });
  }

  subscribe(channel: string, handler: (msg: Broadcast) => void): Unsubscribe {
    if (this.closed) return () => {};

    let subs = this.subHandlers.get(channel);
    const isFirst = !subs || subs.size === 0;
    if (!subs) {
      subs = new Set();
      this.subHandlers.set(channel, subs);
    }
    subs.add(handler);

    if (isFirst) {
      // First local subscriber for this channel → issue Redis SUBSCRIBE.
      void Promise.resolve(this.sub.subscribe(channel)).catch((err: unknown) => {
        console.error(`[RedisPubSub] subscribe failed on channel ${channel}:`, err);
      });
    }

    return () => {
      const set = this.subHandlers.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        // Last local subscriber gone → issue Redis UNSUBSCRIBE.
        this.subHandlers.delete(channel);
        void Promise.resolve(this.sub.unsubscribe(channel)).catch((err: unknown) => {
          console.error(`[RedisPubSub] unsubscribe failed on channel ${channel}:`, err);
        });
      }
    };
  }

  /**
   * Close the pub/sub: removes the message listener and quits both Redis
   * connections. After closing, publish and subscribe are no-ops.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.sub.off('message', this.messageListener);
    this.subHandlers.clear();
    await Promise.all([
      Promise.resolve(this.pub.quit()),
      Promise.resolve(this.sub.quit()),
    ]);
  }

  /** Number of local subscribers on a channel (diagnostics/tests). */
  subscriberCount(channel: string): number {
    return this.subHandlers.get(channel)?.size ?? 0;
  }
}
