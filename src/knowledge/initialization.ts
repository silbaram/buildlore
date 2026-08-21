import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { isNodeError, KnowledgeError, type KnowledgeErrorCode } from './errors.js';
import {
  cloneKnowledge,
  getSubmoduleStatus,
  initializeGitSuperproject,
  initKnowledge,
  resolveGitWorktreeRoot,
  validateKnowledgeBranch,
} from './git.js';
import { resolveKnowledgeRoot } from './paths.js';
import { emptyManifest, readManifest, writeManifest } from './registry.js';
import { ensureKnowledgeIgnorePolicy } from './tracking-policy.js';
import type { SubmoduleStatus } from './types.js';
import { validateRepositoryLocator } from './validation.js';

export const MODE_A_INITIALIZATION_SCHEMA_VERSION = 'buildlore.mode-a-init.v1' as const;

export type ModeAInitializationStage =
  | 'git-ready'
  | 'ignore-policy-ready'
  | 'manifest-ready'
  | 'submodule-ready';

export interface ModeAInitializationInput {
  readonly branch?: string;
  readonly repository: string;
}

export interface ModeAInitializationResult {
  readonly completedStages: readonly ModeAInitializationStage[];
  readonly gitRepository: 'created' | 'existing';
  readonly ignorePolicy: 'created' | 'existing';
  readonly knowledge: SubmoduleStatus;
  readonly manifest: 'created' | 'existing';
  readonly schemaVersion: typeof MODE_A_INITIALIZATION_SCHEMA_VERSION;
}

export class ModeAInitializationError extends KnowledgeError {
  readonly completedStages: readonly ModeAInitializationStage[];
  readonly partial: true;

  constructor(
    code: KnowledgeErrorCode,
    options: {
      readonly cause?: unknown;
      readonly completedStages: readonly ModeAInitializationStage[];
      readonly recoveryCommand?: readonly string[];
    },
  ) {
    super(code, 'Mode A initialization stopped after a recoverable partial result.', {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      recoveryCommand: options.recoveryCommand ?? ['knowledge', 'status'],
    });
    this.name = 'ModeAInitializationError';
    this.completedStages = Object.freeze([...options.completedStages]);
    this.partial = true;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      code: this.code,
      completedStages: this.completedStages,
      partial: this.partial,
      recoveryCommand: this.recoveryCommand,
    };
  }
}

async function pathStatus(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Unable to inspect Mode A workspace state.', {
      cause: error,
    });
  }
}

async function canonicalWorkspaceRoot(repositoryRoot: string): Promise<string> {
  const status = await pathStatus(repositoryRoot);
  if (status === null || !status.isDirectory() || status.isSymbolicLink()) {
    throw new KnowledgeError(
      'PATH_OUTSIDE_KNOWLEDGE',
      'Mode A workspace must be an existing non-symlink directory.',
    );
  }
  let canonical: string;
  try {
    canonical = await realpath(repositoryRoot);
  } catch (error) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Unable to resolve Mode A workspace.', {
      cause: error,
    });
  }
  if (canonical !== resolve(repositoryRoot)) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Mode A workspace path is not canonical.');
  }
  return canonical;
}

async function assertEmptyDirectory(repositoryRoot: string): Promise<void> {
  let entries: readonly string[];
  try {
    entries = await readdir(repositoryRoot);
  } catch (error) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Unable to inspect Mode A workspace.', {
      cause: error,
    });
  }
  if (entries.length !== 0) {
    throw new KnowledgeError(
      'WORKSPACE_NOT_EMPTY',
      'A non-Git Mode A workspace must be empty before initialization.',
    );
  }
}

function asKnowledgeError(error: unknown): KnowledgeError {
  if (error instanceof KnowledgeError) return error;
  return new KnowledgeError('GIT_ACCESS_DENIED', 'Mode A initialization failed safely.', {
    cause: error,
    recoveryCommand: ['knowledge', 'status'],
  });
}

function partialError(
  error: unknown,
  completedStages: readonly ModeAInitializationStage[],
): ModeAInitializationError {
  const failure = asKnowledgeError(error);
  return new ModeAInitializationError(failure.code, {
    cause: failure,
    completedStages,
    ...(failure.recoveryCommand === undefined
      ? {}
      : { recoveryCommand: failure.recoveryCommand }),
  });
}

function assertMatchingBinding(
  status: SubmoduleStatus,
  repository: string,
  branch: string | undefined,
): void {
  if (status.repository !== repository || status.branch !== (branch ?? null)) {
    throw new KnowledgeError(
      'SUBMODULE_MISMATCH',
      'Existing knowledge submodule binding does not match the initialization request.',
      { recoveryCommand: ['knowledge', 'status'] },
    );
  }
}

