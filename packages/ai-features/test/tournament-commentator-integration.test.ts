/**
 * Live integration test for `TournamentCommentator`.
 *
 * Selected by `GAMBIT_LIVE_PROVIDER=openai` through the live-provider runner.
 * Uses a real `OpenAiCompatibleAdapter` (requires `OPENAI_API_KEY`) and a 
 * mock `AnalysisProvider` to verify wiring to a real LLM.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { OpenAiCompatibleAdapter } from '@chess-platform/ai-orchestrator';

import { TournamentCommentator } from '../src/index.js';

const PRE_COMPUTED_RESULTS: readonly EngineResult[] = [
  {
    multipv: 1,
    evaluation: { type: 'cp', value: 85 },
    principalVariation: ['d1d2', 'e8g8', 'e1c1'],
    depth: 15,
    selDepth: 20,
    nodes: 500_000,
    nps: 250_000,
    timeMs: 2000,
  },
];

const fakeEngine: AnalysisProvider = {
  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    return PRE_COMPUTED_RESULTS;
  },
  async play(_request: PlayRequest): Promise<PlayResult> {
    return { move: 'd1d2' };
  },
  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return {
      engineName: 'FakeStockfish',
      engineAuthor: 'chess-platform',
      version: '1.0',
      fingerprint: 'fake',
      variants: new Set(['chess']),
      options: new Map(),
      supportsMultiPv: true,
      supportsLimitStrength: false,
      supportsSkillLevel: false,
      supportsPonder: false,
    };
  },
};

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'openai') describe('TournamentCommentator (integration)', () => {
  let commentator: TournamentCommentator;

  before(async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required for integration tests');
    }

    const ai = new OpenAiCompatibleAdapter({
      id: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      defaultModel: 'gpt-4o-mini',
    });

    commentator = new TournamentCommentator({ engine: fakeEngine, ai });
  });

  test('commentateMoment provides a live engine-grounded response', async () => {
    // Sicilan Najdorf, Poisoned Pawn variation
    const fen = 'r1b1kb1r/1p3ppp/pqnppn2/8/4P3/2N2N2/PPPB1PPP/R2QKB1R w KQkq - 2 9';
    
    const result = await commentator.commentateMoment({
      fen,
      lastMove: 'd1d2',
      context: {
        whitePlayer: 'Bobby Fischer',
        blackPlayer: 'Boris Spassky',
        round: 11,
        event: 'World Chess Championship 1972',
      },
      limits: { depth: 15 },
    });

    assert.ok(result.commentary.length > 50, 'Should return a substantial commentary block');
    assert.ok(
      result.commentary.toLowerCase().includes('fischer') || result.commentary.toLowerCase().includes('spassky'),
      'Should mention the players from the context',
    );
    
    // The citation should be populated by the fake engine
    assert.equal(result.citation.fen, fen);
    assert.equal(result.citation.move, 'd1d2');
    assert.equal(result.citation.depth, 15);
    assert.deepEqual(result.citation.bestLine, ['d1d2', 'e8g8', 'e1c1']);
  });

  test('recapRound provides a data-grounded round recap', async () => {
    const result = await commentator.recapRound({
      event: 'Candidates Tournament',
      round: 14,
      results: [
        { white: 'Gukesh D', black: 'Hikaru Nakamura', result: '1/2-1/2' },
        { white: 'Ian Nepomniachtchi', black: 'Fabiano Caruana', result: '1/2-1/2' },
      ],
      standings: [
        { rank: 1, player: 'Gukesh D', points: 9 },
        { rank: 2, player: 'Hikaru Nakamura', points: 8.5 },
        { rank: 3, player: 'Ian Nepomniachtchi', points: 8.5 },
        { rank: 4, player: 'Fabiano Caruana', points: 8.5 },
      ],
    });

    assert.ok(result.recap.length > 50, 'Should return a substantial recap');
    const lowerRecap = result.recap.toLowerCase();
    
    assert.ok(lowerRecap.includes('gukesh'), 'Should mention Gukesh');
    assert.ok(lowerRecap.includes('hikaru') || lowerRecap.includes('nakamura'), 'Should mention Hikaru');
    assert.ok(lowerRecap.includes('candidates'), 'Should mention the event name');
  });
});
