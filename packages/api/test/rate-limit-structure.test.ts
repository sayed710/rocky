/**
 * A structural guard: no route may make two rate-limit decisions.
 *
 * The defect this increment fixed was not a wrong line, it was a *shape* — a handler asking the
 * limiter about one bucket, acting on the answer, then asking about another. Fixing the six routes
 * that had that shape does not stop the seventh from being written the same way, and a behavioural
 * test cannot see it: a route with two sequential admissions passes every "is it limited?" test,
 * and only misbehaves when the second bucket refuses a request the first has already charged.
 *
 * Two things hold the shape now. The port has a single admission method taking every bucket at
 * once, so there is no single-key consuming call to reach for — that is the primary guard, and it
 * is enforced by the compiler. This file closes the remaining gap: the port cannot stop a handler
 * from calling the multi-bucket method twice.
 *
 * It reads `routes.ts` through the **TypeScript parser** rather than by matching text. The first
 * version matched the string `admit([`, which missed a handler that prepared its bucket list in a
 * variable first; the second matched `admit(` with a lookbehind, which cannot tell a call from the
 * same characters inside a comment or a string literal and bounded the bucket list by searching
 * for `]);`. Both were raised in the CodeRabbit review of PR #137. A guard that stands in for a
 * deleted method should not itself be approximate, and the compiler that already builds this
 * package can answer the question exactly.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';

const ROUTES_PATH = join(process.cwd(), 'src/routes.ts');
const SOURCE = ts.createSourceFile(
  'routes.ts',
  readFileSync(ROUTES_PATH, 'utf8'),
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
);

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);

interface Route {
  readonly path: string;
  readonly line: number;
  readonly node: ts.CallExpression;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function lineOf(node: ts.Node): number {
  return SOURCE.getLineAndCharacterOfPosition(node.getStart(SOURCE)).line + 1;
}

/** Every `router.<verb>('<path>', …)` registration, with the whole registration as its subtree. */
function routes(): Route[] {
  const found: Route[] = [];
  walk(SOURCE, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return;
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'router') return;
    if (!VERBS.has(callee.name.text)) return;
    const first = node.arguments[0];
    if (first === undefined || !ts.isStringLiteral(first)) return;
    found.push({ path: first.text, line: lineOf(node), node });
  });
  return found;
}

/**
 * Calls to the local `admit(...)` or `reserve(...)` helpers inside `node` — identifier calls, not
 * property ones. `admit` wraps `reserve`, so each is one admission decision.
 */
function admissions(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  walk(node, (n) => {
    if (!ts.isCallExpression(n)) return;
    if (ts.isIdentifier(n.expression) && ['admit', 'reserve'].includes(n.expression.text)) calls.push(n);
  });
  return calls;
}

/**
 * The literal prefix of one bucket's `key`.
 *
 * Every key in the table is written as `` `prefix:${something}` ``, so the template's head is the
 * part that names the bucket. A plain string is taken whole. Anything else — a variable, a call,
 * a concatenation — fails: this test cannot tell what such a key would be at run time, and a guard
 * that quietly stops checking is worse than one that stops the build.
 */
function bucketKey(element: ts.Expression, path: string): string {
  assert.ok(ts.isObjectLiteralExpression(element), `${path}: each bucket must be an object literal`);
  const property = element.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === 'key',
  );
  assert.ok(property, `${path}: each bucket must define a key`);

  const value = property.initializer;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isTemplateExpression(value)) return value.head.text;
  assert.fail(`${path}: a bucket key must be a string or template literal, got ${ts.SyntaxKind[value.kind]}`);
}

function routeNamed(path: string): Route {
  const match = routes().find((r) => r.path === path);
  assert.ok(match, `route ${path} is no longer in the table`);
  return match;
}

test('the limiter port is reached through exactly one call site in the whole route table', () => {
  const direct: ts.CallExpression[] = [];
  walk(SOURCE, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'admit') return;
    if (ts.isIdentifier(callee.expression) && callee.expression.text === 'rateLimiter') {
      direct.push(n);
    }
  });

  assert.equal(
    direct.length,
    1,
    'every route must go through the local `admit` helper; a second direct call site is a second ' +
      'place for the charge/refuse ordering to be got wrong',
  );
});

test('no handler makes more than one admission decision', () => {
  const offenders = routes()
    .map((r) => ({ path: r.path, line: r.line, calls: admissions(r.node).length }))
    .filter((r) => r.calls > 1);

  assert.deepEqual(
    offenders,
    [],
    'a handler calling `admit(...)` or `reserve(...)` twice is two independent decisions, so the first can be ' +
      'charged before the second refuses — hand every bucket to one call instead',
  );
});

/**
 * The routes that must be charging more than one bucket, and are therefore the ones the invariant
 * is actually about. Listed by name so that silently dropping a bucket from any of them — turning
 * a per-user *and* per-IP guard into a per-IP one — fails here rather than passing quietly.
 */
