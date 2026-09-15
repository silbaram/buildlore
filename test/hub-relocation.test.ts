import { mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertConnectionCurrent, connectProject, relocateHub, resolveConnection } from '../src/connection/service.js';
import { runCli } from '../src/cli/run-cli.js';
import { connectedFixture, git } from './helpers/connected-fixture.js';

describe('explicit hub relocation', () => {
  it('previews without writes, relocates one hub mapping and invalidates held capabilities', async () => {
    const f = await connectedFixture();
    try {
      const extra = join(f.root, '추가 worktree');
      await git(f.sourceRoot, 'worktree', 'add', '-b', 'relocation-extra', extra);
      await connectProject(extra, { hub: f.hubRoot, projectId: f.projectId, sourceRepository: 'https://example.test/parcel.git' }, { configDir: f.configDir });
      const local = join(f.configDir, 'connections.json');
      const before = await readFile(local, 'utf8');
      const shared = await readFile(join(f.sourceRoot, '.buildlore/connection.json'));
      const writer = await readFile(join(f.hubRoot, '.buildlore/local-projects.json'));
      const to = join(f.root, '옮긴 지식 허브');
      await rename(f.hubRoot, to);
      const input = { from: f.hubRoot, to, knowledgeRepository: '../knowledge.git' };
      const options = { configDir: f.configDir };
      const entries = await readdir(f.configDir, { recursive: true });
      const plan = await relocateHub(input, options);
      expect(plan).toMatchObject({ affectedBindings: 2, changed: true, applied: false });
      expect(JSON.stringify(plan)).not.toContain(f.root);
      expect(await relocateHub(input, options)).toEqual(plan);
      expect(await readFile(local, 'utf8')).toBe(before);
      expect(await readdir(f.configDir, { recursive: true })).toEqual(entries);
      await expect(resolveConnection(extra, options)).rejects.toMatchObject({ code: 'HUB_UNAVAILABLE' });
      await relocateHub({ ...input, apply: true, expectedPlan: plan.planDigest }, options);
      const after = JSON.parse(await readFile(local, 'utf8')) as { bindings: unknown; hubs: { hubRoot: string }[] };
      expect(after.bindings).toEqual((JSON.parse(before) as { bindings: unknown }).bindings);
      expect(after.hubs[0]?.hubRoot).toBe(to);
      for (const root of [f.sourceRoot, extra]) expect(await resolveConnection(root, options)).toMatchObject({ projectId: f.projectId });
      await expect(assertConnectionCurrent(f.context)).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
      expect(await readFile(join(f.sourceRoot, '.buildlore/connection.json'))).toEqual(shared);
      expect(await readFile(join(to, '.buildlore/local-projects.json'))).toEqual(writer);
      await expect(relocateHub({ ...input, apply: true, expectedPlan: plan.planDigest }, options)).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
      const again = await relocateHub(input, options), stable = await readFile(local);
      expect(again.changed).toBe(false);
      await relocateHub({ ...input, apply: true, expectedPlan: again.planDigest }, options);
      expect(await readFile(local)).toEqual(stable);
    } finally { await f.cleanup(); }
  }, 30000);

  it('rejects stale registry and target snapshots, identity changes, and symlink destinations', async () => {
    const f = await connectedFixture();
    try {
      const options = { configDir: f.configDir }, to = join(f.root, 'new-hub');
      await rename(f.hubRoot, to);
      const input = { from: f.hubRoot, to, knowledgeRepository: '../knowledge.git' };
      const local = join(f.configDir, 'connections.json');
      const plan = await relocateHub(input, options);
      await writeFile(local, (await readFile(local, 'utf8')) + '\n');
      await expect(relocateHub({ ...input, apply: true, expectedPlan: plan.planDigest }, options)).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
      const fresh = await relocateHub(input, options), before = await readFile(local);
      const gm = join(to, '.gitmodules');
      await expect(relocateHub({ ...input, apply: true, expectedPlan: fresh.planDigest }, options, {
        beforeReplace: async () => { await writeFile(gm, (await readFile(gm, 'utf8')) + '\n# concurrent edit\n'); },
      })).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
      expect(await readFile(local)).toEqual(before);
      const alias = join(f.root, 'alias'); await symlink(to, alias);
      await expect(relocateHub({ ...input, to: alias }, options)).rejects.toMatchObject({ code: 'READ_BOUNDARY_VIOLATION' });
      await expect(relocateHub({ ...input, from: f.sourceRoot }, options)).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
      await expect(relocateHub({ ...input, knowledgeRepository: '../other.git' }, options)).rejects.toMatchObject({ code: 'CONNECTION_MISSING' });
      await git(to, 'config', '--file', '.gitmodules', 'submodule.knowledge.url', '../other.git');
      await expect(relocateHub(input, options)).rejects.toMatchObject({ code: 'KNOWLEDGE_IDENTITY_MISMATCH' });
    } finally { await f.cleanup(); }
  }, 30000);

  it('keeps an old or new complete registry through interruptions and never steals a held lock', async () => {
    const f = await connectedFixture();
    try {
      const options = { configDir: f.configDir }, to = join(f.root, 'new-hub');
      await rename(f.hubRoot, to);
      const input = { from: f.hubRoot, to, knowledgeRepository: '../knowledge.git' };
      const plan = await relocateHub(input, options), local = join(f.configDir, 'connections.json');
      const before = await readFile(local);
      const apply = { ...input, apply: true, expectedPlan: plan.planDigest };
      await expect(relocateHub(apply, options, { beforeReplace: () => Promise.reject(new Error('interruption')) })).rejects.toMatchObject({ code: 'CONNECTION_WRITE_FAILED' });
      expect(await readFile(local)).toEqual(before);
      const lock = join(f.configDir, 'locks/registry.lock'); await writeFile(lock, 'held');
      await expect(relocateHub(apply, options)).rejects.toMatchObject({ code: 'CONNECTION_BUSY' });
      expect(await readFile(lock, 'utf8')).toBe('held');
      await unlink(lock);
      await expect(relocateHub(apply, options, { afterReplace: () => Promise.reject(new Error('interruption')) })).rejects.toMatchObject({ code: 'CONNECTION_WRITE_FAILED' });
      expect((await relocateHub(input, options)).changed).toBe(false);
      expect(await resolveConnection(f.sourceRoot, options)).toMatchObject({ projectId: f.projectId });
    } finally { await f.cleanup(); }
  }, 30000);

  it('validates CLI apply pairing and emits a path-free hub management result outside a source checkout', async () => {
    const f = await connectedFixture();
    try {
      const to = join(f.root, 'new-hub'); await rename(f.hubRoot, to);
      const cwd = join(f.root, 'plain-directory'); await mkdir(cwd);
      const args = ['connection', 'relocate-hub', '--from', f.hubRoot, '--to', to, '--knowledge-repo', '../knowledge.git', '--json'];
      const invoke = async (extra: string[]) => {
        let output = '';
        const code = await runCli([...args, ...extra], { stdout: s => { output += s; }, stderr: s => { output += s; } }, { cwd, configDir: f.configDir });
        return { code, output, value: JSON.parse(output) as { data: { planDigest: `sha256:${string}`; changed: boolean }; projectId: string | null } };
      };
      const preview = await invoke([]);
      expect(preview.code).toBe(0); expect(preview.value.projectId).toBeNull();
      expect(preview.output).not.toContain(f.root);
      expect((await invoke(['--apply'])).code).toBe(2);
      expect((await invoke(['--expect-plan', preview.value.data.planDigest])).code).toBe(2);
      expect((await invoke(['--project', 'parcel'])).code).toBe(2);
      expect((await invoke(['--apply', '--expect-plan', preview.value.data.planDigest])).code).toBe(0);
    } finally { await f.cleanup(); }
  }, 30000);
});
