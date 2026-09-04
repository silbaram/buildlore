import type { SanitizationReport } from '../sanitizer/index.js';
import type { ProjectSourceWriterFactory } from './project-source-writer.js';

export const EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION =
  'buildlore.execution-projection-plan.v1' as const;
export const EXECUTION_INCLUSION_POLICY_VERSION =
  'buildlore.execution-inclusion.v1' as const;

export type ExecutionRunStatus = 'blocked' | 'failed' | 'finished' | 'started';
export type ExecutionSourceLayout = 'graph' | 'handoff' | 'iteration' | 'maintenance';
export type ExecutionRunKind =
  | 'final_acceptance_review'
  | 'final_verification'
  | 'final_visual_review';
export type ExecutionDecision = 'blocked' | 'exclude' | 'include' | 'quarantine';
export type ExecutionIncludeReason =
  | 'failed_or_blocked'
  | 'retry_succeeded'
  | 'reusable_verification'
  | 'significant_change';
export type ExecutionExcludeReason = 'duplicate_success' | 'low_signal' | 'started';
export type ExecutionQuarantineReason =
  | 'lineage_mismatch'
  | 'lineage_missing'
  | 'malformed_status'
  | 'path_unsafe'
  | 'project_mismatch'
  | 'run_hash_mismatch'
  | 'run_reference_invalid'
  | 'timestamp_invalid'
  | 'unsupported_layout'
  | 'unsupported_schema';
export type ExecutionReasonCode =
  | ExecutionExcludeReason
  | ExecutionIncludeReason
  | ExecutionQuarantineReason
  | 'security_blocked'
  | 'security_quarantine';

export interface ExecutionVerificationSummary {
  readonly argv?: readonly string[];
  readonly command: string;
  readonly exitCode: number | null;
  readonly finishedAt: string | null;
  readonly gitHeadSha?: string;
  readonly productRevisionSha256?: string;
  readonly relatedFilesSha256?: string;
  readonly scope?: 'full' | 'related';
  readonly selectedFileCount?: number;
  readonly source: 'command' | 'config' | 'manual';
  readonly startedAt: string | null;
  readonly status: 'failed' | 'not_run' | 'passed' | 'skipped' | 'unavailable';
  readonly type: 'custom' | 'lint' | 'test' | 'typecheck';
  readonly workspaceRevisionSha256?: string;
}

export interface ObservedP2aRun {
  readonly agentTool: string;
  readonly changedFiles: readonly string[];
  readonly currentDevelopmentContractRef?: string;
  readonly currentDevelopmentContractSha256?: string;
  readonly embeddedExecutionEnvelope?: Readonly<Record<string, unknown>>;
  readonly executionEnvelopeSha256?: string;
  readonly executionEnvelopeReferenceSha256?: string;
  readonly failureClass?: string;
  readonly finishedAt: string | null;
  readonly fixSummaries: readonly string[];
  readonly guardChecks: readonly string[];
  readonly guardNotes: readonly string[];
  readonly iterationId: string;
  readonly localizationFiles: readonly string[];
  readonly localizationFindings: readonly string[];
  readonly projectId: string;
  readonly productRevisionSha256?: string;
  readonly reproductionSteps: readonly string[];
  readonly runId: string;
  readonly runKind: ExecutionRunKind | null;
  readonly sourceGateRefs: readonly Readonly<{
    path: string;
    sha256: string;
  }>[];
  readonly sourceLayout: ExecutionSourceLayout;
  readonly sourceSpecRef: string;
  readonly startedAt: string;
  readonly status: ExecutionRunStatus;
  readonly taskContractSha256: string;
  readonly taskGraphRef: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly updatedAt: string;
  readonly verification: readonly ExecutionVerificationSummary[];
  readonly verificationScope?: 'full' | 'relevant';
  readonly workspaceRevisionSha256?: string;
  readonly gitHeadSha?: string;
  readonly workspaceRef: string;
}

export interface P2aRunIndexEntry {
  readonly agentTool: string;
  readonly finishedAt: string | null;
  readonly iterationId: string;
  readonly runId: string;
  readonly runKind: ExecutionRunKind | null;
  readonly runRef: string;
  readonly startedAt: string;
  readonly status: ExecutionRunStatus;
  readonly taskGraphRef: string;
  readonly taskId: string;
  readonly workspaceRef: string;
}

export interface P2aRunIndexTask {
  readonly latestRunId: string | null;
  readonly runIds: readonly string[];
  readonly taskId: string;
}

