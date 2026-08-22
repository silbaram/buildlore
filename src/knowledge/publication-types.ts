import type { TrackingClassification } from './tracking-types.js';

export const KNOWLEDGE_PUBLISH_PLAN_SCHEMA_VERSION =
  'buildlore.knowledge-publish-plan.v1' as const;
export const KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION =
  'buildlore.knowledge-publish-result.v1' as const;
export const KNOWLEDGE_COMMIT_LINEAGE_SCHEMA_VERSION =
  'buildlore.knowledge-commit-lineage.v1' as const;

export type PublicationDigest = `sha256:${string}`;
export type GitObjectId = string;

export interface KnowledgePublishOptions {
  readonly codeRevision: GitObjectId;
  readonly embeddingCompatibilityDigest: PublicationDigest;
  readonly includePolicyTrack?: boolean;
  readonly modelCompatibilityDigest: PublicationDigest;
  readonly profileDigest: PublicationDigest;
  readonly promptDigest: PublicationDigest;
  readonly registration?: boolean;
  readonly sourceRevision: GitObjectId;
}

export interface KnowledgePublishPlanInput extends KnowledgePublishOptions {
  readonly projectId: string;
}

export interface KnowledgePublishCommitInput extends KnowledgePublishPlanInput {
  readonly expectedPlanDigest: PublicationDigest;
}

export type PublishPathStatus = 'added' | 'deleted' | 'modified';

export interface PublishNumstat {
  readonly added: number | null;
  readonly deleted: number | null;
}

export interface PublishPathEntry {
  readonly classification: Exclude<TrackingClassification, 'always-ignore'>;
  readonly contentSha256: PublicationDigest | null;
  readonly mode: '100644' | null;
  readonly numstat: PublishNumstat;
  readonly reasonCode: 'selected';
  readonly relativePath: string;
  readonly status: PublishPathStatus;
}

export type ForeignChangeKind = 'staged' | 'unstaged' | 'untracked';

export interface ForeignPathSummary {
  readonly kind: ForeignChangeKind;
  readonly relativePath: string;
  readonly status: string;
}

export interface ForeignChangeBucket {
  readonly count: number;
  readonly entries: readonly ForeignPathSummary[];
  readonly overflow: boolean;
}

export interface ForeignChangeSummary {
  readonly digest: PublicationDigest;
  readonly staged: ForeignChangeBucket;
  readonly unstaged: ForeignChangeBucket;
  readonly untracked: ForeignChangeBucket;
}

export interface RegistrationManifestEntry {
  readonly contentSha256: PublicationDigest;
  readonly relativePath: 'manifest.json';
  readonly registeredProjectId: string;
}

export type PublishBlockReason =
  | 'DIRTY_INDEX'
  | 'EMPTY_SELECTION'
  | 'FOREIGN_STAGED_CHANGE'
  | 'MANIFEST_REGISTRATION_INVALID'
  | 'PATH_UNSAFE'
  | 'ROOT_CHANGE_NOT_ALLOWED'
  | 'TRACKING_POLICY_VIOLATION'
  | 'UNMERGED_CHANGE';

export interface KnowledgePublishPlan {
  readonly baseRevision: GitObjectId;
  readonly blockReasons: readonly PublishBlockReason[];
  readonly codeRevision: GitObjectId;
  readonly eligible: boolean;
  readonly foreignChanges: ForeignChangeSummary;
  readonly indexSnapshotDigest: PublicationDigest;
  readonly lineageDigest: PublicationDigest;
  readonly localUpstreamRevision: GitObjectId | null;
  readonly planDigest: PublicationDigest;
  readonly projectId: string;
  readonly registrationManifest: RegistrationManifestEntry | null;
  readonly repositoryIdentityDigest: PublicationDigest;
  readonly schemaVersion: typeof KNOWLEDGE_PUBLISH_PLAN_SCHEMA_VERSION;
  readonly selectedPaths: readonly PublishPathEntry[];
  readonly sourceRevision: GitObjectId;
  readonly trackingPolicyDigest: PublicationDigest;
}

