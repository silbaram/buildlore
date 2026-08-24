import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { bindLocalProject } from '../src/knowledge/local-project-registry.js';
import { addProject } from '../src/knowledge/workspace.js';
import { runHubProjectSync } from '../src/projector/hub-sync.js';
import {
  createProjectSyncService,
  ProjectSyncError,
  type HubProjectSyncInput,
} from '../src/projector/sync.js';
import {
  SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION,
  type SourceDeclaration,
} from '../src/projector/source-manifest.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

interface Fixture {
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly root: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-hub-sync-'));
  temporaryRoots.push(root);
  const hubRoot = join(root, 'hub');
  const knowledgeRoot = join(hubRoot, 'knowledge');
  await mkdir(knowledgeRoot, { recursive: true });
  return { hubRoot, knowledgeRoot, root };
}

async function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await execFileAsync('git', [...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
  });
  return result.stdout;
}

async function registerProject(
  current: Fixture,
  projectId: string,
  files: Readonly<Record<string, string>>,
  declarations: readonly SourceDeclaration[] = [{
    documentKind: 'markdown',
    id: 'docs',
    path: 'docs',
    pathType: 'directory',
    recursive: true,
  }],
): Promise<string> {
  const sourceRoot = join(current.root, `${projectId}-source`);
  const repository = `https://example.test/${projectId}.git`;
  await mkdir(join(sourceRoot, '.buildlore'), { recursive: true });
  for (const [sourceRef, contents] of Object.entries(files)) {
    const path = join(sourceRoot, ...sourceRef.split('/'));
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
  }
  await writeFile(join(sourceRoot, '.buildlore/sources.json'), serializeCanonicalJson({
    projectId,
    schemaVersion: SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION,
    sourceRepository: repository,
    sources: declarations,
  }));
  await git(sourceRoot, ['init', '--initial-branch=main']);
  await git(sourceRoot, ['config', 'user.email', 'buildlore@example.test']);
  await git(sourceRoot, ['config', 'user.name', 'BuildLore Test']);
  await git(sourceRoot, ['add', '--', '.buildlore/sources.json', 'docs']);
  await git(sourceRoot, ['commit', '-m', 'seed selected sources'], {
    GIT_AUTHOR_DATE: '2026-08-24T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-08-24T00:00:00Z',
  });
  await addProject(current.knowledgeRoot, {
    displayName: projectId,
    projectId,
    sourceRepository: repository,
  });
  await bindLocalProject(current.hubRoot, {
    projectId,
    sourceRepository: repository,
    sourceRoot,
  });
  return sourceRoot;
}

function input(hubRoot: string, projectId = 'alpha', dryRun = false): HubProjectSyncInput {
  return { dryRun, hubRoot, projectId };
}

function failure() {
  return {
    fail(
      code: ConstructorParameters<typeof ProjectSyncError>[0],
      phase: ConstructorParameters<typeof ProjectSyncError>[1]['failedPhase'],
      options: {
        readonly cause?: unknown;
        readonly completedTargets?: readonly string[];
        readonly partial?: boolean;
        readonly recoveryAction?: 'inspect-plan' | 'retry-sync';
      } = {},
    ): never {
      throw new ProjectSyncError(code, {
        ...(options.cause === undefined ? {} : { cause: options.cause }),
        ...(options.completedTargets === undefined
          ? {}
          : { completedTargets: options.completedTargets }),
        failedPhase: phase,
        partial: options.partial ?? false,
        recoveryAction: options.recoveryAction ?? 'inspect-plan',
      });
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })));
});

