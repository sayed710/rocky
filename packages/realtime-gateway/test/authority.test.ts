import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimeControl } from '@chess-platform/game';
import { GameAuthority, AuthorityError } from '../src/authority';
import { InMemoryPubSub, gameChannel, gamesEndedChannel } from '../src/pubsub';
import { InMemoryEventLog } from '../src/event-log';
import type { Broadcast } from '../src/protocol';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };

test('a stale owner reloads a committed ending after its append loses the sequence race', async () => {
  const store = new InMemoryEventLog();
  const owner = new GameAuthority(new InMemoryPubSub(), () => 1_000, store);
  const stalePubsub = new InMemoryPubSub();
  const stale = new GameAuthority(stalePubsub, () => 1_000, store);
  await owner.createGame({ gameId: 'race', timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: true });
  assert.equal(await stale.ensureLoaded('race'), true);
  const staleBroadcasts: Broadcast[] = [];
  stalePubsub.subscribe(gameChannel('race'), (message) => staleBroadcasts.push(message));

  await owner.apply('race', 'bob', { kind: 'resign' });
  await assert.rejects(stale.apply('race', 'alice', { kind: 'move', uci: 'e2e4' }), AuthorityError);

  const status = stale.getState('race').status;
  assert.equal(status.over, true);
  if (!status.over) throw new Error('the committed resignation was not reloaded');
  assert.equal(status.result, '1-0');
  assert.deepEqual(staleBroadcasts, [], 'the losing writer must not publish an uncommitted move');
  await assert.rejects(stale.apply('race', 'alice', { kind: 'move', uci: 'e2e4' }), AuthorityError);
});

async function setup() {
  let clock = 1_000;
  const now = () => clock;
  const advance = (ms: number) => (clock += ms);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, now);
  await authority.createGame({
    gameId: 'g1',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
  });
  return { authority, pubsub, advance, now };
}

test('createGame registers a game and exposes authoritative state', async () => {
  const { authority } = await setup();
  assert.equal(authority.has('g1'), true);
  const s = authority.getState('g1');
  assert.equal(s.ply, 0);
  assert.equal(s.turn, 'w');
  assert.equal(s.turnStartedAt, 1_000, 'turnStartedAt must carry through from domain clock');
  assert.equal(s.status.over, false);
  assert.equal(s.fenHash.length, 12);
  assert.deepEqual(s.players, { white: 'alice', black: 'bob' });
});

test('state exposes authoritative legal destinations for the side to move', async () => {
  const { authority } = await setup();
  const s = authority.getState('g1');
  const total = Object.values(s.legalMoves).reduce((n, d) => n + d.length, 0);
  assert.equal(total, 20, 'the opening position has 20 legal moves');
  assert.deepEqual([...(s.legalMoves['e2'] ?? [])].sort(), ['e3', 'e4']);
  assert.deepEqual([...(s.legalMoves['g1'] ?? [])].sort(), ['f3', 'h3']);
  assert.equal(s.legalMoves['e7'], undefined, 'only the side to move has destinations');
});

test('legal destinations follow the authoritative turn after a move', async () => {
  const { authority } = await setup();
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' });
  const s = authority.getState('g1');
  assert.equal(s.turn, 'b');
  assert.deepEqual([...(s.legalMoves['e7'] ?? [])].sort(), ['e5', 'e6']);
  assert.equal(s.legalMoves['e2'], undefined, 'white pieces are no longer to move');
});

test('legal destinations are empty once the game is over (checkmate)', async () => {
  const { authority } = await setup();
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'f2f3' });
  await authority.apply('g1', 'bob', { kind: 'move', uci: 'e7e5' });
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'g2g4' });
  await authority.apply('g1', 'bob', { kind: 'move', uci: 'd8h4' });
  const s = authority.getState('g1');
  assert.equal(s.status.over, true);
  assert.deepEqual(s.legalMoves, {});
});

test('duplicate game id is refused', async () => {
  const { authority } = await setup();
  await assert.rejects(
    authority.createGame({
      gameId: 'g1',
      timeControl: TC,
      players: { white: 'x', black: 'y' },
      rated: false,
    }),
    (e) => e instanceof AuthorityError && e.code === 'invalid_command',
  );
});

