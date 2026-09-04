import type {
  SourceRetrievalMeaningOrigin,
  SourceRetrievalMeaningV1,
} from '../../projector/source-contracts.js';

export const COMPILATION_PURPOSE_SCHEMA_VERSION =
  'buildlore.compilation-purpose.v1' as const;
export const TEXT_UNIT_SCHEMA_VERSION = 'buildlore.text-unit.v1' as const;
export const DOCUMENT_INTERPRETATION_SCHEMA_VERSION =
  'buildlore.document-interpretation.v1' as const;
export const LEGACY_CORPUS_SNAPSHOT_SCHEMA_VERSION = 'buildlore.corpus-snapshot.v1' as const;
export const CORPUS_SNAPSHOT_SCHEMA_VERSION = 'buildlore.corpus-snapshot.v2' as const;
export const HIERARCHICAL_COMPILATION_POLICY_SCHEMA_VERSION =
  'buildlore.hierarchical-compilation-policy.v1' as const;
export const SPARSE_RELATION_GRAPH_SCHEMA_VERSION =
  'buildlore.sparse-relation-graph.v1' as const;
export const COMPILE_PARTITION_CURSOR_SCHEMA_VERSION =
  'buildlore.compile-partition-cursor.v2' as const;
export const COMPILE_CONTINUATION_SCHEMA_VERSION =
  'buildlore.compile-continuation.v2' as const;
export const COMPILE_PARTITION_SCHEMA_VERSION =
  'buildlore.compile-partition.v2' as const;
export const PLANNING_DISPOSITION_INVENTORY_SCHEMA_VERSION =
  'buildlore.planning-disposition-inventory.v1' as const;
export const DOCUMENT_INTERPRETATION_RULE_SCHEMA_VERSION =
  'buildlore.document-interpretation-rule.v1' as const;
export const PAGE_BLUEPRINT_SCHEMA_VERSION = 'buildlore.page-blueprint.v2' as const;
export const WIKI_OUTLINE_SCHEMA_VERSION = 'buildlore.wiki-outline.v2' as const;
export const WIKI_OUTLINE_DIFF_SCHEMA_VERSION = 'buildlore.wiki-outline-diff.v1' as const;
export const WIKI_OUTLINE_REVIEW_SCHEMA_VERSION =
  'buildlore.wiki-outline-review.v1' as const;
export const EVIDENCE_PACK_SCHEMA_VERSION = 'buildlore.evidence-pack.v1' as const;
export const CURRENT_SESSION_GENERATION_REQUEST_SCHEMA_VERSION =
  'buildlore.current-session-generation-request.v2' as const;
export const HIERARCHICAL_WIKI_PROPOSAL_SCHEMA_VERSION =
  'buildlore.hierarchical-wiki-proposal.v2' as const;
export const WIKI_LINK_RECONCILIATION_SCHEMA_VERSION =
  'buildlore.wiki-link-reconciliation.v1' as const;
export const EXTERNAL_GENERATION_AUTHORIZATION_SCHEMA_VERSION =
  'buildlore.external-generation-authorization.v1' as const;
export const SEMANTIC_QUALITY_POLICY_SCHEMA_VERSION =
  'buildlore.semantic-quality-policy.v2' as const;
export const PAGE_QUALITY_REPORT_SCHEMA_VERSION =
  'buildlore.page-quality-report.v2' as const;
export const CORPUS_QUALITY_REPORT_SCHEMA_VERSION =
  'buildlore.corpus-quality-report.v2' as const;
export const WIKI_CONTENT_DIFF_SCHEMA_VERSION =
  'buildlore.wiki-content-diff.v1' as const;
export const INTEGRATED_WIKI_REVIEW_SURFACE_SCHEMA_VERSION =
  'buildlore.integrated-wiki-review-surface.v1' as const;
export const INTEGRATED_WIKI_CANDIDATE_REVIEW_SCHEMA_VERSION =
  'buildlore.integrated-wiki-candidate-review.v1' as const;
export const COMPILE_RUN_LEDGER_SCHEMA_VERSION = 'buildlore.compile-run-ledger.v1' as const;
export const COMPILE_INTEGRITY_REPORT_SCHEMA_VERSION =
  'buildlore.compile-integrity-report.v1' as const;
export const PAGE_OWNERSHIP_GRAPH_SCHEMA_VERSION =
  'buildlore.page-ownership-graph.v1' as const;
export const AUTHORITATIVE_WIKI_STATE_SCHEMA_VERSION =
  'buildlore.authoritative-wiki-state.v1' as const;
export const AUTHORITATIVE_WIKI_CHECK_SCHEMA_VERSION =
  'buildlore.authoritative-wiki-check.v1' as const;
export const HUMAN_ACTIVATION_APPROVAL_SCHEMA_VERSION =
  'buildlore.human-activation-approval.v1' as const;
export const LEGACY_WIKI_MIGRATION_SCHEMA_VERSION =
  'buildlore.legacy-wiki-migration.v1' as const;
export const LEGACY_WIKI_MIGRATION_REVIEW_SCHEMA_VERSION =
  'buildlore.legacy-wiki-migration-review.v1' as const;

export type HierarchySha256Digest = `sha256:${string}`;

export interface HierarchicalCompilationLimitsV1 {
  readonly maxClusterMembers: 256;
  readonly maxEvidenceBytes: 262144;
  readonly maxEvidenceSourcesPerPage: 8;
  readonly maxEvidenceUnits: 64;
  readonly maxEvidenceUnitsPerSource: 8;
  readonly maxPartitionTasks: 256;
  readonly maxPlanBytes: 33554432;
  readonly maxRelationCandidatesPerTask: 32;
  readonly maxSourceBytes: 524288;
  readonly maxSources: 4096;
  readonly maxTasks: 8192;
}

