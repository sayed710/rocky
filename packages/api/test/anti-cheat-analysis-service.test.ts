import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '@chess-platform/game';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { InMemoryAntiCheatReportRepository, type PositionEvaluator } from '@chess-platform/anti-cheat';
import { EventStoreGameSource } from '../src/anti-cheat/source';
import { AntiCheatAnalysisService } from '../src/anti-cheat/analysis-service';

const fakeEvaluator: PositionEvaluator = {
  evaluate: (_fen, playedUci) => ({
    topMoves: [
      { uci: playedUci, cp: 30 },
      { uci: '0000', cp: 10 },
    ],
    playedCp: 30,
  }),
};

function createFinishedGameEvents(gameId: string, white: string, black: string) {
  const timeControl = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' as const };
  let { game, events } = Game.create({
    gameId,
    timeControl,
    players: { white, black },
    rated: true,
    at: 1000,
  });
  const allEvents = [...events];
  let t = 2000;
  for (const uci of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
    ({ game, events } = game.playMove(uci, t));
    allEvents.push(...events);
    t += 1000;
  }
  return allEvents;
}

function createUnfinishedGameEvents(gameId: string, white: string, black: string) {
  const timeControl = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' as const };
  let { game, events } = Game.create({
    gameId,
    timeControl,
    players: { white, black },
    rated: true,
    at: 1000,
  });
  const allEvents = [...events];
  ({ game, events } = game.playMove('e2e4', 2000));
  allEvents.push(...events);
  return allEvents;
}

test('AntiCheatAnalysisService: analyzes and stores finished game reports', async () => {
  const store = new InMemoryEventStore();
  const repo = new InMemoryAntiCheatReportRepository();
  const source = new EventStoreGameSource(store);
  const service = new AntiCheatAnalysisService(source, () => fakeEvaluator, repo);

  const gameId = '11111111-1111-7111-8111-111111111111';
  const whiteId = '22222222-2222-7222-8222-222222222222';
  const blackId = '33333333-3333-7333-8333-333333333333';

  const events = createFinishedGameEvents(gameId, whiteId, blackId);
  await store.append(gameId, -1, events);

  const report = await service.analyzeAndStore(gameId);
  assert.ok(report);
  assert.ok(report.white);
  assert.ok(report.black);

  const whiteReports = await repo.listByPlayer(whiteId);
  assert.equal(whiteReports.length, 1);
  assert.equal(whiteReports[0]?.gameId, gameId);

  const blackReports = await repo.listByPlayer(blackId);
  assert.equal(blackReports.length, 1);
  assert.equal(blackReports[0]?.gameId, gameId);
});

test('AntiCheatAnalysisService: returns null for unknown gameId', async () => {
  const store = new InMemoryEventStore();
  const repo = new InMemoryAntiCheatReportRepository();
  const source = new EventStoreGameSource(store);
  const service = new AntiCheatAnalysisService(source, () => fakeEvaluator, repo);

  const report = await service.analyzeAndStore('99999999-9999-7999-8999-999999999999');
  assert.equal(report, null);
});

test('AntiCheatAnalysisService: returns null for unfinished game', async () => {
  const store = new InMemoryEventStore();
  const repo = new InMemoryAntiCheatReportRepository();
  const source = new EventStoreGameSource(store);
  const service = new AntiCheatAnalysisService(source, () => fakeEvaluator, repo);

  const gameId = '44444444-4444-7444-8444-444444444444';
  const whiteId = '22222222-2222-7222-8222-222222222222';
  const blackId = '33333333-3333-7333-8333-333333333333';

  const events = createUnfinishedGameEvents(gameId, whiteId, blackId);
  await store.append(gameId, -1, events);

  const report = await service.analyzeAndStore(gameId);
  assert.equal(report, null);

  const whiteReports = await repo.listByPlayer(whiteId);
  assert.equal(whiteReports.length, 0);
});

/**
 * A Chess960 game is analysed from the arrangement it started at, and a corrupt one is skipped.
 *
 * Both cases arrived with ADR-0137. Before it, every game began at `Position.initial(variant)` and a
 * stored creation event could not be rejected on replay, so neither path existed.
 */
