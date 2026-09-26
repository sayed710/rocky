/**
 * @packageDocumentation
 * CLI entry point: `npm run games:rebuild`. Re-folds every game stream in `game_events` into
 * `games` using `DATABASE_URL` (ADR-0147). Repeatable, and safe while gateways project live games.
 * Exits non-zero when any stream could not be projected; those stay in `games_projection_failures`.
 */

import { createPool } from './pool';
import { PgGamesProjector } from './games-projector';

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const { projected, deferred, failures } = await new PgGamesProjector(pool).rebuildAll();
    // eslint-disable-next-line no-console
    console.log(`projected ${projected} game(s); ${deferred} left to the live projector; ${failures.length} failed`);
    for (const failure of failures) {
      // eslint-disable-next-line no-console
      console.error(`game ${failure.gameId}: ${failure.error}`);
    }
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
