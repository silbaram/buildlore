import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { withClientFileLock } from '../src/integrations/lock.js';

it('allows only one writer when concurrent contenders reclaim the same dead-owner lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-client-lock-'));
  const target = join(root, 'settings.json'), lock = join(root, '.buildlore-client-settings.lock');
  await mkdir(lock);
  await writeFile(join(lock, `owner-2147483647-${randomUUID()}`), '');
  let release = (): void => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered = 0, rejected = 0;
  const attempts = Array.from({ length: 20 }, async () => {
    try { await withClientFileLock(target, async () => { entered++; await held; }); }
    catch (error) { expect(error).toMatchObject({ code: 'CLIENT_CONFIG_BUSY' }); rejected++; }
  });
  try {
    await expect.poll(() => rejected).toBe(19);
    expect(entered).toBe(1);
    release(); await Promise.all(attempts);
    expect(await readdir(root)).toEqual([]);
    await expect(withClientFileLock(target, () => Promise.reject(new Error('write failed')))).rejects.toThrow('write failed');
    expect(await readdir(root)).toEqual([]);
  } finally { release(); await Promise.allSettled(attempts); await rm(root, { recursive: true, force: true }); }
});
