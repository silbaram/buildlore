import { constants as fsConstants, type Dirent } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { TextDecoder } from 'node:util';

import { ProfileOperationError } from './errors.js';
import { sha256 } from './materializer.js';
import type { ProfileEntityType } from './types.js';

const MAX_PROFILE_FILE_BYTES = 512 * 1024;
const MAX_ENTITY_PAGES = 4_096;

function unsafe(projectId: string): never {
  throw new ProfileOperationError('PROFILE_UNSAFE', { projectId });
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

export async function readConfinedText(
  workspace: string,
  path: string,
  projectId: string,
  options: { readonly optional?: boolean; readonly maximumBytes?: number } = {},
): Promise<string | null> {
  const maximumBytes = options.maximumBytes ?? MAX_PROFILE_FILE_BYTES;
  let expected: Awaited<ReturnType<typeof lstat>>;
  try {
    expected = await lstat(path);
  } catch (error) {
    if (options.optional === true && isMissing(error)) return null;
    return unsafe(projectId);
  }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size > maximumBytes) {
    return unsafe(projectId);
  }
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    return unsafe(projectId);
  }
  if (canonical !== path || !isContained(workspace, canonical)) return unsafe(projectId);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino ||
        actual.size > maximumBytes || await realpath(path) !== path) return unsafe(projectId);
    const bytes = await handle.readFile();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return unsafe(projectId);
    }
  } catch (error) {
    if (error instanceof ProfileOperationError) throw error;
    return unsafe(projectId);
  } finally {
    try {
      await handle?.close();
    } catch {
      unsafe(projectId);
    }
  }
}

async function readDirectory(path: string, workspace: string, projectId: string): Promise<readonly Dirent[]> {
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return [];
    return unsafe(projectId);
  }
  if (!status.isDirectory() || status.isSymbolicLink() || await realpath(path) !== path ||
      !isContained(workspace, path)) return unsafe(projectId);
  const entries: Dirent[] = [];
  let directory;
  try {
    directory = await opendir(path);
    for await (const entry of directory) {
      if (entries.length >= MAX_ENTITY_PAGES) return unsafe(projectId);
      entries.push(entry);
    }
  } catch (error) {
    if (error instanceof ProfileOperationError) throw error;
    return unsafe(projectId);
  } finally {
    try {
      await directory?.close();
    } catch {
      unsafe(projectId);
    }
  }
  return entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

export async function readEntityInventory(
  workspace: string,
  projectId: string,
): Promise<Readonly<{
  counts: Readonly<Record<ProfileEntityType, number>>;
  digest: `sha256:${string}`;
}>> {
  const entityTypes = ['decisions', 'failures', 'verifications'] as const;
  const counts: Record<ProfileEntityType, number> = {
    decisions: 0,
    failures: 0,
    verifications: 0,
  };
  const bindings: string[] = [];
  for (const entityType of entityTypes) {
    const directory = join(workspace, 'wiki', entityType);
    const entries = await readDirectory(directory, workspace, projectId);
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.md')) {
        return unsafe(projectId);
      }
      const body = await readConfinedText(workspace, join(directory, entry.name), projectId);
      if (body === null) return unsafe(projectId);
      bindings.push(`${entityType}:${entry.name}:${sha256(body)}`);
      counts[entityType] += 1;
    }
  }
  return Object.freeze({ counts: Object.freeze(counts), digest: sha256(bindings.join('\n')) });
}
