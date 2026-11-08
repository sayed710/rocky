import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GameAuthority,
  InMemoryEventLog,
  InMemoryPubSub,
  type Broadcast,
  gameChannel,
  gamesEndedChannel,
  NO_SHOW_ACTOR,
} from '../src';

const BLOCKED_DEAD_FEN = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
const LEGAL_PREDECESSOR_FEN = '8/1pk2p1p/p1p1pPpP/PPP1P1P1/5K2/8/8/8 w - - 0 1';

test('createGame with custom dead position FEN: persists GameCreated and GameEnded, publishes ended broadcast with exact counts', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, store);

  const published: { channel: string; msg: Broadcast }[] = [];
  pubsub.subscribe(gameChannel('dead-custom-game-1'), (msg) => {
    published.push({ channel: gameChannel('dead-custom-game-1'), msg });
  });
  pubsub.subscribe(gamesEndedChannel(), (msg) => {
    published.push({ channel: gamesEndedChannel(), msg });
  });

  const view = await authority.createGame({
    gameId: 'dead-custom-game-1',
    variant: 'standard',
    initialFen: BLOCKED_DEAD_FEN,
    players: { white: 'alice', black: 'bob' },
    timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    at: 1000,
  });

  // 1. Authoritative view
  assert.equal(view.status.over, true);
  if (view.status.over) {
    assert.equal(view.status.termination, 'dead_position');
    assert.equal(view.status.result, '1/2-1/2');
    assert.equal(view.status.winner, null);
  }
  assert.equal(view.stateRevision, 1);
  assert.deepEqual(view.legalMoves, {});

  // 2. Durable persistence: exactly 2 events (GameCreated at seq 0, GameEnded at seq 1)
  const head = await store.head('dead-custom-game-1');
  assert.equal(head, 1);
  const log = await store.loadSince('dead-custom-game-1', -1);
  assert.equal(log.length, 2);
  assert.equal(log[0]!.event.type, 'GameCreated');
  assert.equal(log[0]!.seq, 0);
  assert.equal(log[1]!.event.type, 'GameEnded');
  assert.equal(log[1]!.seq, 1);
  if (log[1]!.event.type === 'GameEnded') {
    assert.equal(log[1]!.event.termination, 'dead_position');
    assert.equal(log[1]!.event.result, '1/2-1/2');
    assert.equal(log[1]!.event.winner, null);
  }

  // 3. Exact-count assertions: exactly 1 per channel, exactly 2 total
  const gameMsgs = published.filter((p) => p.channel === gameChannel('dead-custom-game-1'));
  const endedGlobalMsgs = published.filter((p) => p.channel === gamesEndedChannel());
  assert.equal(gameMsgs.length, 1, 'gameChannel receives exactly 1 broadcast');
  assert.equal(endedGlobalMsgs.length, 1, 'gamesEndedChannel receives exactly 1 broadcast');
  assert.equal(published.length, 2, 'Total broadcasts across channels must be exactly 2');

  const endedBroadcast = gameMsgs[0]!.msg;
  assert.equal(endedBroadcast.t, 'ended');
  if (endedBroadcast.t === 'ended') {
    assert.equal(endedBroadcast.termination, 'dead_position');
    assert.equal(endedBroadcast.result, '1/2-1/2');
    assert.equal(endedBroadcast.winner, null);
    assert.equal(endedBroadcast.stateRevision, 1);
  }

  // 4. Any subsequent move command is rejected because game is already over
  await assert.rejects(
    async () => {
      await authority.apply('dead-custom-game-1', 'bob', { kind: 'move', uci: 'c7d7' });
    },
    { message: /already over/ },
  );
  // Durable head unchanged after rejected duplicate
  assert.equal(await store.head('dead-custom-game-1'), 1);
});

