/**
 * @packageDocumentation
 * The Realtime Gateway: binds client {@link Connection}s to game {@link Room}s
 * and the {@link GameAuthority}, and speaks the {@link ClientMessage} /
 * {@link ServerMessage} protocol.
 *
 * It owns exactly the concerns the architecture assigns to the edge:
 * - **Membership & presence** — join a game as player or spectator, track who
 *   is connected, fan authoritative broadcasts out to the room.
 * - **Optimistic-move reconciliation** — a client move carries a monotonic
 *   `clientSeq`; a stale/duplicate seq or an illegal move yields a
 *   {@link RejectMessage} referencing that seq so the client rolls back.
 * - **Reconnect/resume** — a reconnecting client rejoins (re-establishing its
 *   seat and receiving current state) and then asks for every move it missed
 *   since `lastPly`.
 * - **Latency** — `ping`/`pong` with a server timestamp for client-side clock
 *   interpolation.
 *
 * State ownership stays in the authority; cross-node fanout stays in pub/sub.
 * The gateway subscribes a room to its game channel on first join and
 * unsubscribes when the room empties, so a node only carries fanout for games
 * it actually serves.
 */

import type { Color } from '@chess-platform/core';
import { GameAuthority, AuthorityError, AuthorityCommitError, CommandOutcomeUnknownError, type Command } from './authority';
import { LocalCommandRouter, type CommandRouter } from './command-router';
import { Room } from './room';
import { gameChannel, type PubSub, type Unsubscribe } from './pubsub';
import type { Connection } from './transport';
import type {
  ClientMessage,
  MoveMessage,
  RejectCode,
  Role,
  ServerMessage,
  SimpleCommandMessage,
  StateView,
  TokenVerifier,
} from './protocol';

interface Membership {
  readonly userId: string;
  readonly role: Role;
  /** Highest accepted `clientSeq` for move replay protection. */
  lastSeq: number;
}

interface Session {
  readonly conn: Connection;
  readonly games: Map<string, Membership>;
  readonly joinReads: Map<string, symbol>;
  readonly resumeReads: Map<string, symbol>;
  readonly joinBuffers: Map<string, () => void>;
}

interface RoomEntry {
  readonly room: Room;
  readonly unsubscribe: Unsubscribe;
}

/** How many times a join's readiness is routed before the failure is reported to the client. */
const READINESS_ATTEMPTS = 3;

/** Bounded attempts for refreshing an overtaken draw-only state; mirrors READINESS_ATTEMPTS; no timers/backoff. */
const STATE_REFRESH_ATTEMPTS = 3;

const SIMPLE_TO_COMMAND: Record<SimpleCommandMessage['t'], Command['kind']> = {
  resign: 'resign',
  offerDraw: 'offerDraw',
  acceptDraw: 'acceptDraw',
  declineDraw: 'declineDraw',
  claimFlag: 'claimFlag',
  abort: 'abort',
};

/** Returns true if a buffered message was published after the snapshot's stateRevision or carries no revision. */
function isNewerThanSnapshot(msg: ServerMessage, snapshotRevision: number): boolean {
  if (msg.t === 'state') {
    return msg.state.stateRevision > snapshotRevision;
  }
  if ('stateRevision' in msg && typeof msg.stateRevision === 'number') {
    return msg.stateRevision > snapshotRevision;
  }
  return true;
}

export class RealtimeGateway {
  private readonly sessions = new Map<string, Session>();
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly loadedGames = new Set<string>();
  private readonly joinBuffers = new Map<string, Set<ServerMessage[]>>();
  private readonly observedRevision = new Map<string, number>();
  private readonly stateRefreshes = new Map<string, { again: boolean }>();
  /**
   * Command router: directs game commands to the owning node. Defaults to
   * {@link LocalCommandRouter} (direct authority.apply) for single-node and
   * backward compatibility. Multi-node deployments inject a Redis-backed
   * router that forwards non-owned commands (see ADR-0010).
   */
  private readonly commandRouter: CommandRouter;

