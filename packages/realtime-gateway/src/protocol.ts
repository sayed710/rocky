/**
 * @packageDocumentation
 * The real-time wire protocol between chess clients and the gateway.
 *
 * Two message families flow over a single duplex connection:
 * - {@link ClientMessage}: intents sent by a client (join, move, resume, ping…).
 * - {@link ServerMessage}: authoritative responses and broadcasts.
 *
 * Design rules (see `docs/ARCHITECTURE.md` §4):
 * - The **server is the authority**: a client sends an *intended* move with a
 *   monotonic `clientSeq`; the gateway validates it against the core engine and
 *   either broadcasts the applied move or returns a {@link RejectMessage} so the
 *   client rolls back its optimistic render.
 * - Clocks are authoritative on the server. Move broadcasts carry remaining
 *   time and a `serverTs`; clients interpolate locally (see `latency.ts`).
 * - Reconnection is `lastPly`-based: a resuming client receives the current
 *   authoritative {@link StateView} plus every move it missed.
 *
 * The protocol is transport- and codec-agnostic. {@link encode}/{@link decode}
 * provide a default JSON codec; production deployments may swap in MessagePack
 * binary frames for the move channel without changing these types.
 */

import type { Color, Variant } from '@chess-platform/core';
import type { ResultString, Termination, Players, TimeControl } from '@chess-platform/game';

/** The role a connection holds in a game. */
export type Role = 'white' | 'black' | 'spectator';

/** Remaining clock, milliseconds, for both sides. */
export interface ClockView {
  readonly w: number;
  readonly b: number;
}

/** A single played move, in the compact form clients render/animate. */
export interface MoveView {
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly by: Color;
}

/**
 * Legal destination squares for the side to move, keyed by origin square (both
 * in UCI square notation, e.g. `{ "e2": ["e3", "e4"] }`).
 *
 * Server-authoritative and computed by the perft-verified core engine — the
 * client never derives legality itself. Empty (`{}`) once the game is over.
 * Promotions collapse to their destination square (the promotion piece is
 * chosen by the client on submission, then re-validated by the server).
 */
export type LegalMoves = { readonly [from: string]: readonly string[] };

/**
 * A complete, authoritative snapshot of a game. Sufficient on its own for a
 * client to render correctly (used on join and on resume).
 */
export interface StateView {
  readonly gameId: string;
  readonly variant: Variant;
  readonly players: Players;
  readonly timeControl: TimeControl;
  readonly fen: string;
  /** Short stable hash of `fen`; lets clients cheaply detect desync. */
  readonly fenHash: string;
  readonly ply: number;
  readonly turn: Color;
  readonly clock: ClockView;
  /**
   * Server timestamp (ms since epoch) at which the side to move's turn began — the anchor a
   * client interpolates its displayed countdown from. Mirrors `ClockState.turnStartedAt`, so it
   * is null exactly when that is: a game whose clock was never started. It is a *server* clock
   * reading; a client must correct for skew before comparing it to its own `Date.now()`.
   */
  readonly turnStartedAt: number | null;
  readonly status:
    | { readonly over: false }
    | {
        readonly over: true;
        readonly result: ResultString;
        readonly termination: Termination;
        readonly winner: Color | null;
      };
  /** The side with an open draw offer, if any. */
  readonly drawOffer: Color | null;
  readonly moves: readonly MoveView[];
  /** Legal destinations for the side to move (authoritative; empty once over). */
  readonly legalMoves: LegalMoves;
  /**
   * For a `chess960` game, the Scharnagl id (0..959) of the arrangement it started from; `null` for
   * every other variant, and for a Chess960 game stored before the id was recorded (ADR-0137).
   *
   * On this view rather than only in the event log, because the client cannot derive it: `fen` is the
   * *current* position, so after the first move nothing on the wire says which of the 960 the game
   * began as — and "position 348" is how Chess960 players name the game they are playing.
   *
   * Carried here rather than duplicated into the REST `GameSummary`, which lists games and renders no
   * board. This view is folded from the creation event on every send, so it cannot drift from the log
   * that owns the fact; a summary column would be a second copy that could.
   */
  readonly chess960StartId: number | null;
  /**
   * Durable readiness per seat for a game with a pregame lifecycle (ADR-0148), or `null` for a game
   * without one (bot and direct games, and games created before it existed).
   *
   * While it is non-null, the game is over or has a move played, or one seat is not ready, the first
   * move is refused with `not_ready`. Both ready and no move played means the game waits for White's
   * first move with neither clock running. Folded from the event log, never from connection presence.
   */
  readonly ready: ReadyView | null;
}

