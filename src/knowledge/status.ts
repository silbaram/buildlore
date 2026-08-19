import { join } from 'node:path';

import { KnowledgeError } from './errors.js';
import { getSubmoduleStatus } from './git.js';
import {
  STATUS_SCHEMA_VERSION,
  type CompilerStatusPort,
  type KnowledgePinState,
  type KnowledgeStatus,
  type ProjectKnowledgeStatus,
  type SubmoduleStatus,
} from './types.js';
import { validateProjectId } from './validation.js';
import { showProject } from './workspace.js';

function recoveryFor(state: KnowledgeStatus['knowledge']['state']): readonly string[] | undefined {
  switch (state) {
    case 'unconfigured':
      return ['knowledge', 'clone'];
    case 'uninitialized':
    case 'commit-mismatch':
      return ['knowledge', 'init'];
    case 'conflicted':
    case 'invalid':
      return ['knowledge', 'status'];
    case 'ready':
      return undefined;
  }
}

function pinStateFor(state: SubmoduleStatus['state']): KnowledgePinState {
  switch (state) {
    case 'ready':
      return 'matched';
    case 'commit-mismatch':
      return 'mismatched';
    case 'conflicted':
      return 'conflicted';
    case 'uninitialized':
      return 'uninitialized';
    case 'unconfigured':
      return 'unconfigured';
    case 'invalid':
      return 'invalid';
  }
}

function statusResult(
  knowledge: SubmoduleStatus,
  project: ProjectKnowledgeStatus | null,
  options: {
    readonly ok: boolean;
    readonly projectId?: string;
    readonly recoveryCommand?: readonly string[];
  },
): KnowledgeStatus {
  return {
    compiler: project?.compiler ?? null,
    currentCommit: knowledge.checkedOutCommit,
    initialized:
      knowledge.state === 'ready' ||
      knowledge.state === 'commit-mismatch' ||
      knowledge.state === 'conflicted',
    knowledge,
    ok: options.ok,
    pinState: pinStateFor(knowledge.state),
    pinnedCommit: knowledge.pinnedCommit,
    project,
    projectId: project?.projectId ?? options.projectId ?? null,
    ...(options.recoveryCommand === undefined
      ? {}
      : { recoveryCommand: options.recoveryCommand }),
    schemaVersion: STATUS_SCHEMA_VERSION,
    workspacePath: project?.workspacePath ?? null,
  };
}

export async function getKnowledgeStatus(
  repositoryRoot: string,
  options: {
    readonly compiler?: CompilerStatusPort;
    readonly projectId?: string;
  } = {},
): Promise<KnowledgeStatus> {
  const selectedProjectId =
    options.projectId === undefined ? undefined : validateProjectId(options.projectId);
  const knowledge = await getSubmoduleStatus(repositoryRoot);
  const recoveryCommand = recoveryFor(knowledge.state);
  if (knowledge.state !== 'ready') {
    return statusResult(knowledge, null, {
      ok: false,
      ...(selectedProjectId === undefined ? {} : { projectId: selectedProjectId }),
      ...(recoveryCommand === undefined ? {} : { recoveryCommand }),
    });
  }
  if (selectedProjectId === undefined) {
    return statusResult(knowledge, null, { ok: true });
  }
  if (options.compiler === undefined) {
    throw new KnowledgeError('COMPILER_STATUS_UNSAFE', 'Compiler status adapter is unavailable.');
  }
  const project = await getProjectKnowledgeStatus(
    join(repositoryRoot, 'knowledge'),
    selectedProjectId,
    options.compiler,
  );
  return statusResult(knowledge, project, { ok: true });
}

export async function getProjectKnowledgeStatus(
  knowledgeRoot: string,
  projectId: string,
  compiler: CompilerStatusPort,
): Promise<NonNullable<KnowledgeStatus['project']>> {
  const record = await showProject(knowledgeRoot, projectId);
  let status;
  try {
    status = await compiler.status(record.entry.projectId);
  } catch (error) {
    if (error instanceof KnowledgeError) {
      throw error;
    }
    throw new KnowledgeError('COMPILER_STATUS_UNSAFE', 'Compiler status could not be read safely.', {
      cause: error,
    });
  }
  return {
    compiler: status,
    projectId: record.entry.projectId,
    workspacePath: record.entry.path,
    workspaceState: 'ready',
  };
}
