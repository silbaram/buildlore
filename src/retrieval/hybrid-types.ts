import type { EmbeddingSha256Digest } from './embedding/types.js';
import type {
  HierarchicalRetrievalLocatorV1,
} from './hierarchical.js';
import type {
  LexicalScoreComponents,
  MatchedRetrievalEvidence,
} from './strategy.js';
import type { SemanticIndexSha256Digest } from './vector-index/types.js';

export const RETRIEVAL_RESULT_V2_SCHEMA_VERSION = 'buildlore.retrieval-result.v2' as const;
export const RETRIEVAL_RESULT_V3_SCHEMA_VERSION = 'buildlore.retrieval-result.v3' as const;
export const RETRIEVAL_FUSION_POLICY_SCHEMA_VERSION =
  'buildlore.retrieval-fusion-policy.v1' as const;
export const RETRIEVAL_RANKING_POLICY_SCHEMA_VERSION =
  'buildlore.retrieval-ranking-policy.v2' as const;

export type LocalWikiRetrievalMode = 'graph' | 'hybrid' | 'lexical' | 'semantic';
export type LocalWikiRetrievalEffectiveMode =
  | 'hybrid'
  | 'lexical'
  | 'lexical-graph'
  | 'semantic';
export type LocalWikiRetrievalChannel = 'graph' | 'lexical' | 'semantic';
export type LocalWikiRetrievalIntent = 'auto' | 'current' | 'historical' | 'neutral';
export type LocalWikiRetrievalEffectiveIntent = Exclude<LocalWikiRetrievalIntent, 'auto'>;
export type LocalWikiRetrievalIntentReasonCode =
  | 'auto-current-default'
  | 'auto-historical-gate-marker'
  | 'auto-historical-history-marker'
  | 'auto-historical-iteration-marker'
  | 'explicit-current'
  | 'explicit-historical'
  | 'explicit-neutral';
export type LocalWikiRetrievalFallbackReason =
  | 'embedding-identity-mismatch'
  | 'embedding-provider-incompatible'
  | 'embedding-provider-unavailable'
  | 'semantic-index-incompatible'
  | 'semantic-index-stale'
  | 'semantic-index-unavailable';

export interface RetrievalFusionPolicyV1 {
  readonly schemaVersion: typeof RETRIEVAL_FUSION_POLICY_SCHEMA_VERSION;
  readonly algorithm: 'reciprocal-rank-fusion';
  readonly algorithmVersion: 1;
  readonly rankConstant: 60;
  readonly channelWeights: Readonly<Record<LocalWikiRetrievalChannel, 1>>;
  readonly tieBreak: readonly ['pageId', 'sectionId', 'chunkId'];
  readonly policyDigest: SemanticIndexSha256Digest;
}

export interface LocalWikiRetrievalRequestV2 {
  readonly mode?: LocalWikiRetrievalMode;
  readonly projectId: string;
  readonly query: string;
  readonly topK?: number;
}

export interface LocalWikiRetrievalRequestV3 extends LocalWikiRetrievalRequestV2 {
  readonly intent?: LocalWikiRetrievalIntent;
}

export interface LocalWikiRetrievalChannelScoreV2 {
  readonly channel: LocalWikiRetrievalChannel;
  readonly contribution: number;
  readonly rank: number;
  readonly score: number;
}

export interface LocalWikiRetrievalHitV2 {
  readonly channels: readonly LocalWikiRetrievalChannelScoreV2[];
  readonly chunkId: string;
  readonly locator: HierarchicalRetrievalLocatorV1;
  readonly matchedEvidence: readonly MatchedRetrievalEvidence[];
  readonly rank: number;
  readonly score: number;
  readonly scoreComponents: Readonly<{
    readonly combinedScore: number;
    readonly lexical?: LexicalScoreComponents;
  }>;
  readonly scoreKind: 'exact-cosine' | 'lexical-score' | 'rrf-v1';
  readonly title: string;
}

export interface LocalWikiRetrievalHitV3 extends LocalWikiRetrievalHitV2 {
  readonly baseScore: number;
  readonly diversificationReason: 'primary-distinct-groups' | 'secondary-fill';
  readonly finalScore: number;
  readonly meaningAdjustment: Readonly<{
    readonly authority: number;
    readonly evidenceKind: number;
    readonly lifecycle: number;
    readonly reasonCodes: readonly string[];
    readonly total: number;
  }>;
}

export interface RetrievalRankingPolicyV2 {
  readonly schemaVersion: typeof RETRIEVAL_RANKING_POLICY_SCHEMA_VERSION;
  readonly algorithmVersion: 2;
  readonly authorityAdjustmentLimit: 0.0015;
  readonly conflictHandling: 'axis-neutral-with-reason';
  readonly currentFloor: 'all-current-before-draft-or-superseded';
  readonly diversification: 'two-pass-page-topic-iteration';
  readonly evidenceAdjustmentLimit: 0.001;
  readonly lifecycleAdjustmentLimit: 0.003;
  readonly policyDigest: SemanticIndexSha256Digest;
  readonly semanticCandidateUnit: 'best-chunk-per-section';
  readonly tieBreak: readonly ['finalScore', 'pageId', 'sectionId', 'chunkId'];
}

