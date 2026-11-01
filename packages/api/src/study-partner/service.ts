import { createHash } from 'node:crypto';
import { FenError, IllegalMoveError, Position, type Variant } from '@chess-platform/core';
import { InvalidFenError } from '@chess-platform/engine';
import type {
  StudyPartnerRepository,
  StudyPartnerSessionDetail,
  StudyPartnerTurnRow,
} from '@chess-platform/persistence';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/ids.js';
import { HttpError } from '../http/errors.js';
import { coreFenValidator } from '../analysis/fen-validator.js';
import { isUciShape } from '../analysis/uci.js';
import type { CoachInput, CoachOutcome, CoachService } from '../coach/coach-service.js';
import {
  STUDY_PARTNER_COACHING_VERSION,
  storedStudyPartnerCoaching,
  studyPartnerCoaching,
  type StudyPartnerCoachingV1,
} from './coaching.js';

export const MAX_STUDY_PARTNER_TURNS = 20;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const STUDY_PARTNER_IDEMPOTENCY_KEY_PATTERN = '^[A-Za-z0-9._:-]{1,128}$';
export const STUDY_PARTNER_VARIANTS = ['standard'] as const satisfies readonly Variant[];

type ProductionCoach = Pick<CoachService, 'coach'>;

export interface StudyPartnerTurn {
  readonly id: string;
  readonly turnNumber: number;
  readonly move: string;
  readonly fenBefore: string;
  readonly fenAfter: string;
  readonly coaching: StudyPartnerCoachingV1;
  readonly sessionVersion: number;
  readonly createdAt: Date;
}

export interface StudyPartnerSession {
  readonly id: string;
  readonly variant: Variant;
  readonly initialFen: string;
  readonly currentFen: string;
  readonly status: 'active' | 'completed';
  readonly version: number;
  readonly turnCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly turns: readonly StudyPartnerTurn[];
}

export interface SubmitStudyPartnerTurnResult {
  readonly turn: StudyPartnerTurn;
  readonly replayed: boolean;
}

export interface StudyPartnerServiceOptions {
  readonly repository: StudyPartnerRepository;
  readonly coach: ProductionCoach;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

function cancelled(): Error {
  const error = new Error('request cancelled');
  error.name = 'AbortError';
  return error;
}

function turnView(row: StudyPartnerTurnRow): StudyPartnerTurn {
  if (row.coachingVersion !== STUDY_PARTNER_COACHING_VERSION) {
    throw new Error('unsupported stored Study Partner coaching version');
  }
  return {
    id: row.id,
    turnNumber: row.turnNumber,
    move: row.move,
    fenBefore: row.fenBefore,
    fenAfter: row.fenAfter,
    coaching: storedStudyPartnerCoaching(row.coaching),
    sessionVersion: row.sessionVersion,
    createdAt: row.createdAt,
  };
}

function sessionView(detail: StudyPartnerSessionDetail): StudyPartnerSession {
  const row = detail.session;
  return {
    id: row.id,
    variant: row.variant,
    initialFen: row.initialFen,
    currentFen: row.currentFen,
    status: row.status,
    version: row.version,
    turnCount: row.turnCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    turns: detail.turns.map(turnView),
  };
}

function hashTurn(sessionId: string, move: string, expectedVersion: number): string {
  return createHash('sha256')
    .update(JSON.stringify({ sessionId, move, expectedVersion }))
    .digest('hex');
}

export class StudyPartnerService {
  constructor(private readonly options: StudyPartnerServiceOptions) {}

  async create(ownerId: string, variant: Variant, initialFen: string): Promise<StudyPartnerSession> {
    if (variant !== 'standard') {
      throw HttpError.validation('variant is not supported by Study Partner v1', {
        variant: `supported variants: ${STUDY_PARTNER_VARIANTS.join(', ')}`,
      });
    }
    let canonicalFen: string;
    try {
      coreFenValidator.validate(initialFen, variant);
      canonicalFen = Position.fromFen(initialFen, variant).fen();
    } catch {
      throw HttpError.validation('invalid FEN', { initialFen: 'invalid FEN for variant' });
    }
    const session = await this.options.repository.createSession({
      id: this.options.ids.next(),
      ownerId,
      variant,
      initialFen: canonicalFen,
      now: new Date(this.options.clock.now()),
    });
    return sessionView({ session, turns: [] });
  }

  async get(ownerId: string, sessionId: string): Promise<StudyPartnerSession> {
    const detail = await this.options.repository.findOwnedSession(sessionId, ownerId);
    if (!detail) throw HttpError.notFound('study partner session not found');
    return sessionView(detail);
  }

