import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProjectCompiler,
  EMBEDDING_MARKER_FILENAME,
  resolveConfiguredEmbeddingIdentity,
  type CompilerBackend,
} from '../src/compiler/index.js';
import {
  createProjectEmbeddingIdentityStore,
  parseEmbeddingIdentity,
  type ProjectEmbeddingIdentityPort,
} from '../src/compiler/embedding-identity.js';
import { addProject } from '../src/knowledge/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const temporaryRoots: string[] = [];

function compileResult(): Readonly<Record<string, unknown>> {
  return {
    candidates: [],
    compiled: 0,
    concepts: [],
    deleted: 0,
    errors: [],
    pages: [],
    skipped: 0,
  };
}

async function fixture(): Promise<{ readonly knowledgeRoot: string; readonly workspace: string }> {
  const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-embedding-identity-'));
  temporaryRoots.push(knowledgeRoot);
  await addProject(knowledgeRoot, {
    displayName: 'alpha',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
  });
  await writeSecurityPolicy(knowledgeRoot, 'alpha');
  return { knowledgeRoot, workspace: join(knowledgeRoot, 'projects', 'alpha') };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('project-confined embedding identity', () => {
  it('[V9-V-14][V10-V-05] maps supported providers to safe actual identities', () => {
    expect(resolveConfiguredEmbeddingIdentity({ LLMWIKI_PROVIDER: 'anthropic' })).toMatchObject({
      compilerVersion: '1.1.0',
      modelId: 'voyage-3-lite',
      providerId: 'voyage',
    });
    expect(resolveConfiguredEmbeddingIdentity({
      LLMWIKI_EMBEDDING_MODEL: 'custom-model',
      LLMWIKI_PROVIDER: 'openai',
    })).toMatchObject({ modelId: 'custom-model', providerId: 'openai' });
    expect(resolveConfiguredEmbeddingIdentity({ LLMWIKI_PROVIDER: 'ollama' })).toMatchObject({
      modelId: 'nomic-embed-text',
      providerId: 'ollama',
    });
    expect(resolveConfiguredEmbeddingIdentity({ LLMWIKI_PROVIDER: 'minimax' })).toBeNull();
  });

  it('[V9-V-23][V10-V-05] rejects the complete unsafe identity table without echo', () => {
    const unsafeModels = [
      'https://private.example/token',
      'C:/Users/private/model',
      '/home/person/model',
      '../private-model',
      'model name',
      'model\u0000name',
      '~private-model',
      'api-key-secret',
      `sk-proj-${'A'.repeat(24)}`,
      `ghp_${'A'.repeat(24)}`,
      `AKIA${'A'.repeat(16)}`,
      `xoxb-${'A'.repeat(24)}`,
      `model-${'x'.repeat(128)}`,
    ];
    for (const model of unsafeModels) {
      const identity = resolveConfiguredEmbeddingIdentity({
        LLMWIKI_EMBEDDING_MODEL: model,
        LLMWIKI_PROVIDER: 'openai',
      });
      expect(identity).toBeNull();
      expect(JSON.stringify(identity)).not.toContain(model);
    }
    expect(resolveConfiguredEmbeddingIdentity(
      { LLMWIKI_PROVIDER: 'ollama' },
      { modelRevision: 'https://private.example/revision' },
    )).toBeNull();
    expect(resolveConfiguredEmbeddingIdentity(
      { LLMWIKI_PROVIDER: 'ollama' },
      { dimensions: 65_537 },
    )).toBeNull();
    expect(resolveConfiguredEmbeddingIdentity(
      { LLMWIKI_PROVIDER: 'ollama' },
      { dimensions: 0 },
    )).toBeNull();
    expect(resolveConfiguredEmbeddingIdentity(
      { LLMWIKI_PROVIDER: 'ollama' },
      { modelRevision: 'secret-token' },
    )).toBeNull();
    expect(parseEmbeddingIdentity({
      compatibilityDigest: `sha256:${'0'.repeat(64)}`,
      compilerVersion: '1.1.0',
      modelId: 'C:/Users/private/model',
      providerId: 'openai',
    })).toBeNull();
  });

  it('[V9-V-13][V9-V-14][V9-V-15][V10-V-06] records stable canonical markers and compatibility states', async () => {
    const item = await fixture();
    const store = createProjectEmbeddingIdentityStore(item.knowledgeRoot);
    const identity = resolveConfiguredEmbeddingIdentity({
      LLMWIKI_EMBEDDING_MODEL: 'model-a',
      LLMWIKI_PROVIDER: 'openai',
    });
    if (identity === null) throw new Error('Expected a supported fixture identity.');

    await expect(store.inspect('alpha', identity)).resolves.toMatchObject({
      reasonCode: 'embedding-marker-missing',
      rebuildRequired: true,
      state: 'missing',
    });
    await store.record('alpha', identity);
    const markerPath = join(item.workspace, '.llmwiki', EMBEDDING_MARKER_FILENAME);
    const bytes = await readFile(markerPath, 'utf8');
    expect(bytes.endsWith('\n')).toBe(true);
    expect(bytes.endsWith('\n\n')).toBe(false);
    expect(Object.keys(JSON.parse(bytes) as object).sort()).toEqual([
      'embeddingIdentity', 'projectId', 'schemaVersion',
    ]);
    await expect(store.inspect('alpha', identity)).resolves.toMatchObject({
      reasonCode: null,
      rebuildRequired: false,
      state: 'compatible',
    });
    await store.record('alpha', identity);
    await expect(readFile(markerPath, 'utf8')).resolves.toBe(bytes);

    const changed = resolveConfiguredEmbeddingIdentity({
      LLMWIKI_EMBEDDING_MODEL: 'model-b',
      LLMWIKI_PROVIDER: 'openai',
    });
    if (changed === null) throw new Error('Expected a supported fixture identity.');
    await expect(store.inspect('alpha', changed)).resolves.toMatchObject({
      reasonCode: 'embedding-identity-mismatch',
      rebuildRequired: true,
      state: 'outdated',
    });
    const driftedIdentities = [
      resolveConfiguredEmbeddingIdentity({ LLMWIKI_PROVIDER: 'ollama' }),
      resolveConfiguredEmbeddingIdentity(
        { LLMWIKI_EMBEDDING_MODEL: 'model-a', LLMWIKI_PROVIDER: 'openai' },
        { modelRevision: 'revision-b' },
      ),
      resolveConfiguredEmbeddingIdentity(
        { LLMWIKI_EMBEDDING_MODEL: 'model-a', LLMWIKI_PROVIDER: 'openai' },
        { dimensions: 1_536 },
      ),
    ];
    for (const drifted of driftedIdentities) {
      if (drifted === null) throw new Error('Expected a supported drift identity.');
      await expect(store.inspect('alpha', drifted)).resolves.toMatchObject({
        reasonCode: 'embedding-identity-mismatch',
        rebuildRequired: true,
        state: 'outdated',
      });
    }
  });

  it('[V9-V-16][V10-V-06] treats malformed markers as outdated and symlinks as unsafe', async () => {
    const item = await fixture();
    const store = createProjectEmbeddingIdentityStore(item.knowledgeRoot);
    const identity = resolveConfiguredEmbeddingIdentity({ LLMWIKI_PROVIDER: 'ollama' });
    if (identity === null) throw new Error('Expected a supported fixture identity.');
    const markerPath = join(item.workspace, '.llmwiki', EMBEDDING_MARKER_FILENAME);
    await writeFile(markerPath, '{"unknown":true}\n', 'utf8');
    await expect(store.inspect('alpha', identity)).resolves.toMatchObject({
      reasonCode: 'embedding-marker-invalid',
      state: 'outdated',
    });
    await unlink(markerPath);
    await symlink(join(item.workspace, 'project.json'), markerPath);
    await expect(store.inspect('alpha', identity)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_KNOWLEDGE',
    });
  });

  it('[V9-V-16][V10-V-06] refuses noncanonical, duplicate, oversized, and foreign markers', async () => {
    const item = await fixture();
    const store = createProjectEmbeddingIdentityStore(item.knowledgeRoot);
    const identity = resolveConfiguredEmbeddingIdentity({ LLMWIKI_PROVIDER: 'ollama' });
    if (identity === null) throw new Error('Expected a supported fixture identity.');
    const markerPath = join(item.workspace, '.llmwiki', EMBEDDING_MARKER_FILENAME);

    await store.record('alpha', identity);
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    await writeFile(markerPath, JSON.stringify(marker), 'utf8');
    await expect(store.inspect('alpha', identity)).resolves.toMatchObject({
      reasonCode: 'embedding-marker-invalid',
      state: 'outdated',
    });

    await writeFile(markerPath, '{"projectId":"alpha","projectId":"alpha"}\n', 'utf8');
    await expect(store.inspect('alpha', identity)).resolves.toMatchObject({
      reasonCode: 'embedding-marker-invalid',
      state: 'outdated',
    });

    const embeddingIdentity = marker.embeddingIdentity as Record<string, unknown>;
    for (const invalidIdentity of [
      { ...embeddingIdentity, compatibilityDigest: `sha256:${'0'.repeat(64)}` },
      { ...embeddingIdentity, compilerVersion: '1.2.0' },
    ]) {
      await writeFile(markerPath, serializeCanonicalJson({
        ...marker,
        embeddingIdentity: invalidIdentity,
      }), 'utf8');
      await expect(store.inspect('alpha', identity)).resolves.toMatchObject({
        reasonCode: 'embedding-marker-invalid',
        state: 'outdated',
      });
    }

    await writeFile(markerPath, Buffer.alloc(64 * 1024 + 1, 0x20));
    await expect(store.inspect('alpha', identity)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_KNOWLEDGE',
    });

    await writeFile(markerPath, serializeCanonicalJson({ ...marker, projectId: 'beta' }), 'utf8');
    await expect(store.inspect('alpha', identity)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_KNOWLEDGE',
    });
  });

  it('[V10-V-06] refuses a compiler-state directory path swap before writing marker bytes', async () => {
    const item = await fixture();
    const directory = join(item.workspace, '.llmwiki');
    const movedDirectory = join(item.workspace, '.llmwiki-original');
    const outsideDirectory = join(item.knowledgeRoot, 'outside-state');
    await mkdir(outsideDirectory);
    const identity = resolveConfiguredEmbeddingIdentity({ LLMWIKI_PROVIDER: 'ollama' });
    if (identity === null) throw new Error('Expected a supported fixture identity.');
    const store = createProjectEmbeddingIdentityStore(item.knowledgeRoot, {
      writeHooks: {
        beforeWrite: async () => {
          await rename(directory, movedDirectory);
          await symlink(outsideDirectory, directory, 'dir');
        },
      },
    });

    await expect(store.record('alpha', identity)).rejects.toMatchObject({
      code: 'REGISTRY_WRITE_FAILED',
    });
    await expect(lstat(join(outsideDirectory, EMBEDDING_MARKER_FILENAME))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('[V9-V-13][V10-V-06] records only settled eligible compile identity', async () => {
    const item = await fixture();
    const environment: NodeJS.ProcessEnv = {
      LLMWIKI_EMBEDDING_MODEL: 'model-a',
      LLMWIKI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'fixture-value',
    };
    const record = vi.fn<ProjectEmbeddingIdentityPort['record']>(() => Promise.resolve());
    const inspect = vi.fn<ProjectEmbeddingIdentityPort['inspect']>();
    const identityPort: ProjectEmbeddingIdentityPort = { inspect, record };
    const backend: CompilerBackend = { run: () => Promise.resolve(compileResult()) };
    const compiler = createProjectCompiler({
      backend,
      embeddingIdentityPort: identityPort,
      environment,
      knowledgeRoot: item.knowledgeRoot,
    });

    await compiler.execute({ capability: 'compile', projectId: 'alpha', review: true });
    expect(record).not.toHaveBeenCalled();

    const failedCompiler = createProjectCompiler({
      backend: {
        run: () => Promise.resolve({ ...compileResult(), errors: ['fixture failure'] }),
      },
      embeddingIdentityPort: identityPort,
      environment,
      knowledgeRoot: item.knowledgeRoot,
    });
    await expect(failedCompiler.execute({ capability: 'compile', projectId: 'alpha' }))
      .rejects.toMatchObject({ code: 'COMPILER_FAILED' });
    expect(record).not.toHaveBeenCalled();

    await compiler.execute({ capability: 'compile', projectId: 'alpha' });
    expect(record).toHaveBeenCalledOnce();

    const driftingBackend: CompilerBackend = {
      run: () => {
        environment.LLMWIKI_EMBEDDING_MODEL = 'model-b';
        return Promise.resolve(compileResult());
      },
    };
    const drifting = createProjectCompiler({
      backend: driftingBackend,
      embeddingIdentityPort: identityPort,
      environment,
      knowledgeRoot: item.knowledgeRoot,
    });
    environment.LLMWIKI_EMBEDDING_MODEL = 'model-a';
    await expect(drifting.execute({ capability: 'compile', projectId: 'alpha' }))
      .rejects.toMatchObject({ code: 'COMPILER_FAILED', sideEffectsPossible: true });
    expect(record).toHaveBeenCalledOnce();

    const failingPort: ProjectEmbeddingIdentityPort = {
      inspect,
      record: () => Promise.reject(new Error('fixture write failure')),
    };
    environment.LLMWIKI_EMBEDDING_MODEL = 'model-a';
    const failedWrite = createProjectCompiler({
      backend,
      embeddingIdentityPort: failingPort,
      environment,
      knowledgeRoot: item.knowledgeRoot,
    });
    await expect(failedWrite.execute({ capability: 'compile', projectId: 'alpha' }))
      .rejects.toMatchObject({ code: 'COMPILER_FAILED', sideEffectsPossible: true });
    await expect(lstat(join(item.workspace, '.llmwiki'))).resolves.toBeDefined();
  });
});
