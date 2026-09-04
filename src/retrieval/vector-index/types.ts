import type {
  ApprovedWikiMeaningSignalV1,
  ApprovedWikiRetrievalCorpusV1,
} from '../hierarchical.js';
import type {
  EmbeddingIdentityV2,
  EmbeddingProviderPort,
} from '../embedding/types.js';

export const RETRIEVAL_CHUNK_SCHEMA_VERSION = 'buildlore.retrieval-chunk.v2' as const;
export const SEMANTIC_INDEX_MANIFEST_SCHEMA_VERSION =
  'buildlore.semantic-index-manifest.v2' as const;
export const SEMANTIC_INDEX_CHECKSUMS_SCHEMA_VERSION =
  'buildlore.semantic-index-checksums.v1' as const;
export const SEMANTIC_INDEX_ACTIVE_SCHEMA_VERSION =
  'buildlore.semantic-index-active.v1' as const;
export const SEMANTIC_INDEX_BUILD_LEDGER_SCHEMA_VERSION =
  'buildlore.semantic-index-build-ledger.v1' as const;
export const SEMANTIC_INDEX_BUNDLE_SCHEMA_VERSION =
  'buildlore.semantic-index-bundle.v1' as const;

export const SEMANTIC_INDEX_LIMITS = Object.freeze({
  dimensions: 384 as const,
  maximumBatchSize: 32 as const,
  /** Resource bound for one tokenizer-planning unit; token safety is verified separately. */
  maximumChunkUtf8Bytes: 8192 as const,
  maximumChunks: 50_000,
  maximumGenerationBytes: 268_435_456,
  maximumMetadataBytes: 134_217_728,
  maximumQueryResults: 20,
  maximumVectorBytes: 76_800_000,
});

export type SemanticIndexSha256Digest = `sha256:${string}`;
export type RetrievalStructureKind = 'fenced-code' | 'heading' | 'list' | 'paragraph' | 'table';
export type RetrievalChunkSkipReason = 'empty-structure' | 'structure-too-large';

export interface SemanticChunkerIdentityV1 {
  readonly contractVersion: 2;
  readonly identityDigest: SemanticIndexSha256Digest;
  readonly kind: 'markdown-semantic-text-token-aware';
  readonly maximumPlanningUtf8Bytes: 8192;
  readonly maximumTokens: 512;
  readonly preserves: readonly ['heading', 'paragraph', 'list', 'table', 'fenced-code'];
  readonly semanticContentPolicyDigest: SemanticIndexSha256Digest;
  readonly unicodeBoundary: 'unicode-cluster-safe-v1';
}

export interface RetrievalChunkCitationLocatorV1 {
  readonly citationId: string;
  readonly jsonPointer?: string;
  readonly sourceId: string;
}

export interface RetrievalChunkV1 {
  readonly schemaVersion: typeof RETRIEVAL_CHUNK_SCHEMA_VERSION;
  readonly projectId: string;
  readonly pageId: string;
  readonly pageRevision: SemanticIndexSha256Digest;
  readonly sectionId: string;
  readonly chunkId: string;
  readonly rowOrdinal: number;
  readonly segmentOrdinal: number;
  readonly structureOrdinal: number;
  readonly structureKind: RetrievalStructureKind;
  readonly contentDigest: SemanticIndexSha256Digest;
  readonly utf8Bytes: number;
  readonly maximumTokens: 512;
  readonly tokenCount: number;
  readonly tokenTruncated: false;
  readonly chunkerDigest: SemanticIndexSha256Digest;
  readonly citationLocators: readonly RetrievalChunkCitationLocatorV1[];
  readonly meaningSignals: readonly ApprovedWikiMeaningSignalV1[];
  readonly eligibility: 'eligible';
  readonly skipReason: null;
}

export interface SkippedRetrievalChunkV1 {
  readonly projectId: string;
  readonly pageId: string;
  readonly pageRevision: SemanticIndexSha256Digest;
  readonly sectionId: string;
  readonly structureKind: RetrievalStructureKind;
  readonly contentDigest: SemanticIndexSha256Digest;
  readonly utf8Bytes: number;
  readonly eligibility: 'ineligible';
  readonly skipReason: RetrievalChunkSkipReason;
}

export interface RetrievalChunkMaterialV1 {
  readonly chunk: RetrievalChunkV1;
  readonly text: string;
}

export interface RetrievalChunkingResultV1 {
  readonly chunker: SemanticChunkerIdentityV1;
  readonly chunks: readonly RetrievalChunkMaterialV1[];
  readonly skipped: readonly SkippedRetrievalChunkV1[];
}

export interface SemanticIndexComponentChecksumV1 {
  readonly basename: 'chunks.jsonl' | 'vectors.f32';
  readonly bytes: number;
  readonly sha256: SemanticIndexSha256Digest;
}

export interface SemanticIndexChecksumsV1 {
  readonly schemaVersion: typeof SEMANTIC_INDEX_CHECKSUMS_SCHEMA_VERSION;
  readonly components: readonly SemanticIndexComponentChecksumV1[];
  readonly checksumsDigest: SemanticIndexSha256Digest;
}

