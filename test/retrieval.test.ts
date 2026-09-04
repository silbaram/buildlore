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
  RETRIEVAL_FUSION_POLICY_V1,
  RETRIEVAL_RANKING_POLICY_V2,
  RetrievalOperationError,
  type LocalWikiOperatorPort,
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
    body: options.body ?? 'fixture body',
    freshness: 'fresh',
    pageId,
    sourceRefs: [`repo@revision:docs/${pageId.replace('/', '-')}.md`],
    summary: options.summary ?? 'fixture summary',
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
  readonly approvedWiki?: Pick<LocalWikiOperatorPort, 'readPage' | 'search'>;
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
      ...(options.approvedWiki === undefined ? {} : { approvedWiki: options.approvedWiki }),
      compiler,
      corpus: options.corpus ?? { snapshot },
      providerConfigured: () => options.providerConfigured ?? true,
    }),
    snapshot,
  };
}

describe('project retrieval orchestration', () => {
  it('[V9-V-07][V9-V-26][V10-V-15] retrieves pure Korean/Unicode locally without provider work', async () => {
    const item = fixture({
      corpusValue: corpus([
        page('decisions/beta', { body: 'Recovery only.', title: 'Beta' }),
        page('decisions/alpha', {
          body: 'Recovery guidance.',
          summary: 'Café architecture.',
          title: 'Alpha',
        }),
        page('decisions/korean', { body: '인증 오류 복구', title: '한국어 복구' }),
      ], { warnings: [{ code: 'incomplete-compile' }] }),
    });
    const result = await item.retrieval.search({
      mode: 'lexical',
      projectId: 'alpha',
      query: 'Cafe\u0301 recovery recovery',
    });

    expect(result).toMatchObject({
      embeddingCompatibility: { state: 'not-applicable' },
      effectiveMode: 'lexical',
      excluded: { archived: 1, orphaned: 2, stale: 3, unverified: 4 },
      fallback: null,
      hits: [
        {
          lexicalRank: 1,
          pageId: 'decisions/alpha',
          rank: 1,
          score: 1,
          scoreKind: 'lexical-weighted-coverage',
        },
        {
          lexicalRank: 2,
          pageId: 'decisions/beta',
          rank: 2,
          score: 0.5,
          scoreKind: 'lexical-weighted-coverage',
        },
      ],
      partial: true,
      requestedMode: 'lexical',
      retrievalStrategy: { tokenizerId: 'buildlore-unicode-hangul-ngram' },
      warnings: [{ code: 'incomplete-compile' }],
    });
    expect(item.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('Recovery guidance');
    await expect(item.retrieval.search({
      mode: 'lexical',
      projectId: 'alpha',
      query: '인증 오류',
    })).resolves.toMatchObject({
      hits: [{ pageId: 'decisions/korean' }],
    });
    expect(item.calls).toEqual([]);
  });

  it('[V9-V-26] preserves pageId tie-breaks, top-20, and normal zero-match results', async () => {
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

  it('[V9-V-09][V9-V-18] converts recorded semantic order using local corpus metadata', async () => {
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
      embeddingCompatibility: {
        currentIdentity: { modelId: 'voyage-3-lite', providerId: 'voyage' },
        state: 'compatible',
      },
      effectiveMode: 'semantic',
      hits: [
        { pageId: 'decisions/beta', score: 1, semanticRank: 1, title: 'Beta local' },
        { pageId: 'decisions/alpha', score: 0.5, semanticRank: 2, title: 'Alpha local' },
      ],
      partial: false,
      recoveryAction: null,
      requestedMode: 'semantic',
    });
    expect(JSON.stringify(result)).not.toContain('upstream title');
  });

  it('[V9-V-10][V9-V-18][V10-V-08] collapses duplicate semantic refs at first occurrence', async () => {
    const item = fixture({
      corpusValue: corpus([
        page('decisions/alpha', { title: 'Alpha local' }),
        page('decisions/beta', { title: 'Beta local' }),
      ]),
      search: searchData([
        'decisions/beta',
        'decisions/beta',
        'decisions/alpha',
        'decisions/beta',
      ]),
    });
    const result = await item.retrieval.search({
      mode: 'semantic',
      projectId: 'alpha',
      query: 'find architecture',
    });
    expect(result.hits.map((hit) => ({
      pageId: hit.pageId,
      score: hit.score,
      semanticRank: hit.semanticRank,
    }))).toEqual([
      { pageId: 'decisions/beta', score: 1, semanticRank: 1 },
      { pageId: 'decisions/alpha', score: 0.5, semanticRank: 2 },
    ]);
  });

  it('[V9-V-10][V9-V-11][V10-V-15] exposes finite explainable fixed hybrid contributions', async () => {
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
        {
          lexicalRank: 2,
          pageId: 'decisions/beta',
          score: 0.75,
          scoreComponents: {
            combinedScore: 0.75,
            fusion: { lexicalContribution: 0.25, semanticContribution: 0.5 },
          },
          semanticRank: 1,
        },
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
    for (const hit of result.hits) {
      expect(Number.isFinite(hit.score)).toBe(true);
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
      expect(hit.scoreComponents.combinedScore).toBe(hit.score);
      if (hit.scoreComponents.fusion !== undefined) {
        expect(hit.score).toBe(
          Math.round((hit.scoreComponents.fusion.lexicalContribution +
            hit.scoreComponents.fusion.semanticContribution) * 1_000_000) / 1_000_000,
        );
      }
      expect(hit.matchedEvidence.every((evidence) =>
        evidence.count > 0 && ['title', 'summary', 'body'].includes(evidence.field) &&
        ['unicode-word', 'hangul-bigram', 'hangul-trigram'].includes(evidence.matchKind),
      )).toBe(true);
    }
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

  it('[V9-V-14][V10-V-10] falls back before semantic work for incompatible marker identity', async () => {
    const item = fixture({
      corpusValue: corpus([page('decisions/alpha', { body: 'architecture' })]),
    });
    const inspect = vi.fn(() => Promise.resolve({
      currentIdentity: {
        compatibilityDigest: `sha256:${'a'.repeat(64)}` as const,
        compilerVersion: '1.1.0' as const,
        modelId: 'fixture-model',
        providerId: 'openai' as const,
      },
      reasonCode: 'embedding-marker-missing' as const,
      rebuildRequired: true,
      state: 'missing' as const,
    }));
    const retrieval = createProjectRetrievalWithPorts({
      compiler: item.compiler,
      corpus: { snapshot: item.snapshot },
      embeddingCompatibility: { inspect },
      embeddingIdentity: () => ({
        compatibilityDigest: `sha256:${'a'.repeat(64)}`,
        compilerVersion: '1.1.0',
        modelId: 'fixture-model',
        providerId: 'openai',
      }),
      providerConfigured: () => true,
    });
    await expect(retrieval.search({
      mode: 'hybrid',
      projectId: 'alpha',
      query: 'architecture',
    })).resolves.toMatchObject({
      effectiveMode: 'lexical',
      embeddingCompatibility: {
        reasonCode: 'embedding-marker-missing',
        rebuildRequired: true,
        state: 'missing',
      },
      fallback: { reasonCode: 'embedding-index-outdated' },
      recoveryAction: {
        command: ['compile', '--project', 'alpha'],
        rebuildRequired: true,
      },
    });
    expect(item.calls.map((call) => call.capability)).toEqual(['eval-fast']);
    expect(inspect).toHaveBeenCalledOnce();
  });

  it('[V9-V-17][V10-V-10] preserves fallback precedence without hiding runtime failure', async () => {
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

  it('[V9-V-18][V10-V-12] rejects semantic refs outside the selected corpus', async () => {
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

  it('[V9-V-18][V10-V-09] rejects post-call content, source, eligibility, and project drift', async () => {
    const initial = corpus([page('decisions/alpha', {
      body: 'architecture',
      summary: 'initial summary',
    })]);
    const changedSnapshots = [
      corpus([page('decisions/alpha', {
        body: 'changed architecture',
        summary: 'initial summary',
      })]),
      corpus([{
        ...page('decisions/alpha', { body: 'architecture', summary: 'initial summary' }),
        sourceRefs: ['repo@revision:docs/changed.md'],
      }]),
      {
        ...initial,
        excluded: { ...initial.excluded, stale: initial.excluded.stale + 1 },
      },
      corpus([{
        ...page('decisions/alpha', { body: 'architecture', summary: 'initial summary' }),
        freshness: 'stale',
      } as unknown as SearchCorpusPage]),
      { ...initial, projectId: 'beta' },
      corpus([]),
    ];
    for (const changed of changedSnapshots) {
      let snapshotCount = 0;
      const snapshot = vi.fn(() => Promise.resolve(snapshotCount++ === 0 ? initial : changed));
      const item = fixture({
        corpus: { snapshot },
        search: searchData(['decisions/alpha']),
      });
      await expect(item.retrieval.search({
        mode: 'hybrid',
        projectId: 'alpha',
        query: 'architecture',
      })).rejects.toMatchObject({
        code: 'RETRIEVAL_SEMANTIC_DRIFT',
        projectId: 'alpha',
      });
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(item.calls.map((call) => call.capability)).toEqual(['eval-fast', 'search']);
    }
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

  it('[V9-V-19][V10-V-07][V10-V-11] rejects the unsafe corpus matrix before compiler/provider work', async () => {
    const invalidCorpora: SearchCorpus[] = [
      { ...corpus([page('decisions/alpha')]), projectId: 'beta' },
      corpus([{ ...page('decisions/alpha'), pageId: '../escape' }]),
      corpus([{
        ...page('decisions/alpha'),
        sourceRefs: ['repo@revision:../../private'],
      }]),
      corpus([page('decisions/alpha'), page('decisions/alpha')]),
      corpus([{
        ...page('decisions/alpha'),
        title: 'unsafe\u0000title',
      }]),
      corpus([{
        ...page('decisions/alpha'),
        sourceRefs: ['repo@revision:docs/shared.md', 'repo@revision:docs/shared.md'],
      }]),
      {
        ...corpus([page('decisions/alpha')]),
        excluded: { archived: -1, orphaned: 0, stale: 0, unverified: 0 },
      },
    ];
    for (const corpusValue of invalidCorpora) {
      const item = fixture({ corpusValue });
      await expect(item.retrieval.search({
        mode: 'hybrid',
        projectId: 'alpha',
        query: 'architecture',
      })).rejects.toMatchObject({
        code: 'RETRIEVAL_CONTRACT_VIOLATION',
        projectId: 'alpha',
      });
      expect(item.calls).toEqual([]);
    }
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

  it('builds default LLM context from approved semantic text and expandable locators', async () => {
    const pageId = `page-${'a'.repeat(64)}`;
    const sectionId = 'section-main';
    const citationId = 'citation-approved-context';
    const sourceId = 'source-approved-context';
    const search = vi.fn(() => Promise.resolve(Object.freeze({
      effectiveChannels: Object.freeze(['lexical', 'graph', 'semantic'] as const),
      effectiveIntent: 'current' as const,
      effectiveMode: 'hybrid' as const,
      egress: 'none' as const,
      fallback: null,
      fusionPolicy: RETRIEVAL_FUSION_POLICY_V1,
      hits: Object.freeze([Object.freeze({
        baseScore: 0.1,
        channels: Object.freeze([Object.freeze({
          channel: 'semantic' as const, contribution: 0.1, rank: 1, score: 0.1,
        })]),
        chunkId: `chunk-${'b'.repeat(64)}`,
        diversificationReason: 'primary-distinct-groups' as const,
        finalScore: 0.1055,
        locator: Object.freeze({
          citationIds: Object.freeze([citationId]),
          pageId,
          projectId: 'alpha',
          sectionId,
          sourceIds: Object.freeze([sourceId]),
        }),
        matchedEvidence: Object.freeze([]),
        meaningAdjustment: Object.freeze({
          authority: 0.0015,
          evidenceKind: 0.001,
          lifecycle: 0.003,
          reasonCodes: Object.freeze(['canonical-authority-boost']),
          total: 0.0055,
        }),
        rank: 1,
        score: 0.1055,
        scoreComponents: Object.freeze({ combinedScore: 0.1 }),
        scoreKind: 'rrf-v1' as const,
        title: 'Approved context',
      })]),
      identity: Object.freeze({
        embeddingIdentityDigest: `sha256:${'c'.repeat(64)}` as const,
        indexGenerationId: `generation-${'d'.repeat(64)}`,
        indexManifestDigest: `sha256:${'e'.repeat(64)}` as const,
      }),
      intentReasonCodes: Object.freeze(['auto-current-default'] as const),
      projectId: 'alpha',
      providerUsed: 'local-in-process' as const,
      rankingPolicy: RETRIEVAL_RANKING_POLICY_V2,
      requestedIntent: 'auto' as const,
      requestedMode: 'hybrid' as const,
      schemaVersion: 'buildlore.retrieval-result.v3' as const,
    })));
    const readPage = vi.fn(() => Promise.resolve(Object.freeze({
      childPageIds: Object.freeze([]),
      corpusDigest: `sha256:${'1'.repeat(64)}` as const,
      egress: 'none' as const,
      generationDigest: `sha256:${'2'.repeat(64)}` as const,
      pageId,
      parentPageId: null,
      projectId: 'alpha',
      projectionDigest: `sha256:${'3'.repeat(64)}` as const,
      proposalDigest: `sha256:${'4'.repeat(64)}` as const,
      providerUsed: 'none' as const,
      relationPageIds: Object.freeze([]),
      sanitizerPolicyDigest: `sha256:${'5'.repeat(64)}` as const,
      schemaVersion: 'buildlore.local-active-wiki-page.v1' as const,
      sections: Object.freeze([Object.freeze({
        body: `source_digest: sha256:${'6'.repeat(64)}\nUseful semantic context.`,
        citationLocators: Object.freeze([Object.freeze({ citationId, sourceId })]),
        semanticText: 'Useful semantic context.',
        sectionId,
      })]),
      status: 'active' as const,
      summary: 'Approved summary.',
      title: 'Approved context',
    })));
    const item = fixture({ approvedWiki: { readPage, search } });

    const result = await item.retrieval.context({
      projectId: 'alpha',
      prompt: 'Provide architecture context.',
    });

    expect(item.calls).toEqual([]);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ mode: 'hybrid' }));
    expect(result.data.primary[0]).toMatchObject({
      chunks: ['Useful semantic context.'],
      id: pageId,
      locators: [{ citationIds: [citationId], sectionId, sourceIds: [sourceId] }],
    });
    expect(JSON.stringify(result.data)).not.toContain('source_digest');
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
