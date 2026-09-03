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
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { addProject } from '../src/knowledge/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
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
  verifyApprovedWikiAuthority,
  type ApprovedWikiAuthorityV1,
} from '../src/retrieval/index.js';
import {
  createApprovedAuthorityFixture,
  createSharedCitationApprovedAuthorityFixture,
} from './helpers/hierarchical-authority-fixture.js';

const PROJECT_ID = 'markdown-publication';
const HISTORICAL_PROJECT_ID = 'historical-authority';
const roots: string[] = [];

function digestValue(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(value), 'utf8')
    .digest('hex')}`;
}

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

async function fixture(projectId = PROJECT_ID) {
  const hubRoot = await mkdtemp(join(process.cwd(), '.test-tmp-markdown-publication-'));
  roots.push(hubRoot);
  const knowledgeRoot = join(hubRoot, 'knowledge');
  await mkdir(knowledgeRoot);
  await addProject(knowledgeRoot, {
    displayName: projectId,
    projectId,
    sourceRepository: `https://example.test/${projectId}.git`,
  });
  const policy = await readSecurityPolicy(knowledgeRoot, projectId);
  const authority = createApprovedAuthorityFixture(projectId, policy.digest);
  return { authority, knowledgeRoot };
}

async function historicalAuthorityFixture(): Promise<ApprovedWikiAuthorityV1> {
  const encoded = await readFile(join(
    process.cwd(),
    'test',
    'fixtures',
    'hierarchical-approved-authority-v22.json.gz.base64',
  ), 'utf8');
  return JSON.parse(gunzipSync(Buffer.from(encoded.trim(), 'base64')).toString('utf8')) as
    ApprovedWikiAuthorityV1;
}

