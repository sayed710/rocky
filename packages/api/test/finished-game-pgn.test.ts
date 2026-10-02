import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, type GameEvent, type ResultString, type Termination, type TimeControl } from '@chess-platform/game';
import type { Variant } from '@chess-platform/core';
import {
  CorruptGameStreamError,
  InMemoryEventStore,
  type StoredEvent,
} from '@chess-platform/persistence';
import { parsePgn, tagValue, type PgnGame } from '@chess-platform/studies';
import { HttpError } from '../src/http/errors';
import { BOT_ACCOUNTS } from '../src/bot/catalogue';
import { CorePositionReader } from '../src/studies/position-reader';
import type { PlayerHandles } from '../src/commentary/ports';
import {
  FinishedGamePgnService,
  finishedGamePgn,
  pgnDate,
  pgnTimeControl,
  readFinishedGame,
} from '../src/game-export/finished-game-pgn';
import { startHarness } from './helpers';

const GAME_ID = '00000000-0000-4000-8000-0000000000a1';
const WHITE = '00000000-0000-4000-8000-00000000000a';
const BLACK = '00000000-0000-4000-8000-00000000000b';
const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BLITZ: TimeControl = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' };
/** 2023-11-14T22:13:20Z. */
const CREATED_AT = 1_700_000_000_000;

type Finish = (game: Game, at: number) => { game: Game; events: GameEvent[] };

interface Played {
  readonly stream: StoredEvent[];
  readonly sans: string[];
}

/** Drive a real game through the authority and return its stream exactly as the store would hold it. */
function play(options: {
  readonly moves: readonly string[];
  readonly finish?: Finish | null;
  readonly variant?: Variant;
  readonly chess960StartId?: number;
  readonly initialFen?: string;
  readonly timeControl?: TimeControl;
  readonly gameId?: string;
  readonly players?: { white: string; black: string };
}): Played {
  const created = Game.create({
    gameId: options.gameId ?? GAME_ID,
    players: options.players ?? { white: WHITE, black: BLACK },
    timeControl: options.timeControl ?? BLITZ,
    at: CREATED_AT,
    ...(options.variant !== undefined ? { variant: options.variant } : {}),
    ...(options.chess960StartId !== undefined ? { chess960StartId: options.chess960StartId } : {}),
    ...(options.initialFen !== undefined ? { initialFen: options.initialFen } : {}),
  });
  let game = created.game;
  const events: GameEvent[] = [...created.events];
  let at = CREATED_AT;
  for (const uci of options.moves) {
    at += 1_000;
    const played = game.playMove(uci, at);
    game = played.game;
    events.push(...played.events);
  }
  const finish = options.finish === undefined ? resign('b') : options.finish;
  if (finish !== null && !game.status.over) {
    const ended = finish(game, at + 1_000);
    events.push(...ended.events);
  }
  return {
    stream: events.map((event, seq) => stored(seq, event)),
    sans: events.flatMap((event) => (event.type === 'MovePlayed' ? [event.san] : [])),
  };
}

function stored(seq: number, event: GameEvent, gameId = GAME_ID): StoredEvent {
  return { gameId, seq, version: 1, event, serverTs: CREATED_AT + seq };
}

const resign = (color: 'w' | 'b'): Finish => (game, at) => game.resign(color, at);
const agree: Finish = (game, at) => {
  const offered = game.offerDraw('w', at);
  const accepted = offered.game.acceptDraw('b', at);
  return { game: accepted.game, events: [...offered.events, ...accepted.events] };
};

const NAMES = { white: 'alice', black: 'bob' };

function exportOf(played: Played, names = NAMES): { text: string; pgn: PgnGame } {
  const record = readFinishedGame(GAME_ID, played.stream);
  assert.ok(record, 'expected a finished game');
  const text = finishedGamePgn(record, names);
  const games = parsePgn(text);
  assert.equal(games.length, 1, 'one export is exactly one PGN game');
  return { text, pgn: games[0]! };
}

function tags(pgn: PgnGame): Record<string, string> {
  return Object.fromEntries(pgn.tags.map((tag) => [tag.key, tag.value]));
}

/** Replay the exported SAN from the exported start under the exported variant: the export alone must be enough. */
function replayExport(pgn: PgnGame): string {
  const reader = new CorePositionReader();
  const variant = (tagValue(pgn, 'Variant') ?? 'standard') as Variant;
  let fen = tagValue(pgn, 'FEN') ?? STANDARD_FEN;
  for (const move of pgn.moves) fen = reader.play(fen, move.san, variant);
  return fen;
}

