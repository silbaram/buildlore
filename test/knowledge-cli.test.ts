import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIo, type CliRuntime } from '../src/cli/index.js';
import { readLocalProjectRegistry } from '../src/knowledge/local-project-registry.js';
import { addProject } from '../src/knowledge/workspace.js';

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

async function createSourceRepository(
  hubRoot: string,
  projectId: string,
  sourceRepository: string,
  checkoutName = projectId,
): Promise<string> {
  const sourceRoot = join(hubRoot, '..', `${checkoutName}-source`);
  await mkdir(sourceRoot);
  await git(sourceRoot, ['init', '--initial-branch=main']);
  await configureIdentity(sourceRoot);
  await mkdir(join(sourceRoot, '.buildlore'));
  await mkdir(join(sourceRoot, 'docs'));
  await writeFile(join(sourceRoot, 'docs', 'overview.md'), `# ${projectId}\n`, 'utf8');
  await writeFile(
    join(sourceRoot, '.buildlore', 'sources.json'),
    JSON.stringify({
      projectId,
      schemaVersion: 'buildlore.sources.v1',
      sourceRepository,
      sources: [{
        documentKind: 'markdown',
        id: 'docs',
        path: 'docs',
        pathType: 'directory',
        recursive: true,
      }],
    }, null, 2) + '\n',
    'utf8',
  );
  await git(sourceRoot, ['add', '.']);
  await git(sourceRoot, ['commit', '-m', 'seed source']);
  return sourceRoot;
}

