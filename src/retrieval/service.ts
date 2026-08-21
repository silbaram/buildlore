import type {
  CompilerOperationResult,
  CompilerWarning,
  ContextSummary,
  EvalSummary,
  SearchSummary,
} from '../compiler/index.js';
import { createProjectCompiler, type ProjectCompilerPort } from '../compiler/index.js';
import {
  createProjectCorpus,
  type ProjectCorpusPort,
  type SearchCorpus,
  type SearchCorpusPage,
} from '../compiler/corpus.js';
import { queryTokens, rankLexical, roundSix, type LexicalRankedPage } from './lexical.js';
import {
  RetrievalOperationError,
  type CreateProjectRetrievalOptions,
  type ProjectContextRequest,
  type ProjectContextResult,
  type ProjectRetrievalPort,
  type ProjectSearchRequest,
  type ProjectSearchResult,
  type RetrievalFallback,
  type RetrievalFallbackReason,
  type RetrievalMode,
  type RetrievalWarning,
  type RetrievalWarningCode,
  type SearchHit,
} from './types.js';

export interface CreateProjectRetrievalWithPortsOptions {
  readonly compiler: ProjectCompilerPort;
  readonly corpus: ProjectCorpusPort;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly providerConfigured?: () => boolean;
}

const MAX_HITS = 20;
const PARTIAL_WARNING_CODES = new Set<RetrievalWarningCode>([
  'embedding-index-outdated',
  'embedding-entry-stale',
  'embedding-store-missing',
  'embedding-store-unavailable',
  'incomplete-compile',
  'journal-unavailable',
]);
const FALLBACK_WARNING_CODES = new Set<RetrievalFallbackReason>([
  'embedding-index-outdated',
  'embedding-store-unavailable',
  'provider-unconfigured',
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function validateSearchRequest(input: ProjectSearchRequest): {
  readonly mode: RetrievalMode;
  readonly projectId: string;
  readonly query: string;
} {
  let request: unknown;
  try {
    request = { ...input };
  } catch {
    throw new RetrievalOperationError('RETRIEVAL_CONFIG_INVALID', 'unknown');
  }
  if (!isRecord(request) || typeof request.projectId !== 'string' ||
      typeof request.query !== 'string' || Object.keys(request).some((key) =>
        key !== 'mode' && key !== 'projectId' && key !== 'query')) {
    throw new RetrievalOperationError('RETRIEVAL_CONFIG_INVALID', 'unknown');
  }
  const validProjectId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request.projectId) &&
    request.projectId.length <= 64;
  const projectId = validProjectId ? request.projectId : 'unknown';
  const mode = request.mode ?? 'hybrid';
  if (!validProjectId || (mode !== 'lexical' && mode !== 'semantic' && mode !== 'hybrid') ||
      request.query.trim() === '' || request.query.length > 8_192 ||
      containsControlCharacter(request.query)) {
    throw new RetrievalOperationError('RETRIEVAL_CONFIG_INVALID', projectId);
  }
  const query = request.query.normalize('NFC');
  if (queryTokens(query).length === 0) {
    throw new RetrievalOperationError('RETRIEVAL_CONFIG_INVALID', projectId);
  }
  return { mode, projectId, query };
}

function validateContextRequest(input: ProjectContextRequest): ProjectContextRequest {
  let request: unknown;
  try {
    request = { ...input };
  } catch {
    throw new RetrievalOperationError('RETRIEVAL_CONFIG_INVALID', 'unknown');
  }
  if (!isRecord(request) || typeof request.projectId !== 'string' ||
      typeof request.prompt !== 'string' || Object.keys(request).some((key) => ![
        'budget', 'depth', 'projectId', 'prompt', 'topChunks', 'topPages',
      ].includes(key))) {
    throw new RetrievalOperationError('RETRIEVAL_CONFIG_INVALID', 'unknown');
  }
  const validProjectId = request.projectId.length <= 64 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request.projectId);
  const ranges: ReadonlyArray<readonly [unknown, number, number]> = [
    [request.budget, 1, 100_000],
    [request.depth, 0, 2],
    [request.topChunks, 0, 50],
    [request.topPages, 1, 20],
  ];
  if (!validProjectId || request.prompt.trim() === '' || request.prompt.length > 8_192 ||
      containsControlCharacter(request.prompt) || ranges.some(([value, minimum, maximum]) =>
        value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) ||
          value < minimum || value > maximum))) {
    throw new RetrievalOperationError(
      'RETRIEVAL_CONFIG_INVALID',
      validProjectId ? request.projectId : 'unknown',
    );
  }
  return Object.freeze({ ...request, prompt: request.prompt.normalize('NFC') }) as unknown as
    ProjectContextRequest;
}

