import { basename, extname, join } from 'node:path';
import { opendir } from 'node:fs/promises';

import { compareSessionText, digestSessionValue, sessionSha256 } from './canonical.js';
import { SESSION_COMPILE_LIMITS } from './contracts.js';
import { SessionCompileError } from './errors.js';
import {
  confinedSessionDirectoryExists,
  listConfinedSessionFiles,
  readConfinedSessionUtf8,
} from './safe-io.js';
import type { SessionAllowedLinkTarget, SessionSha256Digest } from './types.js';

const MAX_INVENTORY_ENTRIES = 8_192;
const SAFE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ROOT_NAVIGATION_FILES = new Set(['MOC.md', 'index.md']);
const PAGE_DIRECTORIES = new Set([
  'concepts',
  'decisions',
  'failures',
  'queries',
  'verifications',
]);
const NON_PAGE_DIRECTORIES = new Set(['graph', 'outputs']);

export interface SessionKnowledgeInventory {
  readonly allowedLinkTargets: readonly SessionAllowedLinkTarget[];
  readonly digest: SessionSha256Digest;
  readonly pendingSlugs: ReadonlySet<string>;
}

async function listPendingCandidateFiles(
  candidates: string,
  workspace: string,
  projectId: string,
): Promise<readonly string[]> {
  let handle;
  try {
    handle = await opendir(candidates);
    const names: string[] = [];
    for await (const entry of handle) {
      if (entry.isSymbolicLink()) return denied(projectId);
      if (entry.isDirectory() && entry.name === 'archive') {
        await confinedSessionDirectoryExists(
          join(candidates, entry.name),
          workspace,
          projectId,
        );
      } else if (entry.isFile() && extname(entry.name) === '.json') {
        names.push(entry.name);
      } else {
        return denied(projectId);
      }
      if (names.length > MAX_INVENTORY_ENTRIES) return denied(projectId);
    }
    return Object.freeze(names.sort(compareSessionText));
  } catch (error) {
    if (error instanceof SessionCompileError) throw error;
    return denied(projectId);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function denied(projectId: string): never {
  throw new SessionCompileError('SESSION_PLAN_DENIED', projectId);
}

export async function readSessionKnowledgeInventory(
  workspace: string,
  projectId: string,
): Promise<SessionKnowledgeInventory> {
  const wiki = join(workspace, 'wiki');
  if (!await confinedSessionDirectoryExists(wiki, workspace, projectId)) {
    return denied(projectId);
  }
  const wikiDirectories: string[] = [];
  const wikiFiles: string[] = [];
  let wikiHandle;
  try {
    wikiHandle = await opendir(wiki);
    for await (const entry of wikiHandle) {
      if (entry.isSymbolicLink()) return denied(projectId);
      if (entry.isDirectory() && PAGE_DIRECTORIES.has(entry.name)) {
        wikiDirectories.push(entry.name);
      } else if (entry.isDirectory() && NON_PAGE_DIRECTORIES.has(entry.name)) {
        continue;
      } else if (entry.isFile() && ROOT_NAVIGATION_FILES.has(entry.name)) {
        wikiFiles.push(entry.name);
      } else {
        return denied(projectId);
      }
      if (wikiDirectories.length + wikiFiles.length > 8_192) return denied(projectId);
    }
  } catch (error) {
    if (error instanceof SessionCompileError) throw error;
    return denied(projectId);
  } finally {
    await wikiHandle?.close().catch(() => undefined);
  }
  wikiDirectories.sort(compareSessionText);
  wikiFiles.sort(compareSessionText);
  const entries: Array<Readonly<{ readonly digest: SessionSha256Digest; readonly path: string }>> = [];
  const targets: SessionAllowedLinkTarget[] = [];
  for (const name of wikiFiles) {
    const path = 'wiki/' + name;
    const body = await readConfinedSessionUtf8(
      join(workspace, path),
      workspace,
      SESSION_COMPILE_LIMITS.maxSourceBytes,
      projectId,
    );
    entries.push(Object.freeze({ digest: sessionSha256(body), path }));
    if (!ROOT_NAVIGATION_FILES.has(name)) {
      const slug = basename(name, '.md');
      targets.push(Object.freeze({ pageId: slug, slug }));
    }
  }
  for (const directory of wikiDirectories) {
    const directoryPath = join(wiki, directory);
    for (const name of await listConfinedSessionFiles(
      directoryPath,
      workspace,
      projectId,
      MAX_INVENTORY_ENTRIES,
    )) {
      if (extname(name) !== '.md') return denied(projectId);
      const slug = basename(name, '.md');
      if (!SAFE_SLUG_PATTERN.test(slug)) return denied(projectId);
      const path = 'wiki/' + directory + '/' + name;
      const body = await readConfinedSessionUtf8(
        join(workspace, path),
        workspace,
        SESSION_COMPILE_LIMITS.maxSourceBytes,
        projectId,
      );
      entries.push(Object.freeze({ digest: sessionSha256(body), path }));
      targets.push(Object.freeze({ pageId: directory + '/' + slug, slug }));
    }
  }
  const pendingSlugs = new Set<string>();
  const compilerState = join(workspace, '.llmwiki');
  const candidates = join(compilerState, 'candidates');
  if (await confinedSessionDirectoryExists(compilerState, workspace, projectId) &&
      await confinedSessionDirectoryExists(candidates, workspace, projectId)) {
    for (const name of await listPendingCandidateFiles(
      candidates,
      workspace,
      projectId,
    )) {
      const path = '.llmwiki/candidates/' + name;
      const body = await readConfinedSessionUtf8(
        join(workspace, path),
        workspace,
        SESSION_COMPILE_LIMITS.maxSourceBytes,
        projectId,
      );
      entries.push(Object.freeze({ digest: sessionSha256(body), path }));
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        return denied(projectId);
      }
      if (typeof parsed !== 'object' || parsed === null || !('slug' in parsed) ||
          typeof parsed.slug !== 'string' || !SAFE_SLUG_PATTERN.test(parsed.slug)) {
        return denied(projectId);
      }
      pendingSlugs.add(parsed.slug);
    }
  }
  targets.sort((left, right) => compareSessionText(left.pageId, right.pageId));
  entries.sort((left, right) => compareSessionText(left.path, right.path));
  if (entries.length > MAX_INVENTORY_ENTRIES ||
      new Set(targets.map((target) => target.slug)).size !== targets.length) {
    return denied(projectId);
  }
  return Object.freeze({
    allowedLinkTargets: Object.freeze(targets),
    digest: digestSessionValue({ entries, projectId }),
    pendingSlugs: Object.freeze(pendingSlugs),
  });
}
