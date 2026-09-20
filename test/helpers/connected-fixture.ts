import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createKnowledgeWorkflowFixture, submitWorkflowFixture, type KnowledgeWorkflowFixture } from './project-knowledge-workflow.js';
import { connectProject } from '../../src/connection/service.js';

export const exec = promisify(execFile);
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-c', 'user.name=BuildLore Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd })).stdout.trim();
}
export async function activate(f: KnowledgeWorkflowFixture): Promise<void> {
  const sync = await f.cli(['sync', '--project', f.projectId]);
  if (sync.exitCode !== 0) throw new Error('Fixture sync failed.');
  const purpose = await f.json('connected-purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
    projectId: f.projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
  const started = await f.cli(['compile', 'hierarchy', 'start', '--allow-legacy-authoring', '--project', f.projectId, '--purpose', purpose]);
  const { approved } = await submitWorkflowFixture(f, started.data);
  const args = approved.data.activationArgs;
  if (!Array.isArray(args) || !args.every((v: unknown) => typeof v === 'string') || (await f.cli(args)).exitCode !== 0) throw new Error('Fixture activation failed.');
}
export async function connectedFixture(approved = false) {
  const f = await createKnowledgeWorkflowFixture('generic-md-json');
  try {
    if (approved) await activate(f);
    const configDir = join(f.root, 'config');
    const context = await connectProject(f.sourceRoot, { hub: f.hubRoot, projectId: f.projectId, sourceRepository: `https://example.test/${f.projectId}.git` }, { configDir });
    return { ...f, configDir, context };
  } catch (error) { await f.cleanup(); throw error; }
}

export async function addHierarchicalProject(f: KnowledgeWorkflowFixture) {
  const { mkdir } = await import('node:fs/promises');
  const { addProject } = await import('../../src/knowledge/workspace.js');
  const { readSecurityPolicy } = await import('../../src/sanitizer/policy.js');
  const { createApprovedWikiProjectionStore } = await import('../../src/retrieval/approved-corpus-store.js');
  const { createApprovedAuthorityFixture } = await import('./hierarchical-authority-fixture.js');
  const projectId = 'other', sourceRoot = join(f.root, '다른 프로젝트');
  await mkdir(sourceRoot); await git(sourceRoot, 'init');
  await addProject(f.knowledgeRoot, { projectId, displayName: 'Other', sourceRepository: 'https://example.test/other.git' });
  const policy = await readSecurityPolicy(f.knowledgeRoot, projectId);
  const projection = await createApprovedWikiProjectionStore(f.knowledgeRoot).publish({ projectId, authority: createApprovedAuthorityFixture(projectId, policy.digest) });
  return { projectId, sourceRoot, generation: projection.corpus.generationDigest, pageId: projection.corpus.pages[0]?.pageId ?? '' };
}
