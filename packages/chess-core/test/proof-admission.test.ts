import assert from 'node:assert/strict';
import test from 'node:test';
import { cloneState, parseFen } from '../src/fen';
import { validateAdmittedProofState } from '../src/proof-admission';
import type { PositionState, Variant } from '../src/types';

test('castling admission: rejects structurally inconsistent Chess960 rights (P1 finding)', () => {
  // Root reproduction: 4k3/8/8/8/8/8/8/R3K3 w - - 0 1 (chess960) with castling.w.k = 0
  const base960 = parseFen('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
  base960.variant = 'chess960';

  // 1. King on e1 (file 4), setting kingside rook to file 0 (a1) must be rejected
  const badKingside = cloneState(base960);
  badKingside.castling.w.k = 0;
  const res1 = validateAdmittedProofState(badKingside);
  assert.equal(res1.ok, false);
  assert.equal(res1.reason, 'unsupported_state');
  assert.match(res1.message!, /right/i);

  // 2. Reversed queenside: setting queenside rook to file 5 when king is on e1 (file 4)
  const badQueenside = cloneState(base960);
  badQueenside.castling.w.q = 5;
  const res2 = validateAdmittedProofState(badQueenside);
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, 'unsupported_state');
  assert.match(res2.message!, /left/i);

  // 3. Absent / wrong-color piece on rook file
  const baseWithKnight = parseFen('4k3/8/8/8/8/8/8/4K2n w - - 0 1');
  baseWithKnight.variant = 'chess960';
  baseWithKnight.castling.w.k = 7; // square h1 contains black knight 'n', not white rook 'R'
  const res3 = validateAdmittedProofState(baseWithKnight);
  assert.equal(res3.ok, false);
  assert.equal(res3.reason, 'unsupported_state');
  assert.match(res3.message!, /Missing.*rook/i);

  // 4. Duplicate rook files
  const dupFiles = cloneState(base960);
  dupFiles.castling.w.k = 0;
  dupFiles.castling.w.q = 0;
  const res4 = validateAdmittedProofState(dupFiles);
  assert.equal(res4.ok, false);
  assert.equal(res4.reason, 'unsupported_state');
  assert.match(res4.message!, /Duplicate.*rook/i);

  // 5. King off home rank with held rights
  const kingOffRank = parseFen('4k3/8/8/8/8/8/4K3/R6R w - - 0 1');
  kingOffRank.variant = 'chess960';
  kingOffRank.castling.w.k = 7;
  const res5 = validateAdmittedProofState(kingOffRank);
  assert.equal(res5.ok, false);
  assert.equal(res5.reason, 'unsupported_state');
  assert.match(res5.message!, /rank/i);

  // 6. Valid inner rooks control (root verification case)
  const validInner = parseFen('4k3/8/8/8/8/8/8/2R1KR2 w FC - 0 1');
  validInner.variant = 'chess960';
  validInner.castling.w = { k: 5, q: 2 };
  validInner.castling.b = { k: -1, q: -1 };
  const resValid = validateAdmittedProofState(validInner);
  assert.equal(resValid.ok, true);
});

test('castling admission: enforces traditional standard chess origins', () => {
  const std = parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assert.equal(validateAdmittedProofState(std).ok, true);

  // Non-traditional kingside rook file in standard chess
  const nonTradK = cloneState(std);
  nonTradK.castling.w.k = 5;
  const resK = validateAdmittedProofState(nonTradK);
  assert.equal(resK.ok, false);
  assert.equal(resK.reason, 'unsupported_state');
  assert.match(resK.message!, /h1|h-file/i);

  // Non-traditional queenside rook file in standard chess
  const nonTradQ = cloneState(std);
  nonTradQ.castling.w.q = 2;
  const resQ = validateAdmittedProofState(nonTradQ);
  assert.equal(resQ.ok, false);
  assert.equal(resQ.reason, 'unsupported_state');
  assert.match(resQ.message!, /a1|a-file/i);

  // Off-home-square king in standard chess
  const kingOffE1 = parseFen('r3k2r/8/8/8/8/8/8/R2K3R w kq - 0 1');
  kingOffE1.castling.w.k = 7;
  const resOff = validateAdmittedProofState(kingOffE1);
  assert.equal(resOff.ok, false);
  assert.equal(resOff.reason, 'unsupported_state');
  assert.match(resOff.message!, /e1|e-file/i);
});

