import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { GameController, type GameMetadataState } from '../src/app/game-controller.js';
import { createI18nManager } from '../src/i18n/index.js';
import type { StateView, WsColor } from '../src/net/ws-protocol.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

/**
 * The starting-position id reaching the client, and surviving a fresh snapshot.
 *
 * A client learns the id from the authoritative snapshot, and every later snapshot — a resync here, a
 * reconnect elsewhere — carries it again. The failure worth catching is a game that describes itself
 * as a different arrangement, or as none, once the board has moved on from the start.
 *
 * These are unit tests over `GameController`'s metadata projection, driven by hand-built snapshots.
 * The socket-drop-and-resume path is a different thing and is covered end to end against a real
 * `GameAuthority` in `e2e-chess960-live-loop.test.ts`. ADR-0137.
 */

const SP700_FEN = 'rbqknnbr/pppppppp/8/8/8/8/PPPPPPPP/RBQKNNBR w KQkq - 0 1';

/**
 * A controller wired to a fake socket, collecting every metadata projection it emits.
 *
 * The scheduler is manual so a reconnect fires exactly when a test says so rather than on a timer,
 * and the other callbacks are no-ops because these tests assert only on `onMetadata`.
 */
function setup() {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    now: () => 0,
    rng: () => 0,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync = new GameSync(client, { gameId: 'g1', token: 'token-u1' });
  const metadatas: GameMetadataState[] = [];
  const controller = new GameController({
    gameSync: sync,
    i18n: createI18nManager(),
    callbacks: {
      onPosition: () => {},
      onTurn: () => {},
      onClock: () => {},
      onStatus: () => {},
      onMetadata: (m) => { metadatas.push(m); },
    },
  });
  return { factory, scheduler, sync, controller, metadatas };
}

/**
 * An authoritative snapshot carrying `chess960StartId`, for driving the controller.
 *
 * `variant` and the id are separate parameters rather than derived from each other, so a test can
 * build the disagreeing combinations the client has to survive.
 */
function stateView(
  variant: StateView['variant'],
  fen: string,
  chess960StartId: number | null,
  ply = 0,
  turn: WsColor = 'w',
): StateView {
  return {
    gameId: 'g1',
    variant,
    players: { white: 'u1', black: 'u2' },
    timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    fen,
    fenHash: `h${ply}`,
    ply,
    turn,
    clock: { w: 60_000, b: 60_000 },
    turnStartedAt: null,
    status: { over: false },
    drawOffer: null,
    moves: [],
    legalMoves: {},
    chess960StartId,
  };
}

test('the starting-position id arrives with the snapshot', () => {
  const { factory, sync, controller, metadatas } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView('chess960', SP700_FEN, 700),
  });

  assert.equal(metadatas.at(-1)?.variant, 'chess960');
  assert.equal(metadatas.at(-1)?.chess960StartId, 700);
  controller.stop();
  sync.stop();
});

test('every other variant reports no starting position', () => {
  const { factory, sync, controller, metadatas } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView('standard', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', null),
  });

  assert.equal(metadatas.at(-1)?.chess960StartId, null);
  controller.stop();
  sync.stop();
});

test('a fresh snapshot on the live socket reports the same arrangement', () => {
  // A `state` message on the open socket, which is the resync path — *not* a reconnect: this emits on
  // the same socket rather than closing it and opening a replacement. The distinction was worth making
  // rather than blurring, because the two deliver the same message for different reasons and only one
  // of them is exercised here. The genuine socket-drop-and-resume path is covered end to end against a
  // real `GameAuthority` in `e2e-chess960-live-loop.test.ts`. Raised in the CodeRabbit review of PR #12.
  //
  // What this pins either way: the board comes from `fen` and the identity from the id, and a fresh
  // snapshot has to still describe the game that was being played.
  const { factory, sync, controller, metadatas } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView('chess960', SP700_FEN, 700),
  });
  assert.equal(metadatas.at(-1)?.chess960StartId, 700);

  // The game has moved on, and the fresh snapshot carries the current position — but the same start.
  const movedOn = 'rbqknnbr/pppppp1p/6p1/8/4P3/8/PPPP1PPP/RBQKNNBR w KQkq - 0 2';
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView('chess960', movedOn, 700, 2) });

  assert.equal(
    metadatas.at(-1)?.chess960StartId,
    700,
    'the arrangement the game began from does not change when the board does',
  );
  controller.stop();
  sync.stop();
});

