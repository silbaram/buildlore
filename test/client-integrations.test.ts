import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectedFixture, git } from './helpers/connected-fixture.js';
import { configureClient, type ClientOptions } from '../src/integrations/service.js';
import { editSetting, launchSnippet } from '../src/integrations/settings.js';

describe('client configuration ownership', () => {
  it.each(['codex', 'claude-code'] as const)('previews, applies, reuses and removes %s without changing user content', async client => {
    const f = await connectedFixture();
    const target = client === 'codex' ? join(f.sourceRoot, '.codex', 'config.toml') : join(f.root, 'claude.json');
    const original = client === 'codex' ? '# User comment\nmodel = "chosen"' : '{ "user": 9007199254740991, "projects": {} }\n';
    try {
      if (client === 'codex') await mkdir(join(f.sourceRoot, '.codex'));
      await writeFile(target, original);
      const base: ClientOptions = { client, projectDir: f.sourceRoot, operation: 'configure', nodePath: process.execPath, binPath: join(f.root, 'bin.js'), configDir: f.configDir, claudeConfigPath: target };
      const preview = await configureClient(base); expect(await readFile(target, 'utf8')).toBe(original);
      const applied = await configureClient({ ...base, apply: true, expectedPlan: preview.planDigest }); expect(applied.applied).toBe(true);
      const configured = await readFile(target, 'utf8'), mtime = (await stat(target)).mtimeMs;
      expect(configured).toContain('BUILDLORE_CONFIG_DIR');
      expect(configured).toContain(f.configDir);
      const again = await configureClient(base); expect(again.changed).toBe(false);
      await configureClient({ ...base, apply: true, expectedPlan: again.planDigest }); expect((await stat(target)).mtimeMs).toBe(mtime);
      if (client === 'codex') {
        const exclude = join(f.sourceRoot, '.git/info/exclude');
        await writeFile(exclude, '# user ignore rules\n');
        const restore = await configureClient(base); expect(restore.changed).toBe(true);
        await configureClient({ ...base, apply: true, expectedPlan: restore.planDigest });
        expect(await readFile(exclude, 'utf8')).toContain('/.codex/config.toml');
        expect((await stat(target)).mtimeMs).toBe(mtime);
      }
      const remove = await configureClient({ ...base, operation: 'remove' });
      await configureClient({ ...base, operation: 'remove', apply: true, expectedPlan: remove.planDigest });
      const after = await readFile(target, 'utf8');
      if (client === 'codex') expect(after).toBe(original); else { expect(after).toContain('9007199254740991'); expect(after).not.toContain(applied.serverName); }
      expect(configured).toContain(applied.serverName);
    } finally { await f.cleanup(); }
  }, 20000);
  it('rejects stale previews and tracked Codex settings', async () => {
    const f = await connectedFixture();
    try {
      await mkdir(join(f.sourceRoot, '.codex'));
      const target = join(f.sourceRoot, '.codex/config.toml'); await writeFile(target, '# user\n');
      const options: ClientOptions = { client: 'codex', projectDir: f.sourceRoot, operation: 'configure', nodePath: process.execPath, binPath: join(f.root, 'bin.js'), configDir: f.configDir };
      const preview = await configureClient(options); await writeFile(target, '# changed\n');
      await expect(configureClient({ ...options, apply: true, expectedPlan: preview.planDigest })).rejects.toMatchObject({ code: 'CLIENT_PLAN_CHANGED' });
      expect(await readFile(target, 'utf8')).toBe('# changed\n');
      await git(f.sourceRoot, 'add', '-f', '.codex/config.toml');
      await expect(configureClient(options)).rejects.toMatchObject({ code: 'CLIENT_CONFIG_TRACKED' });
    } finally { await f.cleanup(); }
  }, 20000);
  it.each(['journal', 'exclude', 'config'] as const)('recovers an interrupted %s without rewriting unrelated bytes', async stage => {
    const f = await connectedFixture();
    try {
      const options: ClientOptions = { client: 'codex', projectDir: f.sourceRoot, operation: 'configure', nodePath: process.execPath, binPath: join(f.root, 'bin.js'), configDir: f.configDir };
      const plan = await configureClient(options);
      await expect(configureClient({ ...options, apply: true, expectedPlan: plan.planDigest, afterStage: at => { if (stage === at) return Promise.reject(new Error('Injected failure')); return Promise.resolve(); } })).rejects.toThrow('Injected failure');
      const retry = await configureClient(options);
      await configureClient({ ...options, apply: true, expectedPlan: retry.planDigest });
      expect((await configureClient(options)).changed).toBe(false);
    } finally { await f.cleanup(); }
  }, 20000);
  it('never overwrites a user-owned name or parses duplicate JSON keys', () => {
    const snippet = launchSnippet('codex', 'buildlore-test', { command: '/node', args: ['/bin'] });
    expect(() => editSetting('codex', '[mcp_servers.buildlore-test]\ncommand="user"\n', '/project', 'buildlore-test', null, snippet)).toThrow();
    expect(() => editSetting('claude-code', '{"projects":{},"projects":{}}', '/project', 'buildlore-test', null, '{}')).toThrow();
  });
  it('rejects an owned marker moved into user text or extended with user keys', () => {
    const name = 'buildlore-review';
    const owned = launchSnippet('codex', name, { command: '/node', args: ['/bin', 'mcp', '--project-dir', '/project', '--read-only'] });
    const embedded = "notes = '''\n" + owned + "'''\n";
    expect(() => editSetting('codex', embedded, '/project', name, owned, null)).toThrow();
    expect(() => editSetting('codex', owned + 'user_setting = "keep"\n', '/project', name, owned, null)).toThrow();
  });
  it.each(['local-negation', 'repository-negation'] as const)('requires effective Git protection for %s', async kind => {
    const f = await connectedFixture();
    try {
      await writeFile(join(f.sourceRoot, '.git/info/exclude'), '/.codex/config.toml\n!/.codex/config.toml\n');
      if (kind === 'repository-negation') await writeFile(join(f.sourceRoot, '.gitignore'), '!/.codex/config.toml\n');
      const options: ClientOptions = { client: 'codex', projectDir: f.sourceRoot, operation: 'configure', nodePath: process.execPath, binPath: join(f.root, 'bin.js'), configDir: f.configDir };
      const plan = await configureClient(options);
      const apply = configureClient({ ...options, apply: true, expectedPlan: plan.planDigest });
      if (kind === 'repository-negation') {
        await expect(apply).rejects.toMatchObject({ code: 'CLIENT_CONFIG_NOT_IGNORED' });
        await expect(readFile(join(f.sourceRoot, '.codex/config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        await apply;
        await expect(git(f.sourceRoot, 'check-ignore', '--no-index', '--quiet', '--', '.codex/config.toml')).resolves.toBe('');
      }
    } finally { await f.cleanup(); }
  }, 20000);
  it('serializes a shared Claude file across independent BuildLore config directories', async () => {
    const a = await connectedFixture(), b = await connectedFixture();
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    let first: Promise<unknown> | undefined, entered = false;
    try {
      const target = join(a.root, 'shared-claude.json'); await writeFile(target, '{}\n');
      const options = (f: typeof a): ClientOptions => ({ client: 'claude-code', operation: 'configure', projectDir: f.sourceRoot, configDir: f.configDir, nodePath: process.execPath, binPath: join(f.root, 'bin.js'), claudeConfigPath: target });
      const pa = await configureClient(options(a)), pb = await configureClient(options(b));
      first = configureClient({ ...options(a), apply: true, expectedPlan: pa.planDigest, afterStage: at => {
        if (at === 'journal') { entered = true; return held; } return Promise.resolve();
      } });
      await expect.poll(() => entered).toBe(true);
      await expect(configureClient({ ...options(b), apply: true, expectedPlan: pb.planDigest })).rejects.toMatchObject({ code: 'CLIENT_CONFIG_BUSY' });
      release(); await first;
      const retry = await configureClient(options(b));
      await configureClient({ ...options(b), apply: true, expectedPlan: retry.planDigest });
      const text = await readFile(target, 'utf8'); expect(text).toContain(pa.serverName); expect(text).toContain(pb.serverName);
    } finally { release(); await first?.catch(() => undefined); await a.cleanup(); await b.cleanup(); }
  }, 20000);
});
