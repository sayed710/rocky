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

    child.on('close', (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        resolve(exitCode);
        return;
      }

      // Check for test runner skip indicators across TAP, spec format, and serialized test events.
      const summaryMatch = /\bskipped\s+([1-9]\d*)\b/i.exec(combinedOutput);
      const individualSkipMatch = /(?:ok\s+\d+\s+-[^\n]+#\s*SKIP|[\ufe63\-]\s+[^\n]+#|#[ \t]*SKIP\b)/i.test(combinedOutput);

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
          /#\s*SKIP/i.test(line) || /[\ufe63\-]\s+[^\n]+#/i.test(line) || /#.*(?:Windows|POSIX)/i.test(line)
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
