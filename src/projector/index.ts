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
export {
  type P2aArtifactAdapter,
  type P2aArtifactBinding,
  type P2aPlanningCandidate,
  type P2aPlanningSelection,
} from './p2a-artifacts.js';
export {
  type ProjectSourceInput,
  type ProjectSourceTargetSnapshot,
  type ProjectSourceWriter,
  type ProjectSourceWriterFactory,
} from './project-source-writer.js';
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
