import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { serializeCanonicalJson, syncDirectory } from './atomic-file.js';
import { isNodeError, KnowledgeError } from './errors.js';
import { assertSafeRegularFile, resolveKnowledgeRoot, resolveProjectWorkspace } from './paths.js';
import { readManifest, withRegistryLock, writeManifest } from './registry.js';
import { ensureKnowledgeIgnorePolicy } from './tracking-policy.js';
import {
  type AddProjectInput,
  type ProjectDescriptor,
  type ProjectRecord,
  type ProjectRegistryEntry,
} from './types.js';
import {
  createProjectDescriptor,
  parseProjectDescriptor,
  projectPathFor,
  validateDisplayName,
  validateProjectId,
  validateRepositoryLocator,
} from './validation.js';

const MAX_DESCRIPTOR_BYTES = 64 * 1024;

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readDescriptor(workspace: string): Promise<ProjectDescriptor> {
  const path = join(workspace, 'project.json');
  let expected: Awaited<ReturnType<typeof lstat>>;
  try {
    expected = await lstat(path);
  } catch (error) {
    throw new KnowledgeError('MANIFEST_INVALID', 'Project descriptor is missing or unreadable.', {
      cause: error,
    });
  }
  if (!expected.isFile() || expected.isSymbolicLink()) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Project descriptor is unsafe.');
  }
  if (expected.size > MAX_DESCRIPTOR_BYTES) {
    throw new KnowledgeError('MANIFEST_INVALID', 'Project descriptor is too large.');
  }

  let handle;
  let raw: string;
  try {
    handle = await open(path, 'r');
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new KnowledgeError(
        'PATH_OUTSIDE_KNOWLEDGE',
        'Project descriptor changed during validation.',
      );
    }
    if (actual.size > MAX_DESCRIPTOR_BYTES) {
      throw new KnowledgeError('MANIFEST_INVALID', 'Project descriptor is too large.');
    }
    raw = await handle.readFile('utf8');
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (error instanceof KnowledgeError) {
      throw error;
    }
    throw new KnowledgeError('MANIFEST_INVALID', 'Project descriptor is unreadable.', {
      cause: error,
    });
  } finally {
    try {
      await handle?.close();
    } catch {
      // Preserve the structured read failure from the try/catch above.
    }
  }
  try {
    return parseProjectDescriptor(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof KnowledgeError) {
      throw error;
    }
    throw new KnowledgeError('MANIFEST_INVALID', 'Project descriptor is not valid JSON.', {
      cause: error,
    });
  }
}

async function validateWorkspaceShape(workspace: string): Promise<ProjectDescriptor> {
  let workspaceStatus: Awaited<ReturnType<typeof lstat>>;
  try {
    workspaceStatus = await lstat(workspace);
  } catch (error) {
    throw new KnowledgeError('MANIFEST_INVALID', 'Project workspace is missing or unreadable.', {
      cause: error,
      recoveryCommand: ['project', 'validate'],
    });
  }
  if (!workspaceStatus.isDirectory() || workspaceStatus.isSymbolicLink()) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Project workspace root is unsafe.');
  }
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(workspace);
  } catch (error) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Unable to resolve project workspace root.', {
      cause: error,
    });
  }
  if (canonicalWorkspace !== workspace) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Project workspace root is not canonical.');
  }

  for (const directory of ['sources', 'wiki', '.llmwiki']) {
    const directoryPath = join(workspace, directory);
    let status: Awaited<ReturnType<typeof lstat>>;
    try {
      status = await lstat(directoryPath);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new KnowledgeError('MANIFEST_INVALID', 'Project workspace is incomplete.', {
          cause: error,
          recoveryCommand: ['project', 'validate'],
        });
      }
      throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Unable to verify project workspace.', {
        cause: error,
      });
    }
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Project workspace shape is unsafe.');
    }
    let actual: string;
    try {
      actual = await realpath(directoryPath);
    } catch (error) {
      throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Unable to resolve project workspace.', {
        cause: error,
      });
    }
    if (!isContained(canonicalWorkspace, actual)) {
      throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Project workspace path escapes its root.');
    }
  }
  await assertSafeRegularFile(join(workspace, 'log.md'));
  return readDescriptor(workspace);
}

function descriptorMatches(
  actual: ProjectDescriptor,
  expected: ProjectDescriptor,
): boolean {
  return (
    actual.profileVersion === expected.profileVersion &&
    actual.projectId === expected.projectId &&
    actual.schemaVersion === expected.schemaVersion &&
    actual.sourceRepository === expected.sourceRepository
  );
}

