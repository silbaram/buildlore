export {
  ProjectionError,
  SourceDocumentError,
  type ProjectionErrorCode,
  type SourceDocumentErrorCode,
} from './errors.js';
export {
  createSourceDocument,
  normalizeSourceBody,
  parseSourceDocument,
  renderSourceDocument,
  validateSourceDocument,
} from './source-document.js';
export { createP2aPlanningProjector } from './p2a-planning-projector.js';
export { createP2aExecutionKnowledgeProjector } from './p2a-execution-projector.js';
export {
  createProjectSyncService,
  PROJECT_SYNC_SCHEMA_VERSION,
  ProjectSyncError,
  type CreateProjectSyncServiceOptions,
  type ProjectSyncDecisionCounts,
  type ProjectSyncErrorCode,
  type ProjectSyncFailurePhase,
  type ProjectSyncInput,
  type ProjectSyncPlanEntrySummary,
  type ProjectSyncPlanSummary,
  type ProjectSyncPort,
  type ProjectSyncRecoveryAction,
  type ProjectSyncSummary,
  type ProjectSyncWriteSummary,
} from './sync.js';
export {
  EXECUTION_INCLUSION_POLICY_VERSION,
  EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION,
  type CanonicalTaskLineage,
  type CreateP2aExecutionProjectorOptions,
  type ExecutionDecision,
  type ExecutionExcludeReason,
  type ExecutionIncludeReason,
  type ExecutionKnowledgeProjectorPort,
  type ExecutionProjectionApplyResult,
  type ExecutionProjectionInput,
  type ExecutionProjectionPlan,
  type ExecutionProjectionPlanEntry,
  type ExecutionProjectionWriteResult,
  type ExecutionQuarantineReason,
  type ExecutionReasonCode,
} from './execution-types.js';
export {
  type P2aArtifactAdapter,
  type P2aArtifactBinding,
  type P2aPlanningCandidate,
  type P2aPlanningSelection,
} from './p2a-artifacts.js';
export {
  PROJECTION_PLAN_SCHEMA_VERSION,
  type CreateP2aPlanningProjectorOptions,
  type PlanningDocumentKind,
  type PlanningProjectionInput,
  type PlanningProjectorPort,
  type ProjectionApplyResult,
  type ProjectionDecision,
  type ProjectionPlan,
  type ProjectionPlanEntry,
  type ProjectionReasonCode,
  type ProjectionWriteResult,
  type ProjectionWriteStatus,
  type RevisionTimestampPort,
  type RevisionTimestampRequest,
  type RevisionTimestampResolution,
  type TimestampSource,
} from './planning-types.js';
export {
  MAX_SOURCE_BODY_CHARS,
  SOURCE_DOCUMENT_SCHEMA_VERSION,
  type BuildLoreSourceMetadata,
  type CreateSourceDocumentInput,
  type SourceDocument,
  type SourceType,
} from './types.js';
