import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { addProject } from '../src/knowledge/workspace.js';
import { readSecurityPolicy } from '../src/sanitizer/policy.js';
import { createApprovedWikiProjectionStore } from '../src/retrieval/approved-corpus-store.js';
import { createApprovedAuthorityFixture } from './helpers/hierarchical-authority-fixture.js';
import { connectProject } from '../src/connection/service.js';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runCli } from '../src/cli/run-cli.js';
import { readConnectedWiki, connectionStatus } from '../src/application/wiki-read-service.js';
import { hash } from '../src/connection/contracts.js';
import { activate, addHierarchicalProject, connectedFixture, git } from './helpers/connected-fixture.js';
import { containsCredentialMaterial } from '../src/sanitizer/service.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';

describe('approved connected Wiki reads', () => {
  it('does not serialize suspected credentials supplied in the project option', async () => {
    const f = await connectedFixture();
    try {
      const id = `sk-${randomBytes(16).toString('hex')}`;
      let output = '';
      const code = await runCli(['connect', '--hub', f.hubRoot, '--project', id, '--json'],
        { stdout: value => { output += value; }, stderr: value => { output += value; } },
        { cwd: f.sourceRoot, configDir: f.configDir });
      expect(output.includes(id)).toBe(false);
      expect(code).toBe(2);
      expect(JSON.parse(output)).toMatchObject({ projectId: null, data: null });
    } finally { await f.cleanup(); }
  }, 20000);
  it('preserves hub search modes and intents when a matching generation is supplied', async () => {
    const f = await connectedFixture(true);
    try {
      const generation = (await readConnectedWiki(f.context, { operation: 'list' })).readContext.generation;
      const other = await addHierarchicalProject(f);
      for (const project of [f.projectId, other.projectId]) {
        const selectedGeneration = project === f.projectId ? generation : other.generation;
        for (const mode of [undefined, 'lexical', 'graph', 'hybrid', 'semantic']) {
          for (const intent of ['auto', 'neutral', 'current', 'historical']) {
            const args = ['search', '--project', project, '--query', 'local',
              ...(mode === undefined ? [] : ['--mode', mode]), '--intent', intent];
            const baseline = await f.cli(args);
            expect(baseline.exitCode).toBe(mode === 'semantic' ? 4 : 0);
            const pinned = await f.cli([...args, '--expect-generation', selectedGeneration]);
            expect(pinned.exitCode).toBe(baseline.exitCode);
            expect(pinned.data).toEqual(baseline.data);
          }
        }
      }
    } finally { await f.cleanup(); }
  }, 60000);
  it('has no legacy fallback, reports missing approval, and requires generations before content access', async () => {
    const f = await connectedFixture();
    try {
      expect(await connectionStatus(f.context)).toMatchObject({ connected: true, readable: false, approval: 'missing', remote: 'not_checked' });
      await expect(readConnectedWiki(f.context, { operation: 'list' })).rejects.toMatchObject({ code: 'APPROVAL_MISSING' });
      await expect(readConnectedWiki(f.context, { operation: 'read', page: 'overview' })).rejects.toMatchObject({ code: 'GENERATION_REQUIRED' });
      let stderr = '';
      expect(await runCli(['wiki', 'list', '--json'], { stdout: () => {}, stderr: s => { stderr += s; } }, { cwd: f.sourceRoot, configDir: f.configDir })).toBe(2);
      expect(JSON.parse(stderr)).toMatchObject({ schemaVersion: 'buildlore.cli-envelope.v2', data: null, readContext: null });
    } finally { await f.cleanup(); }
  }, 20000);
  it('serves CLI and common-service parity, enforces project/generation and keeps one snapshot across activation', async () => {
    const f = await connectedFixture(true);
    try {
      const list = await readConnectedWiki(f.context, { operation: 'list' });
      const generation = list.readContext.generation;
      expect(list.readContext).toMatchObject({ format: 'project-knowledge', readPolicy: 'connected-approved' });
      const cli = async (args: string[], cwd = join(f.sourceRoot, 'docs')) => {
        let output = '';
        const code = await runCli([...args, '--json'], { stdout: s => { output += s; }, stderr: s => { output += s; } }, { cwd, configDir: f.configDir });
        return { code, envelope: JSON.parse(output) as Record<string, unknown> };
      };
      for (const [args, request] of [
        [['wiki', 'list'], { operation: 'list' }],
        [['search', '--query', 'local'], { operation: 'search', query: 'local' }],
        [['search', '--query', 'local', '--intent', 'neutral'], { operation: 'search', query: 'local', intent: 'neutral' }],
        [['wiki', 'memory'], { operation: 'memory' }],
        [['wiki', 'memory', '--task', 'local', '--progressive'], { operation: 'memory', task: 'local', progressive: true }],
        [['wiki', 'read', '--page', 'overview', '--expect-generation', generation], { operation: 'read', page: 'overview', expectedGeneration: generation }],
        [['wiki', 'citations', '--page', 'overview', '--expect-generation', generation], { operation: 'citations', page: 'overview', expectedGeneration: generation }],
      ] as const) {
        const result = await cli([...args]);
        expect(result.code, JSON.stringify(result.envelope)).toBe(0);
        expect(result.envelope).toMatchObject({ schemaVersion: 'buildlore.cli-envelope.v2', projectId: f.projectId, readContext: list.readContext });
        expect(result.envelope.data).toEqual((await readConnectedWiki(f.context, request)).data);
      }
      const page = await createKnowledgeWikiReader(f.knowledgeRoot).read(f.projectId, 'overview');
      if (!page?.evidence[0]) throw new Error('Fixture evidence missing.');
      expect((await cli(['wiki', 'lookup', '--kind', 'evidence', '--id', page.evidence[0].evidenceId, '--expect-generation', generation])).code).toBe(0);
      expect((await cli(['wiki', 'list', '--project', 'other'])).code).toBe(3);
      expect((await cli(['wiki', 'read', '--page', 'overview', '--expect-generation', hash('stale')])).code).toBe(3);
      expect((await cli(['search', '--query', 'local', '--mode', 'semantic'])).code).toBe(2);
      expect((await cli(['wiki', 'list', '--project', f.projectId], f.hubRoot)).envelope.schemaVersion).toBe('buildlore.cli-envelope.v1');
      const cursor = ((await readConnectedWiki(f.context, { operation: 'list', limit: 1 })).data as { cursor: string }).cursor;
      expect(await connectionStatus(f.context)).toMatchObject({ approval: 'ready', pin: 'matched', dirty: 'dirty', sourceRevisionComparison: 'match' });
      const old = await readConnectedWiki(f.context, { operation: 'read', page: 'overview', expectedGeneration: generation }, {
        afterSnapshot: async () => { await f.setRevision('R2'); await git(f.sourceRoot, 'add', 'docs', 'settings.json'); await git(f.sourceRoot, 'commit', '-m', 'R2');
          expect(await connectionStatus(f.context)).toMatchObject({ sourceRevisionComparison: 'different' });
          await activate(f); },
      });
      expect(old.readContext.generation).toBe(generation);
      expect(old.data).toEqual(page);
      await expect(readConnectedWiki(f.context, { operation: 'read', page: 'overview', expectedGeneration: generation })).rejects.toMatchObject({ code: 'GENERATION_CHANGED' });
      for (const operation of ['read', 'citations', 'lookup', 'search', 'list', 'memory'] as const) {
        await expect(readConnectedWiki(f.context, { operation, page: 'overview', query: 'local', expectedGeneration: generation })).rejects.toMatchObject({ code: 'GENERATION_CHANGED' });
      }
      await expect(readConnectedWiki(f.context, { operation: 'list', cursor })).rejects.toThrow();
      expect((await readConnectedWiki(f.context, { operation: 'list' })).readContext.generation).not.toBe(generation);
      // The capability must refresh Git health instead of trusting its earlier pin.
      await git(f.knowledgeRoot, 'commit', '--allow-empty', '-m', 'changed knowledge head');
      await expect(readConnectedWiki(f.context, { operation: 'list' })).rejects.toMatchObject({ code: 'KNOWLEDGE_PIN_MISMATCH' });
    } finally { await f.cleanup(); }
  }, 90000);
});

