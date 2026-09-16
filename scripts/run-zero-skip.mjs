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
        process.stderr.write(`\n[run-zero-skip] Process terminated by signal: ${signal}\n`);
        resolve(1);
        return;
      }

      if (code === null || code !== 0) {
        resolve(code ?? 1);
        return;
      }

      // Guard against empty test runs (e.g. invalid glob or 0 tests executed)
      const testsMatch = /\btests\s+(\d+)\b/i.exec(combinedOutput);
      if (testsMatch && Number.parseInt(testsMatch[1], 10) === 0) {
        process.stderr.write(
          `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: Test runner reported 0 tests executed.\x1b[0m\n`
        );
        resolve(1);
        return;
      }

      // Check for test runner skip indicators across TAP, spec format, and serialized test events.
      // 1. Look for TAP or spec summary line: "skipped 0", "skipped 1", etc.
      const summaryMatch = /\bskipped:?\s+(\d+)\b/i.exec(combinedOutput);
      // 2. Look for individual test skip directives:
      // TAP: "ok 1 - test # SKIP [reason]" or "not ok 1 - test # SKIP [reason]"
      // Spec: "- test # SKIP [reason]" or "- test (skipped)"
      const individualSkipRegex = /(?:^|\r?\n)\s*(?:(?:ok|not ok)\s+\d+\s+-[^\r\n]*\s+#\s*SKIP\b|[\ufe63\-]\s+[^\r\n]*\s+#\s*SKIP\b|[\ufe63\-]\s+[^\r\n]*\((?:skipped|skip)\))/i;
      const individualSkipMatch = individualSkipRegex.test(combinedOutput);

      let skippedCount = 0;
      if (summaryMatch) {
        skippedCount = Number.parseInt(summaryMatch[1], 10);
      } else if (individualSkipMatch) {
        skippedCount = 1;
      }

      // In Linux CI (ubuntu-latest), NO skips are permitted under ANY circumstances.
      // On Windows local checkouts, exactly 3 POSIX-only tests cannot physically run because Windows
      // lacks POSIX signal delivery (SIGTERM) and POSIX file permission bits.
      if (skippedCount > 0 && process.platform === 'win32' && !process.env.STRICT_ZERO_SKIP) {
        const windowsPlatformSkips = [
          /SIGTERM on Windows terminates without running handlers/i,
          /POSIX permission bits are not meaningful on Windows/i,
          /Windows terminates on kill\(\) without running handlers/i,
        ];
        const skipLines = combinedOutput.split(/\r?\n/).filter((line) =>
          /#\s*SKIP\b/i.test(line) || /[\ufe63\-]\s+[^\r\n]*\s+#\s*SKIP\b/i.test(line) || /#.*(?:Windows|POSIX)/i.test(line)
        );
        const allKnownPlatformSkips = skipLines.length > 0 && skipLines.every((line) =>
          windowsPlatformSkips.some((re) => re.test(line))
        );
        if (allKnownPlatformSkips) {
          skippedCount = 0;
        }
      }

      if (skippedCount > 0) {
        process.stderr.write(
          `\n\x1b[31m[ZERO-SKIP ENFORCER] FAILED: Test suite finished with ${skippedCount} skipped test(s). The zero-skip policy requires skipped === 0.\x1b[0m\n`
        );
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
