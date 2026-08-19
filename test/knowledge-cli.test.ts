import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIo, type CliRuntime } from '../src/cli/index.js';

const temporaryRoots: string[] = [];
const compiler: NonNullable<CliRuntime['compiler']> = {
  status: () =>
    Promise.resolve({ pendingChanges: [], pendingChangesCount: 0, stateStatus: 'missing' }),
};

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

async function configureIdentity(repository: string): Promise<void> {
  await git(repository, ['config', 'user.name', 'BuildLore Test']);
  await git(repository, ['config', 'user.email', 'buildlore@example.invalid']);
}

async function createUnconfiguredRepository(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-knowledge-cli-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'knowledge'));
  return root;
}

async function createConfiguredRepository(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-knowledge-cli-git-'));
  temporaryRoots.push(root);
  const knowledgeOrigin = join(root, 'knowledge.git');
  const knowledgeSeed = join(root, 'knowledge-seed');
  const code = join(root, 'code');

  await git(root, ['init', '--bare', '--initial-branch=main', knowledgeOrigin]);
  await git(root, ['-c', 'protocol.file.allow=always', 'clone', knowledgeOrigin, knowledgeSeed]);
  await configureIdentity(knowledgeSeed);
  await writeFile(join(knowledgeSeed, 'README.md'), '# Knowledge fixture\n', 'utf8');
  await git(knowledgeSeed, ['add', 'README.md']);
  await git(knowledgeSeed, ['commit', '-m', 'seed knowledge']);
  await git(knowledgeSeed, ['push', 'origin', 'main']);

  await git(root, ['init', '--initial-branch=main', code]);
  await configureIdentity(code);
  await writeFile(join(code, 'README.md'), '# Code fixture\n', 'utf8');
  await git(code, ['add', 'README.md']);
  await git(code, ['commit', '-m', 'seed code']);
  const cloned = await capture(
    ['knowledge', 'clone', '--repository', '../knowledge.git', '--branch', 'main'],
    code,
  );
  if (cloned.exitCode !== 0) {
    throw new Error(`Knowledge clone fixture failed: ${cloned.stderr}`);
  }
  return code;
}

