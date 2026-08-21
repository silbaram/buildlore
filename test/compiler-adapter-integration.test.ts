import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createProjectCompiler,
  EMBEDDING_MARKER_FILENAME,
} from '../src/compiler/index.js';
import { addProject } from '../src/knowledge/index.js';
import { createSourceDocument, renderSourceDocument } from '../src/projector/index.js';
import { createProjectRetrieval } from '../src/retrieval/index.js';
import { startFakeOpenAiServer, type FakeOpenAiServer } from './fixtures/fake-openai.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const temporaryRoots: string[] = [];
const servers: FakeOpenAiServer[] = [];
const originalEnvironment = new Map<string, string | undefined>();
type ProviderEnvironmentName =
  | 'LLMWIKI_EMBEDDING_MODEL'
  | 'LLMWIKI_MODEL'
  | 'LLMWIKI_PROVIDER'
  | 'OPENAI_API_KEY'
  | 'OPENAI_BASE_URL'
  | 'OPENAI_EMBEDDINGS_BASE_URL';

function setEnvironment(name: ProviderEnvironmentName, value: string): void {
  if (!originalEnvironment.has(name)) {
    originalEnvironment.set(name, process.env[name]);
  }
  process.env[name] = value;
}

function restoreEnvironment(): void {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  originalEnvironment.clear();
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(directory: string, prefix = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      hash.update(relativePath);
      if (entry.isDirectory()) {
        await visit(path, relativePath);
      } else {
        hash.update(await readFile(path));
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

async function fileDigests(root: string): Promise<Readonly<Record<string, string>>> {
  const digests: Record<string, string> = {};
  async function visit(directory: string, prefix = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, relativePath);
      } else {
        digests[relativePath] = createHash('sha256').update(await readFile(path)).digest('hex');
      }
    }
  }
  await visit(root);
  return digests;
}

async function createProjectSource(
  knowledgeRoot: string,
  projectId: 'alpha' | 'beta',
): Promise<void> {
  await addProject(knowledgeRoot, {
    displayName: projectId,
    projectId,
    sourceRepository: `https://example.test/${projectId}.git`,
  });
  await writeSecurityPolicy(knowledgeRoot, projectId);
  const marker = projectId === 'alpha' ? 'ALPHA-MARKER' : 'BETA-MARKER';
  const source = [
    'buildlore+p2a:',
    encodeURIComponent(`https://example.test/${projectId}.git`),
    projectId,
    'v1-compiler-fixture',
    'product-spec',
    encodeURIComponent('iterations/v1-compiler-fixture/gate-b-spec/spec.json'),
  ].join('/');
  const target = `planning--${createHash('sha256').update(source).digest('hex')}.md`;
  await writeFile(
    join(knowledgeRoot, 'projects', projectId, 'sources', target),
    renderSourceDocument(createSourceDocument({
      body: `${marker} says each BuildLore project compiles an isolated Shared Topic page.`,
      ingestedAt: '2026-08-19T00:00:00.000Z',
      producer: 'p2a',
      projectId,
      source,
      sourceKind: 'planning',
      sourceRevision: `sha256:${createHash('sha256').update(`${projectId}-source`).digest('hex')}`,
      sourceType: 'file',
      title: 'Shared decision',
    })),
    'utf8',
  );
}

