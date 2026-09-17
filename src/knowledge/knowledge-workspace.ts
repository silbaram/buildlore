import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ensureDirectory, readConfig, replaceConfig, safeDirectory } from '../connection/io.js';
import { fail, locator, record } from '../connection/contracts.js';
import { gitRead, worktreeRoot } from '../connection/git-read.js';
import { isNodeError } from './errors.js';
import { sameRepository } from './repository-paths.js';
import { emptyManifest, readManifest, writeManifest } from './registry.js';
import { initializeLocalProjectRegistry } from './local-project-registry.js';
import { createRepositoryWriterLease } from './repository-writer-lease.js';
import { KNOWLEDGE_GITIGNORE } from './tracking-policy.js';
import { writeTextAtomic } from './atomic-file.js';
import { decodeUtf8Strict } from './strict-json.js';

export const KNOWLEDGE_WORKSPACE_VERSION = 'buildlore.workspace.v1' as const;
export interface KnowledgeWorkspace {
  readonly schemaVersion: typeof KNOWLEDGE_WORKSPACE_VERSION;
  readonly mode: 'knowledge';
  readonly knowledgeRepository: string;
}
export interface WorkspaceLayout {
  readonly mode: 'legacy-hub' | 'knowledge';
  readonly root: string;
  readonly knowledgeRoot: string;
}
const markerPath = (root: string): string => join(root, '.buildlore', 'workspace.json');

export function parseKnowledgeWorkspace(value: unknown): KnowledgeWorkspace {
  const v = record(value, ['schemaVersion', 'mode', 'knowledgeRepository']);
  if (v.schemaVersion !== KNOWLEDGE_WORKSPACE_VERSION || v.mode !== 'knowledge') fail('FORMAT_UNSUPPORTED');
  const repository = locator(v.knowledgeRepository);
  if (repository !== v.knowledgeRepository) fail();
  return { schemaVersion: KNOWLEDGE_WORKSPACE_VERSION, mode: 'knowledge', knowledgeRepository: repository };
}