export interface HierarchicalCompilationPolicyV1 {
  readonly schemaVersion: typeof HIERARCHICAL_COMPILATION_POLICY_SCHEMA_VERSION;
  readonly limits: HierarchicalCompilationLimitsV1;
  readonly policyDigest: HierarchySha256Digest;
}

export interface CompilationPurposeV1 {
  readonly schemaVersion: typeof COMPILATION_PURPOSE_SCHEMA_VERSION;
  readonly projectId: string;
  readonly audience: readonly string[];
  readonly goals: readonly string[];
  readonly keyQuestions: readonly string[];
  readonly scopeHints: readonly string[];
  readonly excludedTopics: readonly string[];
  readonly outputLanguage: string;
  readonly requestedPageRoles: readonly string[];
  readonly wikiTitle?: string;
  readonly purposeDigest: HierarchySha256Digest;
}

export type TextUnitKind =
  | 'document'
  | 'fenced-code'
  | 'heading'
  | 'list'
  | 'paragraph'
  | 'table';

export interface TextUnitRangeV1 {
  /** One-based inclusive Unicode scalar column at the end of the unit. */
  readonly endColumn: number;
  readonly endLine: number;
  /** One-based inclusive Unicode scalar column at the start of the unit. */
  readonly startColumn: number;
  readonly startLine: number;
}

export interface TextUnitV1 {
  readonly schemaVersion: typeof TEXT_UNIT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly sourceId: string;
  readonly sourceRevision: HierarchySha256Digest;
  readonly sourceRef: string;
  readonly kind: TextUnitKind;
  readonly ordinal: number;
  readonly range: TextUnitRangeV1;
  readonly contentDigest: HierarchySha256Digest;
  /** Sanitized, digest-verified topic text when the unit can name an outline topic. */
  readonly topicLabel: string | null;
  readonly unitId: string;
}

export type DocumentLifecycle =
  | 'current'
  | 'deprecated'
  | 'draft'
  | 'superseded'
  | 'unknown';

export type DocumentAuthority = 'canonical' | 'historical' | 'supporting' | 'unknown';
export type SynthesisEligibility = 'eligible' | 'excluded' | 'review';
export type DocumentRelationKind = 'related' | 'superseded-by' | 'supersedes';

export interface DocumentRelationV1 {
  readonly kind: DocumentRelationKind;
  readonly sourceId: string;
}

export interface DocumentInterpretationV1 {
  readonly schemaVersion: typeof DOCUMENT_INTERPRETATION_SCHEMA_VERSION;
  readonly projectId: string;
  readonly sourceId: string;
  readonly sourceRevision: HierarchySha256Digest;
  readonly role: string;
  readonly lifecycle: DocumentLifecycle;
  readonly authority: DocumentAuthority;
  readonly synthesisEligibility: SynthesisEligibility;
  readonly basis: readonly string[];
  readonly confidenceBasisPoints: number;
  readonly reasonCodes: readonly string[];
  readonly relations: readonly DocumentRelationV1[];
  readonly interpretationDigest: HierarchySha256Digest;
}

export interface CorpusSnapshotSourceV1 {
  readonly retrievalMeaning?: SourceRetrievalMeaningV1;
  readonly retrievalMeaningOrigin?: SourceRetrievalMeaningOrigin;
  readonly sourceId: string;
  readonly sourceRevision: HierarchySha256Digest;
  readonly sourceRef: string;
  readonly sanitizedContentDigest: HierarchySha256Digest;
}

export interface CorpusSnapshotV1 {
  readonly schemaVersion:
    | typeof LEGACY_CORPUS_SNAPSHOT_SCHEMA_VERSION
    | typeof CORPUS_SNAPSHOT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly purposeDigest: HierarchySha256Digest;
  readonly interpretationRulesDigest: HierarchySha256Digest;
  readonly profileDigest: HierarchySha256Digest;
  readonly compilerContractDigest: HierarchySha256Digest;
  readonly sanitizerPolicyDigest: HierarchySha256Digest;
  readonly sourceManifestDigest: HierarchySha256Digest;
  readonly policyDigest: HierarchySha256Digest;
  readonly sources: readonly CorpusSnapshotSourceV1[];
  readonly textUnits: readonly TextUnitV1[];
  readonly corpusDigest: HierarchySha256Digest;
  readonly snapshotDigest: HierarchySha256Digest;
}

export interface HierarchyPlanningTaskV1 {
  readonly taskId: string;
  readonly unitId: string;
  readonly sourceId: string;
  readonly ordinal: number;
  readonly kind: TextUnitKind;
  readonly contentDigest: HierarchySha256Digest;
}

export interface SparseRelationCandidateV1 {
  readonly relationId: string;
  readonly leftTaskId: string;
  readonly rightTaskId: string;
  readonly ownerTaskId: string;
  readonly basis: 'matching-content-digest';
  readonly sharedKeyDigest: HierarchySha256Digest;
}

export interface SparseRelationGraphV1 {
  readonly schemaVersion: typeof SPARSE_RELATION_GRAPH_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly policyDigest: HierarchySha256Digest;
  readonly tasks: readonly HierarchyPlanningTaskV1[];
  readonly relations: readonly SparseRelationCandidateV1[];
  readonly taskSetDigest: HierarchySha256Digest;
  readonly relationSetDigest: HierarchySha256Digest;
  readonly graphDigest: HierarchySha256Digest;
}

