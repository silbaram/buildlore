import { describe, expect, it, vi } from 'vitest';

import {
  CompilerOperationError,
  type CompilerOperationResult,
  type CompilerRequest,
  type ContextSummary,
  type EvalSummary,
  type ProjectCompilerPort,
  type SearchSummary,
} from '../src/compiler/index.js';
import {
  ProjectCorpusError,
  type ProjectCorpusPort,
  type SearchCorpus,
  type SearchCorpusPage,
} from '../src/compiler/corpus.js';
import {
  RetrievalOperationError,
} from '../src/retrieval/index.js';
import { createProjectRetrievalWithPorts } from '../src/retrieval/service.js';

const EVAL: EvalSummary = {
  citationCoveragePercent: 100,
  citationPrecisionPercent: 100,
  embeddingsAvailable: true,
  healthScore: 100,
  pageCount: 3,
  pendingReviews: 0,
  sourceCount: 3,
  suite: 'fast',
  thresholdViolationCount: 0,
};

const CONTEXT: ContextSummary = {
  budget: { estimatedTokens: 10, requestedTokens: 100, truncated: false },
  gaps: [],
  primary: [],
  version: 1,
};

function page(
  pageId: string,
  options: { readonly body?: string; readonly summary?: string; readonly title?: string } = {},
): SearchCorpusPage {
  return {
    body: options.body ?? '',
    freshness: 'fresh',
    pageId,
    sourceRefs: [`repo@revision:docs/${pageId.replace('/', '-')}.md`],
    summary: options.summary ?? '',
    title: options.title ?? pageId,
  };
}

function corpus(
  pages: readonly SearchCorpusPage[],
  options: { readonly warnings?: readonly { readonly code: string }[] } = {},
): SearchCorpus {
  return {
    excluded: { archived: 1, orphaned: 2, stale: 3, unverified: 4 },
    pages,
    projectId: 'alpha',
    warnings: options.warnings ?? [],
  };
}

function operation(
  capability: CompilerOperationResult['capability'],
  data: CompilerOperationResult['data'],
  warnings: readonly { readonly code: string }[] = [],
): CompilerOperationResult {
  return {
    capability,
    data,
    ok: true,
    outcome: 'succeeded',
    projectId: 'alpha',
    warnings,
  };
}

function searchData(pageIds: readonly string[]): SearchSummary {
  return {
    pages: pageIds.map((pageId) => ({
      kind: 'page',
      pageId,
      slug: pageId.slice(pageId.indexOf('/') + 1),
      summary: 'upstream summary is not trusted for output',
      title: 'upstream title is not trusted for output',
    })),
  };
}

function fixture(options: {
  readonly corpus?: ProjectCorpusPort;
  readonly corpusValue?: SearchCorpus;
  readonly evaluation?: EvalSummary;
  readonly providerConfigured?: boolean;
  readonly search?: SearchSummary;
  readonly searchFailure?: Error;
  readonly searchWarnings?: readonly { readonly code: string }[];
} = {}) {
  const calls: CompilerRequest[] = [];
  const compiler: ProjectCompilerPort = {
    execute: vi.fn((request: CompilerRequest) => {
      calls.push(request);
      if (request.capability === 'eval-fast') {
        return Promise.resolve(operation('eval-fast', options.evaluation ?? EVAL));
      }
      if (request.capability === 'search') {
        if (options.searchFailure !== undefined) return Promise.reject(options.searchFailure);
        return Promise.resolve(operation(
          'search',
          options.search ?? searchData([]),
          options.searchWarnings,
        ));
      }
      if (request.capability === 'context') {
        return Promise.resolve(operation('context', CONTEXT));
      }
      return Promise.reject(new Error('Unexpected compiler capability in retrieval fixture.'));
    }),
    status: () => Promise.resolve({
      pendingChanges: [],
      pendingChangesCount: 0,
      stateStatus: 'ok',
    }),
  };
  const snapshot = vi.fn((projectId: string) => {
    if (options.corpus !== undefined) return options.corpus.snapshot(projectId);
    return Promise.resolve(options.corpusValue ?? corpus([]));
  });
  return {
    calls,
    compiler,
    retrieval: createProjectRetrievalWithPorts({
      compiler,
      corpus: options.corpus ?? { snapshot },
      providerConfigured: () => options.providerConfigured ?? true,
    }),
    snapshot,
  };
}