export interface P2aRunIndex {
  readonly projectId: string;
  readonly runs: readonly P2aRunIndexEntry[];
  readonly tasks: readonly P2aRunIndexTask[];
}

export interface CanonicalTaskLineage {
  readonly graphRef: string;
  readonly graphRevision: `sha256:${string}`;
  readonly graphVersion: string;
  readonly iterationId: string;
  readonly sourceSpecRef: string;
  readonly sourceSpecRevision: `sha256:${string}`;
  readonly taskContractSha256: string;
  readonly taskId: string;
  readonly taskTitle: string;
}

export interface ExecutionAttempt {
  readonly changedFiles: readonly string[];
  readonly failureClass?: string;
  readonly finishedAt: string | null;
  readonly fixSummaries: readonly string[];
  readonly guardChecks: readonly string[];
  readonly guardNotes: readonly string[];
  readonly localizationFiles: readonly string[];
  readonly localizationFindings: readonly string[];
  readonly reproductionSteps: readonly string[];
  readonly runId: string;
  readonly runRef: string;
  readonly runRevision: `sha256:${string}`;
  readonly sourceGateRefs: readonly Readonly<{
    relativePath: string;
    revision: `sha256:${string}`;
  }>[];
  readonly startedAt: string;
  readonly status: ExecutionRunStatus;
  readonly verification: readonly ExecutionVerificationSummary[];
}

export interface ExecutionProjectionPlanEntry {
  readonly attempts: readonly Readonly<{
    runId: string;
    runRef: string;
    runRevision: `sha256:${string}`;
    status: ExecutionRunStatus;
  }>[];
  readonly decision: ExecutionDecision;
  readonly lineage?: CanonicalTaskLineage;
  readonly reasonCode: ExecutionReasonCode;
  readonly security?: SanitizationReport;
  readonly sourceRevision?: `sha256:${string}`;
  readonly sourceUri?: string;
  readonly target?: string;
  readonly taskStableId?: string;
  readonly writeStatus?: 'create' | 'unchanged' | 'update';
}

export interface ExecutionProjectionPlan {
  readonly counts: Readonly<Record<ExecutionDecision, number>>;
  readonly entries: readonly ExecutionProjectionPlanEntry[];
  readonly planFingerprint: `sha256:${string}`;
  readonly policyVersion: typeof EXECUTION_INCLUSION_POLICY_VERSION;
  readonly projectId: string;
  readonly schemaVersion: typeof EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION;
}

export interface ExecutionProjectionInput {
  readonly artifactRoot: string;
  readonly knowledgeRoot: string;
  readonly projectId: string;
}

export interface ExecutionProjectionWriteResult {
  readonly sourceRevision: `sha256:${string}`;
  readonly target: string;
  readonly taskStableId: string;
  readonly writeStatus: 'create' | 'unchanged' | 'update';
}

export interface ExecutionProjectionApplyResult {
  readonly planFingerprint: `sha256:${string}`;
  readonly projectId: string;
  readonly writes: readonly ExecutionProjectionWriteResult[];
}

export interface P2aExecutionArtifactAdapter {
  read(
    input: ExecutionProjectionInput,
    repository: string,
  ): Promise<P2aExecutionSelection>;
  verify(selection: P2aExecutionSelection): Promise<void>;
}

export interface ExecutionCandidate {
  readonly attempts: readonly ExecutionAttempt[];
  readonly body: string;
  readonly ingestedAt: string;
  readonly lineage: CanonicalTaskLineage;
  readonly reasonCode: ExecutionIncludeReason;
  readonly sourceRevision: `sha256:${string}`;
  readonly sourceUri: string;
  readonly target: string;
  readonly taskStableId: string;
  readonly title: string;
}

export interface ExecutionArtifactBinding {
  readonly relativePath: string;
  readonly revision: `sha256:${string}`;
}

export interface P2aExecutionSelection {
  readonly artifactRoot: string;
  readonly bindings: readonly ExecutionArtifactBinding[];
  readonly candidates: readonly ExecutionCandidate[];
  readonly entries: readonly ExecutionProjectionPlanEntry[];
}

export interface CreateP2aExecutionProjectorOptions {
  readonly artifactReader?: P2aExecutionArtifactAdapter;
  readonly sourceWriter?: ProjectSourceWriterFactory;
}

export interface ExecutionKnowledgeProjectorPort {
  apply(plan: ExecutionProjectionPlan): Promise<ExecutionProjectionApplyResult>;
  plan(input: ExecutionProjectionInput): Promise<ExecutionProjectionPlan>;
}
