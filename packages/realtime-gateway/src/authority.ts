/**
 * @packageDocumentation
 * The Game Authority: the single owner of live game state.
 *
 * Responsibilities (`docs/ARCHITECTURE.md` §3):
 * - Owns the in-memory {@link Game} aggregate for each live game, keyed by id
 *   (a shard owns a disjoint set of games; one owner per game).
 * - Validates every command via `@chess-platform/game` (which itself uses the
 *   perft-verified core engine) — the server is the sole authority on legality.
 * - Appends emitted events to an append-only log and publishes the resulting
 *   authoritative broadcasts to the game's channel for gateway fanout.
 * - Serializes commands **per game** so concurrent intents can never interleave
 *   and corrupt state (the explicit race-condition guard from the roadmap).
 *
 * The authority is transport-agnostic: it neither knows nor cares whether a
 * command arrived over WebSocket, HTTP, or a test harness.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Game, type GameEvent } from '@chess-platform/game';
import type { Color, Position } from '@chess-platform/core';
import type { CreateGameParams } from '@chess-platform/game';
import { InMemoryEventLog, isStateRevision, nextEventHead, type EventLog, type LoggedEvent } from './event-log';
import type { GameBroadcast, LegalMoves, StateView } from './protocol';
import { gameChannel, gamesEndedChannel, type PubSub } from './pubsub';

/**
 * A command against a game. Every kind but the last three is issued by a seated player through the
 * wire protocol. `ready` is issued by the gateway itself after a seated player's authenticated join,
 * `expireNoShow` only by the server's no-show worker as {@link NO_SHOW_ACTOR} (ADR-0148), and
 * `expireFlag` only by the server's flag worker as {@link FLAG_ACTOR} (ADR-0149); the protocol
 * decoder produces none of them.
 */
export type Command =
  | { readonly kind: 'move'; readonly uci: string }
  | { readonly kind: 'resign' }
  | { readonly kind: 'offerDraw' }
  | { readonly kind: 'acceptDraw' }
  | { readonly kind: 'declineDraw' }
  | { readonly kind: 'claimFlag' }
  | { readonly kind: 'abort' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'expireNoShow' }
  | { readonly kind: 'expireFlag' };

/**
 * The actor that issues `expireNoShow`. Not an account id: player identities come only from verified
 * tokens, and anonymous spectators are `anon-<connection>`, so no client can act as it.
 */
export const NO_SHOW_ACTOR = 'system:no-show';

/** The actor that issues `expireFlag`; like {@link NO_SHOW_ACTOR}, no client can act as it. */
export const FLAG_ACTOR = 'system:flag';

/** Reasons a command can be refused, aligned with the protocol reject codes. */
export type AuthorityErrorCode =
  | 'illegal_move'
  | 'not_your_turn'
  | 'not_a_player'
  | 'unknown_game'
  | 'invalid_command'
  | 'command_expired'
  | 'outcome_unknown'
  | 'not_ready';

/** A refused command. `code` maps directly onto a protocol `RejectCode`. */
export class AuthorityError extends Error {
  constructor(readonly code: AuthorityErrorCode, message: string) {
    super(message);
    this.name = 'AuthorityError';
  }
}

/** Persistence may have committed even when its acknowledgement failed. */
export class AuthorityCommitError extends AuthorityError {
  /** Correlation for a local execution whose persistence acknowledgement failed. */
  readonly requestId = `local-${randomUUID()}`;
}

/** An uncertainty notification, never a confirmed command rejection. */
export class CommandOutcomeUnknownError extends AuthorityError {
  constructor(readonly requestId: string) {
    super('outcome_unknown', 'Command outcome unknown; it may still complete. Check game state before submitting another command.');
  }
}

interface BroadcastLogEntry {
  readonly seq: number;
  readonly ply: number | null;
  readonly msg: GameBroadcast;
}

interface GameRecord {
  game: Game;
  readonly events: GameEvent[];
  readonly broadcasts: BroadcastLogEntry[];
  broadcastSeq: number;
  /** Validated durable-log head, never a broadcast counter. */
  persistedSeq: number;
  /** Set when an uncertain append could not be reconciled with the durable log. */
  stale: boolean;
}

interface Waiter {
  started: boolean;
  cancelled: boolean;
  reject: (e: unknown) => void;
}

/** The serialization boundary outlives every replaceable resident snapshot. */
interface GameSlot {
  record: GameRecord | undefined;
  tail: Promise<void>;
  pending: number;
  generation: number;
  dispose: boolean;
  reloads: number;
  reload: { generation: number; done: Promise<boolean> } | undefined;
  coldLoad: { generation: number; done: Promise<LoadOutcome> } | undefined;
  stalled: { op: 'append' | 'create'; since: number } | undefined;
  waiters: Set<Waiter>;
}

type LoadOutcome = 'loaded' | 'missing' | 'invalidated';

/** Short, stable hash of a FEN string for cheap desync detection. */
export function fenHash(fen: string): string {
  return createHash('sha256').update(fen).digest('hex').slice(0, 12);
}

/**
 * Legal destinations for the side to move, keyed by origin square. Reuses the
 * position's own (perft-verified) move generator — the single source of truth
 * for legality — and collapses promotions to their shared destination square.
 * Returns `{}` for terminal positions (no legal moves).
 */
export function legalMovesOf(position: Position): LegalMoves {
  const byFrom = new Map<string, Set<string>>();
  for (const move of position.legalMoves()) {
    const uci = position.toUci(move);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    let dests = byFrom.get(from);
    if (dests === undefined) {
      dests = new Set<string>();
      byFrom.set(from, dests);
    }
    dests.add(to);
  }
  const out: Record<string, readonly string[]> = {};
  for (const [from, dests] of byFrom) {
    out[from] = [...dests];
  }
  return out;
}

