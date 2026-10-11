#!/usr/bin/env node
/**
 * Reads Helm JSON on stdin and prints what the deployed release is running (see lib/deployed-image-tags.mjs).
 *
 *   helm history gambit -o json | node scripts/resolve-deployed-image-tags.mjs --deployed-revision
 *     prints the deployed revision number.
 *   helm get values gambit --all -o json --revision N | node scripts/resolve-deployed-image-tags.mjs
 *     prints deployed_* key=value lines for $GITHUB_OUTPUT.
 *
 * Exits non-zero on anything it cannot resolve exactly, so the deploy stops instead of guessing.
 */

import { readFileSync } from 'node:fs';

import { findDeployedRevision, formatGithubOutput, resolveDeployedImageTags } from './lib/deployed-image-tags.mjs';

const mode = process.argv[2] ?? '';
try {
  if (mode !== '' && mode !== '--deployed-revision') {
    throw new Error(`unknown argument ${JSON.stringify(mode)}`);
  }
  const input = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(
    mode === '--deployed-revision'
      ? `${findDeployedRevision(input)}\n`
      : formatGithubOutput(resolveDeployedImageTags(input)),
  );
} catch (error) {
  process.stderr.write(`resolve-deployed-image-tags: ${error.message}\n`);
  process.exit(1);
}
