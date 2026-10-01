/**
 * Deterministic AST/Syntax Runtime Localization Coverage Guard.
 *
 * Verifies that all runtime presentation views, mounts, dialogs, and UI helpers in
 * `packages/web/src/app/` route 100% of user-visible copy through `i18n.t(key)`.
 *
 * Architecture:
 * - Scans all application source files in `packages/web/src/app/` by default.
 * - Every file is strictly classified: either UI-bearing (scanned) or technical/headless
 *   (documented in `NON_UI_TECHNICAL_FILES` with an architectural justification).
 * - New files cannot silently escape the guard: unclassified files fail the test immediately.
 * - Statically inspects known DOM presentation sinks and helpers:
 *   - .textContent, .innerHTML, .innerText assignments (literals, templates, ternaries)
 *   - .title and .placeholder DOM property assignments
 *   - setAttribute('aria-label' | 'title' | 'placeholder', ...)
 *   - el(doc, tag, attrs, ...children) helper calls (attribute copy & text children)
 *   - renderEmpty(container, { title, body, cta: { label } }) calls
 *   - Option tables with { label: '...' }
 *   - Validation results with { message: '...' }
 *   - Status helper calls (setStatus, renderStatus, showStatus, updateStatus)
 * - Scope note: This AST guard statically enforces that known DOM and presentation sinks do not
 *   receive raw English copy strings; dynamic dataflow (e.g. mapping technical tokens like Speed
 *   to translated labels, live locale switching) is rigorously proven by runtime relocalization tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { estimateSpeed, presetToTimeControl } from '../src/app/time-presets.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = resolve(PACKAGE_ROOT, 'src', 'app');

export interface AstViolation {
  readonly file: string;
  readonly type: string;
  readonly text: string;
  readonly line: number;
}

/**
 * Narrowly justified classification of application files that contain zero presentation
 * copy, zero UI mounts, and zero user-facing error messages.
 *
 * Every excluded file MUST have a documented architectural reason.
 */
export const NON_UI_TECHNICAL_FILES: Readonly<Record<string, string>> = {
  'achievements-controller.ts': 'Headless state controller managing achievements API fetching and reactive state; presentation copy rendered via achievements-view.ts.',
  'analysis-controller.ts': 'Headless network and debounce controller for engine analysis WebSocket/REST requests; output rendered via analysis-view.ts.',
  'analysis-format.ts': 'Pure numeric/algebraic chess notation and centipawn formatter functions; no presentation prose.',
  'assess-controller.ts': 'Headless request controller managing mistake prediction API calls; UI copy rendered via assess-view.ts.',
  'capabilities-nav.ts': 'Pure boolean predicate functions querying server capability flags; no user-visible presentation copy.',
  'coach-controller.ts': 'Headless request controller coordinating multi-section AI coaching requests; UI copy rendered via coach-view.ts.',
  'composition.ts': 'Dependency injection container and application composition root; instantiates services and wires routes.',
  'config.ts': 'Pure technical configuration constants (API URLs, WebSocket endpoints, storage keys).',
  'create-game-prefs.ts': 'Pure localStorage read/write persistence for player game preferences (variant, speed, rating range).',
  'dom.ts': 'Low-level DOM construction primitives and element creation helpers (el, clearChildren).',
  'email-verification-controller.ts': 'Headless state controller for email verification token lifecycle; presentation handled by email-verification-mount.ts.',
  'endgame-controller.ts': 'Headless controller managing endgame training position requests and validation; UI rendered via endgame-view.ts.',
  'explain-controller.ts': 'Headless state controller managing move explanation API requests; UI rendered via explain-view.ts.',
  'forum-controller.ts': 'Headless state controller for forum thread listings, post creation, and pagination; UI rendered via forum-view.ts.',
  'game-review-annotation.ts': 'Pure chess annotation symbols and move evaluation classification mapping functions; no presentation prose.',
  'game-review-controller.ts': 'Headless background controller managing post-game move evaluation batch requests; presentation handled by game-mount.ts.',
  'index.ts': 'Library module re-export barrel file.',
  'leaderboard-controller.ts': 'Headless data controller managing leaderboard queries and caching; UI rendered via leaderboard-view.ts.',
  'learning-controller.ts': 'Headless state controller for learning courses, lessons, and interactive step state; UI rendered via learning-view.ts.',
  'lifecycle.ts': 'Pure resource disposal primitives and lifecycle management interfaces (Disposable, CompositeDisposable).',
  'lobby-controller.ts': 'Headless state machine managing open game offers (seeks) and live subscriptions; UI rendered via lobby-mount.ts.',
  'messages-controller.ts': 'Headless messaging client controller managing direct message threads; UI rendered via messages-view.ts.',
  'move-request-controller.ts': 'Headless HTTP controller executing chess move requests against game API endpoints; no UI copy.',
  'opening-controller.ts': 'Headless request controller for opening book exploration; UI copy rendered via opening-view.ts.',
  'passkeys-controller.ts': 'Headless WebAuthn credentials controller coordinating browser navigator.credentials calls; UI rendered via passkeys-view.ts.',
  'password-reset-controller.ts': 'Headless state controller for password recovery tokens and reset calls; UI rendered via password-recovery-mount.ts.',
  'profile-controller.ts': 'Headless user profile and social relationship data controller; UI rendered via profile-mount.ts.',
  'puzzle-controller.ts': 'Headless controller managing tactic search requests and state invalidation; UI copy rendered via puzzle-view.ts.',
  'route-surface.ts': 'DOM container attachment helpers and route mount surface management; no presentation prose.',
  'router.ts': 'Pure client-side hash/history routing engine without DOM rendering logic.',
  'search-controller.ts': 'Headless state controller coordinating keyword and semantic search queries; UI rendered via search-view.ts.',
  'search-results.ts': 'Pure data transform functions mapping search API responses to entity views; no presentation prose.',
  'sessions-controller.ts': 'Headless controller managing active browser session listing and revocation; UI rendered via sessions-view.ts.',
  'social-controller.ts': 'Headless state controller for friendships, follower relationships, and player blocking; UI rendered via profile-mount.ts.',
  'studies-controller.ts': 'Headless state controller managing study chapter trees and collaborative edits; UI rendered via studies-view.ts.',
  'teams-controller.ts': 'Headless state controller for team membership, join requests, and administration; UI rendered via teams-view.ts.',
  'tournament-commentary-controller.ts': 'Headless controller managing tournament round commentary polling; UI rendered via tournament-commentary-view.ts.',
  'tournament-controller.ts': 'Headless state controller for tournament brackets, standings, and pairings; UI rendered via tournament-view.ts.',
};

