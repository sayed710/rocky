import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game,
  prepareMove,
  prepareReady,
  prepareDrawOffer,
  prepareAuthoritativeCommand,
  settlePrepared,
  evaluatePreparedProof,
  MAX_SAFE_TIMESTAMP_MS,
  type GameEvent,
  type PreparedOperation,
  type TimeControl,
} from '@chess-platform/game';
import { CorruptGameStreamError, projectGameStream, type StoredEvent } from '../src';
import { GamesProjectionWorker, type GamesProjectionBatch } from '../src/pg/games-projector';

const BLITZ: TimeControl = { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 };

function stored(events: readonly GameEvent[]): StoredEvent[] {
  return events.map((event, seq) => ({ gameId: 'g1', seq, version: 1, event, serverTs: 0 }));
}

/** Fool's mate: four plies, Black checkmates at ply 4. */
function foolsMate(): GameEvent[] {
  let { game, events } = Game.create({
    gameId: 'g1', variant: 'standard', timeControl: BLITZ,
    players: { white: 'w-player', black: 'b-player' }, rated: true, at: 1_000,
  });
  const log = [...events];
  for (const [i, uci] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) {
    ({ game, events } = game.playMove(uci, 2_000 + i));
    log.push(...events);
  }
  return log;
}

test('a creation-only stream projects the creation facts, zero plies and seq 0', () => {
  const [created] = foolsMate();
  const p = projectGameStream('g1', stored([created!]));
  assert.deepEqual(p, {
    id: 'g1', variant: 'standard', rated: true, speed: 'blitz', white: 'w-player', black: 'b-player',
    startedAt: new Date(1_000), plyCount: 0, lastSeq: 0, result: null, termination: null, endedAt: null,
  });
});

test('moves advance ply count and last seq, and the ending supplies result, termination and end time', () => {
  const log = foolsMate();
  const ending = log.at(-1)!;
  assert.equal(ending.type, 'GameEnded');
  const p = projectGameStream('g1', stored(log));
  assert.equal(p.plyCount, 4);
  assert.equal(p.lastSeq, log.length - 1);
  assert.equal(p.result, '0-1');
  assert.equal(p.termination, 'checkmate');
  assert.deepEqual(p.endedAt, new Date(ending.type === 'GameEnded' ? ending.at : NaN));
});

test('speed uses the canonical classification, including unlimited as correspondence', () => {
  const { events } = Game.create({
    gameId: 'g1', variant: 'standard', timeControl: { kind: 'unlimited' } as TimeControl,
    players: { white: 'a', black: 'b' }, rated: false, at: 5,
  });
  assert.equal(projectGameStream('g1', stored(events)).speed, 'correspondence');
});

test('streams no authority could write are rejected rather than partially projected', () => {
  const log = foolsMate();
  const cases: [string, StoredEvent[]][] = [
    ['empty', []],
    ['first event is not GameCreated', stored(log.slice(1))],
    ['gap in seq', stored(log).filter((e) => e.seq !== 2)],
    ['event after GameEnded', stored([...log, log[1]!])],
    ['second GameCreated', stored([log[0]!, log[0]!])],
    ['ply out of order', stored([log[0]!, log[2]!])],
    ['unreadable time control', stored([{ ...log[0]!, timeControl: null } as unknown as GameEvent])],
  ];
  for (const [name, stream] of cases) {
    assert.throws(() => projectGameStream('g1', stream), /game g1: /, name);
  }
});

function setupAdjudicationStream() {
  const created = Game.create({
    gameId: 'g1',
    initialFen: '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1',
    timeControl: { initialMs: 10000, incrementMs: 1000, delayMs: 0, kind: 'increment' },
    players: { white: 'w-player', black: 'b-player' },
    at: 1000,
  });
  const prepared = prepareMove(created.game, {
    uci: 'g6g5',
    at: 2000,
    operationId: 'op-1',
    rulesVersion: '1.0.0',
  });
  if (prepared.intent.kind !== 'move') throw new Error('Expected move intent');
  const startedEvent: GameEvent = {
    type: 'AdjudicationStarted',
    gameId: 'g1',
    operationId: prepared.operationId,
    baseRevision: prepared.baseRevision,
    at: prepared.at,
    rulesVersion: prepared.rulesVersion,
    prepared,
  };
  const blocked = created.game.withEvents([startedEvent]);
  const base = evaluatePreparedProof(prepared, { kind: 'global_deadness' }, { maxSteps: 1000 });
  const successor = evaluatePreparedProof(
    prepared,
    { kind: 'successor_deadness', successorFen: prepared.intent.successorFen },
    { maxSteps: 1000 },
  );
  if (!base || !successor) throw new Error('Proofs must succeed');
  const settlement = settlePrepared(blocked, { base, successor }, 3000);
  const events: readonly GameEvent[] = [...created.events, startedEvent, ...settlement.batch];
  return { created, prepared, startedEvent, settlement, events };
}