test('clock metadata: enforces non-negative safe integers and rejects invalid payloads', () => {
  const base = parseFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  const baseSnap = cloneState(base);

  // Missing halfmoves
  const { halfmoves: _half, ...missingHalf } = baseSnap;
  assert.equal(validateAdmittedProofState(missingHalf).ok, false);

  // String halfmoves
  const stringHalf = { ...baseSnap, halfmoves: '0' };
  assert.equal(validateAdmittedProofState(stringHalf).ok, false);

  // Object halfmoves
  const objectHalf = { ...baseSnap, halfmoves: {} };
  assert.equal(validateAdmittedProofState(objectHalf).ok, false);

  // NaN halfmoves
  const nanHalf = cloneState(base);
  nanHalf.halfmoves = NaN;
  assert.equal(validateAdmittedProofState(nanHalf).ok, false);

  // Infinity halfmoves
  const infHalf = cloneState(base);
  infHalf.halfmoves = Infinity;
  assert.equal(validateAdmittedProofState(infHalf).ok, false);

  // Negative halfmoves
  const negHalf = cloneState(base);
  negHalf.halfmoves = -1;
  assert.equal(validateAdmittedProofState(negHalf).ok, false);

  // Fractional halfmoves
  const fracHalf = cloneState(base);
  fracHalf.halfmoves = 2.5;
  assert.equal(validateAdmittedProofState(fracHalf).ok, false);

  // Zero fullmoves (must be >= 1)
  const zeroFull = cloneState(base);
  zeroFull.fullmoves = 0;
  assert.equal(validateAdmittedProofState(zeroFull).ok, false);

  // Negative fullmoves
  const negFull = cloneState(base);
  negFull.fullmoves = -5;
  assert.equal(validateAdmittedProofState(negFull).ok, false);

  // Valid safe integers accepted
  const validClocks = cloneState(base);
  validClocks.halfmoves = 50;
  validClocks.fullmoves = 100;
  assert.equal(validateAdmittedProofState(validClocks).ok, true);
});

test('en passant admission: rejects out-of-range square aliases including 32-bit representations', () => {
  const base = parseFen('4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1');
  assert.equal(validateAdmittedProofState(base).ok, true);

  // 1. Positive 32-bit alias: 2**32 + 0x50 (4294967376)
  const posAlias = cloneState(base);
  posAlias.epSquare = 4294967376;
  const resPos = validateAdmittedProofState(posAlias);
  assert.equal(resPos.ok, false);
  assert.equal(resPos.reason, 'unsupported_state');
  assert.match(resPos.message!, /Invalid en passant square/i);

  // 2. Negative 32-bit alias: -(2**32 - 0x50) (-4294967216)
  const negAlias = cloneState(base);
  negAlias.epSquare = -4294967216;
  const resNeg = validateAdmittedProofState(negAlias);
  assert.equal(resNeg.ok, false);
  assert.equal(resNeg.reason, 'unsupported_state');
  assert.match(resNeg.message!, /Invalid en passant square/i);

  // 3. Positive alias with spoofed array extra-properties attached
  const spoofed = cloneState(base);
  spoofed.epSquare = 4294967376;
  const spoofedBoard = spoofed.board as unknown as Record<number, string | null>;
  spoofedBoard[4294967376] = null;
  spoofedBoard[4294967360] = 'p';
  spoofedBoard[4294967392] = null;
  const resSpoofed = validateAdmittedProofState(spoofed);
  assert.equal(resSpoofed.ok, false);
  assert.equal(resSpoofed.reason, 'unsupported_state');
  assert.match(resSpoofed.message!, /Invalid en passant square/i);
});

test('position semantics error handling: catches only FenError and rethrows unexpected programmer errors (P2)', () => {
  const valid = parseFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1');

  // 1. Normal semantic failure throws FenError and is converted to unsupported_state
  const twoWhiteKings = cloneState(valid);
  twoWhiteKings.board[0x10] = 'K';
  const semanticRes = validateAdmittedProofState(twoWhiteKings);
  assert.equal(semanticRes.ok, false);
  assert.equal(semanticRes.reason, 'unsupported_state');
  assert.match(semanticRes.message!, /Invalid king count/);

  // 2. Unexpected programmer/system error (non-FenError) must be rethrown via controlled throwing accessor without monkeypatching
  let variantAccesses = 0;
  const throwingState: PositionState = {
    ...valid,
    get variant(): Variant {
      variantAccesses++;
      if (variantAccesses > 2) {
        throw new TypeError('Unexpected engine internal error');
      }
      return 'standard';
    },
  };

  assert.throws(
    () => validateAdmittedProofState(throwingState),
    (err: unknown) => err instanceof TypeError && (err as Error).message === 'Unexpected engine internal error',
  );
});