  constructor(
    private readonly authority: GameAuthority,
    private readonly pubsub: PubSub,
    private readonly tokenVerifier: TokenVerifier,
    private readonly now: () => number = () => Date.now(),
    commandRouter?: CommandRouter,
    /** Called once a join has materialised a game, so a host can react to who is seated. */
    private readonly onGameLoaded?: (gameId: string, state: StateView) => void,
    /** Called when the last session in a game leaves this node — the pair of `onGameLoaded`. */
    private readonly onGameUnloaded?: (gameId: string) => void,
    /**
     * Called once when every bounded refresh attempt for an overtaken draw-only command state
     * failed; the command itself committed - the gateway sends no frame for it (no stale snapshot, no
     * false reject) and the host should log/alert.
     */
    private readonly onStateRefreshFailed?: (gameId: string, error: unknown) => void,
  ) {
    // Fall back to local routing when no router is injected. This preserves
    // backward compatibility: existing callers that don't pass a router get
    // the same direct-authority behavior.
    this.commandRouter = commandRouter ?? new LocalCommandRouter(this.authority);
  }

  /** Register a new connection and wire its lifecycle handlers. */
  handleConnection(conn: Connection): void {
    const session: Session = { conn, games: new Map(), joinReads: new Map(), resumeReads: new Map(), joinBuffers: new Map() };
    this.sessions.set(conn.id, session);
    conn.onMessage((msg) => {
      try {
        this.onMessage(session, msg);
      } catch {
        conn.send({
          t: 'reject',
          gameId: typeof (msg as { gameId?: unknown }).gameId === 'string'
            ? (msg as { gameId: string }).gameId
            : '',
          ref: null,
          code: 'invalid_command',
          message: 'malformed client message',
        });
        conn.close(1008, 'malformed client message');
      }
    });
    conn.onClose(() => this.onClose(session));
  }

  /** Number of rooms this node currently serves (diagnostics/tests). */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** Whether any connection on this node is in `gameId`'s room. */
  hasLocalSessions(gameId: string): boolean {
    return this.rooms.has(gameId);
  }

  /** Observed revision for a game (test inspection). */
  observedRevisionFor(gameId: string): number | undefined {
    return this.observedRevision.get(gameId);
  }

  private onMessage(session: Session, msg: ClientMessage): void {
    switch (msg.t) {
      case 'join':
        this.onJoin(session, msg.gameId, msg.token);
        return;
      case 'move':
        this.onMove(session, msg);
        return;
      case 'resign':
      case 'offerDraw':
      case 'acceptDraw':
      case 'declineDraw':
      case 'claimFlag':
      case 'abort':
        this.onSimpleCommand(session, msg);
        return;
      case 'resume':
        this.onResume(session, msg.gameId, msg.lastPly);
        return;
      case 'ping':
        session.conn.send({ t: 'pong', ts: msg.ts, serverTs: this.now() });
        return;
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  }

  /**
   * Starts buffering pubsub and room state frames synchronously before any snapshot is read.
   * Every commit after the snapshot (which publishes after its append) is either in the snapshot
   * or in the buffer; the join reuses resident state only if loaded after this buffer started.
   * Known limitation: on a node with no existing subscription for the game, the first Redis
   * SUBSCRIBE is fire-and-forget, so a commit published by another node in that short window
   * can still be missed (pre-existing on main for cold joins; closing it needs a PubSub API change).
   */
  private startJoinBuffer(session: Session, gameId: string): { stop: () => void; take: () => ServerMessage[] } {
    const prevStop = session.joinBuffers.get(gameId);
    if (prevStop) {
      prevStop();
      session.joinBuffers.delete(gameId);
    }
    const buffered: ServerMessage[] = [];
    const unsubscribe = this.pubsub.subscribe(gameChannel(gameId), (msg) => {
      this.observe(gameId, msg);
      buffered.push(msg);
    });
    let set = this.joinBuffers.get(gameId);
    if (!set) {
      set = new Set();
      this.joinBuffers.set(gameId, set);
    }
    set.add(buffered);

    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      const currentSet = this.joinBuffers.get(gameId);
      if (currentSet) {
        currentSet.delete(buffered);
        if (currentSet.size === 0) {
          this.joinBuffers.delete(gameId);
          if (!this.rooms.has(gameId)) {
            this.observedRevision.delete(gameId);
          }
        }
      }
      if (session.joinBuffers.get(gameId) === stop) {
        session.joinBuffers.delete(gameId);
      }
    };

    session.joinBuffers.set(gameId, stop);

    const take = (): ServerMessage[] => {
      stop();
      return buffered;
    };

    return { stop, take };
  }

