import type { SourceSanitizerPort } from '../sanitizer/index.js';
import type { P2aArtifactAdapter } from './p2a-artifacts.js';
import type { ProjectSourceWriterFactory } from './project-source-writer.js';

export const PROJECTION_PLAN_SCHEMA_VERSION = 'buildlore.projection-plan.v1' as const;

export type PlanningDocumentKind =
  | 'archived-iteration'
  | 'implementation-plan'
  | 'intake'
  | 'product-spec';

export type ProjectionDecision = 'error' | 'exclude' | 'include';
export type ProjectionWriteStatus = 'create' | 'unchanged' | 'update';
export type TimestampSource = 'approval' | 'close' | 'explicit' | 'promotion' | 'revision';

export type ProjectionReasonCode =
  | 'approval_invalid'
  | 'approved_implementation_plan'
  | 'approved_intake'
  | 'approved_product_spec'
  | 'archived_feature'
  | 'draft'
  | 'duplicate_copy'
  | 'evidence_or_review'
  | 'generated_artifact'
  | 'lineage_invalid'
  | 'maintenance'
  | 'path_unsafe'
  | 'pending_iteration'
  | 'project_mismatch'
  | 'source_collision'
  | 'task_or_run'
  | 'timestamp_unavailable'
  | 'unsupported_schema';

export interface ProjectionPlanEntry {
  readonly decision: ProjectionDecision;
  readonly documentKind?: PlanningDocumentKind;
  readonly reasonCode: ProjectionReasonCode;
  readonly sourceArtifact: string;
  readonly ingestedAt?: string;
  readonly sourceRevision?: `sha256:${string}`;
  readonly sourceUri?: string;
  readonly target?: string;
  readonly timestampSource?: TimestampSource;
  readonly writeStatus?: ProjectionWriteStatus;
}

export interface ProjectionPlan {
  readonly counts: Readonly<Record<ProjectionDecision, number>>;
  readonly entries: readonly ProjectionPlanEntry[];
  readonly planFingerprint: `sha256:${string}`;
  readonly projectId: string;
  readonly schemaVersion: typeof PROJECTION_PLAN_SCHEMA_VERSION;
}

export interface PlanningProjectionInput {
  readonly artifactRoot: string;
  readonly explicitTimestamp?: string;
  readonly knowledgeRoot: string;
  readonly projectId: string;
}

export interface RevisionTimestampRequest {
  readonly artifactRoot: string;
  readonly sourceArtifact: string;
  readonly sourceRevision: `sha256:${string}`;
}

export interface RevisionTimestampResolution {
  readonly sourceRevision: `sha256:${string}`;
  readonly timestamp: string;
}

export interface RevisionTimestampPort {
  resolveTimestamp(
    request: RevisionTimestampRequest,
  ): Promise<RevisionTimestampResolution | null>;
}

export interface CreateP2aPlanningProjectorOptions {
  readonly artifactReader?: P2aArtifactAdapter;
  readonly revisionClock?: RevisionTimestampPort;
  readonly sourceWriter?: ProjectSourceWriterFactory;
}

export interface ProjectionWriteResult {
  readonly documentKind: PlanningDocumentKind;
  readonly sourceRevision: `sha256:${string}`;
  readonly target: string;
  readonly writeStatus: ProjectionWriteStatus;
}

export interface ProjectionApplyResult {
  readonly planFingerprint: `sha256:${string}`;
  readonly projectId: string;
  readonly writes: readonly ProjectionWriteResult[];
}

export interface PlanningProjectorPort {
  apply(plan: ProjectionPlan, sanitizer: SourceSanitizerPort): Promise<ProjectionApplyResult>;
  plan(input: PlanningProjectionInput): Promise<ProjectionPlan>;
}
