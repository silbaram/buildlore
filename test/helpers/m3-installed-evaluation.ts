import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Peer, verifyInstalledM2Protocol, type InstalledM2Options } from './m2-installed-evaluation.js';

const exec = promisify(execFile);
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function tree(root: string): Promise<{ digest: string; bytes: number }> {
  const entries: [string, string][] = []; let bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = join(relative, name), full = join(root, path), stat = await lstat(full);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) { const value = await readFile(full); bytes += value.length; entries.push([path, hash(value)]); }
    }
  };
  await visit(''); return { digest: hash(JSON.stringify(entries)), bytes };
}
export async function verifyInstalledM3(o: InstalledM2Options & { tarball: string; install: string }): Promise<void> {
  const baseline = process.env.BUILDLORE_M3_BASELINE_TARBALL;
  assert(baseline, 'Baseline tarball required');
  const candidate = join(o.evidence, 'buildlore-0.1.1-rc.1.tgz'); await cp(o.tarball, candidate);
  const claudeConfig = join(o.root, 'isolated-claude'); await mkdir(claudeConfig);
  const preservedClaude = '{"unrelated":"preserve"}\n';
  await writeFile(join(claudeConfig, '.claude.json'), preservedClaude);
  await mkdir(join(o.sourceRoot, '.codex'), { recursive: true });
  const preservedCodex = '# User settings\n[mcp_servers.unrelated]\ncommand = "preserved"\n';
  await writeFile(join(o.sourceRoot, '.codex/config.toml'), preservedCodex);
  for (const file of ['AGENTS.md', 'CLAUDE.md']) await writeFile(join(o.sourceRoot, file), 'User-owned guidance.\n');
  const env = { ...process.env, BUILDLORE_CONFIG_DIR: o.configDir, CLAUDE_CONFIG_DIR: claudeConfig };
  const commands: { command: string; exitCode: number; durationMs: number; outputBytes: number }[] = [];
  const run = async (program: string, args: string[], cwd = o.sourceRoot) => {
    const start = performance.now();
    try {
      const result = await exec(program, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
      commands.push({ command: program === o.binary ? args.slice(0, 2).join(' ') : program + ' ' + args[0], exitCode: 0,
        durationMs: performance.now() - start, outputBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) });
      return result;
    } catch (error) {
      commands.push({ command: program === o.binary ? args.slice(0, 2).join(' ') : program + ' ' + args[0],
        exitCode: error instanceof Error && 'code' in error && typeof error.code === 'number' ? error.code : -1,
        durationMs: performance.now() - start, outputBytes: 0 });
      throw error;
    }
  };
  const cli = async (args: string[], cwd = o.sourceRoot): Promise<Record<string, unknown>> => {
    const value = object(JSON.parse((await run(o.binary, [...args, '--json'], cwd)).stdout));
    assert.equal(value.ok, true); return value;
  };
  let hub = o.hubRoot;
  const knowledgeBefore = await tree(join(hub, 'knowledge'));
  const gitState = async () => ({
    head: (await run('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], join(hub, 'knowledge'))).stdout,
    index: hash((await run('git', ['--no-optional-locks', 'ls-files', '--stage'], join(hub, 'knowledge'))).stdout),
  });
  const gitBefore = await gitState();
  const writerBefore = await readFile(join(hub, '.buildlore/local-projects.json'));
  const sourceBefore = await readFile(join(o.sourceRoot, '.buildlore/sources.json'));
  const sharedBefore = await readFile(join(o.sourceRoot, '.buildlore/connection.json'));
  const stages: { version: string; installMs: number; firstReadAndEvidenceMs: number; installedBytes: number }[] = [];
  const readProjects = async (): Promise<void> => {
    for (const selected of [{ sourceRoot: o.sourceRoot, projectId: o.projectId, pageId: 'overview' }, o.other]) {
      const first = await cli(['wiki', 'list'], selected.sourceRoot);
      assert.equal(first.projectId, selected.projectId);
      const generation = object(first.readContext).generation; assert.equal(typeof generation, 'string');
      const page = await cli(['wiki', 'read', '--page', selected.pageId, '--expect-generation', String(generation)], selected.sourceRoot);
      assert.equal(page.projectId, selected.projectId);
      const citations = await cli(['wiki', 'citations', '--page', selected.pageId, '--expect-generation', String(generation)], selected.sourceRoot);
      assert.equal(citations.projectId, selected.projectId);
      assert(object(page.data)); assert(object(citations.data));
    }
    const lookup = await cli(['wiki', 'lookup', '--kind', 'evidence', '--id', o.evidenceId, '--expect-generation', o.generation]);
    assert(JSON.stringify(lookup.data).includes(o.evidenceId));
    assert.equal((await cli(['doctor'])).ok, true);
  };
  const install = async (tarball: string, version: string): Promise<void> => {
    const start = performance.now();
    await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', tarball], o.install);
    const installMs = performance.now() - start;
    const metadata = object(JSON.parse(await readFile(join(o.install, 'node_modules/buildlore/package.json'), 'utf8')));
    assert.equal(metadata.version, version);
    assert((await run(o.binary, ['--help'])).stdout.includes('buildlore setup'));
    if (version !== '0.1.0') assert.equal((await run(o.binary, ['--version'])).stdout.trim(), 'buildlore ' + version);
    await readProjects();
    const firstReadAndEvidenceMs = performance.now() - start;
    const installed = await tree(join(o.install, 'node_modules'));
    stages.push({ version, installMs, firstReadAndEvidenceMs, installedBytes: installed.bytes });
    assert.equal((await tree(join(hub, 'knowledge'))).digest, knowledgeBefore.digest);
    assert.deepEqual(await gitState(), gitBefore);
    process.stdout.write(`Verified installed version ${version}, page and evidence reads.\n`);
  };
  const configure = async (client: string, operation: string, binary = o.binary): Promise<void> => {
    const args = ['client', operation, '--client', client, '--project-dir', o.sourceRoot];
    const invoke = async (extra: string[]) => object(JSON.parse((await run(binary, [...args, ...extra, '--json'])).stdout));
    const preview = await invoke([]);
    assert.equal(typeof preview.planDigest, 'string');
    assert.equal((await invoke(['--apply', '--expect-plan', String(preview.planDigest)])).applied, true);
    assert.equal((await invoke([])).changed, false);
  };
  try {
    // Actual baseline/candidate transitions in the same consumer installation.
    await install(baseline, '0.1.0');
    await install(candidate, '0.1.1-rc.1');
    for (const client of ['codex', 'claude-code']) await configure(client, 'configure');
    const held = new Peer(o.binary, ['mcp', '--project-dir', o.sourceRoot, '--read-only'], env);
    try {
      await held.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'm3-lifecycle', version: '1' } });
      held.notify('notifications/initialized');
      const before = object(object(await held.request('tools/call', { name: 'list', arguments: {} })).result);
      assert.equal(object(before.structuredContent).ok, true);
      const oldHub = hub; hub = join(dirname(hub), '이동한 지식 hub'); await rename(oldHub, hub);
      const args = ['connection', 'relocate-hub', '--from', oldHub, '--to', hub, '--knowledge-repo', '../knowledge.git'];
      const registryBefore = await readFile(join(o.configDir, 'connections.json'));
      const preview = object((await cli(args)).data);
      assert.equal(preview.changed, true);
      assert.deepEqual(await readFile(join(o.configDir, 'connections.json')), registryBefore);
      const applyArgs = [...args, '--apply', '--expect-plan', String(preview.planDigest)];
      const attempts = await Promise.allSettled([cli(applyArgs), cli(applyArgs)]);
      assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1, 'Concurrent stale plan must not apply twice');
      for (const attempt of attempts) if (attempt.status === 'rejected') {
        const reason = object(attempt.reason), stderr = reason.stderr;
        assert.equal(typeof stderr, 'string');
        const errors = object(JSON.parse(String(stderr))).errors;
        assert(Array.isArray(errors) && errors.some(e => ['CONNECTION_BUSY', 'CONNECTION_CONFLICT'].includes(String(object(e).code))));
      }
      const failure = object(object(await held.request('tools/call', { name: 'list', arguments: {} })).result);
      assert.equal(object(failure.structuredContent).ok, false);
      assert.equal(object(failure.structuredContent).data, null);
      assert.equal(object((await cli(args)).data).changed, false);
      await writeFile(join(o.evidence, 'm3-held-session.json'), JSON.stringify(held.messages, null, 2));
    } finally { await held.close(); }
    await readProjects();
    await install(baseline, '0.1.0');
    await install(candidate, '0.1.1-rc.1');
    await verifyInstalledM2Protocol({ ...o, hubRoot: hub });
    // A different launch path must update owned settings without touching user data.
    const alternatePackage = join(o.install, 'node_modules/buildlore-alternate');
    await cp(join(o.install, 'node_modules/buildlore'), alternatePackage, { recursive: true });
    const alternateBinary = join(alternatePackage, 'dist/cli/bin.js');
    for (const client of ['codex', 'claude-code']) await configure(client, 'configure', alternateBinary);
    for (const client of ['codex', 'claude-code']) await configure(client, 'configure');
    // Recover the documented wrong order: uninstall first, reinstall, then remove settings.
    const configuredFiles = [join(o.sourceRoot, '.codex/config.toml'), join(claudeConfig, '.claude.json')];
    const settingsBeforeUninstall = await Promise.all(configuredFiles.map(path => readFile(path)));
    const configBeforeUninstall = await tree(o.configDir);
    await run('npm', ['uninstall', '--no-audit', '--no-fund', 'buildlore'], o.install);
    await assert.rejects(lstat(o.binary));
    assert.deepEqual(await Promise.all(configuredFiles.map(path => readFile(path))), settingsBeforeUninstall);
    assert.equal((await tree(o.configDir)).digest, configBeforeUninstall.digest);
    assert.equal((await tree(join(hub, 'knowledge'))).digest, knowledgeBefore.digest);
    assert.deepEqual(await gitState(), gitBefore);
    await install(candidate, '0.1.1-rc.1');
    for (const client of ['codex', 'claude-code']) await configure(client, 'remove');
    const claude = object(JSON.parse(await readFile(join(claudeConfig, '.claude.json'), 'utf8')));
    assert.equal(claude.unrelated, 'preserve');
    assert.equal(await readFile(join(o.sourceRoot, '.codex/config.toml'), 'utf8'), preservedCodex);
    for (const file of ['AGENTS.md', 'CLAUDE.md']) assert.equal(await readFile(join(o.sourceRoot, file), 'utf8'), 'User-owned guidance.\n');
    for (const root of [o.sourceRoot, o.other.sourceRoot]) await cli(['disconnect'], root);
    await run('npm', ['uninstall', '--no-audit', '--no-fund', 'buildlore'], o.install);
    await assert.rejects(lstat(o.binary));
    assert.equal((await tree(join(hub, 'knowledge'))).digest, knowledgeBefore.digest);
    assert.deepEqual(await gitState(), gitBefore);
    assert.deepEqual(await readFile(join(hub, '.buildlore/local-projects.json')), writerBefore);
    assert.deepEqual(await readFile(join(o.sourceRoot, '.buildlore/sources.json')), sourceBefore);
    assert.deepEqual(await readFile(join(o.sourceRoot, '.buildlore/connection.json')), sharedBefore);
    const remaining = object(JSON.parse(await readFile(join(o.configDir, 'connections.json'), 'utf8')));
    assert(Array.isArray(remaining.bindings) && remaining.bindings.length >= 1, 'Unrelated worktree binding must remain');
    const summary = { schemaVersion: 'buildlore.m3-lifecycle-evidence.v1', passed: true,
      environment: { node: process.version, npm: (await run('npm', ['--version'])).stdout.trim(), platform: process.platform, arch: process.arch },
      packages: { baseline: { version: '0.1.0', sha256: hash(await readFile(baseline)) },
        candidate: { version: '0.1.1-rc.1', sha256: hash(await readFile(candidate)), compressedBytes: (await lstat(candidate)).size } },
      stages, commands, knowledgePreserved: true, knowledgeHeadAndIndexPreserved: true, writerRegistryPreserved: true, sourceManifestPreserved: true,
      concurrentRelocationGuardPassed: true, heldMcpSessionRejected: true, uninstallFirstRecoveryPassed: true,
      realAiClientCalls: 0, claudeActualClient: 'excluded by user; unverified',
      measurement: 'One Linux run using the existing npm cache. Each stage measures install plus prepared-fixture CLI page/evidence reads; development fixture preparation is outside each stage. Installed bytes sum regular files, exclude symlinks, and are not disk-block usage. No cold-install or statistical performance claim.' };
    await writeFile(join(o.evidence, 'm3-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  } finally {
    await writeFile(join(o.evidence, 'm3-commands.json'), JSON.stringify(commands, null, 2) + '\n');
  }
}