function evalData(result: CompilerOperationResult, projectId: string): EvalSummary {
  if (result.projectId !== projectId || result.capability !== 'eval-fast' || !isRecord(result.data) ||
      result.data.suite !== 'fast' || typeof result.data.embeddingsAvailable !== 'boolean') {
    throw new RetrievalOperationError('RETRIEVAL_CONTRACT_VIOLATION', projectId);
  }
  return result.data as EvalSummary;
}

function searchData(result: CompilerOperationResult, projectId: string): SearchSummary {
  if (result.projectId !== projectId || result.capability !== 'search' ||
      !isRecord(result.data) || !Array.isArray(result.data.pages)) {
    throw new RetrievalOperationError('RETRIEVAL_CONTRACT_VIOLATION', projectId);
  }
  return result.data as SearchSummary;
}

function contextData(result: CompilerOperationResult, projectId: string): ContextSummary {
  if (result.projectId !== projectId || result.capability !== 'context' ||
      !isRecord(result.data) || result.data.version !== 1) {
    throw new RetrievalOperationError('RETRIEVAL_CONTRACT_VIOLATION', projectId);
  }
  return result.data as ContextSummary;
}

function defaultProviderConfigured(environment: Readonly<NodeJS.ProcessEnv>): boolean {
  const provider = environment.LLMWIKI_PROVIDER ?? 'anthropic';
  switch (provider) {
    case 'anthropic':
      return Boolean(environment.ANTHROPIC_API_KEY || environment.ANTHROPIC_AUTH_TOKEN);
    case 'openai':
      return Boolean(environment.OPENAI_API_KEY);
    case 'minimax':
      return Boolean(environment.MINIMAX_API_KEY);
    case 'copilot':
      return Boolean(environment.GITHUB_TOKEN);
    case 'claude-agent':
    case 'ollama':
      return true;
    default:
      return true;
  }
}

function warningCode(code: string): RetrievalWarningCode {
  if (PARTIAL_WARNING_CODES.has(code as RetrievalWarningCode) ||
      FALLBACK_WARNING_CODES.has(code as RetrievalFallbackReason)) {
    return code as RetrievalWarningCode;
  }
  return 'query-warning';
}

function normalizeWarnings(...groups: ReadonlyArray<readonly CompilerWarning[]>): readonly RetrievalWarning[] {
  return [...new Set(groups.flatMap((group) => group.map((warning) => warningCode(warning.code))))]
    .sort()
    .map((code) => ({ code }));
}

function pageHit(
  page: SearchCorpusPage,
  rank: number,
  score: number,
  scoreKind: SearchHit['scoreKind'],
  ranks: { readonly lexicalRank?: number; readonly semanticRank?: number },
): SearchHit {
  return {
    freshness: 'fresh',
    ...(ranks.lexicalRank === undefined ? {} : { lexicalRank: ranks.lexicalRank }),
    pageId: page.pageId,
    rank,
    score,
    scoreKind,
    ...(ranks.semanticRank === undefined ? {} : { semanticRank: ranks.semanticRank }),
    sourceRefs: page.sourceRefs,
    summary: page.summary,
    title: page.title,
  };
}

