import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  findDeployedRevision,
  formatGithubOutput,
  resolveDeployedImageTags,
} from '../lib/deployed-image-tags.mjs';

const CLI = 'scripts/resolve-deployed-image-tags.mjs';

/** Computed values the way `helm get values --all` returns them, reduced to what is read. */
function deployedValues({ strategy = 'rolling', api = '1.1.0', web = '1.1.0', gateway = '1.1.0', activeColor = 'blue', blue = '', green = '' } = {}) {
  return {
    images: { api: { tag: api }, web: { tag: web }, gateway: { tag: gateway } },
    rollout: { strategy, blueGreen: { activeColor, colors: { blue: { tag: blue }, green: { tag: green } } }, canary: { tag: '' } },
  };
}

test('a rolling release is live on images.*.tag and has no colours', () => {
  assert.deepEqual(resolveDeployedImageTags(deployedValues()), {
    strategy: 'rolling', activeColor: '', api: '1.1.0', web: '1.1.0', gateway: '1.1.0',
    liveApi: '1.1.0', liveWeb: '1.1.0', blue: '', green: '',
  });
});

test('a canary release is live on its stable track, never on the canary tag', () => {
  const values = deployedValues({ strategy: 'canary' });
  values.rollout.canary.tag = '1.2.0';
  const tags = resolveDeployedImageTags(values);
  assert.equal(tags.liveApi, '1.1.0');
  assert.equal(tags.liveWeb, '1.1.0');
});

test('a blue/green release is live on the active colour, resolved the way the chart resolves it', () => {
  const flipped = resolveDeployedImageTags(deployedValues({ strategy: 'blueGreen', activeColor: 'green', green: '1.2.3' }));
  assert.equal(flipped.liveApi, '1.2.3');
  assert.equal(flipped.liveWeb, '1.2.3');
  assert.equal(flipped.blue, '');
  assert.equal(flipped.green, '1.2.3');
  assert.equal(flipped.api, '1.1.0', 'images.api.tag stays the fallback the untagged colour runs');

  // An active colour with no tag of its own runs images.<component>.tag.
  const staged = resolveDeployedImageTags(deployedValues({ strategy: 'blueGreen', activeColor: 'blue', green: '1.2.3' }));
  assert.equal(staged.liveApi, '1.1.0');
  assert.equal(staged.activeColor, 'blue');
});

test('stale colour tags are ignored unless the deployed strategy is blueGreen', () => {
  const tags = resolveDeployedImageTags(deployedValues({ strategy: 'rolling', blue: '0.9.0', green: '0.8.0' }));
  assert.equal(tags.blue, '');
  assert.equal(tags.green, '');
  assert.equal(tags.liveApi, '1.1.0');
});

test('a missing strategy is the chart default, rolling', () => {
  const values = deployedValues();
  delete values.rollout;
  assert.equal(resolveDeployedImageTags(values).strategy, 'rolling');
});

test('anything that cannot be resolved exactly is refused', () => {
  const cases = [
    [null, /not a JSON object/],
    [[], /not a JSON object/],
    [deployedValues({ strategy: 'bogus' }), /rollout.strategy/],
    [deployedValues({ api: '' }), /images.api.tag/],
    [(() => { const v = deployedValues(); delete v.images.gateway; return v; })(), /images.gateway.tag/],
    [deployedValues({ web: '1.0;rm -rf /' }), /images.web.tag/],
    [deployedValues({ api: '-1.0' }), /images.api.tag/],
    [deployedValues({ strategy: 'blueGreen', activeColor: 'purple' }), /activeColor/],
    [deployedValues({ strategy: 'blueGreen', green: '$(id)' }), /colors.green.tag/],
  ];
  for (const [values, message] of cases) {
    assert.throws(() => resolveDeployedImageTags(values), message);
  }
  const numeric = deployedValues();
  numeric.images.api.tag = 1.1; // a tag Helm parsed as a number is not the string that was deployed
  assert.throws(() => resolveDeployedImageTags(numeric), /images.api.tag/);
});

test('the deployed revision is the newest one whose status is deployed', () => {
  assert.equal(findDeployedRevision([
    { revision: 3, status: 'superseded' },
    { revision: 4, status: 'deployed' },
    { revision: 5, status: 'failed' },
    { revision: 6, status: 'pending-upgrade' },
  ]), 4);
  assert.equal(findDeployedRevision([{ revision: '7', status: 'deployed' }]), 7);
  assert.throws(() => findDeployedRevision([{ revision: 2, status: 'failed' }]), /no revision/);
  assert.throws(() => findDeployedRevision([{ revision: 'x', status: 'deployed' }]), /no revision/);
  assert.throws(() => findDeployedRevision({}), /not a JSON array/);
});

test('output lines are exactly the keys deploy.yml reads', () => {
  const text = formatGithubOutput(resolveDeployedImageTags(deployedValues({ strategy: 'blueGreen', green: '1.2.3' })));
  assert.equal(text, [
    'deployed_strategy=blueGreen', 'deployed_active_color=blue', 'deployed_api_tag=1.1.0',
    'deployed_web_tag=1.1.0', 'deployed_gateway_tag=1.1.0', 'deployed_live_api_tag=1.1.0',
    'deployed_live_web_tag=1.1.0', 'deployed_blue_tag=', 'deployed_green_tag=1.2.3', '',
  ].join('\n'));
});

test('the CLI prints outputs on success and fails closed on bad input', () => {
  const ok = spawnSync(process.execPath, [CLI], { input: JSON.stringify(deployedValues()), encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^deployed_live_api_tag=1\.1\.0$/m);

  const revision = spawnSync(process.execPath, [CLI, '--deployed-revision'], { input: '[{"revision":2,"status":"deployed"}]', encoding: 'utf8' });
  assert.equal(revision.stdout, '2\n');

  for (const [args, input] of [[[], ''], [[], '{"images":{}}'], [['--bogus'], '{}'], [['--deployed-revision'], '[]']]) {
    const bad = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });
    assert.equal(bad.status, 1, `expected failure for ${JSON.stringify(args)} ${input}`);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /^resolve-deployed-image-tags: /);
  }
});
