import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { assertConnectionCurrent, connectProject, disconnectProject, resolveConnection, setupHub } from '../src/connection/service.js';
import { connectedFixture, git } from './helpers/connected-fixture.js';

describe('local read connection lifecycle', () => {
  it('does not resolve a trailing-space checkout as a different sibling repository', async () => {
    const f = await connectedFixture();
    try {
      const sibling = `${f.sourceRoot} `;
      await mkdir(sibling);
      await git(sibling, 'init');
      expect(await resolveConnection(sibling, { configDir: f.configDir })).toBeNull();
      const input = { hub: f.hubRoot, projectId: f.projectId, sourceRepository: 'https://example.test/parcel.git' };
      await connectProject(sibling, input, { configDir: f.configDir });
      expect(await readFile(join(sibling, '.buildlore/connection.json'), 'utf8')).toBeTruthy();
      await disconnectProject(sibling, true, { configDir: f.configDir });
      expect(await resolveConnection(f.sourceRoot, { configDir: f.configDir })).not.toBeNull();
    } finally { await f.cleanup(); }
  }, 20000);
  it('invalidates an issued capability when the local hub mapping changes', async () => {
    const first = await connectedFixture();
    const second = await connectedFixture();
    try {
      const path = join(first.configDir, 'connections.json');
      const registry = JSON.parse(await readFile(path, 'utf8')) as { hubs: { hubRoot: string }[] };
      for (const hub of registry.hubs) hub.hubRoot = second.hubRoot;
      await writeFile(path, JSON.stringify(registry));
      // A fresh resolution may adopt an explicit local reconfiguration. A held
      // capability must never silently switch to that other physical repository.
      expect(await resolveConnection(first.sourceRoot, { configDir: first.configDir })).not.toBeNull();
      await expect(assertConnectionCurrent(first.context)).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
    } finally { await first.cleanup(); await second.cleanup(); }
  }, 30000);
  it('is idempotent, preserves writer state, resolves subdirectories and rejects nested repositories', async () => {
    const f = await connectedFixture();
    try {
      const shared = join(f.sourceRoot, '.buildlore/connection.json'), local = join(f.configDir, 'connections.json');
      const before = await Promise.all([readFile(shared), readFile(local), readFile(join(f.hubRoot, '.buildlore/local-projects.json')), readFile(join(f.sourceRoot, '.buildlore/sources.json'))]);
      const options = { configDir: f.configDir }, input = { hub: f.hubRoot, projectId: f.projectId, sourceRepository: 'https://example.test/parcel.git' };
      await connectProject(f.sourceRoot, input, options);
      expect(await Promise.all([readFile(shared), readFile(local), readFile(join(f.hubRoot, '.buildlore/local-projects.json')), readFile(join(f.sourceRoot, '.buildlore/sources.json'))])).toEqual(before);
      expect(await resolveConnection(join(f.sourceRoot, 'docs'), options)).toMatchObject({ projectId: f.projectId });
      await symlink(join(f.sourceRoot, 'docs'), join(f.sourceRoot, 'linked'));
      expect(await resolveConnection(join(f.sourceRoot, 'linked'), options)).toMatchObject({ projectId: f.projectId });
      await mkdir(join(f.sourceRoot, 'nested'));
      await git(join(f.sourceRoot, 'nested'), 'init');
      expect(await resolveConnection(join(f.sourceRoot, 'nested'), options)).toBeNull();
      await disconnectProject(f.sourceRoot, false, options);
      expect(await readFile(shared)).toEqual(before[0]);
      await expect(resolveConnection(f.sourceRoot, options)).rejects.toMatchObject({ code: 'CONNECTION_INCOMPLETE' });
      await connectProject(f.sourceRoot, input, options);
      await disconnectProject(f.sourceRoot, true, options);
      expect(await resolveConnection(f.sourceRoot, options)).toBeNull();
    } finally { await f.cleanup(); }
  }, 20000);
  it('repairs interrupted shared-first connect without altering the shared document', async () => {
    const f = await connectedFixture();
    try {
      const options = { configDir: f.configDir }, input = { hub: f.hubRoot, projectId: f.projectId, sourceRepository: 'https://example.test/parcel.git' };
      await disconnectProject(f.sourceRoot, true, options);
      await expect(connectProject(f.sourceRoot, input, options, { afterSharedWrite: () => Promise.reject(new Error('injected interruption')) })).rejects.toThrow();
      const before = await readFile(join(f.sourceRoot, '.buildlore/connection.json'));
      await expect(resolveConnection(f.sourceRoot, options)).rejects.toMatchObject({ code: 'CONNECTION_INCOMPLETE' });
      await connectProject(f.sourceRoot, input, options);
      expect(await readFile(join(f.sourceRoot, '.buildlore/connection.json'))).toEqual(before);
      await writeFile(join(f.configDir, 'locks/registry.lock'), '');
      await expect(disconnectProject(f.sourceRoot, false, options)).rejects.toMatchObject({ code: 'CONNECTION_BUSY' });
    } finally { await f.cleanup(); }
  }, 20000);
  it('rejects symlink configs, changed origins and a moved checkout', async () => {
    const f = await connectedFixture();
    try {
      const options = { configDir: f.configDir };
      await git(f.sourceRoot, 'remote', 'add', 'origin', 'https://example.test/other.git');
      await expect(resolveConnection(f.sourceRoot, options)).rejects.toMatchObject({ code: 'SOURCE_IDENTITY_MISMATCH' });
      await git(f.sourceRoot, 'remote', 'remove', 'origin');
      await rename(join(f.configDir, 'connections.json'), join(f.root, 'registry.json'));
      await symlink(join(f.root, 'registry.json'), join(f.configDir, 'connections.json'));
      await expect(resolveConnection(f.sourceRoot, options)).rejects.toMatchObject({ code: 'CONNECTION_INVALID' });
    } finally { await f.cleanup(); }
  }, 20000);
  it('registers an existing hub and never overwrites an unrelated Git repository', async () => {
    const f = await connectedFixture();
    try {
      expect(await setupHub(f.hubRoot, '../knowledge.git', { configDir: f.configDir })).toMatchObject({ outcome: 'unchanged' });
      await expect(setupHub(f.sourceRoot, '../knowledge.git', { configDir: f.configDir })).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
      await expect(setupHub(f.hubRoot, '../other.git', { configDir: f.configDir })).rejects.toMatchObject({ code: 'KNOWLEDGE_IDENTITY_MISMATCH' });
    } finally { await f.cleanup(); }
  }, 20000);
});

