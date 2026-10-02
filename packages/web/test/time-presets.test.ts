import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATE_GAME_PRESETS,
  CUSTOM_LIMITS,
  CUSTOM_PRESET_ID,
  DEFAULT_PRESET_ID,
  UNLIMITED_TIME_CONTROL,
  UNLIMITED_TIME_ID,
  validateCustomTime,
  presetToTimeControl,
  estimateSpeed,
} from '../src/app/time-presets.js';

const EXPECTED_CREATE_GAME_PRESETS = [
  ['1+0', { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }],
  ['2+1', { initialMs: 120_000, incrementMs: 1_000, delayMs: 0, kind: 'increment' }],
  ['3+0', { initialMs: 180_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }],
  ['3+2', { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' }],
  ['5+0', { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }],
  ['5+3', { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' }],
  ['10+0', { initialMs: 600_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }],
  ['10+5', { initialMs: 600_000, incrementMs: 5_000, delayMs: 0, kind: 'increment' }],
  ['15+10', { initialMs: 900_000, incrementMs: 10_000, delayMs: 0, kind: 'increment' }],
  ['30+20', { initialMs: 1_800_000, incrementMs: 20_000, delayMs: 0, kind: 'increment' }],
] as const;

test('create-game V2 offers the canonical ten-preset ladder in product order', () => {
  assert.deepEqual(
    CREATE_GAME_PRESETS.map((preset) => preset.id),
    EXPECTED_CREATE_GAME_PRESETS.map(([id]) => id),
  );
});

test('every exposed preset maps to its exact API time control, preserving all V1 payloads', () => {
  for (const [id, timeControl] of EXPECTED_CREATE_GAME_PRESETS) {
    const preset = CREATE_GAME_PRESETS.find((candidate) => candidate.id === id);
    assert.ok(preset, `missing create-game preset ${id}`);
    assert.deepEqual(presetToTimeControl(preset.minutes, preset.increment), timeControl);
  }
});

test('every create-game preset has a unique id and valid positive values', () => {
  const ids = new Set<string>();
  for (const p of CREATE_GAME_PRESETS) {
    assert.ok(!ids.has(p.id), `duplicate preset id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.minutes > 0, `${p.id} minutes must be positive`);
    assert.ok(p.increment >= 0, `${p.id} increment must be >= 0`);
  }
});

test('the create-game default remains exactly 10+0', () => {
  assert.equal(DEFAULT_PRESET_ID, '10+0');
  assert.ok(CREATE_GAME_PRESETS.some((p) => p.id === DEFAULT_PRESET_ID));
});

test('presetToTimeControl maps sudden-death vs increment', () => {
  const noInc = presetToTimeControl(5, 0);
  assert.deepEqual(noInc, { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' });

  const withInc = presetToTimeControl(3, 2);
  assert.deepEqual(withInc, { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' });
});

test('presetToTimeControl rounds a half-minute initial time', () => {
  const tc = presetToTimeControl(0.5, 0);
  assert.equal(tc.initialMs, 30_000);
});

test('custom time accepts its exact boundaries and produces integer milliseconds', () => {
  assert.deepEqual(validateCustomTime(0.5, 0), {
    ok: true,
    timeControl: { initialMs: 30_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
  });
  assert.deepEqual(validateCustomTime(180, 60), {
    ok: true,
    timeControl: { initialMs: 10_800_000, incrementMs: 60_000, delayMs: 0, kind: 'increment' },
  });
});

test('custom time rejects unsafe, off-step, and non-finite values before a request exists', () => {
  for (const minutes of [-1, 0, 0.4, 0.7, 180.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const validation = validateCustomTime(minutes, 0);
    assert.equal(validation.ok, false, `minutes ${minutes} must be rejected`);
    if (!validation.ok) assert.equal(validation.field, 'minutes');
  }
  for (const increment of [-1, 0.5, 60.5, 61, Number.NaN, Number.POSITIVE_INFINITY]) {
    const validation = validateCustomTime(5, increment);
    assert.equal(validation.ok, false, `increment ${increment} must be rejected`);
    if (!validation.ok) assert.equal(validation.field, 'increment');
  }
});

test('custom bounds retain the repository-established product limits', () => {
  assert.deepEqual(CUSTOM_LIMITS, {
    minMinutes: 0.5,
    maxMinutes: 180,
    minuteStep: 0.5,
    minIncrement: 0,
    maxIncrement: 60,
  });
});

/**
 * Unlimited is a choice the panel offers, but it is deliberately *not* a preset:
 * `CREATE_GAME_PRESETS` is `TIME_PRESETS`, which the play-vs-computer dialog
 * also renders, and a `TimePreset` has no minutes/increment that could describe
 * an untimed game. Keeping it out of the catalog is what keeps that dialog
 * unchanged by this feature.
 */
test('the untimed choice is a sentinel id, not an entry in the preset ladder', () => {
  assert.equal(UNLIMITED_TIME_ID, 'unlimited');
  assert.notEqual(UNLIMITED_TIME_ID, CUSTOM_PRESET_ID);
  // `CreateGamePresetId` already excludes the id by construction — tsc rejects
  // comparing the two — so what is left to check at runtime is the looser case:
  // no entry named after it either.
  assert.equal(
    CREATE_GAME_PRESETS.some((preset) => preset.id.toLowerCase().includes('unlimited')),
    false,
  );
});

/**
 * `parseTimeControl` in packages/api/src/domain.ts rejects `kind: 'unlimited'`
 * carrying any non-zero duration with a 422, so these four fields are the whole
 * contract — pinned here rather than only at the panel that sends them.
 */
test('the untimed control is exactly the zero-duration wire shape the server accepts', () => {
  assert.deepEqual(UNLIMITED_TIME_CONTROL, {
    initialMs: 0,
    incrementMs: 0,
    delayMs: 0,
    kind: 'unlimited',
  });
});

test('estimateSpeed buckets the ladder the way players expect', () => {
  const speedOf = (m: number, i: number) => estimateSpeed(presetToTimeControl(m, i));
  assert.equal(speedOf(1, 0), 'bullet');
  assert.equal(speedOf(2, 1), 'bullet');
  assert.equal(speedOf(3, 0), 'blitz');
  assert.equal(speedOf(5, 3), 'blitz');
  assert.equal(speedOf(10, 0), 'rapid');
  assert.equal(speedOf(15, 10), 'rapid');
  assert.equal(speedOf(30, 20), 'classical');
});

/**
 * Arithmetically the untimed control estimates at zero seconds, which is the
 * *shortest* bucket — the opposite of what it means. The kind has to win, as it
 * does in the server's `classifySpeed`.
 */
test('estimateSpeed reads the untimed control as correspondence, not shortest bucket', () => {
  assert.equal(estimateSpeed(UNLIMITED_TIME_CONTROL), 'correspondence');
  assert.equal(estimateSpeed({ ...UNLIMITED_TIME_CONTROL, kind: 'sudden_death' }), 'ultrabullet');
});
