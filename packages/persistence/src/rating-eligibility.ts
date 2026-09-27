/**
 * @packageDocumentation
 * Whether a finished game changes ratings, decided only from its committed event stream (ADR-0150).
 * No caller supplies any part of the decision: `rated`, the seats, the variant, the time control, the
 * result and the termination all come from `GameCreated` and `GameEnded` as the authority wrote them.
 * Account facts (a bot flag, a deleted account) are checked by the applier in the database.
 */

import { isEngineBotUserId, type Termination } from '@chess-platform/game';
import type { Variant } from '@chess-platform/core';
import { PersistenceError } from './errors';
import type { GameProjection } from './games-projection';
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
  /** Aborted, a pregame no-show of any source, or any other ending with no score. */
  | 'no_result'
  /** A first-party engine bot, or a seat that is not an account, took part. */
  | 'not_human';

export type RatingDecision =
  | { readonly kind: 'rate'; readonly game: RateableGame }
  | { readonly kind: 'ineligible'; readonly reason: IneligibleReason };

/** Endings of real play. Every one is rated alike (owner decision 6); nothing else is. */
const PLAYED_TERMINATIONS: ReadonlySet<Termination> = new Set<Termination>([
  'checkmate', 'resignation', 'timeout', 'stalemate', 'agreement',
  'insufficient_material', 'fifty_move', 'threefold', 'variant',
]);
/** No chess was played to a result: never rated, whatever the stored result says (owner decisions 4, 5, 7). */
const UNPLAYED_TERMINATIONS: ReadonlySet<Termination> = new Set<Termination>(['aborted', 'no_show']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decide from a folded, finished stream. Throws {@link PersistenceError} for an ending no authority
 * could have written (an unknown termination or result, a player facing themself), so a stream whose
 * eligibility cannot be proven is blocked rather than rated or silently skipped.
 */
export function decideRating(game: GameProjection): RatingDecision {
  if (game.result === null || game.termination === null) {
    throw corrupt(game.id, 'the stream has not ended');
  }
  const termination = game.termination;
  if (!PLAYED_TERMINATIONS.has(termination) && !UNPLAYED_TERMINATIONS.has(termination)) {
    throw corrupt(game.id, `unknown termination ${JSON.stringify(termination)}`);
  }
  const whiteScore = scoreOf(game.result);
  if (whiteScore === undefined) throw corrupt(game.id, `unknown result ${JSON.stringify(game.result)}`);
  if (game.white === game.black) throw corrupt(game.id, 'both seats are the same player');

  if (!game.rated) return ineligible('casual');
  if (UNPLAYED_TERMINATIONS.has(termination) || whiteScore === null) return ineligible('no_result');
  if (!isAccountSeat(game.white) || !isAccountSeat(game.black)) return ineligible('not_human');

  return {
    kind: 'rate',
    game: { gameId: game.id, variant: game.variant, speed: game.speed, white: game.white, black: game.black, whiteScore },
  };
}

/** A registered-account-shaped seat that is not a reserved engine bot. */
function isAccountSeat(seat: string): boolean {
  return UUID.test(seat) && !isEngineBotUserId(seat);
}

function scoreOf(result: string): 0 | 0.5 | 1 | null | undefined {
  switch (result) {
    case '1-0': return 1;
    case '0-1': return 0;
    case '1/2-1/2': return 0.5;
    case '*': return null;
    default: return undefined;
  }
}

function ineligible(reason: IneligibleReason): RatingDecision {
  return { kind: 'ineligible', reason };
}

function corrupt(gameId: string, reason: string): PersistenceError {
  return new PersistenceError(`game ${gameId}: ${reason}`);
}
