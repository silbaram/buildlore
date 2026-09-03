import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
  HIERARCHICAL_WIKI_ACTIVATION_RESULT_SCHEMA_VERSION,
  createHierarchicalWikiActivationService,
} from '../src/cli/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { addProject } from '../src/knowledge/index.js';
import {
  createApprovedWikiProjectionStore,
  createHierarchicalMarkdownPublication,
} from '../src/retrieval/index.js';
import { readSecurityPolicy } from '../src/sanitizer/index.js';
import { createApprovedAuthorityFixture } from './helpers/hierarchical-authority-fixture.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = 'hierarchical-activation';
const roots: string[] = [];

function digestValue(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(value), 'utf8')
    .digest('hex')}`;
}

async function fixture() {
  const hubRoot = await mkdtemp(join(process.cwd(), '.test-tmp-hierarchical-activation-'));
  roots.push(hubRoot);
  const knowledgeRoot = join(hubRoot, 'knowledge');
  await mkdir(knowledgeRoot);
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: knowledgeRoot });
  await addProject(knowledgeRoot, {
    displayName: PROJECT_ID,
    projectId: PROJECT_ID,
    sourceRepository: `https://example.test/${PROJECT_ID}.git`,
  });
  const policy = await readSecurityPolicy(knowledgeRoot, PROJECT_ID);
  const authority = createApprovedAuthorityFixture(PROJECT_ID, policy.digest);
  await mkdir(join(hubRoot, '.buildlore'));
  await writeFile(join(hubRoot, '.buildlore/approved-wiki.json'), `${JSON.stringify({
    authority,
    projectId: PROJECT_ID,
    schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
  })}\n`, 'utf8');
  return { authority, hubRoot, knowledgeRoot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe('hierarchical activation v2', () => {
  it('publishes authority and its complete Markdown materialization without a provider', async () => {
    const item = await fixture();
    const result = await createHierarchicalWikiActivationService({
      hubRoot: item.hubRoot,
      knowledgeRoot: item.knowledgeRoot,
      liveSnapshotVerifier: { verify: () => Promise.resolve() },
    }).activate({
      confirmationDigest: item.authority.humanActivationApproval.approvalDigest,
      projectId: PROJECT_ID,
    });

    expect(result).toMatchObject({
      egress: 'none',
      materialization: {
        fileCount: 3,
        pageCount: 2,
        projectId: PROJECT_ID,
        state: 'ready',
      },
      pageCount: 2,
      projectId: PROJECT_ID,
      providerUsed: 'none',
      schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_RESULT_SCHEMA_VERSION,
    });
    const namespace = join(
      item.knowledgeRoot,
      'projects',
      PROJECT_ID,
      'wiki',
      'buildlore-hierarchy',
    );
    expect((await readdir(namespace)).sort()).toEqual([
      'index.md',
      'manifest.json',
      ...item.authority.finalization.proposals.map((proposal) => `${proposal.pageId}.md`),
    ].sort());
    expect(await readFile(join(namespace, 'index.md'), 'utf8')).toContain(
      '# Receipt-bound Wiki activation',
    );
    await expect(createApprovedWikiProjectionStore(item.knowledgeRoot).status(PROJECT_ID))
      .resolves.toMatchObject({ state: 'ready' });
    await expect(createHierarchicalMarkdownPublication({
      knowledgeRoot: item.knowledgeRoot,
    }).status(PROJECT_ID)).resolves.toEqual(result.materialization);
  });

  it('rejects confirmation mismatch before either authority or Markdown mutation', async () => {
    const item = await fixture();
    const service = createHierarchicalWikiActivationService({
      hubRoot: item.hubRoot,
      knowledgeRoot: item.knowledgeRoot,
      liveSnapshotVerifier: { verify: () => Promise.resolve() },
    });
    await expect(service.activate({
      confirmationDigest: `sha256:${'0'.repeat(64)}`,
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({ code: 'HIERARCHICAL_WIKI_ACTIVATION_APPROVAL_MISMATCH' });
    await expect(createApprovedWikiProjectionStore(item.knowledgeRoot).status(PROJECT_ID))
      .resolves.toMatchObject({ state: 'none' });
    await expect(createHierarchicalMarkdownPublication({
      knowledgeRoot: item.knowledgeRoot,
    }).status(PROJECT_ID)).resolves.toMatchObject({ state: 'none' });
  });

  it('rematerializes an intact legacy renderer without changing approved authority', async () => {
    const item = await fixture();
    const activation = createHierarchicalWikiActivationService({
      hubRoot: item.hubRoot,
      knowledgeRoot: item.knowledgeRoot,
      liveSnapshotVerifier: { verify: () => Promise.resolve() },
    });
    await activation.activate({
      confirmationDigest: item.authority.humanActivationApproval.approvalDigest,
      projectId: PROJECT_ID,
    });
    const authorityPath = join(
      item.knowledgeRoot,
      'projects',
      PROJECT_ID,
      '.llmwiki',
      'buildlore-hierarchy',
      'approved-authority.json',
    );
    const authorityBefore = await readFile(authorityPath, 'utf8');
    const manifestPath = join(
      item.knowledgeRoot,
      'projects',
      PROJECT_ID,
      'wiki',
      'buildlore-hierarchy',
      'manifest.json',
    );
    const current = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    const files = (current.files as Array<Record<string, unknown>>).map((file) => {
      const { citationMap: _citationMap, ...legacy } = file;
      void _citationMap;
      return legacy;
    });
    const legacyBasis = Object.freeze({
      authorityDigest: current.authorityDigest,
      corpusDigest: current.corpusDigest,
      files,
      generationDigest: current.generationDigest,
      pageCount: current.pageCount,
      projectId: current.projectId,
      projectionDigest: current.projectionDigest,
      recordDigest: current.recordDigest,
      rendererDigest: digestValue('legacy-renderer'),
      sanitizerPolicyDigest: current.sanitizerPolicyDigest,
      schemaVersion: 'buildlore.hierarchical-markdown-materialization-manifest.v1',
    });
    await writeFile(manifestPath, serializeCanonicalJson(Object.freeze({
      ...legacyBasis,
      materializationDigest: digestValue(legacyBasis),
    })), 'utf8');

    await expect(createHierarchicalMarkdownPublication({
      knowledgeRoot: item.knowledgeRoot,
    }).status(PROJECT_ID)).resolves.toMatchObject({ state: 'renderer-outdated' });
    const result = await createHierarchicalWikiActivationService({
      hubRoot: item.hubRoot,
      knowledgeRoot: item.knowledgeRoot,
      liveSnapshotVerifier: { verify: () => Promise.reject(new Error('must not verify sources')) },
    }).activate({ projectId: PROJECT_ID, rematerialize: true });

    expect(result.materialization).toMatchObject({ state: 'ready' });
    await expect(readFile(authorityPath, 'utf8')).resolves.toBe(authorityBefore);
  });
});
