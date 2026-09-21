import type { SourceChunk } from '../../projector/types.js';
import type { SourceRangeMappingV1 } from '../../projector/source-contracts.js';
/** Language-neutral contracts. Construction alone does not grant persistence authority. */
export type KnowledgeDigest = `sha256:${string}`;
export type KnowledgeClassification = 'observed' | 'declared' | 'inferred';
export type KnowledgeLifecycle = 'current' | 'historical' | 'superseded' | 'stale';
export type KnowledgeReviewStatus = 'proposed' | 'accepted' | 'disputed';
/** A page key. Legacy proposal codecs still restrict this to their three roles. */
export type KnowledgePageRole = string;
export type KnowledgeRendererVersion = 'knowledge-markdown-v1' | 'knowledge-markdown-v2' | 'knowledge-markdown-v3';

export interface KnowledgeSourceV1 {
  readonly chunk?: SourceChunk;
  readonly originMappings?: readonly SourceRangeMappingV1[];
  readonly sourceId: string;
  readonly sourceRef: string;
  readonly sourceContentDigest: KnowledgeDigest;
  readonly sourceRevision: string | null;
  readonly codeRevision: string | null;
  readonly tracked: boolean | null;
  /** Checkout HEAD only; neither working-source identity nor verified code revision. */
  readonly repositoryRevision?: string | null;
  readonly format: 'markdown' | 'json';
  readonly content: string;
  /** Projector-provided JSON origin of an exact sanitized projected line. */
  readonly origins?: readonly (KnowledgeSourceOriginV1 & { readonly jsonPointer: string })[];
}

export interface KnowledgeSourceOriginV1 {
  readonly projectedLine: number;
  readonly sourceRef: string;
  readonly jsonPointer?: string;
  readonly range: Readonly<{ startLine: number; startColumn: number; endLine: number; endColumn: number }>;
}

export type KnowledgeLocatorV1 =
  | Readonly<{ kind: 'lines'; start: number; end: number }>
  | Readonly<{ kind: 'json-pointer'; pointer: string }>;

export interface KnowledgeEvidenceV1 {
  readonly projectId: string;
  readonly evidenceId: KnowledgeDigest;
  readonly sourceId: string;
  readonly sourceRef: string;
  readonly sourceContentDigest: KnowledgeDigest;
  readonly sanitizedContentDigest: KnowledgeDigest;
  readonly sourceRevision: string | null;
  readonly codeRevision: string | null;
  readonly sourceRevisionUnavailableReason: 'not-provided-by-source-inventory' | null;
  readonly repositoryRevision?: string | null;
  readonly codeRevisionUnavailableReason: 'not-proven-by-source-inventory' | null;
  readonly locator: KnowledgeLocatorV1;
  readonly origin?: KnowledgeSourceOriginV1;
  readonly excerpt: string;
  readonly excerptDigest: KnowledgeDigest;
}

export interface KnowledgeSnapshotV1 {
  readonly schemaVersion: 'buildlore.knowledge-snapshot.v1';
  readonly projectId: string;
  readonly selectionDigest: KnowledgeDigest;
  readonly sanitizerPolicyDigest: KnowledgeDigest;
  readonly sanitizerRulesVersion: string;
  readonly sources: readonly KnowledgeSourceV1[];
  readonly evidence: readonly KnowledgeEvidenceV1[];
  readonly snapshotDigest: KnowledgeDigest;
}

export interface KnowledgeActorV1 {
  readonly sessionId: string;
  readonly model: string;
  readonly kind: 'agent' | 'human';
}

export interface KnowledgeFactInputV1 {
  readonly subject: string;
  readonly predicate: string | null;
  readonly statement: string;
  readonly scope: string;
  readonly classification: KnowledgeClassification;
  readonly lifecycle: KnowledgeLifecycle;
  readonly evidenceIds: readonly KnowledgeDigest[];
  /** An exact literal observation only; never an attestation of code execution. */
  readonly observation: Readonly<{ evidenceId: KnowledgeDigest; kind: 'source-literal' }> | null;
}