function finalFen(played: Played): string {
  return Game.fromEvents(played.stream.map((entry) => entry.event)).fen;
}

class RecordingHandles implements PlayerHandles {
  readonly calls: (readonly string[])[] = [];
  constructor(private readonly known: ReadonlyMap<string, string>) {}
  async handles(playerIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    this.calls.push([...playerIds]);
    return new Map([...this.known].filter(([id]) => playerIds.includes(id)));
  }
}

async function storeOf(played: Played, gameId = GAME_ID): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore(() => CREATED_AT);
  await store.append(gameId, -1, played.stream.map((entry) => entry.event));
  return store;
}

// --- The export ----------------------------------------------------------------------------------

test('a standard white win exports the Seven Tag Roster, the stored SAN in order, and the result', () => {
  const played = play({ moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'], finish: resign('b') });
  const { text, pgn } = exportOf(played);

  assert.deepEqual(pgn.tags.slice(0, 7), [
    { key: 'Event', value: '?' },
    { key: 'Site', value: '?' },
    { key: 'Date', value: '2023.11.14' },
    { key: 'Round', value: '?' },
    { key: 'White', value: 'alice' },
    { key: 'Black', value: 'bob' },
    { key: 'Result', value: '1-0' },
  ]);
  assert.deepEqual(pgn.moves.map((move) => move.san), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
  assert.deepEqual(pgn.moves.map((move) => move.san), played.sans);
  assert.equal(pgn.result, '1-0');
  assert.ok(text.endsWith(' 1-0\n'), 'the movetext ends with the result and a final newline');
  assert.equal(tagValue(pgn, 'SetUp'), undefined, 'a standard start needs no SetUp');
  assert.equal(tagValue(pgn, 'FEN'), undefined, 'a standard start needs no FEN');
  assert.equal(tagValue(pgn, 'Variant'), undefined, 'standard chess carries no Variant tag');
  assert.equal(replayExport(pgn), finalFen(played));
});

test('a black win, a draw and an abandoned game each export their own GameEnded result', () => {
  const cases: { finish: Finish; result: string }[] = [
    { finish: resign('w'), result: '0-1' },
    { finish: agree, result: '1/2-1/2' },
    { finish: (game, at) => game.abort(at), result: '*' },
  ];
  for (const { finish, result } of cases) {
    const { pgn, text } = exportOf(play({ moves: ['d2d4'], finish }));
    assert.equal(tagValue(pgn, 'Result'), result);
    assert.equal(pgn.result, result);
    assert.ok(text.endsWith(` ${result}\n`));
  }
});

test('a checkmate exports the stored mating SAN and the decisive result', () => {
  const played = play({ moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'], finish: null });
  const { pgn } = exportOf(played);
  assert.deepEqual(pgn.moves.map((move) => move.san), ['f3', 'e5', 'g4', 'Qh4#']);
  assert.equal(pgn.result, '0-1');
});

/** The stream with the stored SAN of `ply` replaced. */
function withSan(played: Played, ply: number, san: string): StoredEvent[] {
  return played.stream.map((entry) =>
    entry.event.type === 'MovePlayed' && entry.event.ply === ply ? stored(entry.seq, { ...entry.event, san }) : entry,
  );
}

test('the exported moves are the stored SAN text, including a historical castling spelling', () => {
  // The stored SAN is written as stored, not recomputed: `0-0` stays `0-0`.
  const played = play({ moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1'] });
  assert.equal(played.sans.at(-1), 'O-O');
  const record = readFinishedGame(GAME_ID, withSan(played, 7, '0-0'));
  assert.ok(record);
  assert.deepEqual(
    parsePgn(finishedGamePgn(record, NAMES))[0]!.moves.map((move) => move.san),
    ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', '0-0'],
  );
});

test('a stored SAN that names a different move than its UCI is refused', () => {
  // Replay checks the UCI; a well-formed SAN for another move would make the PGN a different game.
  const played = play({ moves: ['e2e4', 'e7e5', 'g1f3'] });
  for (const [ply, san] of [[2, 'e6'], [2, 'd5'], [3, 'Ng1f3'], [3, 'Nh3'], [1, 'e3']] as const) {
    assert.throws(() => readFinishedGame(GAME_ID, withSan(played, ply, san)), CorruptGameStreamError, `${ply} ${san}`);
  }
});

/**
 * The authority's result contract (packages/game/src/game.ts), written out independently of the
 * implementation's table so a change to either one fails here.
 */
const EXPECTED_RESULTS: Record<Termination, readonly ResultString[]> = {
  checkmate: ['1-0', '0-1'],
  resignation: ['1-0', '0-1'],
  timeout: ['1-0', '0-1'],
  stalemate: ['1/2-1/2'],
  agreement: ['1/2-1/2'],
  insufficient_material: ['1/2-1/2'],
  fifty_move: ['1/2-1/2'],
  threefold: ['1/2-1/2'],
  variant: ['1-0', '0-1', '1/2-1/2'],
  aborted: ['*'],
  no_show: ['*', '1-0', '0-1'],
};

function endingStream(patch: { result: string; winner: string | null; termination: string }): StoredEvent[] {
  const played = play({ moves: ['e2e4'] });
  return played.stream.map((entry) =>
    entry.event.type === 'GameEnded' ? stored(entry.seq, { ...entry.event, ...patch } as GameEvent) : entry);
}

const accepts = (patch: { result: string; winner: string | null; termination: string }): boolean => {
  try {
    return readFinishedGame(GAME_ID, endingStream(patch)) !== null;
  } catch (err) {
    if (err instanceof CorruptGameStreamError) return false;
    throw err;
  }
};

test('every termination x result x winner combination is accepted exactly when the authority could write it', () => {
  let accepted = 0;
  for (const [termination, results] of Object.entries(EXPECTED_RESULTS)) {
    for (const result of ['1-0', '0-1', '1/2-1/2', '*'] as const) {
      for (const winner of ['w', 'b', null] as const) {
        const matching = result === '1-0' ? 'w' : result === '0-1' ? 'b' : null;
        const expected = results.includes(result) && winner === matching;
        assert.equal(accepts({ result, winner, termination }), expected, `${termination} ${result} winner=${String(winner)}`);
        if (expected) accepted += 1;
      }
    }
  }
  assert.equal(accepted, 18, 'the 18 combinations the authority can write');
  assert.equal(accepts({ result: '1-0', winner: 'w', termination: 'forfeit' }), false, 'an unknown termination is refused');
});

test('the contradictions found in review are refused, and every legitimate ending kind is kept', () => {
  for (const patch of [
    { result: '1/2-1/2', winner: null, termination: 'checkmate' },
    { result: '1/2-1/2', winner: null, termination: 'resignation' },
    { result: '1/2-1/2', winner: null, termination: 'timeout' },
    { result: '1/2-1/2', winner: null, termination: 'no_show' },
    { result: '*', winner: null, termination: 'checkmate' },
    { result: '*', winner: null, termination: 'variant' },
    { result: '1-0', winner: 'w', termination: 'stalemate' },
    { result: '0-1', winner: 'b', termination: 'agreement' },
    { result: '1-0', winner: 'b', termination: 'checkmate' },
    { result: '0-1', winner: null, termination: 'resignation' },
    { result: '1/2-1/2', winner: 'w', termination: 'agreement' },
    { result: '*', winner: 'b', termination: 'aborted' },
    { result: '1-0', winner: 'w', termination: 'aborted' },
  ]) {
    assert.equal(accepts(patch), false, JSON.stringify(patch));
  }
  for (const patch of [
    { result: '1-0', winner: 'w', termination: 'checkmate' },
    { result: '0-1', winner: 'b', termination: 'resignation' },
    { result: '1-0', winner: 'w', termination: 'timeout' },
    { result: '1/2-1/2', winner: null, termination: 'stalemate' },
    { result: '1/2-1/2', winner: null, termination: 'agreement' },
    { result: '1/2-1/2', winner: null, termination: 'insufficient_material' },
    { result: '1/2-1/2', winner: null, termination: 'fifty_move' },
    { result: '1/2-1/2', winner: null, termination: 'threefold' },
    { result: '0-1', winner: 'b', termination: 'variant' },
    { result: '1/2-1/2', winner: null, termination: 'variant' },
    { result: '*', winner: null, termination: 'no_show' },
    { result: '1-0', winner: 'w', termination: 'no_show' },
    { result: '*', winner: null, termination: 'aborted' },
  ]) {
    assert.equal(accepts(patch), true, JSON.stringify(patch));
  }
});

test('endings the real authority writes are all exported', () => {
  const tc: TimeControl = { kind: 'sudden_death', initialMs: 10_000, incrementMs: 0, delayMs: 0 };
  // A decisive flag, and a flag against a side that cannot win, which the authority records as an
  // insufficient-material draw rather than a drawn timeout.
  const flagged = play({ moves: ['e2e4'], timeControl: tc, finish: (game, at) => game.claimFlag(at + 60_000) });
  const flaggedDraw = play({
    initialFen: '3qk3/8/8/8/8/8/8/4K3 w - - 0 1', moves: ['e1e2'], timeControl: tc,
    finish: (game, at) => game.claimFlag(at + 60_000),
  });
  const threefold = play({ moves: ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'], finish: null });
  const kingOfTheHill = play({ variant: 'kingofthehill', moves: ['e2e4', 'a7a6', 'e1e2', 'a6a5', 'e2e3', 'a5a4', 'e3d4'], finish: null });

  const endings = [flagged, flaggedDraw, threefold, kingOfTheHill].map((played) => {
    const record = readFinishedGame(GAME_ID, played.stream);
    assert.ok(record);
    return `${record.ended.termination} ${record.ended.result}`;
  });
  assert.deepEqual(endings, ['timeout 1-0', 'insufficient_material 1/2-1/2', 'threefold 1/2-1/2', 'variant 1-0']);

  // A tournament no-show with one ready seat is a forfeit win.
  const created = Game.create({
    gameId: GAME_ID, players: { white: WHITE, black: BLACK }, timeControl: BLITZ, at: CREATED_AT,
    source: 'tournament', noShowAfterMs: 30_000,
  });
  const ready = created.game.markReady('b', CREATED_AT + 1_000);
  const forfeit = ready.game.expireNoShow(CREATED_AT + 30_000);
  const stream = [...created.events, ...ready.events, ...forfeit.events].map((event, seq) => stored(seq, event));
  const record = readFinishedGame(GAME_ID, stream);
  assert.ok(record);
  assert.equal(`${record.ended.termination} ${record.ended.result} ${String(record.ended.winner)}`, 'no_show 0-1 b');
});

test('a Three-Check FEN that ends with its check counters still numbers from its fullmove', () => {
  const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 7 +0+0';
  const { pgn, text } = exportOf(play({ variant: 'threecheck', initialFen, moves: ['e2e4'] }));
  assert.equal(tagValue(pgn, 'FEN'), initialFen, 'the stored start is written as stored');
  assert.match(text, /\n7\. e4 1-0\n$/);
});

test('zero-move endings are finished games, not corrupt ones', () => {
  const resignedAtStart = exportOf(play({ moves: [], finish: resign('w') }));
  assert.deepEqual(resignedAtStart.pgn.moves, []);
  assert.equal(resignedAtStart.pgn.result, '0-1');
  assert.ok(resignedAtStart.text.endsWith('\n\n0-1\n'), 'the movetext is the result token alone');

  const aborted = exportOf(play({ moves: [], finish: (game, at) => game.abort(at) }));
  assert.deepEqual(aborted.pgn.moves, []);
  assert.equal(aborted.pgn.result, '*');
});

test('a seek no-show exports as a zero-move game with no result', () => {
  const created = Game.create({
    gameId: GAME_ID,
    players: { white: WHITE, black: BLACK },
    timeControl: BLITZ,
    at: CREATED_AT,
    source: 'seek',
    noShowAfterMs: 30_000,
  });
  const ended = created.game.expireNoShow(CREATED_AT + 30_000);
  const stream = [...created.events, ...ended.events].map((event, seq) => stored(seq, event));
  const record = readFinishedGame(GAME_ID, stream);
  assert.ok(record);
  const pgn = parsePgn(finishedGamePgn(record, NAMES))[0]!;
  assert.deepEqual(pgn.moves, []);
  assert.equal(pgn.result, '*');
  assert.equal(tagValue(pgn, 'Result'), '*');
});

test('a game that has not ended is not a finished game', () => {
  const played = play({ moves: ['e2e4', 'e7e5'], finish: null });
  assert.equal(readFinishedGame(GAME_ID, played.stream), null);
  const createdOnly = play({ moves: [], finish: null });
  assert.equal(readFinishedGame(GAME_ID, createdOnly.stream), null);
});

// --- Refusing corrupt history ---------------------------------------------------------------------

test('a stream that does not start with GameCreated is refused as corrupt', () => {
  const played = play({ moves: ['e2e4'] });
  const stream = played.stream.slice(1).map((entry, seq) => stored(seq, entry.event));
  assert.throws(() => readFinishedGame(GAME_ID, stream), CorruptGameStreamError);
});

test('a gap in the stream sequence is refused as corrupt', () => {
  const played = play({ moves: ['e2e4', 'e7e5'] });
  const gapped = played.stream.filter((entry) => entry.seq !== 1);
  assert.throws(() => readFinishedGame(GAME_ID, gapped), CorruptGameStreamError);
});

test('an event after GameEnded is refused as corrupt, never exported as a prefix', () => {
  const played = play({ moves: ['e2e4'] });
  const late = stored(played.stream.length, {
    type: 'MovePlayed', ply: 2, uci: 'e7e5', san: 'e5', by: 'b', moveTimeMs: 0, remaining: { w: 1, b: 1 }, at: CREATED_AT,
  });
  assert.throws(() => readFinishedGame(GAME_ID, [...played.stream, late]), CorruptGameStreamError);
});

test('a skipped ply, an illegal stored move, a foreign GameCreated and an unknown result are refused', () => {
  const played = play({ moves: ['e2e4', 'e7e5'] });
  const skippedPly = played.stream.map((entry) =>
    entry.event.type === 'MovePlayed' && entry.event.ply === 2 ? stored(entry.seq, { ...entry.event, ply: 3 }) : entry,
  );
  assert.throws(() => readFinishedGame(GAME_ID, skippedPly), CorruptGameStreamError);

  const illegal = played.stream.map((entry) =>
    entry.event.type === 'MovePlayed' && entry.event.ply === 2 ? stored(entry.seq, { ...entry.event, uci: 'e7e4' }) : entry,
  );
  assert.throws(() => readFinishedGame(GAME_ID, illegal), CorruptGameStreamError);

  const foreign = play({ moves: ['e2e4'], gameId: '00000000-0000-4000-8000-0000000000ff' });
  assert.throws(() => readFinishedGame(GAME_ID, foreign.stream), CorruptGameStreamError);

  const unknownResult = played.stream.map((entry) =>
    entry.event.type === 'GameEnded' ? stored(entry.seq, { ...entry.event, result: '2-0' as never }) : entry,
  );
  assert.throws(() => readFinishedGame(GAME_ID, unknownResult), CorruptGameStreamError);
});

test('a stored SAN that is not SAN-shaped is refused, so it cannot forge movetext or tags', () => {
  const played = play({ moves: ['e2e4', 'e7e5'] });
  for (const forged of ['e5 1-0 [Evil "x"]', 'e5\n[Result "0-1"]', '{e5}', '', 'e5)']) {
    const stream = played.stream.map((entry) =>
      entry.event.type === 'MovePlayed' && entry.event.ply === 2 ? stored(entry.seq, { ...entry.event, san: forged }) : entry,
    );
    assert.throws(() => readFinishedGame(GAME_ID, stream), CorruptGameStreamError, JSON.stringify(forged));
  }
});

// --- Tags -------------------------------------------------------------------------------------------

test('player display values are escaped by the serializer, never interpolated raw', () => {
  const hostile = { white: 'a"b\\c', black: 'x"]\n[Result "1-0"]\r\n' };
  const { pgn, text } = exportOf(play({ moves: ['e2e4'], finish: resign('w') }), hostile);
  assert.equal(tagValue(pgn, 'White'), 'a"b\\c');
  assert.equal(tagValue(pgn, 'Black'), 'x"] [Result "1-0"]  ');
  assert.equal(tagValue(pgn, 'Result'), '0-1', 'a hostile name cannot forge another tag');
  assert.equal(pgn.tags.filter((tag) => tag.key === 'Result').length, 1);
  assert.ok(text.includes('[White "a\\"b\\\\c"]'));
});

test('Unicode display values are written unchanged', () => {
  const { pgn } = exportOf(play({ moves: ['e2e4'] }), { white: 'Ünïcødé', black: 'لاعب' });
  assert.equal(tagValue(pgn, 'White'), 'Ünïcødé');
  assert.equal(tagValue(pgn, 'Black'), 'لاعب');
});

test('the date is the UTC calendar date of GameCreated', () => {
  assert.equal(pgnDate(CREATED_AT), '2023.11.14');
  assert.equal(pgnDate(Date.UTC(2026, 0, 2, 23, 59, 59)), '2026.01.02');
  assert.equal(pgnDate(Date.UTC(999, 5, 7)), '0999.06.07');
  assert.equal(pgnDate(Date.UTC(10_000, 0, 1)), '????.??.??');
  assert.equal(pgnDate(Number.NaN), '????.??.??');
});

test('no tag the durable log does not establish is invented', () => {
  const { pgn } = exportOf(play({ moves: ['e2e4'] }));
  const keys = pgn.tags.map((tag) => tag.key);
  for (const invented of ['WhiteElo', 'BlackElo', 'ECO', 'Opening', 'Termination', 'WhiteTitle', 'Annotator', 'PlyCount', 'Chess960StartId']) {
    assert.ok(!keys.includes(invented), `${invented} must not be exported`);
  }
  assert.deepEqual(keys, ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', 'TimeControl']);
});

// --- Time control -------------------------------------------------------------------------------

test('TimeControl is written only where PGN can say exactly what the clock did', () => {
  assert.equal(pgnTimeControl({ kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 }), '180+2');
  assert.equal(pgnTimeControl({ kind: 'increment', initialMs: 300_000, incrementMs: 0, delayMs: 0 }), '300+0');
  assert.equal(pgnTimeControl({ kind: 'sudden_death', initialMs: 600_000, incrementMs: 0, delayMs: 0 }), '600');
  // The clock ignores an increment on a sudden-death control, so the tag must too.
  assert.equal(pgnTimeControl({ kind: 'sudden_death', initialMs: 600_000, incrementMs: 5_000, delayMs: 0 }), '600');
  // PGN's own notation for "no time control" (PGN standard §9.6.1), not a Rookzen invention.
  assert.equal(pgnTimeControl({ kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 }), '-');
  // PGN has no delay notation, and writing it as increment would change its meaning.
  assert.equal(pgnTimeControl({ kind: 'delay', initialMs: 300_000, incrementMs: 0, delayMs: 5_000 }), undefined);
  // PGN counts whole seconds; a fraction cannot be written without rounding the control.
  assert.equal(pgnTimeControl({ kind: 'increment', initialMs: 180_500, incrementMs: 2_000, delayMs: 0 }), undefined);
  assert.equal(pgnTimeControl({ kind: 'increment', initialMs: 180_000, incrementMs: 500, delayMs: 0 }), undefined);
  assert.equal(pgnTimeControl({ kind: 'sudden_death', initialMs: 0, incrementMs: 0, delayMs: 0 }), undefined);
});

test('a delay game exports without a TimeControl tag, and an unlimited one with "-"', () => {
  const delay = exportOf(play({ moves: ['e2e4'], timeControl: { kind: 'delay', initialMs: 300_000, incrementMs: 0, delayMs: 5_000 } }));
  assert.equal(tagValue(delay.pgn, 'TimeControl'), undefined);
  const unlimited = exportOf(play({ moves: ['e2e4'], timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 } }));
  assert.equal(tagValue(unlimited.pgn, 'TimeControl'), '-');
  const blitz = exportOf(play({ moves: ['e2e4'] }));
  assert.equal(tagValue(blitz.pgn, 'TimeControl'), '180+2');
});

// --- Variants and starting positions ----------------------------------------------------------------

const VARIANT_GAMES: readonly { variant: Variant; moves: readonly string[]; fen: boolean }[] = [
  { variant: 'kingofthehill', moves: ['e2e4', 'e7e5', 'e1e2'], fen: false },
  { variant: 'atomic', moves: ['e2e4', 'd7d5', 'e4d5'], fen: false },
  { variant: 'crazyhouse', moves: ['e2e4', 'd7d5', 'e4d5', 'd8d5', 'P@e4'], fen: true },
  { variant: 'threecheck', moves: ['e2e4', 'f7f6', 'd1h5'], fen: true },
  { variant: 'horde', moves: ['a4a5', 'e7e5'], fen: true },
  { variant: 'racingkings', moves: ['h2h3', 'a2a3'], fen: true },
];

for (const { variant, moves, fen } of VARIANT_GAMES) {
  test(`a ${variant} game stays identifiable and replays from the export alone`, () => {
    const played = play({ variant, moves });
    const { pgn } = exportOf(played);
    assert.equal(tagValue(pgn, 'Variant'), variant);
    assert.deepEqual(pgn.moves.map((move) => move.san), played.sans);
    const created = played.stream[0]!.event;
    assert.ok(created.type === 'GameCreated');
    if (fen) {
      assert.equal(tagValue(pgn, 'SetUp'), '1');
      assert.equal(tagValue(pgn, 'FEN'), created.initialFen);
    } else {
      assert.equal(tagValue(pgn, 'FEN'), undefined);
      assert.equal(tagValue(pgn, 'SetUp'), undefined);
    }
    assert.equal(replayExport(pgn), finalFen(played));
  });
}

test('the crazyhouse drop is exported as stored drop SAN', () => {
  const { pgn } = exportOf(play({ variant: 'crazyhouse', moves: ['e2e4', 'd7d5', 'e4d5', 'd8d5', 'P@e4'] }));
  assert.equal(pgn.moves.at(-1)?.san, 'P@e4');
});

test('Chess960 always carries its Variant, SetUp and exact starting FEN, never normalized away', () => {
  for (const startId of [0, 518, 959]) {
    const played = play({ variant: 'chess960', chess960StartId: startId, moves: ['e2e4', 'e7e5'] });
    const created = played.stream[0]!.event;
    assert.ok(created.type === 'GameCreated');
    const { pgn } = exportOf(played);
    assert.equal(tagValue(pgn, 'Variant'), 'chess960');
    assert.equal(tagValue(pgn, 'SetUp'), '1');
    assert.equal(tagValue(pgn, 'FEN'), created.initialFen, `start ${startId} keeps its own FEN`);
    assert.equal(replayExport(pgn), finalFen(played));
    assert.equal(tagValue(pgn, 'Chess960StartId'), undefined, 'the FEN pins the start; no invented id tag');
  }
});

test('position 518 is exported as Chess960 even though its FEN is the standard one', () => {
  const { pgn } = exportOf(play({ variant: 'chess960', chess960StartId: 518, moves: ['e2e4'] }));
  assert.equal(tagValue(pgn, 'FEN'), STANDARD_FEN);
  assert.equal(tagValue(pgn, 'Variant'), 'chess960');
});

test('a historical Chess960 game without a start id exports truthfully from its initialFen', () => {
  const played = play({ variant: 'chess960', chess960StartId: 0, moves: ['e2e4'] });
  const created = played.stream[0]!.event;
  assert.ok(created.type === 'GameCreated');
  const { chess960StartId: _omitted, ...historical } = created;
  const stream = [stored(0, historical), ...played.stream.slice(1)];
  const record = readFinishedGame(GAME_ID, stream);
  assert.ok(record);
  const pgn = parsePgn(finishedGamePgn(record, NAMES))[0]!;
  assert.equal(tagValue(pgn, 'FEN'), created.initialFen);
  assert.equal(tagValue(pgn, 'Variant'), 'chess960');
});

test('a custom starting FEN with Black to move is replayable and numbered from Black', () => {
  const initialFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 7';
  const played = play({ initialFen, moves: ['e7e5', 'g1f3'] });
  const { pgn, text } = exportOf(played);
  assert.equal(tagValue(pgn, 'SetUp'), '1');
  assert.equal(tagValue(pgn, 'FEN'), initialFen);
  assert.match(text, /\n7\.\.\. e5 8\. Nf3 1-0\n$/);
  assert.equal(replayExport(pgn), finalFen(played));
});

// --- The service ------------------------------------------------------------------------------------

test('the service exports from one stream read and one batched identity read', async () => {
  const played = play({ moves: ['e2e4', 'e7e5', 'g1f3'] });
  const store = await storeOf(played);
  let loads = 0;
  const counting = { load: (id: string) => { loads += 1; return store.load(id); } };
  const handles = new RecordingHandles(new Map([[WHITE, 'alice'], [BLACK, 'bob']]));

  const text = await new FinishedGamePgnService(counting, handles).export(GAME_ID, new AbortController().signal);

  assert.equal(loads, 1);
  assert.deepEqual(handles.calls, [[WHITE, BLACK]]);
  const pgn = parsePgn(text)[0]!;
  assert.equal(tagValue(pgn, 'White'), 'alice');
  assert.equal(tagValue(pgn, 'Black'), 'bob');
});

test('the service names engine bots by their catalogue handle and unknown seats "?"', async () => {
  const bot = BOT_ACCOUNTS[0]!;
  const played = play({ moves: ['e2e4'], players: { white: bot.userId, black: 'not-a-user' } });
  const service = new FinishedGamePgnService(await storeOf(played), new RecordingHandles(new Map()));
  const pgn = parsePgn(await service.export(GAME_ID, new AbortController().signal))[0]!;
  assert.equal(tagValue(pgn, 'White'), bot.handle);
  assert.equal(tagValue(pgn, 'Black'), '?', 'an unresolvable seat is the PGN unknown, not its internal id');
});

test('a stored handle wins over the catalogue for a bot seat', async () => {
  const bot = BOT_ACCOUNTS[1]!;
  const played = play({ moves: ['e2e4'], players: { white: WHITE, black: bot.userId } });
  const handles = new RecordingHandles(new Map([[WHITE, 'alice'], [bot.userId, bot.handle]]));
  const pgn = parsePgn(await new FinishedGamePgnService(await storeOf(played), handles).export(GAME_ID, new AbortController().signal))[0]!;
  assert.equal(tagValue(pgn, 'Black'), bot.handle);
});

test('the service answers 404 for an unknown game and 409 for a live one without reading identities', async () => {
  const handles = new RecordingHandles(new Map());
  const empty = new FinishedGamePgnService(new InMemoryEventStore(), handles);
  await assert.rejects(empty.export(GAME_ID, new AbortController().signal), (err: unknown) =>
    err instanceof HttpError && err.status === 404);

  const live = new FinishedGamePgnService(await storeOf(play({ moves: ['e2e4'], finish: null })), handles);
  await assert.rejects(live.export(GAME_ID, new AbortController().signal), (err: unknown) =>
    err instanceof HttpError && err.status === 409);
  assert.deepEqual(handles.calls, []);
});

test('the service stops before any read once the request is cancelled', async () => {
  let loads = 0;
  const service = new FinishedGamePgnService(
    { load: async () => { loads += 1; return []; } },
    new RecordingHandles(new Map()),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.export(GAME_ID, controller.signal), (err: unknown) => err instanceof HttpError && err.status === 503);
  assert.equal(loads, 0);
});

// --- HTTP -------------------------------------------------------------------------------------------

async function finishedHarnessGame(h: Awaited<ReturnType<typeof startHarness>>, handles: [string, string]) {
  const white = await h.makeUser(handles[0]);
  const black = await h.makeUser(handles[1]);
  const played = play({ moves: ['e2e4', 'e7e5'], players: { white: white.userId, black: black.userId } });
  await h.repos.events.append(GAME_ID, -1, played.stream.map((entry) => entry.event));
  return played;
}

test('GET /v1/games/:id/export.pgn serves the exact PGN as a public attachment', async () => {
  const h = await startHarness();
  try {
    const played = await finishedHarnessGame(h, ['alice-pgn', 'bob-pgn']);
    const res = await fetch(`${h.baseUrl}/v1/games/${GAME_ID}/export.pgn`);
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/x-chess-pgn; charset=utf-8');
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="game-${GAME_ID}.pgn"`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const record = readFinishedGame(GAME_ID, played.stream);
    assert.ok(record);
    assert.equal(body, finishedGamePgn(record, { white: 'alice-pgn', black: 'bob-pgn' }));
    assert.ok(!body.includes('<'), 'a PGN document, not HTML');
  } finally {
    await h.close();
  }
});

test('GET /v1/games/:id/export.pgn validates the id and reports missing and live games', async () => {
  const h = await startHarness();
  try {
    for (const bad of ['not-a-uuid', '00000000-0000-4000-8000-0000000000a1%0D%0AX-Evil:%201', 'ZZZZZZZZ-0000-4000-8000-000000000000']) {
      const res = await h.json('GET', `/v1/games/${bad}/export.pgn`);
      assert.equal(res.status, 422, bad);
      assert.equal(res.headers.get('content-disposition'), null);
    }
    const missing = await h.json('GET', `/v1/games/${GAME_ID}/export.pgn`);
    assert.equal(missing.status, 404);

    const live = play({ moves: ['e2e4'], finish: null });
    await h.repos.events.append(GAME_ID, -1, live.stream.map((entry) => entry.event));
    const ongoing = await h.json('GET', `/v1/games/${GAME_ID}/export.pgn`);
    assert.equal(ongoing.status, 409);
    assert.equal(ongoing.body.error.code, 'conflict');
  } finally {
    await h.close();
  }
});

test('GET /v1/games/:id/export.pgn takes its result from GameEnded even when the projection disagrees', async () => {
  const h = await startHarness();
  try {
    const white = await h.makeUser('erin-pgn');
    const black = await h.makeUser('frank-pgn');
    const played = play({ moves: ['e2e4'], finish: resign('w'), players: { white: white.userId, black: black.userId } });
    await h.repos.events.append(GAME_ID, -1, played.stream.map((entry) => entry.event));
    await h.repos.games.start({
      id: GAME_ID, variant: 'standard', rated: false, speed: 'blitz',
      whiteId: white.userId, blackId: black.userId, startedAt: new Date(CREATED_AT),
    });
    await h.repos.games.finish(GAME_ID, {
      result: '1-0', termination: 'checkmate', plyCount: 40, lastSeq: 99, endedAt: new Date(CREATED_AT),
    });

    const res = await fetch(`${h.baseUrl}/v1/games/${GAME_ID}/export.pgn`);
    const pgn = parsePgn(await res.text())[0]!;

    assert.equal(res.status, 200);
    assert.equal(pgn.result, '0-1', 'the event log, not the projection, decides the result');
    assert.equal(tagValue(pgn, 'Result'), '0-1');
    assert.deepEqual(pgn.moves.map((move) => move.san), ['e4']);
  } finally {
    await h.close();
  }
});
