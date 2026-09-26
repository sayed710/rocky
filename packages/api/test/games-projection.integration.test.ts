/** Projection-dependent API reads become truthful once the event-log projector runs (ADR-0147). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Game } from '@chess-platform/game';
import { uuidv7 } from '@chess-platform/persistence';
import { migrate, PgGamesProjector, PgUsersRepository, PostgresEventStore } from '@chess-platform/persistence/pg';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { createPgApiServer } from '../src/bootstrap';
import { InMemoryEmailSender } from '../src/ports/email';
import { JsonLogger } from '../src/ports/logger';
import { DurableGameLauncher } from '../src/tournament/durable-launcher';
import { closeServer, listenOnFetchablePort } from './listen';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(process.cwd(), '../persistence/migrations');
const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;

/** Project until `ready` holds: the horizon is cluster-wide, so another database's transaction can delay it briefly. */
async function projectUntil(projector: PgGamesProjector, ready: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    await projector.runBatch();
    if (await ready()) return;
    if (Date.now() > deadline) throw new Error('projection did not catch up within 30 s');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a tournament game gains a row, and its projected ending is served by /v1/games/:id and user history', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const users = new PgUsersRepository(pool);
    const white = uuidv7();
    const black = uuidv7();
    await users.create({ id: white, handle: `tw_${white.slice(-12)}` });
    await users.create({ id: black, handle: `tb_${black.slice(-12)}` });

    const store = new PostgresEventStore(pool);
    const { gameId } = await new DurableGameLauncher(store, { now: () => 10_000 }).launch({
      tournamentId: uuidv7(), matchId: 'm1', white, black, variant: 'standard', timeControl: TC, attempt: 0,
    });
    const composed = createPgApiServer({
      pool,
      logger: new JsonLogger({}, { level: 'error', sink: () => {} }),
      emailSender: new InMemoryEmailSender(),
      config: { accessTokenSecret: 'test-access-token-secret-0123456789abcdef' },
    });
    const listening = await listenOnFetchablePort((p, h) => composed.server.listen(p, h), '127.0.0.1');
    const url = `http://127.0.0.1:${listening.port}`;
    const get = async (path: string) => {
      const response = await fetch(`${url}${path}`);
      return { status: response.status, body: await response.json() as Record<string, unknown> & unknown[] };
    };
    try {
      assert.equal((await get(`/v1/games/${gameId}`)).status, 404, 'on main a tournament game never had a row');

      const projector = new PgGamesProjector(pool);
      await projectUntil(projector, async () => (await get(`/v1/games/${gameId}`)).status === 200);
      const started = await get(`/v1/games/${gameId}`);
      assert.equal(started.status, 200);
      assert.equal(started.body['rated'], true);
      assert.equal(started.body['speed'], 'bullet');
      assert.equal(started.body['startedAt'], new Date(10_000).toISOString());

      const game = Game.fromEvents((await store.load(gameId)).map((e) => e.event));
      await store.append(gameId, 0, game.resign('w', 12_345).events);
      await projectUntil(projector, async () => (await get(`/v1/games/${gameId}`)).body['result'] !== null);

      const finished = await get(`/v1/games/${gameId}`);
      assert.equal(finished.status, 200);
      assert.equal(finished.body['result'], '0-1');
      assert.equal(finished.body['termination'], 'resignation');
      assert.equal(finished.body['endedAt'], new Date(12_345).toISOString());

      const history = await get(`/v1/users/tw_${white.slice(-12)}/games`);
      assert.equal(history.status, 200);
      assert.deepEqual(history.body, [finished.body], 'history reads the same projected row');
    } finally {
      await closeServer(listening.server);
      await composed.shutdownAnalysis();
    }
  });
});