/** The result of applying a command. */
export interface ApplyResult {
  readonly events: readonly GameEvent[];
  readonly broadcasts: readonly GameBroadcast[];
  readonly state: StateView;
}

/** Admission runs under the game slot, after hydration and before domain execution. */
export interface ApplyOptions {
  readonly beforeExecute?: () => Promise<void>;
  /** Final synchronous ticket check after the admission promise resumes this slot. */
  readonly recheckAdmission?: () => void;
  readonly requestId?: string;
  /** A local ownership attempt must not survive eviction/recreation of its slot. */
  readonly lifecycleGeneration?: number;
}

// provisional creation-only budget: preserves the store's 60 s player-lock contention allowance plus 15 s margin; not an approved production configuration (PR #119 owner direction 2026-10-20)
export const DEFAULT_CREATE_TIMEOUT_MS = 75_000;

function invokeSafely<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (err) {
    return Promise.reject(err);
  }
}

interface CommitContext {
  rejectCaller(err: unknown): void;
}

function validateTimeout(val: number | undefined, name: string): void {
  if (val === undefined) return;
  if (!Number.isInteger(val) || val < 1 || val > 600000) {
    throw new RangeError(`${name} must be an integer between 1 and 600000`);
  }
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  return () => clearTimeout(timer);
};

export interface GameAuthorityOptions {
  durableReadTimeoutMs?: number;
  durableWriteTimeoutMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
  durableCreateTimeoutMs?: number;
  onDurableWriteStalled?: (gameId: string, op: 'append' | 'create') => void;
  onDurableWriteSettled?: (gameId: string, op: 'append' | 'create', outcome: 'committed' | 'failed') => void;
}

export class GameAuthority {
  private readonly games = new Map<string, GameSlot>();
  private lifecycleSequence = 0;
  private readonly _durableReadTimeoutMs?: number;
  private readonly durableWriteTimeoutMs?: number;
  private readonly durableCreateTimeoutMs: number;
  private readonly _schedule: (fn: () => void, ms: number) => () => void;
  private readonly onDurableWriteStalled?: (gameId: string, op: 'append' | 'create') => void;
  private readonly onDurableWriteSettled?: (gameId: string, op: 'append' | 'create', outcome: 'committed' | 'failed') => void;
  private _abandonedReadCount = 0;

  constructor(
    private readonly pubsub: PubSub,
    /** Injectable clock so tests are deterministic; defaults to wall time. */
    private readonly now: () => number = () => Date.now(),
    /**
     * Durable event log. Every event is persisted before its broadcast fans
     * out, so a game survives eviction/restart and rehydrates exactly. Defaults
     * to a process-local in-memory log; the deployable service injects the
     * Postgres store (`@chess-platform/persistence`).
     */
    private readonly store: EventLog = new InMemoryEventLog(),
    options: GameAuthorityOptions = {},
  ) {
    validateTimeout(options.durableReadTimeoutMs, 'durableReadTimeoutMs');
    validateTimeout(options.durableWriteTimeoutMs, 'durableWriteTimeoutMs');
    validateTimeout(options.durableCreateTimeoutMs, 'durableCreateTimeoutMs');
    this._durableReadTimeoutMs = options.durableReadTimeoutMs;
    this.durableWriteTimeoutMs = options.durableWriteTimeoutMs;
    this.durableCreateTimeoutMs = options.durableCreateTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;
    this._schedule = options.schedule ?? defaultSchedule;
    this.onDurableWriteStalled = options.onDurableWriteStalled;
    this.onDurableWriteSettled = options.onDurableWriteSettled;
  }

  get durableReadTimeoutMs(): number | undefined {
    return this._durableReadTimeoutMs;
  }

  get schedule(): (fn: () => void, ms: number) => () => void {
    return this._schedule;
  }

  private notifyWriteStalled(gameId: string, op: 'append' | 'create'): void {
    try {
      this.onDurableWriteStalled?.(gameId, op);
    } catch {
      // Invoke every hook inside try/catch; a throwing hook is ignored.
    }
  }

  private notifyWriteSettled(gameId: string, op: 'append' | 'create', outcome: 'committed' | 'failed'): void {
    try {
      this.onDurableWriteSettled?.(gameId, op, outcome);
    } catch {
      // Invoke every hook inside try/catch; a throwing hook is ignored.
    }
  }

  private unavailableError(gameId: string): AuthorityError {
    return new AuthorityError('invalid_command', `game ${gameId} is unavailable: an earlier durable write has not settled`);
  }

  private failUnavailable(gameId: string): never {
    throw this.unavailableError(gameId);
  }

  stalledWriteCount(): number {
    let count = 0;
    for (const slot of this.games.values()) {
      if (slot.stalled !== undefined) {
        count++;
      }
    }
    return count;
  }


  abandonedReadCount(): number {
    return this._abandonedReadCount;
  }

  pendingCommandCount(gameId: string): number {
    return this.games.get(gameId)?.pending ?? 0;
  }

  /** Whether a live game is currently held in the hot cache. */
  has(gameId: string): boolean {
    const slot = this.games.get(gameId);
    return slot?.record !== undefined && !slot.dispose;
  }

  /** A resident game is safe for synchronous edge reads only after any reload completes. */
  hasFresh(gameId: string): boolean {
    const slot = this.games.get(gameId);
    return slot?.record !== undefined && !slot.record.stale && !slot.dispose && slot.reloads === 0;
  }

