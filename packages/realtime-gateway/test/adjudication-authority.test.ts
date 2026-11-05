/**
 * The authority's adjudicated path, hermetically (Issue #124, ADR-0176). A fake admission appends
 * `AdjudicationStarted` exactly as the store does, so the authority's own decisions are tested: what
 * it admits, how it maps refusals, what it publishes, how it folds a recorded release, and that it
 * refuses a release that differs from the stop it records. Real PostgreSQL is covered in
 * services/gateway/test/adjudication-gateway.integration.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AdjudicationJobController,
  Game,
  GameError,
  prepareAuthoritativeCommand,
  type AdjudicationStartedEvent,
  type GameEvent,
  type PreparedOperation,
} from '@chess-platform/game';
import { ADJUDICATION_ACTOR, AuthorityCommitError, AuthorityError, FLAG_ACTOR, GameAuthority, type AdjudicationAdmission } from '../src/authority';
import { InMemoryEventLog } from '../src/event-log';
import { InMemoryPubSub, gameChannel } from '../src/pubsub';
import type { Broadcast } from '../src/protocol';

const FEN_MATE1 = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';
const TC = { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 } as const;

function startedFor(op: PreparedOperation): AdjudicationStartedEvent {
  return {
    type: 'AdjudicationStarted', gameId: op.gameId, operationId: op.operationId, baseRevision: op.baseRevision,
    at: op.at, rulesVersion: op.rulesVersion, prepared: op, ...(op.clockPolicy ? { clockPolicy: op.clockPolicy } : {}),
  };
}

/** Appends Started as the store does; records what it was asked. */
class FakeAdmission implements AdjudicationAdmission {
  readonly rulesVersion = 'rocky-adjudication@1';
  readonly clockPolicy = 'observed-release-v1' as const;
  readonly requests: Array<Parameters<AdjudicationAdmission['start']>[0]> = [];
  failWith: Error | undefined;
  constructor(private readonly log: InMemoryEventLog) {}
  async start(params: Parameters<AdjudicationAdmission['start']>[0]): Promise<{ status: 'started' | 'noop' }> {
    this.requests.push(params);
    if (this.failWith) throw this.failWith;
    const logged = await this.log.load(params.gameId);
    const game = Game.fromEvents(logged.map((e) => e.event));
    let op: PreparedOperation;
    if ('prepared' in params) {
      op = params.prepared;
    } else {
      const adm = prepareAuthoritativeCommand(game, params.command, params.context);
      if (adm.kind === 'noop') return { status: 'noop' };
      op = adm.operation;
    }
    await this.log.append(params.gameId, logged.length - 1, [startedFor(op)]);
    return { status: 'started' };
  }
}

async function setup(clock: { now: number }) {
  const log = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const admission = new FakeAdmission(log);
  const created = Game.create({ gameId: 'g1', players: { white: 'w', black: 'b' }, timeControl: TC, rated: false, at: 1000, initialFen: FEN_MATE1 });
  await log.append('g1', -1, created.events);
  const authority = new GameAuthority(pubsub, () => clock.now, log, { adjudication: admission });
  await authority.ensureLoaded('g1');
  const room: Broadcast[] = [];
  pubsub.subscribe(gameChannel('g1'), (m) => room.push(m));
  return { log, admission, authority, room };
}

/** Settle and release the pending operation as the worker would, straight into the log. */
async function settleAndRelease(log: InMemoryEventLog, at: number, releaseAt: number): Promise<void> {
  const logged = await log.load('g1');
  const game = Game.fromEvents(logged.map((e) => e.event));
  const pending = game.adjudication!;
  const ctrl = new AdjudicationJobController();
  ctrl.createJob(pending.prepared, game);
  while (ctrl.getJob(pending.operationId)!.status === 'active') ctrl.stepJob(pending.operationId, 1000);
  const settled = ctrl.settleJob(game, pending.operationId, at);
  await log.append('g1', logged.length - 1, settled.batch);
  const released = settled.game.prepareClockRelease({ releaseRequestId: `stop:${pending.operationId}`, at: releaseAt });
  await log.append('g1', logged.length - 1 + settled.batch.length, [released.event]);
}

