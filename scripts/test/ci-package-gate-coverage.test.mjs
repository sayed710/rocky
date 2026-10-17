import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

// Evaluate the real workflow patterns rather than maintaining a duplicate allowlist.
// These expressions use the common JS/POSIX ERE subset: anchors, groups, alternatives,
// escaped dots and optional groups. No glob or shell expansion is simulated here.
function filter(area) {
  const lines = workflow.split('\n').filter(line => line.includes(`&& ${area}=true || ${area}=false`));
  assert.equal(lines.length, 1, `one ${area} filter must exist`);
  const expression = lines[0].match(/grep -qE '([^']+)'/);
  assert.ok(expression, `${area} must expose its single-quoted ERE`);
  return new RegExp(expression[1]);
}

function workspaceDependencies(manifest, seen = new Set()) {
  const dir = path.dirname(manifest);
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const spec of Object.values(pkg.dependencies ?? {})) {
    if (!spec.startsWith('file:')) continue;
    const dependency = path.resolve(dir, spec.slice(5));
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    workspaceDependencies(path.join(dependency, 'package.json'), seen);
  }
  return seen;
}

for (const [area, manifest] of [
  ['gateway', 'services/gateway/package.json'],
  ['web', 'packages/e2e-harness/package.json'],
]) {
  test(`${area} acceptance includes every current transitive workspace dependency`, () => {
    const matches = filter(area);
    for (const dir of workspaceDependencies(path.join(root, manifest))) {
      const source = path.relative(root, dir).split(path.sep).join('/') + '/src/changed.ts';
      assert.ok(matches.test(source), `${area} silently omits ${source}`);
    }
  });
  test(`${area} conservatively includes newly added workspace packages`, () => {
    assert.ok(filter(area).test('packages/future-dependency/src/index.ts'));
  });
}

test('gateway service and acceptance infrastructure retain coverage', () => {
  const matches = filter('gateway');
  for (const source of [
    'services/gateway/src/serve.ts', 'scripts/run-gateway-tests.mjs',
    'scripts/check-test-topology.mjs', 'scripts/test/gateway-signal-route.test.mjs',
    'scripts/nginx-trusted-edge-acceptance.mjs', 'scripts/nginx-web-delivery-acceptance.mjs',
    'scripts/lib/wait-for-health.mjs', 'Dockerfile.gateway-test', 'docker/web/nginx.conf.template',
  ]) assert.ok(matches.test(source), source);
});

test('root manifests and workflow changes still select both acceptance jobs', () => {
  for (const area of ['gateway', 'web']) {
    for (const source of ['package.json', 'package-lock.json', '.github/workflows/ci.yml']) {
      assert.ok(filter(area).test(source), `${area}: ${source}`);
    }
  }
});

test('unrelated root documentation does not select expensive acceptance jobs', () => {
  for (const area of ['gateway', 'web']) {
    for (const source of ['README.md', 'docs/audits/example.md']) {
      assert.equal(filter(area).test(source), false, `${area}: ${source}`);
    }
  }
});