afterEach(async () => {
  restoreEnvironment();
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('llm-wiki-compiler offline SDK integration', () => {
  it('stages an explicit review compile without writing the live wiki', async () => {
    const provider = await startFakeOpenAiServer();
    servers.push(provider);
    setEnvironment('LLMWIKI_PROVIDER', 'openai');
    setEnvironment('OPENAI_API_KEY', 'fixture-key-not-a-secret');
    setEnvironment('OPENAI_BASE_URL', provider.baseUrl);
    setEnvironment('OPENAI_EMBEDDINGS_BASE_URL', provider.baseUrl);
    setEnvironment('LLMWIKI_MODEL', 'fixture-model');
    setEnvironment('LLMWIKI_EMBEDDING_MODEL', 'fixture-embedding-model');

    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-review-'));
    temporaryRoots.push(knowledgeRoot);
    await createProjectSource(knowledgeRoot, 'alpha');
    const workspace = join(knowledgeRoot, 'projects', 'alpha');
    const wikiBefore = await treeDigest(join(workspace, 'wiki'));
    const compiler = createProjectCompiler({ knowledgeRoot });

    const result = await compiler.execute({
      capability: 'compile',
      projectId: 'alpha',
      review: true,
    });

    expect(result).toMatchObject({
      data: {
        candidateCount: 1,
        candidates: [{
          disposition: 'forced',
          reasons: ['manual-review-requested'],
          slug: 'shared-topic',
        }],
        compiled: 1,
      },
      projectId: 'alpha',
    });
    await expect(treeDigest(join(workspace, 'wiki'))).resolves.toBe(wikiBefore);
    const candidateFiles = await readdir(join(workspace, '.llmwiki', 'candidates'));
    expect(candidateFiles).toHaveLength(1);
    expect(candidateFiles[0]).toMatch(/^shared-topic-[a-f0-9]{8}\.json$/u);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/ALPHA-MARKER|fixture-key-not-a-secret/u);
  });

  it('[V9-V-13][V9-V-15][V9-V-19][V10-V-11] keeps markers and same-slug projects isolated and stable', async () => {
    const provider = await startFakeOpenAiServer();
    servers.push(provider);
    setEnvironment('LLMWIKI_PROVIDER', 'openai');
    setEnvironment('OPENAI_API_KEY', 'fixture-key-not-a-secret');
    setEnvironment('OPENAI_BASE_URL', provider.baseUrl);
    setEnvironment('OPENAI_EMBEDDINGS_BASE_URL', provider.baseUrl);
    setEnvironment('LLMWIKI_MODEL', 'fixture-model');
    setEnvironment('LLMWIKI_EMBEDDING_MODEL', 'fixture-embedding-model');

    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-integration-'));
    temporaryRoots.push(knowledgeRoot);
    await createProjectSource(knowledgeRoot, 'alpha');
    await createProjectSource(knowledgeRoot, 'beta');
    const compiler = createProjectCompiler({ knowledgeRoot });

    const alphaFirst = await compiler.execute({ capability: 'compile', projectId: 'alpha' });
    expect(alphaFirst).toMatchObject({
      data: { compiled: 1, pageIds: ['concepts/shared-topic'] },
      outcome: 'succeeded',
      projectId: 'alpha',
    });
    const embeddingMarkerPath = join(
      knowledgeRoot,
      'projects',
      'alpha',
      '.llmwiki',
      EMBEDDING_MARKER_FILENAME,
    );
    const embeddingMarkerBefore = await readFile(embeddingMarkerPath, 'utf8');
    expect(JSON.parse(embeddingMarkerBefore)).toMatchObject({
      embeddingIdentity: {
        compilerVersion: '1.1.0',
        modelId: 'fixture-embedding-model',
        providerId: 'openai',
      },
      projectId: 'alpha',
      schemaVersion: 'buildlore.embedding-index-identity.v1',
    });
    const callsAfterFirst = provider.chatCalls + provider.embeddingCalls;
    const lexical = createProjectRetrieval({ knowledgeRoot });
    const lexicalResult = await lexical.search({
      mode: 'lexical',
      projectId: 'alpha',
      query: 'shared topic',
    });
    expect(lexicalResult).toMatchObject({
      effectiveMode: 'lexical',
      hits: [{ pageId: 'concepts/shared-topic', score: 1 }],
      projectId: 'alpha',
    });
    expect(provider.chatCalls + provider.embeddingCalls).toBe(callsAfterFirst);
    expect(JSON.stringify(lexicalResult)).not.toMatch(/ALPHA-MARKER|BETA-MARKER/u);
    setEnvironment('OPENAI_API_KEY', '');
    const unconfigured = createProjectRetrieval({ knowledgeRoot });
    await expect(unconfigured.search({
      mode: 'semantic',
      projectId: 'alpha',
      query: 'shared topic',
    })).resolves.toMatchObject({
      effectiveMode: 'lexical',
      fallback: { reasonCode: 'provider-unconfigured' },
      partial: true,
    });
    expect(provider.chatCalls + provider.embeddingCalls).toBe(callsAfterFirst);
    setEnvironment('OPENAI_API_KEY', 'fixture-key-not-a-secret');
    const alphaWikiBefore = await readFile(
      join(knowledgeRoot, 'projects', 'alpha', 'wiki', 'concepts', 'shared-topic.md'),
      'utf8',
    );
    const alphaStateBefore = await readFile(
      join(knowledgeRoot, 'projects', 'alpha', '.llmwiki', 'state.json'),
      'utf8',
    );
    const alphaFilesBefore = await fileDigests(join(knowledgeRoot, 'projects', 'alpha'));
    const betaBefore = await treeDigest(join(knowledgeRoot, 'projects', 'beta'));

    const alphaSecond = await compiler.execute({ capability: 'compile', projectId: 'alpha' });
    expect(alphaSecond).toMatchObject({ data: { compiled: 0 }, outcome: 'unchanged' });
    expect(provider.chatCalls + provider.embeddingCalls).toBe(callsAfterFirst);
    await expect(readFile(embeddingMarkerPath, 'utf8')).resolves.toBe(embeddingMarkerBefore);
    await expect(
      readFile(join(knowledgeRoot, 'projects', 'alpha', 'wiki', 'concepts', 'shared-topic.md'), 'utf8'),
    ).resolves.toBe(alphaWikiBefore);
    await expect(
      readFile(join(knowledgeRoot, 'projects', 'alpha', '.llmwiki', 'state.json'), 'utf8'),
    ).resolves.toBe(alphaStateBefore);
    const alphaFilesAfter = await fileDigests(join(knowledgeRoot, 'projects', 'alpha'));
    const changedPaths = [...new Set([...Object.keys(alphaFilesBefore), ...Object.keys(alphaFilesAfter)])]
      .filter((path) => alphaFilesBefore[path] !== alphaFilesAfter[path])
      .sort();
    expect(changedPaths).toEqual(['wiki/index.md']);
    await expect(treeDigest(join(knowledgeRoot, 'projects', 'beta'))).resolves.toBe(betaBefore);
    const alphaBeforeSearch = await treeDigest(join(knowledgeRoot, 'projects', 'alpha'));

    const alphaSearch = await compiler.execute({
      capability: 'search',
      projectId: 'alpha',
      question: 'Find the shared topic.',
    });
    expect(alphaSearch).toMatchObject({
      data: { pages: [{ pageId: 'concepts/shared-topic' }] },
      projectId: 'alpha',
    });
    await expect(treeDigest(join(knowledgeRoot, 'projects', 'alpha'))).resolves.toBe(
      alphaBeforeSearch,
    );
    const alphaFilesBeforeQuery = await fileDigests(join(knowledgeRoot, 'projects', 'alpha'));
    const alphaQuery = await compiler.execute({
      capability: 'query',
      projectId: 'alpha',
      question: 'Explain the shared topic.',
    });
    expect(alphaQuery).toMatchObject({
      data: { pageIds: ['concepts/shared-topic'] },
      projectId: 'alpha',
    });
    const alphaFilesAfterQuery = await fileDigests(join(knowledgeRoot, 'projects', 'alpha'));
    const queryChangedPaths = [
      ...new Set([...Object.keys(alphaFilesBeforeQuery), ...Object.keys(alphaFilesAfterQuery)]),
    ]
      .filter((path) => alphaFilesBeforeQuery[path] !== alphaFilesAfterQuery[path])
      .sort();
    expect(queryChangedPaths).toEqual(['log.md']);
    const alphaBeforeLocalReads = await treeDigest(join(knowledgeRoot, 'projects', 'alpha'));
    const providerCallsBeforeLocalReads = provider.chatCalls + provider.embeddingCalls;
    const alphaStatus = await compiler.execute({ capability: 'status', projectId: 'alpha' });
    const alphaLint = await compiler.execute({ capability: 'lint', projectId: 'alpha' });
    const alphaFastEval = await compiler.execute({ capability: 'eval-fast', projectId: 'alpha' });
    const alphaContext = await compiler.execute({
      capability: 'context',
      projectId: 'alpha',
      prompt: 'Provide context for the shared topic.',
      topChunks: 0,
    });
    expect(provider.chatCalls + provider.embeddingCalls).toBe(providerCallsBeforeLocalReads);
    await expect(treeDigest(join(knowledgeRoot, 'projects', 'alpha'))).resolves.toBe(
      alphaBeforeLocalReads,
    );
    const alphaBeforeSemanticContext = await treeDigest(
      join(knowledgeRoot, 'projects', 'alpha'),
    );
    const providerCallsBeforeSemanticContext = provider.chatCalls + provider.embeddingCalls;
    const alphaSemanticContext = await compiler.execute({
      capability: 'context',
      projectId: 'alpha',
      prompt: 'Provide semantic context for the shared topic.',
    });
    await expect(treeDigest(join(knowledgeRoot, 'projects', 'alpha'))).resolves.toBe(
      alphaBeforeSemanticContext,
    );
    expect(provider.chatCalls + provider.embeddingCalls).toBeGreaterThan(
      providerCallsBeforeSemanticContext,
    );
    const alphaFullEval = await compiler.execute({ capability: 'eval-full', projectId: 'alpha' });
    expect(alphaStatus).toMatchObject({ capability: 'status', projectId: 'alpha' });
    expect(alphaLint).toMatchObject({ capability: 'lint', projectId: 'alpha' });
    expect(alphaFastEval).toMatchObject({
      capability: 'eval-fast',
      data: { suite: 'fast' },
      projectId: 'alpha',
    });
    expect(alphaFullEval).toMatchObject({
      capability: 'eval-full',
      data: { suite: 'full' },
      projectId: 'alpha',
    });
    expect(alphaContext).toMatchObject({ capability: 'context', projectId: 'alpha' });
    expect(alphaSemanticContext).toMatchObject({ capability: 'context', projectId: 'alpha' });
    const alphaResults = [
      alphaFirst,
      alphaSecond,
      alphaSearch,
      alphaQuery,
      alphaStatus,
      alphaLint,
      alphaFastEval,
      alphaFullEval,
      alphaContext,
      alphaSemanticContext,
    ];
    const serializedAlphaResults = JSON.stringify(alphaResults);
    expect(serializedAlphaResults).not.toContain('ALPHA-MARKER');
    expect(serializedAlphaResults).not.toContain('BETA-MARKER');
    expect(serializedAlphaResults).not.toContain(knowledgeRoot);
    expect(serializedAlphaResults).not.toContain('fixture-key-not-a-secret');
    expect(provider.chatBodies.every((body) => !body.includes('BETA-MARKER'))).toBe(true);
    expect(provider.embeddingBodies.every((body) => !body.includes('BETA-MARKER'))).toBe(true);
    const alphaLog = await readFile(join(knowledgeRoot, 'projects', 'alpha', 'log.md'), 'utf8');
    expect(alphaLog).not.toMatch(/ALPHA-MARKER|BETA-MARKER|fixture-key-not-a-secret/u);
    await expect(treeDigest(join(knowledgeRoot, 'projects', 'beta'))).resolves.toBe(betaBefore);

    const betaResult = await compiler.execute({ capability: 'compile', projectId: 'beta' });
    expect(betaResult).toMatchObject({
      data: { pageIds: ['concepts/shared-topic'] },
      outcome: 'succeeded',
      projectId: 'beta',
    });
    const [alphaWiki, betaWiki] = await Promise.all(
      ['alpha', 'beta'].map(async (projectId) =>
        readFile(
          join(knowledgeRoot, 'projects', projectId, 'wiki', 'concepts', 'shared-topic.md'),
          'utf8',
        ),
      ),
    );
    expect(alphaWiki).toContain('Shared Topic');
    expect(betaWiki).toContain('Shared Topic');
    expect(provider.chatBodies.some((body) => body.includes('ALPHA-MARKER'))).toBe(true);
    expect(provider.chatBodies.some((body) => body.includes('BETA-MARKER'))).toBe(true);
  });
});
