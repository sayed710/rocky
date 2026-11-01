/**
 * Regression tests for Issue #128 in @chess-platform/realtime-gateway:
 * Verifies that cold loads and warm reloads of malformed durable streams
 * (events after GameEnded, duplicate endings, unknown event types) fail closed:
 *  - no partial publication to PubSub
 *  - no append / modification to backing EventLog (deep-cloned row comparisons)
 *  - cached result is not overwritten / rewritten to forged outcomes
 *  - untrusted cache cannot be read after reload failure
 *  - concurrent cold callers settle predictably without unhandled rejections
 *  - gateway socket join and warm resume fail closed without leaking success frames (joined/resumed)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, GameError, type GameEvent, type MovePlayedEvent, type TimeControl } from '@chess-platform/game';
import { GameAuthority, AuthorityError } from '../src/authority';
import { InMemoryEventLog } from '../src/event-log';
import { RealtimeGateway } from '../src/gateway';
import { InMemoryPubSub, gameChannel } from '../src/pubsub';
import { InMemoryConnection } from '../src/transport';
import type { Broadcast } from '../src/protocol';
import { FakeTokenVerifier } from './fake-token-verifier';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

function createResignedGameEvents(gameId: string): GameEvent[] {
  const { game, events } = Game.create({
    gameId,
    variant: 'standard',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: false,
    at: 1_000,
  });
  const m1 = game.playMove('e2e4', 2_000);
  const ended = m1.game.resign('w', 3_000);
  return [...events, ...m1.events, ...ended.events];
}

test('cold load of malformed stream (events after GameEnded) fails closed with concurrent settlement', async () => {
  const gameId = 'g-cold-corrupt';
  const legitimate = createResignedGameEvents(gameId);
  const lateMove: MovePlayedEvent = {
    type: 'MovePlayed',
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    moveTimeMs: 1_000,
    remaining: { w: 300_000, b: 299_000 },
    at: 4_000,
  };
  const malformedEvents: GameEvent[] = [...legitimate, lateMove];

  const store = new InMemoryEventLog();
  await store.append(gameId, -1, malformedEvents);

  // Capture detached, deep-cloned rows before load attempt
  const preLoadRows = structuredClone(await store.load(gameId));

  const pubsub = new InMemoryPubSub();
  const published: Broadcast[] = [];
  pubsub.subscribe(gameChannel(gameId), (msg) => { published.push(msg); });

  const authority = new GameAuthority(pubsub, () => 5_000, store);

  // 1. Single load attempt rejects with GameError
  await assert.rejects(
    () => authority.ensureLoaded(gameId),
    (err: unknown) => err instanceof GameError && err.message === 'MovePlayed after GameEnded',
  );

  // Authority does not retain corrupt game resident
  assert.equal(authority.has(gameId), false);
  assert.equal(published.length, 0);

  // 2. Concurrent cold callers all settle predictably without unhandled rejections
  const concurrentSettled = await Promise.allSettled([
    authority.ensureLoaded(gameId),
    authority.ensureLoaded(gameId),
    authority.ensureLoaded(gameId),
  ]);
  for (const res of concurrentSettled) {
    assert.equal(res.status, 'rejected');
    if (res.status === 'rejected') {
      assert.ok(res.reason instanceof GameError);
      assert.equal(res.reason.message, 'MovePlayed after GameEnded');
    }
  }

  assert.equal(authority.has(gameId), false);
  assert.equal(published.length, 0);

  // 3. Complete event log rows remain strictly identical (no append, rewrite, or mutation)
  const afterLoadRows = await store.load(gameId);
  assert.deepEqual(afterLoadRows, preLoadRows);
});

test('warm reload from corrupted backing log rejects, does not rewrite cached result, and marks cache unusable', async () => {
  const gameId = 'g-warm-corrupt';
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1_000, store);

  // Start and finish a legitimate game (Alice resigns -> Black wins)
  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: false,
  });
  await authority.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await authority.apply(gameId, 'alice', { kind: 'resign' });

  assert.equal(authority.has(gameId), true);
  const stateBefore = authority.getState(gameId);
  assert.equal(stateBefore.status.over, true);
  assert.equal(stateBefore.status.result, '0-1');
  assert.equal(stateBefore.status.winner, 'b');

  // Clear broadcast recordings from creation/play
  const postCorruptPublished: Broadcast[] = [];
  pubsub.subscribe(gameChannel(gameId), (msg) => { postCorruptPublished.push(msg); });

  // Simulate an out-of-band corruption to the durable store: append a conflicting GameEnded (claiming White win)
  const currentLogged = await store.load(gameId);
  const corruptEnding: GameEvent = {
    type: 'GameEnded',
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    at: 10_000,
  };
  await store.append(gameId, currentLogged.length - 1, [corruptEnding]);

  // Capture deep-cloned rows before reload
  const preReloadRows = structuredClone(await store.load(gameId));

  // Warm reload must reject with GameError
  await assert.rejects(
    () => authority.reloadFromLog(gameId),
    (err: unknown) => err instanceof GameError && err.message === 'GameEnded after GameEnded',
  );

  // No corrupt broadcasts emitted to pubsub
  assert.equal(postCorruptPublished.length, 0);

  // Store is not appended to by the reload failure; rows remain identical
  const postReloadRows = await store.load(gameId);
  assert.deepEqual(postReloadRows, preReloadRows);

  // The cached record was not rewritten to White winning, and untrusted cache cannot be read
  assert.throws(
    () => authority.getState(gameId),
    (err: unknown) => err instanceof AuthorityError && err.code === 'invalid_command' && err.message.includes('durable game reload is required'),
  );
});

test('cold load with unknown event kind fails closed safely', async () => {
  const gameId = 'g-unknown-event';
  const { events } = Game.create({
    gameId,
    variant: 'standard',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: false,
    at: 1_000,
  });

  const unknownEvent = {
    type: 'UnknownForgedKind',
    at: 2_000,
  } as unknown as GameEvent;

  const store = new InMemoryEventLog();
  await store.append(gameId, -1, [...events, unknownEvent]);
  const preLoadRows = structuredClone(await store.load(gameId));

  const pubsub = new InMemoryPubSub();
  const published: Broadcast[] = [];
  pubsub.subscribe(gameChannel(gameId), (msg) => { published.push(msg); });

  const authority = new GameAuthority(pubsub, () => 3_000, store);

  await assert.rejects(
    () => authority.ensureLoaded(gameId),
    (err: unknown) => err instanceof GameError && err.message.includes('Unknown event type'),
  );

  assert.equal(authority.has(gameId), false);
  assert.equal(published.length, 0);
  assert.deepEqual(await store.load(gameId), preLoadRows);
});

test('gateway socket join on cold malformed game fails closed with invalid_command and no success frames', async () => {
  const gameId = 'g-socket-corrupt';
  const legitimate = createResignedGameEvents(gameId);
  const lateMove: MovePlayedEvent = {
    type: 'MovePlayed',
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    moveTimeMs: 1_000,
    remaining: { w: 300_000, b: 299_000 },
    at: 4_000,
  };

  const store = new InMemoryEventLog();
  await store.append(gameId, -1, [...legitimate, lateMove]);
  const preJoinRows = structuredClone(await store.load(gameId));

  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 5_000, store);
  const verifier = new FakeTokenVerifier().allow('alice-token', 'alice');
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  const connection = new InMemoryConnection('conn-1');
  gateway.handleConnection(connection);

  connection.deliver({ t: 'join', gameId, token: 'alice-token' });
  await flush();

  // Socket join is rejected
  assert.deepEqual(
    connection.all('reject').map((r) => [r.code, r.message]),
    [['invalid_command', 'failed to load game']],
  );

  // Explicitly assert zero success frames / receipts were delivered
  assert.equal(connection.all('joined').length, 0);
  assert.equal(connection.all('resumed').length, 0);
  assert.equal(connection.all('commandConfirmed').length, 0);
  assert.equal(connection.all('state').length, 0);
  assert.equal(connection.sent.some((m) => m.t !== 'reject'), false);

  // Authority does not retain game resident and store is untouched
  assert.equal(authority.has(gameId), false);
  assert.deepEqual(await store.load(gameId), preJoinRows);
});

test('gateway socket resume after eviction on corrupted log fails closed without emitting resumed', async () => {
  const gameId = 'g-resume-corrupt';
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1_000, store);
  const verifier = new FakeTokenVerifier().allow('alice-token', 'alice');
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  // 1. Create a legitimate ongoing game and join as Alice
  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: false,
  });

  const connection = new InMemoryConnection('conn-resume');
  gateway.handleConnection(connection);
  connection.deliver({ t: 'join', gameId, token: 'alice-token' });
  await flush();

  assert.equal(connection.all('joined').length, 1);
  const joinedFrame = connection.all('joined')[0]!;
  assert.equal(joinedFrame.gameId, gameId);

  // 2. Play move 1. e4, then Alice resigns
  await authority.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await authority.apply(gameId, 'alice', { kind: 'resign' });

  // 3. Evict game from memory cache
  authority.evict(gameId);
  assert.equal(authority.has(gameId), false);

  // 4. Corrupt durable log by appending a trailing move after GameEnded
  const currentLogged = await store.load(gameId);
  const lateMove: MovePlayedEvent = {
    type: 'MovePlayed',
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    moveTimeMs: 1_000,
    remaining: { w: 300_000, b: 299_000 },
    at: 5_000,
  };
  await store.append(gameId, currentLogged.length - 1, [lateMove]);
  const preResumeRows = structuredClone(await store.load(gameId));

  // 5. Client attempts to resume
  connection.deliver({ t: 'resume', gameId, lastPly: 1 });
  await flush();

  // Resume must fail closed with invalid_command
  assert.deepEqual(
    connection.all('reject').map((r) => [r.code, r.message]),
    [['invalid_command', 'failed to load game']],
  );

  // Explicitly assert NO resumed frame was delivered
  assert.equal(connection.all('resumed').length, 0);

  // Authority does not retain game resident and store is untouched
  assert.equal(authority.has(gameId), false);
  assert.deepEqual(await store.load(gameId), preResumeRows);
});
