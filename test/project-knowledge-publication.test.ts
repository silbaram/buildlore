import { cp, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeWorkflowFixture, submitWorkflowFixture, type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { createApprovedAuthorityFixture } from './helpers/hierarchical-authority-fixture.js';
import { createApprovedWikiProjectionStore, prepareApprovedWikiPublication, prepareCurrentApprovedWikiPublication, type CurrentApprovedWikiAuthority } from '../src/retrieval/approved-corpus-store.js';
import { createHierarchicalMarkdownPublication, type HierarchicalMarkdownPublicationTestHooks } from '../src/retrieval/hierarchical-markdown-publication.js';
import { createRepositoryWriterLease } from '../src/knowledge/repository-writer-lease.js';
import { readSecurityPolicy } from '../src/sanitizer/index.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { record } from '../src/knowledge/project-knowledge/guards.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())); });

async function bytes(directory: string): Promise<Readonly<Record<string, string>>> {
  return Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async (path) => [path, await readFile(join(directory, path), 'utf8')] as const)));
}

describe('project knowledge publication recovery', () => {
  it('preserves unowned files on first activation, including a collision after the initial check', async () => {
    const fixture = await createKnowledgeWorkflowFixture('generic-md-json');
    fixtures.push(fixture);
    const projectId = fixture.projectId;
    expect(await fixture.cli(['sync', '--project', projectId])).toMatchObject({ exitCode: 0 });
    const purpose = await fixture.json('purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
      projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
    const started = await fixture.cli(['compile', 'hierarchy', 'start', '--project', projectId, '--purpose', purpose]);
    const { approved } = await submitWorkflowFixture(fixture, started.data);
    const args = approved.data.activationArgs as string[];
    const inputPath = args[args.indexOf('--input') + 1];
    if (!inputPath) throw new Error('Missing fixture activation path.');
    const authority = record(JSON.parse(await readFile(join(fixture.hubRoot, inputPath), 'utf8')) as unknown).authority as CurrentApprovedWikiAuthority;
    await prepareCurrentApprovedWikiPublication(authority, projectId, fixture.knowledgeRoot);
    const namespace = join(fixture.knowledgeRoot, 'projects', projectId, 'wiki/buildlore-hierarchy');
    await mkdir(namespace, { recursive: true });
    const corpus = createApprovedWikiProjectionStore(fixture.knowledgeRoot);
    for (const name of ['overview.md', 'architecture.md', 'decisions.md', 'knowledge.json', 'evidence.json', 'manifest.json']) {
      const path = join(namespace, name);
      await writeFile(path, 'Synthetic user-maintained content.\n');
      expect((await fixture.cli(args)).exitCode).not.toBe(0);
      expect(await bytes(namespace)).toEqual({ [name]: 'Synthetic user-maintained content.\n' });
      expect(await corpus.status(projectId)).toMatchObject({ state: 'none' });
      await unlink(path);
    }
    let reached = false;
    const publisher = createHierarchicalMarkdownPublication({ knowledgeRoot: fixture.knowledgeRoot,
      lease: createRepositoryWriterLease(), hooks: { afterJournalWrite: async () => {
        reached = true;
        await writeFile(join(namespace, 'overview.md'), 'Synthetic concurrent user content.\n');
      } } });
    await expect(publisher.publish({ projectId, authority })).rejects.toMatchObject({ code: 'HIERARCHICAL_MARKDOWN_DRIFT' });
    expect(reached).toBe(true);
    expect(await bytes(namespace)).toEqual({ 'overview.md': 'Synthetic concurrent user content.\n' });
    expect(await corpus.status(projectId)).toMatchObject({ state: 'none' });
    await unlink(join(namespace, 'overview.md'));
    // An empty directory is safe; refusal must not poison a retry of the same approval.
    expect(await fixture.cli(args)).toMatchObject({ exitCode: 0 });
  }, 60_000);

  it('archives legacy authority once and restores all old bytes for each pre-commit failure', async () => {
    const fixture = await createKnowledgeWorkflowFixture('generic-md-json');
    fixtures.push(fixture);
    const projectId = fixture.projectId;
    const policy = await readSecurityPolicy(fixture.knowledgeRoot, projectId);
    const legacy = createApprovedAuthorityFixture(projectId, policy.digest);
    const lease = createRepositoryWriterLease();
    const publisher = createHierarchicalMarkdownPublication({ knowledgeRoot: fixture.knowledgeRoot, lease });
    await publisher.publish({ projectId, authority: legacy });
    expect(await fixture.cli(['sync', '--project', projectId])).toMatchObject({ exitCode: 0 });
    const purpose = await fixture.json('purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
      projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
    const started = await fixture.cli(['compile', 'hierarchy', 'start', '--project', projectId, '--purpose', purpose]);
    expect(started).toMatchObject({ exitCode: 0 });
    const { approved } = await submitWorkflowFixture(fixture, started.data);
    const args = approved.data.activationArgs as string[];
    const path = args[args.indexOf('--input') + 1];
    if (!path) throw new Error('Fixture activation input missing.');
    const authority = record(JSON.parse(await readFile(join(fixture.hubRoot, path), 'utf8')) as unknown).authority as CurrentApprovedWikiAuthority;
    await prepareCurrentApprovedWikiPublication(authority, projectId, fixture.knowledgeRoot);
    const namespace = join(fixture.knowledgeRoot, 'projects', projectId, 'wiki/buildlore-hierarchy');
    const before = await bytes(namespace);
    const corpus = createApprovedWikiProjectionStore(fixture.knowledgeRoot);
    for (const phase of ['beforeStageWrite', 'afterJournalWrite', 'afterPreviousGenerationMove', 'afterNewGenerationMove', 'beforeAuthorityCommit'] as const) {
      let reached = false;
      const hooks: HierarchicalMarkdownPublicationTestHooks = { [phase]: () => { reached = true; throw new Error('Injected fixture failure.'); } };
      await expect(createHierarchicalMarkdownPublication({ knowledgeRoot: fixture.knowledgeRoot, lease, hooks })
        .publish({ projectId, authority })).rejects.toThrow();
      expect(reached, `Fault seam ${phase} was actually reached.`).toBe(true);
      expect(await bytes(namespace)).toEqual(before);
      expect(await corpus.readAuthority(projectId)).toEqual(legacy);
    }
    const archiveRoot = join(fixture.knowledgeRoot, 'projects', projectId, '.llmwiki/buildlore-hierarchy/archives');
    const legacyDigest = prepareApprovedWikiPublication(legacy, projectId).authorityDigest;
    expect(await readdir(archiveRoot)).toEqual([`${legacyDigest.slice(7)}.json`]);
    const archivePath = join(archiveRoot, `${legacyDigest.slice(7)}.json`);
    const archivedBytes = await readFile(archivePath, 'utf8');
    expect(record(JSON.parse(archivedBytes) as unknown).authority).toEqual(legacy);
    expect(await fixture.cli(args)).toMatchObject({ exitCode: 0 });
    expect(await readFile(archivePath, 'utf8')).toEqual(archivedBytes);
    expect((await bytes(namespace))['overview.md']).toContain('accepted');
    const reader = createKnowledgeWikiReader(fixture.knowledgeRoot);
    expect(await reader.list(projectId, { limit: 1 })).toMatchObject({ total: 3 });
    const first = await reader.list(projectId, { limit: 1 });
    expect(await reader.list(projectId, { limit: 1, cursor: String(first?.cursor) })).toMatchObject({ total: 3 });
    const fresh = join(fixture.root, 'portable-knowledge');
    // Only portable project state: no authoring run, private key or machine-local hub binding.
    await cp(join(fixture.knowledgeRoot, 'projects'), join(fresh, 'projects'), { recursive: true });
    await cp(join(fixture.knowledgeRoot, 'manifest.json'), join(fresh, 'manifest.json'));
    expect(await createApprovedWikiProjectionStore(fresh).readAuthority(projectId)).toEqual(authority);
    expect(await createKnowledgeWikiReader(fresh).read(projectId, 'overview')).toEqual(await reader.read(projectId, 'overview'));
    await writeFile(join(namespace, 'overview.md'), '# Unreviewed direct edit\n');
    expect(await publisher.status(projectId)).toMatchObject({ state: 'drifted' });
    await expect(publisher.publish({ projectId, authority })).rejects.toThrow();
    expect(await readFile(join(namespace, 'overview.md'), 'utf8')).toBe('# Unreviewed direct edit\n');
  }, 60_000);
});
