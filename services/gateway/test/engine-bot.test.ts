import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GameAuthority,
  InMemoryEventLog,
  InMemoryPubSub,
  LocalCommandRouter,
  gameChannel,
  type Broadcast,
} from '@chess-platform/realtime-gateway';
import type {
  AnalysisProvider,
  AnalysisRequest,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import type { Counter, Histogram, Logger, LogFields } from '@chess-platform/api';
import { BOT_ACCOUNTS } from '@chess-platform/api';
import { EngineBotMover } from '../src/engine-bot.js';

/**
 * A real engine answers over a pipe, so the event loop turns before `play()` resolves. Fakes that
 * answer on the microtask queue would let a re-run loop starve timers — including the test
 * runner's own timeouts — and turn a failing assertion into a hung file.
 */
const engineTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeAnalysisProvider implements AnalysisProvider {
  public playCalls: PlayRequest[] = [];
  public shouldFail = false;
  public responseMove = 'e7e5';

  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    return [];
  }

  async play(request: PlayRequest): Promise<PlayResult> {
    this.playCalls.push(request);
    await engineTurn();
    if (this.shouldFail) {
      throw new Error('Engine UCI subprocess crashed');
    }
    return { move: this.responseMove };
  }

  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

class FakeCounter implements Counter {
  public count = 0;
  inc(n = 1): void {
    this.count += n;
  }
}

class FakeHistogram implements Histogram {
  public observations: number[] = [];
  observe(value: number): void {
    this.observations.push(value);
  }
}

class CapturingLogger implements Logger {
  public warnings: { msg: string; fields?: LogFields }[] = [];

  debug(_msg: string, _fields?: LogFields): void {}
  info(_msg: string, _fields?: LogFields): void {}
  warn(msg: string, fields?: LogFields): void {
    this.warnings.push({ msg, fields });
  }
  error(_msg: string, _fields?: LogFields): void {}
  child(_bindings: LogFields): Logger {
    return this;
  }
}

test('EngineBotMover single-node: bot plays a response move after human move', async () => {
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const provider = new FakeAnalysisProvider();
  provider.responseMove = 'e7e5';
  const moveSecondsHistogram = new FakeHistogram();

  const mover = new EngineBotMover({
    authority,
    router,
    pubsub,
    provider,
    moveSecondsHistogram,
  });

  const botUser = BOT_ACCOUNTS[0]!; // gambit-novice
  const humanId = 'human-player-1';
  const gameId = '00000000-0000-7000-8000-000000000010';

  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: humanId, black: botUser.userId },
    rated: false,
  });

  mover.registerGame(gameId);

  // Human plays 1. e4 — pub/sub broadcast triggers bot move attempt
  await authority.apply(gameId, humanId, { kind: 'move', uci: 'e2e4' });
  await mover.attemptMove(gameId);

  const state = authority.getState(gameId);
  assert.equal(state.ply, 2, 'state must advance to ply 2 after bot reply');
  assert.equal(provider.playCalls.length, 1, 'provider.play must be called once');
  assert.equal(provider.playCalls[0]!.priority, 0, 'must use JobPriority.BotMove (0)');
  assert.deepEqual(provider.playCalls[0]!.strength, botUser.strength);

  assert.equal(moveSecondsHistogram.observations.length, 1, 'histogram must record one observation');
  assert.ok(Number.isFinite(moveSecondsHistogram.observations[0]), 'observation must be a finite number');
  assert.ok(moveSecondsHistogram.observations[0]! >= 0, 'observation duration must be non-negative');

  mover.stop();
});

test('EngineBotMover: does not issue a command when it is not the bot turn', async () => {
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const provider = new FakeAnalysisProvider();

  const mover = new EngineBotMover({
    authority,
    router,
    pubsub,
    provider,
  });

  const botUser = BOT_ACCOUNTS[0]!;
  const humanId = 'human-player-1';
  const gameId = '00000000-0000-7000-8000-000000000011';

  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: humanId, black: botUser.userId },
    rated: false,
  });

  // Ply 0: human (White) to move. Attempting move for bot (Black) should produce no command.
  await mover.attemptMove(gameId);

  const state = authority.getState(gameId);
  assert.equal(state.ply, 0, 'state remains at ply 0');
  assert.equal(provider.playCalls.length, 0, 'engine play was not invoked');

  mover.stop();
});

