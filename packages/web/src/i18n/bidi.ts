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
const CLOCK_REGEX = /^\d+:\d{2}$/;
const FEN_PARTS = /^([rnbqkpRNBQKP1-8]+\/){7}[rnbqkpRNBQKP1-8]+ [wb] (-|[KQkq]+|[A-Ha-h]+) (-|[a-h][36]) \d+ \d+$/;
const EVAL_REGEX = /^[+-]?(\d+(\.\d+)?|#[+-]?\d+)$/;
const RATING_REGEX = /^\d+(\s*\(±\d+\))?$/;
const TIME_CONTROL_REGEX = /^\d+(\.\d+)?\+\d+$/;

/**
 * Checks if a string represents an intrinsically LTR chess notation token
 * (SAN, UCI, FEN, clock, evaluation, rating, or time control).
 */
export function isChessNotation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return (
    UCI_REGEX.test(trimmed) ||
    SAN_REGEX.test(trimmed) ||
    CLOCK_REGEX.test(trimmed) ||
    FEN_PARTS.test(trimmed) ||
    EVAL_REGEX.test(trimmed) ||
    RATING_REGEX.test(trimmed) ||
    TIME_CONTROL_REGEX.test(trimmed)
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
