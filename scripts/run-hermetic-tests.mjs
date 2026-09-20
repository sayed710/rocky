#!/usr/bin/env node
/**
 * Centralized zero-skip orchestrator for repository-wide hermetic workspace test fan-out.
 *
 * Runs each declared hermetic workspace in sequence through runWithZeroSkip, strictly
 * enforcing that every child workspace executes tests, exits with code 0, and reports
 * zero skipped tests. If any workspace reports skipped > 0, 0 tests, non-zero exit,
 * or signal termination, execution halts immediately with failure.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getHermeticWorkspaces } from './lib/workspace-topology.mjs';
import { runWithZeroSkip } from './run-zero-skip.mjs';

/**
 * Derived list of all hermetic packages executed during root `npm test`.
 * These packages contain hermetic unit tests with zero external service dependencies.
 *
 * @type {readonly string[]}
 */
export const HERMETIC_WORKSPACES = getHermeticWorkspaces();

/**
 * Resolves the path to the npm-cli.js executable without relying on shell expansion.
 * Checks process.env.npm_execpath first, then falls back to standard Node.js installation paths.
 *
 * @returns {string|null} Absolute path to npm-cli.js, or null if unresolvable.
 */
export function resolveNpmCli() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return process.env.npm_execpath;
  }
  const winCandidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(winCandidate)) return winCandidate;
  const posixCandidate = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(posixCandidate)) return posixCandidate;
  return null;
}

/**
 * Runs the sequence of hermetic test workspaces through zero-skip enforcement.
 *
 * @param {Object} [options={}] - Execution options.
 * @param {string[]} [options.workspaces] - Workspaces to test (defaults to HERMETIC_WORKSPACES).
 * @param {string} [options.npmCli] - Path to npm-cli.js.
 * @param {boolean} [options.silent=false] - If true, suppresses stdout/stderr output.
 * @param {function(string, string[], object): Promise<number>} [options.runner=runWithZeroSkip] - Runner function.
 * @param {function(string): { cmd: string, args: string[] }} [options.commandBuilder] - Custom command builder for testing.
 * @returns {Promise<number>} Resolves with 0 on complete zero-skip success, or non-zero on first failure.
 */
export async function runHermeticTests(options = {}) {
  const workspaces = options.workspaces ?? HERMETIC_WORKSPACES;
  const runner = options.runner ?? runWithZeroSkip;
  const silent = Boolean(options.silent);

  let npmCli = options.npmCli;
  if (!npmCli && !options.commandBuilder) {
    npmCli = resolveNpmCli();
    if (!npmCli) {
      if (!silent) {
        process.stderr.write(
          '[run-hermetic-tests] ERROR: npm_execpath is unavailable; please run via "npm test" or ensure npm is installed.\n'
        );
      }
      return 1;
    }
  }

  for (let i = 0; i < workspaces.length; i++) {
    const ws = workspaces[i];
    if (!silent) {
      process.stdout.write(
        `\n\x1b[36m>>> [HERMETIC TEST ORCHESTRATOR] [${i + 1}/${workspaces.length}] Running workspace: ${ws}...\x1b[0m\n`
      );
    }

    let cmd;
    let args;
    if (options.commandBuilder) {
      const built = options.commandBuilder(ws);
      cmd = built.cmd;
      args = built.args;
    } else {
      cmd = process.execPath;
      args = [npmCli, 'run', 'test', '--workspace', ws];
    }

    const code = await runner(cmd, args, { silent });
    if (code !== 0) {
      if (!silent) {
        process.stderr.write(
          `\n\x1b[31m[HERMETIC TEST ORCHESTRATOR] FAILED on workspace "${ws}" with exit code ${code}.\x1b[0m\n`
        );
      }
      return code;
    }
  }

  if (!silent) {
    process.stdout.write(
      `\n\x1b[32m[HERMETIC TEST ORCHESTRATOR] SUCCESS: All ${workspaces.length} hermetic workspaces executed with zero skips.\x1b[0m\n`
    );
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const cliWorkspaces = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const workspaces = cliWorkspaces.length > 0 ? cliWorkspaces : undefined;
  const code = await runHermeticTests({ workspaces });
  process.exit(code);
}