test('EngineBotMover: bot plays White at ply 0 on registration', async () => {
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const provider = new FakeAnalysisProvider();
  provider.responseMove = 'e2e4';

  const mover = new EngineBotMover({
    authority,
    router,
    pubsub,
    provider,
  });

  const botUser = BOT_ACCOUNTS[0]!; // bot is White
  const humanId = 'human-player-2';
  const gameId = '00000000-0000-7000-8000-000000000012';

  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: botUser.userId, black: humanId },
    rated: false,
  });

  // Registering game triggers immediate move for White
  mover.registerGame(gameId);
  await mover.attemptMove(gameId);

  const state = authority.getState(gameId);
  assert.equal(state.ply, 1, 'bot White moves at ply 0 without prior broadcast');
  assert.equal(provider.playCalls.length, 1);

  mover.stop();
});

test('EngineBotMover: unsubscribes and stops after terminal game state', async () => {
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const provider = new FakeAnalysisProvider();

  const mover = new EngineBotMover({
    authority,
    router,
    pubsub,
    provider,
  });

  const botUser = BOT_ACCOUNTS[0]!;
  const humanId = 'human-player-1';
  const gameId = '00000000-0000-7000-8000-000000000013';

  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: humanId, black: botUser.userId },
    rated: false,
  });

  mover.registerGame(gameId);

  // Human resigns (game over) — pub/sub broadcast triggers unregister
  await authority.apply(gameId, humanId, { kind: 'resign' });

  const state = authority.getState(gameId);
  assert.equal(state.status.over, true);
  assert.equal(provider.playCalls.length, 0, 'no moves attempted after game over');

  mover.stop();
});

test('EngineBotMover: engine failure increments failure counter, logs warning, and keeps process alive', async () => {
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const provider = new FakeAnalysisProvider();
  provider.shouldFail = true;

  const failuresCounter = new FakeCounter();
  const movesCounter = new FakeCounter();
  const logger = new CapturingLogger();

  const mover = new EngineBotMover({
    authority,
    router,
    pubsub,
    provider,
    failuresCounter,
    movesCounter,
    logger,
  });

  const botUser = BOT_ACCOUNTS[0]!;
  const humanId = 'human-player-1';
  const gameId = '00000000-0000-7000-8000-000000000014';

  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: humanId, black: botUser.userId },
    rated: false,
  });

  mover.registerGame(gameId);

  // Human plays 1. e4 — pub/sub broadcast triggers move attempt
  await authority.apply(gameId, humanId, { kind: 'move', uci: 'e2e4' });
  await waitUntil('the engine failure', () => failuresCounter.count > 0);

  assert.equal(failuresCounter.count, 1, 'failure counter must be incremented');
  assert.equal(movesCounter.count, 0, 'moves counter must not be incremented');
  assert.equal(logger.warnings.length, 1, 'warning must be logged');
  assert.ok(logger.warnings[0]!.msg.includes(gameId));

  const state = authority.getState(gameId);
  assert.equal(state.ply, 1, 'state remains untouched at ply 1');

  mover.stop();
});

