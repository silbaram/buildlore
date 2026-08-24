import { execFile } from 'node:child_process';
import { lstat, realpath, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { isNodeError, KnowledgeError } from './errors.js';
import { type SubmoduleStatus } from './types.js';
import { isSshScpLocator, validateRepositoryLocator } from './validation.js';

interface GitResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const STATUS_LINE_PATTERN = /^([ +\-U])([0-9a-f]{40}|[0-9a-f]{64})\s+knowledge(?:\s|$)/u;

export interface GitRevisionSnapshot {
  readonly committedAt: string;
  readonly head: string;
}

function runGit(
  cwd: string,
  args: readonly string[],
  options: { readonly allowFailure?: boolean } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        maxBuffer: 1024 * 1024,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stderr, stdout });
          return;
        }
        if (options.allowFailure === true && typeof error.code === 'number') {
          resolve({ exitCode: error.code, stderr, stdout });
          return;
        }
        if (isNodeError(error) && error.code === 'ENOENT') {
          reject(
            new KnowledgeError('GIT_NOT_AVAILABLE', 'Git is not available.', {
              cause: error,
              recoveryCommand: ['git', '--version'],
            }),
          );
          return;
        }
        reject(
          new KnowledgeError(
            'GIT_ACCESS_DENIED',
            'Git could not complete the requested operation.',
            { cause: error, recoveryCommand: ['knowledge', 'status'] },
          ),
        );
      },
    );
  });
}

