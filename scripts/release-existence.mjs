#!/usr/bin/env node
/**
 * Release-existence evidence for deploy.yml (see lib/release-existence.mjs).
 *
 *   node scripts/release-existence.mjs classify --release gambit \
 *       --status-exit <code> --status-stderr <file> [--list-exit <code> --list-stdout <file>]
 *     prints `release_existence=exists|absent|unknown` and `release_existence_reason=<one line>`
 *     and exits 0. The workflow treats anything but exactly `exists` / `absent` (including a
 *     non-zero exit of this script) as unknown.
 *
 *   node scripts/release-existence.mjs only-initial-revision < history.json
 *     exits 0 when the `helm history -o json` on stdin is exactly one revision, revision 1;
 *     otherwise exits 1 with the reason on one line of stderr.
 *
 * Usage errors exit 2.
 */

import { readFileSync } from 'node:fs';

import { checkOnlyInitialRevision, classifyReleaseExistence } from './lib/release-existence.mjs';

const PROG = 'release-existence';

function oneLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

class UsageError extends Error {}

function exitCode(flag, value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,2})$/.test(value)) {
    throw new UsageError(`${flag} must be an exit code, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

function parseFlags(args, allowed) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!allowed.includes(flag)) throw new UsageError(`unexpected argument ${JSON.stringify(flag)}`);
    if (flag in flags) throw new UsageError(`${flag} given twice`);
    if (i + 1 >= args.length) throw new UsageError(`${flag} needs a value`);
    flags[flag] = args[i + 1];
  }
  return flags;
}

function classify(args) {
  const flags = parseFlags(args, ['--release', '--status-exit', '--status-stderr', '--list-exit', '--list-stdout']);
  for (const required of ['--release', '--status-exit', '--status-stderr']) {
    if (!(required in flags)) throw new UsageError(`${required} is required`);
  }
  if (('--list-exit' in flags) !== ('--list-stdout' in flags)) {
    throw new UsageError('--list-exit and --list-stdout go together');
  }
  const result = classifyReleaseExistence({
    release: flags['--release'],
    statusExitCode: exitCode('--status-exit', flags['--status-exit']),
    statusStderr: readFileSync(flags['--status-stderr'], 'utf8'),
    listExitCode: '--list-exit' in flags ? exitCode('--list-exit', flags['--list-exit']) : null,
    listStdout: '--list-stdout' in flags ? readFileSync(flags['--list-stdout'], 'utf8') : null,
  });
  process.stdout.write(`release_existence=${result.state}\nrelease_existence_reason=${oneLine(result.reason)}\n`);
}

function onlyInitialRevision(args) {
  if (args.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(args[0])}`);
  const raw = readFileSync(0, 'utf8');
  let history;
  try {
    history = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`${PROG}: helm history output is not valid JSON (${oneLine(error.message)})\n`);
    process.exit(1);
  }
  const result = checkOnlyInitialRevision(history);
  if (!result.ok) {
    process.stderr.write(`${PROG}: ${oneLine(result.reason)}\n`);
    process.exit(1);
  }
  process.stdout.write('initial_install_revision=1\n');
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'classify') classify(args);
  else if (command === 'only-initial-revision') onlyInitialRevision(args);
  else throw new UsageError(`unknown command ${JSON.stringify(command)} (expected classify or only-initial-revision)`);
} catch (error) {
  process.stderr.write(`${PROG}: ${oneLine(error.message)}\n`);
  process.exit(error instanceof UsageError ? 2 : 1);
}
