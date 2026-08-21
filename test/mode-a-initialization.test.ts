import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '../src/cli/index.js';
import {
  initializeModeAWorkspace,
  ModeAInitializationError,
  readManifest,
} from '../src/knowledge/index.js';

const temporaryRoots: string[] = [];

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`Git fixture command failed: ${stderr}`, { cause: error }));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-mode-a-'));
  temporaryRoots.push(root);
  return root;
}

async function configureIdentity(repository: string): Promise<void> {
  await git(repository, ['config', 'user.name', 'BuildLore Test']);
  await git(repository, ['config', 'user.email', 'buildlore@example.invalid']);
}

async function createKnowledgeOrigin(
  root: string,
  name = 'knowledge.git',
  options: { readonly unsafeManifestSymlink?: boolean } = {},
): Promise<void> {
  const origin = join(root, name);
  const seed = join(root, `${name}-seed`);
  await git(root, ['init', '--bare', '--initial-branch=main', origin]);
  await git(root, ['-c', 'protocol.file.allow=always', 'clone', origin, seed]);
  await configureIdentity(seed);
  await writeFile(join(seed, 'README.md'), '# Knowledge fixture\n', 'utf8');
  if (options.unsafeManifestSymlink === true) {
    await symlink('../external.txt', join(seed, 'manifest.json'));
  }
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-m', 'seed knowledge']);
  await git(seed, ['push', 'origin', 'main']);
}