async function assertDirectRoot(root: string, repository: string): Promise<void> {
  await safeDirectory(root);
  if (await worktreeRoot(root) !== root) fail('READ_BOUNDARY_VIOLATION');
  // Neither a legacy hub nor a source checkout may silently become a knowledge workspace.
  for (const file of ['.gitmodules', '.buildlore/connection.json', '.buildlore/sources.json']) {
    const stat = await lstat(join(root, file)).catch(error => {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat) fail('CONNECTION_CONFLICT');
  }
  const origin = (await gitRead(root, ['config', '--local', '--get', 'remote.origin.url'], true))?.trimEnd();
  if (origin && !await sameRepository(repository, root, origin, root)) fail('KNOWLEDGE_IDENTITY_MISMATCH');
}

export async function inspectKnowledgeWorkspace(root: string): Promise<KnowledgeWorkspace> {
  const file = await readConfig(markerPath(root), 16 * 1024);
  if (!file) fail('HUB_UNAVAILABLE');
  const workspace = parseKnowledgeWorkspace(file.value);
  await assertDirectRoot(root, workspace.knowledgeRepository);
  await readManifest(root);
  return workspace;
}

/** A valid explicit marker selects direct mode; malformed markers never fall back. */
export async function resolveWorkspaceLayout(directory: string): Promise<WorkspaceLayout> {
  const root = resolve(directory);
  const marker = await readConfig(markerPath(root), 16 * 1024);
  if (!marker) return { mode: 'legacy-hub', root, knowledgeRoot: join(root, 'knowledge') };
  await inspectKnowledgeWorkspace(root);
  return { mode: 'knowledge', root, knowledgeRoot: root };
}

async function ensureIgnore(root: string): Promise<void> {
  const file = join(root, '.gitignore');
  const before = await lstat(file).catch(error => {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (before && (!before.isFile() || before.isSymbolicLink() || before.size > 256 * 1024)) fail();
  let text = '';
  if (before) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev) fail();
      const bytes = Buffer.alloc(256 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await handle.stat();
      if (length > 256 * 1024 || length !== before.size || after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('CONNECTION_CONFLICT');
      text = decodeUtf8Strict(bytes.subarray(0, length));
    } finally { await handle.close(); }
  }
  const localRules = [
    ['/node_modules/', 'node_modules/.buildlore-ignore-probe'],
    ['/.buildlore/local-projects.json', '.buildlore/local-projects.json'],
    ['/.buildlore/local-projects.json.lock', '.buildlore/local-projects.json.lock'],
    ['/.buildlore/.local-projects.json.*.tmp', '.buildlore/.local-projects.json.probe.tmp'],
    ['/.buildlore/hierarchy-runs/', '.buildlore/hierarchy-runs/project/run.json'],
    ['/.buildlore/knowledge-inputs/', '.buildlore/knowledge-inputs/input.json'],
  ] as const;
  const ignored = async (path: string): Promise<boolean> =>
    await gitRead(root, ['check-ignore', '--no-index', '--quiet', '--', path], true) !== null;
  // An existing positive rule can be cancelled by a later negation. Reassert only
  // ineffective local rules, preserving the user's text and idempotent reruns.
  const missing = text.includes(KNOWLEDGE_GITIGNORE.trimEnd()) ? [] : [KNOWLEDGE_GITIGNORE.trimEnd()];
  const lines = new Set(text.split(/\r?\n/u));
  for (const [rule, probe] of localRules) {
    if (!lines.has(rule) || !await ignored(probe)) missing.push(rule);
  }
  if (missing.length) {
    await writeTextAtomic(file, `${text}${text.endsWith('\n') || !text ? '' : '\n'}${missing.join('\n')}\n`, {
      confinementRoot: root,
      beforeRename: async () => {
        const entry = await lstat(file).catch(error => {
          if (isNodeError(error) && error.code === 'ENOENT') return null;
          throw error;
        });
        if (before === null ? entry !== null : entry === null || !entry.isFile() || entry.isSymbolicLink() ||
            entry.ino !== before.ino || entry.dev !== before.dev || entry.size !== before.size ||
            entry.mtimeMs !== before.mtimeMs || entry.ctimeMs !== before.ctimeMs) fail('CONNECTION_CONFLICT');
      },
    });
  }
  for (const [, probe] of localRules) if (!await ignored(probe)) fail('CONNECTION_CONFLICT');
  // Ignore rules cannot protect files already present in the Git index.
  if (await gitRead(root, ['ls-files', '-z', '--', ...localRules.map(([rule]) => rule.slice(1))])) fail('CONNECTION_CONFLICT');
}

export async function initializeKnowledgeWorkspace(directory: string, repository?: string): Promise<Readonly<{ schemaVersion: 'buildlore.workspace-init.v1'; mode: 'knowledge'; outcome: 'created' | 'existing' }>> {
  const root = resolve(directory);
  await safeDirectory(root);
  if (await realpath(root) !== root || await worktreeRoot(root) !== root) fail('READ_BOUNDARY_VIOLATION');
  const prior = await readConfig(markerPath(root), 16 * 1024);
  const declared = prior ? parseKnowledgeWorkspace(prior.value).knowledgeRepository : undefined;
  const origin = (await gitRead(root, ['config', '--local', '--get', 'remote.origin.url'], true))?.trimEnd();
  const requested = locator(repository ?? declared ?? origin);
  if (declared !== undefined && declared !== requested) fail('KNOWLEDGE_IDENTITY_MISMATCH');
  await assertDirectRoot(root, requested);
  return createRepositoryWriterLease().withLease(root, 'workspace-init', async () => {
    await assertDirectRoot(root, requested);
    await ensureDirectory(join(root, '.buildlore'));
    const marker = await readConfig(markerPath(root), 16 * 1024);
    if (marker && parseKnowledgeWorkspace(marker.value).knowledgeRepository !== requested) fail('CONNECTION_CONFLICT');
    const manifest = await lstat(join(root, 'manifest.json')).catch(error => {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    });
    if (manifest) await readManifest(root);
    else await writeManifest(root, emptyManifest());
    await ensureDirectory(join(root, 'projects'));
    await ensureIgnore(root);
    await initializeLocalProjectRegistry(root);
    if (!marker) await replaceConfig(markerPath(root), { schemaVersion: KNOWLEDGE_WORKSPACE_VERSION, mode: 'knowledge', knowledgeRepository: requested }, null, 16 * 1024,
      () => assertDirectRoot(root, requested));
    return { schemaVersion: 'buildlore.workspace-init.v1', mode: 'knowledge', outcome: marker ? 'existing' : 'created' };
  });
}
