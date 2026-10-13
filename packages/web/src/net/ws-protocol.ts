/**
 * Realtime wire protocol (frontend mirror of M3 `@chess-platform/realtime-gateway`).
 *
 * A hand-authored, framework-independent mirror of the gateway's message
 * contract (`packages/realtime-gateway/src/protocol.ts`) — the same philosophy as
 * `api/models.ts` mirroring the REST OpenAPI. Two families flow over one duplex
 * connection:
 *   - {@link ClientMessage}: intents the client sends (join, move, resume, ping…).
 *   - {@link ServerMessage}: authoritative replies and room broadcasts.
 *
 * The **server is authoritative**: a client submits an intended move with a
 * monotonically increasing `clientSeq`; the gateway either broadcasts the applied
 * move or returns a {@link RejectMessage} echoing that `clientSeq` so the client
 * rolls back exactly that optimistic render. Reconnection is `lastPly`-based.
 *
 * Wire colors are `'w' | 'b'` (the core/game domain), distinct from the web UI's
 * `'white' | 'black'` orientation type.
 */
import { VARIANTS, type Variant } from '../api/models.js';

export type { Variant };

/** Side to move / mover, in wire form. */
export type WsColor = 'w' | 'b';

/** The role a connection holds in a game. */
export type Role = 'white' | 'black' | 'spectator';

/** Remaining clock (ms) for both sides. */
export interface ClockView {
  readonly w: number;
  readonly b: number;
}

/** A single played move in the compact form clients render/animate. */
export interface MoveView {
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly by: WsColor;
}

export interface Players {
  readonly white: string;
  readonly black: string;
}

export interface TimeControl {
  readonly initialMs: number;
  readonly incrementMs: number;
  readonly delayMs: number;
  readonly kind: 'increment' | 'delay' | 'sudden_death' | 'unlimited';
}

export type ResultString = '1-0' | '0-1' | '1/2-1/2' | '*';

export type Termination =
  | 'checkmate'
  | 'resignation'
  | 'timeout'
  | 'stalemate'
  | 'agreement'
  | 'insufficient_material'
  | 'fifty_move'
  | 'threefold'
  | 'variant'
  | 'aborted'
  /** Pregame no-show (ADR-0148): no first move before the deadline. Never a chess timeout. */
  | 'no_show';

export type GameStatus =
  | { readonly over: false }
  | {
      readonly over: true;
      readonly result: ResultString;
      readonly termination: Termination;
      readonly winner: WsColor | null;
    };

/**
 * Legal destination squares for the side to move, keyed by origin square (both
 * in UCI square notation, e.g. `{ "e2": ["e3", "e4"] }`). Server-authoritative
 * (computed by the core engine on the gateway); empty (`{}`) once the game is
 * over. The frontend consumes this — it never derives legality itself.
 */
export type LegalMoves = { readonly [from: string]: readonly string[] };

/** A complete authoritative snapshot; sufficient on its own to render a game. */
export interface StateView {
  /** Absent on legacy servers; presence does not advertise durable recovery. */
  readonly stateRevision?: number;
  readonly gameId: string;
  readonly variant: Variant;
  readonly players: Players;
  readonly timeControl: TimeControl;
  readonly fen: string;
  /** Short stable hash of `fen` for cheap desync detection. */
  readonly fenHash: string;
  readonly ply: number;
  readonly turn: WsColor;
  readonly clock: ClockView;
  /** Server timestamp (ms since epoch) when current turn began, or null if unlimited/not started. */
  readonly turnStartedAt: number | null;
  readonly status: GameStatus;
  readonly drawOffer: WsColor | null;
  readonly moves: readonly MoveView[];
  /** Legal destinations for the side to move (authoritative; empty once over). */
  readonly legalMoves: LegalMoves;
  /**
   * For a `chess960` game, the Scharnagl id (0..959) of the arrangement it started from; `null` for
   * every other variant, and for a Chess960 game whose id was never recorded (ADR-0137).
   *
   * The client displays it and does nothing else with it. It is **not** used to build a board:
   * `fen` is the authoritative position and stays the only thing the board renders, so the browser
   * never becomes a second opinion on what position 348 looks like.
   */
  readonly chess960StartId: number | null;
  /**
   * Durable readiness per seat, or `null` for a game without a pregame lifecycle (ADR-0148). Folded
   * from the server's event log; the client only displays it and gates its own board with it — the
   * server refuses an early first move regardless. Absent from a gateway older than ADR-0148, which
   * a rolling deploy makes normal; `GameSync` reads absence as `null`.
   */
  readonly ready?: ReadyView | null;
}

