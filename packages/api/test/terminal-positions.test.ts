/**
 * Decided positions are reported as results, never as evaluations.
 *
 * The defect this pins: a position with no legal moves gives a UCI engine nothing to score, so it
 * answers `bestmove (none)` with no `info` lines and `UciEngineInstance.assembleResults` substitutes
 * a placeholder `{ cp: 0, depth: 0 }`. Reasonable as an internal marker; a lie once served as an
 * evaluation. Checkmate reached clients as `+0.00` — dead level — on both `POST /v1/analysis` and
 * Move Explanation. Found in the independent review of PR #134; ADR-0116.
 *
 * Every FEN below was verified against `Position.status()` before being used, so a test that fails
 * here is reporting a real behaviour change rather than a stale fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AnalysisProvider,
  AnalysisRequest,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import type { ProviderCapabilities } from '@chess-platform/ai-orchestrator';
import { AiOrchestrator, FakeProvider } from '@chess-platform/ai-orchestrator';
import { MoveExplainer } from '@chess-platform/ai-features';
import { AnalysisService } from '../src/analysis/service';
import { MoveExplanationService } from '../src/ai/move-explanation-service';
import { fromStatus, terminalOutcome } from '../src/analysis/terminal';
import { startHarness } from './helpers';

/** Scholar's Mate delivered: Black to move, mated. */
const CHECKMATE_FEN = 'r1bqkb1r/pppp1Qpp/2n5/4p3/2B1n3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4';
/** Black to move, no legal move, not in check. */
const STALEMATE_FEN = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';
/** Bare kings. */
const INSUFFICIENT_FEN = '8/8/8/4k3/8/4K3/8/8 w - - 0 1';
/** Frozen King and Pawn dead position (motivating Issue #124 position). */
const DEAD_POSITION_FEN = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
/** Predecessor position where White's move b5b6 transitions into DEAD_POSITION_FEN. */
const BEFORE_DEAD_POSITION_FEN = '8/1pk2p1p/p1p1pPpP/PPP1P1P1/5K2/8/8/8 w - - 0 1';
/**
 * King of the Hill: White's king stands on d5, which wins on the spot.
 *
 * The pawn matters. Without it this is bare kings, which standard rules already call a draw by
 * insufficient material — so it could not show that the *variant* is what decided. With it, standard
 * rules say play continues and only King of the Hill says White has won.
 */
const KOTH_WIN_FEN = '8/8/8/3K4/8/8/4P3/7k w - - 0 1';
/** The position one move before Scholar's Mate — White to move, plays f3f7. */
const BEFORE_MATE_FEN = 'r1bqkb1r/pppp1ppp/2n5/4p3/2B1n3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 4';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Answers every search with a fabricated `+0.00`, exactly as the real engine does for a position it
 * cannot score. If the terminal check is ever removed, this is what would reach the client.
 */
class CountingAnalysisProvider implements AnalysisProvider {
  callCount = 0;
  readonly fens: string[] = [];
  responder: ((fen: string) => readonly EngineResult[]) | undefined;

  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.callCount += 1;
    this.fens.push(request.fen);
    return (
      this.responder?.(request.fen) ?? [
        {
          multipv: 1,
          evaluation: { type: 'cp', value: 0 },
          principalVariation: [],
          depth: 0,
          selDepth: 0,
          nodes: 0,
          nps: 0,
          timeMs: 1,
        },
      ]
    );
  }
  async play(_r: PlayRequest): Promise<PlayResult> {
    throw new Error('not implemented in stub');
  }
  capabilitiesFor(_v: string): EngineCapabilities | undefined {
    return undefined;
  }
}

function capabilitiesFor(id: string): ProviderCapabilities {
  return {
    providerId: id,
    displayName: id,
    modalities: ['text'],
    taskClasses: [],
    supportsStreaming: true,
    supportsStructured: true,
    supportsEmbeddings: false,
    supportsCancellation: true,
    models: [
      {
        id: `${id}-model`,
        displayName: `${id}-model`,
        contextWindow: 128_000,
        inputCostPerMtMicroUsd: 0,
        outputCostPerMtMicroUsd: 0,
        maxOutputTokens: 4096,
      },
    ],
    maxContextTokens: 128_000,
    local: false,
  };
}

