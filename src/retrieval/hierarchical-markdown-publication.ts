import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  serializeCanonicalJson,
  syncDirectory,
  writeJsonAtomic,
} from '../knowledge/atomic-file.js';
import { isNodeError } from '../knowledge/errors.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { decodeUtf8Strict, parseJsonStrict } from '../knowledge/strict-json.js';
import { consumePreparedSource } from '../sanitizer/approval.js';
import {
  createProjectSecurityService,
  readSecurityPolicy,
  type ProjectSecurityService,
} from '../sanitizer/index.js';
import {
  ApprovedWikiProjectionError,
  createApprovedWikiProjectionStore,
  prepareApprovedWikiPublication,
  readApprovedWikiPublicationSnapshot,
  type ApprovedWikiAuthorityV1,
  type ApprovedWikiProjectionStorePort,
  type ApprovedWikiPublicationSnapshotV1,
  type ApprovedWikiRetrievalProjectionV1,
} from './approved-corpus-store.js';
import {
  HIERARCHICAL_MARKDOWN_MANIFEST_FILENAME,
  HIERARCHICAL_MARKDOWN_MANIFEST_SCHEMA_VERSION,
  HIERARCHICAL_MARKDOWN_MAXIMUM_MANIFEST_BYTES,
  HIERARCHICAL_MARKDOWN_NAMESPACE,
  HIERARCHICAL_MARKDOWN_RENDERER_DIGEST,
  HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION,
  HierarchicalMarkdownMaterializationError,
  parseHierarchicalMarkdownManifest,
  renderVerifiedHierarchicalMarkdown,
  type HierarchicalMarkdownMaterializationManifestV1,
  type HierarchicalMarkdownMaterializationStatusV1,
  type HierarchicalMarkdownRenderPlanV1,
} from './hierarchical-markdown.js';

export const HIERARCHICAL_MARKDOWN_PUBLICATION_RESULT_SCHEMA_VERSION =
  'buildlore.hierarchical-markdown-publication-result.v1' as const;

const JOURNAL_SCHEMA_VERSION =
  'buildlore.hierarchical-markdown-materialization-journal.v1' as const;
const JOURNAL_FILENAME = 'materialization.journal';
const LOCK_FILENAME = 'materialization.lock';
const MAXIMUM_JOURNAL_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PAGE_FILENAME_PATTERN = /^page-[a-f0-9]{64}\.md$/u;
const TEMPORARY_NAME_PATTERN = /^materialization-[a-f0-9-]{36}\.(?:bak|tmp)$/u;
const JOURNAL_KEYS = Object.freeze([
  'backupName',
  'previousAuthorityDigest',
  'previousMaterializationDigest',
  'projectId',
  'schemaVersion',
  'stageName',
  'targetAuthorityDigest',
  'targetMaterializationDigest',
] as const);

export interface HierarchicalMarkdownPublicationResultV1 {
  readonly egress: 'none';
  readonly materialization: Extract<HierarchicalMarkdownMaterializationStatusV1, {
    readonly state: 'ready';
  }>;
  readonly projection: ApprovedWikiRetrievalProjectionV1;
  readonly providerUsed: 'none';
  readonly schemaVersion: typeof HIERARCHICAL_MARKDOWN_PUBLICATION_RESULT_SCHEMA_VERSION;
}

export interface HierarchicalMarkdownPublicationPort {
  publish(input: Readonly<{
    readonly authority: ApprovedWikiAuthorityV1;
    readonly preserveAuthority?: true;
    readonly projectId: string;
  }>): Promise<HierarchicalMarkdownPublicationResultV1>;
  status(projectId: string): Promise<HierarchicalMarkdownMaterializationStatusV1>;
}

export interface HierarchicalMarkdownRepositoryLease {
  readonly repositoryIdentityDigest: string;
  updatePhase(phase: string): Promise<void>;
}

export interface HierarchicalMarkdownRepositoryLeasePort {
  withLease<T>(
    repositoryRoot: string,
    operation: 'hierarchical-activation' | 'semantic-index-activation',
    action: (lease: HierarchicalMarkdownRepositoryLease) => Promise<T> | T,
  ): Promise<T>;
}

/** Deterministic hooks used only to verify commit and recovery boundaries. */
export interface HierarchicalMarkdownPublicationTestHooks {
  readonly afterAuthorityCommit?: () => Promise<void> | void;
  readonly afterJournalWrite?: () => Promise<void> | void;
  readonly afterNewGenerationMove?: () => Promise<void> | void;
  readonly afterPreviousGenerationMove?: () => Promise<void> | void;
  readonly beforeAuthorityCommit?: () => Promise<void> | void;
  readonly beforeStageWrite?: () => Promise<void> | void;
}

export interface CreateHierarchicalMarkdownPublicationOptions {
  readonly corpusStore?: ApprovedWikiProjectionStorePort;
  readonly hooks?: HierarchicalMarkdownPublicationTestHooks;
  readonly knowledgeRoot: string;
  readonly lease?: HierarchicalMarkdownRepositoryLeasePort;
  readonly security?: ProjectSecurityService;
}