test('adjudication lifecycle in projection: complete stream projects, incomplete settling rejects', () => {
  const { created, startedEvent, settlement, events } = setupAdjudicationStream();

  const completeStream = stored(events);
  const p = projectGameStream('g1', completeStream);
  assert.equal(p.plyCount, 1);
  assert.equal(p.result, null);

  const provingStream = stored([...created.events, startedEvent]);
  const pProving = projectGameStream('g1', provingStream);
  assert.equal(pProving.result, null);
  assert.equal(pProving.plyCount, 0);

  const incompleteSettlingStream = stored([...created.events, startedEvent, settlement.resolved]);
  assert.throws(
    () => projectGameStream('g1', incompleteSettlingStream),
    /stream ends in incomplete settling state/,
  );
});

test('adjudication lifecycle in projection: startedSeq and operationId mismatches reject', () => {
  const { created, startedEvent, settlement } = setupAdjudicationStream();

  const seqMismatchResolved = {
    ...settlement.resolved,
    startedSeq: 999,
  };
  assert.throws(
    () => projectGameStream('g1', stored([...created.events, startedEvent, seqMismatchResolved, ...settlement.batch.slice(1)])),
    /AdjudicationResolved startedSeq mismatch/,
  );

  const opMismatchResolved = {
    ...settlement.resolved,
    operationId: 'op-different',
  };
  assert.throws(
    () => projectGameStream('g1', stored([...created.events, startedEvent, opMismatchResolved, ...settlement.batch.slice(1)])),
    /AdjudicationResolved operationId mismatch/,
  );

  const effectTypeMismatchStream = stored([
    ...created.events,
    startedEvent,
    settlement.resolved,
    {
      type: 'GameEnded',
      result: '1/2-1/2',
      termination: 'dead_position',
      winner: null,
      at: 3_000,
    },
  ]);
  assert.throws(
    () => projectGameStream('g1', effectTypeMismatchStream),
    /[Ss]ettling effect type mismatch/,
  );
});

test('projection rejects same joint balance tamper as domain', () => {
  const { events } = setupAdjudicationStream();
  const tampered: GameEvent[] = events.map(ev => {
    if (ev.type === 'AdjudicationResolved') {
      return {
        ...ev,
        effects: ev.effects.map(eff => eff.type === 'MovePlayed' ? { ...eff, remaining: { ...eff.remaining, w: 17 } } : eff),
      };
    }
    if (ev.type === 'MovePlayed') {
      return {
        ...ev,
        remaining: { ...ev.remaining, w: 17 },
      };
    }
    return ev;
  });
  assert.throws(
    () => projectGameStream('g1', stored(tampered)),
    (err: unknown) => err instanceof CorruptGameStreamError,
  );
});

test('projection rejects corrupted SAN in settling move', () => {
  const { events } = setupAdjudicationStream();
  const tampered: GameEvent[] = events.map(ev => {
    if (ev.type === 'MovePlayed') {
      return { ...ev, san: 'Qxg5#' };
    }
    return ev;
  });
  assert.throws(
    () => projectGameStream('g1', stored(tampered)),
    (err: unknown) => err instanceof CorruptGameStreamError,
  );
});

test('projection role matrix: missing required base evidence rejects across lifecycle operations', () => {
  const { created, startedEvent, settlement } = setupAdjudicationStream();
  const missingBaseResolved = {
    ...settlement.resolved,
    evidence: {},
  };
  assert.throws(
    () => projectGameStream('g1', stored([...created.events, startedEvent, missingBaseResolved, ...settlement.batch.slice(1)])),
    (err: unknown) => err instanceof CorruptGameStreamError && /without verified base|missing.*base|required.*base/i.test(err.message),
  );
});

