import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

import type {
  CompilerOperationResult,
  CompilerWarning,
  ContextSummary,
  EvalSummary,
  SearchSummary,
} from '../compiler/index.js';
import {
  createProjectCompiler,
  type ProjectCompilerPort,
} from '../compiler/index.js';
import {
  createProjectEmbeddingIdentityStore,
  resolveConfiguredEmbeddingIdentity,
  type EmbeddingIdentity,
  type ProjectEmbeddingCompatibilityPort,
} from '../compiler/embedding-identity.js';
import {
  createProjectCorpus,
  type ProjectCorpusPort,
  type SearchCorpus,
  type SearchCorpusPage,
} from '../compiler/corpus.js';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { queryTokens, rankLexical, roundSix, type LexicalRankedPage } from './lexical.js';
import { buildLexicalIndex, fuseReciprocalRanks, RETRIEVAL_STRATEGY } from './strategy.js';
import {
  createLocalWikiOperator,
  type LocalWikiOperatorPort,
} from './local-wiki-operator.js';
import { LocalWikiRetrievalError } from './hybrid-types.js';
import {
  RetrievalOperationError,
  type CreateProjectRetrievalOptions,
  type EmbeddingCompatibility,
  type ProjectContextRequest,
  type ProjectContextResult,
  type ProjectRetrievalPort,
  type ProjectSearchRequest,
  type ProjectSearchResult,
  type RetrievalFallback,
  type RetrievalFallbackReason,
  type RetrievalMode,
  type RetrievalRecoveryAction,
  type RetrievalWarning,
  type RetrievalWarningCode,
  type SearchHit,
} from './types.js';

export interface CreateProjectRetrievalWithPortsOptions {
  readonly approvedWiki?: Pick<LocalWikiOperatorPort, 'readPage' | 'search'>;
  readonly compiler: ProjectCompilerPort;
  readonly corpus: ProjectCorpusPort;
  readonly embeddingCompatibility?: ProjectEmbeddingCompatibilityPort;
  readonly embeddingIdentity?: () => EmbeddingIdentity | null;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly providerConfigured?: () => boolean;
}

