/**
 * @packageDocumentation
 * The shape a parsed PGN takes. Movetext is a tree, not a list, because PGN's `(...)` variations
 * are alternatives to a move rather than continuations of it — flattening them loses the only
 * thing an annotated game has that a move list does not.
 */

/** Upper bound on a single import, in bytes. */
export const MAX_PGN_BYTES = 5 * 1024 * 1024;

/** Upper bound on games accepted from one import. */
export const MAX_GAMES_PER_IMPORT = 64;

/**
 * Upper bound on nesting depth of `(...)` variations.
 *
 * Recursive descent over untrusted input needs a depth limit or a crafted file of nothing but open
 * parens exhausts the call stack — a `RangeError` from inside the parser, which is a crash rather
 * than a rejection. This is the parser's own limit, separate from the byte cap, because a small
 * file can still be deeply nested.
 */
export const MAX_VARIATION_DEPTH = 128;

/** One `[Key "Value"]` tag pair. */
export interface PgnTag {
  readonly key: string;
  readonly value: string;
}

/**
 * A move in the movetext, plus everything PGN allows to hang off it.
 *
 * `variations` are alternatives to THIS move — each is a line that could have been played instead,
 * starting from the position before it.
 */
export interface PgnMoveNode {
  /** The move in Standard Algebraic Notation, exactly as written. */
  readonly san: string;
  /** Numeric Annotation Glyphs attached to the move, e.g. `[1]` for `!`. */
  readonly nags: readonly number[];
  /** Comments following the move, in order. */
  readonly comments: readonly string[];
  /** Alternatives to this move. */
  readonly variations: readonly (readonly PgnMoveNode[])[];
}

/** The move number and side of a game's first move. */
export interface PgnStartingMove {
  /** The FEN fullmove number of the starting position, at least 1. */
  readonly number: number;
  readonly color: 'w' | 'b';
}

/** One game: its tags, its movetext, and its result token. */
export interface PgnGame {
  readonly tags: readonly PgnTag[];
  /** Comments appearing before the first move. */
  readonly preComments: readonly string[];
  /**
   * Where move numbering starts. Absent means `1.` with White, which is what the parser and the
   * study export assume. A game exported from a position with Black to move needs it, or its first
   * move is numbered as White's.
   */
  readonly startingMove?: PgnStartingMove;
  readonly moves: readonly PgnMoveNode[];
  /** The result token as written: `1-0`, `0-1`, `1/2-1/2`, or `*`. */
  readonly result: string;
}

/** The four result tokens PGN permits. Anything else is a parse error. */
export const PGN_RESULTS = ['1-0', '0-1', '1/2-1/2', '*'] as const;
export type PgnResult = (typeof PGN_RESULTS)[number];

export function isPgnResult(token: string): token is PgnResult {
  return (PGN_RESULTS as readonly string[]).includes(token);
}

/** Looks up a tag value by key, case-insensitively as the PGN spec requires. */
export function tagValue(game: PgnGame, key: string): string | undefined {
  const lower = key.toLowerCase();
  return game.tags.find((t) => t.key.toLowerCase() === lower)?.value;
}
