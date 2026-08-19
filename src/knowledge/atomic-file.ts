import { randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { isNodeError, KnowledgeError } from './errors.js';

export interface AtomicWriteHooks {
  readonly beforeClose?: () => Promise<void> | void;
  readonly beforeRename?: () => Promise<void> | void;
  readonly beforeSync?: () => Promise<void> | void;
  readonly beforeWrite?: () => Promise<void> | void;
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
  await assertReplaceableFile(path);
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await hooks.beforeWrite?.();
    await handle.writeFile(serializeCanonicalJson(value), 'utf8');
    await hooks.beforeSync?.();
    await handle.sync();
    await hooks.beforeClose?.();
    await handle.close();
    handle = undefined;
    await hooks.beforeRename?.();
    await rename(temporaryPath, path);
    renamed = true;
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
