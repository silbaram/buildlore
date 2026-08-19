import { lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  serializeCanonicalJson,
  type AtomicWriteHooks,
  writeJsonAtomic,
} from './atomic-file.js';
import { isNodeError, KnowledgeError } from './errors.js';
import { resolveKnowledgeRoot } from './paths.js';
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeManifest } from './types.js';
import { parseKnowledgeManifest } from './validation.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface RegistryLockHooks {
  readonly afterOpen?: () => Promise<void> | void;
}

export function emptyManifest(): KnowledgeManifest {
  return { projects: [], schemaVersion: KNOWLEDGE_SCHEMA_VERSION };
}

async function readVerifiedManifestFile(
  manifestPath: string,
  expected: Awaited<ReturnType<typeof lstat>>,
): Promise<string> {
  let handle;
  try {
    handle = await open(manifestPath, 'r');
    const actual = await handle.stat();
    if (
      !actual.isFile() ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino
    ) {
      throw new KnowledgeError(
        'PATH_OUTSIDE_KNOWLEDGE',
        'Knowledge manifest changed during validation.',
      );
    }
    if (actual.size > MAX_MANIFEST_BYTES) {
      throw new KnowledgeError('MANIFEST_INVALID', 'Knowledge manifest is too large.');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle?.close();
  }
}

export async function readManifest(
  knowledgeRoot: string,
  options: { readonly allowMissing?: boolean } = {},
): Promise<KnowledgeManifest> {
  const root = await resolveKnowledgeRoot(knowledgeRoot);
  const manifestPath = join(root, 'manifest.json');
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(manifestPath);
  } catch (error) {
    if (options.allowMissing === true && isNodeError(error) && error.code === 'ENOENT') {
      return emptyManifest();
    }
    throw new KnowledgeError('MANIFEST_INVALID', 'Knowledge manifest is missing or unreadable.', {
      cause: error,
    });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Knowledge manifest is unsafe.');
  }
  if (metadata.size > MAX_MANIFEST_BYTES) {
    throw new KnowledgeError('MANIFEST_INVALID', 'Knowledge manifest is too large.');
  }
  try {
    const decoded = JSON.parse(
      await readVerifiedManifestFile(manifestPath, metadata),
    ) as unknown;
    const manifest = parseKnowledgeManifest(decoded);
    const sourceProjects = (
      decoded as { readonly projects: ReadonlyArray<{ readonly projectId: string }> }
    ).projects;
    if (
      sourceProjects.some(
        (project, index) => project.projectId !== manifest.projects[index]?.projectId,
      )
    ) {
      throw new KnowledgeError(
        'MANIFEST_INVALID',
        'Knowledge manifest projects must be sorted by projectId.',
      );
    }
    return manifest;
  } catch (error) {
    if (error instanceof KnowledgeError) {
      throw error;
    }
    throw new KnowledgeError('MANIFEST_INVALID', 'Knowledge manifest is not valid JSON.', {
      cause: error,
    });
  }
}

export async function writeManifest(
  knowledgeRoot: string,
  manifest: KnowledgeManifest,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const root = await resolveKnowledgeRoot(knowledgeRoot);
  const canonical = parseKnowledgeManifest(manifest);
  if (Buffer.byteLength(serializeCanonicalJson(canonical), 'utf8') > MAX_MANIFEST_BYTES) {
    throw new KnowledgeError('MANIFEST_INVALID', 'Knowledge manifest is too large.');
  }
  await writeJsonAtomic(join(root, 'manifest.json'), canonical, hooks);
}

export async function withRegistryLock<T>(
  knowledgeRoot: string,
  action: () => Promise<T>,
  hooks: RegistryLockHooks = {},
): Promise<T> {
  const root = await resolveKnowledgeRoot(knowledgeRoot);
  const lockPath = join(root, 'manifest.json.lock');
  let handle;
  let opened = false;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    opened = true;
    await hooks.afterOpen?.();
    await handle.writeFile('buildlore registry mutation\n', 'utf8');
    await handle.sync();
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // The original acquisition error remains authoritative.
    }
    if (opened) {
      try {
        await unlink(lockPath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
          throw new KnowledgeError(
            'REGISTRY_WRITE_FAILED',
            'Unable to clean up a failed registry lock.',
            { cause: cleanupError, recoveryCommand: ['project', 'validate'] },
          );
        }
      }
    }
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new KnowledgeError(
        'REGISTRY_BUSY',
        'Knowledge registry is busy. Inspect manifest.json.lock before retrying.',
        { recoveryCommand: ['project', 'validate'] },
      );
    }
    throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Unable to lock the knowledge registry.', {
      cause: error,
      recoveryCommand: ['project', 'validate'],
    });
  }

  const outcome = await Promise.resolve().then(action).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  );
  let cleanupError: unknown;
  try {
    await handle.close();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await unlink(lockPath);
  } catch (error) {
    if (cleanupError === undefined && (!isNodeError(error) || error.code !== 'ENOENT')) {
      cleanupError = error;
    }
  }
  if (cleanupError !== undefined) {
    throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Unable to release registry lock.', {
      cause: cleanupError,
      recoveryCommand: ['project', 'validate'],
    });
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