test('a changed starting-position id is reported rather than swallowed', () => {
  // Metadata callbacks only fire when something changed, and the id had to be added to that
  // comparison. Without it a client would keep displaying the first game's arrangement — which is a
  // stale-state bug that no board rendering would reveal, since the FEN would be right.
  const { factory, sync, controller, metadatas } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView('chess960', SP700_FEN, 700),
  });
  const countBefore = metadatas.length;

  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView('chess960', SP700_FEN, 701) });

  assert.ok(metadatas.length > countBefore, 'the change produced a metadata update');
  assert.equal(metadatas.at(-1)?.chess960StartId, 701);
  controller.stop();
  sync.stop();
});

test('a snapshot with no chess960StartId at all normalises to null', () => {
  // `decodeServer` validates the message discriminator and casts the rest, so a frame from an older
  // server — or any path that does not populate the field — can carry no `chess960StartId` despite the
  // type declaring it. The controller is where that becomes `null` (`?? null`), and this pins it,
  // because the consumer downstream renders the plain variant label on `null` and would otherwise
  // print "Chess960 · #undefined".
  //
  // Pinned here rather than guarded again in `game-mount`: normalising once, at the boundary where the
  // wire becomes a typed projection, is what makes every consumer's `=== null` correct. A second check
  // downstream would be a guard with nothing left to catch. Raised in the Qodo review of PR #12.
  const { factory, sync, controller, metadatas } = setup();
  controller.start();
  sync.start();
  factory.last.open();

  const withoutField = { ...stateView('chess960', SP700_FEN, 700) } as Record<string, unknown>;
  delete withoutField['chess960StartId'];

  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: withoutField as unknown as StateView,
  });

  assert.equal(metadatas.at(-1)?.variant, 'chess960');
  assert.equal(
    metadatas.at(-1)?.chess960StartId,
    null,
    'absent on the wire becomes null, never undefined',
  );
  controller.stop();
  sync.stop();
});

test('a reconnect rehydrates the same arrangement', () => {
  // A genuine socket drop and replacement, not a resync on the live socket: close the first socket,
  // let the scheduler fire the reconnect, open the replacement, and deliver *its* `joined` snapshot.
  //
  // Added alongside the resync case above rather than replacing it — the two deliver the same message
  // for different reasons, and CodeRabbit's point on PR #12 was that only one of them was covered
  // here. The equivalent path against a real `GameAuthority`, including the client emitting its own
  // `resume`, is in `e2e-chess960-live-loop.test.ts`.
  const { factory, scheduler, sync, controller, metadatas } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView('chess960', SP700_FEN, 700),
  });
  assert.equal(metadatas.at(-1)?.chess960StartId, 700);

  // Drop the socket and let the client reconnect.
  assert.equal(factory.sockets.length, 1, 'one socket so far');
  factory.last.serverClose(1006, '', false);
  scheduler.runNext();
  // Asserted, not assumed: without a genuine reconnect `factory.last` would still be the *first*
  // socket and the emit below would succeed anyway, so the test would pass while proving nothing.
  assert.equal(factory.sockets.length, 2, 'the client opened a replacement socket');
  factory.last.open();

  // The replacement socket's own snapshot, at a later ply.
  const movedOn = 'rbqknnbr/pppppp1p/6p1/8/4P3/8/PPPP1PPP/RBQKNNBR w KQkq - 0 2';
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView('chess960', movedOn, 700, 2),
  });

  assert.equal(metadatas.at(-1)?.variant, 'chess960');
  assert.equal(
    metadatas.at(-1)?.chess960StartId,
    700,
    'the game came back from a dropped socket describing the same arrangement',
  );
  controller.stop();
  sync.stop();
});