function buildExplanation(engine: CountingAnalysisProvider, provider: FakeProvider): MoveExplanationService {
  const orchestrator = new AiOrchestrator();
  orchestrator.registry.register(provider, capabilitiesFor(provider.id));
  return new MoveExplanationService({
    analysis: new AnalysisService({ provider: engine }),
    explainer: new MoveExplainer({ ai: orchestrator, defaultVariant: 'standard' }),
  });
}

// ---------------------------------------------------------------------------
// Adjudication
// ---------------------------------------------------------------------------

test('terminalOutcome names each decided position in the platform result vocabulary', () => {
  assert.deepEqual(terminalOutcome(CHECKMATE_FEN, 'standard'), {
    reason: 'checkmate',
    result: '1-0',
  });
  assert.deepEqual(terminalOutcome(STALEMATE_FEN, 'standard'), {
    reason: 'stalemate',
    result: '1/2-1/2',
  });
  assert.deepEqual(terminalOutcome(INSUFFICIENT_FEN, 'standard'), {
    reason: 'insufficient_material',
    result: '1/2-1/2',
  });
  assert.deepEqual(terminalOutcome(DEAD_POSITION_FEN, 'standard'), {
    reason: 'dead_position',
    result: '1/2-1/2',
  });
  assert.equal(terminalOutcome(START_FEN, 'standard'), undefined, 'an ongoing game has no result');
});

/**
 * Variant rules are core's, not a second copy.
 *
 * `Position.status()` resolves King of the Hill, Three-check, Atomic, Racing Kings and Horde before
 * the generic no-legal-moves check, so adjudication here inherits all of them. This is the case
 * that would fail first if someone reimplemented terminal detection as "zero legal moves": White's
 * king on d5 wins immediately while both sides still have moves available.
 */
test('a variant win is adjudicated by core rules, not by counting legal moves', () => {
  const koth = terminalOutcome(KOTH_WIN_FEN, 'kingofthehill');
  assert.deepEqual(koth, { reason: 'variant_win', result: '1-0' });

  const asStandard = terminalOutcome(KOTH_WIN_FEN, 'standard');
  assert.equal(asStandard, undefined, 'the same position is ongoing under standard rules');
});

// ---------------------------------------------------------------------------
// POST /v1/analysis
// ---------------------------------------------------------------------------

test('POST /v1/analysis reports checkmate as a result and never runs the engine', async () => {
  const engine = new CountingAnalysisProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider: engine }) });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: { fen: CHECKMATE_FEN, variant: 'standard' },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.terminal, { reason: 'checkmate', result: '1-0' });
    assert.deepEqual(res.body.lines, [], 'a decided position has no lines to report');
    assert.equal(engine.callCount, 0, 'and nothing to search');

    // The specific regression: no `+0.00` anywhere in the response.
    assert.equal(JSON.stringify(res.body).includes('"value":0'), false);
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis reports stalemate as a draw rather than an evaluation', async () => {
  const engine = new CountingAnalysisProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider: engine }) });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: { fen: STALEMATE_FEN, variant: 'standard' },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.terminal, { reason: 'stalemate', result: '1/2-1/2' });
    assert.deepEqual(res.body.lines, []);
    assert.equal(engine.callCount, 0);
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis reports a variant win using the variant rules', async () => {
  const engine = new CountingAnalysisProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider: engine }) });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: { fen: KOTH_WIN_FEN, variant: 'kingofthehill' },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.terminal, { reason: 'variant_win', result: '1-0' });
    assert.equal(engine.callCount, 0);
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis reports dead_position as a draw rather than an evaluation and incurs no engine work', async () => {
  const engine = new CountingAnalysisProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider: engine }) });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: { fen: DEAD_POSITION_FEN, variant: 'standard' },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.terminal, { reason: 'dead_position', result: '1/2-1/2' });
    assert.deepEqual(res.body.lines, [], 'a dead position has no lines to report');
    assert.equal(engine.callCount, 0, 'no engine search performed');
    assert.equal(JSON.stringify(res.body).includes('"value":0'), false, 'no fabricated +0.00 evaluation');
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis still analyses an ongoing position exactly as before', async () => {
  const engine = new CountingAnalysisProvider();
  engine.responder = () => [
    {
      multipv: 1,
      evaluation: { type: 'cp', value: 35 },
      principalVariation: ['e2e4'],
      depth: 16,
      selDepth: 20,
      nodes: 1000,
      nps: 5000,
      timeMs: 900,
    },
  ];
  const h = await startHarness({}, { analysis: new AnalysisService({ provider: engine }) });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard' },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.terminal, undefined, 'no result field on a live position');
    assert.equal(res.body.lines.length, 1);
    assert.equal(engine.callCount, 1);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Move Explanation
