import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { Peer } from './m2-installed-evaluation.js';
import type { KnowledgeWorkflowFixture } from './project-knowledge-workflow.js';
import { activate, git } from './connected-fixture.js';
import { record } from '../../src/knowledge/project-knowledge/guards.js';
import { serializeSecurityPolicy, parseSecurityPolicy } from '../../src/sanitizer/policy.js';
import { createProfileBindingV2 } from '../../src/profile/index.js';
import { parseSourceCollectionManifestV2 } from '../../src/projector/source-manifest.js';
import { serializeCanonicalJson } from '../../src/knowledge/atomic-file.js';

const exec = promisify(execFile);
export async function verifyInstalledWorkspace(tarball: string, hiddenRoots: readonly string[]): Promise<void> {
  assert.equal(process.platform, 'linux', 'Installed isolation verification unavailable: Linux with bwrap is required.');
  const root = await mkdtemp(join(tmpdir(), 'buildlore-installed-flow-'));
  try {
    const npm = process.env.npm_execpath;
    assert(npm, 'Run verification with npm@11.19.0.');
    assert.equal((await exec(process.execPath, [npm, '--version'])).stdout.trim(), '11.19.0');
    let workspace = join(root, 'knowledge');
    let config = join(root, 'config');
    const origin = join(root, 'knowledge.git');
    await git(root, 'init', '--bare', '--initial-branch=main', origin);
    await git(root, 'clone', origin, workspace);
    const install = async (path: string): Promise<void> => {
      await exec(process.execPath, [npm, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', path], { cwd: workspace, maxBuffer: 4 * 1024 * 1024 });
    };
    await install(tarball);
    const binary = (): string => join(workspace, 'node_modules/buildlore/dist/cli/bin.js');
    const env = (): NodeJS.ProcessEnv => ({ ...process.env, BUILDLORE_CONFIG_DIR: config });
    const sandbox = (writable: boolean): string[] => ['--ro-bind', '/', '/', ...(writable ? ['--bind', root, root] : []),
      ...hiddenRoots.flatMap(path => ['--tmpfs', path]), '--unshare-net', '--proc', '/proc', '--dev', '/dev'];
    async function invoke(args: readonly string[], cwd = workspace, expected = 0) {
      let stdout: string, stderr: string;
      let exitCode = 0;
      try {
        const output = await exec('bwrap', [...sandbox(true), '--chdir', cwd, process.execPath, binary(), ...args, '--json'], { cwd, env: env(), maxBuffer: 8 * 1024 * 1024 });
        stdout = output.stdout; stderr = output.stderr;
      } catch (error) {
        const failed = error as { code: number; stdout: string; stderr: string };
        exitCode = failed.code; stdout = failed.stdout; stderr = failed.stderr;
      }
      assert.equal(exitCode, expected, `${args.join(' ')}: ${stderr}`);
      const envelope = record(JSON.parse(stdout || stderr) as unknown);
      if (args[0] === 'client') {
        assert.equal(envelope.schemaVersion, 'buildlore.client-plan.v1');
        assert.equal(envelope.applied, false);
        return { exitCode, data: envelope, stderr, envelope };
      }
      assert.equal(envelope.ok, expected === 0);
      return { exitCode, data: record(envelope.data ?? {}), stderr, envelope };
    }
    assert.equal((await invoke(['workspace', 'guide'])).data.mode, 'uninitialized');
    assert.equal((await invoke(['workspace', 'init', '--knowledge-repo', '../knowledge.git'])).data.outcome, 'created');
    const projects = ['parcel', 'other'] as const;
    const sources = new Map<string, string>();
    for (const projectId of projects) {
      const sourceRoot = join(root, `source-${projectId}`); sources.set(projectId, sourceRoot);
      await mkdir(join(sourceRoot, 'docs'), { recursive: true });
      const fixtureInput = join(process.cwd(), 'test/fixtures/project-knowledge/v1/generic-md-json/R1');
      for (const name of ['README.md', 'architecture.md', 'decision.md']) await cp(join(fixtureInput, name), join(sourceRoot, 'docs', name));
      await cp(join(fixtureInput, 'settings.json'), join(sourceRoot, 'settings.json'));
      await git(sourceRoot, 'init', '--initial-branch=main');
      await mkdir(join(sourceRoot, '.buildlore'));
      // User-owned source identity input only; installed CLI declares all document selections below.
      await writeFile(join(sourceRoot, '.buildlore/sources.json'), serializeCanonicalJson(parseSourceCollectionManifestV2({ schemaVersion: 'buildlore.sources.v2', projectId,
        sourceRepository: `https://example.test/${projectId}.git`, sources: [] })));
      await git(sourceRoot, 'add', '.'); await git(sourceRoot, 'commit', '-m', 'fixed source inputs');
      await invoke(['project', 'add', '--id', projectId, '--source-repo', `https://example.test/${projectId}.git`, '--source-root', sourceRoot]);
      // Explicit language/adapter configuration input for generic Markdown and JSON.
      await writeFile(join(workspace, 'projects', projectId, 'profile-binding.json'), serializeCanonicalJson(createProfileBindingV2('general', 'en')));
      const empty = await invoke(['workspace', 'guide', '--project', projectId]);
      assert(JSON.stringify(empty.data).includes('SOURCE_DECLARATIONS_REQUIRED'));
      await invoke(['source', 'add', '--project', projectId, '--id', 'docs', '--kind', 'markdown', '--path', 'docs', '--recursive']);
      await invoke(['source', 'add', '--project', projectId, '--id', 'settings', '--kind', 'json', '--path', 'settings.json']);
      // Explicit fixture policy input, never approval/registration state or secret suppression.
      await writeFile(join(workspace, 'projects', projectId, 'security-policy.json'), serializeSecurityPolicy(parseSecurityPolicy({
        schemaVersion: 'buildlore.security-policy.v1', projectId, defaultClassification: 'public', classificationRules: [],
        egressRules: ['compile', 'context', 'eval-full', 'query', 'search'].map(capability => ({ capability, allowedClassifications: ['internal', 'public'] })), overrides: [],
      }, projectId)));
      await git(sourceRoot, 'add', '.'); await git(sourceRoot, 'commit', '-m', 'declared sources');
    }
    // Workspace/npm/registry metadata is explicitly committed before per-project publication.
    await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', 'installed workspace configuration');
    const source = (project: string): string => { const value = sources.get(project); assert(value); return value; };
    const missing = await invoke(['doctor'], source('parcel'), 2);
    assert(JSON.stringify(missing.envelope).includes('Source connection is missing'));
    assert(Array.isArray(missing.data.recoveryCommands));
    const wrongPath = await invoke(['connect', '--workspace', join(root, 'missing'), '--project', 'parcel'], source('parcel'), 6);
    assert(JSON.stringify(wrongPath.envelope).includes('HUB_UNAVAILABLE'));
    assert(JSON.stringify(wrongPath.envelope).includes('knowledge Git root'));
    await invoke(['connect', '--workspace', workspace, '--project', 'parcel', '--source-repo', 'https://example.test/parcel.git'], source('parcel'));
    const unapproved = await invoke(['doctor'], source('parcel'), 2);
    assert.equal(unapproved.data.approval, 'missing');
    assert(JSON.stringify(unapproved.envelope).includes('No approved Wiki'));
    for (const projectId of projects) {
      const inputs = join(workspace, '.buildlore/knowledge-inputs'); await mkdir(inputs, { recursive: true, mode: 0o700 });
      const fixture: KnowledgeWorkflowFixture = {
        root, hubRoot: workspace, knowledgeRoot: workspace, sourceRoot: source(projectId), projectId,
        setRevision: () => Promise.reject(new Error('Revision change not used.')), cleanup: async () => {},
        json: async (name, value) => { const path = `.buildlore/knowledge-inputs/${name}`; await writeFile(join(workspace, path), JSON.stringify(value), { mode: 0o600 }); return path; },
        cli: args => invoke(args),
      };
      await activate(fixture);
      const args = ['--project', projectId, '--source-revision', await git(source(projectId), 'rev-parse', 'HEAD')];
      const plan = await invoke(['publish', 'plan', ...args]); assert.equal(plan.data.eligible, true);
      const publication = await invoke(['publish', 'commit', ...args, '--expect-plan', String(plan.data.planDigest)]);
      assert.equal(publication.data.state, 'committed'); assert.equal(publication.data.parentPin, 'not_applicable');
    }
    async function connectAll(): Promise<void> {
      for (const projectId of projects) await invoke(['connect', '--workspace', workspace, '--project', projectId, '--source-repo', `https://example.test/${projectId}.git`], source(projectId));
    }
    await connectAll();
    await invoke(['client', 'configure', '--client', 'codex', '--project-dir', source('parcel')]);
    async function mcp(project: string, corrupt = false): Promise<Record<string, unknown>> {
      const cwd = source(project);
      const clientEnv = Object.fromEntries(Object.entries(env()).filter((e): e is [string, string] => e[1] !== undefined));
      const client = new Peer('bwrap', [...sandbox(false), '--chdir', cwd, process.execPath, binary(), 'mcp', '--project-dir', cwd, '--read-only'], clientEnv);
      try {
        await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'workspace-verifier', version: '1' } });
        client.notify('notifications/initialized');
        const call = async (name: string, args: object): Promise<Record<string, unknown>> => record((await client.request('tools/call', { name, arguments: args })).result);
        if (corrupt) { const rejected = await call('list', {}); assert.equal(rejected.isError, true); assert(JSON.stringify(rejected.structuredContent).includes('KNOWLEDGE_INVALID')); return {}; }
        const status = await call('status', {}); assert.notEqual(status.isError, true);
        const statusData = record(record(status.structuredContent).data);
        assert.equal(statusData.projectId, project); assert.equal(statusData.pin, 'not_applicable'); assert.equal(statusData.readable, true);
        const generation = statusData.generation;
        const listed = await call('list', {}); assert.notEqual(listed.isError, true);
        assert.equal(record(record(listed.structuredContent).readContext).generation, generation);
        const read = await call('read', { page: 'overview', expectedGeneration: generation }); assert.notEqual(read.isError, true);
        const search = await call('search', { query: 'SQLite', expectedGeneration: generation }); assert.notEqual(search.isError, true, JSON.stringify(search.structuredContent));
        const searchData = record(record(search.structuredContent).data);
        assert(Array.isArray(searchData.hits) && searchData.hits.length > 0, 'Search must retrieve approved content.');
        for (const name of ['list', 'search', 'read']) {
          const wrong = await call(name, { ...(name === 'search' ? { query: 'SQLite' } : name === 'read' ? { page: 'overview', expectedGeneration: generation } : {}), projectId: project === 'parcel' ? 'other' : 'parcel' });
          assert.equal(wrong.isError, true);
        }
        const stale = await call('read', { page: 'overview', expectedGeneration: `sha256:${'f'.repeat(64)}` });
        assert.equal(stale.isError, true); assert(JSON.stringify(stale.structuredContent).includes('GENERATION_CHANGED'));
        return { generation, read: record(read.structuredContent).data, search: record(search.structuredContent).data };
      } finally { await client.close(); }
    }
    const baseline = new Map<string, Record<string, unknown>>();
    for (const project of projects) baseline.set(project, await mcp(project));
    const original = workspace;
    workspace = join(root, 'restored');
    await git(root, 'clone', original, workspace);
    // A clone from a local checkout has a different origin; restore its declared portable repository identity.
    await git(workspace, 'remote', 'set-url', 'origin', '../knowledge.git');
    const delivered = join(root, 'delivered'); await mkdir(delivered);
    const replacement = join(delivered, basename(tarball)); await cp(tarball, replacement); await rm(tarball);
    await install(replacement); // Fails if package/lock still depends on the now unavailable original tarball.
    config = join(root, 'restored-config');
    const cloned = await invoke(['workspace', 'guide', '--project', 'parcel']);
    assert(JSON.stringify(cloned.data).includes('SOURCE_BINDING_REQUIRED'));
    assert.equal((await invoke(['workspace', 'init'])).data.outcome, 'existing');
    for (const project of projects) {
      await invoke(['project', 'bind', '--project', project, '--source-root', source(project)]);
      assert.equal((await invoke(['workspace', 'guide', '--project', project])).data.overall, 'action_required');
    }
    await connectAll();
    for (const project of projects) {
      assert.equal((await invoke(['workspace', 'guide', '--project', project])).data.overall, 'ready');
      assert.deepEqual(await mcp(project), baseline.get(project));
    }
    const authority = join(workspace, 'projects/parcel/.llmwiki/buildlore-hierarchy/approved-authority.json');
    const bytes = await readFile(authority); await writeFile(authority, '{}');
    const bad = await invoke(['doctor'], source('parcel'), 3);
    assert.equal(bad.data.approval, 'invalid');
    assert(JSON.stringify(bad.envelope).includes('KNOWLEDGE_INVALID'));
    assert(!JSON.stringify(bad.envelope).includes(source('parcel')));
    await mcp('parcel', true); await writeFile(authority, bytes);
    process.stdout.write(JSON.stringify({ installedWorkspace: 'passed', platform: process.platform, sourceHidden: true,
      mcpReadOnlyMount: true, networkDisabledDuringWorkflow: true, projects: 2, firstInitialization: 'created',
      publication: 'two CLI Git commits', freshClone: 'reinstalled from separately delivered tarball; original removed',
      generationAndContentRestored: true, searchReadIsolationAndStaleGeneration: 'passed', invalidApproval: 'rejected',
      authoring: 'deterministic proposal/review inputs; explicit test approval; no paid AI' }) + '\n');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
}
