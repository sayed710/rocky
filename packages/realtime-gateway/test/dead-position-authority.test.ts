import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GameAuthority,
  InMemoryEventLog,
  InMemoryPubSub,
  type Broadcast,
  gameChannel,
  gamesEndedChannel,
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
