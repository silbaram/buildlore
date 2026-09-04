import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createProjectSessionCompiler } from '../src/compiler/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  createProjectSyncService,
  createSourceManagement,
  initializeSingleProjectQuickstart,
  parseSourceCollectionManifestV2,
  parseSourceDocument,
} from '../src/projector/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { createProfileBindingV2 } from '../src/profile/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { cwd, env: { ...process.env, LC_ALL: 'C' } });
}

async function fixture(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-json-lifecycle-'));
  roots.push(root);
  const origin = join(root, 'knowledge.git');
  const seed = join(root, 'knowledge-seed');
  const sourceRoot = join(root, 'source');
  const hubRoot = join(root, 'hub');
  await git(root, ['init', '--bare', '--initial-branch=main', origin]);
  await git(root, ['-c', 'protocol.file.allow=always', 'clone', origin, seed]);
  await git(seed, ['config', 'user.name', 'BuildLore Test']);
  await git(seed, ['config', 'user.email', 'buildlore@example.invalid']);
  await writeFile(join(seed, 'README.md'), '# Knowledge\n');
  await git(seed, ['add', 'README.md']);
  await git(seed, ['commit', '-m', 'seed knowledge']);
  await git(seed, ['push', 'origin', 'main']);
  await Promise.all([mkdir(sourceRoot), mkdir(hubRoot)]);
  await git(sourceRoot, ['init', '--initial-branch=main']);
  await git(sourceRoot, ['config', 'user.name', 'BuildLore Test']);
  await git(sourceRoot, ['config', 'user.email', 'buildlore@example.invalid']);
  await mkdir(join(sourceRoot, 'docs'));
  await Promise.all(Object.entries(files).map(async ([name, body]) =>
    writeFile(join(sourceRoot, 'docs', name), body)));
  await git(sourceRoot, ['add', '.']);
  await git(sourceRoot, ['commit', '-m', 'seed source']);
  await initializeSingleProjectQuickstart(hubRoot, {
    branch: 'main',
    knowledgeRepository: '../knowledge.git',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
    sourceRoot,
  });
  await writeFile(
    join(hubRoot, 'knowledge/projects/alpha/profile-binding.json'),
    serializeCanonicalJson(createProfileBindingV2('general')),
  );
  await writeSecurityPolicy(join(hubRoot, 'knowledge'), 'alpha', { capabilities: ['compile'] });
  return { hubRoot, sourceRoot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('JSON source lifecycle', () => {
  it('syncs mixed JSON and Markdown through sanitization into a citable compile plan', async () => {
    const current = await fixture({
      'architecture.json': JSON.stringify({
        components: ['projector', 'sanitizer', 'compiler', 'retrieval'],
        purpose: 'Local-first project knowledge',
      }),
      'guide.md': '# Project guide\n\nLocal-first project knowledge.\n',
    });
    const sources = createSourceManagement({ hubRoot: current.hubRoot });
    await sources.add({
      id: 'architecture', kind: 'json', path: 'docs/architecture.json', projectId: 'alpha',
    });
    await sources.add({
      id: 'guide', kind: 'markdown', path: 'docs/guide.md', projectId: 'alpha',
    });
    const synchronized = await createProjectSyncService().sync({
      dryRun: false, hubRoot: current.hubRoot, projectId: 'alpha',
    });
    expect(synchronized.writes.map((write) => write.sourceKind).sort()).toEqual([
      'json', 'markdown',
    ]);
    const sourceDirectory = join(current.hubRoot, 'knowledge/projects/alpha/sources');
    const sourceFiles = (await readdir(sourceDirectory)).sort();
    const jsonFile = sourceFiles.find((name) => name.startsWith('json--'));
    expect(jsonFile).toBeDefined();
    const jsonDocument = parseSourceDocument(await readFile(join(sourceDirectory, jsonFile!), 'utf8'));
    expect(jsonDocument.schemaVersion).toBe('buildlore.source.v3');
    expect(jsonDocument.buildlore.jsonOrigins?.some((entry) =>
      entry.origin.jsonPointer === '/components/0')).toBe(true);

    const diff = await sources.diff('alpha');
    expect(diff.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceRef: 'docs/architecture.json', status: 'unchanged' }),
      expect.objectContaining({ sourceRef: 'docs/guide.md', status: 'unchanged' }),
    ]));

    const plan = await createProjectSessionCompiler({
      hubRoot: current.hubRoot,
      knowledgeRoot: join(current.hubRoot, 'knowledge'),
    }).plan({ projectId: 'alpha' });
    const jsonSource = plan.sources.find((source) => source.sourceKind === 'json');
    expect(jsonSource?.sanitizedBody).toContain('projector');
    const componentOrigin = jsonDocument.buildlore.jsonOrigins?.find((entry) =>
      entry.origin.jsonPointer === '/components/0');
    expect(jsonSource?.citationAnchors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        jsonPointer: '/components/0',
        originalFile: 'docs/architecture.json',
        originalRange: componentOrigin?.origin.range,
      }),
    ]));
  }, 30_000);

  it('blocks a secret in a profile-excluded raw JSON field before persistence', async () => {
    const secret = `AKIA${'A1B2C3D4E5F6G7H8'}`;
    const current = await fixture({
      'state.json': JSON.stringify({ public: 'safe', schema: 'state.v1', token: secret }),
    });
    const sources = createSourceManagement({ hubRoot: current.hubRoot });
    await sources.add({ id: 'state', kind: 'json', path: 'docs/state.json', projectId: 'alpha' });
    const manifestPath = join(current.sourceRoot, '.buildlore/sources.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      sources: Array<Record<string, unknown>>;
    };
    manifest.sources[0]!.metadata = {
      namespace: 'buildlore.json',
      schemaVersion: 'buildlore.json-metadata.v1',
      values: {
        profiles: [{
          exclude: ['/token'],
          id: 'safe-state',
          match: { equals: 'state.v1', pointer: '/schema' },
          schemaVersion: 'buildlore.json-extraction-profile.v1',
          sections: [{ pointer: '/public', title: 'Public' }],
        }],
        profileRequired: true,
      },
    };
    await writeFile(manifestPath, serializeCanonicalJson(parseSourceCollectionManifestV2(manifest)));
    const secretDiff = await sources.diff('alpha');
    expect(secretDiff.records.some((record) =>
      record.reasonCode === 'SOURCE_SECURITY_BLOCKED' &&
      record.sourceRef === 'docs/state.json' && record.status === 'blocked')).toBe(true);
    await expect(createProjectSyncService().sync({
      dryRun: false, hubRoot: current.hubRoot, projectId: 'alpha',
    })).rejects.toMatchObject({
      code: 'SYNC_SANITIZATION_FAILED', completedTargets: [], partial: false,
    });
    await expect(readdir(join(
      current.hubRoot, 'knowledge/projects/alpha/sources',
    ))).resolves.toEqual([]);
  }, 30_000);
});
