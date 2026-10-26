import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import type { StateView } from '../src/net/ws-protocol.js';
import { createGameDocument, makeFinishedState, makeState } from './support/analysis-fixtures.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';
import { adoptGameSession } from './support/game-session.js';

/**
 * The game route's board ownership: who may move which pieces, driven only by the authoritative
 * `joined` role and game status. Gestures go through the real `BoardView` click handler, and a move
 * counts as submitted when the route calls `controller.submitMove` — before `GameSync` gets a chance
 * to drop it, so a spectator's attempt cannot hide behind the server-side guard.
 */

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const AFTER_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
const BOARD_PX = 800;

type Role = 'white' | 'black' | 'spectator';

function live(fen: string, turn: 'w' | 'b', legalMoves: StateView['legalMoves']): StateView {
  return { ...makeState(fen, turn === 'w' ? 0 : 1, turn), legalMoves };
}

function setup(options: { open?: boolean; userId?: string; scheduler?: ManualScheduler } = {}) {
  const sockets = new FakeSocketFactory();
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: new FakeTransport(() => json(404, {})),
  });
  const { doc, elements } = createGameDocument();
  adoptGameSession(app.api.session, 'token', options.userId ?? 'u1');
  const boardEl = elements.get('board')!;
  Object.assign(boardEl, { getBoundingClientRect: () => ({ left: 0, top: 0, width: BOARD_PX, height: BOARD_PX }) });
  // The fake document has no text nodes; without one the board writes its status as plain text.
  Object.defineProperty(elements.get('status')!, 'ownerDocument', { value: undefined });
  const mounted = mountGame({
    doc,
    boardEl: boardEl as unknown as HTMLElement,
    gameId: 'g-test-1',
    createGameSync: (syncOptions) =>
      app.createGameSync(options.scheduler ? { ...syncOptions, scheduler: options.scheduler } : syncOptions),
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'token',
    initialSessionId: 'u1',
    restorePromise: Promise.resolve(null),
    i18n: app.i18n,
  });
  const submitted: string[] = [];
  const submit = mounted.controller.submitMove.bind(mounted.controller);
  mounted.controller.submitMove = (uci: string) => {
    submitted.push(uci);
    return submit(uci);
  };
  const enabled: boolean[] = [];
  const setInputEnabled = mounted.board.setInputEnabled;
  mounted.board.setInputEnabled = (on: boolean) => {
    enabled.push(on);
    setInputEnabled(on);
  };
  if (options.open !== false) sockets.last.open();

  const orientation = (): 'white' | 'black' => mounted.board.view.orientationColor;
  const click = (sq: string): void => {
    const file = sq.charCodeAt(0) - 97;
    const rank = Number(sq[1]) - 1;
    const cell = BOARD_PX / 8;
    const col = orientation() === 'white' ? file : 7 - file;
    const row = orientation() === 'white' ? 7 - rank : rank;
    for (const fn of boardEl.listeners['click'] ?? []) {
      fn({ clientX: col * cell + cell / 2, clientY: row * cell + cell / 2 } as unknown as Event);
    }
  };
  const cellAttr = (sq: string, attr: string): string | null => {
    const match = new RegExp(`data-square="${sq}"[^>]*?${attr}="([^"]*)"`).exec(boardEl.innerHTML);
    return match?.[1] ?? null;
  };
  const selected = (): string[] =>
    [...boardEl.innerHTML.matchAll(/data-square="(\w\d)"[^>]*?aria-selected="true"/g)].map((m) => m[1]!);
  const premoves = (): string[] =>
    [...boardEl.innerHTML.matchAll(/class="[^"]*cb-premove[^"]*"[^>]*?data-square="(\w\d)"/g)].map((m) => m[1]!);
  const moveFrames = (): string[] =>
    sockets.last.sent.map((f) => JSON.parse(f) as { t: string; uci?: string }).filter((f) => f.t === 'move').map((f) => f.uci!);
  const join = (role: Role, state: StateView): void => {
    sockets.last.emit({ t: 'joined', gameId: 'g-test-1', role, state });
  };
  const sync = (state: StateView): void => {
    sockets.last.emit({ t: 'state', gameId: 'g-test-1', state });
  };
  const emit = (msg: unknown): void => {
    sockets.last.emit(msg);
  };
  return {
    logout: () => {
      mounted.onLogoutRequested();
      app.api.session.reset(false);
      mounted.onSessionChange(null);
    },
    changeAccount: (userId: string) => {
      adoptGameSession(app.api.session, 'token', userId);
      mounted.onSessionChange({ handle: userId, userId });
      sockets.last.open();
    },
    open: () => sockets.last.open(),
    elements, mounted, submitted, enabled, click, cellAttr, selected, premoves, moveFrames, join, sync, emit, sockets, orientation,
    feedback: () => elements.get('move-feedback')?.innerHTML ?? '',
    dispose: () => {
      mounted.dispose?.();
      mounted.analysis.dispose();
      mounted.connectivity.dispose();
      mounted.controller.dispose();
      app.dispose();
    },
  };
}

