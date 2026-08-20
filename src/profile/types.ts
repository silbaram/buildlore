import {
  BUILDLORE_LIFECYCLE_PROFILE_ID,
  BUILDLORE_LIFECYCLE_PROFILE_VERSION,
} from '../knowledge/types.js';

export const BUILDLORE_PROFILE_SCHEMA_VERSION = 'buildlore.profile.v1' as const;
export const BUILDLORE_PROFILE_ID = BUILDLORE_LIFECYCLE_PROFILE_ID;
export const BUILDLORE_PROFILE_VERSION = BUILDLORE_LIFECYCLE_PROFILE_VERSION;
export const PROFILE_PLAN_SCHEMA_VERSION = 'buildlore.profile-plan.v1' as const;
export const PROFILE_APPLY_SCHEMA_VERSION = 'buildlore.profile-apply.v1' as const;

export type OutputLanguage = 'en' | 'ko';
export type LifecycleEntityType = 'decision' | 'failure' | 'verification';
export type ProfileEntityType = 'decisions' | 'failures' | 'verifications';
export type ProfileEntityDirectory = `wiki/${ProfileEntityType}`;
export type ProfileRelationType = 'supersedes' | 'verified-by';
export type ProfileHeldReason =
  | 'contradicted'
  | 'low-confidence'
  | 'provenance-violating'
  | 'schema-violating';

export interface ProfileEntityDecision {
  readonly directory: ProfileEntityDirectory;
  readonly id: LifecycleEntityType;
  readonly upstreamType: ProfileEntityType;
}

export interface ProfileRelationDecision {
  readonly cardinality: Readonly<{ readonly from: '0..n'; readonly to: '0..n' }>;
  readonly direction: 'directed';
  readonly from: readonly ProfileEntityType[];
  readonly id: ProfileRelationType;
  readonly to: readonly ProfileEntityType[];
}

export interface ProfileLifecycleDecision {
  readonly entity: ProfileEntityType;
  readonly field: 'status';
  readonly initial: string;
  readonly terminal: readonly ['archived'];
  readonly transitions: Readonly<Record<string, readonly string[]>>;
}

export interface ProfileReviewPolicy {
  readonly hold: readonly ProfileHeldReason[];
  readonly lowConfidenceThreshold: 0.5;
  readonly treatMissingConfidenceAs: 'low';
}

export interface ProfileFreshnessPolicy {
  readonly archived: 'retain-history-exclude-active';
  readonly orphaned: 'retain-review-exclude-active';
  readonly stale: 'retain-warn-recompile';
}

export interface ProfileExclusions {
  readonly entities: readonly ['project', 'feature', 'task', 'run', 'artifact'];
  readonly relations: readonly ['implements', 'failed-by', 'produced', 'belongs-to'];
  readonly workflows: readonly ['generic-workflow', 'workflow-actions', 'artifacts', 'connectors'];
}

export interface BuildLoreLifecycleProfileV1 {
  readonly schemaVersion: typeof BUILDLORE_PROFILE_SCHEMA_VERSION;
  readonly profileId: typeof BUILDLORE_PROFILE_ID;
  readonly profileVersion: typeof BUILDLORE_PROFILE_VERSION;
  readonly outputLanguage: OutputLanguage;
  readonly entities: readonly ProfileEntityDecision[];
  readonly relations: readonly ProfileRelationDecision[];
  readonly lifecycles: readonly ProfileLifecycleDecision[];
  readonly reviewPolicy: ProfileReviewPolicy;
  readonly freshnessPolicy: ProfileFreshnessPolicy;
  readonly exclusions: ProfileExclusions;
}

export interface MaterializedProfile {
  readonly configJson: string;
  readonly configJsonHash: `sha256:${string}`;
  readonly profileJson: string;
  readonly profileJsonHash: `sha256:${string}`;
  readonly sourceHash: `sha256:${string}`;
}

export interface LifecycleReviewSignals {
  readonly confidence?: number;
  readonly contradicted?: boolean;
  readonly provenanceViolations?: readonly string[];
  readonly schemaViolations?: readonly string[];
}

export interface LifecycleFixture extends LifecycleReviewSignals {
  readonly archiveReason?: string;
  readonly entityType: LifecycleEntityType;
  readonly evidenceRefs?: readonly string[];
  readonly incomingSupersedesFromActive?: number;
  readonly outgoingPassedVerifications?: number;
  readonly resolution?: string;
  readonly state: string;
}

export interface LifecycleFixtureResult {
  readonly heldReasons: readonly ProfileHeldReason[];
  readonly issues: readonly string[];
  readonly valid: boolean;
}

export type ProfilePlanDisposition =
  | 'compatible-recompile'
  | 'migration-required'
  | 'unchanged';

export interface ProfileChangePlan {
  readonly affectedEntityTypes: readonly ProfileEntityType[];
  readonly affectedPageCounts: Readonly<Record<ProfileEntityType, number>>;
  readonly appliedHash?: `sha256:${string}`;
  readonly disposition: ProfilePlanDisposition;
  readonly migrationRequired: boolean;
  readonly outputLanguage: OutputLanguage;
  readonly profileVersion: typeof BUILDLORE_PROFILE_VERSION;
  readonly projectId: string;
  readonly reasonCodes: readonly string[];
  readonly recompileRequired: boolean;
  readonly reviewConfigHash: `sha256:${string}`;
  readonly schemaVersion: typeof PROFILE_PLAN_SCHEMA_VERSION;
  readonly sourceHash: `sha256:${string}`;
  readonly upstreamProfileHash: `sha256:${string}`;
  readonly warnings: readonly string[];
}

export interface ProfileApplyResult {
  readonly outcome: 'applied' | 'unchanged';
  readonly outputLanguage: OutputLanguage;
  readonly profileHash: `sha256:${string}`;
  readonly profileVersion: typeof BUILDLORE_PROFILE_VERSION;
  readonly projectId: string;
  readonly recompileRequired: boolean;
  readonly reviewConfigHash: `sha256:${string}`;
  readonly schemaVersion: typeof PROFILE_APPLY_SCHEMA_VERSION;
  readonly upstreamProfileHash: `sha256:${string}`;
  readonly warnings: readonly string[];
}

export interface ProjectLifecycleProfilePort {
  apply(plan: ProfileChangePlan): Promise<ProfileApplyResult>;
  plan(projectId: string): Promise<ProfileChangePlan>;
}

export interface ProfileBinding {
  readonly mode: 'custom' | 'default';
  readonly outputLanguage: OutputLanguage;
  readonly workspace: string;
}