export interface KnowledgeCommitLineageV1 {
  readonly codeRevision: GitObjectId;
  readonly compilerPackage: 'llm-wiki-compiler';
  readonly compilerPackageIntegrity: string;
  readonly compilerVersion: '1.1.0';
  readonly embeddingCompatibilityDigest: PublicationDigest;
  readonly knowledgeParentRevision: GitObjectId;
  readonly knowledgeTreeRevision: GitObjectId;
  readonly modelCompatibilityDigest: PublicationDigest;
  readonly planDigest: PublicationDigest;
  readonly profileDigest: PublicationDigest;
  readonly projectId: string;
  readonly promptDigest: PublicationDigest;
  readonly schemaVersion: typeof KNOWLEDGE_COMMIT_LINEAGE_SCHEMA_VERSION;
  readonly selectedPathsDigest: PublicationDigest;
  readonly sourceRevision: GitObjectId;
  readonly trackingPolicyDigest: PublicationDigest;
}

export type PublicationFailureCode =
  | 'PUBLISH_DIRTY_INDEX'
  | 'PUBLISH_INELIGIBLE'
  | 'PUBLISH_PARTIAL'
  | 'PUBLISH_PATH_DRIFT'
  | 'PUBLISH_PLAN_DRIFT'
  | 'PUBLISH_POLICY_BLOCKED'
  | 'PUBLISH_REPOSITORY_DRIFT'
  | 'PUBLISH_TRANSACTION_FAILED';

export interface PublishForeignCounts {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
}

interface PublishResultBase {
  readonly baseRevision: GitObjectId;
  readonly foreignCounts: PublishForeignCounts;
  readonly localCommitPreserved: boolean;
  readonly partial: boolean;
  readonly pinRequired: true;
  readonly projectId: string;
  readonly recoveryCommand: readonly string[];
  readonly schemaVersion: typeof KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION;
  readonly stagedPaths: readonly string[];
  readonly treeRevision: GitObjectId | null;
  readonly warnings: readonly string[];
}

export interface KnowledgePublishBlockedResult extends PublishResultBase {
  readonly errorCode: PublicationFailureCode;
  readonly knowledgeRevision: GitObjectId | null;
  readonly state: 'blocked';
}

export interface KnowledgePublishCommittedResult extends PublishResultBase {
  readonly knowledgeRevision: GitObjectId;
  readonly state: 'committed';
  readonly treeRevision: GitObjectId;
}

export type KnowledgePublishResult =
  | KnowledgePublishBlockedResult
  | KnowledgePublishCommittedResult;

export interface PublicationBlobPolicyPort {
  validate(
    projectId: string,
    relativePath: string,
    content: Buffer,
    expectedDigest: PublicationDigest,
  ): Promise<boolean>;
}

export interface PublicationFaultHooks {
  readonly afterAdd?: () => Promise<void> | void;
  readonly afterCachedValidation?: () => Promise<void> | void;
  readonly afterCommitTree?: (commitOid: GitObjectId) => Promise<void> | void;
  readonly afterSecretScan?: () => Promise<void> | void;
  readonly afterWriteTree?: (treeOid: GitObjectId) => Promise<void> | void;
  readonly beforeAdd?: () => Promise<void> | void;
  readonly beforePostVerify?: () => Promise<void> | void;
  readonly beforeUpdateRef?: (commitOid: GitObjectId) => Promise<void> | void;
}

export class PublicationError extends Error {
  readonly code: PublicationFailureCode;
  readonly partial: boolean;

  constructor(code: PublicationFailureCode, partial = false) {
    super('Knowledge publication could not be completed safely.');
    this.name = 'PublicationError';
    this.code = code;
    this.partial = partial;
  }
}