test('pre-127 atomic game stream projects cleanly without strict legality gating', () => {
  const { events: [created] } = Game.create({
    gameId: 'atomic-pre127',
    variant: 'atomic',
    timeControl: BLITZ,
    players: { white: 'w-player', black: 'b-player' },
    rated: true,
    at: 1_000,
  });
  const ucis = ['e2e3', 'e7e6', 'e1e2', 'e8e7', 'e2d3', 'e7d6', 'd3d4', 'e6e5'];
  const sans = ['e3', 'e6', 'Ke2', 'Ke7', 'Kd3', 'Kd6', 'Kd4', 'e5'];
  const pre127Events: GameEvent[] = [created!];
  for (let i = 0; i < ucis.length; i++) {
    pre127Events.push({
      type: 'MovePlayed',
      ply: i + 1,
      uci: ucis[i]!,
      san: sans[i]!,
      by: i % 2 === 0 ? 'w' : 'b',
      moveTimeMs: 1000,
      remaining: { w: 180_000 - Math.floor((i + 2) / 2) * 1000, b: 180_000 - Math.floor((i + 1) / 2) * 1000 },
      at: 2_000 + i * 1000,
    });
  }
  pre127Events.push({
    type: 'MovePlayed',
    ply: 9,
    uci: 'd4e5',
    san: 'Kxe5',
    by: 'w',
    moveTimeMs: 1000,
    remaining: { w: 175_000, b: 176_000 },
    at: 10_000,
  });
  pre127Events.push({
    type: 'GameEnded',
    result: '0-1',
    termination: 'variant',
    winner: 'b',
    at: 10_000,
  });
  const p = projectGameStream('atomic-pre127', pre127Events.map((event, seq) => ({
    gameId: 'atomic-pre127',
    seq,
    version: 1,
    event,
    serverTs: 0,
  })));
  assert.equal(p.id, 'atomic-pre127');
  assert.equal(p.variant, 'atomic');
  assert.equal(p.plyCount, 9);
  assert.equal(p.result, '0-1');
  assert.equal(p.termination, 'variant');
});

const FEN_MATE = '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1';
const MAX = MAX_SAFE_TIMESTAMP_MS;
const unlimitedTC: TimeControl = { initialMs: 0, incrementMs: 0, delayMs: 0, kind: 'unlimited' };

function makeStarted(prepared: PreparedOperation): GameEvent {
  return {
    type: 'AdjudicationStarted',
    gameId: prepared.gameId,
    operationId: prepared.operationId,
    baseRevision: prepared.baseRevision,
    at: prepared.at,
    rulesVersion: prepared.rulesVersion,
    prepared,
  };
}

function parseJsonEvents(events: readonly GameEvent[]): GameEvent[] {
  const parsed: unknown = JSON.parse(JSON.stringify(events));
  if (!Array.isArray(parsed)) throw new Error('Expected array of GameEvent from JSON round-trip');
  return parsed as GameEvent[];
}

function storeStream(gameId: string, events: readonly GameEvent[]): StoredEvent[] {
  const deserialized = parseJsonEvents(events);
  return deserialized.map((event, seq) => ({ gameId, seq, version: 1, event, serverTs: 0 }));
}

test('projection round-trip: readiness exemption and selected second Ready near DateMax project cleanly', () => {
  const { game: tGame, event: tCreated } = Game.create({
    gameId: 'p-tourney-ready',
    variant: 'standard',
    initialFen: FEN_MATE,
    timeControl: unlimitedTC,
    players: { white: 'alice', black: 'bob' },
    source: 'tournament',
    noShowAfterMs: 1000,
    at: 1000,
  });
  const tReadyW = tGame.markReady('w', 1100);
  const readyBOp = prepareReady(tReadyW.game, {
    color: 'b',
    at: 1500,
    operationId: 'p-ready-b-op',
    rulesVersion: '1.0.0',
  });
  if (readyBOp.kind === 'noop') throw new Error('Expected actionable ready');
  const readyBStarted = makeStarted(readyBOp);
  const readyBBlocked = tReadyW.game.withEvents([readyBStarted]);
  const readyBBaseH = evaluatePreparedProof(readyBOp, { kind: 'global_deadness' });
  assert.ok(readyBBaseH);
  const readyBSettled = settlePrepared(readyBBlocked, { base: readyBBaseH }, MAX - 10);
  const readyBEvents: GameEvent[] = [
    tCreated,
    ...tReadyW.events,
    readyBStarted,
    ...readyBSettled.batch,
  ];
  const stored = storeStream('p-tourney-ready', readyBEvents);
  const p1 = projectGameStream('p-tourney-ready', stored);
  assert.equal(p1.id, 'p-tourney-ready');
  assert.equal(p1.variant, 'standard');
  assert.equal(p1.speed, 'correspondence');
  assert.equal(p1.white, 'alice');
  assert.equal(p1.black, 'bob');
  assert.equal(p1.plyCount, 0);
  assert.equal(p1.result, null);
  assert.equal(p1.termination, null);
  assert.equal(p1.endedAt, null);
  assert.equal(p1.lastSeq, stored.length - 1);
});

