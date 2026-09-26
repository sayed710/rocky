/**
 * Redis-backed CommandRouter: routes game commands to the owning node.
 *
 * If this node owns the game, the command is applied locally. If not, the
 * command is forwarded to the owner via a Redis list queue (RPUSH/BLPOP),
 * and the result is relayed back via a per-request response queue.
 *
 * Redis Pub/Sub is NOT used for command forwarding — it is fire-and-forget
 * (ADR-0008). Command forwarding requires reliable delivery, so we use
 * Redis lists with BLPOP for request/response semantics.
 *
 * On ownership claim, the router starts the OwnerCommandConsumer for that
 * game so forwarded commands are actually processed (M14 inc 5 fix).
 *
 * See ADR-0010 for the design rationale.
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  GameAuthority,
  AuthorityError,
  type ApplyResult,
  type AuthorityErrorCode,
  type Command,
  type CommandRouter,
  type GameBroadcast,
  type StateView,
} from '@chess-platform/realtime-gateway';
import type { GameEvent } from '@chess-platform/game';
import {
  type Span,
  type Tracer,
  type Counter,
  type Histogram,
  NullTracer,
  generateTraceId,
  formatTraceparent,
  parseTraceparent,
  isSampled,
} from '@chess-platform/api';
import { OwnershipRegistry } from './ownership.js';

export interface RedisCommandRouterOptions {
  /** The local GameAuthority instance. */
  authority: GameAuthority;
  /** Ownership registry for claim/check operations. */
  registry: OwnershipRegistry;
  /** Redis client for command queue operations (RPUSH/BLPOP). */
  redis: Redis;
  /** This node's unique identifier. */
  nodeId: string;
  /** Timeout for forwarded command responses, in ms (default 5000). */
  forwardTimeoutMs?: number;
  /**
   * Owner command consumer. When this node claims ownership, the router
   * starts the consumer for that game so forwarded commands are processed.
   */
  consumer: OwnerCommandConsumer;
  /** Tracer for span instrumentation. Defaults to NullTracer. */
  tracer?: Tracer;
  /** Optional metric counter for forwarded commands total. */
  forwardedCommandsCounter?: Counter;
  /** Optional metric counter for forward timeouts total. */
  forwardTimeoutsCounter?: Counter;
  /** Optional metric counter for commands served via local lease fast path. */
  fastPathCommandsCounter?: Counter;
  /** Optional metric histogram for command forwarding latency in seconds. */
  forwardLatencyHistogram?: Histogram;
}

const DEFAULT_FORWARD_TIMEOUT_MS = 5000;
const CMD_PREFIX = 'game:cmd';
const RESP_PREFIX = 'game:resp';

/** Wire format for a forwarded command. */
export interface ForwardedCommand {
  readonly requestId: string;
  readonly gameId: string;
  readonly userId: string;
  readonly cmd: Command;
  readonly responseKey: string;
  readonly traceparent?: string;
}

/** Wire format for a successful forwarded command result. */
export interface ForwardedSuccess {
  readonly ok: true;
  readonly events: readonly GameEvent[];
  // Mirrors the authority's `ApplyResult.broadcasts`: the authority only ever
  // emits per-game broadcasts (tournament updates are published separately),
  // so this stays narrower than the full `Broadcast` union.
  readonly broadcasts: readonly GameBroadcast[];
  readonly state: StateView;
}

/** Wire format for a failed forwarded command result. */
export interface ForwardedFailure {
  readonly ok: false;
  readonly error: { readonly code: AuthorityErrorCode; readonly message: string };
}

export type ForwardedResult = ForwardedSuccess | ForwardedFailure;

/** Where a `gateway.command` span sits in the trace: a new root, or a child of a forwarder. */
interface CommandSpanParent {
  readonly traceId: string;
  readonly parentId?: string;
  readonly sampledFlag?: boolean;
}

