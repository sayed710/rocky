/**
 * Adjudicated play under load, on real PostgreSQL (Issue #124, ADR-0176): two replicas share one
 * database, each with its own authority (the owner of half the games), worker and resync. Concurrent
 * games play random legal moves at human-like intervals while the harness measures what a player
 * waits for, and injects the failures the design must survive: a worker that dies holding claims,
 * lost COMMIT replies, and an owner that restarts cold. At the end every game must replay exactly
 * from the log and be neither proving nor stopped.
 *
 * Scale with SOAK_GAMES / SOAK_PLIES / SOAK_THINK_MS (defaults are small enough for CI). Gated
 * behind DATABASE_URL; zero-skip in CI.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Game, type GameEvent } from '@chess-platform/game';
import {
  GameAuthority,
  InMemoryPubSub,
  gameChannel,
  type Broadcast,
  type Command,
  type CommandRouter,
} from '@chess-platform/realtime-gateway';
import { PgAdjudicationStore, PostgresEventStore, migrate, migrationsDir } from '@chess-platform/persistence/pg';
import { withTestDatabase, type TestDatabase } from '@chess-platform/persistence/test-support';
import { AdjudicationWorker, routedAdjudicationChange } from '../src/adjudication-worker.js';
import { AdjudicationResync } from '../src/adjudication-resync.js';

type Pool = TestDatabase['pool'];

const DATABASE_URL = process.env['DATABASE_URL'];
const GAMES = Number(process.env['SOAK_GAMES'] ?? 6);
const PLIES = Number(process.env['SOAK_PLIES'] ?? 16);
const THINK_MS = Number(process.env['SOAK_THINK_MS'] ?? 150);
const soakTest = (name: string, fn: () => Promise<void>): void => {
  (DATABASE_URL ? test : test.skip)(name, { timeout: 900_000 }, fn);
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

/** A pool whose COMMIT reply is lost (the transaction commits, the caller sees an error) at `rate`. */
function lossyCommits(pool: Pool, rate: () => number, counter: { lost: number }): Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') return target.query.bind(target);
      if (prop !== 'connect') return Reflect.get(target, prop, receiver);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(c, p, r) {
            if (p !== 'query') return Reflect.get(c, p, r);
            return async (sql: unknown, ...rest: unknown[]) => {
              const res = await (c.query as (...a: unknown[]) => Promise<unknown>).call(c, sql, ...rest);
              if (sql === 'COMMIT' && Math.random() < rate()) {
                counter.lost++;
                throw new Error('connection lost after COMMIT');
              }
              return res;
            };
          },
        });
      };
    },
  }) as Pool;
}

interface Replica {
  authority: GameAuthority;
  worker: AdjudicationWorker;
  resync: AdjudicationResync;
  store: PgAdjudicationStore;
}