export interface CompilePartitionCursorV2 {
  readonly schemaVersion: typeof COMPILE_PARTITION_CURSOR_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly graphDigest: HierarchySha256Digest;
  readonly policyDigest: HierarchySha256Digest;
  readonly partitionSize: number;
  readonly taskOffset: number;
  readonly cursorDigest: HierarchySha256Digest;
}

export interface CompileContinuationV2 {
  readonly schemaVersion: typeof COMPILE_CONTINUATION_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly graphDigest: HierarchySha256Digest;
  readonly policyDigest: HierarchySha256Digest;
  readonly partitionSize: number;
  readonly nextTaskOffset: number;
  readonly nextCursor: CompilePartitionCursorV2 | null;
  readonly acceptedPartitionDigests: readonly HierarchySha256Digest[];
  readonly complete: boolean;
  readonly continuationDigest: HierarchySha256Digest;
}

export interface TaskDispositionV1 {
  readonly taskId: string;
  readonly disposition: 'planned';
}

export interface RelationDispositionV1 {
  readonly relationId: string;
  readonly disposition: 'candidate';
}

export interface CompilePartitionV2 {
  readonly schemaVersion: typeof COMPILE_PARTITION_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly graphDigest: HierarchySha256Digest;
  readonly policyDigest: HierarchySha256Digest;
  readonly taskOffset: number;
  readonly taskDispositions: readonly TaskDispositionV1[];
  readonly relationDispositions: readonly RelationDispositionV1[];
  readonly complete: boolean;
  readonly nextCursor: CompilePartitionCursorV2 | null;
  readonly partitionDigest: HierarchySha256Digest;
}

export interface PlanningDispositionInventoryV1 {
  readonly schemaVersion: typeof PLANNING_DISPOSITION_INVENTORY_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly graphDigest: HierarchySha256Digest;
  readonly policyDigest: HierarchySha256Digest;
  readonly taskCount: number;
  readonly relationCount: number;
  readonly taskDispositionDigest: HierarchySha256Digest;
  readonly relationDispositionDigest: HierarchySha256Digest;
  readonly dispositionDigest: HierarchySha256Digest;
  readonly complete: true;
  readonly inventoryDigest: HierarchySha256Digest;
}

export interface DocumentMeaningFieldsV1 {
  readonly role?: string;
  readonly lifecycle?: DocumentLifecycle;
  readonly authority?: DocumentAuthority;
  readonly synthesisEligibility?: SynthesisEligibility;
  readonly relations?: readonly DocumentRelationV1[];
}

export interface DocumentInterpretationRuleV1 {
  readonly schemaVersion: typeof DOCUMENT_INTERPRETATION_RULE_SCHEMA_VERSION;
  readonly ruleId: string;
  readonly priority: number;
  readonly sourceRefPrefix: string | null;
  readonly sourceRefSuffix: string | null;
  readonly meaning: DocumentMeaningFieldsV1;
  readonly ruleDigest: HierarchySha256Digest;
}

export interface InterpretDocumentInputV1 {
  readonly projectId: string;
  readonly sourceId: string;
  readonly sourceRevision: HierarchySha256Digest;
  readonly sourceRef: string;
  readonly explicitMeaning: DocumentMeaningFieldsV1;
  readonly rules: readonly DocumentInterpretationRuleV1[];
}

export interface BlueprintEvidenceScopeV1 {
  readonly snapshotDigest: HierarchySha256Digest;
  readonly taskSetDigest: HierarchySha256Digest;
  readonly relationSetDigest: HierarchySha256Digest;
  readonly allowedUnitKinds: readonly TextUnitKind[];
  readonly sourceIds: readonly string[];
  /** Ordered topic-range units to consume before lexical fallback. */
  readonly preferredUnitIds: readonly string[];
}

export interface PageBlueprintV1 {
  readonly schemaVersion: typeof PAGE_BLUEPRINT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly pageId: string;
  readonly stableKey: string;
  readonly role: string;
  readonly title: string;
  readonly parentPageId: string | null;
  readonly childPageIds: readonly string[];
  readonly relatedPageIds: readonly string[];
  readonly keyQuestions: readonly string[];
  readonly requiredSections: readonly string[];
  readonly evidenceScope: BlueprintEvidenceScopeV1;
  readonly minimumDistinctSources: number;
  readonly generationOrder: number;
  readonly blueprintDigest: HierarchySha256Digest;
}

export interface WikiOutlineV1 {
  readonly schemaVersion: typeof WIKI_OUTLINE_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly graphDigest: HierarchySha256Digest;
  readonly interpretationSetDigest: HierarchySha256Digest;
  readonly purposeDigest: HierarchySha256Digest;
  readonly policyDigest: HierarchySha256Digest;
  readonly activationState: 'candidate';
  readonly rootPageId: string;
  readonly blueprints: readonly PageBlueprintV1[];
  /** Body-free reasons for requested pages intentionally omitted from the outline. */
  readonly reviewNotes: readonly string[];
  readonly outlineDigest: HierarchySha256Digest;
}

export interface WikiOutlineDiffV1 {
  readonly schemaVersion: typeof WIKI_OUTLINE_DIFF_SCHEMA_VERSION;
  readonly projectId: string;
  readonly beforeOutlineDigest: HierarchySha256Digest;
  readonly afterOutlineDigest: HierarchySha256Digest;
  readonly addedPageIds: readonly string[];
  readonly removedPageIds: readonly string[];
  readonly changedPageIds: readonly string[];
  readonly identical: boolean;
  readonly diffDigest: HierarchySha256Digest;
}

