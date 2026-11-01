import { Position, validateFen } from '@chess-platform/core';
import {
  DEFAULT_STUDY_VARIANT,
  type PositionReader,
  type StudyVariant,
} from '@chess-platform/studies';

export class CorePositionReader implements PositionReader {
  legalSans(fen: string, variant: StudyVariant = DEFAULT_STUDY_VARIANT): readonly string[] {
    validateFen(fen, variant);
    const pos = Position.fromFen(fen, variant);
    return pos.legalMoves().map((m) => pos.toSan(m));
  }

  play(fen: string, san: string, variant: StudyVariant = DEFAULT_STUDY_VARIANT): string {
    validateFen(fen, variant);
    const pos = Position.fromFen(fen, variant);
    const legalMoves = pos.legalMoves();
    let move = legalMoves.find((m) => pos.toSan(m) === san);
    if (!move) {
      const bareSan = (s: string) =>
        s
          .replace(/[+#]+$/, '')
          .replace(/[!?]+$/, '')
          .replace(/^0-0-0$/, 'O-O-O')
          .replace(/^0-0$/, 'O-O');
      const target = bareSan(san);
      move = legalMoves.find((m) => bareSan(pos.toSan(m)) === target);
    }
    if (!move) {
      throw new Error(`Move '${san}' is not legal from position '${fen}'`);
    }
    return pos.play(move).fen();
  }

  initialFen(variant: StudyVariant = DEFAULT_STUDY_VARIANT): string {
    return Position.initial(variant).fen();
  }
}
