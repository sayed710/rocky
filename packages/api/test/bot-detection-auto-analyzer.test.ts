import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '@chess-platform/game';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { InMemoryBotBehaviorReportRepository } from '@chess-platform/anti-cheat';
import { InMemoryPubSub, gamesEndedChannel, type EndedBroadcast, type MoveBroadcast } from '@chess-platform/realtime-gateway';
import { EventStoreBotTimingSource } from '../src/bot-detection/source';
import { BotAnalysisService } from '../src/bot-detection/analysis-service';
import { BotAutoAnalyzer, type BotGameAnalyzer } from '../src/bot-detection/auto-analyzer';

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

test('BotAutoAnalyzer: end-to-end auto-analysis of finished games', async () => {
  const store = new InMemoryEventStore();
  const repo = new InMemoryBotBehaviorReportRepository();
  const source = new EventStoreBotTimingSource(store);
  const service = new BotAnalysisService(source, repo);
  const pubsub = new InMemoryPubSub();
  const analyzer = new BotAutoAnalyzer(pubsub, service);

  analyzer.start();

  const gameId = '11111111-1111-7111-8111-111111111111';
  const whiteId = '22222222-2222-7222-8222-222222222222';
  const blackId = '33333333-3333-7333-8333-333333333333';

  const events = createFinishedGameEvents(gameId, whiteId, blackId);
  await store.append(gameId, -1, events);

  const endedMsg: EndedBroadcast = {
    t: 'ended',
    stateRevision: 1,
    gameId,
    result: '0-1',
    termination: 'checkmate',
    winner: 'b',
    serverTs: 1000,
  };

  pubsub.publish(gamesEndedChannel(), endedMsg);
  await analyzer.drain();

  const whiteReports = await repo.listByPlayer(whiteId);
  assert.equal(whiteReports.length, 1);
  assert.equal(whiteReports[0]?.gameId, gameId);

  const blackReports = await repo.listByPlayer(blackId);
  assert.equal(blackReports.length, 1);
  assert.equal(blackReports[0]?.gameId, gameId);
});

test('BotAutoAnalyzer: crash-safety and error logging on analysis rejection', async () => {
  const pubsub = new InMemoryPubSub();
  let reportedError: { gameId: string; err: unknown } | undefined;

  const failingAnalyzer: BotGameAnalyzer = {
    analyzeAndStore: async () => {
      throw new Error('Timing extraction failed');
    },
  };

  const analyzer = new BotAutoAnalyzer(pubsub, failingAnalyzer, {
    onError: (gameId, err) => {
      reportedError = { gameId, err };
    },
  });

  analyzer.start();

  const gameId = 'game-failed-1';
  const endedMsg: EndedBroadcast = {
    t: 'ended',
    stateRevision: 1,
    gameId,
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    serverTs: 1000,
  };

  pubsub.publish(gamesEndedChannel(), endedMsg);
  await analyzer.drain();

  assert.ok(reportedError);
  assert.equal(reportedError.gameId, gameId);
  assert.equal((reportedError.err as Error).message, 'Timing extraction failed');
});

test('BotAutoAnalyzer: a failed analysis is retried on re-broadcast', async () => {
  const pubsub = new InMemoryPubSub();
  let calls = 0;
  // A throwing onError must not break the worker either; assert containment.
  const failingAnalyzer: BotGameAnalyzer = {
    analyzeAndStore: async () => {
      calls++;
      throw new Error('transient failure');
    },
  };
  const analyzer = new BotAutoAnalyzer(pubsub, failingAnalyzer, {
    onError: () => {
      throw new Error('onError itself throws');
    },
  });
  analyzer.start();

  const endedMsg: EndedBroadcast = {
    t: 'ended',
    stateRevision: 1,
    gameId: 'game-retry-1',
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    serverTs: 1000,
  };

  pubsub.publish(gamesEndedChannel(), endedMsg);
  await analyzer.drain(); // must not reject even though onError throws
  pubsub.publish(gamesEndedChannel(), endedMsg);
  await analyzer.drain();

  // The failed game left the dedup set, so the re-broadcast re-analyzed it.
  assert.equal(calls, 2);
});

test('BotAutoAnalyzer: deduplication skips re-analysis for seen gameId', async () => {
  const pubsub = new InMemoryPubSub();
  let calls = 0;

  const countingAnalyzer: BotGameAnalyzer = {
    analyzeAndStore: async () => {
      calls++;
      return null;
    },
  };

  const analyzer = new BotAutoAnalyzer(pubsub, countingAnalyzer);
  analyzer.start();

  const gameId = 'game-dedup-1';
  const endedMsg: EndedBroadcast = {
    t: 'ended',
    stateRevision: 1,
    gameId,
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    serverTs: 1000,
  };

  pubsub.publish(gamesEndedChannel(), endedMsg);
  pubsub.publish(gamesEndedChannel(), endedMsg);
  await analyzer.drain();

  assert.equal(calls, 1);
});

test('BotAutoAnalyzer: ignores non-ended broadcasts and stops cleanly', async () => {
  const pubsub = new InMemoryPubSub();
  let calls = 0;

  const countingAnalyzer: BotGameAnalyzer = {
    analyzeAndStore: async () => {
      calls++;
      return null;
    },
  };

  const analyzer = new BotAutoAnalyzer(pubsub, countingAnalyzer);
  analyzer.start();

  assert.equal(pubsub.subscriberCount(gamesEndedChannel()), 1);

  const moveMsg: MoveBroadcast = {
    t: 'move',
    stateRevision: 1,
    gameId: 'game-1',
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: '123456789012',
    clock: { w: 180_000, b: 180_000 },
    serverTs: 1000,
    legalMoves: {},
  };

  pubsub.publish(gamesEndedChannel(), moveMsg);
  await analyzer.drain();
  assert.equal(calls, 0);

  analyzer.stop();
  assert.equal(pubsub.subscriberCount(gamesEndedChannel()), 0);

  const endedMsg: EndedBroadcast = {
    t: 'ended',
    stateRevision: 1,
    gameId: 'game-1',
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    serverTs: 1000,
  };

  pubsub.publish(gamesEndedChannel(), endedMsg);
  await analyzer.drain();
  assert.equal(calls, 0);
});
