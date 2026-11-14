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
import { Game, type GameEvent, type MovePlayedEvent } from '@chess-platform/game';
import {
  ADJUDICATION_ACTOR,
  GameAuthority,
  InMemoryPubSub,
  gameChannel,
  AuthorityCommitError,
  CommandOutcomeUnknownError,
  type Broadcast,
  type Command,
  type CommandRouter,
  type StateView,
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
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { AdjudicationWorker, routedAdjudicationChange, type AdjudicationChange } from '../src/adjudication-worker.js';
import { AdjudicationResync } from '../src/adjudication-resync.js';
import {
  LostCommitTracker,
  MemorySampler,
  ReplicaRouteGate,
  SoakMetricsTracker,
  WorkerLossBarrier,
  assertRecoveryStateMatchesReplayPrefix,
  assertStateViewMatchesReplay,
  createPrng,
  createReplicaPublicationGuard,
  deriveFaultSeed,
  deriveGameSeed,
  derivePlyMovePrng,
  getCurrentMoveRouteCorrelation,
  lossyCommits,
  parseSoakConfig,
  runWithLossyTransactionScope,
  runWithMoveRouteCorrelation,
  type LossyCommitControl,
  type LossyTransactionPurpose,
  type MovePositionContext,
  type MoveRouteCorrelation,
} from './support/soak-metrics.js';

export type { LossyCommitControl };

const DATABASE_URL = process.env['DATABASE_URL'];
const config = parseSoakConfig(process.env);
const { seed: SOAK_SEED, games: GAMES, plies: PLIES, thinkMs: THINK_MS } = config;

const soakTest = (name: string, fn: () => Promise<void>): void => {
  (DATABASE_URL ? test : test.skip)(name, { timeout: config.timeoutMs }, fn);
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ReplicaStats {
  readonly disposed: boolean;
  readonly publishCount: number;
  readonly appendCount: number;
  readonly broadcastCount: number;
  readonly authorityApplyCount: number;
  readonly stalePublishBlockedCount: number;
  readonly staleAuthorityBlockedCount: number;
  readonly staleAppendBlockedCount: number;
  readonly staleBroadcastBlockedCount: number;
}

interface Replica {
  readonly slotIndex: 0 | 1;
  readonly authority: GameAuthority;
  readonly worker: AdjudicationWorker;
  readonly resync: AdjudicationResync;
  readonly store: PgAdjudicationStore;
  readonly eventStore: PostgresEventStore;
  readonly executorId: string;
  readonly getStats: () => ReplicaStats;
  readonly stopWorkers: () => Promise<void>;
  readonly dispose: () => Promise<void>;
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
    const commitControl: LossyCommitControl = {
      enabled: false,
      targetMinLost: 0,
      rate: 0,
      requireInsertInTx: true,
    };
    const lost = { lost: 0 };
    const lostCommitTracker = new LostCommitTracker();
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
    let preRestartReplica0ExecutorId = '';
    let postRestartReplica0ExecutorId = '';
    let oldReplica0Ref: Replica | undefined;
    let oldReplica0PublishCountAtDispose = 0;
    let oldReplica0AppendCountAtDispose = 0;
    let oldReplica0BroadcastCountAtDispose = 0;
    let abandonedAtColdRestartCount = 0;
    let abandonedColdRestartReclaimedCount = 0;
    let coldRestartLiveRoutingVerified = false;
    let coldRestartDistinctResourcesVerified = false;
    let coldRestartStaleCommandBlockedVerified = false;
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
    const owner0Gate = new ReplicaRouteGate(0);
    const createdReplicas = new Set<Replica>();
    let progressTimer: NodeJS.Timeout | undefined;
    let running = true;

    try {
      // --- games ---
      const tc = { kind: 'increment' as const, initialMs: 300_000, incrementMs: 2_000, delayMs: 0 };
      const games: SoakGame[] = [];

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
      }

      // --- replicas & timing wrapper ---
      const ownerOf = (gameId: string) => games.find((g) => g.id === gameId)!.owner;
      const router: CommandRouter = {
        route: (gameId: string, userId: string, cmd: Command) => {
          const slot = ownerOf(gameId);
          if (slot !== 0) {
            return replicas[slot]!.authority.apply(gameId, userId, cmd);
          }
          const isDrainBypass = userId === ADJUDICATION_ACTOR || cmd.kind === 'adjudicationChanged';
          return owner0Gate.route(
            isDrainBypass,
            () => replicas[0]!,
            (replica) => replica.authority.apply(gameId, userId, cmd),
          );
        },
      };

      const verifyRecoverySnapshot = async (gameId: string, state: StateView): Promise<void> => {
        assert.ok(
          Number.isSafeInteger(state.stateRevision) && state.stateRevision >= 0,
          `recovery stateRevision must be a non-negative safe integer for game ${gameId}`,
        );
        const prefixRows = (
          await pool.query<{ seq: number; payload: unknown }>(
            `SELECT seq, payload
             FROM game_events
             WHERE game_id = $1 AND seq <= $2
             ORDER BY seq ASC`,
            [gameId, state.stateRevision],
          )
        ).rows;
        assert.equal(
          prefixRows.length,
          state.stateRevision + 1,
          `recovery prefix row count must equal stateRevision + 1 for game ${gameId}`,
        );
        for (let i = 0; i < prefixRows.length; i++) {
          assert.equal(prefixRows[i]!.seq, i, `recovery prefix seq must be contiguous at ${i} for game ${gameId}`);
        }
        const replayedPrefix = Game.fromEvents(prefixRows.map((r) => r.payload as GameEvent));
        assertRecoveryStateMatchesReplayPrefix(state, replayedPrefix, prefixRows.length);
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
          const routeCorr = getCurrentMoveRouteCorrelation();
          const basePly =
            routeCorr && routeCorr.gameId === params.gameId
              ? routeCorr.basePly
              : tracker.getGameBasePly(params.gameId);
          const operationId = params.context?.operationId ?? params.prepared?.operationId;
          const commandKind = params.command?.kind ?? params.prepared?.intent?.kind ?? 'unknown';
          const uci = params.command?.kind === 'move'
            ? params.command.uci
            : params.prepared?.intent?.kind === 'move'
              ? params.prepared.intent.uci
              : undefined;

          if (routeCorr && routeCorr.gameId === params.gameId && operationId) {
            routeCorr.operationId = operationId;
          }

          if (operationId) {
            tracker.recordStartRequest({
              gameId: params.gameId,
              operationId,
              basePly,
              atMs: t0,
              uci,
            });
          }

          const purpose: LossyTransactionPurpose =
            commandKind === 'move' && operationId !== undefined && uci !== undefined
              ? 'move_admission'
              : 'other_admission';

          const runStart = () =>
            operationId
              ? runWithLossyTransactionScope(
                  {
                    purpose,
                    gameId: params.gameId,
                    operationId,
                    commandKind,
                    uci,
                    basePly,
                    onInjected: (injection) => {
                      lostCommitTracker.recordInjection(injection);
                      if (routeCorr && routeCorr.gameId === params.gameId) {
                        routeCorr.injected = injection;
                      }
                    },
                  },
                  () => origStart(params),
                )
              : origStart(params);

          try {
            const res = await runStart();
            const duration = performance.now() - t0;
            tracker.recordStartAttempt(duration, basePly);
            if (res.status === 'started' || res.status === 'proving') {
              tracker.recordStartAdmitted(params.gameId, res.operationId, basePly, duration);
            } else if ((res.status === 'noop' || res.status === 'completed') && operationId) {
              tracker.clearUnresolvedStart(operationId);
            }
            return res;
          } catch (err) {
            tracker.recordStartAttempt(performance.now() - t0, basePly);
            throw err;
          }
        };

        return store;
      };

      const makeReplica = (slotIndex: 0 | 1, barrier?: WorkerLossBarrier): Replica => {
        const store = wrapTimedStore(new PgAdjudicationStore(lossy), barrier);
        const origStartAdjudication = store.startAdjudication.bind(store);
        const eventStore = new PostgresEventStore(pool);
        const origEventAppend = eventStore.append.bind(eventStore);
        const executorId = randomUUID();
        let replicaRef: Replica | undefined;
        const publicationGuard = createReplicaPublicationGuard(
          slotIndex,
          (idx) => replicas[idx],
          () => replicaRef,
        );
        store.startAdjudication = publicationGuard.wrapAsyncCall('startAdjudication', origStartAdjudication);
        eventStore.append = publicationGuard.wrapAsyncCall('eventStore.append', origEventAppend);
        const guardedPubsub = new Proxy(pubsub, {
          get(target, prop, receiver) {
            if (prop === 'publish') {
              return publicationGuard.wrapSyncBroadcast(target.publish.bind(target));
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === 'function' ? val.bind(target) : val;
          },
        });
        const authority = new GameAuthority(guardedPubsub, () => Date.now(), eventStore, {
          adjudication: { rulesVersion: 'rocky-adjudication@1', clockPolicy: 'observed-release-v1', start: (p) => store.startAdjudication(p) },
        });
        const origAuthorityApply = authority.apply.bind(authority);
        authority.apply = publicationGuard.wrapAsyncCall('authority.apply', origAuthorityApply);
        const rawPublish = routedAdjudicationChange({ authority, router, hasLocalSessions: () => false });
        const worker = new AdjudicationWorker({
          store,
          executorId,
          leaseMs: 5_000,
          pollMs: 50,
          publish: publicationGuard.wrapPublish<AdjudicationChange>(rawPublish),
        });
        const resync = new AdjudicationResync({ authority, router, intervalMs: 500 });
        let stopWorkersPromise: Promise<void> | undefined;
        const stopWorkers = (): Promise<void> => {
          if (stopWorkersPromise) return stopWorkersPromise;
          stopWorkersPromise = (async () => {
            await Promise.allSettled([resync.stop(), worker.stop()]);
          })();
          return stopWorkersPromise;
        };
        let disposePromise: Promise<void> | undefined;
        const dispose = (): Promise<void> => {
          if (disposePromise) return disposePromise;
          disposePromise = (async () => {
            publicationGuard.markDisposed();
            await stopWorkers();
            for (const g of games) {
              authority.evict(g.id);
            }
            await eventStore.closePlayerLocks();
          })();
          return disposePromise;
        };
        replicaRef = {
          slotIndex,
          authority,
          worker,
          resync,
          store,
          eventStore,
          executorId,
          getStats: () => ({
            disposed: publicationGuard.isDisposed,
            publishCount: publicationGuard.publishCount,
            appendCount: publicationGuard.appendCount,
            broadcastCount: publicationGuard.broadcastCount,
            authorityApplyCount: publicationGuard.authorityApplyCount,
            stalePublishBlockedCount: publicationGuard.staleBlockedCount,
            staleAuthorityBlockedCount: publicationGuard.staleAuthorityBlockedCount,
            staleAppendBlockedCount: publicationGuard.staleAppendBlockedCount,
            staleBroadcastBlockedCount: publicationGuard.staleBroadcastBlockedCount,
          }),
          stopWorkers,
          dispose,
        };
        createdReplicas.add(replicaRef);
        return replicaRef;
      };

      replicas.push(makeReplica(0), makeReplica(1, worker1Barrier));
      for (const g of games) await replicas[g.owner]!.authority.ensureLoaded(g.id);
      for (const r of replicas) { r.worker.start(); r.resync.start(); }

      // --- correlation subscriptions ---
      for (const g of games) {
        const unsub = pubsub.subscribe(gameChannel(g.id), (msg: Broadcast) => {
          const now = performance.now();
          if (msg.t === 'move') {
            tracker.onMoveBroadcast(g.id, msg.ply, now, msg.uci);
          }
          if (msg.t === 'state') {
            const phase = msg.state.adjudication;
            tracker.onProvingState(g.id, phase === 'proving', now);
            tracker.onStoppedState(g.id, phase === 'stopped', now);
            tracker.onStateBroadcast(g.id, msg.state.ply, now, msg.state.moves);
          }
        });
        unsubs.push(unsub);
      }

      // --- reproducible players with basePly-anchored choice generation ---
      let refused = 0;
      let routeSuccessReturns = 0;

      const play = async (g: SoakGame) => {
        const gameSeed = deriveGameSeed(SOAK_SEED, g.index);
        let attempt = 0;
        for (let ply = 0; ply < PLIES; ply++) {
          if (!running) return;
          const thinkRnd = createPrng((gameSeed + ply * 101) >>> 0);
          await sleep(THINK_MS * (0.5 + thinkRnd()));
          if (!running) return;

          if (replicas[g.owner]!.getStats().disposed) {
            await sleep(10);
            ply--;
            continue;
          }
          let owner = replicas[g.owner]!.authority;
          let state;
          try {
            state = owner.getState(g.id);
          } catch {
            if (replicas[g.owner]!.getStats().disposed) {
              await sleep(10);
              ply--;
              continue;
            }
            owner = replicas[g.owner]!.authority;
            await owner.ensureLoaded(g.id);
            state = owner.getState(g.id);
          }
          if (state.ply > tracker.getObservedMoveCount(g.id)) {
            const recovery = await owner.readRecovery(g.id, 0);
            tracker.onRecoveryResponse(g.id, recovery.state.ply, performance.now(), recovery.state.moves);
            state = recovery.state;
          }
          if (state.status.over) {
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
          const routeCorr: MoveRouteCorrelation = { gameId: g.id, uci, basePly };
          try {
            await runWithMoveRouteCorrelation(routeCorr, () => router.route(g.id, user, { kind: 'move', uci }));
            if (routeCorr.injected) {
              lostCommitTracker.recordRouteOutcome(routeCorr.injected.operationId, 'unexpected_success');
              throw new Error(
                `Lost COMMIT injection on ${routeCorr.injected.operationId} (game ${g.id}, uci ${uci}) unexpectedly returned route success`,
              );
            }
            routeSuccessReturns++;
            attempt = 0;
          } catch (err: unknown) {
            if (routeCorr.injected?.routeOutcome === 'unexpected_success') {
              throw err;
            }
            const isAmbiguous =
              err instanceof AuthorityCommitError ||
              err instanceof CommandOutcomeUnknownError;
            if (routeCorr.injected) {
              const errName = err instanceof Error ? err.name : typeof err;
              lostCommitTracker.recordRouteOutcome(
                routeCorr.injected.operationId,
                isAmbiguous ? 'uncertain_error' : 'non_uncertain_error',
                errName,
              );
              if (!isAmbiguous) {
                throw new Error(
                  `Lost COMMIT injection on ${routeCorr.injected.operationId} surfaced non-uncertain error ${errName}: ${String(err)}`,
                );
              }
            }
            refused++;
            tracker.onMoveFailed(g.id, basePly, isAmbiguous ? 'ambiguous_commit' : 'definite_failure', uci);
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

        // Stage 1: Scoped lost COMMIT reply on an actual move admission (deterministic targeting + durable proof)
        tracker.recordFaultStart('lossy_commits', performance.now());
        const eligibleLossyGame = games.find((g) => {
          try {
            const st = replicas[g.owner]!.authority.getState(g.id);
            return !st.status.over && st.ply < PLIES;
          } catch {
            return false;
          }
        });
        commitControl.targetGameId = eligibleLossyGame?.id;
        commitControl.targetMinLost = 1;
        commitControl.maxLost = 1;
        commitControl.rate = 0;
        commitControl.requireInsertInTx = true;
        commitControl.enabled = true;

        const faultWaitStart = performance.now();
        while (running && lostCommitTracker.injectedCount < 1 && performance.now() - faultWaitStart < 30_000) {
          if (commitControl.targetGameId !== undefined && performance.now() - faultWaitStart > 5_000) {
            commitControl.targetGameId = undefined;
          }
          await sleep(50);
        }
        commitControl.enabled = false;
        commitControl.targetGameId = undefined;
        if (lostCommitTracker.injectedCount === 0 && running) {
          throw new Error('Fault coverage unexercised: 0 lost COMMIT replies occurred on move admission within fault window');
        }

        const injectedRecord = lostCommitTracker.getInjections()[0]!;
        const durableWaitStart = performance.now();
        let verifiedInjectedAdmission = false;
        let durableVerifyFailureReason = 'timed out waiting for persisted AdjudicationStarted and non-pending routeOutcome';
        while (running && performance.now() - durableWaitStart < 15_000) {
          const adjRes = await pool.query<{
            execution_state: string;
            started_seq: number | null;
          }>(
            `SELECT execution_state, started_seq
             FROM game_adjudications
             WHERE game_id = $1 AND operation_id = $2`,
            [injectedRecord.gameId, injectedRecord.operationId],
          );
          const adjRow = adjRes.rows[0];
          if (adjRow) {
            durableVerifyFailureReason = `execution_state=${adjRow.execution_state}, routeOutcome=${injectedRecord.routeOutcome}`;
          } else if (injectedRecord.routeOutcome !== 'pending') {
            durableVerifyFailureReason = `missing game_adjudications row for operationId=${injectedRecord.operationId}, routeOutcome=${injectedRecord.routeOutcome}`;
          }
          if (adjRow && injectedRecord.routeOutcome !== 'pending') {
            const evRes =
              adjRow.started_seq !== null
                ? await pool.query<{ seq: number; type: string; payload: unknown }>(
                    `SELECT seq, type, payload
                     FROM game_events
                     WHERE game_id = $1 AND seq = $2
                     ORDER BY seq ASC`,
                    [injectedRecord.gameId, adjRow.started_seq],
                  )
                : { rows: [] as Array<{ seq: number; type: string; payload: unknown }> };
            const detail = lostCommitTracker.verifyAdmissionStartedDetailed(injectedRecord.operationId, {
              gameId: injectedRecord.gameId,
              operationId: injectedRecord.operationId,
              executionState: adjRow.execution_state,
              startedSeq: adjRow.started_seq,
              events: evRes.rows,
            });
            if (detail.valid) {
              verifiedInjectedAdmission = true;
            } else {
              durableVerifyFailureReason = detail.reason;
            }
            break;
          }
          await sleep(50);
        }
        if (running && !verifiedInjectedAdmission) {
          throw new Error(
            `Lost COMMIT move admission ${injectedRecord.operationId} (game ${injectedRecord.gameId}, uci ${injectedRecord.uci}) failed uncertain-route or durable AdjudicationStarted verification: ${durableVerifyFailureReason}`,
          );
        }
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
        preRestartReplica0ExecutorId = replicas[0]!.executorId;
        if (!running) return;

        // Stage 3: Genuine cold restart of owner replica 0 (replace worker, store/eventStore, authority, resync; dispose old)
        tracker.recordFaultStart('owner_0_cold_restart', performance.now());
        const coldRestartOwner0 = async (): Promise<void> => {
          const oldReplica = replicas[0]!;
          oldReplica0Ref = oldReplica;

          // Pause new owner-0 work at route boundary, drain commands already dispatched to owner 0,
          // stop resync & worker (whose ADJUDICATION_ACTOR route paths bypass the pause so they cannot deadlock),
          // drain any residual bypass calls and fence the slot before disposing old replica.
          await owner0Gate.pauseAndDrain();
          await oldReplica.stopWorkers();
          await owner0Gate.drainAndFence();
          assert.equal(owner0Gate.inFlightCount, 0, 'owner 0 must have zero in-flight route calls at cutover');

          await oldReplica.dispose();
          const oldStatsAtDispose = oldReplica.getStats();
          oldReplica0PublishCountAtDispose = oldStatsAtDispose.publishCount;
          oldReplica0AppendCountAtDispose = oldStatsAtDispose.appendCount;
          oldReplica0BroadcastCountAtDispose = oldStatsAtDispose.broadcastCount;

          const heldByOldRes = await pool.query<{ operation_id: string }>(
            `SELECT operation_id
             FROM game_adjudications
             WHERE executor_id = $1 AND execution_state = 'proving'`,
            [oldReplica.executorId],
          );
          const heldByOldIds = heldByOldRes.rows.map((r) => r.operation_id);
          abandonedAtColdRestartCount = heldByOldIds.length;

          const replacement = makeReplica(0);
          postRestartReplica0ExecutorId = replacement.executorId;
          coldRestartDistinctResourcesVerified =
            oldReplica.getStats().disposed === true &&
            replacement.executorId !== oldReplica.executorId &&
            replacement.store !== oldReplica.store &&
            replacement.eventStore !== oldReplica.eventStore &&
            replacement.authority !== oldReplica.authority &&
            replacement.worker !== oldReplica.worker &&
            replacement.resync !== oldReplica.resync;

          replicas[0] = replacement;
          for (const g of games.filter((x) => x.owner === 0)) {
            await replacement.authority.ensureLoaded(g.id);
            const recovery = await replacement.authority.readRecovery(g.id, 0);
            await verifyRecoverySnapshot(g.id, recovery.state);
            tracker.onRecoveryResponse(g.id, recovery.state.ply, performance.now(), recovery.state.moves);
          }
          replacement.worker.start();
          replacement.resync.start();
          owner0Gate.resume();

          const owner0SampleGame = games.find((x) => x.owner === 0);
          if (owner0SampleGame) {
            await router.route(owner0SampleGame.id, ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });
            coldRestartLiveRoutingVerified =
              replacement.authority.has(owner0SampleGame.id) &&
              !oldReplica.authority.has(owner0SampleGame.id);

            await assert.rejects(
              () => oldReplica.authority.apply(owner0SampleGame.id, ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' }),
              /Stale replica/,
            );
            const oldStatsAfterStaleAttempt = oldReplica.getStats();
            coldRestartStaleCommandBlockedVerified =
              oldStatsAfterStaleAttempt.staleAuthorityBlockedCount >= 1 &&
              oldStatsAfterStaleAttempt.appendCount === oldReplica0AppendCountAtDispose &&
              oldStatsAfterStaleAttempt.broadcastCount === oldReplica0BroadcastCountAtDispose &&
              oldStatsAfterStaleAttempt.publishCount === oldReplica0PublishCountAtDispose;
          }

          if (heldByOldIds.length > 0) {
            const reclaimWaitStart = performance.now();
            const reclaimedSet = new Set<string>();
            while (running && reclaimedSet.size < heldByOldIds.length && performance.now() - reclaimWaitStart < 15_000) {
              const checkRes = await pool.query<{
                operation_id: string;
                executor_id: string | null;
                execution_state: string;
              }>(
                `SELECT operation_id, executor_id, execution_state
                 FROM game_adjudications
                 WHERE operation_id = ANY($1::uuid[])`,
                [heldByOldIds],
              );
              for (const row of checkRes.rows) {
                if (row.executor_id !== oldReplica.executorId || row.execution_state !== 'proving') {
                  reclaimedSet.add(row.operation_id);
                }
              }
              if (reclaimedSet.size >= heldByOldIds.length) break;
              await sleep(50);
            }
            abandonedColdRestartReclaimedCount = reclaimedSet.size;
            if (running && abandonedColdRestartReclaimedCount < heldByOldIds.length) {
              throw new Error(
                `Owner 0 cold restart left ${heldByOldIds.length - abandonedColdRestartReclaimedCount} proving operation(s) unreclaimed within 15000ms`,
              );
            }
          } else {
            abandonedColdRestartReclaimedCount = 0;
          }
        };
        await coldRestartOwner0();
        tracker.recordFaultEnd('owner_0_cold_restart', performance.now());
      };

      const started = performance.now();
      progressTimer = setInterval(() => {
        const elapsedSec = ((performance.now() - started) / 1000).toFixed(1);
        console.log(
          `[soak progress] elapsed: ${elapsedSec}s, routeSuccessReturns: ${routeSuccessReturns}, activeProofs: ${tracker.activeOpsCount}, lostCommits: ${lost.lost}`,
        );
      }, 30_000);

      const taskPromises = [...games.map(play), faults()];
      try {
        await Promise.all(taskPromises);
      } catch (runErr) {
        running = false;
        worker1Barrier.abort('run error teardown');
        await owner0Gate.abort(runErr instanceof Error ? runErr.message : String(runErr));
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

      // Final drain: give a lagging game with durable committed moves but missing observation one explicit genuine recovery request
      for (const g of games) {
        const owner = replicas[g.owner]!.authority;
        let view: StateView;
        try {
          view = owner.getState(g.id);
        } catch {
          await owner.ensureLoaded(g.id);
          view = owner.getState(g.id);
        }
        if (view.ply > tracker.getObservedMoveCount(g.id)) {
          const recovery = await owner.readRecovery(g.id, 0);
          await verifyRecoverySnapshot(g.id, recovery.state);
          tracker.onRecoveryResponse(g.id, recovery.state.ply, performance.now(), recovery.state.moves);
        }
      }

      // Final drain durable proof: verify every lost-COMMIT move admission settled with its exact matching MovePlayed
      for (const injected of lostCommitTracker.getInjections()) {
        const adjRes = await pool.query<{
          execution_state: string;
          started_seq: number | null;
          final_seq: number | null;
        }>(
          `SELECT execution_state, started_seq, final_seq
           FROM game_adjudications
           WHERE game_id = $1 AND operation_id = $2`,
          [injected.gameId, injected.operationId],
        );
        const adjRow = adjRes.rows[0];
        if (!adjRow) {
          throw new Error(
            `Lost COMMIT move admission ${injected.operationId} (game ${injected.gameId}, uci ${injected.uci}) missing game_adjudications row at final drain`,
          );
        }
        const evRes =
          adjRow.started_seq !== null && adjRow.final_seq !== null
            ? await pool.query<{ seq: number; type: string; payload: unknown }>(
                `SELECT seq, type, payload
                 FROM game_events
                 WHERE game_id = $1 AND seq >= $2 AND seq <= $3
                 ORDER BY seq ASC`,
                [injected.gameId, adjRow.started_seq, adjRow.final_seq],
              )
            : { rows: [] as Array<{ seq: number; type: string; payload: unknown }> };
        const detail = lostCommitTracker.verifyDurableEvidenceDetailed(injected.operationId, {
          gameId: injected.gameId,
          operationId: injected.operationId,
          executionState: adjRow.execution_state,
          startedSeq: adjRow.started_seq,
          finalSeq: adjRow.final_seq,
          events: evRes.rows,
        });
        if (!detail.valid) {
          throw new Error(
            `Lost COMMIT move admission ${injected.operationId} (game ${injected.gameId}, uci ${injected.uci}) failed final durable MovePlayed verification: ${detail.reason}`,
          );
        }
      }

      let totalDurableMoves = 0;
      let totalActualPlies = 0;
      let earlyEndings = 0;
      for (const g of games) {
        const logged = (await pool.query('SELECT payload FROM game_events WHERE game_id = $1 ORDER BY seq', [g.id])).rows.map((r) => r.payload as GameEvent);
        const replayed = Game.fromEvents(logged);
        const owner = replicas[g.owner]!.authority;
        const view = owner.getState(g.id);
        assertStateViewMatchesReplay(view, replayed, logged.length);
        const resolved = logged.filter((e) => e.type === 'AdjudicationResolved').length;
        const startedN = logged.filter((e) => e.type === 'AdjudicationStarted').length;
        assert.equal(resolved, startedN, 'every admitted command settled exactly once');

        const moveEvents = logged.filter((e): e is MovePlayedEvent => e.type === 'MovePlayed');
        const moveEventsCount = moveEvents.length;
        totalDurableMoves += moveEventsCount;
        totalActualPlies += replayed.ply;
        if (replayed.ply < PLIES) earlyEndings++;

        const observedMoves = tracker.getObservedMovesForGame(g.id);
        const parsePly = (k: string) => Number(k.split(':')[0]);
        const sortKeys = (a: string, b: string) => parsePly(a) - parsePly(b) || a.localeCompare(b);
        const expectedKeys = moveEvents.map((m) => `${m.ply}:${m.uci}`).sort(sortKeys);
        const observedKeys = observedMoves.map((m) => `${m.ply}:${m.uci}`).sort(sortKeys);
        const missing = expectedKeys.filter((k) => !observedKeys.includes(k));
        const extra = observedKeys.filter((k) => !expectedKeys.includes(k));
        const diffMessage = `game ${g.id} move mismatch: observed ${observedMoves.length} vs durable ${moveEventsCount}; missing=[${missing.join(', ')}], extra=[${extra.join(', ')}]`;
        assert.equal(observedMoves.length, moveEventsCount, diffMessage);
        assert.deepEqual(observedKeys, expectedKeys, diffMessage);

        const snap = replayed.snapshot();
        for (const side of ['w', 'b'] as const) {
          assert.ok(snap.clock.remaining[side] >= 0);
          assert.ok(snap.clock.remaining[side] <= tc.initialMs + tc.incrementMs * replayed.ply);
        }
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
        routeSuccessReturns,
        durableMoves: totalDurableMoves,
        moves: totalDurableMoves,
        refusedRetries: refused,
        lostCommitReplies: lostCommitTracker.verifiedCommittedCount,
        faultCoverage: {
          lostCommitReplies: lostCommitTracker.verifiedCommittedCount,
          lostCommitMoveAdmission: {
            injectedCount: lostCommitTracker.injectedCount,
            uncertainRouteCount: lostCommitTracker.uncertainRouteCount,
            verifiedCommittedCount: lostCommitTracker.verifiedCommittedCount,
            rawProxyLostCount: lost.lost,
            injections: lostCommitTracker.getInjections().map((rec) => {
              const queuedElapsedMs = tracker.getOperationQueuedMs(rec.operationId);
              return {
                operationId: rec.operationId,
                gameId: rec.gameId,
                uci: rec.uci,
                basePly: rec.basePly,
                commandKind: rec.commandKind,
                purpose: rec.purpose,
                hadInsertInTx: rec.hadInsertInTx,
                routeOutcome: rec.routeOutcome,
                routeErrorName: rec.routeErrorName,
                admissionVerified: rec.admissionVerified ?? false,
                durableVerified: rec.durableVerified,
                ...(queuedElapsedMs !== undefined ? { queuedElapsedMs } : {}),
              };
            }),
          },
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
          ownerColdRestart: {
            oldExecutorId: preRestartReplica0ExecutorId,
            newExecutorId: postRestartReplica0ExecutorId,
            distinctResourcesVerified: coldRestartDistinctResourcesVerified,
            liveRoutingVerified: coldRestartLiveRoutingVerified,
            staleCommandBlockedVerified: coldRestartStaleCommandBlockedVerified,
            oldReplicaDisposed: oldReplica0Ref?.getStats().disposed ?? false,
            oldPublishCountAtDispose: oldReplica0PublishCountAtDispose,
            oldPublishCountAtEnd: oldReplica0Ref?.getStats().publishCount ?? 0,
            oldAppendCountAtDispose: oldReplica0AppendCountAtDispose,
            oldAppendCountAtEnd: oldReplica0Ref?.getStats().appendCount ?? 0,
            oldBroadcastCountAtDispose: oldReplica0BroadcastCountAtDispose,
            oldBroadcastCountAtEnd: oldReplica0Ref?.getStats().broadcastCount ?? 0,
            oldStalePublishBlockedCount: oldReplica0Ref?.getStats().stalePublishBlockedCount ?? 0,
            oldStaleAuthorityBlockedCount: oldReplica0Ref?.getStats().staleAuthorityBlockedCount ?? 0,
            oldStaleAppendBlockedCount: oldReplica0Ref?.getStats().staleAppendBlockedCount ?? 0,
            oldStaleBroadcastBlockedCount: oldReplica0Ref?.getStats().staleBroadcastBlockedCount ?? 0,
            abandonedHeldCount: abandonedAtColdRestartCount,
            abandonedReclaimedCount: abandonedColdRestartReclaimedCount,
          },
        },
        wallSeconds: +(wall / 1000).toFixed(1),
        movesPerSecond: +(totalDurableMoves / (wall / 1000)).toFixed(2),
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
      assert.ok(totalDurableMoves >= GAMES * Math.min(PLIES, 4), 'games made progress');
      assert.ok(report.moveLatencyMs.n > 0, 'moveLatency samples must not be empty');
      assert.equal(report.moveLatencyMs.n, report.durableMoves, 'moveLatency sample count must equal durable committed moves');
      assert.equal(report.durableMoves, report.actualPlies, 'durable committed moves must equal replayed actual plies');
      const provSum =
        report.moveLatencyMs.provenance.move_broadcast +
        report.moveLatencyMs.provenance.state_broadcast +
        report.moveLatencyMs.provenance.recovery_response;
      assert.equal(provSum, report.moveLatencyMs.n, 'provenance counts must sum to total moveLatency samples');
      assert.ok(report.faultCoverage.lostCommitReplies >= 1, 'must exercise at least one verified lost COMMIT reply');
      assert.ok(report.faultCoverage.lostCommitMoveAdmission.injectedCount >= 1, 'must inject at least one scoped move-admission lost COMMIT');
      assert.equal(
        report.faultCoverage.lostCommitMoveAdmission.uncertainRouteCount,
        report.faultCoverage.lostCommitMoveAdmission.injectedCount,
        'every lost COMMIT move admission must surface an uncertain route result',
      );
      assert.equal(
        report.faultCoverage.lostCommitMoveAdmission.verifiedCommittedCount,
        report.faultCoverage.lostCommitMoveAdmission.injectedCount,
        'every lost COMMIT move admission must match durable MovePlayed + AdjudicationResolved persistence',
      );
      assert.ok(
        report.faultCoverage.lostCommitMoveAdmission.injections.every(
          (inj) =>
            inj.purpose === 'move_admission' &&
            inj.commandKind === 'move' &&
            inj.hadInsertInTx &&
            inj.admissionVerified &&
            inj.durableVerified,
        ),
        'all lost COMMIT injections must correlate to move_admission transactions with durable proof',
      );
      assert.ok(report.faultCoverage.heldAtDeath >= 1, 'worker 1 must hold at least one claim at death');
      assert.ok(report.faultCoverage.successorTakeovers >= 1, 'successor worker must take over at least one abandoned claim');
      assert.equal(report.faultCoverage.targetTakeover.operationId, targetOpId);
      assert.equal(report.faultCoverage.targetTakeover.successorExecutorId, preRestartReplica0ExecutorId);
      assert.notEqual(postRestartReplica0ExecutorId, '', 'owner cold restart must produce a replacement executorId');
      assert.notEqual(postRestartReplica0ExecutorId, preRestartReplica0ExecutorId, 'owner cold restart must replace executorId');
      assert.equal(replicas[0]!.executorId, postRestartReplica0ExecutorId, 'active owner 0 replica must be the cold replacement');
      assert.equal(report.faultCoverage.ownerColdRestart.distinctResourcesVerified, true, 'owner cold restart must replace worker, store, eventStore, authority and resync');
      assert.equal(report.faultCoverage.ownerColdRestart.liveRoutingVerified, true, 'owner cold restart must bind live routing to replacement authority');
      assert.equal(report.faultCoverage.ownerColdRestart.staleCommandBlockedVerified, true, 'old owner replica must reject stale commands after cutover');
      assert.equal(report.faultCoverage.ownerColdRestart.oldReplicaDisposed, true, 'old owner replica must be disposed after cold restart');
      assert.equal(
        report.faultCoverage.ownerColdRestart.oldPublishCountAtEnd,
        report.faultCoverage.ownerColdRestart.oldPublishCountAtDispose,
        'old owner replica must not publish after disposal',
      );
      assert.equal(
        report.faultCoverage.ownerColdRestart.oldAppendCountAtEnd,
        report.faultCoverage.ownerColdRestart.oldAppendCountAtDispose,
        'old owner replica must not append events after disposal',
      );
      assert.equal(
        report.faultCoverage.ownerColdRestart.oldBroadcastCountAtEnd,
        report.faultCoverage.ownerColdRestart.oldBroadcastCountAtDispose,
        'old owner replica must not broadcast after disposal',
      );
      assert.equal(
        report.faultCoverage.ownerColdRestart.abandonedReclaimedCount,
        report.faultCoverage.ownerColdRestart.abandonedHeldCount,
        'any proving work held by old owner replica must be reclaimed after cold restart',
      );
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
      await owner0Gate.abort('test teardown');
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = undefined;
      }
      sampler.stop();
      loop.disable();
      for (const unsub of unsubs) {
        try { unsub(); } catch { /* cleanup */ }
      }
      for (const r of createdReplicas) {
        try { await r.dispose(); } catch { /* cleanup */ }
      }
    }
  });
});
