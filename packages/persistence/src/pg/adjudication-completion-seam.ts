/**
 * @packageDocumentation
 * Internally owned controller and completion seam for Stage M adjudication (Issue #124).
 *
 * Guarantees that:
 * 1. Only genuine AdjudicationJobController instances evaluate proof and settlement.
 * 2. Proof job creation, stepping, and settlement occur strictly OUTSIDE DB transactions and locks.
 * 3. SettlementResult is privately retained across rollbacks or uncertain commits so
 *    retry does not re-invoke consumed jobs or drop evidence.
 * 4. Caller-supplied controllers, crafted prototypes, and external seams are strictly rejected.
 */

import {
  AdjudicationJobController,
  type AdjudicationJobView,
  type AllStepResult,
  type Game,
  type JobStepResult,
  type PreparedOperation,
  type SettlementResult,
} from '@chess-platform/game';
import { AdjudicationConflictError } from '../errors';
import type { RetainedSettlement } from './adjudication-types';

export class AdjudicationCompletionSeam {
  readonly #controller: AdjudicationJobController;
  readonly #retained = new Map<string, RetainedSettlement>();

  constructor() {
    if (arguments.length > 0) {
      throw new AdjudicationConflictError('Unauthorized controller: AdjudicationCompletionSeam accepts no external controller or arguments');
    }
    this.#controller = new AdjudicationJobController();
  }

  createProofJob(prepared: PreparedOperation, game: Game): string {
    const pending = game.adjudication;
    if (!pending || pending.operationId !== prepared.operationId) {
      throw new AdjudicationConflictError('Game pending adjudication does not match prepared operation');
    }
    return this.#controller.createJob(prepared, game);
  }

  stepProofJob(operationId: string, totalWorkBudget: number): JobStepResult {
    return this.#controller.stepJob(operationId, totalWorkBudget);
  }

  stepAllProofJobs(totalWorkBudget: number): AllStepResult {
    return this.#controller.stepAll(totalWorkBudget);
  }

  getProofJob(operationId: string): Readonly<AdjudicationJobView> | undefined {
    return this.#controller.getJob(operationId);
  }

  cancelProofJob(operationId: string): void {
    this.#controller.cancelJob(operationId);
  }

  evictProofJob(operationId: string): boolean {
    return this.#controller.evictJob(operationId);
  }

  getRetainedSettlement(gameId: string, operationId: string): RetainedSettlement | undefined {
    return this.#retained.get(`${gameId}:${operationId}`);
  }

  clearRetainedSettlement(gameId: string, operationId: string): void {
    this.#retained.delete(`${gameId}:${operationId}`);
  }

  /**
   * Evaluate (once) the settlement of a finished proof job. A later call for the same operation
   * returns the retained result when it asks for the same resolution instant and refuses otherwise.
   */
  evaluateSettlement(game: Game, gameId: string, operationId: string, resolutionAt: number): RetainedSettlement {
    const key = `${gameId}:${operationId}`;
    const existing = this.#retained.get(key);
    if (existing) {
      if (existing.resolutionAt !== resolutionAt) {
        throw new AdjudicationConflictError('A settlement for this operation was already evaluated at another resolution instant');
      }
      return existing;
    }
    const settlement: SettlementResult = this.#controller.settleJob(game, operationId, resolutionAt);
    const retained: RetainedSettlement = Object.freeze({ gameId, operationId, settlement, resolutionAt });
    this.#retained.set(key, retained);
    return retained;
  }
}