test('createGame with throwing subscriber: durable creation commits, attempts global channel, returns terminal view without throwing AuthorityCommitError', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, store);

  let gameChannelAttempts = 0;
  let globalChannelAttempts = 0;

  // Subscriber on gameChannel deliberately throws an error
  pubsub.subscribe(gameChannel('throwing-sub-game'), () => {
    gameChannelAttempts++;
    throw new Error('synthetic subscriber throw after durable creation');
  });

  // Subscriber on gamesEndedChannel records delivery
  pubsub.subscribe(gamesEndedChannel(), () => {
    globalChannelAttempts++;
  });

  const view = await authority.createGame({
    gameId: 'throwing-sub-game',
    variant: 'standard',
    initialFen: BLOCKED_DEAD_FEN,
    players: { white: 'alice', black: 'bob' },
    timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    at: 1000,
  });

  // Succeeded: did NOT throw AuthorityCommitError!
  assert.equal(view.status.over, true);
  if (view.status.over) {
    assert.equal(view.status.termination, 'dead_position');
  }

  // Durable store has head = 1 and both events
  const head = await store.head('throwing-sub-game');
  assert.equal(head, 1);

  // Both publication attempts were made independently
  assert.equal(gameChannelAttempts, 1);
  assert.equal(globalChannelAttempts, 1);
});

test('move into dead position: predecessor emits MovePlayed then GameEnded with distinct revisions and empty legalMoves', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, store);

  const published: Broadcast[] = [];
  pubsub.subscribe(gameChannel('predecessor-game'), (msg) => {
    published.push(msg);
  });

  await authority.createGame({
    gameId: 'predecessor-game',
    variant: 'standard',
    initialFen: LEGAL_PREDECESSOR_FEN,
    players: { white: 'alice', black: 'bob' },
    timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    at: 1000,
  });

  // White plays b5b6, reaching the dead position
  const result = await authority.apply('predecessor-game', 'alice', { kind: 'move', uci: 'b5b6' });

  // 1. Events: MovePlayed followed by GameEnded
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0]!.type, 'MovePlayed');
  assert.equal(result.events[1]!.type, 'GameEnded');
  if (result.events[1]!.type === 'GameEnded') {
    assert.equal(result.events[1]!.termination, 'dead_position');
    assert.equal(result.events[1]!.result, '1/2-1/2');
    assert.equal(result.events[1]!.winner, null);
  }

  // 2. State & legalMoves
  assert.equal(result.state.status.over, true);
  if (result.state.status.over) {
    assert.equal(result.state.status.termination, 'dead_position');
  }
  assert.deepEqual(result.state.legalMoves, {});

  // 3. Broadcasts: move broadcast then ended broadcast with distinct revisions
  assert.equal(result.broadcasts.length, 2);
  assert.equal(result.broadcasts[0]!.t, 'move');
  assert.equal(result.broadcasts[1]!.t, 'ended');
  assert.equal(result.broadcasts[0]!.stateRevision, 1);
  assert.equal(result.broadcasts[1]!.stateRevision, 2);

  // 4. Store head is seq 2 (GameCreated 0, MovePlayed 1, GameEnded 2)
  const head = await store.head('predecessor-game');
  assert.equal(head, 2);

  // 5. Subsequent move is rejected
  await assert.rejects(
    async () => {
      await authority.apply('predecessor-game', 'bob', { kind: 'move', uci: 'c7d7' });
    },
    { message: /already over/ },
  );
  assert.equal(await store.head('predecessor-game'), 2);
});

