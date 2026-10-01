/** Tournament launches converge on the real event store, and refuse a slot taken by another pairing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { migrate, PostgresEventStore } from '@chess-platform/persistence/pg';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { DurableGameLauncher } from '../src/tournament/durable-launcher';
import type { LaunchInput } from '../src/tournament/launcher';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';

test('a stored launch is recognized after a JSONB round trip, and another pairing cannot take its slot', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const events = new PostgresEventStore(pool);
    // Keys deliberately out of the order JSONB stores them in.
    const input: LaunchInput = {
      tournamentId: 't-pg', matchId: 'a:1', white: '00000000-0000-7000-8000-00000000000a', black: '00000000-0000-7000-8000-00000000000b',
      variant: 'standard', timeControl: { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 }, attempt: 0,
    };
    const [a, b] = await Promise.all([
      new DurableGameLauncher(events, { now: () => 1 }).launch(input),
      new DurableGameLauncher(events, { now: () => 1 }).launch(input),
    ]);
    assert.equal(a.gameId, b.gameId);
    assert.deepEqual(await new DurableGameLauncher(events, { now: () => 2 }).launch(input), a);
    await assert.rejects(
      new DurableGameLauncher(events, { now: () => 2 }).launch({ ...input, white: '00000000-0000-7000-8000-00000000000c' }),
      /different game/,
    );
  });
});