  private async withDeadline<T>(
    label: string,
    ms: number | undefined,
    op: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (ms === undefined) {
      return invokeSafely(() => op(undefined));
    }
    const controller = new AbortController();
    // reads have no durable effect; a late read result is discarded; writes are fenced instead (see commit)
    let settled = false;
    let timedOut = false;
    let cancelTimer: (() => void) | undefined;
    let rejectCaller!: (err: unknown) => void;
    const callerOutcome = new Promise<never>((_, reject) => {
      rejectCaller = reject;
    });

    const opPromise = invokeSafely(() => op(controller.signal));
    opPromise
      .then(
        () => {
          settled = true;
          if (timedOut) {
            this._abandonedReadCount--;
          }
        },
        () => {
          settled = true;
          if (timedOut) {
            this._abandonedReadCount--;
          }
        },
      );

    cancelTimer = this.schedule(() => {
      if (!settled) {
        timedOut = true;
        this._abandonedReadCount++;
        controller.abort();
        rejectCaller(new AuthorityError('invalid_command', `durable ${label} timed out`));
      }
    }, ms);

    void opPromise.catch(() => {});
    void callerOutcome.catch(() => {});

    try {
      return await Promise.race([opPromise, callerOutcome]);
    } finally {
      cancelTimer?.();
    }
  }

  /**
   * Whether a game exists at all — in the hot cache or the durable log.
   * Unlike {@link has} this consults the store, so an evicted/cold game counts.
   */
  async knows(gameId: string): Promise<boolean> {
    return this.has(gameId) || this.withDeadline('exists', this.durableReadTimeoutMs, (s) => this.store.exists(gameId, s));
  }

  /**
   * Create and register a new game. Throws if the id is already in use (in the
   * hot cache or the durable log). `at` defaults to the authority's clock. The
   * `GameCreated` event is persisted before the game is registered; creation is
   * not a broadcast (joiners receive the full state instead).
   */
  async createGame(params: Omit<CreateGameParams, 'at'> & { at?: number }): Promise<StateView> {
    const slot = this.slotFor(params.gameId);
    if (slot.stalled) {
      this.failUnavailable(params.gameId);
    }

    let rejectCaller!: (err: unknown) => void;
    const callerOutcome = new Promise<never>((_, reject) => {
      rejectCaller = reject;
    });
    const waiter: Waiter = { started: false, cancelled: false, reject: rejectCaller };
    slot.waiters.add(waiter);

    const run = this.enqueue(params.gameId, slot, async () => {
      try {
        if (waiter.cancelled) {
          this.failUnavailable(params.gameId);
        }
        waiter.started = true;
        if (slot.record) {
          throw new AuthorityError('invalid_command', `game ${params.gameId} already exists`);
        }
        const at = params.at ?? this.now();
        // Wrapped for the same reason the persist below is: this function's contract is that a refused
        // creation surfaces as `AuthorityError`, and `Game.create` refuses some of them itself — a
        // `chess960` game without a starting-position id, or any other variant carrying one (ADR-0137).
        // `codeOf` in `gateway.ts` does fall back to `invalid_command` for an unrecognised error, so an
        // escaping `GameError` would already reach the client as the right reject code; this makes that
        // a stated guarantee rather than a lucky default, and keeps the two failure paths in this one
        // function consistent. Raised in the Qodo review of PR #145.
        let game: Game;
        let events: GameEvent[];
        try {
          ({ game, events } = Game.create({ ...params, at }));
        } catch (err) {
          throw new AuthorityError('invalid_command', `cannot create game ${params.gameId}: ${(err as Error).message}`);
        }

        const controller = new AbortController();
        let timedOut = false;
        const cancelTimer = this.schedule(() => {
          timedOut = true;
          controller.abort();
          slot.stalled = { op: 'create', since: this.now() };
          for (const w of slot.waiters) {
            if (!w.started) {
              w.cancelled = true;
              w.reject(this.unavailableError(params.gameId));
            }
          }
          this.notifyWriteStalled(params.gameId, 'create');
          rejectCaller(
            new AuthorityCommitError(
              'invalid_command',
              `game creation for ${params.gameId} timed out; the outcome is unknown and it may still commit`,
            ),
          );
        }, this.durableCreateTimeoutMs);

        // Persist first: an append against a fresh id fails if the game already
        // exists in the durable log, so the store is the single source of truth for
        // uniqueness across restarts.
        const appendP = invokeSafely(() => this.store.append(params.gameId, -1, events, controller.signal));
        let persistedSeq: number;
        try {
          persistedSeq = await appendP;
          this.validateAppendHead(persistedSeq, nextEventHead(-1, events.length));
          slot.record = {
            game,
            events: [...events],
            broadcasts: [],
            broadcastSeq: 0,
            persistedSeq,
            stale: false,
          };
          // Eviction of a not-yet-created game must not discard a successful creation.
          slot.dispose = false;
          if (timedOut) {
            slot.stalled = undefined;
            this.notifyWriteSettled(params.gameId, 'create', 'committed');
          }
          return this.viewOf(game, persistedSeq);
        } catch (err) {
          if (timedOut) {
            slot.stalled = undefined;
            this.notifyWriteSettled(params.gameId, 'create', 'failed');
          }
          const message = `cannot create game ${params.gameId}: ${(err as Error).message}`;
          if (err !== null && typeof err === 'object' && 'appendRejected' in err && err.appendRejected === true) {
            throw new AuthorityError('invalid_command', message);
          }
          throw new AuthorityCommitError('invalid_command', message);
        } finally {
          cancelTimer();
        }
      } finally {
        slot.waiters.delete(waiter);
      }
    });

    void run.catch(() => {});
    void callerOutcome.catch(() => {});
    return Promise.race([run, callerOutcome]);
  }