test('ongoing dead prefix command arbitration: incoming move adjudicates dead_position without accepting move', async () => {
  const store = new InMemoryEventLog();
  // Durably seed an ongoing game prefix that starts in dead position without GameEnded
  await store.append('ongoing-dead-prefix', -1, [{
    type: 'GameCreated',
    gameId: 'ongoing-dead-prefix',
    variant: 'standard',
    initialFen: BLOCKED_DEAD_FEN,
    players: { white: 'alice', black: 'bob' },
    timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    rated: false,
    at: 1000,
  }]);

  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 2000, store);
  await authority.ensureLoaded('ongoing-dead-prefix');

  // Cold join/hydration reloads the prefix
  const state = await authority.getState('ongoing-dead-prefix');
  assert.equal(state.status.over, false, 'Rehydrated ongoing prefix starts with status over: false');

  // Non-player outsider attempting to apply command is rejected by admission
  await assert.rejects(
    async () => {
      await authority.apply('ongoing-dead-prefix', 'eve', { kind: 'move', uci: 'c7d7' });
    },
    { message: /only players may issue commands/ },
  );
  // Store head remains 0
  assert.equal(await store.head('ongoing-dead-prefix'), 0);

  // Bob (Black to move) attempts to play move c7d7
  const result = await authority.apply('ongoing-dead-prefix', 'bob', { kind: 'move', uci: 'c7d7' });

  // Does NOT accept the move: emits GameEnded with dead_position
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.type, 'GameEnded');
  if (result.events[0]!.type === 'GameEnded') {
    assert.equal(result.events[0]!.termination, 'dead_position');
    assert.equal(result.events[0]!.result, '1/2-1/2');
    assert.equal(result.events[0]!.winner, null);
  }

  // Durable store now has GameEnded at seq 1
  const head = await store.head('ongoing-dead-prefix');
  assert.equal(head, 1);

  // Authoritative state is now over
  const updatedState = await authority.getState('ongoing-dead-prefix');
  assert.equal(updatedState.status.over, true);
  if (updatedState.status.over) {
    assert.equal(updatedState.status.termination, 'dead_position');
  }
  assert.deepEqual(updatedState.legalMoves, {});

  // Cold eviction and rehydration preserves terminal state and empty legal moves
  authority.evict('ongoing-dead-prefix');
  await authority.ensureLoaded('ongoing-dead-prefix');
  const rehydrated = await authority.getState('ongoing-dead-prefix');
  assert.equal(rehydrated.status.over, true);
  if (rehydrated.status.over) {
    assert.equal(rehydrated.status.termination, 'dead_position');
  }
  assert.deepEqual(rehydrated.legalMoves, {});

  // Recovery read verifies catch-up
  const recovery = await authority.readRecovery('ongoing-dead-prefix', 0);
  assert.equal(recovery.state.status.over, true);
});

test('ongoing dead prefix command arbitration: flag claim adjudicates dead_position rather than timeout', async () => {
  const store = new InMemoryEventLog();
  // Sourced game created with sudden death 1 second
  await store.append('ongoing-dead-flag', -1, [
    {
      type: 'GameCreated',
      gameId: 'ongoing-dead-flag',
      variant: 'standard',
      initialFen: BLOCKED_DEAD_FEN,
      players: { white: 'alice', black: 'bob' },
      timeControl: { initialMs: 1000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rated: false,
      at: 1000,
    },
  ]);

  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 2000, store);
  await authority.ensureLoaded('ongoing-dead-flag');

  // Alice (White) tries to claim flag
  const result = await authority.apply('ongoing-dead-flag', 'alice', { kind: 'claimFlag' });

  // Adjudicates dead_position ending, NOT timeout
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.type, 'GameEnded');
  if (result.events[0]!.type === 'GameEnded') {
    assert.equal(result.events[0]!.termination, 'dead_position');
    assert.equal(result.events[0]!.result, '1/2-1/2');
    assert.equal(result.events[0]!.winner, null);
  }
});

