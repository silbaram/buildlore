import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { addProject } from '../src/knowledge/index.js';
import type {
  RepositoryWriterLease,
  RepositoryWriterLeasePort,
} from '../src/knowledge/repository-writer-lease.js';
import {
  createProjectSecurityService,
  readSecurityPolicy,
  type ProjectSecurityService,
  type SanitizationReport,
} from '../src/sanitizer/index.js';
import {
  createApprovedWikiProjectionStore,
  createHierarchicalMarkdownPublication,
} from '../src/retrieval/index.js';
import { createApprovedAuthorityFixture } from './helpers/hierarchical-authority-fixture.js';

const PROJECT_ID = 'markdown-publication';
const roots: string[] = [];

const lease: RepositoryWriterLeasePort = Object.freeze({
  withLease<T>(
    _repositoryRoot: string,
    _operation: Parameters<RepositoryWriterLeasePort['withLease']>[1],
    action: (lease: RepositoryWriterLease) => Promise<T> | T,
  ): Promise<T> {
    return Promise.resolve(action(Object.freeze({
      repositoryIdentityDigest: 'test-repository',
      updatePhase: () => Promise.resolve(),
    })));
  },
});

async function fixture() {
  const hubRoot = await mkdtemp(join(process.cwd(), '.test-tmp-markdown-publication-'));
  roots.push(hubRoot);
  const knowledgeRoot = join(hubRoot, 'knowledge');
  await mkdir(knowledgeRoot);
  await addProject(knowledgeRoot, {
    displayName: PROJECT_ID,
    projectId: PROJECT_ID,
    sourceRepository: `https://example.test/${PROJECT_ID}.git`,
  });
  const policy = await readSecurityPolicy(knowledgeRoot, PROJECT_ID);
  const authority = createApprovedAuthorityFixture(PROJECT_ID, policy.digest);
  return { authority, knowledgeRoot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe('hierarchical Markdown compound publication', () => {
  it('publishes and repairs one complete deterministic tracked generation', async () => {
    const item = await fixture();
    const reports: SanitizationReport[] = [];
    const realSecurity = createProjectSecurityService({ knowledgeRoot: item.knowledgeRoot });
    const security: ProjectSecurityService = Object.freeze({
      async prepareSource(request: Parameters<ProjectSecurityService['prepareSource']>[0]) {
        const result = await realSecurity.prepareSource(request);
        reports.push(result.report);
        return result;
      },
    });
    const publisher = createHierarchicalMarkdownPublication({
      knowledgeRoot: item.knowledgeRoot,
      lease,
      security,
    });
    expect(await publisher.status(PROJECT_ID)).toMatchObject({ state: 'none' });
    const failure = await publisher.publish({ authority: item.authority, projectId: PROJECT_ID })
      .then(() => null, (error: unknown) => error);
    if (failure !== null) {
      throw new Error(JSON.stringify(reports.map((report) => ({
        decision: report.decision,
        summaries: report.summaries,
      }))));
    }

    const ready = await publisher.status(PROJECT_ID);
    expect(ready).toMatchObject({ fileCount: 3, pageCount: 2, state: 'ready' });
    const wikiRoot = join(
      item.knowledgeRoot,
      'projects',
      PROJECT_ID,
      'wiki',
      'buildlore-hierarchy',
    );
    const originalIndex = await readFile(join(wikiRoot, 'index.md'), 'utf8');
    const repeated = await publisher.publish({ authority: item.authority, projectId: PROJECT_ID });
    expect(repeated.materialization).toEqual(ready);
    expect(await readFile(join(wikiRoot, 'index.md'), 'utf8')).toBe(originalIndex);

    await writeFile(join(wikiRoot, 'index.md'), `${originalIndex}manual drift\n`, 'utf8');
    expect(await publisher.status(PROJECT_ID)).toMatchObject({ state: 'drifted' });
    await publisher.publish({ authority: item.authority, projectId: PROJECT_ID });
    expect(await publisher.status(PROJECT_ID)).toMatchObject({ state: 'ready' });
    expect(await readFile(join(wikiRoot, 'index.md'), 'utf8')).toBe(originalIndex);
  });

  it('refuses foreign collisions without mutating the approved authority', async () => {
    const item = await fixture();
    const publisher = createHierarchicalMarkdownPublication({
      knowledgeRoot: item.knowledgeRoot,
      lease,
    });
    await publisher.publish({ authority: item.authority, projectId: PROJECT_ID });
    const wikiRoot = join(
      item.knowledgeRoot,
      'projects',
      PROJECT_ID,
      'wiki',
      'buildlore-hierarchy',
    );
    await writeFile(join(wikiRoot, 'foreign.txt'), 'foreign\n', 'utf8');
    expect(await publisher.status(PROJECT_ID)).toMatchObject({ state: 'invalid' });
    await expect(publisher.publish({ authority: item.authority, projectId: PROJECT_ID }))
      .rejects.toMatchObject({ code: 'HIERARCHICAL_MARKDOWN_CONTRACT_INVALID' });
    expect(await readFile(join(wikiRoot, 'foreign.txt'), 'utf8')).toBe('foreign\n');
    await expect(createApprovedWikiProjectionStore(item.knowledgeRoot).readAuthority(PROJECT_ID))
      .resolves.toEqual(item.authority);
  });

  it('rolls back a pre-authority failure and treats authority commit as the commit point', async () => {
    const before = await fixture();
    const failing = createHierarchicalMarkdownPublication({
      hooks: { afterNewGenerationMove: () => { throw new Error('injected'); } },
      knowledgeRoot: before.knowledgeRoot,
      lease,
    });
    await expect(failing.publish({ authority: before.authority, projectId: PROJECT_ID }))
      .rejects.toMatchObject({ code: 'HIERARCHICAL_MARKDOWN_WRITE_FAILED' });
    await expect(createApprovedWikiProjectionStore(before.knowledgeRoot).status(PROJECT_ID))
      .resolves.toMatchObject({ state: 'none' });
    await expect(failing.status(PROJECT_ID)).resolves.toMatchObject({ state: 'none' });

    const after = await fixture();
    const committed = createHierarchicalMarkdownPublication({
      hooks: { afterAuthorityCommit: () => { throw new Error('injected'); } },
      knowledgeRoot: after.knowledgeRoot,
      lease,
    });
    await expect(committed.publish({ authority: after.authority, projectId: PROJECT_ID }))
      .resolves.toMatchObject({ materialization: { state: 'ready' } });
    await expect(committed.status(PROJECT_ID)).resolves.toMatchObject({ state: 'ready' });
  });

  it('rejects a Wiki parent inode replacement before moving the staged namespace', async () => {
    const item = await fixture();
    const publisher = createHierarchicalMarkdownPublication({
      knowledgeRoot: item.knowledgeRoot,
      lease,
    });
    await publisher.publish({ authority: item.authority, projectId: PROJECT_ID });
    const workspace = join(item.knowledgeRoot, 'projects', PROJECT_ID);
    const wikiRoot = join(workspace, 'wiki');
    const displacedWikiRoot = join(workspace, 'wiki-before-parent-swap');
    const replacementRoot = join(workspace, 'wiki-parent-replacement');
    const originalIndex = await readFile(
      join(wikiRoot, 'buildlore-hierarchy', 'index.md'),
      'utf8',
    );
    await mkdir(replacementRoot);
    let swapped = false;
    const guarded = createHierarchicalMarkdownPublication({
      hooks: {
        async afterJournalWrite() {
          await rename(wikiRoot, displacedWikiRoot);
          await symlink(replacementRoot, wikiRoot, 'dir');
          swapped = true;
        },
      },
      knowledgeRoot: item.knowledgeRoot,
      lease,
    });
    try {
      await expect(guarded.publish({ authority: item.authority, projectId: PROJECT_ID }))
        .rejects.toMatchObject({ code: 'HIERARCHICAL_MARKDOWN_WRITE_FAILED' });
      expect(await readdir(replacementRoot)).toEqual([]);
      expect(await readFile(
        join(displacedWikiRoot, 'buildlore-hierarchy', 'index.md'),
        'utf8',
      )).toBe(originalIndex);
    } finally {
      if (swapped) {
        await unlink(wikiRoot).catch(() => undefined);
        await rename(displacedWikiRoot, wikiRoot).catch(() => undefined);
      }
    }
    await expect(publisher.publish({ authority: item.authority, projectId: PROJECT_ID }))
      .resolves.toMatchObject({ materialization: { state: 'ready' } });
  });

  it('preserves a foreign file inserted after inspection instead of deleting it', async () => {
    const item = await fixture();
    const publisher = createHierarchicalMarkdownPublication({
      knowledgeRoot: item.knowledgeRoot,
      lease,
    });
    await publisher.publish({ authority: item.authority, projectId: PROJECT_ID });
    const namespace = join(
      item.knowledgeRoot,
      'projects',
      PROJECT_ID,
      'wiki',
      'buildlore-hierarchy',
    );
    const foreignPath = join(namespace, 'foreign.txt');
    const guarded = createHierarchicalMarkdownPublication({
      hooks: { afterJournalWrite: () => writeFile(foreignPath, 'foreign\n', 'utf8') },
      knowledgeRoot: item.knowledgeRoot,
      lease,
    });

    await expect(guarded.publish({ authority: item.authority, projectId: PROJECT_ID }))
      .rejects.toMatchObject({ code: 'HIERARCHICAL_MARKDOWN_CONTRACT_INVALID' });
    expect(await readFile(foreignPath, 'utf8')).toBe('foreign\n');

    await unlink(foreignPath);
    await expect(publisher.publish({ authority: item.authority, projectId: PROJECT_ID }))
      .resolves.toMatchObject({ materialization: { state: 'ready' } });
  });

  it('preserves a foreign backup file across committed cleanup recovery', async () => {
    const item = await fixture();
    const publisher = createHierarchicalMarkdownPublication({
      knowledgeRoot: item.knowledgeRoot,
      lease,
    });
    await publisher.publish({ authority: item.authority, projectId: PROJECT_ID });
    const storeRoot = join(
      item.knowledgeRoot,
      'projects',
      PROJECT_ID,
      '.llmwiki',
      'buildlore-hierarchy',
    );
    let foreignBackupPath: string | undefined;
    const guarded = createHierarchicalMarkdownPublication({
      hooks: {
        async afterPreviousGenerationMove() {
          const backupName = (await readdir(storeRoot)).find((name) => name.endsWith('.bak'));
          if (backupName === undefined) throw new Error('backup generation is unavailable');
          foreignBackupPath = join(storeRoot, backupName, 'foreign.txt');
          await writeFile(foreignBackupPath, 'foreign\n', 'utf8');
        },
      },
      knowledgeRoot: item.knowledgeRoot,
      lease,
    });

    await expect(guarded.publish({ authority: item.authority, projectId: PROJECT_ID }))
      .resolves.toMatchObject({ materialization: { state: 'ready' } });
    if (foreignBackupPath === undefined) throw new Error('foreign backup path is unavailable');
    expect(await readFile(foreignBackupPath, 'utf8')).toBe('foreign\n');
    expect(await readdir(storeRoot)).toContain('materialization.journal');

    await unlink(foreignBackupPath);
    await expect(publisher.publish({ authority: item.authority, projectId: PROJECT_ID }))
      .resolves.toMatchObject({ materialization: { state: 'ready' } });
    expect((await readdir(storeRoot)).some((name) =>
      name === 'materialization.journal' || name.endsWith('.bak'))).toBe(false);
  });
});