test('a variant the domain refuses is reported as an AuthorityError, not a GameError', async () => {
  // `Game.create` refuses `chess960` itself — the variant has no start position of its own, so the
  // game would be ordinary chess wearing the label (ADR-0123). This function's contract is that a
  // refused creation surfaces as `AuthorityError`, the same as the duplicate-id case above, so the
  // domain's refusal has to be translated rather than allowed to escape as its own type.
  const { authority } = await setup();
  await assert.rejects(
    authority.createGame({
      gameId: 'g-960',
      variant: 'chess960',
      timeControl: TC,
      players: { white: 'x', black: 'y' },
      rated: false,
    }),
    (e) => e instanceof AuthorityError && e.code === 'invalid_command' && /chess960/.test(e.message),
  );
  assert.equal(authority.has('g-960'), false, 'and no game was registered');
});

test('a legal move is applied and published as an authoritative broadcast', async () => {
  const { authority, pubsub } = await setup();
  const got: Broadcast[] = [];
  pubsub.subscribe(gameChannel('g1'), (m) => got.push(m));

  const res = await authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' });
  assert.equal(res.broadcasts.length, 1);
  assert.equal(got.length, 1);
  const mv = got[0]!;
  assert.equal(mv.t, 'move');
  if (mv.t === 'move') {
    assert.equal(mv.ply, 1);
    assert.equal(mv.san, 'e4');
    assert.equal(mv.by, 'w');
    assert.equal(mv.fenHash.length, 12);
  }
  assert.equal(authority.getState('g1').turn, 'b');
});

test('moving out of turn is rejected with not_your_turn', async () => {
  const { authority } = await setup();
  await assert.rejects(
    authority.apply('g1', 'bob', { kind: 'move', uci: 'e7e5' }),
    (e) => e instanceof AuthorityError && e.code === 'not_your_turn',
  );
});

test('an illegal move is rejected with illegal_move and does not change state', async () => {
  const { authority } = await setup();
  await assert.rejects(
    authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e5' }),
    (e) => e instanceof AuthorityError && e.code === 'illegal_move',
  );
  assert.equal(authority.getState('g1').ply, 0);
});

test('a spectator (non-player) cannot issue commands', async () => {
  const { authority } = await setup();
  await assert.rejects(
    authority.apply('g1', 'eve', { kind: 'move', uci: 'e2e4' }),
    (e) => e instanceof AuthorityError && e.code === 'not_a_player',
  );
});

test('commands are serialized per game (submission order, no interleaving)', async () => {
  const { authority } = await setup();
  // Fire White's and Black's first moves concurrently. The per-game lock must
  // apply them strictly in submission order — White's e4 first (legal), then
  // Black's e5 (now legal because it is Black's turn) — never interleaving into
  // a corrupt state. Both succeed and the log is exactly [e4, e5].
  const [white, black] = await Promise.allSettled([
    authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' }),
    authority.apply('g1', 'bob', { kind: 'move', uci: 'e7e5' }),
  ]);
  assert.equal(white.status, 'fulfilled');
  assert.equal(black.status, 'fulfilled');
  const state = authority.getState('g1');
  assert.equal(state.ply, 2);
  assert.deepEqual(state.moves.map((m) => m.san), ['e4', 'e5']);
  assert.equal(state.turn, 'w');
});

test('an out-of-turn move loses the race and is rejected', async () => {
  const { authority } = await setup();
  // If Black tries to move first (submitted first), it is rejected because it
  // is White's turn; a subsequent White move still succeeds.
  const [black, whiteLate] = await Promise.allSettled([
    authority.apply('g1', 'bob', { kind: 'move', uci: 'e7e5' }),
    authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' }),
  ]);
  assert.equal(black.status, 'rejected');
  assert.equal(whiteLate.status, 'fulfilled');
  assert.equal(authority.getState('g1').ply, 1);
});

test('resignation ends the game and broadcasts a terminal event', async () => {
  const { authority, pubsub } = await setup();
  const got: Broadcast[] = [];
  pubsub.subscribe(gameChannel('g1'), (m) => got.push(m));
  const res = await authority.apply('g1', 'bob', { kind: 'resign' });
  const ended = res.broadcasts.find((b) => b.t === 'ended');
  assert.ok(ended);
  if (ended && ended.t === 'ended') {
    assert.equal(ended.result, '1-0');
    assert.equal(ended.termination, 'resignation');
    assert.equal(ended.winner, 'w');
  }
  assert.equal(authority.getState('g1').status.over, true);
  assert.ok(got.some((b) => b.t === 'ended'));
});