export interface KnowledgeRecordV1 extends KnowledgeFactInputV1 {
  readonly id: KnowledgeDigest;
  readonly projectId: string;
  readonly lifecycle: KnowledgeLifecycle;
  readonly reviewStatus: KnowledgeReviewStatus;
  readonly supersededBy: readonly KnowledgeDigest[];
  readonly derivation: Readonly<{ actor: KnowledgeActorV1; snapshotDigest: KnowledgeDigest }>;
  readonly recordDigest: KnowledgeDigest;
}

export interface KnowledgePageClaimV1 {
  readonly claimId: string;
  readonly text: string;
  readonly factIds: readonly KnowledgeDigest[];
  readonly presentation: 'current' | 'history' | 'uncertainty';
}

export interface KnowledgePageV1 {
  readonly role: KnowledgePageRole;
  readonly title: string;
  readonly sections: readonly Readonly<{
    readonly sectionId?: string;
    readonly title: string;
    readonly claims: readonly KnowledgePageClaimV1[];
  }>[];
}

export interface KnowledgeProposalV1 {
  readonly schemaVersion: 'buildlore.knowledge-proposal.v1' | 'buildlore.knowledge-proposal.v2';
  /** Required by the free-page v2 contract; absent in legacy v1. */
  readonly rootPageId?: string;
  readonly projectId: string;
  readonly snapshotDigest: KnowledgeDigest;
  readonly baselineGenerationDigest: KnowledgeDigest | null;
  readonly actor: KnowledgeActorV1;
  readonly facts: readonly KnowledgeRecordV1[];
  readonly pages: readonly KnowledgePageV1[];
  readonly supersessions: readonly Readonly<{
    readonly previousFactId: KnowledgeDigest;
    readonly replacementFactId: KnowledgeDigest;
    readonly evidenceIds: readonly KnowledgeDigest[];
  }>[];
  readonly conflicts: readonly Readonly<{ factIds: readonly KnowledgeDigest[] }> [];
  readonly proposalDigest: KnowledgeDigest;
}

export interface KnowledgeClaimReviewV1 {
  readonly targetId: string;
  readonly verdict: 'supported' | 'unsupported' | 'insufficient' | 'conflicting';
  readonly evidenceIds: readonly KnowledgeDigest[];
  readonly rationale: string;
}

/** An accountable semantic judgment, not a cryptographic proof of truth. */
export interface KnowledgeSemanticReviewV1 {
  readonly schemaVersion: 'buildlore.knowledge-semantic-review.v1';
  readonly projectId: string;
  readonly proposalDigest: KnowledgeDigest;
  readonly snapshotDigest: KnowledgeDigest;
  readonly reviewer: KnowledgeActorV1;
  readonly method: 'source-support-and-currentness';
  readonly coverageChecked: true;
  readonly judgments: readonly KnowledgeClaimReviewV1[];
  readonly reviewDigest: KnowledgeDigest;
}

export interface KnowledgeGenerationV1 {
  readonly schemaVersion: 'buildlore.knowledge-generation.v1' | 'buildlore.knowledge-generation.v2' | 'buildlore.knowledge-generation.v3';
  /** Mandatory in v2; forbidden in legacy v1. Runtime replay enforces the version boundary. */
  readonly completenessProof?: KnowledgeCompletenessProof;
  /** The generic v3 contract records reviewed revisions and unresolved issues. */
  readonly wikiProof?: KnowledgeWikiProof;
  readonly projectId: string;
  readonly snapshot: KnowledgeSnapshotV1;
  readonly baselineGenerationDigest: KnowledgeDigest | null;
  readonly proposal: KnowledgeProposalV1;
  readonly review: KnowledgeSemanticReviewV1;
  readonly records: readonly KnowledgeRecordV1[];
  readonly evidence: readonly KnowledgeEvidenceV1[];
  readonly pages: readonly KnowledgePageV1[];
  readonly reconciliationPolicyVersion: 'conservative-currentness-v1';
  readonly rendererVersion: KnowledgeRendererVersion;
  readonly generationDigest: KnowledgeDigest;
}
import type { KnowledgeCompletenessProof } from '../../compiler/project-knowledge/completeness-proof.js';
import type { KnowledgeWikiProof } from '../../compiler/project-knowledge/wiki-contracts.js';
