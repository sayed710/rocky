/**
 * Real PostgreSQL: a role with CREATE on `public` plants `public.hashtextextended(text, integer)`,
 * a better match than pg_catalog's `(text, bigint)` for the literal 0 the adapters used to pass.
 * The unqualified expression demonstrably runs the planted code with the caller's rights; the
 * adapters' qualified calls never do, and they still take the same lock keys.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Game } from '@chess-platform/game';
import { migrate } from '../src/pg/migrate';
import { lockPlayerPair } from '../src/pg/pair-lock';
import { lockGameCreationPlayers } from '../src/pg/event-store';
import { PgSessionsRepository } from '../src/pg/repositories';
import { withTestDatabase } from '../src/test-support/database';

const migrationsDir = [
  join(__dirname, '../../migrations'),
  join(__dirname, '../migrations'),
  join(process.cwd(), 'migrations'),
  join(process.cwd(), 'packages/persistence/migrations'),
].find((d) => existsSync(d))!;

const W = '018f2780-0000-7000-8000-0000000000d1';
const B = '018f2780-0000-7000-8000-0000000000d2';

test('planted public overloads never run through the adapters advisory locks', async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, migrationsDir);
    await pool.query(
      `INSERT INTO users (id, handle, email, email_verified_at, created_at)
       VALUES ($1, 'lock_w', 'lock_w@example.com', NOW(), NOW()), ($2, 'lock_b', 'lock_b@example.com', NOW(), NOW())`,
      [W, B],
    );
    await pool.query('CREATE TABLE public.planted_calls (who name); GRANT INSERT ON public.planted_calls TO PUBLIC');
    const role = `planter_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(12).toString('hex');
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    let attacker: Pool | null = null;
    try {
      await pool.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
      const url = new URL(connectionString);
      url.username = role;
      url.password = password;
      attacker = new Pool({ connectionString: url.toString(), max: 1 });
      await attacker.query(`CREATE FUNCTION public.hashtextextended(t text, s integer) RETURNS bigint LANGUAGE plpgsql AS $f$
        BEGIN INSERT INTO public.planted_calls VALUES (current_user); RETURN 1; END $f$`);
      const planted = async () => Number((await pool.query('SELECT count(*) AS n FROM public.planted_calls')).rows[0].n);

      // Control: the pre-fix expression is captured by the planted overload, as the caller.
      await pool.query("SELECT pg_advisory_xact_lock(hashtextextended('rocky:active-human-game:' || $1, 0))", [W]);
      assert.equal(await planted(), 1, 'the unqualified call resolves to the planted overload');
      assert.equal((await pool.query('SELECT who FROM public.planted_calls')).rows[0].who, (await pool.query('SELECT current_user AS u')).rows[0].u);
      await pool.query('DELETE FROM public.planted_calls');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockPlayerPair(client, W, B);
        const created = Game.create({
          gameId: '018f2780-0000-7000-8000-0000000000d3',
          players: { white: W, black: B },
          timeControl: { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 },
          rated: false,
          at: 1000,
        });
        await lockGameCreationPlayers(client, created.events);
        // The locks are the same keys as before the change: the pg_catalog value is what they hold.
        const held = await client.query(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()
             AND ((classid::bigint << 32) | objid::bigint) IN (
               pg_catalog.hashtextextended('rocky:active-human-game:' || $1::text, 0::bigint),
               pg_catalog.hashtextextended('rocky:active-human-game:' || $2::text, 0::bigint))`,
          [W, B],
        );
        assert.equal(held.rows[0].n, 2, 'both player keys are held');
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      await new PgSessionsRepository(pool).revokeAllForUser(W, new Date());

      assert.equal(await planted(), 0, 'no planted code ran through the adapters');
    } finally {
      await attacker?.end();
      await pool.query(`DROP OWNED BY ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  });
});