  async submitTurn(input: {
    readonly ownerId: string;
    readonly sessionId: string;
    readonly move: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
    readonly charge: () => Promise<void>;
  }): Promise<SubmitStudyPartnerTurnResult> {
    if (!isUciShape(input.move)) throw HttpError.validation('invalid move', { move: 'invalid UCI move' });
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw HttpError.validation('expectedVersion must be a non-negative integer');
    }
    if (!new RegExp(STUDY_PARTNER_IDEMPOTENCY_KEY_PATTERN).test(input.idempotencyKey)) {
      throw HttpError.validation('Idempotency-Key is malformed');
    }
    if (input.signal.aborted) throw cancelled();
    const requestHash = hashTurn(input.sessionId, input.move, input.expectedVersion);
    const now = new Date(this.options.clock.now());
    const claim = await this.options.repository.claimTurn({
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      expectedVersion: input.expectedVersion,
      maxTurns: MAX_STUDY_PARTNER_TURNS,
      now,
    });
    if (claim.kind === 'replayed') return { turn: turnView(claim.turn), replayed: true };
    if (claim.kind === 'not_found') throw HttpError.notFound('study partner session not found');
    if (claim.kind === 'inactive') throw HttpError.conflict('study partner session is completed');
    if (claim.kind === 'version_conflict') {
      throw HttpError.conflict('study partner session version conflict', {
        expectedVersion: input.expectedVersion,
        currentVersion: claim.currentVersion,
      });
    }
    if (claim.kind === 'turn_limit_reached') {
      throw HttpError.validation(`study partner sessions are limited to ${String(MAX_STUDY_PARTNER_TURNS)} turns`);
    }
    if (claim.kind === 'idempotency_conflict') {
      throw HttpError.validation('Idempotency-Key was already used with a different turn request');
    }
    if (claim.kind === 'failed') {
      throw HttpError.conflict('this Idempotency-Key belongs to a failed turn; use a new key to retry');
    }
    if (claim.kind === 'exhausted') {
      throw HttpError.conflict('this session cannot accept new turns after an ambiguous accepted turn; end or delete it');
    }
    if (claim.kind === 'in_progress') throw HttpError.conflict('a study partner turn is already in progress');

    const ref = {
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      now,
    };
    let rateLimitRefused = false;
    try {
      const detail = await this.options.repository.findOwnedSession(input.sessionId, input.ownerId);
      if (!detail) throw HttpError.notFound('study partner session not found');
      try {
        coreFenValidator.validate(detail.session.currentFen, detail.session.variant);
      } catch (error: unknown) {
        if (error instanceof InvalidFenError || error instanceof FenError) {
          throw HttpError.validation('invalid FEN in study partner session', {
            currentFen: 'invalid FEN for variant',
          });
        }
        throw error;
      }
      const before = Position.fromFen(detail.session.currentFen, detail.session.variant);
      let after: Position;
      try {
        after = before.play(input.move);
      } catch (error: unknown) {
        if (error instanceof IllegalMoveError) {
          throw HttpError.validation('illegal move for the authoritative position', {
            move: 'illegal move',
          });
        }
        throw error;
      }
      if (input.signal.aborted) throw cancelled();

      const coachInput: CoachInput = {
        fen: detail.session.currentFen,
        variant: detail.session.variant,
        move: input.move,
        moves: detail.turns.map((turn) => turn.move),
        signal: input.signal,
      };
      const outcome: CoachOutcome = await this.options.coach.coach(coachInput, async () => {
        if (input.signal.aborted) throw cancelled();
        const accepted = await this.options.repository.acceptTurn({
          ...ref,
          now: new Date(this.options.clock.now()),
        });
        if (!accepted) throw HttpError.conflict('study partner turn is no longer claimable');
        try {
          await input.charge();
        } catch (error: unknown) {
          rateLimitRefused = error instanceof HttpError && error.status === 429;
          throw error;
        }
      });
      if (input.signal.aborted) throw cancelled();
      if (
        outcome.fen !== detail.session.currentFen
        || outcome.variant !== detail.session.variant
        || outcome.move !== input.move
      ) {
        throw new Error('production Coach returned a result for another position or move');
      }
      const coaching = studyPartnerCoaching(outcome);
      const committed = await this.options.repository.commitTurn({
        ...ref,
        turnId: this.options.ids.next(),
        expectedVersion: input.expectedVersion,
        move: input.move,
        fenBefore: detail.session.currentFen,
        fenAfter: after.fen(),
        coaching: { ...coaching },
        coachingVersion: STUDY_PARTNER_COACHING_VERSION,
        now: new Date(this.options.clock.now()),
      });
      if (committed.kind === 'not_found') throw HttpError.notFound('study partner session not found');
      if (committed.kind === 'conflict') throw HttpError.conflict('study partner session changed before commit');
      return { turn: turnView(committed.turn), replayed: false };
    } catch (error: unknown) {
      const failedRef = { ...ref, now: new Date(this.options.clock.now()) };
      if (rateLimitRefused) {
        const persisted = await this.options.repository.refuseTurn(failedRef);
        if (!persisted) throw new Error('Study Partner rate-limit refusal was not persisted');
      } else {
        try {
          await this.options.repository.failTurn(failedRef);
        } catch {
          // Ambiguous-work cleanup is best effort; preserve the original mapped failure.
        }
      }
      throw error;
    }
  }

  async end(ownerId: string, sessionId: string, expectedVersion: number): Promise<StudyPartnerSession> {
    const result = await this.options.repository.endSession({
      ownerId,
      sessionId,
      expectedVersion,
      now: new Date(this.options.clock.now()),
    });
    if (result.kind === 'not_found') throw HttpError.notFound('study partner session not found');
    if (result.kind === 'version_conflict') {
      throw HttpError.conflict('study partner session version conflict', {
        expectedVersion,
        currentVersion: result.currentVersion,
      });
    }
    if (result.kind === 'turn_in_progress') throw HttpError.conflict('a study partner turn is in progress');
    const detail = await this.options.repository.findOwnedSession(sessionId, ownerId);
    if (!detail) throw HttpError.notFound('study partner session not found');
    return sessionView(detail);
  }

  async delete(ownerId: string, sessionId: string): Promise<void> {
    const result = await this.options.repository.deleteOwnedSession(
      sessionId,
      ownerId,
      new Date(this.options.clock.now()),
    );
    if (result.kind === 'not_found') throw HttpError.notFound('study partner session not found');
    if (result.kind === 'turn_in_progress') throw HttpError.conflict('a study partner turn is in progress');
  }
}
