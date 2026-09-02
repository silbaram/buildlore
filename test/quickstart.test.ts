import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '../src/cli/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { initializeSingleProjectQuickstart } from '../src/projector/index.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], {
    cwd,
    env: { ...process.env, LC_ALL: 'C' },
  });
}

async function configureIdentity(repository: string): Promise<void> {
  await git(repository, ['config', 'user.name', 'BuildLore Test']);
  await git(repository, ['config', 'user.email', 'buildlore@example.invalid']);
}

async function createFixture(
  withKnowledgeOrigin: boolean = true,
): Promise<Readonly<{
  hubRoot: string;
  root: string;
  sourceRoot: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-quickstart-'));
  temporaryRoots.push(root);
  const origin = join(root, 'knowledge.git');
  const seed = join(root, 'knowledge-seed');
  const sourceRoot = join(root, 'source');
  const hubRoot = join(root, 'hub');
  if (withKnowledgeOrigin) {
    await git(root, ['init', '--bare', '--initial-branch=main', origin]);
    await git(root, ['-c', 'protocol.file.allow=always', 'clone', origin, seed]);
    await configureIdentity(seed);
    await writeFile(join(seed, 'README.md'), '# Knowledge\n');
    await git(seed, ['add', 'README.md']);
    await git(seed, ['commit', '-m', 'seed knowledge']);
    await git(seed, ['push', 'origin', 'main']);
  }
  await Promise.all([mkdir(sourceRoot), mkdir(hubRoot)]);
  await git(sourceRoot, ['init', '--initial-branch=main']);
  await configureIdentity(sourceRoot);
  await writeFile(join(sourceRoot, 'README.md'), '# Source\n');
  await git(sourceRoot, ['add', 'README.md']);
  await git(sourceRoot, ['commit', '-m', 'seed source']);
  return { hubRoot, root, sourceRoot };
}