test('a player command is admitted, not applied; the room sees the game proving', async () => {
  const clock = { now: 2000 };
  const { admission, authority, room } = await setup(clock);
  const res = await authority.apply('g1', 'w', { kind: 'move', uci: 'e7e4' });
  assert.deepEqual(res.events.map((e) => e.type), ['AdjudicationStarted']);
  const req = admission.requests[0]!;
  assert.ok('command' in req);
  assert.deepEqual(req.command, { kind: 'move', uci: 'e7e4' });
  assert.equal(req.context.color, 'w');
  assert.equal(req.context.at, 2000);
  assert.equal(req.context.clockPolicy, 'observed-release-v1');
  assert.equal(authority.getState('g1').adjudication, 'proving');
  assert.deepEqual(room.map((m) => m.t), ['state']);
  // Nothing may be played while proving.
  await assert.rejects(authority.apply('g1', 'b', { kind: 'resign' }), (e: unknown) => e instanceof AuthorityError && e.code === 'invalid_command');
  assert.equal(admission.requests.length, 1);
});

test('refusals: not a player, not your turn, an illegal move, an uncertain admission', async () => {
  const clock = { now: 2000 };
  const { admission, authority } = await setup(clock);
  await assert.rejects(authority.apply('g1', 'x', { kind: 'resign' }), (e: unknown) => e instanceof AuthorityError && e.code === 'not_a_player');
  await assert.rejects(authority.apply('g1', 'b', { kind: 'move', uci: 'h8g8' }), (e: unknown) => e instanceof AuthorityError && e.code === 'not_your_turn');
  admission.failWith = new GameError('Illegal move');
  await assert.rejects(authority.apply('g1', 'w', { kind: 'move', uci: 'e7e1' }), (e: unknown) => e instanceof AuthorityError && e.code === 'illegal_move');
  admission.failWith = new Error('connection reset');
  await assert.rejects(authority.apply('g1', 'w', { kind: 'move', uci: 'e7e4' }), (e: unknown) => e instanceof AuthorityCommitError);
  // Only the server may report an adjudication, and only the flag actor may expire a clock.
  await assert.rejects(authority.apply('g1', 'w', { kind: 'adjudicationChanged' }), (e: unknown) => e instanceof AuthorityError && e.code === 'not_a_player');
  await assert.rejects(authority.apply('g1', 'w', { kind: 'expireFlag' }), (e: unknown) => e instanceof AuthorityError && e.code === 'not_a_player');
  await assert.rejects(authority.apply('g1', FLAG_ACTOR, { kind: 'expireFlag' }), (e: unknown) => e instanceof AuthorityError && e.code === 'invalid_command');
});

test('the owner folds a settlement and its release and publishes them in order', async () => {
  const clock = { now: 2000 };
  const { log, authority, room } = await setup(clock);
  await authority.apply('g1', 'w', { kind: 'move', uci: 'e7e4' });
  await settleAndRelease(log, 2100, 2200);
  const res = await authority.apply('g1', ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });
  assert.deepEqual(res.events.map((e) => e.type), ['AdjudicationResolved', 'MovePlayed', 'AdjudicationClocksStarted']);
  assert.deepEqual(room.map((m) => m.t), ['state', 'move', 'state']);
  const state = authority.getState('g1');
  assert.equal(state.adjudication, undefined);
  assert.equal(state.turn, 'b');
  const logged = await log.load('g1');
  assert.equal(state.fen, Game.fromEvents(logged.map((e) => e.event)).fen);
  assert.equal(state.stateRevision, logged.length - 1);
  // A repeated notice with nothing new publishes nothing.
  await authority.apply('g1', ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });
  assert.equal(room.length, 3);
});

test('a lost notice heals on the next command: the owner folds the log before deciding', async () => {
  const clock = { now: 2000 };
  const { log, admission, authority, room } = await setup(clock);
  await authority.apply('g1', 'w', { kind: 'move', uci: 'e7e4' });
  await settleAndRelease(log, 2100, 2200);
  // No adjudicationChanged arrives. Black's command still sees the released game and is admitted.
  clock.now = 3000;
  const res = await authority.apply('g1', 'b', { kind: 'move', uci: 'h8g8' });
  assert.deepEqual(res.events.map((e) => e.type), ['AdjudicationStarted']);
  assert.equal(admission.requests.length, 2);
  assert.deepEqual(room.map((m) => m.t), ['state', 'move', 'state', 'state'], 'settlement published before the new proof');
});

