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
  AuthorityCommitError,
  CommandOutcomeUnknownError,
  FLAG_ACTOR,
  NO_SHOW_ACTOR,
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
import { OwnershipRegistry, type OwnershipTicket } from './ownership.js';
import {
  ENQUEUE_REQUEST, START_REQUEST, FINISH_REQUEST, SETTLE_REQUEST,
  REQUEST_RETENTION_MS, requestKey, respond,
} from './forwarded-request.js';

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
  /** Total connect/owner-comparison budget for local execution admission. */
  ownershipCheckTimeoutMs?: number;
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
const CMD_PREFIX = 'game:cmd:v2';
const RESP_PREFIX = 'game:resp';

/** Another delivery already admitted this identity; it owns the response. */
class DuplicateForwardedRequest extends Error {}
class UnownedForwardedRequest extends Error {}

interface OwnershipAdmission {
  readonly lifecycleGeneration: number;
  readonly ownership: OwnershipTicket | undefined;
  readonly check: (requireFresh?: boolean) => void;
}

/** Wire format for a forwarded command. */
export interface ForwardedCommand {
  /** Missing versions fail closed: a legacy envelope has no safe execution lifetime. */
  readonly version?: 2;
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

/** Malformed acknowledgements can never establish a confirmed rejection. */
function decodeResult(raw: string): ForwardedResult {
  const result = JSON.parse(raw) as ForwardedResult;
  if (!result || typeof result.ok !== 'boolean' || (result.ok
    ? !Array.isArray(result.events) || !Array.isArray(result.broadcasts) || !result.state || typeof result.state !== 'object'
    : !result.error || typeof result.error.code !== 'string' || typeof result.error.message !== 'string')) {
    throw new Error('Malformed forwarded result');
  }
  return result;
}

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
    span.setAttribute('cmd.error_code', err instanceof AuthorityCommitError ? 'outcome_unknown' : err instanceof AuthorityError ? err.code : 'invalid_command');
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
  private readonly ownershipCheckTimeoutMs: number;
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
    this.ownershipCheckTimeoutMs = opts.ownershipCheckTimeoutMs ?? 1000;
    if (!Number.isFinite(this.ownershipCheckTimeoutMs) || this.ownershipCheckTimeoutMs <= 0) {
      throw new Error('ownershipCheckTimeoutMs must be finite and positive');
    }
    this.consumer = opts.consumer;
    this.consumer.bindOwner(opts.nodeId);
    this.tracer = opts.tracer ?? new NullTracer();
    this.forwardedCommandsCounter = opts.forwardedCommandsCounter;
    this.forwardTimeoutsCounter = opts.forwardTimeoutsCounter;
    this.fastPathCommandsCounter = opts.fastPathCommandsCounter;
    this.forwardLatencyHistogram = opts.forwardLatencyHistogram;
    this.installHooks();
    this.consumer.setOwnershipAdmission(async gameId => {
      const admission = this.captureAdmission(gameId);
      // This is outside apply's slot. START_REQUEST remains the atomic forwarded
      // admission; the original ticket is checked after it and before mutation.
      await this.rehydrateIfStale(gameId);
      return admission;
    });
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
   * Every path that can acquire ownership must go through here. `ensureLoaded()` is a no-op on
   * a cache hit, so reaching `apply()` after a new claim without this would validate against
   * exactly the stale copy this mechanism exists to discard. Forward timeouts do not claim or
   * reapply their request; subsequent new requests use the normal ownership path.
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
    // A valid local lease avoids reacquiring ownership. Execution still compares
    // Redis ownership under the slot after all hydration/command waits.
    if (this.registry.holdsValidLease(gameId)) {
      this.fastPathCommandsCounter?.inc();
      return withCommandSpan(this.tracer, cmd.kind, { traceId: generateTraceId() }, () =>
        this.applyLocal(gameId, userId, cmd),
      );
    }

    // Fallback path: claim/renew lease via Redis, then apply locally or forward.
    const claim = await this.registry.claim(gameId);

    if (claim.owned) {
      // Consumer was started by the onClaimed hook (or already running).
      return withCommandSpan(this.tracer, cmd.kind, { traceId: generateTraceId() }, () =>
        this.applyLocal(gameId, userId, cmd),
      );
    }

