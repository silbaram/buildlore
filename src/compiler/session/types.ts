export const SESSION_COMPILE_PLAN_SCHEMA_VERSION = 'buildlore.compile-plan.v2' as const;
export const SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION = 'buildlore.compile-proposal.v1' as const;
export const SESSION_COMPILE_APPLY_RESULT_SCHEMA_VERSION =
  'buildlore.compile-apply-result.v1' as const;
export const SESSION_COMPILE_PROVENANCE_SCHEMA_VERSION =
  'buildlore.session-compile-provenance.v1' as const;
export const SESSION_REVIEW_CANDIDATE_SCHEMA_VERSION =
  'buildlore.session-review-candidate.v1' as const;
export const SESSION_CANDIDATE_LIST_SCHEMA_VERSION =
  'buildlore.session-candidate-list.v1' as const;
export const SESSION_CANDIDATE_APPROVAL_SCHEMA_VERSION =
  'buildlore.session-candidate-approval.v1' as const;
export const SESSION_PROMOTION_PROOF_SCHEMA_VERSION =
  'buildlore.session-promotion-proof.v1' as const;
export const SESSION_COMPILE_ALGORITHM_VERSION = 'buildlore.session-planner.v1' as const;

export type SessionSha256Digest = `sha256:${string}`;

export interface SessionCompileLimits {
  readonly maxCitationsPerPage: 512;
  readonly maxLinksPerPage: 256;
  readonly maxMergeCandidates: 512;
  readonly maxPageBytes: 524288;
  readonly maxPlanBytes: 33554432;
  readonly maxProposalBytes: 524288;
  readonly maxProposals: 50;
  readonly maxQuoteCodeUnits: 512;
  readonly maxSourceBytes: 524288;
  readonly maxSources: 4096;
  readonly maxTasks: 8192;
}

export interface SessionCitationAnchor {
  readonly anchorId: string;
  readonly originalFile: string;
  readonly originalLine: number;
  readonly quote: string;
  readonly quoteDigest: SessionSha256Digest;
  readonly sourceId: string;
}

export interface SessionPlannedSource {
  readonly citationAnchors: readonly SessionCitationAnchor[];
  readonly compilerSourceContentDigest: SessionSha256Digest;
  readonly compilerSourceId: string;
  readonly originalContentDigest: SessionSha256Digest;
  readonly revision: SessionSha256Digest;
  readonly sanitizedBody: string;
  readonly sanitizedContentDigest: SessionSha256Digest;
  readonly sourceId: string;
  readonly sourceKind: 'markdown' | 'planning';
  readonly sourceRef: string;
  readonly title: string;
}

export type SessionRequestedPageKind =
  | 'concept'
  | 'decision'
  | 'failure'
  | 'query'
  | 'verification';

export interface SessionPlanTask {
  readonly allowedSourceIds: readonly string[];
  readonly endLine: number;
  readonly headingKey: string;
  readonly mergeCandidateIds: readonly string[];
  readonly outputBounds: Readonly<{
    readonly maxBytes: number;
    readonly maxCitations: number;
    readonly maxLinks: number;
  }>;
  readonly requestedPageKinds: readonly SessionRequestedPageKind[];
  readonly sourceId: string;
  readonly startLine: number;
  readonly taskId: string;
}

export interface SessionMergeCandidate {
  readonly candidateId: string;
  readonly deterministicEvidence: Readonly<{
    readonly scoreBasisPoints: number;
    readonly sharedTokens: readonly string[];
  }>;
  readonly memberSourceIds: readonly string[];
  readonly memberTaskIds: readonly string[];
  readonly orderingKey: string;
}

export interface SessionAllowedLinkTarget {
  readonly pageId: string;
  readonly slug: string;
}

