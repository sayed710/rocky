/** Lobby match receipts use committed endings even while the games projector is stopped. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Game, type GameEvent } from '@chess-platform/game';
import { uuidv7 } from '@chess-platform/persistence';
import { migrate, PgSeekAcceptor, PgSeeksRepository, PgUsersRepository, PostgresEventStore } from '@chess-platform/persistence/pg';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { createPgDependencies } from '../src/bootstrap';
import { createApiServer } from '../src/server';
import { InMemoryEmailSender } from '../src/ports/email';
import { JsonLogger } from '../src/ports/logger';
import { closeServer, listenOnFetchablePort } from './listen';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(process.cwd(), '../persistence/migrations');
const TC = { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 } as const;
const FOOLS_MATE = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];

/** Produce normal domain events for each terminal path without introducing a projector. */
function endingEvents(game: Game, ending: 'resignation' | 'aborted' | 'checkmate'): GameEvent[] {
  if (ending === 'resignation') return game.resign('w', 2_000).events;
  if (ending === 'aborted') return game.abort(2_000).events;
  const events: GameEvent[] = [];
  for (const [index, uci] of FOOLS_MATE.entries()) {
    const step = game.playMove(uci, 2_000 + index);
    events.push(...step.events);
    game = step.game;
  }
  return events;
}

// Boundary matrix: stale projection, three terminal causes,
// anonymous/other-account reads, unrelated/rolled-back endings, and an open-seek limit of one.
for (const ending of ['resignation', 'aborted', 'checkmate'] as const) {
  test(`GET seeks suppresses ${ending} before projection without hiding live or open seeks`, { skip }, async () => {
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, MIGRATIONS);
      const users = new PgUsersRepository(pool);
      const creator = await users.create({ id: uuidv7(), handle: `rc_${uuidv7().slice(-12)}` });
      const opponent = await users.create({ id: uuidv7(), handle: `ro_${uuidv7().slice(-12)}` });
      const seeks = new PgSeeksRepository(pool);
      const seek = await seeks.create({ id: uuidv7(), creatorId: creator.id, variant: 'standard', timeControl: TC, rated: false });
      const gameId = uuidv7();
      const created = Game.create({ gameId, variant: 'standard', timeControl: TC, players: { white: creator.id, black: opponent.id }, rated: false, at: 1_000 });
      await new PgSeekAcceptor(pool).accept(seek.id, gameId, created.events, {
        id: gameId, variant: 'standard', rated: false, speed: 'blitz',
        whiteId: creator.id, blackId: opponent.id, startedAt: new Date(1_000),
      });
      const open = await seeks.create({ id: uuidv7(), creatorId: opponent.id, variant: 'standard', timeControl: TC, rated: false });

      const composition = createPgDependencies({
        pool, logger: new JsonLogger({}, { level: 'error', sink: () => {} }),
        emailSender: new InMemoryEmailSender(),
        config: { accessTokenSecret: 'test-access-token-secret-0123456789abcdef' },
      });
      const api = createApiServer(composition.deps);
      const listening = await listenOnFetchablePort((port, host) => api.listen(port, host), '127.0.0.1');
      const creatorToken = composition.deps.tokens.issue({ userId: creator.id, handle: creator.handle, roles: ['user'] }).token;
      const opponentToken = composition.deps.tokens.issue({ userId: opponent.id, handle: opponent.handle, roles: ['user'] }).token;
      const list = async (token?: string): Promise<{ id: string; gameId: string | null }[]> => {
        const response = await fetch(`http://127.0.0.1:${listening.port}/v1/seeks?limit=1`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        assert.equal(response.status, 200);
        return await response.json() as { id: string; gameId: string | null }[];
      };
      try {
        assert.deepEqual((await list(creatorToken)).map(({ id }) => id), [seek.id, open.id], 'live receipt is outside the open-seek limit');
        assert.deepEqual((await list()).map(({ id }) => id), [open.id], 'anonymous callers see no private receipt');
        assert.deepEqual((await list(opponentToken)).map(({ id }) => id), [open.id], 'another account sees no creator receipt');

        const store = new PostgresEventStore(pool);
        const unrelatedId = uuidv7();
        const unrelated = Game.create({ gameId: unrelatedId, variant: 'standard', timeControl: TC, players: { white: creator.id, black: opponent.id }, rated: false, at: 1_000 });
        await store.append(unrelatedId, -1, [...unrelated.events, ...unrelated.game.abort(2_000).events]);
        assert.deepEqual((await list(creatorToken)).map(({ id }) => id), [seek.id, open.id], 'another game ending must not suppress this live receipt');

        const uncommitted = await pool.connect();
        try {
          await uncommitted.query('BEGIN');
          const terminal = endingEvents(created.game, ending).find((event) => event.type === 'GameEnded');
          assert.ok(terminal);
          await uncommitted.query("INSERT INTO game_events (game_id, seq, type, payload) VALUES ($1, 1, 'GameEnded', $2::jsonb)", [gameId, JSON.stringify(terminal)]);
          assert.equal((await uncommitted.query("SELECT 1 FROM game_events WHERE game_id = $1 AND type = 'GameEnded'", [gameId])).rowCount, 1);
          assert.deepEqual((await list(creatorToken)).map(({ id }) => id), [seek.id, open.id], 'uncommitted ending is invisible to the independent REST connection');
        } finally {
          try { await uncommitted.query('ROLLBACK'); }
          finally { uncommitted.release(); }
        }
        assert.deepEqual((await list(creatorToken)).map(({ id }) => id), [seek.id, open.id], 'rolled-back ending does not suppress a live receipt');

        await store.append(gameId, 0, endingEvents(created.game, ending));
        assert.equal((await store.load(gameId)).at(-1)?.event.type, 'GameEnded');
        const projection = await pool.query<{ ended_at: Date | null }>('SELECT ended_at FROM games WHERE id = $1', [gameId]);
        assert.equal(projection.rows[0]?.ended_at ?? null, null, 'no projector has observed the ending');
        assert.deepEqual((await list(creatorToken)).map(({ id }) => id), [open.id], 'the committed ending suppresses the receipt immediately');
        assert.deepEqual((await list(opponentToken)).map(({ id }) => id), [open.id]);
      } finally {
        await closeServer(listening.server);
        await composition.shutdownAnalysis();
      }
    });
  });
}
