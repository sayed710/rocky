import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorForRole,
  decodeServer,
  encodeClient,
  opposite,
} from '../src/net/ws-protocol.js';
import type { ClientMessage } from '../src/net/ws-protocol.js';

test('encodeClient round-trips a client message', () => {
  const msg: ClientMessage = { t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 7 };
  assert.deepEqual(JSON.parse(encodeClient(msg)), msg);
});

test('decodeServer parses each server message type', () => {
  const pong = decodeServer(JSON.stringify({ t: 'pong', ts: 1, serverTs: 2 }));
  assert.equal(pong?.t, 'pong');
  const presence = decodeServer(
    JSON.stringify({ t: 'presence', gameId: 'g', white: true, black: false, spectators: 3 }),
  );
  assert.equal(presence?.t, 'presence');
  const reject = decodeServer(
    JSON.stringify({ t: 'reject', gameId: 'g', ref: 4, code: 'illegal_move', message: 'no' }),
  );
  assert.equal(reject?.t, 'reject');
});

test('decodeServer preserves the authoritative legalMoves on a state frame', () => {
  const frame = decodeServer(
    JSON.stringify({
      t: 'state',
      gameId: 'g',
      state: { fen: 'startpos', turn: 'w', legalMoves: { e2: ['e3', 'e4'], g1: ['f3', 'h3'] } },
    }),
  );
  assert.equal(frame?.t, 'state');
  if (frame?.t === 'state') {
    assert.deepEqual(frame.state.legalMoves['e2'], ['e3', 'e4']);
    assert.deepEqual(frame.state.legalMoves['g1'], ['f3', 'h3']);
  }
});

test('decodeServer rejects malformed, non-object, and unknown/client frames', () => {
  assert.equal(decodeServer('{not json'), null);
  assert.equal(decodeServer('42'), null);
  assert.equal(decodeServer('null'), null);
  assert.equal(decodeServer(JSON.stringify({ t: 'nope' })), null);
  // A client-only message type is not a valid server frame.
  assert.equal(decodeServer(JSON.stringify({ t: 'join', gameId: 'g', userId: 'u' })), null);
});

test('opposite flips the side to move', () => {
  assert.equal(opposite('w'), 'b');
  assert.equal(opposite('b'), 'w');
});

test('colorForRole maps roles to wire colors', () => {
  assert.equal(colorForRole('white'), 'w');
  assert.equal(colorForRole('black'), 'b');
  assert.equal(colorForRole('spectator'), null);
});

test('decodeServer rejects invalid adjudication on legacy snapshots across joined, state, and resumed', () => {
  const invalidPhases: readonly unknown[] = ['invalid_phase', 'random', null, 123, true, {}];
  for (const phase of invalidPhases) {
    const legacyStateWithPhase = {
      fen: 'startpos',
      turn: 'w',
      legalMoves: { e2: ['e4'] },
      adjudication: phase,
    };

    assert.equal(
      decodeServer(JSON.stringify({ t: 'joined', gameId: 'g', role: 'white', state: legacyStateWithPhase })),
      null,
      `legacy joined with adjudication=${String(phase)} must be rejected`,
    );

    assert.equal(
      decodeServer(JSON.stringify({ t: 'state', gameId: 'g', state: legacyStateWithPhase })),
      null,
      `legacy state with adjudication=${String(phase)} must be rejected`,
    );

    assert.equal(
      decodeServer(JSON.stringify({ t: 'resumed', gameId: 'g', state: legacyStateWithPhase, missed: [] })),
      null,
      `legacy resumed with adjudication=${String(phase)} must be rejected`,
    );
  }
});

test('decodeServer accepts allowed legacy snapshots with undefined, proving, or stopped adjudication', () => {
  const allowedPhases: readonly (string | undefined)[] = [undefined, 'proving', 'stopped'];
  for (const phase of allowedPhases) {
    const legacyState = {
      fen: 'startpos',
      turn: 'w',
      legalMoves: { e2: ['e4'] },
      ...(phase !== undefined ? { adjudication: phase } : {}),
    };

    const joined = decodeServer(JSON.stringify({ t: 'joined', gameId: 'g', role: 'white', state: legacyState }));
    assert.equal(joined?.t, 'joined');
    if (joined?.t === 'joined') {
      assert.equal(joined.state.adjudication, phase);
    }

    const state = decodeServer(JSON.stringify({ t: 'state', gameId: 'g', state: legacyState }));
    assert.equal(state?.t, 'state');
    if (state?.t === 'state') {
      assert.equal(state.state.adjudication, phase);
    }

    const resumed = decodeServer(JSON.stringify({ t: 'resumed', gameId: 'g', state: legacyState, missed: [] }));
    assert.equal(resumed?.t, 'resumed');
    if (resumed?.t === 'resumed') {
      assert.equal(resumed.state.adjudication, phase);
    }
  }
});
