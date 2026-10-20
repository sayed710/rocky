/**
 * Stored-history replay (#127 Design B): a durable atomic game whose last move only the pre-#127 rules
 * allowed still replays, with its stored result, while every live and generic path stays strict.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IllegalMoveError, Position } from '@chess-platform/core';
import { charge, type TimeControl } from '../src/clock';
import type { GameEvent, MovePlayedEvent } from '../src/events';
import { Game, GameError } from '../src/game';
import { replayStoredHistory, StoredHistoryError, type StoredHistoryRow, type StoredPly } from '../src/stored-history';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' };
const LINE = 'e2e3 e7e6 e1e2 e8e7 e2d3 e7d6 d3d4 e6e5';

/** Play `ucis` with the current (strict) rules, one second apart. */
function played(variant: 'atomic' | 'standard', ucis: string, initialFen?: string) {
  let { game, events } = Game.create({
    gameId: 'legacy',
    variant,
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
    at: 0,
    ...(initialFen === undefined ? {} : { initialFen }),
  });
  const log: GameEvent[] = [...events];
  let at = 0;
  for (const uci of ucis === '' ? [] : ucis.split(' ')) {
    const r = game.playMove(uci, (at += 1_000));
    game = r.game;
    log.push(...r.events);
  }
  return { game, log, at };
}

/** Append the pair the pre-#127 authority wrote for a kingless capture, exactly as `playMove` shaped it. */
function withPre127Move(base: ReturnType<typeof played>, uci: string, san: string): GameEvent[] {
  const s = base.game.snapshot();
  const at = base.at + 1_000;
  const charged = charge(s.clock, s.position.turn, at, s.timeControl);
  const move: MovePlayedEvent = {
    type: 'MovePlayed', ply: s.ply + 1, uci, san, by: s.position.turn,
    moveTimeMs: charged.moveTimeMs, remaining: charged.clock.remaining, at,
  };
  return [...base.log, move, { type: 'GameEnded', result: '0-1', termination: 'variant', winner: 'b', at }];
}

const rowsOf = (events: readonly GameEvent[], gameId = 'legacy'): StoredHistoryRow[] =>
  events.map((event, seq) => ({ gameId, seq, version: 1, event }));

const kingCapture = () => withPre127Move(played('atomic', LINE), 'd4e5', 'Kxe5');
// A knight capture whose blast takes both kings (Nf4xd5 next to kings on d4 and d6).
const BOTH_KINGS_FEN = '8/8/3k4/3n4/3K1N2/8/8/8 w - - 0 1';
const knightBlast = () => withPre127Move(played('atomic', '', BOTH_KINGS_FEN), 'f4d5', 'Nxd5');

test('a stored pre-#127 king capture replays with its stored result, clocks and repetition', () => {
  const events = kingCapture();
  const plies: StoredPly[] = [];
  const { game, historicalPly } = replayStoredHistory('legacy', rowsOf(events), (p) => plies.push(p));
  assert.equal(historicalPly, 9);
  assert.deepEqual(game.status, { over: true, result: '0-1', termination: 'variant', winner: 'b' });
  const s = game.snapshot();
  const last = events[events.length - 2] as MovePlayedEvent;
  assert.deepEqual(s.clock.remaining, last.remaining, 'the stored clock is folded, not recomputed differently');
  assert.equal(s.ply, 9);
  assert.deepEqual(s.moves, events.filter((e) => e.type === 'MovePlayed'));
  assert.equal(s.repetition.get([...s.repetition.keys()].at(-1)!), 1);
  assert.equal(s.position.fen().split(' ')[0]!.match(/[Kk]/g), null, 'the stored move left no king');
  assert.deepEqual(plies.map((p) => p.historical), [false, false, false, false, false, false, false, false, true]);
  assert.equal(plies[8]!.before.fen(), played('atomic', LINE).game.fen);
  assert.throws(() => game.playMove('a2a3', 99_000), GameError, 'a replayed legacy game refuses every command');
});

test('a stored pre-#127 non-king capture that exploded both kings replays too', () => {
  const { game, historicalPly } = replayStoredHistory('legacy', rowsOf(knightBlast()));
  assert.equal(historicalPly, 1);
  assert.deepEqual(game.status, { over: true, result: '0-1', termination: 'variant', winner: 'b' });
});

test('every legal stored history replays exactly as Game.fromEvents does', () => {
  for (const { log } of [played('atomic', LINE), played('standard', 'e2e4 e7e5 g1f3 b8c6 f1b5'), played('atomic', 'e2e3 e7e6 d1h5 a7a6 h5f7')]) {
    const { game, historicalPly } = replayStoredHistory('legacy', rowsOf(log));
    assert.equal(historicalPly, null);
    assert.deepEqual(game.snapshot(), Game.fromEvents(log).snapshot());
  }
});

