/** Durable readiness, first-move clock start and the pregame no-show rule (ADR-0148). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, GameError, NOT_READY_MESSAGE } from '../src/game';
import type { GameEvent, GameSource } from '../src/events';
import type { TimeControl } from '../src/clock';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };
const CREATED_AT = 1_000_000;
const DEADLINE: Record<GameSource, number> = { seek: 60_000, tournament: 300_000 };

function create(source?: GameSource, timeControl: TimeControl = TC) {
  return Game.create({
    gameId: 'g1',
    timeControl,
    players: { white: 'alice', black: 'bob' },
    rated: true,
    at: CREATED_AT,
    ...(source !== undefined ? { source, noShowAfterMs: DEADLINE[source] } : {}),
  });
}

/** A sourced game with both seats ready, and every event so far. */
function bothReady(source: GameSource, at = CREATED_AT + 5_000) {
  const created = create(source);
  const white = created.game.markReady('w', at);
  const black = white.game.markReady('b', at + 1);
  return { game: black.game, events: [...created.events, ...white.events, ...black.events] };
}

test('the source is recorded on GameCreated only when given, and unknown sources are refused', () => {
  const seek = create('seek').events[0]!;
  assert.ok(seek.type === 'GameCreated' && seek.source === 'seek');
  const legacy = create().events[0]!;
  assert.ok(legacy.type === 'GameCreated' && !('source' in legacy), 'a bot/direct game stores no source');
  assert.throws(() => Game.create({
    gameId: 'g', timeControl: TC, players: { white: 'a', black: 'b' }, at: 0, source: 'lobby' as GameSource, noShowAfterMs: 1,
  }), GameError);
  for (const noShowAfterMs of [undefined, 0, -1, 1.5]) {
    assert.throws(() => Game.create({
      gameId: 'g', timeControl: TC, players: { white: 'a', black: 'b' }, at: 0, source: 'seek', ...(noShowAfterMs === undefined ? {} : { noShowAfterMs }),
    }), /no-show deadline/, 'a sourced game must carry a usable deadline');
  }
  assert.throws(() => Game.create({ gameId: 'g', timeControl: TC, players: { white: 'a', black: 'b' }, at: 0, noShowAfterMs: 1 }), /unknown game source/);
  assert.equal(seek.noShowAfterMs, 60_000, 'the deadline is recorded on the event');
  const forged = { ...seek, source: 'lobby' } as unknown as GameEvent;
  assert.throws(() => Game.fromEvents([forged]), /unknown game source/);
});

test('a sourced game anchors no clock at creation; a game without a source keeps the creation anchor', () => {
  assert.equal(create('seek').game.snapshot().clock.turnStartedAt, null);
  assert.equal(create('tournament').game.snapshot().clock.turnStartedAt, null);
  assert.equal(create().game.snapshot().clock.turnStartedAt, CREATED_AT);
});

test('the first move is refused until both seats are durably ready, and is not charged for the wait', () => {
  const { game } = create('seek');
  assert.equal(game.awaitingReadiness, true);
  assert.throws(() => game.playMove('e2e4', CREATED_AT + 1), new RegExp(NOT_READY_MESSAGE));
  const whiteOnly = game.markReady('w', CREATED_AT + 2).game;
  assert.equal(whiteOnly.awaitingReadiness, true);
  assert.throws(() => whiteOnly.playMove('e2e4', CREATED_AT + 3), new RegExp(NOT_READY_MESSAGE));

  // Both ready, then 30 seconds of waiting before White's first move.
  const ready = whiteOnly.markReady('b', CREATED_AT + 4).game;
  assert.equal(ready.awaitingReadiness, false);
  assert.deepEqual(ready.snapshot().clock.remaining, { w: 300_000, b: 300_000 }, 'full base clocks while waiting');
  const firstMoveAt = CREATED_AT + 4 + 30_000;
  const moved = ready.playMove('e2e4', firstMoveAt);
  const move = moved.events[0]!;
  assert.ok(move.type === 'MovePlayed');
  assert.equal(move.moveTimeMs, 0, 'the first move consumes no chess time');
  assert.deepEqual(move.remaining, { w: 300_000 + 3_000, b: 300_000 }, 'only the increment is applied');
  assert.equal(moved.game.snapshot().clock.turnStartedAt, firstMoveAt, "Black's clock starts at White's move");

  // Black is charged from White's move, not from creation or readiness.
  const reply = moved.game.playMove('e7e5', firstMoveAt + 7_000).events[0]!;
  assert.ok(reply.type === 'MovePlayed');
  assert.equal(reply.moveTimeMs, 7_000);
  assert.equal(reply.remaining.b, 300_000 - 7_000 + 3_000);
});