export type WikiOutlineReviewDecision = 'approved' | 'rejected';

export interface WikiOutlineReviewV1 {
  readonly schemaVersion: typeof WIKI_OUTLINE_REVIEW_SCHEMA_VERSION;
  readonly projectId: string;
  readonly outlineDigest: HierarchySha256Digest;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly decision: WikiOutlineReviewDecision;
  readonly reasonCodes: readonly string[];
  readonly activationAuthorized: false;
  readonly reviewDigest: HierarchySha256Digest;
}

export interface SanitizedEvidenceSourceV1 {
  readonly sourceId: string;
  readonly sourceRevision: HierarchySha256Digest;
  readonly sourceRef: string;
  /** Same-process opaque sanitizer approval; source bytes are not a public field. */
  readonly preparedSource: PreparedSource;
}

export interface EvidenceCitationAnchorV1 {
  readonly citationId: string;
  readonly sourceId: string;
  readonly sourceRevision: HierarchySha256Digest;
  readonly sourceRef: string;
  readonly range: TextUnitRangeV1;
  readonly quoteDigest: HierarchySha256Digest;
}

export interface EvidenceUnitV1 {
  readonly unitId: string;
  readonly sourceId: string;
  readonly kind: TextUnitKind;
  readonly range: TextUnitRangeV1;
  readonly content: string;
  readonly contentDigest: HierarchySha256Digest;
  readonly citation: EvidenceCitationAnchorV1;
}

export interface EvidenceConflictV1 {
  readonly conflictId: string;
  readonly kind: string;
  readonly unitIds: readonly string[];
  readonly status: 'unresolved';
}

export interface EvidenceGapV1 {
  readonly gapId: string;
  readonly keyQuestion: string;
  readonly reasonCode: string;
}

export interface EvidencePackV1 {
  readonly schemaVersion: typeof EVIDENCE_PACK_SCHEMA_VERSION;
  readonly projectId: string;
  readonly pageId: string;
  readonly blueprintDigest: HierarchySha256Digest;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly sanitizerPolicyDigest: HierarchySha256Digest;
  readonly units: readonly EvidenceUnitV1[];
  readonly conflicts: readonly EvidenceConflictV1[];
  readonly gaps: readonly EvidenceGapV1[];
  readonly evidenceBytes: number;
  readonly packDigest: HierarchySha256Digest;
}

export interface ApprovedChildSummaryV1 {
  readonly pageId: string;
  readonly proposalDigest: HierarchySha256Digest;
  readonly reviewDigest: HierarchySha256Digest;
  readonly summary: string;
  readonly citationIds: readonly string[];
  readonly synthesisApproved: true;
}

export interface CurrentSessionGenerationRequestV1 {
  readonly schemaVersion: typeof CURRENT_SESSION_GENERATION_REQUEST_SCHEMA_VERSION;
  readonly projectId: string;
  readonly pageId: string;
  readonly blueprintDigest: HierarchySha256Digest;
  readonly evidencePackDigest: HierarchySha256Digest;
  readonly generationOrder: number;
  readonly generationAttempt: number;
  readonly instructionCodes: readonly string[];
  readonly requiredSections: readonly string[];
  readonly requiredLinkPageIds: readonly string[];
  readonly approvedChildSummaries: readonly ApprovedChildSummaryV1[];
  readonly executionMode: 'current-session';
  readonly egress: 'none';
  readonly providerUsed: null;
  readonly processSpawned: false;
  readonly requestDigest: HierarchySha256Digest;
}

export interface HierarchicalProposalClaimV1 {
  readonly claimId: string;
  readonly text: string;
  readonly evidenceUnitIds: readonly string[];
  readonly citationIds: readonly string[];
}

export interface HierarchicalProposalSectionV1 {
  readonly sectionId: string;
  readonly title?: string;
  readonly body: string;
}

export interface HierarchicalWikiProposalV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WIKI_PROPOSAL_SCHEMA_VERSION;
  readonly projectId: string;
  readonly pageId: string;
  readonly blueprintDigest: HierarchySha256Digest;
  readonly evidencePackDigest: HierarchySha256Digest;
  readonly requestDigest: HierarchySha256Digest;
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly HierarchicalProposalSectionV1[];
  readonly claims: readonly HierarchicalProposalClaimV1[];
  readonly wikilinks: readonly string[];
  readonly citationIds: readonly string[];
  readonly lifecycle: 'candidate';
  readonly proposalDigest: HierarchySha256Digest;
}

export interface WikiLinkReconciliationEntryV1 {
  readonly pageId: string;
  readonly requiredLinkPageIds: readonly string[];
}

export interface WikiLinkReconciliationV1 {
  readonly schemaVersion: typeof WIKI_LINK_RECONCILIATION_SCHEMA_VERSION;
  readonly projectId: string;
  readonly outlineDigest: HierarchySha256Digest;
  readonly entries: readonly WikiLinkReconciliationEntryV1[];
  readonly complete: true;
  readonly reconciliationDigest: HierarchySha256Digest;
}

export interface ExternalGenerationAuthorizationV1 {
  readonly schemaVersion: typeof EXTERNAL_GENERATION_AUTHORIZATION_SCHEMA_VERSION;
  readonly projectId: string;
  readonly destinationId: string;
  readonly providerIdentity: string;
  readonly sanitizedPayloadScopeDigest: HierarchySha256Digest;
  readonly decision: 'approved';
  readonly egress: 'sanitized-evidence-only';
  readonly adapterIncluded: false;
  readonly authorizationDigest: HierarchySha256Digest;
}