test('live and generic paths never admit the pre-#127 move', () => {
  const events = kingCapture();
  assert.throws(() => Game.fromEvents(events), IllegalMoveError);
  const base = played('atomic', LINE);
  assert.throws(() => base.game.withEvents(events.slice(-2)), IllegalMoveError);
  assert.throws(() => base.game.playMove('d4e5', 9_000), GameError);
  assert.throws(() => Position.fromFen(base.game.fen, 'atomic').play('d4e5'), IllegalMoveError);
  assert.ok(!Position.fromFen(base.game.fen, 'atomic').legalMoves().some((m) => m.from === 0x33 && m.to === 0x44));
});

/** Each forgery must be refused; `replaced` swaps the event at `at` (negative counts from the end). */
function refuses(name: string, events: readonly GameEvent[] | StoredHistoryRow[], error: new (...a: never[]) => Error = Error) {
  const rows = (events as unknown[]).length > 0 && 'seq' in (events as object[])[0]! ? (events as StoredHistoryRow[]) : rowsOf(events as GameEvent[]);
  assert.throws(() => replayStoredHistory('legacy', rows), error, name);
}

function patchedAt(events: readonly GameEvent[], index: number, patch: object): GameEvent[] {
  const copy = [...events];
  const i = index < 0 ? copy.length + index : index;
  copy[i] = { ...copy[i]!, ...patch } as GameEvent;
  return copy;
}

test('the exception requires the exact pre-#127 signature', () => {
  const events = kingCapture();
  refuses('truncated before GameEnded', events.slice(0, -1), IllegalMoveError);
  refuses('result 1-0', patchedAt(events, -1, { result: '1-0', winner: 'w' }), IllegalMoveError);
  refuses('a drawn result naming black', patchedAt(events, -1, { result: '1/2-1/2' }), IllegalMoveError);
  refuses('termination timeout', patchedAt(events, -1, { termination: 'timeout' }), IllegalMoveError);
  refuses('winner white', patchedAt(events, -1, { winner: 'w' }), IllegalMoveError);
  refuses('ending at another instant', patchedAt(events, -1, { at: 99_999 }), IllegalMoveError);
  refuses('ending a resignation', patchedAt(events, -1, { termination: 'resignation' }), IllegalMoveError);
  refuses('stored SAN names another piece', patchedAt(events, -2, { san: 'Qxe5' }), IllegalMoveError);
  refuses('stored SAN names another square', patchedAt(events, -2, { san: 'Kxd5' }), IllegalMoveError);
  refuses('stored SAN without the capture', patchedAt(events, -2, { san: 'Ke5' }), IllegalMoveError);
  refuses('stored SAN with a foreign disambiguation', patchedAt(events, -2, { san: 'Kcxe5' }), IllegalMoveError);
  refuses('a non-pseudo-legal move', patchedAt(events, -2, { uci: 'd4f6', san: 'Kxf6' }), IllegalMoveError);
  refuses('moved before the previous move', patchedAt(patchedAt(events, -2, { at: 500 }), -1, { at: 500 }), IllegalMoveError);
  refuses('the same stream in standard', withPre127Move(played('standard', LINE), 'd4e5', 'Kxe5'), IllegalMoveError);
  // A king capture far from the enemy king explodes only the mover's king: a king remains.
  refuses('a move that leaves a king', withPre127Move(played('atomic', '', '8/8/8/8/8/3p4/3K4/7k w - - 0 1'), 'd2d3', 'Kxd3'), IllegalMoveError);
  const legacyMoveThenMore = [...events.slice(0, -1), { ...events.at(-2)!, ply: 10, at: 11_000 } as GameEvent, events.at(-1)!];
  refuses('another move after the legacy move', legacyMoveThenMore, IllegalMoveError);
  const v2 = rowsOf(events).map((row, i, all) => (i >= all.length - 2 ? { ...row, version: 2 } : row));
  refuses('rows stored under another event version', v2, IllegalMoveError);
});