test('a game without a source still charges its first move from creation (unchanged lifecycle)', () => {
  const move = create().game.playMove('e2e4', CREATED_AT + 10_000).events[0]!;
  assert.ok(move.type === 'MovePlayed');
  assert.equal(move.moveTimeMs, 10_000);
  assert.equal(create().game.markReady('w', CREATED_AT).events.length, 0, 'readiness is not recorded for it');
});

test('no flag can be claimed before the first move of a sourced game, however long the wait', () => {
  const { game } = bothReady('tournament');
  assert.throws(() => game.claimFlag(CREATED_AT + 10 * 3_600_000), /not flagged/);
});

test('readiness is idempotent and is not recorded after the first move or the end', () => {
  const created = create('seek');
  const first = created.game.markReady('w', CREATED_AT + 1);
  assert.equal(first.events.length, 1);
  assert.equal(first.game.markReady('w', CREATED_AT + 2).events.length, 0, 'a duplicate join is a no-op');
  const { game } = bothReady('seek');
  const moved = game.playMove('e2e4', CREATED_AT + 10_000).game;
  assert.equal(moved.markReady('w', CREATED_AT + 10_001).events.length, 0);
  const ended = create('seek').game.resign('w', CREATED_AT + 1).game;
  assert.equal(ended.markReady('b', CREATED_AT + 2).events.length, 0);
});

test('replay reconstructs readiness and the clock exactly, without reading the wall clock', () => {
  const { game, events } = bothReady('seek');
  const moved = game.playMove('e2e4', CREATED_AT + 40_000);
  const all = [...events, ...moved.events];
  const replayed = Game.fromEvents(all).snapshot();
  assert.deepEqual(replayed.ready, { w: true, b: true });
  assert.deepEqual(replayed.clock, moved.game.snapshot().clock);
  assert.equal(replayed.source, 'seek');
  assert.throws(() => Game.fromEvents([...events, { type: 'PlayerReady', by: 'x', at: 1 } as unknown as GameEvent]), /unknown seat/);
});

test('an event stream stored before this change replays exactly, including a first move charged from creation', () => {
  // A pre-ADR-0148 stream: no source, the first move charged 12 s from creation.
  const created = create().events;
  const legacyMove: GameEvent = {
    type: 'MovePlayed', ply: 1, uci: 'e2e4', san: 'e4', by: 'w', moveTimeMs: 12_000,
    remaining: { w: 300_000 - 12_000 + 3_000, b: 300_000 }, at: CREATED_AT + 12_000,
  };
  const snap = Game.fromEvents([...created, legacyMove]).snapshot();
  assert.equal(snap.source, null);
  assert.deepEqual(snap.clock.remaining, { w: 291_000, b: 300_000 });
  assert.equal(snap.clock.turnStartedAt, CREATED_AT + 12_000);
});

test('unlimited sourced games keep an unlimited clock with no anchor', () => {
  const unlimited: TimeControl = { initialMs: 0, incrementMs: 0, delayMs: 0, kind: 'unlimited' };
  const created = create('seek', unlimited);
  const ready = created.game.markReady('w', CREATED_AT).game.markReady('b', CREATED_AT).game;
  const moved = ready.playMove('e2e4', CREATED_AT + 50_000).game.snapshot();
  assert.equal(moved.clock.turnStartedAt, null);
  assert.deepEqual(moved.clock.remaining, { w: 0, b: 0 });
});

