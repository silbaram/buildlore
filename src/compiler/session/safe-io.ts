import { constants as fsConstants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import { decodeUtf8Strict } from '../../knowledge/strict-json.js';
import { SessionCompileError } from './errors.js';

function denied(projectId: string): never {
  throw new SessionCompileError('SESSION_PLAN_DENIED', projectId);
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

export async function readConfinedSessionUtf8(
  path: string,
  root: string,
  maximum: number,
  projectId: string,
): Promise<string> {
  let handle;
  try {
    const expected = await lstat(path, { bigint: true });
    const canonical = await realpath(path);
    if (!expected.isFile() || expected.isSymbolicLink() || expected.size > BigInt(maximum) ||
        !isContained(root, canonical) || canonical !== path) return denied(projectId);
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino ||
        before.size !== expected.size) return denied(projectId);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        bytes.byteLength !== Number(after.size)) return denied(projectId);
    return decodeUtf8Strict(bytes);
  } catch (error) {
    if (error instanceof SessionCompileError) throw error;
    return denied(projectId);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function listConfinedSessionFiles(
  directory: string,
  root: string,
  projectId: string,
  maximum: number,
): Promise<readonly string[]> {
  let handle;
  try {
    const status = await lstat(directory);
    const canonical = await realpath(directory);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== directory ||
        !isContained(root, canonical)) return denied(projectId);
    handle = await opendir(directory);
    const names: string[] = [];
    for await (const entry of handle) {
      if (!entry.isFile() || entry.isSymbolicLink()) return denied(projectId);
      names.push(entry.name);
      if (names.length > maximum) return denied(projectId);
    }
    return Object.freeze(names.sort());
  } catch (error) {
    if (error instanceof SessionCompileError) throw error;
    return denied(projectId);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function confinedSessionDirectoryExists(
  path: string,
  root: string,
  projectId: string,
): Promise<boolean> {
  try {
    const status = await lstat(path);
    const canonical = await realpath(path);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== path ||
        !isContained(root, canonical)) return denied(projectId);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    if (error instanceof SessionCompileError) throw error;
    return denied(projectId);
  }
}