  /**
   * Handle a join request. Identity is derived from the token (never from a
   * client-asserted userId). When the token is absent, the connection joins
   * as an anonymous spectator. When the token is present but invalid, the
   * join is rejected with `unauthorized`.
   */
  private onJoin(session: Session, gameId: string, token: string | undefined): void {
    const intent = Symbol('join');
    session.joinReads.set(gameId, intent);
    const current = (): boolean =>
      this.sessions.get(session.conn.id) === session && session.joinReads.get(gameId) === intent;
    const buffer = this.startJoinBuffer(session, gameId);
    void (async () => {
      try {
        let loaded = await this.authority.ensureLoaded(gameId);
        // A copy loaded for background work (the no-show worker) can be evicted between the load
        // and this continuation; load once more rather than failing a valid join.
        if (loaded && !this.authority.has(gameId)) loaded = await this.authority.ensureLoaded(gameId);
        if (!loaded) {
          if (current()) {
            this.reject(session, gameId, null, 'unknown_game', `no such game ${gameId}`);
          }
          return;
        }
        if (!current()) return;
        const state = (await this.authority.readRecovery(gameId, 0)).state;
        if (!current()) return;
        if (!this.authority.has(gameId)) { // An eviction (e.g. the deadline-expiry worker) during the read would leave the joined player without a resident slot for local commands; re-hydrate once.
          const reloaded = await this.authority.ensureLoaded(gameId);
          if (!current()) return;
          if (!reloaded) {
            this.reject(session, gameId, null, 'unknown_game', `no such game ${gameId}`);
            return;
          }
        }
        this.completeJoin(session, gameId, token, state, buffer.take);
      } catch (err: unknown) {
        if (current()) {
          if (err instanceof AuthorityError && err.code === 'unknown_game') {
            this.reject(session, gameId, null, 'unknown_game', `no such game ${gameId}`);
          } else {
            this.reject(session, gameId, null, 'invalid_command', 'failed to load game');
          }
        }
      } finally {
        buffer.stop();
        if (session.joinBuffers.get(gameId) === buffer.stop) {
          session.joinBuffers.delete(gameId);
        }
        if (session.joinReads.get(gameId) === intent) {
          session.joinReads.delete(gameId);
        }
      }
    })();
  }

  /**
   * Finish a join once the game is resident and recovery state has been read.
   * State comes from a detached recovery read; the resident slot exists for commands and host hooks.
   */
  private completeJoin(
    session: Session,
    gameId: string,
    token: string | undefined,
    state: StateView,
    takeBuffer: () => ServerMessage[],
  ): void {
    if (this.sessions.get(session.conn.id) !== session) return;
    // Derive identity from the token. No token → anonymous spectator.
    let userId: string;
    if (token !== undefined) {
      let verified: ReturnType<TokenVerifier['verify']>;
      try {
        verified = this.tokenVerifier.verify(token);
      } catch {
        verified = null;
      }
      if (verified === null) {
        this.reject(session, gameId, null, 'unauthorized', 'invalid or expired token');
        return;
      }
      userId = verified.userId;
    } else {
      // Anonymous spectator: generate a unique id so two anonymous tabs don't
      // collide as the same user. The spectator has no move authority.
      userId = `anon-${session.conn.id}`;
    }

    const color = state.players.white === userId ? 'w' : state.players.black === userId ? 'b' : null;
    const role: Role = color === 'w' ? 'white' : color === 'b' ? 'black' : 'spectator';

    const entry = this.ensureRoom(gameId);
    entry.room.add(session.conn, userId, role);
    const pending = takeBuffer();

    session.games.set(gameId, { userId, role, lastSeq: 0 });

    session.conn.send({ t: 'joined', gameId, role, state });
    this.observe(gameId, { t: 'state', gameId, state });
    for (const msg of pending) {
      if (isNewerThanSnapshot(msg, state.stateRevision)) {
        session.conn.send(msg);
      }
    }
    entry.room.broadcastPresence();
    if (color !== null) this.commitReadiness(session, gameId, userId, color, state);

    if (!this.loadedGames.has(gameId)) {
      this.loadedGames.add(gameId);
      this.onGameLoaded?.(gameId, state);
    }
  }