  /**
   * Ensure a game is resident in the hot cache, hydrating it from the durable
   * log if it was evicted or the process restarted. Returns `false` if no such
   * game exists anywhere. Safe to call repeatedly; a cache hit is a no-op.
   */
  async ensureLoaded(gameId: string): Promise<boolean> {
    const entrySlot = this.games.get(gameId);
    if (entrySlot?.stalled) {
      this.failUnavailable(gameId);
    }
    for (;;) {
      const loopSlot = this.games.get(gameId);
      if (loopSlot?.stalled) {
        this.failUnavailable(gameId);
      }
      if (this.hasFresh(gameId)) return true;
      const slot = this.slotFor(gameId);
      if (slot.stalled) {
        this.failUnavailable(gameId);
      }
      const generation = slot.generation;
      const current = (): boolean => this.games.get(gameId) === slot && slot.generation === generation;
      try {
        // Await the fallible reload result, never the rejection-neutral queue tail.
        if (slot.reloads > 0 && slot.reload?.generation === generation) {
          const loaded = await this.awaitReload(slot, generation);
          if (slot.generation !== generation) continue;
          if (!loaded) return false;
          if (!current()) continue;
        } else {
          let attempt = slot.coldLoad;
          if (attempt?.generation !== generation) {
            // A settled failed reload is retried by a new ordinary load.
            if (slot.reloads === 0) slot.reload = undefined;
            const done = this.enqueue<LoadOutcome>(gameId, slot, async () => {
              if (!current()) return 'invalidated';
              if (slot.record && !slot.record.stale && !slot.dispose) return 'loaded';
              const loaded = await this.refreshSlot(gameId, slot, generation);
              if (!current()) return 'invalidated';
              return loaded ? 'loaded' : 'missing';
            });
            attempt = { generation, done };
            slot.coldLoad = attempt;
          }
          let outcome: LoadOutcome;
          try { outcome = await attempt.done; }
          finally { if (slot.coldLoad === attempt) slot.coldLoad = undefined; }
          if (outcome === 'invalidated' || slot.generation !== generation) continue;
          if (outcome === 'missing') return false;
          // A forced read requested during cold loading supersedes that snapshot.
          const loaded = await this.awaitReload(slot, generation);
          if (slot.generation !== generation) continue;
          if (!loaded) return false;
          if (!current()) continue;
        }
        if (this.hasFresh(gameId)) return true;
      } catch (err) {
        if (slot.generation !== generation) continue;
        throw err;
      }
    }
  }

  private async awaitReload(slot: GameSlot, generation: number): Promise<boolean> {
    let reload = slot.reload;
    while (reload?.generation === generation) {
      const loaded = await reload.done;
      if (slot.reload === reload) return loaded;
      reload = slot.reload;
    }
    return true;
  }

  /**
   * Reload a game from the durable log, replacing any cached copy.
   *
   * Unlike {@link ensureLoaded}, a cache hit does NOT short-circuit: this exists for the moment a
   * node takes over ownership, where the cached copy is precisely what cannot be trusted — the
   * previous owner's moves reached this node as room broadcasts, which never touch the authority.
   *
   * The read and installation use the same slot as cold loading and commands. A forced read
   * always queues its own snapshot after earlier work. Missing durable state clears the resident;
   * failed reads leave it stale, and a later call retries. Eviction invalidates delayed results.
   */
  async reloadFromLog(gameId: string): Promise<boolean> {
    const slot = this.slotFor(gameId);
    if (slot.stalled) {
      this.failUnavailable(gameId);
    }
    const generation = slot.generation;
    if (slot.record) slot.record.stale = true;
    slot.reloads++;
    const done = this.enqueue(gameId, slot, async () => {
      try { return await this.refreshSlot(gameId, slot, generation); }
      finally { slot.reloads--; }
    });
    slot.reload = { generation, done };
    return done;
  }

  /** Preserve the command queue while replacing its state with PostgreSQL truth. */
  private async refreshSlot(gameId: string, slot: GameSlot, generation = slot.generation, revive = true): Promise<boolean> {
    if (generation !== slot.generation) return false;
    if (slot.record) slot.record.stale = true;
    const logged = await this.withDeadline('load', this.durableReadTimeoutMs, (s) => this.store.load(gameId, s));
    if (generation !== slot.generation || this.games.get(gameId) !== slot) return false;
    if (logged.length === 0) {
      slot.record = undefined;
      return false;
    }
    slot.record = this.rebuildRecord(gameId, logged);
    if (revive) slot.dispose = false;
    return true;
  }

  /**
   * Drop a game from the hot cache. Durable state is untouched, so the next
   * access rehydrates it from the log. Intended for finished/idle games to
   * bound memory; a no-op for an unknown id.
   */
  evict(gameId: string): void {
    const slot = this.games.get(gameId);
    if (!slot) return;
    slot.generation = ++this.lifecycleSequence;
    slot.dispose = true;
    this.releaseSlot(gameId, slot);
  }

  private slotFor(gameId: string): GameSlot {
    let slot = this.games.get(gameId);
    if (!slot) {
      slot = {
        record: undefined,
        tail: Promise.resolve(),
        pending: 0,
        generation: ++this.lifecycleSequence,
        dispose: false,
        reloads: 0,
        reload: undefined,
        coldLoad: undefined,
        stalled: undefined,
        waiters: new Set<Waiter>(),
      };
      this.games.set(gameId, slot);
    }
    return slot;
  }

  /** Capture before loading/waiting; slot generations are never reused by this authority. */
  captureLifecycle(gameId: string): number {
    return this.slotFor(gameId).generation;
  }