test('terminal event is published to gamesEndedChannel', async () => {
  const { authority, pubsub } = await setup();
  const gotGlobal: Broadcast[] = [];
  pubsub.subscribe(gamesEndedChannel(), (m) => gotGlobal.push(m));
  await authority.apply('g1', 'bob', { kind: 'resign' });
  assert.equal(gotGlobal.length, 1);
  const ended = gotGlobal[0]!;
  assert.equal(ended.t, 'ended');
  if (ended.t === 'ended') {
    assert.equal(ended.gameId, 'g1');
    assert.equal(ended.result, '1-0');
    assert.equal(ended.termination, 'resignation');
  }
});

test('getMissedSince returns only broadcasts after the given ply', async () => {
  const { authority } = await setup();
  for (const uci of ['e2e4', 'e7e5', 'g1f3']) {
    await authority.apply('g1', uci[1] === '2' || uci[1] === '1' ? 'alice' : 'bob', { kind: 'move', uci });
  }
  const missedFrom1 = authority.getMissedSince('g1', 1);
  const plies = missedFrom1.filter((b) => b.t === 'move').map((b) => (b.t === 'move' ? b.ply : 0));
  assert.deepEqual(plies, [2, 3]);
  assert.equal(authority.getMissedSince('g1', 0).length, 3);
  assert.equal(authority.getMissedSince('g1', 3).length, 0);
});

test('unknown game raises unknown_game', async () => {
  const { authority } = await setup();
  assert.throws(
    () => authority.getState('nope'),
    (e) => e instanceof AuthorityError && e.code === 'unknown_game',
  );
});

// ── C1: MoveBroadcast carries legalMoves for the resulting position ────────

test('C1: a move broadcast carries legal destinations for the new side to move', async () => {
  const { authority, pubsub } = await setup();
  const got: Broadcast[] = [];
  pubsub.subscribe(gameChannel('g1'), (m) => got.push(m));

  await authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' });
  const mv = got.find((b) => b.t === 'move');
  assert.ok(mv, 'should have a move broadcast');
  if (mv && mv.t === 'move') {
    // After 1.e4, it's Black's turn — e7 should have e5/e6 as destinations.
    assert.deepEqual([...(mv.legalMoves['e7'] ?? [])].sort(), ['e5', 'e6']);
    // e4 (the moved pawn) should not be a legal origin for Black.
    assert.equal(mv.legalMoves['e4'], undefined);
    // e2 (the pawn's origin) should no longer have destinations (White moved).
    assert.equal(mv.legalMoves['e2'], undefined);
  }
});

test('C1: the mating move broadcast carries empty legalMoves', async () => {
  const { authority, pubsub } = await setup();
  const got: Broadcast[] = [];
  pubsub.subscribe(gameChannel('g1'), (m) => got.push(m));

  // Fool's mate: f3 e5 g4 Qh4#
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'f2f3' });
  await authority.apply('g1', 'bob', { kind: 'move', uci: 'e7e5' });
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'g2g4' });

  got.length = 0; // clear to capture only the mating move
  await authority.apply('g1', 'bob', { kind: 'move', uci: 'd8h4' });

  const mv = got.find((b) => b.t === 'move');
  assert.ok(mv, 'should have the mating move broadcast');
  if (mv && mv.t === 'move') {
    // The mating move's broadcast should carry empty legalMoves (game over).
    assert.deepEqual(mv.legalMoves, {});
  }
  // The previous (non-mating) move broadcast should have had non-empty legalMoves.
  // (g4 was the 3rd move; its broadcast should have had legalMoves for Black.)
  // We already cleared `got`, so verify via the state:
  assert.equal(authority.getState('g1').status.over, true);
  assert.deepEqual(authority.getState('g1').legalMoves, {});
});

// ── M1: getState returns empty legalMoves for non-checkmate endings ────────

test('M1: after resignation, getState legalMoves is {} while the position has moves', async () => {
  const { authority } = await setup();
  // Play one move so the position is not the startpos (which also has moves).
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' });
  // Resign — the position still has legal moves, but the game is over.
  await authority.apply('g1', 'bob', { kind: 'resign' });
  const s = authority.getState('g1');
  assert.equal(s.status.over, true);
  assert.deepEqual(s.legalMoves, {}, 'legalMoves must be {} after resignation even though the position has moves');
});