test('route: logout immediately disables gestures and a fresh spectator join remains read-only', () => {
  const r = setup();
  try {
    r.join('white', live(START, 'w', { e2: ['e4'] }));
    r.logout();
    r.click('e2'); r.click('e4');
    assert.deepEqual(r.submitted, []);
    assert.deepEqual(r.selected(), []);
    r.open(); r.join('spectator', live(START, 'w', { e2: ['e4'] }));
    r.click('e2'); r.click('e4');
    assert.deepEqual(r.submitted, []);
    assert.equal(r.enabled.at(-1), false);
  } finally { r.dispose(); }
});

test('route: black-to-white account adoption restores white orientation', () => {
  const r = setup({ userId: 'u2' });
  try {
    r.join('black', live(START, 'w', {}));
    assert.equal(r.orientation(), 'black');
    r.changeAccount('u1');
    r.join('white', live(START, 'w', {}));
    assert.equal(r.orientation(), 'white');
  } finally { r.dispose(); }
});

test('route: spectator resolution preserves a manually chosen orientation', () => {
  const r = setup();
  try {
    r.mounted.board.setOrientation('black');
    r.join('spectator', live(START, 'w', {}));
    assert.equal(r.orientation(), 'black');
  } finally { r.dispose(); }
});

test('route: before the role is known the board takes no gesture and is never enabled', () => {
  const r = setup();
  try {
    r.click('e2');
    r.click('e4');
    assert.deepEqual(r.selected(), [], 'no selection before joined');
    assert.deepEqual(r.premoves(), [], 'no premove before joined');
    assert.deepEqual(r.submitted, []);
    assert.equal(r.feedback(), '', 'no rejection either: nobody owns the pieces yet');
    assert.ok(!r.enabled.includes(true), `input never enabled before join (calls: ${r.enabled.join(',')})`);
  } finally {
    r.dispose();
  }
});

test('route: straight after mount, before the socket even opens, the board takes no gesture', () => {
  const r = setup({ open: false });
  try {
    r.click('e2');
    r.click('e4');
    assert.deepEqual(r.selected(), []);
    assert.deepEqual(r.premoves(), []);
    assert.deepEqual(r.submitted, []);
    r.open();
    r.click('e2');
    assert.deepEqual(r.selected(), [], 'still nobody once connected but not joined');
  } finally {
    r.dispose();
  }
});

