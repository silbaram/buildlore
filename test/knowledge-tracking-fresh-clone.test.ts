import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProjectCompiler, EMBEDDING_MARKER_FILENAME } from '../src/compiler/index.js';
import {
  assessSemanticCacheState,
  addProject,
  classifyTrackingPath,
  LLM_WIKI_COMPILER_INTEGRITY,
  type CompilerPackageIdentity,
} from '../src/knowledge/index.js';
import { createSourceDocument, renderSourceDocument } from '../src/projector/index.js';
import { createProjectRetrieval } from '../src/retrieval/index.js';
import { startFakeOpenAiServer, type FakeOpenAiServer } from './fixtures/fake-openai.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const roots: string[] = [];
const servers: FakeOpenAiServer[] = [];
const originalEnvironment = new Map<string, string | undefined>();
const packageIdentity: CompilerPackageIdentity = {
  exactVersion: '1.1.0',
  packageIntegrity: LLM_WIKI_COMPILER_INTEGRITY,
  upstreamPackage: 'llm-wiki-compiler',
};

function setEnvironment(name: string, value: string): void {
  if (!originalEnvironment.has(name)) originalEnvironment.set(name, process.env[name]);
  process.env[name] = value;
}

function restoreEnvironment(): void {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnvironment.clear();
}

async function writeSource(knowledgeRoot: string, revision: string, title: string): Promise<void> {
  const source = [
    'buildlore+p2a:',
    encodeURIComponent('https://example.test/alpha.git'),
    'alpha',
    revision,
    'product-spec',
    encodeURIComponent(`iterations/${revision}/gate-b-spec/spec.json`),
  ].join('/');
  const stableId = createHash('sha256').update(source).digest('hex');
  await writeFile(
    join(knowledgeRoot, 'projects', 'alpha', 'sources', `planning--${stableId}.md`),
    renderSourceDocument(createSourceDocument({
      body: 'The architecture decision keeps each project workspace isolated and reviewable.',
      ingestedAt: '2026-08-22T00:00:00.000Z',
      producer: 'p2a',
      projectId: 'alpha',
      source,
      sourceKind: 'planning',
      sourceRevision: `sha256:${createHash('sha256').update(revision).digest('hex')}`,
      sourceType: 'file',
      title,
    })),
    'utf8',
  );
}

async function createKnowledgeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const directory = relative === '' ? root : join(root, relative);
  const result: string[] = [];
  for (const item of (await readdir(directory, { withFileTypes: true }))
    .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const path = relative === '' ? item.name : `${relative}/${item.name}`;
    if (item.isDirectory()) result.push(...await listFiles(root, path));
    else if (item.isFile()) result.push(path);
    else throw new Error('Fresh-clone fixture contains an unsafe filesystem entry.');
  }
  return result;
}

async function copyDefaultTrackedSnapshot(sourceRoot: string, targetRoot: string): Promise<string[]> {
  const copied: string[] = [];
  for (const relativePath of await listFiles(sourceRoot)) {
    const result = classifyTrackingPath(relativePath, packageIdentity);
    if (!result.ok) throw new Error('Compiler output inventory is incomplete or ambiguous.');
    if (result.disposition === 'exclude') continue;
    const destination = join(targetRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(sourceRoot, relativePath), destination);
    copied.push(relativePath);
  }
  return copied;
}

afterEach(async () => {
  restoreEnvironment();
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  await Promise.all(roots.splice(0).map(async (root) => rm(root, {
    force: true,
    recursive: true,
  })));
});

describe('tracked-state fresh clone', () => {
  it('[V11-V-02][V11-P-02] continues incremental compile and regenerates ignored caches', async () => {
    const provider = await startFakeOpenAiServer();
    servers.push(provider);
    const runtimeCredential = ['fixture', 'runtime', 'value'].join('-');
    setEnvironment('LLMWIKI_PROVIDER', 'openai');
    setEnvironment('OPENAI_API_KEY', runtimeCredential);
    setEnvironment('OPENAI_BASE_URL', provider.baseUrl);
    setEnvironment('OPENAI_EMBEDDINGS_BASE_URL', provider.baseUrl);
    setEnvironment('LLMWIKI_MODEL', 'fixture-model');
    setEnvironment('LLMWIKI_EMBEDDING_MODEL', 'fixture-embedding-model');

    const original = await createKnowledgeRoot('buildlore-tracking-original-');
    await addProject(original, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    await writeSecurityPolicy(original, 'alpha');
    await writeSource(original, 'revision-one', 'Initial decision');
    const originalCompiler = createProjectCompiler({ knowledgeRoot: original });
    await expect(originalCompiler.execute({ capability: 'compile', projectId: 'alpha' }))
      .resolves.toMatchObject({ data: { compiled: 1 }, outcome: 'succeeded' });

    const clone = await createKnowledgeRoot('buildlore-tracking-clone-');
    const copied = await copyDefaultTrackedSnapshot(original, clone);
    expect(copied).toContain('projects/alpha/.llmwiki/state.json');
    expect(copied).toContain(
      `projects/alpha/.llmwiki/${EMBEDDING_MARKER_FILENAME}`,
    );
    expect(copied).not.toContain('projects/alpha/.llmwiki/embeddings.json');

    const cloneWorkspace = join(clone, 'projects', 'alpha');
    await expect(readFile(join(cloneWorkspace, '.llmwiki', 'state.json'), 'utf8'))
      .resolves.toContain('planning--');
    await expect(readFile(join(cloneWorkspace, '.llmwiki', 'embeddings.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(assessSemanticCacheState({
      embeddingsCachePresent: false,
      identityMarkerPresent: true,
    })).toBe('embedding-cache-missing');

    const beforeSearchCalls = provider.chatCalls + provider.embeddingCalls;
    await expect(createProjectRetrieval({ knowledgeRoot: clone }).search({
      mode: 'semantic',
      projectId: 'alpha',
      query: 'isolated architecture',
    })).resolves.toMatchObject({
      effectiveMode: 'lexical',
      fallback: { reasonCode: 'embedding-store-unavailable' },
      partial: true,
    });
    expect(provider.chatCalls + provider.embeddingCalls).toBe(beforeSearchCalls);

    await writeSource(clone, 'revision-two', 'Follow-up decision');
    const cloneCompiler = createProjectCompiler({ knowledgeRoot: clone });
    await expect(cloneCompiler.execute({ capability: 'compile', projectId: 'alpha' }))
      .resolves.toMatchObject({ data: { compiled: 1 }, outcome: 'succeeded' });
    await expect(readFile(join(cloneWorkspace, '.llmwiki', 'embeddings.json'), 'utf8'))
      .resolves.toContain('fixture-embedding-model');

    const cloneBytes = await Promise.all((await listFiles(clone)).map(async (path) =>
      readFile(join(clone, path), 'utf8')));
    const serializedClone = cloneBytes.join('\n');
    expect(serializedClone).not.toContain(runtimeCredential);
    expect(serializedClone).not.toContain(provider.baseUrl);
    expect(serializedClone).not.toContain(tmpdir());
  }, 30_000);
});
