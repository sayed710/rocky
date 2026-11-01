import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeServer,
  type StateView,
} from '../src/net/ws-protocol.js';
import { GameSync } from '../src/net/game-sync.js';
import { WsClient } from '../src/net/ws-client.js';
import { GameController } from '../src/app/game-controller.js';
import { describeOutcome } from '../src/app/explain-view.js';
import { renderEndgameVerdict } from '../src/app/endgame-view.js';
import type { EndgameAttemptResult } from '../src/api/models.js';
import { createI18nManager } from '../src/i18n/index.js';
import { createFakeDoc } from './support/localization-dom.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

function makeStateView(
  over: boolean = false,
  stateRevision?: number,
  turn: 'w' | 'b' = 'b',
  ply: number = 0,
  gameId: string = 'g1',
): StateView {
  return {
    gameId,
    variant: 'standard',
    players: { white: 'u1', black: 'u2' },
    timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    fen: '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1',
    fenHash: 'h0',
    ply,
    turn,
    clock: { w: 60_000, b: 60_000 },
    turnStartedAt: null,
    status: over
      ? { over: true, result: '1/2-1/2', termination: 'dead_position', winner: null }
      : { over: false },
    drawOffer: null,
    moves: [],
    legalMoves: turn === 'w' ? { e2: ['e4'] } : {},
    chess960StartId: null,
    ready: null,
    ...(stateRevision !== undefined ? { stateRevision } : {}),
  };
}

test('ws-protocol: decodeServer accepts valid revisioned and unrevisioned ended frames with dead_position', () => {
  const revisioned = decodeServer(
    JSON.stringify({
      t: 'ended',
      gameId: 'g1',
      result: '1/2-1/2',
      termination: 'dead_position',
      winner: null,
      serverTs: 1000,
      stateRevision: 10,
    }),
  );
  assert.equal(revisioned?.t, 'ended');
  if (revisioned?.t === 'ended') {
    assert.equal(revisioned.termination, 'dead_position');
    assert.equal(revisioned.result, '1/2-1/2');
    assert.equal(revisioned.winner, null);
    assert.equal(revisioned.stateRevision, 10);
  }

  const unrevisioned = decodeServer(
    JSON.stringify({
      t: 'ended',
      gameId: 'g1',
      result: '1/2-1/2',
      termination: 'dead_position',
      winner: null,
      serverTs: 1000,
    }),
  );
  assert.equal(unrevisioned?.t, 'ended');
  if (unrevisioned?.t === 'ended') {
    assert.equal(unrevisioned.termination, 'dead_position');
    assert.equal(unrevisioned.result, '1/2-1/2');
    assert.equal(unrevisioned.winner, null);
    assert.equal(unrevisioned.stateRevision, undefined);
  }
});