test('data-driven authority command admission refusals: invalid commands reject without durable mutation or dead settlement', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();

  const id = 'authority-refusal-partitions';
  const baseEvent = {
    type: 'GameCreated' as const,
    gameId: id,
    variant: 'standard' as const,
    initialFen: BLOCKED_DEAD_FEN,
    players: { white: 'alice', black: 'bob' },
    timeControl: { initialMs: 10_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const },
    rated: false,
    at: 0,
  };

  const sourcedId = 'authority-sourced-refusals';
  const sourcedEvent = {
    ...baseEvent,
    gameId: sourcedId,
    source: 'seek' as const,
    noShowAfterMs: 1000,
  };

  await store.append(id, -1, [baseEvent]);
  await store.append(sourcedId, -1, [sourcedEvent]);

  // Two-ply game for abort refusal
  const twoPlyId = 'authority-two-ply-abort';
  await store.append(twoPlyId, -1, [
    { ...baseEvent, gameId: twoPlyId },
    {
      type: 'MovePlayed',
      ply: 1,
      uci: 'c7d7',
      san: 'Kd7',
      by: 'b',
      moveTimeMs: 100,
      remaining: { w: 10_000, b: 9_900 },
      at: 100,
    },
    {
      type: 'MovePlayed',
      ply: 2,
      uci: 'f4e3',
      san: 'Ke3',
      by: 'w',
      moveTimeMs: 100,
      remaining: { w: 9_900, b: 9_900 },
      at: 200,
    },
  ]);

  // Duplicate draw offer game
  const duplicateOfferId = 'authority-duplicate-offer';
  await store.append(duplicateOfferId, -1, [
    { ...baseEvent, gameId: duplicateOfferId },
    {
      type: 'DrawOffered',
      by: 'b',
      at: 100,
    },
  ]);

  const authority = new GameAuthority(pubsub, () => 500, store);
  await authority.ensureLoaded(id);
  await authority.ensureLoaded(sourcedId);
  await authority.ensureLoaded(twoPlyId);
  await authority.ensureLoaded(duplicateOfferId);

  // 1. Server premature no-show
  await assert.rejects(
    async () => authority.apply(sourcedId, NO_SHOW_ACTOR, { kind: 'expireNoShow' }),
    { message: /No-show expiry refused: not_due/ },
  );
  assert.equal(await store.head(sourcedId), 0, 'Premature no-show must not mutate durable store');

  // 2. Player unready move
  await assert.rejects(
    async () => authority.apply(sourcedId, 'bob', { kind: 'move', uci: 'c7d7' }),
    { message: /both players must be ready before the first move/ },
  );
  assert.equal(await store.head(sourcedId), 0, 'Unready move must not mutate durable store');

  // 3. Player premature flag claim
  await assert.rejects(
    async () => authority.apply(id, 'alice', { kind: 'claimFlag' }),
    { message: /Opponent has not flagged/ },
  );
  assert.equal(await store.head(id), 0, 'Premature flag claim must not mutate durable store');

  // 4. Player abort after 2 plies
  await assert.rejects(
    async () => authority.apply(twoPlyId, 'bob', { kind: 'abort' }),
    { message: /Game can no longer be aborted/ },
  );
  assert.equal(await store.head(twoPlyId), 2, 'Late abort must not mutate durable store');

  // 5. Missing draw offer accept
  await assert.rejects(
    async () => authority.apply(id, 'alice', { kind: 'acceptDraw' }),
    { message: /No draw offer from the opponent to accept/ },
  );
  assert.equal(await store.head(id), 0, 'Missing draw accept must not mutate durable store');

  // 6. Missing draw offer decline
  await assert.rejects(
    async () => authority.apply(id, 'alice', { kind: 'declineDraw' }),
    { message: /No draw offer to decline/ },
  );
  assert.equal(await store.head(id), 0, 'Missing draw decline must not mutate durable store');

  // 7. Duplicate draw offer
  await assert.rejects(
    async () => authority.apply(duplicateOfferId, 'bob', { kind: 'offerDraw' }),
    { message: /Draw already offered by this side/ },
  );
  assert.equal(await store.head(duplicateOfferId), 1, 'Duplicate offerDraw must not mutate durable store');

  // 8. Illegal move on ongoing dead prefix
  await assert.rejects(
    async () => authority.apply(id, 'bob', { kind: 'move', uci: 'e2e4' }),
    { message: /No legal move matches "e2e4"/ },
  );
  assert.equal(await store.head(id), 0, 'Illegal move must not mutate durable store');
});