async function installHistoricalAuthorityRecord(
  knowledgeRoot: string,
  authority: ApprovedWikiAuthorityV1,
): Promise<string> {
  const storeRoot = join(
    knowledgeRoot,
    'projects',
    HISTORICAL_PROJECT_ID,
    '.llmwiki',
    'buildlore-hierarchy',
  );
  await mkdir(storeRoot, { mode: 0o700, recursive: true });
  const authorityDigest = digestValue(authority);
  const basis = Object.freeze({
    authority,
    authorityDigest,
    projectId: HISTORICAL_PROJECT_ID,
    schemaVersion: 'buildlore.approved-wiki-authority-record.v1' as const,
  });
  const path = join(storeRoot, 'approved-authority.json');
  await writeFile(path, serializeCanonicalJson(Object.freeze({
    ...basis,
    recordDigest: digestValue(basis),
  })), { encoding: 'utf8', mode: 0o600 });
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe('hierarchical Markdown compound publication', () => {
  it('keeps stored v22 authority readable without allowing a new legacy activation', async () => {
    const item = await fixture(HISTORICAL_PROJECT_ID);
    const authority = await historicalAuthorityFixture();
    const publisher = createHierarchicalMarkdownPublication({
      knowledgeRoot: item.knowledgeRoot,
      lease,
    });
    expect(() => verifyApprovedWikiAuthority(authority, HISTORICAL_PROJECT_ID))
      .toThrowError('Approved hierarchical Wiki authority is invalid.');
    await expect(publisher.publish({ authority, projectId: HISTORICAL_PROJECT_ID }))
      .rejects.toMatchObject({ code: 'APPROVED_WIKI_PROJECTION_INVALID' });

    const authorityPath = await installHistoricalAuthorityRecord(item.knowledgeRoot, authority);
    const authorityBytes = await readFile(authorityPath, 'utf8');
    const store = createApprovedWikiProjectionStore(item.knowledgeRoot);
    await expect(store.readAuthority(HISTORICAL_PROJECT_ID)).resolves.toEqual(authority);
    const projection = await store.read(HISTORICAL_PROJECT_ID);
    expect(projection.projectId).toBe(HISTORICAL_PROJECT_ID);
    expect(projection.corpus.pages).toHaveLength(2);
    const publication = await publisher.publish({
      authority,
      projectId: HISTORICAL_PROJECT_ID,
    });
    expect(publication).toMatchObject({ materialization: { pageCount: 2, state: 'ready' } });
    expect(await readFile(authorityPath, 'utf8')).toBe(authorityBytes);

    const firstProposal = authority.finalization.proposals[0];
    if (firstProposal === undefined) throw new Error('historical proposal is unavailable');
    const altered = Object.freeze({
      ...authority,
      finalization: Object.freeze({
        ...authority.finalization,
        proposals: Object.freeze([
          Object.freeze({ ...firstProposal, summary: `${firstProposal.summary} altered` }),
          ...authority.finalization.proposals.slice(1),
        ]),
      }),
    }) as ApprovedWikiAuthorityV1;
    await expect(publisher.publish({ authority: altered, projectId: HISTORICAL_PROJECT_ID }))
      .rejects.toMatchObject({ code: 'APPROVED_WIKI_PROJECTION_INVALID' });
    expect(await readFile(authorityPath, 'utf8')).toBe(authorityBytes);
    await installHistoricalAuthorityRecord(item.knowledgeRoot, altered);
    await expect(store.read(HISTORICAL_PROJECT_ID))
      .rejects.toMatchObject({ code: 'APPROVED_WIKI_PROJECTION_INVALID' });

    const malformed = Object.freeze({
      ...authority,
      authorityCheck: null,
    }) as unknown as ApprovedWikiAuthorityV1;
    await installHistoricalAuthorityRecord(item.knowledgeRoot, malformed);
    await expect(store.read(HISTORICAL_PROJECT_ID))
      .rejects.toMatchObject({ code: 'APPROVED_WIKI_PROJECTION_INVALID' });
  });

  it('distinguishes an intact previous renderer and rematerializes the same authority',
    async () => {
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
      const manifestPath = join(namespace, 'manifest.json');
      const current = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      const legacyFiles = (current.files as Array<Record<string, unknown>>).map((file) => {
        const { citationMap: _citationMap, ...legacy } = file;
        void _citationMap;
        return legacy;
      });
      const {
        materializationDigest: _materializationDigest,
        schemaVersion: _schemaVersion,
        rendererDigest: _rendererDigest,
        ...shared
      } = current;
      void _materializationDigest;
      void _schemaVersion;
      void _rendererDigest;
      const legacyBasis = Object.freeze({
        authorityDigest: shared.authorityDigest,
        corpusDigest: shared.corpusDigest,
        files: legacyFiles,
        generationDigest: shared.generationDigest,
        pageCount: shared.pageCount,
        projectId: shared.projectId,
        projectionDigest: shared.projectionDigest,
        recordDigest: shared.recordDigest,
        rendererDigest: digestValue('legacy-renderer'),
        sanitizerPolicyDigest: shared.sanitizerPolicyDigest,
        schemaVersion: 'buildlore.hierarchical-markdown-materialization-manifest.v1',
      });
      await writeFile(manifestPath, serializeCanonicalJson(Object.freeze({
        ...legacyBasis,
        materializationDigest: digestValue(legacyBasis),
      })), 'utf8');
      await expect(publisher.status(PROJECT_ID)).resolves.toEqual({
        projectId: PROJECT_ID,
        reasonCode: 'renderer-outdated',
        recoveryAction: [
          'compile', 'activate', '--project', PROJECT_ID, '--rematerialize',
        ],
        schemaVersion: 'buildlore.hierarchical-markdown-materialization-status.v2',
        state: 'renderer-outdated',
      });
      const authorityBefore = await createApprovedWikiProjectionStore(item.knowledgeRoot)
        .readAuthority(PROJECT_ID);
      await publisher.publish({ authority: item.authority, projectId: PROJECT_ID });
      await expect(publisher.status(PROJECT_ID)).resolves.toMatchObject({ state: 'ready' });
      await expect(createApprovedWikiProjectionStore(item.knowledgeRoot)
        .readAuthority(PROJECT_ID)).resolves.toEqual(authorityBefore);
    });

  it('fails a preserve-authority render if the approved record changes before commit',
    async () => {
      const item = await fixture();
      const initial = createHierarchicalMarkdownPublication({
        knowledgeRoot: item.knowledgeRoot,
        lease,
      });
      await initial.publish({ authority: item.authority, projectId: PROJECT_ID });
      const store = createApprovedWikiProjectionStore(item.knowledgeRoot);
      const replacement = createSharedCitationApprovedAuthorityFixture(
        PROJECT_ID,
        item.authority.liveSnapshot.sanitizerPolicyDigest,
      );
      expect(replacement).not.toEqual(item.authority);
      const authorityDigest = digestValue(replacement);
      const replacementBasis = Object.freeze({
        authority: replacement,
        authorityDigest,
        projectId: PROJECT_ID,
        schemaVersion: 'buildlore.approved-wiki-authority-record.v1' as const,
      });
      const authorityPath = join(
        item.knowledgeRoot,
        'projects',
        PROJECT_ID,
        '.llmwiki',
        'buildlore-hierarchy',
        'approved-authority.json',
      );
      const guarded = createHierarchicalMarkdownPublication({
        hooks: {
          beforeStageWrite: async () => {
            await writeFile(authorityPath, serializeCanonicalJson(Object.freeze({
              ...replacementBasis,
              recordDigest: digestValue(replacementBasis),
            })), 'utf8');
          },
        },
        knowledgeRoot: item.knowledgeRoot,
        lease,
      });

      await expect(guarded.publish({
        authority: item.authority,
        preserveAuthority: true,
        projectId: PROJECT_ID,
      })).rejects.toMatchObject({ code: 'HIERARCHICAL_MARKDOWN_DRIFT' });
      await expect(store.readAuthority(PROJECT_ID)).resolves.toEqual(replacement);
    });

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
