import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
  HIERARCHICAL_WIKI_ACTIVATION_RESULT_SCHEMA_VERSION,
  createHierarchicalWikiActivationService,
} from '../src/cli/index.js';
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
      '# BuildLore Hierarchical Wiki',
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
});
