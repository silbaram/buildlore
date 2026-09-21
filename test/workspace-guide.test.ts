import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceGuide } from '../src/application/workspace-guide.js';
import { initializeKnowledgeWorkspace } from '../src/knowledge/knowledge-workspace.js';
import { connectProject } from '../src/connection/service.js';
import { runCli } from '../src/cli/run-cli.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { parseSourceCollectionManifestV2 } from '../src/projector/source-manifest.js';
import { createKnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { activate, git } from './helpers/connected-fixture.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-guide-')); roots.push(root);
  await git(root, 'init'); return root;
}
async function snapshot(root: string): Promise<unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    result[entry.name] = entry.isDirectory() ? await snapshot(path) : (await readFile(path)).toString('base64');
  }
  return result;
}
describe('workspace setup guide', () => {
  it('guides empty Git roots through explicit initialization and project selection without writes', async () => {
    const root = await repository();
    const before = await snapshot(root);
    const initial = await workspaceGuide(root);
    expect(initial).toMatchObject({ mode: 'uninitialized', overall: 'action_required' });
    expect(initial.checks).toContainEqual({ id: 'workspace', state: 'pending', reasonCode: 'WORKSPACE_NOT_INITIALIZED' });
    expect(await snapshot(root)).toEqual(before);
    await initializeKnowledgeWorkspace(root, 'https://example.test/knowledge.git');
    expect((await workspaceGuide(root)).checks.find(c => c.id === 'project')?.reasonCode).toBe('PROJECT_REQUIRED');
    expect((await workspaceGuide(root, 'parcel')).checks.find(c => c.id === 'project')?.reasonCode).toBe('PROJECT_NOT_REGISTERED');
    await mkdir(join(root, 'subdir'));
    expect((await workspaceGuide(join(root, 'subdir'))).overall).toBe('blocked');
  });
  it('reports corrupt marker in CLI human and JSON output before normal resolver failure', async () => {
    const root = await repository(); await mkdir(join(root, '.buildlore'));
    await writeFile(join(root, '.buildlore/workspace.json'), '{broken');
    const before = await snapshot(root);
    for (const json of [false, true]) {
      let output = '';
      expect(await runCli(['workspace', 'guide', ...(json ? ['--json'] : [])], { stdout: v => { output += v; }, stderr: v => { output += v; } }, { cwd: root })).toBe(3);
      expect(output).toContain('WORKSPACE_INVALID'); expect(output).not.toContain(root);
      expect(output).not.toContain('workspace init');
    }
    expect(await snapshot(root)).toEqual(before);
  });
  it('does not initialize legacy hubs or follow unsafe configuration directories', async () => {
    const root = await repository(); await writeFile(join(root, '.gitmodules'), 'legacy fixture');
    expect(await workspaceGuide(root)).toMatchObject({ mode: 'legacy-hub', nextActions: [{ argv: ['knowledge', 'status'] }] });
    await rm(join(root, '.gitmodules')); await symlink('missing', join(root, '.buildlore'));
    expect((await workspaceGuide(root)).overall).toBe('blocked');
  });
  it('requires explicit project selection, separates missing sources from damaged ones, and hides source paths', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    try {
      expect((await workspaceGuide(f.hubRoot)).checks.find(c => c.id === 'project')?.reasonCode).toBe('PROJECT_REQUIRED');
      expect((await workspaceGuide(f.hubRoot, 'absent')).checks.find(c => c.id === 'binding')?.state).toBe('not_checked');
      const guide = await workspaceGuide(f.hubRoot, f.projectId);
      expect(guide.checks.find(c => c.id === 'approval')?.reasonCode).toBe('APPROVAL_REQUIRED');
      expect(JSON.stringify(guide)).not.toContain(f.sourceRoot);
      const manifest = join(f.sourceRoot, '.buildlore/sources.json');
      const sourceManifest = await readFile(manifest);
      const parsed = parseSourceCollectionManifestV2(JSON.parse(sourceManifest.toString()) as unknown);
      const empty = serializeCanonicalJson({ ...parsed, sources: [] });
      await writeFile(manifest, empty);
      const emptyGuide = await workspaceGuide(f.hubRoot, f.projectId);
      expect(emptyGuide.nextActions[0]).toMatchObject({
        argv: ['source', 'add', '--project', f.projectId, '--id', '<source-id>',
          '--kind', '<source-kind>', '--path', '<relative-source-directory>', '--recursive'],
        requiredInputs: ['source-id', 'source-kind', 'relative-source-directory'],
      });
      expect(await readFile(manifest, 'utf8')).toBe(empty);
      await rm(manifest);
      const missingGuide = await workspaceGuide(f.hubRoot, f.projectId);
      expect(missingGuide.checks.find(c => c.id === 'sources')?.state).toBe('pending');
      expect(missingGuide.nextActions[0]?.argv).toEqual(emptyGuide.nextActions[0]?.argv);
      await writeFile(manifest, '{broken');
      expect((await workspaceGuide(f.hubRoot, f.projectId)).checks.find(c => c.id === 'sources')?.state).toBe('blocked');
      await writeFile(join(f.hubRoot, '.buildlore/local-projects.json'), '{broken');
      expect((await workspaceGuide(f.hubRoot, f.projectId)).checks.find(c => c.id === 'binding')?.reasonCode).toBe('SOURCE_BINDING_INVALID');
      await rm(join(f.hubRoot, '.buildlore/local-projects.json'));
      await chmod(join(f.hubRoot, '.buildlore'), 0o755); // Git clones do not retain private directory modes.
      const cloned = await workspaceGuide(f.hubRoot, f.projectId);
      expect(cloned.checks.find(c => c.id === 'binding')?.reasonCode).toBe('SOURCE_BINDING_REQUIRED');
      expect(cloned.nextActions[0]?.argv).toEqual(['workspace', 'init']);
      await writeFile(manifest, sourceManifest);
      expect(await initializeKnowledgeWorkspace(f.hubRoot)).toMatchObject({ outcome: 'existing' });
      expect((await f.cli(['project', 'bind', '--project', f.projectId, '--source-root', f.sourceRoot])).exitCode).toBe(0);
    } finally { await f.cleanup(); }
  });
  it('accepts the same registered optional P2A adapter as the existing CLI', async () => {
    const f = await createKnowledgeWorkflowFixture('optional-p2a', { directWorkspace: true });
    try {
      const guide = await workspaceGuide(f.hubRoot, f.projectId);
      expect(guide.checks.find(c => c.id === 'sources')?.state).toBe('complete');
      expect(guide.checks.find(c => c.id === 'approval')?.state).toBe('pending');
    } finally { await f.cleanup(); }
  });
  it('checks approved content and the exact connection while leaving client/AI/embedding claims unchecked', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    try {
      await activate(f); await git(f.hubRoot, 'add', '.'); await git(f.hubRoot, 'commit', '-m', 'approved');
      const configDir = join(f.root, 'config');
      expect((await workspaceGuide(f.hubRoot, f.projectId, configDir)).checks.find(c => c.id === 'connection')?.reasonCode).toBe('CONNECTION_REQUIRED');
      await connectProject(f.sourceRoot, { workspace: f.hubRoot, projectId: f.projectId, sourceRepository: `https://example.test/${f.projectId}.git` }, { configDir });
      const before = await snapshot(f.root);
      const guide = await workspaceGuide(f.hubRoot, f.projectId, configDir);
      expect(guide.overall).toBe('ready');
      expect(guide.checks.slice(-3).every(c => c.state === 'not_checked')).toBe(true);
      expect(await snapshot(f.root)).toEqual(before);
      await writeFile(join(f.hubRoot, 'projects', f.projectId, '.llmwiki/buildlore-hierarchy/approved-authority.json'), '{}');
      expect((await workspaceGuide(f.hubRoot, f.projectId, configDir)).overall).toBe('blocked');
    } finally { await f.cleanup(); }
  }, 60000);
});
