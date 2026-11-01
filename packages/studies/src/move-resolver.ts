import { StudyRuleError } from './errors';
import { DEFAULT_STUDY_VARIANT, type StudyVariant } from './model';

/**
 * The single thing this package needs from a chess engine: given a position, which moves are legal
 * and what is each one called.
 *
 * It is a port rather than an import so the domain stays free of an engine dependency, and because
 * the shape it needs is genuinely small — `@chess-platform/core` can write SAN (`Position.toSan`)
 * but cannot read it, so no existing function answers "which move is `Nbd7` here?".
 */
export interface PositionReader {
  /** SAN for every legal move from this position, in any order. */
  legalSans(fen: string, variant?: StudyVariant): readonly string[];
  /** The position after playing a SAN move. Throws if the move is not legal. */
  play(fen: string, san: string, variant?: StudyVariant): string;
  /** The canonical starting position for a variant. */
  initialFen(variant?: StudyVariant): string;
}

/**
 * Strips the decorations SAN allows but that do not identify the move.
 *
 * One character class, not two passes. Stripping `[+#]` and then `[!?]` looks equivalent and is
 * not: on `Qh5+!` the first pass finds no match, because the string ends in `!`, and the second
 * leaves `Qh5+`. The engine writes `Qh5+`, which bares to `Qh5`, so the two never meet and a
 * perfectly ordinary annotated move fails to resolve. `isSanShaped` in `pgn-parse.ts` already used
 * the single class — two functions in one package disagreeing about the same trailing characters.
 */
function bare(san: string): string {
  return san
    .replace(/[+#!?]+$/, '')
    .replace(/^0-0-0$/, 'O-O-O')
    .replace(/^0-0$/, 'O-O');
}

/**
 * Resolves a SAN token against a position by asking the engine what it *calls* each legal move and
 * matching, rather than by re-deriving SAN's disambiguation rules.
 *
 * Those rules are the fiddly part of SAN — when a file letter suffices, when a rank is needed, when
 * both are — and a second implementation of them is a second opportunity to disagree with the
 * first. Matching against the engine's own output cannot disagree with it by construction.
 *
 * Check and mate suffixes are ignored on both sides: a file that says `Qh5` where the engine says
 * `Qh5+` is describing the same move, and rejecting it would fail on a large fraction of real
 * exports for no gain.
 */
export function resolveSan(
  reader: PositionReader,
  fen: string,
  san: string,
  variant: StudyVariant = DEFAULT_STUDY_VARIANT,
): string {
  const wanted = bare(san);
  const legal = reader.legalSans(fen, variant);

  for (const candidate of legal) {
    if (bare(candidate) === wanted) {
      return candidate;
    }
  }

  throw new StudyRuleError(
    'invalid_move',
    `'${san}' is not a legal move in this position`
  );
}
