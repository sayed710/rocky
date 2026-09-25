import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Game } from '@chess-platform/game';
import { uuidv7 } from '@chess-platform/persistence';
import { migrate, PostgresEventStore, PgBotBehaviorReportRepository, PgTerminalEventInbox, PgTournamentsRepository, createPool } from '@chess-platform/persistence/pg';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { GameAuthority, InMemoryPubSub, gameChannel } from '@chess-platform/realtime-gateway';
import type { Pool } from 'pg';
import { ArenaService } from '../src/tournament/arena.service';
import { DurableGameLauncher } from '../src/tournament/durable-launcher';
import { TournamentService } from '../src/tournament/service';
import { TournamentResultReporter } from '../src/tournament/reporter';
import { TerminalEventReconciler } from '../src/terminal-event-reconciler';
import { BotAnalysisService } from '../src/bot-detection/analysis-service';
import { EventStoreBotTimingSource } from '../src/bot-detection/source';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(__dirname, '..', '..', '..', 'persistence', 'migrations');
const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;

function reporterFor(pool: Pool): {
  readonly store: PostgresEventStore;
  readonly repo: PgTournamentsRepository;
  readonly arena: ArenaService;
  readonly tournament: TournamentService;
  readonly reporter: TournamentResultReporter;
} {
  const store = new PostgresEventStore(pool);
  const repo = new PgTournamentsRepository(pool);
  const launcher = new DurableGameLauncher(store, { now: () => 1_000 });
  const arena = new ArenaService(repo, launcher, () => 1_000);
  const tournament = new TournamentService(repo, launcher);
  const reporter = new TournamentResultReporter(new InMemoryPubSub(), repo, tournament, arena, store, { scanIntervalMs: 0 });
  return { store, repo, arena, tournament, reporter };
}

async function startArena(arena: ArenaService): Promise<{ tournamentId: string; gameId: string }> {
  const tournamentId = uuidv7();
  await arena.create({ id: tournamentId, name: 'recovery', variant: 'standard', timeControl: TC, durationMs: 60_000 });
  await arena.register(tournamentId, uuidv7());
  await arena.register(tournamentId, uuidv7());
  await arena.start(tournamentId, 1_000);
  const snapshot = await arena.load(tournamentId);
  const gameId = snapshot.toSnapshot().gameLinks?.[0]?.[1];
  assert.ok(gameId, 'the arena must launch a durable game before this test can end it');
  return { tournamentId, gameId };
}

async function commitEnding(store: PostgresEventStore, gameId: string, abort = false): Promise<void> {
  const stored = await store.load(gameId);
  const game = Game.fromEvents(stored.map(({ event }) => event));
  const { events } = abort ? game.abort(2_000) : game.resign('b', 2_000);
  assert.equal(events.at(-1)?.type, 'GameEnded');
  await store.append(gameId, stored.at(-1)!.seq, events);
}

test('lost notification, restart and two reporters converge on one committed arena result', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, MIGRATIONS);
    const replicaPool = createPool({ connectionString, max: 4 });
    const first = reporterFor(pool);
    const second = reporterFor(replicaPool);
    try {
      const { tournamentId, gameId } = await startArena(first.arena);
      await commitEnding(first.store, gameId);
      for (let n = 0; n < 101; n += 1) {
        await first.arena.create({ id: uuidv7(), name: `later-${n}`, variant: 'standard', timeControl: TC, durationMs: 60_000 });
      }
      assert.equal((await first.repo.list(100)).some(({ id }) => id === tournamentId), false);

      // Neither reporter receives a broadcast. Independent processes scan the same committed row.
      await Promise.all([first.reporter.start(), second.reporter.start()]);
      const standings = await first.arena.getStandings(tournamentId);
      assert.equal(standings.filter(({ gamesPlayed }) => gamesPlayed === 1).length, 2);
      assert.equal(standings.filter(({ wins }) => wins === 1).length, 1);

      first.reporter.stop();
      second.reporter.stop();
      const restarted = reporterFor(pool);
      await restarted.reporter.start();
      const afterRestart = await restarted.arena.getStandings(tournamentId);
      assert.deepEqual(afterRestart, standings, 'replay after a committed effect must not award again');
      restarted.reporter.stop();
    } finally {
      first.reporter.stop();
      second.reporter.stop();
      await first.store.closePlayerLocks();
      await second.store.closePlayerLocks();
      await replicaPool.end();
    }
  }, { connectionString: process.env['DATABASE_URL'] });
});