export interface LocalWikiRetrievalFallbackV2 {
  readonly excludedChannel: 'semantic';
  readonly fromMode: 'hybrid';
  readonly reasonCode: LocalWikiRetrievalFallbackReason;
  readonly toMode: 'lexical-graph';
}

export interface LocalWikiRetrievalIdentityV2 {
  readonly embeddingIdentityDigest: EmbeddingSha256Digest | null;
  readonly indexGenerationId: string | null;
  readonly indexManifestDigest: SemanticIndexSha256Digest | null;
}

export interface RetrievalResultV2 {
  readonly schemaVersion: typeof RETRIEVAL_RESULT_V2_SCHEMA_VERSION;
  readonly projectId: string;
  readonly requestedMode: LocalWikiRetrievalMode;
  readonly effectiveMode: LocalWikiRetrievalEffectiveMode;
  readonly effectiveChannels: readonly LocalWikiRetrievalChannel[];
  readonly fallback: LocalWikiRetrievalFallbackV2 | null;
  readonly fusionPolicy: RetrievalFusionPolicyV1 | null;
  readonly hits: readonly LocalWikiRetrievalHitV2[];
  readonly identity: LocalWikiRetrievalIdentityV2;
  readonly providerUsed: 'local-in-process' | 'none';
  readonly egress: 'none';
}

export interface RetrievalResultV3 {
  readonly schemaVersion: typeof RETRIEVAL_RESULT_V3_SCHEMA_VERSION;
  readonly projectId: string;
  readonly requestedMode: LocalWikiRetrievalMode;
  readonly effectiveMode: LocalWikiRetrievalEffectiveMode;
  readonly effectiveIntent: LocalWikiRetrievalEffectiveIntent;
  readonly effectiveChannels: readonly LocalWikiRetrievalChannel[];
  readonly fallback: LocalWikiRetrievalFallbackV2 | null;
  readonly fusionPolicy: RetrievalFusionPolicyV1 | null;
  readonly intentReasonCodes: readonly LocalWikiRetrievalIntentReasonCode[];
  readonly hits: readonly LocalWikiRetrievalHitV3[];
  readonly identity: LocalWikiRetrievalIdentityV2;
  readonly providerUsed: 'local-in-process' | 'none';
  readonly rankingPolicy: RetrievalRankingPolicyV2;
  readonly requestedIntent: LocalWikiRetrievalIntent;
  readonly egress: 'none';
}

export interface LocalWikiRetrievalPortV2 {
  search(request: LocalWikiRetrievalRequestV2): Promise<RetrievalResultV2>;
}

export interface LocalWikiRetrievalPortV3 {
  search(request: LocalWikiRetrievalRequestV3): Promise<RetrievalResultV3>;
}

export type LocalWikiRetrievalErrorCode =
  | 'LOCAL_WIKI_PROJECTION_INVALID'
  | 'LOCAL_WIKI_PROJECTION_UNAVAILABLE'
  | 'LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID'
  | 'LOCAL_WIKI_RETRIEVAL_CONTRACT_INVALID'
  | 'LOCAL_WIKI_RETRIEVAL_PROJECT_MISMATCH'
  | 'LOCAL_WIKI_SEMANTIC_UNAVAILABLE';

export type LocalWikiRetrievalRecoveryAction =
  | readonly ['compile', 'activate', '--project', string]
  | readonly ['index', 'rebuild', '--project', string]
  | readonly ['index', 'rebuild', '--full', '--project', string]
  | readonly ['model', 'bind', '--profile', string]
  | readonly ['model', 'verify', '--profile', string];

export class LocalWikiRetrievalError extends Error {
  readonly code: LocalWikiRetrievalErrorCode;
  readonly reasonCode: LocalWikiRetrievalFallbackReason | null;
  readonly recoveryAction: LocalWikiRetrievalRecoveryAction | null;
  readonly retryable: boolean;

  constructor(
    code: LocalWikiRetrievalErrorCode,
    options: Readonly<{
      readonly reasonCode?: LocalWikiRetrievalFallbackReason;
      readonly recoveryAction?: LocalWikiRetrievalRecoveryAction;
    }> = {},
  ) {
    super(code === 'LOCAL_WIKI_PROJECTION_UNAVAILABLE'
      ? 'Approved hierarchical Wiki projection is unavailable.'
      : code === 'LOCAL_WIKI_PROJECTION_INVALID'
        ? 'Approved hierarchical Wiki projection is invalid or stale.'
        : code === 'LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID'
      ? 'Local Wiki retrieval input is invalid.'
      : code === 'LOCAL_WIKI_RETRIEVAL_PROJECT_MISMATCH'
        ? 'Local Wiki retrieval project does not match.'
        : code === 'LOCAL_WIKI_SEMANTIC_UNAVAILABLE'
          ? 'Local Wiki semantic retrieval is unavailable.'
          : 'Local Wiki retrieval contract is invalid.');
    this.name = 'LocalWikiRetrievalError';
    this.code = code;
    this.reasonCode = options.reasonCode ?? null;
    this.recoveryAction = options.recoveryAction ?? null;
    this.retryable = code === 'LOCAL_WIKI_SEMANTIC_UNAVAILABLE' ||
      code === 'LOCAL_WIKI_PROJECTION_UNAVAILABLE';
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      reasonCode: this.reasonCode,
      recoveryAction: this.recoveryAction,
      retryable: this.retryable,
    });
  }
}
