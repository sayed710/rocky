/**
 * @packageDocumentation
 * Domain-owned Worker-Local Resumable Proof-Job Controller (Issue #124, Stage 2).
 *
 * Implements worker-local proof-job lifecycle across slices.
 * Private mint authority and registry integration reside securely within
 * the registry lexical module (`./adjudication-proof`).
 */

export {
  AdjudicationJobController,
  type AdjudicationJobView,
  type AllStepResult,
  type ControllerOptions,
  type JobStatus,
  type JobStepResult,
} from './adjudication-proof';
