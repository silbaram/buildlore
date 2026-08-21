import type { ContextSummary } from '../compiler/index.js';
import type { EmbeddingIdentity } from '../compiler/embedding-identity.js';
import type {
  LexicalScoreComponents,
  MatchedRetrievalEvidence,
  RetrievalStrategyIdentity,
} from './strategy.js';

export type RetrievalMode = 'hybrid' | 'lexical' | 'semantic';
export type RetrievalScoreKind =
  | 'hybrid-reciprocal-rank'
  | 'lexical-weighted-coverage'
  | 'semantic-rank';
export type RetrievalFallbackReason =
  | 'embedding-index-outdated'
  | 'embedding-store-unavailable'
  | 'provider-unconfigured';
export type RetrievalWarningCode =
  | RetrievalFallbackReason
  | 'embedding-entry-stale'
  | 'embedding-store-missing'
  | 'incomplete-compile'
  | 'journal-unavailable'
  | 'query-warning';

export interface RetrievalWarning {
  readonly code: RetrievalWarningCode;
}

export interface RetrievalFallback {
  readonly fromMode: 'hybrid' | 'semantic';
  readonly reasonCode: RetrievalFallbackReason;
  readonly toMode: 'lexical';
}

export type EmbeddingCompatibilityState =
  | 'compatible'
  | 'missing'
  | 'not-applicable'
  | 'outdated'
  | 'unavailable';

export interface EmbeddingCompatibility {
  readonly currentIdentity: EmbeddingIdentity | null;
  readonly reasonCode: string | null;
  readonly rebuildRequired: boolean;
  readonly state: EmbeddingCompatibilityState;
}

export interface RetrievalRecoveryAction {
  readonly command: readonly ['compile', '--project', string];
  readonly rebuildRequired: boolean;
}

export interface SearchSemanticScoreComponent {
  readonly rank: number;
  readonly reciprocalRank: number;
}

export interface SearchFusionScoreComponent {
  readonly lexicalContribution: number;
  readonly semanticContribution: number;
}

export interface SearchScoreComponents {
  readonly combinedScore: number;
  readonly fusion?: SearchFusionScoreComponent;
  readonly lexical?: LexicalScoreComponents;
  readonly semantic?: SearchSemanticScoreComponent;
}

export interface SearchHit {
  readonly freshness: 'fresh';
  readonly lexicalRank?: number;
  readonly matchedEvidence: readonly MatchedRetrievalEvidence[];
  readonly pageId: string;
  readonly rank: number;
  readonly score: number;
  readonly scoreComponents: SearchScoreComponents;
  readonly scoreKind: RetrievalScoreKind;
  readonly semanticRank?: number;
  readonly sourceRefs: readonly string[];
  readonly summary: string;
  readonly title: string;
}

export interface ProjectSearchRequest {
  readonly mode?: RetrievalMode;
  readonly projectId: string;
  readonly query: string;
}

export interface ProjectSearchResult {
  readonly embeddingCompatibility: EmbeddingCompatibility;
  readonly effectiveMode: RetrievalMode;
  readonly excluded: Readonly<Record<'archived' | 'orphaned' | 'stale' | 'unverified', number>>;
  readonly fallback: RetrievalFallback | null;
  readonly hits: readonly SearchHit[];
  readonly partial: boolean;
  readonly projectId: string;
  readonly recoveryAction: RetrievalRecoveryAction | null;
  readonly requestedMode: RetrievalMode;
  readonly retrievalStrategy: RetrievalStrategyIdentity;
  readonly warnings: readonly RetrievalWarning[];
}

export interface ProjectContextRequest {
  readonly budget?: number;
  readonly depth?: number;
  readonly projectId: string;
  readonly prompt: string;
  readonly topChunks?: number;
  readonly topPages?: number;
}

export interface ProjectContextResult {
  readonly data: ContextSummary;
  readonly fallback: RetrievalFallback | null;
  readonly partial: boolean;
  readonly projectId: string;
  readonly warnings: readonly RetrievalWarning[];
}

export interface ProjectRetrievalPort {
  context(request: ProjectContextRequest): Promise<ProjectContextResult>;
  search(request: ProjectSearchRequest): Promise<ProjectSearchResult>;
}

export interface CreateProjectRetrievalOptions {
  readonly knowledgeRoot: string;
}

export type RetrievalOperationErrorCode =
  | 'RETRIEVAL_CONFIG_INVALID'
  | 'RETRIEVAL_CONTRACT_VIOLATION'
  | 'RETRIEVAL_SEMANTIC_DRIFT';

export class RetrievalOperationError extends Error {
  readonly code: RetrievalOperationErrorCode;
  readonly projectId: string;
  readonly recoveryAction: 'check' | 'check-config';
  readonly retryable: false;

  constructor(code: RetrievalOperationErrorCode, projectId: string) {
    super(code === 'RETRIEVAL_CONFIG_INVALID'
      ? 'Retrieval input is invalid.'
      : code === 'RETRIEVAL_SEMANTIC_DRIFT'
        ? 'Project changed during semantic retrieval.'
        : 'Retrieval returned an unsafe result.');
    this.name = 'RetrievalOperationError';
    this.code = code;
    this.projectId = projectId;
    this.recoveryAction = code === 'RETRIEVAL_CONFIG_INVALID' ? 'check-config' : 'check';
    this.retryable = false;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      code: this.code,
      message: this.message,
      projectId: this.projectId,
      recoveryAction: this.recoveryAction,
      retryable: this.retryable,
    };
  }
}