test('projection round-trip: fractional increment held move and same-turn draw offer settlement project cleanly', () => {
  const fracTC: TimeControl = { initialMs: 1000.5, incrementMs: 0.25, delayMs: 0, kind: 'increment' };
  const { game: fracGame, event: fracCreated } = Game.create({
    gameId: 'p-frac-draw',
    variant: 'standard',
    initialFen: FEN_MATE,
    timeControl: fracTC,
    players: { white: 'alice', black: 'bob' },
    at: 1000,
  });
  const fracMoveOp = prepareMove(fracGame, {
    uci: 'g6g5',
    at: 1100,
    operationId: 'p-frac-move-op',
    rulesVersion: '1.0.0',
  });
  const fracMoveStarted = makeStarted(fracMoveOp);
  const fracMoveBlocked = fracGame.withEvents([fracMoveStarted]);
  const fracMoveBaseH = evaluatePreparedProof(fracMoveOp, { kind: 'global_deadness' });
  assert.ok(fracMoveBaseH);
  if (fracMoveOp.intent.kind !== 'move') throw new Error('Expected move');
  const fracMoveSuccH = evaluatePreparedProof(fracMoveOp, {
    kind: 'successor_deadness',
    successorFen: fracMoveOp.intent.successorFen,
  });
  assert.ok(fracMoveSuccH);
  const fracMoveSettled = settlePrepared(fracMoveBlocked, { base: fracMoveBaseH, successor: fracMoveSuccH }, 2000);

  const fracDrawOp = prepareDrawOffer(fracMoveSettled.game, {
    color: 'b',
    at: 2200,
    operationId: 'p-frac-draw-op',
    rulesVersion: '1.0.0',
  });
  const fracDrawStarted = makeStarted(fracDrawOp);
  const fracDrawBlocked = fracMoveSettled.game.withEvents([fracDrawStarted]);
  const fracDrawBaseH = evaluatePreparedProof(fracDrawOp, { kind: 'global_deadness' });
  assert.ok(fracDrawBaseH);
  const fracDrawSettled = settlePrepared(fracDrawBlocked, { base: fracDrawBaseH }, 2500);

  const fracEvents: GameEvent[] = [
    fracCreated,
    fracMoveStarted,
    ...fracMoveSettled.batch,
    fracDrawStarted,
    ...fracDrawSettled.batch,
  ];
  const stored = storeStream('p-frac-draw', fracEvents);
  const p2 = projectGameStream('p-frac-draw', stored);
  assert.equal(p2.id, 'p-frac-draw');
  assert.equal(p2.speed, 'ultrabullet');
  assert.equal(p2.plyCount, 1);
  assert.equal(p2.result, null);
  assert.equal(p2.termination, null);
  assert.equal(p2.endedAt, null);
  assert.equal(p2.lastSeq, stored.length - 1);
});

