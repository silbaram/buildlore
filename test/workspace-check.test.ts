import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceConnect } from '../src/application/workspace-setup.js';
import { workspaceCheck } from '../src/application/workspace-check.js';
import { McpProbe, inspectWikiProtocol } from '../src/mcp/probe.js';
import { packageVersion } from '../src/package-version.js';
import { createKnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { activate, git } from './helpers/connected-fixture.js';
import { matchPublishedShape } from './helpers/published-shape.js';

describe('workspace MCP check', () => {
  it.each([
    ['generation changes', 'list', 'GENERATION_CHANGED'],
    ['wrong project', 'status', 'PROJECT_MISMATCH'],
    ['empty Wiki', 'list', 'WIKI_EMPTY'],
    ['empty search', 'search', 'SEARCH_EMPTY'],
    ['wrong read page', 'read', 'MCP_PAGE_MISMATCH'],
    ['empty read', 'read', 'WIKI_READ_EMPTY'],
    ['legacy sections', 'read', null],
  ])('verifies protocol content: %s', async (scenario, failedStage, code) => {
    const generation = 'sha256:' + 'a'.repeat(64);
    const completed: string[] = [];
    const peer: Pick<McpProbe, 'request' | 'notify'> = {
      notify: () => undefined,
      request: (method, params) => {
        if (method === 'initialize') return Promise.resolve({ protocolVersion: '2025-11-25', serverInfo: { name: 'buildlore', version: packageVersion() } });
        if (method === 'tools/list') return Promise.resolve({ tools: ['status', 'list', 'search', 'read'].map(name => ({ name })) });
        if (!params || !('name' in params)) throw new Error('Unexpected tool request');
        const name = params.name;
        const data: Record<string, unknown> = { projectId: 'sample' };
        if (name === 'status') Object.assign(data, { readable: true, dirty: 'clean', generation });
        if (name === 'list') data.pages = [{ pageId: 'guide', title: 'Sample guide' }];
        if (name === 'search') data.hits = [{ locator: { projectId: 'sample', pageId: 'guide' } }];
        if (name === 'read') Object.assign(data, { pageId: 'guide', markdown: 'Fixture content' });
        if (name === failedStage) {
          if (scenario === 'wrong project') data.projectId = 'other';
          if (scenario === 'empty Wiki') data.pages = [];
          if (scenario === 'empty search') data.hits = [];
          if (scenario === 'wrong read page') data.pageId = 'different';
          if (scenario === 'empty read') data.markdown = '';
          if (scenario === 'legacy sections') { delete data.markdown; data.sections = [{ body: 'Legacy content' }]; }
        }
        return Promise.resolve({ structuredContent: { ok: true, projectId: 'sample', data,
          readContext: { generation: name === failedStage && scenario === 'generation changes' ? 'sha256:' + 'b'.repeat(64) : generation } } });
      },
    };
    const inspection = inspectWikiProtocol(peer, 'sample', (id, state) => { if (state === 'complete') completed.push(id); });
    if (code) { await expect(inspection).rejects.toMatchObject({ code }); expect(completed).not.toContain(failedStage); }
    else { await inspection; expect(completed).toEqual(['initialize', 'tools', 'status', 'list', 'search', 'read']); }
  });

  it('requires setup and approval, reads real MCP content, and detects dirty Wiki and edited settings', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    const options = { directory: f.hubRoot, projectId: f.projectId, client: 'codex' as const,
      configDir: join(f.root, 'config'), binPath: resolve('dist/cli/bin.js') };
    try {
      expect((await workspaceCheck(options)).stages).toContainEqual({ id: 'connection', state: 'blocked', code: 'CONNECTION_MISSING' });
      expect(await workspaceConnect({ ...options, apply: true })).toMatchObject({ overall: 'configured' });
      expect((await workspaceCheck(options)).stages).toContainEqual({ id: 'status', state: 'blocked', code: 'APPROVAL_MISSING' });
      await activate(f);
      await git(f.hubRoot, 'add', '.'); await git(f.hubRoot, 'commit', '-m', 'approved fixture');
      const check = await workspaceCheck(options);
      expect(check, JSON.stringify(check)).toMatchObject({ overall: 'ready', clientSession: 'unverified' });
      expect(check.stages.every(s => s.state === 'complete')).toBe(true);
      expect(JSON.stringify(check)).not.toContain(f.root);
      await matchPublishedShape(check, { $ref: 'workspace-setup.schema.json' });
      await writeFile(join(f.hubRoot, 'projects', f.projectId, 'uncommitted.txt'), 'pending');
      expect((await workspaceCheck(options)).stages).toContainEqual({ id: 'status', state: 'blocked', code: 'KNOWLEDGE_DIRTY' });
      const configFile = join(f.sourceRoot, '.codex/config.toml');
      await writeFile(configFile, (await readFile(configFile, 'utf8')).replace('--read-only', '--unexpected'));
      expect((await workspaceCheck(options)).stages).toContainEqual({ id: 'client', state: 'blocked', code: 'CLIENT_CONFIG_CONFLICT' });
    } finally { await f.cleanup(); }
  }, 60000);

  it.each([
    ['invalid JSON', 'process.stdout.write("not-json\\n");', 'MCP_PROTOCOL_INVALID'],
    ['invalid result', 'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:null})+"\\n");', 'MCP_PROTOCOL_INVALID'],
    ['oversized response', 'process.stdout.write("x".repeat(4096));', 'MCP_OUTPUT_LIMIT'],
    ['early exit', 'process.exit(0);', 'MCP_EXITED'],
    ['timeout', 'setInterval(()=>{},1000);', 'MCP_TIMEOUT'],
  ])('bounds %s and reaps the child', async (_name, body, code) => {
    const peer = new McpProbe(process.execPath, ['-e', body], {}, 1000, 2000, 1024);
    try { await expect(peer.request('initialize')).rejects.toMatchObject({ code }); }
    finally { await peer.close(); }
    expect(peer.child.exitCode !== null || peer.child.signalCode !== null).toBe(true);
  }, 5000);
});
