import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMPILER_CAPABILITIES,
  CompilerBackendError,
  CompilerOperationError,
  createCompilerEgressAuthorizer,
  createProjectCompiler,
  type CompilerBackend,
  type CompilerCapabilityName,
  type CompilerRequest,
} from '../src/compiler/index.js';
import { createLlmWikiCompilerBackend } from '../src/compiler/backend.js';
import { addProject } from '../src/knowledge/index.js';

const temporaryRoots: string[] = [];

const STATUS_RESULT = {
  lastCompiledAt: null,
  pages: { concepts: 0, queries: 0, total: 0 },
  pendingCandidates: 0,
  pendingChanges: [],
  pendingChangesCount: 0,
  sources: 0,
  stateStatus: 'missing',
};

async function createFixture(backend: CompilerBackend, allowEgress = true) {
  const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-capabilities-'));
  temporaryRoots.push(knowledgeRoot);
  await addProject(knowledgeRoot, {
    displayName: 'Alpha',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
  });
  return {
    compiler: createProjectCompiler({
      backend,
      egressAuthorizer: createCompilerEgressAuthorizer(() => allowEgress),
      environment: {},
      knowledgeRoot,
    }),
    knowledgeRoot,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('compiler capability contract', () => {
  it('declares the approved SDK-only capability matrix', () => {
    expect(COMPILER_CAPABILITIES.compile).toMatchObject({
      capability: 'compile',
      egress: 'source-to-generation-provider',
      fallback: 'none',
      provider: 'required',
      transport: 'sdk',
      workspaceEffect: 'content-write',
    });
    expect(COMPILER_CAPABILITIES.context).toMatchObject({
      egress: 'prompt-to-embedding-provider',
      provider: 'conditional',
      workspaceEffect: 'none',
    });
    expect(COMPILER_CAPABILITIES['eval-fast']).toMatchObject({
      provider: 'none',
      workspaceEffect: 'none',
    });
    expect(COMPILER_CAPABILITIES['eval-full']).toMatchObject({
      egress: 'citation-evidence-to-judge',
      provider: 'required',
      workspaceEffect: 'cache-write',
    });
    expect(COMPILER_CAPABILITIES.lint).toMatchObject({
      provider: 'none',
      workspaceEffect: 'none',
    });
    expect(COMPILER_CAPABILITIES.query).toMatchObject({
      provider: 'required',
      workspaceEffect: 'log-write',
    });
    expect(COMPILER_CAPABILITIES.search).toMatchObject({
      provider: 'required',
      workspaceEffect: 'none',
    });
    expect(COMPILER_CAPABILITIES.status).toMatchObject({
      provider: 'none',
      workspaceEffect: 'none',
    });
    for (const descriptor of Object.values(COMPILER_CAPABILITIES)) {
      expect(descriptor).toMatchObject({
        activeCancellation: false,
        fallback: 'none',
        overallTimeout: false,
        progress: 'none',
        transport: 'sdk',
      });
    }
  });

  it('normalizes all eight capability results without upstream bodies or reasoning', async () => {
    const responses: Readonly<Record<CompilerCapabilityName, unknown>> = {
      compile: {
        candidates: [],
        compiled: 1,
        concepts: ['Alpha Concept'],
        deleted: 0,
        errors: [],
        pages: ['alpha-concept'],
        skipped: 0,
      },
      context: {
        budget: { estimatedTokens: 30, requestedTokens: 100, truncated: false },
        gaps: [{ code: 'dangling-link', message: 'raw gap', pageId: 'concepts/alpha' }],
        primary: [
          {
            chunks: [{ score: 0.8, text: 'generated wiki chunk' }],
            id: 'concepts/alpha',
            reasons: ['title-match'],
            score: 0.8,
            sourceWindows: [{ file: 'secret.md', start: 1, end: 2, text: 'source body' }],
            summary: 'safe summary',
            title: 'Alpha',
          },
        ],
        version: 1,
        warnings: [{ code: 'embedding-store-missing', message: 'raw warning' }],
      },
      'eval-fast': evalResult('fast'),
      'eval-full': {
        ...evalResult('full'),
        citationSupport: {
          judgeErrors: 0,
          judgements: [{ claimText: 'source body', reason: 'provider reasoning', spanText: 'secret' }],
          meanScore: 1.5,
        },
      },
      lint: {
        errors: 1,
        info: 0,
        results: [
          {
            file: 'wiki/concepts/alpha.md',
            line: 3,
            message: 'source body in raw lint message',
            rule: 'citation-required',
            severity: 'error',
          },
        ],
        warnings: 0,
      },
      query: {
        answer: 'grounded answer',
        pageIds: ['concepts/alpha'],
        reasoning: 'provider reasoning',
        refs: [{ kind: 'page', pageId: 'concepts/alpha', slug: 'alpha', title: 'Alpha' }],
        selectedPages: ['alpha'],
        warnings: [{ code: 'embedding-index-outdated', message: 'raw warning' }],
      },
      search: {
        pages: [
          {
            body: 'full page body must not pass through',
            slug: 'alpha',
            summary: 'safe summary',
            title: 'Alpha',
          },
        ],
        refs: [{ kind: 'page', pageId: 'concepts/alpha', slug: 'alpha', title: 'Alpha' }],
        warnings: [{ code: 'embedding-index-outdated', message: 'raw warning' }],
      },
      status: STATUS_RESULT,
    };
    const calls: Array<{ capability: string; root: string }> = [];
    const backend: CompilerBackend = {
      run(root, request) {
        calls.push({ capability: request.capability, root });
        return Promise.resolve(responses[request.capability]);
      },
    };
    const { compiler, knowledgeRoot } = await createFixture(backend);
    const requests: readonly CompilerRequest[] = [
      { capability: 'compile', projectId: 'alpha' },
      { capability: 'status', projectId: 'alpha' },
      { capability: 'lint', projectId: 'alpha' },
      { capability: 'eval-fast', projectId: 'alpha' },
      { capability: 'eval-full', projectId: 'alpha' },
      { capability: 'search', projectId: 'alpha', question: 'What is alpha?' },
      { capability: 'query', projectId: 'alpha', question: 'Explain alpha.' },
      { capability: 'context', projectId: 'alpha', prompt: 'Need alpha context.' },
    ];

    const results = await Promise.all(requests.map(async (request) => compiler.execute(request)));
    expect(calls).toHaveLength(8);
    expect(new Set(calls.map((call) => call.root))).toEqual(
      new Set([join(knowledgeRoot, 'projects', 'alpha')]),
    );
    expect(results[0]).toMatchObject({
      data: { compiled: 1, pageIds: ['concepts/alpha-concept'] },
      outcome: 'succeeded',
    });
    expect(results[1]).toMatchObject({ data: { pendingChangesCount: 0 } });
    expect(results[2]).toMatchObject({
      data: { findings: [{ file: 'wiki/concepts/alpha.md', rule: 'citation-required' }] },
    });
    expect(results[4]).toMatchObject({ data: { citationSupportMean: 1.5, suite: 'full' } });
    expect(results[5]).toMatchObject({
      data: { pages: [{ pageId: 'concepts/alpha', summary: 'safe summary' }] },
      warnings: [{ code: 'embedding-index-outdated' }],
    });
    expect(results[6]).toMatchObject({ data: { answer: 'grounded answer' } });
    expect(results[7]).toMatchObject({
      data: { primary: [{ chunks: ['generated wiki chunk'], id: 'concepts/alpha' }] },
    });
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain('full page body');
    expect(serialized).not.toContain('provider reasoning');
    expect(serialized).not.toContain('source body');
    expect(serialized).not.toContain('raw warning');
  });

  it('maps every capability to the approved public SDK call and safe options', async () => {
    const compile = vi.fn(() => Promise.resolve({}));
    const context = vi.fn(() => Promise.resolve({}));
    const evalRun = vi.fn(() => Promise.resolve({}));
    const lint = vi.fn(() =>
      Promise.resolve({
        errors: 1,
        info: 0,
        results: [
          {
            file: '/safe/project/wiki/concepts/alpha.md',
            message: 'raw message',
            rule: 'citation-required',
            severity: 'error',
          },
        ],
        warnings: 0,
      }),
    );
    const query = vi.fn(() => Promise.resolve({}));
    const search = vi.fn(() => Promise.resolve({}));
    const status = vi.fn(() => Promise.resolve({}));
    const wiki = {
      compile,
      getContextPack: context,
      lint,
      query,
      runEval: evalRun,
      search,
      status,
    };
    const factory = vi.fn(() => wiki);
    const backend = createLlmWikiCompilerBackend(factory);
    const root = '/safe/project';

    await backend.run(root, { capability: 'compile', projectId: 'alpha' });
    await backend.run(root, { capability: 'status', projectId: 'alpha' });
    const lintResult = await backend.run(root, { capability: 'lint', projectId: 'alpha' });
    await backend.run(root, { capability: 'eval-fast', projectId: 'alpha' });
    await backend.run(root, { capability: 'eval-full', projectId: 'alpha' });
    await backend.run(root, {
      capability: 'search',
      projectId: 'alpha',
      question: 'Find alpha.',
    });
    await backend.run(root, {
      capability: 'query',
      projectId: 'alpha',
      question: 'Explain alpha.',
    });
    await backend.run(root, {
      budget: 2_000,
      capability: 'context',
      depth: 2,
      projectId: 'alpha',
      prompt: 'Need alpha context.',
      topChunks: 4,
      topPages: 3,
    });

    expect(factory).toHaveBeenCalledTimes(8);
    expect(factory).toHaveBeenCalledWith(root);
    expect(compile).toHaveBeenCalledWith();
    expect(status).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledWith();
    expect(lint).toHaveBeenCalledWith();
    expect(lintResult).toMatchObject({
      results: [{ file: 'wiki/concepts/alpha.md', rule: 'citation-required' }],
    });
    expect(evalRun).toHaveBeenNthCalledWith(1, { mode: 'fast', record: false });
    expect(evalRun).toHaveBeenNthCalledWith(2, { mode: 'full', record: false });
    expect(search).toHaveBeenCalledWith('Find alpha.');
    expect(query).toHaveBeenCalledWith('Explain alpha.', { debug: false, save: false });
    expect(context).toHaveBeenCalledWith({
      budget: 2_000,
      depth: 2,
      prompt: 'Need alpha context.',
      topChunks: 4,
      topPages: 3,
    });
  });

  it('preserves a clean compile as a true SDK-backed no-op', async () => {
    const compile = vi.fn(() => Promise.resolve({}));
    const status = vi.fn(() =>
      Promise.resolve({
        pendingChanges: [],
        pendingChangesCount: 0,
        sources: 3,
        stateStatus: 'ok',
      }),
    );
    const backend = createLlmWikiCompilerBackend(
      () =>
        ({
          compile,
          status,
        }) as unknown as ReturnType<
          NonNullable<Parameters<typeof createLlmWikiCompilerBackend>[0]>
        >,
    );

    await expect(
      backend.run('/safe/project', { capability: 'compile', projectId: 'alpha' }),
    ).resolves.toEqual({
      candidates: [],
      compiled: 0,
      concepts: [],
      deleted: 0,
      errors: [],
      pages: [],
      skipped: 3,
    });
    expect(status).toHaveBeenCalledOnce();
    expect(compile).not.toHaveBeenCalled();
  });

  it('classifies the native provider abort timeout without exposing its detail', async () => {
    const rawError = Object.assign(new Error('raw timeout detail'), { name: 'AbortError' });
    const backend = createLlmWikiCompilerBackend(
      () =>
        ({
          compile: () => Promise.reject(rawError),
          status: () =>
            Promise.resolve({
              pendingChanges: [{ file: 'decision--alpha.md', status: 'new' }],
              pendingChangesCount: 1,
              sources: 1,
              stateStatus: 'missing',
            }),
        }) as unknown as ReturnType<
          NonNullable<Parameters<typeof createLlmWikiCompilerBackend>[0]>
        >,
    );
    const error = await backend
      .run('/safe/project', { capability: 'compile', projectId: 'alpha' })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CompilerBackendError);
    expect(error).toMatchObject({ kind: 'timeout' });
    expect(JSON.stringify(error)).not.toContain('raw timeout detail');
  });

  it('denies provider capabilities by default before the backend', async () => {
    const run = vi.fn();
    const backend: CompilerBackend = { run };
    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-capabilities-'));
    temporaryRoots.push(knowledgeRoot);
    await addProject(knowledgeRoot, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    const compiler = createProjectCompiler({ backend, knowledgeRoot });
    for (const request of [
      { capability: 'compile', projectId: 'alpha' },
      { capability: 'eval-full', projectId: 'alpha' },
      { capability: 'search', projectId: 'alpha', question: 'Find alpha.' },
      { capability: 'query', projectId: 'alpha', question: 'Explain alpha.' },
      { capability: 'context', projectId: 'alpha', prompt: 'Need semantic context.' },
    ] as const) {
      await expect(compiler.execute(request)).rejects.toMatchObject({
        code: 'COMPILER_EGRESS_DENIED',
        sideEffectsPossible: false,
      });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps context local without an egress decision when semantic chunks are disabled', async () => {
    const authorize = vi.fn(() => false);
    const backend: CompilerBackend = {
      run: () =>
        Promise.resolve({
          budget: { estimatedTokens: 1, requestedTokens: 100, truncated: false },
          gaps: [],
          primary: [],
          version: 1,
          warnings: [],
        }),
    };
    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-capabilities-'));
    temporaryRoots.push(knowledgeRoot);
    await addProject(knowledgeRoot, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    const compiler = createProjectCompiler({
      backend,
      egressAuthorizer: createCompilerEgressAuthorizer(authorize),
      knowledgeRoot,
    });
    await expect(
      compiler.execute({
        capability: 'context',
        projectId: 'alpha',
        prompt: 'Local context only.',
        topChunks: 0,
      }),
    ).resolves.toMatchObject({ capability: 'context', projectId: 'alpha' });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('rejects unsafe input and forged optional write controls', async () => {
    const run = vi.fn();
    const backend: CompilerBackend = { run };
    const { compiler } = await createFixture(backend);
    await expect(
      compiler.execute({ capability: 'query', projectId: 'alpha', question: 'line\nsecret' }),
    ).rejects.toMatchObject({ code: 'COMPILER_CONFIG_INVALID' });
    await expect(
      compiler.execute({
        capability: 'query',
        projectId: 'alpha',
        question: 'safe',
        save: true,
      } as CompilerRequest),
    ).rejects.toMatchObject({ code: 'COMPILER_CONFIG_INVALID' });
    for (const request of [
      null,
      {},
      { capability: 'query', projectId: 'alpha' },
      { capability: 'search', projectId: 'alpha', question: 42 },
      { capability: 'context', projectId: 'alpha', prompt: undefined },
      { capability: 'context', projectId: 'alpha', prompt: 'safe', topChunks: 51 },
      { capability: 'context', projectId: 'alpha', prompt: 'safe', topPages: 21 },
      { capability: 'status', extra: true, projectId: 'alpha' },
    ]) {
      await expect(compiler.execute(request as CompilerRequest)).rejects.toMatchObject({
        code: 'COMPILER_CONFIG_INVALID',
      });
    }
    await expect(
      compiler.execute(
        { capability: 'status', projectId: 'alpha' },
        { signal: { aborted: false } as AbortSignal },
      ),
    ).rejects.toMatchObject({ code: 'COMPILER_CONFIG_INVALID' });
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed on inconsistent, unsafe, or out-of-range upstream results', async () => {
    const responses: Readonly<Partial<Record<CompilerCapabilityName, unknown>>> = {
      context: {
        budget: { estimatedTokens: 1, requestedTokens: 10, truncated: 'false' },
        gaps: [],
        primary: [],
        version: 1,
        warnings: [],
      },
      'eval-full': {
        ...evalResult('full'),
        citationSupport: { judgeErrors: 0, judgements: [], meanScore: 3 },
      },
      lint: {
        errors: 0,
        info: 0,
        results: [
          { file: 'wiki/concepts/alpha.md', rule: 'citation-required', severity: 'error' },
        ],
        warnings: 0,
      },
      query: {
        answer: 'answer',
        pageIds: ['concepts/alpha'],
        refs: [{ kind: 'page', pageId: 'concepts/beta', slug: 'beta', title: 'Beta' }],
        selectedPages: ['beta'],
        warnings: [],
      },
      search: {
        pages: [{ body: 'body', slug: 'alpha\nunsafe', summary: 'summary', title: 'Alpha' }],
        refs: [
          {
            kind: 'page',
            pageId: 'concepts/alpha\nunsafe',
            slug: 'alpha\nunsafe',
            title: 'Alpha',
          },
        ],
        warnings: [],
      },
      status: { ...STATUS_RESULT, lastCompiledAt: 'not-a-timestamp' },
    };
    const backend: CompilerBackend = {
      run: (_root, request) => Promise.resolve(responses[request.capability]),
    };
    const { compiler } = await createFixture(backend);
    const requests: readonly CompilerRequest[] = [
      { capability: 'context', projectId: 'alpha', prompt: 'context' },
      { capability: 'eval-full', projectId: 'alpha' },
      { capability: 'lint', projectId: 'alpha' },
      { capability: 'query', projectId: 'alpha', question: 'query' },
      { capability: 'search', projectId: 'alpha', question: 'search' },
      { capability: 'status', projectId: 'alpha' },
    ];
    for (const request of requests) {
      await expect(compiler.execute(request)).rejects.toMatchObject({
        code: 'COMPILER_CONTRACT_VIOLATION',
        ...(request.capability === 'query' ? { sideEffectsPossible: true } : {}),
      });
    }
  });

  it('treats resolved compile errors as failure with possible side effects', async () => {
    const backend: CompilerBackend = {
      run: () =>
        Promise.resolve({
          candidates: [],
          compiled: 0,
          concepts: [],
          deleted: 0,
          errors: ['raw source and provider detail'],
          pages: [],
          skipped: 0,
        }),
    };
    const { compiler } = await createFixture(backend);
    const error = await compiler
      .execute({ capability: 'compile', projectId: 'alpha' })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: 'COMPILER_FAILED',
      sideEffectsPossible: true,
    });
    expect(JSON.stringify(error)).not.toContain('raw source');
  });

  it('does not record a full evaluation with provider judgement errors as success', async () => {
    const backend: CompilerBackend = {
      run: () =>
        Promise.resolve({
          ...evalResult('full'),
          citationSupport: {
            judgeErrors: 1,
            judgements: [{ reason: 'raw provider failure' }],
            meanScore: 0,
          },
        }),
    };
    const { compiler } = await createFixture(backend);
    const error = await compiler
      .execute({ capability: 'eval-full', projectId: 'alpha' })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: 'COMPILER_FAILED',
      sideEffectsPossible: true,
    });
    expect(JSON.stringify(error)).not.toContain('raw provider failure');
  });

  it('does not record semantic context provider failures as success', async () => {
    let warningCode = 'query-embedding-unavailable';
    const backend: CompilerBackend = {
      run: () =>
        Promise.resolve({
          budget: { estimatedTokens: 1, requestedTokens: 100, truncated: false },
          gaps: [],
          primary: [],
          version: 1,
          warnings: [{ code: warningCode, message: 'raw provider detail' }],
        }),
    };
    const { compiler } = await createFixture(backend);
    await expect(
      compiler.execute({ capability: 'context', projectId: 'alpha', prompt: 'semantic context' }),
    ).rejects.toMatchObject({
      code: 'COMPILER_PROVIDER_UNAVAILABLE',
      sideEffectsPossible: false,
    });
    warningCode = 'semantic-retrieval-error';
    const error = await compiler
      .execute({ capability: 'context', projectId: 'alpha', prompt: 'semantic context' })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'COMPILER_FAILED', sideEffectsPossible: false });
    expect(JSON.stringify(error)).not.toContain('raw provider detail');
  });

  it('keeps normalization failures project-scoped and redacts unexpected exceptions', async () => {
    let response: unknown = {
      ...STATUS_RESULT,
      pendingChanges: [{ file: '../outside.md', status: 'new' }],
      pendingChangesCount: 1,
    };
    const backend: CompilerBackend = {
      run: () => Promise.resolve(response),
    };
    const { compiler } = await createFixture(backend);
    await expect(
      compiler.execute({ capability: 'status', projectId: 'alpha' }),
    ).rejects.toMatchObject({
      code: 'COMPILER_CONTRACT_VIOLATION',
      projectId: 'alpha',
      sideEffectsPossible: false,
    });

    response = Object.defineProperty({}, 'errors', {
      get() {
        throw new Error('CREDENTIAL-SENTINEL SOURCE-SENTINEL /private/path');
      },
    });
    const error = await compiler
      .execute({ capability: 'compile', projectId: 'alpha' })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: 'COMPILER_CONTRACT_VIOLATION',
      projectId: 'alpha',
      sideEffectsPossible: true,
    });
    expect(JSON.stringify(error)).not.toMatch(/CREDENTIAL|SOURCE|\/private/u);
  });

  it('handles pre-start and post-start cancellation without racing the backend', async () => {
    let settle: ((value: unknown) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const backend: CompilerBackend = { run };
    const { compiler } = await createFixture(backend);
    const before = new AbortController();
    before.abort();
    await expect(
      compiler.execute({ capability: 'status', projectId: 'alpha' }, { signal: before.signal }),
    ).rejects.toMatchObject({ code: 'COMPILER_CANCELLED', sideEffectsPossible: false });
    expect(run).not.toHaveBeenCalled();

    const during = new AbortController();
    const pending = compiler.execute(
      { capability: 'status', projectId: 'alpha' },
      { signal: during.signal },
    );
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    during.abort();
    let completed = false;
    void pending.finally(() => {
      completed = true;
    }).catch(() => undefined);
    await Promise.resolve();
    expect(completed).toBe(false);
    settle?.(STATUS_RESULT);
    await expect(pending).rejects.toMatchObject({
      code: 'COMPILER_CANCELLED',
      sideEffectsPossible: true,
    });
  });

  it('serializes operations for the same project across adapter instances', async () => {
    const releases: Array<() => void> = [];
    const run = vi.fn(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(STATUS_RESULT));
        }),
    );
    const { compiler, knowledgeRoot } = await createFixture({ run });
    const secondCompiler = createProjectCompiler({ backend: { run }, knowledgeRoot });
    const first = compiler.execute({ capability: 'status', projectId: 'alpha' });
    const second = secondCompiler.execute({ capability: 'status', projectId: 'alpha' });

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    releases.shift()?.();
    await expect(first).resolves.toMatchObject({ projectId: 'alpha' });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await expect(second).resolves.toMatchObject({ projectId: 'alpha' });
  }, 15_000);

  it('releases the project queue after a failed operation', async () => {
    let calls = 0;
    const backend: CompilerBackend = {
      run: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new CompilerBackendError('failed'))
          : Promise.resolve(STATUS_RESULT);
      },
    };
    const { compiler } = await createFixture(backend);
    const first = compiler.execute({ capability: 'status', projectId: 'alpha' });
    const second = compiler.execute({ capability: 'status', projectId: 'alpha' });

    await expect(first).rejects.toMatchObject({ code: 'COMPILER_FAILED' });
    await expect(second).resolves.toMatchObject({ projectId: 'alpha' });
    expect(calls).toBe(2);
  });

  it('does not serialize independent project workspaces', async () => {
    let releaseAlpha: (() => void) | undefined;
    const run = vi.fn((_root: string, request: CompilerRequest) =>
      request.projectId === 'alpha'
        ? new Promise((resolve) => {
            releaseAlpha = () => resolve(STATUS_RESULT);
          })
        : Promise.resolve(STATUS_RESULT),
    );
    const { compiler, knowledgeRoot } = await createFixture({ run });
    await addProject(knowledgeRoot, {
      displayName: 'Beta',
      projectId: 'beta',
      sourceRepository: 'https://example.test/beta.git',
    });
    const alpha = compiler.execute({ capability: 'status', projectId: 'alpha' });
    const beta = compiler.execute({ capability: 'status', projectId: 'beta' });

    await expect(beta).resolves.toMatchObject({ projectId: 'beta' });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    expect(run).toHaveBeenCalledTimes(2);
    releaseAlpha?.();
    await expect(alpha).resolves.toMatchObject({ projectId: 'alpha' });
  });

  it('maps backend failures and never serializes their raw cause', async () => {
    const backend: CompilerBackend = {
      run: () => Promise.reject(new CompilerBackendError('provider-unavailable')),
    };
    const { compiler } = await createFixture(backend);
    const error = await compiler
      .execute({ capability: 'compile', projectId: 'alpha' })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CompilerOperationError);
    expect(error).toMatchObject({
      code: 'COMPILER_PROVIDER_UNAVAILABLE',
      sideEffectsPossible: false,
    });
    expect(JSON.stringify(error)).not.toContain('credential');
  });

  it('maps every backend failure kind without recording success', async () => {
    const expected = {
      busy: ['COMPILER_BUSY', false],
      failed: ['COMPILER_FAILED', true],
      'provider-unavailable': ['COMPILER_PROVIDER_UNAVAILABLE', false],
      'provider-unknown': ['COMPILER_PROVIDER_UNKNOWN', false],
      timeout: ['COMPILER_TIMEOUT', true],
    } as const;
    let kind: keyof typeof expected = 'busy';
    const backend: CompilerBackend = {
      run: () => Promise.reject(new CompilerBackendError(kind)),
    };
    const { compiler } = await createFixture(backend);
    for (const [failureKind, [code, sideEffectsPossible]] of Object.entries(expected)) {
      kind = failureKind as keyof typeof expected;
      await expect(
        compiler.execute({ capability: 'compile', projectId: 'alpha' }),
      ).rejects.toMatchObject({ code, sideEffectsPossible });
    }
  });

  it('redacts thrown backend and egress-authorizer details', async () => {
    const backend: CompilerBackend = {
      run: () => Promise.reject(new Error('CREDENTIAL-SENTINEL SOURCE-SENTINEL /private/path')),
    };
    const { compiler } = await createFixture(backend);
    const backendError = await compiler
      .execute({ capability: 'compile', projectId: 'alpha' })
      .catch((reason: unknown) => reason);
    expect(JSON.stringify(backendError)).not.toMatch(/CREDENTIAL|SOURCE|\/private/u);

    const run = vi.fn();
    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-capabilities-'));
    temporaryRoots.push(knowledgeRoot);
    await addProject(knowledgeRoot, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    const denied = createProjectCompiler({
      backend: { run },
      egressAuthorizer: {
        authorize: () => Promise.reject(new Error('CREDENTIAL-SENTINEL')),
      },
      knowledgeRoot,
    });
    const egressError = await denied
      .execute({ capability: 'compile', projectId: 'alpha' })
      .catch((reason: unknown) => reason);
    expect(egressError).toMatchObject({ code: 'COMPILER_EGRESS_DENIED' });
    expect(JSON.stringify(egressError)).not.toContain('CREDENTIAL-SENTINEL');
    expect(run).not.toHaveBeenCalled();
  });

  it('passes an immutable project-and-capability context to the egress decision', async () => {
    const backend: CompilerBackend = {
      run: () =>
        Promise.resolve({
          candidates: [],
          compiled: 0,
          concepts: [],
          deleted: 0,
          errors: [],
          pages: [],
          skipped: 0,
        }),
    };
    const decision = vi.fn((context: Readonly<{ capability: string; projectId: string }>) => {
      expect(Object.isFrozen(context)).toBe(true);
      expect(context).toEqual({ capability: 'compile', projectId: 'alpha' });
      return true;
    });
    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-capabilities-'));
    temporaryRoots.push(knowledgeRoot);
    await addProject(knowledgeRoot, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    const compiler = createProjectCompiler({
      backend,
      egressAuthorizer: createCompilerEgressAuthorizer(decision),
      knowledgeRoot,
    });
    await expect(
      compiler.execute({ capability: 'compile', projectId: 'alpha' }),
    ).resolves.toMatchObject({ outcome: 'unchanged' });
    expect(decision).toHaveBeenCalledOnce();
  });

  it('rejects invalid provider timeout configuration before backend invocation', async () => {
    const run = vi.fn();
    const backend: CompilerBackend = { run };
    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-capabilities-'));
    temporaryRoots.push(knowledgeRoot);
    await addProject(knowledgeRoot, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    const compiler = createProjectCompiler({
      backend,
      egressAuthorizer: createCompilerEgressAuthorizer(() => true),
      environment: { LLMWIKI_REQUEST_TIMEOUT_MS: '-1' },
      knowledgeRoot,
    });
    await expect(compiler.execute({ capability: 'compile', projectId: 'alpha' })).rejects.toMatchObject({
      code: 'COMPILER_CONFIG_INVALID',
    });
    expect(run).not.toHaveBeenCalled();
  });
});

function evalResult(suite: 'fast' | 'full'): Readonly<Record<string, unknown>> {
  return {
    citationCoverage: { coveragePercent: 75, precisionPercent: 80 },
    health: { score: 90 },
    stats: { pageCount: 2, sourceCount: 1 },
    suite,
    thresholdViolations: [],
  };
}
