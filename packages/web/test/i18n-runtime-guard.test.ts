/**
 * Deterministic AST/Syntax Runtime Localization Coverage Guard.
 *
 * Verifies that runtime view renderers, mounts, dialogs, and helpers in `packages/web/src/app/`
 * do not render raw English string literals to DOM nodes or define unlocalized label tables.
 *
 * Covers:
 * - textContent, innerHTML, innerText assignments (direct literals, interpolated templates, ternaries)
 * - setAttribute('aria-label' | 'title' | 'placeholder', ...)
 * - el(doc, tag, attrs, ...children) helper calls (text children & attribute copy)
 * - renderEmpty(container, { title, body, cta: { label } }) real options call shape
 * - Option and UI label tables / constants flowing to DOM
 * - Ternary fallback branches (e.g. i18n ? i18n.t(...) : 'English fallback')
 *
 * All user-facing copy must be routed through `i18n.t(key)`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = resolve(PACKAGE_ROOT, 'src', 'app');

export interface AstViolation {
  readonly file: string;
  readonly type: string;
  readonly text: string;
  readonly line: number;
}

/**
 * All client-owned runtime view renderers, mounts, dialogs, and UI helpers
 * migrated in PR #81.
 */
export const MIGRATED_VIEW_FILES: readonly string[] = [
  'achievements-helpers.ts',
  'achievements-view.ts',
  'analysis-view.ts',
  'competition-mounts.ts',
  'create-game-panel.ts',
  'email-verification-mount.ts',
  'endgame-mount.ts',
  'endgame-view.ts',
  'forum-helpers.ts',
  'forum-mounts.ts',
  'forum-view.ts',
  'game-controller.ts',
  'game-mount.ts',
  'leaderboard-view.ts',
  'learning-helpers.ts',
  'learning-mounts.ts',
  'learning-view.ts',
  'lobby-mount.ts',
  'messages-helpers.ts',
  'messages-view.ts',
  'messaging-mounts.ts',
  'passkeys-view.ts',
  'password-recovery-mount.ts',
  'play-bot-dialog.ts',
  'profile-mount.ts',
  'render-helpers.ts',
  'search-mount.ts',
  'search-view.ts',
  'sessions-view.ts',
  'studies-helpers.ts',
  'studies-mounts.ts',
  'studies-view.ts',
  'team-mounts.ts',
  'teams-helpers.ts',
  'teams-view.ts',
  'tournament-commentary-view.ts',
  'tournament-view.ts',
  'variant-labels.ts',
];

/**
 * Narrowly documented allowlist for non-copy tokens:
 * - HTML element tags
 * - DOM attribute names and input types
 * - DOM event names
 * - Directionality and live region state tokens
 * - Protocol identifiers (variants, speeds, seek modes, player roles)
 */
const TECHNICAL_TOKENS = new Set([
  // DOM element tags
  'button', 'div', 'span', 'p', 'a', 'input', 'form', 'fieldset', 'legend', 'table',
  'thead', 'tbody', 'tr', 'td', 'th', 'ul', 'li', 'ol', 'select', 'option', 'label',
  'dialog', 'section', 'nav', 'header', 'footer', 'main', 'article', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'bdi', 'bdo', 'time', 'svg', 'path', 'strong',
  'em', 'small', 'img',
  // Attributes & input types
  'class', 'id', 'name', 'value', 'type', 'href', 'src', 'rel', 'role', 'target',
  'tabindex', 'disabled', 'readonly', 'hidden', 'checked', 'selected', 'autocomplete',
  'autofocus', 'inputmode', 'min', 'max', 'step', 'dir', 'aria-label', 'aria-hidden',
  'aria-expanded', 'aria-live', 'aria-describedby', 'aria-invalid', 'aria-busy',
  'aria-controls', 'text', 'checkbox', 'radio', 'submit', 'reset', 'number',
  'decimal', 'password', 'email',
  // DOM events
  'click', 'change', 'submit', 'input', 'keydown', 'keyup', 'focus', 'blur',
  'resize', 'scroll', 'load', 'unload',
  // Direction & state tokens
  'ltr', 'rtl', 'auto', 'off', 'on', 'none', 'polite', 'assertive', 'true', 'false',
  'open', 'close',
  // Protocol & domain identifiers
  'standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck',
  'horde', 'racingkings', 'ultrabullet', 'bullet', 'blitz', 'rapid', 'classical',
  'correspondence', 'casual', 'rated', 'keyword', 'semantic', 'hybrid',
  'white', 'black', 'random', 'player', 'spectator', 'idle', 'connecting',
  'ready', 'playing', 'finished', 'aborted', 'unlimited', 'sudden_death',
  'increment', 'delay',
]);

/**
 * Distinguishes user-visible English copy strings from technical identifiers,
 * CSS class lists, numbers, chess notation, or punctuation.
 */