describe('same-hub project isolation and hierarchical compatibility', () => {
  it('rejects suspected credential queries in the hierarchical path without echoing input', async () => {
    const f = await connectedFixture();
    try {
      const other = await addHierarchicalProject(f);
      await connectProject(other.sourceRoot, { hub: f.hubRoot, projectId: other.projectId,
        sourceRepository: 'https://example.test/other.git' }, { configDir: f.configDir });
      const query = `Cookie: sessionid=${randomBytes(24).toString('hex')}`;
      expect(containsCredentialMaterial(query)).toBe(true);
      let output = '';
      const code = await runCli(['search', '--query', query, '--json'],
        { stdout: value => { output += value; }, stderr: value => { output += value; } },
        { cwd: other.sourceRoot, configDir: f.configDir });
      expect(output.includes(query)).toBe(false);
      expect(code).toBe(3);
    } finally { await f.cleanup(); }
  }, 30000);
  it('reports corrupted approval as invalid instead of missing', async () => {
    const f = await connectedFixture(true);
    try {
      const path = join(f.knowledgeRoot, 'projects', f.projectId, '.llmwiki/buildlore-hierarchy/approved-authority.json');
      await readFile(path);
      await writeFile(path, '{}\n');
      let output = '';
      const code = await runCli(['connection', 'status', '--json'],
        { stdout: value => { output += value; }, stderr: value => { output += value; } },
        { cwd: f.sourceRoot, configDir: f.configDir });
      expect(code).toBe(3);
      expect(JSON.parse(output)).toMatchObject({ data: { approval: 'invalid' }, errors: [{ code: 'KNOWLEDGE_INVALID' }] });
    } finally { await f.cleanup(); }
  }, 30000);
  it('serves overlapping page aliases with their own evidence and rejects cross-project identifiers', async () => {
    const f = await connectedFixture(true);
    try {
      const otherRoot = join(f.root, '다른 프로젝트');
      await mkdir(otherRoot); await git(otherRoot, 'init');
      await addProject(f.knowledgeRoot, { projectId: 'other', displayName: 'Other', sourceRepository: 'https://example.test/other.git' });
      const policy = await readSecurityPolicy(f.knowledgeRoot, 'other');
      await createApprovedWikiProjectionStore(f.knowledgeRoot).publish({ projectId: 'other', authority: createApprovedAuthorityFixture('other', policy.digest) });
      const other = await connectProject(otherRoot, { hub: f.hubRoot, projectId: 'other', sourceRepository: 'https://example.test/other.git' }, { configDir: f.configDir });
      const a = await readConnectedWiki(f.context, { operation: 'list' });
      const b = await readConnectedWiki(other, { operation: 'list' });
      expect(b.readContext.format).toBe('hierarchical');
      expect(b.readContext.generation).not.toBe(a.readContext.generation);
      const listed = b.data as { pages: { pageId: string }[] };
      const otherPage = listed.pages[0]?.pageId;
      if (!otherPage) throw new Error('Missing other project page.');
      const page = await readConnectedWiki(other, { operation: 'read', page: otherPage, expectedGeneration: b.readContext.generation });
      expect(JSON.stringify(page.data)).not.toContain('parcel');
      expect(await readConnectedWiki(other, { operation: 'citations', page: otherPage, expectedGeneration: b.readContext.generation })).toMatchObject({ readContext: b.readContext });
      expect(await readConnectedWiki(other, { operation: 'search', query: 'wiki' })).toMatchObject({ readContext: b.readContext });
      await expect(readConnectedWiki(other, { operation: 'memory' })).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
      await expect(readConnectedWiki(other, { operation: 'read', page: 'overview', expectedGeneration: a.readContext.generation })).rejects.toMatchObject({ code: 'GENERATION_CHANGED' });
    } finally { await f.cleanup(); }
  }, 60000);
});
