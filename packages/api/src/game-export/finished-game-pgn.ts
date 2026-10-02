/**
 * @packageDocumentation
 * Finished-game PGN export (ADR-0154): one completed durable event stream in, one PGN game out.
 *
 * The event log is the only source. The `games` projection holds no moves and may lag the log, so
 * nothing here reads it. Stream invariants are checked by the projection's own validator
 * ({@link projectGameStream}) and every stored move is replayed through the authority
 * ({@link Game.fromEvents}), so a stream no authority could have written is refused, never exported.
 */

import { Position } from '@chess-platform/core';
import {
  Game,
  type GameCreatedEvent,
  type GameEndedEvent,
  type MovePlayedEvent,
  type ResultString,
  type Termination,
  type TimeControl,
} from '@chess-platform/game';
import {
  CorruptGameStreamError,
  projectGameStream,
  type EventStore,
  type StoredEvent,
} from '@chess-platform/persistence';
import { isPgnResult, serializePgn, type PgnTag } from '@chess-platform/studies';
import { botAccountByUserId } from '../bot/catalogue';
import type { PlayerHandles } from '../commentary/ports';
import { HttpError } from '../http/errors';

/** The media type of a PGN document, as the study export already serves it. */
export const PGN_CONTENT_TYPE = 'application/x-chess-pgn; charset=utf-8';

/** PGN's value for a tag whose fact is unknown. */
const UNKNOWN = '?';

const STANDARD_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** A completed game as its durable stream records it. */
export interface FinishedGameRecord {
  readonly created: GameCreatedEvent;
  /** In committed order. */
  readonly moves: readonly MovePlayedEvent[];
  readonly ended: GameEndedEvent;
}

/** What a PGN reader is told each seat is called. */
export interface SeatNames {
  readonly white: string;
  readonly black: string;
}

/**
 * Read a finished game from its complete committed stream.
 *
 * @returns the game, or `null` when the stream is valid but has no `GameEnded` yet.
 * @throws CorruptGameStreamError for a stream no authority could have written.
 */