test('ws-protocol: decodeServer rejects invalid dead_position combinations across ended, snapshots, and matched resumed.missed', () => {
  // External baseline note: root's compiled immutable-baseline probe (outputs/issue124a-legacy-decoder-baseline.json)
  // established that legacy revisioned decoders reject new codes while legacy unrevisioned frames structurally pass.
  // The tests below verify current production decodeServer trust boundaries.

  // 1. Revisioned ended: decisive or abort results with dead_position are rejected
  assert.equal(
    decodeServer(JSON.stringify({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'dead_position', winner: 'w', serverTs: 1000, stateRevision: 1 })),
    null,
  );
  assert.equal(
    decodeServer(JSON.stringify({ t: 'ended', gameId: 'g1', result: '0-1', termination: 'dead_position', winner: 'b', serverTs: 1000, stateRevision: 1 })),
    null,
  );
  assert.equal(
    decodeServer(JSON.stringify({ t: 'ended', gameId: 'g1', result: '*', termination: 'dead_position', winner: null, serverTs: 1000, stateRevision: 1 })),
    null,
  );
  assert.equal(
    decodeServer(JSON.stringify({ t: 'ended', gameId: 'g1', result: '1/2-1/2', termination: 'dead_position', winner: 'w', serverTs: 1000, stateRevision: 1 })),
    null,
  );
  assert.equal(
    decodeServer(JSON.stringify({ t: 'ended', gameId: 'g1', result: '1/2-1/2', termination: 'dead_position', winner: 'b', serverTs: 1000, stateRevision: 1 })),
    null,
  );

  // 2. Unrevisioned ended: invalid combinations rejected
  assert.equal(
    decodeServer(JSON.stringify({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'dead_position', winner: 'w', serverTs: 1000 })),
    null,
  );
  assert.equal(
    decodeServer(JSON.stringify({ t: 'ended', gameId: 'g1', result: '1/2-1/2', termination: 'dead_position', winner: 'w', serverTs: 1000 })),
    null,
  );

  // 3. Joined snapshot with invalid dead_position
  const badState = {
    ...makeStateView(false, 1),
    status: { over: true, result: '1-0', termination: 'dead_position', winner: 'w' },
  };
  assert.equal(
    decodeServer(JSON.stringify({ t: 'joined', gameId: 'g1', role: 'spectator', state: badState })),
    null,
  );

  // 4. State snapshot with invalid dead_position
  assert.equal(
    decodeServer(JSON.stringify({ t: 'state', gameId: 'g1', state: badState })),
    null,
  );

  // 5. Resumed snapshot with invalid dead_position in state
  assert.equal(
    decodeServer(JSON.stringify({ t: 'resumed', gameId: 'g1', stateRevision: 5, state: badState, missed: [] })),
    null,
  );

  // 6. Resumed envelope with matched revisions (stateRevision: 5 on state and missed):
  // Invalid dead_position in missed is rejected specifically by semantic dead_position guard
  const matchedRevisionState = makeStateView(false, 5);
  const badMissedFrame = {
    t: 'resumed',
    gameId: 'g1',
    stateRevision: 5,
    state: matchedRevisionState,
    missed: [
      { t: 'ended', gameId: 'g1', result: '1-0', termination: 'dead_position', winner: 'w', serverTs: 1000, stateRevision: 5 },
    ],
  };
  assert.equal(
    decodeServer(JSON.stringify(badMissedFrame)),
    null,
    'resumed with invalid dead_position in missed must be rejected by semantic ending guard',
  );

  // Valid control with identical matched-revision envelope is accepted
  const validMissedFrame = {
    t: 'resumed',
    gameId: 'g1',
    stateRevision: 5,
    state: matchedRevisionState,
    missed: [
      { t: 'ended', gameId: 'g1', result: '1/2-1/2', termination: 'dead_position', winner: null, serverTs: 1000, stateRevision: 5 },
    ],
  };
  const decodedValidMissed = decodeServer(JSON.stringify(validMissedFrame));
  assert.equal(decodedValidMissed?.t, 'resumed', 'matched envelope with valid dead_position in missed must pass decodeServer');

  // 7. Historical terminations preserved
  assert.ok(decodeServer(JSON.stringify({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 1000, stateRevision: 1 })));
  assert.ok(decodeServer(JSON.stringify({ t: 'ended', gameId: 'g1', result: '1/2-1/2', termination: 'stalemate', winner: null, serverTs: 1000, stateRevision: 1 })));
  assert.ok(decodeServer(JSON.stringify({ t: 'ended', gameId: 'g1', result: '1/2-1/2', termination: 'insufficient_material', winner: null, serverTs: 1000, stateRevision: 1 })));
});

test('GameSync: delivers valid dead_position ending cleanly to state', () => {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync = new GameSync(client, { gameId: 'g1', scheduler });
  sync.start();
  factory.last.open();

  // Initial joined snapshot at stateRevision 1
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: makeStateView(false, 1),
  });
  assert.equal(sync.getState().status?.over, false);

  // Valid revisioned ended event with dead_position
  factory.last.emit({
    t: 'ended',
    gameId: 'g1',
    result: '1/2-1/2',
    termination: 'dead_position',
    winner: null,
    serverTs: 1000,
    stateRevision: 2,
  });

  const state = sync.getState();
  assert.equal(state.status?.over, true);
  if (state.status?.over) {
    assert.equal(state.status.result, '1/2-1/2');
    assert.equal(state.status.termination, 'dead_position');
    assert.equal(state.status.winner, null);
  }
  sync.stop();
  client.close();
});

