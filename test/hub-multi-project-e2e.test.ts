import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProjectCompiler, type CompilerBackend } from '../src/compiler/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { bindLocalProject } from '../src/knowledge/local-project-registry.js';
import { addProject } from '../src/knowledge/workspace.js';
import {
  createProjectSyncService,
  SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION,
} from '../src/projector/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const temporaryRoots: string[] = [];
const projects = [
  { checkout: 'a', marker: 'ALPHA-ONLY-SENTINEL', projectId: 'alpha' },
  { checkout: 'b', marker: 'BETA-ONLY-SENTINEL', projectId: 'beta' },
  { checkout: 'c', marker: 'GAMMA-ONLY-SENTINEL', projectId: 'gamma' },
] as const;

interface HubFixture {
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly root: string;
  readonly sourceRoots: Readonly<Record<string, string>>;
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`Git fixture command failed: ${stderr}`, { cause: error }));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function configureIdentity(repository: string): Promise<void> {
  await git(repository, ['config', 'user.name', 'BuildLore Test']);
  await git(repository, ['config', 'user.email', 'buildlore@example.invalid']);
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

async function createFixture(): Promise<HubFixture> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-hub-multi-project-'));
  temporaryRoots.push(root);
  const hubRoot = join(root, 'd');
  const knowledgeRoot = join(hubRoot, 'knowledge');
  await mkdir(knowledgeRoot, { recursive: true });
  const sourceRoots: Record<string, string> = {};

  for (const project of projects) {
    const sourceRoot = join(root, project.checkout);
    const sourceRepository = `https://example.test/${project.projectId}.git`;
    sourceRoots[project.projectId] = sourceRoot;
    await mkdir(join(sourceRoot, '.buildlore'), { recursive: true });
    await mkdir(join(sourceRoot, 'docs'));
    await git(sourceRoot, ['init', '--initial-branch=main']);
    await configureIdentity(sourceRoot);
    await writeFile(
      join(sourceRoot, 'docs', `${project.projectId}.md`),
      `# ${project.projectId}\n\n${project.marker}\n`,
      'utf8',
    );
    await writeFile(
      join(sourceRoot, '.buildlore', 'sources.json'),
      serializeCanonicalJson({
        projectId: project.projectId,
        schemaVersion: SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION,
        sourceRepository,
        sources: [{
          documentKind: 'markdown',
          id: `${project.projectId}-docs`,
          path: 'docs',
          pathType: 'directory',
          recursive: true,
        }],
      }),
      'utf8',
    );
    await git(sourceRoot, ['add', '.']);
    await git(sourceRoot, ['commit', '-m', `seed ${project.projectId}`]);

    await addProject(knowledgeRoot, {
      displayName: project.projectId,
      projectId: project.projectId,
      sourceRepository,
    });
    await bindLocalProject(hubRoot, {
      projectId: project.projectId,
      sourceRepository,
      sourceRoot,
    });
    await writeSecurityPolicy(knowledgeRoot, project.projectId, {
      capabilities: ['compile'],
    });
  }

  return { hubRoot, knowledgeRoot, root, sourceRoots };
}

async function collectedSource(knowledgeRoot: string, projectId: string): Promise<string> {
  const sourcesRoot = join(knowledgeRoot, 'projects', projectId, 'sources');
  const entries = await readdir(sourcesRoot);
  expect(entries).toHaveLength(1);
  const source = entries[0];
  if (source === undefined) throw new Error('Collected source fixture is missing.');
  return readFile(join(sourcesRoot, source), 'utf8');
}