  isLifecycleCurrent(gameId: string, generation: number): boolean {
    const slot = this.games.get(gameId);
    return slot !== undefined && !slot.dispose && slot.generation === generation;
  }

  /** Pending includes queued work, so disposal cannot create a competing lock. */
  private enqueue<T>(gameId: string, slot: GameSlot, execute: () => Promise<T>): Promise<T> {
    slot.pending++;
    const run = slot.tail.then(execute);
    const finish = (): void => {
      slot.pending--;
      this.releaseSlot(gameId, slot);
    };
    slot.tail = run.then(finish, finish);
    return run;
  }

  private releaseSlot(gameId: string, slot: GameSlot): void {
    if (slot.pending === 0 && slot.stalled === undefined && (slot.dispose || !slot.record) && this.games.get(gameId) === slot) {
      this.games.delete(gameId);
    }
  }

  /**
   * Rebuild a full {@link GameRecord} from a durable event log: the folded
   * {@link Game}, plus the broadcast history replayed exactly as the live path
   * produced it, so resume/catch-up ({@link getMissedSince}) works after a
   * restart.
   */
  private isValidSuffix(suffix: readonly LoggedEvent[], baseSeq: number): boolean {
    if (suffix.length === 0) return false;
    let expected = baseSeq + 1;
    for (const entry of suffix) {
      if (!isStateRevision(entry.seq) || entry.seq !== expected) {
        return false;
      }
      expected++;
    }
    return true;
  }

  private extendRecord(
    gameId: string,
    base: {
      game: Game;
      broadcasts: readonly BroadcastLogEntry[];
      broadcastSeq: number;
      persistedSeq: number;
    },
    suffix: readonly LoggedEvent[],
  ): GameRecord {
    let previous = base.persistedSeq;
    for (const entry of suffix) {
      if (!isStateRevision(entry.seq) || entry.seq !== previous + 1) {
        throw new Error(`invalid durable event sequence for ${gameId}`);
      }
      previous = entry.seq;
    }
    let game = base.game;
    const broadcasts = [...base.broadcasts];
    let broadcastSeq = base.broadcastSeq;
    for (const entry of suffix) {
      const ev = entry.event;
      game = game.withEvents([ev]);
      if (ev.type !== 'MovePlayed' && ev.type !== 'GameEnded' && ev.type !== 'PlayerReady') continue;
      const msg = this.toBroadcast(gameId, ev, game, entry.seq);
      if (!msg) continue;
      const seq = ++broadcastSeq;
      broadcasts.push({ seq, ply: msg.t === 'move' ? msg.ply : null, msg });
    }
    return {
      game,
      events: [],
      broadcasts,
      broadcastSeq,
      persistedSeq: previous,
      stale: false,
    };
  }

  /**
   * Rebuild a full {@link GameRecord} from a durable event log: the folded
   * {@link Game}, plus the broadcast history replayed exactly as the live path
   * produced it, so resume/catch-up ({@link getMissedSince}) works after a
   * restart.
   */
  private rebuildRecord(gameId: string, logged: readonly LoggedEvent[]): GameRecord {
    if (logged.length === 0) {
      throw new Error(`invalid durable event sequence for ${gameId}`);
    }
    const first = logged[0]!;
    if (!isStateRevision(first.seq) || first.seq !== 0) {
      throw new Error(`invalid durable event sequence for ${gameId}`);
    }
    const baseGame = Game.fromEvents([first.event]);
    const base = {
      game: baseGame,
      broadcasts: [] as BroadcastLogEntry[],
      broadcastSeq: 0,
      persistedSeq: 0,
    };
    const record = this.extendRecord(gameId, base, logged.slice(1));
    return {
      ...record,
      events: logged.map((e) => e.event),
    };
  }

  /** Current authoritative state view. Throws if the game is unknown. */
  getState(gameId: string): StateView {
    const record = this.require(gameId);
    if (record.stale) throw new AuthorityError('invalid_command', 'durable game reload is required');
    return this.viewOf(record.game, record.persistedSeq);
  }