/** Durable readiness of both seats. */
export interface ReadyView {
  readonly w: boolean;
  readonly b: boolean;
}

// ─── Client → Server ─────────────────────────────────────────────────────────

export interface JoinMessage {
  readonly t: 'join';
  readonly gameId: string;
  /** Access token; required for players, optional for anonymous spectators. */
  readonly token?: string;
}

export interface MoveMessage {
  readonly t: 'move';
  readonly gameId: string;
  readonly uci: string;
  readonly clientSeq: number;
}

export type SimpleCommand =
  | 'resign'
  | 'offerDraw'
  | 'acceptDraw'
  | 'declineDraw'
  | 'claimFlag'
  | 'abort';

export interface SimpleCommandMessage {
  readonly t: SimpleCommand;
  readonly gameId: string;
}

export interface ResumeMessage {
  readonly t: 'resume';
  readonly gameId: string;
  readonly lastPly: number;
}

export interface PingMessage {
  readonly t: 'ping';
  readonly ts: number;
}

export type ClientMessage =
  | JoinMessage
  | MoveMessage
  | SimpleCommandMessage
  | ResumeMessage
  | PingMessage;

// ─── Server → Client ─────────────────────────────────────────────────────────

export interface JoinedMessage {
  readonly t: 'joined';
  readonly gameId: string;
  readonly role: Role;
  readonly state: StateView;
}

export interface StateMessage {
  readonly t: 'state';
  readonly gameId: string;
  readonly state: StateView;
}

export interface MoveBroadcast {
  readonly stateRevision?: number;
  readonly t: 'move';
  readonly gameId: string;
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly by: WsColor;
  readonly fenHash: string;
  readonly clock: ClockView;
  readonly serverTs: number;
  /**
   * Legal destinations for the side to move in the **resulting** position
   * at this event's durable prefix, before any subsequent GameEnded event.
   * This is the push-based refresh mechanism: every broadcast carries
   * the authoritative legal-move map so clients never starve after a live move.
   */
  readonly legalMoves: LegalMoves;
}

export interface EndedBroadcast {
  readonly stateRevision?: number;
  readonly t: 'ended';
  readonly gameId: string;
  readonly result: ResultString;
  readonly termination: Termination;
  readonly winner: WsColor | null;
  readonly serverTs: number;
}

/** A seat's readiness became durable; carries both seats (ADR-0148). */
export interface ReadyBroadcast {
  readonly stateRevision?: number;
  readonly t: 'ready';
  readonly gameId: string;
  readonly ready: ReadyView;
  readonly serverTs: number;
}

export interface PresenceMessage {
  readonly t: 'presence';
  readonly gameId: string;
  readonly white: boolean;
  readonly black: boolean;
  readonly spectators: number;
}

export interface ResumedMessage {
  readonly t: 'resumed';
  readonly gameId: string;
  readonly state: StateView;
  readonly missed: readonly (MoveBroadcast | EndedBroadcast | ReadyBroadcast)[];
}

export type RejectCode =
  | 'command_expired'
  | 'illegal_move'
  | 'not_your_turn'
  | 'not_a_player'
  | 'stale_seq'
  | 'unknown_game'
  | 'not_joined'
  | 'invalid_command'
  | 'unauthorized'
  | 'not_ready';

