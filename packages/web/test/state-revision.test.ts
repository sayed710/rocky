import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeServer, isRevisionedState, type ServerMessage } from '../src/net/ws-protocol.js';

// Existing one-argument decoders compile here; the baseline genuinely ignores strict mode.
const decode: (frame: string, mode?: 'legacy' | 'revision') => ServerMessage | null = decodeServer;
const state = {
  gameId: 'g', variant: 'standard', players: { white: 'alice', black: 'bob' },
  timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
  fen: 'startpos', fenHash: '0123456789ab', ply: 0, turn: 'w', clock: { w: 300_000, b: 300_000 },
  turnStartedAt: 1_000, status: { over: false }, drawOffer: null, moves: [], legalMoves: {},
  chess960StartId: null, ready: null,
} as const;
const ended = { t: 'ended', gameId: 'g', result: '1-0', termination: 'resignation', winner: 'w', serverTs: 1_000 };

test('REV-05 revision-aware snapshots accept the PostgreSQL INTEGER bounds', () => {
  for (const stateRevision of [0, 1, 2_147_483_647]) {
    const frame = { t: 'state', gameId: 'g', state: { ...state, stateRevision } };
    assert.deepEqual(decode(JSON.stringify(frame), 'revision'), frame);
    assert.equal(isRevisionedState(frame.state), true);
  }
});

test('REV-05 present malformed revisions are rejected in both decoding modes', () => {
  for (const stateRevision of [-1, 0.5, '1', null, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]) {
    for (const mode of ['legacy', 'revision'] as const) {
      assert.equal(decode(JSON.stringify({ t: 'state', gameId: 'g', state: { ...state, stateRevision } }), mode), null);
      assert.equal(decode(JSON.stringify({ ...ended, stateRevision }), mode), null);
    }
  }
  assert.equal(decode(JSON.stringify({ ...ended, stateRevision: 0 })), null, 'committed event positions are positive');
});

test('COMP-01 missing revisions remain legacy; strict mode does not invent synchronization', () => {
  const frame = { t: 'state', gameId: 'g', state };
  assert.deepEqual(decode(JSON.stringify(frame)), frame);
  assert.equal(isRevisionedState(state), false);
  assert.equal(decode(JSON.stringify(frame), 'revision'), null);
  assert.deepEqual(decode(JSON.stringify(ended)), ended);
  assert.equal(decode(JSON.stringify(ended), 'revision'), null);
});

test('COMP-01 revisioned payloads require complete shapes and consistently stamped missed frames', () => {
  assert.equal(decode(JSON.stringify({ t: 'state', gameId: 'g', state: { stateRevision: 0 } })), null);
  assert.equal(decode(JSON.stringify({ t: 'ended', stateRevision: 1 })), null);
  assert.equal(decode(JSON.stringify({ t: 'resumed', gameId: 'g', state: { ...state, stateRevision: 1 }, missed: [ended] })), null);
  const frame = { t: 'resumed', gameId: 'g', state: { ...state, stateRevision: 1 }, missed: [{ ...ended, stateRevision: 1 }] };
  assert.deepEqual(decode(JSON.stringify(frame), 'revision'), frame);
  const receipt = { t: 'commandConfirmed', gameId: 'g', requestId: 'r' };
  assert.deepEqual(decode(JSON.stringify(receipt), 'revision'), receipt, 'command identity is independent of revision');
});

test('revisioned enum fields reject coercible arrays and objects', () => {
  for (const result of [['1-0'], { value: '1-0' }]) {
    assert.equal(decode(JSON.stringify({ ...ended, stateRevision: 1, result })), null);
  }
  for (const role of [['white'], { value: 'white' }]) {
    assert.equal(decode(JSON.stringify({ t: 'joined', gameId: 'g', role, state: { ...state, stateRevision: 0 } })), null);
  }
  for (const kind of [['increment'], { value: 'increment' }]) {
    assert.equal(decode(JSON.stringify({ t: 'state', gameId: 'g', state: { ...state, stateRevision: 0, timeControl: { ...state.timeControl, kind } } })), null);
  }
});