/** Durable readiness of both seats. */
export interface ReadyView {
  readonly w: boolean;
  readonly b: boolean;
}

// ─── Client → Server ────────────────────────────────────────────────────────

/**
 * A gateway-local port that verifies an access token and derives the user
 * identity from it. The gateway never trusts a client-asserted `userId`;
 * identity comes exclusively from the token. See ADR-0004.
 */
export interface TokenVerifier {
  /**
   * Verify the token and return the authenticated user id, or `null` if the
   * token is invalid, expired, or malformed.
   */
  verify(token: string): { readonly userId: string } | null;
}

/**
 * Join a game as a player (identity derived from `token`) or as an anonymous
 * spectator (when `token` is absent). The gateway verifies the token via the
 * injected {@link TokenVerifier}; the client never asserts its own identity.
 *
 * Spectator policy (ADR-0004): when `token` is omitted, the connection is
 * seated as an anonymous spectator — no move authority, no presence seat.
 * When `token` is present but invalid, the join is rejected with
 * `unauthorized`.
 */
export interface JoinMessage {
  readonly t: 'join';
  readonly gameId: string;
  /** Access token; required for players, optional for anonymous spectators. */
  readonly token?: string;
}

/** An intended move. `clientSeq` must strictly increase per connection+game. */
export interface MoveMessage {
  readonly t: 'move';
  readonly gameId: string;
  readonly uci: string;
  readonly clientSeq: number;
}

/** Commands that do not carry extra data beyond the game id. */
export interface SimpleCommandMessage {
  readonly t: 'resign' | 'offerDraw' | 'acceptDraw' | 'declineDraw' | 'claimFlag' | 'abort';
  readonly gameId: string;
}

/** Reconnect: ask for current state plus everything after `lastPly`. */
export interface ResumeMessage {
  readonly t: 'resume';
  readonly gameId: string;
  readonly lastPly: number;
}

/** Latency probe; the server echoes `ts` and adds its own timestamp. */
export interface PingMessage {
  readonly t: 'ping';
  readonly ts: number;
}

/** The discriminated union of everything a client may send. */
export type ClientMessage =
  | JoinMessage
  | MoveMessage
  | SimpleCommandMessage
  | ResumeMessage
  | PingMessage;

// ─── Server → Client ────────────────────────────────────────────────────────

/** Acknowledges a join and delivers the assigned role + current state. */
export interface JoinedMessage {
  readonly t: 'joined';
  readonly gameId: string;
  readonly role: Role;
  readonly state: StateView;
}

/** A full authoritative state push (e.g. after resume or reconciliation). */
export interface StateMessage {
  readonly t: 'state';
  readonly gameId: string;
  readonly state: StateView;
}

/** An applied, authoritative move broadcast to every member of a room. */
export interface MoveBroadcast {
  readonly t: 'move';
  readonly gameId: string;
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly by: Color;
  readonly fenHash: string;
  readonly clock: ClockView;
  readonly serverTs: number;
  /**
   * Legal destinations for the side to move in the **resulting** position
   * (after this move has been applied). Empty (`{}`) when the move ended the
   * game. This is the push-based refresh mechanism: every broadcast carries
   * the authoritative legal-move map so clients never starve after a live move.
   */
  readonly legalMoves: LegalMoves;
}

/** A terminal event broadcast to every member of a room. */
export interface EndedBroadcast {
  readonly t: 'ended';
  readonly gameId: string;
  readonly result: ResultString;
  readonly termination: Termination;
  readonly winner: Color | null;
  readonly serverTs: number;
}

/**
 * A seat's readiness became durable (ADR-0148). Fanned out through the game channel so a client on
 * any gateway replica learns it; carries both seats so it is safe to apply in any order.
 */
export interface ReadyBroadcast {
  readonly t: 'ready';
  readonly gameId: string;
  readonly ready: ReadyView;
  readonly serverTs: number;
}

/**
 * A minimal live snapshot of a single board within a tournament.
 * Sourced from the authority's `StateView`.
 */