describe('clones and worktrees', () => {
  it('binds another worktree to the same project and rejects replacement of its original root', async () => {
    const f = await connectedFixture();
    try {
      const extra = join(f.root, '추가 작업 트리'), options = { configDir: f.configDir };
      await git(f.sourceRoot, 'worktree', 'add', '-b', 'connected-extra', extra);
      const input = { hub: f.hubRoot, projectId: f.projectId, sourceRepository: 'https://example.test/parcel.git' };
      await connectProject(extra, input, options);
      await mkdir(join(extra, '한글 하위 폴더'));
      expect(await resolveConnection(join(extra, '한글 하위 폴더'), options)).toMatchObject({ projectId: f.projectId });
      await disconnectProject(extra, false, options);
      expect(await resolveConnection(f.sourceRoot, options)).toMatchObject({ projectId: f.projectId });
      await rename(f.sourceRoot, join(f.root, 'moved-source'));
      await git(f.root, 'clone', join(f.root, 'moved-source'), f.sourceRoot);
      await git(f.sourceRoot, 'remote', 'remove', 'origin');
      await mkdir(join(f.sourceRoot, '.buildlore'));
      await writeFile(join(f.sourceRoot, '.buildlore/connection.json'), await readFile(join(f.root, 'moved-source/.buildlore/connection.json')));
      await expect(resolveConnection(f.sourceRoot, options)).rejects.toMatchObject({ code: 'SOURCE_IDENTITY_MISMATCH' });
      await disconnectProject(f.sourceRoot, false, options);
      const replacement = await connectProject(f.sourceRoot, input, options);
      expect(await assertConnectionCurrent(replacement)).toMatchObject({ projectId: f.projectId });
      await expect(assertConnectionCurrent(f.context)).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
    } finally { await f.cleanup(); }
  }, 20000);
});
