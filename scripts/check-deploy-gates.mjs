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
 *  Gates 10 and 11 pin each evidence temp file ("$RESOLVED", "$EXISTENCE_FILE", "$INV_VERDICT",
 *  "$MARKER_FILE") to a positive allowlist of references (checkEvidenceReferences): its mktemp, its
 *  one producer — an exact whole line, arguments included — its sed reads — each an exact
 *  (variable, key) pair, once (EVIDENCE_READS) — and its publication; any other reference fails the
 *  gate. GITHUB_OUTPUT is pinned the same way (checkOutputPublications): every reference to it, in
 *  any spelling, must be one of today's exact publication lines (OUTPUT_PUBLICATIONS), each once,
 *  so no later line can overwrite a published value. The classifiers' inputs (LIST_ARGS and the
 *  exit codes STATUS_RC, LIST_RC, INV_API_RC, INV_LABEL_RC, INV_ANNOTATION_RC) are pinned to exact
 *  write sites (PRODUCER_WRITES, checkDecisionWrites), and each exit code's `X=0` reset must
 *  directly precede its exact capture line (checkResetPrecedesCapture). The raw payload files
 *  the classifiers read ("$STATUS_ERR", "$LIST_OUT", "$INV_API", "$INV_LABELLED",
 *  "$INV_ANNOTATED") are pinned by checkEvidenceReferences to their mktemp and a fixed table of
 *  exact lines (PAYLOAD_REFERENCES: capture, classifier invocation, fixed reads), each once, so no
 *  line can truncate, rebind or rewrite a capture before its classifier reads it. The decision
 *  scalars read from those files (PREV_REV, SNAPSHOT_NEWEST, RELEASE_EXISTENCE, RELEASE_EXISTS,
 *  INVENTORY, DEPLOY_MARKER) are pinned the same way to a positive allowlist of write sites
 *  (checkDecisionWrites): any assignment, builtin (`read`, `printf -v`, `declare`, `unset`, ...),
 *  assigning expansion or eval string naming them outside their allowed lines fails the gate.
 *  These are accidental-regression guards; deliberate obfuscation is out of their contract.
 *  11. Release existence is never derived from a bare `helm status` exit code: RELEASE_EXISTS=false is
 *      set only by the confirmed-absence arm of scripts/release-existence.mjs's classification (status
 *      not-found AND an empty `helm list --all`), and the rollback step uninstalls only behind a fresh
 *      `helm history` re-check showing exactly revision 1; rollback requires RELEASE_EXISTS = "true".
 *      Recovery safety (ADR-0076 amendment 2026-10-12): the rollback step's `if:` is exactly
 *      `failure() && steps.smoke_check.outcome == 'failure'`; the helm upgrade records this run's
 *      marker (`--description "$DEPLOY_MARKER"`) and both the uninstall and the rollback sit behind
 *      a `helm history` re-read and scripts/recovery-ownership.mjs's ownership check; confirmed
 *      absence becomes RELEASE_EXISTS=false only after the namespace inventory found nothing; and
 *      every `helm history` asks for the explicit `--max 256` window.
 *
 * Run: node scripts/check-deploy-gates.mjs
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { BASE_INVENTORY_KINDS, EXTERNAL_SECRET_RESOURCE } from './lib/recovery-ownership.mjs';

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
  problems.push(...checkReleaseExistence(deployText));
}

/**
 * Positive reference allowlist for the temp files whose contents become trusted evidence (gates 10
 * and 11): "$RESOLVED" (the verified rollback target), "$EXISTENCE_FILE" (the release existence
 * verdict), "$INV_VERDICT" (the orphan inventory verdict) and "$MARKER_FILE" (the run marker).
 *
 * Contract: every reference to the protected variable in the workflow text must be a whole logical
 * line matching one of the variable's allowed forms (`forms`), each line naming the variable exactly
 * once, and every form marked `once` must appear exactly once. Any other reference fails the gate,
 * whatever it is: a write by any redirection or tee, a read, an alias (`X=$RESOLVED`), cp / mv /
 * sed -i, an fd opened with exec, eval, an indirect name (`v=RESOLVED; ... ${!v}`, `declare`,
 * `printf -v`) or merely a different quoting. A reference is any occurrence of the NAME as an
 * identifier token (`(?<![A-Za-z0-9_])NAME(?![A-Za-z0-9_])`), with or without `$`, braces or quotes,
 * so a bare name counts too, while `$RESOLVED_OLD` is another variable.
 *
 * Guarantee: within the workflow text, nothing refers to an evidence file other than its mktemp,
 * its one producer (whose stdout is redirected to it), its sed reads and (for "$RESOLVED") its
 * publication to $GITHUB_OUTPUT. In particular no second writer can name it. Each sed read is one
 * exact `VAR=$(sed -n 's/^key=//p' "$NAME")` line for an allowed (variable, key) pair, appearing
 * exactly once (EVIDENCE_READS; the "$RESOLVED" echo read is pinned to key rollback_evidence), so a
 * read cannot assign into another variable (`GITHUB_OUTPUT=`, `PATH=`, ...) or read another key.
 *
 * Normalisation, as bash does it: CR is stripped and backslash-newline is removed entirely (not
 * replaced by a space), so a name split across a continuation is spliced back together. Because
 * YAML strips the run block's indentation before bash sees the script, the check runs twice — once
 * keeping the whitespace after a continuation and once removing it — and a line fails if it fails
 * either way. Comment lines are dropped unless they continue the previous line; text after an inline
 * `#` is not stripped, so a mention in an inline comment or in a quoted literal fails (fail-closed:
 * without a shell parser quoting cannot be judged, and a false positive only fails the gate).
 *
 * Out of scope: writing the same temp path through a variable that never names the protected one
 * (infeasible by construction, as the path comes from mktemp and is never copied elsewhere — any
 * such copy is itself a reference), a name assembled from pieces at run time (`x=RESOL; y=${x}VED`),
 * a literal name split into quoted segments and resolved by a nameref or other builtin
 * (`declare -n ref=RES""OLVED`), YAML-level escapes inside quoted scalars, and anything outside this
 * workflow step (other steps'
 * processes, actions, the runner). This is still a static check, not a shell parser: the behavioural
 * snapshot tests remain the primary guard.
 *
 * @param {string} workflowText The workflow text (comments included; they are dropped here).
 * @param {string} name The protected variable's name.
 * @param {{ label: string, re: RegExp, once?: boolean }[]} forms The allowed whole-line forms.
 * @returns {string[]} Problems (empty when every reference is an allowed form).
 */
export function checkEvidenceReferences(workflowText, name, forms) {
  const variants = logicalLineVariants(workflowText);
  const token = identifierToken(name);
  const offending = new Set();
  const badCounts = new Set();
  for (const lines of variants) {
    const refs = lines.filter((line) => (line.match(token) ?? []).length > 0);
    for (const line of refs) {
      if (line.match(token).length !== 1 || !forms.some((form) => form.re.test(line))) offending.add(line);
    }
    for (const form of forms.filter((f) => f.once)) {
      const n = refs.filter((line) => line.match(token).length === 1 && form.re.test(line)).length;
      if (n !== 1) badCounts.add(`\`${form.label}\` must appear exactly once, found ${n}`);
    }
  }
  const allowed = `"$${name}" may only be referenced in its allowed forms [${forms.map((f) => f.label).join(' | ')}]`;
  const found = [];
  if (offending.size > 0) {
    found.push(`${allowed}; offending line(s): [${[...offending].join(' | ')}]`);
  }
  for (const why of badCounts) found.push(`${allowed}; ${why}`);
  return found;
}

