/**
 * @packageDocumentation
 * Glicko-2 rating system (Glickman, 2013). Pure functions — no state, no I/O —
 * so ratings are deterministic and unit-testable against the reference worked
 * example. Ratings are stored per (user, variant, speed) pool, and every rated game is
 * its own rating period ({@link rateGame}); no inactivity RD growth is applied (ADR-0150).
 */

/** A player's Glicko-2 rating triple on the original (1500-centered) scale. */
export interface Glicko2Rating {
  readonly rating: number;
  readonly rd: number;
  readonly vol: number;
}

/** One opponent result: their rating/RD and the score against them (1/0.5/0). */
export interface Glicko2Result {
  readonly rating: number;
  readonly rd: number;
  readonly score: number;
}

export const DEFAULT_RATING = 1500;
export const DEFAULT_RD = 350;
export const DEFAULT_VOL = 0.06;
/** System constant constraining volatility change; smaller = more conservative. */
export const GLICKO2_TAU = 0.5;

const SCALE = 173.7178;
const CONVERGENCE = 1e-6;

/** A fresh, unrated player. */
export function initialRating(): Glicko2Rating {
  return { rating: DEFAULT_RATING, rd: DEFAULT_RD, vol: DEFAULT_VOL };
}

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expectedScore(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/** Solve for the new volatility via the Illinois algorithm (Glickman step 5). */
function newVolatility(vol: number, delta: number, phi: number, v: number, tau: number): number {
  const a = Math.log(vol * vol);
  const d2 = delta * delta;
  const pv = phi * phi + v;

  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (d2 - pv - ex);
    const den = 2 * (pv + ex) * (pv + ex);
    return num / den - (x - a) / (tau * tau);
  };

  let A = a;
  let B: number;
  if (d2 > pv) {
    B = Math.log(d2 - pv);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k += 1;
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > CONVERGENCE) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  return Math.exp(A / 2);
}

/**
 * Compute a player's new rating after a batch of results. With an empty batch,
 * only the rating deviation inflates (idle-period rule).
 */
export function updateRating(
  player: Glicko2Rating,
  results: readonly Glicko2Result[],
  tau: number = GLICKO2_TAU,
): Glicko2Rating {
  const mu = (player.rating - DEFAULT_RATING) / SCALE;
  const phi = player.rd / SCALE;

  if (results.length === 0) {
    const phiStar = Math.sqrt(phi * phi + player.vol * player.vol);
    return { rating: player.rating, rd: phiStar * SCALE, vol: player.vol };
  }

  let vInv = 0;
  let dSum = 0;
  for (const r of results) {
    const muJ = (r.rating - DEFAULT_RATING) / SCALE;
    const phiJ = r.rd / SCALE;
    const e = expectedScore(mu, muJ, phiJ);
    const gj = g(phiJ);
    vInv += gj * gj * e * (1 - e);
    dSum += gj * (r.score - e);
  }
  const v = 1 / vInv;
  const delta = v * dSum;

  const vol = newVolatility(player.vol, delta, phi, v, tau);
  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * dSum;

  return { rating: newMu * SCALE + DEFAULT_RATING, rd: newPhi * SCALE, vol };
}

/** Both players' ratings after one game, the game being its own rating period. */
export interface RatedGame {
  readonly white: Glicko2Rating;
  readonly black: Glicko2Rating;
}

/**
 * Rate one game from both players' pre-game states. Each side is updated against the other's
 * rating from before the game, never against an already-updated opponent.
 */
export function rateGame(white: Glicko2Rating, black: Glicko2Rating, whiteScore: 0 | 0.5 | 1): RatedGame {
  return {
    white: updateRating(white, [{ rating: black.rating, rd: black.rd, score: whiteScore }]),
    black: updateRating(black, [{ rating: white.rating, rd: white.rd, score: 1 - whiteScore }]),
  };
}