function lexicalHits(ranked: readonly LexicalRankedPage[]): readonly SearchHit[] {
  return ranked.slice(0, MAX_HITS).map((item, index) =>
    pageHit(item.page, index + 1, item.score, 'lexical-coverage', {
      lexicalRank: item.lexicalRank,
    }),
  );
}

function semanticRanks(
  result: SearchSummary,
  pages: ReadonlyMap<string, SearchCorpusPage>,
  projectId: string,
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  result.pages.forEach((reference, index) => {
    if (!pages.has(reference.pageId) || ranks.has(reference.pageId)) {
      throw new RetrievalOperationError('RETRIEVAL_SEMANTIC_DRIFT', projectId);
    }
    ranks.set(reference.pageId, index + 1);
  });
  return ranks;
}

function semanticHits(
  ranks: ReadonlyMap<string, number>,
  pages: ReadonlyMap<string, SearchCorpusPage>,
): readonly SearchHit[] {
  return [...ranks].slice(0, MAX_HITS).map(([pageId, semanticRank], index) =>
    pageHit(pages.get(pageId) as SearchCorpusPage, index + 1, roundSix(1 / semanticRank),
      'semantic-rank', { semanticRank }),
  );
}

function hybridHits(
  lexical: readonly LexicalRankedPage[],
  semantic: ReadonlyMap<string, number>,
  pages: ReadonlyMap<string, SearchCorpusPage>,
): readonly SearchHit[] {
  const lexicalRanks = new Map(lexical.map((item) => [item.page.pageId, item.lexicalRank]));
  const ids = new Set([...lexicalRanks.keys(), ...semantic.keys()]);
  const ranked = [...ids].map((pageId) => {
    const lexicalRank = lexicalRanks.get(pageId);
    const semanticRank = semantic.get(pageId);
    const score = roundSix(
      0.5 * (lexicalRank === undefined ? 0 : 1 / lexicalRank) +
      0.5 * (semanticRank === undefined ? 0 : 1 / semanticRank),
    );
    return { lexicalRank, pageId, score, semanticRank };
  }).sort((left, right) => right.score - left.score || left.pageId.localeCompare(right.pageId));
  return ranked.slice(0, MAX_HITS).map((item, index) =>
    pageHit(pages.get(item.pageId) as SearchCorpusPage, index + 1, item.score,
      'hybrid-reciprocal-rank', {
        ...(item.lexicalRank === undefined ? {} : { lexicalRank: item.lexicalRank }),
        ...(item.semanticRank === undefined ? {} : { semanticRank: item.semanticRank }),
      }),
  );
}

function fallbackResult(
  corpus: SearchCorpus,
  lexical: readonly LexicalRankedPage[],
  requestedMode: 'hybrid' | 'semantic',
  reasonCode: RetrievalFallbackReason,
): ProjectSearchResult {
  const fallback: RetrievalFallback = { fromMode: requestedMode, reasonCode, toMode: 'lexical' };
  return {
    effectiveMode: 'lexical',
    excluded: corpus.excluded,
    fallback,
    hits: lexicalHits(lexical),
    partial: true,
    projectId: corpus.projectId,
    requestedMode,
    warnings: normalizeWarnings(corpus.warnings, [{ code: reasonCode }]),
  };
}

function fallbackWarning(warnings: readonly CompilerWarning[]): RetrievalFallbackReason | null {
  for (const warning of warnings) {
    if (warning.code === 'embedding-index-outdated' ||
        warning.code === 'embedding-store-unavailable') return warning.code;
  }
  return null;
}

function isPartial(warnings: readonly RetrievalWarning[]): boolean {
  return warnings.some((warning) => PARTIAL_WARNING_CODES.has(warning.code));
}

