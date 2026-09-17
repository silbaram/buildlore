import { describe, expect, it } from 'vitest';
import { createKnowledgeWorkflowFixture, submitWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { runCli } from '../src/cli/run-cli.js';
import { createLocalWikiOperator } from '../src/retrieval/local-wiki-operator.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { createRepositoryWriterLease } from '../src/knowledge/repository-writer-lease.js';
import { knowledgeSemanticProvider } from './helpers/knowledge-semantic-provider.js';

describe('direct knowledge workspace CLI', () => {
  it('runs the real sync, authoring, approval, activation and retrieval workflow at the repository root', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    try {
      expect(f.knowledgeRoot).toBe(f.hubRoot);
      expect(await f.cli(['workspace', 'init'])).toMatchObject({ exitCode: 0, data: { mode: 'knowledge', outcome: 'existing' } });
      expect(await f.cli(['project', 'show', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
      expect(await f.cli(['source', 'list', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
      expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
      const purpose = await f.json('purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
        projectId: f.projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
      const started = await f.cli(['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', purpose]);
      expect(started, started.stderr).toMatchObject({ exitCode: 0, data: { phase: 'awaiting-proposal' } });
      const first = await submitWorkflowFixture(f, started.data);
      expect(await f.cli(first.approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
      const provider = knowledgeSemanticProvider();
      const identity = provider.activeIdentity();
      if (!identity) throw new Error('Missing fixture embedding identity.');
      const operator = createLocalWikiOperator({ hubRoot: f.hubRoot, knowledgeRoot: f.knowledgeRoot,
        provider, embeddingIdentity: identity, repositoryLease: createRepositoryWriterLease() });
      expect(await operator.rebuildIndex({ projectId: f.projectId })).toMatchObject({ result: { outcome: 'activated' } });
      expect(await f.cli(['index', 'status', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
      expect(await createKnowledgeWikiReader(f.knowledgeRoot, { hubRoot: f.hubRoot, provider })
        .search(f.projectId, 'storage', 'semantic')).toMatchObject({ effectiveMode: 'semantic', fallback: null });
      expect(await f.cli(['wiki', 'read', '--project', f.projectId, '--page', 'overview'])).toMatchObject({ exitCode: 0, data: { role: 'overview' } });
      expect(await f.cli(['search', '--project', f.projectId, '--query', 'storage', '--mode', 'lexical'])).toMatchObject({ exitCode: 0 });
      expect((await f.cli(['wiki', 'read', '--project', 'other-project', '--page', 'overview'])).exitCode).not.toBe(0);
      let output = '';
      expect(await runCli(['knowledge', 'pin', 'plan', '--intent', 'iteration-close', '--iteration', 'first', '--knowledge-revision', 'a'.repeat(40), '--json'],
        { stdout: v => { output += v; }, stderr: v => { output += v; } }, { cwd: f.hubRoot })).not.toBe(0);
      expect(output).toContain('CLI_COMMAND_UNSUPPORTED');
    } finally { await f.cleanup(); }
  }, 60000);
});