export interface LiveBoardView {
  readonly gameId: string;
  readonly white: string;
  readonly black: string;
  readonly ply: number;
  readonly turn: Color;
  readonly fen: string;
  readonly fenHash: string;
  readonly clock: ClockView;
  readonly status: StateView['status'];
}

/** 
 * Broadcast of a live tournament's active boards, fanned out to spectators.
 */
export interface TournamentUpdateBroadcast {
  readonly t: 'tournamentUpdate';
  readonly tournamentId: string;
  readonly games: readonly LiveBoardView[];
  readonly serverTs: number;
}

/** Room presence: who occupies the player seats and how many are watching. */
export interface PresenceMessage {
  readonly t: 'presence';
  readonly gameId: string;
  readonly white: boolean;
  readonly black: boolean;
  readonly spectators: number;
}

/** Response to {@link ResumeMessage}: current state + missed broadcasts. */
export interface ResumedMessage {
  readonly t: 'resumed';
  readonly gameId: string;
  readonly state: StateView;
  readonly missed: readonly GameBroadcast[];
}

/**
 * A rejected intent. `ref` echoes the `clientSeq` of the offending move so the
 * client can roll back exactly that optimistic render.
 */
export interface RejectMessage {
  readonly t: 'reject';
  readonly gameId: string;
  readonly ref: number | null;
  readonly code: RejectCode;
  readonly message: string;
}

/** Machine-readable rejection reasons. */
export type RejectCode =
  | 'illegal_move'
  | 'not_your_turn'
  | 'not_a_player'
  | 'stale_seq'
  | 'unknown_game'
  | 'not_joined'
  | 'invalid_command'
  | 'unauthorized'
  /** The first move of a game with a pregame lifecycle, before both seats are durably ready. */
  | 'not_ready';

/** Echoed latency probe; carries the server timestamp for RTT estimation. */
export interface PongMessage {
  readonly t: 'pong';
  readonly ts: number;
  readonly serverTs: number;
}

/** The discriminated union of everything the server may send. */
export type ServerMessage =
  | JoinedMessage
  | StateMessage
  | MoveBroadcast
  | EndedBroadcast
  | PresenceMessage
  | ResumedMessage
  | RejectMessage
  | PongMessage
  | TournamentUpdateBroadcast
  | ReadyBroadcast;

/** What the authority publishes for one game's committed events. */
export type GameBroadcast = MoveBroadcast | EndedBroadcast | ReadyBroadcast;

/** Broadcasts fanned out to a whole room (as opposed to point-to-point replies). */
export type Broadcast = GameBroadcast | TournamentUpdateBroadcast;

// ─── Default JSON codec ─────────────────────────────────────────────────────

/** Serialize a server message to a string frame (default JSON codec). */
export function encode(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse a client frame. Returns `null` for malformed input or unknown message
 * types rather than throwing, so a hostile client cannot crash the gateway.
 */
export function decode(frame: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const t = parsed['t'];
  switch (t) {
    case 'join': {
      if (!isNonEmptyString(parsed['gameId'], 256)) return null;
      const token = parsed['token'];
      if (token !== undefined && !isNonEmptyString(token, 16_384)) return null;
      return token === undefined
        ? { t, gameId: parsed['gameId'] }
        : { t, gameId: parsed['gameId'], token };
    }
    case 'move':
      if (!isNonEmptyString(parsed['gameId'], 256)) return null;
      if (!isNonEmptyString(parsed['uci'], 32)) return null;
      if (!isPositiveSafeInteger(parsed['clientSeq'])) return null;
      return {
        t,
        gameId: parsed['gameId'],
        uci: parsed['uci'],
        clientSeq: parsed['clientSeq'],
      };
    case 'resign':
    case 'offerDraw':
    case 'acceptDraw':
    case 'declineDraw':
    case 'claimFlag':
    case 'abort':
      return isNonEmptyString(parsed['gameId'], 256)
        ? { t, gameId: parsed['gameId'] }
        : null;
    case 'resume':
      if (!isNonEmptyString(parsed['gameId'], 256)) return null;
      if (!isNonNegativeSafeInteger(parsed['lastPly'])) return null;
      return { t, gameId: parsed['gameId'], lastPly: parsed['lastPly'] };
    case 'ping':
      return isFiniteNumber(parsed['ts']) ? { t, ts: parsed['ts'] } : null;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
