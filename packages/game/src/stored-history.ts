/**
 * @packageDocumentation
 * `@chess-platform/game/stored-history` — replay of a game's complete durable event log (#127).
 *
 * Before #127 the atomic rules let a king capture next to the enemy king, and let any capture explode
 * both kings. Such a move leaves no king at all, so it always ended the game at once with
 * `GameEnded { 0-1, variant, winner b }` (white's missing king is found first), written by the same
 * command in the same append. Correct rules reject the move, so a strict replay of that stored game
 * now fails. This module replays stored histories exactly as {@link Game.fromEvents} does, except that
 * one such stored move is admitted when the history ends with precisely that signature. Live play,
 * `Game.fromEvents`, `withEvents`, `Position.play` and `legalMoves` never admit it.
 *
 * **Trust contract.** The rows must be what `EventStore.load(gameId)` returned. Their shape is checked
 * (ids, contiguous `seq` from 0, one `GameCreated` first, contiguous plies and movers, nothing after the
 * one `GameEnded`), but nothing here can prove that a first-party caller did not fabricate an internally
 * consistent finished history; only review and the consumer allowlist test guard that. A truncated
 * history never reaches the exception: without its `GameEnded` the legacy move fails strictly, as before.
 * Whatever is admitted is a finished `0-1` game, which refuses every command.
 */

import {
  applyMove,
  findKing,
  generatePseudoLegal,
  Position,
  toFen,
  type Move,
} from '@chess-platform/core';
import { Game, GameError, type GameState } from './game';
import type { GameEvent, MovePlayedEvent } from './events';
import { FOLD_STORED } from './internal/stored-replay-key';

/** One stored row, as `EventStore.load` returns it (only the fields replay needs). */
export interface StoredHistoryRow {
  readonly gameId: string;
  readonly seq: number;
  readonly version: number;
  readonly event: GameEvent;
}

/** One replayed move, with the positions around it. */
export interface StoredPly {
  readonly event: MovePlayedEvent;
  readonly before: Position;
  readonly after: Position;
  /** True only for the admitted pre-#127 atomic move, which the current rules reject. */
  readonly historical: boolean;
}

export interface StoredHistory {
  readonly game: Game;
  /** The ply of the admitted pre-#127 move, or `null` when every move is legal today. */
  readonly historicalPly: number | null;
}

/** A stored history that is malformed, or that no version of the rules could have written. */
export class StoredHistoryError extends GameError {
  constructor(gameId: string, reason: string) {
    super(`stored history of game ${gameId} ${reason}`);
    this.name = 'StoredHistoryError';
  }
}

/**
 * The only event version the defect could have written: it was live while version 1 was current, so a
 * row the store records under any other version cannot carry a pre-#127 move. Mirrors persistence's
 * `CURRENT_EVENT_VERSION`, which this package cannot import (persistence depends on it).
 */
const PRE_127_EVENT_VERSION = 1;

/**
 * Replay a game from its complete stored history.
 *
 * `onPly` is called once per move, in order, before the move is folded; per-ply positions are not
 * retained, so memory beyond the returned `Game` does not grow with the game. Throws
 * {@link StoredHistoryError} for a malformed history and the strict replay error for an illegal move.
 */
export function replayStoredHistory(
  gameId: string,
  rows: readonly StoredHistoryRow[],
  onPly?: (ply: StoredPly) => void,
): StoredHistory {
  assertWellFormed(gameId, rows);
  const events = rows.map((row) => row.event);
  let historicalPly: number | null = null;
  const game = Game[FOLD_STORED](
    events,
    (index, state, event) => {
      const after = admitPre127Atomic(rows, index, state, event);
      if (after !== null) historicalPly = event.ply;
      return after;
    },
    (state, event, after, admitted) => {
      if (event.by !== state.position.turn) {
        throw new StoredHistoryError(gameId, `has move ${event.ply} played by ${event.by} on ${state.position.turn}'s turn`);
      }
      onPly?.({ event, before: state.position, after, historical: admitted });
    },
  );
  return { game, historicalPly };
}