async function capture(
  args: readonly string[],
  cwd: string,
  overrides: Partial<CliRuntime> = {},
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
    exitCode: await runCli(args, io, { compiler, cwd, ...overrides }),
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
  it('initializes ignored hub-local state without changing a sibling source checkout', async () => {
    const root = await createConfiguredRepository();
    const sourceRoot = await createSourceRepository(
      root,
      'source-probe',
      'https://example.test/source-probe.git',
    );
    const before = await git(sourceRoot, ['status', '--porcelain=v2', '--untracked-files=all']);

    const initialized = await capture(
      ['init', '--knowledge-repo', '../knowledge.git', '--branch', 'main', '--json'],
      root,
    );

    expect(initialized).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      data: { localProjects: { bindingCount: 0, outcome: 'created' } },
      ok: true,
    });
    expect(JSON.parse(await readFile(join(root, '.buildlore/local-projects.json'), 'utf8')))
      .toEqual({ bindings: [], schemaVersion: 'buildlore.local-projects.v1' });
    expect(await git(sourceRoot, ['status', '--porcelain=v2', '--untracked-files=all']))
      .toBe(before);
  });

  it('adds, lists, shows, and validates a project with deterministic JSON', async () => {
    const root = await createConfiguredRepository();
    const sourceRepository = 'https://example.test/alpha.git';
    const sourceRoot = await createSourceRepository(root, 'alpha', sourceRepository);
    const added = await capture(
      [
        'project',
        'add',
        '--project-id',
        'alpha',
        '--display-name',
        'Alpha',
        '--source-repository',
        sourceRepository,
        '--source-root',
        sourceRoot,
        '--json',
      ],
      root,
    );
    expect(added.exitCode).toBe(0);
    expect(added.stderr).toBe('');
    expect(JSON.parse(added.stdout)).toMatchObject({
      data: {
        binding: { outcome: 'created' },
        entry: { path: 'projects/alpha', projectId: 'alpha' },
        localSource: { manifestStatus: 'ready', state: 'ready' },
      },
      ok: true,
    });

    const listed = await capture(['project', 'list', '--json'], root);
    expect(JSON.parse(listed.stdout)).toMatchObject({
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
    const status = await capture(
      ['knowledge', 'status', '--project-id', 'alpha', '--json'],
      root,
    );
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

  it('rolls back portable registration when the local binding commit fails', async () => {
    const root = await createConfiguredRepository();
    const sourceRepository = 'https://example.test/atomic.git';
    const sourceRoot = await createSourceRepository(root, 'atomic', sourceRepository);
    const command = [
      'project',
      'add',
      '--id',
      'atomic',
      '--source-repo',
      sourceRepository,
      '--source-root',
      sourceRoot,
      '--json',
    ] as const;

    const failed = await capture(command, root, {
      localProjectRegistryHooks: {
        beforeRename: () => Promise.reject(new Error('injected local registry failure')),
      },
    });
    expect(failed).toMatchObject({ exitCode: 4, stdout: '' });
    expect(failed.stderr).not.toContain(sourceRoot);
    expect(JSON.parse(failed.stderr)).toMatchObject({
      errors: [{ code: 'SOURCE_BINDING_WRITE_FAILED' }],
      ok: false,
    });
    expect((await readLocalProjectRegistry(root, { allowMissing: true })).bindings).toEqual([]);
    await expect(stat(join(root, 'knowledge/projects/atomic'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const afterFailure = JSON.parse(
      (await capture(['project', 'list', '--json'], root)).stdout,
    ) as { readonly data: readonly { readonly projectId: string }[] };
    expect(afterFailure.data.map((project) => project.projectId)).not.toContain('atomic');

    const retried = await capture(command, root);
    expect(retried).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(retried.stdout)).toMatchObject({
      data: {
        binding: { outcome: 'created' },
        entry: { projectId: 'atomic' },
      },
      ok: true,
    });
  });

  it('returns a structured recovery result for an unconfigured submodule', async () => {
    const root = await createUnconfiguredRepository();
    const result = await capture(['knowledge', 'status', '--json'], root);
    expect(result.exitCode).toBe(6);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      data: { knowledge: { state: 'unconfigured' }, ok: false },
      errors: [
        {
          code: 'KNOWLEDGE_NOT_CONFIGURED',
          recoveryCommand: ['knowledge', 'clone'],
        },
      ],
      ok: false,
      partial: true,
    });
  });

  it('reports an unregistered project when a ready repository has no manifest', async () => {
    const root = await createConfiguredRepository();
    const shown = await capture(
      ['project', 'show', '--project-id', 'missing', '--json'],
      root,
    );
    expect(shown.exitCode).toBe(2);
    expect(JSON.parse(shown.stderr)).toMatchObject({
      errors: [{ code: 'PROJECT_NOT_FOUND', recoveryCommand: ['project', 'list'] }],
      ok: false,
    });
  });

  it('validates a selected project id before reflecting status data', async () => {
    const root = await createUnconfiguredRepository();
    const secret = 'TOKEN=do-not-reflect';
    const result = await capture(
      ['knowledge', 'status', '--project-id', secret, '--json'],
      root,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain(secret);
    expect(JSON.parse(result.stderr)).toMatchObject({
      errors: [{ code: 'CLI_ARGUMENT_INVALID' }],
      projectId: null,
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
        '--source-root',
        '/not-used',
      ],
      root,
    );
    expect(rejected.exitCode).toBe(3);
    expect(rejected.stderr).not.toContain('do-not-reflect');
    expect(rejected.stdout).toBe('');

    const unsupported = await capture(['token=do-not-reflect'], root);
    expect(unsupported.exitCode).toBe(2);
    expect(unsupported.stderr).toBe(
      'unknown: failed\n' +
      'error CLI_COMMAND_UNSUPPORTED: Command usage is invalid. Run buildlore --help for usage.\n',
    );
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
        '--source-root',
        '/not-used',
        '--json',
      ],
      root,
    );
    expect(result.exitCode).toBe(6);
    expect(JSON.parse(result.stderr)).toMatchObject({
      errors: [{ code: 'KNOWLEDGE_NOT_CONFIGURED' }],
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
        '--source-root',
        '/not-used',
        '--profile-version',
        'future.profile.v2',
      ],
      root,
    );
    expect(result).toEqual({
      exitCode: 2,
      stderr:
        'project.add: failed\n' +
        'error CLI_OPTION_UNSUPPORTED: Command usage is invalid. Run buildlore --help for usage.\n',
      stdout: '',
    });
  });

  it('returns the approved flat status fields and restores an uninitialized submodule', async () => {
    const root = await createConfiguredRepository();
    const ready = await capture(['knowledge', 'status', '--json'], root);
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
    const uninitialized = await capture(['knowledge', 'status', '--json'], root);
    expect(JSON.parse(uninitialized.stderr)).toMatchObject({
      data: { initialized: false, pinState: 'uninitialized' },
      errors: [{ code: 'SUBMODULE_UNINITIALIZED' }],
      ok: false,
    });
    await expect(capture(['knowledge', 'init'], root)).resolves.toMatchObject({
      exitCode: 0,
      stderr: '',
    });
  });

  it('returns a domain validation error for an incomplete project workspace', async () => {
    const root = await createConfiguredRepository();
    const sourceRepository = 'https://example.test/alpha.git';
    const sourceRoot = await createSourceRepository(root, 'alpha', sourceRepository);
    await capture(
      [
        'project',
        'add',
        '--project-id',
        'alpha',
        '--display-name',
        'Alpha',
        '--source-repository',
        sourceRepository,
        '--source-root',
        sourceRoot,
      ],
      root,
    );
    await rm(join(root, 'knowledge', 'projects', 'alpha', 'sources'), { recursive: true });
    const shown = await capture(
      ['project', 'show', '--project-id', 'alpha', '--json'],
      root,
    );
    expect(shown.exitCode).toBe(3);
    expect(JSON.parse(shown.stderr)).toMatchObject({
      errors: [{ code: 'MANIFEST_INVALID', recoveryCommand: ['project', 'validate'] }],
      ok: false,
    });
  });

  it('adds, binds, rebinds, reports, and synchronizes explicit sibling sources without path disclosure or implicit compilation', async () => {
    const root = await createConfiguredRepository();
    await capture(
      ['init', '--knowledge-repo', '../knowledge.git', '--branch', 'main'],
      root,
    );
    const alphaRepository = 'https://example.test/alpha.git';
    const alphaSource = await createSourceRepository(root, 'alpha', alphaRepository);
    const compilerRequests: unknown[] = [];
    const projectCompiler: NonNullable<CliRuntime['projectCompiler']> = {
      execute: (request) => {
        compilerRequests.push(request);
        if (request.capability !== 'compile') throw new Error('Unexpected compiler capability.');
        return Promise.resolve({
          capability: 'compile',
          data: {
            candidateCount: 0,
            candidates: [],
            compiled: 1,
            deleted: 0,
            pageIds: ['overview'],
            skipped: 0,
          },
          ok: true,
          outcome: 'succeeded',
          projectId: request.projectId,
          warnings: [],
        });
      },
      status: () => Promise.resolve({
        pendingChanges: [],
        pendingChangesCount: 0,
        stateStatus: 'ok',
      }),
    };

    const added = await capture([
      'project', 'add', '--id', 'alpha', '--source-repo', alphaRepository,
      '--source-root', alphaSource, '--json',
    ], root, { projectCompiler });
    expect(added).toMatchObject({ exitCode: 0, stderr: '' });
    expect(added.stdout).not.toContain(alphaSource);
    expect(JSON.parse(added.stdout)).toMatchObject({
      data: {
        binding: { outcome: 'created' },
        entry: { projectId: 'alpha' },
        localSource: { manifestStatus: 'ready', reasonCode: 'READY', state: 'ready' },
      },
    });

    const betaRepository = 'https://example.test/beta.git';
    await addProject(join(root, 'knowledge'), {
      displayName: 'Beta',
      projectId: 'beta',
      sourceRepository: betaRepository,
    });
    const betaSourceOne = await createSourceRepository(
      root,
      'beta',
      betaRepository,
      'beta-one',
    );
    const betaSourceTwo = await createSourceRepository(
      root,
      'beta',
      betaRepository,
      'beta-two',
    );
    const bound = await capture([
      'project', 'bind', '--project', 'beta', '--source-root', betaSourceOne, '--json',
    ], root);
    const rebound = await capture([
      'project', 'bind', '--project', 'beta', '--source-root', betaSourceTwo, '--json',
    ], root);
    expect(JSON.parse(bound.stdout)).toMatchObject({ data: { binding: { outcome: 'created' } } });
    expect(JSON.parse(rebound.stdout)).toMatchObject({ data: { binding: { outcome: 'replaced' } } });

    for (const reported of [
      await capture(['project', 'list', '--json'], root),
      await capture(['project', 'show', '--project', 'beta', '--json'], root),
    ]) {
      expect(reported.stdout).not.toContain(alphaSource);
      expect(reported.stdout).not.toContain(betaSourceOne);
      expect(reported.stdout).not.toContain(betaSourceTwo);
      expect(reported.stdout).toContain('"localSource"');
    }

    const beforeDryRun = await readdir(join(root, 'knowledge/projects/alpha/sources'));
    const dryRun = await capture(
      ['sync', '--project', 'alpha', '--dry-run', '--json'],
      root,
      { projectCompiler },
    );
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await readdir(join(root, 'knowledge/projects/alpha/sources'))).toEqual(beforeDryRun);
    expect(compilerRequests).toEqual([]);

    const synchronized = await capture(
      ['sync', '--project', 'alpha', '--json'],
      root,
      { projectCompiler },
    );
    expect(synchronized).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await readdir(join(root, 'knowledge/projects/alpha/sources'))).toHaveLength(1);
    expect(compilerRequests).toEqual([]);

    const compiled = await capture(
      ['compile', '--project', 'alpha', '--json'],
      root,
      { projectCompiler },
    );
    expect(compiled).toMatchObject({ exitCode: 0, stderr: '' });
    expect(compilerRequests).toEqual([{ capability: 'compile', projectId: 'alpha' }]);

    const deltaRepository = 'https://example.test/delta.git';
    const deltaSource = await createSourceRepository(root, 'delta', deltaRepository, 'delta');
    const bindingLock = join(root, '.buildlore/local-projects.json.lock');
    await writeFile(bindingLock, 'concurrent binding mutation\n', { mode: 0o600 });
    const busyRegistration = await capture([
      'project', 'add', '--id', 'delta', '--source-repo', deltaRepository,
      '--source-root', deltaSource, '--json',
    ], root);
    await rm(bindingLock, { force: true });
    expect(busyRegistration).toMatchObject({ exitCode: 4, stdout: '' });
    expect(JSON.parse(busyRegistration.stderr)).toMatchObject({
      errors: [{ code: 'SOURCE_BINDING_BUSY' }],
      ok: false,
    });
    const listedAfterBusyRegistration = JSON.parse(
      (await capture(['project', 'list', '--json'], root)).stdout,
    ) as { readonly data: readonly { readonly projectId: string }[] };
    expect(listedAfterBusyRegistration.data.map((project) => project.projectId))
      .not.toContain('delta');

    const secretPath = join(root, '..', 'missing-do-not-reflect');
    const rejected = await capture([
      'project', 'add', '--id', 'gamma', '--source-repo', 'https://example.test/gamma.git',
      '--source-root', secretPath, '--json',
    ], root);
    expect(rejected.exitCode).toBe(3);
    expect(rejected.stderr).not.toContain(secretPath);
    const listed = JSON.parse((await capture(['project', 'list', '--json'], root)).stdout) as {
      readonly data: readonly { readonly projectId: string }[];
    };
    expect(listed.data.map((project) => project.projectId)).not.toContain('gamma');
  });
});