test('data-driven authority due admitted dead actions: due actions settle dead draw and persist GameEnded', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();

  // 1. Due no-show on dead position
  const noShowId = 'authority-due-noshow';
  await store.append(noShowId, -1, [{
    type: 'GameCreated' as const,
    gameId: noShowId,
    variant: 'standard' as const,
    initialFen: BLOCKED_DEAD_FEN,
    players: { white: 'alice', black: 'bob' },
    timeControl: { initialMs: 10_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const },
    rated: false,
    source: 'seek' as const,
    noShowAfterMs: 1000,
    at: 0,
  }]);

  // Authority clock at 1500 (deadline passed)
  const authority1 = new GameAuthority(pubsub, () => 1500, store);
  await authority1.ensureLoaded(noShowId);
  const noShowResult = await authority1.apply(noShowId, NO_SHOW_ACTOR, { kind: 'expireNoShow' });
  assert.equal(noShowResult.events.length, 1);
  assert.equal(noShowResult.events[0]!.type, 'GameEnded');
  if (noShowResult.events[0]!.type === 'GameEnded') {
    assert.equal(noShowResult.events[0]!.termination, 'dead_position');
    assert.equal(noShowResult.events[0]!.result, '1/2-1/2');
    assert.equal(noShowResult.events[0]!.winner, null);
  }
  assert.equal(await store.head(noShowId), 1);

  // 2. Valid abort on dead position
  const abortId = 'authority-valid-abort';
  await store.append(abortId, -1, [{
    type: 'GameCreated' as const,
    gameId: abortId,
    variant: 'standard' as const,
    initialFen: BLOCKED_DEAD_FEN,
    players: { white: 'alice', black: 'bob' },
    timeControl: { initialMs: 10_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const },
    rated: false,
    at: 0,
  }]);
  const authority2 = new GameAuthority(pubsub, () => 500, store);
  await authority2.ensureLoaded(abortId);
  const abortResult = await authority2.apply(abortId, 'alice', { kind: 'abort' });
  assert.equal(abortResult.events.length, 1);
  assert.equal(abortResult.events[0]!.type, 'GameEnded');
  if (abortResult.events[0]!.type === 'GameEnded') {
    assert.equal(abortResult.events[0]!.termination, 'dead_position');
    assert.equal(abortResult.events[0]!.result, '1/2-1/2');
    assert.equal(abortResult.events[0]!.winner, null);
  }
  assert.equal(await store.head(abortId), 1);

  // 3. Accepted draw on dead position
  const acceptId = 'authority-accept-draw';
  await store.append(acceptId, -1, [
    {
      type: 'GameCreated' as const,
      gameId: acceptId,
      variant: 'standard' as const,
      initialFen: BLOCKED_DEAD_FEN,
      players: { white: 'alice', black: 'bob' },
      timeControl: { initialMs: 10_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const },
      rated: false,
      at: 0,
    },
    {
      type: 'DrawOffered' as const,
      by: 'w' as const,
      at: 100,
    },
  ]);
  const authority3 = new GameAuthority(pubsub, () => 500, store);
  await authority3.ensureLoaded(acceptId);
  const acceptResult = await authority3.apply(acceptId, 'bob', { kind: 'acceptDraw' });
  assert.equal(acceptResult.events.length, 1);
  assert.equal(acceptResult.events[0]!.type, 'GameEnded');
  if (acceptResult.events[0]!.type === 'GameEnded') {
    assert.equal(acceptResult.events[0]!.termination, 'dead_position');
    assert.equal(acceptResult.events[0]!.result, '1/2-1/2');
    assert.equal(acceptResult.events[0]!.winner, null);
  }
  assert.equal(await store.head(acceptId), 2);
});

test('createGame with throwing subscriber: logs contextual console.error with channel and gameId without leaking synthetic payload sentinel across all arguments', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const id = 'throwing-sub-contextual-log';
  const syntheticSentinel = 'SYNTHETIC_PAYLOAD_SENTINEL ' + BLOCKED_DEAD_FEN;

  let globalAttempts = 0;
  pubsub.subscribe(gameChannel(id), () => {
    throw new Error(syntheticSentinel);
  });
  pubsub.subscribe(gamesEndedChannel(), () => {
    globalAttempts++;
  });

  const loggedErrors: unknown[][] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  try {
    const authority = new GameAuthority(pubsub, () => 1000, store);
    const view = await authority.createGame({
      gameId: id,
      variant: 'standard',
      initialFen: BLOCKED_DEAD_FEN,
      players: { white: 'alice', black: 'bob' },
      timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      at: 1000,
    });

    assert.equal(view.status.over, true);
    assert.equal(await store.head(id), 1);
    assert.equal(globalAttempts, 1, 'gamesEndedChannel still received delivery');
    assert.ok(loggedErrors.length >= 1, 'console.error must be called on synchronous publish failure');

    // Inspect ALL arguments across all logged calls
    const allArgs = loggedErrors.flat().map((arg) => String(arg));
    assert.ok(allArgs.some((arg) => arg.includes('[InMemoryPubSub]')), 'Must contain [InMemoryPubSub] tag');
    assert.ok(allArgs.some((arg) => arg.includes('channel')), 'Must identify channel');
    assert.ok(allArgs.some((arg) => arg.includes(id)), 'Must include gameId');
    assert.ok(
      allArgs.every((arg) => !arg.includes(syntheticSentinel) && !arg.includes(BLOCKED_DEAD_FEN)),
      'Must NOT include synthetic error payload or FEN in any logged argument',
    );
  } finally {
    console.error = origError;
  }
});
