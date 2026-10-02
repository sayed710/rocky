import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Two levels up: the suite runs from `dist-test/test/`, not from source. Same as `style-contract.test.ts`.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const E2E_DIR = resolve(PACKAGE_ROOT, 'e2e');

/**
 * Regression: `account-security-sessions.spec.ts` shipped in M14 inc 46 (PR #126) without the
 * top-level `GAMBIT_E2E_BACKEND` guard every other backend-dependent spec declares. It calls
 * `/v1/auth/register` against the e2e harness, so under the documented static run — `npm run e2e`
 * with no environment variable, harness not started — its five tests failed on a dead preview
 * proxy. CI always sets `GAMBIT_E2E_BACKEND=1`, so CI stayed green for two milestones' worth of
 * increments while the documented local command was broken. Nothing in review catches a missing
 * line, which is why this is a test and not a convention.
 *
 * The subject is the spec source, so reading it is the only available surface: whether Playwright
 * skips a file is decided inside a Playwright run, and there is no resolved object to import the
 * way `dev-proxy.test.ts` imports the Vite config. That test's warning about scraping source still
 * applies to *how*, and `hasBackendGuard` below answers it by parsing rather than pattern-matching.
 *
 * Fails closed: a new spec on neither side of the ledger fails test 1, so the author has to make a
 * deliberate, reviewable choice rather than inheriting a default.
 */
const STATIC_SPECS = new Set([
  'app-loads.spec.ts',
  'auth-responsive.spec.ts',
  'create-game-responsive.spec.ts',
  'offline-navigation.spec.ts',
  'leaderboard.spec.ts',
  'password-recovery.spec.ts',
  'email-verification.spec.ts',
  'rtl-layout-reliability.spec.ts',
  'localization-state.spec.ts',
  'seek-creator-rating.spec.ts',
]);

/**
 * Recursive, because Playwright recurses `testDir` too — a spec parked in a subdirectory is
 * collected and run like any other, and a non-recursive scan would exempt it silently. That is the
 * one hole a fail-closed check cannot afford. Paths come back relative to `e2e/`, so a nested spec
 * can never accidentally match a bare filename in the allowlist.
 *
 * Separators are normalised to `/` because `readdirSync` emits the platform's own: a nested spec is
 * `sub\name.spec.ts` here and `sub/name.spec.ts` in CI. Nothing in the current flat layout depends
 * on it, but the day someone allowlists a nested spec, the entry they write would match on Linux
 * and not on Windows — a divergence between the machine that develops and the machine that gates.
 */
function listSpecs(): string[] {
  const entries = readdirSync(E2E_DIR, { recursive: true, encoding: 'utf8' });
  const specs = entries.filter((file) => file.endsWith('.spec.ts')).map((file) => file.replaceAll('\\', '/'));
  assert.ok(specs.length > 0, `no .spec.ts files found under ${E2E_DIR}`);
  return specs;
}

/**
 * The guard as a *statement*, established by parsing rather than by matching text.
 *
 * Text matching cannot express what the guard actually has to be. Searching for `test.skip` and
 * `GAMBIT_E2E_BACKEND` anywhere in the file passes a spec that names the variable only in a comment
 * while its `test.skip()` calls sit inside test bodies, gating nothing; tightening that to one
 * regex still passes a guard that has been commented out, since a comment is text like any other.
 * Both read as guarded and neither is. What makes the guard work is that it is a top-level
 * statement — a property no regex can check, and the one the parser checks for free.
 *
 * `style-contract.test.ts` already strips comments and tracks quotes for the same reason, and
 * `typescript` is a declared devDependency of this package, so this is the established way here
 * rather than a new one. It is also the *less* brittle choice: reformatting, quote style and
 * bracket-vs-dot access stop being anybody's problem, which is what `dev-proxy.test.ts` warns
 * about.
 *
 * One spelling is still required — the condition has to name the variable, so aliasing it into a
 * local first is rejected even though it would work. That asymmetry is deliberate and the right way
 * round: a false positive fails loudly with the expected form quoted in the error, while a false
 * negative is a backend-dependent spec silently escaping the gate.
 */
function hasBackendGuard(file: string): boolean {
  const source = readFileSync(resolve(E2E_DIR, file), 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

  return parsed.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement)) return false;
    const call = statement.expression;
    if (!ts.isCallExpression(call)) return false;

    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    if (callee.name.text !== 'skip' || callee.expression.getText(parsed) !== 'test') return false;

    const [condition] = call.arguments;
    return condition !== undefined && condition.getText(parsed).includes('GAMBIT_E2E_BACKEND');
  });
}

test('every e2e spec not on the static allowlist declares the backend skip guard', () => {
  const specs = listSpecs();
  const missingGuard = specs.filter((file) => !STATIC_SPECS.has(file) && !hasBackendGuard(file));
  assert.deepEqual(
    missingGuard,
    [],
    `The following e2e spec(s) are missing the GAMBIT_E2E_BACKEND skip guard:\n` +
      missingGuard.map((f) => `  - ${f}`).join('\n') +
      `\nAdd the guard (\`test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend');\`) ` +
      `or add the file to STATIC_SPECS in test/e2e-backend-guard.test.ts if it truly runs without a backend.`,
  );
});

test('no allowlisted static spec declares the backend skip guard', () => {
  const specs = listSpecs();
  const staleAllowlist = specs.filter((file) => STATIC_SPECS.has(file) && hasBackendGuard(file));
  assert.deepEqual(
    staleAllowlist,
    [],
    `The following allowlisted static spec(s) declare the GAMBIT_E2E_BACKEND skip guard:\n` +
      staleAllowlist.map((f) => `  - ${f}`).join('\n') +
      `\nRemove them from STATIC_SPECS because they are gated with GAMBIT_E2E_BACKEND.`,
  );
});

test('every entry in the static allowlist corresponds to an existing spec file', () => {
  const specs = new Set(listSpecs());
  const deadEntries = [...STATIC_SPECS].filter((file) => !specs.has(file));
  assert.deepEqual(
    deadEntries,
    [],
    `The following entries in STATIC_SPECS do not exist in ${E2E_DIR}:\n` +
      deadEntries.map((f) => `  - ${f}`).join('\n') +
      `\nRemove non-existent spec files from STATIC_SPECS.`,
  );
});