export interface SemanticQualityThresholdsV1 {
  readonly minimumSectionCoverageBasisPoints: 10000;
  readonly minimumClaimGroundingBasisPoints: 10000;
  readonly minimumClaimEvidenceSupportBasisPoints: 10000;
  readonly minimumClaimTokenOverlapBasisPoints: 2500;
  readonly minimumSummaryTokenOverlapBasisPoints: 5000;
  readonly minimumTitleTokenOverlapBasisPoints: 6000;
  readonly minimumQuestionCoverageBasisPoints: 10000;
  readonly maximumRepeatedLineBasisPoints: 5000;
  readonly maximumNearDuplicateBasisPoints: 8500;
  readonly maximumOrphanBasisPoints: 500;
  readonly maximumUncategorizedPages: 0;
  readonly maximumUnresolvedConflicts: 0;
  readonly maximumOptionalSections: 8;
  readonly minimumSubstantiveUtf8Bytes: 80;
  readonly minimumUniqueTokens: 8;
}

export interface SemanticQualityPolicyV1 {
  readonly schemaVersion: typeof SEMANTIC_QUALITY_POLICY_SCHEMA_VERSION;
  readonly thresholds: SemanticQualityThresholdsV1;
  readonly policyDigest: HierarchySha256Digest;
}

export interface PageQualityReportV1 {
  readonly schemaVersion: typeof PAGE_QUALITY_REPORT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly pageId: string;
  readonly blueprintDigest: HierarchySha256Digest;
  readonly proposalDigest: HierarchySha256Digest;
  readonly evidencePackDigest: HierarchySha256Digest;
  readonly policyDigest: HierarchySha256Digest;
  readonly sectionCoverageBasisPoints: number;
  readonly claimGroundingBasisPoints: number;
  readonly claimEvidenceSupportBasisPoints: number;
  readonly titleGroundingBasisPoints: number;
  readonly summaryGroundingBasisPoints: number;
  readonly titleGrounded: boolean;
  readonly summaryGrounded: boolean;
  readonly optionalSectionCount: number;
  readonly unsupportedParagraphCount: number;
  readonly questionCoverageBasisPoints: number;
  readonly unansweredKeyQuestionCount: number;
  readonly repeatedLineBasisPoints: number;
  readonly maximumNearDuplicateBasisPoints: number;
  readonly requiredDistinctSources: number;
  readonly observedDistinctSources: number;
  readonly unresolvedConflictCount: number;
  readonly unresolvedGapCount: number;
  readonly missingRequiredLinkCount: number;
  readonly substantiveUtf8Bytes: number;
  readonly uniqueTokenCount: number;
  readonly nearDuplicatePageIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly hardQualityPassed: boolean;
  readonly eligibleForApproval: boolean;
  readonly llmJudgeUsed: false;
  readonly embeddingSimilarityUsed: false;
  readonly canonicalMutationAuthorized: false;
  readonly reportDigest: HierarchySha256Digest;
}

export interface CorpusQualityReportV1 {
  readonly schemaVersion: typeof CORPUS_QUALITY_REPORT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly outlineDigest: HierarchySha256Digest;
  readonly reconciliationDigest: HierarchySha256Digest;
  readonly policyDigest: HierarchySha256Digest;
  readonly candidateCount: number;
  readonly expectedCandidateCount: number;
  readonly pageReportDigests: readonly HierarchySha256Digest[];
  readonly reachablePageCount: number;
  readonly orphanPageIds: readonly string[];
  readonly intentionalOrphanPageIds: readonly string[];
  readonly orphanBasisPoints: number;
  readonly uncategorizedPageCount: number;
  readonly reasonCodes: readonly string[];
  readonly hardQualityPassed: boolean;
  readonly eligibleForApproval: boolean;
  readonly deterministicChecksOnly: true;
  readonly llmJudgeCanOverride: false;
  readonly embeddingSimilarityCanOverride: false;
  readonly canonicalMutationAuthorized: false;
  readonly reportDigest: HierarchySha256Digest;
}

export interface SemanticQualityEvaluationV1 {
  readonly pages: readonly PageQualityReportV1[];
  readonly corpus: CorpusQualityReportV1;
}

export type WikiContentChangeKind = 'added' | 'modified' | 'unchanged';
export type WikiSectionChangeKind = 'added' | 'modified' | 'removed' | 'unchanged';

export interface WikiSectionContentDiffV1 {
  readonly sectionId: string;
  readonly changeKind: WikiSectionChangeKind;
  readonly beforeBodyDigest: HierarchySha256Digest | null;
  readonly afterBodyDigest: HierarchySha256Digest | null;
}

export interface WikiContentDiffV1 {
  readonly schemaVersion: typeof WIKI_CONTENT_DIFF_SCHEMA_VERSION;
  readonly projectId: string;
  readonly pageId: string;
  readonly baseProposalDigest: HierarchySha256Digest | null;
  readonly candidateProposalDigest: HierarchySha256Digest;
  readonly changeKind: WikiContentChangeKind;
  readonly titleChanged: boolean;
  readonly summaryChanged: boolean;
  readonly sections: readonly WikiSectionContentDiffV1[];
  readonly addedCitationIds: readonly string[];
  readonly removedCitationIds: readonly string[];
  readonly addedWikilinkPageIds: readonly string[];
  readonly removedWikilinkPageIds: readonly string[];
  readonly diffDigest: HierarchySha256Digest;
}

