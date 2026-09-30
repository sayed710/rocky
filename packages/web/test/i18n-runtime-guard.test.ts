/**
 * Deterministic AST/Syntax Runtime Localization Coverage Guard.
 *
 * Verifies that runtime view renderers in `packages/web/src/app/` do not assign raw
 * English string literals to DOM nodes (`.textContent`, `.innerHTML`, `.innerText`,
 * `setAttribute('aria-label'|'title'|'placeholder', ...)`, or `renderEmpty(...)`).
 *
 * All user-facing copy must be routed through `i18n.t(key)`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
 * Distinguishes user-visible English copy strings from structural HTML tags,
 * punctuation, numeric strings, or DOM property/event names.
 */
export function isCopyString(text: string): boolean {
  if (!text || text.trim() === '') return false;
  // Ignore purely symbols / digits / technical / punctuation
  if (/^[\s\d\.\:\-\+\#\·\—\–\(\)\/\_]+$/.test(text)) return false;
  // Ignore standard event names, HTML tags, input types, and boolean/state tokens
  if (/^(click|change|submit|input|keydown|keyup|focus|blur|resize|scroll|load|unload)$/.test(text)) return false;
  if (/^(button|div|span|p|a|input|form|fieldset|legend|table|thead|tbody|tr|td|th|ul|li|ol|select|option|label|dialog|section|nav|header|footer|main|article|aside|h[1-6]|bdi|bdo)$/.test(text)) return false;
  if (/^(text|hidden|checkbox|radio|submit|reset|number|decimal)$/.test(text)) return false;
  if (/^(ltr|rtl|auto|off|none|polite|assertive|true|false)$/.test(text)) return false;
  // English copy typically contains multi-word phrases or capitalized English words
  return /\b[A-Z][a-z]{2,}\b/.test(text) || /\s[a-z]{2,}\s/.test(text);
}

/**
 * Deterministically scans a TypeScript AST for raw string literal DOM assignments.
 */
export function scanSourceForViolations(fileName: string, sourceCode: string): AstViolation[] {
  const sf = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true);
  const violations: AstViolation[] = [];

  function walk(node: ts.Node): void {
    // 1. Assignment to textContent, innerHTML, innerText
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isPropertyAccessExpression(node.left)) {
        const prop = node.left.name.text;
        if (['textContent', 'innerHTML', 'innerText'].includes(prop)) {
          if (ts.isStringLiteral(node.right) || ts.isNoSubstitutionTemplateLiteral(node.right)) {
            if (isCopyString(node.right.text)) {
              violations.push({
                file: fileName,
                type: prop,
                text: node.right.text,
                line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              });
            }
          }
        }
      }
    }
    // 2. Call to setAttribute('aria-label' | 'title' | 'placeholder', 'literal')
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setAttribute') {
        const [arg0, arg1] = node.arguments;
        if (arg0 && ts.isStringLiteral(arg0) && ['aria-label', 'title', 'placeholder'].includes(arg0.text)) {
          if (arg1 && (ts.isStringLiteral(arg1) || ts.isNoSubstitutionTemplateLiteral(arg1))) {
            if (isCopyString(arg1.text)) {
              violations.push({
                file: fileName,
                type: `setAttribute(${arg0.text})`,
                text: arg1.text,
                line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              });
            }
          }
        }
      }
      // 3. Call to renderEmpty(..., 'literal')
      if (ts.isIdentifier(node.expression) && node.expression.text === 'renderEmpty') {
        const lastArg = node.arguments[node.arguments.length - 1];
        if (lastArg && (ts.isStringLiteral(lastArg) || ts.isNoSubstitutionTemplateLiteral(lastArg))) {
          if (isCopyString(lastArg.text)) {
            violations.push({
              file: fileName,
              type: 'renderEmpty',
              text: lastArg.text,
              line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            });
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  }

  walk(sf);
  return violations;
}

test('i18n AST guard: all runtime view renderers in packages/web/src/app have 0 raw copy literals', () => {
  const files = readdirSync(APP_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 10, 'expected to find app TypeScript source files');

  const allViolations: AstViolation[] = [];
  for (const file of files) {
    const filePath = resolve(APP_DIR, file);
    const content = readFileSync(filePath, 'utf8');
    const violations = scanSourceForViolations(file, content);
    allViolations.push(...violations);
  }

  assert.deepEqual(
    allViolations,
    [],
    `Found ${allViolations.length} raw copy literal violation(s) in packages/web/src/app/*.ts. Use i18n.t() instead.`,
  );
});

test('i18n AST guard falsification: catches synthetic textContent, innerHTML, setAttribute, and renderEmpty violations', () => {
  const syntheticSnippet = `
    function render(el: HTMLElement, container: HTMLElement, btn: HTMLElement) {
      el.textContent = "Welcome to the game";
      container.innerHTML = "<div>Something went wrong</div>";
      btn.setAttribute("aria-label", "Play now");
      renderEmpty(container, "No active tournaments");
    }
  `;

  const violations = scanSourceForViolations('synthetic-test.ts', syntheticSnippet);
  assert.equal(violations.length, 4, 'expected exactly 4 synthetic violations');

  assert.equal(violations[0]?.type, 'textContent');
  assert.equal(violations[0]?.text, 'Welcome to the game');

  assert.equal(violations[1]?.type, 'innerHTML');
  assert.equal(violations[1]?.text, '<div>Something went wrong</div>');

  assert.equal(violations[2]?.type, 'setAttribute(aria-label)');
  assert.equal(violations[2]?.text, 'Play now');

  assert.equal(violations[3]?.type, 'renderEmpty');
  assert.equal(violations[3]?.text, 'No active tournaments');
});
