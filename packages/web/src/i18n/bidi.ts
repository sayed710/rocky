/**
 * Bidirectional text and chess notation isolation utilities.
 *
 * Chess content (SAN, UCI, FEN, PGN, clocks, coordinates, ratings) is intrinsically LTR.
 * In a mixed-direction or future RTL environment, displaying this content requires isolation
 * to prevent directional bleed or corrupted rendering, while ensuring that copying text
 * does NOT insert invisible control characters that break chess engines or notation parsers.
 */

const UCI_REGEX = /^[a-h][1-8][a-h][1-8][qrbn]?$/i;
const SAN_REGEX = /^([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](=[NBRQK])?|O-O(-O)?)[+#]?$/;
const SAN_WITH_UCI_REGEX = /^([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](=[NBRQK])?|O-O(-O)?)[+#]?\s*\([a-h][1-8][a-h][1-8][qrbn]?\)$/i;
const CLOCK_REGEX = /^\d+:\d{2}(\s*[–-]\s*\d+:\d{2})?$/;
const FEN_PARTS = /^([rnbqkpRNBQKP1-8]+\/){7}[rnbqkpRNBQKP1-8]+ [wb] (-|[KQkq]+|[A-Ha-h]+) (-|[a-h][36]) \d+ \d+$/;
const EVAL_REGEX = /^[+-]?(\d+(\.\d+)?|#[+-]?\d+)$/;
const RATING_REGEX = /^\d+(\s*\((?:±|RD\s*)\d+\))?$/;
const TIME_CONTROL_REGEX = /^\d+(\.\d+)?\+\d+$/;

const PGN_TERMINATION_REGEX = /^(1-0|0-1|1\/2-1\/2|\*)$/;
const PGN_MOVE_NUMBER_REGEX = /^\d+\.{1,3}$/;
const PGN_COMBINED_MOVE_REGEX = /^\d+\.{1,3}([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](=[NBRQK])?|O-O(-O)?)[+#]?$/;
const PGN_NAG_REGEX = /^(\$\d+|[?!]{1,2})$/;

/**
 * Checks if a string represents a bounded PGN movetext sequence (e.g. `1. e4 e5 2. Nf3 Nc6`).
 *
 * Guarantees:
 * - Deterministic linear O(N) token scan, avoiding catastrophic backtracking regexes.
 * - Rejects non-chess English prose even if it contains numbered items (e.g. "1. First step").
 * - Bounded length check (rejects inputs > 50,000 chars immediately).
 */
export function isPgnMovetext(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 50000) {
    return false;
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) {
    // Single move like "1.e4"
    return PGN_COMBINED_MOVE_REGEX.test(trimmed);
  }

  let hasMoveNumber = false;
  let hasSanMove = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (PGN_MOVE_NUMBER_REGEX.test(token)) {
      hasMoveNumber = true;
      continue;
    }

    if (PGN_COMBINED_MOVE_REGEX.test(token)) {
      hasMoveNumber = true;
      hasSanMove = true;
      continue;
    }

    if (SAN_REGEX.test(token)) {
      hasSanMove = true;
      continue;
    }

    if (PGN_NAG_REGEX.test(token)) {
      continue;
    }

    if (i === tokens.length - 1 && PGN_TERMINATION_REGEX.test(token)) {
      continue;
    }

    // Any invalid token fails the PGN classification
    return false;
  }

  return hasMoveNumber && hasSanMove;
}

/**
 * Checks if a string represents an intrinsically LTR chess notation token
 * (SAN, UCI, FEN, clock, evaluation, rating, time control, or PGN movetext).
 */
export function isChessNotation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return (
    UCI_REGEX.test(trimmed) ||
    SAN_REGEX.test(trimmed) ||
    SAN_WITH_UCI_REGEX.test(trimmed) ||
    CLOCK_REGEX.test(trimmed) ||
    FEN_PARTS.test(trimmed) ||
    EVAL_REGEX.test(trimmed) ||
    RATING_REGEX.test(trimmed) ||
    TIME_CONTROL_REGEX.test(trimmed) ||
    isPgnMovetext(trimmed)
  );
}

/**
 * Creates a DOM element configured with `dir="ltr"` and CSS isolation class `bidi-ltr`.
 */
export function createLtrElement(
  doc: Document,
  tagName: string,
  text: string,
  className?: string,
): HTMLElement {
  const el = doc.createElement(tagName);
  el.setAttribute('dir', 'ltr');
  const classes = ['bidi-ltr'];
  if (className) {
    classes.push(className);
  }
  el.className = classes.join(' ');
  el.textContent = text;
  return el;
}

/**
 * Applies LTR isolation attributes and classes to an existing DOM element.
 */
export function applyLtrIsolation(element: HTMLElement): void {
  element.setAttribute('dir', 'ltr');
  const current = element.className ? element.className.split(/\s+/).filter(Boolean) : [];
  if (!current.includes('bidi-ltr')) {
    current.push('bidi-ltr');
    element.className = current.join(' ');
  }
}

/**
 * Applies auto-direction attributes (`dir="auto"`) to an element containing user text.
 */
export function applyAutoDirection(element: HTMLElement): void {
  element.setAttribute('dir', 'auto');
}

/**
 * Creates an element with `dir="auto"` for user-generated text content.
 */
export function createUserTextElement(
  doc: Document,
  tagName: string,
  text: string,
  className?: string,
): HTMLElement {
  const el = doc.createElement(tagName);
  el.setAttribute('dir', 'auto');
  if (className) {
    el.className = className;
  }
  el.textContent = text;
  return el;
}

/** Escapes special HTML characters to prevent XSS. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wraps content in an HTML element with `dir="ltr"` and `class="bidi-ltr"`,
 * safely escaping text to prevent markup injection.
 */
export function wrapLtrHtml(text: string, tagName: 'bdi' | 'span' = 'bdi'): string {
  return `<${tagName} dir="ltr" class="bidi-ltr">${escapeHtml(text)}</${tagName}>`;
}

/**
 * Wraps user-generated text in an HTML element with `dir="auto"`,
 * safely escaping text to prevent markup injection.
 */
export function wrapUserTextHtml(
  text: string,
  tagName: 'bdi' | 'span' = 'bdi',
  className?: string,
): string {
  const classAttr = className ? ` class="${escapeHtml(className)}"` : '';
  return `<${tagName} dir="auto"${classAttr}>${escapeHtml(text)}</${tagName}>`;
}
