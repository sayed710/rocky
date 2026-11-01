/**
 * @packageDocumentation
 * Authoritative FEN validation for the analysis subsystem.
 *
 * Implements the {@link FenValidator} seam from `@chess-platform/engine` by composing
 * the engine package's {@link structuralFenValidator} (defense-in-depth: bounds length
 * and enforces a character allowlist) with `@chess-platform/core`'s {@link parseFen}
 * and {@link validatePositionSemantics} (bounded semantic legality check).
 */

import type { PositionState, Variant } from '@chess-platform/core';
import { FenError, parseFen, validatePositionSemantics } from '@chess-platform/core';
import type { FenValidator } from '@chess-platform/engine';
import { InvalidFenError, structuralFenValidator } from '@chess-platform/engine';
import { VARIANTS } from '../domain.js';

function isPlatformVariant(candidate: string): candidate is Variant {
  return (VARIANTS as readonly string[]).includes(candidate);
}

export class CoreFenValidator implements FenValidator {
  validate(fen: string, variant: string): void {
    structuralFenValidator.validate(fen, variant);

    if (!isPlatformVariant(variant)) {
      throw new InvalidFenError(`Unsupported or unknown variant "${variant}".`);
    }

    let state: PositionState;
    try {
      state = parseFen(fen, variant);
    } catch (err: unknown) {
      if (err instanceof FenError) {
        throw new InvalidFenError('Invalid FEN position.');
      }
      throw err;
    }

    try {
      validatePositionSemantics(state);
    } catch (err: unknown) {
      if (err instanceof FenError) {
        throw new InvalidFenError('Invalid FEN position.');
      }
      throw err;
    }
  }
}

export const coreFenValidator: FenValidator = new CoreFenValidator();
