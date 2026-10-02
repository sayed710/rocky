import type { PgnGame, PgnMoveNode } from './pgn-model';

/**
 * Escapes the two characters PGN reserves inside a tag value, and writes each non-printing
 * character as a space.
 *
 * PGN strings may not contain non-printing characters, and the parser ends a string at a newline.
 * Writing a newline verbatim splits the tag across lines, and the rest of it is read as movetext.
 * A space keeps the value on its own line; dropping the character instead would join the words on
 * either side of it.
 */
function escapeTagValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/**
 * Makes a comment safe to write between braces.
 *
 * PGN gives `{...}` **no escape mechanism** — a comment ends at the first `}`, full stop. So a
 * comment containing a brace cannot be represented, and writing it verbatim does not produce a
 * lossy file, it produces a broken one: everything after the brace is re-read as movetext, which
 * either fails to parse or silently becomes moves nobody wrote.
 *
 * Substituting the parentheses is lossy and says so. The alternative is refusing to export a study
 * because someone typed a brace in a note, which is worse.
 */
function sanitizeComment(comment: string): string {
  return comment.replace(/\{/g, '(').replace(/\}/g, ')');
}

/**
 * Writes one game back to PGN text.
 *
 * The contract that matters is `parse(serialize(parse(x)))` equalling `parse(x)` — byte-identical
 * output is *not* promised, because PGN permits formatting the same game many ways and reproducing
 * an input's whitespace would mean carrying whitespace through the tree. What must survive is the
 * game: tags, moves, comments, NAGs, variation structure, result.
 */
export function serializePgn(game: PgnGame): string {
  const lines: string[] = [];

  for (const tag of game.tags) {
    lines.push(`[${tag.key} "${escapeTagValue(tag.value)}"]`);
  }
  if (game.tags.length > 0) {
    lines.push('');
  }

  const parts: string[] = [];
  for (const comment of game.preComments) {
    parts.push(`{${sanitizeComment(comment)}}`);
  }

  // Move numbering is regenerated rather than remembered. The tree is the source of truth for
  // order, so a number carried over from the input could only ever contradict it.
  writeMoves(parts, game.moves, game.startingMove?.number ?? 1, game.startingMove?.color ?? 'w');
  parts.push(game.result);

  lines.push(wrap(parts.join(' '), 80));
  return lines.join('\n') + '\n';
}

/** Writes several games separated by a blank line, the way a PGN file holds them. */
export function serializePgnGames(games: readonly PgnGame[]): string {
  return games.map(serializePgn).join('\n');
}

function writeMoves(
  out: string[],
  nodes: readonly PgnMoveNode[],
  startNumber: number,
  startColor: 'w' | 'b'
): void {
  let number = startNumber;
  let color: 'w' | 'b' = startColor;

  for (const node of nodes) {
    if (color === 'w') {
      out.push(`${number}.`);
    } else if (out.length === 0 || needsBlackEllipsis(out)) {
      // Black to move at the start of a line or straight after a variation needs `12...` — without
      // it, re-parsing attaches the move to the wrong side of the move number.
      out.push(`${number}...`);
    }

    out.push(node.san);

    for (const nag of node.nags) {
      out.push(`$${nag}`);
    }
    for (const comment of node.comments) {
      out.push(`{${sanitizeComment(comment)}}`);
    }

    for (const variation of node.variations) {
      const inner: string[] = [];
      writeMoves(inner, variation, number, color);
      out.push(`(${inner.join(' ')})`);
    }

    if (color === 'b') {
      number++;
    }
    color = color === 'w' ? 'b' : 'w';
  }
}

/**
 * True when the previous token was a comment, NAG or closed variation — anything that separates a
 * black move from its move number and so requires the number be repeated with an ellipsis.
 */
function needsBlackEllipsis(out: string[]): boolean {
  const prev = out[out.length - 1];
  if (prev === undefined) {
    return true;
  }
  return prev.endsWith('}') || prev.endsWith(')') || prev.startsWith('$');
}

/** Soft-wraps at a column boundary without splitting a token. */
function wrap(text: string, width: number): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines.join('\n');
}