  /**
   * Detached read of one committed prefix of the game log.
   *
   * A commit occurring after the load may be absent. This method never installs or reconciles
   * the resident command cache.
   */
  async readRecovery(gameId: string, lastPly: number): Promise<{ state: StateView; missed: GameBroadcast[] }> {
    const slot = this.games.get(gameId);
    if (slot?.stalled) {
      this.failUnavailable(gameId);
    }
    const residentUsable =
      slot?.record !== undefined && !slot.record.stale && !slot.dispose && slot.reloads === 0;

    if (residentUsable && typeof this.store.head === 'function') {
      const R = slot.record!;
      const baseGame = R.game;
      const baseSeq = R.persistedSeq;
      const baseBroadcastLen = R.broadcasts.length;
      const baseBroadcastSeq = R.broadcastSeq;
      const baseBroadcasts = R.broadcasts.slice(0, baseBroadcastLen);

      const h = await this.withDeadline('head', this.durableReadTimeoutMs, (s) =>
        this.store.head!(gameId, s),
      );
      if (h === -1) {
        throw new AuthorityError('unknown_game', `no such game ${gameId}`);
      }

      const currentSlot = this.games.get(gameId);
      const isResidentStillCurrent =
        currentSlot === slot &&
        slot.record === R &&
        !R.stale &&
        !slot.dispose &&
        slot.reloads === 0 &&
        R.persistedSeq >= h;

      if (isResidentStillCurrent) {
        return {
          state: this.viewOf(R.game, R.persistedSeq),
          missed: this.missedFromRecord(R, lastPly),
        };
      }

      if (baseSeq >= h) {
        return {
          state: this.viewOf(baseGame, baseSeq),
          missed: this.missedFromBroadcasts(baseBroadcasts, lastPly),
        };
      }

      if (typeof this.store.loadSince === 'function') {
        const suffix = await this.withDeadline('suffix read', this.durableReadTimeoutMs, (s) =>
          this.store.loadSince!(gameId, baseSeq, s),
        );
        if (this.isValidSuffix(suffix, baseSeq)) {
          const detached = this.extendRecord(
            gameId,
            {
              game: baseGame,
              broadcasts: baseBroadcasts,
              broadcastSeq: baseBroadcastSeq,
              persistedSeq: baseSeq,
            },
            suffix,
          );
          const activeSlot = this.games.get(gameId);
          const activeUsable =
            activeSlot?.record !== undefined &&
            !activeSlot.record.stale &&
            !activeSlot.dispose &&
            activeSlot.reloads === 0;
          const chosen =
            activeUsable && activeSlot.record!.persistedSeq > detached.persistedSeq
              ? activeSlot.record!
              : detached;
          return {
            state: this.viewOf(chosen.game, chosen.persistedSeq),
            missed: this.missedFromRecord(chosen, lastPly),
          };
        }
      }
    }

    const logged = await this.withDeadline('load', this.durableReadTimeoutMs, (s) =>
      this.store.load(gameId, s),
    );
    if (logged.length === 0) {
      throw new AuthorityError('unknown_game', `no such game ${gameId}`);
    }
    const loaded = this.rebuildRecord(gameId, logged);
    const fallbackSlot = this.games.get(gameId);
    const fallbackUsable =
      fallbackSlot?.record !== undefined &&
      !fallbackSlot.record.stale &&
      !fallbackSlot.dispose &&
      fallbackSlot.reloads === 0;
    const chosen =
      fallbackUsable && fallbackSlot.record!.persistedSeq > loaded.persistedSeq
        ? fallbackSlot.record!
        : loaded;
    return {
      state: this.viewOf(chosen.game, chosen.persistedSeq),
      missed: this.missedFromRecord(chosen, lastPly),
    };
  }

  /**
   * Every broadcast a resuming client missed: all broadcasts recorded after the
   * move whose ply equals `lastPly`. `lastPly <= 0` returns the full history.
   */
  getMissedSince(gameId: string, lastPly: number): GameBroadcast[] {
    const rec = this.require(gameId);
    if (rec.stale) throw new AuthorityError('invalid_command', 'durable game reload is required');
    return this.missedFromRecord(rec, lastPly);
  }

  private missedFromRecord(rec: GameRecord, lastPly: number): GameBroadcast[] {
    return this.missedFromBroadcasts(rec.broadcasts, lastPly);
  }

  private missedFromBroadcasts(broadcasts: readonly BroadcastLogEntry[], lastPly: number): GameBroadcast[] {
    if (lastPly <= 0) return broadcasts.map((e) => e.msg);
    let cutSeq = -1;
    for (const e of broadcasts) {
      if (e.ply === lastPly) cutSeq = e.seq;
    }
    return broadcasts.filter((e) => e.seq > cutSeq).map((e) => e.msg);
  }

  /** Resolve a user's seat in a game, or `null` if they are a spectator. */
  colorOf(gameId: string, userId: string): Color | null {
    const record = this.require(gameId);
    if (record.stale) throw new AuthorityError('invalid_command', 'durable game reload is required');
    const { players } = record.game.snapshot();
    if (players.white === userId) return 'w';
    if (players.black === userId) return 'b';
    return null;
  }

  /**
   * Apply a command from `userId`. Serialized per game: the returned promise
   * resolves only after any in-flight command for the same game completes, so
   * two moves can never race. Rejections surface as {@link AuthorityError}.
   */
  apply(gameId: string, userId: string, cmd: Command, options: ApplyOptions = {}): Promise<ApplyResult> {
    const slot = this.games.get(gameId);
    if (!slot || slot.dispose) throw new AuthorityError('unknown_game', `no such game ${gameId}`);
    // Refused before queueing and never executed. Returned as a rejection, not thrown: routers call
    // apply() without an async boundary, and a synchronous throw would escape as a malformed message.
    if (slot.stalled) return Promise.reject(this.unavailableError(gameId));

    let rejectCaller!: (err: unknown) => void;
    const callerOutcome = new Promise<never>((_, reject) => {
      rejectCaller = reject;
    });
    const waiter: Waiter = { started: false, cancelled: false, reject: rejectCaller };
    slot.waiters.add(waiter);

    const ctx: CommitContext = { rejectCaller };

    const run = this.enqueue(gameId, slot, async () => {
      try {
        if (waiter.cancelled) {
          this.failUnavailable(gameId);
        }
        waiter.started = true;
        const checkLifecycle = (): void => {
          if (options.lifecycleGeneration !== undefined &&
            !this.isLifecycleCurrent(gameId, options.lifecycleGeneration)) {
            throw new AuthorityError('command_expired', 'Command ownership lifecycle changed before execution.');
          }
        };
        checkLifecycle();
        if (slot.record?.stale && !(await this.refreshSlot(gameId, slot, slot.generation, false))) {
          throw new AuthorityError('unknown_game', `no durable game ${gameId}`);
        }
        checkLifecycle();
        if (!slot.record) throw new AuthorityError('unknown_game', `no durable game ${gameId}`);
        // Admission may await external validation, but must never enqueue a reload
        // behind the slot it already holds. Select the resident only after admission.
        if (options.beforeExecute) await options.beforeExecute();
        options.recheckAdmission?.();
        checkLifecycle();
        if (options.lifecycleGeneration !== undefined && (slot.record?.stale || slot.reloads > 0)) {
          throw new AuthorityError('command_expired', 'Command requires a fresh ownership attempt after reload.');
        }
        const rec = slot.record;
        if (!rec) throw new AuthorityError('unknown_game', `no durable game ${gameId}`);
        const result = await this.applyNow(gameId, rec, userId, cmd, ctx);
        // Only a successful authoritative execution confirms this exact identity.
        // Position similarity, including a different request's same move, cannot.
        if (options.requestId) this.pubsub.publish(gameChannel(gameId), { t: 'commandConfirmed', gameId, requestId: options.requestId });
        return result;
      } finally {
        slot.waiters.delete(waiter);
      }
    });

    void run.catch(() => {});
    void callerOutcome.catch(() => {});
    return Promise.race([run, callerOutcome]);
  }