test('GameSync: preserves pending move, pending action, uncertainty notice, and revision floor when invalid dead_position arrives', () => {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync = new GameSync(client, { gameId: 'g1', scheduler });
  sync.start();
  factory.last.open();

  // Joined at stateRevision 1 as White with White to move
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: makeStateView(false, 1, 'w'),
  });
  assert.equal(sync.getState().status?.over, false);
  assert.equal(sync.getState().turn, 'w');

  // 1. Pending action preservation:
  const offered = sync.offerDraw();
  assert.equal(offered, true);
  assert.equal(sync.getState().pendingAction, 'offerDraw');

  // Corrupt ended frame arrives at transport
  const corruptEndedFrame = {
    t: 'ended',
    gameId: 'g1',
    result: '1-0',
    termination: 'dead_position',
    winner: 'w',
    serverTs: 1000,
    stateRevision: 2,
  };
  factory.last.emit(corruptEndedFrame);

  // Observable state is preserved untouched: pendingAction not cleared, status remains ongoing
  const stateAfterCorrupt = sync.getState();
  assert.equal(stateAfterCorrupt.status?.over, false, 'game must remain ongoing after invalid ended frame');
  assert.equal(stateAfterCorrupt.pendingAction, 'offerDraw', 'pendingAction must be preserved when corrupt frame is dropped');
  assert.equal(stateAfterCorrupt.lastReject, null, 'no false rejection notice should be recorded');

  // Now emit valid dead_position ending at revision 2
  factory.last.emit({
    t: 'ended',
    gameId: 'g1',
    result: '1/2-1/2',
    termination: 'dead_position',
    winner: null,
    serverTs: 1000,
    stateRevision: 2,
  });

  // Valid ending reconciles state cleanly: game is over, pendingAction is cleared
  const stateAfterValid = sync.getState();
  assert.equal(stateAfterValid.status?.over, true);
  assert.equal(stateAfterValid.status?.termination, 'dead_position');
  assert.equal(stateAfterValid.status?.result, '1/2-1/2');
  assert.equal(stateAfterValid.pendingAction, null);

  sync.stop();
  client.close();

  // 2. Pending optimistic move preservation on a fresh game
  const client2 = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync2 = new GameSync(client2, { gameId: 'g2', scheduler });
  sync2.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g2',
    role: 'white',
    state: makeStateView(false, 1, 'w', 0, 'g2'),
  });
  const pending = sync2.submitMove('e2e4');
  assert.ok(pending, 'optimistic move must be submitted');
  assert.equal(sync2.getState().pending?.uci, 'e2e4');

  factory.last.emit({
    t: 'ended',
    gameId: 'g2',
    result: '1-0',
    termination: 'dead_position',
    winner: 'w',
    serverTs: 1000,
    stateRevision: 2,
  });
  assert.equal(sync2.getState().pending?.uci, 'e2e4', 'pending move must be preserved when corrupt frame is dropped');
  assert.equal(sync2.getState().status?.over, false);
  assert.equal(sync2.getState().lastReject, null);

  // A clean state snapshot with valid dead_position ending clears pending
  factory.last.emit({
    t: 'state',
    gameId: 'g2',
    state: makeStateView(true, 2, 'b', 0, 'g2'),
  });
  assert.equal(sync2.getState().status?.over, true);
  assert.equal(sync2.getState().pending, null, 'pending move cleared by accepted state snapshot');

  sync2.stop();
  client2.close();

  // 3. Command uncertainty (outcomeUnknown) preservation on a fresh game
  const client3 = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync3 = new GameSync(client3, { gameId: 'g3', scheduler });
  sync3.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g3',
    role: 'white',
    state: makeStateView(false, 1, 'w', 0, 'g3'),
  });

  const pending3 = sync3.submitMove('e2e4');
  assert.ok(pending3, 'move must be submitted to establish clientSeq');

  // Server emits outcomeUnknown receipt for this move request
  factory.last.emit({
    t: 'outcomeUnknown',
    code: 'outcome_unknown',
    gameId: 'g3',
    ref: pending3.clientSeq,
    requestId: 'req-uncertain-1',
    message: 'Command outcome unknown.',
  });

  const state3Uncertain = sync3.getState();
  assert.equal(state3Uncertain.lastReject?.t, 'outcomeUnknown');
  assert.equal(state3Uncertain.lastReject?.code, 'outcome_unknown');
  assert.equal(state3Uncertain.lastReject?.message, 'Command outcome unknown.');
  assert.equal(state3Uncertain.pending?.uci, 'e2e4');

  // Corrupt ended frame arrives at transport
  factory.last.emit({
    t: 'ended',
    gameId: 'g3',
    result: '1-0',
    termination: 'dead_position',
    winner: 'w',
    serverTs: 1000,
    stateRevision: 2,
  });

  // Observable uncertainty notice and pending intent remain preserved:
  const state3AfterCorrupt = sync3.getState();
  assert.equal(state3AfterCorrupt.status?.over, false, 'game must remain ongoing after invalid ended frame');
  assert.equal(state3AfterCorrupt.lastReject?.t, 'outcomeUnknown', 'outcomeUnknown notice must remain intact when corrupt frame is dropped');
  assert.equal(state3AfterCorrupt.lastReject?.code, 'outcome_unknown');
  assert.equal(state3AfterCorrupt.lastReject?.message, 'Command outcome unknown.');
  assert.equal(state3AfterCorrupt.pending?.uci, 'e2e4', 'pending move must be preserved during uncertainty');

  sync3.stop();
  client3.close();
});

