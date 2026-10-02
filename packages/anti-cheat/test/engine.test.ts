import test from 'node:test';
import * as assert from 'node:assert/strict';
import { Position, chess960Fen } from '@chess-platform/core';
import { extractPlies, EngineBackedEvaluator } from '../src/engine';
import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { MATE_ENCODING } from '../src/analyzer';

/** The standard opening position, spelled once so the replay tests below say what they start from. */
const STANDARD_START = Position.initial('standard').fen();

test('a lease cancellation reaches both engine searches and prevents subsequent analysis', async () => {
  const provider = new FakeAnalysisProvider();
  const controller = new AbortController();
  const signals: Array<AbortSignal | undefined> = [];
  provider.analyze = async (request) => {
    signals.push(request.signal);
    return [{ multipv: 1, evaluation: { type: 'cp', value: 20 }, principalVariation: ['d2d4'], depth: 18, nodes: 1, nps: 1, timeMs: 1 }];
  };
  const evaluator = new EngineBackedEvaluator(provider, 'standard', controller.signal);
  await evaluator.evaluate(STANDARD_START, 'e2e4', 18);
  assert.deepEqual(signals, [controller.signal, controller.signal], 'MultiPV and played-move searches share ownership cancellation');
  controller.abort();
  await assert.rejects(evaluator.evaluate(STANDARD_START, 'e2e4', 18), { name: 'AbortError' });
  assert.equal(signals.length, 2);
});