test('a chess960 game is analysed from its own starting position', async () => {
  const events = new InMemoryEventStore();
  const gameId = 'c960-game';
  // Position 700 — RBQKNNBR, king d1, rooks a1/h1 — so a replay that fell back to position 518 would
  // be scoring a different game.
  let { game, events: created } = Game.create({
    gameId,
    variant: 'chess960',
    chess960StartId: 700,
    timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' as const },
    players: { white: 'w1', black: 'b1' },
    rated: true,
    at: 1000,
  });
  const all = [...created];
  let t = 2000;
  for (const uci of ['e2e4', 'e7e5', 'f1g3', 'd7d6']) {
    let next;
    ({ game, events: next } = game.playMove(uci, t));
    all.push(...next);
    t += 1000;
  }
  ({ events: created } = game.resign('b', t));
  all.push(...created);
  await events.append(gameId, -1, all);

  const seen: string[] = [];
  const recordingEvaluator: PositionEvaluator = {
    evaluate: (fen, playedUci) => {
      seen.push(fen);
      return { topMoves: [{ uci: playedUci, cp: 30 }], playedCp: 30 };
    },
  };

  const service = new AntiCheatAnalysisService(
    new EventStoreGameSource(events),
    () => recordingEvaluator,
    new InMemoryAntiCheatReportRepository(),
  );
  const report = await service.analyzeAndStore(gameId);

  assert.ok(report, 'the chess960 game was analysed rather than rejected as illegal');
  assert.equal(
    seen[0],
    'rbqknnbr/pppppppp/8/8/8/8/PPPPPPPP/RBQKNNBR w KQkq - 0 1',
    'the first position scored is the arrangement the game started from, not position 518',
  );
});

test('a stored game whose chess960 metadata is corrupt is skipped, not thrown from', async () => {
  // `Game.reduce` rejects a creation event whose start id disagrees with its FEN (ADR-0137 §3). That
  // throw is correct, but an anti-cheat read is not where it should surface: this method's contract is
  // "the finished game, or null", and an unanalysable game is an absent one. Raised in the CodeRabbit
  // review of PR #12.
  const events = new InMemoryEventStore();
  const gameId = 'c960-corrupt';
  await events.append(gameId, -1, [
    {
      type: 'GameCreated',
      gameId,
      variant: 'chess960',
      // Claims position 700 while carrying the board of 518.
      chess960StartId: 700,
      initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' as const },
      players: { white: 'w1', black: 'b1' },
      rated: true,
      at: 1000,
    } as never,
  ]);

  const service = new AntiCheatAnalysisService(
    new EventStoreGameSource(events),
    () => fakeEvaluator,
    new InMemoryAntiCheatReportRepository(),
  );

  assert.equal(await service.analyzeAndStore(gameId), null, 'skipped rather than raising');
});

test('a corrupt stored game is logged, so containment is not the same as silence', async () => {
  // Returning a bare `null` made a corrupt stream indistinguishable from an ordinary miss: the
  // moderation route maps `null` to a 404 "no finished game", and `AntiCheatAutoAnalyzer` reports only
  // *rejected* promises — so nothing would ever have said a durable row is unreadable. Raised in the
  // Qodo review of PR #12, against the containment added for CodeRabbit's finding in the same round.
  const events = new InMemoryEventStore();
  const gameId = 'c960-corrupt-logged';
  await events.append(gameId, -1, [
    {
      type: 'GameCreated',
      gameId,
      variant: 'chess960',
      chess960StartId: 700,
      initialFen: 'PRIVATE-STORED-FEN-SENTINEL',
      timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' as const },
      players: { white: 'w1', black: 'b1' },
      rated: true,
      at: 1000,
    } as never,
  ]);

  const records: { msg: string; fields?: Record<string, unknown> }[] = [];
  const capturing = {
    debug() {}, info() {}, warn() {},
    error(msg: string, fields?: Record<string, unknown>) {
      records.push({ msg, ...(fields ? { fields } : {}) });
    },
    child() { return capturing; },
  };

  const service = new AntiCheatAnalysisService(
    new EventStoreGameSource(events, capturing as never),
    () => fakeEvaluator,
    new InMemoryAntiCheatReportRepository(),
  );

  assert.equal(await service.analyzeAndStore(gameId), null);
  assert.equal(records.length, 1, 'the unreadable row produced exactly one operator signal');
  assert.match(records[0]!.msg, /could not be replayed/);
  assert.equal(records[0]!.fields?.['gameId'], gameId, 'and names the game an operator has to go find');
  assert.equal(records[0]!.fields?.['errorClass'], 'game-replay-error');
  assert.ok(!JSON.stringify(records).includes('PRIVATE-STORED-FEN-SENTINEL'), 'stored payload must not enter operator logs');
});
