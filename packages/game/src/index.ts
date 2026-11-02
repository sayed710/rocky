/**
 * @packageDocumentation
 * `@chess-platform/game` — the event-sourced game authority domain. Built on
 * `@chess-platform/core`; owns clocks, legality (server-authoritative), and the
 * durable event log from which any game is reconstructed.
 */

export * from './clock';
export * from './events';
export { ENGINE_BOT_USER_IDS, isEngineBotUserId, isHumanGamePlayers } from './bot-accounts';
export { Game, GameError, NOT_READY_MESSAGE, canMate } from './game';
export type { GameState, GameStatus, CreateGameParams, NoShowVerdict } from './game';
export * from './prepared-command';
export {
  getRegisteredEvidence,
  evaluatePreparedProof,
  type AdjudicationEvidenceHandle,
  type ProofQuestion,
  type VerifiedDeadOutcome,
  type VerifiedEvidenceOutcome,
  type VerifiedEvidenceRecord,
} from './adjudication-proof';
export * from './adjudication-lifecycle';
export {
  isSuccessorCheapEnding,
  resolveRequiredProofRoles,
  type ProofRoleKind,
  type RequiredProofRole,
  type AdjudicationRequirements,
} from './adjudication-requirements';
export {
  AdjudicationJobController,
  type AdjudicationJobView,
  type ControllerOptions,
  type JobStatus,
  type JobStepResult,
  type AllStepResult,
} from './adjudication-controller';