export function createProjectRetrievalWithPorts(
  options: CreateProjectRetrievalWithPortsOptions,
): ProjectRetrievalPort {
  const environment = options.environment ?? process.env;
  const providerConfigured = options.providerConfigured ?? (() =>
    defaultProviderConfigured(environment));

  return {
    async context(inputRequest): Promise<ProjectContextResult> {
      const request = validateContextRequest(inputRequest);
      let fallback: RetrievalFallback | null = null;
      let executeRequest = request;
      if (request.topChunks !== 0) {
        const evaluation = evalData(
          await options.compiler.execute({ capability: 'eval-fast', projectId: request.projectId }),
          request.projectId,
        );
        const configured = providerConfigured();
        if (!evaluation.embeddingsAvailable || !configured) {
          fallback = {
            fromMode: 'semantic',
            reasonCode: evaluation.embeddingsAvailable
              ? 'provider-unconfigured'
              : 'embedding-store-unavailable',
            toMode: 'lexical',
          };
          executeRequest = { ...request, topChunks: 0 };
        }
      }
      const result = await options.compiler.execute({
        capability: 'context',
        projectId: executeRequest.projectId,
        prompt: executeRequest.prompt,
        ...(executeRequest.budget === undefined ? {} : { budget: executeRequest.budget }),
        ...(executeRequest.depth === undefined ? {} : { depth: executeRequest.depth }),
        ...(executeRequest.topChunks === undefined ? {} : { topChunks: executeRequest.topChunks }),
        ...(executeRequest.topPages === undefined ? {} : { topPages: executeRequest.topPages }),
      });
      const warnings = normalizeWarnings(
        result.warnings,
        fallback === null ? [] : [{ code: fallback.reasonCode }],
      );
      return {
        data: contextData(result, request.projectId),
        fallback,
        partial: fallback !== null || isPartial(warnings),
        projectId: request.projectId,
        warnings,
      };
    },

    async search(inputRequest): Promise<ProjectSearchResult> {
      const request = validateSearchRequest(inputRequest);
      const corpus = await options.corpus.snapshot(request.projectId);
      const lexical = rankLexical(corpus.pages, queryTokens(request.query));
      if (request.mode === 'lexical') {
        const warnings = normalizeWarnings(corpus.warnings);
        return {
          effectiveMode: 'lexical',
          excluded: corpus.excluded,
          fallback: null,
          hits: lexicalHits(lexical),
          partial: isPartial(warnings),
          projectId: request.projectId,
          requestedMode: 'lexical',
          warnings,
        };
      }
      const evaluation = await options.compiler.execute({
        capability: 'eval-fast',
        projectId: request.projectId,
      });
      if (!evalData(evaluation, request.projectId).embeddingsAvailable) {
        return fallbackResult(corpus, lexical, request.mode, 'embedding-store-unavailable');
      }
      if (!providerConfigured()) {
        return fallbackResult(corpus, lexical, request.mode, 'provider-unconfigured');
      }
      const semantic = await options.compiler.execute({
        capability: 'search',
        projectId: request.projectId,
        question: request.query,
      });
      const fallback = fallbackWarning(semantic.warnings);
      if (fallback !== null) return fallbackResult(corpus, lexical, request.mode, fallback);
      const pages = new Map(corpus.pages.map((page) => [page.pageId, page]));
      const ranks = semanticRanks(searchData(semantic, request.projectId), pages, request.projectId);
      const warnings = normalizeWarnings(corpus.warnings, semantic.warnings);
      return {
        effectiveMode: request.mode,
        excluded: corpus.excluded,
        fallback: null,
        hits: request.mode === 'semantic'
          ? semanticHits(ranks, pages)
          : hybridHits(lexical, ranks, pages),
        partial: isPartial(warnings),
        projectId: request.projectId,
        requestedMode: request.mode,
        warnings,
      };
    },
  };
}

export function createProjectRetrieval(options: CreateProjectRetrievalOptions): ProjectRetrievalPort {
  const compiler = createProjectCompiler({
    knowledgeRoot: options.knowledgeRoot,
  });
  const corpus = createProjectCorpus({ knowledgeRoot: options.knowledgeRoot });
  return createProjectRetrievalWithPorts({
    compiler,
    corpus,
  });
}
