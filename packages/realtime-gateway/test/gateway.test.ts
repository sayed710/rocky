import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimeControl } from '@chess-platform/game';
import { GameAuthority } from '../src/authority';
import { InMemoryEventLog } from '../src/event-log';
import { InMemoryPubSub } from '../src/pubsub';
import { InMemoryConnection } from '../src/transport';
import { RealtimeGateway } from '../src/gateway';
import { FakeTokenVerifier } from './fake-token-verifier';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };

/** Drain pending micro/macro tasks so async command application completes. */
const flush = () => new Promise((r) => setImmediate(r));

async function harness() {
  let clock = 1_000;
  const now = () => (clock += 10);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, now);
  const verifier = new FakeTokenVerifier()
    .allow('token-alice', 'alice')
    .allow('token-bob', 'bob');
  const gateway = new RealtimeGateway(authority, pubsub, verifier, now);
  await authority.createGame({
    gameId: 'g1',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
  });
  const connect = (id: string) => {
    const c = new InMemoryConnection(id);
    gateway.handleConnection(c);
    return c;
  };
  return { authority, pubsub, gateway, verifier, connect };
}

test('join assigns the correct role and returns current state', async () => {
  const { connect } = await harness();
  const alice = connect('a');
  alice.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
  const joined = alice.last('joined');
  assert.ok(joined);
  assert.equal(joined!.role, 'white');
  assert.equal(joined!.state.turn, 'w');

  const sam = connect('s');
  sam.deliver({ t: 'join', gameId: 'g1' }); // no token → anonymous spectator
  assert.equal(sam.last('joined')!.role, 'spectator');
});

test('valid joins and resumes wait for a stale takeover reload without disconnecting', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1_000, store);
  await authority.createGame({ gameId: 'reload-join', timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: false });
  const gateway = new RealtimeGateway(authority, pubsub, new FakeTokenVerifier().allow('alice-token', 'alice'));
  const first = new InMemoryConnection('first');
  gateway.handleConnection(first);
  first.deliver({ t: 'join', gameId: 'reload-join', token: 'alice-token' });
  assert.ok(first.last('joined'));
  const departing = new InMemoryConnection('departing');
  gateway.handleConnection(departing);
  departing.deliver({ t: 'join', gameId: 'reload-join' });
  assert.ok(departing.last('joined'));

  const originalLoad = store.load.bind(store);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  store.load = async (gameId) => {
    await blocked;
    return originalLoad(gameId);
  };
  const reload = authority.reloadFromLog('reload-join');
  const second = new InMemoryConnection('second');
  gateway.handleConnection(second);
  second.deliver({ t: 'join', gameId: 'reload-join' });
  const vanished = new InMemoryConnection('vanished');
  gateway.handleConnection(vanished);
  vanished.deliver({ t: 'join', gameId: 'reload-join' });
  vanished.close();
  first.deliver({ t: 'resume', gameId: 'reload-join', lastPly: 0 });
  departing.deliver({ t: 'resume', gameId: 'reload-join', lastPly: 0 });
  departing.close();
  assert.equal(first.isClosed, false);
  assert.equal(second.isClosed, false);
  release();
  await reload;
  await flush();
  await flush();
  assert.ok(second.last('joined'));
  assert.equal(first.last('presence')?.spectators, 1, 'a closed pending join must not re-enter the room');
  assert.ok(first.last('resumed'));
  assert.equal(departing.last('resumed'), undefined, 'closed sessions must not receive a delayed resume');
  assert.equal(first.isClosed, false);
  assert.equal(second.isClosed, false);
});

test('presence reflects seats and spectator count', async () => {
  const { connect } = await harness();
  const alice = connect('a');
  const bob = connect('b');
  const sam = connect('s');
  alice.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
  bob.deliver({ t: 'join', gameId: 'g1', token: 'token-bob' });
  sam.deliver({ t: 'join', gameId: 'g1' }); // no token → anonymous spectator
  const p = sam.last('presence')!;
  assert.equal(p.white, true);
  assert.equal(p.black, true);
  assert.equal(p.spectators, 1);
});

