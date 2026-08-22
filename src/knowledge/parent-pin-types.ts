import type { GitMachinePort } from './git-machine.js';
import type { PublicationInspectionPort } from './publication-inspection.js';
import type { GitObjectId, PublicationDigest } from './publication-types.js';
import type { RepositoryWriterLeasePort } from './repository-writer-lease.js';

export const PARENT_KNOWLEDGE_PIN_PLAN_SCHEMA_VERSION =
  'buildlore.parent-knowledge-pin-plan.v1' as const;
export const PARENT_KNOWLEDGE_PIN_RESULT_SCHEMA_VERSION =
  'buildlore.parent-knowledge-pin-result.v1' as const;

export interface ParentKnowledgePinInput {
  readonly intent: 'iteration-close';
  readonly iterationId: string;
  readonly knowledgeRevision: GitObjectId;
}

export type ParentKnowledgePinBlockReason =
  | 'KNOWLEDGE_DIRTY'
  | 'KNOWLEDGE_HEAD_MISMATCH'
  | 'KNOWLEDGE_LINEAGE_INVALID'
  | 'KNOWLEDGE_REMOTE_MISSING'
  | 'KNOWLEDGE_REMOTE_UNREADABLE'
  | 'KNOWLEDGE_REMOTE_UNREACHABLE'
  | 'PARENT_CODE_MISMATCH'
  | 'PARENT_DIRTY';

export interface ParentKnowledgePinPlan {
  readonly schemaVersion: typeof PARENT_KNOWLEDGE_PIN_PLAN_SCHEMA_VERSION;
  readonly intent: 'iteration-close';
  readonly iterationId: string;
  readonly path: 'knowledge';
  readonly parentRepositoryIdentityDigest: PublicationDigest;
  readonly knowledgeRepositoryIdentityDigest: PublicationDigest;
  readonly parentBaseRevision: GitObjectId;
  readonly codeRevision: GitObjectId;
  readonly oldKnowledgeGitlink: GitObjectId;
  readonly newKnowledgeGitlink: GitObjectId;
  readonly projectId: string | null;
  readonly sourceRevision: GitObjectId | null;
  readonly lineageDigest: PublicationDigest | null;
  readonly targetRemoteReachability: boolean;
  readonly noOp: boolean;
  readonly eligible: boolean;
  readonly blockReasons: readonly ParentKnowledgePinBlockReason[];
  readonly planDigest: PublicationDigest;
}

export type ParentKnowledgePinFailureCode =
  | 'PARENT_PIN_INELIGIBLE'
  | 'PARENT_PIN_PARTIAL'
  | 'PARENT_PIN_PLAN_DRIFT'
  | 'PARENT_PIN_POSTVERIFY_FAILED'
  | 'PARENT_PIN_REPOSITORY_BUSY'
  | 'PARENT_PIN_TRANSACTION_FAILED';

interface ParentKnowledgePinResultBase {
  readonly schemaVersion: typeof PARENT_KNOWLEDGE_PIN_RESULT_SCHEMA_VERSION;
  readonly intent: 'iteration-close';
  readonly iterationId: string;
  readonly path: 'knowledge';
  readonly projectId: string | null;
  readonly sourceRevision: GitObjectId | null;
  readonly parentBaseRevision: GitObjectId;
  readonly codeRevision: GitObjectId;
  readonly oldKnowledgeGitlink: GitObjectId;
  readonly newKnowledgeGitlink: GitObjectId;
  readonly targetRemoteReachability: boolean;
  readonly planDigest: PublicationDigest;
  readonly applied: boolean;
  readonly noOp: boolean;
  readonly partial: boolean;
  readonly resultingParentCommitSha: GitObjectId | null;
  readonly recoveryCommand: readonly string[];
}

export interface ParentKnowledgePinAppliedResult extends ParentKnowledgePinResultBase {
  readonly applied: true;
  readonly noOp: false;
  readonly partial: false;
  readonly resultingParentCommitSha: GitObjectId;
  readonly state: 'applied';
}

export interface ParentKnowledgePinNoOpResult extends ParentKnowledgePinResultBase {
  readonly applied: false;
  readonly noOp: true;
  readonly partial: false;
  readonly resultingParentCommitSha: null;
  readonly state: 'no-op';
}

export interface ParentKnowledgePinBlockedResult extends ParentKnowledgePinResultBase {
  readonly applied: false;
  readonly errorCode: ParentKnowledgePinFailureCode;
  readonly noOp: false;
  readonly state: 'blocked';
}

export type ParentKnowledgePinResult =
  | ParentKnowledgePinAppliedResult
  | ParentKnowledgePinBlockedResult
  | ParentKnowledgePinNoOpResult;

export interface ParentKnowledgePinPort {
  plan(input: ParentKnowledgePinInput): Promise<ParentKnowledgePinPlan>;
  commit(
    input: ParentKnowledgePinInput,
    expectedPlanDigest: PublicationDigest,
  ): Promise<ParentKnowledgePinResult>;
}

export interface ParentKnowledgePinFaultHooks {
  readonly afterAdd?: () => Promise<void> | void;
  readonly afterCachedValidation?: () => Promise<void> | void;
  readonly afterCommitTree?: (commitOid: GitObjectId) => Promise<void> | void;
  readonly afterWriteTree?: (treeOid: GitObjectId) => Promise<void> | void;
  readonly beforeAdd?: () => Promise<void> | void;
  readonly beforePostVerify?: (commitOid: GitObjectId) => Promise<void> | void;
  readonly beforeUpdateRef?: (commitOid: GitObjectId) => Promise<void> | void;
}

export interface ParentKnowledgePinServiceOptions {
  readonly gitMachine?: GitMachinePort;
  readonly hooks?: ParentKnowledgePinFaultHooks;
  readonly inspector?: PublicationInspectionPort;
  readonly lease?: RepositoryWriterLeasePort;
}

export class ParentKnowledgePinError extends Error {
  readonly code: ParentKnowledgePinFailureCode;
  readonly partial: boolean;

  constructor(code: ParentKnowledgePinFailureCode, partial = false) {
    super('Parent knowledge pin could not be completed safely.');
    this.name = 'ParentKnowledgePinError';
    this.code = code;
    this.partial = partial;
  }
}