async function capture(
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
  return {
    exitCode: await runCli(args, io, { compiler, cwd }),
    stderr,
    stdout,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('knowledge and project CLI', () => {
  it('adds, lists, shows, and validates a project with deterministic JSON', async () => {
    const root = await createConfiguredRepository();
    const added = await capture(
      [
        'project',
        'add',
        '--project-id',
        'alpha',
        '--display-name',
        'Alpha',
        '--source-repository',
        'https://example.test/alpha.git',
      ],
      root,
    );
    expect(added.exitCode).toBe(0);
    expect(added.stderr).toBe('');
    expect(JSON.parse(added.stdout)).toMatchObject({
      data: { entry: { path: 'projects/alpha', projectId: 'alpha' } },
      ok: true,
    });

    const listed = await capture(['project', 'list'], root);
    expect(JSON.parse(listed.stdout)).toEqual({
      data: [
        {
          displayName: 'Alpha',
          path: 'projects/alpha',
          projectId: 'alpha',
          sourceRepository: 'https://example.test/alpha.git',
        },
      ],
      ok: true,
    });
    await expect(capture(['project', 'show', '--project-id', 'alpha'], root)).resolves.toMatchObject({
      exitCode: 0,
      stderr: '',
    });
    await expect(
      capture(['project', 'validate', '--project-id', 'alpha'], root),
    ).resolves.toMatchObject({ exitCode: 0, stderr: '' });
    const status = await capture(['knowledge', 'status', '--project-id', 'alpha'], root);
    expect(JSON.parse(status.stdout)).toMatchObject({
      data: {
        compiler: { pendingChangesCount: 0, stateStatus: 'missing' },
        pinState: 'matched',
        projectId: 'alpha',
        workspacePath: 'projects/alpha',
      },
      ok: true,
    });
  });

  it('returns a structured recovery result for an unconfigured submodule', async () => {
    const root = await createUnconfiguredRepository();
    const result = await capture(['knowledge', 'status'], root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      data: { knowledge: { state: 'unconfigured' }, ok: false },
      error: {
        code: 'KNOWLEDGE_NOT_CONFIGURED',
        recoveryCommand: ['knowledge', 'clone'],
      },
      ok: false,
    });
  });

  it('reports an unregistered project when a ready repository has no manifest', async () => {
    const root = await createConfiguredRepository();
    const shown = await capture(['project', 'show', '--project-id', 'missing'], root);
    expect(shown.exitCode).toBe(1);
    expect(JSON.parse(shown.stderr)).toMatchObject({
      error: { code: 'PROJECT_NOT_FOUND', recoveryCommand: ['project', 'list'] },
      ok: false,
    });
  });

  it('validates a selected project id before reflecting status data', async () => {
    const root = await createUnconfiguredRepository();
    const secret = 'TOKEN=do-not-reflect';
    const result = await capture(['knowledge', 'status', '--project-id', secret], root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain(secret);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'MANIFEST_INVALID' },
      ok: false,
    });
  });

  it('does not reflect credential-bearing or unsupported input', async () => {
    const root = await createConfiguredRepository();
    const secret = 'https://user:do-not-reflect@example.test/private.git';
    const rejected = await capture(
      [
        'project',
        'add',
        '--project-id',
        'private',
        '--display-name',
        'Private',
        '--source-repository',
        secret,
      ],
      root,
    );
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).not.toContain('do-not-reflect');
    expect(rejected.stdout).toBe('');

    const unsupported = await capture(['token=do-not-reflect'], root);
    expect(unsupported.exitCode).toBe(2);
    expect(unsupported.stderr).toBe('Unsupported command. Run buildlore --help for usage.\n');
  });

  it('blocks project writes until the knowledge submodule is ready', async () => {
    const root = await createUnconfiguredRepository();
    const result = await capture(
      [
        'project',
        'add',
        '--project-id',
        'alpha',
        '--display-name',
        'Alpha',
        '--source-repository',
        'https://example.test/alpha.git',
      ],
      root,
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'KNOWLEDGE_NOT_CONFIGURED' },
      ok: false,
    });
  });

  it('rejects unsupported project options as usage errors before reading repository state', async () => {
    const root = await createUnconfiguredRepository();
    const result = await capture(
      [
        'project',
        'add',
        '--project-id',
        'alpha',
        '--display-name',
        'Alpha',
        '--source-repository',
        'https://example.test/alpha.git',
        '--profile-version',
        'future.profile.v2',
      ],
      root,
    );
    expect(result).toEqual({
      exitCode: 2,
      stderr: 'Unsupported command. Run buildlore --help for usage.\n',
      stdout: '',
    });
  });

  it('returns the approved flat status fields and restores an uninitialized submodule', async () => {
    const root = await createConfiguredRepository();
    const ready = await capture(['knowledge', 'status'], root);
    const readyPayload = JSON.parse(ready.stdout) as {
      readonly data: {
        readonly currentCommit: string;
        readonly pinnedCommit: string;
      };
    };
    expect(readyPayload).toMatchObject({
      data: {
        initialized: true,
        pinState: 'matched',
        projectId: null,
        schemaVersion: 'buildlore.status.v1',
        workspacePath: null,
      },
      ok: true,
    });
    expect(readyPayload.data.currentCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(readyPayload.data.pinnedCommit).toMatch(/^[0-9a-f]{40}$/u);

    await git(root, ['submodule', 'deinit', '-f', '--', 'knowledge']);
    const uninitialized = await capture(['knowledge', 'status'], root);
    expect(JSON.parse(uninitialized.stderr)).toMatchObject({
      data: { initialized: false, pinState: 'uninitialized' },
      error: { code: 'SUBMODULE_UNINITIALIZED' },
      ok: false,
    });
    await expect(capture(['knowledge', 'init'], root)).resolves.toMatchObject({
      exitCode: 0,
      stderr: '',
    });
  });

  it('returns a domain validation error for an incomplete project workspace', async () => {
    const root = await createConfiguredRepository();
    await capture(
      [
        'project',
        'add',
        '--project-id',
        'alpha',
        '--display-name',
        'Alpha',
        '--source-repository',
        'https://example.test/alpha.git',
      ],
      root,
    );
    await rm(join(root, 'knowledge', 'projects', 'alpha', 'sources'), { recursive: true });
    const shown = await capture(['project', 'show', '--project-id', 'alpha'], root);
    expect(shown.exitCode).toBe(1);
    expect(JSON.parse(shown.stderr)).toMatchObject({
      error: { code: 'MANIFEST_INVALID', recoveryCommand: ['project', 'validate'] },
      ok: false,
    });
  });
});