  private async applyNow(gameId: string, rec: GameRecord, userId: string, cmd: Command, ctx?: CommitContext): Promise<ApplyResult> {
    const at = this.now();
    if (cmd.kind === 'expireNoShow') {
      // Checked before anything else so a player can never issue it, and the worker never as a seat.
      // The deadline is the game's own durable one; the caller supplies none.
      if (userId !== NO_SHOW_ACTOR) throw new AuthorityError('not_a_player', 'only the server may expire a no-show');
      return this.commit(gameId, rec, this.guard(() => rec.game.expireNoShow(at)), ctx);
    }
    if (cmd.kind === 'expireFlag') {
      if (userId !== FLAG_ACTOR) throw new AuthorityError('not_a_player', 'only the server may expire a clock');
      // Decided here, on the owner's clock and its freshest copy: refused unless the side to move has
      // flagged on a clock the first move started, so a move that committed first always wins.
      if (!rec.game.timeoutDue(at)) throw new AuthorityError('invalid_command', 'Flag expiry refused: not due');
      return this.commit(gameId, rec, rec.game.claimFlag(at), ctx);
    }
    const players = rec.game.snapshot().players;
    const color = players.white === userId ? 'w' : players.black === userId ? 'b' : null;
    if (color === null) {
      throw new AuthorityError('not_a_player', 'only players may issue commands');
    }
    // A player command arriving after a due no-show deadline records the no-show instead, as a move
    // after a flag fall records the timeout. The outcome never depends on how late the worker runs.
    if (rec.game.noShowVerdict(at).kind === 'expire') {
      return this.commit(gameId, rec, rec.game.expireNoShow(at), ctx);
    }
    // Likewise once the side to move has flagged: a late move cannot rescue them, and neither can a
    // resignation or draw that reaches the owner before the flag worker does (ADR-0149).
    if (rec.game.timeoutDue(at)) {
      return this.commit(gameId, rec, rec.game.claimFlag(at), ctx);
    }
    let result: { game: Game; events: GameEvent[] };

    switch (cmd.kind) {
      case 'move': {
        if (rec.game.turn !== color) {
          throw new AuthorityError('not_your_turn', 'it is not your turn');
        }
        // The domain refuses this too; checked here only to give the precise reject code.
        if (rec.game.awaitingReadiness) {
          throw new AuthorityError('not_ready', 'both players must be ready before the first move');
        }
        try {
          result = rec.game.playMove(cmd.uci, at);
        } catch (err) {
          throw new AuthorityError('illegal_move', (err as Error).message);
        }
        break;
      }
      case 'resign':
        result = this.guard(() => rec.game.resign(color, at));
        break;
      case 'offerDraw':
        result = this.guard(() => rec.game.offerDraw(color, at));
        break;
      case 'acceptDraw':
        result = this.guard(() => rec.game.acceptDraw(color, at));
        break;
      case 'declineDraw':
        result = this.guard(() => rec.game.declineDraw(color, at));
        break;
      case 'claimFlag':
        result = this.guard(() => rec.game.claimFlag(at));
        break;
      case 'abort':
        result = this.guard(() => rec.game.abort(at));
        break;
      case 'ready':
        result = rec.game.markReady(color, at);
        break;
      default: {
        const _exhaustive: never = cmd;
        throw new AuthorityError('invalid_command', `unknown command ${JSON.stringify(_exhaustive)}`);
      }
    }
    return this.commit(gameId, rec, result, ctx);
  }

