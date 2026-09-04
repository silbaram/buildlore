import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createProjectSessionCompiler } from '../src/compiler/index.js';
import { createSessionCompilePlanner } from '../src/compiler/session/source-planner.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { createBuiltInProfileBinding } from '../src/profile/index.js';
import {
  createProjectSyncService,
  createSourceManagement,
  initializeSingleProjectQuickstart,
  parseSourceCollectionManifestV2,
  parseSourceDocument,
  SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
} from '../src/projector/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

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

async function fixture(files: Readonly<Record<string, string>>): Promise<Readonly<{
  hubRoot: string;
  sourceRoot: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-general-adapter-'));
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
  await writeSecurityPolicy(join(hubRoot, 'knowledge'), 'alpha', {
    capabilities: ['compile'],
  });
  return { hubRoot, sourceRoot };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('generic source pipeline', () => {
  it('syncs Markdown, text, and code and creates a provider-free compile review plan', async () => {
    const current = await fixture({
      'guide.md': '# 범용 가이드\n\n로컬 지식 검색 안내입니다.\n',
      'notes.txt': 'Portable English retrieval notes.\n',
      'tool.ts': 'export function portableSearch(): string { return "local"; }\n',
    });
    const sources = createSourceManagement({ hubRoot: current.hubRoot });
    await sources.add({
      id: 'code',
      kind: 'code',
      path: 'docs/tool.ts',
      projectId: 'alpha',
    });
    await sources.add({
      id: 'markdown',
      kind: 'markdown',
      path: 'docs/guide.md',
      projectId: 'alpha',
    });
    await sources.add({
      id: 'text',
      kind: 'text',
      path: 'docs/notes.txt',
      projectId: 'alpha',
    });
    const manifestPath = join(current.sourceRoot, '.buildlore/sources.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      sources: Array<Record<string, unknown>>;
    };
    const markdownDeclaration = manifest.sources.find((entry) => entry.id === 'markdown');
    if (markdownDeclaration === undefined) throw new Error('markdown declaration is missing');
    markdownDeclaration.metadata = {
      namespace: 'buildlore.generic',
      schemaVersion: 'buildlore.generic-metadata.v1',
      values: {
        retrievalMeaning: {
          authority: 'canonical',
          evidenceKind: 'overview',
          iterationGroup: null,
          lifecycle: 'current',
          revisionOrdinal: 2,
          schemaVersion: SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
          supersededBySourceRefs: [],
          supersedesSourceRefs: [],
          topicGroup: 'project-overview',
        },
      },
    };
    await writeFile(
      manifestPath,
      serializeCanonicalJson(parseSourceCollectionManifestV2(manifest)),
    );
    const synchronized = await createProjectSyncService().sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    });
    expect(synchronized.writes.map((entry) => entry.sourceKind).sort()).toEqual([
      'code',
      'markdown',
      'text',
    ]);
    expect(synchronized.collection?.entries.map((entry) => entry.reasonCode).sort()).toEqual([
      'selected_code',
      'selected_markdown',
      'selected_text',
    ]);
    const workspace = join(current.hubRoot, 'knowledge/projects/alpha');
    const storedFiles = (await readdir(join(workspace, 'sources'))).sort();
    expect(storedFiles.map((name) => name.split('--')[0])).toEqual([
      'code',
      'markdown',
      'text',
    ]);
    const documents = await Promise.all(storedFiles.map(async (name) =>
      parseSourceDocument(await readFile(join(workspace, 'sources', name), 'utf8'))));
    expect(documents.every((document) => document.schemaVersion === 'buildlore.source.v2'))
      .toBe(true);
    expect(documents.map((document) => document.buildlore.descriptor?.kind).sort()).toEqual([
      'code',
      'markdown',
      'text',
    ]);

    const plan = await createProjectSessionCompiler({
      hubRoot: current.hubRoot,
      knowledgeRoot: join(current.hubRoot, 'knowledge'),
    }).plan({ projectId: 'alpha' });
    expect(plan.sources.map((source) => source.sourceKind).sort()).toEqual([
      'code',
      'markdown',
      'text',
    ]);
    const code = plan.sources.find((source) => source.sourceKind === 'code');
    const markdown = plan.sources.find((source) => source.sourceKind === 'markdown');
    expect(markdown?.retrievalMeaning).toEqual({
      meaning: {
        authority: 'canonical',
        evidenceKind: 'overview',
        iterationGroup: null,
        lifecycle: 'current',
        revisionOrdinal: 2,
        schemaVersion: SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
        supersededBySourceRefs: [],
        supersedesSourceRefs: [],
        topicGroup: 'project-overview',
      },
      origin: 'manifest',
    });
    expect(code?.retrievalMeaning?.meaning).toMatchObject({
      authority: 'unknown',
      evidenceKind: 'other',
      lifecycle: 'unknown',
    });
    expect(code?.retrievalMeaning?.origin).toBe('legacy-default');
    expect(code?.sanitizedBody).toContain('```typescript\n');
    expect(code?.citationAnchors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        originalFile: 'docs/tool.ts',
        originalLine: 1,
        quote: 'export function portableSearch(): string { return "local"; }',
      }),
    ]));
  }, 30_000);

  it('scans the original tail before canonical truncation and writes no source on a secret', async () => {
    const privateKeyTail = [
      '-----BEGIN PRIVATE KEY-----',
      'not-a-real-key-fixture',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const current = await fixture({
      'long.md': `# Long\n\n${'safe content '.repeat(9_000)}\n${privateKeyTail}\n`,
    });
    const sources = createSourceManagement({ hubRoot: current.hubRoot });
    await sources.add({
      id: 'long',
      kind: 'markdown',
      path: 'docs/long.md',
      projectId: 'alpha',
    });
    await expect(createProjectSyncService().sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({
      code: 'SYNC_SANITIZATION_FAILED',
      completedTargets: [],
      partial: false,
    });
    await expect(readdir(join(
      current.hubRoot,
      'knowledge/projects/alpha/sources',
    ))).resolves.toEqual([]);
  }, 30_000);

  it('rejects credential-shaped adapter metadata before diff or sync can persist it', async () => {
    const current = await fixture({ 'guide.md': '# Guide\n\nSafe body.\n' });
    const sources = createSourceManagement({ hubRoot: current.hubRoot });
    await sources.add({
      id: 'guide',
      kind: 'markdown',
      path: 'docs/guide.md',
      projectId: 'alpha',
    });
    const manifestPath = join(current.sourceRoot, '.buildlore/sources.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      sources: Array<Record<string, unknown>>;
    };
    const declaration = manifest.sources[0];
    if (declaration === undefined) throw new Error('source declaration fixture is missing');
    declaration.metadata = {
      namespace: 'buildlore.generic',
      schemaVersion: 'buildlore.generic-metadata.v1',
      values: { token: `sk-${'A1b2C3d4E5f6G7h8J9k0LmNo'}` },
    };
    await writeFile(
      manifestPath,
      serializeCanonicalJson(parseSourceCollectionManifestV2(manifest)),
    );

    await expect(sources.diff('alpha')).resolves.toMatchObject({
      records: [expect.objectContaining({ status: 'blocked' })],
    });
    await expect(createProjectSyncService().sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'SYNC_SANITIZATION_FAILED' });
    await expect(readdir(join(current.hubRoot, 'knowledge/projects/alpha/sources')))
      .resolves.toEqual([]);
  }, 30_000);

  it('fails sync and compilation when the persisted profile binding drifts', async () => {
    const current = await fixture({ 'guide.md': '# Guide\n\nSafe body.\n' });
    const bindingPath = join(
      current.hubRoot,
      'knowledge/projects/alpha/profile-binding.json',
    );
    await writeFile(
      bindingPath,
      serializeCanonicalJson(createBuiltInProfileBinding('development', 'ko')),
    );

    await expect(createProjectSyncService().sync({
      dryRun: true,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'SYNC_BINDING_FAILED' });
    await expect(createProjectSessionCompiler({
      hubRoot: current.hubRoot,
      knowledgeRoot: join(current.hubRoot, 'knowledge'),
    }).plan({ projectId: 'alpha' })).rejects.toMatchObject({ code: 'SESSION_PLAN_DENIED' });
  }, 30_000);

  it('does not let the compile planner infer the P2A adapter for a general project', async () => {
    const current = await fixture({ 'guide.md': '# Guide\n\nSafe body.\n' });
    await mkdir(join(current.sourceRoot, '.plan2agent'));
    await writeFile(join(current.sourceRoot, '.plan2agent/current-spec.json'), '{}\n');
    await writeFile(
      join(current.sourceRoot, '.buildlore/sources.json'),
      serializeCanonicalJson(parseSourceCollectionManifestV2({
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
      })),
    );
    const phases: string[] = [];
    const planner = createSessionCompilePlanner({
      hubRoot: current.hubRoot,
      knowledgeRoot: join(current.hubRoot, 'knowledge'),
      onPhase: (phase) => phases.push(phase),
    });

    await expect(planner.create('alpha')).rejects.toMatchObject({
      code: 'SESSION_PLAN_DENIED',
    });
    expect(phases).toEqual(['project-resolved', 'binding-resolved']);
  }, 30_000);
});
