/**
 * Redis-backed {@link PubSub} adapter for the deployable gateway service.
 *
 * Uses `ioredis` (a single dependency) with two separate connections:
 * one for SUBSCRIBE (blocked by Redis protocol) and one for PUBLISH.
 *
 * The {@link RedisPubSub} class in `@chess-platform/realtime-gateway` implements
 * the domain logic (origin tagging, self-delivery skip, ref-counted subscribe).
 * This file is the **infrastructure binding** — it creates the `ioredis`
 * connections and wires them into the domain adapter. This mirrors the
 * EventLog/Postgres pattern from M14 increment 2: the adapter lives in the
 * service, not in the dependency-free domain package.
 *
 * See ADR-0008 for the decision record.
 */

import { Redis } from 'ioredis';
import { RedisPubSub, type PubSub, type RedisLike } from '@chess-platform/realtime-gateway';

/**
 * Adapt an ioredis client to the domain's minimal {@link RedisLike} port.
 * ioredis's `subscribe`/`unsubscribe` are heavily overloaded and return
 * `Promise<number>`; the port only needs the channel-oriented subset, so we
 * wrap explicitly (instead of an unsafe cast) to keep the boundary type-safe.
 */
function toRedisLike(client: Redis): RedisLike {
  return {
    publish: (channel, message) => client.publish(channel, message),
    subscribe: (channel) => client.subscribe(channel).then(() => undefined),
    unsubscribe: (channel) => client.unsubscribe(channel).then(() => undefined),
    on: (event, listener) => {
      client.on(event, listener);
    },
    off: (event, listener) => {
      client.off(event, listener);
    },
    quit: () => client.quit().then(() => undefined),
  };
}

export interface RedisPubSubOptions {
  /** Redis URL (e.g. `redis://localhost:6379`). */
  url: string;
  /** Unique identifier for this gateway node. */
  nodeId: string;
  /** Optional Redis connection options (e.g. TLS, retry strategy). */
  redisOptions?: Record<string, unknown>;
}

/**
 * The options for the two connections {@link createRedisPubSub} opens.
 *
 * No ready check on the subscriber. ioredis writes SUBSCRIBE while the connection is still
 * handshaking (the command is allowed while Redis loads), so a subscription made right after
 * connecting — at startup, or while reconnecting — can switch the connection to subscriber mode
 * before the ready check's INFO, which Redis then refuses; ioredis treats that as fatal, resets the
 * connection, and anything published meanwhile is lost. The check only waits for Redis to finish
 * loading its dataset, which pub/sub does not need. The publisher keeps it.
 */
export function pubSubConnectionOptions(redisOptions?: Record<string, unknown>): {
  readonly pub: Record<string, unknown>;
  readonly sub: Record<string, unknown>;
} {
  const base = { ...redisOptions, lazyConnect: false };
  return { pub: base, sub: { ...base, enableReadyCheck: false } };
}

/**
 * Create a {@link PubSub} backed by Redis pub/sub.
 *
 * Returns the {@link RedisPubSub} instance (which implements {@link PubSub})
 * along with a `close` function that gracefully shuts down both Redis
 * connections. The caller is responsible for calling `close` on shutdown.
 */
export function createRedisPubSub(opts: RedisPubSubOptions): {
  pubsub: PubSub;
  ping: () => Promise<void>;
  close: () => Promise<void>;
} {
  // Two connections: one for SUBSCRIBE (blocked), one for PUBLISH.
  const options = pubSubConnectionOptions(opts.redisOptions);
  const pub = new Redis(opts.url, options.pub);
  const sub = new Redis(opts.url, options.sub);

  const pubsub = new RedisPubSub(toRedisLike(pub), toRedisLike(sub), opts.nodeId);

  return {
    pubsub,
    ping: async () => {
      await pub.ping();
    },
    close: () => pubsub.close(),
  };
}