interface JournalV1 {
  readonly backupName: string;
  readonly previousAuthorityDigest: `sha256:${string}` | null;
  readonly previousMaterializationDigest: `sha256:${string}` | null;
  readonly projectId: string;
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly stageName: string;
  readonly targetAuthorityDigest: `sha256:${string}`;
  readonly targetMaterializationDigest: `sha256:${string}`;
}

interface HierarchyPaths {
  readonly compilerRootIdentity: DirectoryIdentity;
  readonly finalRoot: string;
  readonly journal: string;
  readonly lock: string;
  readonly storeRoot: string;
  readonly storeRootIdentity: DirectoryIdentity | null;
  readonly wikiRoot: string;
  readonly wikiRootIdentity: DirectoryIdentity;
  readonly workspace: string;
  readonly workspaceIdentity: DirectoryIdentity;
}

interface DirectoryIdentity {
  readonly device: number;
  readonly inode: number;
  readonly path: string;
}

interface LockIdentity {
  readonly device: number;
  readonly inode: number;
}

interface NamespaceInspection {
  readonly manifest: InspectableManifest | null;
  readonly state: 'absent' | 'drifted' | 'invalid' | 'missing' | 'ready' |
    'renderer-outdated';
}

const LEGACY_MANIFEST_SCHEMA_VERSION =
  'buildlore.hierarchical-markdown-materialization-manifest.v1' as const;

interface LegacyManifestV1 extends Omit<
  HierarchicalMarkdownMaterializationManifestV1,
  'schemaVersion'
> {
  readonly schemaVersion: typeof LEGACY_MANIFEST_SCHEMA_VERSION;
}

type InspectableManifest = HierarchicalMarkdownMaterializationManifestV1 | LegacyManifestV1;

function fail(code: ConstructorParameters<typeof HierarchicalMarkdownMaterializationError>[0]): never {
  throw new HierarchicalMarkdownMaterializationError(code);
}

