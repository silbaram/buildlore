import type { EmbeddingIdentity } from '../../compiler/embedding-identity.js';
import type { RetrievalMode } from '../types.js';
import type { RetrievalStrategyIdentity } from '../strategy.js';

export const RETRIEVAL_CORPUS_SCHEMA_VERSION = 'buildlore.retrieval-corpus.v1' as const;
export const RECORDED_SEMANTIC_SCHEMA_VERSION =
  'buildlore.recorded-semantic-fixture.v1' as const;
export const RECORDED_MORPHOLOGY_SCHEMA_VERSION =
  'buildlore.recorded-morphology-candidate.v1' as const;
export const RETRIEVAL_EVALUATION_SCHEMA_VERSION = 'buildlore.retrieval-eval.v1' as const;

export type RetrievalCategory =
  | 'code-symbol-korean'
  | 'korean-exact'
  | 'korean-spacing-morphology'
  | 'korean-synonym'
  | 'korean-to-english';

export interface FrozenRetrievalDocument {
  readonly body: string;
  readonly evidenceId: string;
  readonly language: string;
  readonly pageId: string;
  readonly sourceRefs: readonly string[];
  readonly summary: string;
  readonly title: string;
}

export interface RetrievalQueryFixture {
  readonly category: RetrievalCategory;
  readonly language: string;
  readonly queryId: string;
  readonly requestedMode: RetrievalMode;
  readonly text: string;
}

export interface RelevanceJudgement {
  readonly evidenceId: string;
  readonly queryId: string;
  readonly relevance: 1 | 2 | 3;
}

export interface FrozenRetrievalCorpusV1 {
  readonly corpusVersion: string;
  readonly documents: readonly FrozenRetrievalDocument[];
  readonly hashes: {
    readonly corpusSha256: `sha256:${string}`;
    readonly judgementSha256: `sha256:${string}`;
    readonly querySha256: `sha256:${string}`;
  };
  readonly judgements: readonly RelevanceJudgement[];
  readonly queries: readonly RetrievalQueryFixture[];
  readonly schemaVersion: typeof RETRIEVAL_CORPUS_SCHEMA_VERSION;
}

export interface RecordedQueryRanking {
  readonly pageIds: readonly string[];
  readonly queryId: string;
}

export interface RecordedSemanticFixtureV1 {
  readonly embeddingIdentity: EmbeddingIdentity;
  readonly fixtureId: string;
  readonly rankings: readonly RecordedQueryRanking[];
  readonly schemaVersion: typeof RECORDED_SEMANTIC_SCHEMA_VERSION;
}

export interface RecordedMorphologyCandidateV1 {
  readonly candidateId: 'garu-ko';
  readonly fixtureId: string;
  readonly modelVersion: string;
  readonly packageVersion: string;
  readonly rankings: readonly RecordedQueryRanking[];
  readonly schemaVersion: typeof RECORDED_MORPHOLOGY_SCHEMA_VERSION;
}

export interface RetrievalMetricResult {
  readonly category: RetrievalCategory;
  readonly metricVersion: 1;
  readonly mode: 'hybrid' | 'lexical' | 'semantic';
  readonly mrr: number;
  readonly passed: boolean;
  readonly queryCount: number;
  readonly recallAt5: number;
  readonly thresholds: {
    readonly minimumMrr: number | null;
    readonly minimumRecallAt5: number | null;
  };
}

export interface RetrievalCandidateReport {
  readonly candidateId: string;
  readonly dependencyImpact: 'deferred-wasm-model' | 'none';
  readonly decision: 'recorded-only' | 'rejected' | 'selected';
  readonly deterministicOffline: boolean;
  readonly identity: string;
  readonly indexBytes: number | null;
  readonly indexBytesUnavailableReason: string | null;
  readonly licenseId: 'BuildLore-internal' | 'MIT';
  readonly metrics: readonly RetrievalMetricResult[];
  readonly reasonCodes: readonly string[];
  readonly sourceEvidenceIds: readonly string[];
}

export interface RetrievalPerformanceBaseline {
  readonly architecture: string;
  readonly comparable: boolean;
  readonly cpuModelClass: `sha256:${string}`;
  readonly indexBytes: number;
  readonly latencyMilliseconds: {
    readonly maximum: number;
    readonly median: number;
    readonly minimum: number;
  } | null;
  readonly logicalCpuCount: number;
  readonly nodeVersion: string;
  readonly operatingSystem: string;
  readonly reasonCodes: readonly string[];
  readonly sampleCount: number;
  readonly timerKind: 'injected' | 'performance-now';
  readonly warmupCount: number;
}

export interface RetrievalEvaluationReport {
  readonly candidateComparisonPassed: boolean;
  readonly candidates: readonly RetrievalCandidateReport[];
  readonly embeddingFixtureIdentity: EmbeddingIdentity;
  readonly inputHashes: FrozenRetrievalCorpusV1['hashes'];
  readonly metrics: readonly RetrievalMetricResult[];
  readonly morphologyFixtureIdentity: {
    readonly fixtureId: string;
    readonly modelVersion: string;
    readonly packageVersion: string;
  };
  readonly overallPassed: boolean;
  readonly performance: RetrievalPerformanceBaseline;
  readonly regression: {
    readonly compatible: boolean;
    readonly passed: boolean;
    readonly reasonCodes: readonly string[];
  };
  readonly schemaVersion: typeof RETRIEVAL_EVALUATION_SCHEMA_VERSION;
  readonly semanticFixtureId: string;
  readonly selectedStrategy: RetrievalStrategyIdentity;
}

export interface RetrievalEvaluationInput {
  readonly baseline?: RetrievalEvaluationReport;
  readonly corpus: FrozenRetrievalCorpusV1;
  readonly morphology: RecordedMorphologyCandidateV1;
  readonly semantic: RecordedSemanticFixtureV1;
}

export interface RetrievalEvaluationPort {
  evaluate(input: RetrievalEvaluationInput): RetrievalEvaluationReport;
}