test('a legal move is broadcast to players and spectators', async () => {
  const { connect } = await harness();
  const alice = connect('a');
  const bob = connect('b');
  const sam = connect('s');
  for (const [c, u] of [
    [alice, 'alice'],
    [bob, 'bob'],
    [sam, 'sam'],
  ] as const) {
    c.deliver({ t: 'join', gameId: 'g1', ...(u === 'sam' ? {} : { token: `token-${u}` }) });
  }
  alice.deliver({ t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  await flush();
  for (const c of [alice, bob, sam]) {
    const mv = c.last('move');
    assert.ok(mv, `${c.id} should receive the move`);
    assert.equal(mv!.ply, 1);
    assert.equal(mv!.san, 'e4');
  }
});

test('an illegal move is rejected referencing its clientSeq (rollback signal)', async () => {
  const { connect } = await harness();
  const alice = connect('a');
  alice.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
  alice.deliver({ t: 'move', gameId: 'g1', uci: 'e2e5', clientSeq: 7 });
  await flush();
  const rej = alice.last('reject')!;
  assert.equal(rej.code, 'illegal_move');
  assert.equal(rej.ref, 7);
});

test('stale or duplicate clientSeq is rejected', async () => {
  const { connect } = await harness();
  const alice = connect('a');
  alice.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
  alice.deliver({ t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  await flush();
  alice.deliver({ t: 'move', gameId: 'g1', uci: 'd2d4', clientSeq: 1 });
  await flush();
  const rej = alice.last('reject')!;
  assert.equal(rej.code, 'stale_seq');
});

test('a spectator cannot move; an unjoined connection cannot move', async () => {
  const { connect } = await harness();
  const sam = connect('s');
  sam.deliver({ t: 'join', gameId: 'g1' }); // no token → anonymous spectator
  sam.deliver({ t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  await flush();
  assert.equal(sam.last('reject')!.code, 'not_a_player');

  const ghost = connect('g');
  ghost.deliver({ t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  await flush();
  assert.equal(ghost.last('reject')!.code, 'not_joined');
});

test('reconnect: rejoin restores seat + state, resume replays missed moves', async () => {
  const { connect } = await harness();
  const alice = connect('a');
  const bob = connect('b');
  alice.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
  bob.deliver({ t: 'join', gameId: 'g1', token: 'token-bob' });
  alice.deliver({ t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  await flush();
  bob.deliver({ t: 'move', gameId: 'g1', uci: 'e7e5', clientSeq: 1 });
  await flush();

  // Alice drops after seeing only ply 1.
  alice.close();
  assert.equal(alice.isClosed, true);

  // She reconnects on a fresh socket.
  const alice2 = connect('a2');
  alice2.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
  const joined = alice2.last('joined')!;
  assert.equal(joined.role, 'white'); // seat restored
  assert.equal(joined.state.ply, 2); // current authoritative state

  // She asks for everything after the last ply she saw (1).
  alice2.deliver({ t: 'resume', gameId: 'g1', lastPly: 1 });
  const resumed = alice2.last('resumed')!;
  const missedPlies = resumed.missed.filter((m) => m.t === 'move').map((m) => (m.t === 'move' ? m.ply : 0));
  assert.deepEqual(missedPlies, [2]);
  assert.equal(resumed.state.ply, 2);

  // And she can keep playing; the move reaches bob.
  alice2.deliver({ t: 'move', gameId: 'g1', uci: 'g1f3', clientSeq: 2 });
  await flush();
  assert.equal(bob.last('move')!.ply, 3);
});

test('draw offer pushes state; acceptance ends the game as a draw', async () => {
  const { connect } = await harness();
  const alice = connect('a');
  const bob = connect('b');
  alice.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
  bob.deliver({ t: 'join', gameId: 'g1', token: 'token-bob' });

  alice.deliver({ t: 'offerDraw', gameId: 'g1' });
  await flush();
  const st = bob.last('state')!;
  assert.equal(st.state.drawOffer, 'w');

  bob.deliver({ t: 'acceptDraw', gameId: 'g1' });
  await flush();
  const ended = bob.last('ended')!;
  assert.equal(ended.result, '1/2-1/2');
  assert.equal(ended.termination, 'agreement');
});

test('join to an unknown game is rejected', async () => {
  const { connect } = await harness();
  const c = connect('c');
  c.deliver({ t: 'join', gameId: 'ghost', token: 'token-alice' });
  // A game absent from the hot cache might still exist in the durable log, so
  // rejecting an unknown game consults the store — the reject lands on the next
  // microtask, after the store confirms the game truly does not exist.
  await new Promise((r) => setImmediate(r));
  assert.equal(c.last('reject')!.code, 'unknown_game');
});

test('ping is answered with a pong carrying a server timestamp', async () => {
  const { connect } = await harness();
  const c = connect('c');
  c.deliver({ t: 'ping', ts: 42 });
  const pong = c.last('pong')!;
  assert.equal(pong.ts, 42);
  assert.equal(typeof pong.serverTs, 'number');
});

test('closing the last connection frees the room', async () => {
  const { connect, gateway } = await harness();
  const alice = connect('a');
  alice.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
  assert.equal(gateway.roomCount, 1);
  alice.close();
  assert.equal(gateway.roomCount, 0);
});

// ── C4: Token-authenticated join ───────────────────────────────────────────

test('C4: join with a valid token seats the token user, not a client-asserted id', async () => {
  const { connect } = await harness();
  const alice = connect('a');
  // The token determines identity — there is no userId field to assert.
  alice.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
  const joined = alice.last('joined')!;
  assert.equal(joined.role, 'white', 'token-alice maps to alice who is white');
});

test('C4: join with an invalid token is rejected with unauthorized', async () => {
  const { connect } = await harness();
  const c = connect('evil');
  c.deliver({ t: 'join', gameId: 'g1', token: 'forged-token' });
  const rej = c.last('reject')!;
  assert.equal(rej.code, 'unauthorized');
  // No joined message, no presence broadcast.
  assert.equal(c.last('joined'), undefined);
  assert.equal(c.last('presence'), undefined);
});

test('C4: join without a token is seated as an anonymous spectator', async () => {
  const { connect } = await harness();
  const sam = connect('s');
  sam.deliver({ t: 'join', gameId: 'g1' });
  const joined = sam.last('joined')!;
  assert.equal(joined.role, 'spectator');
});

test('C4: a spectator (no token) cannot move', async () => {
  const { connect } = await harness();
  const sam = connect('s');
  sam.deliver({ t: 'join', gameId: 'g1' });
  sam.deliver({ t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  await flush();
  assert.equal(sam.last('reject')!.code, 'not_a_player');
});

test('C4: identity comes from the token, not from any client claim', async () => {
  const { connect, verifier } = await harness();
  // Register a token for 'bob' but try to join as alice's seat — the gateway
  // should seat bob (black), not alice (white), because identity is from the token.
  verifier.allow('token-bob-2', 'bob');
  const c = connect('b2');
  c.deliver({ t: 'join', gameId: 'g1', token: 'token-bob-2' });
  const joined = c.last('joined')!;
  assert.equal(joined.role, 'black', 'token maps to bob → black, regardless of any claim');
});

test('onGameLoaded callback is optional and invoked once when a join materialises a game', async () => {
  let clock = 1_000;
  const now = () => (clock += 10);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, now);
  const verifier = new FakeTokenVerifier().allow('token-alice', 'alice');

  const loaded: { gameId: string; state: any }[] = [];
  const gateway = new RealtimeGateway(authority, pubsub, verifier, now, undefined, (gameId, state) => {
    loaded.push({ gameId, state });
  });

  await authority.createGame({
    gameId: 'g-loaded',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: false,
  });

  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId: 'g-loaded', token: 'token-alice' });

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.gameId, 'g-loaded');

  // Repeat join for the same game should not re-invoke onGameLoaded
  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId: 'g-loaded' });

  assert.equal(loaded.length, 1, 'onGameLoaded is guarded against double-invocation');
});

test('onGameLoaded fires again when a game room empties and is rejoined', async () => {
  let clock = 1_000;
  const now = () => (clock += 10);
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, now);
  const verifier = new FakeTokenVerifier().allow('token-alice', 'alice');

  const loaded: string[] = [];
  const gateway = new RealtimeGateway(authority, pubsub, verifier, now, undefined, (gameId) => {
    loaded.push(gameId);
  });

  await authority.createGame({
    gameId: 'g-rejoin',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: false,
  });

  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId: 'g-rejoin', token: 'token-alice' });

  assert.equal(loaded.length, 1);

  // Close connection c1 -> room empties and is torn down
  c1.close();

  assert.equal(gateway.roomCount, 0, 'room should be torn down');

  // New connection joins the game again
  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId: 'g-rejoin', token: 'token-alice' });

  assert.equal(loaded.length, 2, 'onGameLoaded must fire again after room empties and is rejoined');
});


