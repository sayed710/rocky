/**
 * @packageDocumentation
 * Shared pure adjudication requirements resolver (Issue #124, Stage 2).
 *
 * Defines and resolves the required proof roles for an admitted prepared operation,
 * matching settlement semantics conditionally with zero drift:
 * 1. Root terminal endings require zero proof roles.
 * 2. Base deadness ('global_deadness') is required initially.
 * 3. If base deadness resolves to 'dead', no further proof roles are required (immediate draw).
 * 4. If base deadness resolves to 'not_dead':
 *    - For move operations: 'successor_deadness' is required unless the successor is a cheap ending.
 *    - For flag expiry operations: 'directional_reachability' is required for the prospective winner.
 *    - For resignations: no additional proof role is required.
 */

import {
  opposite,
  Position,
} from '@chess-platform/core';
import type { PreparedOperation } from './prepared-command';
import { resolveLegalMove } from './prepared-command';
import type { ProofQuestion } from './adjudication-proof';
import type { RepetitionHistory } from './game';
import { isSuccessorCheapEnding } from './adjudication-lifecycle';

export type ProofRoleKind = 'base' | 'successor' | 'timeout';

export interface RequiredProofRole {
  readonly role: ProofRoleKind;
  readonly question: ProofQuestion;
}

export interface AdjudicationRequirements {
  readonly isRootEnding: boolean;
  readonly requiredRoles: readonly RequiredProofRole[];
}

export { isSuccessorCheapEnding };

export function resolveRequiredProofRoles(
  prepared: PreparedOperation,
  baseOutcome?: 'dead' | 'not_dead' | null,
  repetition?: RepetitionHistory,
): AdjudicationRequirements {
  const basePos = Position.fromFen(prepared.baseFen, prepared.variant);
  if (basePos.status().over) {
    return { isRootEnding: true, requiredRoles: [] };
  }

  const baseRole: RequiredProofRole = {
    role: 'base',
    question: { kind: 'global_deadness' },
  };

  if (!baseOutcome || baseOutcome === 'dead') {
    return { isRootEnding: false, requiredRoles: [baseRole] };
  }

  const intent = prepared.intent;
  if (intent.kind === 'move') {
    const moveObj = resolveLegalMove(basePos, intent.uci);
    const succPos = basePos.play(moveObj);
    if (isSuccessorCheapEnding(succPos, repetition)) {
      return { isRootEnding: false, requiredRoles: [baseRole] };
    }
    const succRole: RequiredProofRole = {
      role: 'successor',
      question: { kind: 'successor_deadness', successorFen: intent.successorFen },
    };
    return { isRootEnding: false, requiredRoles: [baseRole, succRole] };
  }

  if (intent.kind === 'expireFlag') {
    const prospectiveWinner = opposite(intent.flagged);
    const timeoutRole: RequiredProofRole = {
      role: 'timeout',
      question: { kind: 'directional_reachability', winner: prospectiveWinner },
    };
    return { isRootEnding: false, requiredRoles: [baseRole, timeoutRole] };
  }

  return { isRootEnding: false, requiredRoles: [baseRole] };
}