function digestText(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function digestValue(value: unknown): `sha256:${string}` {
  return digestText(serializeCanonicalJson(value));
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function parseLegacyManifest(value: unknown, projectId: string): LegacyManifestV1 {
  const manifestKeys = [
    'authorityDigest', 'corpusDigest', 'files', 'generationDigest',
    'materializationDigest', 'pageCount', 'projectId', 'projectionDigest', 'recordDigest',
    'rendererDigest', 'sanitizerPolicyDigest', 'schemaVersion',
  ];
  if (!isRecord(value) || !exactKeys(value, manifestKeys) ||
      value.schemaVersion !== LEGACY_MANIFEST_SCHEMA_VERSION || value.projectId !== projectId ||
      !Number.isSafeInteger(value.pageCount) || (value.pageCount as number) < 0 ||
      (value.pageCount as number) > 4_096 || !Array.isArray(value.files)) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  for (const candidate of [
    value.authorityDigest, value.corpusDigest, value.generationDigest,
    value.materializationDigest, value.projectionDigest, value.recordDigest,
    value.rendererDigest, value.sanitizerPolicyDigest,
  ]) {
    if (!isDigest(candidate)) fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  const files = Object.freeze(value.files.map((entry) => {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.byteLength) ||
        (entry.byteLength as number) < 1 || (entry.byteLength as number) > 4 * 1024 * 1024 ||
        !isDigest(entry.sha256) || typeof entry.path !== 'string') {
      fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
    }
    if (entry.kind === 'index') {
      if (!exactKeys(entry, ['byteLength', 'kind', 'path', 'sha256']) ||
          entry.path !== 'index.md') fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
      return Object.freeze({
        byteLength: entry.byteLength as number,
        kind: 'index' as const,
        path: entry.path,
        sha256: entry.sha256,
      });
    }
    if (entry.kind !== 'page' ||
        !exactKeys(entry, ['byteLength', 'kind', 'pageId', 'path', 'proposalDigest', 'sha256']) ||
        typeof entry.pageId !== 'string' || !/^page-[a-f0-9]{64}$/u.test(entry.pageId) ||
        entry.path !== `${entry.pageId}.md` || !PAGE_FILENAME_PATTERN.test(entry.path) ||
        !isDigest(entry.proposalDigest)) {
      fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
    }
    return Object.freeze({
      byteLength: entry.byteLength as number,
      kind: 'page' as const,
      pageId: entry.pageId,
      path: entry.path,
      proposalDigest: entry.proposalDigest,
      sha256: entry.sha256,
    });
  }));
  if (files.length !== (value.pageCount as number) + 1 || files[0]?.path !== 'index.md' ||
      files.filter((file) => file.kind === 'page').length !== value.pageCount ||
      files.some((file, index) => index > 0 &&
        (files[index - 1]?.path ?? '') >= file.path)) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  const basis = Object.freeze({
    authorityDigest: value.authorityDigest as `sha256:${string}`,
    corpusDigest: value.corpusDigest as `sha256:${string}`,
    files,
    generationDigest: value.generationDigest as `sha256:${string}`,
    pageCount: value.pageCount,
    projectId,
    projectionDigest: value.projectionDigest as `sha256:${string}`,
    recordDigest: value.recordDigest as `sha256:${string}`,
    rendererDigest: value.rendererDigest as `sha256:${string}`,
    sanitizerPolicyDigest: value.sanitizerPolicyDigest as `sha256:${string}`,
    schemaVersion: LEGACY_MANIFEST_SCHEMA_VERSION,
  });
  if (value.materializationDigest !== digestValue(basis)) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  return Object.freeze({
    ...basis,
    materializationDigest: value.materializationDigest,
  });
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function pathStatus(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
  }
}

async function assertSafeDirectory(path: string): Promise<DirectoryIdentity> {
  try {
    const [status, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== resolve(path)) {
      fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
    }
    return Object.freeze({ device: status.dev, inode: status.ino, path: canonical });
  } catch (error) {
    if (error instanceof HierarchicalMarkdownMaterializationError) throw error;
    fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
  }
}

async function assertDirectoryIdentity(identity: DirectoryIdentity): Promise<void> {
  try {
    const [status, canonical] = await Promise.all([lstat(identity.path), realpath(identity.path)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== identity.path ||
        status.dev !== identity.device || status.ino !== identity.inode) {
      fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
    }
  } catch (error) {
    if (error instanceof HierarchicalMarkdownMaterializationError) throw error;
    fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
  }
}

async function hierarchyPaths(
  knowledgeRoot: string,
  projectId: string,
  ensureStore = true,
): Promise<HierarchyPaths> {
  const workspace = await resolveProjectWorkspace(knowledgeRoot, projectId, { mustExist: true });
  const wikiRoot = join(workspace, 'wiki');
  const compilerRoot = join(workspace, '.llmwiki');
  const storeRoot = join(compilerRoot, HIERARCHICAL_MARKDOWN_NAMESPACE);
  const [workspaceIdentity, wikiRootIdentity, compilerRootIdentity] = await Promise.all([
    assertSafeDirectory(workspace),
    assertSafeDirectory(wikiRoot),
    assertSafeDirectory(compilerRoot),
  ]);
  if (ensureStore) {
    try {
      await mkdir(storeRoot, { mode: 0o700 });
      await syncDirectory(compilerRoot);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
      }
    }
  }
  const storeRootStatus = await pathStatus(storeRoot);
  const storeRootIdentity = storeRootStatus === null ? null : await assertSafeDirectory(storeRoot);
  if (ensureStore && storeRootIdentity === null) fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
  const finalRoot = join(wikiRoot, HIERARCHICAL_MARKDOWN_NAMESPACE);
  if (!isContained(workspace, finalRoot) || !isContained(workspace, storeRoot)) {
    fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
  }
  return Object.freeze({
    compilerRootIdentity,
    finalRoot,
    journal: join(storeRoot, JOURNAL_FILENAME),
    lock: join(storeRoot, LOCK_FILENAME),
    storeRoot,
    storeRootIdentity,
    wikiRoot,
    wikiRootIdentity,
    workspace,
    workspaceIdentity,
  });
}

function requiredStoreIdentity(paths: HierarchyPaths): DirectoryIdentity {
  return paths.storeRootIdentity ?? fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
}

async function assertStoreParentIdentities(paths: HierarchyPaths): Promise<void> {
  await assertDirectoryIdentity(paths.workspaceIdentity);
  await assertDirectoryIdentity(paths.compilerRootIdentity);
  await assertDirectoryIdentity(requiredStoreIdentity(paths));
}

async function assertWikiParentIdentities(paths: HierarchyPaths): Promise<void> {
  await assertDirectoryIdentity(paths.workspaceIdentity);
  await assertDirectoryIdentity(paths.wikiRootIdentity);
}

async function assertHierarchyParentIdentities(paths: HierarchyPaths): Promise<void> {
  await assertStoreParentIdentities(paths);
  await assertWikiParentIdentities(paths);
}

async function assertLockOwned(
  paths: HierarchyPaths,
  identity: LockIdentity,
): Promise<void> {
  try {
    await assertStoreParentIdentities(paths);
    const [status, canonical] = await Promise.all([lstat(paths.lock), realpath(paths.lock)]);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 ||
        status.dev !== identity.device || status.ino !== identity.inode ||
        canonical !== paths.lock) fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
  } catch (error) {
    if (error instanceof HierarchicalMarkdownMaterializationError) throw error;
    fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
  }
}

async function releaseLock(
  paths: HierarchyPaths,
  handle: FileHandle,
  identity: LockIdentity,
): Promise<void> {
  try {
    await handle.close();
    await assertLockOwned(paths, identity);
    await unlink(paths.lock);
    await syncDirectory(paths.storeRoot);
  } catch (error) {
    if (error instanceof HierarchicalMarkdownMaterializationError) throw error;
    fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
  }
}