// ---------------------------------------------------------------------------

/**
 * The search count is the cost contract, and it is now conditional.
 *
 * A move that ends the game leaves nothing to evaluate, so the post-move search is not run: the
 * correct answer and the cheaper one are the same request.
 */
test('a mating move costs one engine search and is cited as checkmate, not +0.00', async () => {
  const engine = new CountingAnalysisProvider();
  engine.responder = (fen) =>
    fen === BEFORE_MATE_FEN
      ? [
          {
            multipv: 1,
            evaluation: { type: 'mate', value: 1 },
            principalVariation: ['f3f7'],
            depth: 12,
            selDepth: 14,
            nodes: 500,
            nps: 5000,
            timeMs: 50,
          },
        ]
      : [];
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'A mating attack.' });
  const service = buildExplanation(engine, provider);

  const outcome = await service.explain({
    fen: BEFORE_MATE_FEN,
    variant: 'standard',
    move: 'f3f7',
  });

  assert.equal(engine.callCount, 1, 'the post-move search is skipped');
  assert.deepEqual(engine.fens, [BEFORE_MATE_FEN], 'and it is the pre-move position that ran');
  assert.deepEqual(outcome.citation.moveOutcome, {
    kind: 'terminal',
    reason: 'checkmate',
    result: '1-0',
  });
});

test('the model is told the game ended, and is not given an evaluation of the final position', async () => {
  const engine = new CountingAnalysisProvider();
  engine.responder = () => [
    {
      multipv: 1,
      evaluation: { type: 'mate', value: 1 },
      principalVariation: ['f3f7'],
      depth: 12,
      selDepth: 14,
      nodes: 500,
      nps: 5000,
      timeMs: 50,
    },
  ];
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'A mating attack.' });
  const service = buildExplanation(engine, provider);

  await service.explain({ fen: BEFORE_MATE_FEN, variant: 'standard', move: 'f3f7' });

  const grounded = provider.calls[0]!.messages.find(
    (m) => m.role === 'system' && m.content.includes('Engine evaluation'),
  );
  assert.ok(grounded, 'grounding is still supplied for the pre-move position');
  assert.ok(
    grounded!.content.includes('Result after f3f7: checkmate — White wins'),
    'the outcome is grounded as a result',
  );
  assert.equal(
    grounded!.content.includes('Evaluation after f3f7'),
    false,
    'and never as a score for a finished game',
  );
});

test('a non-terminal move still costs two engine searches', async () => {
  const engine = new CountingAnalysisProvider();
  engine.responder = () => [
    {
      multipv: 1,
      evaluation: { type: 'cp', value: 35 },
      principalVariation: ['e2e4', 'e7e5'],
      depth: 16,
      selDepth: 20,
      nodes: 1000,
      nps: 5000,
      timeMs: 900,
    },
  ];
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'A normal move.' });
  const service = buildExplanation(engine, provider);

  const outcome = await service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' });

  assert.equal(engine.callCount, 2);
  assert.equal(outcome.citation.moveOutcome.kind, 'evaluation');
});

