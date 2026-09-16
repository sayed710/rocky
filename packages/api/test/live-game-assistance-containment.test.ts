import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AnalysisProvider,
  AnalysisRequest,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import type { GameEvent } from '@chess-platform/game';
import { AnalysisService } from '../src/analysis/service.js';
import { BOT_ACCOUNTS } from '../src/bot/catalogue.js';
import { startHarness, type Harness } from './helpers.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const OTHER_FEN = '8/8/8/8/8/8/5k2/7K w - - 0 1';

class ControllableProvider implements AnalysisProvider {
  calls = 0;
  readonly entered: Promise<void>;
  private enter!: () => void;
  private releaseSearch: (() => void) | null = null;

  constructor(private readonly paused = false) {
    this.entered = new Promise<void>((resolve) => { this.enter = resolve; });
  }

  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.calls += 1;
    this.enter();
    if (this.paused) {
      await new Promise<void>((resolve) => { this.releaseSearch = resolve; });
    }
    return [{
      multipv: 1,
      evaluation: { type: 'cp', value: 20 },
      principalVariation: ['e2e4'],
      depth: 12,
      nodes: 1_000,
      nps: 100_000,
      timeMs: 10,
    }];
  }

  release(): void {
    assert.ok(this.releaseSearch, 'analysis must be in flight before release');
    this.releaseSearch();
  }

  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not used');
  }

  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

function created(gameId: string, white: string, black: string, rated = true): GameEvent {
  return {
    type: 'GameCreated',
    gameId,
    variant: 'standard',
    initialFen: START_FEN,
    timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    players: { white, black },
    rated,
    at: 1_700_000_000_000,
  };
}

async function startGame(
  h: Harness,
  gameId: string,
  white: string,
  black: string,
  rated = true,
): Promise<void> {
  await h.repos.events.append(gameId, -1, [created(gameId, white, black, rated)]);
}

async function endGame(h: Harness, gameId: string): Promise<void> {
  await h.repos.events.append(gameId, 0, [{
    type: 'GameEnded',
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    at: 1_700_000_001_000,
  }]);
}

function analysisRequest(token: string, fen = START_FEN) {
  return {
    token,
    body: { fen, variant: 'standard' },
  };
}

test('assistance is allowed when the caller has no active human game', async (t) => {
  const provider = new ControllableProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  t.after(() => h.close());
  const user = await h.makeUser('free-player');

  const response = await h.json('POST', '/v1/analysis', analysisRequest(user.token));

  assert.equal(response.status, 200);
  assert.equal(provider.calls, 1);
});

test('active rated and unrated human games block assistance before engine work', async (t) => {
  for (const rated of [true, false]) {
    const provider = new ControllableProvider();
    const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
    t.after(() => h.close());
    const player = await h.makeUser(`active-${rated}`);
    const opponent = await h.makeUser(`opponent-${rated}`);
    await startGame(h, rated
      ? '00000000-0000-7000-8000-000000000101'
      : '00000000-0000-7000-8000-000000000102', player.userId, opponent.userId, rated);

    const response = await h.json('POST', '/v1/analysis', analysisRequest(player.token));

    assert.equal(response.status, 409, `rated=${rated}`);
    assert.equal(response.body.error.code, 'conflict');
    assert.equal(response.body.error.details.reason, 'active_human_game');
    assert.equal(provider.calls, 0);
  }
});

test('arbitrary FEN and a second authenticated session cannot bypass the user-scoped guard', async (t) => {
  const provider = new ControllableProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  t.after(() => h.close());
  const player = await h.makeUser('multi-session');
  const opponent = await h.makeUser('multi-session-opponent');
  const secondSession = h.tokens.issue({
    userId: player.userId,
    handle: 'multi-session',
    roles: ['user'],
  }).token;
  await startGame(
    h,
    '00000000-0000-7000-8000-000000000103',
    player.userId,
    opponent.userId,
  );

  const response = await h.json('POST', '/v1/analysis', analysisRequest(secondSession, OTHER_FEN));

  assert.equal(response.status, 409);
  assert.equal(provider.calls, 0);
});

test('every actionable assistance route is blocked for an active human-game participant', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const player = await h.makeUser('route-matrix-player');
  const opponent = await h.makeUser('route-matrix-opponent');
  await startGame(
    h,
    '00000000-0000-7000-8000-000000000104',
    player.userId,
    opponent.userId,
  );

  const routes = [
    ['POST', '/v1/analysis', { fen: START_FEN, variant: 'standard' }],
    ['POST', '/v1/analysis/puzzle', { fen: START_FEN, variant: 'standard' }],
    ['POST', '/v1/analysis/mistake-prediction', { fen: START_FEN, variant: 'standard', move: 'e2e4' }],
    ['POST', '/v1/ai/move-explanation', { fen: START_FEN, variant: 'standard', move: 'e2e4' }],
    ['POST', '/v1/openings/explore', { variant: 'standard', moves: ['e2e4'] }],
    ['POST', '/v1/coach', { fen: START_FEN, variant: 'standard' }],
    ['POST', '/v1/study-partner/sessions', { variant: 'standard', initialFen: START_FEN }],
  ] as const;

  for (const [method, path, body] of routes) {
    const response = await h.json(method, path, { token: player.token, body });
    assert.equal(response.status, 409, `${method} ${path}`);
    assert.equal(response.body.error.details.reason, 'active_human_game', `${method} ${path}`);
  }
});