const MAX_HITS = 20;
const PARTIAL_WARNING_CODES = new Set<RetrievalWarningCode>([
  'embedding-identity-mismatch',
  'embedding-index-outdated',
  'embedding-provider-incompatible',
  'embedding-provider-unavailable',
  'embedding-entry-stale',
  'embedding-store-missing',
  'embedding-store-unavailable',
  'incomplete-compile',
  'journal-unavailable',
  'semantic-index-incompatible',
  'semantic-index-stale',
  'semantic-index-unavailable',
]);
const FALLBACK_WARNING_CODES = new Set<RetrievalFallbackReason>([
  'embedding-identity-mismatch',
  'embedding-index-outdated',
  'embedding-provider-incompatible',
  'embedding-provider-unavailable',
  'embedding-store-unavailable',
  'provider-unconfigured',
  'semantic-index-incompatible',
  'semantic-index-stale',
  'semantic-index-unavailable',
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
  details: Pick<SearchHit, 'matchedEvidence' | 'scoreComponents'>,
): SearchHit {
  return {
    freshness: 'fresh',
    ...(ranks.lexicalRank === undefined ? {} : { lexicalRank: ranks.lexicalRank }),
    matchedEvidence: details.matchedEvidence,
    pageId: page.pageId,
    rank,
    score,
    scoreComponents: details.scoreComponents,
    scoreKind,
    ...(ranks.semanticRank === undefined ? {} : { semanticRank: ranks.semanticRank }),
    sourceRefs: page.sourceRefs,
    summary: page.summary,
    title: page.title,
  };
}

function lexicalHits(ranked: readonly LexicalRankedPage[]): readonly SearchHit[] {
  return ranked.slice(0, MAX_HITS).map((item, index) =>
    pageHit(item.page, index + 1, item.score, 'lexical-weighted-coverage', {
      lexicalRank: item.lexicalRank,
    }, {
      matchedEvidence: item.matchedEvidence,
      scoreComponents: {
        combinedScore: item.score,
        lexical: item.scoreComponents,
      },
    }),
  );
}

function semanticRanks(
  result: SearchSummary,
  pages: ReadonlyMap<string, SearchCorpusPage>,
  projectId: string,
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  result.pages.forEach((reference) => {
    if (!pages.has(reference.pageId)) {
      throw new RetrievalOperationError('RETRIEVAL_SEMANTIC_DRIFT', projectId);
    }
    if (!ranks.has(reference.pageId)) ranks.set(reference.pageId, ranks.size + 1);
  });
  return ranks;
}

function validatedCorpus(corpus: SearchCorpus, projectId: string): SearchCorpus {
  if (!isRecord(corpus) || corpus.projectId !== projectId || !Array.isArray(corpus.pages) ||
      !Array.isArray(corpus.warnings) || corpus.warnings.length > 20 ||
      corpus.warnings.some((warning) => !isRecord(warning) ||
        Object.keys(warning).length !== 1 || typeof warning.code !== 'string' ||
        warning.code.length < 1 || warning.code.length > 128) ||
      !isRecord(corpus.excluded) || Object.keys(corpus.excluded).sort().join(',') !==
        'archived,orphaned,stale,unverified' ||
      Object.values(corpus.excluded).some((count) => typeof count !== 'number' ||
        !Number.isSafeInteger(count) || count < 0)) {
    throw new RetrievalOperationError('RETRIEVAL_CONTRACT_VIOLATION', projectId);
  }
  try {
    buildLexicalIndex(corpus.pages);
  } catch {
    throw new RetrievalOperationError('RETRIEVAL_CONTRACT_VIOLATION', projectId);
  }
  return corpus;
}

function corpusSnapshotToken(corpus: SearchCorpus): `sha256:${string}` {
  const value = {
    excluded: corpus.excluded,
    pages: corpus.pages.map((page) => ({
      body: page.body,
      freshness: page.freshness,
      pageId: page.pageId,
      sourceRefs: [...page.sourceRefs],
      summary: page.summary,
      title: page.title,
    })),
    projectId: corpus.projectId,
    warnings: corpus.warnings.map((warning) => ({ code: warning.code })),
  };
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(value)).digest('hex')}`;
}

function semanticHits(
  ranks: ReadonlyMap<string, number>,
  pages: ReadonlyMap<string, SearchCorpusPage>,
): readonly SearchHit[] {
  return [...ranks].slice(0, MAX_HITS).map(([pageId, semanticRank], index) =>
    pageHit(pages.get(pageId) as SearchCorpusPage, index + 1, roundSix(1 / semanticRank),
      'semantic-rank', { semanticRank }, {
        matchedEvidence: [],
        scoreComponents: {
          combinedScore: roundSix(1 / semanticRank),
          semantic: { rank: semanticRank, reciprocalRank: roundSix(1 / semanticRank) },
        },
      }),
  );
}

function hybridHits(
  lexical: readonly LexicalRankedPage[],
  semantic: ReadonlyMap<string, number>,
  pages: ReadonlyMap<string, SearchCorpusPage>,
): readonly SearchHit[] {
  const lexicalDetails = new Map(lexical.map((item) => [item.page.pageId, item]));
  const ranked = fuseReciprocalRanks(
    lexical.map((item) => item.page.pageId),
    [...semantic.keys()],
  );
  return ranked.slice(0, MAX_HITS).map((item, index) =>
    pageHit(pages.get(item.pageId) as SearchCorpusPage, index + 1, item.combinedScore,
      'hybrid-reciprocal-rank', {
        ...(item.lexicalRank === undefined ? {} : { lexicalRank: item.lexicalRank }),
        ...(item.semanticRank === undefined ? {} : { semanticRank: item.semanticRank }),
      }, {
        matchedEvidence: lexicalDetails.get(item.pageId)?.matchedEvidence ?? [],
        scoreComponents: {
          combinedScore: item.combinedScore,
          fusion: {
            lexicalContribution: item.lexicalContribution,
            semanticContribution: item.semanticContribution,
          },
          ...(lexicalDetails.get(item.pageId) === undefined
            ? {}
            : { lexical: (lexicalDetails.get(item.pageId) as LexicalRankedPage).scoreComponents }),
          ...(item.semanticRank === undefined ? {} : {
            semantic: {
              rank: item.semanticRank,
              reciprocalRank: roundSix(1 / item.semanticRank),
            },
          }),
        },
      }),
  );
}

function recoveryAction(projectId: string, rebuildRequired: boolean): RetrievalRecoveryAction {
  return {
    command: ['compile', '--project', projectId],
    rebuildRequired,
  };
}

function unavailableCompatibility(
  reasonCode: RetrievalFallbackReason,
  currentIdentity: EmbeddingIdentity | null,
): EmbeddingCompatibility {
  return {
    currentIdentity,
    reasonCode,
    rebuildRequired: reasonCode !== 'provider-unconfigured',
    state: 'unavailable',
  };
}

function fallbackResult(
  corpus: SearchCorpus,
  lexical: readonly LexicalRankedPage[],
  requestedMode: 'hybrid' | 'semantic',
  reasonCode: RetrievalFallbackReason,
  compatibility: EmbeddingCompatibility,
): ProjectSearchResult {
  const fallback: RetrievalFallback = { fromMode: requestedMode, reasonCode, toMode: 'lexical' };
  return {
    embeddingCompatibility: compatibility,
    effectiveMode: 'lexical',
    excluded: corpus.excluded,
    fallback,
    hits: lexicalHits(lexical),
    partial: true,
    projectId: corpus.projectId,
    recoveryAction: recoveryAction(corpus.projectId, compatibility.rebuildRequired),
    requestedMode,
    retrievalStrategy: RETRIEVAL_STRATEGY,
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

function estimatedContextTokens(value: string): number {
  return Math.max(1, Math.ceil([...value].length / 4));
}

async function approvedWikiContext(
  wiki: Pick<LocalWikiOperatorPort, 'readPage' | 'search'>,
  request: ProjectContextRequest,
): Promise<ProjectContextResult> {
  const topPages = request.topPages ?? 5;
  const topChunks = request.topChunks ?? Math.min(10, topPages * 2);
  const requestedTokens = request.budget ?? 1_200;
  const searchTopK = Math.min(20, Math.max(topPages, topChunks === 0 ? topPages : topChunks));
  const result = await wiki.search({
    intent: 'auto',
    mode: topChunks === 0 ? 'graph' : 'hybrid',
    projectId: request.projectId,
    query: request.prompt,
    topK: searchTopK,
  });
  const pageIds = [...new Set(result.hits.map((hit) => hit.locator.pageId))];
  const pages = new Map((await Promise.all(pageIds.map(async (pageId) => {
    const page = await wiki.readPage({ pageId, projectId: request.projectId });
    return [pageId, page] as const;
  }))).map((entry) => entry));
  const primary = new Map<string, {
    chunks: string[];
    id: string;
    locators: Array<NonNullable<ContextSummary['primary'][number]['locators']>[number]>;
    reasons: Set<string>;
    score: number;
    summary: string;
    title: string;
  }>();
  let estimatedTokens = 0;
  let selectedChunks = 0;
  let truncated = false;
  for (const hit of result.hits) {
    let item = primary.get(hit.locator.pageId);
    if (item === undefined) {
      if (primary.size >= topPages) {
        truncated = true;
        continue;
      }
      const page = pages.get(hit.locator.pageId);
      if (page === undefined) {
        throw new RetrievalOperationError('RETRIEVAL_CONTRACT_VIOLATION', request.projectId);
      }
      item = {
        chunks: [],
        id: page.pageId,
        locators: [],
        reasons: new Set(['approved-semantic-content', ...result.intentReasonCodes]),
        score: hit.finalScore,
        summary: page.summary,
        title: page.title,
      };
      primary.set(page.pageId, item);
    }
    item.score = Math.max(item.score, hit.finalScore);
    item.reasons.add(hit.diversificationReason);
    for (const reason of hit.meaningAdjustment.reasonCodes) item.reasons.add(reason);
    if (topChunks === 0) continue;
    if (selectedChunks >= topChunks) {
      truncated = true;
      continue;
    }
    const page = pages.get(hit.locator.pageId);
    const section = page?.sections.find((candidate) =>
      candidate.sectionId === hit.locator.sectionId);
    if (section === undefined) {
      throw new RetrievalOperationError('RETRIEVAL_CONTRACT_VIOLATION', request.projectId);
    }
    let context = section.semanticText ?? section.body;
    let tokens = estimatedContextTokens(context);
    const remainingTokens = requestedTokens - estimatedTokens;
    if (tokens > remainingTokens) {
      if (remainingTokens <= 0) {
        truncated = true;
        continue;
      }
      context = [...context].slice(0, remainingTokens * 4).join('').trimEnd();
      if (context.length === 0) {
        truncated = true;
        continue;
      }
      tokens = estimatedContextTokens(context);
      truncated = true;
    }
    item.chunks.push(context);
    item.locators.push(hit.locator);
    estimatedTokens += tokens;
    selectedChunks += 1;
  }
  const warnings = result.fallback === null
    ? Object.freeze([])
    : Object.freeze([{ code: result.fallback.reasonCode }]);
  return Object.freeze({
    data: Object.freeze({
      budget: Object.freeze({ estimatedTokens, requestedTokens, truncated }),
      gaps: Object.freeze([]),
      primary: Object.freeze([...primary.values()].map((item) => Object.freeze({
        chunks: Object.freeze(item.chunks),
        id: item.id,
        locators: Object.freeze(item.locators),
        reasons: Object.freeze([...item.reasons].sort()),
        score: item.score,
        summary: item.summary,
        title: item.title,
      }))),
      version: 1 as const,
    }),
    fallback: result.fallback === null
      ? null
      : Object.freeze({
          fromMode: 'hybrid' as const,
          reasonCode: result.fallback.reasonCode,
          toMode: 'lexical' as const,
        }),
    partial: result.fallback !== null,
    projectId: request.projectId,
    warnings,
  });
}

export function createProjectRetrievalWithPorts(
  options: CreateProjectRetrievalWithPortsOptions,
): ProjectRetrievalPort {
  const environment = options.environment ?? process.env;
  const providerConfigured = options.providerConfigured ?? (() =>
    defaultProviderConfigured(environment));
  const embeddingIdentity = options.embeddingIdentity ?? (() =>
    resolveConfiguredEmbeddingIdentity(environment));
  const embeddingCompatibility = options.embeddingCompatibility ?? {
    inspect: (_projectId: string, currentIdentity: EmbeddingIdentity) => Promise.resolve({
      currentIdentity,
      reasonCode: null,
      rebuildRequired: false,
      state: 'compatible' as const,
    }),
  };

  return {
    async context(inputRequest): Promise<ProjectContextResult> {
      const request = validateContextRequest(inputRequest);
      if (options.approvedWiki !== undefined) {
        try {
          return await approvedWikiContext(options.approvedWiki, request);
        } catch (error) {
          if (!(error instanceof LocalWikiRetrievalError) ||
              error.code !== 'LOCAL_WIKI_PROJECTION_UNAVAILABLE') throw error;
        }
      }
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
      const corpus = validatedCorpus(
        await options.corpus.snapshot(request.projectId),
        request.projectId,
      );
      const initialSnapshot = corpusSnapshotToken(corpus);
      const lexical = rankLexical(corpus.pages, queryTokens(request.query), request.query);
      if (request.mode === 'lexical') {
        const warnings = normalizeWarnings(corpus.warnings);
        return {
          embeddingCompatibility: {
            currentIdentity: null,
            reasonCode: null,
            rebuildRequired: false,
            state: 'not-applicable',
          },
          effectiveMode: 'lexical',
          excluded: corpus.excluded,
          fallback: null,
          hits: lexicalHits(lexical),
          partial: isPartial(warnings),
          projectId: request.projectId,
          recoveryAction: null,
          requestedMode: 'lexical',
          retrievalStrategy: RETRIEVAL_STRATEGY,
          warnings,
        };
      }
      const evaluation = await options.compiler.execute({
        capability: 'eval-fast',
        projectId: request.projectId,
      });
      const currentIdentity = embeddingIdentity();
      if (!evalData(evaluation, request.projectId).embeddingsAvailable) {
        return fallbackResult(
          corpus,
          lexical,
          request.mode,
          'embedding-store-unavailable',
          unavailableCompatibility('embedding-store-unavailable', currentIdentity),
        );
      }
      if (!providerConfigured() || currentIdentity === null) {
        return fallbackResult(
          corpus,
          lexical,
          request.mode,
          'provider-unconfigured',
          unavailableCompatibility('provider-unconfigured', currentIdentity),
        );
      }
      const compatibility = await embeddingCompatibility.inspect(request.projectId, currentIdentity);
      if (compatibility.state !== 'compatible') {
        return fallbackResult(corpus, lexical, request.mode, 'embedding-index-outdated', {
          currentIdentity: compatibility.currentIdentity,
          reasonCode: compatibility.reasonCode,
          rebuildRequired: compatibility.rebuildRequired,
          state: compatibility.state,
        });
      }
      const semantic = await options.compiler.execute({
        capability: 'search',
        projectId: request.projectId,
        question: request.query,
      });
      let freshCorpus: SearchCorpus;
      try {
        freshCorpus = validatedCorpus(
          await options.corpus.snapshot(request.projectId),
          request.projectId,
        );
      } catch (error) {
        if (error instanceof RetrievalOperationError &&
            error.code === 'RETRIEVAL_CONTRACT_VIOLATION') {
          throw new RetrievalOperationError('RETRIEVAL_SEMANTIC_DRIFT', request.projectId);
        }
        throw error;
      }
      if (corpusSnapshotToken(freshCorpus) !== initialSnapshot) {
        throw new RetrievalOperationError('RETRIEVAL_SEMANTIC_DRIFT', request.projectId);
      }
      const fallback = fallbackWarning(semantic.warnings);
      if (fallback !== null) return fallbackResult(corpus, lexical, request.mode, fallback, {
        currentIdentity,
        reasonCode: fallback,
        rebuildRequired: true,
        state: 'outdated',
      });
      const pages = new Map(corpus.pages.map((page) => [page.pageId, page]));
      const ranks = semanticRanks(searchData(semantic, request.projectId), pages, request.projectId);
      const warnings = normalizeWarnings(corpus.warnings, semantic.warnings);
      return {
        embeddingCompatibility: {
          currentIdentity,
          reasonCode: null,
          rebuildRequired: false,
          state: 'compatible',
        },
        effectiveMode: request.mode,
        excluded: corpus.excluded,
        fallback: null,
        hits: request.mode === 'semantic'
          ? semanticHits(ranks, pages)
          : hybridHits(lexical, ranks, pages),
        partial: isPartial(warnings),
        projectId: request.projectId,
        recoveryAction: null,
        requestedMode: request.mode,
        retrievalStrategy: RETRIEVAL_STRATEGY,
        warnings,
      };
    },
  };
}

export function createProjectRetrieval(options: CreateProjectRetrievalOptions): ProjectRetrievalPort {
  const compiler = createProjectCompiler({
    ...(options.jsonKnowledgeAdapters === undefined
      ? {}
      : { jsonKnowledgeAdapters: options.jsonKnowledgeAdapters }),
    knowledgeRoot: options.knowledgeRoot,
  });
  const corpus = createProjectCorpus({ knowledgeRoot: options.knowledgeRoot });
  const embeddingCompatibility = createProjectEmbeddingIdentityStore(options.knowledgeRoot);
  return createProjectRetrievalWithPorts({
    approvedWiki: createLocalWikiOperator({
      hubRoot: dirname(options.knowledgeRoot),
      knowledgeRoot: options.knowledgeRoot,
    }),
    compiler,
    corpus,
    embeddingCompatibility,
  });
}