export interface SemanticIndexManifestV1 {
  readonly schemaVersion: typeof SEMANTIC_INDEX_MANIFEST_SCHEMA_VERSION;
  readonly projectId: string;
  readonly generationId: string;
  readonly corpusDigest: SemanticIndexSha256Digest;
  readonly wikiGenerationDigest: SemanticIndexSha256Digest;
  readonly sanitizerPolicyDigest: SemanticIndexSha256Digest;
  readonly chunker: SemanticChunkerIdentityV1;
  readonly embeddingIdentity: EmbeddingIdentityV2;
  readonly metric: 'cosine';
  readonly dimensions: 384;
  readonly scalarEncoding: 'float32-little-endian';
  readonly byteOrder: 'little-endian';
  readonly rowCount: number;
  readonly vectorBytes: number;
  readonly metadataBytes: number;
  readonly componentChecksums: readonly SemanticIndexComponentChecksumV1[];
  readonly checksumsDigest: SemanticIndexSha256Digest;
  readonly manifestDigest: SemanticIndexSha256Digest;
}

export interface SemanticIndexActiveV1 {
  readonly schemaVersion: typeof SEMANTIC_INDEX_ACTIVE_SCHEMA_VERSION;
  readonly projectId: string;
  readonly generationId: string;
  readonly manifestDigest: SemanticIndexSha256Digest;
}

export type SemanticIndexBuildMode = 'full' | 'incremental';

export interface SemanticIndexBuildLedgerV1 {
  readonly schemaVersion: typeof SEMANTIC_INDEX_BUILD_LEDGER_SCHEMA_VERSION;
  readonly projectId: string;
  readonly buildId: string;
  readonly requestedMode: SemanticIndexBuildMode;
  readonly effectiveMode: SemanticIndexBuildMode;
  readonly inputCorpusDigest: SemanticIndexSha256Digest;
  readonly previousGenerationId: string | null;
  readonly generationId: string;
  readonly embeddingIdentityDigest: SemanticIndexSha256Digest;
  readonly reusedRows: number;
  readonly createdRows: number;
  readonly deletedRows: number;
  readonly skippedRows: number;
  readonly providerUsed: 'local-in-process';
  readonly egress: 'none';
  readonly durationMilliseconds: number;
  readonly recoveryState: 'complete';
  readonly resultManifestDigest: SemanticIndexSha256Digest;
  readonly ledgerDigest: SemanticIndexSha256Digest;
}

export interface SemanticIndexViewV1 {
  readonly manifest: SemanticIndexManifestV1;
}

export type SemanticIndexStatusV1 =
  | Readonly<{ readonly projectId: string; readonly state: 'none' }>
  | Readonly<{
      readonly manifest: SemanticIndexManifestV1;
      readonly projectId: string;
      readonly state: 'ready';
    }>
  | Readonly<{
      readonly projectId: string;
      readonly reasonCode: SemanticIndexReasonCode;
      readonly recoveryAction: readonly ['index', 'rebuild', '--full', '--project', string];
      readonly state: 'incompatible';
    }>;

export interface SemanticIndexBuildInputV1 {
  readonly activationGuard?: SemanticIndexActivationGuardV1;
  readonly projectId: string;
  readonly corpus: ApprovedWikiRetrievalCorpusV1;
  readonly sanitizerPolicyDigest: SemanticIndexSha256Digest;
  readonly embeddingIdentity: EmbeddingIdentityV2;
  readonly provider: EmbeddingProviderPort;
}

export interface SemanticIndexActivationCandidateV1 {
  readonly chunkerIdentityDigest: SemanticIndexSha256Digest;
  readonly corpusDigest: SemanticIndexSha256Digest;
  readonly embeddingIdentityDigest: SemanticIndexSha256Digest;
  readonly generationId: string;
  readonly manifestDigest: SemanticIndexSha256Digest;
  readonly projectId: string;
  readonly sanitizerPolicyDigest: SemanticIndexSha256Digest;
  readonly wikiGenerationDigest: SemanticIndexSha256Digest;
}

/** Wraps the exact active-selector mutation while caller-owned lineage locks remain held. */
export type SemanticIndexActivationGuardV1 = <T>(
  candidate: SemanticIndexActivationCandidateV1,
  activate: () => Promise<T>,
) => Promise<T>;

export interface SemanticIndexBuildResultV1 {
  readonly ledger: SemanticIndexBuildLedgerV1;
  readonly manifest: SemanticIndexManifestV1;
  readonly outcome: 'activated' | 'unchanged';
}

export interface SemanticIndexSearchHitV1 {
  readonly chunkId: string;
  readonly rowOrdinal: number;
  readonly pageId: string;
  readonly sectionId: string;
  readonly citationLocators: readonly RetrievalChunkCitationLocatorV1[];
  readonly score: number;
}

export interface SemanticIndexSearchResultV1 {
  readonly projectId: string;
  readonly manifestDigest: SemanticIndexSha256Digest;
  readonly hits: readonly SemanticIndexSearchHitV1[];
}

