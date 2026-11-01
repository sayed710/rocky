import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTerminal, fromStatus } from '../src/analysis/terminal';
import { storedStudyPartnerCoaching } from '../src/study-partner/coaching';

test('describeTerminal formats dead_position as draw phrase', () => {
  const text = describeTerminal({ reason: 'dead_position', result: '1/2-1/2' });
  assert.equal(text, 'dead position — drawn');
});

test('fromStatus maps unchanged core GameStatus without emitting dead_position', () => {
  assert.deepEqual(fromStatus({ over: false }), undefined);
  assert.deepEqual(
    fromStatus({ over: true, reason: 'stalemate' }),
    { reason: 'stalemate', result: '1/2-1/2' },
  );
  assert.deepEqual(
    fromStatus({ over: true, reason: 'insufficient_material' }),
    { reason: 'insufficient_material', result: '1/2-1/2' },
  );
  assert.deepEqual(
    fromStatus({ over: true, reason: 'checkmate', winner: 'w' }),
    { reason: 'checkmate', result: '1-0' },
  );
});

test('storedStudyPartnerCoaching round-trips valid dead_position citation and mistake outcomes', () => {
  const basePayload = {
    version: 1,
    fen: '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1',
    variant: 'standard',
    move: 'c7d7',
    mistake: {
      kind: 'present' as const,
      value: {
        fen: '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1',
        variant: 'standard',
        move: 'c7d7',
        classification: 'ok' as const,
        before: {
          evalKind: 'cp' as const,
          evalValue: 0,
          evalLabel: '0.00',
        },
        after: {
          kind: 'terminal' as const,
          reason: 'dead_position',
          result: '1/2-1/2',
          label: 'dead position — drawn',
        },
        centipawnLoss: 0,
        bestMove: null,
        bestLine: [],
        depth: 10,
      },
    },
    explanation: {
      kind: 'present' as const,
      value: {
        fen: '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1',
        variant: 'standard',
        move: 'c7d7',
        explanation: 'Position is dead and drawn.',
        citation: {
          moveOutcome: {
            kind: 'terminal' as const,
            reason: 'dead_position',
            result: '1/2-1/2',
          },
          evalKind: 'cp' as const,
          evalValue: 0,
          evalLabel: '0.00',
          bestMove: null,
          bestLine: [],
          depth: 10,
        },
      },
    },
    opening: { kind: 'omitted' as const, reason: 'not_requested' as const },
    puzzle: { kind: 'omitted' as const, reason: 'not_requested' as const },
    endgame: { kind: 'omitted' as const, reason: 'not_requested' as const },
  };

  const decoded = storedStudyPartnerCoaching(basePayload);
  assert.equal(decoded.version, 1);
  assert.equal(decoded.explanation.kind, 'present');
  if (decoded.explanation.kind === 'present') {
    assert.equal(decoded.explanation.value.citation.moveOutcome.kind, 'terminal');
    if (decoded.explanation.value.citation.moveOutcome.kind === 'terminal') {
      assert.equal(decoded.explanation.value.citation.moveOutcome.reason, 'dead_position');
      assert.equal(decoded.explanation.value.citation.moveOutcome.result, '1/2-1/2');
    }
  }
  assert.equal(decoded.mistake.kind, 'present');
  if (decoded.mistake.kind === 'present') {
    assert.equal(decoded.mistake.value.after.kind, 'terminal');
    if (decoded.mistake.value.after.kind === 'terminal') {
      assert.equal(decoded.mistake.value.after.reason, 'dead_position');
      assert.equal(decoded.mistake.value.after.result, '1/2-1/2');
      assert.equal(decoded.mistake.value.after.label, 'dead position — drawn');
    }
  }

  // Decisive result on dead_position in citation must be rejected
  const badCitation = {
    ...basePayload,
    explanation: {
      kind: 'present' as const,
      value: {
        ...basePayload.explanation.value,
        citation: {
          ...basePayload.explanation.value.citation,
          moveOutcome: {
            kind: 'terminal' as const,
            reason: 'dead_position',
            result: '1-0',
          },
        },
      },
    },
  };
  assert.throws(() => storedStudyPartnerCoaching(badCitation), /invalid stored Study Partner coaching section/);

  // Decisive result on dead_position in mistake must be rejected
  const badMistake = {
    ...basePayload,
    mistake: {
      kind: 'present' as const,
      value: {
        ...basePayload.mistake.value,
        after: {
          kind: 'terminal' as const,
          reason: 'dead_position',
          result: '0-1',
          label: 'dead position — drawn',
        },
      },
    },
  };
  assert.throws(() => storedStudyPartnerCoaching(badMistake), /invalid stored Study Partner coaching section/);

  // Unknown terminal reason must be rejected
  const unknownReason = {
    ...basePayload,
    mistake: {
      kind: 'present' as const,
      value: {
        ...basePayload.mistake.value,
        after: {
          kind: 'terminal' as const,
          reason: 'unknown_reason',
          result: '1/2-1/2',
          label: 'unknown',
        },
      },
    },
  };
  assert.throws(() => storedStudyPartnerCoaching(unknownReason), /invalid stored Study Partner coaching section/);
});