/** The stream-shape rules every durable log satisfies, mirroring persistence's `projectGameStream`. */
function assertWellFormed(gameId: string, rows: readonly StoredHistoryRow[]): void {
  const fail = (reason: string): never => {
    throw new StoredHistoryError(gameId, reason);
  };
  if (rows.length === 0) fail('is empty');
  let ply = 0;
  for (const [index, row] of rows.entries()) {
    if (row.gameId !== gameId) fail(`has row ${index} for game ${JSON.stringify(row.gameId)}`);
    if (row.seq !== index) fail(`has seq ${JSON.stringify(row.seq)} at position ${index}`);
    const event = row.event;
    if ((index === 0) !== (event.type === 'GameCreated')) fail(`has ${event.type} at seq ${index}`);
    if (event.type === 'GameCreated' && event.gameId !== gameId) fail(`was created as game ${JSON.stringify(event.gameId)}`);
    if (event.type === 'GameEnded' && index !== rows.length - 1) fail(`continues after GameEnded at seq ${index}`);
    if (event.type === 'MovePlayed' && event.ply !== ++ply) fail(`has ply ${JSON.stringify(event.ply)} where ${ply} belongs`);
  }
}

/**
 * The position a pre-#127 atomic move led to, or `null` unless every part of its signature holds:
 * an atomic game; the move is the second-to-last row and the last is the `GameEnded { 0-1, variant,
 * winner b }` the same command wrote at the same instant, no earlier than the previous move; both rows
 * are version 1; the move is a
 * capture the unchanged explosion mechanics can play; it leaves no king of either colour; and its stored
 * SAN names that capture. The mover and ply are checked for every move by the caller.
 */
function admitPre127Atomic(
  rows: readonly StoredHistoryRow[],
  index: number,
  state: GameState,
  event: MovePlayedEvent,
): Position | null {
  const ending = rows[index + 1];
  if (state.variant !== 'atomic' || index !== rows.length - 2 || ending === undefined) return null;
  const ended = ending.event;
  if (
    ended.type !== 'GameEnded' ||
    ended.result !== '0-1' ||
    ended.termination !== 'variant' ||
    ended.winner !== 'b' ||
    ended.at !== event.at ||
    event.at < (state.moves.at(-1)?.at ?? state.createdAt)
  ) {
    return null;
  }
  if (rows[index]!.version !== PRE_127_EVENT_VERSION || ending.version !== PRE_127_EVENT_VERSION) return null;

  const before = state.position;
  const move = generatePseudoLegal(before.snapshot()).find((m) => before.toUci(m) === event.uci);
  if (move?.captured === undefined) return null;
  const after = applyMove(before.snapshot(), move);
  if (findKing(after, 'w') !== -1 || findKing(after, 'b') !== -1) return null;
  if (!sanNames(event.san, move, before)) return null;
  return Position.fromFen(toFen(after), 'atomic');
}

/**
 * Whether stored SAN names `move`. The current `toSan` cannot be asked, since its disambiguation reads
 * today's legal moves, so the SAN is parsed: piece (or pawn file), optional disambiguation, the capture
 * mark, target and promotion must all agree with the move, ignoring check and annotation suffixes.
 */
function sanNames(san: unknown, move: Move, before: Position): boolean {
  if (typeof san !== 'string') return false;
  const parsed = /^([KQRBN])?([a-h])?([1-8])?x([a-h][1-8])(?:=([QRBN]))?[+#]?[!?]*$/.exec(san);
  if (parsed === null) return false;
  const [, piece, file, rank, target, promotion] = parsed;
  const uci = before.toUci(move);
  const type = move.piece.toLowerCase();
  if (type === 'p' ? piece !== undefined || file !== uci[0] || rank !== undefined : piece !== type.toUpperCase()) return false;
  if (file !== undefined && file !== uci[0]) return false;
  if (rank !== undefined && rank !== uci[1]) return false;
  return target === uci.slice(2, 4) && (promotion?.toLowerCase() ?? undefined) === move.promotion;
}