export async function resolveGitWorktreeRoot(repositoryRoot: string): Promise<string | null> {
  const result = await runGit(repositoryRoot, ['rev-parse', '--show-toplevel'], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  const rawRoot = result.stdout.trim();
  if (rawRoot.length === 0 || rawRoot.includes('\n') || rawRoot.includes('\r')) {
    throw new KnowledgeError('SUBMODULE_MISMATCH', 'Git returned an invalid worktree root.', {
      recoveryCommand: ['knowledge', 'status'],
    });
  }
  try {
    return await realpath(rawRoot);
  } catch (error) {
    throw new KnowledgeError('SUBMODULE_MISMATCH', 'Unable to resolve the Git worktree root.', {
      cause: error,
      recoveryCommand: ['knowledge', 'status'],
    });
  }
}

/** Read-only, bounded revision metadata for an already validated Git checkout. */
export async function readGitRevisionSnapshot(
  repositoryRoot: string,
): Promise<GitRevisionSnapshot> {
  const [headResult, timestampResult] = await Promise.all([
    runGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    runGit(repositoryRoot, ['show', '-s', '--format=%cI', 'HEAD']),
  ]);
  const head = headResult.stdout.trim();
  const committedAt = timestampResult.stdout.trim();
  if (
    !OBJECT_ID_PATTERN.test(head) ||
    headResult.stdout.trimEnd() !== head ||
    committedAt.length < 1 || committedAt.length > 64 ||
    timestampResult.stdout.trimEnd() !== committedAt
  ) {
    throw new KnowledgeError('GIT_ACCESS_DENIED', 'Git returned invalid revision metadata.', {
      recoveryCommand: ['knowledge', 'status'],
    });
  }
  return Object.freeze({ committedAt, head });
}

export async function initializeGitSuperproject(repositoryRoot: string): Promise<void> {
  await runGit(repositoryRoot, ['init', '--initial-branch=main']);
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function pathStatus(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw new KnowledgeError('SUBMODULE_MISMATCH', 'Unable to inspect knowledge Git state.', {
      cause: error,
      recoveryCommand: ['knowledge', 'status'],
    });
  }
}

export async function resolveGitCommonDirectory(repositoryRoot: string): Promise<string> {
  const result = await runGit(repositoryRoot, ['rev-parse', '--git-common-dir']);
  const rawPath = result.stdout.trim();
  if (rawPath.length === 0 || rawPath.includes('\n') || rawPath.includes('\r')) {
    throw new KnowledgeError('SUBMODULE_MISMATCH', 'Git returned an invalid common directory.', {
      recoveryCommand: ['knowledge', 'status'],
    });
  }
  try {
    return await realpath(resolve(repositoryRoot, rawPath));
  } catch (error) {
    throw new KnowledgeError('SUBMODULE_MISMATCH', 'Unable to resolve Git metadata.', {
      cause: error,
      recoveryCommand: ['knowledge', 'status'],
    });
  }
}

async function assertCloneTargetsAbsent(
  repositoryRoot: string,
  commonGitDirectory: string,
): Promise<void> {
  const workspace = join(repositoryRoot, 'knowledge');
  const moduleDirectory = join(commonGitDirectory, 'modules', 'knowledge');
  if ((await pathStatus(workspace)) !== null || (await pathStatus(moduleDirectory)) !== null) {
    throw new KnowledgeError(
      'SUBMODULE_MISMATCH',
      'Knowledge clone targets already exist; inspect them before cloning.',
      { recoveryCommand: ['knowledge', 'status'] },
    );
  }
}

async function removeOwnedDirectory(path: string, ownerRoot: string): Promise<boolean> {
  if (!isContained(ownerRoot, path)) {
    return false;
  }
  const status = await pathStatus(path);
  if (status === null) {
    return true;
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    return false;
  }
  let actual: string;
  try {
    actual = await realpath(path);
  } catch {
    return false;
  }
  if (!isContained(ownerRoot, actual)) {
    return false;
  }
  await rm(path, { force: true, recursive: true });
  return (await pathStatus(path)) === null;
}

async function removeOwnedGitmodules(repositoryRoot: string): Promise<boolean> {
  const path = join(repositoryRoot, '.gitmodules');
  const status = await pathStatus(path);
  if (status === null) {
    return true;
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    return false;
  }
  await unlink(path);
  return true;
}

async function rollbackKnowledgeClone(
  repositoryRoot: string,
  commonGitDirectory: string,
): Promise<boolean> {
  await runGit(repositoryRoot, ['submodule', 'deinit', '-f', '--', 'knowledge'], {
    allowFailure: true,
  });
  await runGit(repositoryRoot, ['rm', '-f', '--ignore-unmatch', '--', 'knowledge'], {
    allowFailure: true,
  });
  await runGit(repositoryRoot, ['rm', '-f', '--ignore-unmatch', '--', '.gitmodules'], {
    allowFailure: true,
  });

  const workspaceRemoved = await removeOwnedDirectory(
    join(repositoryRoot, 'knowledge'),
    repositoryRoot,
  );
  const moduleRemoved = await removeOwnedDirectory(
    join(commonGitDirectory, 'modules', 'knowledge'),
    commonGitDirectory,
  );
  const gitmodulesRemoved = await removeOwnedGitmodules(repositoryRoot);
  const gitmodulesIndex = await runGit(
    repositoryRoot,
    ['ls-files', '--error-unmatch', '--', '.gitmodules'],
    { allowFailure: true },
  );
  const knowledgeIndex = await runGit(
    repositoryRoot,
    ['ls-files', '--error-unmatch', '--', 'knowledge'],
    { allowFailure: true },
  );
  return (
    workspaceRemoved &&
    moduleRemoved &&
    gitmodulesRemoved &&
    gitmodulesIndex.exitCode !== 0 &&
    knowledgeIndex.exitCode !== 0 &&
    (await getSubmoduleStatus(repositoryRoot)).state === 'unconfigured'
  );
}

function firstLine(output: string): string {
  return output.split(/\r?\n/u)[0] ?? '';
}

function isRelativeLocalLocator(locator: string): boolean {
  return (
    !locator.startsWith('https://') &&
    !locator.startsWith('ssh://') &&
    !isSshScpLocator(locator)
  );
}

export function validateKnowledgeBranch(branch: string): string {
  const components = branch.split('/');
  if (
    branch.length < 1 ||
    branch.length > 255 ||
    branch.startsWith('-') ||
    branch.startsWith('.') ||
    branch.startsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('/') ||
    branch === '@' ||
    branch.includes('@{') ||
    branch.includes('//') ||
    branch.includes('..') ||
    /[\s~^:?*[\\]/u.test(branch) ||
    components.some((component) => component.startsWith('.') || component.endsWith('.lock'))
  ) {
    throw new KnowledgeError('MANIFEST_INVALID', 'Git branch name is invalid.');
  }
  return branch;
}

function validateRevision(revision: string): string {
  const normalized = revision.toLowerCase();
  if (!OBJECT_ID_PATTERN.test(normalized)) {
    throw new KnowledgeError('MANIFEST_INVALID', 'Revision must be a full Git object id.');
  }
  return normalized;
}

export function parseSubmoduleStatusLine(line: string): {
  readonly commit: string;
  readonly prefix: ' ' | '+' | '-' | 'U';
} | null {
  const match = STATUS_LINE_PATTERN.exec(line);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  const prefix = match[1];
  if (prefix !== ' ' && prefix !== '+' && prefix !== '-' && prefix !== 'U') {
    return null;
  }
  return { commit: match[2], prefix };
}

async function readGitConfig(
  repositoryRoot: string,
  key: string,
): Promise<string | null> {
  const result = await runGit(repositoryRoot, ['config', '-f', '.gitmodules', '--get', key], {
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function assertSafeGitmodules(repositoryRoot: string): Promise<boolean> {
  try {
    const status = await lstat(join(repositoryRoot, '.gitmodules'));
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new KnowledgeError('SUBMODULE_MISMATCH', 'The knowledge submodule metadata is unsafe.', {
        recoveryCommand: ['knowledge', 'status'],
      });
    }
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    if (error instanceof KnowledgeError) {
      throw error;
    }
    throw new KnowledgeError('SUBMODULE_MISMATCH', 'Unable to inspect submodule metadata.', {
      cause: error,
      recoveryCommand: ['knowledge', 'status'],
    });
  }
}

export async function getSubmoduleStatus(repositoryRoot: string): Promise<SubmoduleStatus> {
  if (!(await assertSafeGitmodules(repositoryRoot))) {
    const [knowledgeIndex, gitmodulesIndex] = await Promise.all([
      runGit(repositoryRoot, ['ls-files', '--stage', '--', 'knowledge'], {
        allowFailure: true,
      }),
      runGit(repositoryRoot, ['ls-files', '--stage', '--', '.gitmodules'], {
        allowFailure: true,
      }),
    ]);
    const indexLines = knowledgeIndex.stdout.split(/\r?\n/u).filter((line) => line !== '');
    const hasOrphanedMetadata = gitmodulesIndex.stdout.trim().length > 0;
    const hasOrphanedGitlink = indexLines.length > 0;
    return {
      branch: null,
      checkedOutCommit: null,
      gitStatusPrefix: indexLines.length > 1 ? 'U' : null,
      path: 'knowledge',
      pinnedCommit: null,
      repository: null,
      state: hasOrphanedGitlink || hasOrphanedMetadata ? 'invalid' : 'unconfigured',
    };
  }

  const [path, rawRepository, rawBranch, index] = await Promise.all([
    readGitConfig(repositoryRoot, 'submodule.knowledge.path'),
    readGitConfig(repositoryRoot, 'submodule.knowledge.url'),
    readGitConfig(repositoryRoot, 'submodule.knowledge.branch'),
    runGit(repositoryRoot, ['ls-files', '--stage', '--', 'knowledge'], { allowFailure: true }),
  ]);
  let branch: string | null;
  let branchInvalid = false;
  try {
    branch = rawBranch === null ? null : validateKnowledgeBranch(rawBranch);
  } catch {
    branch = null;
    branchInvalid = true;
  }
  if (path !== 'knowledge' || rawRepository === null || branchInvalid) {
    return {
      branch,
      checkedOutCommit: null,
      gitStatusPrefix: null,
      path: 'knowledge',
      pinnedCommit: null,
      repository: null,
      state: 'invalid',
    };
  }

  let repository: string;
  try {
    repository = validateRepositoryLocator(rawRepository);
  } catch {
    return {
      branch,
      checkedOutCommit: null,
      gitStatusPrefix: null,
      path: 'knowledge',
      pinnedCommit: null,
      repository: null,
      state: 'invalid',
    };
  }

  const indexLines = index.stdout.split(/\r?\n/u).filter((line) => line !== '');
  const parsedIndex = indexLines.map((line) => /^160000 ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\tknowledge$/u.exec(line));
  const hasUnmergedGitlink = parsedIndex.some(
    (entry) => entry !== null && entry[2] !== undefined && entry[2] !== '0',
  );
  const firstIndexEntry = parsedIndex[0];
  if (
    index.exitCode !== 0 ||
    parsedIndex.length !== 1 ||
    firstIndexEntry === undefined ||
    firstIndexEntry === null ||
    firstIndexEntry[1] === undefined
  ) {
    return {
      branch,
      checkedOutCommit: null,
      gitStatusPrefix: hasUnmergedGitlink ? 'U' : null,
      path: 'knowledge',
      pinnedCommit: null,
      repository,
      state: hasUnmergedGitlink ? 'conflicted' : 'invalid',
    };
  }
  const pinnedCommit = firstIndexEntry[1];
  if (firstIndexEntry[2] !== '0') {
    return {
      branch,
      checkedOutCommit: null,
      gitStatusPrefix: 'U',
      path: 'knowledge',
      pinnedCommit,
      repository,
      state: 'conflicted',
    };
  }

  const statusResult = await runGit(repositoryRoot, ['submodule', 'status', '--', 'knowledge'], {
    allowFailure: true,
  });
  const parsedStatus = parseSubmoduleStatusLine(firstLine(statusResult.stdout));
  if (statusResult.exitCode !== 0 || parsedStatus === null) {
    return {
      branch,
      checkedOutCommit: null,
      gitStatusPrefix: null,
      path: 'knowledge',
      pinnedCommit,
      repository,
      state: 'invalid',
    };
  }
  if (parsedStatus.prefix === 'U') {
    return {
      branch,
      checkedOutCommit: null,
      gitStatusPrefix: 'U',
      path: 'knowledge',
      pinnedCommit,
      repository,
      state: 'conflicted',
    };
  }
  if (parsedStatus.prefix === '-') {
    return {
      branch,
      checkedOutCommit: null,
      gitStatusPrefix: '-',
      path: 'knowledge',
      pinnedCommit,
      repository,
      state: 'uninitialized',
    };
  }

  const currentResult = await runGit(repositoryRoot, ['-C', 'knowledge', 'rev-parse', 'HEAD'], {
    allowFailure: true,
  });
  const rawCheckedOutCommit = currentResult.exitCode === 0 ? currentResult.stdout.trim() : null;
  const checkedOutCommit =
    rawCheckedOutCommit !== null && OBJECT_ID_PATTERN.test(rawCheckedOutCommit)
      ? rawCheckedOutCommit
      : null;
  const mismatch =
    parsedStatus.prefix === '+' ||
    checkedOutCommit === null ||
    checkedOutCommit !== pinnedCommit;
  return {
    branch,
    checkedOutCommit,
    gitStatusPrefix: mismatch ? '+' : ' ',
    path: 'knowledge',
    pinnedCommit,
    repository,
    state: mismatch ? 'commit-mismatch' : 'ready',
  };
}

export async function cloneKnowledge(
  repositoryRoot: string,
  input: {
    readonly branch?: string;
    readonly repository: string;
    readonly revision?: string;
  },
): Promise<SubmoduleStatus> {
  const repository = validateRepositoryLocator(input.repository);
  const branch = input.branch === undefined ? undefined : validateKnowledgeBranch(input.branch);
  const revision = input.revision === undefined ? undefined : validateRevision(input.revision);
  if ((await getSubmoduleStatus(repositoryRoot)).state !== 'unconfigured') {
    throw new KnowledgeError('SUBMODULE_MISMATCH', 'Knowledge submodule is already configured.', {
      recoveryCommand: ['knowledge', 'status'],
    });
  }
  const commonGitDirectory = await resolveGitCommonDirectory(repositoryRoot);
  await assertCloneTargetsAbsent(repositoryRoot, commonGitDirectory);

  const args = [
    ...(isRelativeLocalLocator(repository) ? ['-c', 'protocol.file.allow=always'] : []),
    'submodule',
    'add',
    ...(branch === undefined ? [] : ['-b', branch]),
    '--',
    repository,
    'knowledge',
  ];
  let added = false;
  let finalStatus: SubmoduleStatus | undefined;
  try {
    await runGit(repositoryRoot, args);
    added = true;
    if (revision !== undefined) {
      await runGit(repositoryRoot, ['-C', 'knowledge', 'checkout', '--detach', revision]);
      await runGit(repositoryRoot, ['add', '--', 'knowledge']);
    }
    finalStatus = await getSubmoduleStatus(repositoryRoot);
    if (finalStatus.state !== 'ready') {
      throw new KnowledgeError(
        'SUBMODULE_MISMATCH',
        'Knowledge clone did not produce a ready pinned submodule.',
        { recoveryCommand: ['knowledge', 'status'] },
      );
    }
  } catch (error) {
    let rolledBack = false;
    try {
      rolledBack = await rollbackKnowledgeClone(repositoryRoot, commonGitDirectory);
    } catch {
      // A structured cleanup failure is returned below without exposing Git output.
    }
    if (!rolledBack) {
      throw new KnowledgeError(
        'SUBMODULE_MISMATCH',
        'Knowledge clone failed and its generated Git state requires inspection.',
        { cause: error, recoveryCommand: ['knowledge', 'status'] },
      );
    }
    if (added && revision !== undefined) {
      throw new KnowledgeError(
        'SUBMODULE_MISMATCH',
        'Requested knowledge revision could not be pinned; the clone was rolled back.',
        { cause: error, recoveryCommand: ['knowledge', 'clone'] },
      );
    }
    throw error;
  }
  return finalStatus;
}

export async function initKnowledge(repositoryRoot: string): Promise<SubmoduleStatus> {
  const status = await getSubmoduleStatus(repositoryRoot);
  if (status.state === 'unconfigured') {
    throw new KnowledgeError('KNOWLEDGE_NOT_CONFIGURED', 'Knowledge submodule is not configured.', {
      recoveryCommand: ['knowledge', 'status'],
    });
  }
  if (status.state === 'invalid') {
    throw new KnowledgeError('SUBMODULE_MISMATCH', 'Knowledge submodule metadata is invalid.', {
      recoveryCommand: ['knowledge', 'status'],
    });
  }
  if (status.state === 'conflicted') {
    throw new KnowledgeError('SUBMODULE_CONFLICT', 'Knowledge submodule has a Git conflict.', {
      recoveryCommand: ['knowledge', 'status'],
    });
  }
  const args = [
    ...(status.repository !== null && isRelativeLocalLocator(status.repository)
      ? ['-c', 'protocol.file.allow=always']
      : []),
    'submodule',
    'update',
    '--init',
    '--',
    'knowledge',
  ];
  await runGit(repositoryRoot, args);
  const initialized = await getSubmoduleStatus(repositoryRoot);
  if (initialized.state !== 'ready') {
    throw new KnowledgeError(
      'SUBMODULE_MISMATCH',
      'Knowledge submodule initialization did not restore the pinned revision.',
      { recoveryCommand: ['knowledge', 'status'] },
    );
  }
  return initialized;
}