export interface RemovedBaselineWikiPageV1 {
  readonly pageId: string;
  readonly baselineProposalDigest: HierarchySha256Digest;
  readonly baselineProposal: HierarchicalWikiProposalV1;
  readonly removalDigest: HierarchySha256Digest;
}

export interface IntegratedWikiReviewCoverageV1 {
  readonly expectedTaskCount: number;
  readonly observedTaskDispositionCount: number;
  readonly taskDispositionCoverageBasisPoints: number;
  readonly expectedRelationCount: number;
  readonly observedRelationDispositionCount: number;
  readonly relationDispositionCoverageBasisPoints: number;
  readonly expectedCandidateCount: number;
  readonly observedCandidateCount: number;
  readonly candidateCoverageBasisPoints: number;
  readonly expectedGenerationReceiptCount: number;
  readonly observedGenerationReceiptCount: number;
  readonly generationReceiptCoverageBasisPoints: number;
  readonly expectedPageQualityReportCount: number;
  readonly observedPageQualityReportCount: number;
  readonly pageQualityReportCoverageBasisPoints: number;
  readonly reconciliationComplete: boolean;
  readonly reachablePageCount: number;
  readonly orphanPageCount: number;
  readonly intentionalOrphanPageCount: number;
  readonly uncategorizedPageCount: number;
  readonly complete: boolean;
  readonly coverageDigest: HierarchySha256Digest;
}

/** Structural receipt contract embedded in the language-neutral review surface. */
export interface CurrentSessionGenerationReceiptContractV1 {
  readonly schemaVersion: 'buildlore.current-session-generation-receipt.v1';
  readonly projectId: string;
  readonly pageId: string;
  readonly purposeDigest: HierarchySha256Digest;
  readonly exchangeDigest: HierarchySha256Digest;
  readonly requestDigest: HierarchySha256Digest;
  readonly blueprintDigest: HierarchySha256Digest;
  readonly evidencePackDigest: HierarchySha256Digest;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly proposalDigest: HierarchySha256Digest;
  readonly sanitizerPolicyDigest: HierarchySha256Digest;
  readonly sanitizerRulesVersion: 'buildlore.sanitizer-rules.v5';
  readonly sanitizerInputDigest: HierarchySha256Digest;
  readonly generationActor: 'current-agent-session';
  readonly proposalOutputSanitized: true;
  readonly egress: 'none';
  readonly providerUsed: null;
  readonly processSpawned: false;
  readonly receiptDigest: HierarchySha256Digest;
}

export interface IntegratedWikiReviewCandidateV1 {
  readonly pageId: string;
  readonly blueprint: PageBlueprintV1;
  readonly proposal: HierarchicalWikiProposalV1;
  readonly baselineProposal: HierarchicalWikiProposalV1 | null;
  readonly generationReceipt: CurrentSessionGenerationReceiptContractV1;
  readonly contentDiff: WikiContentDiffV1;
  readonly citationAnchors: readonly EvidenceCitationAnchorV1[];
  readonly observedSourceIds: readonly string[];
  readonly unresolvedConflictIds: readonly string[];
  readonly unresolvedGapIds: readonly string[];
  readonly pageQualityReport: PageQualityReportV1;
  readonly candidateDigest: HierarchySha256Digest;
}

export interface IntegratedWikiReviewSurfaceV1 {
  readonly schemaVersion: typeof INTEGRATED_WIKI_REVIEW_SURFACE_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly graphDigest: HierarchySha256Digest;
  readonly outlineDigest: HierarchySha256Digest;
  readonly purposeDigest: HierarchySha256Digest;
  readonly compilationPolicyDigest: HierarchySha256Digest;
  readonly planningInventoryDigest: HierarchySha256Digest;
  readonly reconciliationDigest: HierarchySha256Digest | null;
  readonly semanticQualityPolicyDigest: HierarchySha256Digest;
  readonly baselineGenerationDigest: HierarchySha256Digest | null;
  readonly runCoverage: IntegratedWikiReviewCoverageV1;
  readonly candidates: readonly IntegratedWikiReviewCandidateV1[];
  readonly removedBaselinePages: readonly RemovedBaselineWikiPageV1[];
  readonly corpusQualityReport: CorpusQualityReportV1;
  readonly hardQualityPassed: boolean;
  readonly eligibleForHumanAcceptance: boolean;
  readonly canonicalMutationAuthorized: false;
  readonly reasonCodes: readonly string[];
  readonly surfaceDigest: HierarchySha256Digest;
}

export type IntegratedWikiCandidateReviewDecision = 'accepted' | 'rejected';

export interface IntegratedWikiCandidateReviewV1 {
  readonly schemaVersion: typeof INTEGRATED_WIKI_CANDIDATE_REVIEW_SCHEMA_VERSION;
  readonly projectId: string;
  readonly reviewSurfaceDigest: HierarchySha256Digest;
  readonly pageId: string;
  readonly proposalDigest: HierarchySha256Digest;
  readonly generationReceiptDigest: HierarchySha256Digest;
  readonly contentDiffDigest: HierarchySha256Digest;
  readonly pageQualityReportDigest: HierarchySha256Digest;
  readonly corpusQualityReportDigest: HierarchySha256Digest;
  readonly planningInventoryDigest: HierarchySha256Digest;
  readonly decision: IntegratedWikiCandidateReviewDecision;
  readonly reasonCodes: readonly string[];
  readonly canonicalMutationAuthorized: false;
  readonly reviewDigest: HierarchySha256Digest;
}

