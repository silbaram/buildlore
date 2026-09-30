import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHierarchyPayloadStore } from '../src/cli/hierarchical-run-store.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';

interface Payload {
  readonly schemaVersion: 'buildlore.store-fixture.v1';
  readonly projectId: string;
  readonly runId: string;
  readonly revision: number;
  readonly recordDigest: `sha256:${string}`;
}

function payload(revision = 0): Payload {
  const basis = { schemaVersion: 'buildlore.store-fixture.v1' as const,
    projectId: 'alpha', runId: `run-${'1'.repeat(64)}`, revision };
  return { ...basis, recordDigest: `sha256:${createHash('sha256').update(serializeCanonicalJson(basis)).digest('hex')}` };
}

function parse(value: unknown, projectId: string, runId: string): Payload {
  if (value === null || typeof value !== 'object' || !('schemaVersion' in value) ||
      value.schemaVersion !== 'buildlore.store-fixture.v1' || !('projectId' in value) ||
      value.projectId !== projectId || !('runId' in value) || value.runId !== runId ||
      !('revision' in value) || typeof value.revision !== 'number' ||
      !('recordDigest' in value) || typeof value.recordDigest !== 'string' ||
      value.recordDigest !== payload(value.revision).recordDigest) {
    throw new Error('Invalid fixture record.');
  }
  return payload(value.revision);
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 3 }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'buildlore store with spaces '));
  roots.push(root);
  const store = createHierarchyPayloadStore(root, parse), initial = payload();
  await store.create(initial);
  const directory = join(root, '.buildlore', 'hierarchy-runs', initial.projectId, initial.runId);
  return { root, store, initial, directory, path: join(directory, 'run.json') };
}

describe('shared hierarchy payload persistence', () => {
  it('reopens saved state and refuses a stale writer without replacing the committed revision', async () => {
    const f = await fixture(), next = payload(1);
    await expect(createHierarchyPayloadStore(f.root, parse).read('alpha', f.initial.runId)).resolves.toEqual(f.initial);
    await f.store.replace(f.initial, next);
    await expect(f.store.replace(f.initial, next)).rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_RUN_CONFLICT' });
    await expect(f.store.read('alpha', next.runId)).resolves.toEqual(next);
    await expect(lstat(join(f.directory, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves live and unknown-owner locks and the previous run', async () => {
    const f = await fixture(), lock = join(f.directory, 'run.lock');
    for (const host of [hostname(), 'foreign-fixture-host']) {
      const owner = { schemaVersion: 'buildlore.hierarchical-workflow-run-lock.v1', hostname: host,
        pid: process.pid, token: '2'.repeat(64) };
      await writeFile(lock, serializeCanonicalJson(owner), { mode: 0o600, flag: 'wx' });
      await expect(f.store.replace(f.initial, payload(1))).rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_RUN_BUSY' });
      expect(await readFile(lock, 'utf8')).toBe(serializeCanonicalJson(owner));
      await expect(f.store.read('alpha', f.initial.runId)).resolves.toEqual(f.initial);
      await unlink(lock);
    }
  });

  it('rejects an extra hardlink to the run record before replay', async () => {
    const f = await fixture();
    await link(f.path, join(f.directory, 'extra.json'));
    await expect(f.store.read('alpha', f.initial.runId)).rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_RUN_INVALID' });
  });

  it('rejects a read-only record without changing saved state or leaving a lock', async () => {
    const f = await fixture(), saved = await readFile(f.path);
    await chmod(f.path, 0o444);
    try {
      await expect(f.store.read('alpha', f.initial.runId)).rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_RUN_INVALID' });
      await expect(f.store.replace(f.initial, payload(1))).rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_RUN_INVALID' });
    } finally { await chmod(f.path, 0o600); }
    expect(await readFile(f.path)).toEqual(saved);
    await expect(f.store.read('alpha', f.initial.runId)).resolves.toEqual(f.initial);
    await expect(lstat(join(f.directory, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a redirected state directory (a junction on Windows)', async () => {
    const f = await fixture(), directory = join(f.root, '.buildlore', 'hierarchy-runs', 'alpha');
    const { rename } = await import('node:fs/promises');
    const saved = join(f.root, 'redirected');
    await rename(directory, saved);
    await symlink(saved, directory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.store.read('alpha', f.initial.runId)).rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED' });
  });

  it.skipIf(process.platform === 'win32')('keeps POSIX private file and directory checks after state creation', async () => {
    const f = await fixture();
    await chmod(f.path, 0o666);
    await expect(f.store.read('alpha', f.initial.runId)).rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_RUN_INVALID' });
    await chmod(f.path, 0o600);
    await chmod(f.directory, 0o777);
    await expect(f.store.read('alpha', f.initial.runId)).rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED' });
  });
});