test('GameSync: gap recovery and equal-revision behavior with dead_position', () => {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync = new GameSync(client, { gameId: 'g1', scheduler });
  sync.start();
  factory.last.open();

  // Joined at stateRevision 1
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'spectator',
    state: makeStateView(false, 1),
  });

  // 1. Equal-revision frame at revision 1: duplicate broadcast is dropped without state mutation
  factory.last.emit({
    t: 'ended',
    gameId: 'g1',
    result: '1/2-1/2',
    termination: 'dead_position',
    winner: null,
    serverTs: 1000,
    stateRevision: 1,
  });
  assert.equal(sync.getState().status?.over, false, 'equal revision frame must not alter state');

  // 2. Observe gap ready frame at revision 4 -> triggers gap recovery while game is ongoing
  factory.last.emit({
    t: 'ready',
    gameId: 'g1',
    ready: { w: true, b: true },
    serverTs: 2000,
    stateRevision: 4,
  });
  assert.equal(sync.getState().recovering, true, 'gap observation must set recovering flag');
  assert.equal(sync.getState().status?.over, false, 'game remains ongoing before recovery snapshot');

  // 3. Invalid recovery snapshot arriving during recovery is dropped
  const invalidRecoverySnapshot = {
    t: 'state',
    gameId: 'g1',
    state: {
      ...makeStateView(false, 4),
      status: { over: true, result: '1-0', termination: 'dead_position', winner: 'w' },
    },
  };
  factory.last.emit(invalidRecoverySnapshot);
  assert.equal(sync.getState().recovering, true, 'invalid snapshot must be dropped and not complete recovery');
  assert.equal(sync.getState().status?.over, false);

  // 4. Valid recovery snapshot completes recovery cleanly
  const validRecoverySnapshot = {
    t: 'state',
    gameId: 'g1',
    state: makeStateView(true, 4),
  };
  factory.last.emit(validRecoverySnapshot);

  const recovered = sync.getState();
  assert.equal(recovered.status?.over, true, 'valid recovery snapshot completes recovery');
  assert.equal(recovered.status?.termination, 'dead_position');
  assert.equal(recovered.status?.result, '1/2-1/2');
  assert.equal(recovered.recovering, false);

  sync.stop();
  client.close();
});