async function withHierarchyLock<T>(
  paths: HierarchyPaths,
  action: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  let handle: FileHandle | undefined;
  let identity: LockIdentity | undefined;
  try {
    await assertStoreParentIdentities(paths);
    handle = await open(paths.lock, 'wx', 0o600);
    const status = await handle.stat();
    if (!status.isFile()) fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
    identity = Object.freeze({ device: status.dev, inode: status.ino });
    await handle.writeFile('buildlore hierarchy lineage mutation\n', 'utf8');
    await handle.sync();
    await assertLockOwned(paths, identity);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isNodeError(error) && error.code === 'EEXIST') {
      fail('HIERARCHICAL_MARKDOWN_BUSY');
    }
    if (error instanceof HierarchicalMarkdownMaterializationError) throw error;
    fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
  }
  const ownedHandle = handle;
  const ownedIdentity = identity;
  const outcome = await action(() => assertLockOwned(paths, ownedIdentity)).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  );
  await releaseLock(paths, ownedHandle, ownedIdentity);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Acquires the hierarchy lineage lock after the caller has acquired the repository lease. */
export async function withHierarchicalMarkdownLineageLock<T>(
  knowledgeRoot: string,
  projectId: string,
  action: () => Promise<T>,
): Promise<T> {
  const paths = await hierarchyPaths(knowledgeRoot, projectId);
  return withHierarchyLock(paths, async (assertOwned) => {
    await assertOwned();
    await assertHierarchyParentIdentities(paths);
    const value = await action();
    await assertHierarchyParentIdentities(paths);
    await assertOwned();
    return value;
  });
}

function parseJournal(value: unknown, projectId: string): JournalV1 {
  if (!isRecord(value) || !exactKeys(value, JOURNAL_KEYS) ||
      value.schemaVersion !== JOURNAL_SCHEMA_VERSION || value.projectId !== projectId ||
      typeof value.backupName !== 'string' || !TEMPORARY_NAME_PATTERN.test(value.backupName) ||
      !value.backupName.endsWith('.bak') || typeof value.stageName !== 'string' ||
      !TEMPORARY_NAME_PATTERN.test(value.stageName) || !value.stageName.endsWith('.tmp') ||
      !isDigest(value.targetAuthorityDigest) || !isDigest(value.targetMaterializationDigest) ||
      !(value.previousAuthorityDigest === null || isDigest(value.previousAuthorityDigest)) ||
      !(value.previousMaterializationDigest === null ||
        isDigest(value.previousMaterializationDigest))) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  return Object.freeze({
    backupName: value.backupName,
    previousAuthorityDigest: value.previousAuthorityDigest,
    previousMaterializationDigest: value.previousMaterializationDigest,
    projectId,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    stageName: value.stageName,
    targetAuthorityDigest: value.targetAuthorityDigest,
    targetMaterializationDigest: value.targetMaterializationDigest,
  });
}

async function readJournal(paths: HierarchyPaths, projectId: string): Promise<JournalV1 | null> {
  const status = await pathStatus(paths.journal);
  if (status === null) return null;
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 ||
      status.size < 2 || status.size > MAXIMUM_JOURNAL_BYTES) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  try {
    return parseJournal(
      parseJsonStrict(decodeUtf8Strict(await readFile(paths.journal))),
      projectId,
    );
  } catch (error) {
    if (error instanceof HierarchicalMarkdownMaterializationError) throw error;
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
}

function allowedGeneratedName(name: string): boolean {
  return name === HIERARCHICAL_MARKDOWN_MANIFEST_FILENAME || name === 'index.md' ||
    PAGE_FILENAME_PATTERN.test(name);
}