test('a logged release that differs from the recorded stop is refused on rebuild', async () => {
  const clock = { now: 2000 };
  const { log, authority } = await setup(clock);
  await authority.apply('g1', 'w', { kind: 'move', uci: 'e7e4' });
  await settleAndRelease(log, 2100, 2200);
  const logged = await log.load('g1');
  const forged = logged.map((e) => e.event).map((ev): GameEvent =>
    ev.type === 'AdjudicationClocksStarted' ? ({ ...ev, ply: ev.ply + 1 } as GameEvent) : ev);
  const tampered = new InMemoryEventLog();
  await tampered.append('g1', -1, forged);
  const cold = new GameAuthority(new InMemoryPubSub(), () => clock.now, tampered);
  await assert.rejects(cold.ensureLoaded('g1'));
  // The genuine log rebuilds.
  const genuine = new GameAuthority(new InMemoryPubSub(), () => clock.now, log);
  assert.equal(await genuine.ensureLoaded('g1'), true);
  assert.equal(genuine.getState('g1').fen, Game.fromEvents(logged.map((e) => e.event)).fen);
  assert.equal(authority.getState('g1').adjudication, 'proving', 'the live copy waits for the notice');
});

test('without an admission the authority applies commands exactly as before', async () => {
  const log = new InMemoryEventLog();
  const created = Game.create({ gameId: 'g1', players: { white: 'w', black: 'b' }, timeControl: TC, rated: false, at: 1000 });
  await log.append('g1', -1, created.events);
  const authority = new GameAuthority(new InMemoryPubSub(), () => 2000, log);
  await authority.ensureLoaded('g1');
  const res = await authority.apply('g1', 'w', { kind: 'move', uci: 'e2e4' });
  assert.deepEqual(res.events.map((e) => e.type), ['MovePlayed']);
  assert.equal(res.state.adjudication, undefined);
  assert.equal('adjudication' in res.state, false);
});

/** A sourced game whose seats must both be ready, with its own fake admission. */
async function setupSourced(clock: { now: number }) {
  const log = new InMemoryEventLog();
  const admission = new FakeAdmission(log);
  const created = Game.create({
    gameId: 'g1', players: { white: 'w', black: 'b' }, timeControl: TC, rated: false, at: 1000,
    source: 'seek', noShowAfterMs: 60_000,
  });
  await log.append('g1', -1, created.events);
  const authority = new GameAuthority(new InMemoryPubSub(), () => clock.now, log, { adjudication: admission });
  await authority.ensureLoaded('g1');
  return { log, admission, authority };
}

test('a move before both seats are ready is refused not_ready, as without adjudication', async () => {
  const clock = { now: 2000 };
  const { admission, authority } = await setupSourced(clock);
  await assert.rejects(authority.apply('g1', 'w', { kind: 'move', uci: 'e2e4' }), (e: unknown) => e instanceof AuthorityError && e.code === 'not_ready');
  assert.equal(admission.requests.length, 0);
});

test('a flag claim with the no-show already due records the no-show', async () => {
  const clock = { now: 1000 + 60_000 + 5 };
  const { admission, authority } = await setupSourced(clock);
  const res = await authority.apply('g1', 'w', { kind: 'claimFlag' });
  assert.deepEqual(res.events.map((e) => e.type), ['AdjudicationStarted']);
  const req = admission.requests[0]!;
  assert.ok('prepared' in req);
  assert.equal(req.prepared.intent.kind, 'expireNoShow');
});

test('a command after a release folded from a replica whose clock runs ahead is admitted at the release floor', async () => {
  const clock = { now: 2000 };
  const { log, admission, authority } = await setup(clock);
  await authority.apply('g1', 'w', { kind: 'move', uci: 'e7e4' });
  // The worker released at 2500 by its own clock; this owner's clock still reads 2400.
  await settleAndRelease(log, 2100, 2500);
  clock.now = 2400;
  const res = await authority.apply('g1', 'b', { kind: 'move', uci: 'h8g8' });
  assert.deepEqual(res.events.map((e) => e.type), ['AdjudicationStarted']);
  const req = admission.requests.at(-1)!;
  assert.ok('command' in req);
  assert.equal(req.context.at, 2500);
});

test('the owner reads only the log suffix after its copy when the store supports it', async () => {
  const clock = { now: 2000 };
  const { log, authority } = await setup(clock);
  const reads: string[] = [];
  const load = log.load.bind(log);
  const loadSince = log.loadSince?.bind(log);
  log.load = async (gameId, signal) => { reads.push('load'); return load(gameId, signal); };
  if (loadSince) log.loadSince = async (gameId, after, signal) => { reads.push(`since:${after}`); return loadSince(gameId, after, signal); };
  await authority.apply('g1', ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });
  assert.ok(loadSince, 'the in-memory log offers suffix reads');
  assert.deepEqual(reads, ['since:0']);
});
