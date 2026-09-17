#!/usr/bin/env node
/**
 * Wraps a test command and fails if the test runner reports any skipped tests.
 *
 * Usage:
 *   node scripts/run-zero-skip.mjs <command> [args...]
 *   node scripts/run-zero-skip.mjs -- npm test
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * Spawns a test command, buffers and streams its output, and strictly enforces
 * that the test runner reported at least one executed test and zero skipped tests.
 *
 * Scans only genuine line-anchored reporter summary lines (`# tests N`, `ℹ tests N`,
 * `# skipped N`, `ℹ skipped N`) and TAP plan lines (`1..N`) to avoid false
 * positives or false negatives caused by arbitrary prose in test output.
 *
 * @param {string} cmd - Command or binary to execute.
 * @param {string[]} [args=[]] - Arguments to pass to the command.
 * @param {import('node:child_process').SpawnOptions & { silent?: boolean }} [options={}] - Options for spawn and output suppression.
 * @returns {Promise<number>} Resolves with process exit code (0 on valid zero-skip pass, non-zero on failure).
 */
export function runWithZeroSkip(cmd, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
      ...options,
    });

    let combinedOutput = '';

    child.stdout?.on('data', (chunk) => {
      if (!options.silent) process.stdout.write(chunk);
      combinedOutput += chunk.toString('utf8');
    });

    child.stderr?.on('data', (chunk) => {
      if (!options.silent) process.stderr.write(chunk);
      combinedOutput += chunk.toString('utf8');
    });


    child.on('error', (err) => {
      console.error(`[run-zero-skip] Failed to start process: ${err.message}`);
      resolve(1);
    });

    child.on('close', (code, signal) => {
      if (signal) {
        if (!options.silent) {
          process.stderr.write(`\n[run-zero-skip] Process terminated by signal: ${signal}\n`);
        }
        resolve(1);
        return;
      }

      if (code === null || code !== 0) {
        resolve(code ?? 1);
        return;
      }

      // Guard against missing or empty test runs (e.g. invalid glob, non-test command, or 0 tests executed).
      // Only accept genuine line-anchored reporter summary lines (# tests N, ℹ tests N) or TAP plan headers (1..N).
      // In multi-summary outputs, aggregate test counts and fail if any suite reports 0 executed tests.
      const testSummaryMatches = [...combinedOutput.matchAll(/^\s*(?:#|ℹ)\s+tests:?\s+(\d+)\b/gim)];
      let totalTests = null;
      if (testSummaryMatches.length > 0) {
        let aggregated = 0;
        for (const match of testSummaryMatches) {
          const count = Number.parseInt(match[1], 10);
          if (count === 0) {
            totalTests = 0;
            break;
          }
          aggregated += count;
        }
        if (totalTests !== 0) {
          totalTests = aggregated;
        }
      } else {
        const planMatches = [...combinedOutput.matchAll(/^\s*1\.\.(\d+)\b/gm)];
        if (planMatches.length > 0) {
          let aggregated = 0;
          for (const match of planMatches) {
            const count = Number.parseInt(match[1], 10);
            if (count === 0) {
              totalTests = 0;
              break;
            }
            aggregated += count;
          }
          if (totalTests !== 0) {
            totalTests = aggregated;
          }
        }
      }

      if (totalTests === null || totalTests === 0) {
        if (!options.silent) {
          process.stderr.write(
            `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: No executed tests detected in output (total=${totalTests}).\x1b[0m\n`
          );
        }
        resolve(1);
        return;
      }

      // Check for test runner skip indicators across TAP, spec format, and serialized test events.
      // 1. Look for genuine line-anchored TAP or spec summary lines: "# skipped 0", "ℹ skipped 0", etc.
      // In multi-summary outputs, accumulate skips across all suites so an earlier skip is never laundered.
      const skipSummaryMatches = [...combinedOutput.matchAll(/^\s*(?:#|ℹ)\s+skipped:?\s+(\d+)\b/gim)];
      // 2. Look for individual test skip directives:
      // TAP: "ok 1 - test # SKIP [reason]" or "not ok 1 - test # SKIP [reason]"
      // Spec: "- test # SKIP [reason]" or "- test (skipped)"
      const individualSkipRegex = /^\s*(?:(?:ok|not ok)\s+\d+\s+-[^\r\n]*\s+#\s*SKIP\b|[\ufe63\-]\s+[^\r\n]*\s+#\s*SKIP\b|[\ufe63\-]\s+[^\r\n]*\((?:skipped|skip)\))/im;
      const individualSkipMatch = individualSkipRegex.test(combinedOutput);

      let skippedCount = 0;
      if (skipSummaryMatches.length > 0) {
        for (const match of skipSummaryMatches) {
          skippedCount += Number.parseInt(match[1], 10);
        }
      } else if (individualSkipMatch) {
        skippedCount = 1;
      }

      if (skippedCount > 0) {
        if (!options.silent) {
          process.stderr.write(
            `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: Test suite finished with ${skippedCount} skipped test(s). The zero-skip policy requires skipped === 0.\x1b[0m\n`
          );
        }
        resolve(1);
        return;
      }

      // Check for TODO tests across TAP and spec format summaries and directives.
      // 1. Look for genuine line-anchored TAP or spec summary lines: "# todo 0", "ℹ todo 0", etc.
      const todoSummaryMatches = [...combinedOutput.matchAll(/^\s*(?:#|ℹ)\s+todo:?\s+(\d+)\b/gim)];
      // 2. Look for individual test TODO directives:
      // TAP: "ok 1 - test # TODO [reason]" or "not ok 1 - test # TODO [reason]"
      // Spec: "- test # TODO [reason]" or "- test (todo)"
      const individualTodoRegex = /^\s*(?:(?:ok|not ok)\s+\d+\s+-[^\r\n]*\s+#\s*TODO\b|[\ufe63\-]\s+[^\r\n]*\s+#\s*TODO\b|[\ufe63\-]\s+[^\r\n]*\((?:todo)\))/im;
      const individualTodoMatch = individualTodoRegex.test(combinedOutput);

      let todoCount = 0;
      if (todoSummaryMatches.length > 0) {
        for (const match of todoSummaryMatches) {
          todoCount += Number.parseInt(match[1], 10);
        }
      } else if (individualTodoMatch) {
        todoCount = 1;
      }

      if (todoCount > 0) {
        if (!options.silent) {
          process.stderr.write(
            `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: Test suite finished with ${todoCount} TODO test(s). The zero-skip policy requires todo === 0.\x1b[0m\n`
          );
        }
        resolve(1);
        return;
      }

      // Check for cancelled tests across TAP and spec format summaries.
      const cancelledSummaryMatches = [...combinedOutput.matchAll(/^\s*(?:#|ℹ)\s+cancelled:?\s+(\d+)\b/gim)];
      let cancelledCount = 0;
      if (cancelledSummaryMatches.length > 0) {
        for (const match of cancelledSummaryMatches) {
          cancelledCount += Number.parseInt(match[1], 10);
        }
      }

      if (cancelledCount > 0) {
        if (!options.silent) {
          process.stderr.write(
            `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: Test suite finished with ${cancelledCount} cancelled test(s). The zero-skip policy requires cancelled === 0.\x1b[0m\n`
          );
        }
        resolve(1);
        return;
      }

      // Check for fail/failed summaries in case child process exited 0 despite reporter failures.
      const failSummaryMatches = [...combinedOutput.matchAll(/^\s*(?:#|ℹ)\s+fail(?:ed)?:?\s+(\d+)\b/gim)];
      let failCount = 0;
      if (failSummaryMatches.length > 0) {
        for (const match of failSummaryMatches) {
          failCount += Number.parseInt(match[1], 10);
        }
      }

      if (failCount > 0) {
        if (!options.silent) {
          process.stderr.write(
            `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: Test suite finished with ${failCount} failed test(s). The zero-skip policy requires fail === 0.\x1b[0m\n`
          );
        }
        resolve(1);
        return;
      }

      resolve(0);
    });
  });
}

// If invoked as CLI
const isCli = process.argv[1] && (
  process.argv[1].endsWith('run-zero-skip.mjs') ||
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
);

if (isCli) {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  if (args.length === 0) {
    console.error('Usage: node scripts/run-zero-skip.mjs [--] <command> [args...]');
    process.exit(1);
  }

  const [cmd, ...cmdArgs] = args;
  runWithZeroSkip(cmd, cmdArgs).then((code) => {
    process.exit(code);
  });
}
