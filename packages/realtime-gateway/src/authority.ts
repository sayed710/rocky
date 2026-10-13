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
import { InMemoryEventLog, type EventLog } from './event-log';
import type { GameBroadcast, LegalMoves, ReadyView, StateView } from './protocol';
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
  /** Durable-log head seq already persisted (`events.length - 1`). */
  persistedSeq: number;
  /** Set when an uncertain append could not be reconciled with the durable log. */
  stale: boolean;
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

export class GameAuthority {
  private readonly games = new Map<string, GameSlot>();
  private lifecycleSequence = 0;

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
  ) {}

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

  /**
   * Whether a game exists at all — in the hot cache or the durable log.
   * Unlike {@link has} this consults the store, so an evicted/cold game counts.
   */
  async knows(gameId: string): Promise<boolean> {
    return this.has(gameId) || this.store.exists(gameId);
  }

  /**
   * Create and register a new game. Throws if the id is already in use (in the
   * hot cache or the durable log). `at` defaults to the authority's clock. The
   * `GameCreated` event is persisted before the game is registered; creation is
   * not a broadcast (joiners receive the full state instead).
   */
  async createGame(params: Omit<CreateGameParams, 'at'> & { at?: number }): Promise<StateView> {
    const slot = this.slotFor(params.gameId);
    return this.enqueue(params.gameId, slot, async () => {
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
      // Persist first: an append against a fresh id fails if the game already
      // exists in the durable log, so the store is the single source of truth for
      // uniqueness across restarts.
      let persistedSeq: number;
      try {
        persistedSeq = await this.store.append(params.gameId, -1, events);
      } catch (err) {
        throw new AuthorityError('invalid_command', `cannot create game ${params.gameId}: ${(err as Error).message}`);
      }
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
      return this.viewOf(game);
    });
  }

  /**
   * Ensure a game is resident in the hot cache, hydrating it from the durable
   * log if it was evicted or the process restarted. Returns `false` if no such
   * game exists anywhere. Safe to call repeatedly; a cache hit is a no-op.
   */
  async ensureLoaded(gameId: string): Promise<boolean> {
    for (;;) {
      if (this.hasFresh(gameId)) return true;
      const slot = this.slotFor(gameId);
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
    const logged = await this.store.load(gameId);
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
      slot = { record: undefined, tail: Promise.resolve(), pending: 0, generation: ++this.lifecycleSequence,
        dispose: false, reloads: 0, reload: undefined, coldLoad: undefined };
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
    if (slot.pending === 0 && (slot.dispose || !slot.record) && this.games.get(gameId) === slot) {
      this.games.delete(gameId);
    }
  }

  /**
   * Rebuild a full {@link GameRecord} from a durable event log: the folded
   * {@link Game}, plus the broadcast history replayed exactly as the live path
   * produced it, so resume/catch-up ({@link getMissedSince}) works after a
   * restart.
   */
  private rebuildRecord(gameId: string, logged: readonly { readonly event: GameEvent }[]): GameRecord {
    const events = logged.map((e) => e.event);
    const game = Game.fromEvents(events);
    const broadcasts: BroadcastLogEntry[] = [];
    let broadcastSeq = 0;
    // Replay incrementally: a MovePlayed/GameEnded broadcast carries the
    // fenHash + legalMoves of the position *after* that event, exactly as the
    // live path computes them.
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type !== 'MovePlayed' && ev.type !== 'GameEnded' && ev.type !== 'PlayerReady') continue;
      const upto = Game.fromEvents(events.slice(0, i + 1));
      const snap = upto.snapshot();
      const fh = fenHash(upto.fen);
      const legal: LegalMoves = snap.status.over ? {} : legalMovesOf(snap.position);
      const msg = this.toBroadcast(gameId, ev, fh, legal, snap.ready);
      if (!msg) continue;
      const seq = ++broadcastSeq;
      broadcasts.push({ seq, ply: msg.t === 'move' ? msg.ply : null, msg });
    }
    return {
      game,
      events,
      broadcasts,
      broadcastSeq,
      persistedSeq: events.length - 1,
      stale: false,
    };
  }

  /** Current authoritative state view. Throws if the game is unknown. */
  getState(gameId: string): StateView {
    const record = this.require(gameId);
    if (record.stale) throw new AuthorityError('invalid_command', 'durable game reload is required');
    return this.viewOf(record.game);
  }

  /**
   * Every broadcast a resuming client missed: all broadcasts recorded after the
   * move whose ply equals `lastPly`. `lastPly <= 0` returns the full history.
   */
  getMissedSince(gameId: string, lastPly: number): GameBroadcast[] {
    const rec = this.require(gameId);
    if (rec.stale) throw new AuthorityError('invalid_command', 'durable game reload is required');
    if (lastPly <= 0) return rec.broadcasts.map((e) => e.msg);
    let cutSeq = -1;
    for (const e of rec.broadcasts) {
      if (e.ply === lastPly) cutSeq = e.seq;
    }
    return rec.broadcasts.filter((e) => e.seq > cutSeq).map((e) => e.msg);
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
    return this.enqueue(gameId, slot, async () => {
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
      const result = await this.applyNow(gameId, rec, userId, cmd);
      // Only a successful authoritative execution confirms this exact identity.
      // Position similarity, including a different request's same move, cannot.
      if (options.requestId) this.pubsub.publish(gameChannel(gameId), { t: 'commandConfirmed', gameId, requestId: options.requestId });
      return result;
    });
  }

  private async applyNow(gameId: string, rec: GameRecord, userId: string, cmd: Command): Promise<ApplyResult> {
    const at = this.now();
    if (cmd.kind === 'expireNoShow') {
      // Checked before anything else so a player can never issue it, and the worker never as a seat.
      // The deadline is the game's own durable one; the caller supplies none.
      if (userId !== NO_SHOW_ACTOR) throw new AuthorityError('not_a_player', 'only the server may expire a no-show');
      return this.commit(gameId, rec, this.guard(() => rec.game.expireNoShow(at)));
    }
    if (cmd.kind === 'expireFlag') {
      if (userId !== FLAG_ACTOR) throw new AuthorityError('not_a_player', 'only the server may expire a clock');
      // Decided here, on the owner's clock and its freshest copy: refused unless the side to move has
      // flagged on a clock the first move started, so a move that committed first always wins.
      if (!rec.game.timeoutDue(at)) throw new AuthorityError('invalid_command', 'Flag expiry refused: not due');
      return this.commit(gameId, rec, rec.game.claimFlag(at));
    }
    const players = rec.game.snapshot().players;
    const color = players.white === userId ? 'w' : players.black === userId ? 'b' : null;
    if (color === null) {
      throw new AuthorityError('not_a_player', 'only players may issue commands');
    }
    // A player command arriving after a due no-show deadline records the no-show instead, as a move
    // after a flag fall records the timeout. The outcome never depends on how late the worker runs.
    if (rec.game.noShowVerdict(at).kind === 'expire') {
      return this.commit(gameId, rec, rec.game.expireNoShow(at));
    }
    // Likewise once the side to move has flagged: a late move cannot rescue them, and neither can a
    // resignation or draw that reaches the owner before the flag worker does (ADR-0149).
    if (rec.game.timeoutDue(at)) {
      return this.commit(gameId, rec, rec.game.claimFlag(at));
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
    return this.commit(gameId, rec, result);
  }

  /** Persist a command's events, then commit them to the hot record and publish their broadcasts. */
  private async commit(
    gameId: string,
    rec: GameRecord,
    result: { game: Game; events: GameEvent[] },
  ): Promise<ApplyResult> {
    // A no-op (a repeated readiness) changes nothing, so it neither touches the log nor broadcasts.
    if (result.events.length === 0) return { events: [], broadcasts: [], state: this.viewOf(rec.game) };

    // Compute the resulting position's legal moves once per command.
    // For MovePlayed broadcasts this is the post-move position's side-to-move
    // legal moves (empty if the move ended the game). For GameEnded broadcasts
    // the game is over so legal moves are always {}.
    const resultingSnap = result.game.snapshot();
    const resultingLegalMoves: LegalMoves =
      resultingSnap.status.over ? {} : legalMovesOf(resultingSnap.position);
    const resultingFenHash = fenHash(result.game.fen);

    const pending: BroadcastLogEntry[] = [];
    let nextSeq = rec.broadcastSeq;
    for (const ev of result.events) {
      const msg = this.toBroadcast(gameId, ev, resultingFenHash, resultingLegalMoves, resultingSnap.ready);
      if (!msg) continue;
      pending.push({ seq: ++nextSeq, ply: msg.t === 'move' ? msg.ply : null, msg });
    }

    // Persist the emitted events *before* mutating the hot record or publishing,
    // so a durable-log failure leaves the in-memory game and the store in lock
    // step (nothing committed, nothing broadcast) rather than ahead of disk.
    try {
      rec.persistedSeq = await this.store.append(gameId, rec.persistedSeq, result.events);
    } catch (err) {
      rec.stale = true;
      try {
        const slot = this.games.get(gameId);
        if (slot) await this.refreshSlot(gameId, slot, slot.generation, false);
      } catch {
        // A later command must retry the durable reload before using this cache entry.
      }
      const message = `failed to persist events for ${gameId}: ${(err as Error).message}`;
      // Both EventLog and persistence's structural implementation mark known
      // optimistic conflicts. An opaque I/O error can hide a successful COMMIT.
      if (err !== null && typeof err === 'object' && 'appendRejected' in err && err.appendRejected === true) {
        throw new AuthorityError('invalid_command', message);
      }
      throw new AuthorityCommitError('invalid_command', message);
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

    return { events: result.events, broadcasts, state: this.viewOf(rec.game) };
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
    resultingFenHash: string,
    resultingLegalMoves: LegalMoves,
    resultingReady: ReadyView,
  ): GameBroadcast | null {
    switch (ev.type) {
      case 'PlayerReady':
        return { t: 'ready', gameId, ready: { ...resultingReady }, serverTs: ev.at };
      case 'MovePlayed':
        return {
          t: 'move',
          gameId,
          ply: ev.ply,
          uci: ev.uci,
          san: ev.san,
          by: ev.by,
          fenHash: resultingFenHash,
          clock: { w: ev.remaining.w, b: ev.remaining.b },
          serverTs: ev.at,
          legalMoves: resultingLegalMoves,
        };
      case 'GameEnded':
        return {
          t: 'ended',
          gameId,
          result: ev.result,
          termination: ev.termination,
          winner: ev.winner,
          serverTs: ev.at,
        };
      default:
        return null;
    }
  }

  private viewOf(game: Game): StateView {
    const snap = game.snapshot();
    const fen = game.fen;
    return {
      gameId: snap.gameId,
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
    const rec = slot?.record;
    if (!rec || slot?.dispose) throw new AuthorityError('unknown_game', `no such game ${gameId}`);
    if (slot.reloads > 0) throw new AuthorityError('invalid_command', 'durable game reload is required');
    return rec;
  }
}
