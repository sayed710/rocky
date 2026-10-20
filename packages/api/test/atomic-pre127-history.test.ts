/**
 * #127 Design B, per consumer: a durable atomic game whose final move only the pre-#127 rules allowed
 * (a king capture next to the enemy king, which exploded both kings and ended the game 0-1) is read by
 * every finished-game consumer with its stored result, and nothing rewrites it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, charge, type GameEvent, type MovePlayedEvent, type TimeControl } from '@chess-platform/game';
import { CorruptGameStreamError, InMemoryEventStore, projectGameStream } from '@chess-platform/persistence';
import { InMemoryAntiCheatReportRepository, type PositionEvaluator } from '@chess-platform/anti-cheat';
import { finishedGamePgn, readFinishedGame } from '../src/game-export/finished-game-pgn';
import { DurableFinishedGameReviewArchive } from '../src/game-review/finished-game-review';
import { EventStoreGameSource } from '../src/anti-cheat/source';
import { AntiCheatAnalysisService } from '../src/anti-cheat/analysis-service';
import { EventStoreBotTimingSource } from '../src/bot-detection/source';
import { DurableFinishedGameArchive } from '../src/tournament/durable-finished-game';
import { DurableTournamentLiveView } from '../src/tournament/durable-live-view';
import { InMemoryTournamentsRepository } from '../src/fakes';

const GAME_ID = '00000000-0000-4000-8000-000000000127';
const LIVE_ID = '00000000-0000-4000-8000-000000000128';
const WHITE = '00000000-0000-4000-8000-0000000000a1';
const BLACK = '00000000-0000-4000-8000-0000000000b1';
const TC: TimeControl = { initialMs: 300_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' };
const LINE = 'e2e3 e7e6 e1e2 e8e7 e2d3 e7d6 d3d4 e6e5';

/** The legal line, then the [MovePlayed Kxe5, GameEnded 0-1 variant b] pair the pre-#127 authority wrote. */
function pre127Events(gameId = GAME_ID, variant: 'atomic' | 'standard' = 'atomic'): GameEvent[] {
  let { game, events } = Game.create({ gameId, variant, timeControl: TC, players: { white: WHITE, black: BLACK }, rated: true, at: 0 });
  const log: GameEvent[] = [...events];
  let at = 0;
  for (const uci of LINE.split(' ')) {
    const r = game.playMove(uci, (at += 1_000));
    game = r.game;
    log.push(...r.events);
  }
  const s = game.snapshot();
  at += 1_000;
  const charged = charge(s.clock, 'w', at, TC);
  const move: MovePlayedEvent = {
    type: 'MovePlayed', ply: 9, uci: 'd4e5', san: 'Kxe5', by: 'w',
    moveTimeMs: charged.moveTimeMs, remaining: charged.clock.remaining, at,
  };
  return [...log, move, { type: 'GameEnded', result: '0-1', termination: 'variant', winner: 'b', at }];
}

async function storeWith(events: readonly GameEvent[], gameId = GAME_ID): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore(() => 1_000);
  await store.append(gameId, -1, events);
  return store;
}

test('PGN export: the stored game exports with its stored result and SAN', async () => {
  const store = await storeWith(pre127Events());
  const record = readFinishedGame(GAME_ID, await store.load(GAME_ID));
  assert.ok(record);
  assert.equal(record.ended.result, '0-1');
  assert.equal(record.moves.length, 9);
  const pgn = finishedGamePgn(record, { white: 'alice', black: 'bob' });
  assert.match(pgn, /4\. Kd4 e5\+ 5\. Kxe5 0-1\s*$/);
});

test('PGN export: forged or truncated variants of the pattern are refused as corrupt', async () => {
  const events = pre127Events();
  const forged: Array<[string, GameEvent[]]> = [
    ['truncated before GameEnded', events.slice(0, -1)],
    ['standard variant', pre127Events(GAME_ID, 'standard')],
    ['white declared winner', [...events.slice(0, -1), { ...events.at(-1)!, result: '1-0', winner: 'w' } as GameEvent]],
    ['SAN naming another move', [...events.slice(0, -2), { ...events.at(-2)!, san: 'Kxd5' } as GameEvent, events.at(-1)!]],
  ];
  for (const [name, stream] of forged) {
    const store = await storeWith(stream);
    const rows = await store.load(GAME_ID);
    assert.throws(() => readFinishedGame(GAME_ID, rows), CorruptGameStreamError, name);
  }
});