test('seek no-show: aborted with no result at the deadline whoever was ready, never before it', () => {
  for (const ready of [[], ['w'], ['b'], ['w', 'b']] as const) {
    let game = create('seek').game;
    for (const color of ready) game = game.markReady(color, CREATED_AT + 1).game;
    assert.deepEqual(game.noShowVerdict(CREATED_AT + 59_999), { kind: 'not_due' });
    const verdict = game.noShowVerdict(CREATED_AT + 60_000);
    assert.equal(verdict.kind, 'expire', `ready: ${ready.join(',') || 'none'}`);
    const ended = game.expireNoShow(CREATED_AT + 60_000);
    assert.deepEqual(ended.events, [
      { type: 'GameEnded', result: '*', termination: 'no_show', winner: null, at: CREATED_AT + 60_000 },
    ]);
  }
});

test('tournament no-show: one ready player wins, neither ready is a double forfeit, both ready waits', () => {
  const at = CREATED_AT + 300_000;
  const whiteReady = create('tournament').game.markReady('w', CREATED_AT + 1).game;
  assert.deepEqual(whiteReady.expireNoShow(at).events[0], {
    type: 'GameEnded', result: '1-0', termination: 'no_show', winner: 'w', at,
  });
  const blackReady = create('tournament').game.markReady('b', CREATED_AT + 1).game;
  assert.deepEqual(blackReady.expireNoShow(at).events[0], {
    type: 'GameEnded', result: '0-1', termination: 'no_show', winner: 'b', at,
  });
  assert.deepEqual(create('tournament').game.expireNoShow(at).events[0], {
    type: 'GameEnded', result: '*', termination: 'no_show', winner: null, at,
  });
  const { game } = bothReady('tournament');
  assert.deepEqual(game.noShowVerdict(at + 86_400_000), { kind: 'both_ready' });
  assert.throws(() => game.expireNoShow(at), /both_ready/);
});

test('no-show never applies after the first move, to a finished game, or to a game without a source', () => {
  const { game } = bothReady('seek');
  const moved = game.playMove('e2e4', CREATED_AT + 10_000).game;
  assert.deepEqual(moved.noShowVerdict(CREATED_AT + 3_600_000), { kind: 'not_applicable' });
  assert.throws(() => moved.expireNoShow(CREATED_AT + 3_600_000), /not_applicable/);
  assert.deepEqual(create().game.noShowVerdict(CREATED_AT + 3_600_000), { kind: 'not_applicable' });
  const expired = create('seek').game.expireNoShow(CREATED_AT + 60_000).game;
  assert.throws(() => expired.expireNoShow(CREATED_AT + 60_001), /already over/);
  assert.throws(() => expired.playMove('e2e4', CREATED_AT + 60_001), /already over/);
});

test('readiness recorded after the deadline does not count, so a due forfeit is never erased', () => {
  const late = CREATED_AT + 300_000;
  const created = create('tournament').game.markReady('w', CREATED_AT + 1).game;
  const bothLate = created.markReady('b', late);
  assert.equal(bothLate.events.length, 0, 'a join at or after the deadline records nothing');
  assert.deepEqual(bothLate.game.noShowVerdict(late).kind, 'expire');
  assert.deepEqual(bothLate.game.expireNoShow(late).events[0], {
    type: 'GameEnded', result: '1-0', termination: 'no_show', winner: 'w', at: late,
  });
});

test('a first move after a due deadline records the no-show instead, however late the worker is', () => {
  const { game } = bothReady('seek');
  const moved = game.playMove('e2e4', CREATED_AT + 60_000);
  assert.deepEqual(moved.events, [
    { type: 'GameEnded', result: '*', termination: 'no_show', winner: null, at: CREATED_AT + 60_000 },
  ]);
  // A tournament game both players readied in time is not due, so its late first move plays.
  const t = bothReady('tournament').game.playMove('e2e4', CREATED_AT + 3_600_000);
  assert.equal(t.events[0]!.type, 'MovePlayed');
});
