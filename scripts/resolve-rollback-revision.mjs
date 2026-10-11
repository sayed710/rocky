#!/usr/bin/env node
/**
 * Reads the pre-upgrade `helm history <release> -o json` on stdin and prints the revision an
 * automatic post-deploy rollback may target (see lib/rollback-revision.mjs).
 *
 *   node scripts/resolve-rollback-revision.mjs < history.json
 *     prints rollback_revision, rollback_newest_revision and rollback_evidence key=value lines
 *     for $GITHUB_OUTPUT.
 *
 * Exits non-zero, with the reason on one line of stderr, when no revision can be proven safe; the
 * workflow then refuses an automatic rollback instead of guessing.
 */

import { readFileSync } from 'node:fs';

import { formatRollbackOutput, resolveRollbackRevision } from './lib/rollback-revision.mjs';

try {
  if (process.argv.length > 2) {
    throw new Error(`unexpected argument ${JSON.stringify(process.argv[2])}`);
  }
  const raw = readFileSync(0, 'utf8');
  let history;
  try {
    history = JSON.parse(raw);
  } catch (error) {
    throw new Error(`helm history output is not valid JSON (${error.message})`);
  }
  process.stdout.write(formatRollbackOutput(resolveRollbackRevision(history)));
} catch (error) {
  process.stderr.write(`resolve-rollback-revision: ${String(error.message).replace(/\s+/g, ' ').trim()}\n`);
  process.exit(1);
}
