/**
 * Durable adjudication through the live gateway authority on real PostgreSQL (Issue #124, ADR-0176):
 * a player's command is admitted as an obligation, the room sees the game proving, the worker
 * settles it and the owner publishes the move and the stop, the release starts the clocks, and the
 * next command is adjudicated again. Gated behind DATABASE_URL; zero-skip in CI.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Game, type GameEvent } from '@chess-platform/game';
import {
  ADJUDICATION_ACTOR,
  AuthorityError,
  GameAuthority,
  InMemoryPubSub,
  LocalCommandRouter,
  gameChannel,
  type AdjudicationAdmission,
  type Broadcast,
} from '@chess-platform/realtime-gateway';
import { PgAdjudicationStore, PostgresEventStore, migrate, migrationsDir } from '@chess-platform/persistence/pg';
import { withTestDatabase, type TestDatabase } from '@chess-platform/persistence/test-support';
import { AdjudicationWorker, routedAdjudicationChange } from '../src/adjudication-worker.js';

type Pool = TestDatabase['pool'];

const DATABASE_URL = process.env['DATABASE_URL'];
const pgTest = (name: string, fn: () => Promise<void>): void => {
  (DATABASE_URL ? test : test.skip)(name, { timeout: 120_000 }, fn);
};

const FEN_MATE1 = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';

async function seed(pool: Pool, initialFen?: string): Promise<{ gameId: string; white: string; black: string }> {
  await migrate(pool, migrationsDir());
  const white = randomUUID();
  const black = randomUUID();
  const gameId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, handle, email, email_verified_at, created_at)
     VALUES ($1, 'white_player', 'white@example.com', NOW(), NOW()), ($2, 'black_player', 'black@example.com', NOW(), NOW())`,
    [white, black],
  );
  const created = Game.create({
    gameId, players: { white, black },
    timeControl: { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 },
    rated: false, at: 1000, ...(initialFen ? { initialFen } : {}),
  });
  await pool.query(
    `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at) VALUES ($1, 'standard', false, 'blitz', $2, $3, NOW())`,
    [gameId, white, black],
  );
  await pool.query(
    `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, 'GameCreated', 1, $2::jsonb)`,
    [gameId, JSON.stringify(created.events[0])],
  );
  return { gameId, white, black };
}

function stack(pool: Pool, clock: { now: number }) {
  const pubsub = new InMemoryPubSub();
  const adjudicationStore = new PgAdjudicationStore(pool);
  const admission: AdjudicationAdmission = {
    rulesVersion: 'rocky-adjudication@1',
    clockPolicy: 'observed-release-v1',
    start: (params) => adjudicationStore.startAdjudication(params),
  };
  const authority = new GameAuthority(pubsub, () => clock.now, new PostgresEventStore(pool), { adjudication: admission });
  const router = new LocalCommandRouter(authority);
  const worker = new AdjudicationWorker({
    store: adjudicationStore,
    executorId: randomUUID(),
    sliceBudget: 5_000,
    releaseGraceMs: 0,
    now: () => clock.now,
    publish: routedAdjudicationChange({ authority, router, hasLocalSessions: () => true }),
  });
  return { pubsub, authority, router, worker };
}

async function types(pool: Pool, gameId: string): Promise<string[]> {
  return (await pool.query('SELECT type FROM game_events WHERE game_id = $1 ORDER BY seq', [gameId])).rows.map((r) => r.type as string);
}

pgTest('a command is proved, settled, published, released and the next one adjudicated again', async () => {
  await withTestDatabase(async ({ pool }) => {
    const { gameId, white, black } = await seed(pool, FEN_MATE1);
    const clock = { now: 2000 };
    const { pubsub, authority, router, worker } = stack(pool, clock);
    const room: Broadcast[] = [];
    pubsub.subscribe(gameChannel(gameId), (msg) => room.push(msg));
    assert.equal(await authority.ensureLoaded(gameId), true);
    assert.equal(authority.getState(gameId).adjudication, undefined, 'an unadjudicated view is unchanged');

    // White plays: only AdjudicationStarted is durable, and the room sees the game proving.
    const admitted = await router.route(gameId, white, { kind: 'move', uci: 'e7e4' });
    assert.deepEqual(admitted.events.map((e) => e.type), ['AdjudicationStarted']);
    assert.equal(authority.getState(gameId).adjudication, 'proving');
    assert.deepEqual(room.map((m) => m.t), ['state']);
    await assert.rejects(router.route(gameId, black, { kind: 'resign' }), (err: unknown) => err instanceof AuthorityError);

    // The worker settles; the owner publishes the move and the stopped clocks, then the release.
    clock.now = 2500;
    const pass = await worker.runPass();
    assert.deepEqual({ settled: pass.settled, released: pass.released, failed: pass.failed }, { settled: 1, released: 1, failed: 0 });
    assert.deepEqual((await types(pool, gameId)).slice(1), ['AdjudicationStarted', 'AdjudicationResolved', 'MovePlayed', 'AdjudicationClocksStarted']);
    const kinds = room.map((m) => m.t);
    assert.deepEqual(kinds, ['state', 'move', 'state', 'state']);
    const stopped = room[2] as Extract<Broadcast, { t: 'state' }>;
    assert.equal(stopped.state.adjudication, 'stopped');
    assert.equal(stopped.state.turnStartedAt, null, 'stopped clocks do not run');
    const released = room[3] as Extract<Broadcast, { t: 'state' }>;
    assert.equal(released.state.adjudication, undefined);
    assert.equal(released.state.turn, 'b');

    // The owner's copy equals a cold replay of the durable log.
    const logged = (await pool.query('SELECT payload FROM game_events WHERE game_id = $1 ORDER BY seq', [gameId])).rows.map((r) => r.payload as GameEvent);
    assert.equal(authority.getState(gameId).fen, Game.fromEvents(logged).fen);
    assert.equal(authority.getState(gameId).stateRevision, logged.length - 1);

    // Black's next command is adjudicated again, never appended raw.
    clock.now = 3000;
    const next = await router.route(gameId, black, { kind: 'move', uci: 'h8g8' });
    assert.deepEqual(next.events.map((e) => e.type), ['AdjudicationStarted']);
    assert.equal(authority.getState(gameId).adjudication, 'proving');
    assert.equal((await types(pool, gameId)).at(-1), 'AdjudicationStarted');

    // Only the server may report an adjudication.
    await assert.rejects(router.route(gameId, white, { kind: 'adjudicationChanged' }), (err: unknown) => err instanceof AuthorityError && err.code === 'not_a_player');
    await router.route(gameId, ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });
  });
});

pgTest('a cold owner rebuilds an adjudicated game, its release included, from the durable log', async () => {
  await withTestDatabase(async ({ pool }) => {
    const { gameId, white } = await seed(pool, FEN_MATE1);
    const clock = { now: 2000 };
    const first = stack(pool, clock);
    await first.authority.ensureLoaded(gameId);
    await first.router.route(gameId, white, { kind: 'move', uci: 'e7e4' });
    clock.now = 2500;
    await first.worker.runPass();

    const cold = new GameAuthority(new InMemoryPubSub(), () => clock.now, new PostgresEventStore(pool));
    assert.equal(await cold.ensureLoaded(gameId), true);
    const state = cold.getState(gameId);
    assert.equal(state.fen, first.authority.getState(gameId).fen);
    assert.equal(state.stateRevision, first.authority.getState(gameId).stateRevision);
    assert.equal(state.adjudication, undefined);
    assert.deepEqual(cold.getMissedSince(gameId, 0).map((m) => m.t), ['move']);
  });
});