test('duplicate recovery of an aborted arena game launches exactly one replacement', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, MIGRATIONS);
    const first = reporterFor(pool);
    const second = reporterFor(pool);
    try {
      const { tournamentId, gameId } = await startArena(first.arena);
      await commitEnding(first.store, gameId, true);
      await Promise.all([first.reporter.start(), second.reporter.start()]);
      const links = (await first.arena.load(tournamentId)).toSnapshot().gameLinks ?? [];
      assert.equal(links.length, 1);
      assert.notEqual(links[0]![1], gameId);
      assert.equal(await first.store.exists(links[0]![1]), true);
      await Promise.all([first.reporter.scan(), second.reporter.scan()]);
      assert.deepEqual((await first.arena.load(tournamentId)).toSnapshot().gameLinks, links);
    } finally {
      first.reporter.stop();
      second.reporter.stop();
      await first.store.closePlayerLocks();
      await second.store.closePlayerLocks();
    }
  }, { connectionString: process.env['DATABASE_URL'] });
});

test('two reporters recover one committed round-based result without double scoring', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, MIGRATIONS);
    const replicaPool = createPool({ connectionString, max: 4 });
    const first = reporterFor(pool);
    const second = reporterFor(replicaPool);
    try {
      const tournamentId = uuidv7();
      await first.tournament.create({ id: tournamentId, name: 'round recovery', format: 'round_robin', variant: 'standard', timeControl: TC });
      await first.tournament.register(tournamentId, uuidv7());
      await first.tournament.register(tournamentId, uuidv7());
      await first.tournament.start(tournamentId);
      const gameId = (await first.tournament.load(tournamentId)).toSnapshot().gameLinks?.[0]?.[1];
      assert.ok(gameId, 'starting the round must durably launch the pairing');
      await commitEnding(first.store, gameId);

      await Promise.all([first.reporter.start(), second.reporter.start()]);
      const result = await first.tournament.load(tournamentId);
      assert.equal(result.resultFor(0, 0), 'white_win');
      const standings = result.standings();
      assert.equal(standings.filter(({ points }) => points > 0).length, 1);
      await Promise.all([first.reporter.scan(), second.reporter.scan()]);
      const replayed = await first.tournament.load(tournamentId);
      assert.deepEqual(replayed.standings(), standings);
      assert.equal(replayed.resultFor(0, 0), 'white_win');
    } finally {
      first.reporter.stop();
      second.reporter.stop();
      await first.store.closePlayerLocks();
      await second.store.closePlayerLocks();
      await replicaPool.end();
    }
  }, { connectionString: process.env['DATABASE_URL'] });
});