test('every multi-bucket route hands both buckets to a single admission', () => {
  const expected: Record<string, readonly string[]> = {
    '/v1/auth/login': ['login:ip:', 'login:handle-ip:'],
    '/v1/auth/password-reset/request': ['password-reset:ip:', 'password-reset:target:'],
    '/v1/auth/email/verification/request': ['email-verification:user:', 'email-verification:ip:'],
    '/v1/analysis': ['analysis:user:', 'analysis:ip:'],
    '/v1/analysis/mistake-prediction': ['mistake-prediction:user:', 'mistake-prediction:ip:'],
    '/v1/ai/move-explanation': ['move-explanation:user:', 'move-explanation:ip:'],
  };

  for (const [path, keys] of Object.entries(expected)) {
    const calls = admissions(routeNamed(path).node);
    assert.equal(calls.length, 1, `${path} must make exactly one admission decision`);

    // The bucket list has to be readable here, so it must be a literal at the call rather than a
    // variable assembled earlier. That is a real constraint and not merely this test's convenience:
    // the point of naming these six routes is that dropping a bucket from one of them fails, and a
    // list built somewhere else is a list this assertion cannot check.
    const argument = calls[0]!.arguments[0];
    assert.ok(
      argument !== undefined && ts.isArrayLiteralExpression(argument),
      `${path} must pass its buckets as an array literal at the admission`,
    );

    assert.equal(
      argument.elements.length,
      keys.length,
      `${path} must charge exactly ${keys.length} buckets`,
    );

    // Read each bucket's `key` from its own AST node. Matching against the argument's source text
    // would count a mention in a comment: a route could swap a required bucket for a different one,
    // keep the array length, leave the old name in a comment beside it, and satisfy every
    // assertion here while charging the wrong thing. Raised in the CodeRabbit review of PR #137.
    const charged = argument.elements.map((element) => bucketKey(element, path));
    for (const key of keys) {
      assert.ok(charged.includes(key), `${path} must charge ${key} in the same admission`);
    }
  }
});

/**
 * `/v1/analysis`, `/v1/analysis/mistake-prediction` and `/v1/ai/move-explanation` each buy real
 * engine time, so a request rejected by validation must reach no bucket at all. The cheap way to
 * lose that is to move the charge back above the parsing, where it started. `/v1/auth/login` is
 * here for a different reason (audit P1-1): a malformed body, such as a code that is not eight
 * digits, must not spend a failure budget or count toward step-up.
 */
test('the expensive routes parse the body before they charge for it', () => {
  for (const path of ['/v1/analysis', '/v1/analysis/mistake-prediction', '/v1/ai/move-explanation', '/v1/auth/login']) {
    const route = routeNamed(path);

    let parse: ts.CallExpression | undefined;
    walk(route.node, (n) => {
      if (parse !== undefined || !ts.isCallExpression(n)) return;
      if (!ts.isIdentifier(n.expression) || n.expression.text !== 'strictObject') return;
      const first = n.arguments[0];
      if (first !== undefined && ts.isPropertyAccessExpression(first) && first.name.text === 'body') {
        parse = n;
      }
    });
    assert.ok(parse, `${path} should validate its body`);

    const charge = admissions(route.node)[0];
    assert.ok(charge, `${path} should charge quota`);
    assert.ok(
      charge.getStart(SOURCE) > parse.getStart(SOURCE),
      `${path} must charge quota only after the body is known to be real`,
    );
  }
});

/**
 * Login's handle-and-source bucket is a failure budget (audit P1-1): reserved at admission and
 * refunded once the password is known to be right. Refunding before the check would make them free for an
 * attacker, and marking the IP bucket refundable would stop it counting every attempt.
 */
test('login refunds exactly its failure bucket, and only after the password check', () => {
  const route = routeNamed('/v1/auth/login');
  const refunds: ts.CallExpression[] = [];
  let check: ts.CallExpression | undefined;
  walk(route.node, (n) => {
    if (!ts.isCallExpression(n)) return;
    if (ts.isIdentifier(n.expression) && n.expression.text === 'refund') refunds.push(n);
    if (
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'login' &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'auth'
    ) {
      check = n;
    }
  });

  assert.equal(refunds.length, 1, 'login must refund in exactly one place');
  assert.ok(check, 'login must call auth.login');
  assert.ok(refunds[0]!.getStart(SOURCE) > check.getStart(SOURCE), 'refund must follow auth.login');

  // What is refunded is exactly what the admission reserved: the value `reserve(...)` resolved to.
  const [admission] = admissions(route.node);
  assert.ok(admission && ts.isIdentifier(admission.expression));
  assert.equal(admission.expression.text, 'reserve', 'login must use `reserve` to get reservations');
  const declaration = admission.parent.parent;
  assert.ok(
    ts.isAwaitExpression(admission.parent) && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name),
    'the reservations must be bound to a variable',
  );
  // The refund's argument is built from what `reserve` returned (plus the account-wide count's own
  // reservation), never from a bucket list written out again at the refund.
  const refunded = refunds[0]!.arguments[1];
  assert.ok(refunded && ts.isIdentifier(refunded), 'refund must take a named value');
  let built: ts.VariableDeclaration | undefined;
  walk(route.node, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === refunded.text) built = n;
  });
  const mentions = new Set<string>();
  if (built?.initializer) walk(built.initializer, (n) => { if (ts.isIdentifier(n)) mentions.add(n.text); });
  assert.ok(
    refunded.text === declaration.name.text || mentions.has(declaration.name.text),
    'refund must hand back the reservations `reserve` returned',
  );

  // The account-wide count is a tally — it signals step-up, it never refuses — and it is keyed by
  // the handle alone.
  const tallies: ts.CallExpression[] = [];
  walk(route.node, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'tally') {
      tallies.push(n);
    }
  });
  assert.equal(tallies.length, 1, 'login must tally exactly once');
  const tallied = tallies[0]!.arguments[0];
  assert.ok(tallied !== undefined && ts.isObjectLiteralExpression(tallied));
  assert.equal(bucketKey(tallied, '/v1/auth/login'), 'login:handle:');

  const argument = admission.arguments[0];
  assert.ok(argument !== undefined && ts.isArrayLiteralExpression(argument));
  const refundable = argument.elements
    .filter((element) =>
      ts.isObjectLiteralExpression(element) &&
      element.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === 'refundable' &&
          p.initializer.kind === ts.SyntaxKind.TrueKeyword,
      ))
    .map((element) => bucketKey(element, '/v1/auth/login'))
    .sort();
  assert.deepEqual(refundable, ['login:handle-ip:']);
});
