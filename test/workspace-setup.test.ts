import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceConnect, workspaceClientGuide } from '../src/application/workspace-setup.js';
import { ClientConfigError } from '../src/integrations/files.js';
import { createKnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { runCli } from '../src/cli/run-cli.js';
import { matchPublishedShape } from './helpers/published-shape.js';

describe('workspace connection setup', () => {
  it('previews without writes, preserves settings, applies once and reports idempotence', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    const configDir = join(f.root, 'config'), configFile = join(f.sourceRoot, '.codex/config.toml');
    const options = { directory: f.hubRoot, projectId: f.projectId, client: 'codex' as const, configDir, binPath: resolve('dist/cli/bin.js') };
    try {
      await mkdir(join(f.sourceRoot, '.codex'));
      const original = '# User settings\nmodel = "local-model"\n[mcp_servers.other]\ncommand = "/bin/false"\n';
      await writeFile(configFile, original);
      const preview = await workspaceConnect(options);
      expect(preview).toMatchObject({ overall: 'preview', clientSession: 'unverified' });
      await matchPublishedShape(preview, { $ref: 'workspace-setup.schema.json' });
      expect(JSON.stringify(preview)).not.toContain(f.root);
      expect(await readFile(configFile, 'utf8')).toBe(original);
      await expect(lstat(configDir)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(f.sourceRoot, '.buildlore/connection.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      const applied = await workspaceConnect({ ...options, apply: true });
      expect(applied, JSON.stringify(applied)).toMatchObject({ overall: 'configured' });
      const bytes = await readFile(configFile, 'utf8');
      expect(bytes).toContain(original);
      const registry = await readFile(join(configDir, 'connections.json'));
      const second = await workspaceConnect({ ...options, apply: true });
      expect(second.stages.slice(1).map(s => s.state)).toEqual(['unchanged', 'unchanged']);
      expect(await readFile(configFile, 'utf8')).toBe(bytes);
      expect(await readFile(join(configDir, 'connections.json'))).toEqual(registry);
      const guide = await workspaceClientGuide(options);
      expect(guide.overall).toBe('action_required');
      expect(guide.stages).toContainEqual({ id: 'protocol', state: 'not_checked', code: 'MCP_CHECK_REQUIRED' });
      await writeFile(configFile, bytes.replace('--read-only', '--unexpected-edit'));
      const refused = await workspaceConnect({ ...options, apply: true });
      expect(refused.overall).toBe('blocked');
      expect(refused.stages[2]?.code).toBe('CLIENT_CONFIG_CONFLICT');
      expect(await readFile(configFile, 'utf8')).toContain('--unexpected-edit');
    } finally { await f.cleanup(); }
  }, 30000);

  it('reports a partial connection and recovers on the same command', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    const options = { directory: f.hubRoot, projectId: f.projectId, client: 'codex' as const,
      configDir: join(f.root, 'config'), binPath: resolve('dist/cli/bin.js'), apply: true };
    try {
      const result = await workspaceConnect({ ...options, afterConnection: () => Promise.reject(new ClientConfigError('CLIENT_CONFIG_BUSY')) });
      expect(result).toMatchObject({ overall: 'blocked', stages: [
        { id: 'prerequisites', state: 'complete' }, { id: 'connection', state: 'complete' }, { id: 'client', state: 'blocked' },
      ] });
      expect(await workspaceConnect(options)).toMatchObject({ overall: 'configured', stages: [
        { state: 'complete' }, { state: 'unchanged' }, { state: 'complete' },
      ] });
    } finally { await f.cleanup(); }
  }, 30000);

  it('requires explicit project/client and provides safe CLI output', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    try {
      const runtime = { cwd: f.hubRoot, configDir: join(f.root, 'config'), workspaceBinPath: resolve('dist/cli/bin.js') };
      const invoke = async (args: string[]) => {
        let text = ''; const code = await runCli(args, { stdout: s => { text += s; }, stderr: s => { text += s; } }, runtime);
        return { code, text };
      };
      expect((await invoke(['workspace', 'connect', '--client', 'codex'])).code).not.toBe(0);
      expect((await invoke(['workspace', 'guide', '--client', 'codex'])).code).not.toBe(0);
      expect((await invoke(['workspace', 'check', '--project', f.projectId, '--client', 'claude-code'])).code).not.toBe(0);
      const result = await invoke(['workspace', 'connect', '--project', f.projectId, '--client', 'codex']);
      expect(result.code, result.text).toBe(0);
      expect(result.text).toContain('workspace connect: preview');
      expect(result.text).not.toContain(f.root);
      const missing = await workspaceConnect({ directory: f.hubRoot, projectId: 'missing', client: 'codex' });
      expect(missing.overall).toBe('blocked'); expect(missing.nextActions.join()).toContain('project add');
    } finally { await f.cleanup(); }
  }, 30000);
});
