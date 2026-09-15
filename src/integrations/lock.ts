import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureDirectory, safeDirectory } from '../connection/io.js';
import { isNodeError } from '../knowledge/errors.js';
import { reject } from './files.js';

function collision(error: unknown): boolean {
  return isNodeError(error) && ['EEXIST', 'ENOTEMPTY'].includes(error.code ?? '');
}
async function removeOwner(directory: string, owner: string): Promise<void> {
  try { await unlink(join(directory, owner)); } catch (error) {
    if (!(isNodeError(error) && error.code === 'ENOENT')) throw error;
  }
  // A contender may already have replaced the empty directory with its own
  // nonempty lock. Never recursively remove that new owner's directory.
  await rmdir(directory).catch(error => {
    if (!collision(error) && !(isNodeError(error) && error.code === 'ENOENT')) throw error;
  });
}
async function reclaim(directory: string): Promise<void> {
  const stat = await lstat(directory).catch(error => {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return;
  await safeDirectory(directory);
  const entries = await readdir(directory);
  if (entries.length === 0) return; // Atomic publication may replace an empty released lock.
  if (entries.length !== 1) reject('CLIENT_CONFIG_BUSY');
  const owner = entries[0];
  const match = owner && /^owner-([1-9][0-9]*)-[a-f0-9-]{36}$/u.exec(owner);
  if (!owner || !match) reject('CLIENT_CONFIG_BUSY');
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) reject('CLIENT_CONFIG_BUSY');
  const entry = await lstat(join(directory, owner)).catch(error => {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) return;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size !== 0) reject('CLIENT_CONFIG_BUSY');
  try { process.kill(pid, 0); } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') { await removeOwner(directory, owner); return; }
  }
  reject('CLIENT_CONFIG_BUSY');
}

/** Lock the actual destination, including callers with different config roots. */
export async function withClientFileLock<T>(target: string, action: () => Promise<T>): Promise<T> {
  const parent = dirname(target);
  await ensureDirectory(parent);
  const directory = join(parent, '.buildlore-client-settings.lock');
  const staging = await mkdtemp(join(parent, '.buildlore-client-lock-'));
  const owner = `owner-${process.pid}-${randomUUID()}`;
  let published = false;
  try {
    await writeFile(join(staging, owner), '', { flag: 'wx', mode: 0o600 });
    try { await rename(staging, directory); } catch (error) {
      if (!collision(error)) reject('CLIENT_CONFIG_BUSY');
      await reclaim(directory).catch(() => reject('CLIENT_CONFIG_BUSY'));
      await rename(staging, directory).catch(() => reject('CLIENT_CONFIG_BUSY'));
    }
    published = true;
    return await action();
  } finally {
    await removeOwner(published ? directory : staging, owner);
  }
}