class FakeAnalysisProvider implements AnalysisProvider {
  public stubs: Record<string, EngineResult[]> = {};

  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    // Basic routing by FEN.
    return this.stubs[request.fen] || [];
  }

  async play(request: PlayRequest): Promise<PlayResult> {
    throw new Error('Not implemented');
  }

  capabilitiesFor(variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

test('extractPlies round-trips a short game', () => {
  // Scholar's mate
  const moves = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
  
  const plies = extractPlies(moves, 'standard', STANDARD_START, (i) => i < 2);
  
  assert.equal(plies.length, 7);
  
  // Ply 0: e2e4
  assert.equal(plies[0].fen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(plies[0].playedUci, 'e2e4');
  assert.equal(plies[0].player, 'white');
  assert.equal(plies[0].isBook, true);

  // Ply 1: e7e5
  assert.equal(plies[1].fen, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  assert.equal(plies[1].playedUci, 'e7e5');
  assert.equal(plies[1].player, 'black');
  assert.equal(plies[1].isBook, true);

  // Ply 2: f1c4
  assert.equal(plies[2].fen, 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2');
  assert.equal(plies[2].playedUci, 'f1c4');
  assert.equal(plies[2].player, 'white');
  assert.equal(plies[2].isBook, undefined);

  // Ply 6: h5f7#
  assert.equal(plies[6].playedUci, 'h5f7');
  assert.equal(plies[6].player, 'white');
});

test('extractPlies throws on illegal move', () => {
  assert.throws(() => extractPlies(['e2e5'], 'standard', STANDARD_START), /illegal move 'e2e5'/);
});

/**
 * A Chess960 game is replayed from the arrangement it actually started at.
 *
 * Before ADR-0137 made the variant creatable, `extractPlies` began at `Position.initial(variant)` —
 * position 518 for Chess960 — which was harmless only because no other arrangement could reach it.
 * With real games arriving, replaying position 700 from 518 scores a player against a game nobody
 * played. Position 700 is `RBQKNNBR`: king d1, rooks a1/h1, so the two boards are visibly different
 * and 518 could not stand in for it. Raised in the Qodo review of PR #12.
 */
test('extractPlies replays a chess960 game from its own starting position', () => {
  const startFen = chess960Fen(700);
  const moves = ['e2e4', 'e7e5', 'f1g3'];

  const plies = extractPlies(moves, 'chess960', startFen);

  assert.equal(plies.length, 3);
  assert.equal(plies[0].fen, startFen, "the first ply is scored from the game's own start");
  assert.notEqual(startFen, Position.initial('chess960').fen(), 'and that start is not position 518');

  // Every ply's FEN is the position that move was actually played from.
  let pos = Position.fromFen(startFen, 'chess960');
  for (let i = 0; i < moves.length; i++) {
    assert.equal(plies[i].fen, pos.fen(), `ply ${i} is scored from the right board`);
    pos = pos.play(moves[i]);
  }
});

test('extractPlies replaying a chess960 game from the wrong start is refused, not scored', () => {
  // The failure mode this guards. `f1g3` is a knight move in position 700 and illegal from 518, so
  // replaying that game from the default throws rather than quietly scoring the wrong positions.
  // A silent wrong answer is the outcome worth making impossible; this shows the old default would
  // not have produced one silently *here*, while the test above is what pins the positions.
  assert.throws(
    () => extractPlies(['e2e4', 'e7e5', 'f1g3'], 'chess960', Position.initial('chess960').fen()),
    /illegal move 'f1g3'/,
  );
});

test('evaluate returns top moves and playedCp when move is in top N', async () => {
  const provider = new FakeAnalysisProvider();
  provider.stubs['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'] = [
    {
      multipv: 1,
      principalVariation: ['e2e4'],
      evaluation: { type: 'cp', value: 30 },
      depth: 10,
      nodes: 100,
      nps: 100,
      timeMs: 10
    },
    {
      multipv: 2,
      principalVariation: ['d2d4'],
      evaluation: { type: 'cp', value: 25 },
      depth: 10,
      nodes: 100,
      nps: 100,
      timeMs: 10
    }
  ];

  const evaluator = new EngineBackedEvaluator(provider);
  const result = await evaluator.evaluate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'd2d4', 10);
  
  assert.deepEqual(result.topMoves, [
    { uci: 'e2e4', cp: 30 },
    { uci: 'd2d4', cp: 25 }
  ]);
  assert.equal(result.playedCp, 25);
});

test('evaluate calculates negated playedCp when move is outside top N', async () => {
  const provider = new FakeAnalysisProvider();
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const afterH3Fen = 'rnbqkbnr/pppppppp/8/8/8/7P/PPPPPPP1/RNBQKBNR b KQkq - 0 1'; // after h2h3
  
  provider.stubs[startFen] = [
    {
      multipv: 1,
      principalVariation: ['e2e4'],
      evaluation: { type: 'cp', value: 30 },
      depth: 10,
      nodes: 100,
      nps: 100,
      timeMs: 10
    }
  ];

  provider.stubs[afterH3Fen] = [
    {
      multipv: 1,
      principalVariation: ['e7e5'],
      evaluation: { type: 'cp', value: 40 }, // Black evaluates position at +40 (Black is better)
      depth: 10,
      nodes: 100,
      nps: 100,
      timeMs: 10
    }
  ];

  const evaluator = new EngineBackedEvaluator(provider);
  const result = await evaluator.evaluate(startFen, 'h2h3', 10);
  
  assert.deepEqual(result.topMoves, [
    { uci: 'e2e4', cp: 30 }
  ]);
  // The resulting position gives +40 to the side to move (Black).
  // So White's evaluation is -40.
  assert.equal(result.playedCp, -40);
});

test('evaluate encodes mate-in-1 properly and negates properly', async () => {
  const provider = new FakeAnalysisProvider();
  const mateIn1Fen = '3k4/3Q4/8/8/8/8/8/4K3 b - - 0 1';
  
  provider.stubs[mateIn1Fen] = [
    {
      multipv: 1,
      principalVariation: ['e2e4'], // Fake PV
      evaluation: { type: 'mate', value: 1 }, // Mate in 1 for the mover
      depth: 10,
      nodes: 100,
      nps: 100,
      timeMs: 10
    }
  ];

  const evaluator = new EngineBackedEvaluator(provider);
  const result = await evaluator.evaluate(mateIn1Fen, 'e2e4', 10);
  
  assert.deepEqual(result.topMoves, [
    { uci: 'e2e4', cp: MATE_ENCODING }
  ]);
  assert.equal(result.playedCp, MATE_ENCODING);
});

test('evaluate prices checkmating move as MATE_ENCODING without engine call', async () => {
  const provider = new FakeAnalysisProvider();
  // Scholar's mate just before checkmate
  const beforeMateFen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 2 4';
  
  provider.stubs[beforeMateFen] = [
    {
      multipv: 1,
      principalVariation: ['h5f7'],
      evaluation: { type: 'mate', value: 1 }, // White has mate in 1
      depth: 10,
      nodes: 10,
      nps: 10,
      timeMs: 1
    }
  ];

  const evaluator = new EngineBackedEvaluator(provider);
  // Actually play a move NOT in the stubbed top moves to force the fallback logic.
  // We'll simulate h5f7 is not in topMoves to test the "mover delivered checkmate" path.
  provider.stubs[beforeMateFen] = [
    {
      multipv: 1,
      principalVariation: ['c4f7'], // Engine thinks this is best for some reason
      evaluation: { type: 'cp', value: 500 },
      depth: 10,
      nodes: 10,
      nps: 10,
      timeMs: 1
    }
  ];

  const result = await evaluator.evaluate(beforeMateFen, 'h5f7', 10); // Checkmate!
  
  assert.equal(result.playedCp, MATE_ENCODING);
});

test('evaluate returns unscorable if original position is terminal', async () => {
  const provider = new FakeAnalysisProvider();
  const matedFen = 'r1bqkbnr/pppp1Qpp/2n5/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4';
  
  const evaluator = new EngineBackedEvaluator(provider);
  const result = await evaluator.evaluate(matedFen, 'e8e7', 10); // Attempt an illegal move or anything
  
  assert.deepEqual(result.topMoves, []);
  assert.equal(result.playedCp, undefined);
});

test('evaluate returns unscorable if engine returns no usable lines', async () => {
  const provider = new FakeAnalysisProvider();
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  
  provider.stubs[startFen] = []; // Engine gives no lines
  
  const evaluator = new EngineBackedEvaluator(provider);
  const result = await evaluator.evaluate(startFen, 'e2e4', 10);
  
  assert.deepEqual(result.topMoves, []);
  assert.equal(result.playedCp, undefined);
});