test('a rejected move still costs no engine search at all', async () => {
  const engine = new CountingAnalysisProvider();
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'unused' });
  const service = buildExplanation(engine, provider);

  await assert.rejects(() =>
    service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e5' }),
  );

  assert.equal(engine.callCount, 0);
  assert.equal(provider.calls.length, 0);
});

/**
 * A game already decided has no move to explain, and says so before charging for one.
 *
 * Checkmate and stalemate cannot reach this path — `Position.play` rejects the move — but a draw by
 * insufficient material, by the fifty-move rule, or by a variant rule leaves legal moves available
 * while the game is over. Those were accepted: the request was charged, the pre-move search returned
 * a terminal outcome with no lines, and the caller got a *retryable* 503 for a permanent condition.
 * Raised in the Qodo review of PR #135.
 */
test('a move played from an already-decided position is rejected, and costs nothing', async () => {
  const engine = new CountingAnalysisProvider();
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'unused' });
  const service = buildExplanation(engine, provider);
  let charged = 0;

  await assert.rejects(
    () =>
      service.explain(
        // Bare kings: `Kd3` is perfectly legal, and the game ended before it.
        { fen: INSUFFICIENT_FEN, variant: 'standard', move: 'e3d3' },
        async () => {
          charged += 1;
        },
      ),
    (err: unknown) => {
      const httpError = err as { status?: number; message?: string };
      assert.equal(httpError.status, 422, 'permanent, not a retryable 503');
      assert.equal(httpError.message, 'the game is already over in this position');
      return true;
    },
  );

  assert.equal(charged, 0, 'and the caller keeps their quota');
  assert.equal(engine.callCount, 0);
  assert.equal(provider.calls.length, 0);
});

test('a move into a dead position costs one engine search and is cited as dead_position, skipping post-move evaluation', async () => {
  const engine = new CountingAnalysisProvider();
  engine.responder = (fen) =>
    fen === BEFORE_DEAD_POSITION_FEN
      ? [
          {
            multipv: 1,
            evaluation: { type: 'cp', value: 0 },
            principalVariation: ['b5b6'],
            depth: 12,
            selDepth: 14,
            nodes: 500,
            nps: 5000,
            timeMs: 50,
          },
        ]
      : [];
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'A dead position transition.' });
  const service = buildExplanation(engine, provider);

  const outcome = await service.explain({
    fen: BEFORE_DEAD_POSITION_FEN,
    variant: 'standard',
    move: 'b5b6',
  });

  assert.equal(engine.callCount, 1, 'the post-move search is skipped');
  assert.deepEqual(engine.fens, [BEFORE_DEAD_POSITION_FEN], 'only pre-move position ran');
  assert.deepEqual(outcome.citation.moveOutcome, {
    kind: 'terminal',
    reason: 'dead_position',
    result: '1/2-1/2',
  });
});

test('explaining a move from an already dead position fails with 422 and charges nothing', async () => {
  const engine = new CountingAnalysisProvider();
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: '' });
  const service = buildExplanation(engine, provider);

  let charged = 0;
  await assert.rejects(
    () =>
      service.explain(
        { fen: DEAD_POSITION_FEN, variant: 'standard', move: 'c7d7' },
        async () => {
          charged += 1;
        },
      ),
    (err: unknown) => {
      const httpError = err as { status?: number; message?: string };
      assert.equal(httpError.status, 422, 'permanent, not a retryable 503');
      assert.equal(httpError.message, 'the game is already over in this position');
      return true;
    },
  );

  assert.equal(charged, 0, 'caller keeps their quota');
  assert.equal(engine.callCount, 0, 'engine never called');
  assert.equal(provider.calls.length, 0, 'ai model never called');
});

/** Threefold is reported as itself, not folded into a neighbouring draw. */
test('a dead_position status is reported as dead_position draw', () => {
  assert.deepEqual(fromStatus({ over: true, reason: 'dead_position' }), {
    reason: 'dead_position',
    result: '1/2-1/2',
  });
});

test('a threefold status is reported as threefold', () => {
  assert.deepEqual(fromStatus({ over: true, reason: 'threefold' }), {
    reason: 'threefold',
    result: '1/2-1/2',
  });
});
