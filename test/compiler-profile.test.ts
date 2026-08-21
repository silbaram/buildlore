import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProjectCompiler,
  type CompilerBackend,
} from '../src/compiler/index.js';
import { addProject } from '../src/knowledge/index.js';
import {
  createBuildLoreLifecycleProfile,
  createProjectLifecycleProfile,
  renderLifecycleProfile,
} from '../src/profile/index.js';

const temporaryRoots: string[] = [];
const STATUS_RESULT = {
  lastCompiledAt: null,
  orphanedCount: 0,
  orphanedPages: [],
  pages: { concepts: 0, queries: 0, total: 0 },
  pendingCandidates: 0,
  pendingChanges: [],
  pendingChangesCount: 0,
  sources: 0,
  staleCount: 0,
  stalePages: [],
  stateStatus: 'missing',
};

async function fixture(): Promise<Readonly<{
  knowledgeRoot: string;
  run: CompilerBackend['run'];
  workspace: string;
}>> {
  const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-profile-'));
  temporaryRoots.push(knowledgeRoot);
  await addProject(knowledgeRoot, {
    displayName: 'Alpha',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
  });
  const run = vi.fn<CompilerBackend['run']>(() => Promise.resolve(STATUS_RESULT));
  return { knowledgeRoot, run, workspace: join(knowledgeRoot, 'projects', 'alpha') };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('compiler lifecycle-profile preflight', () => {
  it('preserves default-profile behavior without generating profile files', async () => {
    const item = await fixture();
    const before = await readFile(join(item.workspace, 'project.json'), 'utf8');
    const compiler = createProjectCompiler({
      backend: { run: item.run },
      knowledgeRoot: item.knowledgeRoot,
    });
    await expect(compiler.execute({ capability: 'status', projectId: 'alpha' }))
      .resolves.toMatchObject({ capability: 'status', projectId: 'alpha' });
    expect(item.run).toHaveBeenCalledTimes(1);
    await expect(readFile(join(item.workspace, 'project.json'), 'utf8')).resolves.toBe(before);
    await expect(readFile(join(item.workspace, '.llmwiki', 'profile.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts only a fully applied custom binding before backend invocation', async () => {
    const item = await fixture();
    await writeFile(
      join(item.workspace, 'profile.json'),
      renderLifecycleProfile(createBuildLoreLifecycleProfile('ko')),
      'utf8',
    );
    const compiler = createProjectCompiler({
      backend: { run: item.run },
      knowledgeRoot: item.knowledgeRoot,
    });
    await expect(compiler.execute({ capability: 'status', projectId: 'alpha' }))
      .rejects.toMatchObject({ code: 'PROFILE_DRIFT' });
    expect(item.run).not.toHaveBeenCalled();

    const manager = createProjectLifecycleProfile({ knowledgeRoot: item.knowledgeRoot });
    await manager.apply(await manager.plan('alpha'));
    await expect(compiler.execute({ capability: 'status', projectId: 'alpha' }))
      .resolves.toMatchObject({ capability: 'status', projectId: 'alpha' });
    expect(item.run).toHaveBeenCalledTimes(1);
  });

  it('blocks source, materialized, and incomplete-apply drift before backend invocation', async () => {
    for (const drift of ['source', 'profile', 'config'] as const) {
      const item = await fixture();
      await writeFile(
        join(item.workspace, 'profile.json'),
        renderLifecycleProfile(createBuildLoreLifecycleProfile('en')),
        'utf8',
      );
      const manager = createProjectLifecycleProfile({ knowledgeRoot: item.knowledgeRoot });
      await manager.apply(await manager.plan('alpha'));
      if (drift === 'source') {
        await writeFile(
          join(item.workspace, 'profile.json'),
          renderLifecycleProfile(createBuildLoreLifecycleProfile('ko')),
          'utf8',
        );
      } else if (drift === 'profile') {
        await writeFile(join(item.workspace, '.llmwiki', 'profile.json'), '{}\n', 'utf8');
      } else {
        await unlink(join(item.workspace, '.llmwiki', 'config.json'));
      }
      const backend: CompilerBackend = { run: item.run };
      const compiler = createProjectCompiler({ backend, knowledgeRoot: item.knowledgeRoot });
      await expect(compiler.execute({ capability: 'status', projectId: 'alpha' }))
        .rejects.toMatchObject({ code: 'PROFILE_DRIFT' });
      expect(item.run).not.toHaveBeenCalled();
    }
  });
});