async function captureCli(
  args: readonly string[],
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  let stderr = '';
  let stdout = '';
  const io: CliIo = {
    stderr: (message) => {
      stderr += message;
    },
    stdout: (message) => {
      stdout += message;
    },
  };
  return { exitCode: await runCli(args, io, { cwd }), stderr, stdout };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('Mode A workspace initialization', () => {
  it('initializes an empty non-Git directory and converges idempotently on retry', async () => {
    const root = await createTemporaryRoot();
    await createKnowledgeOrigin(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace);

    const result = await initializeModeAWorkspace(workspace, {
      branch: 'main',
      repository: '../knowledge.git',
    });

    expect(result).toMatchObject({
      completedStages: [
        'git-ready',
        'submodule-ready',
        'manifest-ready',
        'ignore-policy-ready',
      ],
      gitRepository: 'created',
      ignorePolicy: 'created',
      knowledge: { branch: 'main', path: 'knowledge', state: 'ready' },
      manifest: 'created',
      schemaVersion: 'buildlore.mode-a-init.v1',
    });
    await expect(git(workspace, ['rev-parse', '--show-toplevel'])).resolves.toBe(workspace);
    await expect(readManifest(join(workspace, 'knowledge'))).resolves.toEqual({
      projects: [],
      schemaVersion: 'buildlore.knowledge.v1',
    });
    await expect(readFile(join(workspace, 'knowledge', '.gitignore'), 'utf8')).resolves.toContain(
      '**/.llmwiki/embeddings/**',
    );

    await expect(
      initializeModeAWorkspace(workspace, {
        branch: 'main',
        repository: '../knowledge.git',
      }),
    ).resolves.toMatchObject({
      gitRepository: 'existing',
      ignorePolicy: 'existing',
      manifest: 'existing',
    });

    const cliResult = await captureCli(
      ['init', '--knowledge-repo', '../knowledge.git', '--branch', 'main', '--json'],
      workspace,
    );
    expect(cliResult.exitCode).toBe(0);
    const cliPayload = JSON.parse(cliResult.stdout) as {
      readonly knowledgeRevision: unknown;
    };
    expect(cliPayload).toMatchObject({
      command: 'init',
      data: { gitRepository: 'existing', manifest: 'existing' },
      ok: true,
      partial: false,
    });
    expect(cliPayload.knowledgeRevision).toMatch(/^[0-9a-f]{40}$/u);

    const bindingBefore = await readFile(join(workspace, '.gitmodules'), 'utf8');
    await expect(
      initializeModeAWorkspace(workspace, {
        branch: 'other',
        repository: '../knowledge.git',
      }),
    ).rejects.toMatchObject({ code: 'SUBMODULE_MISMATCH' });
    await expect(readFile(join(workspace, '.gitmodules'), 'utf8')).resolves.toBe(bindingBefore);
  }, 30_000);

  it('rejects a non-empty non-Git directory without changing user bytes', async () => {
    const root = await createTemporaryRoot();
    await createKnowledgeOrigin(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'keep.txt'), 'keep exactly\n', 'utf8');

    const result = await captureCli(
      ['init', '--knowledge-repo', '../knowledge.git', '--branch', 'main', '--json'],
      workspace,
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      command: 'init',
      errors: [{ code: 'WORKSPACE_NOT_EMPTY' }],
      ok: false,
      partial: false,
    });
    await expect(readFile(join(workspace, 'keep.txt'), 'utf8')).resolves.toBe('keep exactly\n');
    await expect(pathExists(join(workspace, '.git'))).resolves.toBe(false);
  }, 30_000);

  it('keeps a generated .git, reports partial progress, and completes on matching retry', async () => {
    const root = await createTemporaryRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace);

    let failure: unknown;
    try {
      await initializeModeAWorkspace(workspace, {
        branch: 'main',
        repository: '../missing.git',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModeAInitializationError);
    expect(failure).toMatchObject({
      code: 'GIT_ACCESS_DENIED',
      completedStages: ['git-ready'],
      partial: true,
    });
    await expect(pathExists(join(workspace, '.git'))).resolves.toBe(true);
    await expect(pathExists(join(workspace, '.gitmodules'))).resolves.toBe(false);
    await expect(pathExists(join(workspace, 'knowledge'))).resolves.toBe(false);

    const diagnostic = await captureCli(
      ['init', '--knowledge-repo', '../missing.git', '--branch', 'main', '--json'],
      workspace,
    );
    expect(diagnostic.exitCode).toBe(6);
    expect(JSON.parse(diagnostic.stderr)).toMatchObject({
      command: 'init',
      data: { completedStages: ['git-ready'] },
      errors: [{ code: 'GIT_ACCESS_DENIED' }],
      partial: true,
    });

    await createKnowledgeOrigin(root, 'missing.git');
    await expect(
      initializeModeAWorkspace(workspace, {
        branch: 'main',
        repository: '../missing.git',
      }),
    ).resolves.toMatchObject({
      gitRepository: 'existing',
      knowledge: { state: 'ready' },
      manifest: 'created',
    });
  }, 30_000);

  it('rejects an escaping registry asset before external writes and completes after repair', async () => {
    const root = await createTemporaryRoot();
    await createKnowledgeOrigin(root, 'knowledge.git', { unsafeManifestSymlink: true });
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await git(workspace, ['init', '--initial-branch=main']);
    await writeFile(join(workspace, 'external.txt'), 'outside stays unchanged\n', 'utf8');

    await expect(
      initializeModeAWorkspace(workspace, {
        branch: 'main',
        repository: '../knowledge.git',
      }),
    ).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_KNOWLEDGE',
      completedStages: ['git-ready', 'submodule-ready'],
      partial: true,
    });
    await expect(readFile(join(workspace, 'external.txt'), 'utf8')).resolves.toBe(
      'outside stays unchanged\n',
    );

    await unlink(join(workspace, 'knowledge', 'manifest.json'));
    await expect(
      initializeModeAWorkspace(workspace, {
        branch: 'main',
        repository: '../knowledge.git',
      }),
    ).resolves.toMatchObject({ manifest: 'created' });
    await expect(readFile(join(workspace, 'external.txt'), 'utf8')).resolves.toBe(
      'outside stays unchanged\n',
    );
  }, 30_000);

  it('rejects credential-bearing input before Git mutation or diagnostic reflection', async () => {
    const root = await createTemporaryRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const secret = 'https://user:do-not-reflect@example.test/knowledge.git';

    const result = await captureCli(
      ['init', '--knowledge-repo', secret, '--json'],
      workspace,
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).not.toContain('do-not-reflect');
    expect(JSON.parse(result.stderr)).toMatchObject({
      errors: [{ code: 'MANIFEST_INVALID' }],
      partial: false,
    });
    await expect(pathExists(join(workspace, '.git'))).resolves.toBe(false);
  });
});