  /** Persist a command's events, then commit them to the hot record and publish their broadcasts. */
  private async commit(
    gameId: string,
    rec: GameRecord,
    result: { game: Game; events: GameEvent[] },
    ctx?: CommitContext,
  ): Promise<ApplyResult> {
    // A no-op (a repeated readiness) changes nothing, so it neither touches the log nor broadcasts.
    if (result.events.length === 0) return { events: [], broadcasts: [], state: this.viewOf(rec.game, rec.persistedSeq) };

    let expectedHead: number;
    try { expectedHead = nextEventHead(rec.persistedSeq, result.events.length); }
    catch (err) { throw new AuthorityError('invalid_command', (err as Error).message); }

    const pending: BroadcastLogEntry[] = [];
    let nextSeq = rec.broadcastSeq;
    let prefix = rec.game;
    for (let i = 0; i < result.events.length; i++) {
      const ev = result.events[i]!;
      prefix = i === result.events.length - 1 ? result.game : prefix.withEvents([ev]);
      if (ev.type !== 'MovePlayed' && ev.type !== 'GameEnded' && ev.type !== 'PlayerReady') continue;
      const msg = this.toBroadcast(gameId, ev, prefix, rec.persistedSeq + i + 1);
      if (!msg) continue;
      pending.push({ seq: ++nextSeq, ply: msg.t === 'move' ? msg.ply : null, msg });
    }

    const slot = this.games.get(gameId);
    const controller = new AbortController();
    let timedOut = false;
    let cancelTimer: (() => void) | undefined;

    if (this.durableWriteTimeoutMs !== undefined) {
      cancelTimer = this.schedule(() => {
        timedOut = true;
        controller.abort();
        if (slot) {
          slot.stalled = { op: 'append', since: this.now() };
          for (const waiter of slot.waiters) {
            if (!waiter.started) {
              waiter.cancelled = true;
              waiter.reject(this.unavailableError(gameId));
            }
          }
        }
        rec.stale = true;
        this.notifyWriteStalled(gameId, 'append');
        ctx?.rejectCaller(
          new AuthorityCommitError(
            'invalid_command',
            `durable append for ${gameId} timed out; the outcome is unknown and it may still commit`,
          ),
        );
      }, this.durableWriteTimeoutMs);
    }

    const appendP = invokeSafely(() => this.store.append(gameId, rec.persistedSeq, result.events, controller.signal));

    try {
      try {
        const returnedHead = await appendP;
        this.validateAppendHead(returnedHead, expectedHead);
        rec.persistedSeq = returnedHead;
        if (timedOut) {
          // Only the write-deadline timer marked the copy untrusted; an independent reload request
          // (reloadFromLog) keeps its own stale mark and refresh.
          rec.stale = false;
          if (slot) slot.stalled = undefined;
          this.notifyWriteSettled(gameId, 'append', 'committed');
        }
      } catch (err) {
        rec.stale = true;
        try {
          const s = this.games.get(gameId);
          if (s) await this.refreshSlot(gameId, s, s.generation, false);
        } catch {
          // A later command must retry the durable reload before using this cache entry.
        } finally {
          if (timedOut) {
            if (slot) slot.stalled = undefined;
            this.notifyWriteSettled(gameId, 'append', 'failed');
          }
        }
        const message = `failed to persist events for ${gameId}: ${(err as Error).message}`;
        if (err !== null && typeof err === 'object' && 'appendRejected' in err && err.appendRejected === true) {
          throw new AuthorityError('invalid_command', message);
        }
        throw new AuthorityCommitError('invalid_command', message);
      }
    } finally {
      cancelTimer?.();
    }

    // Commit to the hot record only after the durable append succeeded.
    rec.game = result.game;
    rec.events.push(...result.events);
    rec.broadcasts.push(...pending);
    rec.broadcastSeq = nextSeq;

    // Publish only after state is durably committed, so a subscriber can never
    // observe a broadcast for a state the authority has not persisted.
    const broadcasts = pending.map((e) => e.msg);
    for (const msg of broadcasts) {
      this.pubsub.publish(gameChannel(gameId), msg);
      if (msg.t === 'ended') this.pubsub.publish(gamesEndedChannel(), msg);
    }

    return { events: result.events, broadcasts, state: this.viewOf(rec.game, rec.persistedSeq) };
  }

  private guard(fn: () => { game: Game; events: GameEvent[] }): { game: Game; events: GameEvent[] } {
    try {
      return fn();
    } catch (err) {
      throw new AuthorityError('invalid_command', (err as Error).message);
    }
  }

  private toBroadcast(
    gameId: string,
    ev: GameEvent,
    prefix: Game,
    stateRevision: number,
  ): GameBroadcast | null {
    switch (ev.type) {
      case 'PlayerReady':
        return { t: 'ready', gameId, stateRevision, ready: { ...prefix.snapshot().ready }, serverTs: ev.at };
      case 'MovePlayed':
        return {
          t: 'move',
          gameId,
          stateRevision,
          ply: ev.ply,
          uci: ev.uci,
          san: ev.san,
          by: ev.by,
          fenHash: fenHash(prefix.fen),
          clock: { w: ev.remaining.w, b: ev.remaining.b },
          serverTs: ev.at,
          legalMoves: prefix.status.over ? {} : legalMovesOf(prefix.snapshot().position),
        };
      case 'GameEnded':
        return {
          t: 'ended',
          gameId,
          stateRevision,
          result: ev.result,
          termination: ev.termination,
          winner: ev.winner,
          serverTs: ev.at,
        };
      default:
        return null;
    }
  }

  private validateAppendHead(returned: number, expected: number): void {
    if (!isStateRevision(returned) || returned !== expected) {
      throw new Error('invalid durable event sequence returned by append');
    }
  }

  private viewOf(game: Game, stateRevision: number): StateView {
    const snap = game.snapshot();
    const fen = game.fen;
    return {
      gameId: snap.gameId,
      stateRevision,
      variant: snap.variant,
      players: snap.players,
      timeControl: snap.timeControl,
      fen,
      fenHash: fenHash(fen),
      ply: snap.ply,
      turn: game.turn,
      clock: { w: snap.clock.remaining.w, b: snap.clock.remaining.b },
      turnStartedAt: snap.clock.turnStartedAt,
      status: snap.status,
      drawOffer: snap.drawOffer,
      moves: snap.moves.map((m) => ({ ply: m.ply, uci: m.uci, san: m.san, by: m.by })),
      legalMoves: snap.status.over ? {} : legalMovesOf(snap.position),
      chess960StartId: snap.chess960StartId,
      ready: snap.source === null ? null : { ...snap.ready },
    };
  }

  private require(gameId: string): GameRecord {
    const slot = this.games.get(gameId);
    if (slot?.stalled) {
      this.failUnavailable(gameId);
    }
    const rec = slot?.record;
    if (!rec || slot?.dispose) throw new AuthorityError('unknown_game', `no such game ${gameId}`);
    if (slot.reloads > 0) throw new AuthorityError('invalid_command', 'durable game reload is required');
    return rec;
  }
}