soakTest('adjudicated play under load survives worker death, lost replies and an owner restart', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const pubsub = new InMemoryPubSub();
    const lossRate = { value: 0 };
    const lost = { lost: 0 };
    const lossy = lossyCommits(pool, () => lossRate.value, lost);

    // --- games ---
    const tc = { kind: 'increment' as const, initialMs: 300_000, incrementMs: 2_000, delayMs: 0 };
    const games: Array<{ id: string; white: string; black: string; owner: number }> = [];
    for (let g = 0; g < GAMES; g++) {
      const white = randomUUID();
      const black = randomUUID();
      const id = randomUUID();
      await pool.query(
        `INSERT INTO users (id, handle, email, email_verified_at, created_at) VALUES ($1, $3, $4, NOW(), NOW()), ($2, $5, $6, NOW(), NOW())`,
        [white, black, `w${g}`, `w${g}@example.com`, `b${g}`, `b${g}@example.com`],
      );
      await pool.query(
        `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at) VALUES ($1, 'standard', false, 'blitz', $2, $3, NOW())`,
        [id, white, black],
      );
      const created = Game.create({ gameId: id, players: { white, black }, timeControl: tc, rated: false, at: Date.now() });
      await pool.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, 'GameCreated', 1, $2::jsonb)`,
        [id, JSON.stringify(created.events[0])]);
      games.push({ id, white, black, owner: g % 2 });
    }

    // --- replicas ---
    const replicas: Replica[] = [];
    const ownerOf = (gameId: string) => games.find((g) => g.id === gameId)!.owner;
    const router: CommandRouter = { route: (gameId: string, userId: string, cmd: Command) => replicas[ownerOf(gameId)]!.authority.apply(gameId, userId, cmd) };
    const phases = new Map<string, number[]>();
    const timed = (store: PgAdjudicationStore): PgAdjudicationStore => {
      for (const name of ['listClaimableAdjudications', 'listReleasableStops', 'claimAdjudication', 'renewAdjudication', 'createProofJob', 'stepProofJob', 'settleAdjudication', 'releaseClocks', 'startAdjudication'] as const) {
        const orig = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!.bind(store);
        (store as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
          const t0 = performance.now();
          const done = () => { const xs = phases.get(name) ?? []; xs.push(performance.now() - t0); phases.set(name, xs); };
          const out = orig(...args);
          if (out instanceof Promise) return out.finally(done);
          done();
          return out;
        };
      }
      return store;
    };
    const makeReplica = (): Replica => {
      const store = timed(new PgAdjudicationStore(lossy));
      const authority = new GameAuthority(pubsub, () => Date.now(), new PostgresEventStore(pool), {
        adjudication: { rulesVersion: 'rocky-adjudication@1', clockPolicy: 'observed-release-v1', start: (p) => store.startAdjudication(p) },
      });
      const worker = new AdjudicationWorker({
        store, executorId: randomUUID(), leaseMs: 5_000, pollMs: 50,
        publish: routedAdjudicationChange({ authority, router, hasLocalSessions: () => false }),
      });
      const resync = new AdjudicationResync({ authority, router, intervalMs: 500 });
      return { authority, worker, resync, store };
    };
    replicas.push(makeReplica(), makeReplica());
    for (const g of games) await replicas[g.owner]!.authority.ensureLoaded(g.id);
    for (const r of replicas) { r.worker.start(); r.resync.start(); }

    // --- measurement ---
    const moveLatency: number[] = [];
    const stoppedFor: number[] = [];
    const provingFor: number[] = [];
    const pendingMove = new Map<string, number>();
    const provingSince = new Map<string, number>();
    const stoppedSince = new Map<string, number>();
    for (const g of games) {
      pubsub.subscribe(gameChannel(g.id), (msg: Broadcast) => {
        const now = performance.now();
        if (msg.t === 'move') {
          const sent = pendingMove.get(g.id);
          if (sent !== undefined) { moveLatency.push(now - sent); pendingMove.delete(g.id); }
        }
        if (msg.t === 'state') {
          const phase = msg.state.adjudication;
          if (phase === 'proving' && !provingSince.has(g.id)) provingSince.set(g.id, now);
          if (phase !== 'proving' && provingSince.has(g.id)) { provingFor.push(now - provingSince.get(g.id)!); provingSince.delete(g.id); }
          if (phase === 'stopped' && !stoppedSince.has(g.id)) stoppedSince.set(g.id, now);
          if (phase !== 'stopped' && stoppedSince.has(g.id)) { stoppedFor.push(now - stoppedSince.get(g.id)!); stoppedSince.delete(g.id); }
        }
      });
    }
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    let heapPeak = 0;
    const heapTimer = setInterval(() => { heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed); }, 200);

    // --- players ---
    let refused = 0;
    let moves = 0;
    const play = async (g: (typeof games)[number]) => {
      let seed = parseInt(g.id.slice(0, 8), 16) || 1;
      const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let ply = 0; ply < PLIES; ply++) {
        await sleep(THINK_MS * (0.5 + rnd()));
        const owner = replicas[g.owner]!.authority;
        let state;
        try { state = owner.getState(g.id); } catch { await owner.ensureLoaded(g.id); state = owner.getState(g.id); }
        if (state.status.over) return;
        if (state.adjudication === 'proving') { ply--; continue; }
        const legal = Object.entries(state.legalMoves).flatMap(([from, tos]) => tos.map((to) => `${from}${to}`));
        if (legal.length === 0) { ply--; continue; }
        let uci = legal[Math.floor(rnd() * legal.length)]!;
        if (/^[a-h]7[a-h]8$|^[a-h]2[a-h]1$/.test(uci) && /p/i.test(state.fen.split(' ')[0]!)) uci += 'q';
        const user = state.turn === 'w' ? g.white : g.black;
        pendingMove.set(g.id, performance.now());
        try {
          await router.route(g.id, user, { kind: 'move', uci });
          moves++;
        } catch {
          refused++;
          pendingMove.delete(g.id);
          ply--;
          if (refused > GAMES * PLIES * 4) throw new Error('too many refusals');
        }
      }
    };

    // --- faults, mid-run ---
    const faults = (async () => {
      await sleep(THINK_MS * PLIES * 0.25);
      lossRate.value = 0.1; // lost COMMIT replies for a while
      await sleep(THINK_MS * PLIES * 0.2);
      lossRate.value = 0;
      // Replica 1's worker dies holding claims: it simply stops; its leases must lapse and be taken over.
      await replicas[1]!.worker.stop();
      await sleep(THINK_MS * PLIES * 0.2);
      // Replica 0's owner restarts cold: a fresh authority rebuilds its games from the log.
      replicas[0]!.resync.stop();
      replicas[0] = { ...replicas[0]!, authority: new GameAuthority(pubsub, () => Date.now(), new PostgresEventStore(pool), {
        adjudication: { rulesVersion: 'rocky-adjudication@1', clockPolicy: 'observed-release-v1', start: (p) => replicas[0]!.store.startAdjudication(p) },
      }) };
      for (const g of games.filter((x) => x.owner === 0)) await replicas[0]!.authority.ensureLoaded(g.id);
      replicas[0]!.resync = new AdjudicationResync({ authority: replicas[0]!.authority, router, intervalMs: 500 });
      replicas[0]!.resync.start();
    })();

    const started = performance.now();
    await Promise.all([...games.map(play), faults]);
    // Let the remaining adjudications settle and release.
    const deadline = performance.now() + 60_000;
    let open = 0;
    for (;;) {
      open = (await pool.query(`SELECT count(*)::int AS n FROM game_adjudications WHERE execution_state = 'proving' OR is_current_stop`)).rows[0].n;
      if (open === 0 || performance.now() > deadline) break;
      await sleep(100);
    }
    await sleep(1_500); // resync interval, so every owner has folded the last change
    const wall = performance.now() - started;
    clearInterval(heapTimer);
    loop.disable();
    for (const r of replicas) { await r.worker.stop(); await r.resync.stop(); }

    // --- invariants ---
    assert.equal(open, 0, 'nothing is left proving or stopped');
    for (const g of games) {
      const logged = (await pool.query('SELECT payload FROM game_events WHERE game_id = $1 ORDER BY seq', [g.id])).rows.map((r) => r.payload as GameEvent);
      const replayed = Game.fromEvents(logged);
      const owner = replicas[g.owner]!.authority;
      const view = owner.getState(g.id);
      assert.equal(view.fen, replayed.fen, 'owner copy equals replay');
      assert.equal(view.stateRevision, logged.length - 1);
      assert.equal(view.adjudication, undefined, 'released or ended, never stuck');
      assert.equal(replayed.adjudication, null);
      const resolved = logged.filter((e) => e.type === 'AdjudicationResolved').length;
      const startedN = logged.filter((e) => e.type === 'AdjudicationStarted').length;
      assert.equal(resolved, startedN, 'every admitted command settled exactly once');
      // Clocks: never negative, never more than the initial time plus increments earned.
      const snap = replayed.snapshot();
      for (const side of ['w', 'b'] as const) {
        assert.ok(snap.clock.remaining[side] >= 0);
        assert.ok(snap.clock.remaining[side] <= tc.initialMs + tc.incrementMs * replayed.ply);
      }
    }

    const report = {
      games: GAMES, plies: PLIES, thinkMs: THINK_MS, moves, refusedRetries: refused, lostCommitReplies: lost.lost,
      wallSeconds: +(wall / 1000).toFixed(1), movesPerSecond: +(moves / (wall / 1000)).toFixed(2),
      moveLatencyMs: { p50: +pct(moveLatency, 0.5).toFixed(1), p90: +pct(moveLatency, 0.9).toFixed(1), p99: +pct(moveLatency, 0.99).toFixed(1), max: +pct(moveLatency, 1).toFixed(1), n: moveLatency.length },
      provingMs: { p50: +pct(provingFor, 0.5).toFixed(1), p90: +pct(provingFor, 0.9).toFixed(1), max: +pct(provingFor, 1).toFixed(1) },
      stoppedMs: { p50: +pct(stoppedFor, 0.5).toFixed(1), p90: +pct(stoppedFor, 0.9).toFixed(1), max: +pct(stoppedFor, 1).toFixed(1) },
      eventLoopDelayMs: { p50: +(loop.percentile(50) / 1e6).toFixed(1), p99: +(loop.percentile(99) / 1e6).toFixed(1), max: +(loop.max / 1e6).toFixed(1) },
      heapPeakMB: +(heapPeak / 1e6).toFixed(0),
      storeMs: Object.fromEntries([...phases].map(([k, xs]) => [k, { n: xs.length, p50: +pct(xs, 0.5).toFixed(1), p90: +pct(xs, 0.9).toFixed(1), max: +pct(xs, 1).toFixed(1), total: Math.round(xs.reduce((a, b) => a + b, 0)) }])),
    };
    console.log('SOAK', JSON.stringify(report));
    assert.ok(moves >= GAMES * Math.min(PLIES, 4), 'games made progress');
  });
});