async function capture(args: readonly string[], cwd: string): Promise<Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>> {
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
  return Object.freeze({ exitCode: await runCli(args, io, { cwd }), stderr, stdout });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('single-project quickstart', () => {
  it('initializes and reruns with the hub checkout as its own source', async () => {
    const fixture = await createFixture();
    const args = [
      'init',
      '--project', 'alpha',
      '--knowledge-repo', '../knowledge.git',
      '--source-repo', 'https://example.test/alpha.git',
      '--source-root', fixture.sourceRoot,
      '--branch', 'main',
      '--json',
    ] as const;

    const created = await capture(args, fixture.sourceRoot);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(created.stdout).not.toContain(fixture.root);
    expect(JSON.parse(created.stdout)).toMatchObject({
      data: {
        binding: 'created',
        gitRepository: 'existing',
        knowledge: 'ready',
        project: 'created',
        sourceManifest: 'created',
      },
      ok: true,
    });
    expect(await readFile(join(fixture.sourceRoot, '.gitmodules'), 'utf8'))
      .toContain('path = knowledge');
    expect(JSON.parse(await readFile(
      join(fixture.sourceRoot, 'knowledge/projects/alpha/project.json'),
      'utf8',
    ))).toMatchObject({ projectId: 'alpha' });

    const repeated = await capture(args, fixture.sourceRoot);
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      data: {
        binding: 'existing',
        gitRepository: 'existing',
        knowledge: 'ready',
        project: 'existing',
        sourceManifest: 'existing',
      },
      ok: true,
    });
  }, 30_000);

  it('creates a private local knowledge origin when no repository is supplied', async () => {
    const fixture = await createFixture(false);
    const args = [
      'init',
      '--project', 'alpha',
      '--source-repo', 'https://example.test/alpha.git',
      '--source-root', fixture.sourceRoot,
      '--json',
    ] as const;
    const created = await capture(args, fixture.hubRoot);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(created.stdout).not.toContain(fixture.root);
    expect(JSON.parse(created.stdout)).toMatchObject({
      data: {
        gitRepository: 'created',
        knowledge: 'ready',
        profileBinding: 'created',
      },
      ok: true,
    });
    const gitmodules = await readFile(join(fixture.hubRoot, '.gitmodules'), 'utf8');
    expect(gitmodules).toContain('.git/buildlore/knowledge.git');
    expect(gitmodules).not.toContain(fixture.root);

    const repeated = await capture(args, fixture.hubRoot);
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      data: {
        binding: 'existing',
        knowledge: 'ready',
        profileBinding: 'existing',
      },
      ok: true,
    });
  }, 30_000);

  it('initializes one explicit project, empty general manifest, and converges on retry', async () => {
    const fixture = await createFixture();
    const args = [
      'init',
      '--project', 'alpha',
      '--knowledge-repo', '../knowledge.git',
      '--source-repo', 'https://example.test/alpha.git',
      '--source-root', fixture.sourceRoot,
      '--branch', 'main',
      '--json',
    ] as const;
    const created = await capture(args, fixture.hubRoot);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(created.stdout).not.toContain(fixture.root);
    expect(JSON.parse(created.stdout)).toMatchObject({
      command: 'init',
      data: {
        binding: 'created',
        knowledge: 'ready',
        project: 'created',
        profileBinding: 'created',
        projectId: 'alpha',
        schemaVersion: 'buildlore.quickstart.v1',
        sourceManifest: 'created',
      },
      ok: true,
      projectId: 'alpha',
    });
    expect(JSON.parse(await readFile(
      join(fixture.sourceRoot, '.buildlore/sources.json'),
      'utf8',
    ))).toEqual({
      projectId: 'alpha',
      schemaVersion: 'buildlore.sources.v2',
      sourceRepository: 'https://example.test/alpha.git',
      sources: [],
    });
    expect(JSON.parse(await readFile(
      join(fixture.hubRoot, 'knowledge/projects/alpha/project.json'),
      'utf8',
    ))).toMatchObject({
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    expect(JSON.parse(await readFile(
      join(fixture.hubRoot, 'knowledge/projects/alpha/profile-binding.json'),
      'utf8',
    ))).toEqual({
      adapters: [{ adapterId: 'buildlore.generic', adapterVersion: 1 }],
      outputLanguage: 'en',
      profileId: 'general',
      schemaVersion: 'buildlore.profile-binding.v1',
      upstreamProfile: 'default',
    });

    const repeated = await capture(args, fixture.hubRoot);
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      data: {
        binding: 'existing',
        gitRepository: 'existing',
        manifest: 'existing',
        project: 'existing',
        profileBinding: 'existing',
        sourceManifest: 'existing',
      },
      ok: true,
    });
  }, 30_000);

  it('keeps legacy init valid and rejects incomplete quickstart arguments before mutation', async () => {
    const fixture = await createFixture();
    const invalid = await capture([
      'init',
      '--project', 'alpha',
      '--knowledge-repo', '../knowledge.git',
      '--source-repo', 'https://example.test/alpha.git',
      '--json',
    ], fixture.hubRoot);
    expect(invalid.exitCode).toBe(2);
    expect(JSON.parse(invalid.stderr)).toMatchObject({
      errors: [{ code: 'CLI_OPTION_MISSING' }],
      ok: false,
    });
    await expect(readFile(join(fixture.hubRoot, '.gitmodules'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('validates project bindings before creating Git or source state', async () => {
    const fixture = await createFixture(false);
    await expect(initializeSingleProjectQuickstart(fixture.hubRoot, {
      projectId: 'knowledge',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot: fixture.sourceRoot,
    })).rejects.toMatchObject({ code: 'SOURCE_BINDING_INVALID' });
    for (const path of [
      join(fixture.hubRoot, '.git/HEAD'),
      join(fixture.hubRoot, '.gitmodules'),
      join(fixture.sourceRoot, '.buildlore/sources.json'),
    ]) {
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('rejects an existing source manifest bound to a different repository', async () => {
    const fixture = await createFixture();
    const input = {
      branch: 'main',
      knowledgeRepository: '../knowledge.git',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot: fixture.sourceRoot,
    } as const;
    await initializeSingleProjectQuickstart(fixture.hubRoot, input);
    const manifestPath = join(fixture.sourceRoot, '.buildlore/sources.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.sourceRepository = 'https://example.test/other.git';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = await readFile(manifestPath, 'utf8');

    await expect(initializeSingleProjectQuickstart(fixture.hubRoot, input)).rejects.toMatchObject({
      code: 'SOURCE_PROJECT_MISMATCH',
    });
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(before);
  }, 30_000);

  it('rejects a rerun that points an existing project at a different checkout', async () => {
    const fixture = await createFixture();
    const input = {
      branch: 'main',
      knowledgeRepository: '../knowledge.git',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot: fixture.sourceRoot,
    } as const;
    await initializeSingleProjectQuickstart(fixture.hubRoot, input);
    const secondSourceRoot = join(fixture.root, 'second-source');
    await mkdir(secondSourceRoot);
    await git(secondSourceRoot, ['init', '--initial-branch=main']);
    await configureIdentity(secondSourceRoot);
    await writeFile(join(secondSourceRoot, 'README.md'), '# Second source\n');
    await git(secondSourceRoot, ['add', 'README.md']);
    await git(secondSourceRoot, ['commit', '-m', 'seed second source']);

    await expect(initializeSingleProjectQuickstart(fixture.hubRoot, {
      ...input,
      sourceRoot: secondSourceRoot,
    })).rejects.toMatchObject({ code: 'SOURCE_BINDING_CONFLICT' });
  }, 30_000);

  it('validates an existing source manifest before creating hub state', async () => {
    const fixture = await createFixture(false);
    await mkdir(join(fixture.sourceRoot, '.buildlore'));
    await writeFile(
      join(fixture.sourceRoot, '.buildlore/sources.json'),
      serializeCanonicalJson({
        projectId: 'alpha',
        schemaVersion: 'buildlore.sources.v2',
        sourceRepository: 'https://example.test/other.git',
        sources: [],
      }),
    );

    await expect(initializeSingleProjectQuickstart(fixture.hubRoot, {
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot: fixture.sourceRoot,
    })).rejects.toMatchObject({ code: 'SOURCE_PROJECT_MISMATCH' });
    await expect(readFile(join(fixture.hubRoot, '.git/HEAD'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