/**
 * Runs `work` inside a `gateway.command` span and records how it ended.
 *
 * Every command path needs identical bookkeeping — routed locally, forwarded to another node, or
 * consumed as the owner — and writing it inline produced four near-identical copies that could
 * drift apart. `end()` lives in a `finally` because an unended span is never exported at all.
 *
 * Attributes stay on the `BOUNDED_SPAN_ATTRS` whitelist: command kind and outcome, never the game
 * id, user id, or move payload. Span attributes bypass JsonLogger's PII redaction.
 */
async function withCommandSpan<T>(
  tracer: Tracer,
  cmdKind: string,
  parent: CommandSpanParent,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan('gateway.command', {
    traceId: parent.traceId,
    ...(parent.parentId !== undefined ? { parentId: parent.parentId } : {}),
    ...(parent.sampledFlag !== undefined ? { sampledFlag: parent.sampledFlag } : {}),
    kind: 'server',
    attributes: { 'cmd.kind': cmdKind },
  });

  try {
    const result = await work(span);
    span.setAttribute('cmd.outcome', 'ok');
    span.setStatus('ok');
    return result;
  } catch (err) {
    span.setAttribute('cmd.outcome', 'error');
    span.setAttribute('cmd.error_code', err instanceof AuthorityError ? err.code : 'invalid_command');
    span.setStatus('error');
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Adds `gateway.command` spans to a router that has none of its own — the single-node
 * {@link LocalCommandRouter} path. {@link RedisCommandRouter} instruments itself, because only it
 * knows whether a command was applied locally or forwarded, so it must NOT be wrapped in this.
 */
export class TracingCommandRouter implements CommandRouter {
  constructor(
    private readonly inner: CommandRouter,
    private readonly tracer: Tracer = new NullTracer(),
  ) {}

  async route(gameId: string, userId: string, cmd: Command): Promise<ApplyResult> {
    return withCommandSpan(this.tracer, cmd.kind, { traceId: generateTraceId() }, () =>
      this.inner.route(gameId, userId, cmd),
    );
  }
}

/**
 * A CommandRouter backed by Redis. Checks ownership via the
 * OwnershipRegistry; forwards non-owned commands via Redis lists.
 * Starts the owner consumer when this node claims a game.
 */
export class RedisCommandRouter implements CommandRouter {
  private readonly authority: GameAuthority;
  private readonly registry: OwnershipRegistry;
  private readonly redis: Redis;
  private readonly nodeId: string;
  private readonly forwardTimeoutMs: number;
  private readonly consumer: OwnerCommandConsumer;
  private readonly tracer: Tracer;
  /** Games newly claimed by this node whose cached aggregate has not been rehydrated yet. */
  private readonly staleAfterClaim = new Set<string>();
  /**
   * The claim that recorded each game's outstanding reload debt. Reload debt belongs to that
   * claim: a reload begun for an earlier claim read the log before the game moved on elsewhere, so
   * it must not settle a later claim's debt. Numbers come from one process-wide counter and are
   * never reused, so an entry can be dropped once its debt is settled.
   */
  private readonly claimGeneration = new Map<string, number>();
  private claimSequence = 0;
  /** In-flight rehydrations, so concurrent commands for one claim share a single log read. */
  private readonly rehydrations = new Map<string, { readonly generation: number; readonly done: Promise<void> }>();
  private readonly forwardedCommandsCounter: Counter | undefined;
  private readonly forwardTimeoutsCounter: Counter | undefined;
  private readonly fastPathCommandsCounter: Counter | undefined;
  private readonly forwardLatencyHistogram: Histogram | undefined;
  private hooksInstalled = false;

  constructor(opts: RedisCommandRouterOptions) {
    this.authority = opts.authority;
    this.registry = opts.registry;
    this.redis = opts.redis;
    this.nodeId = opts.nodeId;
    this.forwardTimeoutMs = opts.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
    this.consumer = opts.consumer;
    this.tracer = opts.tracer ?? new NullTracer();
    this.forwardedCommandsCounter = opts.forwardedCommandsCounter;
    this.forwardTimeoutsCounter = opts.forwardTimeoutsCounter;
    this.fastPathCommandsCounter = opts.fastPathCommandsCounter;
    this.forwardLatencyHistogram = opts.forwardLatencyHistogram;
    this.installHooks();
  }

  /**
   * Wire ownership hooks so claiming a game starts the consumer and
   * releasing stops it. Idempotent.
   */
  private installHooks(): void {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    this.registry.setHooks({
      onClaimed: (gameId) => {
        // Taking ownership means this node may hold a stale aggregate: while another node
        // owned the game, its moves arrived here as pub/sub BROADCASTS, which fan out to
        // rooms and never touch the local authority. Applying a command against that copy
        // rejects legal moves — the exact failure ADR-0010 was written to eliminate,
        // reappearing at the moment of failover.
        //
        // The reload cannot happen here: this hook is synchronous, and rehydrating is not.
        // Evicting alone is worse than doing nothing, because apply() does not hydrate on a
        // cache miss — it answers `unknown_game`. So record the debt and settle it on the
        // async command path, in route().
        this.claimGeneration.set(gameId, ++this.claimSequence);
        this.staleAfterClaim.add(gameId);
        this.consumer.startConsumer(gameId);
      },
      onReleased: (gameId) => this.consumer.stopConsumer(gameId),
    });
  }

  /**
   * Settle the reload debt recorded by `onClaimed` before this node acts as the authority for a
   * game it has only just taken over.
   *
   * Every path that can acquire ownership must go through here, not just the common one: the
   * forward-timeout path claims the game too, and `ensureLoaded()` is a no-op on a cache hit, so
   * reaching `apply()` from there without this would validate against exactly the stale copy this
   * whole mechanism exists to discard.
   *
   * Concurrent commands for the same claim share one log read rather than each issuing their own.
   * The stale mark is cleared only on success, and only by a reload started for the current claim:
   * if ownership was lost and re-claimed while an older reload was still reading, that reload's
   * snapshot predates the other owner's moves, so this starts a new reload at once; for a game in
   * this node's cache it queues behind the older one on the game's command lock, so it reads the
   * log after it. A failed reload is retried by the next command instead of being silently
   * forgotten.
   */
  private async rehydrateIfStale(gameId: string): Promise<void> {
    while (this.staleAfterClaim.has(gameId)) {
      const generation = this.claimGeneration.get(gameId) ?? 0;
      let inFlight = this.rehydrations.get(gameId);
      if (inFlight?.generation !== generation) {
        const done: Promise<void> = this.authority
          .reloadFromLog(gameId)
          .then(() => {
            if (this.claimGeneration.get(gameId) !== generation) return;
            this.staleAfterClaim.delete(gameId);
            this.claimGeneration.delete(gameId);
          })
          .finally(() => {
            if (this.rehydrations.get(gameId)?.done === done) this.rehydrations.delete(gameId);
          });
        inFlight = { generation, done };
        this.rehydrations.set(gameId, inFlight);
      }
      await inFlight.done;
    }
  }

  /**
   * Become (or confirm being) the owner of `gameId` and settle any takeover reload, without
   * applying a command. Resolves `false` when another node owns the game.
   *
   * This is `route()`'s ownership step on its own, for callers that must decide what to submit
   * from the authoritative state — the engine bot (ADR-0080) — and so need that state fresh
   * BEFORE they compute. A non-owner's cached copy never sees the owner's moves.
   */
  async prepareOwnership(gameId: string): Promise<boolean> {
    if (!this.registry.holdsValidLease(gameId) && !(await this.registry.claim(gameId)).owned) {
      return false;
    }
    await this.rehydrateIfStale(gameId);
    // The reload is I/O; the lease can lapse or change hands while it runs.
    return this.holdsOwnership(gameId);
  }

  /**
   * Synchronous re-check that this node still holds a valid lease on a copy with no reload debt.
   * A lease lost and re-claimed while a caller was awaiting leaves reload debt, so it reads false.
   */
  holdsOwnership(gameId: string): boolean {
    return this.registry.holdsValidLease(gameId) && !this.staleAfterClaim.has(gameId);
  }

  async route(gameId: string, userId: string, cmd: Command): Promise<ApplyResult> {
    // Fast path: if this node holds a valid, non-expired local lease for gameId outside
    // the safety margin, apply locally immediately without touching Redis.
    // Preserves takeover rehydration (rehydrateIfStale) if the game was newly claimed.
    if (this.registry.holdsValidLease(gameId)) {
      this.fastPathCommandsCounter?.inc();
      await this.rehydrateIfStale(gameId);
      return withCommandSpan(this.tracer, cmd.kind, { traceId: generateTraceId() }, () =>
        this.authority.apply(gameId, userId, cmd),
      );
    }

    // Fallback path: claim/renew lease via Redis, then apply locally or forward.
    const claim = await this.registry.claim(gameId);

    if (claim.owned) {
      await this.rehydrateIfStale(gameId);
      // Consumer was started by the onClaimed hook (or already running).
      return withCommandSpan(this.tracer, cmd.kind, { traceId: generateTraceId() }, () =>
        this.authority.apply(gameId, userId, cmd),
      );
    }

    // Another node owns the game — forward the command.
    const commandTraceId = generateTraceId();
    return withCommandSpan(this.tracer, cmd.kind, { traceId: commandTraceId }, (commandSpan) =>
      this.forward(gameId, userId, cmd, commandTraceId, commandSpan.spanId, commandSpan.sampled),
    );
  }

  /**
   * Forward a command to the owning node via a Redis list queue.
   * The owner processes it and pushes the result to a response queue.
   *
   * Important: do NOT DEL the response key after RPUSH — that races the
   * sender's BLPOP and can eat the response. The sender's BLPOP consumes
   * the value; use a short EXPIRE on the response key for cleanup.
   */
  private async forward(
    gameId: string,
    userId: string,
    cmd: Command,
    parentTraceId: string,
    parentSpanId: string,
    parentSampled: boolean,
  ): Promise<ApplyResult> {
    const requestId = `${this.nodeId}-${randomUUID()}`;
    const cmdKey = `${CMD_PREFIX}:${gameId}`;
    const respKey = `${RESP_PREFIX}:${requestId}`;

    this.forwardedCommandsCounter?.inc();
    const startTime = performance.now();

    const forwardSpan = this.tracer.startSpan('gateway.forward', {
      traceId: parentTraceId,
      parentId: parentSpanId,
      sampledFlag: parentSampled,
      kind: 'client',
    });

    const traceparent = formatTraceparent({
      traceId: parentTraceId,
      spanId: forwardSpan.spanId,
      sampled: forwardSpan.sampled,
    });

    const envelope: ForwardedCommand = {
      requestId,
      gameId,
      userId,
      cmd,
      responseKey: respKey,
      ...(traceparent ? { traceparent } : {}),
    };

    // `forwardSpan.end()` lives in the `finally` below: rpush, blpop and JSON.parse can all throw,
    // and a span that is never ended is never exported — the failure would be invisible in exactly
    // the case most worth seeing.
    let timedOut = false;
    try {
    // Push the command to the owner's queue (non-blocking, shared connection).
    await this.redis.rpush(cmdKey, JSON.stringify(envelope));

    // Wait for the response with a timeout (BLPOP timeout is in seconds).
    // A blocking BLPOP holds its connection until it returns, so it must run
    // on a DEDICATED connection — never the shared command/ownership one, or it
    // would stall ownership claims, lease renewals, and concurrent forwards
    // behind it (ioredis serializes commands on a single connection).
    const timeoutSec = Math.max(1, Math.ceil(this.forwardTimeoutMs / 1000));
    const blockingConn = this.redis.duplicate();
    let raw: [string, string] | null;
    try {
      raw = await blockingConn.blpop(respKey, timeoutSec);
    } finally {
      blockingConn.disconnect();
    }

    if (!raw) {
      timedOut = true;
      forwardSpan.setAttribute('forward.outcome', 'error');
      forwardSpan.setAttribute('forward.timeout', true);
      forwardSpan.setStatus('error');

      // Timeout — the owner may have crashed. Try to claim ownership.
      // If the owner's lease has expired, SET NX EX succeeds.
      // The forward genuinely failed even when this recovery succeeds, so the span above stays
      // an error; the enclosing gateway.command span is what records the command's real outcome.
      const reclaimed = await this.registry.claim(gameId);
      if (reclaimed.owned) {
        // This is a takeover: the previous owner stopped answering. Whatever this node has cached
        // predates its ownership, so it must be replaced from the log before the command that
        // triggered the takeover is applied.
        await this.rehydrateIfStale(gameId);
        await this.authority.ensureLoaded(gameId);
        return this.authority.apply(gameId, userId, cmd);
      }
      throw new AuthorityError('invalid_command', 'command forward timeout');
    }

    // blpop returns [key, value]; we only need the value.
    const payload = Array.isArray(raw) ? raw[1] : raw;
    const result = JSON.parse(payload) as ForwardedResult;

    if (!result.ok) {
      forwardSpan.setAttribute('forward.outcome', 'error');
      forwardSpan.setAttribute('forward.timeout', false);
      forwardSpan.setStatus('error');

      throw new AuthorityError(
        result.error.code,
        result.error.message,
      );
    }

    forwardSpan.setAttribute('forward.outcome', 'ok');
    forwardSpan.setAttribute('forward.timeout', false);
    forwardSpan.setStatus('ok');

    // Broadcasts were already published by the owner via pub/sub.
    return {
      events: result.events,
      broadcasts: result.broadcasts,
      state: result.state,
    };
    } catch (err) {
      // Covers the throws the branches above do not set attributes for — a Redis failure or a
      // malformed response payload.
      forwardSpan.setAttribute('forward.outcome', 'error');
      forwardSpan.setAttribute('forward.timeout', timedOut);
      forwardSpan.setStatus('error');
      throw err;
    } finally {
      const latencySec = (performance.now() - startTime) / 1000;
      this.forwardLatencyHistogram?.observe(latencySec);
      if (timedOut) {
        this.forwardTimeoutsCounter?.inc();
      }
      forwardSpan.end();
    }
  }
}

/**
 * Consumer loop for the owner node: processes forwarded commands from the
 * Redis queue and pushes results back to the response queue.
 *
 * Must be started via {@link startConsumer} when this node claims a game
 * (wired automatically by {@link RedisCommandRouter} through ownership hooks).
 */
export class OwnerCommandConsumer {
  private running = false;
  private readonly loops = new Map<string, Promise<void>>();
  /** Dedicated blocking connection per loop (BLPOP holds its connection). */
  private readonly blockingConns = new Map<string, Redis>();
  private readonly authority: GameAuthority;
  private readonly redis: Redis;
  private readonly tracer: Tracer;
  private readonly blpopTimeoutSec = 15;
  /** Response key TTL (seconds) so abandoned responses don't leak. */
  private readonly responseTtlSec = 30;

  constructor(authority: GameAuthority, redis: Redis, tracer?: Tracer) {
    this.authority = authority;
    this.redis = redis;
    this.tracer = tracer ?? new NullTracer();
  }

  /**
   * Start consuming commands for a game this node owns.
   * Safe to call multiple times for the same game (idempotent).
   */
  startConsumer(gameId: string): void {
    if (this.loops.has(gameId)) return;
    this.running = true;
    // Dedicated blocking connection: a BLPOP holds its connection until it
    // returns, so each loop needs its own client. Sharing the command/ownership
    // connection would stall claims, lease renewals, and other loops behind it.
    const conn = this.redis.duplicate();
    this.blockingConns.set(gameId, conn);
    const loop = this.consumeLoop(gameId, conn);
    this.loops.set(gameId, loop);
  }

  /** Stop all consumer loops (for graceful shutdown). */
  stop(): void {
    this.running = false;
    this.loops.clear();
    for (const conn of this.blockingConns.values()) conn.disconnect();
    this.blockingConns.clear();
  }

  /** Stop consuming for a specific game (when ownership is released). */
  stopConsumer(gameId: string): void {
    this.loops.delete(gameId);
    const conn = this.blockingConns.get(gameId);
    if (conn) {
      this.blockingConns.delete(gameId);
      conn.disconnect();
    }
  }

  /** Whether a consumer loop is active for `gameId` (diagnostics/tests). */
  isConsuming(gameId: string): boolean {
    return this.loops.has(gameId);
  }

  private async consumeLoop(gameId: string, conn: Redis): Promise<void> {
    const cmdKey = `${CMD_PREFIX}:${gameId}`;
    // Liveness is tracked by `blockingConns`, which is populated *before* this
    // loop launches — unlike `loops`, whose entry is assigned only after this
    // method's synchronous prefix runs (so the first guard check would see it
    // absent and exit immediately).
    while (this.running && this.blockingConns.has(gameId)) {
      try {
        const raw = await conn.blpop(cmdKey, this.blpopTimeoutSec);
        if (!raw) continue; // timeout, loop back

        const payload = Array.isArray(raw) ? raw[1] : raw;
        await this.processCommand(payload);
      } catch (err) {
        // A forced disconnect (stop/stopConsumer) rejects the pending BLPOP;
        // exit quietly in that case rather than logging a spurious error.
        if (!this.running || !this.blockingConns.has(gameId)) break;
        console.error(`[OwnerCommandConsumer] error for ${gameId}:`, err);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  private async processCommand(raw: string): Promise<void> {
    // A malformed payload throws out to consumeLoop, which logs it and backs off. Swallowing it
    // here would drop the message silently — the one failure mode an observability change must
    // not introduce.
    const envelope = JSON.parse(raw) as ForwardedCommand;

    // An older node mid-rollout sends no traceparent, and a malformed one must never be fatal:
    // either way this span starts a new root trace instead of joining the forwarder's.
    const parsedTrace = parseTraceparent(envelope.traceparent);
    const traceId = parsedTrace?.traceId ?? generateTraceId();

    const commandSpan = this.tracer.startSpan('gateway.command', {
      traceId,
      ...(parsedTrace?.parentId ? { parentId: parsedTrace.parentId } : {}),
      ...(parsedTrace ? { sampledFlag: isSampled(parsedTrace.flags) } : {}),
      kind: 'server',
      attributes: {
        'cmd.kind': envelope.cmd.kind,
      },
    });

    try {
      await this.authority.ensureLoaded(envelope.gameId);
      const result = await this.authority.apply(
        envelope.gameId,
        envelope.userId,
        envelope.cmd,
      );

      commandSpan.setAttribute('cmd.outcome', 'ok');
      commandSpan.setStatus('ok');

      const response: ForwardedSuccess = {
        ok: true,
        events: result.events,
        broadcasts: result.broadcasts,
        state: result.state,
      };
      // RPUSH then EXPIRE — do NOT DEL; the sender's BLPOP consumes the value.
      await this.redis.rpush(envelope.responseKey, JSON.stringify(response));
      await this.redis.expire(envelope.responseKey, this.responseTtlSec);
    } catch (err) {
      const errorCode = err instanceof AuthorityError ? err.code : 'invalid_command';
      commandSpan.setAttribute('cmd.outcome', 'error');
      commandSpan.setAttribute('cmd.error_code', errorCode);
      commandSpan.setStatus('error');

      const response: ForwardedFailure = {
        ok: false,
        error: {
          code: errorCode,
          message: err instanceof Error ? err.message : String(err),
        },
      };
      await this.redis.rpush(envelope.responseKey, JSON.stringify(response));
      await this.redis.expire(envelope.responseKey, this.responseTtlSec);
    } finally {
      commandSpan.end();
    }
  }
}
