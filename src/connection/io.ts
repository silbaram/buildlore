import { constants } from 'node:fs';
import { lstat, realpath, open, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isNodeError } from '../knowledge/errors.js';
import { serializeCanonicalJson, writeJsonAtomic } from '../knowledge/atomic-file.js';
import { absolute, decodeConfig, fail, hash, type Digest } from './contracts.js';

export function configDirectory(env: Readonly<NodeJS.ProcessEnv> = process.env): string {
  if (env.BUILDLORE_CONFIG_DIR !== undefined) return absolute(env.BUILDLORE_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME !== undefined) return join(absolute(env.XDG_CONFIG_HOME), 'buildlore');
  return join(homedir(), '.config', 'buildlore');
}
export async function safeDirectory(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => fail('READ_BOUNDARY_VIOLATION'));
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path)) fail('READ_BOUNDARY_VIOLATION');
}
export async function ensureDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) fail();
  try { await lstat(path); } catch (e) {
    if (!isNodeError(e) || e.code !== 'ENOENT') fail('CONNECTION_WRITE_FAILED');
    await ensureDirectory(dirname(path));
    await mkdir(path, { mode: 0o700 }).catch(async e => {
      if (!isNodeError(e) || e.code !== 'EEXIST') fail('CONNECTION_WRITE_FAILED');
      await safeDirectory(path);
    });
  }
  await safeDirectory(path);
}
export interface ConfigFile { readonly value: unknown; readonly digest: Digest }
export async function readConfig(path: string, maxBytes: number): Promise<ConfigFile | null> {
  try {
    // Inspect the parent even for a missing file; a dangling symlink is not absence.
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail('READ_BOUNDARY_VIOLATION');
    await safeDirectory(dirname(path));
  } catch (e) {
    if (isNodeError(e) && e.code === 'ENOENT') return null;
    throw e;
  }
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) fail();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size > maxBytes) fail();
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat(), entry = await lstat(path);
    await safeDirectory(dirname(path));
    if (length > maxBytes || after.size !== current.size || after.mtimeMs !== current.mtimeMs ||
        entry.dev !== current.dev || entry.ino !== current.ino || entry.isSymbolicLink()) fail();
    const body = bytes.subarray(0, length);
    return { value: decodeConfig(body, maxBytes), digest: hash(body) };
  } catch (e) {
    if (isNodeError(e) && e.code === 'ENOENT') return null;
    throw e;
  } finally { await handle?.close(); }
}
export async function replaceConfig(path: string, value: unknown, expected: Digest | null, maxBytes: number, validate?: () => Promise<void>): Promise<void> {
  if (Buffer.byteLength(serializeCanonicalJson(value)) > maxBytes) fail('CONNECTION_INVALID');
  if ((await readConfig(path, maxBytes))?.digest !== (expected ?? undefined)) fail('CONNECTION_CONFLICT');
  await writeJsonAtomic(path, value, { confinementRoot: dirname(path), beforeRename: async () => {
    await validate?.();
    if ((await readConfig(path, maxBytes))?.digest !== (expected ?? undefined)) fail('CONNECTION_CONFLICT');
  } });
}
export async function withRegistryLock<T>(config: string, sourceRoot: string, action: () => Promise<T>): Promise<T> {
  await ensureDirectory(config);
  const directory = join(config, 'locks');
  await ensureDirectory(directory);
  const handles = [];
  try {
    for (const name of ['registry', hash(sourceRoot).slice(7)]) {
      const path = join(directory, `${name}.lock`);
      const handle = await open(path, 'wx', 0o600).catch(() => fail('CONNECTION_BUSY'));
      handles.push({ path, handle });
    }
    return await action();
  } finally {
    for (const { path, handle } of handles.reverse()) {
      const owned = await handle.stat();
      await handle.close();
      await safeDirectory(directory);
      const current = await lstat(path).catch(() => null);
      if (current?.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await unlink(path);
    }
  }
}
