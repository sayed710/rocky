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
import {
  createStreamingTestParser,
  createStreamLineProcessor,
} from './lib/test-output-parser.mjs';

/**
 * Spawns a test command, streams its output, and strictly enforces that the test
 * runner reported at least one executed test and zero skipped tests.
 * Maintains strictly O(1) bounded memory state by streaming lines directly to
 * createStreamingTestParser, preventing transcript accumulation in memory.
 * Uses independent StringDecoder instances and line buffers for stdout and stderr
 * to prevent multibyte corruption and cross-stream line interleaving.
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

    const parser = createStreamingTestParser();
    const processor = createStreamLineProcessor(parser);
    const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const signalHandlers = new Map();

    for (const signal of forwardedSignals) {
      const handler = () => {
        if (!child.killed) child.kill(signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    const cleanupSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
    };

    child.stdout?.on('data', (chunk) => {
      if (!options.silent) {
        process.stdout.write(chunk);
      }
      processor.pushStdoutChunk(chunk);
    });

    child.stderr?.on('data', (chunk) => {
      if (!options.silent) {
        process.stderr.write(chunk);
      }
      processor.pushStderrChunk(chunk);
    });

    child.on('error', (err) => {
      cleanupSignalHandlers();
      console.error(`[run-zero-skip] Failed to start process: ${err.message}`);
      resolve(1);
    });

    child.on('close', (code, signal) => {
      cleanupSignalHandlers();
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

      const results = processor.getResults();

      if (!results.accountingValid) {
        if (!options.silent) {
          process.stderr.write(
            `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: Reporter accounting is incomplete or contradictory: ${results.accountingError}.\x1b[0m\n`
          );
        }
        resolve(1);
        return;
      }

      // Guard against missing or empty test runs (e.g. invalid glob, non-test command, or 0 tests executed).
      // Only accept genuine line-anchored reporter summary lines (# tests N, ℹ tests N) or TAP plan headers (1..N).
      // In multi-summary outputs, aggregate test counts and fail if any suite reports 0 executed tests.
      if (results.totalTests === null || results.totalTests === 0) {
        if (!options.silent) {
          process.stderr.write(
            `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: No executed tests detected in output (total=${results.totalTests}).\x1b[0m\n`
          );
        }
        resolve(1);
        return;
      }

      // Check for test runner skip indicators across TAP summaries and individual directives.
      if (results.skippedCount > 0) {
        if (!options.silent) {
          process.stderr.write(
            `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: Test suite finished with ${results.skippedCount} skipped test(s). The zero-skip policy requires skipped === 0.\x1b[0m\n`
          );
        }
        resolve(1);
        return;
      }

      // Check for TODO tests across TAP summaries and individual directives.
      if (results.todoCount > 0) {
        if (!options.silent) {
          process.stderr.write(
            `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: Test suite finished with ${results.todoCount} TODO test(s). The zero-skip policy requires todo === 0.\x1b[0m\n`
          );
        }
        resolve(1);
        return;
      }

      // Check for cancelled tests across TAP and spec format summaries.
      if (results.cancelledCount > 0) {
        if (!options.silent) {
          process.stderr.write(
            `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: Test suite finished with ${results.cancelledCount} cancelled test(s). The zero-skip policy requires cancelled === 0.\x1b[0m\n`
          );
        }
        resolve(1);
        return;
      }

      // Check for fail/failed summaries and raw TAP "not ok" test points.
      if (results.failCount > 0) {
        if (!options.silent) {
          process.stderr.write(
            `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: Test suite finished with ${results.failCount} failed test(s). The zero-skip policy requires fail === 0.\x1b[0m\n`
          );
        }
        resolve(1);
        return;
      }

      if (results.passCount === null || results.passCount !== results.totalTests) {
        if (!options.silent) {
          process.stderr.write(
            `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: Passing-test accounting does not equal the executed total (pass=${results.passCount}, total=${results.totalTests}).\x1b[0m\n`
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
