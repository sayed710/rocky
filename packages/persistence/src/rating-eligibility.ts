/**
 * @packageDocumentation
 * Whether a finished game changes ratings, decided only from its committed event stream (ADR-0150).
 * No caller supplies any part of the decision: `rated`, the seats, the variant, the time control, the
 * result and the termination all come from `GameCreated` and `GameEnded` as the authority wrote them.
 * Account facts (a bot flag, a deleted account) are checked by the applier in the database.
 */

import { isEngineBotUserId, type ResultString, type Termination } from '@chess-platform/game';
import type { Variant } from '@chess-platform/core';
import { PersistenceError } from './errors';
import type { StoredEvent } from './event-store';
import { projectGameStream } from './games-projection';
import type { Speed } from './repositories';

/** A game that changes both players' ratings in its variant × speed pool. */
export interface RateableGame {
  readonly gameId: string;
  readonly variant: Variant;
  readonly speed: Speed;
  readonly white: string;
  readonly black: string;
  readonly whiteScore: 0 | 0.5 | 1;
}

/** Why an ending changes no rating. */
export type IneligibleReason =
  /** `GameCreated.rated` is false. */
  | 'casual'
  /** Aborted, or a pregame no-show of any source (a seek abort, a forfeit or a double forfeit). */
  | 'no_result'
  /** A first-party engine bot, or a seat that is not an account, took part. */
  | 'not_human';

export type RatingDecision =
  | { readonly kind: 'rate'; readonly game: RateableGame }
  | { readonly kind: 'ineligible'; readonly reason: IneligibleReason };

const DECISIVE: readonly ResultString[] = ['1-0', '0-1'];
const DRAW: readonly ResultString[] = ['1/2-1/2'];
/**
 * Every termination with the results `Game` can record for it; any other pairing is corrupt. Endings of
 * real play are all rated alike (owner decision 6); `aborted` and `no_show` never are (decisions 4, 5, 7).
 */
const RESULTS_BY_TERMINATION: ReadonlyMap<Termination, readonly ResultString[]> = new Map<Termination, readonly ResultString[]>([
  ['checkmate', DECISIVE], ['resignation', DECISIVE], ['timeout', DECISIVE],
  ['stalemate', DRAW], ['agreement', DRAW], ['insufficient_material', DRAW], ['fifty_move', DRAW], ['threefold', DRAW],
  ['variant', [...DECISIVE, ...DRAW]],
  ['aborted', ['*']],
  ['no_show', ['*', ...DECISIVE]],
]);
const UNPLAYED_TERMINATIONS: ReadonlySet<Termination> = new Set<Termination>(['aborted', 'no_show']);
const WINNER_BY_RESULT: Readonly<Record<ResultString, 'w' | 'b' | null>> = { '1-0': 'w', '0-1': 'b', '1/2-1/2': null, '*': null };
const TIME_CONTROL_KINDS: ReadonlySet<unknown> = new Set(['increment', 'delay', 'sudden_death', 'unlimited']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decide from a game's complete committed stream. Throws {@link PersistenceError} for a stream no
 * authority could have written: one the games fold rejects, one that has not ended, a non-boolean
 * `rated`, an unknown time-control kind, a result that termination cannot have, a winner that
 * contradicts the result, or a player facing themself. Such a game is blocked, never rated and never
 * silently skipped.
 */
export function decideRating(gameId: string, stream: readonly StoredEvent[]): RatingDecision {
  const game = projectGameStream(gameId, stream);
  const created = stream[0]!.event as { rated?: unknown; timeControl: { kind?: unknown } };
  const ended = stream.at(-1)!.event;
  if (ended.type !== 'GameEnded' || game.result === null || game.termination === null) {
    throw corrupt(gameId, 'the stream has not ended');
  }
  if (typeof created.rated !== 'boolean') throw corrupt(gameId, 'GameCreated has no boolean rated flag');
  if (!TIME_CONTROL_KINDS.has(created.timeControl.kind)) {
    throw corrupt(gameId, `unknown time control kind ${JSON.stringify(created.timeControl.kind)}`);
  }
  const allowed = RESULTS_BY_TERMINATION.get(game.termination);
  if (!allowed) throw corrupt(gameId, `unknown termination ${JSON.stringify(game.termination)}`);
  if (!allowed.includes(game.result)) {
    throw corrupt(gameId, `result ${JSON.stringify(game.result)} cannot end by ${game.termination}`);
  }
  if (ended.winner !== WINNER_BY_RESULT[game.result]) {
    throw corrupt(gameId, `winner ${JSON.stringify(ended.winner)} contradicts result ${game.result}`);
  }
  if (game.white === game.black) throw corrupt(gameId, 'both seats are the same player');

  if (!game.rated) return ineligible('casual');
  if (UNPLAYED_TERMINATIONS.has(game.termination)) return ineligible('no_result');
  if (!isAccountSeat(game.white) || !isAccountSeat(game.black)) return ineligible('not_human');

  const whiteScore = game.result === '1-0' ? 1 : game.result === '0-1' ? 0 : 0.5;
  return {
    kind: 'rate',
    game: { gameId, variant: game.variant, speed: game.speed, white: game.white, black: game.black, whiteScore },
  };
}

/** A registered-account-shaped seat that is not a reserved engine bot. */
function isAccountSeat(seat: string): boolean {
  return UUID.test(seat) && !isEngineBotUserId(seat);
}

function ineligible(reason: IneligibleReason): RatingDecision {
  return { kind: 'ineligible', reason };
}

function corrupt(gameId: string, reason: string): PersistenceError {
  return new PersistenceError(`game ${gameId}: ${reason}`);
}