  /**
   * Make a seated player's authenticated join durable readiness (ADR-0148). Presence in a room is
   * not readiness: it counts only once the owning authority has appended `PlayerReady`.
   *
   * Routed like any command, so it is applied by the game's single owner and serialized with moves.
   * The domain makes it idempotent, which is what makes repeated joins, several tabs and replicas
   * racing each other harmless. The local `state` may be stale on a non-owner; it can only lack
   * readiness, never invent it, so at worst an unnecessary no-op is routed.
   *
   * A losing append (another seat's readiness or a move committed first) reloads the owner's copy and
   * surfaces as `invalid_command`; re-routing then re-evaluates against the durable log, so a
   * readiness is never lost to a concurrent write. A final failure is reported to the client; the
   * next join tries again.
   */
  private commitReadiness(session: Session, gameId: string, userId: string, color: Color, state: StateView): void {
    if (state.ready === null || state.status.over || state.ply > 0 || state.ready[color]) return;
    void (async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await this.commandRouter.route(gameId, userId, { kind: 'ready' });
          return;
        } catch (err) {
          const retryable = !(err instanceof AuthorityCommitError)
            && (!(err instanceof AuthorityError) || err.code === 'invalid_command' || err.code === 'command_expired');
          if (!retryable || attempt >= READINESS_ATTEMPTS) throw err;
        }
      }
    })().catch((err: unknown) => this.reject(session, gameId, null, codeOf(err), messageOf(err), requestIdOf(err), 'ready', color));
  }

  private onMove(session: Session, msg: MoveMessage): void {
    const membership = session.games.get(msg.gameId);
    if (!membership) {
      this.reject(session, msg.gameId, msg.clientSeq, 'not_joined', 'join the game first');
      return;
    }
    if (membership.role === 'spectator') {
      this.reject(session, msg.gameId, msg.clientSeq, 'not_a_player', 'spectators cannot move');
      return;
    }
    // Replay protection: clientSeq must strictly increase per connection+game.
    if (msg.clientSeq <= membership.lastSeq) {
      this.reject(session, msg.gameId, msg.clientSeq, 'stale_seq', 'stale or duplicate clientSeq');
      return;
    }
    membership.lastSeq = msg.clientSeq;

    // Fire the (per-game serialized) command; broadcasts fan out via pub/sub.
    // A rejection is reported back referencing this exact clientSeq.
    void this.commandRouter
      .route(msg.gameId, membership.userId, { kind: 'move', uci: msg.uci })
      .catch((err: unknown) => {
        this.reject(session, msg.gameId, msg.clientSeq, codeOf(err), messageOf(err), requestIdOf(err));
      });
  }

  private onSimpleCommand(session: Session, msg: SimpleCommandMessage): void {
    const membership = session.games.get(msg.gameId);
    if (!membership) {
      this.reject(session, msg.gameId, null, 'not_joined', 'join the game first');
      return;
    }
    if (membership.role === 'spectator') {
      this.reject(session, msg.gameId, null, 'not_a_player', 'spectators cannot issue commands');
      return;
    }
    const kind = SIMPLE_TO_COMMAND[msg.t];
    void this.commandRouter
      .route(msg.gameId, membership.userId, { kind } as Command)
      .then((result) => {
        // Commands that emit no move/terminal broadcast (draw offer/decline)
        // still change shared state; push an authoritative snapshot so both
        // sides see the updated draw offer.
        if (result.broadcasts.length === 0) {
          this.sendStateToRoom(msg.gameId, result.state);
        }
      })
      .catch((err: unknown) => {
        this.reject(session, msg.gameId, null, codeOf(err), messageOf(err), requestIdOf(err), msg.t);
      });
  }

  private onResume(session: Session, gameId: string, lastPly: number): void {
    const membership = session.games.get(gameId);
    if (!membership) {
      this.reject(session, gameId, null, 'not_joined', 'join before resuming');
      return;
    }
    const intent = Symbol('resume');
    session.resumeReads.set(gameId, intent);
    const current = (): boolean =>
      this.sessions.get(session.conn.id) === session &&
      session.resumeReads.get(gameId) === intent &&
      session.games.get(gameId) === membership;
    void (async () => {
      try {
        const loaded = await this.authority.ensureLoaded(gameId);
        if (!loaded) {
          if (current()) {
            this.reject(session, gameId, null, 'unknown_game', `no such game ${gameId}`);
          }
          return;
        }
        if (!current()) return;
        const read = await this.authority.readRecovery(gameId, lastPly);
        if (current()) {
          session.conn.send({
            t: 'resumed',
            gameId,
            state: read.state,
            missed: read.missed,
          });
        }
      } catch (err: unknown) {
        if (current()) {
          if (err instanceof AuthorityError && err.code === 'unknown_game') {
            this.reject(session, gameId, null, 'unknown_game', `no such game ${gameId}`);
          } else {
            this.reject(session, gameId, null, 'invalid_command', 'failed to load game');
          }
        }
      } finally {
        if (session.resumeReads.get(gameId) === intent) {
          session.resumeReads.delete(gameId);
        }
      }
    })();
  }

  private onClose(session: Session): void {
    for (const stop of session.joinBuffers.values()) {
      stop();
    }
    session.joinBuffers.clear();
    for (const gameId of session.games.keys()) {
      const entry = this.rooms.get(gameId);
      if (!entry) continue;
      entry.room.remove(session.conn.id);
      if (entry.room.size === 0) {
        entry.unsubscribe();
        this.rooms.delete(gameId);
        this.loadedGames.delete(gameId);
        this.onGameUnloaded?.(gameId);
        const buffers = this.joinBuffers.get(gameId);
        if (!buffers || buffers.size === 0) {
          this.observedRevision.delete(gameId);
        }
      } else {
        entry.room.broadcastPresence();
      }
    }
    this.sessions.delete(session.conn.id);
  }

  private ensureRoom(gameId: string): RoomEntry {
    let entry = this.rooms.get(gameId);
    if (entry) return entry;
    const room = new Room(gameId);
    const unsubscribe = this.pubsub.subscribe(gameChannel(gameId), (msg) => {
      this.observe(gameId, msg);
      room.broadcast(msg);
    });
    entry = { room, unsubscribe };
    this.rooms.set(gameId, entry);
    return entry;
  }

  private observe(gameId: string, msg: ServerMessage): void {
    let rev: number | undefined;
    if (msg.t === 'move' || msg.t === 'ended' || msg.t === 'ready') {
      rev = msg.stateRevision;
    } else if (msg.t === 'state') {
      rev = msg.state.stateRevision;
    }
    if (rev !== undefined) {
      const current = this.observedRevision.get(gameId);
      if (current === undefined || rev > current) {
        this.observedRevision.set(gameId, rev);
      }
    }
  }

  private sendStateToRoom(gameId: string, state: StateView): void {
    const highest = this.observedRevision.get(gameId) ?? -1;
    if (state.stateRevision >= highest) {
      this.deliverState(gameId, state);
      return;
    }
    const existing = this.stateRefreshes.get(gameId);
    if (existing) {
      existing.again = true;
      return;
    }
    this.stateRefreshes.set(gameId, { again: false });
    void this.refreshState(gameId);
  }

  /**
   * Bounded server-side refresh for an overtaken draw-only command state.
   * Retries up to STATE_REFRESH_ATTEMPTS with resident fallback on the owner node.
   * If all attempts fail, notifies onStateRefreshFailed so the host can alert/log.
   */
  private async refreshState(gameId: string): Promise<void> {
    try {
      while (true) {
        let lastError: unknown;
        let succeeded = false;

        for (let attempt = 1; attempt <= STATE_REFRESH_ATTEMPTS; attempt++) {
          const room = this.rooms.get(gameId);
          const buffers = this.joinBuffers.get(gameId);
          if (!room && (!buffers || buffers.size === 0)) {
            this.stateRefreshes.delete(gameId);
            return;
          }

          let stateToDeliver: StateView | undefined;

          try {
            const latest = await this.authority.readRecovery(gameId, 0);
            const activeRoom = this.rooms.get(gameId);
            const activeBuffers = this.joinBuffers.get(gameId);
            if (!activeRoom && (!activeBuffers || activeBuffers.size === 0)) {
              this.stateRefreshes.delete(gameId);
              return;
            }
            const floor = this.observedRevision.get(gameId) ?? -1;
            if (latest.state.stateRevision >= floor) {
              stateToDeliver = latest.state;
            } else {
              lastError = new Error('state refresh read below observed revision');
            }
          } catch (err: unknown) {
            lastError = err;
            const activeRoom = this.rooms.get(gameId);
            const activeBuffers = this.joinBuffers.get(gameId);
            if (!activeRoom && (!activeBuffers || activeBuffers.size === 0)) {
              this.stateRefreshes.delete(gameId);
              return;
            }
            if (this.authority.hasFresh(gameId)) {
              try {
                const resident = this.authority.getState(gameId);
                const floor = this.observedRevision.get(gameId) ?? -1;
                if (resident.stateRevision >= floor) {
                  stateToDeliver = resident;
                } else {
                  lastError = new Error('resident state below observed revision');
                }
              } catch {
                // Ignore getState error and continue to next attempt
              }
            }
          }

          if (stateToDeliver) {
            succeeded = true;
            this.deliverState(gameId, stateToDeliver);
            break;
          }
        }

        if (!succeeded) {
          try {
            this.onStateRefreshFailed?.(gameId, lastError);
          } catch {
            // Protect gateway from throwing host hook
          }
        }

        const entry = this.stateRefreshes.get(gameId);
        if (entry?.again) {
          entry.again = false;
        } else {
          this.stateRefreshes.delete(gameId);
          return;
        }
      }
    } catch (err: unknown) {
      this.stateRefreshes.delete(gameId);
      // Unexpected errors (e.g. from delivery) are reported, never swallowed.
      try {
        this.onStateRefreshFailed?.(gameId, err);
      } catch {
        /* a throwing host hook must not break the gateway */
      }
    }
  }

  private deliverState(gameId: string, state: StateView): void {
    const entry = this.rooms.get(gameId);
    const buffers = this.joinBuffers.get(gameId);
    if (!entry && (!buffers || buffers.size === 0)) return;
    const msg: ServerMessage = { t: 'state', gameId, state };
    this.observe(gameId, msg);
    if (entry) {
      entry.room.sendAll(msg);
    }
    if (buffers) {
      for (const buf of buffers) {
        buf.push(msg);
      }
    }
  }

  private reject(
    session: Session,
    gameId: string,
    ref: number | null,
    code: RejectCode | 'outcome_unknown',
    message: string,
    requestId = '',
    action?: SimpleCommandMessage['t'] | 'ready',
    readyColor?: Color,
  ): void {
    if (code === 'outcome_unknown') {
      session.conn.send({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId, ref, requestId, message, ...(action ? { action } : {}), ...(readyColor ? { readyColor } : {}) });
      return;
    }
    session.conn.send({ t: 'reject', gameId, ref, code, message });
  }
}

function requestIdOf(err: unknown): string {
  return err instanceof CommandOutcomeUnknownError || err instanceof AuthorityCommitError ? err.requestId : '';
}

function codeOf(err: unknown): RejectCode | 'outcome_unknown' {
  if (err instanceof AuthorityCommitError) return 'outcome_unknown';
  if (err instanceof AuthorityError) return err.code;
  return 'invalid_command';
}

function messageOf(err: unknown): string {
  if (err instanceof AuthorityCommitError) return new CommandOutcomeUnknownError(err.requestId).message;
  return err instanceof Error ? err.message : String(err);
}