export function isCopyString(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Pure symbols, punctuation, chess marks, or numbers
  if (/^[\s\d\.\:\-\+\#\·\—\–\(\)\/\_\[\]\<\>\,\;\=\*\'\"\`\|\@\&\?\!\^\%\~]+$/.test(trimmed)) return false;

  // Exact allowlisted technical tokens
  if (TECHNICAL_TOKENS.has(trimmed.toLowerCase())) return false;

  // Kebab-case CSS class names or element IDs (e.g. 'panel-row', 'cg-form', 'button-primary')
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(trimmed)) return false;

  // Space-separated CSS class list (e.g. 'button primary', 'panel-row is-active')
  if (/^[a-z0-9\-]+(\s+[a-z0-9\-]+)+$/.test(trimmed) && !/[A-Z]/.test(trimmed)) return false;

  // URLs, route paths, data URIs, anchor IDs
  if (trimmed.startsWith('/') || trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('#')) return false;

  // Chess coordinates (e.g. 'e4', 'Nf3', 'a1', 'h8') or game score ('1-0', '0-1')
  if (/^[a-h][1-8]$/.test(trimmed) || /^[01]\-[01]$/.test(trimmed) || trimmed === '1/2-1/2') return false;

  // English copy patterns:
  // 1. Multi-word phrases with English words
  if (/\b[a-zA-Z]{2,}\s+[a-zA-Z]{2,}\b/.test(trimmed)) return true;
  // 2. Sentences ending with period, exclamation, question mark, or ellipsis
  if (/[.!?…]$/.test(trimmed) && /[a-zA-Z]{3,}/.test(trimmed)) return true;
  // 3. Capitalized English word of length >= 3 that is not an allowlisted technical token
  if (/^[A-Z][a-z]{2,}$/.test(trimmed)) return true;

  return false;
}

/**
 * Deterministically scans a TypeScript AST for raw string literal DOM assignments,
 * template interpolations, el() children, renderEmpty calls, option tables, and ternary fallbacks.
 */
export function scanSourceForViolations(fileName: string, sourceCode: string): AstViolation[] {
  const sf = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true);
  const violations: AstViolation[] = [];

  function record(type: string, text: string, node: ts.Node): void {
    violations.push({
      file: fileName,
      type,
      text,
      line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    });
  }

  function checkExpressionForCopy(expr: ts.Expression | undefined, typePrefix: string): void {
    if (!expr) return;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      if (isCopyString(expr.text)) {
        record(typePrefix, expr.text, expr);
      }
    } else if (ts.isTemplateExpression(expr)) {
      if (isCopyString(expr.head.text)) {
        record(`${typePrefix}-template`, expr.head.text, expr);
      }
      for (const span of expr.templateSpans) {
        if (isCopyString(span.literal.text)) {
          record(`${typePrefix}-template`, span.literal.text, span.literal);
        }
      }
    } else if (ts.isConditionalExpression(expr)) {
      checkExpressionForCopy(expr.whenTrue, `${typePrefix}-ternary-true`);
      checkExpressionForCopy(expr.whenFalse, `${typePrefix}-ternary-false`);
    }
  }

  function walk(node: ts.Node): void {
    // 1. Property assignments: textContent, innerHTML, innerText
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isPropertyAccessExpression(node.left)) {
        const prop = node.left.name.text;
        if (['textContent', 'innerHTML', 'innerText'].includes(prop)) {
          checkExpressionForCopy(node.right, prop);
        }
      }
    }

    // 2. setAttribute calls for user-visible copy: aria-label, title, placeholder
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setAttribute') {
      const [arg0, arg1] = node.arguments;
      if (arg0 && (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0))) {
        if (['aria-label', 'title', 'placeholder'].includes(arg0.text)) {
          checkExpressionForCopy(arg1, `setAttribute(${arg0.text})`);
        }
      }
    }

    // 3. el(doc, tag, attrs, ...children) helper calls
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'el') {
      const attrs = node.arguments[2];
      if (attrs && ts.isObjectLiteralExpression(attrs)) {
        for (const prop of attrs.properties) {
          if (ts.isPropertyAssignment(prop)) {
            const attrName = prop.name.getText(sf).replace(/['"]/g, '');
            if (['aria-label', 'title', 'placeholder'].includes(attrName)) {
              checkExpressionForCopy(prop.initializer, `el(attrs.${attrName})`);
            }
          }
        }
      }
      const children = node.arguments.slice(3);
      for (const child of children) {
        checkExpressionForCopy(child, 'el(child)');
      }
    }

    // 4. renderEmpty(container, { title, body, cta: { label } }) calls
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'renderEmpty') {
      const opts = node.arguments[1];
      if (opts && ts.isObjectLiteralExpression(opts)) {
        for (const prop of opts.properties) {
          if (ts.isPropertyAssignment(prop)) {
            const propName = prop.name.getText(sf).replace(/['"]/g, '');
            if (['title', 'body'].includes(propName)) {
              checkExpressionForCopy(prop.initializer, `renderEmpty.${propName}`);
            }
            if (propName === 'cta' && ts.isObjectLiteralExpression(prop.initializer)) {
              for (const ctaProp of prop.initializer.properties) {
                if (ts.isPropertyAssignment(ctaProp)) {
                  const ctaPropName = ctaProp.name.getText(sf).replace(/['"]/g, '');
                  if (ctaPropName === 'label') {
                    checkExpressionForCopy(ctaProp.initializer, 'renderEmpty.cta.label');
                  }
                }
              }
            }
          }
        }
      }
    }

    // 5. UI label constants / tables flowing to DOM: { label: '...' } in option arrays
    if (ts.isPropertyAssignment(node)) {
      const propName = node.name.getText(sf).replace(/['"]/g, '');
      if (propName === 'label') {
        checkExpressionForCopy(node.initializer, 'option.label');
      }
    }

    ts.forEachChild(node, walk);
  }

  walk(sf);
  return violations;
}

test('i18n AST guard: all 38 migrated runtime view renderers in packages/web/src/app have 0 raw copy literals', () => {
  assert.ok(MIGRATED_VIEW_FILES.length >= 38, 'expected at least 38 migrated view files');

  const allViolations: AstViolation[] = [];
  for (const file of MIGRATED_VIEW_FILES) {
    const filePath = resolve(APP_DIR, file);
    assert.ok(existsSync(filePath), `migrated view file must exist: ${file}`);
    const content = readFileSync(filePath, 'utf8');
    const violations = scanSourceForViolations(file, content);
    allViolations.push(...violations);
  }

  assert.deepEqual(
    allViolations,
    [],
    `Found ${allViolations.length} raw copy literal violation(s) in migrated view files. Use i18n.t() instead.`,
  );
});

test('i18n AST guard falsification: comprehensive check of real application call shapes', () => {
  const syntheticSnippet = [
    'const SEARCH_OPTIONS = [',
    '  { value: "keyword", label: "Keyword search" },',
    '];',
    'function render(doc: Document, container: HTMLElement, btn: HTMLElement, i18n?: I18n) {',
    '  container.textContent = `Welcome to ${siteName} chess`;',
    '  renderEmpty(container, {',
    '    title: "No active tournaments",',
    '    body: "Create a new tournament to get started",',
    '    cta: { label: "Create tournament", href: "/tournaments/new", route: "tournament-new" }',
    '  });',
    '  const action = el(doc, "button", { "aria-label": "Close dialog" }, "Cancel action");',
    '  btn.textContent = i18n ? i18n.t("action.save") : "Save changes";',
    '  btn.setAttribute("title", "Click to submit");',
    '}',
  ].join('\n');

  const violations = scanSourceForViolations('synthetic-test.ts', syntheticSnippet);
  assert.ok(violations.length >= 8, `expected at least 8 synthetic violations, got ${violations.length}`);

  const types = violations.map((v) => v.type);
  assert.ok(types.includes('option.label'), 'must catch option.label');
  assert.ok(types.includes('textContent-template'), 'must catch interpolated textContent template');
  assert.ok(types.includes('renderEmpty.title'), 'must catch renderEmpty.title');
  assert.ok(types.includes('renderEmpty.body'), 'must catch renderEmpty.body');
  assert.ok(types.includes('renderEmpty.cta.label'), 'must catch renderEmpty.cta.label');
  assert.ok(types.includes('el(attrs.aria-label)'), 'must catch el() aria-label attr');
  assert.ok(types.includes('el(child)'), 'must catch el() text child');
  assert.ok(types.includes('textContent-ternary-false'), 'must catch ternary false English fallback');
  assert.ok(types.includes('setAttribute(title)'), 'must catch setAttribute(title)');
});

test('i18n AST guard falsification: proves individual real mutations fail the guard', () => {
  // Mutation 1: Raw title in real renderEmpty call
  const m1 = `
    renderEmpty(container, {
      title: "No active games",
      body: i18n.t("empty.body"),
    });
  `;
  const v1 = scanSourceForViolations('mutation-1.ts', m1);
  assert.equal(v1.length, 1);
  assert.equal(v1[0]?.type, 'renderEmpty.title');
  assert.equal(v1[0]?.text, 'No active games');

  // Mutation 2: Raw visible label in real el() call
  const m2 = `
    const btn = el(doc, 'button', { type: 'button' }, 'Submit game');
  `;
  const v2 = scanSourceForViolations('mutation-2.ts', m2);
  assert.equal(v2.length, 1);
  assert.equal(v2[0]?.type, 'el(child)');
  assert.equal(v2[0]?.text, 'Submit game');

  // Mutation 3: Interpolated textContent template
  const m3 = `
    statusEl.textContent = \`Playing against \${opponentName}\`;
  `;
  const v3 = scanSourceForViolations('mutation-3.ts', m3);
  assert.equal(v3.length, 1);
  assert.equal(v3[0]?.type, 'textContent-template');
  assert.equal(v3[0]?.text, 'Playing against ');
});
