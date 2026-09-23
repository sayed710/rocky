#!/usr/bin/env node
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runWithZeroSkip } from './run-zero-skip.mjs';

const PROVIDERS = Object.freeze({
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
});

/** Selects only provisioned providers without ever reading or logging credential values. */
export function selectLiveProviders(mode, env = process.env) {
  if (mode !== 'all' && !(mode in PROVIDERS)) {
    throw new Error(`Unknown live provider '${mode}'. Expected all, openai, or anthropic.`);
  }
  const candidates = mode === 'all' ? Object.keys(PROVIDERS) : [mode];
  const selected = candidates.filter((provider) => Boolean(env[PROVIDERS[provider]]));
  if (selected.length === 0) {
    const requirement = mode === 'all'
      ? 'at least one of OPENAI_API_KEY or ANTHROPIC_API_KEY'
      : PROVIDERS[mode];
    throw new Error(`Live provider tests require ${requirement}.`);
  }
  return selected;
}

export async function runLiveProviderTests(mode, command, args, options = {}) {
  const selected = selectLiveProviders(mode, options.env ?? process.env);
  for (const provider of selected) {
    const code = await runWithZeroSkip(command, args, {
      ...options,
      env: {
        ...(options.env ?? process.env),
        GAMBIT_LIVE_PROVIDER: provider,
      },
    });
    if (code !== 0) return code;
  }
  return 0;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const [mode, separator, command, ...args] = process.argv.slice(2);
  if (!mode || separator !== '--' || !command) {
    console.error('Usage: node scripts/run-live-provider-tests.mjs <all|openai|anthropic> -- <command> [args...]');
    process.exit(1);
  }
  runLiveProviderTests(mode, command, args).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[live-provider] ${error.message}`);
      process.exit(1);
    }
  );
}