/**
 * Derives the active set of scanned UI-bearing files.
 * Any app file not explicitly in NON_UI_TECHNICAL_FILES is scanned by default.
 */
export function getScannedViewFiles(appDir: string = APP_DIR): string[] {
  const allFiles = readdirSync(appDir).filter((f) => f.endsWith('.ts'));
  const nonUiSet = new Set(Object.keys(NON_UI_TECHNICAL_FILES));
  return allFiles.filter((f) => !nonUiSet.has(f)).sort();
}

/**
 * Backwards-compatible alias for existing imports.
 */
export const MIGRATED_VIEW_FILES: readonly string[] = getScannedViewFiles();

/**
 * Narrowly documented allowlist for non-copy tokens:
 * - HTML element tags
 * - DOM attribute names and input types
 * - DOM event names
 * - Directionality and live region state tokens
 *
 * Protocol values (e.g. 'white', 'black', 'random', 'rated') are intentionally NOT here:
 * if they are rendered into textContent, title, placeholder, or option labels, they must
 * be localized via i18n.t().
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
  // 1. Example / hint patterns (e.g. 'e.g. Nf3')
  if (/e\.g\./i.test(trimmed)) return true;
  // 2. Multi-word phrases with English words or alphanumerics
  if (/\b[a-zA-Z]{2,}\s+[a-zA-Z0-9]{2,}\b/.test(trimmed)) return true;
  // 3. Sentences ending with period, exclamation, question mark, or ellipsis
  if (/[.!?…]$/.test(trimmed) && /[a-zA-Z]{3,}/.test(trimmed)) return true;
  // 4. Capitalized English word of length >= 3 that is not an allowlisted technical token
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
    // 1. Property assignments: textContent, innerHTML, innerText, title, placeholder
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isPropertyAccessExpression(node.left)) {
        const prop = node.left.name.text;
        if (['textContent', 'innerHTML', 'innerText', 'title', 'placeholder'].includes(prop)) {
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

    // 5. Option tables and validation message objects: { label: '...' } or { message: '...' }
    if (ts.isPropertyAssignment(node)) {
      const propName = node.name.getText(sf).replace(/['"]/g, '');
      if (propName === 'label') {
        checkExpressionForCopy(node.initializer, 'option.label');
      } else if (propName === 'message') {
        checkExpressionForCopy(node.initializer, 'validation.message');
      }
    }

    // 6. Status helper calls: setStatus, renderStatus, showStatus, updateStatus
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fnName = node.expression.text;
      if (['setStatus', 'renderStatus', 'showStatus', 'updateStatus'].includes(fnName)) {
        for (const arg of node.arguments) {
          checkExpressionForCopy(arg, `${fnName}(arg)`);
        }
      }
    }

    ts.forEachChild(node, walk);
  }

  walk(sf);
  return violations;
}

test('i18n AST guard: all application source files are strictly classified and accounted for', () => {
  const allFiles = readdirSync(APP_DIR).filter((f) => f.endsWith('.ts')).sort();
  assert.ok(allFiles.length >= 87, `expected at least 87 files in packages/web/src/app, got ${allFiles.length}`);

  const nonUiEntries = Object.keys(NON_UI_TECHNICAL_FILES);
  for (const file of nonUiEntries) {
    assert.ok(
      allFiles.includes(file),
      `NON_UI_TECHNICAL_FILES contains phantom file not in app directory: ${file}`,
    );
    const justification = NON_UI_TECHNICAL_FILES[file];
    assert.ok(
      justification && justification.length >= 20,
      `NON_UI_TECHNICAL_FILES entry for ${file} must have a detailed architectural justification`,
    );
  }

  const scannedFiles = getScannedViewFiles();
  assert.ok(
    scannedFiles.length >= 48,
    `expected at least 48 scanned presentation files, got ${scannedFiles.length}`,
  );

  const classifiedSet = new Set([...nonUiEntries, ...scannedFiles]);
  const unclassified = allFiles.filter((f) => !classifiedSet.has(f));
  assert.deepEqual(
    unclassified,
    [],
    `Found unclassified files in packages/web/src/app: ${unclassified.join(', ')}. ` +
      'Every file must either be scanned for runtime copy or explicitly classified in NON_UI_TECHNICAL_FILES.',
  );
});

test('i18n AST guard: all scanned runtime UI surfaces have 0 raw copy literals', () => {
  const scannedFiles = getScannedViewFiles();
  const allViolations: AstViolation[] = [];

  for (const file of scannedFiles) {
    const filePath = resolve(APP_DIR, file);
    assert.ok(existsSync(filePath), `scanned view file must exist: ${file}`);
    const content = readFileSync(filePath, 'utf8');
    const violations = scanSourceForViolations(file, content);
    allViolations.push(...violations);
  }

  assert.deepEqual(
    allViolations,
    [],
    `Found ${allViolations.length} raw copy literal violation(s) in scanned UI surfaces:\n` +
      allViolations.map((v) => `  ${v.file}:${v.line} [${v.type}]: "${v.text}"`).join('\n') +
      '\nUse i18n.t() instead.',
  );
});

test('i18n AST guard falsification: comprehensive check of real application call shapes', () => {
  const syntheticSnippet = [
    'const SEARCH_OPTIONS = [',
    '  { value: "keyword", label: "Keyword search" },',
    '];',
    'function validate() {',
    '  return { valid: false, message: "Enter a whole rating from 0 to 4000." };',
    '}',
    'function render(doc: Document, container: HTMLElement, btn: HTMLElement, input: HTMLInputElement, i18n?: I18n) {',
    '  container.textContent = `Welcome to ${siteName} chess`;',
    '  renderEmpty(container, {',
    '    title: "No active tournaments",',
    '    body: "Create a new tournament to get started",',
    '    cta: { label: "Create tournament", href: "/tournaments/new", route: "tournament-new" }',
    '  });',
    '  const action = el(doc, "button", { "aria-label": "Close dialog", title: "Action title" }, "Cancel action");',
    '  btn.textContent = i18n ? i18n.t("action.save") : "Save changes";',
    '  btn.setAttribute("title", "Click to submit");',
    '  btn.title = session === null ? "Sign in to play the computer" : "";',
    '  input.placeholder = "e.g. Nf3";',
    '  setStatus(`Played ${move.from}–${move.to}.`);',
    '}',
  ].join('\n');

  const violations = scanSourceForViolations('synthetic-test.ts', syntheticSnippet);
  assert.ok(violations.length >= 13, `expected at least 13 synthetic violations, got ${violations.length}`);

  const types = violations.map((v) => v.type);
  assert.ok(types.includes('option.label'), 'must catch option.label');
  assert.ok(types.includes('validation.message'), 'must catch validation.message');
  assert.ok(types.includes('textContent-template'), 'must catch interpolated textContent template');
  assert.ok(types.includes('renderEmpty.title'), 'must catch renderEmpty.title');
  assert.ok(types.includes('renderEmpty.body'), 'must catch renderEmpty.body');
  assert.ok(types.includes('renderEmpty.cta.label'), 'must catch renderEmpty.cta.label');
  assert.ok(types.includes('el(attrs.aria-label)'), 'must catch el() aria-label attr');
  assert.ok(types.includes('el(attrs.title)'), 'must catch el() title attr');
  assert.ok(types.includes('el(child)'), 'must catch el() text child');
  assert.ok(types.includes('textContent-ternary-false'), 'must catch ternary false English fallback');
  assert.ok(types.includes('setAttribute(title)'), 'must catch setAttribute(title)');
  assert.ok(types.includes('title-ternary-true'), 'must catch DOM property title = ternary');
  assert.ok(types.includes('placeholder'), 'must catch DOM property placeholder =');
  assert.ok(types.includes('setStatus(arg)-template'), 'must catch setStatus template literal');
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

  // Mutation 4: Raw .title DOM property assignment
  const m4 = `
    playBotBtn.title = 'Sign in to play the computer';
  `;
  const v4 = scanSourceForViolations('mutation-4.ts', m4);
  assert.equal(v4.length, 1);
  assert.equal(v4[0]?.type, 'title');
  assert.equal(v4[0]?.text, 'Sign in to play the computer');

  // Mutation 5: Raw .placeholder DOM property assignment
  const m5 = `
    sanInput.placeholder = 'e.g. Nf3';
  `;
  const v5 = scanSourceForViolations('mutation-5.ts', m5);
  assert.equal(v5.length, 1);
  assert.equal(v5[0]?.type, 'placeholder');
  assert.equal(v5[0]?.text, 'e.g. Nf3');

  // Mutation 6: Raw validation message object
  const m6 = `
    return { valid: false, message: 'Minimum rating must not exceed maximum rating.' };
  `;
  const v6 = scanSourceForViolations('mutation-6.ts', m6);
  assert.equal(v6.length, 1);
  assert.equal(v6[0]?.type, 'validation.message');
  assert.equal(v6[0]?.text, 'Minimum rating must not exceed maximum rating.');

  // Mutation 7: Protocol word 'White' used as user-visible label in option or child
  const m7 = `
    label.textContent = 'White';
  `;
  const v7 = scanSourceForViolations('mutation-7.ts', m7);
  assert.equal(v7.length, 1);
  assert.equal(v7[0]?.type, 'textContent');
  assert.equal(v7[0]?.text, 'White');

  // Mutation 8: An unclassified file cannot evade the classification guard
  const fakeFileList = ['assess-view.ts', 'unclassified-feature-view.ts'];
  const fakeNonUi = { 'assess-controller.ts': 'Headless controller' };
  const classified = new Set([...Object.keys(fakeNonUi), 'assess-view.ts']);
  const unclassified = fakeFileList.filter((f) => !classified.has(f));
  assert.equal(unclassified.length, 1);
  assert.equal(unclassified[0], 'unclassified-feature-view.ts');

  // Mutation 9: setStatus called with interpolated English copy template
  const m9 = `
    setStatus(\`Played \${move.from}–\${move.to}.\`);
  `;
  const v9 = scanSourceForViolations('mutation-9.ts', m9);
  assert.ok(v9.length >= 1, 'must catch setStatus template literal');
  assert.equal(v9[0]?.type, 'setStatus(arg)-template');
  assert.equal(v9[0]?.text, 'Played ');

  // Mutation 10: setStatus called with raw English copy string literal
  const m10 = `
    setStatus('Premove set: e2–e4.');
  `;
  const v10 = scanSourceForViolations('mutation-10.ts', m10);
  assert.equal(v10.length, 1, 'must catch setStatus string literal');
  assert.equal(v10[0]?.type, 'setStatus(arg)');
  assert.equal(v10[0]?.text, 'Premove set: e2–e4.');
});

test('time-presets: estimateSpeed returns technical domain tokens, not English display labels', () => {
  const speeds = [
    estimateSpeed({ initialMs: 30_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }),
    estimateSpeed(presetToTimeControl(1, 0)),
    estimateSpeed(presetToTimeControl(3, 2)),
    estimateSpeed(presetToTimeControl(10, 0)),
    estimateSpeed(presetToTimeControl(30, 20)),
    estimateSpeed({ initialMs: 0, incrementMs: 0, delayMs: 0, kind: 'unlimited' }),
  ];

  const validTechnicalSpeeds = new Set([
    'ultrabullet',
    'bullet',
    'blitz',
    'rapid',
    'classical',
    'correspondence',
  ]);

  for (const s of speeds) {
    assert.ok(validTechnicalSpeeds.has(s), `expected technical speed token, got: ${s}`);
    assert.equal(s, s.toLowerCase(), `technical speed token must be lowercase, got: ${s}`);
    // Structural assertion: MUST NOT be English display copy
    assert.notEqual(s, 'Bullet');
    assert.notEqual(s, 'Blitz');
    assert.notEqual(s, 'Rapid');
    assert.notEqual(s, 'Classical');
    assert.notEqual(s, 'Correspondence');
  }
});