test('route: a spectator selects nothing and submits nothing, on either side to move', () => {
  const r = setup();
  try {
    r.join('spectator', live(START, 'w', { e2: ['e3', 'e4'] }));
    for (const [from, to] of [['e2', 'e4'], ['e7', 'e5']] as const) {
      r.click(from);
      assert.deepEqual(r.selected(), [], `${from} not selectable by a spectator`);
      r.click(to);
    }
    assert.deepEqual(r.submitted, [], 'the route never asked to submit a spectator move');
    assert.deepEqual(r.moveFrames(), []);
    assert.deepEqual(r.premoves(), []);
    assert.equal(r.feedback(), '', 'spectator blocking is not reported as an illegal move');
    assert.ok(!r.enabled.includes(true), `spectator input never enabled (calls: ${r.enabled.join(',')})`);
  } finally {
    r.dispose();
  }
});

test('route: a spectator stays read-only across sync updates and turn changes', () => {
  const r = setup();
  try {
    r.join('spectator', live(START, 'w', { e2: ['e3', 'e4'] }));
    r.sync(live(AFTER_E4, 'b', { e7: ['e6', 'e5'] }));
    r.click('e7');
    r.click('e5');
    r.sync(live(AFTER_E4, 'b', { e7: ['e6', 'e5'] }));
    r.click('d2');
    r.click('d4');
    assert.deepEqual(r.selected(), []);
    assert.deepEqual(r.submitted, []);
    assert.deepEqual(r.premoves(), []);
    assert.ok(!r.enabled.includes(true));
  } finally {
    r.dispose();
  }
});

test('route: the white player moves a white piece on their turn', () => {
  const r = setup();
  try {
    r.join('white', live(START, 'w', { e2: ['e3', 'e4'] }));
    assert.equal(r.enabled.at(-1), true, 'a live player gets input');
    r.click('e2');
    assert.deepEqual(r.selected(), ['e2']);
    r.click('e4');
    assert.deepEqual(r.submitted, ['e2e4']);
    assert.deepEqual(r.moveFrames(), ['e2e4']);
  } finally {
    r.dispose();
  }
});

test('route: off-turn, the white player cannot select or premove Black (the side to move)', () => {
  const r = setup();
  try {
    r.join('white', live(AFTER_E4, 'b', { e7: ['e6', 'e5'] }));
    r.click('e7');
    assert.deepEqual(r.selected(), [], 'the opponent-coloured side to move is not ours');
    r.click('e5');
    assert.deepEqual(r.premoves(), []);
    assert.deepEqual(r.submitted, []);

    r.click('d2');
    assert.deepEqual(r.selected(), ['d2'], 'our own piece is still selectable off-turn');
    r.click('d4');
    assert.deepEqual(r.premoves().sort(), ['d2', 'd4'], 'an own-colour premove queues');
    assert.deepEqual(r.submitted, [], 'a premove is not a submission');
  } finally {
    r.dispose();
  }
});

test('route: off-turn, the black player cannot select or premove White (the side to move)', () => {
  const r = setup();
  try {
    r.join('black', live(START, 'w', { e2: ['e3', 'e4'] }));
    assert.equal(r.orientation(), 'black');
    r.click('e2');
    assert.deepEqual(r.selected(), []);
    r.click('e4');
    assert.deepEqual(r.premoves(), []);
    assert.deepEqual(r.submitted, []);

    r.click('e7');
    assert.deepEqual(r.selected(), ['e7']);
    r.click('e5');
    assert.deepEqual(r.premoves().sort(), ['e5', 'e7']);
    assert.deepEqual(r.submitted, []);
  } finally {
    r.dispose();
  }
});

test('route: joining a finished game never enables input, in either callback order', () => {
  for (const role of ['white', 'black', 'spectator'] as const) {
    const r = setup();
    try {
      r.join(role, makeFinishedState(START));
      assert.ok(!r.enabled.includes(true), `${role}: no transient enable (calls: ${r.enabled.join(',')})`);
      r.click(role === 'black' ? 'e7' : 'e2');
      assert.deepEqual(r.selected(), []);
      assert.deepEqual(r.submitted, []);
    } finally {
      r.dispose();
    }
  }
});

