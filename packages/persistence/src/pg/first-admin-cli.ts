/**
 * @packageDocumentation
 * `npm run admin:bootstrap -- <user-id> <operator>`: grant the first admin on a fresh installation
 * (ADR-0152). Exits 1 on any refusal; prints only the outcome, never connection details.
 */
import { bootstrapFirstAdmin } from './first-admin';
import { createPool } from './pool';

const REFUSALS = {
  admin_exists: 'an admin already exists; grant further roles through POST /v1/users/:userId/roles',
  unknown_user: 'no such user; the account must already exist',
  bot_account: 'refusing to promote a bot account',
} as const;

async function main(): Promise<void> {
  const [userId = '', operator = ''] = process.argv.slice(2);
  const pool = createPool({ max: 1 });
  try {
    const outcome = await bootstrapFirstAdmin(pool, userId, operator);
    if (outcome.kind === 'refused') throw new Error(REFUSALS[outcome.reason]);
    console.log(JSON.stringify({ granted: true, userId: outcome.userId }));
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
