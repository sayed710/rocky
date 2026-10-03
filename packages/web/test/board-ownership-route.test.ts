import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import type { StateView } from '../src/net/ws-protocol.js';
import { createGameDocument, makeFinishedState, makeState } from './support/analysis-fixtures.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';

/**
 * The game route's board ownership: who may move which pieces, driven only by the authoritative
 * `joined` role and game status. Gestures go through the real `BoardView` click handler, and a move
 * counts as submitted when the route calls `controller.submitMove` — before `GameSync` gets a chance
 * to drop it, so a spectator's attempt cannot hide behind the server-side guard.
 */

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const BOARD_PX = 800;

type Role = 'white' | 'black' | 'spectator';

function live(fen: string, turn: 'w' | 'b', legalMoves: StateView['legalMoves']): StateView {
  return { ...makeState(fen, turn === 'w' ? 0 : 1, turn), legalMoves };
}

function setup(options: { open?: boolean } = {}) {
  const sockets = new FakeSocketFactory();
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: new FakeTransport(() => json(404, {})),
  });
  const { doc, elements } = createGameDocument();
  const boardEl = elements.get('board')!;
  Object.assign(boardEl, { getBoundingClientRect: () => ({ left: 0, top: 0, width: BOARD_PX, height: BOARD_PX }) });
  // The fake document has no text nodes; without one the board writes its status as plain text.
  Object.defineProperty(elements.get('status')!, 'ownerDocument', { value: undefined });
  const mounted = mountGame({
    doc,
    boardEl: boardEl as unknown as HTMLElement,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => 'token',
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
  return {
    open: () => sockets.last.open(),
    elements, mounted, submitted, enabled, click, cellAttr, selected, premoves, moveFrames, join, sync, orientation,
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
