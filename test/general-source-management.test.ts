import { execFile } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { createSourceCollectionAdapter } from '../src/projector/collection-adapters.js';
import {
  createSourceManagement,
  createProjectSyncService,
  initializeSingleProjectQuickstart,
  parseSourceCollectionManifestV2,
  parseSourceDocument,
  renderSourceDocument,
  SourceManagementError,
} from '../src/projector/index.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], {
    cwd,
    env: { ...process.env, LC_ALL: 'C' },
  });
}

async function configureIdentity(repository: string): Promise<void> {
  await git(repository, ['config', 'user.name', 'BuildLore Test']);
  await git(repository, ['config', 'user.email', 'buildlore@example.invalid']);
}

async function fixture(): Promise<Readonly<{ hubRoot: string; sourceRoot: string }>> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-source-management-'));
  temporaryRoots.push(root);
  const origin = join(root, 'knowledge.git');
  const seed = join(root, 'knowledge-seed');
  const sourceRoot = join(root, 'source');
  const hubRoot = join(root, 'hub');
  await git(root, ['init', '--bare', '--initial-branch=main', origin]);
  await git(root, ['-c', 'protocol.file.allow=always', 'clone', origin, seed]);
  await configureIdentity(seed);
  await writeFile(join(seed, 'README.md'), '# Knowledge\n');
  await git(seed, ['add', 'README.md']);
  await git(seed, ['commit', '-m', 'seed knowledge']);
  await git(seed, ['push', 'origin', 'main']);
  await Promise.all([mkdir(sourceRoot), mkdir(hubRoot)]);
  await git(sourceRoot, ['init', '--initial-branch=main']);
  await configureIdentity(sourceRoot);
  await mkdir(join(sourceRoot, 'docs'));
  await Promise.all([
    writeFile(join(sourceRoot, 'docs/guide.md'), '# Guide\n\nPortable guide.\n'),
    writeFile(join(sourceRoot, 'docs/notes.txt'), 'Portable text notes.\n'),
    writeFile(join(sourceRoot, 'docs/tool.ts'), 'export const answer = 42;\n'),
    writeFile(join(sourceRoot, 'docs/other.md'), '# Other\n'),
  ]);
  await git(sourceRoot, ['add', '.']);
  await git(sourceRoot, ['commit', '-m', 'seed source']);
  await initializeSingleProjectQuickstart(hubRoot, {
    branch: 'main',
    knowledgeRepository: '../knowledge.git',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
    sourceRoot,
  });
  return { hubRoot, sourceRoot };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('general source management', () => {
  it('adds, lists, diffs, and normalizes generic sources deterministically', async () => {
    const current = await fixture();
    const service = createSourceManagement({ hubRoot: current.hubRoot });
    await expect(service.add({
      id: 'text',
      kind: 'text',
      path: 'docs/notes.txt',
      projectId: 'alpha',
    })).resolves.toMatchObject({ outcome: 'created' });
    await expect(service.add({
      id: 'code',
      kind: 'code',
      path: 'docs/tool.ts',
      projectId: 'alpha',
    })).resolves.toMatchObject({ outcome: 'created' });
    const markdown = await service.add({
      id: 'markdown',
      kind: 'markdown',
      path: 'docs/guide.md',
      projectId: 'alpha',
    });
    expect(markdown.declarations.map((entry) => entry.id)).toEqual([
      'code',
      'markdown',
      'text',
    ]);
    const bytes = await readFile(join(current.sourceRoot, '.buildlore/sources.json'), 'utf8');
    await expect(service.add({
      id: 'markdown',
      kind: 'markdown',
      path: 'docs/guide.md',
      projectId: 'alpha',
    })).resolves.toMatchObject({
      manifestDigest: markdown.manifestDigest,
      outcome: 'unchanged',
    });
    await expect(readFile(join(current.sourceRoot, '.buildlore/sources.json'), 'utf8'))
      .resolves.toBe(bytes);
    await expect(service.list('alpha')).resolves.toMatchObject({
      declarationCount: 3,
      manifestDigest: markdown.manifestDigest,
      manifestSchemaVersion: 'buildlore.sources.v2',
      projectId: 'alpha',
    });

    const beforeKnowledge = await readdir(join(current.hubRoot, 'knowledge'), { recursive: true });
    const diff = await service.diff('alpha');
    expect(diff.records.map((entry) => [entry.sourceRef, entry.status])).toEqual([
      ['docs/tool.ts', 'added'],
      ['docs/guide.md', 'added'],
      ['docs/notes.txt', 'added'],
    ]);
    expect(await readdir(join(current.hubRoot, 'knowledge'), { recursive: true }))
      .toEqual(beforeKnowledge);
    expect(await readFile(join(current.sourceRoot, '.buildlore/sources.json'), 'utf8')).toBe(bytes);

    await unlink(join(current.sourceRoot, 'docs/notes.txt'));
    const missing = await service.diff('alpha');
    expect(missing.records).toContainEqual(expect.objectContaining({
      declarationId: 'text',
      sourceRef: 'docs/notes.txt',
      status: 'missing',
    }));
  }, 30_000);

  it('[SHW-V-03][SHW-V-08] rejects protected source additions before downstream work', async () => {
    const current = await fixture();
    await mkdir(join(current.sourceRoot, 'docs/.llmwiki'));
    await writeFile(
      join(current.sourceRoot, 'docs/.llmwiki/generated.md'),
      '# Generated sentinel\n',
    );
    const manifestPath = join(current.sourceRoot, '.buildlore/sources.json');
    const manifestBefore = await readFile(manifestPath, 'utf8');
    const knowledgeBefore = (await readdir(join(current.hubRoot, 'knowledge'), {
      recursive: true,
    })).sort();
    const base = createSourceCollectionAdapter({ includeP2a: false });
    let collectionCalls = 0;
    const service = createSourceManagement({
      collectionAdapter: {
        collect(input) {
          collectionCalls += 1;
          return base.collect(input);
        },
      },
      hubRoot: current.hubRoot,
    });

    for (const [id, path] of [
      ['git-root', '.git'],
      ['git-segment', 'docs/.git/config.md'],
      ['local-root', '.buildlore'],
      ['local-file', '.buildlore/sources.json'],
      ['wiki-state-directory', 'docs/.llmwiki'],
      ['wiki-state-file', 'docs/.llmwiki/generated.md'],
      ['knowledge-root', 'knowledge'],
      ['projects-root', 'projects/alpha'],
      ['sources-root', 'sources/generated.md'],
      ['wiki-root', 'wiki/generated.md'],
      ['export-root', 'export/wiki.json'],
      ['exports-root', 'exports/wiki.json'],
    ] as const) {
      let failure: unknown;
      try {
        await service.add({ id, kind: 'markdown', path, projectId: 'alpha', recursive: true });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'SOURCE_MANIFEST_INVALID' });
      expect(String(failure)).not.toContain(current.sourceRoot);
    }

    expect(collectionCalls).toBe(0);
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(manifestBefore);
    expect((await readdir(join(current.hubRoot, 'knowledge'), { recursive: true })).sort())
      .toEqual(knowledgeBefore);
  }, 30_000);

  it('fails conflicts and lock contention without replacing canonical bytes', async () => {
    const current = await fixture();
    const service = createSourceManagement({ hubRoot: current.hubRoot });
    await service.add({
      id: 'docs',
      kind: 'markdown',
      path: 'docs/guide.md',
      projectId: 'alpha',
    });
    const path = join(current.sourceRoot, '.buildlore/sources.json');
    const before = await readFile(path, 'utf8');
    await expect(service.add({
      id: 'docs',
      kind: 'markdown',
      path: 'docs/other.md',
      projectId: 'alpha',
    })).rejects.toBeInstanceOf(SourceManagementError);
    expect(await readFile(path, 'utf8')).toBe(before);

    await writeFile(
      join(current.sourceRoot, '.buildlore/sources.json.lock'),
      'occupied\n',
    );
    await expect(service.add({
      id: 'other',
      kind: 'markdown',
      path: 'docs/other.md',
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'SOURCE_MANIFEST_BUSY' });
    expect(await readFile(path, 'utf8')).toBe(before);
  }, 30_000);

  it('does not remove a replacement lock or publish a manifest after lock ownership changes', async () => {
    const current = await fixture();
    const manifestPath = join(current.sourceRoot, '.buildlore/sources.json');
    const lockPath = join(current.sourceRoot, '.buildlore/sources.json.lock');
    const before = await readFile(manifestPath, 'utf8');
    const base = createSourceCollectionAdapter({ includeP2a: false });
    const service = createSourceManagement({
      collectionAdapter: {
        async collect(input) {
          await unlink(lockPath);
          await writeFile(lockPath, 'replacement lock\n');
          return base.collect(input);
        },
      },
      hubRoot: current.hubRoot,
    });

    await expect(service.add({
      id: 'docs',
      kind: 'markdown',
      path: 'docs/guide.md',
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'SOURCE_MANIFEST_WRITE_FAILED' });
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(before);
    await expect(readFile(lockPath, 'utf8')).resolves.toBe('replacement lock\n');
  }, 30_000);

  it('rechecks the selected source inventory before publishing a declaration', async () => {
    const current = await fixture();
    const manifestPath = join(current.sourceRoot, '.buildlore/sources.json');
    const before = await readFile(manifestPath, 'utf8');
    const base = createSourceCollectionAdapter({ includeP2a: false });
    const service = createSourceManagement({
      collectionAdapter: {
        async collect(input) {
          const result = await base.collect(input);
          await writeFile(join(current.sourceRoot, 'docs/guide.md'), '# Drifted\n');
          return result;
        },
      },
      hubRoot: current.hubRoot,
    });

    await expect(service.add({
      id: 'docs',
      kind: 'markdown',
      path: 'docs/guide.md',
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'SOURCE_MANIFEST_STALE' });
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(before);
  }, 30_000);

  it('rechecks the project profile binding before publishing a declaration', async () => {
    const current = await fixture();
    const manifestPath = join(current.sourceRoot, '.buildlore/sources.json');
    const before = await readFile(manifestPath, 'utf8');
    const base = createSourceCollectionAdapter({ includeP2a: false });
    const service = createSourceManagement({
      collectionAdapter: {
        async collect(input) {
          const result = await base.collect(input);
          await writeFile(
            join(current.hubRoot, 'knowledge/projects/alpha/profile-binding.json'),
            '{}\n',
          );
          return result;
        },
      },
      hubRoot: current.hubRoot,
    });

    await expect(service.add({
      id: 'docs',
      kind: 'markdown',
      path: 'docs/guide.md',
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'SOURCE_MANIFEST_STALE' });
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(before);
  }, 30_000);

  it('reports changed when canonical stored output drifts without a source revision change', async () => {
    const current = await fixture();
    const service = createSourceManagement({ hubRoot: current.hubRoot });
    await service.add({
      id: 'markdown',
      kind: 'markdown',
      path: 'docs/guide.md',
      projectId: 'alpha',
    });
    await createProjectSyncService().sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    });
    await expect(service.diff('alpha')).resolves.toMatchObject({
      records: [expect.objectContaining({ status: 'unchanged' })],
    });
    const sourcesRoot = join(current.hubRoot, 'knowledge/projects/alpha/sources');
    const target = (await readdir(sourcesRoot))[0];
    if (target === undefined) throw new Error('stored source fixture is missing');
    const path = join(sourcesRoot, target);
    const stored = parseSourceDocument(await readFile(path, 'utf8'));
    await writeFile(path, renderSourceDocument({ ...stored, title: `${stored.title} drifted` }));

    await expect(service.diff('alpha')).resolves.toMatchObject({
      records: [expect.objectContaining({ status: 'changed' })],
    });
  }, 30_000);

  it('blocks diff reads from hard-linked generated source targets', async () => {
    if (process.platform === 'win32') return;
    const current = await fixture();
    const service = createSourceManagement({ hubRoot: current.hubRoot });
    await service.add({
      id: 'markdown',
      kind: 'markdown',
      path: 'docs/guide.md',
      projectId: 'alpha',
    });
    await createProjectSyncService().sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    });
    const sourcesRoot = join(current.hubRoot, 'knowledge/projects/alpha/sources');
    const target = (await readdir(sourcesRoot))[0];
    if (target === undefined) throw new Error('stored source fixture is missing');
    await link(join(sourcesRoot, target), join(current.hubRoot, 'hardlink-sentinel.md'));

    await expect(service.diff('alpha')).resolves.toMatchObject({
      records: [expect.objectContaining({ status: 'blocked' })],
    });
  }, 30_000);

  it('rejects empty, NUL, and invalid UTF-8 files before changing the manifest', async () => {
    const current = await fixture();
    const manifestPath = join(current.sourceRoot, '.buildlore/sources.json');
    const before = await readFile(manifestPath, 'utf8');
    await Promise.all([
      writeFile(join(current.sourceRoot, 'docs/empty.txt'), ''),
      writeFile(join(current.sourceRoot, 'docs/nul.txt'), 'safe\0unsafe'),
      writeFile(join(current.sourceRoot, 'docs/invalid.txt'), Buffer.from([0xff, 0xfe, 0xfd])),
    ]);
    const service = createSourceManagement({ hubRoot: current.hubRoot });
    for (const [id, path] of [
      ['empty', 'docs/empty.txt'],
      ['nul', 'docs/nul.txt'],
      ['invalid', 'docs/invalid.txt'],
    ] as const) {
      await expect(service.add({ id, kind: 'text', path, projectId: 'alpha' })).rejects
        .toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });
      await expect(readFile(manifestPath, 'utf8')).resolves.toBe(before);
    }
  }, 30_000);

  it('reports a deleted file from a recursive declaration as missing', async () => {
    const current = await fixture();
    const service = createSourceManagement({ hubRoot: current.hubRoot });
    await service.add({
      id: 'docs',
      kind: 'markdown',
      path: 'docs',
      projectId: 'alpha',
      recursive: true,
    });
    await createProjectSyncService().sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    });
    await unlink(join(current.sourceRoot, 'docs/other.md'));

    const diff = await service.diff('alpha');
    expect(diff.records).toContainEqual({
      declarationId: 'docs',
      reasonCode: 'SOURCE_MISSING',
      sourceRef: 'docs/other.md',
      status: 'missing',
    });
    expect(diff.records).toContainEqual(expect.objectContaining({
      sourceRef: 'docs/guide.md',
      status: 'unchanged',
    }));
  }, 30_000);

  it('rejects declarations that are not enabled by the bound project profile', async () => {
    const current = await fixture();
    await mkdir(join(current.sourceRoot, '.plan2agent'));
    await writeFile(join(current.sourceRoot, '.plan2agent/current-spec.json'), '{}\n');
    const manifestPath = join(current.sourceRoot, '.buildlore/sources.json');
    const manifest = parseSourceCollectionManifestV2({
      projectId: 'alpha',
      schemaVersion: 'buildlore.sources.v2',
      sourceRepository: 'https://example.test/alpha.git',
      sources: [{
        adapterId: 'buildlore.p2a',
        adapterVersion: 1,
        id: 'planning',
        kind: 'planning',
        path: '.plan2agent/current-spec.json',
        pathType: 'file',
      }],
    });
    const before = serializeCanonicalJson(manifest);
    await writeFile(manifestPath, before);
    const service = createSourceManagement({ hubRoot: current.hubRoot });

    await expect(service.list('alpha')).rejects.toMatchObject({
      code: 'PROJECTION_ARTIFACT_INVALID',
    });
    await expect(service.add({
      id: 'other',
      kind: 'markdown',
      path: 'docs/other.md',
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(before);
  }, 30_000);
});
