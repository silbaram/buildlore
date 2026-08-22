import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveGitCommonDirectory } from '../src/knowledge/git.js';
import {
  RepositoryWriterLeaseManager,
  type RepositoryWriterLease,
} from '../src/knowledge/repository-writer-lease.js';
import { withRegistryLock } from '../src/knowledge/registry.js';

const LEASE_FILE_NAME = 'buildlore.repository-writer.lock';
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
          GIT_CONFIG_GLOBAL: '/dev/null',
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

async function createRepository(): Promise<{
  readonly container: string;
  readonly repository: string;
}> {
  const container = await mkdtemp(join(tmpdir(), 'buildlore-repository-lease-'));
  temporaryRoots.push(container);
  const repository = join(container, 'repository');
  await mkdir(repository);
  await git(repository, ['init', '--initial-branch=main']);
  await git(repository, ['config', 'user.name', 'BuildLore Test']);
  await git(repository, ['config', 'user.email', 'buildlore@example.invalid']);
  await writeFile(join(repository, 'README.md'), '# fixture\n', 'utf8');
  await git(repository, ['add', 'README.md']);
  await git(repository, ['commit', '-m', 'initial']);
  return { container, repository };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('RepositoryWriterLeaseManager', () => {
  it('creates an exclusive 0600 common-dir lease and releases it after phase updates', async () => {
    const { repository } = await createRepository();
    const commonDirectory = await resolveGitCommonDirectory(repository);
    const leasePath = join(commonDirectory, LEASE_FILE_NAME);
    const manager = new RepositoryWriterLeaseManager();

    const result = await manager.withLease(repository, 'commit', async (lease) => {
      const metadata = await lstat(leasePath);
      expect(metadata.mode & 0o777).toBe(0o600);
      const acquired = JSON.parse(await readFile(leasePath, 'utf8')) as unknown;
      expect(acquired).toMatchObject({
        operation: 'commit',
        phase: 'acquired',
      });
      expect(isRecord(acquired) && typeof acquired.token === 'string').toBe(true);
      if (!isRecord(acquired) || typeof acquired.token !== 'string') throw new Error('invalid lease');
      expect(acquired.token).toMatch(/^[0-9a-f]{64}$/u);
      await lease.updatePhase('write-tree');
      const updated = JSON.parse(await readFile(leasePath, 'utf8')) as unknown;
      expect(updated).toMatchObject({
        operation: 'commit',
        phase: 'write-tree',
      });
      expect(isRecord(updated) && typeof updated.token === 'string').toBe(true);
      if (!isRecord(updated) || typeof updated.token !== 'string') throw new Error('invalid lease');
      expect(updated.token).toMatch(/^[0-9a-f]{64}$/u);
      expect(lease.repositoryIdentityDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(lease.repositoryIdentityDigest).not.toContain(commonDirectory);
      return 'released';
    });

    expect(result).toBe('released');
    await expect(lstat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('makes worktrees sharing one common directory contend without waiting or mutating', async () => {
    const { container, repository } = await createRepository();
    const worktree = join(container, 'secondary-worktree');
    await git(repository, ['worktree', 'add', '-b', 'secondary', worktree]);
    await expect(resolveGitCommonDirectory(worktree)).resolves.toBe(
      await resolveGitCommonDirectory(repository),
    );

    const acquired = deferred();
    const release = deferred();
    const first = new RepositoryWriterLeaseManager({ afterAcquire: acquired.resolve });
    const secondAction = vi.fn<(lease: RepositoryWriterLease) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const held = first.withLease(repository, 'commit', async () => {
      await release.promise;
      return 'winner';
    });
    await acquired.promise;

    await expect(
      new RepositoryWriterLeaseManager().withLease(worktree, 'push', secondAction),
    ).rejects.toMatchObject({
      code: 'REPOSITORY_BUSY',
      message: 'Repository Git mutation is already in progress.',
    });
    expect(secondAction).not.toHaveBeenCalled();
    release.resolve();
    await expect(held).resolves.toBe('winner');
  });

  it('never takes over a stale lease and does not expose its path or contents', async () => {
    const { repository } = await createRepository();
    const commonDirectory = await resolveGitCommonDirectory(repository);
    const leasePath = join(commonDirectory, LEASE_FILE_NAME);
    const staleSentinel = 'stale-owner-metadata';
    await writeFile(leasePath, staleSentinel, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const action = vi.fn<() => void>();

    let caught: unknown;
    try {
      await new RepositoryWriterLeaseManager().withLease(repository, 'commit', action);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'REPOSITORY_BUSY' });
    expect(String(caught)).not.toContain(leasePath);
    expect(String(caught)).not.toContain(staleSentinel);
    expect(action).not.toHaveBeenCalled();
    await expect(readFile(leasePath, 'utf8')).resolves.toBe(staleSentinel);
  });

  it('rechecks token and inode ownership and preserves a lease that changed in place', async () => {
    const { repository } = await createRepository();
    const commonDirectory = await resolveGitCommonDirectory(repository);
    const leasePath = join(commonDirectory, LEASE_FILE_NAME);
    const replacementToken = 'b'.repeat(64);
    const manager = new RepositoryWriterLeaseManager({
      beforeRelease: async () =>
        writeFile(
          leasePath,
          `${JSON.stringify({ operation: 'commit', phase: 'changed', token: replacementToken })}\n`,
          'utf8',
        ),
    });

    await expect(manager.withLease(repository, 'commit', () => 'value')).rejects.toMatchObject({
      code: 'REPOSITORY_OWNERSHIP_LOST',
    });
    await expect(readFile(leasePath, 'utf8')).resolves.toContain(replacementToken);
  });

  it('does not unlink a replacement lease with a different inode', async () => {
    const { repository } = await createRepository();
    const commonDirectory = await resolveGitCommonDirectory(repository);
    const leasePath = join(commonDirectory, LEASE_FILE_NAME);
    const movedPath = join(commonDirectory, 'moved-repository-writer.lock');
    const replacement = 'replacement-owner\n';
    const manager = new RepositoryWriterLeaseManager({
      beforeRelease: async () => {
        await rename(leasePath, movedPath);
        await writeFile(leasePath, replacement, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      },
    });

    await expect(manager.withLease(repository, 'parent-pin', () => 'value')).rejects.toMatchObject({
      code: 'REPOSITORY_OWNERSHIP_LOST',
    });
    await expect(readFile(leasePath, 'utf8')).resolves.toBe(replacement);
    await expect(readFile(movedPath, 'utf8')).resolves.toContain('"operation":"parent-pin"');
  });

  it('returns a stable release failure and preserves the lease when release cannot start', async () => {
    const { repository } = await createRepository();
    const commonDirectory = await resolveGitCommonDirectory(repository);
    const leasePath = join(commonDirectory, LEASE_FILE_NAME);
    const manager = new RepositoryWriterLeaseManager({
      beforeRelease: () => {
        throw new Error('injected release failure');
      },
    });

    await expect(manager.withLease(repository, 'push', () => 'value')).rejects.toMatchObject({
      code: 'REPOSITORY_RELEASE_FAILED',
    });
    await expect(lstat(leasePath)).resolves.toMatchObject({ mode: 0o100600 });
  });

  it('keeps compiler, manifest, and repository mutation locks independent', async () => {
    const { repository } = await createRepository();
    const commonDirectory = await resolveGitCommonDirectory(repository);
    const leasePath = join(commonDirectory, LEASE_FILE_NAME);
    const compilerDirectory = join(repository, 'projects', 'alpha', '.llmwiki');
    const compilerLock = join(compilerDirectory, 'lock');
    const manifestLock = join(repository, 'manifest.json.lock');
    await mkdir(compilerDirectory, { recursive: true });
    await writeFile(compilerLock, 'compiler-owned\n', 'utf8');

    await new RepositoryWriterLeaseManager().withLease(repository, 'commit', async () => {
      await expect(readFile(compilerLock, 'utf8')).resolves.toBe('compiler-owned\n');
      await withRegistryLock(repository, async () => {
        await expect(lstat(leasePath)).resolves.toMatchObject({ mode: 0o100600 });
        await expect(lstat(manifestLock)).resolves.toMatchObject({ mode: 0o100600 });
        await expect(readFile(compilerLock, 'utf8')).resolves.toBe('compiler-owned\n');
      });
      await expect(lstat(manifestLock)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    await expect(readFile(compilerLock, 'utf8')).resolves.toBe('compiler-owned\n');

    await writeFile(manifestLock, 'registry-owned\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await expect(
      new RepositoryWriterLeaseManager().withLease(repository, 'push', () => 'independent'),
    ).resolves.toBe('independent');
    await expect(readFile(manifestLock, 'utf8')).resolves.toBe('registry-owned\n');
    await unlink(manifestLock);
  });

  it('allows independent common directories to hold Git mutation leases concurrently', async () => {
    const firstRepository = await createRepository();
    const secondRepository = await createRepository();
    const firstEntered = deferred();
    const secondEntered = deferred();
    const release = deferred();

    const first = new RepositoryWriterLeaseManager().withLease(
      firstRepository.repository,
      'commit',
      async () => {
        firstEntered.resolve();
        await secondEntered.promise;
        await release.promise;
        return 'first';
      },
    );
    const second = new RepositoryWriterLeaseManager().withLease(
      secondRepository.repository,
      'push',
      async () => {
        secondEntered.resolve();
        await firstEntered.promise;
        await release.promise;
        return 'second';
      },
    );
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
  });
});