test('route: once finished, a later live-looking sync never re-enables the board', () => {
  const r = setup();
  try {
    r.join('white', live(START, 'w', { e2: ['e3', 'e4'] }));
    r.sync(makeFinishedState(START));
    assert.equal(r.enabled.at(-1), false);
    r.sync(live(START, 'w', { e2: ['e3', 'e4'] }));
    r.click('e2');
    r.click('e4');
    assert.deepEqual(r.selected(), []);
    assert.deepEqual(r.submitted, []);
    assert.equal(r.enabled.at(-1), false, 'finished wins');
  } finally {
    r.dispose();
  }
});

test('route: a Chess960 game keeps the same ownership boundary', () => {
  const fen = 'rbqknnbr/1ppppp2/p5pp/8/2P5/2Q5/PPBPPPPP/R2KNNBR b KQkq - 0 4';
  const r = setup();
  try {
    r.join('white', { ...live(fen, 'b', { b7: ['b6', 'b5'] }), variant: 'chess960', chess960StartId: 700 });
    r.click('b7');
    assert.deepEqual(r.selected(), [], 'Black is to move but is not ours');
    r.click('d1');
    assert.deepEqual(r.selected(), ['d1']);
    assert.deepEqual(r.submitted, []);
  } finally {
    r.dispose();
  }
});