describe('hub-bound project sync', () => {
  it('collects only selected project documents and retains undeclared knowledge', async () => {
    const current = await fixture();
    const sourceRoot = await registerProject(current, 'alpha', {
      'docs/guide.md': '# Alpha guide\n\nSelected knowledge.\n',
      'docs/reference.markdown': '# Reference\n\nStable details.\n',
    });
    const sourcesRoot = join(current.knowledgeRoot, 'projects/alpha/sources');
    const stalePath = join(sourcesRoot, 'undeclared-retained.md');
    await writeFile(stalePath, 'retain this prior collected output\n');
    const sourceStatusBefore = await git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
    const registryBefore = await readFile(
      join(current.hubRoot, '.buildlore/local-projects.json'),
      'utf8',
    );

    const result = await createProjectSyncService().sync(input(current.hubRoot));

    expect(result).toMatchObject({
      appliedCount: 2,
      dryRun: false,
      projectId: 'alpha',
      remainingCount: 0,
    });
    expect(result.collection?.counts.include).toBe(2);
    expect(result.execution.entries).toEqual([]);
    expect(result.writes.map((write) => write.sourceKind)).toEqual(['markdown', 'markdown']);
    expect(await readFile(stalePath, 'utf8')).toBe('retain this prior collected output\n');
    expect(await git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']))
      .toBe(sourceStatusBefore);
    expect(await readFile(join(current.hubRoot, '.buildlore/local-projects.json'), 'utf8'))
      .toBe(registryBefore);
    await expect(stat(join(current.knowledgeRoot, 'projects/alpha/wiki/index.md'))).rejects
      .toMatchObject({ code: 'ENOENT' });
  });

  it('returns a complete deterministic dry-run plan without knowledge or registry writes', async () => {
    const current = await fixture();
    await registerProject(current, 'alpha', {
      'docs/guide.md': '# Dry run\n\nPlan only.\n',
    });
    const sourcesRoot = join(current.knowledgeRoot, 'projects/alpha/sources');
    const beforeSources = await readdir(sourcesRoot);
    const registryPath = join(current.hubRoot, '.buildlore/local-projects.json');
    const registryBefore = await readFile(registryPath, 'utf8');

    const service = createProjectSyncService();
    const first = await service.sync(input(current.hubRoot, 'alpha', true));
    const second = await service.sync(input(current.hubRoot, 'alpha', true));

    expect(second).toEqual(first);
    expect(first).toMatchObject({ appliedCount: 0, dryRun: true, remainingCount: 1 });
    expect(first.writes).toEqual([]);
    expect(await readdir(sourcesRoot)).toEqual(beforeSources);
    expect(await readFile(registryPath, 'utf8')).toBe(registryBefore);
  });

  it('rejects a suspected secret before any selected output is committed', async () => {
    const current = await fixture();
    await registerProject(current, 'alpha', {
      'docs/clean.md': '# Clean\n\nSafe selected knowledge.\n',
      'docs/unsafe.md': '# Unsafe\n\nAPI_KEY=super-secret-value-1234567890\n',
    });
    const sourcesRoot = join(current.knowledgeRoot, 'projects/alpha/sources');

    await expect(createProjectSyncService().sync(input(current.hubRoot))).rejects.toMatchObject({
      code: 'SYNC_SANITIZATION_FAILED',
      completedTargets: [],
      failedPhase: 'sanitization',
    });
    expect(await readdir(sourcesRoot)).toEqual([]);
  });

  it('fails closed when a selected byte changes after planning', async () => {
    const current = await fixture();
    const sourceRoot = await registerProject(current, 'alpha', {
      'docs/guide.md': '# Drift\n\nOriginal bytes.\n',
    });
    const sourcesRoot = join(current.knowledgeRoot, 'projects/alpha/sources');

    await expect(runHubProjectSync(input(current.hubRoot), {
      failure: failure(),
      hooks: {
        afterPlan: async () => {
          await writeFile(join(sourceRoot, 'docs/guide.md'), '# Drift\n\nChanged bytes.\n');
        },
      },
    })).rejects.toMatchObject({
      code: 'SYNC_INPUT_DRIFT',
      completedTargets: [],
      failedPhase: 'drift',
    });
    expect(await readdir(sourcesRoot)).toEqual([]);
  });

  it('revalidates selected bytes after the final pre-write hook', async () => {
    const current = await fixture();
    const sourceRoot = await registerProject(current, 'alpha', {
      'docs/guide.md': '# Drift\n\nOriginal bytes.\n',
    });
    const sourcesRoot = join(current.knowledgeRoot, 'projects/alpha/sources');

    await expect(runHubProjectSync(input(current.hubRoot), {
      failure: failure(),
      hooks: {
        beforeFirstWrite: async () => {
          await writeFile(join(sourceRoot, 'docs/guide.md'), '# Drift\n\nChanged bytes.\n');
        },
      },
    })).rejects.toMatchObject({
      code: 'SYNC_INPUT_DRIFT',
      completedTargets: [],
      failedPhase: 'drift',
    });
    expect(await readdir(sourcesRoot)).toEqual([]);
  });

  it('rejects an incompatible target collision before replacing knowledge', async () => {
    const current = await fixture();
    await registerProject(current, 'alpha', {
      'docs/guide.md': '# Collision\n\nDo not replace foreign content.\n',
    });
    const sourcesRoot = join(current.knowledgeRoot, 'projects/alpha/sources');
    const plan = await createProjectSyncService().sync(input(current.hubRoot, 'alpha', true));
    const target = plan.collection?.entries[0]?.target;
    expect(target).toMatch(/^markdown--[a-f0-9]{64}\.md$/u);
    const collisionPath = join(sourcesRoot, target as string);
    await writeFile(collisionPath, 'incompatible target bytes\n');

    await expect(createProjectSyncService().sync(input(current.hubRoot))).rejects.toMatchObject({
      code: 'SYNC_TARGET_COLLISION',
      completedTargets: [],
      failedPhase: 'write',
    });
    expect(await readFile(collisionPath, 'utf8')).toBe('incompatible target bytes\n');
    expect(await readdir(sourcesRoot)).toEqual([target]);
  });

  it('does not read or write a sibling project while syncing the requested project', async () => {
    const current = await fixture();
    await registerProject(current, 'alpha', {
      'docs/guide.md': '# Alpha\n\nAlpha only.\n',
    });
    const betaRoot = await registerProject(current, 'beta', {
      'docs/unsafe.md': '# Beta\n\n-----BEGIN PRIVATE KEY-----\n',
    });
    const betaKnowledge = join(current.knowledgeRoot, 'projects/beta/sources/sentinel.md');
    await writeFile(betaKnowledge, 'beta knowledge remains unchanged\n');
    const betaStatus = await git(betaRoot, ['status', '--porcelain=v1', '--untracked-files=all']);

    await expect(createProjectSyncService().sync(input(current.hubRoot, 'alpha')))
      .resolves.toMatchObject({ appliedCount: 1, projectId: 'alpha' });
    expect(await readFile(betaKnowledge, 'utf8')).toBe('beta knowledge remains unchanged\n');
    expect(await git(betaRoot, ['status', '--porcelain=v1', '--untracked-files=all']))
      .toBe(betaStatus);
    expect((await readdir(join(current.knowledgeRoot, 'projects/beta/sources'))).sort())
      .toEqual(['sentinel.md']);
    await expect(stat(join(current.knowledgeRoot, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
