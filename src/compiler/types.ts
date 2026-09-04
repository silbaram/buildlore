import type { CompilerChangeStatus } from '../knowledge/types.js';
import type {
  SessionCompileApproveResultV1,
  SessionCompileCandidatesResultV1,
} from './session/types.js';

export type CompilerCapabilityName =
  | 'approve'
  | 'candidates'
  | 'compile'
  | 'context'
  | 'eval-fast'
  | 'eval-full'
  | 'lint'
  | 'query'
  | 'search'
  | 'status';

export type ProviderRequirement = 'conditional' | 'none' | 'required';
export type WorkspaceEffect = 'cache-write' | 'content-write' | 'log-write' | 'none';
export type DataEgressClass =
  | 'citation-evidence-to-judge'
  | 'none'
  | 'prompt-to-embedding-provider'
  | 'question-and-wiki-to-provider'
  | 'source-to-generation-provider';

export interface CompilerCapabilityDescriptor {
  readonly activeCancellation: false;
  readonly capability: CompilerCapabilityName;
  readonly egress: DataEgressClass;
  readonly fallback: 'none';
  readonly overallTimeout: false;
  readonly progress: 'none';
  readonly provider: ProviderRequirement;
  readonly transport: 'sdk';
  readonly upstreamMethod: string;
  readonly workspaceEffect: WorkspaceEffect;
}

export interface CompileRequest {
  readonly capability: 'compile';
  readonly projectId: string;
  readonly review?: boolean;
}

export interface CandidatesRequest {
  readonly capability: 'candidates';
  readonly projectId: string;
}

export interface ApproveRequest {
  readonly capability: 'approve';
  readonly candidateId: string;
  readonly projectId: string;
}

export interface StatusRequest {
  readonly capability: 'status';
  readonly projectId: string;
}

export interface LintRequest {
  readonly capability: 'lint';
  readonly projectId: string;
}

export interface EvalFastRequest {
  readonly capability: 'eval-fast';
  readonly projectId: string;
}

export interface EvalFullRequest {
  readonly capability: 'eval-full';
  readonly projectId: string;
}

export interface SearchRequest {
  readonly capability: 'search';
  readonly projectId: string;
  readonly question: string;
}

export interface QueryRequest {
  readonly capability: 'query';
  readonly projectId: string;
  readonly question: string;
}

export interface ContextRequest {
  readonly budget?: number;
  readonly capability: 'context';
  readonly depth?: number;
  readonly projectId: string;
  readonly prompt: string;
  readonly topChunks?: number;
  readonly topPages?: number;
}

export type CompilerRequest =
  | ApproveRequest
  | CandidatesRequest
  | CompileRequest
  | ContextRequest
  | EvalFastRequest
  | EvalFullRequest
  | LintRequest
  | QueryRequest
  | SearchRequest
  | StatusRequest;

export interface CompilerWarning {
  readonly code: string;
}

export interface CompileSummary {
  readonly candidateCount: number;
  readonly candidates: readonly CompileReviewCandidate[];
  readonly compiled: number;
  readonly deleted: number;
  readonly pageIds: readonly string[];
  readonly skipped: number;
}

export type CompileReviewDisposition = 'forced' | 'held';
export type CompileReviewReason =
  | 'all'
  | 'connector-fetched'
  | 'contradicted'
  | 'imported-okf'
  | 'low-confidence'
  | 'manual-review-requested'
  | 'provenance-violating'
  | 'schema-violating';

export interface CompileReviewCandidate {
  readonly disposition: CompileReviewDisposition;
  readonly id: string;
  readonly reasons: readonly CompileReviewReason[];
  readonly slug: string;
}

export interface StatusSummary extends CompilerChangeStatus {
  readonly lastCompiledAt: string | null;
  readonly orphanedCount: number;
  readonly orphanedPages: readonly string[];
  readonly pageCount: number;
  readonly pendingCandidates: number;
  readonly sourceCount: number;
  readonly staleCount: number;
  readonly stalePages: readonly string[];
}