test('projection round-trip: fractional delay with pause and subsequent held move project cleanly', () => {
  const delayTC: TimeControl = { initialMs: 1000.25, incrementMs: 0, delayMs: 0.5, kind: 'delay' };
  const { game: delayGame, event: delayCreated } = Game.create({
    gameId: 'p-frac-delay',
    variant: 'standard',
    initialFen: FEN_MATE,
    timeControl: delayTC,
    players: { white: 'alice', black: 'bob' },
    at: 1000,
  });
  const delayMove1 = delayGame.playMove('g6g5', 1100);
  const delayDrawOp = prepareDrawOffer(delayMove1.game, {
    color: 'b',
    at: 1200,
    operationId: 'p-delay-draw-op',
    rulesVersion: '1.0.0',
  });
  const delayDrawStarted = makeStarted(delayDrawOp);
  const delayDrawBlocked = delayMove1.game.withEvents([delayDrawStarted]);
  const delayDrawBaseH = evaluatePreparedProof(delayDrawOp, { kind: 'global_deadness' });
  assert.ok(delayDrawBaseH);
  const delayDrawSettled = settlePrepared(delayDrawBlocked, { base: delayDrawBaseH }, 2000);

  const delayMove2Op = prepareMove(delayDrawSettled.game, {
    uci: 'h8h7',
    at: 2100,
    operationId: 'p-delay-move2-op',
    rulesVersion: '1.0.0',
  });
  const delayMove2Started = makeStarted(delayMove2Op);
  const delayMove2Blocked = delayDrawSettled.game.withEvents([delayMove2Started]);
  const delayMove2BaseH = evaluatePreparedProof(delayMove2Op, { kind: 'global_deadness' });
  assert.ok(delayMove2BaseH);
  if (delayMove2Op.intent.kind !== 'move') throw new Error('Expected move');
  const delayMove2SuccH = evaluatePreparedProof(delayMove2Op, {
    kind: 'successor_deadness',
    successorFen: delayMove2Op.intent.successorFen,
  });
  assert.ok(delayMove2SuccH);
  const delayMove2Settled = settlePrepared(delayMove2Blocked, { base: delayMove2BaseH, successor: delayMove2SuccH }, 3000);

  const delayEvents: GameEvent[] = [
    delayCreated,
    ...delayMove1.events,
    delayDrawStarted,
    ...delayDrawSettled.batch,
    delayMove2Started,
    ...delayMove2Settled.batch,
  ];
  const stored = storeStream('p-frac-delay', delayEvents);
  const p3 = projectGameStream('p-frac-delay', stored);
  assert.equal(p3.id, 'p-frac-delay');
  assert.equal(p3.speed, 'ultrabullet');
  assert.equal(p3.plyCount, 2);
  assert.equal(p3.result, null);
  assert.equal(p3.termination, null);
  assert.equal(p3.endedAt, null);
  assert.equal(p3.lastSeq, stored.length - 1);
});

test('projection round-trip: late tournament first move after historical deadline projects cleanly', () => {
  const { game: tLateGame, event: tLateCreated } = Game.create({
    gameId: 'p-tourney-late',
    variant: 'standard',
    initialFen: FEN_MATE,
    timeControl: unlimitedTC,
    players: { white: 'alice', black: 'bob' },
    source: 'tournament',
    noShowAfterMs: 1000,
    at: 1000,
  });
  const tLateW = tLateGame.markReady('w', 1100);
  const tLateB = tLateW.game.markReady('b', 1200);
  const tLateAuth = prepareAuthoritativeCommand(tLateB.game, { kind: 'move', uci: 'g6g5' }, {
    at: 2100,
    color: 'w',
    operationId: 'p-tourney-late-op',
    rulesVersion: '1.0.0',
  });
  assert.equal(tLateAuth.kind, 'prepared');
  const tLateStarted = makeStarted(tLateAuth.operation);
  const tLateBlocked = tLateB.game.withEvents([tLateStarted]);
  const tLateBaseH = evaluatePreparedProof(tLateAuth.operation, { kind: 'global_deadness' });
  assert.ok(tLateBaseH);
  if (tLateAuth.operation.intent.kind !== 'move') throw new Error('Expected move');
  const tLateSuccH = evaluatePreparedProof(tLateAuth.operation, {
    kind: 'successor_deadness',
    successorFen: tLateAuth.operation.intent.successorFen,
  });
  assert.ok(tLateSuccH);
  const tLateSettled = settlePrepared(tLateBlocked, { base: tLateBaseH, successor: tLateSuccH }, 2200);

  const tLateEvents: GameEvent[] = [
    tLateCreated,
    ...tLateW.events,
    ...tLateB.events,
    tLateStarted,
    ...tLateSettled.batch,
  ];
  const stored = storeStream('p-tourney-late', tLateEvents);
  const p4 = projectGameStream('p-tourney-late', stored);
  assert.equal(p4.id, 'p-tourney-late');
  assert.equal(p4.speed, 'correspondence');
  assert.equal(p4.plyCount, 1);
  assert.equal(p4.result, null);
  assert.equal(p4.termination, null);
  assert.equal(p4.endedAt, null);
  assert.equal(p4.lastSeq, stored.length - 1);
});