async function createStagedWorkspace(
  projectsRoot: string,
  descriptor: ProjectDescriptor,
): Promise<string> {
  const staging = join(projectsRoot, `.buildlore-workspace-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  await Promise.all(
    ['sources', 'wiki', '.llmwiki'].map(async (directory) =>
      mkdir(join(staging, directory), { mode: 0o700 }),
    ),
  );
  await Promise.all([
    writeFile(join(staging, 'project.json'), serializeCanonicalJson(descriptor), {
      encoding: 'utf8',
      flag: 'wx',
      flush: true,
      mode: 0o600,
    }),
    writeFile(join(staging, 'log.md'), '# BuildLore project log\n', {
      encoding: 'utf8',
      flag: 'wx',
      flush: true,
      mode: 0o600,
    }),
  ]);
  await validateWorkspaceShape(staging);
  await Promise.all(
    ['sources', 'wiki', '.llmwiki'].map(async (directory) =>
      syncDirectory(join(staging, directory)),
    ),
  );
  await syncDirectory(staging);
  return staging;
}

async function projectRecordForEntry(
  knowledgeRoot: string,
  entry: ProjectRegistryEntry,
): Promise<ProjectRecord> {
  const workspace = await resolveProjectWorkspace(knowledgeRoot, entry.projectId, {
    mustExist: true,
  });
  const descriptor = await validateWorkspaceShape(workspace);
  if (
    descriptor.projectId !== entry.projectId ||
    descriptor.sourceRepository !== entry.sourceRepository
  ) {
    throw new KnowledgeError('MANIFEST_INVALID', 'Project descriptor does not match the registry.');
  }
  return { descriptor, entry, workspacePath: entry.path };
}

export async function addProject(
  knowledgeRoot: string,
  input: AddProjectInput,
): Promise<ProjectRecord> {
  const root = await resolveKnowledgeRoot(knowledgeRoot);
  const projectId = validateProjectId(input.projectId);
  const descriptor = createProjectDescriptor({
    projectId,
    sourceRepository: validateRepositoryLocator(input.sourceRepository),
  });
  const entry: ProjectRegistryEntry = {
    displayName: validateDisplayName(input.displayName),
    path: projectPathFor(projectId),
    projectId,
    sourceRepository: descriptor.sourceRepository,
  };

  return withRegistryLock(root, async () => {
    const manifest = await readManifest(root, { allowMissing: true });
    if (
      manifest.projects.some(
        (project) => project.projectId === projectId || project.path === entry.path,
      )
    ) {
      throw new KnowledgeError('PROJECT_EXISTS', 'Project is already registered.');
    }
    const projectsRoot = join(root, 'projects');
    const workspace = await resolveProjectWorkspace(root, projectId);
    const workspaceExists = await pathExists(workspace);
    if (workspaceExists) {
      const existing = await validateWorkspaceShape(workspace);
      if (!descriptorMatches(existing, descriptor)) {
        throw new KnowledgeError(
          'PROJECT_EXISTS',
          'An unregistered workspace exists with different metadata.',
        );
      }
    }
    await ensureKnowledgeIgnorePolicy(root);
    try {
      await mkdir(projectsRoot, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Unable to prepare projects directory.', {
        cause: error,
        recoveryCommand: ['project', 'validate'],
      });
    }
    if (!workspaceExists) {
      let staging: string;
      try {
        staging = await createStagedWorkspace(projectsRoot, descriptor);
        await rename(staging, workspace);
        await syncDirectory(projectsRoot);
      } catch (error) {
        if (error instanceof KnowledgeError) {
          throw error;
        }
        throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Unable to publish project workspace.', {
          cause: error,
          recoveryCommand: ['project', 'validate'],
        });
      }
      await resolveProjectWorkspace(root, projectId, { mustExist: true });
    }
    const published = await validateWorkspaceShape(workspace);
    if (!descriptorMatches(published, descriptor)) {
      throw new KnowledgeError(
        'REGISTRY_WRITE_FAILED',
        'Published project workspace changed before registry update.',
        { recoveryCommand: ['project', 'validate'] },
      );
    }

    await writeManifest(root, {
      projects: [...manifest.projects, entry],
      schemaVersion: manifest.schemaVersion,
    });
    return { descriptor, entry, workspacePath: entry.path };
  });
}

export async function listProjects(knowledgeRoot: string): Promise<readonly ProjectRegistryEntry[]> {
  return (await readManifest(knowledgeRoot, { allowMissing: true })).projects;
}

export async function showProject(
  knowledgeRoot: string,
  projectId: string,
): Promise<ProjectRecord> {
  const id = validateProjectId(projectId);
  const manifest = await readManifest(knowledgeRoot, { allowMissing: true });
  const entry = manifest.projects.find((project) => project.projectId === id);
  if (entry === undefined) {
    throw new KnowledgeError('PROJECT_NOT_FOUND', 'Project is not registered.', {
      recoveryCommand: ['project', 'list'],
    });
  }
  return projectRecordForEntry(knowledgeRoot, entry);
}

export async function validateProjectRegistry(
  knowledgeRoot: string,
  projectId?: string,
): Promise<{ readonly project: ProjectRecord | null; readonly valid: true }> {
  const manifest = await readManifest(knowledgeRoot, { allowMissing: projectId !== undefined });
  if (projectId === undefined) {
    for (const entry of manifest.projects) {
      await projectRecordForEntry(knowledgeRoot, entry);
    }
    return { project: null, valid: true };
  }
  const id = validateProjectId(projectId);
  const entry = manifest.projects.find((candidate) => candidate.projectId === id);
  if (entry === undefined) {
    throw new KnowledgeError('PROJECT_NOT_FOUND', 'Project is not registered.', {
      recoveryCommand: ['project', 'list'],
    });
  }
  return { project: await projectRecordForEntry(knowledgeRoot, entry), valid: true };
}