export interface RejectMessage {
  readonly t: 'reject';
  readonly gameId: string;
  readonly ref: number | null;
  readonly code: RejectCode;
  readonly message: string;
}

/** Acknowledgement uncertainty, never a confirmed rejection or cancellation. */
export interface OutcomeUnknownMessage {
  readonly t: 'outcomeUnknown';
  readonly code: 'outcome_unknown';
  readonly gameId: string;
  readonly ref: number | null;
  readonly requestId: string;
  readonly action?: SimpleCommand | 'ready';
  readonly readyColor?: WsColor;
  readonly message: string;
}

export interface CommandConfirmedMessage {
  readonly t: 'commandConfirmed';
  readonly gameId: string;
  readonly requestId: string;
}

export interface PongMessage {
  readonly t: 'pong';
  readonly ts: number;
  readonly serverTs: number;
}

export type ServerMessage =
  | CommandConfirmedMessage
  | OutcomeUnknownMessage
  | JoinedMessage
  | StateMessage
  | MoveBroadcast
  | EndedBroadcast
  | PresenceMessage
  | ResumedMessage
  | RejectMessage
  | PongMessage
  | ReadyBroadcast;

// ─── Codec ───────────────────────────────────────────────────────────────────

const SERVER_TYPES: ReadonlySet<string> = new Set([
  'joined',
  'state',
  'move',
  'ended',
  'presence',
  'resumed',
  'reject',
  'outcomeUnknown',
  'commandConfirmed',
  'pong',
  'ready',
]);

/** PostgreSQL INTEGER limit; independent of clientSeq's validation contract. */
const MAX_STATE_REVISION = 2_147_483_647;

/** Serialize a client intent to a string frame (default JSON codec). */
export function encodeClient(msg: ClientMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse a server frame. Returns `null` for malformed input or unknown message
 * types rather than throwing, so a hostile/buggy server cannot crash the client.
 */
export function decodeServer(frame: string, mode: 'legacy' | 'revision' = 'legacy'): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return null;
  }
  if (!record(parsed) || typeof parsed.t !== 'string' || !SERVER_TYPES.has(parsed.t)) return null;
  return validRevisionFrame(parsed, mode) ? parsed as unknown as ServerMessage : null;
}

function validRevisionFrame(parsed: Record<string, unknown>, mode: 'legacy' | 'revision'): boolean {
  const type = parsed.t;
  if (typeof type !== 'string') return false;
  const snapshot = ['joined', 'state', 'resumed'].includes(type);
  const event = ['move', 'ready', 'ended'].includes(type);
  if (!snapshot && !event) return true;
  const payload = snapshot ? parsed.state : parsed;
  if (!record(payload)) return false;
  const revisioned = Object.hasOwn(payload, 'stateRevision');
  if (!revisioned && mode === 'revision') return false;
  if (revisioned && !(snapshot ? validState(payload) : validEvent(parsed))) return false;
  if (snapshot && revisioned && (parsed.gameId !== payload.gameId ||
      (parsed.t === 'joined' && (typeof parsed.role !== 'string' || !['white', 'black', 'spectator'].includes(parsed.role))))) return false;
  if (parsed.t === 'resumed') {
    if (!Array.isArray(parsed.missed)) return false;
    for (const missed of parsed.missed) {
      if (!record(missed) || typeof missed.t !== 'string' || !['move', 'ready', 'ended'].includes(missed.t) ||
          Object.hasOwn(missed, 'stateRevision') !== revisioned ||
          (revisioned && (!validEvent(missed) || missed.gameId !== parsed.gameId))) return false;
    }
  }
  return true;
}

export type LegacyStateView = StateView & { readonly stateRevision?: never };
export type RevisionedStateView = StateView & { readonly stateRevision: number };

