import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { isNodeError, KnowledgeError } from './errors.js';

export interface AtomicWriteHooks {
  readonly beforeClose?: () => Promise<void> | void;
  readonly beforeRename?: () => Promise<void> | void;
  readonly beforeSync?: () => Promise<void> | void;
  readonly beforeWrite?: () => Promise<void> | void;
  readonly confinementRoot?: string;
}

interface DirectoryIdentity {
  readonly device: number;
  readonly inode: number;
  readonly path: string;
  readonly root: string;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function captureDirectoryIdentity(
  directory: string,
  confinementRoot: string,
): Promise<DirectoryIdentity> {
  try {
    const resolvedRoot = resolve(confinementRoot);
    const resolvedDirectory = resolve(directory);
    const [rootStatus, directoryStatus, canonicalRoot, canonicalDirectory] = await Promise.all([
      lstat(resolvedRoot),
      lstat(resolvedDirectory),
      realpath(resolvedRoot),
      realpath(resolvedDirectory),
    ]);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink() || canonicalRoot !== resolvedRoot ||
        !directoryStatus.isDirectory() || directoryStatus.isSymbolicLink() ||
        canonicalDirectory !== resolvedDirectory || !isContained(canonicalRoot, canonicalDirectory)) {
      throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Atomic write directory is unsafe.');
    }
    return {
      device: directoryStatus.dev,
      inode: directoryStatus.ino,
      path: canonicalDirectory,
      root: canonicalRoot,
    };
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Atomic write directory is unsafe.', {
      cause: error,
      recoveryCommand: ['project', 'validate'],
    });
  }
}

async function assertDirectoryIdentity(identity: DirectoryIdentity): Promise<void> {
  try {
    const [status, canonical] = await Promise.all([lstat(identity.path), realpath(identity.path)]);
    if (!status.isDirectory() || status.isSymbolicLink() || status.dev !== identity.device ||
        status.ino !== identity.inode || canonical !== identity.path ||
        !isContained(identity.root, canonical)) {
      throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Atomic write directory changed.');
    }
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Atomic write directory changed.', {
      cause: error,
      recoveryCommand: ['project', 'validate'],
    });
  }
}

async function assertReplaceableFile(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Refusing to replace an unsafe file target.');
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }
    if (error instanceof KnowledgeError) {
      throw error;
    }
    throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Unable to inspect registry target.', {
      cause: error,
      recoveryCommand: ['project', 'validate'],
    });
  }
}

export async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (
      !isNodeError(error) ||
      (error.code !== 'EINVAL' &&
        error.code !== 'EISDIR' &&
        error.code !== 'ENOTSUP' &&
        error.code !== 'EPERM')
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export function serializeCanonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const directory = dirname(path);
  const directoryIdentity = hooks.confinementRoot === undefined
    ? undefined
    : await captureDirectoryIdentity(directory, hooks.confinementRoot);
  await assertReplaceableFile(path);
  if (directoryIdentity !== undefined) await assertDirectoryIdentity(directoryIdentity);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await hooks.beforeWrite?.();
    if (directoryIdentity !== undefined) {
      await assertDirectoryIdentity(directoryIdentity);
      const [temporaryStatus, temporaryCanonical] = await Promise.all([
        handle.stat(),
        realpath(temporaryPath),
      ]);
      if (!temporaryStatus.isFile() || temporaryCanonical !== resolve(temporaryPath) ||
          !isContained(directoryIdentity.path, temporaryCanonical)) {
        throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Atomic temporary file is unsafe.');
      }
    }
    await handle.writeFile(serializeCanonicalJson(value), 'utf8');
    await hooks.beforeSync?.();
    if (directoryIdentity !== undefined) await assertDirectoryIdentity(directoryIdentity);
    await handle.sync();
    await hooks.beforeClose?.();
    await handle.close();
    handle = undefined;
    await hooks.beforeRename?.();
    if (directoryIdentity !== undefined) await assertDirectoryIdentity(directoryIdentity);
    await rename(temporaryPath, path);
    renamed = true;
    if (directoryIdentity !== undefined) {
      await assertDirectoryIdentity(directoryIdentity);
      const canonicalTarget = await realpath(path);
      if (canonicalTarget !== resolve(path) ||
          !isContained(directoryIdentity.path, canonicalTarget)) {
        throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Atomic write target is unsafe.');
      }
    }
    await syncDirectory(directory);
  } catch (error) {
    if (error instanceof KnowledgeError) {
      throw error;
    }
    throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Atomic file replacement failed.', {
      cause: error,
      recoveryCommand: ['project', 'validate'],
    });
  } finally {
    try {
      await handle?.close();
    } catch {
      // Preserve the structured failure already raised by the write path.
    }
    if (!renamed) {
      let cleanupAllowed = true;
      if (directoryIdentity !== undefined) {
        try {
          await assertDirectoryIdentity(directoryIdentity);
        } catch {
          cleanupAllowed = false;
        }
      }
      if (cleanupAllowed) {
        try {
          await unlink(temporaryPath);
        } catch (error) {
          if (!isNodeError(error) || error.code !== 'ENOENT') {
            // A failed cleanup never replaces the original failure or promotes the temp file.
          }
        }
      }
    }
  }
}