/**
 * The workflow's logical lines as bash reads them, in the two variants checkEvidenceReferences
 * describes: CR stripped, comment lines dropped unless they continue the previous line,
 * backslash-newline removed (keeping, then removing, the whitespace after it), whitespace collapsed.
 *
 * @param {string} workflowText
 * @returns {string[][]}
 */
function logicalLineVariants(workflowText) {
  const raw = workflowText.replace(/\r/g, '').split('\n');
  // A comment line is dropped unless the line before it ends with a continuation backslash.
  const kept = raw.filter((line, i) => !/^\s*#/.test(line) || (i > 0 && /\\$/.test(raw[i - 1]))).join('\n');
  return [kept.replace(/\\\n/g, ''), kept.replace(/\\\n[ \t]*/g, '')]
    .map((text) => text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()));
}

/** NAME as a whole identifier token, with or without `$`, braces or quotes around it. */
const identifierToken = (name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'g');

/**
 * Whether `line` writes (or may write) the variable `name`: it has a write site of it, i.e.
 * (a) a bare occurrence of the identifier token — one not immediately preceded by `$`, `${` or
 *     `${!` (an assignment, `read`, `printf -v`, `declare` / `local` / `export` / `typeset` /
 *     `readonly`, `let`, `((...))`, `unset`, `mapfile`, a nameref target, an `eval` string ...), or
 * (b) an assigning expansion: `${NAME=`, `${NAME:=` or a subscript `${NAME[`.
 * The line is also inspected with every `'`, `"` and `\` removed, so a name spliced by quoting
 * (`PREV""_REV`) or escaped (`\PREV_REV`) is a write site too; a site in either spelling counts.
 */
