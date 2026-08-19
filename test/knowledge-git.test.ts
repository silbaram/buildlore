import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cloneKnowledge,
  getSubmoduleStatus,
  initKnowledge,
  parseSubmoduleStatusLine,
} from '../src/knowledge/index.js';

const temporaryRoots: string[] = [];

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

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

async function createGitFixture(): Promise<{
  readonly code: string;
  readonly knowledgeSeed: string;
  readonly originalKnowledgeCommit: string;
  readonly root: string;
}> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-knowledge-git-'));
  temporaryRoots.push(root);
  const codeOrigin = join(root, 'code-origin.git');
  const knowledgeOrigin = join(root, 'knowledge.git');
  const knowledgeSeed = join(root, 'knowledge-seed');
  const code = join(root, 'code');

  await git(root, ['init', '--bare', '--initial-branch=main', codeOrigin]);
  await git(root, ['init', '--bare', '--initial-branch=main', knowledgeOrigin]);
  await git(root, ['-c', 'protocol.file.allow=always', 'clone', knowledgeOrigin, knowledgeSeed]);
  await configureIdentity(knowledgeSeed);
  await writeFile(join(knowledgeSeed, 'README.md'), '# Knowledge fixture\n', 'utf8');
  await git(knowledgeSeed, ['add', 'README.md']);
  await git(knowledgeSeed, ['commit', '-m', 'seed knowledge']);
  await git(knowledgeSeed, ['push', 'origin', 'main']);
  const originalKnowledgeCommit = await git(knowledgeSeed, ['rev-parse', 'HEAD']);

  await git(root, ['-c', 'protocol.file.allow=always', 'clone', codeOrigin, code]);
  await configureIdentity(code);
  await writeFile(join(code, 'README.md'), '# Code fixture\n', 'utf8');
  await git(code, ['add', 'README.md']);
  await git(code, ['commit', '-m', 'seed code']);
  await git(code, ['push', 'origin', 'main']);
  return { code, knowledgeSeed, originalKnowledgeCommit, root };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('knowledge Git submodule lifecycle', () => {
  it('clones, diagnoses, initializes, and restores a pinned local submodule', async () => {
    const fixture = await createGitFixture();
    const cloned = await cloneKnowledge(fixture.code, {
      branch: 'main',
      repository: '../knowledge.git',
      revision: fixture.originalKnowledgeCommit,
    });
    expect(cloned).toMatchObject({
      branch: 'main',
      checkedOutCommit: fixture.originalKnowledgeCommit,
      gitStatusPrefix: ' ',
      pinnedCommit: fixture.originalKnowledgeCommit,
      repository: '../knowledge.git',
      state: 'ready',
    });
    expect(await readFile(join(fixture.code, '.gitmodules'), 'utf8')).toContain(
      'url = ../knowledge.git',
    );
    expect(await git(fixture.code, ['ls-files', '--stage', '--', 'knowledge'])).toMatch(
      /^160000 [0-9a-f]{40} 0\s+knowledge$/u,
    );
    await expect(
      git(fixture.code, ['config', '--local', '--get', 'protocol.file.allow']),
    ).rejects.toThrow(/Git fixture command failed/u);

    await git(fixture.code, ['add', '.gitmodules', 'knowledge']);
    await git(fixture.code, ['commit', '-m', 'pin knowledge']);
    await git(fixture.code, ['submodule', 'deinit', '-f', '--', 'knowledge']);
    await expect(getSubmoduleStatus(fixture.code)).resolves.toMatchObject({
      gitStatusPrefix: '-',
      state: 'uninitialized',
    });
    await expect(initKnowledge(fixture.code)).resolves.toMatchObject({
      checkedOutCommit: fixture.originalKnowledgeCommit,
      state: 'ready',
    });

    await writeFile(join(fixture.knowledgeSeed, 'SECOND.md'), '# Second commit\n', 'utf8');
    await git(fixture.knowledgeSeed, ['add', 'SECOND.md']);
    await git(fixture.knowledgeSeed, ['commit', '-m', 'second knowledge commit']);
    await git(fixture.knowledgeSeed, ['push', 'origin', 'main']);
    const secondCommit = await git(fixture.knowledgeSeed, ['rev-parse', 'HEAD']);
    await git(fixture.code, [
      '-c',
      'protocol.file.allow=always',
      '-C',
      'knowledge',
      'fetch',
      'origin',
      'main',
    ]);
    await git(join(fixture.code, 'knowledge'), ['checkout', '--detach', secondCommit]);
    await expect(getSubmoduleStatus(fixture.code)).resolves.toMatchObject({
      checkedOutCommit: secondCommit,
      gitStatusPrefix: '+',
      pinnedCommit: fixture.originalKnowledgeCommit,
      state: 'commit-mismatch',
    });
    await expect(initKnowledge(fixture.code)).resolves.toMatchObject({
      checkedOutCommit: fixture.originalKnowledgeCommit,
      gitStatusPrefix: ' ',
      state: 'ready',
    });
  }, 30_000);

  it('parses all documented status prefixes and rejects unsafe repository metadata', async () => {
    const commit = 'a'.repeat(40);
    expect(parseSubmoduleStatusLine(` ${commit} knowledge (heads/main)`)).toEqual({
      commit,
      prefix: ' ',
    });
    expect(parseSubmoduleStatusLine(`-${commit} knowledge`)).toEqual({ commit, prefix: '-' });
    expect(parseSubmoduleStatusLine(`+${commit} knowledge`)).toEqual({ commit, prefix: '+' });
    expect(parseSubmoduleStatusLine(`U${commit} knowledge`)).toEqual({ commit, prefix: 'U' });

    const fixture = await createGitFixture();
    const secret = 'https://user:secret@example.test/repo.git';
    await expect(
      cloneKnowledge(fixture.code, { repository: secret }),
    ).rejects.toMatchObject({ code: 'MANIFEST_INVALID' });
    await expect(getSubmoduleStatus(fixture.code)).resolves.toMatchObject({ state: 'unconfigured' });
    await expect(pathExists(join(fixture.code, '.gitmodules'))).resolves.toBe(false);
    await expect(git(fixture.code, ['config', '--local', '--list'])).resolves.not.toContain(secret);
    await expect(git(fixture.code, ['log', '--all', '-p'])).resolves.not.toContain(secret);
  }, 30_000);

  it('rolls back every generated clone artifact when revision pinning fails', async () => {
    const fixture = await createGitFixture();
    await expect(
      cloneKnowledge(fixture.code, {
        repository: '../knowledge.git',
        revision: 'f'.repeat(40),
      }),
    ).rejects.toMatchObject({
      code: 'SUBMODULE_MISMATCH',
      recoveryCommand: ['knowledge', 'clone'],
    });
    await expect(getSubmoduleStatus(fixture.code)).resolves.toMatchObject({ state: 'unconfigured' });
    await expect(pathExists(join(fixture.code, '.gitmodules'))).resolves.toBe(false);
    await expect(pathExists(join(fixture.code, 'knowledge'))).resolves.toBe(false);
    await expect(git(fixture.code, ['status', '--porcelain'])).resolves.toBe('');

    await expect(
      cloneKnowledge(fixture.code, {
        repository: '../knowledge.git',
        revision: fixture.originalKnowledgeCommit,
      }),
    ).resolves.toMatchObject({
      checkedOutCommit: fixture.originalKnowledgeCommit,
      state: 'ready',
    });
  }, 30_000);

  it('returns recovery guidance and clean state when submodule add fails', async () => {
    const fixture = await createGitFixture();
    await expect(
      cloneKnowledge(fixture.code, { repository: '../missing-knowledge.git' }),
    ).rejects.toMatchObject({
      code: 'GIT_ACCESS_DENIED',
      recoveryCommand: ['knowledge', 'status'],
    });
    await expect(getSubmoduleStatus(fixture.code)).resolves.toMatchObject({ state: 'unconfigured' });
    await expect(pathExists(join(fixture.code, '.gitmodules'))).resolves.toBe(false);
    await expect(pathExists(join(fixture.code, 'knowledge'))).resolves.toBe(false);
    await expect(git(fixture.code, ['status', '--porcelain'])).resolves.toBe('');
  }, 30_000);

  it('cleans partial clone state when the requested branch does not exist', async () => {
    const fixture = await createGitFixture();
    await expect(
      cloneKnowledge(fixture.code, {
        branch: 'missing-branch',
        repository: '../knowledge.git',
      }),
    ).rejects.toMatchObject({ code: 'GIT_ACCESS_DENIED' });
    await expect(getSubmoduleStatus(fixture.code)).resolves.toMatchObject({ state: 'unconfigured' });
    await expect(pathExists(join(fixture.code, '.gitmodules'))).resolves.toBe(false);
    await expect(pathExists(join(fixture.code, 'knowledge'))).resolves.toBe(false);
    await expect(git(fixture.code, ['status', '--porcelain'])).resolves.toBe('');
  }, 30_000);

  it('treats an orphaned gitlink without .gitmodules as invalid', async () => {
    const fixture = await createGitFixture();
    await cloneKnowledge(fixture.code, { repository: '../knowledge.git' });
    await rm(join(fixture.code, '.gitmodules'));
    await expect(getSubmoduleStatus(fixture.code)).resolves.toMatchObject({
      repository: null,
      state: 'invalid',
    });
    await expect(initKnowledge(fixture.code)).rejects.toMatchObject({
      code: 'SUBMODULE_MISMATCH',
      recoveryCommand: ['knowledge', 'status'],
    });
  }, 30_000);

  it('refuses clone when a tracked .gitmodules file is deleted from the worktree', async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.code, '.gitmodules'), '# tracked metadata\n', 'utf8');
    await git(fixture.code, ['add', '.gitmodules']);
    await git(fixture.code, ['commit', '-m', 'track metadata']);
    await rm(join(fixture.code, '.gitmodules'));
    await expect(getSubmoduleStatus(fixture.code)).resolves.toMatchObject({ state: 'invalid' });
    await expect(
      cloneKnowledge(fixture.code, { repository: '../knowledge.git' }),
    ).rejects.toMatchObject({ code: 'SUBMODULE_MISMATCH' });
    await expect(git(fixture.code, ['ls-files', '--error-unmatch', '--', '.gitmodules'])).resolves.toBe(
      '.gitmodules',
    );
  }, 30_000);

  it('does not misclassify ordinary tracked knowledge files as a gitlink conflict', async () => {
    const fixture = await createGitFixture();
    await writeFile(
      join(fixture.code, '.gitmodules'),
      '[submodule "knowledge"]\n\tpath = knowledge\n\turl = ../knowledge.git\n',
      'utf8',
    );
    await mkdir(join(fixture.code, 'knowledge'));
    await writeFile(join(fixture.code, 'knowledge', 'one.md'), 'one\n', 'utf8');
    await writeFile(join(fixture.code, 'knowledge', 'two.md'), 'two\n', 'utf8');
    await git(fixture.code, ['add', '.gitmodules', 'knowledge']);
    await expect(getSubmoduleStatus(fixture.code)).resolves.toMatchObject({
      gitStatusPrefix: null,
      state: 'invalid',
    });
  }, 30_000);

  it('rejects Git-invalid branch components before creating clone state', async () => {
    const fixture = await createGitFixture();
    for (const branch of ['@', 'topic/@{bad', 'topic/.hidden', 'topic/name.lock', 'topic//bad']) {
      await expect(
        cloneKnowledge(fixture.code, { branch, repository: '../knowledge.git' }),
      ).rejects.toMatchObject({ code: 'MANIFEST_INVALID' });
    }
    await expect(getSubmoduleStatus(fixture.code)).resolves.toMatchObject({ state: 'unconfigured' });
    await expect(pathExists(join(fixture.code, 'knowledge'))).resolves.toBe(false);
  }, 30_000);

  it('diagnoses an actual divergent gitlink merge as conflicted', async () => {
    const fixture = await createGitFixture();
    await git(fixture.knowledgeSeed, [
      'checkout',
      '-b',
      'left',
      fixture.originalKnowledgeCommit,
    ]);
    await writeFile(join(fixture.knowledgeSeed, 'LEFT.md'), '# Left\n', 'utf8');
    await git(fixture.knowledgeSeed, ['add', 'LEFT.md']);
    await git(fixture.knowledgeSeed, ['commit', '-m', 'left knowledge']);
    const leftCommit = await git(fixture.knowledgeSeed, ['rev-parse', 'HEAD']);
    await git(fixture.knowledgeSeed, ['push', 'origin', 'left']);

    await git(fixture.knowledgeSeed, [
      'checkout',
      '-b',
      'right',
      fixture.originalKnowledgeCommit,
    ]);
    await writeFile(join(fixture.knowledgeSeed, 'RIGHT.md'), '# Right\n', 'utf8');
    await git(fixture.knowledgeSeed, ['add', 'RIGHT.md']);
    await git(fixture.knowledgeSeed, ['commit', '-m', 'right knowledge']);
    const rightCommit = await git(fixture.knowledgeSeed, ['rev-parse', 'HEAD']);
    await git(fixture.knowledgeSeed, ['push', 'origin', 'right']);

    await cloneKnowledge(fixture.code, {
      repository: '../knowledge.git',
      revision: fixture.originalKnowledgeCommit,
    });
    await git(fixture.code, ['add', '.gitmodules', 'knowledge']);
    await git(fixture.code, ['commit', '-m', 'pin original knowledge']);
    await git(fixture.code, ['checkout', '-b', 'left-pin']);
    await git(fixture.code, [
      '-c',
      'protocol.file.allow=always',
      '-C',
      'knowledge',
      'fetch',
      'origin',
      'left',
      'right',
    ]);
    await git(join(fixture.code, 'knowledge'), ['checkout', '--detach', leftCommit]);
    await git(fixture.code, ['add', 'knowledge']);
    await git(fixture.code, ['commit', '-m', 'pin left knowledge']);

    await git(fixture.code, ['checkout', 'main']);
    await git(fixture.code, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--',
      'knowledge',
    ]);
    await git(join(fixture.code, 'knowledge'), ['checkout', '--detach', rightCommit]);
    await git(fixture.code, ['add', 'knowledge']);
    await git(fixture.code, ['commit', '-m', 'pin right knowledge']);
    await expect(git(fixture.code, ['merge', 'left-pin'])).rejects.toThrow(
      /Git fixture command failed/u,
    );
    await expect(getSubmoduleStatus(fixture.code)).resolves.toMatchObject({
      gitStatusPrefix: 'U',
      state: 'conflicted',
    });
  }, 30_000);

  it('supports a relative local repository path with spaces and non-ASCII characters', async () => {
    const fixture = await createGitFixture();
    await rename(join(fixture.root, 'knowledge.git'), join(fixture.root, '지식 저장소.git'));
    await expect(
      cloneKnowledge(fixture.code, { repository: '../지식 저장소.git' }),
    ).resolves.toMatchObject({
      repository: '../지식 저장소.git',
      state: 'ready',
    });
  }, 30_000);
});