export function readFinishedGame(gameId: string, stream: readonly StoredEvent[]): FinishedGameRecord | null {
  const projection = projectGameStream(gameId, stream);
  const events = stream.map((entry) => entry.event);
  const created = events[0];
  if (created?.type !== 'GameCreated' || created.gameId !== gameId) {
    throw new CorruptGameStreamError(gameId, 'GameCreated names a different game');
  }
  try {
    Game.fromEvents(events);
  } catch (err) {
    throw new CorruptGameStreamError(gameId, `replay failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (projection.result === null) return null;

  // `projectGameStream` refuses anything after `GameEnded`, so a result means it is the last event.
  const ended = events[events.length - 1];
  if (ended?.type !== 'GameEnded' || !isPgnResult(ended.result)) {
    throw new CorruptGameStreamError(gameId, 'GameEnded has no PGN result');
  }
  const contradiction = endingContradiction(ended);
  if (contradiction !== null) throw new CorruptGameStreamError(gameId, `GameEnded ${contradiction}`);

  const moves = events.filter((event): event is MovePlayedEvent => event.type === 'MovePlayed');
  const mismatch = sanMismatch(created, moves);
  if (mismatch !== null) throw new CorruptGameStreamError(gameId, mismatch);
  return { created, moves, ended };
}

const DECISIVE: readonly ResultString[] = ['1-0', '0-1'];
const DRAW: readonly ResultString[] = ['1/2-1/2'];

/**
 * The results each termination can carry, exactly as `packages/game/src/game.ts` writes them. It is the
 * only producer of `GameEnded`:
 *
 * - checkmate, resignation and timeout are always decisive. A flag against a side that cannot win is
 *   recorded as `insufficient_material`, not as a drawn `timeout` (`endByTimeout`).
 * - a variant ending is a variant win or a variant draw (`terminalEventFor`).
 * - an abort has no result.
 * - a no-show is `*` (a seek, or neither seat ready) or a forfeit win (`noShowVerdict`), never a draw.
 *
 * A `Record` over the whole union, so a new termination fails to compile until its results are decided.
 */
const RESULTS_BY_TERMINATION: Readonly<Record<Termination, readonly ResultString[]>> = {
  checkmate: DECISIVE,
  resignation: DECISIVE,
  timeout: DECISIVE,
  stalemate: DRAW,
  agreement: DRAW,
  insufficient_material: DRAW,
  fifty_move: DRAW,
  threefold: DRAW,
  variant: [...DECISIVE, ...DRAW],
  aborted: ['*'],
  no_show: ['*', ...DECISIVE],
};

/** Why an ending's result, winner and termination disagree, or `null` when they agree. */
function endingContradiction(ended: GameEndedEvent): string | null {
  const allowed = Object.hasOwn(RESULTS_BY_TERMINATION, ended.termination)
    ? RESULTS_BY_TERMINATION[ended.termination]
    : undefined;
  if (allowed === undefined) return `has unknown termination ${JSON.stringify(ended.termination)}`;
  if (!allowed.includes(ended.result)) return `records ${ended.termination} with result ${ended.result}`;
  const winner = ended.result === '1-0' ? 'w' : ended.result === '0-1' ? 'b' : null;
  if (ended.winner !== winner) return `names winner ${String(ended.winner)} for result ${ended.result}`;
  return null;
}

/**
 * Why a stored SAN does not denote the stored UCI move, or `null` when every one does.
 *
 * Replay checks the UCI; the SAN is what the export writes. A SAN for another move would make the PGN
 * describe a different game, and text that is not SAN at all could forge movetext or tags. Each stored
 * SAN must equal the authority's SAN for its move, apart from check, mate and annotation suffixes and
 * the `0-0` castling spelling.
 */
function sanMismatch(created: GameCreatedEvent, moves: readonly MovePlayedEvent[]): string | null {
  let position = Position.fromFen(created.initialFen, created.variant);
  for (const move of moves) {
    const legal = position.legalMoves().find((candidate) => position.toUci(candidate) === move.uci);
    if (legal === undefined) return `move ${move.ply} (${move.uci}) is not legal`;
    if (typeof move.san !== 'string' || bareSan(move.san) !== bareSan(position.toSan(legal))) {
      return `move ${move.ply} stores SAN ${JSON.stringify(move.san)} for ${move.uci}`;
    }
    position = position.play(legal);
  }
  return null;
}

function bareSan(san: string): string {
  return san.replace(/[!?]+$/, '').replace(/[+#]+$/, '').replace(/^0-0-0$/, 'O-O-O').replace(/^0-0$/, 'O-O');
}

/** Write a finished game as one PGN game. Every tag value goes through the serializer's escaping. */
export function finishedGamePgn(game: FinishedGameRecord, names: SeatNames): string {
  const { created, moves, ended } = game;
  const tags: PgnTag[] = [
    { key: 'Event', value: UNKNOWN },
    { key: 'Site', value: UNKNOWN },
    { key: 'Date', value: pgnDate(created.at) },
    { key: 'Round', value: UNKNOWN },
    { key: 'White', value: names.white },
    { key: 'Black', value: names.black },
    { key: 'Result', value: ended.result },
  ];
  // The Rookzen variant id, as the study export already writes it.
  if (created.variant !== 'standard') tags.push({ key: 'Variant', value: created.variant });
  // Chess960 position 518 has the standard FEN, so Chess960 always states its start.
  const setUp = created.initialFen !== STANDARD_START_FEN || created.variant === 'chess960';
  if (setUp) {
    tags.push({ key: 'SetUp', value: '1' }, { key: 'FEN', value: created.initialFen });
  }
  const timeControl = pgnTimeControl(created.timeControl);
  if (timeControl !== undefined) tags.push({ key: 'TimeControl', value: timeControl });

  return serializePgn({
    tags,
    preComments: [],
    ...(setUp ? { startingMove: startingMoveOf(created) } : {}),
    moves: moves.map((move) => ({ san: move.san, nags: [], comments: [], variations: [] })),
    result: ended.result,
  });
}

/** The UTC calendar date of `at` as `YYYY.MM.DD`, or PGN's unknown date when it has no 4-digit year. */
export function pgnDate(at: number): string {
  const date = new Date(at);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(year) || year < 0 || year > 9999) return '????.??.??';
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  return `${pad(year, 4)}.${pad(date.getUTCMonth() + 1, 2)}.${pad(date.getUTCDate(), 2)}`;
}

/**
 * The PGN `TimeControl` value for a Rookzen control, or `undefined` when PGN cannot state it exactly.
 *
 * Follows what the clock does, which is decided by `kind`: increment is added only for `increment`
 * and delay is subtracted only for `delay`. PGN has no delay notation, and its values are whole
 * seconds, so a delay control or a fractional second is left out rather than approximated.
 * `unlimited` is PGN's own "-" (no time control).
 */
export function pgnTimeControl(tc: TimeControl): string | undefined {
  if (tc.kind === 'unlimited') return '-';
  if (tc.kind === 'delay') return undefined;
  const base = wholeSeconds(tc.initialMs);
  if (base === undefined || base <= 0) return undefined;
  if (tc.kind === 'sudden_death') return String(base);
  const increment = wholeSeconds(tc.incrementMs);
  return increment === undefined ? undefined : `${base}+${increment}`;
}

function wholeSeconds(ms: number): number | undefined {
  return Number.isSafeInteger(ms) && ms >= 0 && ms % 1000 === 0 ? ms / 1000 : undefined;
}

/**
 * The move number and side of the first move, as chess-core parses the starting FEN. Read from the
 * parsed position rather than the text, because a Three-Check FEN may end with its check counters.
 */
function startingMoveOf(created: GameCreatedEvent): { number: number; color: 'w' | 'b' } {
  const start = Position.fromFen(created.initialFen, created.variant).snapshot();
  return {
    number: Number.isSafeInteger(start.fullmoves) && start.fullmoves >= 1 ? start.fullmoves : 1,
    color: start.turn,
  };
}

/**
 * The name PGN gives a seat: the account's handle, else the engine bot's catalogue handle, else
 * PGN's unknown. Never the internal seat reference.
 */
export function seatName(playerId: string, handles: ReadonlyMap<string, string>): string {
  return handles.get(playerId) ?? botAccountByUserId(playerId)?.handle ?? UNKNOWN;
}

/** The HTTP-facing export: one stream read, one batched identity read, pure serialization. */
export class FinishedGamePgnService {
  constructor(
    private readonly events: Pick<EventStore, 'load'>,
    private readonly players: PlayerHandles,
  ) {}

  /**
   * @throws HttpError 404 for an unknown game, 409 for one that has not ended, 503 once cancelled.
   * @throws CorruptGameStreamError for a stream no authority could have written.
   */
  async export(gameId: string, signal: AbortSignal): Promise<string> {
    throwIfCancelled(signal);
    const stream = await this.events.load(gameId);
    if (stream.length === 0) throw HttpError.notFound('game not found');
    const game = readFinishedGame(gameId, stream);
    if (game === null) throw HttpError.conflict('game has not finished');

    throwIfCancelled(signal);
    const { white, black } = game.created.players;
    const handles = await this.players.handles([white, black]);
    return finishedGamePgn(game, { white: seatName(white, handles), black: seatName(black, handles) });
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw HttpError.unavailable('PGN export was cancelled');
}