test('terminal inbox replays a missed ending, receipts survive restart and replicas may race', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const store = new PostgresEventStore(pool);
    const first = new PgTerminalEventInbox(pool);
    const second = new PgTerminalEventInbox(pool);
    try {
      const gameId = uuidv7();
      const { events } = Game.create({ gameId, variant: 'standard', players: { white: uuidv7(), black: uuidv7() }, timeControl: TC, rated: false, at: 1_000 });
      await store.append(gameId, -1, events);
      await commitEnding(store, gameId);
      assert.equal((await first.pendingAfter('test-consumer', null, 100)).length, 1);

      const analysis = new BotAnalysisService(new EventStoreBotTimingSource(store), new PgBotBehaviorReportRepository(pool));
      let calls = 0;
      const handler = async (endedGameId: string) => {
        calls += 1;
        assert.ok(await analysis.analyzeAndStore(endedGameId));
      };
      const makeWorker = (inbox: PgTerminalEventInbox) => new TerminalEventReconciler(
        new InMemoryPubSub(), inbox, 'test-consumer', handler, { scanIntervalMs: 0 },
      );
      const workers = [makeWorker(first), makeWorker(second)];
      await Promise.all(workers.map((worker) => worker.start()));
      assert.ok(calls >= 1, 'a committed ending must be processed without pub/sub');
      assert.equal((await pool.query('SELECT 1 FROM bot_reports WHERE game_id = $1', [gameId])).rowCount, 2);
      assert.deepEqual(await first.pendingAfter('test-consumer', null, 100), []);
      await handler(gameId);
      assert.equal((await pool.query('SELECT 1 FROM bot_reports WHERE game_id = $1', [gameId])).rowCount, 2, 'replay upserts, not duplicates');
      const beforeRestart = calls;
      await makeWorker(first).start();
      assert.equal(calls, beforeRestart, 'the durable receipt survives worker restart');
      workers.forEach((worker) => worker.stop());
    } finally {
      await store.closePlayerLocks();
    }
  }, { connectionString: process.env['DATABASE_URL'] });
});

test('a failed terminal consumer remains pending and a restarted worker retries it', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const store = new PostgresEventStore(pool);
    const inbox = new PgTerminalEventInbox(pool);
    try {
      const gameId = uuidv7();
      const { events } = Game.create({ gameId, variant: 'standard', players: { white: uuidv7(), black: uuidv7() }, timeControl: TC, rated: false, at: 1_000 });
      await store.append(gameId, -1, events);
      await commitEnding(store, gameId);

      const failed = new TerminalEventReconciler(new InMemoryPubSub(), inbox, 'retry-test', async () => {
        throw new Error('injected downstream failure');
      }, { scanIntervalMs: 0, onError: () => undefined });
      await failed.start();
      assert.equal((await inbox.pendingAfter('retry-test', null, 100)).length, 1);
      failed.stop();

      let recovered = 0;
      const restarted = new TerminalEventReconciler(new InMemoryPubSub(), inbox, 'retry-test', async () => {
        recovered += 1;
      }, { scanIntervalMs: 0 });
      await restarted.start();
      assert.equal(recovered, 1);
      assert.equal((await inbox.pendingAfter('retry-test', null, 100)).length, 0);
      restarted.stop();
    } finally {
      await store.closePlayerLocks();
    }
  }, { connectionString: process.env['DATABASE_URL'] });
});

test('a PostgreSQL sequence loser reloads the winning terminal state without broadcasting', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const writerStore = new PostgresEventStore(pool);
    const staleStore = new PostgresEventStore(pool);
    const writer = new GameAuthority(new InMemoryPubSub(), () => 1_000, writerStore);
    const stalePubsub = new InMemoryPubSub();
    const stale = new GameAuthority(stalePubsub, () => 1_000, staleStore);
    const gameId = uuidv7();
    const white = uuidv7();
    const black = uuidv7();
    try {
      await writer.createGame({ gameId, variant: 'standard', players: { white, black }, timeControl: TC, rated: false });
      await stale.ensureLoaded(gameId);
      let falseBroadcasts = 0;
      stalePubsub.subscribe(gameChannel(gameId), () => { falseBroadcasts += 1; });
      await writer.apply(gameId, black, { kind: 'resign' });
      await assert.rejects(stale.apply(gameId, white, { kind: 'move', uci: 'e2e4' }));
      assert.equal(stale.getState(gameId).status.over, true);
      assert.equal(falseBroadcasts, 0);
      assert.equal((await staleStore.load(gameId)).filter(({ event }) => event.type === 'GameEnded').length, 1);
    } finally {
      await writerStore.closePlayerLocks();
      await staleStore.closePlayerLocks();
    }
  }, { connectionString: process.env['DATABASE_URL'] });
});