function sourceRootFor(current: HubFixture, projectId: string): string {
  const sourceRoot = current.sourceRoots[projectId];
  if (sourceRoot === undefined) throw new Error('Source checkout fixture is missing.');
  return sourceRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('central hub multi-project end-to-end isolation', () => {
  it('syncs and compiles only the selected sibling project without publishing or changing peers', async () => {
    const current = await createFixture();
    const sync = createProjectSyncService();
    await sync.sync({ dryRun: false, hubRoot: current.hubRoot, projectId: 'beta' });
    await sync.sync({ dryRun: false, hubRoot: current.hubRoot, projectId: 'gamma' });

    await git(current.knowledgeRoot, ['init', '--initial-branch=main']);
    await configureIdentity(current.knowledgeRoot);
    await git(current.knowledgeRoot, ['add', '.']);
    await git(current.knowledgeRoot, ['commit', '-m', 'seed peer knowledge']);

    const peerBefore = {
      beta: await treeDigest(join(current.knowledgeRoot, 'projects', 'beta')),
      gamma: await treeDigest(join(current.knowledgeRoot, 'projects', 'gamma')),
    };
    const sourceStateBefore: Record<string, string> = {};
    for (const project of projects) {
      sourceStateBefore[project.projectId] = await git(
        sourceRootFor(current, project.projectId),
        ['status', '--porcelain=v2', '--untracked-files=all'],
      );
    }
    const knowledgeHeadBefore = await git(current.knowledgeRoot, ['rev-parse', 'HEAD']);
    const registryBefore = await readFile(
      join(current.hubRoot, '.buildlore', 'local-projects.json'),
      'utf8',
    );

    const dryRun = await sync.sync({
      dryRun: true,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    });
    expect(dryRun).toMatchObject({ appliedCount: 0, dryRun: true, projectId: 'alpha' });
    expect(await readdir(join(current.knowledgeRoot, 'projects', 'alpha', 'sources')))
      .toEqual([]);

    await expect(sync.sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    })).resolves.toMatchObject({ appliedCount: 1, projectId: 'alpha' });

    const compilerWorkspaces: string[] = [];
    const backend: CompilerBackend = {
      async run(workspaceRoot, request) {
        if (request.capability !== 'compile') throw new Error('Unexpected compiler capability.');
        compilerWorkspaces.push(workspaceRoot);
        const projectId = basename(workspaceRoot);
        const source = await collectedSource(current.knowledgeRoot, projectId);
        const expected = projects.find((project) => project.projectId === projectId);
        if (expected === undefined) throw new Error('Unexpected compiler workspace.');
        expect(source).toContain(expected.marker);
        for (const peer of projects.filter((project) => project.projectId !== projectId)) {
          expect(source).not.toContain(peer.marker);
        }
        await mkdir(join(workspaceRoot, 'wiki', 'concepts'), { recursive: true });
        await writeFile(
          join(workspaceRoot, 'wiki', 'concepts', `${projectId}.md`),
          `# ${projectId}\n\n${expected.marker}\n`,
          'utf8',
        );
        return {
          compiled: 1,
          concepts: [],
          deleted: 0,
          errors: [],
          pages: [projectId],
          skipped: 0,
        };
      },
    };
    const compiler = createProjectCompiler({
      backend,
      environment: {
        LLMWIKI_EMBEDDING_MODEL: 'fixture-embedding-model',
        LLMWIKI_MODEL: 'fixture-model',
        LLMWIKI_PROVIDER: 'openai',
        OPENAI_API_KEY: 'fixture-key-not-a-secret',
      },
      knowledgeRoot: current.knowledgeRoot,
    });
    await expect(compiler.execute({ capability: 'compile', projectId: 'alpha' }))
      .resolves.toMatchObject({ projectId: 'alpha', data: { compiled: 1 } });

    expect(compilerWorkspaces).toEqual([
      join(current.knowledgeRoot, 'projects', 'alpha'),
    ]);
    expect(await treeDigest(join(current.knowledgeRoot, 'projects', 'beta')))
      .toBe(peerBefore.beta);
    expect(await treeDigest(join(current.knowledgeRoot, 'projects', 'gamma')))
      .toBe(peerBefore.gamma);
    expect(await git(current.knowledgeRoot, ['rev-parse', 'HEAD'])).toBe(knowledgeHeadBefore);
    expect(await git(current.knowledgeRoot, ['diff', '--cached', '--name-only'])).toBe('');
    expect(await readFile(
      join(current.hubRoot, '.buildlore', 'local-projects.json'),
      'utf8',
    )).toBe(registryBefore);
    for (const project of projects) {
      expect(await git(sourceRootFor(current, project.projectId), [
        'status', '--porcelain=v2', '--untracked-files=all',
      ])).toBe(sourceStateBefore[project.projectId]);
    }

    const alphaWiki = await readFile(
      join(current.knowledgeRoot, 'projects', 'alpha', 'wiki', 'concepts', 'alpha.md'),
      'utf8',
    );
    expect(alphaWiki).toContain('ALPHA-ONLY-SENTINEL');
    expect(alphaWiki).not.toMatch(/BETA-ONLY-SENTINEL|GAMMA-ONLY-SENTINEL/u);

    for (const projectId of ['beta', 'gamma'] as const) {
      await compiler.execute({ capability: 'compile', projectId });
      const wiki = await readFile(
        join(current.knowledgeRoot, 'projects', projectId, 'wiki', 'concepts', `${projectId}.md`),
        'utf8',
      );
      const expected = projects.find((project) => project.projectId === projectId);
      expect(wiki).toContain(expected?.marker);
      for (const peer of projects.filter((project) => project.projectId !== projectId)) {
        expect(wiki).not.toContain(peer.marker);
      }
    }
  });
});
