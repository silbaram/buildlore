import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createWorkspacePublicationService } from '../src/knowledge/workspace-publication.js';
import { createCliPublicationLineageResolver } from '../src/cli/publication-lineage.js';
import { createKnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { activate, git } from './helpers/connected-fixture.js';
import { readApprovedWikiPublicationSnapshot } from '../src/retrieval/approved-corpus-store.js';

describe('direct workspace publication', () => {
  it.each([false, true])('publishes real approved Wiki and reopens its committed history (detached source=%s)', async detached => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    vi.stubEnv('LLMWIKI_PROVIDER', undefined);
    vi.stubEnv('LLMWIKI_EMBEDDING_MODEL', undefined);
    try {
      await git(f.hubRoot, 'add', '.');
      await git(f.hubRoot, 'commit', '-m', 'initial workspace configuration');
      if (detached) await git(f.sourceRoot, 'checkout', '--detach', 'HEAD');
      await activate(f);
      const before = await readApprovedWikiPublicationSnapshot(f.knowledgeRoot, f.projectId);
      const sourceRevision = await git(f.sourceRoot, 'rev-parse', 'HEAD');
      const args = ['--project', f.projectId, '--source-revision', sourceRevision];
      const plan = await f.cli(['publish', 'plan', ...args]);
      expect(plan, plan.stderr).toMatchObject({ exitCode: 0 });
      expect(plan.data, JSON.stringify(plan.data.blockReasons)).toMatchObject({ eligible: true });
      const commit = await f.cli(['publish', 'commit', ...args, '--expect-plan', String(plan.data.planDigest)]);
      expect(commit, commit.stderr).toMatchObject({ exitCode: 0, data: { state: 'committed', parentPin: 'not_applicable' } });
      expect(await git(f.hubRoot, 'log', '-1', '--format=%B')).toContain(sourceRevision);
      const copy = join(f.root, 'committed-copy');
      await git(f.root, 'clone', f.hubRoot, copy);
      expect((await readApprovedWikiPublicationSnapshot(copy, f.projectId)).authorityDigest).toBe(before.authorityDigest);
      const exportProject = vi.fn(() => Promise.resolve({ schemaVersion: 1, projectId: f.projectId,
        pageCount: 1, pages: [{ modelId: 'fixture-model', promptVersion: 'fixture-v1' }] }));
      await writeFile(join(f.hubRoot, 'projects', f.projectId, '.llmwiki/buildlore-hierarchy/approved-authority.json'), '{}\n');
      await expect(createCliPublicationLineageResolver(f.hubRoot, { compilerExport: { exportProject },
        environment: { LLMWIKI_PROVIDER: 'openai', LLMWIKI_EMBEDDING_MODEL: 'embed-safe' } }).resolve(f.projectId))
        .rejects.toMatchObject({ code: 'PUBLISH_IDENTITY_UNAVAILABLE' });
      expect(exportProject).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); await f.cleanup(); }
  }, 60000);

  it('records the source checkout revision and publishes only the selected project without a synthetic parent pin', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    try {
      await git(f.hubRoot, 'add', '.');
      await git(f.hubRoot, 'commit', '-m', 'registered direct workspace');
      const sourceRevision = await git(f.sourceRoot, 'rev-parse', 'HEAD');
      expect(await git(f.hubRoot, 'rev-parse', 'HEAD')).not.toBe(sourceRevision);
      const lineage = await createCliPublicationLineageResolver(f.hubRoot, {
        compilerExport: { exportProject: () => Promise.resolve({ schemaVersion: 1, projectId: f.projectId, pageCount: 1,
          pages: [{ modelId: 'fixture-model', promptVersion: 'fixture-v1' }] }) },
        environment: { LLMWIKI_PROVIDER: 'openai', LLMWIKI_EMBEDDING_MODEL: 'embed-safe' },
      }).resolve(f.projectId);
      expect(lineage.codeRevision).toBe(sourceRevision);
      const log = join(f.knowledgeRoot, 'projects', f.projectId, 'log.md');
      await writeFile(log, '# Project activity\n\nReviewed workspace publication.\n');
      const packageFile = join(f.hubRoot, 'package.json');
      await writeFile(packageFile, '{"private":true}\n');
      const service = createWorkspacePublicationService(f.hubRoot);
      const input = { ...lineage, projectId: f.projectId, sourceRevision };
      expect((await service.plan(input)).blockReasons).toContain('ROOT_CHANGE_NOT_ALLOWED');
      await git(f.hubRoot, 'add', 'package.json');
      await git(f.hubRoot, 'commit', '-m', 'record package metadata separately');
      const plan = await service.plan(input);
      expect(plan, JSON.stringify(plan.blockReasons)).toMatchObject({ schemaVersion: 'buildlore.workspace-publish-plan.v1', mode: 'knowledge', eligible: true });
      expect(plan.planDigest).not.toBe(plan.knowledgePlanDigest);
      expect(plan.selectedPaths.map(p => p.relativePath)).toEqual([`projects/${f.projectId}/log.md`]);
      await expect(service.commit({ ...input, expectedPlanDigest: plan.knowledgePlanDigest })).rejects.toMatchObject({ code: 'PUBLISH_PLAN_DRIFT' });
      const result = await service.commit({ ...input, expectedPlanDigest: plan.planDigest });
      expect(result, JSON.stringify(result)).toMatchObject({ schemaVersion: 'buildlore.workspace-publish-result.v1', state: 'committed', pinRequired: false, parentPin: 'not_applicable' });
      expect(await readFile(packageFile, 'utf8')).toBe('{"private":true}\n');
      const message = await git(f.hubRoot, 'log', '-1', '--format=%B');
      expect(message).toContain(sourceRevision);
      expect(message).toContain(plan.knowledgePlanDigest);
      expect(await git(f.hubRoot, 'status', '--porcelain=v1', '--', 'package.json')).toBe('');
    } finally { await f.cleanup(); }
  }, 30000);
});