export interface SessionCompilePlanV1 {
  readonly schemaVersion: typeof SESSION_COMPILE_PLAN_SCHEMA_VERSION;
  readonly projectId: string;
  readonly contractDigest: SessionSha256Digest;
  readonly planDigest: SessionSha256Digest;
  readonly profileDigest: SessionSha256Digest;
  readonly policyDigest: SessionSha256Digest;
  readonly selectionDigest: SessionSha256Digest;
  readonly sourceManifestDigest: SessionSha256Digest;
  readonly existingKnowledgeDigest: SessionSha256Digest;
  readonly algorithmVersion: typeof SESSION_COMPILE_ALGORITHM_VERSION;
  readonly limits: SessionCompileLimits;
  readonly sources: readonly SessionPlannedSource[];
  readonly tasks: readonly SessionPlanTask[];
  readonly mergeCandidates: readonly SessionMergeCandidate[];
  readonly allowedLinkTargets: readonly SessionAllowedLinkTarget[];
}

export interface SessionCallerHarnessIdentity {
  readonly compatibilityDigest: SessionSha256Digest;
  readonly kind: string;
  readonly version: string;
}

export interface SessionProposalCitation {
  readonly file: string;
  readonly id: string;
  readonly line: number;
  readonly quote: string;
  readonly sourceId: string;
}

export type SessionProfileFieldValue = boolean | number | string | readonly string[];

export interface SessionCompileProposalV1 {
  readonly schemaVersion: typeof SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION;
  readonly projectId: string;
  readonly planDigest: SessionSha256Digest;
  readonly proposalId: string;
  readonly proposalDigest: SessionSha256Digest;
  readonly taskId: string;
  readonly mergeCandidateIds: readonly string[];
  readonly pageId: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: SessionRequestedPageKind;
  readonly summary: string;
  readonly body: string;
  readonly sources: readonly string[];
  readonly wikilinks: readonly string[];
  readonly citations: readonly SessionProposalCitation[];
  readonly confidence: number;
  readonly callerHarness: SessionCallerHarnessIdentity;
  readonly profileFields?: Readonly<Record<string, SessionProfileFieldValue>>;
}

export interface SessionCompileProvenanceV1 {
  readonly schemaVersion: typeof SESSION_COMPILE_PROVENANCE_SCHEMA_VERSION;
  readonly projectId: string;
  readonly planDigest: SessionSha256Digest;
  readonly proposalDigest: SessionSha256Digest;
  readonly sourceManifestDigest: SessionSha256Digest;
  readonly profileDigest: SessionSha256Digest;
  readonly policyDigest: SessionSha256Digest;
  readonly callerHarness: SessionCallerHarnessIdentity;
  readonly contractDigest: SessionSha256Digest;
  readonly bindingDigest: SessionSha256Digest;
}

export interface SessionCompilePlanRequest {
  readonly projectId: string;
}

export interface SessionCompileApplyRequest {
  readonly projectId: string;
  readonly proposalFiles: readonly string[];
}

export interface SessionCompileCandidatesRequest {
  readonly projectId: string;
}

export interface SessionCompileApproveRequest {
  readonly candidateId: string;
  readonly projectId: string;
}

export interface SessionCompilerSourceBinding {
  readonly compilerSourceContentDigest: SessionSha256Digest;
  readonly compilerSourceId: string;
  readonly sourceId: string;
}

export interface SessionCitationBinding {
  readonly citationId: string;
  readonly compilerSourceContentDigest: SessionSha256Digest;
  readonly compilerSourceId: string;
  readonly originalFile: string;
  readonly originalLine: number;
  readonly quoteDigest: SessionSha256Digest;
  readonly sourceId: string;
}

