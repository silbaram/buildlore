import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run-cli.js';
import { workspaceGuide } from '../src/application/workspace-guide.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { initializeKnowledgeWorkspace } from '../src/knowledge/knowledge-workspace.js';
import { readLocalProjectRegistry } from '../src/knowledge/local-project-registry.js';
import { readManifest, writeManifest } from '../src/knowledge/registry.js';
import { addProject } from '../src/knowledge/workspace.js';
import { createBuiltInProfileBinding, createProfileBindingV2 } from '../src/profile/bindings.js';
import { git } from './helpers/connected-fixture.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(sources: readonly unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-registration-'));
  roots.push(root);
  const knowledge = join(root, 'knowledge');
  const source = join(root, 'source');
  const sourceRepository = 'https://example.test/parcel.git';
  await mkdir(knowledge);
  await mkdir(join(source, '.buildlore'), { recursive: true });
  await git(knowledge, 'init');
  await git(source, 'init');
  await initializeKnowledgeWorkspace(knowledge, 'https://example.test/knowledge.git');
  await writeFile(join(source, 'settings.json'), '{"storage":"SQLite"}\n');
  await writeFile(join(source, 'README.md'), '# Parcel\nStores data in SQLite.\n');
  const sourceManifest = serializeCanonicalJson({ projectId: 'parcel', schemaVersion: 'buildlore.sources.v2', sourceRepository, sources });
  await writeFile(join(source, '.buildlore/sources.json'), sourceManifest);
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'source fixture');
  const cli = async (args: readonly string[]) => {
    let stdout = '', stderr = '';
    const code = await runCli([...args, '--json'], {
      stdout: v => { stdout += v; }, stderr: v => { stderr += v; },
    }, { cwd: knowledge });
    return { code, stdout, stderr };
  };
  const register = () => cli(['project', 'add', '--id', 'parcel', '--source-repo', sourceRepository, '--source-root', source]);
  return { knowledge, source, sourceRepository, sourceManifest, cli, register };
}

const jsonSource = { adapterId: 'buildlore.json', adapterVersion: 1, id: 'settings', kind: 'json', path: 'settings.json', pathType: 'file' };

describe('project registration profile configuration', () => {
  it.each([false, true])('reads JSON without manual profile setup (already declared: %s)', async declared => {
    const f = await fixture(declared ? [jsonSource] : []);
    expect(await f.register()).toMatchObject({ code: 0, stderr: '' });
    expect(await readFile(join(f.source, '.buildlore/sources.json'), 'utf8')).toBe(f.sourceManifest);
    if (!declared) {
      expect((await workspaceGuide(f.knowledge, 'parcel')).checks.find(c => c.id === 'sources')?.reasonCode).toBe('SOURCE_DECLARATIONS_REQUIRED');
      expect(await f.cli(['source', 'add', '--project', 'parcel', '--id', 'settings', '--kind', 'json', '--path', 'settings.json']))
        .toMatchObject({ code: 0, stderr: '' });
    }
    const guide = await workspaceGuide(f.knowledge, 'parcel');
    expect(guide.checks.find(c => c.id === 'sources')?.reasonCode).toBe('SOURCE_DECLARATIONS_VALID');
    expect(guide.checks.find(c => c.id === 'approval')?.reasonCode).toBe('APPROVAL_REQUIRED');
    expect(await f.cli(['source', 'list', '--project', 'parcel'])).toMatchObject({ code: 0, stderr: '' });
    const sync = await f.cli(['sync', '--project', 'parcel', '--dry-run']);
    expect(sync, sync.stderr).toMatchObject({ code: 0, stderr: '' });
    expect(sync.stdout).toContain('settings');
  });

  it.each(['valid', 'incompatible', 'corrupt'] as const)('preserves an existing %s profile when adopting a workspace', async state => {
    const f = await fixture([jsonSource]);
    await addProject(f.knowledge, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: f.sourceRepository });
    await writeManifest(f.knowledge, { schemaVersion: 'buildlore.knowledge.v1', projects: [] });
    const path = join(f.knowledge, 'projects/parcel/profile-binding.json');
    const bytes = state === 'corrupt' ? '{broken' : serializeCanonicalJson(
      state === 'valid' ? createProfileBindingV2('general', 'en') : createBuiltInProfileBinding('general', 'en'));
    await writeFile(path, bytes);
    const result = await f.register();
    if (state === 'valid') expect(result).toMatchObject({ code: 0, stderr: '' });
    else {
      expect(result.code).not.toBe(0);
      expect((await readManifest(f.knowledge)).projects).toEqual([]);
      expect((await readLocalProjectRegistry(f.knowledge)).bindings).toEqual([]);
    }
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(await readFile(join(f.source, '.buildlore/sources.json'), 'utf8')).toBe(f.sourceManifest);
  });

  it('rejects unknown adapters before registering a project', async () => {
    const f = await fixture([{ ...jsonSource, adapterId: 'unknown.adapter' }]);
    const result = await f.register();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('SOURCE_KIND_UNSUPPORTED');
    expect(result.stderr).toContain('profile-binding.json');
    expect((await readManifest(f.knowledge)).projects).toEqual([]);
    expect((await readLocalProjectRegistry(f.knowledge)).bindings).toEqual([]);
    await expect(readFile(join(f.knowledge, 'projects/parcel/project.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects declarations that require a different profile and rolls registration back', async () => {
    const f = await fixture([{ adapterId: 'buildlore.p2a', adapterVersion: 1, id: 'planning', kind: 'planning', path: 'README.md', pathType: 'file' }]);
    const result = await f.register();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('SOURCE_KIND_UNSUPPORTED');
    expect((await readManifest(f.knowledge)).projects).toEqual([]);
    expect((await readLocalProjectRegistry(f.knowledge)).bindings).toEqual([]);
    await expect(readFile(join(f.knowledge, 'projects/parcel/profile-binding.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds an explicitly declared optional JSON adapter', async () => {
    const f = await fixture([{ adapterId: 'buildlore.p2a-run', adapterVersion: 1, id: 'runs', kind: 'json', path: 'artifacts/runs/run-index.json', pathType: 'file' }]);
    expect(await f.register()).toMatchObject({ code: 0, stderr: '' });
    expect((await workspaceGuide(f.knowledge, 'parcel')).checks.find(c => c.id === 'sources')?.reasonCode).toBe('SOURCE_DECLARATIONS_VALID');
  });
});