test('Study Partner cannot reveal or extend an existing session during active human play', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const player = await h.makeUser('study-live-player');
  const opponent = await h.makeUser('study-live-opponent');
  const createdSession = await h.json('POST', '/v1/study-partner/sessions', {
    token: player.token,
    body: { variant: 'standard', initialFen: START_FEN },
  });
  assert.equal(createdSession.status, 201);
  await startGame(
    h,
    '00000000-0000-7000-8000-000000000109',
    player.userId,
    opponent.userId,
  );
  const sessionId = createdSession.body.id as string;

  const resumed = await h.json('GET', `/v1/study-partner/sessions/${sessionId}`, {
    token: player.token,
  });
  const turn = await h.json('POST', `/v1/study-partner/sessions/${sessionId}/turns`, {
    token: player.token,
    headers: { 'Idempotency-Key': 'blocked-live-turn' },
    body: { move: 'e2e4', expectedVersion: 0 },
  });

  assert.equal(resumed.status, 409);
  assert.equal(turn.status, 409);
});

test('Study Partner writes acquire the player barrier before durable mutation', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const player = await h.makeUser('study-write-barrier');
  const release = await h.repos.events.acquirePlayerLock(player.userId);
  let settled = false;
  const pending = h.json('POST', '/v1/study-partner/sessions', {
    token: player.token,
    body: { variant: 'standard', initialFen: START_FEN },
  }).then((response) => {
    settled = true;
    return response;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  await release();

  const response = await pending;
  assert.equal(response.status, 201);
});

test('a separate user remains eligible while another user has an active human game', async (t) => {
  const provider = new ControllableProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  t.after(() => h.close());
  const player = await h.makeUser('busy-player');
  const opponent = await h.makeUser('busy-opponent');
  const unrelated = await h.makeUser('unrelated-player');
  await startGame(
    h,
    '00000000-0000-7000-8000-000000000105',
    player.userId,
    opponent.userId,
  );

  const response = await h.json('POST', '/v1/analysis', analysisRequest(unrelated.token));

  assert.equal(response.status, 200);
  assert.equal(provider.calls, 1);
});

test('active bot games remain eligible under the existing versus-computer semantics', async (t) => {
  const provider = new ControllableProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  t.after(() => h.close());
  const player = await h.makeUser('bot-player');
  await startGame(
    h,
    '00000000-0000-7000-8000-000000000106',
    player.userId,
    BOT_ACCOUNTS[0]!.userId,
    false,
  );

  const response = await h.json('POST', '/v1/analysis', analysisRequest(player.token));

  assert.equal(response.status, 200);
  assert.equal(provider.calls, 1);
});

test('curated endgame training remains available during an active human game', async (t) => {
  const provider = new ControllableProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  t.after(() => h.close());
  const player = await h.makeUser('training-player');
  const opponent = await h.makeUser('training-opponent');
  await startGame(
    h,
    '00000000-0000-7000-8000-000000000110',
    player.userId,
    opponent.userId,
  );

  const response = await h.json('POST', '/v1/endgames/next', {
    token: player.token,
    body: { id: 'kq-vs-k-01' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.id, 'kq-vs-k-01');
});

test('disconnect or reconnect cannot reopen assistance while the durable game is active', async (t) => {
  const provider = new ControllableProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  t.after(() => h.close());
  const player = await h.makeUser('reconnect-player');
  const opponent = await h.makeUser('reconnect-opponent');
  await startGame(
    h,
    '00000000-0000-7000-8000-000000000111',
    player.userId,
    opponent.userId,
  );

  for (const phase of ['disconnected', 'reconnected']) {
    const response = await h.json('POST', '/v1/analysis', analysisRequest(player.token));
    assert.equal(response.status, 409, phase);
  }
  assert.equal(provider.calls, 0);
});

test('GameEnded immediately restores post-game assistance', async (t) => {
  const provider = new ControllableProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  t.after(() => h.close());
  const player = await h.makeUser('finished-player');
  const opponent = await h.makeUser('finished-opponent');
  const gameId = '00000000-0000-7000-8000-000000000107';
  await startGame(h, gameId, player.userId, opponent.userId);
  await endGame(h, gameId);

  const response = await h.json('POST', '/v1/analysis', analysisRequest(player.token));

  assert.equal(response.status, 200);
  assert.equal(provider.calls, 1);
});

test('an in-flight result is discarded when the caller enters a human game before delivery', async (t) => {
  const provider = new ControllableProvider(true);
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  t.after(() => h.close());
  const player = await h.makeUser('race-player');
  const opponent = await h.makeUser('race-opponent');

  const pending = h.json('POST', '/v1/analysis', analysisRequest(player.token));
  await provider.entered;
  await startGame(
    h,
    '00000000-0000-7000-8000-000000000108',
    player.userId,
    opponent.userId,
  );
  provider.release();
  const response = await pending;

  assert.equal(response.status, 409);
  assert.equal(response.body.error.details.reason, 'active_human_game');
  assert.equal(provider.calls, 1);
});