test('EngineBotMover: unregisters when the bot\'s own move ends the game', async () => {
  // Regression: the broadcast caused by the bot's own routed move is delivered synchronously,
  // while `doMove` is still in flight. Coalescing that trigger into the in-flight promise and
  // dropping it left a finished game subscribed forever, because nothing re-examined the state
  // after the move that ended it. Fool's mate is the shortest game the bot can end itself.
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const provider = new FakeAnalysisProvider();

  const mover = new EngineBotMover({ authority, router, pubsub, provider });

  const botUser = BOT_ACCOUNTS[0]!;
  const humanId = 'human-player-3';
  const gameId = '00000000-0000-7000-8000-000000000015';

  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: humanId, black: botUser.userId },
    rated: false,
  });

  mover.registerGame(gameId);
  assert.equal(pubsub.subscriberCount(gameChannel(gameId)), 1, 'mover subscribed on registration');

  provider.responseMove = 'e7e5';
  await authority.apply(gameId, humanId, { kind: 'move', uci: 'f2f3' });
  await mover.attemptMove(gameId);

  provider.responseMove = 'd8h4'; // Qh4#
  await authority.apply(gameId, humanId, { kind: 'move', uci: 'g2g4' });
  await mover.attemptMove(gameId);

  const state = authority.getState(gameId);
  assert.equal(state.status.over, true, 'the bot delivered mate');
  assert.equal(
    pubsub.subscriberCount(gameChannel(gameId)),
    0,
    'mover must unsubscribe after the move that ended the game',
  );

  mover.stop();
});

// --- Multi-node ownership gate (ADR-0010) ---
//
// These drive the mover's own logic with a scripted ownership gate. The same guarantees are proven
// against the production RedisCommandRouter + OwnershipRegistry in
// engine-bot-multinode.integration.test.ts.

/** Ownership gate whose answers the test controls. */
class ScriptedOwnership {
  public owns = true;
  /** Make the next post-engine check see a lapsed lease once, as after a missed renewal. */
  public lapseNextCheck = false;
  public prepareCalls = 0;
  async prepareOwnership(_gameId: string): Promise<boolean> {
    this.prepareCalls++;
    return this.owns;
  }
  holdsOwnership(_gameId: string): boolean {
    if (this.lapseNextCheck) {
      this.lapseNextCheck = false;
      return false;
    }
    return this.owns;
  }
}

/** Engine whose answer is held until the test releases it, so the test can act while it "thinks". */
class HeldProvider extends FakeAnalysisProvider {
  private releases: (() => void)[] = [];
  override async play(request: PlayRequest): Promise<PlayResult> {
    this.playCalls.push(request);
    await new Promise<void>((resolve) => this.releases.push(resolve));
    await engineTurn();
    return { move: this.responseMove };
  }
  release(): void {
    for (const r of this.releases.splice(0)) r();
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitUntil(what: string, predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
/** A regression that leaves a held engine call unreleased must fail, not hang the suite. */
const HELD_TEST_TIMEOUT_MS = 5_000;

async function botBlackAfterE4(gameId: string) {
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const bot = BOT_ACCOUNTS[0]!;
  const human = 'human-player-1';
  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: human, black: bot.userId },
    rated: false,
  });
  const e4Broadcasts: Broadcast[] = [];
  const unsub = pubsub.subscribe(gameChannel(gameId), (msg) => e4Broadcasts.push(msg));
  await authority.apply(gameId, human, { kind: 'move', uci: 'e2e4' });
  unsub();
  return { pubsub, authority, router, bot, human, e4Broadcast: e4Broadcasts[0]! };
}

test('EngineBotMover: a non-owner never calls the engine, however many broadcasts arrive', async () => {
  const gameId = '00000000-0000-7000-8000-000000000020';
  const { pubsub, authority, router, e4Broadcast } = await botBlackAfterE4(gameId);
  const provider = new FakeAnalysisProvider();
  const ownership = new ScriptedOwnership();
  ownership.owns = false;
  const mover = new EngineBotMover({ authority, router, pubsub, provider, ownership });

  mover.registerGame(gameId);
  await flush();
  // Duplicate delivery of the same move broadcast: each one wakes the mover, none may compute.
  pubsub.publish(gameChannel(gameId), e4Broadcast);
  pubsub.publish(gameChannel(gameId), e4Broadcast);
  await flush();

  assert.equal(provider.playCalls.length, 0, 'non-owner must not compute from its cached copy');
  assert.equal(ownership.prepareCalls, 3, 'ownership is asked once per wake-up: registration + two broadcasts');
  assert.equal(authority.getState(gameId).ply, 1, 'no command submitted');
  mover.stop();
});