export interface CompileCandidateDispositionV1 {
  readonly pageId: string;
  readonly proposalDigest: HierarchySha256Digest;
  readonly evidencePackDigest: HierarchySha256Digest;
  readonly pageQualityReportDigest: HierarchySha256Digest;
  readonly generationReceiptDigest: HierarchySha256Digest;
  readonly integratedReviewDigest: HierarchySha256Digest;
  readonly childSynthesisReviewDigest: HierarchySha256Digest | null;
  readonly receiptSetDigest: HierarchySha256Digest;
  readonly reviewSurfaceDigest: HierarchySha256Digest;
  readonly integratedReviewSetDigest: HierarchySha256Digest;
  readonly childSynthesisReviewSetDigest: HierarchySha256Digest;
  readonly decision: 'accepted' | 'rejected';
}

export interface CompileRelationDispositionV1 {
  readonly relationId: string;
  readonly reviewDigest: HierarchySha256Digest;
  readonly decision: 'accepted' | 'rejected';
}

export type CompileTaskOutcomeV1 = 'emitted' | 'merged' | 'skipped';

export interface CompileTaskDispositionV1 {
  readonly taskId: string;
  readonly unitId: string;
  readonly sourceId: string;
  readonly outcome: CompileTaskOutcomeV1;
  readonly targetPageIds: readonly string[];
  readonly proposalDigests: readonly HierarchySha256Digest[];
  readonly evidenceUnitIds: readonly string[];
  readonly reasonCode: 'not-selected-for-synthesis' | null;
  readonly dispositionDigest: HierarchySha256Digest;
}

/**
 * Replayable proof that the exact immutable inputs accepted by finalization were
 * checked together. A caller-provided boolean is deliberately not sufficient.
 */
export interface CompileIntegrityReportV1 {
  readonly schemaVersion: typeof COMPILE_INTEGRITY_REPORT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly graphDigest: HierarchySha256Digest;
  readonly outlineDigest: HierarchySha256Digest;
  readonly planningInventoryDigest: HierarchySha256Digest;
  readonly partitionSetDigest: HierarchySha256Digest;
  readonly proposalSetDigest: HierarchySha256Digest;
  readonly evidencePackSetDigest: HierarchySha256Digest;
  readonly pageQualityReportSetDigest: HierarchySha256Digest;
  readonly corpusQualityReportDigest: HierarchySha256Digest;
  readonly reconciliationDigest: HierarchySha256Digest;
  readonly receiptSetDigest: HierarchySha256Digest;
  readonly reviewSurfaceDigest: HierarchySha256Digest;
  readonly integratedReviewSetDigest: HierarchySha256Digest;
  readonly childSynthesisReviewSetDigest: HierarchySha256Digest;
  readonly relationReviewSetDigest: HierarchySha256Digest;
  readonly passed: true;
  readonly reportDigest: HierarchySha256Digest;
}

export interface CompileRunLedgerV1 {
  readonly schemaVersion: typeof COMPILE_RUN_LEDGER_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly graphDigest: HierarchySha256Digest;
  readonly outlineDigest: HierarchySha256Digest;
  readonly planningInventoryDigest: HierarchySha256Digest;
  readonly taskCount: number;
  readonly relationCount: number;
  readonly partitionDigests: readonly HierarchySha256Digest[];
  readonly taskDispositions: readonly CompileTaskDispositionV1[];
  readonly relationDispositions: readonly CompileRelationDispositionV1[];
  readonly candidateDispositions: readonly CompileCandidateDispositionV1[];
  readonly corpusQualityReportDigest: HierarchySha256Digest;
  readonly integrityReportDigest: HierarchySha256Digest;
  readonly receiptSetDigest: HierarchySha256Digest;
  readonly reviewSurfaceDigest: HierarchySha256Digest;
  readonly integratedReviewSetDigest: HierarchySha256Digest;
  readonly childSynthesisReviewSetDigest: HierarchySha256Digest;
  readonly integrityPassed: true;
  readonly semanticQualityPassed: true;
  readonly taskDispositionCoverageBasisPoints: 10000;
  readonly relationDispositionCoverageBasisPoints: 10000;
  readonly candidateDispositionCoverageBasisPoints: 10000;
  readonly status: 'finalized';
  readonly eligibleForApproval: boolean;
  readonly ledgerDigest: HierarchySha256Digest;
}

export interface PageOwnershipEntryV1 {
  readonly pageId: string;
  readonly proposalDigest: HierarchySha256Digest;
  readonly parentPageId: string | null;
  readonly childPageIds: readonly string[];
  readonly ancestorPageIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly textUnitIds: readonly string[];
  readonly sectionIds: readonly string[];
  readonly sourceRevisions: readonly Readonly<{
    readonly sourceId: string;
    readonly sourceRevision: HierarchySha256Digest;
  }>[];
  readonly ownershipDigest: HierarchySha256Digest;
}

