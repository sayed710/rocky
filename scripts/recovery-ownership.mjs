#!/usr/bin/env node
/**
 * Recovery-ownership evidence for deploy.yml (see lib/recovery-ownership.mjs).
 *
 *   node scripts/recovery-ownership.mjs marker --run-id <GITHUB_RUN_ID> --run-attempt <GITHUB_RUN_ATTEMPT> --version <VERSION>
 *     prints `deploy_marker=gambit-deploy <id>-<attempt> <version>`; exits 1 (reason on stderr)
 *     when a part is missing or malformed.
 *
 *   node scripts/recovery-ownership.mjs check --action uninstall|rollback --snapshot-newest <N>
 *       --marker <marker> [--target <rev>] < history.json
 *     exits 0 and prints `recovery_ownership=verified` / `recovery_newest_revision=<N+1>` when the
 *     `helm history -o json` on stdin shows that the newest revision is this run's; otherwise
 *     exits 1 with the reason on one line of stderr. An empty value is a refusal, not a usage error.
 *
 *   node scripts/recovery-ownership.mjs inventory --release gambit --kinds <k1,k2,...>
 *       --api-exit <code> --api-stdout <file> --label-exit <code> --label-stdout <file>
 *       --annotation-exit <code> --annotation-stdout <file>
 *     prints `orphan_inventory=empty|occupied|unknown`, `orphan_inventory_objects=<list>` and
 *     `orphan_inventory_reason=<one line>` and exits 0. The workflow installs only on exactly
 *     `empty` (a non-zero exit of this script counts as unknown).
 *
 * Usage errors exit 2.
 */

import { readFileSync } from 'node:fs';

import { checkRecoveryOwnership, classifyOrphanInventory, composeDeployMarker } from './lib/recovery-ownership.mjs';

const PROG = 'recovery-ownership';

function oneLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

class UsageError extends Error {}
class Refusal extends Error {}

function parseFlags(args, allowed, required) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!allowed.includes(flag)) throw new UsageError(`unexpected argument ${JSON.stringify(flag)}`);
    if (flag in flags) throw new UsageError(`${flag} given twice`);
    if (i + 1 >= args.length) throw new UsageError(`${flag} needs a value`);
    flags[flag] = args[i + 1];
  }
  for (const flag of required) {
    if (!(flag in flags)) throw new UsageError(`${flag} is required`);
  }
  return flags;
}

function exitCode(flag, value) {
  if (!/^(0|[1-9][0-9]{0,2})$/.test(value)) {
    throw new UsageError(`${flag} must be an exit code, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

function marker(args) {
  const flags = parseFlags(args, ['--run-id', '--run-attempt', '--version'], ['--run-id', '--run-attempt', '--version']);
  let value;
  try {
    value = composeDeployMarker({ runId: flags['--run-id'], runAttempt: flags['--run-attempt'], version: flags['--version'] });
  } catch (error) {
    throw new Refusal(error.message);
  }
  process.stdout.write(`deploy_marker=${value}\n`);
}

function check(args) {
  const flags = parseFlags(args, ['--action', '--snapshot-newest', '--marker', '--target'], ['--action', '--snapshot-newest', '--marker']);
  if (flags['--action'] !== 'uninstall' && flags['--action'] !== 'rollback') {
    throw new UsageError(`--action must be uninstall or rollback, got ${JSON.stringify(flags['--action'])}`);
  }
  const raw = readFileSync(0, 'utf8');
  let history;
  try {
    history = JSON.parse(raw);
  } catch (error) {
    throw new Refusal(`helm history output is not valid JSON (${oneLine(error.message)})`);
  }
  const result = checkRecoveryOwnership({
    history,
    action: flags['--action'],
    snapshotNewest: flags['--snapshot-newest'],
    marker: flags['--marker'],
    targetRevision: flags['--target'],
  });
  if (!result.ok) throw new Refusal(result.reason);
  process.stdout.write(`recovery_ownership=verified\nrecovery_newest_revision=${result.newestRevision}\n`);
}

function inventory(args) {
  const all = ['--release', '--kinds', '--api-exit', '--api-stdout', '--label-exit', '--label-stdout', '--annotation-exit', '--annotation-stdout'];
  const flags = parseFlags(args, all, all);
  const result = classifyOrphanInventory({
    release: flags['--release'],
    kinds: flags['--kinds'],
    apiResourcesExit: exitCode('--api-exit', flags['--api-exit']),
    apiResourcesStdout: readFileSync(flags['--api-stdout'], 'utf8'),
    labelExit: exitCode('--label-exit', flags['--label-exit']),
    labelStdout: readFileSync(flags['--label-stdout'], 'utf8'),
    annotationExit: exitCode('--annotation-exit', flags['--annotation-exit']),
    annotationStdout: readFileSync(flags['--annotation-stdout'], 'utf8'),
  });
  process.stdout.write(
    `orphan_inventory=${result.state}\n` +
    `orphan_inventory_objects=${oneLine(result.objects.join(', '))}\n` +
    `orphan_inventory_reason=${oneLine(result.reason)}\n`,
  );
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'marker') marker(args);
  else if (command === 'check') check(args);
  else if (command === 'inventory') inventory(args);
  else throw new UsageError(`unknown command ${JSON.stringify(command)} (expected marker, check or inventory)`);
} catch (error) {
  process.stderr.write(`${PROG}: ${oneLine(error.message)}\n`);
  process.exit(error instanceof UsageError ? 2 : 1);
}
