import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { isNodeError, KnowledgeError } from './errors.js';
import { projectPathFor, validateProjectId } from './validation.js';

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Unable to verify a knowledge path.', {
      cause: error,
    });
  }
}

export async function resolveKnowledgeRoot(knowledgeRoot: string): Promise<string> {
  const status = await safeLstat(knowledgeRoot);
  if (status === null || !status.isDirectory() || status.isSymbolicLink()) {
    throw new KnowledgeError(
      'PATH_OUTSIDE_KNOWLEDGE',
      'Knowledge root must be an existing non-symlink directory.',
    );
  }
  try {
    return await realpath(knowledgeRoot);
  } catch (error) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Unable to resolve the knowledge root.', {
      cause: error,
    });
  }
}

export async function resolveProjectWorkspace(
  knowledgeRoot: string,
  projectId: string,
  options: { readonly mustExist?: boolean } = {},
): Promise<string> {
  validateProjectId(projectId);
  const root = await resolveKnowledgeRoot(knowledgeRoot);
  const projectsRoot = join(root, 'projects');
  const candidate = join(root, ...projectPathFor(projectId).split('/'));
  if (!isContained(root, candidate)) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Project path escapes the knowledge root.');
  }

  for (const path of [projectsRoot, candidate]) {
    const status = await safeLstat(path);
    if (status === null) {
      if (options.mustExist === true) {
        throw new KnowledgeError('PROJECT_NOT_FOUND', 'Project workspace is missing.', {
          recoveryCommand: ['project', 'list'],
        });
      }
      break;
    }
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Project path contains an unsafe entry.');
    }
    let actual: string;
    try {
      actual = await realpath(path);
    } catch (error) {
      throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Unable to resolve a project path.', {
        cause: error,
      });
    }
    if (!isContained(root, actual)) {
      throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Project realpath escapes the knowledge root.');
    }
  }
  return candidate;
}

export async function assertSafeRegularFile(path: string): Promise<void> {
  const status = await safeLstat(path);
  if (status === null || !status.isFile() || status.isSymbolicLink()) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Expected a confined regular file.');
  }
}
