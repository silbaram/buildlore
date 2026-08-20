import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProjectCompiler, type CompilerBackend } from '../src/compiler/index.js';
import { addProject } from '../src/knowledge/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('compiler project isolation', () => {
  it('never resolves or mutates a sibling project for a selected operation', async () => {
    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-isolation-'));
    temporaryRoots.push(knowledgeRoot);
    for (const projectId of ['alpha', 'beta']) {
      await addProject(knowledgeRoot, {
        displayName: projectId,
        projectId,
        sourceRepository: `https://example.test/${projectId}.git`,
      });
    }
    await writeSecurityPolicy(knowledgeRoot, 'alpha');
    const betaSentinel = join(knowledgeRoot, 'projects', 'beta', 'sources', 'decision--beta.md');
    await writeFile(betaSentinel, 'BETA-SOURCE-SENTINEL\n', 'utf8');
    const run = vi.fn((workspaceRoot: string) => {
      expect(workspaceRoot).toBe(join(knowledgeRoot, 'projects', 'alpha'));
      return Promise.resolve({
        pages: [],
        refs: [],
        warnings: [],
      });
    });
    const backend: CompilerBackend = { run };
    const compiler = createProjectCompiler({
      backend,
      knowledgeRoot,
    });

    await expect(
      compiler.execute({ capability: 'search', projectId: 'alpha', question: 'Find alpha.' }),
    ).resolves.toMatchObject({ projectId: 'alpha' });
    await expect(readFile(betaSentinel, 'utf8')).resolves.toBe('BETA-SOURCE-SENTINEL\n');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects an unregistered project before egress or backend invocation', async () => {
    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-isolation-'));
    temporaryRoots.push(knowledgeRoot);
    const run = vi.fn();
    const backend: CompilerBackend = { run };
    const compiler = createProjectCompiler({
      backend,
      knowledgeRoot,
    });
    await expect(
      compiler.execute({ capability: 'compile', projectId: 'missing' }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects an unsafe workspace entry before egress or backend invocation', async () => {
    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-isolation-'));
    temporaryRoots.push(knowledgeRoot);
    await addProject(knowledgeRoot, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    const outside = join(knowledgeRoot, 'outside');
    const sources = join(knowledgeRoot, 'projects', 'alpha', 'sources');
    await mkdir(outside);
    await rm(sources, { recursive: true });
    await symlink(outside, sources, 'dir');
    const run = vi.fn();
    const compiler = createProjectCompiler({
      backend: { run },
      knowledgeRoot,
    });

    await expect(
      compiler.execute({ capability: 'compile', projectId: 'alpha' }),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_KNOWLEDGE' });
    expect(run).not.toHaveBeenCalled();
  });
});
