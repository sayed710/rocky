import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { createGameDocument, makeFinishedState, makeState } from './support/analysis-fixtures.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function setup(role: 'white' | 'spectator' = 'white', finished = false) {
  const sockets = new FakeSocketFactory();
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: new FakeTransport((request) => request.url.endsWith('/v1/capabilities')
      ? json(200, { capabilities: { gameReview: true }, gameReviewVariants: ['standard'] })
      : json(404, {})),
  });
  const { doc, elements } = createGameDocument();
  const mounted = mountGame({
    doc,
    boardEl: elements.get('board')! as unknown as HTMLElement,
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
  sockets.last.open();
  sockets.last.emit({
    t: 'joined', gameId: 'g-test-1', role,
    state: finished ? makeFinishedState(FEN) : makeState(FEN),
  });
  return {
    elements, socket: sockets.last,
    dispose: () => {
      mounted.analysis.dispose();
      mounted.connectivity.dispose();
      mounted.controller.dispose();
      app.dispose();
    },
  };
}

test('live player keeps actions during disconnect and a pending action', () => {
  const game = setup();
  try {
    const actions = game.elements.get('game-actions')!;
    assert.equal(actions.hidden, false);
    game.elements.get('action-offer-draw')!.click();
    assert.equal(game.elements.get('action-offer-draw')!.disabled, true);
    assert.equal(actions.hidden, false, 'an in-flight action is still a live game');
    game.socket.serverClose();
    assert.equal(actions.hidden, false, 'lost transport is not a terminal game state');
  } finally {
    game.dispose();
  }
});

for (const ending of [
  { result: '1-0', termination: 'resignation', winner: 'w' },
  { result: '1/2-1/2', termination: 'agreement', winner: null },
  { result: '1-0', termination: 'checkmate', winner: 'w' },
  { result: '*', termination: 'no_show', winner: null },
] as const) {
  test(`terminal ${ending.termination} hides player actions`, () => {
    const game = setup();
    try {
      assert.equal(game.elements.get('game-actions')!.hidden, false);
      game.socket.emit({ t: 'ended', gameId: 'g-test-1', ...ending, serverTs: 1 });
      assert.equal(game.elements.get('game-actions')!.hidden, true);
      assert.equal(game.elements.get('draw-offer-received')!.hidden, true);
      assert.match(game.elements.get('status')!.textContent, /wins|draw|no result|aborted/i);
    } finally {
      game.dispose();
    }
  });
}

test('initial authoritative terminal state hides actions and retains post-game review', async () => {
  const game = setup('white', true);
  try {
    assert.equal(game.elements.get('game-actions')!.hidden, true);
    for (let i = 0; i < 20 && game.elements.get('game-review')!.hidden; i++) await Promise.resolve();
    assert.equal(game.elements.get('game-review')!.hidden, false);
    assert.match(game.elements.get('status')!.textContent, /wins|checkmate/i);
  } finally {
    game.dispose();
  }
});

for (const action of ['resign', 'abort'] as const) {
  test(`terminal state closes open ${action} confirmation and blocks stale submission`, () => {
    const game = setup();
    try {
      const confirm = game.elements.get(`confirm-${action}`)!;
      game.elements.get(`action-${action}`)!.click();
      assert.equal(confirm.hidden, false);
      const sent = game.socket.sent.length;
      game.socket.emit({ t: 'ended', gameId: 'g-test-1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 1 });
      assert.equal(confirm.hidden, true);
      assert.equal(game.elements.get(`confirm-${action}-yes`)!.disabled, true);
      assert.equal(game.elements.get(`confirm-${action}-no`)!.disabled, true);
      assert.equal(game.elements.get('game-actions')!.hidden, true);
      assert.equal(game.elements.get('status')!.focused, true);
      game.elements.get(`confirm-${action}-yes`)!.click();
      assert.equal(game.socket.sent.length, sent);
    } finally {
      game.dispose();
    }
  });
}

test('received draw offer disappears at terminal state', () => {
  const game = setup();
  try {
    game.socket.emit({ t: 'state', gameId: 'g-test-1', state: { ...makeState(FEN), drawOffer: 'b' } });
    assert.equal(game.elements.get('draw-offer-received')!.hidden, false);
    game.socket.emit({ t: 'ended', gameId: 'g-test-1', result: '1/2-1/2', termination: 'stalemate', winner: null, serverTs: 1 });
    assert.equal(game.elements.get('draw-offer-received')!.hidden, true);
    assert.equal(game.elements.get('game-actions')!.hidden, true);
  } finally {
    game.dispose();
  }
});

test('spectator never sees player actions on live or terminal state', () => {
  const game = setup('spectator');
  try {
    assert.equal(game.elements.get('game-actions')!.hidden, true);
    game.socket.emit({ t: 'ended', gameId: 'g-test-1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 1 });
    assert.equal(game.elements.get('game-actions')!.hidden, true);
  } finally {
    game.dispose();
  }
});

test('Download PGN is absent on a live game and appears for players and spectators at the end', () => {
  for (const role of ['white', 'spectator'] as const) {
    const game = setup(role);
    try {
      assert.equal(game.elements.get('game-export')!.hidden, true, `${role}: no PGN control during play`);
      game.socket.emit({ t: 'ended', gameId: 'g-test-1', result: '0-1', termination: 'resignation', winner: 'b', serverTs: 1 });
      assert.equal(game.elements.get('game-export')!.hidden, false, `${role}: PGN offered once over`);
    } finally {
      game.dispose();
    }
  }
});

test('joining an already finished game offers Download PGN immediately', () => {
  const game = setup('spectator', true);
  try {
    assert.equal(game.elements.get('game-export')!.hidden, false);
    assert.equal(game.elements.get('game-pgn-download')!.getAttribute('aria-disabled'), 'false');
  } finally {
    game.dispose();
  }
});