async function inspectNamespace(
  directory: string,
  projectId: string,
  expected: ApprovedWikiPublicationSnapshotV1 | null,
): Promise<NamespaceInspection> {
  const rootStatus = await pathStatus(directory);
  if (rootStatus === null) return Object.freeze({ manifest: null, state: 'absent' as const });
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    return Object.freeze({ manifest: null, state: 'invalid' as const });
  }
  try {
    if (await realpath(directory) !== resolve(directory)) {
      return Object.freeze({ manifest: null, state: 'invalid' as const });
    }
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() ||
        !allowedGeneratedName(entry.name))) {
      return Object.freeze({ manifest: null, state: 'invalid' as const });
    }
    const manifestEntry = entries.find((entry) =>
      entry.name === HIERARCHICAL_MARKDOWN_MANIFEST_FILENAME);
    if (manifestEntry === undefined) {
      return Object.freeze({ manifest: null, state: 'missing' as const });
    }
    const manifestPath = join(directory, HIERARCHICAL_MARKDOWN_MANIFEST_FILENAME);
    const manifestStatus = await lstat(manifestPath);
    if (!manifestStatus.isFile() || manifestStatus.isSymbolicLink() ||
        manifestStatus.nlink !== 1 || manifestStatus.size < 2 ||
        manifestStatus.size > HIERARCHICAL_MARKDOWN_MAXIMUM_MANIFEST_BYTES ||
        await realpath(manifestPath) !== resolve(manifestPath)) {
      return Object.freeze({ manifest: null, state: 'invalid' as const });
    }
    let manifest: InspectableManifest;
    try {
      const value = parseJsonStrict(decodeUtf8Strict(await readFile(manifestPath)));
      try {
        manifest = parseHierarchicalMarkdownManifest(value, projectId);
      } catch {
        manifest = parseLegacyManifest(value, projectId);
      }
    } catch {
      return Object.freeze({ manifest: null, state: 'invalid' as const });
    }
    const expectedNames = new Set([
      HIERARCHICAL_MARKDOWN_MANIFEST_FILENAME,
      ...manifest.files.map((file) => file.path),
    ]);
    if (entries.some((entry) => !expectedNames.has(entry.name))) {
      return Object.freeze({ manifest, state: 'drifted' as const });
    }
    for (const record of manifest.files) {
      const path = join(directory, record.path);
      const status = await pathStatus(path);
      if (status === null) return Object.freeze({ manifest, state: 'missing' as const });
      if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 ||
          status.size > 4 * 1024 * 1024 || await realpath(path) !== resolve(path)) {
        return Object.freeze({ manifest, state: 'invalid' as const });
      }
      if (status.size !== record.byteLength) {
        return Object.freeze({ manifest, state: 'drifted' as const });
      }
      const body = await readFile(path);
      if (digestText(decodeUtf8Strict(body)) !== record.sha256) {
        return Object.freeze({ manifest, state: 'drifted' as const });
      }
    }
    if (expected !== null && (
      manifest.authorityDigest !== expected.authorityDigest ||
      manifest.recordDigest !== expected.recordDigest ||
      manifest.projectionDigest !== expected.projection.projectionDigest ||
      manifest.corpusDigest !== expected.projection.corpus.corpusDigest ||
      manifest.generationDigest !== expected.projection.corpus.generationDigest ||
      manifest.sanitizerPolicyDigest !== expected.projection.sanitizerPolicyDigest ||
      manifest.pageCount !== expected.projection.corpus.pages.length
    )) return Object.freeze({ manifest, state: 'drifted' as const });
    if (expected !== null && (
      manifest.schemaVersion !== HIERARCHICAL_MARKDOWN_MANIFEST_SCHEMA_VERSION ||
      manifest.rendererDigest !== HIERARCHICAL_MARKDOWN_RENDERER_DIGEST
    )) return Object.freeze({ manifest, state: 'renderer-outdated' as const });
    return Object.freeze({ manifest, state: 'ready' as const });
  } catch {
    return Object.freeze({ manifest: null, state: 'invalid' as const });
  }
}

async function assertReplaceableGeneratedDirectory(directory: string): Promise<void> {
  const status = await pathStatus(directory);
  if (status === null) return;
  if (!status.isDirectory() || status.isSymbolicLink() ||
      await realpath(directory) !== resolve(directory)) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !allowedGeneratedName(entry.name)) {
      fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
    }
    const status = await lstat(join(directory, entry.name));
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
    }
  }
}

async function assertReplaceableNamespace(paths: HierarchyPaths): Promise<void> {
  await assertWikiParentIdentities(paths);
  await assertReplaceableGeneratedDirectory(paths.finalRoot);
}

async function scanFinalBytes(
  plan: HierarchicalMarkdownRenderPlanV1,
  projectId: string,
  security: ProjectSecurityService,
): Promise<void> {
  const entries = [
    ...plan.files.map((file) => Object.freeze({
      body: file.body,
      digest: file.sha256,
      path: file.path,
    })),
    Object.freeze({
      body: plan.manifestBody,
      digest: digestText(plan.manifestBody),
      path: HIERARCHICAL_MARKDOWN_MANIFEST_FILENAME,
    }),
  ];
  for (const entry of entries) {
    const result = await security.prepareSource({
      body: entry.body,
      bodyDigest: entry.digest,
      projectId,
      source: `${HIERARCHICAL_MARKDOWN_NAMESPACE}/${entry.path}`,
      sourceKind: 'wiki',
      sourceRevisionOrContentSha256: entry.digest,
    });
    const prepared = result.ok ? consumePreparedSource(result.prepared) : null;
    if (!result.ok || result.report.decision !== 'include' ||
        result.report.inputDigest !== entry.digest ||
        result.report.outputDigest !== entry.digest ||
        result.report.policyDigest !== plan.publication.projection.sanitizerPolicyDigest ||
        prepared === null || prepared.approvedBody !== entry.body ||
        prepared.approvedBodyDigest !== entry.digest ||
        prepared.inputBodyDigest !== entry.digest || prepared.projectId !== projectId ||
        prepared.policyDigest !== plan.publication.projection.sanitizerPolicyDigest ||
        prepared.sourceKind !== 'wiki' || prepared.untrustedData) {
      fail('HIERARCHICAL_MARKDOWN_SECURITY_DENIED');
    }
  }
}