export interface SemanticIndexExportInputV1 {
  readonly projectId: string;
  readonly destinationDirectory: string;
}

export interface SemanticIndexImportInputV1 {
  readonly activationGuard?: SemanticIndexActivationGuardV1;
  readonly projectId: string;
  readonly bundleDirectory: string;
  readonly corpusDigest: SemanticIndexSha256Digest;
  readonly sanitizerPolicyDigest: SemanticIndexSha256Digest;
  readonly embeddingIdentity: EmbeddingIdentityV2;
}

export interface SemanticIndexBundleResultV1 {
  readonly schemaVersion: typeof SEMANTIC_INDEX_BUNDLE_SCHEMA_VERSION;
  readonly projectId: string;
  readonly generationId: string;
  readonly manifestDigest: SemanticIndexSha256Digest;
  readonly fileCount: 4;
}

export interface VectorIndexPort {
  status(projectId: string): Promise<SemanticIndexStatusV1>;
  buildFull(input: SemanticIndexBuildInputV1): Promise<SemanticIndexBuildResultV1>;
  buildIncremental(input: SemanticIndexBuildInputV1): Promise<SemanticIndexBuildResultV1>;
  resume(input: SemanticIndexBuildInputV1): Promise<SemanticIndexBuildResultV1>;
  openActive(projectId: string): Promise<SemanticIndexViewV1>;
  searchExact(
    projectId: string,
    queryVector: Float32Array,
    topK?: number,
  ): Promise<SemanticIndexSearchResultV1>;
  searchExactDistinctSections(
    projectId: string,
    queryVector: Float32Array,
    topK?: number,
  ): Promise<SemanticIndexSearchResultV1>;
  exportBundle(input: SemanticIndexExportInputV1): Promise<SemanticIndexBundleResultV1>;
  importBundle(input: SemanticIndexImportInputV1): Promise<SemanticIndexBundleResultV1>;
}

export type SemanticIndexErrorCode =
  | 'SEMANTIC_INDEX_BUILD_INCOMPLETE'
  | 'SEMANTIC_INDEX_BUSY'
  | 'SEMANTIC_INDEX_BUNDLE_INVALID'
  | 'SEMANTIC_INDEX_CONFIG_INVALID'
  | 'SEMANTIC_INDEX_DOCUMENT_TRUNCATED'
  | 'SEMANTIC_INDEX_INCOMPATIBLE'
  | 'SEMANTIC_INDEX_LIMIT_EXCEEDED'
  | 'SEMANTIC_INDEX_PROJECT_MISMATCH'
  | 'SEMANTIC_INDEX_UNAVAILABLE'
  | 'SEMANTIC_INDEX_WRITE_FAILED';

export type SemanticIndexReasonCode =
  | 'active-missing'
  | 'artifact-invalid'
  | 'build-interrupted'
  | 'bundle-incompatible'
  | 'identity-mismatch'
  | 'lineage-drift'
  | 'limit-exceeded'
  | 'lock-busy'
  | 'project-mismatch'
  | 'truncated-document'
  | 'write-failed';

export class SemanticIndexError extends Error {
  readonly code: SemanticIndexErrorCode;
  readonly reasonCode: SemanticIndexReasonCode;
  readonly retryable: boolean;

  constructor(code: SemanticIndexErrorCode, reasonCode: SemanticIndexReasonCode) {
    super(code === 'SEMANTIC_INDEX_UNAVAILABLE'
      ? 'Semantic index is unavailable.'
      : code === 'SEMANTIC_INDEX_BUSY'
        ? 'Semantic index mutation is busy.'
        : code === 'SEMANTIC_INDEX_LIMIT_EXCEEDED'
          ? 'Semantic index input exceeds configured limits.'
          : code === 'SEMANTIC_INDEX_BUILD_INCOMPLETE'
            ? 'Semantic index build is incomplete.'
            : code === 'SEMANTIC_INDEX_WRITE_FAILED'
              ? 'Semantic index could not be updated safely.'
              : 'Semantic index contract is invalid.');
    this.name = 'SemanticIndexError';
    this.code = code;
    this.reasonCode = reasonCode;
    this.retryable = code === 'SEMANTIC_INDEX_BUSY' ||
      code === 'SEMANTIC_INDEX_BUILD_INCOMPLETE' ||
      code === 'SEMANTIC_INDEX_WRITE_FAILED';
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      reasonCode: this.reasonCode,
      retryable: this.retryable,
    });
  }
}

/** @internal Deterministic fault injection for atomic generation tests. */
export interface SemanticIndexTestHooks {
  readonly afterBatch?: (completedRows: number) => Promise<void> | void;
  readonly afterStageDirectoryCreate?: () => Promise<void> | void;
  readonly afterPendingWrite?: () => Promise<void> | void;
  readonly beforeActivation?: () => Promise<void> | void;
  readonly beforeGenerationRename?: () => Promise<void> | void;
  readonly beforeLedgerPersist?: () => Promise<void> | void;
}