test('game review: every move, including the stored final one, is listed from its own position', async () => {
  const store = await storeWith(pre127Events());
  const reviewed = await new DurableFinishedGameReviewArchive(store).finishedGameForReview(GAME_ID);
  assert.ok(reviewed);
  assert.equal(reviewed.result, '0-1');
  assert.equal(reviewed.termination, 'variant');
  assert.equal(reviewed.moves.length, 9);
  assert.equal(reviewed.moves[8]!.uci, 'd4e5');
  assert.equal(reviewed.moves[8]!.historical, true, 'marked so the review never sends it to an engine');
  assert.ok(reviewed.moves.slice(0, 8).every((move) => move.historical === undefined));
  assert.equal(reviewed.moves[8]!.fenBefore.split(' ')[0], 'rnbq1bnr/pppp1ppp/3k4/4p3/3K4/4P3/PPPP1PPP/RNBQ1BNR');
});

const evaluator: PositionEvaluator = {
  async evaluate(_fen, played) {
    return { topMoves: [{ uci: played, cp: 0 }], playedCp: 0 };
  },
};

test('anti-cheat: the stored final move is excluded, marked unanalysed on its mover, and nothing is rewritten', async () => {
  const store = await storeWith(pre127Events());
  const before = JSON.stringify(await store.load(GAME_ID));
  const source = new EventStoreGameSource(store);
  const finished = await source.load(GAME_ID);
  assert.ok(finished);
  assert.equal(finished.moves.length, 8, 'the excluded move is not offered to the engine');
  assert.deepEqual(finished.historicalExcluded, { player: 'white', ply: 9, uci: 'd4e5' });

  const repository = new InMemoryAntiCheatReportRepository();
  const report = await new AntiCheatAnalysisService(source, () => evaluator, repository).analyzeAndStore(GAME_ID);
  assert.ok(report);
  assert.equal(report.white.historicalExcludedPlies, 1);
  assert.equal(report.black.historicalExcludedPlies, undefined);
  const stored = await repository.listByPlayer(WHITE);
  assert.equal(stored[0]!.report.historicalExcludedPlies, 1, 'the marker is persisted with the report');
  assert.equal(JSON.stringify(await store.load(GAME_ID)), before, 'the event log is unchanged');
});

test('anti-cheat: an ordinary finished game carries no exclusion marker', async () => {
  const events = pre127Events().slice(0, -2);
  const game = Game.fromEvents(events).resign('w', 20_000);
  const store = await storeWith([...events, ...game.events]);
  const finished = await new EventStoreGameSource(store).load(GAME_ID);
  assert.ok(finished);
  assert.equal(finished.historicalExcluded, undefined);
  const report = await new AntiCheatAnalysisService(new EventStoreGameSource(store), () => evaluator, new InMemoryAntiCheatReportRepository()).analyzeAndStore(GAME_ID);
  assert.equal(report?.white.historicalExcludedPlies, undefined);
});

test('bot detection: timings of every stored move are read', async () => {
  const loaded = await new EventStoreBotTimingSource(await storeWith(pre127Events())).load(GAME_ID);
  assert.ok(loaded);
  assert.equal(loaded.moves.length, 9);
});

test('tournament archive: the finished game, its final move and the position before it', async () => {
  const finished = await new DurableFinishedGameArchive(await storeWith(pre127Events())).finishedGame(GAME_ID);
  assert.ok(finished);
  assert.equal(finished.result, '0-1');
  assert.equal(finished.termination, 'variant');
  assert.deepEqual(finished.finalMove, { uci: 'd4e5', san: 'Kxe5', by: 'w' });
  assert.equal(finished.fenBeforeFinalMove?.split(' ')[0], 'rnbq1bnr/pppp1ppp/3k4/4p3/3K4/4P3/PPPP1PPP/RNBQ1BNR');
});

test('tournament live view: a stored pre-#127 game is skipped as finished and does not hide live boards', async () => {
  const store = await storeWith(pre127Events());
  const live = Game.create({ gameId: LIVE_ID, variant: 'atomic', timeControl: TC, players: { white: WHITE, black: BLACK }, at: 0 });
  await store.append(LIVE_ID, -1, live.events);
  const tournaments = new InMemoryTournamentsRepository();
  await tournaments.save({
    config: { id: 't1', name: 'Test', format: 'round_robin', variant: 'atomic', timeControl: TC as { initialMs: number; incrementMs: number; delayMs: number; kind: 'increment' } },
    state: 'running',
    participants: [WHITE, BLACK],
    rounds: [],
    results: [],
    pairingsByMatchId: [],
    gameLinks: [['0-0', GAME_ID], ['0-1', LIVE_ID]],
  }, 0);
  const boards = await new DurableTournamentLiveView(tournaments, store).activeGames('t1');
  assert.deepEqual(boards.map((b) => b.gameId), [LIVE_ID]);
});

test('projection and rating eligibility read the stored result without judging move legality', async () => {
  const projection = projectGameStream(GAME_ID, await (await storeWith(pre127Events())).load(GAME_ID));
  assert.equal(projection.result, '0-1');
  assert.equal(projection.termination, 'variant');
});
