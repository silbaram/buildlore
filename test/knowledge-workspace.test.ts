import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeKnowledgeWorkspace, resolveWorkspaceLayout } from '../src/knowledge/knowledge-workspace.js';
import { containsPath, isRemoteRepository } from '../src/knowledge/repository-paths.js';

const roots: string[] = [];
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-workspace-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.org/team/knowledge.git'], { cwd: root });
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 3 }))); });

describe('knowledge repository workspace', () => {
  it('initializes the repository itself without replacing package or knowledge files, and is idempotent', async () => {
    const root = await repository();
    await writeFile(join(root, 'package.json'), '{"private":true}\n');
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    await writeFile(join(root, '.gitignore'), '# user rules\ncustom/\n');
    await mkdir(join(root, 'node_modules'));
    expect(await initializeKnowledgeWorkspace(root)).toMatchObject({ outcome: 'created', mode: 'knowledge' });
    const ignore = await readFile(join(root, '.gitignore'), 'utf8');
    const marker = await readFile(join(root, '.buildlore/workspace.json'), 'utf8');
    expect(ignore).toContain('# user rules\ncustom/\n');
    expect(execFileSync('git', ['check-ignore', 'node_modules/example/file'], { cwd: root, encoding: 'utf8' })).toContain('node_modules/example/file');
    expect(await initializeKnowledgeWorkspace(root)).toMatchObject({ outcome: 'existing' });
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(ignore);
    expect(await readFile(join(root, '.buildlore/workspace.json'), 'utf8')).toBe(marker);
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe('{"private":true}\n');
    expect(await readFile(join(root, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3}\n');
    expect(await resolveWorkspaceLayout(root)).toEqual({ mode: 'knowledge', root, knowledgeRoot: root });
  });
  it('keeps unmarked legacy paths and fails closed on damaged or mismatched explicit markers', async () => {
    const root = await repository();
    expect((await resolveWorkspaceLayout(root)).knowledgeRoot).toBe(join(root, 'knowledge'));
    await initializeKnowledgeWorkspace(root);
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://example.org/other.git'], { cwd: root });
    await expect(resolveWorkspaceLayout(root)).rejects.toMatchObject({ code: 'KNOWLEDGE_IDENTITY_MISMATCH' });
    await writeFile(join(root, '.buildlore/workspace.json'), '{"mode":"knowledge"}');
    await expect(resolveWorkspaceLayout(root)).rejects.toThrow();
  });
  it('rejects source checkouts, legacy hubs, unsafe parents and symlink ignore files before initialization', async () => {
    for (const file of ['.gitmodules', '.buildlore/connection.json', '.buildlore/sources.json']) {
      const root = await repository();
      await mkdir(join(root, '.buildlore'), { recursive: true });
      await writeFile(join(root, file), '{}');
      await expect(initializeKnowledgeWorkspace(root)).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
    }
    const root = await repository();
    await writeFile(join(root, 'keep.txt'), 'preserved');
    await symlink('keep.txt', join(root, '.gitignore'));
    await expect(initializeKnowledgeWorkspace(root)).rejects.toThrow();
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('preserved');
  });
  it('requires an explicit portable identity when there is no origin', async () => {
    const root = await repository();
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: root });
    await expect(initializeKnowledgeWorkspace(root)).rejects.toThrow();
    await expect(initializeKnowledgeWorkspace(root, 'https://example.org/team/knowledge.git')).resolves.toMatchObject({ outcome: 'created' });
  });
  it('restores effective local exclusions after negations and preserves the user rules on repeat', async () => {
    const root = await repository();
    const original = '/node_modules/\n!/node_modules/\n/.buildlore/hierarchy-runs/\n!/.buildlore/hierarchy-runs/\n';
    await writeFile(join(root, '.gitignore'), original);
    await mkdir(join(root, 'node_modules/demo'), { recursive: true });
    await mkdir(join(root, '.buildlore/hierarchy-runs/demo'), { recursive: true });
    await writeFile(join(root, 'node_modules/demo/index.js'), 'fixture');
    await writeFile(join(root, '.buildlore/hierarchy-runs/demo/run.json'), '{}');
    await initializeKnowledgeWorkspace(root);
    const ignore = await readFile(join(root, '.gitignore'), 'utf8');
    expect(ignore.startsWith(original)).toBe(true);
    for (const path of ['node_modules/demo/index.js', '.buildlore/hierarchy-runs/demo/run.json']) {
      expect(execFileSync('git', ['check-ignore', '--', path], { cwd: root, encoding: 'utf8' }).trim()).toBe(path);
    }
    await initializeKnowledgeWorkspace(root);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(ignore);
  });
  it('replaces a hardlinked ignore file without modifying the other repository', async () => {
    const root = await repository(), external = await repository();
    const content = '# external rules\ncustom/\n';
    await writeFile(join(external, '.gitignore'), content);
    await link(join(external, '.gitignore'), join(root, '.gitignore'));
    await initializeKnowledgeWorkspace(root);
    expect(await readFile(join(external, '.gitignore'), 'utf8')).toBe(content);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('/node_modules/');
  });
  it('refuses to declare success when local-only files are already tracked', async () => {
    const root = await repository();
    await mkdir(join(root, 'node_modules/demo'), { recursive: true });
    await writeFile(join(root, 'node_modules/demo/index.js'), 'fixture');
    execFileSync('git', ['add', 'node_modules'], { cwd: root });
    await expect(initializeKnowledgeWorkspace(root)).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
    await expect(readFile(join(root, '.buildlore/workspace.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(execFileSync('git', ['ls-files', '--', 'node_modules'], { cwd: root, encoding: 'utf8' })).toContain('node_modules/demo/index.js');
  });
});

describe('repository paths', () => {
  it('distinguishes Windows drives from remote Git locators', () => {
    for (const value of ['C:/repos/wiki.git', 'D:\\repos\\wiki.git', '../wiki.git', '\\\\server\\share\\wiki']) expect(isRemoteRepository(value)).toBe(false);
    for (const value of ['git@example.org:team/wiki.git', 'https://example.org/wiki.git', 'ssh://example.org/wiki.git']) expect(isRemoteRepository(value)).toBe(true);
  });
  it('confines same and descendant paths with actual platform semantics', () => {
    expect(containsPath('C:\\Hub', 'c:\\hub\\child', win32)).toBe(true);
    expect(containsPath('C:\\Hub', 'C:\\Hub-other', win32)).toBe(false);
    expect(containsPath('C:\\Hub', 'D:\\Hub', win32)).toBe(false);
    expect(containsPath('/hub', '/hub/..notes', posix)).toBe(true);
    expect(containsPath('/hub', '/hub-other', posix)).toBe(false);
  });
});