test('EngineBotMover: a result computed before ownership was lost is dropped', { timeout: HELD_TEST_TIMEOUT_MS }, async () => {
  const gameId = '00000000-0000-7000-8000-000000000021';
  const { pubsub, authority, router } = await botBlackAfterE4(gameId);
  const provider = new HeldProvider();
  const ownership = new ScriptedOwnership();
  const mover = new EngineBotMover({ authority, router, pubsub, provider, ownership });

  mover.registerGame(gameId);
  await flush();
  assert.equal(provider.playCalls.length, 1, 'owner started thinking');
  ownership.owns = false; // lease lost mid-think
  provider.release();
  await mover.attemptMove(gameId);

  assert.equal(authority.getState(gameId).ply, 1, 'stale result must not be submitted');
  mover.stop();
});

test('EngineBotMover: a result for a position the game has left is dropped, and the new position is computed', { timeout: HELD_TEST_TIMEOUT_MS }, async () => {
  const gameId = '00000000-0000-7000-8000-000000000022';
  const { pubsub, authority, router, bot, human } = await botBlackAfterE4(gameId);
  const provider = new HeldProvider();
  provider.responseMove = 'g8f6';
  const ownership = new ScriptedOwnership();
  const mover = new EngineBotMover({ authority, router, pubsub, provider, ownership });

  mover.registerGame(gameId);
  await flush();
  const computedFor = provider.playCalls[0]!.fen;
  // While it thinks, the game advances elsewhere (worst case: ownership moved away and back, and
  // this node's copy was rehydrated) — 1...Nc6 2.Nf3, and the bot is to move again.
  await authority.apply(gameId, bot.userId, { kind: 'move', uci: 'b8c6' });
  await authority.apply(gameId, human, { kind: 'move', uci: 'g1f3' });
  provider.release(); // the ply-1 answer (…Nf6) arrives: legal now, but computed for ply 1
  await waitUntil('a fresh computation', () => provider.playCalls.length === 2);

  assert.equal(authority.getState(gameId).ply, 3, 'the ply-1 answer must not be applied at ply 3');
  assert.equal(provider.playCalls.length, 2, 'the change queued a fresh computation');
  assert.notEqual(provider.playCalls[1]!.fen, computedFor, 'recomputed from the current position');
  provider.release();
  await mover.attemptMove(gameId);
  assert.equal(authority.getState(gameId).ply, 4, 'the fresh answer is applied');
  mover.stop();
});

test('EngineBotMover: a result that arrives after the game ended is dropped and bot work stops', { timeout: HELD_TEST_TIMEOUT_MS }, async () => {
  const gameId = '00000000-0000-7000-8000-000000000023';
  const { pubsub, authority, router, human } = await botBlackAfterE4(gameId);
  const provider = new HeldProvider();
  const ownership = new ScriptedOwnership();
  const mover = new EngineBotMover({ authority, router, pubsub, provider, ownership });

  mover.registerGame(gameId);
  await flush();
  await authority.apply(gameId, human, { kind: 'resign' });
  assert.equal(pubsub.subscriberCount(gameChannel(gameId)), 0, 'terminal broadcast unregisters');
  provider.release();
  await mover.attemptMove(gameId);

  assert.equal(authority.getState(gameId).ply, 1, 'no move after the game ended');
  assert.equal(provider.playCalls.length, 1, 'no further computation');
  mover.stop();
});

test('EngineBotMover: the terminal broadcast stops bot work even when the local copy never saw the end', async () => {
  const gameId = '00000000-0000-7000-8000-000000000024';
  const { pubsub, authority, router } = await botBlackAfterE4(gameId);
  const provider = new FakeAnalysisProvider();
  const ownership = new ScriptedOwnership();
  ownership.owns = false;
  const mover = new EngineBotMover({ authority, router, pubsub, provider, ownership });

  mover.registerGame(gameId);
  await flush();
  // The owner's game ended; this node's copy still says ply 1 and in progress.
  pubsub.publish(gameChannel(gameId), {
    t: 'ended', gameId, result: '1-0', termination: 'resignation', winner: 'w', serverTs: Date.now(),
  });

  assert.equal(pubsub.subscriberCount(gameChannel(gameId)), 0, 'unsubscribed on ended');
  assert.equal(provider.playCalls.length, 0);
  mover.stop();
});

