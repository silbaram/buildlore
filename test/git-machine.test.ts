import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GitMachineAdapter,
  parseCachedDiffRawZ,
  parsePorcelainV2Z,
} from '../src/knowledge/git-machine.js';

const temporaryRoots: string[] = [];

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
        maxBuffer: 1024 * 1024,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`Git test fixture command failed: ${stderr}`, { cause: error }));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function createRepository(prefix = 'buildlore-git-machine-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'BuildLore Test']);
  await git(root, ['config', 'user.email', 'buildlore@example.invalid']);
  await writeFile(join(root, 'tracked.txt'), 'initial\n', 'utf8');
  await git(root, ['add', 'tracked.txt']);
  await git(root, ['commit', '-m', 'initial']);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('Git porcelain-v2 and raw cached-diff parsers', () => {
  it('preserves hostile paths and consumes rename records by NUL ordering', () => {
    const oid = 'a'.repeat(40);
    const hostile = ' -leading\tline\n한글.md';
    const renameLike = '2 R. N... looks-like-metadata';
    const output = Buffer.concat([
      Buffer.from(`1 M. N... 100644 100644 100644 ${oid} ${oid} ${hostile}\0`, 'utf8'),
      Buffer.from(`2 R. N... 100644 100644 100644 ${oid} ${oid} R100 renamed.md\0`, 'utf8'),
      Buffer.from(`${renameLike}\0`, 'utf8'),
      Buffer.from('? -dash\t이름\n.md\0', 'utf8'),
    ]);

    expect(parsePorcelainV2Z(output)).toEqual([
      expect.objectContaining({ kind: 'ordinary', path: hostile }),
      expect.objectContaining({
        kind: 'renamed',
        originalPath: renameLike,
        path: 'renamed.md',
        score: 'R100',
      }),
      { kind: 'untracked', path: '-dash\t이름\n.md' },
    ]);
  });

  it('parses rename raw records and rejects human or unbounded output', () => {
    const oldOid = 'a'.repeat(40);
    const newOid = 'b'.repeat(40);
    const raw = Buffer.concat([
      Buffer.from(`:100644 100644 ${oldOid} ${newOid} R087\0`, 'utf8'),
      Buffer.from('old\tname\n.md\0new 유니코드.md\0', 'utf8'),
    ]);
    expect(parseCachedDiffRawZ(raw)).toEqual([
      {
        newMode: '100644',
        newOid,
        oldMode: '100644',
        oldOid,
        originalPath: 'old\tname\n.md',
        path: 'new 유니코드.md',
        status: 'R087',
      },
    ]);
    expect(() => parsePorcelainV2Z(Buffer.from(' M human-output\n', 'utf8'))).toThrowError(
      expect.objectContaining({ code: 'GIT_MACHINE_OUTPUT_INVALID' }),
    );
    expect(() =>
      parsePorcelainV2Z(Buffer.alloc(1025), { maxOutputBytes: 1024 }),
    ).toThrowError(expect.objectContaining({ code: 'GIT_MACHINE_OUTPUT_LIMIT' }));
  });
});

describe('GitMachineAdapter', () => {
  it('uses exact Buffer pathspecs and plumbing for hostile paths without shell interpretation', async () => {
    const repository = await createRepository();
    const adapter = new GitMachineAdapter();
    const hostilePaths = [' leading space.md', '-leading-dash.md', 'tab\tname.md', 'line\nbreak.md', '한글.md'];
    await Promise.all(
      hostilePaths.map(async (path, index) =>
        writeFile(join(repository, path), `content ${String(index)}\n`, 'utf8'),
      ),
    );
    await writeFile(join(repository, 'tracked.txt'), 'changed\n', 'utf8');

    const status = await adapter.status(repository);
    expect(status.filter((entry) => entry.kind === 'untracked').map((entry) => entry.path).sort()).toEqual(
      [...hostilePaths].sort(),
    );
    await adapter.addExact(repository, [...hostilePaths, 'tracked.txt']);
    const cached = await adapter.cachedDiff(repository);
    expect(cached.map((entry) => entry.path).sort()).toEqual([...hostilePaths, 'tracked.txt'].sort());

    const parent = await git(repository, ['rev-parse', 'HEAD']);
    const tree = await adapter.writeTree(repository);
    const commit = await adapter.commitTree(
      repository,
      tree,
      [parent],
      Buffer.from('buildlore machine commit\n', 'utf8'),
    );
    await adapter.updateRefCompareAndSwap(repository, 'refs/heads/main', commit, parent);
    await expect(adapter.cachedDiff(repository)).resolves.toEqual([]);
    await expect(
      adapter.updateRefCompareAndSwap(repository, 'refs/heads/main', parent, parent),
    ).rejects.toMatchObject({ code: 'GIT_REF_RACE' });
    for (const path of hostilePaths) {
      await expect(readFile(join(repository, path), 'utf8')).resolves.toMatch(/^content/u);
    }
  });

  it('normalizes exact remote lookup, fetch, ancestry, and non-force push', async () => {
    const repository = await createRepository();
    const remoteRoot = await mkdtemp(join(tmpdir(), 'buildlore-git-machine-remote-'));
    temporaryRoots.push(remoteRoot);
    const bare = join(remoteRoot, 'origin.git');
    await git(remoteRoot, ['init', '--bare', '--initial-branch=main', bare]);
    await git(repository, ['remote', 'add', 'origin', bare]);
    await git(repository, ['push', 'origin', 'main']);

    const adapter = new GitMachineAdapter();
    const remoteBase = await git(repository, ['rev-parse', 'HEAD']);
    await expect(adapter.lsRemoteExact(repository, 'origin', 'refs/heads/main')).resolves.toBe(
      remoteBase,
    );
    await expect(adapter.lsRemoteExact(repository, 'origin', 'refs/heads/missing')).resolves.toBeNull();

    await writeFile(join(repository, 'tracked.txt'), 'next\n', 'utf8');
    await adapter.addExact(repository, ['tracked.txt']);
    const tree = await adapter.writeTree(repository);
    const next = await adapter.commitTree(
      repository,
      tree,
      [remoteBase],
      Buffer.from('next machine commit\n', 'utf8'),
    );
    await adapter.updateRefCompareAndSwap(repository, 'refs/heads/main', next, remoteBase);
    await expect(adapter.isAncestor(repository, remoteBase, next)).resolves.toBe(true);
    await expect(adapter.isAncestor(repository, next, remoteBase)).resolves.toBe(false);
    await adapter.pushExactNonForce(repository, 'origin', next, 'refs/heads/main');
    await expect(adapter.lsRemoteExact(repository, 'origin', 'refs/heads/main')).resolves.toBe(next);

    const consumer = await createRepository('buildlore-git-machine-consumer-');
    await git(consumer, ['remote', 'add', 'origin', bare]);
    await adapter.fetchObjectNoRefUpdate(consumer, 'origin', next);
    await expect(git(consumer, ['cat-file', '-e', `${next}^{commit}`])).resolves.toBe('');
    await expect(lstat(join(consumer, '.git', 'FETCH_HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails with a bounded stable code when machine output exceeds its cap', async () => {
    const repository = await createRepository();
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(repository, `untracked-${String(index).padStart(3, '0')}-${'x'.repeat(32)}.md`), 'x\n', 'utf8');
    }
    const adapter = new GitMachineAdapter({ maxOutputBytes: 1024 });
    await expect(adapter.status(repository)).rejects.toMatchObject({
      code: 'GIT_MACHINE_OUTPUT_LIMIT',
      message: 'Git machine output exceeded the configured limit.',
    });
  });
});
