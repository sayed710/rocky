/**
 * Adjudicated play under load, on real PostgreSQL (Issue #124, ADR-0176): two replicas share one
 * database, each with its own authority (the owner of half the games), worker and resync. Concurrent
 * games play random legal moves at human-like intervals while the harness measures what a player
 * waits for, and injects the failures the design must survive: a worker that dies holding claims,
 * lost COMMIT replies, and an owner that restarts cold. At the end every game must replay exactly
 * from the log and be neither proving nor stopped.
 *
 * Scale with SOAK_SEED / SOAK_GAMES / SOAK_PLIES / SOAK_THINK_MS (defaults are small enough for CI). Gated
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
import {
  PgAdjudicationStore,
  PostgresEventStore,
  migrate,
  migrationsDir,
  type ClaimAdjudicationParams,
  type RenewAdjudicationParams,
  type SettleAdjudicationParams,
  type StartAdjudicationParams,
} from '@chess-platform/persistence/pg';
import { withTestDatabase, type TestDatabase } from '@chess-platform/persistence/test-support';
import { AdjudicationWorker, routedAdjudicationChange } from '../src/adjudication-worker.js';
import { AdjudicationResync } from '../src/adjudication-resync.js';
import {
  MemorySampler,
  SoakMetricsTracker,
  createPrng,
  deriveFaultSeed,
  deriveGameSeed,
  derivePlyMovePrng,
  parseSoakConfig,
} from './support/soak-metrics.js';

type Pool = TestDatabase['pool'];

const DATABASE_URL = process.env['DATABASE_URL'];
const config = parseSoakConfig(process.env);
const { seed: SOAK_SEED, games: GAMES, plies: PLIES, thinkMs: THINK_MS } = config;

const soakTest = (name: string, fn: () => Promise<void>): void => {
  (DATABASE_URL ? test : test.skip)(name, { timeout: config.timeoutMs }, fn);
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface LossyCommitControl {
  enabled: boolean;
  targetMinLost: number;
  rate: number;
}

/**
 * A pool whose COMMIT reply is lost (the transaction commits, the caller sees an error) at rate.
 * Fault draw stream is seeded from SOAK_SEED; draws interleave by concurrent transaction arrival.
 */