export interface PageOwnershipGraphV1 {
  readonly schemaVersion: typeof PAGE_OWNERSHIP_GRAPH_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly outlineDigest: HierarchySha256Digest;
  readonly ledgerDigest: HierarchySha256Digest;
  readonly receiptSetDigest: HierarchySha256Digest;
  readonly reviewSurfaceDigest: HierarchySha256Digest;
  readonly integratedReviewSetDigest: HierarchySha256Digest;
  readonly childSynthesisReviewSetDigest: HierarchySha256Digest;
  readonly purposeDigest: HierarchySha256Digest;
  readonly interpretationRulesDigest: HierarchySha256Digest;
  readonly profileDigest: HierarchySha256Digest;
  readonly compilerContractDigest: HierarchySha256Digest;
  readonly sanitizerPolicyDigest: HierarchySha256Digest;
  readonly sourceManifestDigest: HierarchySha256Digest;
  readonly policyDigest: HierarchySha256Digest;
  readonly corpusSourceSetDigest: HierarchySha256Digest;
  readonly pages: readonly PageOwnershipEntryV1[];
  readonly graphDigest: HierarchySha256Digest;
}

export interface AuthoritativePageIdentityV1 {
  readonly pageId: string;
  readonly proposalDigest: HierarchySha256Digest;
  readonly ownershipDigest: HierarchySha256Digest;
  readonly status: 'active';
}

export interface AuthoritativeWikiStateV1 {
  readonly schemaVersion: typeof AUTHORITATIVE_WIKI_STATE_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly ledgerDigest: HierarchySha256Digest;
  readonly ownershipGraphDigest: HierarchySha256Digest;
  readonly receiptSetDigest: HierarchySha256Digest;
  readonly reviewSurfaceDigest: HierarchySha256Digest;
  readonly integratedReviewSetDigest: HierarchySha256Digest;
  readonly childSynthesisReviewSetDigest: HierarchySha256Digest;
  readonly humanActivationApprovalDigest: HierarchySha256Digest;
  readonly previousGenerationDigest: HierarchySha256Digest | null;
  readonly activePages: readonly AuthoritativePageIdentityV1[];
  readonly status: 'active';
  readonly generationDigest: HierarchySha256Digest;
}

/**
 * A digest-bound human confirmation record. It records a review decision but is
 * not a signature, credential, or cryptographic identity assertion.
 */
export interface HumanActivationApprovalV1 {
  readonly schemaVersion: typeof HUMAN_ACTIVATION_APPROVAL_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotDigest: HierarchySha256Digest;
  readonly ledgerDigest: HierarchySha256Digest;
  readonly ownershipGraphDigest: HierarchySha256Digest;
  readonly receiptSetDigest: HierarchySha256Digest;
  readonly reviewSurfaceDigest: HierarchySha256Digest;
  readonly integratedReviewSetDigest: HierarchySha256Digest;
  readonly childSynthesisReviewSetDigest: HierarchySha256Digest;
  readonly previousGenerationDigest: HierarchySha256Digest | null;
  readonly previousActivePageIds: readonly string[];
  readonly decision: 'approved';
  readonly explicitConfirmation: true;
  readonly approvalDigest: HierarchySha256Digest;
}

export interface AuthoritativeWikiCheckV1 {
  readonly schemaVersion: typeof AUTHORITATIVE_WIKI_CHECK_SCHEMA_VERSION;
  readonly projectId: string;
  readonly generationDigest: HierarchySha256Digest;
  readonly humanActivationApprovalDigest: HierarchySha256Digest;
  readonly receiptSetDigest: HierarchySha256Digest;
  readonly reviewSurfaceDigest: HierarchySha256Digest;
  readonly integratedReviewSetDigest: HierarchySha256Digest;
  readonly childSynthesisReviewSetDigest: HierarchySha256Digest;
  readonly liveSnapshotDigest: HierarchySha256Digest;
  readonly status: 'clean' | 'stale';
  readonly changedSourceIds: readonly string[];
  readonly configurationDriftReasonCodes: readonly string[];
  readonly directlyStalePageIds: readonly string[];
  readonly stalePageIds: readonly string[];
  readonly retrievalStalePageIds: readonly string[];
  readonly unaffectedPageIds: readonly string[];
  readonly checkDigest: HierarchySha256Digest;
}

export interface LegacyWikiMigrationEntryV1 {
  readonly legacyPageId: string;
  readonly legacyPageDigest: HierarchySha256Digest;
  readonly status: 'quarantined-needs-regeneration';
  readonly replacementPageId: string | null;
  readonly replacementReviewRequired: true;
  readonly automaticDeletionAllowed: false;
  readonly automaticOverwriteAllowed: false;
  readonly automaticActivationAllowed: false;
}

export interface LegacyWikiMigrationV1 {
  readonly schemaVersion: typeof LEGACY_WIKI_MIGRATION_SCHEMA_VERSION;
  readonly projectId: string;
  readonly entries: readonly LegacyWikiMigrationEntryV1[];
  readonly legacyEmbeddingMarkerAction: 'absent' | 'retain-quarantined';
  readonly rollbackGenerationDigest: HierarchySha256Digest | null;
  readonly explicitActivationRequired: true;
  readonly migrationDigest: HierarchySha256Digest;
}

export interface LegacyWikiMigrationReviewEntryV1 {
  readonly legacyPageId: string;
  readonly legacyPageDigest: HierarchySha256Digest;
  readonly replacementPageId: string | null;
  readonly decision: 'accepted' | 'deferred';
}

export interface LegacyWikiMigrationReviewV1 {
  readonly schemaVersion: typeof LEGACY_WIKI_MIGRATION_REVIEW_SCHEMA_VERSION;
  readonly projectId: string;
  readonly migrationDigest: HierarchySha256Digest;
  readonly replacementLedgerDigest: HierarchySha256Digest;
  readonly entries: readonly LegacyWikiMigrationReviewEntryV1[];
  readonly decision: 'approved';
  readonly reviewDigest: HierarchySha256Digest;
}
import type { PreparedSource } from '../../sanitizer/types.js';