test('EngineBotMover: a lease that lapses mid-think does not strand the turn', { timeout: HELD_TEST_TIMEOUT_MS }, async () => {
  const gameId = '00000000-0000-7000-8000-000000000025';
  const { pubsub, authority, router } = await botBlackAfterE4(gameId);
  const provider = new HeldProvider();
  const ownership = new ScriptedOwnership();
  const mover = new EngineBotMover({ authority, router, pubsub, provider, ownership });

  mover.registerGame(gameId);
  await flush();
  ownership.lapseNextCheck = true; // the answer arrives just after a missed renewal
  provider.release();
  // No broadcast follows a lapse; the mover must look again on its own.
  await waitUntil('a second computation', () => provider.playCalls.length === 2);
  assert.equal(authority.getState(gameId).ply, 1, 'the first answer was dropped');
  provider.release();
  await waitUntil('the bot to move', () => authority.getState(gameId).ply === 2);
  mover.stop();
});

test('EngineBotMover: a non-owner re-checks, so a game orphaned by its owner still gets its move', async () => {
  const gameId = '00000000-0000-7000-8000-000000000026';
  const { pubsub, authority, router } = await botBlackAfterE4(gameId);
  const provider = new FakeAnalysisProvider();
  const ownership = new ScriptedOwnership();
  ownership.owns = false; // another pod owns it...
  const mover = new EngineBotMover({ authority, router, pubsub, provider, ownership, nonOwnerRecheckMs: 20 });

  mover.registerGame(gameId);
  await flush();
  assert.equal(provider.playCalls.length, 0);
  ownership.owns = true; // ...until its lease expires. Nothing is broadcast when that happens.
  await waitUntil('the bot to move', () => authority.getState(gameId).ply === 2);
  mover.stop();
});

test('EngineBotMover: a non-owner that missed the ended broadcast unregisters on re-check', async () => {
  const gameId = '00000000-0000-7000-8000-000000000027';
  const log = new InMemoryEventLog();
  const bot = BOT_ACCOUNTS[0]!;
  const human = 'human-player-1';
  // The owner and this replica share the durable log but not the broadcast, which is lost.
  const owner = new GameAuthority(new InMemoryPubSub(), () => Date.now(), log);
  await owner.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: human, black: bot.userId },
    rated: false,
  });
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => Date.now(), log);
  await authority.ensureLoaded(gameId);
  const ownership = new ScriptedOwnership();
  ownership.owns = false;
  const provider = new FakeAnalysisProvider();
  const mover = new EngineBotMover({
    authority, router: new LocalCommandRouter(authority), pubsub, provider, ownership, nonOwnerRecheckMs: 20,
  });

  mover.registerGame(gameId);
  await flush();
  await owner.apply(gameId, human, { kind: 'resign' });
  assert.equal(pubsub.subscriberCount(gameChannel(gameId)), 1, 'nothing reached this replica');

  await waitUntil('the mover to let go', () => pubsub.subscriberCount(gameChannel(gameId)) === 0);
  assert.equal(provider.playCalls.length, 0);
  mover.stop();
});

test('EngineBotMover: joining an already-finished game on a non-owner does not keep it registered', async () => {
  const gameId = '00000000-0000-7000-8000-000000000028';
  const { pubsub, authority, router, human } = await botBlackAfterE4(gameId);
  await authority.apply(gameId, human, { kind: 'resign' });
  const ownership = new ScriptedOwnership();
  ownership.owns = false; // the owner keeps its lease on finished games
  const mover = new EngineBotMover({ authority, router, pubsub, provider: new FakeAnalysisProvider(), ownership });

  mover.registerGame(gameId);
  await flush();

  assert.equal(pubsub.subscriberCount(gameChannel(gameId)), 0, 'unregistered from its own finished copy');
  assert.equal(ownership.prepareCalls, 0, 'no ownership traffic for a finished game');
  mover.stop();
});
