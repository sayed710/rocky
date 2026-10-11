#!/usr/bin/env node
/**
 * Fails when deploy or release workflows violate deployment gating invariants or drift from Helm config.
 *
 * Deployments and releases require strict gates: human approval environments, non-cancelling deployment
 * queues, atomic rollbacks with explicit timeouts, image existence verification, no floating latest tags,
 * precise matching between published image repos and Helm chart image values, strategy-independent
 * Deployment selectors, pre-flight template validation, and single-source strategy argument composition.
 *
 * Without automated enforcement, workflow modifications can quietly remove gates, leave broken deployments
 * hanging in Kubernetes, publish images to repositories that the Helm chart does not reference, hardcode
 * Deployment names that break under blue/green or canary rollouts, execute upgrades with invalid flag compositions,
 * or introduce argument drift between dry-run validation and actual upgrade execution.
 *
 * Checks:
 *   1. deploy.yml's deploy job declares an environment (human approval gate).
 *   2. deploy.yml specifies concurrency with cancel-in-progress: false (deploys queue, never cancel).
 *   3. Every helm upgrade command in deploy.yml passes --atomic, --wait, and an explicit --timeout.
 *   4. deploy.yml's deploy job is `needs:`-gated (does not run unqualified).
 *   5. Neither release.yml nor deploy.yml uses floating `:latest` image tags.
 *   6. Published image repos in release.yml match values.yaml image repositories exactly.
 *   7. deploy.yml does not refer to Deployments by hardcoded names (names vary by strategy, ADR-0075).
 *   8. deploy.yml includes a "helm template" pre-flight check before "helm upgrade".
 *   9. deploy.yml strategy composition ("case $STRATEGY in") appears exactly once (no argument drift).
 *  10. The automatic rollback targets only the revision scripts/resolve-rollback-revision.mjs verified
 *      (no inline revision selection such as history[history.length - 1]); PREV_REV is read only from
 *      the file the resolver writes its output to.
 *
 * Run: node scripts/check-deploy-gates.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEPLOY_WORKFLOW = '.github/workflows/deploy.yml';
const RELEASE_WORKFLOW = '.github/workflows/release.yml';
const CHART_VALUES = 'deploy/helm/gambit/values.yaml';

const problems = [];

function getJobBlock(workflowText, jobName) {
  // Find `jobName:` and capture its body until the next sibling job or end of block
  const regex = new RegExp(`(?:^|\\n)\\s*${jobName}:\\s*\\n([\\s\\S]*?)(?=\\n\\s{2}[a-zA-Z0-9_-]+:\\s*\\n|\\n\\s{0,2}[a-zA-Z0-9_-]+:|$)`);
  const match = workflowText.match(regex);
  return match ? match[1] : null;
}

/** 5. Helper rule: floating `:latest` image tags are prohibited in release and deploy workflows. */
function checkNoFloatingTags(filePath, workflowText) {
  if (/:latest\b|tag:\s*["']?latest["']?|--set\s+[^\n]*\.tag=latest\b/i.test(workflowText)) {
    problems.push(
      `${filePath}: uses floating ":latest" image tag — releases and deployments must target explicit version tags for reproducible rollbacks`,
    );
  }
}

function checkDeployGates() {
  if (!existsSync(DEPLOY_WORKFLOW)) {
    problems.push(`${DEPLOY_WORKFLOW}: file is missing`);
    return;
  }
  const deployText = readFileSync(DEPLOY_WORKFLOW, 'utf8');

  // 1. Environment declaration check & 4. needs:-gated check
  const deployJobBlock = getJobBlock(deployText, 'deploy');

  if (!deployJobBlock) {
    problems.push(`${DEPLOY_WORKFLOW}: missing "deploy:" job definition`);
  } else {
    if (!/^\s*environment:\s*/m.test(deployJobBlock)) {
      problems.push(
        `${DEPLOY_WORKFLOW}: "deploy" job does not declare "environment:" — human approval gates and environment protections will not be enforced`,
      );
    }

    if (!/^\s*needs:\s*/m.test(deployJobBlock)) {
      problems.push(
        `${DEPLOY_WORKFLOW}: "deploy" job is not "needs:"-gated — it runs unqualified without prior validation`,
      );
    }
  }

  // 2. Concurrency queueing check (cancel-in-progress: false)
  if (!/concurrency:\s*\n[\s\S]*?cancel-in-progress:\s*false/m.test(deployText)) {
    problems.push(
      `${DEPLOY_WORKFLOW}: concurrency must set "cancel-in-progress: false" — cancelled deploys leave partially applied releases in Kubernetes`,
    );
  }

  // Split workflow steps, strip comment lines and echo log lines, and collapse line continuations (`\`)
  const stepBlocks = deployText
    .split(/\n\s*-\s+(?:name|uses|run):/)
    .map((block) =>
      block
        .split('\n')
        .filter((line) => !/^\s*#/.test(line) && !/^\s*echo\b/.test(line))
        .join('\n')
        .replace(/\\\r?\n\s*/g, ' '),
    );

  // 3. Helm upgrade flag check (--atomic, --wait, --timeout)
  const helmBlocks = stepBlocks.filter((b) => /\bhelm\s+upgrade\b/.test(b));

  if (helmBlocks.length === 0) {
    problems.push(`${DEPLOY_WORKFLOW}: no "helm upgrade" commands found`);
  } else {
    for (const cmd of helmBlocks) {
      if (!/--atomic\b/.test(cmd)) {
        problems.push(
          `${DEPLOY_WORKFLOW}: "helm upgrade" missing "--atomic" — failed rollouts will remain in a broken state instead of reverting`,
        );
      }
      if (!/--wait\b/.test(cmd)) {
        problems.push(
          `${DEPLOY_WORKFLOW}: "helm upgrade" missing "--wait" — upgrade will return before pods reach ready status`,
        );
      }
      if (!/--timeout\s+[0-9]+[a-z0-9.]*/.test(cmd)) {
        problems.push(
          `${DEPLOY_WORKFLOW}: "helm upgrade" missing explicit "--timeout <duration>" — upgrade can hang indefinitely on stuck resources`,
        );
      }
    }
  }

  // 5. Floating tag check (deploy.yml)
  checkNoFloatingTags(DEPLOY_WORKFLOW, deployText);

  // 7. Hardcoded Deployment reference check (must use label selector, not hardcoded name)
  const hardcodedDepMatches = [...deployText.matchAll(/\bdeployment[s]?\/([a-zA-Z0-9_-]+)/g)];
  if (hardcodedDepMatches.length > 0) {
    for (const m of hardcodedDepMatches) {
      problems.push(
        `${DEPLOY_WORKFLOW}: contains hardcoded Deployment reference "${m[0]}" — Deployment names vary by rollout strategy (ADR-0075), so hardcoding names silently binds the pipeline to one strategy and breaks under blueGreen or canary`,
      );
    }
  }

  // 8. Pre-flight helm template step before helm upgrade (ignoring echo statements)
  const templateIdx = stepBlocks.findIndex((b) => /\bhelm\s+template\b/.test(b));
  const upgradeIdx = stepBlocks.findIndex((b) => /\bhelm\s+upgrade\b/.test(b));

  if (templateIdx === -1) {
    problems.push(
      `${DEPLOY_WORKFLOW}: missing "helm template" pre-flight step — dry-run rendering must validate composed strategy arguments before touching cluster credentials or state`,
    );
  } else if (upgradeIdx !== -1 && templateIdx > upgradeIdx) {
    problems.push(
      `${DEPLOY_WORKFLOW}: "helm template" pre-flight step must execute before "helm upgrade" — validation must occur prior to cluster operations`,
    );
  }

  // 9. Single strategy composition block check (no duplication between pre-flight and upgrade)
  const strategyCaseMatches = [...deployText.matchAll(/case\s+["']?\$STRATEGY["']?\s+in/g)];
  if (strategyCaseMatches.length === 0) {
    problems.push(
      `${DEPLOY_WORKFLOW}: missing strategy composition ("case \"$STRATEGY\" in")`,
    );
  } else if (strategyCaseMatches.length > 1) {
    problems.push(
      `${DEPLOY_WORKFLOW}: strategy composition ("case \"$STRATEGY\" in") appears ${strategyCaseMatches.length} times — argument composition must appear exactly once so pre-flight validation and helm upgrade cannot drift`,
    );
  }

  problems.push(...checkRollbackTarget(deployText));
}

/**
 * 10. The automatic rollback targets only the revision scripts/resolve-rollback-revision.mjs verified.
 *
 * `helm rollback` re-applies its target with no status check, so a target taken from anywhere else
 * — classically the newest `helm history` entry, which can be a failed release — re-applies a
 * configuration that already failed (Amendment 2026-10-11 of ADR-0076).
 *
 * The only accepted non-empty PREV_REV is exactly `$(sed -n 's/^rollback_revision=//p' "$X")`, where
 * "$X" is the file the resolver's stdout is redirected to and nothing else writes to it (by `>`,
 * `>>`, or `tee`). The step output the rollback reads must be published as exactly
 * `echo "prev_revision=$PREV_REV" >> "$GITHUB_OUTPUT"`.
 *
 * Returns the list of problems (empty when the wiring is intact).
 */
export function checkRollbackTarget(deployText) {
  const found = [];
  const fail = (why) => found.push(`${DEPLOY_WORKFLOW}: ${why}`);
  // Commands only: comment lines may name `helm rollback` in operator guidance.
  const commands = deployText
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));
  // ...and echo lines too, except when looking for writes (to the resolver's output file or
  // $GITHUB_OUTPUT) and for PREV_REV assignments chained after an echo.
  const isEcho = (line) => /^\s*echo\b/.test(line);
  const code = commands.filter((line) => !isEcho(line)).join('\n');

  const resolverOutputs = [
    ...code.matchAll(/\bnode\s+scripts\/resolve-rollback-revision\.mjs\b[^\n]*?\s>\s*"\$(\w+)"/g),
  ].map((m) => m[1]);
  if (resolverOutputs.length === 0) {
    fail('the rollback target is not resolved by scripts/resolve-rollback-revision.mjs (with stdout redirected to a file, `> "$FILE"`) — automatic rollback must target only the verified pre-upgrade deployed revision');
  }
  for (const file of resolverOutputs) {
    const allCommands = commands.join('\n');
    const redirects = allCommands.match(new RegExp(`(?:^|[^0-9&])>>?\\s*"\\$${file}"`, 'gm')) ?? [];
    // `tee [flags] [other files] "$X"` writes "$X" too.
    const tees = allCommands.match(new RegExp(`\\btee\\b[^\\n|;&>]*\\s"\\$${file}"`, 'g')) ?? [];
    const writes = [...redirects, ...tees];
    if (writes.length !== 1) {
      fail(`"$${file}" must be written only by scripts/resolve-rollback-revision.mjs, found ${writes.length} write(s)`);
    }
  }
  if (/history\s*\[\s*history\.length\s*-\s*1\s*\]|\bnode\s+-e\b/.test(code)) {
    fail('selects a revision with inline JavaScript (e.g. history[history.length - 1]) — the newest revision can be a failed release that helm rollback would re-apply');
  }
  const assignments = [...code.matchAll(/\bPREV_REV=([^\n]*)/g)].map((m) => m[1].trim());
  // Assignments chained after an echo (`echo "..."; PREV_REV=5`). Quoted text is blanked out first
  // so messages that mention PREV_REV or prev_revision= are not mistaken for assignments.
  for (const line of commands.filter(isEcho)) {
    const masked = line.replace(/"[^"]*"|'[^']*'/g, (quoted) => ' '.repeat(quoted.length));
    for (const m of masked.matchAll(/(?:;|&&|\|\|)\s*PREV_REV=/g)) {
      assignments.push(line.slice(m.index + m[0].length).trim());
    }
  }
  const allowed = (value) =>
    value === '""' ||
    resolverOutputs.some((file) => value === `$(sed -n 's/^rollback_revision=//p' "$${file}")`);
  if (assignments.length === 0 || assignments.some((value) => !allowed(value))) {
    fail(`PREV_REV must be empty or the rollback_revision read from the resolver's output file, found assignments: [${assignments.join(', ')}]`);
  }
  // The published step output is what the rollback step reads, so it must be exactly PREV_REV.
  const PUBLISH_PREV_REV = 'echo "prev_revision=$PREV_REV" >> "$GITHUB_OUTPUT"';
  const publishes = commands
    .filter((line) => /prev_revision=/.test(line) && /"\$GITHUB_OUTPUT"/.test(line))
    .map((line) => line.trim());
  if (publishes.length === 0 || publishes.some((line) => line !== PUBLISH_PREV_REV)) {
    fail(`every prev_revision output must be published exactly as \`${PUBLISH_PREV_REV}\`, found: [${publishes.join(' | ')}]`);
  }
  const rollbacks = [...code.matchAll(/\bhelm\s+rollback\b[^\n]*/g)].map((m) => m[0]);
  if (rollbacks.length === 0 || rollbacks.some((cmd) => !/^helm\s+rollback\s+gambit\s+"\$PREV_REV"\s/.test(cmd))) {
    fail(`every helm rollback must target "$PREV_REV" (the verified revision), found: [${rollbacks.join(' | ')}]`);
  }
  if (!/^\s*PREV_REV:\s*\$\{\{\s*steps\.pre_upgrade\.outputs\.prev_revision\s*\}\}\s*$/m.test(code)) {
    fail('the rollback step must read PREV_REV from steps.pre_upgrade.outputs.prev_revision');
  }
  return found;
}

function checkReleaseGates() {
  if (!existsSync(RELEASE_WORKFLOW)) {
    problems.push(`${RELEASE_WORKFLOW}: file is missing`);
    return;
  }
  const releaseText = readFileSync(RELEASE_WORKFLOW, 'utf8');

  // 5. Floating tag check (release.yml)
  checkNoFloatingTags(RELEASE_WORKFLOW, releaseText);
}

function checkImageRepositoryMatch() {
  if (!existsSync(RELEASE_WORKFLOW) || !existsSync(CHART_VALUES)) {
    return;
  }
  const releaseText = readFileSync(RELEASE_WORKFLOW, 'utf8');
  const valuesText = readFileSync(CHART_VALUES, 'utf8');

  // Extract repositories published in release.yml
  const releaseRepos = new Set(
    [...releaseText.matchAll(/ghcr\.io\/[a-zA-Z0-9_-]+\/gambit-(api|gateway|web)/g)].map((m) => m[0]),
  );

  // Extract repositories referenced in values.yaml
  const valuesRepos = new Set(
    [...valuesText.matchAll(/repository:\s*(ghcr\.io\/[a-zA-Z0-9_-]+\/gambit-(api|gateway|web))/g)].map((m) => m[1]),
  );

  const releaseList = [...releaseRepos].sort();
  const valuesList = [...valuesRepos].sort();

  if (releaseList.length !== 3) {
    problems.push(
      `${RELEASE_WORKFLOW}: expected 3 published image repositories (api, gateway, web), found ${releaseList.length}: [${releaseList.join(', ')}]`,
    );
  }

  if (valuesList.length !== 3) {
    problems.push(
      `${CHART_VALUES}: expected 3 image repositories (api, gateway, web), found ${valuesList.length}: [${valuesList.join(', ')}]`,
    );
  }

  const releaseStr = releaseList.join(',');
  const valuesStr = valuesList.join(',');

  if (releaseStr !== valuesStr) {
    problems.push(
      `Image repository drift between release workflow and chart values:\n` +
        `  - release.yml publishes: [${releaseList.join(', ')}]\n` +
        `  - values.yaml references: [${valuesList.join(', ')}]\n` +
        `  Helm will fail to pull images or silently deploy from the wrong repository.`,
    );
  }
}

function main() {
  checkDeployGates();
  checkReleaseGates();
  checkImageRepositoryMatch();

  console.log('');
  console.log('=== Deployment gate check ===');
  console.log('');

  if (problems.length > 0) {
    console.log('  ✗ Problems:');
    for (const p of problems) {
      console.log(`    - ${p}`);
    }
    console.log('');
    console.log(`=== Results: ${problems.length} problem(s) found ===`);
    console.log('Deployment gate invariants violated. Fix the workflow configuration.');
    process.exit(1);
  }

  console.log('  ✓ deploy.yml declares human-approval environment gate');
  console.log('  ✓ deploy.yml concurrency sets cancel-in-progress: false');
  console.log('  ✓ helm upgrade commands use --atomic, --wait, and explicit --timeout');
  console.log('  ✓ deploy job is needs:-gated');
  console.log('  ✓ no floating :latest image tags in release or deploy workflows');
  console.log('  ✓ release workflow image repositories match chart values.yaml exactly');
  console.log('  ✓ deploy.yml avoids hardcoded Deployment names (strategy-independent)');
  console.log('  ✓ deploy.yml includes a helm template pre-flight check before helm upgrade');
  console.log('  ✓ deploy.yml strategy composition appears exactly once (single-source)');
  console.log('  ✓ deploy.yml rolls back only to the revision resolve-rollback-revision.mjs verified');
  console.log('');
  console.log('=== Results: all deployment gates verified ===');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
