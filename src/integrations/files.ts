import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeDirectory, ensureDirectory } from '../connection/io.js';
import { hash } from '../connection/contracts.js';
import { decodeUtf8Strict } from '../knowledge/strict-json.js';
import { isNodeError } from '../knowledge/errors.js';

export class ClientConfigError extends Error {
  constructor(readonly code: string, readonly snippet: string | null = null) { super(code); this.name = 'ClientConfigError'; }
}
export function reject(code = 'CLIENT_CONFIG_CONFLICT'): never { throw new ClientConfigError(code); }
export interface FileSnapshot { text: string; digest: string; identity: string | null; mode: number }
async function checkParents(path: string): Promise<void> {
  const parent = dirname(path);
  try { await safeDirectory(parent); } catch (e) {
    try { await lstat(parent); } catch (missing) {
      if (isNodeError(missing) && missing.code === 'ENOENT' && dirname(parent) !== parent) { await checkParents(parent); return; }
    }
    throw e;
  }
}
export async function readPrivateFile(path: string): Promise<FileSnapshot> {
  await checkParents(path);
  let handle;
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 4 * 1024 * 1024) reject('CLIENT_CONFIG_INVALID');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await handle.stat();
    if (st.dev !== s.dev || st.ino !== s.ino) reject();
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break; length += bytesRead;
    }
    const after = await handle.stat(), entry = await lstat(path);
    if (length > 4 * 1024 * 1024 || after.mtimeMs !== st.mtimeMs || after.size !== st.size || entry.ino !== st.ino || entry.dev !== st.dev || entry.isSymbolicLink()) reject();
    const bytes = buffer.subarray(0, length);
    return { text: decodeUtf8Strict(bytes), digest: hash(bytes), identity: `${st.dev}:${st.ino}`, mode: st.mode & 0o777 };
  } catch (e) {
    if (isNodeError(e) && e.code === 'ENOENT') return { text: '', digest: hash(''), identity: null, mode: 0o600 };
    throw e;
  } finally { await handle?.close(); }
}
export async function replacePrivateFile(path: string, before: FileSnapshot, text: string, remove = false): Promise<void> {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) reject('CLIENT_CONFIG_TOO_LARGE');
  await ensureDirectory(dirname(path));
  const check = async (): Promise<void> => {
    const current = await readPrivateFile(path);
    if (current.digest !== before.digest || current.identity !== before.identity) reject();
  };
  await check();
  if (remove) { if (before.identity !== null) await unlink(path); return; }
  if (before.identity !== null && text === before.text) return;
  const temp = join(dirname(path), `.buildlore-${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', before.mode);
  try {
    await handle.writeFile(text); await handle.sync(); await handle.close();
    await check(); await rename(temp, path);
  } finally { await handle.close(); await unlink(temp).catch(e => { if (!isNodeError(e) || e.code !== 'ENOENT') throw e; }); }
}