test('projection round-trip: seek expiry after historical deadline normalizes to no-show and projects cleanly', () => {
  const { game: seekLateGame, event: seekLateCreated } = Game.create({
    gameId: 'p-seek-expired',
    variant: 'standard',
    initialFen: FEN_MATE,
    timeControl: unlimitedTC,
    players: { white: 'alice', black: 'bob' },
    source: 'seek',
    noShowAfterMs: 1000,
    at: 1000,
  });
  const seekLateW = seekLateGame.markReady('w', 1100);
  const seekLateB = seekLateW.game.markReady('b', 1200);
  const seekLateAuth = prepareAuthoritativeCommand(seekLateB.game, { kind: 'move', uci: 'g6g5' }, {
    at: 2100,
    color: 'w',
    operationId: 'p-seek-expired-op',
    rulesVersion: '1.0.0',
  });
  assert.equal(seekLateAuth.kind, 'prepared');
  assert.equal(seekLateAuth.operation.intent.kind, 'expireNoShow');
  const seekLateStarted = makeStarted(seekLateAuth.operation);
  const seekLateBlocked = seekLateB.game.withEvents([seekLateStarted]);
  const seekLateBaseH = evaluatePreparedProof(seekLateAuth.operation, { kind: 'global_deadness' });
  assert.ok(seekLateBaseH);
  const seekLateSettled = settlePrepared(seekLateBlocked, { base: seekLateBaseH }, 2200);

  const seekLateEvents: GameEvent[] = [
    seekLateCreated,
    ...seekLateW.events,
    ...seekLateB.events,
    seekLateStarted,
    ...seekLateSettled.batch,
  ];
  const stored = storeStream('p-seek-expired', seekLateEvents);
  const p5 = projectGameStream('p-seek-expired', stored);
  assert.equal(p5.id, 'p-seek-expired');
  assert.equal(p5.speed, 'correspondence');
  assert.equal(p5.plyCount, 0);
  assert.equal(p5.result, '*');
  assert.equal(p5.termination, 'no_show');
  assert.deepEqual(p5.endedAt, new Date(2200));
  assert.equal(p5.lastSeq, stored.length - 1);
});

function batch(overrides: Partial<GamesProjectionBatch> = {}): GamesProjectionBatch {
  return { busy: false, more: false, rewound: false, projected: 0, failures: [], endings: [], ...overrides };
}

test('the worker runs back-to-back while behind, backs off exponentially on errors, and resets after success', async () => {
  const script: (GamesProjectionBatch | Error)[] = [
    batch({ more: true }), batch(), new Error('db down'), new Error('db down'), new Error('db down'), batch(),
  ];
  const starts: number[] = [];
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const worker = new GamesProjectionWorker({
    runBatch: async () => {
      starts.push(Date.now());
      const next = script.shift();
      if (script.length === 0) done();
      if (next instanceof Error) throw next;
      return next ?? batch();
    },
  }, { idleMs: 50, maxBackoffMs: 180, onError: () => {} });
  worker.start();
  await finished;
  await worker.stop();

  // Timers never fire early, apart from millisecond rounding; upper bounds are loose for busy CI.
  const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
  assert.ok(gaps[0]! < 40, `a full page is followed immediately (gap ${gaps[0]})`);
  assert.ok(gaps[1]! >= 48, `an idle batch waits idleMs (gap ${gaps[1]})`);
  assert.ok(gaps[2]! >= 98, `first failure backs off 2x idle (gap ${gaps[2]})`);
  assert.ok(gaps[3]! >= 178, `second failure backs off 4x idle, capped at 180 (gap ${gaps[3]})`);
  assert.ok(gaps[4]! >= 178 && gaps[4]! < 1_000, `third failure stays at the cap (gap ${gaps[4]})`);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('stop() waits for an in-flight batch and schedules nothing afterwards', async () => {
  let release!: () => void;
  let entered!: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const worker = new GamesProjectionWorker({
    runBatch: () => {
      calls += 1;
      entered();
      return new Promise<GamesProjectionBatch>((resolve) => { release = () => resolve(batch({ more: true })); });
    },
  }, { idleMs: 1 });
  worker.start();
  await running;

  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await sleep(10);
  assert.equal(stopped, false, 'stop must not resolve while a batch is running');
  release();
  await stopping;
  await sleep(20);
  assert.equal(calls, 1, 'no batch after stop, even when the last one reported more work');
});

test('a throwing batch hook is reported and does not stop the loop', async () => {
  const errors: unknown[] = [];
  let calls = 0;
  let done!: () => void;
  const twice = new Promise<void>((resolve) => { done = resolve; });
  const worker = new GamesProjectionWorker({
    runBatch: async () => {
      calls += 1;
      if (calls === 2) done();
      return batch();
    },
  }, { idleMs: 1, onBatch: () => { throw new Error('hook'); }, onError: (e) => errors.push(e) });
  worker.start();
  await twice;
  await worker.stop();
  assert.ok(errors.length >= 1);
});