test('route: gap recovery lifecycle disables input, clears premoves, manages retry, and restores gestures on target sync', () => {
  const scheduler = new ManualScheduler();
  const r = setup({ scheduler, userId: 'u1' });
  try {
    const players = { white: 'u1', black: 'u2' };
    const move1 = { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' as const };
    const move2 = { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' as const };
    const move3 = { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' as const };

    const stateFloor1: StateView = {
      ...makeState(AFTER_E4, 1, 'b', [move1], players),
      legalMoves: { e7: ['e6', 'e5'], d7: ['d6', 'd5'] },
    };
    const partial2: StateView = {
      ...makeState(AFTER_E5, 2, 'w', [move1, move2], players),
      legalMoves: { g1: ['f3', 'e2'] },
    };
    const sufficient3: StateView = {
      ...makeState(AFTER_NF3, 3, 'b', [move1, move2, move3], players),
      legalMoves: { b8: ['c6', 'a6'], g8: ['f6'] },
    };

    r.join('white', stateFloor1);
    assert.equal(r.enabled.at(-1), true, 'white player input enabled at floor 1');

    // Pre-gap: White is off-turn; own-colour premove queues.
    r.click('d2');
    assert.deepEqual(r.selected(), ['d2']);
    r.click('d4');
    assert.deepEqual(r.premoves().sort(), ['d2', 'd4']);
    assert.deepEqual(r.submitted, []);

    // Server sends move ply 3 while client is at ply 1 (floor 1 -> ply 3 jump).
    r.emit({
      t: 'move',
      gameId: 'g-test-1',
      ply: 3,
      uci: 'g1f3',
      san: 'Nf3',
      by: 'w',
      clock: { w: 60000, b: 60000 },
      serverTs: 1000,
      fenHash: 'h3',
      legalMoves: { b8: ['c6', 'a6'], g8: ['f6'], d7: ['d6', 'd5'] },
    });

    // Recovery detected: pre-gap premove and selection clear; board input disabled.
    assert.deepEqual(r.premoves(), [], 'pre-gap premove cleared when recovery detected');
    assert.deepEqual(r.selected(), [], 'pre-gap selection cleared when recovery detected');
    assert.equal(r.enabled.at(-1), false, 'board input disabled during recovery');

    // No selections, premoves, or submissions under flight.
    r.click('d2');
    r.click('d4');
    assert.deepEqual(r.selected(), []);
    assert.deepEqual(r.premoves(), []);
    assert.deepEqual(r.submitted, []);

    // Expected recovery scheduler sequence: 2000, 1000, 2000, 2000, 2000 with 5 runNext total.
    assert.equal(scheduler.nextDelayMs, 2000);
    scheduler.runNext();
    assert.equal(scheduler.nextDelayMs, 1000);
    scheduler.runNext();
    assert.equal(scheduler.nextDelayMs, 2000);
    scheduler.runNext();
    assert.equal(scheduler.nextDelayMs, 2000);
    scheduler.runNext();
    assert.equal(scheduler.nextDelayMs, 2000);
    scheduler.runNext();

    assert.equal(scheduler.pending, 0, '0 recovery tasks remaining in scheduler after exhaustion');
    const initialResumes = r.sockets.last.sent
      .map((f) => JSON.parse(f) as { t: string })
      .filter((f) => f.t === 'resume');
    assert.equal(initialResumes.length, 3, '3 automatic resumes sent before exhaustion');

    const reconnectBtn = r.elements.get('game-reconnect')!;
    const resignBtn = r.elements.get('action-resign')!;
    const drawBtn = r.elements.get('action-offer-draw')!;
    const claimBtn = r.elements.get('action-claim-flag')!;
    assert.ok(reconnectBtn, 'game-reconnect element exists');
    assert.ok(resignBtn, 'action-resign element exists');
    assert.ok(drawBtn, 'action-offer-draw element exists');
    assert.ok(claimBtn, 'action-claim-flag element exists');

    assert.equal(reconnectBtn.hidden, false, 'retry button is visible upon exhaustion');
    assert.equal(resignBtn.disabled, true, 'resign button disabled during recovery');
    assert.equal(drawBtn.disabled, true, 'draw offer button disabled during recovery');
    assert.equal(claimBtn.disabled, true, 'claim flag button disabled during recovery');

    // No selections, premoves, or submissions under exhaustion.
    r.click('d2');
    r.click('d4');
    assert.deepEqual(r.selected(), []);
    assert.deepEqual(r.premoves(), []);
    assert.deepEqual(r.submitted, []);

    // Delayed valid partial2 arrives; insufficient to reach ply 3 so retry stays visible.
    r.sync(partial2);
    assert.equal(reconnectBtn.hidden, false, 'retry stays visible through accepted insufficient partial2');
    assert.equal(resignBtn.disabled, true);
    assert.equal(drawBtn.disabled, true);
    assert.equal(claimBtn.disabled, true);

    // Gestures still disabled while waiting for sufficient target ply 3.
    r.click('d2');
    r.click('d4');
    assert.deepEqual(r.selected(), []);
    assert.deepEqual(r.premoves(), []);
    assert.deepEqual(r.submitted, []);

    // Explicit retry triggers a 4th resume attempt and new timer.
    reconnectBtn.click();
    const resumesAfterRetry = r.sockets.last.sent
      .map((f) => JSON.parse(f) as { t: string })
      .filter((f) => f.t === 'resume');
    assert.equal(resumesAfterRetry.length, 4, 'explicit retry dispatched 4th resume');
    assert.equal(scheduler.pending, 1, 'new timer scheduled for 4th resume attempt');
    assert.equal(scheduler.nextDelayMs, 2000);

    // Delivery of sufficient3 restores clean gestures and completes recovery.
    r.sync(sufficient3);
    assert.equal(reconnectBtn.hidden, true, 'retry button hidden after full recovery');
    assert.equal(r.enabled.at(-1), true, 'board input re-enabled after full recovery');
    assert.deepEqual(r.premoves(), [], 'no queued replay from before gap');
    assert.deepEqual(r.submitted, [], 'no queued moves submitted');

    // Post-recovery gesture chooses legal own-color move at current board/turn.
    // Note: promotion coverage is absent from this route regression suite; not fabricated here.
    r.click('d2');
    assert.deepEqual(r.selected(), ['d2']);
    r.click('d4');
    assert.deepEqual(r.premoves().sort(), ['d2', 'd4']);
    assert.deepEqual(r.submitted, []);
  } finally {
    r.dispose();
  }
});