    // Another node owns the game — forward the command.
    const commandTraceId = generateTraceId();
    return withCommandSpan(this.tracer, cmd.kind, { traceId: commandTraceId }, (commandSpan) =>
      this.forward(gameId, userId, cmd, commandTraceId, commandSpan.spanId, commandSpan.sampled),
    );
  }

  private async applyLocal(gameId: string, userId: string, cmd: Command): Promise<ApplyResult> {
    const admission = this.captureAdmission(gameId);
    admission.check(false);
    const ownership = admission.ownership;
    if (!ownership) throw new AuthorityError('command_expired', 'Command ownership changed before execution.');
    await this.rehydrateIfStale(gameId);
    admission.check();
    return this.authority.apply(gameId, userId, cmd, {
      lifecycleGeneration: admission.lifecycleGeneration,
      recheckAdmission: admission.check,
      beforeExecute: async () => {
        admission.check();
        if (!(await this.registry.validateTicket(ownership, this.ownershipCheckTimeoutMs))) {
          throw new AuthorityError('command_expired', 'Command ownership could not be verified before execution.');
        }
        admission.check();
      },
    });
  }

  private captureAdmission(gameId: string): OwnershipAdmission {
    const ticket = Object.freeze({ ownership: this.registry.captureTicket(gameId),
      lifecycleGeneration: this.authority.captureLifecycle(gameId) });
    return Object.freeze({ ownership: ticket.ownership, lifecycleGeneration: ticket.lifecycleGeneration, check: (requireFresh = true) => {
      if (!ticket.ownership || !this.registry.isTicketCurrent(ticket.ownership) ||
        !this.authority.isLifecycleCurrent(gameId, ticket.lifecycleGeneration)) {
        throw new AuthorityError('command_expired', 'Command ownership changed before execution.');
      }
      if (requireFresh && this.staleAfterClaim.has(gameId)) {
        throw new AuthorityError('command_expired', 'Command ownership requires a new attempt after reload.');
      }
    } });
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
      version: 2,
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
    const payload = JSON.stringify(envelope);
    const stateKey = requestKey(requestId);
    const timeoutSec = Math.max(1, Math.ceil(this.forwardTimeoutMs / 1000));
    let enqueueConn: Redis | undefined;
    let dispatchStarted = false;
    try {
    // A lost enqueue acknowledgement must never be resent after its tombstone
    // expires. The shared lease client intentionally retries indefinitely; use
    // a connected, non-buffering, non-resending client only for this dispatch.
    enqueueConn = this.requestConnection(timeoutSec * 1000, 1000);
    await enqueueConn.connect();
    dispatchStarted = true;
    await enqueueConn.eval(ENQUEUE_REQUEST, 2, stateKey, cmdKey, payload, timeoutSec * 1000, REQUEST_RETENTION_MS);

    // Wait for the response with a timeout (BLPOP timeout is in seconds).
    // A blocking BLPOP holds its connection until it returns, so it must run
    // on a DEDICATED connection — never the shared command/ownership one, or it
    // would stall ownership claims, lease renewals, and concurrent forwards
    // behind it (ioredis serializes commands on a single connection).
    // Reuse this isolated socket; bounded client I/O also covers a blackholed
    // response connection where Redis's server-side BLPOP timer cannot reply.
    const raw = await enqueueConn.blpop(respKey, timeoutSec);

    if (!raw) {
      timedOut = true;
      forwardSpan.setAttribute('forward.outcome', 'error');
      forwardSpan.setAttribute('forward.timeout', true);
      forwardSpan.setStatus('error');

      // Never reapply on takeover: the owner may already have committed. A
      // subsequent new command can claim/reload through the normal route path.
      return await this.settleForward(stateKey, cmdKey, payload, requestId);
    }

    // blpop returns [key, value]; we only need the value.
    const responsePayload = Array.isArray(raw) ? raw[1] : raw;
    const result = decodeResult(responsePayload);

    if (!result.ok) {
      forwardSpan.setAttribute('forward.outcome', 'error');
      forwardSpan.setAttribute('forward.timeout', false);
      forwardSpan.setStatus('error');

      if (result.error.code === 'outcome_unknown') throw new CommandOutcomeUnknownError(requestId);
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
      if (err instanceof Error && err.message === 'Command timed out') timedOut = true;
      // Covers the throws the branches above do not set attributes for — a Redis failure or a
      // malformed response payload.
      forwardSpan.setAttribute('forward.outcome', 'error');
      forwardSpan.setAttribute('forward.timeout', timedOut);
      forwardSpan.setStatus('error');
      // A Redis transport failure may occur after enqueue or commit. Resolve
      // the same identity, cancel only queued work, and fail unknown if Redis
      // cannot confirm the outcome. Do not turn unknown into invalid_command.
      if (err instanceof AuthorityError) throw err;
      if (!dispatchStarted) throw new AuthorityError('invalid_command', 'Forwarded command was not dispatched.');
      return await this.settleForward(stateKey, cmdKey, payload, requestId);
    } finally {
      enqueueConn?.disconnect();
      const latencySec = (performance.now() - startTime) / 1000;
      this.forwardLatencyHistogram?.observe(latencySec);
      if (timedOut) {
        this.forwardTimeoutsCounter?.inc();
      }
      forwardSpan.end();
    }
  }

  private requestConnection(timeoutMs: number, blockingGraceMs = 0): Redis {
    const conn = this.redis.duplicate({
      lazyConnect: true, enableOfflineQueue: false, autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0, retryStrategy: () => null,
      connectTimeout: timeoutMs, commandTimeout: timeoutMs + blockingGraceMs,
    });
    // Promise failures are classified/traced above. Avoid ioredis's direct
    // unstructured stderr emission for this short-lived request connection.
    conn.on('error', () => undefined);
    return conn;
  }

  private async settleForward(stateKey: string, cmdKey: string, payload: string, requestId: string): Promise<ApplyResult> {
    let settled: string;
    let conn: Redis | undefined;
    try {
      conn = this.requestConnection(Math.max(1000, Math.ceil(this.forwardTimeoutMs / 1000) * 1000));
      await conn.connect();
      settled = String(await conn.eval(SETTLE_REQUEST, 2, stateKey, cmdKey, payload));
    } catch {
      throw new CommandOutcomeUnknownError(requestId);
    } finally {
      conn?.disconnect();
    }
    if (settled === 'expired') throw new AuthorityError('command_expired', 'Forwarded command expired before execution.');
    if (!settled.startsWith('{')) throw new CommandOutcomeUnknownError(requestId);
    let result: ForwardedResult;
    try { result = decodeResult(settled); } catch { throw new CommandOutcomeUnknownError(requestId); }
    if (!result.ok) {
      if (result.error.code === 'outcome_unknown') throw new CommandOutcomeUnknownError(requestId);
      throw new AuthorityError(result.error.code, result.error.message);
    }
    return { events: result.events, broadcasts: result.broadcasts, state: result.state };
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
  private nodeId = '';
  private ownershipAdmission: ((gameId: string) => Promise<OwnershipAdmission>) | undefined;

  /** Router-owned reload debt is prepared outside the slot, never reentrantly. */
  setOwnershipAdmission(prepare: (gameId: string) => Promise<OwnershipAdmission>): void {
    this.ownershipAdmission = prepare;
  }

  /** Installed by the router, before its claim hook can launch a consumer. */
  bindOwner(nodeId: string): void { this.nodeId = nodeId; }
  private running = false;
  private readonly loops = new Map<string, Promise<void>>();
  /** Dedicated blocking connection per loop (BLPOP holds its connection). */
  private readonly blockingConns = new Map<string, Redis>();
  private readonly authority: GameAuthority;
  private readonly redis: Redis;
  private readonly tracer: Tracer;
  private readonly blpopTimeoutSec = 15;

  /** Whether a player or spectator on this node is in the game's room; until wired, every game is watched. */
  private hasLocalSessions: (gameId: string) => boolean = () => true;

  constructor(authority: GameAuthority, redis: Redis, tracer?: Tracer) {
    this.authority = authority;
    this.redis = redis;
    this.tracer = tracer ?? new NullTracer();
  }

  /** Wire the gateway's room check, which exists only after the gateway is built on this router. */
  watchLocalSessions(hasLocalSessions: (gameId: string) => boolean): void {
    this.hasLocalSessions = hasLocalSessions;
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

    // A server expiry forwarded by a replica that lost the race to decide it can arrive after this
    // owner already ended and evicted the game. A copy loaded only to answer it is let go again once
    // the game is over, as the expiry path itself does (ADR-0148/0149); a join that races this
    // reloads. A copy that was already resident, or one a local player joined meanwhile, is never touched.
    const loadedForExpiry =
      (envelope.userId === NO_SHOW_ACTOR || envelope.userId === FLAG_ACTOR) && !this.authority.has(envelope.gameId);
    // Before the response, so the forwarding replica never observes the reply ahead of the eviction.
    const releaseExpiryCopy = (): void => {
      const { gameId } = envelope;
      const unwatched = loadedForExpiry && !this.hasLocalSessions(gameId);
      if (unwatched && this.authority.hasFresh(gameId) && this.authority.getState(gameId).status.over) {
        this.authority.evict(gameId);
      }
    };
    let admitted = false;
    let expiredAtStart = false;
    const executor = randomUUID();
    const stateKey = requestKey(envelope.requestId);
    let response: ForwardedResult;
    try {
      if (envelope.version !== 2) {
        throw new AuthorityError('command_expired', 'Legacy forwarded command has no safe execution lifetime.');
      }
      const ownershipAdmission = await this.ownershipAdmission?.(envelope.gameId);
      await this.authority.ensureLoaded(envelope.gameId);
      const result = await this.authority.apply(
        envelope.gameId,
        envelope.userId,
        envelope.cmd,
        {
          beforeExecute: async () => {
            const status = String(await this.redis.eval(START_REQUEST, 3, stateKey,
              `game:owner:${envelope.gameId}`, `${CMD_PREFIX}:${envelope.gameId}`, raw, this.nodeId, executor, REQUEST_RETENTION_MS));
            if (status === 'not_owner') throw new UnownedForwardedRequest();
            if (status === 'started' || status === 'done') throw new DuplicateForwardedRequest();
            if (status === 'expired') {
              expiredAtStart = true;
              throw new AuthorityError('command_expired', 'Forwarded command expired before execution.');
            }
            if (status !== 'admitted') throw new CommandOutcomeUnknownError(envelope.requestId);
            admitted = true;
            ownershipAdmission?.check();
          },
          requestId: envelope.requestId,
          ...(ownershipAdmission ? { lifecycleGeneration: ownershipAdmission.lifecycleGeneration,
            recheckAdmission: ownershipAdmission.check } : {}),
        },
      );

      response = {
        ok: true,
        events: result.events,
        broadcasts: result.broadcasts,
        state: result.state,
      };
    } catch (err) {
      if (err instanceof UnownedForwardedRequest) {
        // A BLPOP already in flight can deliver after the expiry owner releases
        // its lease and evicts. The load above must not retain that temporary
        // ended copy merely because admission correctly refuses the old owner.
        releaseExpiryCopy();
        this.stopConsumer(envelope.gameId);
        commandSpan.setAttribute('cmd.outcome', 'not_owner');
        commandSpan.setStatus('error');
        commandSpan.end();
        return;
      }
      if (err instanceof DuplicateForwardedRequest) {
        commandSpan.setAttribute('cmd.outcome', 'duplicate');
        commandSpan.setStatus('ok');
        commandSpan.end();
        releaseExpiryCopy();
        return;
      }
      // Domain refusals are definitive. Persistence failures (including a lost
      // commit acknowledgement), publication failures and uncertain admission
      // are never represented as confirmed rejection.
      let errorCode: AuthorityErrorCode = err instanceof AuthorityCommitError || !(err instanceof AuthorityError)
        ? 'outcome_unknown' : err.code;
      response = {
        ok: false,
        error: {
          code: errorCode,
          message: errorCode === 'outcome_unknown'
            ? new CommandOutcomeUnknownError(envelope.requestId).message
            : err instanceof Error ? err.message : String(err),
        },
      };
      if (!admitted && envelope.version === 2 && !expiredAtStart) {
        // Loading can fail before the lock/admission hook. Revoke that queued
        // identity before reporting a definitive failure; a competing executor
        // may have admitted it while we were awaiting the load.
        try {
          const settled = String(await this.redis.eval(SETTLE_REQUEST, 2, stateKey, `${CMD_PREFIX}:${envelope.gameId}`, raw));
          if (settled === 'expired') {
            errorCode = 'command_expired';
            response = { ok: false, error: { code: errorCode, message: 'Forwarded command expired before execution.' } };
          } else if (settled.startsWith('{')) {
            response = decodeResult(settled);
          } else {
            response = { ok: false, error: { code: 'outcome_unknown', message: new CommandOutcomeUnknownError(envelope.requestId).message } };
          }
        } catch {
          response = { ok: false, error: { code: 'outcome_unknown', message: new CommandOutcomeUnknownError(envelope.requestId).message } };
        }
      }
    }
    try {
      commandSpan.setAttribute('cmd.outcome', response.ok ? 'ok' : 'error');
      commandSpan.setStatus(response.ok ? 'ok' : 'error');
      if (!response.ok) commandSpan.setAttribute('cmd.error_code', response.error.code);
      releaseExpiryCopy();
      const encoded = JSON.stringify(response);
      if (admitted) {
        await this.redis.eval(FINISH_REQUEST, 1, stateKey, executor, encoded, REQUEST_RETENTION_MS);
      }
      // Delivery failures must not overwrite a previously recorded success.
      await respond(this.redis, envelope.responseKey, encoded);
    } finally {
      commandSpan.end();
    }
  }
}
