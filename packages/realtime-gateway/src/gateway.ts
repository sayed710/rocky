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
import { GameAuthority, AuthorityError, type Command } from './authority';
import { LocalCommandRouter, type CommandRouter } from './command-router';
import { Room } from './room';
import { gameChannel, type PubSub, type Unsubscribe } from './pubsub';
import type { Connection } from './transport';
import type {
  ClientMessage,
  MoveMessage,
  RejectCode,
  Role,
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
}

interface RoomEntry {
  readonly room: Room;
  readonly unsubscribe: Unsubscribe;
}

/** How many times a join's readiness is routed before the failure is reported to the client. */
const READINESS_ATTEMPTS = 3;

const SIMPLE_TO_COMMAND: Record<SimpleCommandMessage['t'], Command['kind']> = {
  resign: 'resign',
  offerDraw: 'offerDraw',
  acceptDraw: 'acceptDraw',
  declineDraw: 'declineDraw',
  claimFlag: 'claimFlag',
  abort: 'abort',
};

export class RealtimeGateway {
  private readonly sessions = new Map<string, Session>();
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly loadedGames = new Set<string>();
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
  ) {
    // Fall back to local routing when no router is injected. This preserves
    // backward compatibility: existing callers that don't pass a router get
    // the same direct-authority behavior.
    this.commandRouter = commandRouter ?? new LocalCommandRouter(this.authority);
  }

  /** Register a new connection and wire its lifecycle handlers. */
  handleConnection(conn: Connection): void {
    const session: Session = { conn, games: new Map() };
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
   * Handle a join request. Identity is derived from the token (never from a
   * client-asserted userId). When the token is absent, the connection joins
   * as an anonymous spectator. When the token is present but invalid, the
   * join is rejected with `unauthorized`.
   */
  private onJoin(session: Session, gameId: string, token: string | undefined): void {
    // Hot path: a resident game joins synchronously (no microtask deferral), so
    // the `joined` frame is emitted in the same turn the client's message
    // arrives. Only a game evicted from the cache (or lost to a restart) takes
    // the async hydration path below.
    if (this.authority.hasFresh(gameId)) {
      this.completeJoin(session, gameId, token);
      return;
    }
    void this.authority.ensureLoaded(gameId)
      .then(async (loaded) => {
        // A copy loaded for background work (the no-show worker) can be evicted between the load
        // and this continuation; load once more rather than failing a valid join.
        if (loaded && !this.authority.has(gameId)) loaded = await this.authority.ensureLoaded(gameId);
        if (!loaded) {
          this.reject(session, gameId, null, 'unknown_game', `no such game ${gameId}`);
          return;
        }
        this.completeJoin(session, gameId, token);
      })
      .catch(() => {
        this.reject(session, gameId, null, 'invalid_command', 'failed to load game');
      });
  }

  /** Finish a join once the game is known to be resident in the authority. */
  private completeJoin(session: Session, gameId: string, token: string | undefined): void {
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

    const color = this.authority.colorOf(gameId, userId);
    const role: Role = color === 'w' ? 'white' : color === 'b' ? 'black' : 'spectator';

    const entry = this.ensureRoom(gameId);
    entry.room.add(session.conn, userId, role);
    session.games.set(gameId, { userId, role, lastSeq: 0 });

    const state = this.authority.getState(gameId);
    session.conn.send({ t: 'joined', gameId, role, state });
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
          const retryable = !(err instanceof AuthorityError) || err.code === 'invalid_command';
          if (!retryable || attempt >= READINESS_ATTEMPTS) throw err;
        }
      }
    })().catch((err: unknown) => this.reject(session, gameId, null, codeOf(err), messageOf(err)));
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
        this.reject(session, msg.gameId, msg.clientSeq, codeOf(err), messageOf(err));
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
          this.sendStateToRoom(msg.gameId);
        }
      })
      .catch((err: unknown) => {
        this.reject(session, msg.gameId, null, codeOf(err), messageOf(err));
      });
  }

  private onResume(session: Session, gameId: string, lastPly: number): void {
    const membership = session.games.get(gameId);
    if (!membership) {
      this.reject(session, gameId, null, 'not_joined', 'join before resuming');
      return;
    }
    if (!this.authority.hasFresh(gameId)) {
      void this.authority.ensureLoaded(gameId)
        .then((loaded) => {
          if (!loaded) {
            this.reject(session, gameId, null, 'unknown_game', `no such game ${gameId}`);
            return;
          }
          this.completeResume(session, gameId, lastPly);
        })
        .catch(() => this.reject(session, gameId, null, 'invalid_command', 'failed to load game'));
      return;
    }
    this.completeResume(session, gameId, lastPly);
  }

  private completeResume(session: Session, gameId: string, lastPly: number): void {
    if (this.sessions.get(session.conn.id) !== session || !session.games.has(gameId)) return;
    session.conn.send({
      t: 'resumed',
      gameId,
      state: this.authority.getState(gameId),
      missed: this.authority.getMissedSince(gameId, lastPly),
    });
  }

  private onClose(session: Session): void {
    for (const gameId of session.games.keys()) {
      const entry = this.rooms.get(gameId);
      if (!entry) continue;
      entry.room.remove(session.conn.id);
      if (entry.room.size === 0) {
        entry.unsubscribe();
        this.rooms.delete(gameId);
        this.loadedGames.delete(gameId);
        this.onGameUnloaded?.(gameId);
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
    const unsubscribe = this.pubsub.subscribe(gameChannel(gameId), (msg) => room.broadcast(msg));
    entry = { room, unsubscribe };
    this.rooms.set(gameId, entry);
    return entry;
  }

  private sendStateToRoom(gameId: string): void {
    const entry = this.rooms.get(gameId);
    if (!entry) return;
    entry.room.sendAll({ t: 'state', gameId, state: this.authority.getState(gameId) });
  }

  private reject(
    session: Session,
    gameId: string,
    ref: number | null,
    code: RejectCode,
    message: string,
  ): void {
    session.conn.send({ t: 'reject', gameId, ref, code, message });
  }
}

function codeOf(err: unknown): RejectCode {
  if (err instanceof AuthorityError) return err.code;
  return 'invalid_command';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
