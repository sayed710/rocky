/**
 * Playwright configuration for Gambit M6 acceptance tests.
 *
 * Usage:
 *   npm run e2e                        # static/offline specs (vite preview only)
 *   GAMBIT_E2E_BACKEND=1 npm run e2e   # all specs (starts e2e harness + vite preview)
 *
 * Backend-dependent specs (game-vs-bot, game-vs-human) are gated with
 * `test.skip(!process.env.GAMBIT_E2E_BACKEND, ...)` so `npm run e2e`
 * without backends only runs the static/offline specs.
 *
 * When GAMBIT_E2E_BACKEND=1, Playwright starts and health-checks both the
 * e2e harness and Vite preview. Keeping them as separate managed processes is
 * cross-platform and ensures both are terminated after the suite.
 *
 * Prerequisites for full acceptance:
 *   - npm run build (all packages, including e2e-harness) — must be run first
 *   - GAMBIT_E2E_BACKEND=1 environment variable set
 */
import type { PlaywrightTestConfig } from '@playwright/test';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

const isBackend = !!process.env['GAMBIT_E2E_BACKEND'];
const zeroSkipReporter = fileURLToPath(
  new URL('../../scripts/playwright-zero-skip-reporter.mjs', import.meta.url)
);

const config: PlaywrightTestConfig = {
  testDir: './e2e',
  timeout: 300_000,
  retries: 1,
  reporter: [['list'], [zeroSkipReporter]],
  // Ceiling, not a fixed count: pinning `workers: 4` would RAISE parallelism on a 2-core CI
  // runner, which is the opposite of the fix. The backend-gated suite drives one shared single-process
  // `e2e-harness` and one vite preview server, and unbounded local parallelism starves them.
  // Measured: default 10 workers took 485s with 8 flaky and 1 hard failure; 6 workers produced 3 flaky;
  // 4 workers gave three consecutive clean runs at ~64s.
  workers: Math.max(1, Math.min(4, Math.floor(cpus().length / 2))),
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:4173',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: isBackend
    ? [
        {
          command: 'node ../e2e-harness/dist/main.js',
          url: 'http://127.0.0.1:4174/v1/health',
          reuseExistingServer: false,
          timeout: 120_000,
        },
        {
          command: 'npm run preview -- --port 4173 --host 127.0.0.1',
          url: 'http://127.0.0.1:4173',
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ]
    : {
        command: 'npm run build && npm run preview',
        port: 4173,
        reuseExistingServer: true,
        timeout: 120_000,
      },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
};

export default config;