/** A stamp identifies the wire format, not freshness, replay capability or command confirmation. */
export function isRevisionedState(state: StateView): state is RevisionedStateView {
  return validRevision(state.stateRevision);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_STATE_REVISION;
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function color(value: unknown): boolean { return value === 'w' || value === 'b'; }
function clock(value: unknown): boolean { return record(value) && nonnegative(value.w) && nonnegative(value.b); }
function ready(value: unknown): boolean { return record(value) && typeof value.w === 'boolean' && typeof value.b === 'boolean'; }
function legalMoves(value: unknown): boolean {
  return record(value) && Object.entries(value).every(([from, destinations]) => /^(?:[a-h][1-8]|[PNBRQ]@)$/.test(from) &&
    Array.isArray(destinations) && destinations.every(to => typeof to === 'string' && /^[a-h][1-8]$/.test(to)));
}

const TERMINATIONS: readonly Termination[] = [
  'checkmate', 'resignation', 'timeout', 'stalemate', 'agreement', 'insufficient_material',
  'fifty_move', 'threefold', 'variant', 'aborted', 'no_show',
];
function ending(value: Record<string, unknown>): boolean {
  return typeof value.result === 'string' && ['1-0', '0-1', '1/2-1/2', '*'].includes(value.result) &&
    TERMINATIONS.some(t => t === value.termination) && (value.winner === null || color(value.winner));
}

function validState(value: Record<string, unknown>): boolean {
  const tc = value.timeControl;
  const status = value.status;
  return validRevision(value.stateRevision) && typeof value.gameId === 'string' && value.gameId.length > 0 &&
    VARIANTS.some(v => v === value.variant) && record(value.players) &&
    typeof value.players.white === 'string' && typeof value.players.black === 'string' &&
    record(tc) && nonnegative(tc.initialMs) && nonnegative(tc.incrementMs) && nonnegative(tc.delayMs) &&
    typeof tc.kind === 'string' && ['increment', 'delay', 'sudden_death', 'unlimited'].includes(tc.kind) &&
    typeof value.fen === 'string' && typeof value.fenHash === 'string' &&
    typeof value.ply === 'number' && Number.isSafeInteger(value.ply) && value.ply >= 0 && color(value.turn) &&
    clock(value.clock) && (value.turnStartedAt === null || nonnegative(value.turnStartedAt)) &&
    record(status) && (status.over === false || (status.over === true && ending(status))) &&
    (value.drawOffer === null || color(value.drawOffer)) && Array.isArray(value.moves) &&
    value.moves.every(move => record(move) && typeof move.ply === 'number' && Number.isSafeInteger(move.ply) &&
      move.ply > 0 && typeof move.uci === 'string' && typeof move.san === 'string' && color(move.by)) &&
    legalMoves(value.legalMoves) && (value.chess960StartId === null ||
      (typeof value.chess960StartId === 'number' && Number.isInteger(value.chess960StartId) &&
       value.chess960StartId >= 0 && value.chess960StartId <= 959)) &&
    (value.ready === null || ready(value.ready));
}

function validEvent(value: Record<string, unknown>): boolean {
  if (!validRevision(value.stateRevision) || value.stateRevision === 0 ||
      typeof value.gameId !== 'string' || value.gameId.length === 0 || !nonnegative(value.serverTs)) return false;
  switch (value.t) {
    case 'ready': return ready(value.ready);
    case 'ended': return ending(value);
    case 'move': return typeof value.ply === 'number' && Number.isSafeInteger(value.ply) && value.ply > 0 &&
      typeof value.uci === 'string' && typeof value.san === 'string' && color(value.by) &&
      typeof value.fenHash === 'string' && clock(value.clock) && legalMoves(value.legalMoves);
    default: return false;
  }
}

/** The opposite side to move. */
export function opposite(color: WsColor): WsColor {
  return color === 'w' ? 'b' : 'w';
}

/** Wire color for a role, or null for spectators. */
export function colorForRole(role: Role): WsColor | null {
  if (role === 'white') return 'w';
  if (role === 'black') return 'b';
  return null;
}
