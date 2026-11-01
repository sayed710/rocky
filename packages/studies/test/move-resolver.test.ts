import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Position } from '@chess-platform/core';
import { StudyRuleError, resolveSan, type PositionReader } from '../src';

/**
 * Tests for `resolveSan`, the function both study-import adapters resolve every SAN token through.
 *
 * These assertions existed before, but only reachable through `importGame` — a function nothing in
 * production called. Deleting it in M15 Increment 13 would have taken the only coverage of SAN
 * suffix handling with it, so they moved here, onto the unit that actually owns the behaviour and
 * that production actually calls.
 */

/**
 * The real engine, wired the way the adapters wire it. A stub that invents SAN would test the stub:
 * the whole point of `PositionReader` is that resolution goes through the engine's own SAN writer.
 */
const engine: PositionReader = {
  legalSans(fen, variant) {
    const pos = Position.fromFen(fen, variant);
    return pos.legalMoves().map((m) => pos.toSan(m));
  },
  play(fen, san, variant) {
    const pos = Position.fromFen(fen, variant);
    for (const move of pos.legalMoves()) {
      if (pos.toSan(move) === san) return pos.play(move).fen();
    }
    throw new Error(`illegal move ${san}`);
  },
  initialFen(variant) {
    return Position.initial(variant).fen();
  },
};

/** Position after 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6, where 4. Qxf7 is mate. */
const BEFORE_MATE = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

describe('resolveSan', () => {
  it('accepts a move written without the check suffix the engine would write', () => {
    // Real exports disagree with each other about `+` and `#`. They do not identify the move, so a
    // file that omits one is describing the same game and must resolve — and must come back
    // carrying the engine's spelling, because that is what gets stored.
    assert.equal(resolveSan(engine, BEFORE_MATE, 'Qxf7'), 'Qxf7#');
  });

  it('accepts annotation suffixes in any combination', () => {
    // `Qh5+!` is the case that broke: stripping `[+#]` and then `[!?]` in two passes leaves `Qh5+`,
    // because the first pass sees a string ending in `!` and matches nothing. The engine writes
    // `Qh5+`, which bares to `Qh5`, and the two never meet.
    for (const written of ['Qxf7!', 'Qxf7#!', 'Qxf7!!', 'Qxf7#??', 'Qxf7!?']) {
      assert.equal(resolveSan(engine, BEFORE_MATE, written), 'Qxf7#', `resolving ${written}`);
    }
  });

  it('normalises zeroed castling to the letter form the engine writes', () => {
    const castling = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
    assert.equal(resolveSan(engine, castling, '0-0'), 'O-O');
    assert.equal(resolveSan(engine, castling, '0-0-0'), 'O-O-O');
  });

  it('rejects a move that is not legal rather than guessing', () => {
    assert.throws(
      () => resolveSan(engine, BEFORE_MATE, 'Qxf8'),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'invalid_move',
    );
  });

  /**
   * A reader whose *answers* depend on the variant, so a dropped variant changes the result rather
   * than merely changing an argument nobody observes. Only `threecheck` can play `Re1+` here.
   */
  const perVariant: PositionReader = {
    legalSans: (_fen, variant) => (variant === 'threecheck' ? ['Re1+'] : ['Rd2']),
    play: (fen) => fen,
    initialFen: (variant) => Position.initial(variant).fen(),
  };
  const THREE_CHECK_FEN = '4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1';

  it('resolves against the variant it was given, not against standard chess', () => {
    // The contract every caller depends on. A resolver that dropped the variant would ask about
    // standard chess, never see `Re1+`, and reject a move that is legal in this study — the failure
    // M15 Increment 13 removed from the import path by deleting the walker that never passed one.
    assert.equal(resolveSan(perVariant, THREE_CHECK_FEN, 'Re1', 'threecheck'), 'Re1+');
  });

  it('documents its standard default: omitting the variant means standard chess', () => {
    // Deliberate, not accidental. `@chess-platform/learning` authors move steps against standard
    // positions and calls this with three arguments; lessons carry no variant of their own. Pinned
    // here so it stays a decision — a caller needing a variant must pass one, and changing the
    // default has to be argued for rather than done by accident.
    assert.equal(resolveSan(perVariant, THREE_CHECK_FEN, 'Rd2'), 'Rd2');
    assert.throws(
      () => resolveSan(perVariant, THREE_CHECK_FEN, 'Re1'),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'invalid_move',
      'without a variant the three-check move is not offered, so it cannot resolve',
    );
  });
});