test('UI rendering & live relocalization: controller status, describeOutcome, and mounted endgame verdict across live English and Arabic switch', () => {
  const i18n = createI18nManager({ initialLocale: 'en' });

  // 1. Live GameController status with dynamic language switch
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync = new GameSync(client, { gameId: 'g1', scheduler });
  const statuses: string[] = [];
  const controller = new GameController({
    gameSync: sync,
    i18n,
    callbacks: {
      onPosition: () => {},
      onTurn: () => {},
      onClock: () => {},
      onStatus: (text) => statuses.push(text),
      onColor: () => {},
      onMetadata: () => {},
    },
  });

  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: makeStateView(false, 1),
  });
  factory.last.emit({
    t: 'ended',
    gameId: 'g1',
    result: '1/2-1/2',
    termination: 'dead_position',
    winner: null,
    serverTs: 1000,
    stateRevision: 2,
  });

  // Verify English status
  assert.equal(statuses.at(-1), 'Draw — dead position (1/2-1/2)');
  assert.ok(!statuses.at(-1)?.includes('game.status.'), 'must not leak translation keys');

  // Live locale switch to Arabic on the SAME controller and manager
  i18n.setLocale('ar');
  assert.equal(statuses.at(-1), 'تعادل — وضعية ميتة (1/2-1/2)');
  assert.ok(!statuses.at(-1)?.includes('game.status.'), 'must not leak translation keys');

  // Verify distinction from insufficient material in both languages
  i18n.setLocale('en');
  factory.last.emit({
    t: 'ended',
    gameId: 'g1',
    result: '1/2-1/2',
    termination: 'insufficient_material',
    winner: null,
    serverTs: 2000,
    stateRevision: 3,
  });
  assert.equal(statuses.at(-1), 'Draw — insufficient material (1/2-1/2)');
  assert.notEqual('Draw — dead position (1/2-1/2)', statuses.at(-1));

  i18n.setLocale('ar');
  assert.equal(statuses.at(-1), 'تعادل — عدم كفاية القطع (1/2-1/2)');
  assert.notEqual('تعادل — وضعية ميتة (1/2-1/2)', statuses.at(-1));

  // 2. describeOutcome across live locale switch
  const outcomeDead = { kind: 'terminal' as const, reason: 'dead_position' as const, result: '1/2-1/2' as const };
  const outcomeInsufficient = { kind: 'terminal' as const, reason: 'insufficient_material' as const, result: '1/2-1/2' as const };

  i18n.setLocale('en');
  assert.equal(describeOutcome(outcomeDead, i18n), 'Dead position — draw');
  assert.equal(describeOutcome(outcomeInsufficient, i18n), 'Insufficient material — draw');
  assert.notEqual(describeOutcome(outcomeDead, i18n), describeOutcome(outcomeInsufficient, i18n));

  i18n.setLocale('ar');
  assert.equal(describeOutcome(outcomeDead, i18n), 'تعادل لوضعية ميتة');
  assert.equal(describeOutcome(outcomeInsufficient, i18n), 'تعادل لعدم كفاية القطع');
  assert.notEqual(describeOutcome(outcomeDead, i18n), describeOutcome(outcomeInsufficient, i18n));

  // 3. Real mounted DOM view (renderEndgameVerdict) across live locale switch
  const doc = createFakeDoc();
  const rows = doc.createElement('div');
  const resultEl = doc.createElement('div');

  const attemptDead: EndgameAttemptResult = {
    kind: 'terminal',
    id: 'endgame-1',
    move: 'c7d7',
    fenAfter: '',
    classification: 'optimal',
    goalPreserved: true,
    terminal: { reason: 'dead_position', result: '1/2-1/2' },
  };

  const attemptInsufficient: EndgameAttemptResult = {
    kind: 'terminal',
    id: 'endgame-2',
    move: 'c7d7',
    fenAfter: '',
    classification: 'optimal',
    goalPreserved: true,
    terminal: { reason: 'insufficient_material', result: '1/2-1/2' },
  };

  // Render in English
  i18n.setLocale('en');
  renderEndgameVerdict(doc, rows, resultEl, attemptDead, i18n);
  assert.ok(rows.textContent?.includes('Dead position — draw · 1/2-1/2'), `expected English dead position label in ${rows.textContent}`);
  assert.ok(!rows.textContent?.includes('ai.explain.outcome.'), 'must not leak translation key');

  renderEndgameVerdict(doc, rows, resultEl, attemptInsufficient, i18n);
  assert.ok(rows.textContent?.includes('Insufficient material — draw · 1/2-1/2'), `expected English insufficient material label in ${rows.textContent}`);

  // Re-render in Arabic after live locale switch
  i18n.setLocale('ar');
  renderEndgameVerdict(doc, rows, resultEl, attemptDead, i18n);
  assert.ok(rows.textContent?.includes('تعادل لوضعية ميتة · 1/2-1/2'), `expected Arabic dead position label in ${rows.textContent}`);
  assert.ok(!rows.textContent?.includes('ai.explain.outcome.'), 'must not leak translation key');

  renderEndgameVerdict(doc, rows, resultEl, attemptInsufficient, i18n);
  assert.ok(rows.textContent?.includes('تعادل لعدم كفاية القطع · 1/2-1/2'), `expected Arabic insufficient material label in ${rows.textContent}`);

  controller.dispose();
  sync.stop();
  client.close();
});