describe('project retrieval orchestration', () => {
  it('ranks lexical Unicode unique-token coverage deterministically without compiler/provider calls', async () => {
    const item = fixture({
      corpusValue: corpus([
        page('decisions/beta', { body: 'Recovery only.', title: 'Beta' }),
        page('decisions/alpha', {
          body: 'Recovery guidance.',
          summary: 'Café architecture.',
          title: 'Alpha',
        }),
      ], { warnings: [{ code: 'incomplete-compile' }] }),
    });
    const result = await item.retrieval.search({
      mode: 'lexical',
      projectId: 'alpha',
      query: 'Cafe\u0301 recovery recovery',
    });

    expect(result).toMatchObject({
      effectiveMode: 'lexical',
      excluded: { archived: 1, orphaned: 2, stale: 3, unverified: 4 },
      fallback: null,
      hits: [
        { lexicalRank: 1, pageId: 'decisions/alpha', rank: 1, score: 1 },
        { lexicalRank: 2, pageId: 'decisions/beta', rank: 2, score: 0.5 },
      ],
      partial: true,
      requestedMode: 'lexical',
      warnings: [{ code: 'incomplete-compile' }],
    });
    expect(item.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('Recovery guidance');
  });

  it('uses pageId tie-breaks, a top-20 bound, and normal empty results', async () => {
    const pages = Array.from({ length: 25 }, (_, index) =>
      page(`decisions/page-${String(25 - index).padStart(2, '0')}`, { body: 'shared' }));
    const item = fixture({ corpusValue: corpus(pages) });
    const result = await item.retrieval.search({
      mode: 'lexical',
      projectId: 'alpha',
      query: 'shared',
    });
    expect(result.hits).toHaveLength(20);
    expect(result.hits[0]?.pageId).toBe('decisions/page-01');
    expect(result.hits[19]?.pageId).toBe('decisions/page-20');

    await expect(item.retrieval.search({
      mode: 'lexical',
      projectId: 'alpha',
      query: 'unmatched',
    })).resolves.toMatchObject({ hits: [] });
  });

  it('rejects tokenless or control-bearing input before reading the corpus', async () => {
    const item = fixture();
    for (const query of ['---', 'line\nsecret']) {
      await expect(item.retrieval.search({
        mode: 'lexical',
        projectId: 'alpha',
        query,
      })).rejects.toBeInstanceOf(RetrievalOperationError);
    }
    await expect(item.retrieval.search({
      mode: 'hybrid',
      projectId: '../beta',
      query: 'architecture',
    })).rejects.toMatchObject({ code: 'RETRIEVAL_CONFIG_INVALID', projectId: 'unknown' });
    expect(item.snapshot).not.toHaveBeenCalled();
  });

  it('converts semantic order to reciprocal rank using only local corpus metadata', async () => {
    const item = fixture({
      corpusValue: corpus([
        page('decisions/alpha', { summary: 'Local alpha', title: 'Alpha local' }),
        page('decisions/beta', { summary: 'Local beta', title: 'Beta local' }),
      ]),
      search: searchData(['decisions/beta', 'decisions/alpha']),
    });
    const result = await item.retrieval.search({
      mode: 'semantic',
      projectId: 'alpha',
      query: 'find architecture',
    });

    expect(item.calls.map((call) => call.capability)).toEqual(['eval-fast', 'search']);
    expect(result).toMatchObject({
      effectiveMode: 'semantic',
      hits: [
        { pageId: 'decisions/beta', score: 1, semanticRank: 1, title: 'Beta local' },
        { pageId: 'decisions/alpha', score: 0.5, semanticRank: 2, title: 'Alpha local' },
      ],
      partial: false,
      requestedMode: 'semantic',
    });
    expect(JSON.stringify(result)).not.toContain('upstream title');
  });

  it('fuses lexical and semantic ranks with the approved 0.5 reciprocal rule', async () => {
    const item = fixture({
      corpusValue: corpus([
        page('decisions/alpha', { body: 'architecture design' }),
        page('decisions/beta', { body: 'architecture' }),
        page('decisions/gamma', { body: 'unrelated' }),
      ]),
      search: searchData(['decisions/beta', 'decisions/gamma']),
      searchWarnings: [{ code: 'embedding-entry-stale' }],
    });
    const result = await item.retrieval.search({
      mode: 'hybrid',
      projectId: 'alpha',
      query: 'architecture design',
    });

    expect(result).toMatchObject({
      effectiveMode: 'hybrid',
      hits: [
        { lexicalRank: 2, pageId: 'decisions/beta', score: 0.75, semanticRank: 1 },
        { lexicalRank: 1, pageId: 'decisions/alpha', score: 0.5 },
        { pageId: 'decisions/gamma', score: 0.25, semanticRank: 2 },
      ],
      partial: true,
      warnings: [{ code: 'embedding-entry-stale' }],
    });
    expect(result.hits.map((hit) => hit.pageId)).toEqual([
      'decisions/beta',
      'decisions/alpha',
      'decisions/gamma',
    ]);
  });

  it.each([
    ['embedding-store-unavailable', { ...EVAL, embeddingsAvailable: false }, true],
    ['provider-unconfigured', EVAL, false],
  ] as const)('falls back before semantic search for %s', async (reasonCode, evaluation, configured) => {
    const item = fixture({
      corpusValue: corpus([page('decisions/alpha', { body: 'architecture' })]),
      evaluation,
      providerConfigured: configured,
    });
    await expect(item.retrieval.search({
      mode: 'hybrid',
      projectId: 'alpha',
      query: 'architecture',
    })).resolves.toMatchObject({
      effectiveMode: 'lexical',
      fallback: { fromMode: 'hybrid', reasonCode, toMode: 'lexical' },
      partial: true,
      warnings: [{ code: reasonCode }],
    });
    expect(item.calls.map((call) => call.capability)).toEqual(['eval-fast']);
  });

  it('falls back on documented SDK embedding degradation but not provider runtime failure', async () => {
    const degraded = fixture({
      corpusValue: corpus([page('decisions/alpha', { body: 'architecture' })]),
      search: searchData(['decisions/alpha']),
      searchWarnings: [{ code: 'embedding-index-outdated' }],
    });
    await expect(degraded.retrieval.search({
      mode: 'semantic',
      projectId: 'alpha',
      query: 'architecture',
    })).resolves.toMatchObject({
      effectiveMode: 'lexical',
      fallback: { reasonCode: 'embedding-index-outdated' },
    });

    const failure = new CompilerOperationError('COMPILER_TIMEOUT', 'Compiler provider request timed out.', {
      capability: 'search',
      projectId: 'alpha',
      recoveryAction: 'status',
      retryable: true,
      sideEffectsPossible: false,
    });
    const runtime = fixture({
      corpusValue: corpus([page('decisions/alpha', { body: 'architecture' })]),
      searchFailure: failure,
    });
    await expect(runtime.retrieval.search({
      mode: 'hybrid',
      projectId: 'alpha',
      query: 'architecture',
    })).rejects.toBe(failure);
  });

  it('rejects semantic refs outside the selected local corpus', async () => {
    const item = fixture({
      corpusValue: corpus([page('decisions/alpha', { body: 'architecture' })]),
      search: searchData(['decisions/beta']),
    });
    await expect(item.retrieval.search({
      mode: 'semantic',
      projectId: 'alpha',
      query: 'architecture',
    })).rejects.toMatchObject({ code: 'RETRIEVAL_SEMANTIC_DRIFT', projectId: 'alpha' });
  });

  it('preserves corpus security refusal without invoking any compiler capability', async () => {
    const denied: ProjectCorpusPort = {
      snapshot: () => Promise.reject(new ProjectCorpusError('CORPUS_SECURITY_DENIED', 'alpha')),
    };
    const item = fixture({ corpus: denied });
    await expect(item.retrieval.search({
      mode: 'hybrid',
      projectId: 'alpha',
      query: 'architecture',
    })).rejects.toMatchObject({ code: 'CORPUS_SECURITY_DENIED' });
    expect(item.calls).toEqual([]);
  });

  it('forces credential-free lexical context when embeddings or provider are unavailable', async () => {
    const item = fixture({
      evaluation: { ...EVAL, embeddingsAvailable: false },
    });
    const result = await item.retrieval.context({
      projectId: 'alpha',
      prompt: 'Provide architecture context.',
    });
    expect(item.calls).toEqual([
      { capability: 'eval-fast', projectId: 'alpha' },
      {
        capability: 'context',
        projectId: 'alpha',
        prompt: 'Provide architecture context.',
        topChunks: 0,
      },
    ]);
    expect(result).toMatchObject({
      fallback: { reasonCode: 'embedding-store-unavailable' },
      partial: true,
      warnings: [{ code: 'embedding-store-unavailable' }],
    });
  });

  it('honors explicit lexical context without an eval or provider preflight', async () => {
    const item = fixture({ providerConfigured: false });
    await expect(item.retrieval.context({
      projectId: 'alpha',
      prompt: 'Provide local context.',
      topChunks: 0,
    })).resolves.toMatchObject({ fallback: null, partial: false });
    expect(item.calls.map((call) => call.capability)).toEqual(['context']);
  });
});