export interface LintFinding {
  readonly file: string;
  readonly line?: number;
  readonly rule: string;
  readonly severity: 'error' | 'info' | 'warning';
}

export interface NormalizedLintSummary {
  readonly errors: number;
  readonly findings: readonly LintFinding[];
  readonly info: number;
  readonly warnings: number;
}

export interface EvalSummary {
  readonly citationCoveragePercent: number;
  readonly citationPrecisionPercent: number;
  readonly citationSupportMean?: number;
  readonly embeddingsAvailable: boolean;
  readonly healthScore: number;
  readonly pageCount: number;
  readonly pendingReviews: number;
  readonly sourceCount: number;
  readonly suite: 'fast' | 'full';
  readonly thresholdViolationCount: number;
}

export interface SearchPageSummary {
  readonly kind: 'chunk' | 'index' | 'page';
  readonly pageId: string;
  readonly slug: string;
  readonly summary: string;
  readonly title: string;
}

export interface SearchSummary {
  readonly pages: readonly SearchPageSummary[];
}

export interface QuerySummary {
  readonly answer: string;
  readonly pageIds: readonly string[];
}

export interface ContextPrimarySummary {
  readonly chunks: readonly string[];
  readonly id: string;
  readonly locators?: readonly Readonly<{
    readonly citationIds: readonly string[];
    readonly pageId: string;
    readonly projectId: string;
    readonly sectionId: string;
    readonly sourceIds: readonly string[];
  }>[];
  readonly reasons: readonly string[];
  readonly score: number;
  readonly summary: string;
  readonly title: string;
}

export interface ContextGapSummary {
  readonly code: string;
  readonly pageId: string;
}

export interface ContextSummary {
  readonly budget: {
    readonly estimatedTokens: number;
    readonly requestedTokens: number;
    readonly truncated: boolean;
  };
  readonly gaps: readonly ContextGapSummary[];
  readonly primary: readonly ContextPrimarySummary[];
  readonly version: 1;
}

export type CompilerResultData =
  | CompileSummary
  | ContextSummary
  | EvalSummary
  | NormalizedLintSummary
  | QuerySummary
  | SearchSummary
  | SessionCompileApproveResultV1
  | SessionCompileCandidatesResultV1
  | StatusSummary;

export interface CompilerOperationResult {
  readonly capability: CompilerCapabilityName;
  readonly data: CompilerResultData;
  readonly ok: true;
  readonly outcome: 'succeeded' | 'unchanged';
  readonly projectId: string;
  readonly warnings: readonly CompilerWarning[];
}

export interface CompilerExecutionControl {
  readonly signal?: AbortSignal;
}

export interface CompilerBackend {
  run(workspaceRoot: string, request: CompilerRequest): Promise<unknown>;
}

export interface CompilerCorpusBackend {
  exportProject(workspaceRoot: string, projectId: string): Promise<unknown>;
}

export interface CompilerWikiBackend {
  exportProjectOkf(workspaceRoot: string, outputRoot: string): Promise<unknown>;
  getProjectPage(
    workspaceRoot: string,
    page: Readonly<{ readonly pageDirectory: 'concepts' | 'queries'; readonly slug: string }>,
  ): Promise<unknown>;
  listProjectPages(
    workspaceRoot: string,
    options: Readonly<{
      readonly cursor?: string;
      readonly includeBody?: boolean;
      readonly limit?: number;
      readonly problemCursor?: string;
      readonly profileCursor?: string;
    }>,
  ): Promise<unknown>;
}

export type EgressCapability = 'compile' | 'context' | 'eval-full' | 'query' | 'search';

export interface ProjectCompilerPort {
  execute(
    request: CompilerRequest,
    control?: CompilerExecutionControl,
  ): Promise<CompilerOperationResult>;
  status(projectId: string): Promise<CompilerChangeStatus>;
}