function lossyCommits(
  pool: Pool,
  control: LossyCommitControl,
  counter: { lost: number },
  faultRnd: () => number,
): Pool {
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
              if (sql === 'COMMIT' && control.enabled) {
                const shouldDrop =
                  counter.lost < control.targetMinLost || (control.rate > 0 && faultRnd() < control.rate);
                if (shouldDrop) {
                  counter.lost++;
                  throw new Error('connection lost after COMMIT');
                }
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
  executorId: string;
}

interface SoakGame {
  readonly id: string;
  readonly white: string;
  readonly black: string;
  readonly owner: number;
  readonly index: number;
}

soakTest('adjudicated play under load survives worker death, lost replies and an owner restart', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const pubsub = new InMemoryPubSub();
    const commitControl: LossyCommitControl = { enabled: false, targetMinLost: 0, rate: 0 };
    const lost = { lost: 0 };
    let heldAtDeathCount = 0;
    const faultRnd = createPrng(deriveFaultSeed(SOAK_SEED));
    const lossy = lossyCommits(pool, commitControl, lost, faultRnd);

    const tracker = new SoakMetricsTracker(10);
    const sampler = new MemorySampler();
    sampler.start(200);
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const unsubs: Array<() => void> = [];
    const replicas: Replica[] = [];
    let progressTimer: NodeJS.Timeout | undefined;
    let running = true;

    try {
      // --- games ---
      const tc = { kind: 'increment' as const, initialMs: 300_000, incrementMs: 2_000, delayMs: 0 };
      const games: SoakGame[] = [];
      const actualPliesByGame = new Map<string, number>();

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
        await pool.query(
          `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, 'GameCreated', 1, $2::jsonb)`,
          [id, JSON.stringify(created.events[0])],
        );
        games.push({ id, white, black, owner: g % 2, index: g });
        actualPliesByGame.set(id, 0);
      }

      // --- replicas & timing wrapper ---
      const ownerOf = (gameId: string) => games.find((g) => g.id === gameId)!.owner;
      const router: CommandRouter = {
        route: (gameId: string, userId: string, cmd: Command) => replicas[ownerOf(gameId)]!.authority.apply(gameId, userId, cmd),
      };

      const wrapTimedStore = (store: PgAdjudicationStore): PgAdjudicationStore => {
        const origListClaimable = store.listClaimableAdjudications.bind(store);
        store.listClaimableAdjudications = async (limit: number) => {
          const t0 = performance.now();
          try {
            return await origListClaimable(limit);
          } finally {
            tracker.recordStoreCall('listClaimableAdjudications', performance.now() - t0);
          }
        };

        const origListStops = store.listReleasableStops.bind(store);
        store.listReleasableStops = async (limit: number, minAgeMs?: number, exclude?: readonly string[]) => {
          const t0 = performance.now();
          try {
            return await origListStops(limit, minAgeMs, exclude);
          } finally {
            tracker.recordStoreCall('listReleasableStops', performance.now() - t0);
          }
        };

        const origClaim = store.claimAdjudication.bind(store);
        store.claimAdjudication = async (params: ClaimAdjudicationParams) => {
          const t0 = performance.now();
          try {
            const grant = await origClaim(params);
            tracker.recordClaim({
              gameId: params.gameId,
              operationId: params.operationId,
              executorId: grant.executorId,
              generation: grant.generation,
              leaseUntil: grant.leaseUntil,
            });
            return grant;
          } finally {
            tracker.recordStoreCall('claimAdjudication', performance.now() - t0);
          }
        };

        const origRenew = store.renewAdjudication.bind(store);
        store.renewAdjudication = async (params: RenewAdjudicationParams) => {
          const t0 = performance.now();
          try {
            return await origRenew(params);
          } finally {
            tracker.recordStoreCall('renewAdjudication', performance.now() - t0);
          }
        };

        const origCreateJob = store.createProofJob.bind(store);
        store.createProofJob = async (gameId: string, operationId: string) => {
          const t0 = performance.now();
          try {
            return await origCreateJob(gameId, operationId);
          } finally {
            tracker.recordStoreCall('createProofJob', performance.now() - t0);
          }
        };

        const origStep = store.stepProofJob.bind(store);
        store.stepProofJob = (operationId: string, totalWorkBudget: number) => {
          const t0 = performance.now();
          const cpu0 = process.cpuUsage();
          try {
            const res = origStep(operationId, totalWorkBudget);
            const wallMs = performance.now() - t0;
            const cpuDiff = process.cpuUsage(cpu0);
            const cpuMs = (cpuDiff.user + cpuDiff.system) / 1000;
            tracker.recordStep(operationId, wallMs, cpuMs, res.deltaWork);
            try {
              const view = store.getProofJob(operationId);
              if (view) {
                const roles = view.requiredRoles.map((r) => r.role);
                const questionKinds = view.requiredRoles.map((r) => r.question?.kind ?? 'unknown/inferred');
                tracker.recordRoles(operationId, roles, questionKinds.join(', ') || 'unknown/inferred');
              }
            } catch {
              /* seam job view transient or evicted */
            }
            return res;
          } finally {
            tracker.recordStoreCall('stepProofJob', performance.now() - t0);
          }
        };

        const origSettle = store.settleAdjudication.bind(store);
        store.settleAdjudication = async (params: SettleAdjudicationParams) => {
          const t0 = performance.now();
          try {
            const receipt = await origSettle(params);
            const duration = performance.now() - t0;
            tracker.recordSettleAttempt(params.operationId, duration);
            tracker.recordSettlementCommitted(params.operationId);
            return receipt;
          } catch (err) {
            const duration = performance.now() - t0;
            tracker.recordSettleAttempt(params.operationId, duration);
            throw err;
          }
        };

        const origRelease = store.releaseClocks.bind(store);
        store.releaseClocks = async (params: { gameId: string; releaseRequestId: string; at: number }) => {
          const t0 = performance.now();
          try {
            const receipt = await origRelease(params);
            const duration = performance.now() - t0;
            tracker.recordReleaseAttempt(duration);
            tracker.recordReleaseCommitted(receipt.stopOperationId, duration);
            return receipt;
          } catch (err) {
            tracker.recordReleaseAttempt(performance.now() - t0);
            throw err;
          }
        };

        const origStart = store.startAdjudication.bind(store);
        store.startAdjudication = async (params: StartAdjudicationParams) => {
          const t0 = performance.now();
          const basePly = tracker.getGameBasePly(params.gameId);
          try {
            const res = await origStart(params);
            const duration = performance.now() - t0;
            tracker.recordStartAttempt(duration, basePly);
            if (res.status === 'started' || res.status === 'proving') {
              tracker.recordStartAdmitted(params.gameId, res.operationId, basePly, duration);
            }
            return res;
          } catch (err) {
            tracker.recordStartAttempt(performance.now() - t0, basePly);
            throw err;
          }
        };

        return store;
      };

      const makeReplica = (): Replica => {
        const store = wrapTimedStore(new PgAdjudicationStore(lossy));
        const authority = new GameAuthority(pubsub, () => Date.now(), new PostgresEventStore(pool), {
          adjudication: { rulesVersion: 'rocky-adjudication@1', clockPolicy: 'observed-release-v1', start: (p) => store.startAdjudication(p) },
        });
        const executorId = randomUUID();
        const worker = new AdjudicationWorker({
          store,
          executorId,
          leaseMs: 5_000,
          pollMs: 50,
          publish: routedAdjudicationChange({ authority, router, hasLocalSessions: () => false }),
        });
        const resync = new AdjudicationResync({ authority, router, intervalMs: 500 });
        return { authority, worker, resync, store, executorId };
      };

      replicas.push(makeReplica(), makeReplica());
      for (const g of games) await replicas[g.owner]!.authority.ensureLoaded(g.id);
      for (const r of replicas) { r.worker.start(); r.resync.start(); }

      // --- correlation subscriptions ---
      for (const g of games) {
        const unsub = pubsub.subscribe(gameChannel(g.id), (msg: Broadcast) => {
          const now = performance.now();
          if (msg.t === 'move') {
            tracker.onMoveBroadcast(g.id, msg.ply, now);
          }
          if (msg.t === 'state') {
            const phase = msg.state.adjudication;
            tracker.onProvingState(g.id, phase === 'proving', now);
            tracker.onStoppedState(g.id, phase === 'stopped', now);
          }
        });
        unsubs.push(unsub);
      }

      // --- reproducible players with basePly-anchored choice generation ---
      let refused = 0;
      let moves = 0;

      const play = async (g: SoakGame) => {
        const gameSeed = deriveGameSeed(SOAK_SEED, g.index);
        let attempt = 0;
        for (let ply = 0; ply < PLIES; ply++) {
          if (!running) return;
          const thinkRnd = createPrng((gameSeed + ply * 101) >>> 0);
          await sleep(THINK_MS * (0.5 + thinkRnd()));
          if (!running) return;

          const owner = replicas[g.owner]!.authority;
          let state;
          try {
            state = owner.getState(g.id);
          } catch {
            await owner.ensureLoaded(g.id);
            state = owner.getState(g.id);
          }
          if (state.status.over) {
            actualPliesByGame.set(g.id, state.ply);
            return;
          }
          if (state.adjudication === 'proving') {
            ply--;
            continue;
          }
          const legal = Object.entries(state.legalMoves).flatMap(([from, tos]) => tos.map((to) => `${from}${to}`));
          if (legal.length === 0) {
            ply--;
            continue;
          }
          const basePly = state.ply;
          tracker.setGameBasePly(g.id, basePly);
          const moveChoiceRnd = derivePlyMovePrng(gameSeed, basePly, attempt);
          let uci = legal[Math.floor(moveChoiceRnd() * legal.length)]!;
          if (/^[a-h]7[a-h]8$|^[a-h]2[a-h]1$/.test(uci) && /p/i.test(state.fen.split(' ')[0]!)) {
            uci += 'q';
          }
          const user = state.turn === 'w' ? g.white : g.black;
          tracker.onMovePending(g.id, basePly, performance.now());
          try {
            await router.route(g.id, user, { kind: 'move', uci });
            moves++;
            attempt = 0;
            actualPliesByGame.set(g.id, basePly + 1);
          } catch {
            refused++;
            tracker.onMoveFailed(g.id, basePly);
            ply--;
            attempt++;
            if (refused > GAMES * PLIES * 4) throw new Error('too many refusals');
          }
        }
      };

      // --- reproducible faults with timeline tracking ---
      const faults = async () => {
        await sleep(THINK_MS * PLIES * 0.25);
        if (!running) return;

        // Stage 1: Lossy commits (guaranteed at least one lost COMMIT reply)
        tracker.recordFaultStart('lossy_commits', performance.now());
        commitControl.enabled = true;
        commitControl.targetMinLost = 1;
        commitControl.rate = 0.05;
        const faultWaitStart = performance.now();
        while (running && lost.lost < 1 && performance.now() - faultWaitStart < 30_000) {
          await sleep(50);
        }
        if (lost.lost === 0 && running) {
          throw new Error('Fault coverage unexercised: 0 lost COMMIT replies occurred within fault window');
        }
        await sleep(Math.min(1000, THINK_MS * PLIES * 0.1));
        commitControl.enabled = false;
        tracker.recordFaultEnd('lossy_commits', performance.now());
        if (!running) return;

        // Stage 2: Worker 1 death while actively holding a proving claim in game_adjudications
        const worker1ExecutorId = replicas[1]!.executorId;
        const waitClaimStart = performance.now();
        while (running && performance.now() - waitClaimStart < 30_000) {
          const res = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM game_adjudications WHERE execution_state = 'proving' AND executor_id = $1::uuid AND lease_until > clock_timestamp()`,
            [worker1ExecutorId],
          );
          const held = res.rows[0]?.n ?? 0;
          if (held > 0) {
            heldAtDeathCount = held;
            break;
          }
          await sleep(25);
        }
        if (heldAtDeathCount === 0 && running) {
          throw new Error('Fault coverage unexercised: worker 1 held 0 active proving claims before death injection within deadline');
        }
        // Finite 5000 ms lease window for worker 1 claims to lapse
        tracker.recordFaultStart('worker_1_death', performance.now(), 5000);
        await replicas[1]!.worker.stop();
        await sleep(THINK_MS * PLIES * 0.2);
        if (!running) return;

        // Stage 3: Owner 0 cold restart
        tracker.recordFaultStart('owner_0_cold_restart', performance.now());
        replicas[0]!.resync.stop();
        replicas[0] = {
          ...replicas[0]!,
          authority: new GameAuthority(pubsub, () => Date.now(), new PostgresEventStore(pool), {
            adjudication: { rulesVersion: 'rocky-adjudication@1', clockPolicy: 'observed-release-v1', start: (p) => replicas[0]!.store.startAdjudication(p) },
          }),
        };
        for (const g of games.filter((x) => x.owner === 0)) await replicas[0]!.authority.ensureLoaded(g.id);
        replicas[0]!.resync = new AdjudicationResync({ authority: replicas[0]!.authority, router, intervalMs: 500 });
        replicas[0]!.resync.start();
        tracker.recordFaultEnd('owner_0_cold_restart', performance.now());
      };

      const started = performance.now();
      progressTimer = setInterval(() => {
        const elapsedSec = ((performance.now() - started) / 1000).toFixed(1);
        console.log(
          `[soak progress] elapsed: ${elapsedSec}s, moves: ${moves}, activeProofs: ${tracker.activeOpsCount}, lostCommits: ${lost.lost}`,
        );
      }, 30_000);

      const taskPromises = [...games.map(play), faults()];
      try {
        await Promise.all(taskPromises);
      } catch (runErr) {
        running = false;
        await Promise.allSettled(taskPromises);
        throw runErr;
      }

      const deadline = performance.now() + 60_000;
      let open = 0;
      for (;;) {
        open = (await pool.query(`SELECT count(*)::int AS n FROM game_adjudications WHERE execution_state = 'proving' OR is_current_stop`)).rows[0].n;
        if (open === 0 || performance.now() > deadline) break;
        await sleep(100);
      }
      await sleep(1_500);
      const wall = performance.now() - started;

      // Invariants
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

        const snap = replayed.snapshot();
        for (const side of ['w', 'b'] as const) {
          assert.ok(snap.clock.remaining[side] >= 0);
          assert.ok(snap.clock.remaining[side] <= tc.initialMs + tc.incrementMs * replayed.ply);
        }
      }

      let earlyEndings = 0;
      let totalActualPlies = 0;
      for (const g of games) {
        const pliesReached = actualPliesByGame.get(g.id) ?? 0;
        totalActualPlies += pliesReached;
        if (pliesReached < PLIES) earlyEndings++;
      }

      const memStats = sampler.stop();
      const report = {
        seed: SOAK_SEED,
        games: GAMES,
        requestedPlies: PLIES,
        actualPlies: totalActualPlies,
        earlyEndings,
        thinkMs: THINK_MS,
        timeoutMs: config.timeoutMs,
        moves,
        refusedRetries: refused,
        lostCommitReplies: lost.lost,
        faultCoverage: {
          lostCommitReplies: lost.lost,
          heldAtDeath: heldAtDeathCount,
          successorTakeovers: tracker.successorTakeoversCount,
        },
        wallSeconds: +(wall / 1000).toFixed(1),
        movesPerSecond: +(moves / (wall / 1000)).toFixed(2),
        moveLatencyMs: tracker.getMoveLatencyQuantiles(),
        provingMs: tracker.getProvingWallQuantiles(),
        stoppedMs: tracker.getStoppedQuantiles(),
        activeProofCpuMs: tracker.getActiveProofCpuQuantiles(),
        activeProofSliceWallMs: tracker.getActiveProofSliceWallQuantiles(),
        eventLoopDelayMs: {
          p50: +(loop.percentile(50) / 1e6).toFixed(1),
          p90: +(loop.percentile(90) / 1e6).toFixed(1),
          p99: +(loop.percentile(99) / 1e6).toFixed(1),
          max: +(loop.max / 1e6).toFixed(1),
        },
        heapPeakMB: memStats.heapPeakMB,
        memory: memStats,
        validationCostByPly: tracker.getValidationCostByPly(),
        storeMs: tracker.getStoreMs(),
        tailSamples: {
          slowestMoveLatency: tracker.getTopMoveLatency(),
          slowestProvingWall: tracker.getTopProvingWall(),
          highestProofCpu: tracker.getTopProofCpu(),
        },
      };
      console.log('SOAK', JSON.stringify(report));
      assert.ok(moves >= GAMES * Math.min(PLIES, 4), 'games made progress');
      assert.ok(report.moveLatencyMs.n > 0, 'moveLatency samples must not be empty');
      assert.equal(report.moveLatencyMs.n, moves, 'moveLatency sample count must equal observed moves');
      assert.ok(report.faultCoverage.lostCommitReplies >= 1, 'must exercise at least one lost COMMIT reply');
      assert.ok(report.faultCoverage.heldAtDeath >= 1, 'worker 1 must hold at least one claim at death');
      assert.ok(report.faultCoverage.successorTakeovers >= 1, 'successor worker must take over at least one abandoned claim');
    } finally {
      running = false;
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = undefined;
      }
      sampler.stop();
      loop.disable();
      for (const unsub of unsubs) {
        try { unsub(); } catch { /* cleanup */ }
      }
      for (const r of replicas) {
        try { await r.worker.stop(); } catch { /* cleanup */ }
        try { await r.resync.stop(); } catch { /* cleanup */ }
      }
    }
  });
});