export interface SessionReviewCandidateV1 {
  readonly schemaVersion: typeof SESSION_REVIEW_CANDIDATE_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly candidateDigest: SessionSha256Digest;
  readonly projectId: string;
  readonly profileMode: 'custom' | 'default';
  readonly pageId: string;
  readonly slug: string;
  readonly kind: SessionRequestedPageKind;
  readonly target: string;
  readonly renderedPage: string;
  readonly renderedPageDigest: SessionSha256Digest;
  readonly batchDigest: SessionSha256Digest;
  readonly planDigest: SessionSha256Digest;
  readonly proposalDigest: SessionSha256Digest;
  readonly sourceManifestDigest: SessionSha256Digest;
  readonly profileDigest: SessionSha256Digest;
  readonly policyDigest: SessionSha256Digest;
  readonly contractDigest: SessionSha256Digest;
  readonly provenanceBindingDigest: SessionSha256Digest;
  readonly citationBindings: readonly SessionCitationBinding[];
  readonly compilerSources: readonly SessionCompilerSourceBinding[];
  readonly heldReasons: readonly ['manual-review-requested'];
  readonly upstreamCandidateId?: string;
}

export interface SessionCandidateSummaryV1 {
  readonly candidateId: string;
  readonly heldReasons: readonly ['manual-review-requested'];
  readonly lifecycle: 'approving' | 'pending';
  readonly targetPath: string;
  readonly pageId: string;
  readonly slug: string;
}

export interface SessionCompileCandidatesResultV1 {
  readonly schemaVersion: typeof SESSION_CANDIDATE_LIST_SCHEMA_VERSION;
  readonly projectId: string;
  readonly candidates: readonly SessionCandidateSummaryV1[];
  readonly managedPendingCount: number;
  readonly legacyPendingCount: number;
  readonly warnings: readonly Readonly<{ readonly code: string }>[];
}

export interface SessionPromotionProofV1 {
  readonly schemaVersion: typeof SESSION_PROMOTION_PROOF_SCHEMA_VERSION;
  readonly proofDigest: SessionSha256Digest;
  readonly projectId: string;
  readonly candidateId: string;
  readonly candidateDigest: SessionSha256Digest;
  readonly pageId: string;
  readonly profileMode: 'custom' | 'default';
  readonly bodyDigest: SessionSha256Digest;
  readonly titleDigest: SessionSha256Digest;
  readonly summaryDigest: SessionSha256Digest;
  readonly sourceRefsDigest: SessionSha256Digest;
  readonly citationsDigest: SessionSha256Digest;
  readonly contentHash: string;
  readonly sourceHashes: readonly string[];
  readonly citationBindings: readonly SessionCitationBinding[];
  readonly compilerSources: readonly SessionCompilerSourceBinding[];
}

export interface SessionCompileApproveResultV1 {
  readonly schemaVersion: typeof SESSION_CANDIDATE_APPROVAL_SCHEMA_VERSION;
  readonly projectId: string;
  readonly candidateId: string;
  readonly pageId: string;
  readonly outcome: 'approved';
  readonly providerUsed: false;
  readonly sideEffectsPossible: false;
  readonly warnings: readonly Readonly<{ readonly code: string }>[];
}

export interface SessionCompileApplyResultV1 {
  readonly schemaVersion: typeof SESSION_COMPILE_APPLY_RESULT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly planDigest: SessionSha256Digest;
  readonly batchDigest: SessionSha256Digest;
  readonly outcome: 'staged';
  readonly reviewRequired: true;
  readonly admissionKind: 'buildlore-review';
  readonly admittedCount: number;
  readonly heldCount: number;
  readonly skippedCount: 0;
  readonly candidateRefs: readonly string[];
  readonly sideEffectsPossible: false;
  readonly recoveryAction: 'review';
  readonly warnings: readonly Readonly<{ readonly code: string }>[];
}

export interface ProjectSessionCompilerPort {
  plan(request: SessionCompilePlanRequest): Promise<SessionCompilePlanV1>;
  apply(request: SessionCompileApplyRequest): Promise<SessionCompileApplyResultV1>;
  candidates(request: SessionCompileCandidatesRequest): Promise<SessionCompileCandidatesResultV1>;
  approve(request: SessionCompileApproveRequest): Promise<SessionCompileApproveResultV1>;
}
