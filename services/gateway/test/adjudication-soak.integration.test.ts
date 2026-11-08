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
  WorkerLossBarrier,
  createPrng,
  deriveFaultSeed,
  deriveGameSeed,
  derivePlyMovePrng,
  parseSoakConfig,
  type MovePositionContext,
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
    let targetOpId = '';
    let targetAbandonedGeneration = '';
    let targetSuccessorGeneration = '';
    let targetSuccessorExecutorId = '';
    let targetSettled = false;
    let targetResolvedEventsCount = 0;
    let targetWrapperClaimsCount = 0;
    let targetPreRemainingMs = 0;
    let targetPostRemainingMs = 0;
    let targetFaultDurationMs = 0;
    const faultRnd = createPrng(deriveFaultSeed(SOAK_SEED));
    const lossy = lossyCommits(pool, commitControl, lost, faultRnd);

    const tracker = new SoakMetricsTracker(10);
    const worker1Barrier = new WorkerLossBarrier();
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

      const wrapTimedStore = (store: PgAdjudicationStore, barrier?: WorkerLossBarrier): PgAdjudicationStore => {
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
            const res = await origCreateJob(gameId, operationId);
            if (barrier && barrier.isArmed && !barrier.isTriggered) {
              const zeroStep = store.stepProofJob(operationId, 0);
              if (zeroStep.status === 'active') {
                await barrier.interceptProofBoundary(gameId, operationId, zeroStep.status);
              }
            }
            return res;
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

      const makeReplica = (barrier?: WorkerLossBarrier): Replica => {
        const store = wrapTimedStore(new PgAdjudicationStore(lossy), barrier);
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

      replicas.push(makeReplica(), makeReplica(worker1Barrier));
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
            tracker.onStateBroadcast(g.id, msg.state.ply, now);
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
          const positionContext: MovePositionContext = {
            fen: state.fen,
            uci,
            gameIndex: g.index,
            gameSeed,
            attempt,
            basePly,
          };
          tracker.onMovePending(g.id, basePly, performance.now(), positionContext);
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

        // Stage 2: Worker 1 simulated replica loss at active proof boundary
        worker1Barrier.arm();
        const pausedTarget = await worker1Barrier.waitForPause(30_000);
        targetOpId = pausedTarget.operationId;

        // Verify target operation is actively held in PostgreSQL and lease is unexpired before shutdown request
        const preCheck = await pool.query<{
          execution_state: string;
          executor_id: string;
          lease_until: Date;
          generation: string;
          lease_active: boolean;
          remaining_lease_ms: number;
        }>(
          `SELECT
             execution_state,
             executor_id,
             lease_until,
             generation::text AS generation,
             (lease_until > clock_timestamp()) AS lease_active,
             (EXTRACT(EPOCH FROM (lease_until - clock_timestamp())) * 1000)::double precision AS remaining_lease_ms
           FROM game_adjudications
           WHERE operation_id = $1`,
          [targetOpId],
        );
        const preRow = preCheck.rows[0];
        if (!preRow || preRow.execution_state !== 'proving' || preRow.executor_id !== replicas[1]!.executorId) {
          throw new Error(`Target operation ${targetOpId} not actively held in proving state by worker 1 before shutdown`);
        }
        assert.equal(
          typeof preRow.remaining_lease_ms,
          'number',
          `preCheck remaining_lease_ms must be numeric from ::double precision SQL cast, received ${typeof preRow.remaining_lease_ms}`,
        );
        assert.ok(
          Number.isFinite(preRow.remaining_lease_ms),
          `preCheck remaining_lease_ms must be finite number, received ${preRow.remaining_lease_ms}`,
        );
        if (!preRow.lease_active || preRow.remaining_lease_ms <= 0) {
          throw new Error(
            `Target operation ${targetOpId} lease was not unexpired/active before shutdown: ${preRow.remaining_lease_ms}`,
          );
        }
        const preRemainingMs = preRow.remaining_lease_ms;
        targetAbandonedGeneration = preRow.generation;

        // Fault timeline starts when shutdown/loss is initiated
        const faultStartMs = performance.now();
        const finiteFaultDurationMs = preRemainingMs + 1000;
        targetPreRemainingMs = preRemainingMs;
        targetFaultDurationMs = finiteFaultDurationMs;
        tracker.recordFaultStart('worker_1_death', faultStartMs, finiteFaultDurationMs);

        // Request worker 1 shutdown while proof cannot finish
        const stopPromise = replicas[1]!.worker.stop();

        // Release barrier so worker 1 unblocks, observes #halting flag, and aborts pass without settling
        worker1Barrier.release();
        await stopPromise;

        // Post-stop SQL verification: confirm target operation remains abandoned in proving state with active lease
        const postCheck = await pool.query<{
          execution_state: string;
          executor_id: string;
          lease_until: Date;
          generation: string;
          lease_active: boolean;
          remaining_lease_ms: number;
        }>(
          `SELECT
             execution_state,
             executor_id,
             lease_until,
             generation::text AS generation,
             (lease_until > clock_timestamp()) AS lease_active,
             (EXTRACT(EPOCH FROM (lease_until - clock_timestamp())) * 1000)::double precision AS remaining_lease_ms
           FROM game_adjudications
           WHERE operation_id = $1`,
          [targetOpId],
        );
        const postRow = postCheck.rows[0];
        if (!postRow || postRow.execution_state !== 'proving' || postRow.executor_id !== replicas[1]!.executorId) {
          throw new Error(`Target operation ${targetOpId} was not abandoned in proving state by worker 1 after shutdown`);
        }
        assert.equal(
          typeof postRow.remaining_lease_ms,
          'number',
          `postCheck remaining_lease_ms must be numeric from ::double precision SQL cast, received ${typeof postRow.remaining_lease_ms}`,
        );
        assert.ok(
          Number.isFinite(postRow.remaining_lease_ms),
          `postCheck remaining_lease_ms must be finite number, received ${postRow.remaining_lease_ms}`,
        );
        if (!postRow.lease_active || postRow.remaining_lease_ms <= 0) {
          throw new Error(
            `Target operation ${targetOpId} lease expired during shutdown before abandonment verification: ${postRow.remaining_lease_ms}`,
          );
        }
        const postRemainingMs = postRow.remaining_lease_ms;
        targetPostRemainingMs = postRemainingMs;

        // Count all truly abandoned proving claims left by Worker 1 with unexpired lease
        const abandonedRes = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM game_adjudications
           WHERE execution_state = 'proving'
             AND executor_id = $1::uuid
             AND lease_until > clock_timestamp()`,
          [replicas[1]!.executorId],
        );
        heldAtDeathCount = abandonedRes.rows[0]?.n ?? 0;
        if (heldAtDeathCount === 0) {
          throw new Error('Worker 1 held 0 active unexpired proving claims in PostgreSQL after shutdown');
        }

        // Wait until database clock indicates the abandoned lease has lapsed
        while (running) {
          const checkLapsed = await pool.query<{ lapsed: boolean }>(
            `SELECT (clock_timestamp() >= $1::timestamptz) AS lapsed`,
            [postRow.lease_until],
          );
          if (checkLapsed.rows[0]?.lapsed) break;
          await sleep(50);
        }
        tracker.recordFaultEnd('worker_1_death', performance.now());

        // Wait bounded interval for successor worker to claim the EXACT target operation
        const takeoverWaitStart = performance.now();
        let targetClaimRow: { execution_state: string; executor_id: string; generation: string } | undefined;
        let targetSettledRow: { execution_state: string; is_current_stop: boolean; settlement_receipt: unknown } | undefined;

        while (running && performance.now() - takeoverWaitStart < 15_000) {
          const claimRes = await pool.query<{
            execution_state: string;
            executor_id: string;
            generation: string;
            is_current_stop: boolean;
            settlement_receipt: unknown;
          }>(
            `SELECT
               execution_state,
               executor_id,
               generation::text AS generation,
               is_current_stop,
               settlement_receipt
             FROM game_adjudications
             WHERE operation_id = $1`,
            [targetOpId],
          );
          const row = claimRes.rows[0];
          if (
            row &&
            row.executor_id === replicas[0]!.executorId &&
            BigInt(row.generation) > BigInt(postRow.generation)
          ) {
            targetClaimRow = row;
            if (row.execution_state === 'completed' || row.is_current_stop || row.settlement_receipt !== null) {
              targetSettledRow = row;
              break;
            }
          }
          await sleep(50);
        }

        if (!running) return;

        if (!targetClaimRow) {
          throw new Error(
            `Successor takeover unexercised: target operation ${targetOpId} was not claimed by surviving executor ${replicas[0]!.executorId} at generation > ${postRow.generation} within 15000ms deadline`,
          );
        }

        // Wait for target operation to settle completely if not already settled
        const settleWaitStart = performance.now();
        while (running && !targetSettledRow && performance.now() - settleWaitStart < 15_000) {
          const settleRes = await pool.query<{
            execution_state: string;
            is_current_stop: boolean;
            settlement_receipt: unknown;
          }>(
            `SELECT
               execution_state,
               is_current_stop,
               settlement_receipt
             FROM game_adjudications
             WHERE operation_id = $1`,
            [targetOpId],
          );
          const sRow = settleRes.rows[0];
          if (sRow && (sRow.execution_state === 'completed' || sRow.is_current_stop || sRow.settlement_receipt !== null)) {
            targetSettledRow = sRow;
            break;
          }
          await sleep(50);
        }

        if (!running) return;

        if (!targetSettledRow) {
          throw new Error(
            `Target operation ${targetOpId} was claimed by surviving executor ${replicas[0]!.executorId} at generation ${targetClaimRow.generation} but failed to settle within 15000ms deadline`,
          );
        }

        // Verify target operation resolved event in event log
        const resolvedEventsRes = await pool.query<{ payload: { operationId?: string } }>(
          `SELECT payload FROM game_events WHERE type = 'AdjudicationResolved' AND payload->>'operationId' = $1`,
          [targetOpId],
        );
        targetResolvedEventsCount = resolvedEventsRes.rows.length;
        if (targetResolvedEventsCount !== 1 && running) {
          throw new Error(
            `Target operation ${targetOpId} resolved event count in game_events is ${targetResolvedEventsCount}, expected exactly 1`,
          );
        }

        const targetWrapperClaims = tracker.getOperationClaims(targetOpId) ?? [];
        targetSuccessorGeneration = targetClaimRow.generation;
        targetSuccessorExecutorId = targetClaimRow.executor_id;
        targetSettled = targetSettledRow !== undefined;
        targetWrapperClaimsCount = targetWrapperClaims.length;
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
        for (const g of games.filter((x) => x.owner === 0)) {
          await replicas[0]!.authority.ensureLoaded(g.id);
          const recovery = await replicas[0]!.authority.readRecovery(g.id, 0);
          tracker.onRecoveryResponse(g.id, recovery.state.ply, performance.now());
        }
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
        worker1Barrier.abort('run error teardown');
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
          targetTakeover: {
            operationId: targetOpId,
            abandonedExecutorId: replicas[1]!.executorId,
            abandonedGeneration: targetAbandonedGeneration,
            successorExecutorId: targetSuccessorExecutorId,
            successorGeneration: targetSuccessorGeneration,
            wrapperClaimsCount: targetWrapperClaimsCount,
            settled: targetSettled,
            resolvedEventsCount: targetResolvedEventsCount,
            remainingLeaseMs: targetPostRemainingMs,
            preRemainingMs: targetPreRemainingMs,
            postRemainingMs: targetPostRemainingMs,
            finiteDurationMs: targetFaultDurationMs,
          },
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
      const provSum =
        report.moveLatencyMs.provenance.move_broadcast +
        report.moveLatencyMs.provenance.state_broadcast +
        report.moveLatencyMs.provenance.recovery_response;
      assert.equal(provSum, report.moveLatencyMs.n, 'provenance counts must sum to total moveLatency samples');
      assert.ok(report.faultCoverage.lostCommitReplies >= 1, 'must exercise at least one lost COMMIT reply');
      assert.ok(report.faultCoverage.heldAtDeath >= 1, 'worker 1 must hold at least one claim at death');
      assert.ok(report.faultCoverage.successorTakeovers >= 1, 'successor worker must take over at least one abandoned claim');
      assert.equal(report.faultCoverage.targetTakeover.operationId, targetOpId);
      assert.equal(report.faultCoverage.targetTakeover.successorExecutorId, replicas[0]!.executorId);
      assert.ok(
        BigInt(report.faultCoverage.targetTakeover.successorGeneration) >
          BigInt(report.faultCoverage.targetTakeover.abandonedGeneration),
        'successor generation must be strictly greater than abandoned generation',
      );
      assert.ok(report.faultCoverage.targetTakeover.wrapperClaimsCount >= 2, 'target must have at least abandoned and successor claims');
      assert.equal(report.faultCoverage.targetTakeover.settled, true, 'target operation must settle');
      assert.equal(report.faultCoverage.targetTakeover.resolvedEventsCount, 1, 'target operation must settle exactly once');
      assert.equal(typeof report.faultCoverage.targetTakeover.preRemainingMs, 'number');
      assert.ok(
        report.faultCoverage.targetTakeover.preRemainingMs > 0,
        'target preRemainingMs must be positive finite number',
      );
      assert.equal(typeof report.faultCoverage.targetTakeover.postRemainingMs, 'number');
      assert.ok(
        report.faultCoverage.targetTakeover.postRemainingMs > 0,
        'target postRemainingMs must be positive finite number',
      );
      assert.equal(typeof report.faultCoverage.targetTakeover.remainingLeaseMs, 'number');
      assert.ok(
        report.faultCoverage.targetTakeover.remainingLeaseMs > 0,
        'target remainingLeaseMs must be positive finite number',
      );
      assert.equal(typeof report.faultCoverage.targetTakeover.finiteDurationMs, 'number');
      assert.equal(
        report.faultCoverage.targetTakeover.finiteDurationMs,
        report.faultCoverage.targetTakeover.preRemainingMs + 1000,
        'finiteDurationMs must equal preRemainingMs + 1000 without string concatenation',
      );
    } finally {
      running = false;
      worker1Barrier.abort('test teardown');
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