test('malformed stored histories are refused before replay', () => {
  const events = kingCapture();
  const rows = rowsOf(events);
  refuses('empty', [] as StoredHistoryRow[], StoredHistoryError);
  refuses('rows of another game', rowsOf(events, 'other'), StoredHistoryError);
  refuses('one foreign row', rows.map((r, i) => (i === 3 ? { ...r, gameId: 'other' } : r)), StoredHistoryError);
  refuses('GameCreated for another game', patchedAt(events, 0, { gameId: 'other' }), StoredHistoryError);
  refuses('seq starting at 1', rows.map((r) => ({ ...r, seq: r.seq + 1 })), StoredHistoryError);
  refuses('seq gap', rows.map((r, i) => (i >= 4 ? { ...r, seq: r.seq + 1 } : r)), StoredHistoryError);
  refuses('duplicate seq', rows.map((r, i) => (i === 4 ? { ...r, seq: 3 } : r)), StoredHistoryError);
  refuses('a second GameCreated', [...events.slice(0, 3), events[0]!, ...events.slice(3)], StoredHistoryError);
  refuses('no GameCreated first', events.slice(1), StoredHistoryError);
  refuses('an event after GameEnded', [...events, { type: 'DrawOffered', by: 'w', at: 12_000 }], StoredHistoryError);
  refuses('a second GameEnded', [...events, events.at(-1)!], StoredHistoryError);
  refuses('a skipped ply', patchedAt(events, -2, { ply: 10 }), StoredHistoryError);
  refuses('a move by the wrong side', patchedAt(events, -2, { by: 'b' }), StoredHistoryError);
  refuses('a normal move by the wrong side', patchedAt(played('atomic', LINE).log, 1, { by: 'b' }), StoredHistoryError);
});

/** A seeded random legal game, long enough to measure scaling on its prefixes. */
function longGame(minPlies: number) {
  for (let seed = 1; ; seed++) {
    let a = seed;
    const rand = () => ((a = (Math.imul(a, 1103515245) + 12345) >>> 0) / 2 ** 32);
    let { game, events } = Game.create({ gameId: 'legacy', timeControl: { ...TC, kind: 'unlimited', initialMs: 0, incrementMs: 0 }, players: { white: 'a', black: 'b' }, at: 0 });
    const log: GameEvent[] = [...events];
    for (let at = 1; !game.status.over; at++) {
      const moves = game.snapshot().position.legalMoves();
      const pos = game.snapshot().position;
      const r = game.playMove(pos.toUci(moves[Math.floor(rand() * moves.length)]!), at);
      game = r.game;
      log.push(...r.events);
    }
    if (log.filter((e) => e.type === 'MovePlayed').length >= minPlies) return log;
  }
}

test('replay work is linear in the history and matches Game.fromEvents (deterministic counters)', () => {
  const log = longGame(240);
  const original = Position.prototype.legalMoves;
  let generations = 0;
  Position.prototype.legalMoves = function (this: Position) {
    generations++;
    return original.call(this);
  };
  try {
    const count = (events: readonly GameEvent[], replay: (e: readonly GameEvent[]) => unknown) => {
      generations = 0;
      replay(events);
      return generations;
    };
    const stored = (e: readonly GameEvent[]) => replayStoredHistory('legacy', rowsOf(e));
    const prefix = (plies: number) => log.slice(0, plies + 1);
    for (const plies of [60, 120, 240]) {
      assert.equal(count(prefix(plies), stored), count(prefix(plies), Game.fromEvents), `${plies} plies: same work as fromEvents`);
      assert.equal(count(prefix(plies), stored), plies, `${plies} plies: one legal-move generation per stored move`);
    }
    // The exception costs no extra legal-move generation: it reads pseudo-legal moves once.
    const legacy = kingCapture();
    assert.equal(count(legacy, stored), count(legacy.slice(0, -2), Game.fromEvents) + 1);
  } finally {
    Position.prototype.legalMoves = original;
  }
  let calls = 0;
  const { game } = replayStoredHistory('legacy', rowsOf(log), () => calls++);
  assert.equal(calls, game.snapshot().ply, 'onPly once per move');
  assert.deepEqual(Object.keys(replayStoredHistory('legacy', rowsOf(log))).sort(), ['game', 'historicalPly'], 'no per-ply payload is retained');
});

test('benchmark (informational): stored replay against Game.fromEvents on a long game', () => {
  const log = longGame(240);
  const rows = rowsOf(log);
  const median = (f: () => void) => {
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      f();
      times.push(performance.now() - t);
    }
    return times.sort((x, y) => x - y)[3]!;
  };
  const strict = median(() => Game.fromEvents(log));
  const stored = median(() => replayStoredHistory('legacy', rows));
  console.log(`[bench] ${log.length} events: fromEvents ${strict.toFixed(1)} ms, replayStoredHistory ${stored.toFixed(1)} ms`);
  // Generous ceiling: the gate is the deterministic counter test above; this only catches a gross regression.
  assert.ok(stored < strict * 3 + 50, `stored replay ${stored} ms vs ${strict} ms`);
});