async function writeStagedGeneration(
  paths: HierarchyPaths,
  plan: HierarchicalMarkdownRenderPlanV1,
  stageName: string,
  hooks: HierarchicalMarkdownPublicationTestHooks,
): Promise<string> {
  const stage = join(paths.storeRoot, stageName);
  if (!isContained(paths.storeRoot, stage) || resolve(stage) !== stage) {
    fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
  }
  try {
    await assertStoreParentIdentities(paths);
    await hooks.beforeStageWrite?.();
    await assertStoreParentIdentities(paths);
    await mkdir(stage, { mode: 0o700 });
    const identity = await assertSafeDirectory(stage);
    for (const file of plan.files) {
      await assertDirectoryIdentity(identity);
      const path = join(stage, file.path);
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(file.body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const manifestHandle = await open(
      join(stage, HIERARCHICAL_MARKDOWN_MANIFEST_FILENAME),
      'wx',
      0o600,
    );
    try {
      await manifestHandle.writeFile(plan.manifestBody, 'utf8');
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    await assertStoreParentIdentities(paths);
    await syncDirectory(stage);
    await syncDirectory(paths.storeRoot);
    const inspection = await inspectNamespace(stage, plan.publication.projection.projectId,
      plan.publication);
    if (inspection.state !== 'ready' ||
        inspection.manifest?.materializationDigest !== plan.manifest.materializationDigest) {
      fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
    }
    return stage;
  } catch (error) {
    if (error instanceof HierarchicalMarkdownMaterializationError) throw error;
    fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
  }
}

async function currentAuthority(
  knowledgeRoot: string,
  projectId: string,
): Promise<ApprovedWikiPublicationSnapshotV1 | null> {
  try {
    return await readApprovedWikiPublicationSnapshot(knowledgeRoot, projectId);
  } catch (error) {
    if (error instanceof ApprovedWikiProjectionError &&
        error.code === 'APPROVED_WIKI_PROJECTION_UNAVAILABLE') return null;
    fail('HIERARCHICAL_MARKDOWN_DRIFT');
  }
}

async function removeExactDirectory(
  rootIdentity: DirectoryIdentity,
  candidate: string,
): Promise<void> {
  const root = rootIdentity.path;
  if (!isContained(root, candidate) || resolve(candidate) !== candidate || candidate === root) {
    fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
  }
  await assertDirectoryIdentity(rootIdentity);
  await rm(candidate, { force: true, recursive: true });
  await assertDirectoryIdentity(rootIdentity);
  await syncDirectory(root);
}

async function removeGeneratedDirectory(
  rootIdentity: DirectoryIdentity,
  candidate: string,
): Promise<void> {
  await assertReplaceableGeneratedDirectory(candidate);
  await removeExactDirectory(rootIdentity, candidate);
}

async function cleanupJournal(
  paths: HierarchyPaths,
  journal: JournalV1,
): Promise<void> {
  const stage = join(paths.storeRoot, journal.stageName);
  const backup = join(paths.storeRoot, journal.backupName);
  const storeRootIdentity = requiredStoreIdentity(paths);
  await removeGeneratedDirectory(storeRootIdentity, stage);
  await removeGeneratedDirectory(storeRootIdentity, backup);
  try {
    await assertStoreParentIdentities(paths);
    await unlink(paths.journal);
    await assertStoreParentIdentities(paths);
    await syncDirectory(paths.storeRoot);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
}

async function recoverJournal(
  knowledgeRoot: string,
  paths: HierarchyPaths,
  projectId: string,
): Promise<void> {
  await assertHierarchyParentIdentities(paths);
  const journal = await readJournal(paths, projectId);
  if (journal === null) return;
  const stage = join(paths.storeRoot, journal.stageName);
  const backup = join(paths.storeRoot, journal.backupName);
  const current = await currentAuthority(knowledgeRoot, projectId);
  const finalInspection = await inspectNamespace(paths.finalRoot, projectId, null);
  const stageInspection = await inspectNamespace(stage, projectId, null);
  const finalIsTarget = finalInspection.state === 'ready' &&
    finalInspection.manifest?.materializationDigest === journal.targetMaterializationDigest;
  const stageIsTarget = stageInspection.state === 'ready' &&
    stageInspection.manifest?.materializationDigest === journal.targetMaterializationDigest;
  if (current?.authorityDigest === journal.targetAuthorityDigest) {
    if (!finalIsTarget) {
      if (finalInspection.state !== 'absent' || !stageIsTarget) {
        fail('HIERARCHICAL_MARKDOWN_DRIFT');
      }
      await assertHierarchyParentIdentities(paths);
      await rename(stage, paths.finalRoot);
      await assertHierarchyParentIdentities(paths);
      await Promise.all([syncDirectory(paths.storeRoot), syncDirectory(paths.wikiRoot)]);
    }
    await cleanupJournal(paths, journal);
    return;
  }
  if ((current?.authorityDigest ?? null) !== journal.previousAuthorityDigest) {
    fail('HIERARCHICAL_MARKDOWN_DRIFT');
  }
  const backupInspection = await inspectNamespace(backup, projectId, null);
  if (backupInspection.state !== 'absent') {
    if (finalIsTarget) {
      await removeExactDirectory(paths.wikiRootIdentity, paths.finalRoot);
    } else if (finalInspection.state !== 'absent') {
      fail('HIERARCHICAL_MARKDOWN_DRIFT');
    }
    await assertHierarchyParentIdentities(paths);
    await rename(backup, paths.finalRoot);
    await assertHierarchyParentIdentities(paths);
    await Promise.all([syncDirectory(paths.storeRoot), syncDirectory(paths.wikiRoot)]);
  } else if (finalIsTarget) {
    await removeExactDirectory(paths.wikiRootIdentity, paths.finalRoot);
  }
  await cleanupJournal(paths, journal);
}

function readyStatus(
  projectId: string,
  manifest: HierarchicalMarkdownMaterializationManifestV1,
): Extract<HierarchicalMarkdownMaterializationStatusV1, { readonly state: 'ready' }> {
  return Object.freeze({
    fileCount: manifest.files.length,
    generationDigest: manifest.generationDigest,
    materializationDigest: manifest.materializationDigest,
    pageCount: manifest.pageCount,
    projectId,
    schemaVersion: HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION,
    state: 'ready' as const,
  });
}

function recoveryStatus(
  projectId: string,
  state: 'drifted' | 'invalid' | 'missing' | 'renderer-outdated',
): HierarchicalMarkdownMaterializationStatusV1 {
  if (state === 'renderer-outdated') return Object.freeze({
    projectId,
    reasonCode: 'renderer-outdated' as const,
    recoveryAction: Object.freeze([
      'compile', 'activate', '--project', projectId, '--rematerialize',
    ] as const),
    schemaVersion: HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION,
    state,
  });
  const recoveryAction = Object.freeze(
    ['compile', 'activate', '--project', projectId] as const,
  );
  if (state === 'missing') return Object.freeze({
    projectId,
    reasonCode: 'materialization-missing' as const,
    recoveryAction,
    schemaVersion: HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION,
    state,
  });
  if (state === 'drifted') return Object.freeze({
    projectId,
    reasonCode: 'materialization-drifted' as const,
    recoveryAction,
    schemaVersion: HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION,
    state,
  });
  return Object.freeze({
    projectId,
    reasonCode: 'materialization-invalid' as const,
    recoveryAction,
    schemaVersion: HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION,
    state,
  });
}

async function inspectStatus(
  knowledgeRoot: string,
  projectId: string,
): Promise<HierarchicalMarkdownMaterializationStatusV1> {
  let publication: ApprovedWikiPublicationSnapshotV1 | null;
  try {
    publication = await currentAuthority(knowledgeRoot, projectId);
  } catch {
    return recoveryStatus(projectId, 'invalid');
  }
  let paths: HierarchyPaths;
  try {
    paths = await hierarchyPaths(knowledgeRoot, projectId, false);
  } catch {
    return recoveryStatus(projectId, 'invalid');
  }
  const inspection = await inspectNamespace(paths.finalRoot, projectId, publication);
  if (publication === null) {
    return inspection.state === 'absent'
      ? Object.freeze({
          projectId,
          schemaVersion: HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION,
          state: 'none' as const,
        })
      : recoveryStatus(projectId, 'invalid');
  }
  if (inspection.state === 'ready' && inspection.manifest !== null &&
      inspection.manifest.schemaVersion === HIERARCHICAL_MARKDOWN_MANIFEST_SCHEMA_VERSION) {
    return readyStatus(projectId, inspection.manifest);
  }
  if (inspection.state === 'ready') return recoveryStatus(projectId, 'invalid');
  return recoveryStatus(projectId, inspection.state === 'absent' ? 'missing' : inspection.state);
}

export function createHierarchicalMarkdownPublication(
  options: CreateHierarchicalMarkdownPublicationOptions,
): HierarchicalMarkdownPublicationPort {
  const corpusStore = options.corpusStore ?? createApprovedWikiProjectionStore(options.knowledgeRoot);
  const hooks = options.hooks ?? {};
  const lease = options.lease;
  const security = options.security ?? createProjectSecurityService({
    knowledgeRoot: options.knowledgeRoot,
  });
  const service: HierarchicalMarkdownPublicationPort = {
    async publish(input): Promise<HierarchicalMarkdownPublicationResultV1> {
      if (lease === undefined) fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
      if (input.preserveAuthority !== undefined && input.preserveAuthority !== true) {
        fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
      }
      let publication: ApprovedWikiPublicationSnapshotV1;
      try {
        publication = prepareApprovedWikiPublication(input.authority, input.projectId);
      } catch (error) {
        const stored = await currentAuthority(options.knowledgeRoot, input.projectId)
          .catch(() => null);
        if (stored === null || serializeCanonicalJson(stored.authority) !==
            serializeCanonicalJson(input.authority)) throw error;
        // Historical authority is accepted only after the stored record and retrieval
        // projection have been verified; it can be re-rendered but never newly activated.
        publication = stored;
      }
      const plan = renderVerifiedHierarchicalMarkdown({ publication });
      await scanFinalBytes(plan, input.projectId, security);
      const paths = await hierarchyPaths(options.knowledgeRoot, input.projectId);
      const generationToken = randomUUID();
      const stageName = `materialization-${generationToken}.tmp`;
      const backupName = `materialization-${generationToken}.bak`;
      const stage = await writeStagedGeneration(paths, plan, stageName, hooks);
      let committed = false;
      try {
        await lease.withLease(options.knowledgeRoot, 'hierarchical-activation', async (repoLease) => {
          await repoLease.updatePhase('hierarchy-lineage');
          await withHierarchyLock(paths, async (assertOwned) => {
            await assertOwned();
            await assertHierarchyParentIdentities(paths);
            await recoverJournal(options.knowledgeRoot, paths, input.projectId);
            await assertReplaceableNamespace(paths);
            const policy = await readSecurityPolicy(options.knowledgeRoot, input.projectId);
            if (policy.digest !== publication.projection.sanitizerPolicyDigest) {
              fail('HIERARCHICAL_MARKDOWN_DRIFT');
            }
            const previous = await currentAuthority(options.knowledgeRoot, input.projectId);
            if (input.preserveAuthority === true &&
                previous?.recordDigest !== publication.recordDigest) {
              fail('HIERARCHICAL_MARKDOWN_DRIFT');
            }
            const previousNamespace = await inspectNamespace(paths.finalRoot, input.projectId, null);
            const journal: JournalV1 = Object.freeze({
              backupName,
              previousAuthorityDigest: previous?.authorityDigest ?? null,
              previousMaterializationDigest: previousNamespace.manifest?.materializationDigest ?? null,
              projectId: input.projectId,
              schemaVersion: JOURNAL_SCHEMA_VERSION,
              stageName,
              targetAuthorityDigest: publication.authorityDigest,
              targetMaterializationDigest: plan.manifest.materializationDigest,
            });
            await writeJsonAtomic(paths.journal, journal, { confinementRoot: paths.workspace });
            await hooks.afterJournalWrite?.();
            await assertOwned();
            await assertHierarchyParentIdentities(paths);
            await assertReplaceableNamespace(paths);
            const staged = await inspectNamespace(stage, input.projectId, publication);
            if (staged.state !== 'ready' || staged.manifest?.materializationDigest !==
                plan.manifest.materializationDigest) {
              fail('HIERARCHICAL_MARKDOWN_DRIFT');
            }
            if (await pathStatus(paths.finalRoot) !== null) {
              await assertHierarchyParentIdentities(paths);
              await rename(paths.finalRoot, join(paths.storeRoot, backupName));
              await assertHierarchyParentIdentities(paths);
              await Promise.all([syncDirectory(paths.wikiRoot), syncDirectory(paths.storeRoot)]);
              await hooks.afterPreviousGenerationMove?.();
              await assertHierarchyParentIdentities(paths);
              await assertReplaceableGeneratedDirectory(join(paths.storeRoot, backupName));
            }
            await assertHierarchyParentIdentities(paths);
            await rename(stage, paths.finalRoot);
            await assertHierarchyParentIdentities(paths);
            await Promise.all([syncDirectory(paths.storeRoot), syncDirectory(paths.wikiRoot)]);
            await hooks.afterNewGenerationMove?.();
            await assertOwned();
            await hooks.beforeAuthorityCommit?.();
            await assertHierarchyParentIdentities(paths);
            const installed = await inspectNamespace(
              paths.finalRoot,
              input.projectId,
              publication,
            );
            if (installed.state !== 'ready' || installed.manifest?.materializationDigest !==
                plan.manifest.materializationDigest) {
              fail('HIERARCHICAL_MARKDOWN_DRIFT');
            }
            if (input.preserveAuthority !== true &&
                previous?.recordDigest !== publication.recordDigest) {
              await corpusStore.publish({ authority: input.authority, projectId: input.projectId });
            }
            const current = await currentAuthority(options.knowledgeRoot, input.projectId);
            if (current?.recordDigest !== publication.recordDigest) {
              fail('HIERARCHICAL_MARKDOWN_DRIFT');
            }
            committed = true;
            await hooks.afterAuthorityCommit?.();
            try {
              await cleanupJournal(paths, journal);
            } catch {
              // Authority replacement is the commit point; journal recovery completes cleanup.
            }
          });
        });
      } catch (error) {
        if (!committed) {
          try {
            await lease.withLease(options.knowledgeRoot, 'hierarchical-activation', async () =>
              withHierarchyLock(paths, async () =>
                recoverJournal(options.knowledgeRoot, paths, input.projectId)));
          } catch {
            // Preserve the original stable failure; the durable journal blocks unsafe replacement.
          }
        }
        const current = await currentAuthority(options.knowledgeRoot, input.projectId)
          .catch(() => null);
        const inspection = await inspectNamespace(paths.finalRoot, input.projectId, publication);
        if (current?.recordDigest === publication.recordDigest && inspection.state === 'ready' &&
            inspection.manifest?.materializationDigest === plan.manifest.materializationDigest) {
          committed = true;
        } else if (error instanceof HierarchicalMarkdownMaterializationError) {
          throw error;
        } else {
          fail('HIERARCHICAL_MARKDOWN_WRITE_FAILED');
        }
      } finally {
        if (!committed) {
          await removeGeneratedDirectory(requiredStoreIdentity(paths), stage)
            .catch(() => undefined);
        }
      }
      return Object.freeze({
        egress: 'none' as const,
        materialization: readyStatus(input.projectId, plan.manifest),
        projection: publication.projection,
        providerUsed: 'none' as const,
        schemaVersion: HIERARCHICAL_MARKDOWN_PUBLICATION_RESULT_SCHEMA_VERSION,
      });
    },
    status(projectId) {
      return inspectStatus(options.knowledgeRoot, projectId);
    },
  };
  return Object.freeze(service);
}