async function ensureKnowledgeSubmodule(
  repositoryRoot: string,
  repository: string,
  branch: string | undefined,
): Promise<SubmoduleStatus> {
  const current = await getSubmoduleStatus(repositoryRoot);
  switch (current.state) {
    case 'unconfigured':
      return cloneKnowledge(repositoryRoot, {
        ...(branch === undefined ? {} : { branch }),
        repository,
      });
    case 'commit-mismatch':
    case 'uninitialized':
      assertMatchingBinding(current, repository, branch);
      return initKnowledge(repositoryRoot);
    case 'ready':
      assertMatchingBinding(current, repository, branch);
      return current;
    case 'conflicted':
      throw new KnowledgeError('SUBMODULE_CONFLICT', 'Knowledge submodule has a Git conflict.', {
        recoveryCommand: ['knowledge', 'status'],
      });
    case 'invalid':
      throw new KnowledgeError('SUBMODULE_MISMATCH', 'Knowledge submodule metadata is invalid.', {
        recoveryCommand: ['knowledge', 'status'],
      });
  }
}

async function assertKnowledgeRootBinding(repositoryRoot: string): Promise<string> {
  const expected = join(repositoryRoot, 'knowledge');
  const actual = await resolveKnowledgeRoot(expected);
  if (actual !== expected) {
    throw new KnowledgeError(
      'PATH_OUTSIDE_KNOWLEDGE',
      'Knowledge registry root escapes the Mode A workspace.',
    );
  }
  return actual;
}

async function ensureManifest(knowledgeRoot: string): Promise<'created' | 'existing'> {
  const status = await pathStatus(join(knowledgeRoot, 'manifest.json'));
  if (status === null) {
    await writeManifest(knowledgeRoot, emptyManifest());
    return 'created';
  }
  await readManifest(knowledgeRoot);
  return 'existing';
}

export async function initializeModeAWorkspace(
  repositoryRoot: string,
  input: ModeAInitializationInput,
): Promise<ModeAInitializationResult> {
  const repository = validateRepositoryLocator(input.repository);
  const branch = input.branch === undefined
    ? undefined
    : validateKnowledgeBranch(input.branch);
  const root = await canonicalWorkspaceRoot(repositoryRoot);
  const completedStages: ModeAInitializationStage[] = [];
  let gitRepository: 'created' | 'existing';

  const existingGitRoot = await resolveGitWorktreeRoot(root);
  if (existingGitRoot === null) {
    await assertEmptyDirectory(root);
    try {
      await initializeGitSuperproject(root);
      const initializedRoot = await resolveGitWorktreeRoot(root);
      if (initializedRoot !== root) {
        throw new KnowledgeError(
          'PATH_OUTSIDE_KNOWLEDGE',
          'Initialized Git worktree does not match the Mode A workspace.',
        );
      }
    } catch (error) {
      if ((await pathStatus(join(root, '.git'))) !== null) {
        throw partialError(error, completedStages);
      }
      throw error;
    }
    gitRepository = 'created';
  } else {
    if (existingGitRoot !== root) {
      throw new KnowledgeError(
        'PATH_OUTSIDE_KNOWLEDGE',
        'Mode A initialization must run at the Git worktree root.',
      );
    }
    gitRepository = 'existing';
  }
  completedStages.push('git-ready');

  let knowledge: SubmoduleStatus;
  try {
    knowledge = await ensureKnowledgeSubmodule(root, repository, branch);
    await assertKnowledgeRootBinding(root);
    completedStages.push('submodule-ready');
  } catch (error) {
    throw partialError(error, completedStages);
  }

  let manifest: 'created' | 'existing';
  try {
    manifest = await ensureManifest(join(root, 'knowledge'));
    completedStages.push('manifest-ready');
  } catch (error) {
    throw partialError(error, completedStages);
  }

  let ignorePolicy: 'created' | 'existing';
  try {
    ignorePolicy = await ensureKnowledgeIgnorePolicy(join(root, 'knowledge'));
    completedStages.push('ignore-policy-ready');
  } catch (error) {
    throw partialError(error, completedStages);
  }

  return Object.freeze({
    completedStages: Object.freeze([...completedStages]),
    gitRepository,
    ignorePolicy,
    knowledge,
    manifest,
    schemaVersion: MODE_A_INITIALIZATION_SCHEMA_VERSION,
  });
}
