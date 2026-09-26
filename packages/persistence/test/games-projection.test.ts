import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, type GameEvent, type TimeControl } from '@chess-platform/game';
import { projectGameStream, type StoredEvent } from '../src';
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
    startedAt: new Date(1_000), source: null, plyCount: 0, lastSeq: 0, result: null, termination: null, endedAt: null,
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
