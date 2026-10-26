import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSync } from '../src/net/game-sync.js';
import { WsClient } from '../src/net/ws-client.js';
import type { StateView } from '../src/net/ws-protocol.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

const FEN0 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const FEN2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const FEN3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';

const FENS = [FEN0, FEN1, FEN2, FEN3] as const;

interface MoveView {
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly by: 'w' | 'b';
}

const ALL_MOVES: readonly MoveView[] = [
  { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
  { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
  { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' },
] as const;

const LEGAL_MOVES_BY_PLY: Record<number, Record<string, string[]>> = {
  0: { e2: ['e4'] },
  1: { e7: ['e5'] },
  2: { g1: ['f3'] },
  3: { b8: ['c6'] },
};

function plainState(ply: number): StateView {
  const fen = FENS[ply];
  assert.ok(fen !== undefined, `Missing FEN for ply ${ply}`);

  const legalMoves = LEGAL_MOVES_BY_PLY[ply] ?? { b8: ['c6'] };
  const moves = ALL_MOVES.slice(0, ply).map((move) => ({ ...move }));
  const turn: 'w' | 'b' = ply % 2 === 0 ? 'w' : 'b';

  return {
    gameId: 'g1',
    variant: 'standard',
    stateRevision: ply,
    ply,
    fen,
    fenHash: `h${ply}`,
    turn,
    moves,
    legalMoves,
    players: {
      white: 'u1',
      black: 'u2',
    },
    timeControl: {
      initialMs: 60000,
      incrementMs: 0,
      delayMs: 0,
      kind: 'sudden_death',
    },
    clock: {
      w: 60000,
      b: 60000,
    },
    turnStartedAt: null,
    status: {
      over: false,
    },
    drawOffer: null,
    chess960StartId: null,
    ready: null,
  };
}

interface MalformedMutationCase {
  name: string;
  mutate: (base: Record<string, unknown>) => void;
}

const MALFORMED_CASES: readonly MalformedMutationCase[] = [
  { name: 'missing ply', mutate: (b) => { delete b['ply']; } },
  { name: 'null ply', mutate: (b) => { b['ply'] = null; } },
  { name: 'string ply', mutate: (b) => { b['ply'] = '3'; } },
  { name: 'fractional ply', mutate: (b) => { b['ply'] = 3.5; } },
  { name: 'negative ply', mutate: (b) => { b['ply'] = -1; } },
  { name: 'unsafe ply', mutate: (b) => { b['ply'] = Number.MAX_SAFE_INTEGER + 1; } },
  { name: 'status{}', mutate: (b) => { b['status'] = {}; } },
  { name: 'missing players', mutate: (b) => { delete b['players']; } },
  { name: 'missing timeControl', mutate: (b) => { delete b['timeControl']; } },
  { name: 'missing legalMoves', mutate: (b) => { delete b['legalMoves']; } },
  { name: 'missing fenHash', mutate: (b) => { delete b['fenHash']; } },
  { name: 'missing fen', mutate: (b) => { delete b['fen']; } },
  { name: 'missing clock', mutate: (b) => { delete b['clock']; } },
  { name: 'inner gameId wrong', mutate: (b) => { b['gameId'] = 'wrong'; } },
  { name: 'ledger length', mutate: (b) => { b['moves'] = ALL_MOVES.slice(0, 1).map((m) => ({ ...m })); } },
  {
    name: 'ledger order',
    mutate: (b) => {
      const move0 = ALL_MOVES[0];
      const move1 = ALL_MOVES[1];
      const move2 = ALL_MOVES[2];
      assert.ok(move0 !== undefined && move1 !== undefined && move2 !== undefined);
      b['moves'] = [{ ...move1 }, { ...move0 }, { ...move2 }];
    },
  },
  {
    name: 'ledger null entry',
    mutate: (b) => {
      const move0 = ALL_MOVES[0];
      const move2 = ALL_MOVES[2];
      assert.ok(move0 !== undefined && move2 !== undefined);
      b['moves'] = [{ ...move0 }, null, { ...move2 }];
    },
  },
];

test('malformed snapshot matrix preserves floor state and retries recovery', () => {
  for (const testCase of MALFORMED_CASES) {
    const scheduler = new ManualScheduler();
    const factory = new FakeSocketFactory();
    const client = new WsClient({
      url: 'wss://example.test/ws',
      factory: factory.factory,
      scheduler,
      now: () => 0,
      rng: () => 0,
      heartbeatMs: 0,
      reconnect: {
        baseDelayMs: 10,
        maxDelayMs: 10,
        jitter: 'none',
      },
    });
    const sync = new GameSync(client, {
      gameId: 'g1',
      token: 'token',
      scheduler,
    });

    try {
      sync.start();
      const socket = factory.last;
      socket.open();

      const validFloor1 = plainState(1);
      socket.emit({
        t: 'joined',
        gameId: 'g1',
        role: 'white',
        stateRevision: 1,
        ply: 1,
        state: validFloor1,
      });

      const stateAfterJoin = sync.getState();
      assert.ok(stateAfterJoin.snapshot);
      assert.deepEqual(stateAfterJoin.snapshot, validFloor1);
      assert.equal(stateAfterJoin.snapshot.ply, 1);
      assert.equal(stateAfterJoin.snapshot.stateRevision, 1);
      assert.equal(sync.stateRevision, 1);
      assert.equal(stateAfterJoin.recovering, false);

      socket.emit({
        t: 'move',
        gameId: 'g1',
        stateRevision: 3,
        ply: 3,
        uci: 'g1f3',
        san: 'Nf3',
        by: 'w',
        clock: { w: 60000, b: 60000 },
        serverTs: 0,
        fenHash: 'h3',
        legalMoves: { b8: ['c6'] },
      });

      const stateAfterGap = sync.getState();
      assert.ok(stateAfterGap.snapshot);
      assert.deepEqual(stateAfterGap.snapshot, validFloor1);
      assert.equal(stateAfterGap.snapshot.ply, 1);
      assert.equal(stateAfterGap.snapshot.stateRevision, 1);
      assert.equal(sync.stateRevision, 1);
      assert.equal(stateAfterGap.recovering, true);

      const malformedBase: Record<string, unknown> = { ...plainState(3) };
      testCase.mutate(malformedBase);

      socket.emit({
        t: 'resumed',
        gameId: 'g1',
        state: malformedBase,
        missed: [],
      });

      const stateAfterMalformed = sync.getState();
      assert.ok(stateAfterMalformed.snapshot);
      assert.deepEqual(stateAfterMalformed.snapshot, validFloor1);
      assert.equal(stateAfterMalformed.snapshot.moves.length, 1);
      assert.equal(stateAfterMalformed.snapshot.fenHash, 'h1');
      assert.equal(stateAfterMalformed.snapshot.ply, 1);
      assert.equal(stateAfterMalformed.snapshot.stateRevision, 1);
      assert.equal(sync.stateRevision, 1);
      assert.equal(stateAfterMalformed.recovering, true);

      scheduler.runNext();
      scheduler.runNext();

      const sentList = socket.sent;
      const lastSentRaw = sentList[sentList.length - 1];
      assert.ok(lastSentRaw !== undefined, `Expected second resume sent for case: ${testCase.name}`);
      const parsedSecondResume = JSON.parse(lastSentRaw) as {
        t?: string;
        gameId?: string;
        lastPly?: number;
      };
      assert.equal(parsedSecondResume.t, 'resume');
      assert.equal(parsedSecondResume.gameId, 'g1');
      assert.equal(parsedSecondResume.lastPly, 1);

      const validFull3 = plainState(3);
      socket.emit({
        t: 'resumed',
        gameId: 'g1',
        state: validFull3,
        missed: [],
      });

      const resolvedState = sync.getState();
      assert.equal(resolvedState.recovering, false);
      assert.ok(resolvedState.snapshot);
      assert.equal(resolvedState.snapshot.ply, 3);
      assert.equal(resolvedState.snapshot.stateRevision, 3);
      assert.equal(sync.stateRevision, 3);
      assert.equal(resolvedState.snapshot.fen, FENS[3]);
      assert.equal(resolvedState.snapshot.fenHash, 'h3');
      assert.equal(resolvedState.snapshot.moves.length, 3);
      assert.deepEqual(resolvedState.snapshot.moves, validFull3.moves);
      assert.deepEqual(resolvedState.snapshot, validFull3);
    } finally {
      sync.stop();
      client.close();
    }
  }
});

test('genuine transport send failure transitions to exhaustion and recovers on retryRecovery', (t) => {
  const scheduler = new ManualScheduler();
  const factory = new FakeSocketFactory();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    now: () => 0,
    rng: () => 0,
    heartbeatMs: 0,
    reconnect: {
      baseDelayMs: 10,
      maxDelayMs: 10,
      jitter: 'none',
    },
  });
  const sync = new GameSync(client, {
    gameId: 'g1',
    token: 'token',
    scheduler,
  });

  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  const socket = factory.last;
  socket.open();

  const validFloor0 = plainState(0);
  socket.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    stateRevision: 0,
    ply: 0,
    state: validFloor0,
  });

  const state0 = sync.getState();
  assert.ok(state0.snapshot);
  assert.deepEqual(state0.snapshot, validFloor0);
  assert.equal(state0.snapshot.ply, 0);
  assert.equal(state0.snapshot.stateRevision, 0);
  assert.equal(sync.stateRevision, 0);

  const originalSend = socket.send.bind(socket);
  let failedResumeAttempts = 0;
  socket.send = (data: string): void => {
    const parsed = JSON.parse(data) as { t?: string };
    if (parsed.t === 'resume') {
      failedResumeAttempts++;
      throw new Error('Transport send failure: resume blocked');
    }
    originalSend(data);
  };

  const errors: unknown[] = [];
  client.on({
    error: (error: unknown) => {
      errors.push(error);
    },
  });

  socket.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 3,
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    clock: { w: 60000, b: 60000 },
    serverTs: 0,
    fenHash: 'h3',
    legalMoves: { b8: ['c6'] },
  });

  assert.equal(failedResumeAttempts, 1);
  assert.equal(errors.length, 1);
  assert.equal(scheduler.nextDelayMs, 1000);

  scheduler.runNext();
  assert.equal(failedResumeAttempts, 2);
  assert.equal(errors.length, 2);
  assert.equal(scheduler.nextDelayMs, 2000);

  scheduler.runNext();
  assert.equal(failedResumeAttempts, 3);
  assert.equal(errors.length, 3);

  assert.equal(scheduler.pending, 0);
  assert.equal(sync.getState().recoveryAvailable, true);
  assert.equal(sync.getState().recovering, true);

  const sentResumesBeforeRestore = socket.sent.filter((raw) => {
    const m = JSON.parse(raw) as { t?: string };
    return m.t === 'resume';
  });
  assert.equal(sentResumesBeforeRestore.length, 0);

  socket.send = originalSend;

  sync.retryRecovery();

  const sentResumesAfterRestore = socket.sent.filter((raw) => {
    const m = JSON.parse(raw) as { t?: string };
    return m.t === 'resume';
  });
  assert.equal(sentResumesAfterRestore.length, 1);
  assert.equal(failedResumeAttempts, 3);

  const resumeRaw = sentResumesAfterRestore[0];
  assert.ok(resumeRaw !== undefined);
  const parsedResume = JSON.parse(resumeRaw) as {
    t?: string;
    gameId?: string;
    lastPly?: number;
  };
  assert.equal(parsedResume.t, 'resume');
  assert.equal(parsedResume.gameId, 'g1');
  assert.equal(parsedResume.lastPly, 0);

  const validFull3 = plainState(3);
  socket.emit({
    t: 'resumed',
    gameId: 'g1',
    state: validFull3,
    missed: [],
  });

  const finalState = sync.getState();
  assert.equal(finalState.recovering, false);
  assert.ok(finalState.snapshot);
  assert.equal(finalState.snapshot.ply, 3);
  assert.equal(finalState.snapshot.stateRevision, 3);
  assert.equal(sync.stateRevision, 3);
  assert.equal(finalState.snapshot.fen, FENS[3]);
  assert.equal(finalState.snapshot.fenHash, 'h3');
  assert.deepEqual(finalState.snapshot, validFull3);
});