function hasWriteSite(line, name) {
  const token = identifierToken(name);
  return [line, line.replace(/['"\\]/g, '')].some((text) =>
    [...text.matchAll(token)].some((m) => {
      const before = text.slice(0, m.index);
      const after = text.slice(m.index + name.length);
      if (/\$\{!?$/.test(before)) return /^(?::?=|\[)/.test(after);
      return !/\$$/.test(before);
    }));
}

/**
 * Positive write-site allowlist for the decision scalars read from the evidence files (gates 10 and
 * 11): PREV_REV, SNAPSHOT_NEWEST, RELEASE_EXISTENCE, RELEASE_EXISTS, INVENTORY and DEPLOY_MARKER.
 * checkEvidenceReferences keeps every second writer away from the files, but a shell builtin can
 * rewrite the variable after its verified read without naming any file (`read -r PREV_REV <<< 5`,
 * `printf -v INVENTORY %s empty`, `: "${PREV_REV:=5}"`, `unset RELEASE_EXISTENCE`).
 *
 * Contract: every logical line holding a write site of NAME (hasWriteSite: a bare token, or
 * `${NAME=` / `${NAME:=` / `${NAME[`) must be, as a whole, one of NAME's allowed lines, and each
 * allowed line must appear exactly its allowed number of times. Lines and their normalisation
 * (comments, CR, backslash-newline in both variants, whitespace) are those of
 * checkEvidenceReferences; matching is case-sensitive, so the output key `prev_revision=` is another
 * token. Reads — `$NAME`, `"$NAME"`, `${NAME}`, `${NAME:-...}`, `${NAME:+...}`, `${!NAME}` — are
 * unrestricted. Fail-closed: a bare mention in a quoted literal or an inline comment, an arithmetic
 * read (`$(( NAME + 1 ))`) or a length `${#NAME}` also counts as a write site.
 *
 * Out of scope: a name composed at run time and then reached by indirection or eval of the composed
 * string (`v=PREV; declare -n r=${v}_REV`, `eval "${v}_REV=5"`), a name spelled with escapes or with
 * ANSI-C / locale quoting (`$'\x50'REV_REV`, `$'PREV'_REV`, `$"PREV"_REV`; these are deliberate
 * obfuscation, which the owner accepted as outside this regression guard's contract),
 * YAML-level escapes inside quoted scalars, and anything outside this workflow
 * (other steps' processes, actions, the runner). This is a static check, not a shell parser: the
 * behavioural snapshot tests remain the primary guard.
 *
 * The same contract pins the classifiers' producer inputs (PRODUCER_WRITES: LIST_ARGS, STATUS_RC,
 * LIST_RC, INV_API_RC, INV_LABEL_RC, INV_ANNOTATION_RC), reported with `kind` "producer input";
 * checkResetPrecedesCapture adds the order of each exit code's reset and capture.
 *
 * @param {string} workflowText The workflow text (comments included; they are dropped here).
 * @param {string} name The decision variable's name.
 * @param {{ line: string, count: number }[]} forms The allowed whole lines and their exact counts.
 * @param {string} [kind] How the variable is named in problems.
 * @returns {string[]} Problems (empty when every write site is an allowed line, counted exactly).
 */
export function checkDecisionWrites(workflowText, name, forms, kind = 'decision variable') {
  const offending = new Set();
  const badCounts = new Set();
  for (const lines of logicalLineVariants(workflowText)) {
    const writes = lines.filter((line) => hasWriteSite(line, name));
    for (const line of writes) {
      if (!forms.some((form) => form.line === line)) offending.add(line);
    }
    for (const form of forms) {
      const n = writes.filter((line) => line === form.line).length;
      if (n !== form.count) badCounts.add(`\`${form.line}\` must appear exactly ${form.count} time(s), found ${n}`);
    }
  }
  const allowed = `${kind} ${name} may only be written in its allowed forms [${forms.map((f) => `${f.line} (x${f.count})`).join(' | ')}]`;
  const found = [];
  if (offending.size > 0) found.push(`${allowed}; offending write site line(s): [${[...offending].join(' | ')}]`);
  for (const why of badCounts) found.push(`${allowed}; ${why}`);
  return found;
}

/**
 * Order of an exit code's reset and capture: checkDecisionWrites counts `X=0` and the capture line
 * `... || X=$?` but not their order, and a reset moved after the capture (or a second reset later)
 * erases a failed query's exit code, so the classifier reads a failed `kubectl` / `helm` query as
 * success (`unknown` becomes `empty`, and orphaned Helm-owned objects get adopted).
 *
 * Contract: in each logical-line variant of checkDecisionWrites (comments dropped, continuations
 * joined, whitespace collapsed), every line that is exactly `NAME=0` must be immediately followed —
 * blank lines aside, nothing else — by exactly `capture`. With checkDecisionWrites' counts (one
 * reset, one capture) this pins the pair to adjacent lines in that order. Same scope as
 * checkDecisionWrites: an accidental-regression guard; deliberate obfuscation is out of scope.
 *
 * @param {string} workflowText The workflow text (comments included; they are dropped here).
 * @param {string} name The exit-code variable.
 * @param {string} capture Its exact capture line.
 * @returns {string[]} Problems (empty when every reset directly precedes the capture).
 */
export function checkResetPrecedesCapture(workflowText, name, capture) {
  const found = new Set();
  const reset = `${name}=0`;
  for (const lines of logicalLineVariants(workflowText)) {
    lines.forEach((line, i) => {
      if (line !== reset) return;
      const next = lines.slice(i + 1).find((l) => l !== '');
      if (next !== capture) {
        found.add(`producer input ${name}: the reset \`${reset}\` must directly precede its capture \`${capture}\` (the next code line, blank lines aside); found: \`${next ?? '<end of file>'}\``);
      }
    });
  }
  return [...found];
}

/** The allowed write sites of each decision variable (checkDecisionWrites), exactly as in deploy.yml. */
const DECISION_WRITES = {
  PREV_REV: [
    { line: 'PREV_REV=""', count: 1 },
    { line: `PREV_REV=$(sed -n 's/^rollback_revision=//p' "$RESOLVED")`, count: 1 },
    { line: 'PREV_REV: ${{ steps.pre_upgrade.outputs.prev_revision }}', count: 1 },
  ],
  SNAPSHOT_NEWEST: [
    { line: 'SNAPSHOT_NEWEST=""', count: 1 },
    { line: 'SNAPSHOT_NEWEST=0', count: 1 },
    { line: `SNAPSHOT_NEWEST=$(sed -n 's/^rollback_newest_revision=//p' "$RESOLVED")`, count: 1 },
    { line: 'SNAPSHOT_NEWEST: ${{ steps.pre_upgrade.outputs.snapshot_newest_revision }}', count: 1 },
  ],
  RELEASE_EXISTENCE: [
    { line: 'RELEASE_EXISTENCE=unknown', count: 1 },
    { line: `RELEASE_EXISTENCE=$(sed -n 's/^release_existence=//p' "$EXISTENCE_FILE")`, count: 1 },
  ],
  RELEASE_EXISTS: [
    { line: 'RELEASE_EXISTS=""', count: 1 },
    { line: 'exists) RELEASE_EXISTS=true ;;', count: 1 },
    { line: 'RELEASE_EXISTS=false', count: 1 },
    { line: 'RELEASE_EXISTS: ${{ steps.pre_upgrade.outputs.release_exists }}', count: 1 },
  ],
  INVENTORY: [
    { line: 'INVENTORY=unknown', count: 1 },
    { line: `INVENTORY=$(sed -n 's/^orphan_inventory=//p' "$INV_VERDICT")`, count: 1 },
  ],
  DEPLOY_MARKER: [
    { line: `DEPLOY_MARKER=$(sed -n 's/^deploy_marker=//p' "$MARKER_FILE")`, count: 1 },
    // The upgrade step's and the rollback step's env bindings (each step's one binding is checked
    // by checkRecoveryWiring).
    { line: 'DEPLOY_MARKER: ${{ steps.pre_upgrade.outputs.deploy_marker }}', count: 2 },
  ],
};

/** Shared allowed forms: the mktemp that creates the file, and its exact `VAR=$(sed -n 's/^key=//p' "$NAME")` reads. */
const evidenceFile = (name) => ({ label: `${name}=$(mktemp)`, re: new RegExp(`^${name}=\\$\\(mktemp\\)$`), once: true });
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The exact reads of evidence file NAME: one whole-line form per allowed (variable, key) pair, each
 * appearing exactly once. A read into any other variable (`GITHUB_OUTPUT=`, `PATH=`, ...) or of any
 * other key is an offending reference.
 */
const sedReads = (name, pairs) => pairs.map(([variable, key]) => {
  const line = `${variable}=$(sed -n 's/^${key}=//p' "$${name}")`;
  return { label: line, re: new RegExp(`^${escapeRegExp(line)}$`), once: true };
});
/** The (variable, key) pairs deploy.yml reads from each evidence file, exactly as it does today. */
const EVIDENCE_READS = {
  RESOLVED: [['PREV_REV', 'rollback_revision'], ['SNAPSHOT_NEWEST', 'rollback_newest_revision']],
  EXISTENCE_FILE: [['RELEASE_EXISTENCE', 'release_existence'], ['EXISTENCE_REASON', 'release_existence_reason']],
  INV_VERDICT: [['INVENTORY', 'orphan_inventory'], ['INV_OBJECTS', 'orphan_inventory_objects'], ['INV_REASON', 'orphan_inventory_reason']],
  MARKER_FILE: [['DEPLOY_MARKER', 'deploy_marker']],
};
/**
 * The producer invocations, each one exact logical line (continuations joined) as in deploy.yml
 * today. A changed argument (`--status-stderr "$LIST_ERR"`, a dropped `"${LIST_ARGS[@]}"`) is a
 * different line and so an offending reference of the evidence file it writes.
 */
const STATUS_CMD = 'helm status gambit > /dev/null 2> "$STATUS_ERR" || STATUS_RC=$?';
const LIST_CMD = `helm list --all --filter '^gambit$' -o json > "$LIST_OUT" 2> "$LIST_ERR" || LIST_RC=$?`;
const DISCOVERY = 'kubectl api-resources --api-group=external-secrets.io -o name > "$INV_API" 2> "$INV_ERR" || INV_API_RC=$?';
const LABELLED = 'kubectl get "$INV_KINDS" -l app.kubernetes.io/instance=gambit -o name > "$INV_LABELLED" 2>> "$INV_ERR" || INV_LABEL_RC=$?';
const ANNOTATED = `kubectl get "$INV_KINDS" -o jsonpath='{range .items[*]}{.kind}/{.metadata.name}{"\\t"}{.metadata.annotations.meta\\.helm\\.sh/release-name}{"\\n"}{end}' > "$INV_ANNOTATED" 2>> "$INV_ERR" || INV_ANNOTATION_RC=$?`;
const LIST_ARGS_BUILD = 'LIST_ARGS=(--list-exit "$LIST_RC" --list-stdout "$LIST_OUT")';
const EXISTENCE_CLASSIFIER = 'if node scripts/release-existence.mjs classify --release gambit --status-exit "$STATUS_RC" ' +
  '--status-stderr "$STATUS_ERR" "${LIST_ARGS[@]}" > "$EXISTENCE_FILE" 2>> "$LIST_ERR"; then';
const INVENTORY_CLASSIFIER = 'if node scripts/recovery-ownership.mjs inventory --release gambit --kinds "$INV_KINDS" ' +
  '--api-exit "$INV_API_RC" --api-stdout "$INV_API" --label-exit "$INV_LABEL_RC" --label-stdout "$INV_LABELLED" ' +
  '--annotation-exit "$INV_ANNOTATION_RC" --annotation-stdout "$INV_ANNOTATED" > "$INV_VERDICT" 2>> "$INV_ERR"; then';
/** An exact whole-line form for checkEvidenceReferences. */
const exactLine = (line) => ({ label: line, re: new RegExp(`^${escapeRegExp(line)}$`), once: true });

/**
 * The exit codes the two classifiers are given, each with the exact capture line that sets it
 * (`... || X=$?`). Its `X=0` reset must directly precede that capture (checkResetPrecedesCapture).
 */
const EXIT_CODE_CAPTURES = {
  STATUS_RC: STATUS_CMD,
  LIST_RC: LIST_CMD,
  INV_API_RC: DISCOVERY,
  INV_LABEL_RC: LABELLED,
  INV_ANNOTATION_RC: ANNOTATED,
};

/** The `*)` arm's diagnostic read of "$STATUS_ERR", whitespace-collapsed as logicalLineVariants does. */
const STATUS_ERR_READ = String.raw`STATUS_ERR_LINE=$(head -c 500 "$STATUS_ERR" | tr '\r\n' ' ' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')`;
/** The ExternalSecret discovery conditional, the one read of "$INV_API" besides the classifier. */
const DISCOVERY_CONDITIONAL = `if [ "$INV_API_RC" = 0 ] && grep -qx 'externalsecrets.external-secrets.io' "$INV_API"; then`;

/**
 * The raw payload files the two classifiers read, each pinned (checkEvidenceReferences) to its
 * mktemp and these exact whole lines, each once: its capture, its classifier invocation and the
 * workflow's own fixed reads. A fixed table, never derived from the workflow being checked. Without
 * it a truncation (`: > "$INV_ANNOTATED"`), a second `X=$(mktemp)` or a rewrite
 * (`printf '[]\n' > "$LIST_OUT"`) after the capture empties the evidence: an annotation-only or
 * label-only orphan then classifies `empty` instead of `occupied` (adoption, then deletion), and a
 * contradictory `helm list` becomes `absent` instead of `unknown`. LIST_ERR, INV_ERR and the
 * HISTORY_* / RB_HISTORY* files are out of scope.
 */
const PAYLOAD_REFERENCES = {
  STATUS_ERR: [STATUS_CMD, EXISTENCE_CLASSIFIER, STATUS_ERR_READ],
  LIST_OUT: [LIST_CMD, LIST_ARGS_BUILD],
  INV_API: [DISCOVERY, DISCOVERY_CONDITIONAL, INVENTORY_CLASSIFIER],
  INV_LABELLED: [LABELLED, INVENTORY_CLASSIFIER],
  INV_ANNOTATED: [ANNOTATED, INVENTORY_CLASSIFIER],
};

/**
 * The allowed write sites of the classifiers' inputs (checkDecisionWrites, kind "producer input"):
 * the exit codes they are given — each its `X=0` reset and its capture line, once each — and the
 * array that carries the `helm list` evidence. `LIST_ARGS` in `"${LIST_ARGS[@]}"` is a subscript,
 * so the classifier line is one of its sites too.
 */
const PRODUCER_WRITES = {
  ...Object.fromEntries(Object.entries(EXIT_CODE_CAPTURES).map(([name, capture]) => [name, [
    { line: `${name}=0`, count: 1 },
    { line: capture, count: 1 },
  ]])),
  LIST_ARGS: [
    { line: 'LIST_ARGS=()', count: 1 },
    { line: LIST_ARGS_BUILD, count: 1 },
    { line: EXISTENCE_CLASSIFIER, count: 1 },
  ],
};

/**
 * Every line of deploy.yml that may name GITHUB_OUTPUT, exactly as today, each once
 * (checkOutputPublications).
 */
const OUTPUT_PUBLICATIONS = [
  'echo "version=$VERSION" >> "$GITHUB_OUTPUT"',
  'echo "environment=$ENV" >> "$GITHUB_OUTPUT"',
  'echo "strategy=$STRATEGY" >> "$GITHUB_OUTPUT"',
  'echo "canary_weight=$CANARY_WEIGHT" >> "$GITHUB_OUTPUT"',
  'echo "active_color=$ACTIVE_COLOR" >> "$GITHUB_OUTPUT"',
  'echo "target_color=$TARGET_COLOR" >> "$GITHUB_OUTPUT"',
  'cat "$RESOLVED" >> "$GITHUB_OUTPUT"',
  `printf '%s\\n' "$DEPLOYED_TAGS" >> "$GITHUB_OUTPUT"`,
  'echo "release_exists=$RELEASE_EXISTS" >> "$GITHUB_OUTPUT"',
  'echo "prev_revision=$PREV_REV" >> "$GITHUB_OUTPUT"',
  'echo "rollback_refusal=$ROLLBACK_REFUSAL" >> "$GITHUB_OUTPUT"',
  'echo "deploy_marker=$DEPLOY_MARKER" >> "$GITHUB_OUTPUT"',
  'echo "snapshot_newest_revision=$SNAPSHOT_NEWEST" >> "$GITHUB_OUTPUT"',
];

/**
 * Gate 10, step outputs: $GITHUB_OUTPUT is last-value-wins, so any further write to it — a second
 * `prev_revision=` or `release_exists=`, another file copied into it — can replace the verified
 * rollback target or the existence verdict the rollback step reads. Every reference to the
 * GITHUB_OUTPUT token, in any spelling (`$GITHUB_OUTPUT`, `${GITHUB_OUTPUT}`, quoted or not, the bare
 * name), must be one of OUTPUT_PUBLICATIONS, each exactly once; the matching and normalisation are
 * checkEvidenceReferences'. Out of scope as there: deliberate obfuscation of the name.
 *
 * @param {string} deployText
 * @returns {string[]} Problems (empty when every reference is an allowed publication).
 */
export function checkOutputPublications(deployText) {
  return checkEvidenceReferences(deployText, 'GITHUB_OUTPUT', OUTPUT_PUBLICATIONS.map(exactLine))
    .map((why) => `${DEPLOY_WORKFLOW}: ${why}`);
}

/**
 * The stdout redirections (`>`, `>>`, `>|`, `>&N`, `1>`, `&>`) of the simple command that starts
 * `command`, i.e. up to the first unquoted `|`, `||`, `&&` or `;`, whitespace-normalised.
 */
function stdoutRedirects(command) {
  const masked = command.replace(/"[^"]*"|'[^']*'/g, (quoted) => '_'.repeat(quoted.length));
  const end = masked.search(/(?<!>)\||;|&&/);
  const simple = end === -1 ? command : command.slice(0, end);
  return [...simple.matchAll(/(?<![0-9&>])(?:1|&)?>[>|&]?\s*(?:"[^"]*"|[^\s;&|<>]+)/g)]
    .map((m) => m[0].replace(/\s+/g, ' '));
}

/**
 * 10. The automatic rollback targets only the revision scripts/resolve-rollback-revision.mjs verified.
 *
 * `helm rollback` re-applies its target with no status check, so a target taken from anywhere else
 * — classically the newest `helm history` entry, which can be a failed release — re-applies a
 * configuration that already failed (Amendment 2026-10-11 of ADR-0076).
 *
 * The only accepted non-empty PREV_REV is exactly `$(sed -n 's/^rollback_revision=//p' "$X")`, where
 * "$X" is the file the resolver's stdout is redirected to. "$RESOLVED" may be referenced only as
 * `RESOLVED=$(mktemp)`, the resolver's `> "$RESOLVED"` (once), exactly the reads
 * `PREV_REV=$(sed -n 's/^rollback_revision=//p' "$RESOLVED")` and
 * `SNAPSHOT_NEWEST=$(sed -n 's/^rollback_newest_revision=//p' "$RESOLVED")` (once each), one echo
 * whose `$(...)` reads key rollback_evidence (once) and `cat "$RESOLVED" >> "$GITHUB_OUTPUT"`
 * (once); see checkEvidenceReferences. The step output the rollback reads must be published as exactly
 * `echo "prev_revision=$PREV_REV" >> "$GITHUB_OUTPUT"`, and no other line may name GITHUB_OUTPUT
 * (checkOutputPublications), so nothing published later can replace it.
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
  // The resolver's output file is referenced only in its allowed forms (see checkEvidenceReferences).
  for (const why of checkEvidenceReferences(deployText, 'RESOLVED', [
    evidenceFile('RESOLVED'),
    {
      label: 'elif node scripts/resolve-rollback-revision.mjs < "$HISTORY_FILE" > "$RESOLVED" 2> "$HISTORY_ERR"; then',
      re: /^(?:if|elif) node scripts\/resolve-rollback-revision\.mjs < "\$HISTORY_FILE" > "\$RESOLVED" 2> "\$HISTORY_ERR"; then$/,
      once: true,
    },
    ...sedReads('RESOLVED', EVIDENCE_READS.RESOLVED),
    {
      label: `echo "...$(sed -n 's/^rollback_evidence=//p' "$RESOLVED")..."`,
      re: /^echo "(?:[^"`\\$]|\$[A-Z_][A-Z0-9_]*)*\$\(sed -n 's\/\^rollback_evidence=\/\/p' "\$RESOLVED"\)(?:[^"`\\$]|\$[A-Z_][A-Z0-9_]*)*"$/,
      once: true,
    },
    { label: 'cat "$RESOLVED" >> "$GITHUB_OUTPUT"', re: /^cat "\$RESOLVED" >> "\$GITHUB_OUTPUT"$/, once: true },
  ])) {
    fail(why);
  }
  // ...and PREV_REV, once read from it, is written nowhere else (see checkDecisionWrites).
  for (const why of checkDecisionWrites(deployText, 'PREV_REV', DECISION_WRITES.PREV_REV)) fail(why);
  // ...and nothing else is published to $GITHUB_OUTPUT, in any spelling (checkOutputPublications).
  found.push(...checkOutputPublications(deployText));
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

/**
 * 11. Release existence is established from evidence, and only confirmed absence can lead to an uninstall.
 *
 * A failed initial install is uninstalled, so treating any `helm status` failure (unreachable cluster,
 * expired credentials, RBAC, timeout) as "no release" uninstalls a live release (owner decision
 * 2026-10-11, ADR-0076). Asserted on the command lines (comments and echo lines excluded):
 * - the only `helm status` is the evidence-capturing STATUS_CMD (no `>/dev/null 2>&1`, no `if helm status`);
 * - the list corroboration LIST_CMD (the only `helm list`) and the scripts/release-existence.mjs
 *   classifier are both present; the classifier is exactly EXISTENCE_CLASSIFIER and its inputs
 *   STATUS_RC, LIST_RC and LIST_ARGS — like the inventory's INV_API_RC, INV_LABEL_RC and
 *   INV_ANNOTATION_RC — are written only at their PRODUCER_WRITES sites, and each exit code's
 *   `X=0` reset directly precedes its capture line (checkResetPrecedesCapture);
 * - the raw payload files both classifiers read (STATUS_ERR, LIST_OUT, INV_API, INV_LABELLED,
 *   INV_ANNOTATED) are referenced only by their mktemp and their PAYLOAD_REFERENCES lines, each
 *   once (checkEvidenceReferences; same accidental-regression contract);
 * - RELEASE_EXISTS is assigned exactly three times: `RELEASE_EXISTS=""`, the `exists)` arm and the
 *   `absent)` arm of `case "$RELEASE_EXISTENCE" in`, whose value is read only from "$EXISTENCE_FILE", the
 *   file the classifier's stdout is redirected to (`> "$EXISTENCE_FILE"`) and that is referenced only
 *   by its mktemp, that classifier invocation and sed reads (checkEvidenceReferences, echo lines included);
 * - that case has only the `exists)`, `absent)` and `*)` arms, and the `*)` arm (unknown existence) ends
 *   with `exit 1` before `;;`;
 * - release_exists is published only as `echo "release_exists=$RELEASE_EXISTS" >> "$GITHUB_OUTPUT"`, and the
 *   rollback step binds exactly `RELEASE_EXISTS: ${{ steps.pre_upgrade.outputs.release_exists }}`;
 * - the one `helm uninstall` sits in the `if [ "$RELEASE_EXISTS" = "false" ]` branch of the rollback step,
 *   after a `helm history` re-check and the only-initial-revision check, each failing with `exit 1`;
 * - the one `helm rollback` sits in a branch that requires RELEASE_EXISTS = "true".
 *
 * Returns the list of problems (empty when the wiring is intact).
 */
export function checkReleaseExistence(deployText) {
  const found = [];
  const fail = (why) => found.push(`${DEPLOY_WORKFLOW}: ${why}`);
  const lines = deployText.replace(/\r/g, '').split('\n');
  const isCode = (line) => !/^\s*#/.test(line) && !/^\s*echo\b/.test(line);
  const code = lines.filter(isCode).map((line) => line.trim());
  const codeText = code.join('\n');

  const statusCmds = code.filter((line) => /\bhelm\s+status\b/.test(line));
  if (statusCmds.length !== 1 || statusCmds[0] !== STATUS_CMD) {
    fail(`release existence must not be derived from a bare \`helm status\` exit code; the only helm status must be exactly \`${STATUS_CMD}\`, found: [${statusCmds.join(' | ')}]`);
  }
  const listCmds = code.filter((line) => /\bhelm\s+list\b/.test(line));
  if (listCmds.length !== 1 || listCmds[0] !== LIST_CMD) {
    fail(`release absence must be corroborated by exactly one \`${LIST_CMD}\` (--all lists every status, Helm v3.16.3 pkg/action/list.go), found: [${listCmds.join(' | ')}]`);
  }
  // The classifier's inputs — the exit codes and the LIST_ARGS array — are written only at their
  // exact sites (checkDecisionWrites), so `--list-exit 0` or an extra reset fails.
  for (const [name, forms] of Object.entries(PRODUCER_WRITES)) {
    for (const why of checkDecisionWrites(deployText, name, forms, 'producer input')) fail(why);
  }
  // ...and each exit code's `X=0` reset directly precedes its exact capture line.
  for (const [name, capture] of Object.entries(EXIT_CODE_CAPTURES)) {
    for (const why of checkResetPrecedesCapture(deployText, name, capture)) fail(why);
  }
  // ...and the raw payload files they read are referenced only at their exact lines, so nothing
  // truncates, rebinds or rewrites a capture before its classifier reads it.
  for (const [name, refs] of Object.entries(PAYLOAD_REFERENCES)) {
    for (const why of checkEvidenceReferences(deployText, name, [evidenceFile(name), ...refs.map(exactLine)])) fail(why);
  }
  if (!/^if node scripts\/release-existence\.mjs classify --release gambit --status-exit "\$STATUS_RC" \\$/m.test(codeText)) {
    fail('release existence must be classified by `node scripts/release-existence.mjs classify` from the helm status/list evidence');
  }
  // The decision variables read from the evidence files are written only at their allowed sites
  // (checkDecisionWrites; PREV_REV is gate 10's). Checked before any early return below.
  for (const name of ['SNAPSHOT_NEWEST', 'RELEASE_EXISTENCE', 'RELEASE_EXISTS', 'INVENTORY', 'DEPLOY_MARKER']) {
    for (const why of checkDecisionWrites(deployText, name, DECISION_WRITES[name])) fail(why);
  }

  // Assignments, including any chained after an echo (quoted text blanked out first).
  const assignments = code.filter((line) => /(?:^|[\s;(&|])RELEASE_EXISTS=/.test(line));
  for (const line of lines.filter((l) => /^\s*echo\b/.test(l))) {
    const masked = line.replace(/"[^"]*"|'[^']*'/g, (quoted) => ' '.repeat(quoted.length));
    if (/(?:;|&&|\|\|)\s*RELEASE_EXISTS=/.test(masked)) assignments.push(line.trim());
  }
  const ALLOWED_ASSIGNMENTS = ['RELEASE_EXISTS=""', 'exists) RELEASE_EXISTS=true ;;', 'RELEASE_EXISTS=false'];
  if (assignments.length !== ALLOWED_ASSIGNMENTS.length ||
      !ALLOWED_ASSIGNMENTS.every((allowed) => assignments.filter((a) => a === allowed).length === 1)) {
    fail(`RELEASE_EXISTS must be assigned exactly as [${ALLOWED_ASSIGNMENTS.join(' | ')}] (RELEASE_EXISTS=false only on confirmed absence, after the namespace inventory), found: [${assignments.join(' | ')}]`);
  }
  // The case arms are exactly `exists)` (setting the literal), `absent)` (the namespace inventory,
  // then RELEASE_EXISTS=false) and `*)`, which refuses every other verdict: its arm must end with
  // `exit 1` before `;;` and must not touch RELEASE_EXISTS.
  const caseIdx = code.indexOf('case "$RELEASE_EXISTENCE" in');
  const EXPECTED_ARMS = ['exists) RELEASE_EXISTS=true ;;', 'absent)', '*)'];
  const esacIdx = caseIdx === -1 ? -1 : code.indexOf('esac', caseIdx);
  const caseBody = esacIdx === -1 ? [] : code.slice(caseIdx + 1, esacIdx);
  const arms = caseBody.filter((line) => /^\(?[^\s()=$"']+\)/.test(line));
  const unknownArm = caseBody.slice(caseBody.indexOf('*)') + 1);
  const unknownArmBody = unknownArm.slice(0, unknownArm.indexOf(';;'));
  if (arms.join('\n') !== EXPECTED_ARMS.join('\n') ||
      !unknownArm.includes(';;') ||
      unknownArmBody.at(-1) !== 'exit 1' ||
      unknownArmBody.some((line) => /\bRELEASE_EXISTS\b/.test(line))) {
    fail(`\`case "$RELEASE_EXISTENCE" in\` must have exactly the arms [${EXPECTED_ARMS.join(' | ')}], and the \`*)\` arm (unknown existence) must end with \`exit 1\` before \`;;\`, found arms: [${arms.join(' | ')}]`);
  }
  const absentStart = caseBody.indexOf('absent)');
  const absentEnd = absentStart === -1 ? -1 : caseBody.indexOf(';;', absentStart);
  const absentArm = absentEnd === -1 ? [] : caseBody.slice(absentStart + 1, absentEnd);
  if (absentArm.at(-1) !== 'RELEASE_EXISTS=false') {
    fail('RELEASE_EXISTS=false must be the last statement of the `absent)` arm of `case "$RELEASE_EXISTENCE" in`, after the namespace inventory');
  }
  found.push(...checkOrphanInventory(absentArm, code, lines));
  // The step output the rollback reads must be exactly RELEASE_EXISTS (as gate 10 does for prev_revision).
  const PUBLISH_RELEASE_EXISTS = 'echo "release_exists=$RELEASE_EXISTS" >> "$GITHUB_OUTPUT"';
  const publishes = lines
    .filter((line) => !/^\s*#/.test(line) && /release_exists=/.test(line) && /"\$GITHUB_OUTPUT"/.test(line))
    .map((line) => line.trim());
  if (publishes.length === 0 || publishes.some((line) => line !== PUBLISH_RELEASE_EXISTS)) {
    fail(`every release_exists output must be published exactly as \`${PUBLISH_RELEASE_EXISTS}\`, found: [${publishes.join(' | ')}]`);
  }
  const existenceAssignments = code.filter((line) => /(?:^|[\s;])RELEASE_EXISTENCE=/.test(line));
  const ALLOWED_EXISTENCE = ['RELEASE_EXISTENCE=unknown', `RELEASE_EXISTENCE=$(sed -n 's/^release_existence=//p' "$EXISTENCE_FILE")`];
  if (existenceAssignments.length !== 2 || !ALLOWED_EXISTENCE.every((a) => existenceAssignments.includes(a))) {
    fail(`RELEASE_EXISTENCE must be "unknown" or read from the classifier's output, found: [${existenceAssignments.join(' | ')}]`);
  }
  // ...and that file holds only the classifier's verdict (as gate 10 does for the resolver's file):
  // every classifier invocation sends its stdout to "$EXISTENCE_FILE", and nothing else writes it.
  const classifierStdouts = code
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((line) => /\bnode\s+scripts\/release-existence\.mjs\s+classify\b/.test(line))
    .map((line) => stdoutRedirects(line.slice(line.search(/\bnode\s+scripts\/release-existence\.mjs\s+classify\b/))));
  if (classifierStdouts.length === 0 ||
      classifierStdouts.some((redirects) => redirects.length !== 1 || redirects[0] !== '> "$EXISTENCE_FILE"')) {
    fail(`the classifier's stdout must be redirected exactly once, as \`> "$EXISTENCE_FILE"\`, found: [${classifierStdouts.map((r) => r.join(' ')).join(' | ')}]`);
  }
  for (const why of checkEvidenceReferences(deployText, 'EXISTENCE_FILE', [
    evidenceFile('EXISTENCE_FILE'),
    exactLine(EXISTENCE_CLASSIFIER),
    ...sedReads('EXISTENCE_FILE', EVIDENCE_READS.EXISTENCE_FILE),
  ])) {
    fail(why);
  }

  // The rollback step: from its `- name:` line to the next step (or end of file).
  const start = lines.findIndex((line) => /^\s*-\s+name:\s*Rollback on post-deploy verification failure\s*$/.test(line));
  if (start === -1) {
    fail('the "Rollback on post-deploy verification failure" step is missing');
    return found;
  }
  const next = lines.findIndex((line, i) => i > start && /^\s*-\s+(?:name|uses|run):/.test(line));
  const step = lines.slice(start, next === -1 ? undefined : next).filter(isCode).map((line) => line.trim());

  const ENV_BINDING = 'RELEASE_EXISTS: ${{ steps.pre_upgrade.outputs.release_exists }}';
  const bindings = step.filter((line) => /^RELEASE_EXISTS\s*:/.test(line));
  if (bindings.length !== 1 || bindings[0] !== ENV_BINDING) {
    fail(`the rollback step must bind exactly \`${ENV_BINDING}\`, found: [${bindings.join(' | ')}]`);
  }

  const uninstalls = code.filter((line) => /\bhelm\s+uninstall\b/.test(line));
  const UNINSTALL_CMD = 'helm uninstall gambit --wait --timeout 5m0s';
  if (uninstalls.length !== 1 || uninstalls[0] !== UNINSTALL_CMD || !step.includes(UNINSTALL_CMD)) {
    fail(`deploy.yml must contain exactly one \`${UNINSTALL_CMD}\`, in the rollback step, found: [${uninstalls.join(' | ')}]`);
    return found;
  }
  // Each recovery runs only at the top level of its branch, after its guards in order; every guard
  // is an `if ...; then` whose body ends the step with `exit 1`. The ownership re-check
  // (scripts/recovery-ownership.mjs check) proves the newest revision is this run's.
  const BRANCH = 'if [ "$RELEASE_EXISTS" = "false" ]; then';
  const HISTORY_CHECK = 'if ! helm history gambit -o json --max 256 > "$RB_HISTORY" 2> "$RB_HISTORY_ERR"; then';
  const REVISION_CHECK = 'if ! node scripts/release-existence.mjs only-initial-revision < "$RB_HISTORY" 2> "$RB_HISTORY_ERR" > /dev/null; then';
  const OWNERSHIP_UNINSTALL = 'if ! node scripts/recovery-ownership.mjs check --action uninstall --snapshot-newest "$SNAPSHOT_NEWEST" --marker "$DEPLOY_MARKER" < "$RB_HISTORY" 2> "$RB_HISTORY_ERR" > /dev/null; then';
  const OWNERSHIP_ROLLBACK = 'if ! node scripts/recovery-ownership.mjs check --action rollback --snapshot-newest "$SNAPSHOT_NEWEST" --marker "$DEPLOY_MARKER" --target "$PREV_REV" < "$RB_HISTORY" 2> "$RB_HISTORY_ERR" > /dev/null; then';
  const ROLLBACK_BRANCH = 'elif [ "$RELEASE_EXISTS" = "true" ] && [[ "$PREV_REV" =~ ^[1-9][0-9]*$ ]]; then';
  const guardedAction = (what, branch, guards, isAction) => {
    const start = step.indexOf(branch);
    const top = start === -1 ? [] : branchTopLevel(step, start);
    const positions = guards.map((guard) => top.find((t) => step[t] === guard) ?? -1);
    const action = top.find((t) => isAction(step[t])) ?? -1;
    const ordered = positions.every((p, k) => p !== -1 && (k === 0 || p > positions[k - 1])) && action > positions.at(-1);
    if (!ordered) {
      fail(`the ${what} must be guarded, in order, by \`${branch}\`, ${guards.map((g) => `\`${g}\``).join(', ')}, within the same branch`);
      return;
    }
    for (const p of positions) {
      const body = ifBody(step, p);
      if (body.at(-1) !== 'exit 1') {
        fail(`the ${what} guard \`${step[p]}\` must end its branch with \`exit 1\` before \`fi\``);
      }
    }
  };
  guardedAction('uninstall', BRANCH, [HISTORY_CHECK, REVISION_CHECK, OWNERSHIP_UNINSTALL], (line) => line === UNINSTALL_CMD);
  const iRollbackBranch = step.indexOf(ROLLBACK_BRANCH);
  const rollbackTop = iRollbackBranch === -1 ? [] : branchTopLevel(step, iRollbackBranch);
  if (!rollbackTop.some((t) => /\bhelm\s+rollback\b/.test(step[t]))) {
    fail(`the helm rollback must sit directly in the \`${ROLLBACK_BRANCH}\` branch (rollback requires release_exists exactly "true")`);
  } else {
    guardedAction('rollback', ROLLBACK_BRANCH, [HISTORY_CHECK, OWNERSHIP_ROLLBACK], (line) => /\bhelm\s+rollback\b/.test(line));
  }
  found.push(...checkRecoveryWiring(deployText));
  return found;
}

/**
 * Indices of the statements at the top level of the shell branch opened by step[start] (an `if`
 * or `elif` line), up to the `elif` / `else` / `fi` that closes it. Nested `if ... fi` blocks count
 * as their opening line only.
 */
function branchTopLevel(step, start) {
  const top = [];
  let depth = 0;
  for (let i = start + 1; i < step.length; i++) {
    const line = step[i];
    if (depth === 0 && /^(?:elif|else|fi)\b/.test(line)) break;
    if (depth === 0) top.push(i);
    if (/^if\b/.test(line)) depth++;
    else if (/^fi\b/.test(line)) depth--;
  }
  return top;
}

/** The statements of the `then` part of the `if` at lines[at], up to its own elif/else/fi. */
function ifBody(lines, at) {
  return branchTopLevel(lines, at).map((i) => lines[i]);
}

/** The code lines (trimmed, no comments or echo lines) of the step whose `- name:` matches. */
function stepLines(lines, name) {
  const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s+name:\\s*${name}\\s*$`).test(line));
  if (start === -1) return null;
  const next = lines.findIndex((line, i) => i > start && /^\s*-\s+(?:name|uses|run):/.test(line));
  return lines.slice(start, next === -1 ? undefined : next);
}

/**
 * Gate 11, confirmed absence: before RELEASE_EXISTS=false the `absent)` arm inventories the
 * namespace (scripts/recovery-ownership.mjs inventory) for every kind the chart renders, by the
 * release's instance label and by Helm's release-name annotation, and refuses (`exit 1`) unless
 * the verdict is exactly `empty`. "$INV_VERDICT" is referenced only by its mktemp, the inventory
 * classifier's redirect and sed reads (checkEvidenceReferences).
 */
function checkOrphanInventory(absentArm, code, lines) {
  const found = [];
  const fail = (why) => found.push(`${DEPLOY_WORKFLOW}: ${why}`);
  const KINDS = `INV_KINDS="${BASE_INVENTORY_KINDS.join(',')}"`;
  const KINDS_ES = `INV_KINDS="$INV_KINDS,${EXTERNAL_SECRET_RESOURCE}"`;
  const CLASSIFY = INVENTORY_CLASSIFIER;
  const REFUSAL = 'if [ "$INVENTORY" != "empty" ]; then';
  // The arm with line continuations joined, as the shell reads it.
  const arm = absentArm.join('\n').replace(/\s*\\\n\s*/g, ' ').split('\n');
  const steps = [KINDS, DISCOVERY, LABELLED, ANNOTATED, CLASSIFY, REFUSAL].map((s) => arm.indexOf(s));
  const ordered = steps.every((p, k) => p !== -1 && (k === 0 || p > steps[k - 1]));
  if (!ordered) {
    const missing = [KINDS, DISCOVERY, LABELLED, ANNOTATED, CLASSIFY, REFUSAL].filter((s, k) => steps[k] === -1);
    fail(`on confirmed absence the namespace inventory must run, in order, before RELEASE_EXISTS=false: \`${KINDS}\`, \`${DISCOVERY}\`, \`${LABELLED}\`, \`${ANNOTATED}\`, \`${CLASSIFY}\` and \`${REFUSAL}\`; missing or out of order: [${missing.join(' | ')}]`);
  } else if (ifBody(arm, steps[5]).at(-1) !== 'exit 1') {
    fail(`the namespace inventory refusal \`${REFUSAL}\` must end with \`exit 1\` before \`fi\`: an install on an occupied or unknown namespace adopts live objects`);
  }
  const kindAssignments = code.filter((line) => /(?:^|[\s;])INV_KINDS=/.test(line));
  if (kindAssignments.length !== 2 || kindAssignments[0] !== KINDS || kindAssignments[1] !== KINDS_ES) {
    fail(`INV_KINDS must be assigned exactly as [${KINDS} | ${KINDS_ES}] (every kind deploy/helm/gambit renders), found: [${kindAssignments.join(' | ')}]`);
  }
  const ALLOWED_INVENTORY = ['INVENTORY=unknown', `INVENTORY=$(sed -n 's/^orphan_inventory=//p' "$INV_VERDICT")`];
  const inventoryAssignments = code.filter((line) => /(?:^|[\s;])INVENTORY=/.test(line));
  if (inventoryAssignments.length !== 2 || !ALLOWED_INVENTORY.every((a) => inventoryAssignments.includes(a))) {
    fail(`INVENTORY must be "unknown" or read from the inventory classifier's output, found: [${inventoryAssignments.join(' | ')}]`);
  }
  for (const why of checkEvidenceReferences(lines.join('\n'), 'INV_VERDICT', [
    evidenceFile('INV_VERDICT'),
    exactLine(INVENTORY_CLASSIFIER),
    ...sedReads('INV_VERDICT', EVIDENCE_READS.INV_VERDICT),
  ])) {
    fail(why);
  }
  if (!absentArm.includes('SNAPSHOT_NEWEST=0')) {
    fail('the `absent)` arm must record the snapshot\'s newest revision as `SNAPSHOT_NEWEST=0`');
  }
  return found;
}

/**
 * Gate 11, recovery wiring: the rollback step runs exactly on a failed post-deploy verification;
 * the helm upgrade records this run's marker; the marker and the snapshot's newest revision come
 * only from pre_upgrade's own evidence ("$MARKER_FILE" is referenced only by its mktemp, the marker
 * CLI's redirect and the sed read, checkEvidenceReferences); every `helm history` asks for the
 * --max 256 window.
 */
export function checkRecoveryWiring(deployText) {
  const found = [];
  const fail = (why) => found.push(`${DEPLOY_WORKFLOW}: ${why}`);
  const lines = deployText.replace(/\r/g, '').split('\n');
  const isCode = (line) => !/^\s*#/.test(line) && !/^\s*echo\b/.test(line);
  const code = lines.filter(isCode).map((line) => line.trim());
  const codeText = code.join('\n');

  // The rollback step's condition.
  const CONDITION = "if: failure() && steps.smoke_check.outcome == 'failure'";
  const rbStep = stepLines(lines, 'Rollback on post-deploy verification failure');
  const conditions = (rbStep ?? []).slice(0, (rbStep ?? []).findIndex((line) => /^\s*run:/.test(line)) >>> 0)
    .filter((line) => /^\s*if:/.test(line)).map((line) => line.trim());
  if (!rbStep || conditions.length !== 1 || conditions[0] !== CONDITION) {
    fail(`the rollback step's \`if:\` must be exactly \`${CONDITION.slice(4)}\` (it must run when, and only when, post-deploy verification failed), found: [${conditions.join(' | ')}]`);
  }
  const smokeIds = code.filter((line) => line === 'id: smoke_check');
  const smokeAt = lines.findIndex((line) => line.trim() === 'id: smoke_check');
  const rbAt = lines.findIndex((line) => /^\s*-\s+name:\s*Rollback on post-deploy verification failure\s*$/.test(line));
  if (smokeIds.length !== 1 || smokeAt === -1 || rbAt === -1 || smokeAt > rbAt) {
    fail('exactly one step must have `id: smoke_check` (the post-deploy verification the rollback step\'s condition names), before the rollback step');
  }

  // The marker: composed only by scripts/recovery-ownership.mjs marker, published verbatim.
  const MARKER_CMD = /^if ! node scripts\/recovery-ownership\.mjs marker --run-id "\$GITHUB_RUN_ID" --run-attempt "\$GITHUB_RUN_ATTEMPT" --version "\$VERSION" > "\$MARKER_FILE"; then$/;
  const MARKER_READ = `DEPLOY_MARKER=$(sed -n 's/^deploy_marker=//p' "$MARKER_FILE")`;
  const markerAssignments = code.filter((line) => /(?:^|[\s;])DEPLOY_MARKER=/.test(line));
  if (!code.some((line) => MARKER_CMD.test(line)) || markerAssignments.length !== 1 || markerAssignments[0] !== MARKER_READ) {
    fail(`DEPLOY_MARKER must be assigned only as \`${MARKER_READ}\`, from the output of \`node scripts/recovery-ownership.mjs marker\`, found: [${markerAssignments.join(' | ')}]`);
  }
  for (const why of checkEvidenceReferences(deployText, 'MARKER_FILE', [
    evidenceFile('MARKER_FILE'),
    { label: 'if ! node scripts/recovery-ownership.mjs marker ... > "$MARKER_FILE"; then', re: MARKER_CMD, once: true },
    ...sedReads('MARKER_FILE', EVIDENCE_READS.MARKER_FILE),
  ])) {
    fail(why);
  }
  const published = (key, exact) => {
    const all = lines.filter((line) => !/^\s*#/.test(line) && line.includes(`${key}=`) && /"\$GITHUB_OUTPUT"/.test(line)).map((line) => line.trim());
    if (all.length !== 1 || all[0] !== exact) {
      fail(`every ${key} output must be published exactly as \`${exact}\`, found: [${all.join(' | ')}]`);
    }
  };
  published('deploy_marker', 'echo "deploy_marker=$DEPLOY_MARKER" >> "$GITHUB_OUTPUT"');
  published('snapshot_newest_revision', 'echo "snapshot_newest_revision=$SNAPSHOT_NEWEST" >> "$GITHUB_OUTPUT"');
  const ALLOWED_SNAPSHOT = ['SNAPSHOT_NEWEST=""', 'SNAPSHOT_NEWEST=0', `SNAPSHOT_NEWEST=$(sed -n 's/^rollback_newest_revision=//p' "$RESOLVED")`];
  const snapshotAssignments = code.filter((line) => /(?:^|[\s;])SNAPSHOT_NEWEST=/.test(line));
  if (snapshotAssignments.length !== ALLOWED_SNAPSHOT.length || !ALLOWED_SNAPSHOT.every((a) => snapshotAssignments.filter((s) => s === a).length === 1)) {
    fail(`SNAPSHOT_NEWEST must be assigned exactly as [${ALLOWED_SNAPSHOT.join(' | ')}] (0 on confirmed absence, else the resolver's newest revision), found: [${snapshotAssignments.join(' | ')}]`);
  }

  // The upgrade step marks its revision, and refuses without a marker.
  const MARKER_BINDING = 'DEPLOY_MARKER: ${{ steps.pre_upgrade.outputs.deploy_marker }}';
  const SNAPSHOT_BINDING = 'SNAPSHOT_NEWEST: ${{ steps.pre_upgrade.outputs.snapshot_newest_revision }}';
  const binds = (stepText, binding, what) => {
    const name = binding.slice(0, binding.indexOf(':'));
    const all = (stepText ?? []).map((line) => line.trim()).filter((line) => line.startsWith(`${name}:`));
    if (all.length !== 1 || all[0] !== binding) {
      fail(`${what} must bind exactly \`${binding}\`, found: [${all.join(' | ')}]`);
    }
  };
  const upStep = stepLines(lines, 'Pre-flight template validation and Helm upgrade');
  binds(upStep, MARKER_BINDING, 'the upgrade step');
  binds(rbStep, MARKER_BINDING, 'the rollback step');
  binds(rbStep, SNAPSHOT_BINDING, 'the rollback step');
  const upCode = (upStep ?? []).filter(isCode).map((line) => line.trim());
  const upJoined = upCode.join('\n').replace(/\s*\\\n\s*/g, ' ').split('\n');
  const upgrades = upJoined.filter((line) => /\bhelm\s+upgrade\b/.test(line));
  const iGuard = upCode.indexOf('if [ -z "$DEPLOY_MARKER" ]; then');
  const iUpgrade = upCode.findIndex((line) => /\bhelm\s+upgrade\b/.test(line));
  if (iGuard === -1 || iUpgrade === -1 || iGuard > iUpgrade || ifBody(upCode, iGuard).at(-1) !== 'exit 1') {
    fail('the upgrade step must refuse an empty DEPLOY_MARKER (`if [ -z "$DEPLOY_MARKER" ]; then ... exit 1`) before `helm upgrade`');
  }
  if (upgrades.length !== 1 || (upgrades[0].match(/--description\b/g) ?? []).length !== 1 || !upgrades[0].includes(' --description "$DEPLOY_MARKER" ')) {
    fail('the helm upgrade must record this run\'s marker exactly once as `--description "$DEPLOY_MARKER"` (the rollback step acts only on a revision carrying it)');
  }

  // The history window.
  // Command lines only: quoted text (error messages naming `helm history`) is masked first.
  const histories = code.filter((line) => /\bhelm\s+history\b/.test(line.replace(/"[^"]*"|'[^']*'/g, (q) => ' '.repeat(q.length))));
  const HISTORY = /^(?:if ! )?helm history gambit -o json --max 256 > "\$[A-Z_]+" 2> "\$[A-Z_]+"(?:; then)?$/;
  if (histories.length === 0 || histories.some((line) => !HISTORY.test(line))) {
    fail(`every \`helm history\` must ask for the explicit \`-o json --max 256\` window (Helm returns only the newest --max records; --max 0 returns none), found: [${histories.join(' | ')}]`);
  }
  if (!/^helm upgrade --install gambit /m.test(codeText)) {
    fail('the helm upgrade --install gambit command is missing');
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
  console.log('  ✓ deploy.yml uninstalls only on confirmed absence, behind a fresh helm history re-check');
  console.log('  ✓ deploy.yml installs on confirmed absence only after the namespace inventory found no object of the release');
  console.log('  ✓ deploy.yml marks its helm upgrade and re-verifies ownership before both uninstall and rollback');
  console.log("  ✓ deploy.yml's rollback step runs exactly on failure() && steps.smoke_check.outcome == 'failure'");
  console.log('  ✓ deploy.yml reads helm history with the explicit --max 256 window');
  console.log('');
  console.log('=== Results: all deployment gates verified ===');
}

/**
 * Whether the module at metaUrl is the entry point named by argv1. Node resolves the main module
 * through realpath, but process.argv[1] keeps the path as invoked, so under a symlinked or junctioned
 * checkout a plain comparison would never match and every gate would be skipped with exit 0.
 *
 * @param {string} metaUrl The module's import.meta.url.
 * @param {string | undefined} argv1 process.argv[1].
 * @returns {boolean}
 */
export function isMainModule(metaUrl, argv1) {
  if (argv1 === undefined) return false;
  if (metaUrl === pathToFileURL(argv1).href) return true;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
