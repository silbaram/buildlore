import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { serializeCanonicalJson, writeJsonAtomic } from '../knowledge/atomic-file.js';
import { isNodeError } from '../knowledge/errors.js';
import {
  resolveLocalProjectBinding,
  type Sha256Digest,
  type SourceCheckoutHandle,
} from '../knowledge/local-project-registry.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { showProject } from '../knowledge/workspace.js';
import {
  resolveRegisteredProfileBinding,
  type ResolvedRegisteredProfileBindingV1,
} from '../profile/preflight.js';
import { consumePreparedSource } from '../sanitizer/approval.js';
import { readSecurityPolicy } from '../sanitizer/policy.js';
import { createProjectSecurityService } from '../sanitizer/service.js';
import { generatedSourceFilenameKind } from '../sanitizer/generated-identifiers.js';
import {
  createSourceCollectionAdapter,
  type CollectionCandidate,
  type SourceCollectionAdapter,
} from './collection-adapters.js';
import type { RegisteredJsonKnowledgeAdapterV1 } from './json-knowledge-adapter.js';
import {
  boundRawSourceInputsAreSafe,
  inspectRawSourceInputs,
  rawSourceInputSanitizationIsSafe,
} from './raw-source-inputs.js';
import {
  projectSourceProducer,
  renderExpectedProjectSource,
  type ProjectSourceInput,
} from './project-source-writer.js';
import { parseSourceDocument, renderSourceDocument } from './source-document.js';
import {
  parseSourceCollectionManifestV2,
  readSourceCollectionManifest,
  selectDeclaredSourceFiles,
  SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
  validateSourceSelectionPath,
  type AnySourceDeclaration,
  type LoadedSourceCollectionManifest,
  type SourceCollectionManifest,
  type SourceCollectionManifestV2,
  type SourceDeclarationV2,
} from './source-manifest.js';
import { readGitRevisionSnapshot } from '../knowledge/git.js';
import {
  createBuiltInSourceAdapterRegistry,
  GENERIC_SOURCE_ADAPTER_ID,
  JSON_SOURCE_ADAPTER_ID,
  P2A_SOURCE_ADAPTER_ID,
  type SourceAdapterRegistry,
} from './source-adapter-registry.js';
import type { GenericSourceKind } from './source-contracts.js';

export const SOURCE_MANAGEMENT_SCHEMA_VERSION = 'buildlore.source-management.v1' as const;

export type SourceManagementErrorCode =
  | 'SOURCE_DECLARATION_CONFLICT'
  | 'SOURCE_MANIFEST_BUSY'
  | 'SOURCE_MANIFEST_STALE'
  | 'SOURCE_MANIFEST_WRITE_FAILED';

export class SourceManagementError extends Error {
  readonly code: SourceManagementErrorCode;

  constructor(code: SourceManagementErrorCode, message: string) {
    super(message);
    this.name = 'SourceManagementError';
    this.code = code;
  }
}

export interface SourceDeclarationSummaryV1 {
  readonly adapterId: string;
  readonly adapterVersion: number;
  readonly id: string;
  readonly kind: string;
  readonly path: string;
  readonly pathType: 'directory' | 'file';
  readonly recursive: boolean;
}

export interface SourceListResultV1 {
  readonly declarationCount: number;
  readonly declarations: readonly SourceDeclarationSummaryV1[];
  readonly manifestDigest: Sha256Digest;
  readonly manifestSchemaVersion: SourceCollectionManifest['schemaVersion'];
  readonly projectId: string;
  readonly schemaVersion: typeof SOURCE_MANAGEMENT_SCHEMA_VERSION;
}

export interface SourceAddInput {
  readonly id: string;
  readonly kind: GenericSourceKind | 'json';
  readonly path: string;
  readonly projectId: string;
  readonly recursive?: boolean;
}

export interface SourceAddResultV1 extends SourceListResultV1 {
  readonly outcome: 'created' | 'unchanged';
}

export type SourceDiffStatus = 'added' | 'blocked' | 'changed' | 'missing' | 'unchanged';

export interface SourceDiffRecordV1 {
  readonly declarationId: string;
  readonly reasonCode: string;
  readonly sourceRef: string;
  readonly status: SourceDiffStatus;
}

export interface SourceDiffResultV1 {
  readonly manifestDigest: Sha256Digest;
  readonly projectId: string;
  readonly records: readonly SourceDiffRecordV1[];
  readonly schemaVersion: typeof SOURCE_MANAGEMENT_SCHEMA_VERSION;
}

export interface SourceManagementPort {
  add(input: SourceAddInput): Promise<SourceAddResultV1>;
  diff(projectId: string): Promise<SourceDiffResultV1>;
  list(projectId: string): Promise<SourceListResultV1>;
}

export interface CreateSourceManagementOptions {
  readonly collectionAdapter?: SourceCollectionAdapter;
  readonly hubRoot: string;
  readonly jsonKnowledgeAdapters?: readonly RegisteredJsonKnowledgeAdapterV1[];
}

export interface InitializeSourceManifestResult {
  readonly declarationCount: number;
  readonly manifestDigest: Sha256Digest;
  readonly outcome: 'created' | 'existing';
  readonly schemaVersion: SourceCollectionManifest['schemaVersion'];
}

export interface SourceManifestInitializationInspection {
  readonly outcome: 'absent' | 'existing';
}

const MANIFEST_DIRECTORY = '.buildlore';
const MANIFEST_FILENAME = 'sources.json';
const LOCK_FILENAME = 'sources.json.lock';

function sha256(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function managementFailure(code: SourceManagementErrorCode, message: string): never {
  throw new SourceManagementError(code, message);
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (
    difference !== '..' && !difference.startsWith(`..${sep}`)
  );
}

async function manifestDirectory(
  checkout: SourceCheckoutHandle,
  create: boolean,
): Promise<string> {
  const root = checkout.resolveRootForInternalUse();
  const path = join(root, MANIFEST_DIRECTORY);
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        return managementFailure(
          'SOURCE_MANIFEST_WRITE_FAILED',
          'Source manifest directory could not be prepared.',
        );
      }
    }
  }
  try {
    const [status, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      canonical !== path ||
      !isContained(root, canonical)
    ) return managementFailure('SOURCE_MANIFEST_WRITE_FAILED', 'Source manifest directory is unsafe.');
    return canonical;
  } catch (error) {
    if (error instanceof SourceManagementError) throw error;
    return managementFailure('SOURCE_MANIFEST_WRITE_FAILED', 'Source manifest directory is unsafe.');
  }
}

async function withManifestLock<T>(
  checkout: SourceCheckoutHandle,
  action: (directory: string, assertLockOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const directory = await manifestDirectory(checkout, true);
  const lockPath = join(directory, LOCK_FILENAME);
  let handle: FileHandle | undefined;
  let lockIdentity: Readonly<{ readonly device: bigint; readonly inode: bigint }> | undefined;
  const lockIsOwned = async (): Promise<boolean> => {
    if (handle === undefined || lockIdentity === undefined) return false;
    try {
      const [opened, current] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(lockPath, { bigint: true }),
      ]);
      return opened.isFile() && opened.nlink === 1n && current.isFile() &&
        !current.isSymbolicLink() && current.nlink === 1n &&
        opened.dev === lockIdentity.device && opened.ino === lockIdentity.inode &&
        current.dev === lockIdentity.device && current.ino === lockIdentity.inode;
    } catch {
      return false;
    }
  };
  const assertLockOwned = async (): Promise<void> => {
    if (!await lockIsOwned()) {
      managementFailure('SOURCE_MANIFEST_WRITE_FAILED', 'Source manifest lock ownership changed.');
    }
  };
  try {
    handle = await open(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_RDWR,
      0o600,
    );
    const acquired = await handle.stat({ bigint: true });
    if (!acquired.isFile() || acquired.nlink !== 1n) {
      return managementFailure('SOURCE_MANIFEST_WRITE_FAILED', 'Source manifest lock failed.');
    }
    lockIdentity = Object.freeze({ device: acquired.dev, inode: acquired.ino });
    await handle.writeFile('buildlore source manifest mutation\n', 'utf8');
    await handle.sync();
    await assertLockOwned();
  } catch (error) {
    const owned = await lockIsOwned();
    try {
      await handle?.close();
    } catch {
      // The acquisition failure remains authoritative.
    }
    if (owned) {
      try {
        const current = await lstat(lockPath, { bigint: true });
        if (lockIdentity !== undefined && current.isFile() && !current.isSymbolicLink() &&
            current.nlink === 1n && current.dev === lockIdentity.device &&
            current.ino === lockIdentity.inode) {
          await unlink(lockPath);
        }
      } catch {
        // The acquisition failure remains authoritative.
      }
    }
    if (isNodeError(error) && error.code === 'EEXIST') {
      return managementFailure('SOURCE_MANIFEST_BUSY', 'Source manifest is busy.');
    }
    if (error instanceof SourceManagementError) throw error;
    return managementFailure('SOURCE_MANIFEST_WRITE_FAILED', 'Source manifest lock failed.');
  }
  const outcome = await Promise.resolve().then(() => action(directory, assertLockOwned)).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  );
  let cleanupFailed = false;
  if (!await lockIsOwned()) cleanupFailed = true;
  try {
    await handle.close();
  } catch {
    cleanupFailed = true;
  }
  if (!cleanupFailed) {
    try {
      const current = await lstat(lockPath, { bigint: true });
      if (lockIdentity === undefined || !current.isFile() || current.isSymbolicLink() ||
          current.nlink !== 1n || current.dev !== lockIdentity.device ||
          current.ino !== lockIdentity.inode) {
        cleanupFailed = true;
      } else {
        await unlink(lockPath);
      }
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    return managementFailure('SOURCE_MANIFEST_WRITE_FAILED', 'Source manifest lock cleanup failed.');
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function normalizedDeclaration(declaration: AnySourceDeclaration): SourceDeclarationV2 {
  if ('adapterId' in declaration) return declaration;
  const p2a = declaration.documentKind === 'p2a-planning';
  return Object.freeze({
    adapterId: p2a ? P2A_SOURCE_ADAPTER_ID : GENERIC_SOURCE_ADAPTER_ID,
    adapterVersion: 1,
    id: declaration.id,
    kind: p2a ? 'planning' : declaration.documentKind,
    path: declaration.path,
    pathType: declaration.pathType,
    ...(declaration.pathType === 'directory' && declaration.recursive !== undefined
      ? { recursive: declaration.recursive }
      : {}),
  });
}

function normalizedManifest(
  manifest: SourceCollectionManifest,
  registry?: SourceAdapterRegistry,
): SourceCollectionManifestV2 {
  return parseSourceCollectionManifestV2({
    projectId: manifest.projectId,
    schemaVersion: SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
    sourceRepository: manifest.sourceRepository,
    sources: manifest.sources.map(normalizedDeclaration),
  }, registry);
}

function assertProfileAllowsManifest(
  manifest: SourceCollectionManifestV2,
  profile: ResolvedRegisteredProfileBindingV1,
): void {
  for (const declaration of manifest.sources) {
    profile.sourceAdapters.resolve({
      adapterId: declaration.adapterId,
      adapterVersion: declaration.adapterVersion,
      kind: declaration.kind,
      ...(declaration.metadata === undefined ? {} : { metadata: declaration.metadata }),
    });
  }
}

function declarationSummary(declaration: AnySourceDeclaration): SourceDeclarationSummaryV1 {
  const normalized = normalizedDeclaration(declaration);
  return Object.freeze({
    adapterId: normalized.adapterId,
    adapterVersion: normalized.adapterVersion,
    id: normalized.id,
    kind: normalized.kind,
    path: normalized.path,
    pathType: normalized.pathType,
    recursive: normalized.pathType === 'directory' && normalized.recursive === true,
  });
}

function listResult(loaded: LoadedSourceCollectionManifest): SourceListResultV1 {
  return Object.freeze({
    declarationCount: loaded.manifest.sources.length,
    declarations: Object.freeze(loaded.manifest.sources.map(declarationSummary)),
    manifestDigest: loaded.manifestDigest,
    manifestSchemaVersion: loaded.manifest.schemaVersion,
    projectId: loaded.manifest.projectId,
    schemaVersion: SOURCE_MANAGEMENT_SCHEMA_VERSION,
  });
}

async function writeManifest(
  directory: string,
  manifest: SourceCollectionManifestV2,
): Promise<Sha256Digest> {
  const bytes = serializeCanonicalJson(manifest);
  try {
    await writeJsonAtomic(join(directory, MANIFEST_FILENAME), manifest, {
      confinementRoot: directory,
    });
  } catch {
    return managementFailure('SOURCE_MANIFEST_WRITE_FAILED', 'Source manifest write failed safely.');
  }
  return sha256(bytes);
}

export async function initializeSourceManifest(
  checkout: SourceCheckoutHandle,
  projectId: string,
  sourceRepository: string,
): Promise<InitializeSourceManifestResult> {
  return withManifestLock(checkout, async (directory, assertLockOwned) => {
    const path = join(directory, MANIFEST_FILENAME);
    try {
      await lstat(path);
      const loaded = await readSourceCollectionManifest(checkout, projectId);
      if (loaded.manifest.sourceRepository !== sourceRepository) {
        return managementFailure(
          'SOURCE_DECLARATION_CONFLICT',
          'Existing source manifest binding is incompatible.',
        );
      }
      return Object.freeze({
        declarationCount: loaded.manifest.sources.length,
        manifestDigest: loaded.manifestDigest,
        outcome: 'existing' as const,
        schemaVersion: loaded.manifest.schemaVersion,
      });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    const manifest = parseSourceCollectionManifestV2({
      projectId,
      schemaVersion: SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
      sourceRepository,
      sources: [],
    });
    await assertLockOwned();
    return Object.freeze({
      declarationCount: 0,
      manifestDigest: await writeManifest(directory, manifest),
      outcome: 'created' as const,
      schemaVersion: SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
    });
  });
}

export async function inspectSourceManifestInitialization(
  checkout: SourceCheckoutHandle,
  projectId: string,
  sourceRepository: string,
): Promise<SourceManifestInitializationInspection> {
  const root = checkout.resolveRootForInternalUse();
  const directoryPath = join(root, MANIFEST_DIRECTORY);
  try {
    await lstat(directoryPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return Object.freeze({ outcome: 'absent' });
    }
    return managementFailure(
      'SOURCE_MANIFEST_WRITE_FAILED',
      'Source manifest directory could not be inspected.',
    );
  }
  const directory = await manifestDirectory(checkout, false);
  try {
    await lstat(join(directory, MANIFEST_FILENAME));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return Object.freeze({ outcome: 'absent' });
    }
    return managementFailure(
      'SOURCE_MANIFEST_WRITE_FAILED',
      'Source manifest could not be inspected.',
    );
  }
  const loaded = await readSourceCollectionManifest(checkout, projectId);
  if (loaded.manifest.sourceRepository !== sourceRepository) {
    return managementFailure(
      'SOURCE_DECLARATION_CONFLICT',
      'Existing source manifest binding is incompatible.',
    );
  }
  return Object.freeze({ outcome: 'existing' });
}

async function targetState(
  workspace: string,
  target: string,
  expected: ProjectSourceInput,
  projectId: string,
): Promise<Exclude<SourceDiffStatus, 'missing'>> {
  const sources = join(workspace, 'sources');
  const path = join(sources, target);
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return 'added';
    return 'blocked';
  }
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 ||
      status.size > 512 * 1024) return 'blocked';
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== status.dev ||
        actual.ino !== status.ino || actual.size !== status.size) return 'blocked';
    const content = await handle.readFile('utf8');
    const completed = await handle.stat();
    if (!completed.isFile() || completed.nlink !== 1 || completed.dev !== actual.dev ||
        completed.ino !== actual.ino || completed.size !== actual.size ||
        Buffer.byteLength(content, 'utf8') !== completed.size) return 'blocked';
    const document = parseSourceDocument(content);
    if (
      document.source !== expected.sourceUri || document.sourceType !== 'file' ||
      document.buildlore.producer !== projectSourceProducer(expected) ||
      document.buildlore.projectId !== projectId ||
      document.buildlore.sourceKind !== expected.sourceKind
    ) return 'blocked';
    return content === renderExpectedProjectSource(expected, projectId) ? 'unchanged' : 'changed';
  } catch {
    return 'blocked';
  } finally {
    try {
      await handle?.close();
    } catch {
      // The bounded blocked result remains authoritative.
    }
  }
}

async function prepareDiffInput(
  candidate: CollectionCandidate,
  security: ReturnType<typeof createProjectSecurityService>,
  policyDigest: Sha256Digest,
): Promise<ProjectSourceInput | null> {
  const sourceKind = candidate.sourceKind === 'execution' ? 'planning' : candidate.sourceKind;
  async function approvedBody(body: string, exact: boolean): Promise<string | null> {
    const bodyDigest = sha256(body);
    const result = await security.prepareSource({
      body,
      bodyDigest,
      projectId: candidate.projectId,
      source: candidate.sourceUri,
      sourceKind,
      sourceRevisionOrContentSha256: candidate.sourceRevision,
    });
    if (!result.ok || result.report.policyDigest !== policyDigest ||
        (exact && result.report.summaries.length > 0)) return null;
    const approved = consumePreparedSource(result.prepared);
    if (
      approved === null || approved.inputBodyDigest !== bodyDigest ||
      approved.policyDigest !== policyDigest ||
      approved.projectId !== candidate.projectId || approved.source !== candidate.sourceUri ||
      approved.sourceKind !== sourceKind ||
      approved.sourceRevisionOrContentSha256 !== candidate.sourceRevision ||
      approved.approvedBodyDigest !== result.report.outputDigest ||
      sha256(approved.approvedBody) !== approved.approvedBodyDigest ||
      (exact && approved.approvedBody !== body)
    ) return null;
    return approved.approvedBody;
  }

  const [title, body] = await Promise.all([
    approvedBody(candidate.title, false),
    approvedBody(candidate.body, false),
  ]);
  if (title === null || body === null) return null;
  if (candidate.descriptor?.metadata !== undefined) {
    const metadata = serializeCanonicalJson(candidate.descriptor.metadata);
    if (await approvedBody(metadata, true) === null) return null;
  }
  for (const rawInput of inspectRawSourceInputs(candidate)) {
    const bodyDigest = sha256(rawInput.body);
    const result = await security.prepareSource({
      body: rawInput.body,
      bodyDigest,
      projectId: candidate.projectId,
      source: candidate.sourceUri,
      sourceKind,
      sourceRevisionOrContentSha256: candidate.sourceRevision,
    });
    if (!result.ok || result.report.policyDigest !== policyDigest) return null;
    const approved = consumePreparedSource(result.prepared);
    if (approved === null || approved.inputBodyDigest !== bodyDigest ||
        !rawSourceInputSanitizationIsSafe(rawInput, approved.approvedBody, result.report.summaries)) {
      return null;
    }
  }
  return Object.freeze({
    body,
    ...(candidate.descriptor === undefined ? {} : { descriptor: candidate.descriptor }),
    ingestedAt: candidate.ingestedAt,
    ...(candidate.originMappings === undefined ? {} : { originMappings: candidate.originMappings }),
    ...(candidate.jsonOrigins === undefined ? {} : { jsonOrigins: candidate.jsonOrigins }),
    producer: candidate.producer,
    sourceKind: candidate.sourceKind,
    sourceRevision: candidate.sourceRevision,
    sourceUri: candidate.sourceUri,
    target: candidate.target,
    title,
  });
}

async function existingDeclarations(
  checkout: SourceCheckoutHandle,
  manifest: SourceCollectionManifestV2,
): Promise<Readonly<{
  missing: readonly SourceDeclarationV2[];
  present: readonly SourceDeclarationV2[];
}>> {
  const root = checkout.resolveRootForInternalUse();
  const missing: SourceDeclarationV2[] = [];
  const present: SourceDeclarationV2[] = [];
  for (const declaration of manifest.sources) {
    try {
      await lstat(join(root, ...declaration.path.split('/')));
      present.push(declaration);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') missing.push(declaration);
      else throw error;
    }
  }
  return Object.freeze({ missing: Object.freeze(missing), present: Object.freeze(present) });
}

function declarationContains(
  declaration: SourceDeclarationV2,
  sourceRef: string,
): boolean {
  return declaration.pathType === 'file'
    ? declaration.path === sourceRef
    : sourceRef.startsWith(`${declaration.path}/`);
}

async function storedDeclarationSources(
  workspace: string,
  manifest: SourceCollectionManifestV2,
  projectId: string,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const sourcesRoot = join(workspace, 'sources');
  let entries;
  try {
    const [status, canonical] = await Promise.all([lstat(sourcesRoot), realpath(sourcesRoot)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== sourcesRoot) {
      return managementFailure('SOURCE_MANIFEST_STALE', 'Stored source inventory is unsafe.');
    }
    entries = await readdir(sourcesRoot, { withFileTypes: true });
  } catch {
    return managementFailure('SOURCE_MANIFEST_STALE', 'Stored source inventory is unavailable.');
  }
  if (entries.length > 8_192) {
    return managementFailure('SOURCE_MANIFEST_STALE', 'Stored source inventory is out of bounds.');
  }
  const declarations = new Map(manifest.sources.map((declaration) =>
    [declaration.id, declaration] as const));
  const result = new Map<string, Set<string>>();
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    if (generatedSourceFilenameKind(entry.name) === null) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return managementFailure('SOURCE_MANIFEST_STALE', 'Stored source inventory is unsafe.');
    }
    const path = join(sourcesRoot, entry.name);
    let handle;
    try {
      const expected = await lstat(path);
      if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 ||
          expected.size > 512 * 1024) continue;
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const actual = await handle.stat();
      if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== expected.dev ||
          actual.ino !== expected.ino || actual.size !== expected.size) continue;
      const source = await handle.readFile('utf8');
      const document = parseSourceDocument(source);
      const descriptor = document.buildlore.descriptor;
      if (descriptor === undefined || renderSourceDocument(document) !== source ||
          descriptor.projectId !== projectId ||
          entry.name !== `${descriptor.kind}--${sha256(document.source).slice('sha256:'.length)}.md`) {
        continue;
      }
      const declaration = declarations.get(descriptor.declarationId);
      if (declaration === undefined || declaration.adapterId !== descriptor.adapterId ||
          declaration.adapterVersion !== descriptor.adapterVersion ||
          declaration.kind !== descriptor.kind ||
          !declarationContains(declaration, descriptor.sourceRef)) continue;
      const refs = result.get(declaration.id) ?? new Set<string>();
      refs.add(descriptor.sourceRef);
      result.set(declaration.id, refs);
    } catch {
      continue;
    } finally {
      try {
        await handle?.close();
      } catch {
        // The bounded inventory result remains authoritative.
      }
    }
  }
  return new Map([...result].map(([id, refs]) => [id, new Set([...refs].sort(compareText))]));
}

export function createSourceManagement(
  options: CreateSourceManagementOptions,
): SourceManagementPort {
  const knowledgeRoot = join(options.hubRoot, 'knowledge');
  const collectionAdapter = options.collectionAdapter ?? createSourceCollectionAdapter({
    ...(options.jsonKnowledgeAdapters === undefined
      ? {}
      : { jsonKnowledgeAdapters: options.jsonKnowledgeAdapters }),
  });
  const manifestRegistry = createBuiltInSourceAdapterRegistry({
    registrations: options.jsonKnowledgeAdapters ?? [],
  });

  async function binding(projectId: string): Promise<Readonly<{
    checkout: SourceCheckoutHandle;
    localBindingDigest: Sha256Digest;
    profile: ResolvedRegisteredProfileBindingV1;
    projectDigest: Sha256Digest;
  }>> {
    const project = await showProject(knowledgeRoot, projectId);
    const resolved = await resolveLocalProjectBinding(
      options.hubRoot,
      projectId,
      project.entry.sourceRepository,
    );
    const profile = await resolveRegisteredProfileBinding(knowledgeRoot, projectId, {
      registrations: options.jsonKnowledgeAdapters ?? [],
    });
    return Object.freeze({
      checkout: resolved.checkout,
      localBindingDigest: resolved.bindingDigest,
      profile,
      projectDigest: sha256(serializeCanonicalJson({
        descriptor: project.descriptor,
        entry: project.entry,
      })),
    });
  }

  async function assertBindingUnchanged(
    initial: Awaited<ReturnType<typeof binding>>,
    projectId: string,
  ): Promise<void> {
    let current: Awaited<ReturnType<typeof binding>>;
    try {
      current = await binding(projectId);
    } catch {
      return managementFailure('SOURCE_MANIFEST_STALE', 'Source project binding changed.');
    }
    if (
      current.checkout.resolveRootForInternalUse() !==
        initial.checkout.resolveRootForInternalUse() ||
      current.localBindingDigest !== initial.localBindingDigest ||
      current.profile.bindingDigest !== initial.profile.bindingDigest ||
      current.projectDigest !== initial.projectDigest
    ) {
      return managementFailure('SOURCE_MANIFEST_STALE', 'Source project binding changed.');
    }
  }

  return Object.freeze({
    async add(input: SourceAddInput): Promise<SourceAddResultV1> {
      const resolved = await binding(input.projectId);
      return withManifestLock(resolved.checkout, async (directory, assertLockOwned) => {
        const loaded = await readSourceCollectionManifest(resolved.checkout, input.projectId, {
          sourceAdapterRegistry: manifestRegistry,
        });
        const current = normalizedManifest(loaded.manifest, manifestRegistry);
        const root = resolved.checkout.resolveRootForInternalUse();
        const sourceRef = validateSourceSelectionPath(input.path);
        const proposedPath = join(root, ...sourceRef.split('/'));
        let status;
        try {
          status = await lstat(proposedPath);
        } catch {
          throw new SourceManagementError(
            'SOURCE_DECLARATION_CONFLICT',
            'Source declaration target is unavailable.',
          );
        }
        if (status.isSymbolicLink() || (!status.isFile() && !status.isDirectory())) {
          throw new SourceManagementError(
            'SOURCE_DECLARATION_CONFLICT',
            'Source declaration target is unsafe.',
          );
        }
        const pathType = status.isDirectory() ? 'directory' as const : 'file' as const;
        if (pathType === 'file' && input.recursive === true) {
          throw new SourceManagementError(
            'SOURCE_DECLARATION_CONFLICT',
            'Recursive source declaration requires a directory.',
          );
        }
        const declaration = {
          adapterId: input.kind === 'json' ? JSON_SOURCE_ADAPTER_ID : GENERIC_SOURCE_ADAPTER_ID,
          adapterVersion: 1,
          id: input.id,
          kind: input.kind,
          path: sourceRef,
          pathType,
          ...(pathType === 'directory' && input.recursive === true ? { recursive: true } : {}),
        } as const;
        const existing = current.sources.find((entry) => entry.id === input.id);
        if (existing !== undefined &&
            serializeCanonicalJson(existing) !== serializeCanonicalJson(declaration)) {
          throw new SourceManagementError(
            'SOURCE_DECLARATION_CONFLICT',
            'Source declaration id conflicts with existing state.',
          );
        }
        const proposed = parseSourceCollectionManifestV2({
          ...current,
          sources: existing === undefined ? [...current.sources, declaration] : current.sources,
        }, manifestRegistry);
        assertProfileAllowsManifest(proposed, resolved.profile);
        const proposedBytes = serializeCanonicalJson(proposed);
        const synthetic: LoadedSourceCollectionManifest = Object.freeze({
          manifest: proposed,
          manifestDigest: sha256(proposedBytes),
        });
        const inventory = await selectDeclaredSourceFiles(resolved.checkout, synthetic, {
          sourceAdapterRegistry: manifestRegistry,
        });
        const revision = await readGitRevisionSnapshot(root);
        await collectionAdapter.collect({
          checkout: resolved.checkout,
          ingestedAt: revision.committedAt,
          inventory,
          loadedManifest: synthetic,
          sourceAdapterRegistry: manifestRegistry,
        });
        const freshInventory = await selectDeclaredSourceFiles(resolved.checkout, synthetic, {
          sourceAdapterRegistry: manifestRegistry,
        });
        if (serializeCanonicalJson(freshInventory) !== serializeCanonicalJson(inventory)) {
          return managementFailure('SOURCE_MANIFEST_STALE', 'Source inputs changed during add.');
        }
        const live = await readSourceCollectionManifest(resolved.checkout, input.projectId, {
          sourceAdapterRegistry: resolved.profile.sourceAdapters,
        });
        if (live.manifestDigest !== loaded.manifestDigest) {
          return managementFailure('SOURCE_MANIFEST_STALE', 'Source manifest changed during add.');
        }
        await assertBindingUnchanged(resolved, input.projectId);
        const unchanged = loaded.manifest.schemaVersion === proposed.schemaVersion &&
          serializeCanonicalJson(loaded.manifest) === proposedBytes;
        await assertLockOwned();
        const manifestDigest = unchanged
          ? loaded.manifestDigest
          : await writeManifest(directory, proposed);
        return Object.freeze({
          ...listResult(Object.freeze({ manifest: proposed, manifestDigest })),
          outcome: unchanged ? 'unchanged' as const : 'created' as const,
        });
      });
    },

    async diff(projectId: string): Promise<SourceDiffResultV1> {
      const resolved = await binding(projectId);
      const loaded = await readSourceCollectionManifest(resolved.checkout, projectId, {
        sourceAdapterRegistry: manifestRegistry,
      });
      const canonical = normalizedManifest(loaded.manifest, manifestRegistry);
      assertProfileAllowsManifest(canonical, resolved.profile);
      const declarations = await existingDeclarations(resolved.checkout, canonical);
      const policyDigest = (await readSecurityPolicy(knowledgeRoot, projectId)).digest;
      const workspace = await resolveProjectWorkspace(knowledgeRoot, projectId, {
        mustExist: true,
      });
      const priorSources = await storedDeclarationSources(workspace, canonical, projectId);
      let selectedInventory: Awaited<ReturnType<typeof selectDeclaredSourceFiles>> | undefined;
      const records: SourceDiffRecordV1[] = declarations.missing.flatMap((declaration) => {
        const previous = [...(priorSources.get(declaration.id) ?? [])];
        const sourceRefs = previous.length === 0 ? [declaration.path] : previous;
        return sourceRefs.map((sourceRef) => Object.freeze({
          declarationId: declaration.id,
          reasonCode: 'SOURCE_MISSING',
          sourceRef,
          status: 'missing' as const,
        }));
      });
      const currentSources = new Set<string>();
      if (declarations.present.length > 0) {
        const selectedManifest = parseSourceCollectionManifestV2({
          ...canonical,
          sources: declarations.present,
        }, manifestRegistry);
        const selectedLoaded: LoadedSourceCollectionManifest = Object.freeze({
          manifest: selectedManifest,
          manifestDigest: sha256(serializeCanonicalJson(selectedManifest)),
        });
        const inventory = await selectDeclaredSourceFiles(resolved.checkout, selectedLoaded, {
          sourceAdapterRegistry: manifestRegistry,
        });
        selectedInventory = inventory;
        const revision = await readGitRevisionSnapshot(
          resolved.checkout.resolveRootForInternalUse(),
        );
        const collection = await collectionAdapter.collect({
          checkout: resolved.checkout,
          ingestedAt: revision.committedAt,
          inventory,
          loadedManifest: selectedLoaded,
          sourceAdapterRegistry: resolved.profile.sourceAdapters,
        });
        const security = createProjectSecurityService({ knowledgeRoot });
        const candidatesByDeclaration = new Map<string, number>();
        const blockedSourceRefs = new Set<string>();
        const rawInputsSafe = await boundRawSourceInputsAreSafe(collection, {
          policyDigest,
          projectId,
          security,
          source: `buildlore://project/${projectId}/selected-json-inputs`,
          sourceKind: 'json',
          sourceRevision: selectedLoaded.manifestDigest,
        });
        for (const entry of collection.entries) {
          if (entry.decision !== 'blocked' && entry.decision !== 'error' &&
              entry.decision !== 'quarantine') continue;
          const selected = inventory.files.find((file) => file.sourceRef === entry.sourceRef);
          if (selected === undefined) continue;
          blockedSourceRefs.add(entry.sourceRef);
          currentSources.add(`${selected.declarationId}\u0000${entry.sourceRef}`);
          candidatesByDeclaration.set(
            selected.declarationId,
            (candidatesByDeclaration.get(selected.declarationId) ?? 0) + 1,
          );
          records.push(Object.freeze({
            declarationId: selected.declarationId,
            reasonCode: 'SOURCE_ADAPTER_BLOCKED',
            sourceRef: entry.sourceRef,
            status: 'blocked' as const,
          }));
        }
        if (!rawInputsSafe) {
          for (const selected of inventory.files) {
            if (blockedSourceRefs.has(selected.sourceRef)) continue;
            blockedSourceRefs.add(selected.sourceRef);
            currentSources.add(`${selected.declarationId}\u0000${selected.sourceRef}`);
            candidatesByDeclaration.set(
              selected.declarationId,
              (candidatesByDeclaration.get(selected.declarationId) ?? 0) + 1,
            );
            records.push(Object.freeze({
              declarationId: selected.declarationId,
              reasonCode: 'SOURCE_SECURITY_BLOCKED',
              sourceRef: selected.sourceRef,
              status: 'blocked' as const,
            }));
          }
        }
        for (const candidate of collection.candidates) {
          if (blockedSourceRefs.has(candidate.sourceRef)) continue;
          currentSources.add(`${candidate.declarationId}\u0000${candidate.sourceRef}`);
          candidatesByDeclaration.set(
            candidate.declarationId,
            (candidatesByDeclaration.get(candidate.declarationId) ?? 0) + 1,
          );
          const prepared = await prepareDiffInput(candidate, security, policyDigest);
          const status = prepared === null
            ? 'blocked' as const
            : await targetState(workspace, candidate.target, prepared, projectId);
          records.push(Object.freeze({
            declarationId: candidate.declarationId,
            reasonCode: status === 'blocked' ? 'SOURCE_SECURITY_BLOCKED' : 'SOURCE_STATE',
            sourceRef: candidate.sourceRef,
            status,
          }));
        }
        for (const declaration of declarations.present) {
          const prior = priorSources.get(declaration.id) ?? new Set<string>();
          for (const sourceRef of prior) {
            if (!currentSources.has(`${declaration.id}\u0000${sourceRef}`)) {
              records.push(Object.freeze({
                declarationId: declaration.id,
                reasonCode: 'SOURCE_MISSING',
                sourceRef,
                status: 'missing',
              }));
            }
          }
          if ((candidatesByDeclaration.get(declaration.id) ?? 0) === 0 && prior.size === 0) {
            records.push(Object.freeze({
              declarationId: declaration.id,
              reasonCode: 'SOURCE_MISSING',
              sourceRef: declaration.path,
              status: 'missing',
            }));
          }
        }
      }
      const live = await readSourceCollectionManifest(resolved.checkout, projectId, {
        sourceAdapterRegistry: manifestRegistry,
      });
      if (live.manifestDigest !== loaded.manifestDigest) {
        return managementFailure('SOURCE_MANIFEST_STALE', 'Source manifest changed during diff.');
      }
      const [liveDeclarations, livePolicy] = await Promise.all([
        existingDeclarations(resolved.checkout, canonical),
        readSecurityPolicy(knowledgeRoot, projectId),
      ]);
      if (serializeCanonicalJson(liveDeclarations) !== serializeCanonicalJson(declarations) ||
          livePolicy.digest !== policyDigest) {
        return managementFailure('SOURCE_MANIFEST_STALE', 'Source inputs changed during diff.');
      }
      if (liveDeclarations.present.length > 0 && selectedInventory !== undefined) {
        const liveSelectedManifest = parseSourceCollectionManifestV2({
          ...canonical,
          sources: liveDeclarations.present,
        }, manifestRegistry);
        const liveInventory = await selectDeclaredSourceFiles(
          resolved.checkout,
          Object.freeze({
            manifest: liveSelectedManifest,
            manifestDigest: sha256(serializeCanonicalJson(liveSelectedManifest)),
          }),
          { sourceAdapterRegistry: manifestRegistry },
        );
        if (serializeCanonicalJson(liveInventory) !== serializeCanonicalJson(selectedInventory)) {
          return managementFailure('SOURCE_MANIFEST_STALE', 'Source inputs changed during diff.');
        }
      }
      await assertBindingUnchanged(resolved, projectId);
      return Object.freeze({
        manifestDigest: loaded.manifestDigest,
        projectId,
        records: Object.freeze(records.sort((left, right) => compareText(
          `${left.declarationId}:${left.sourceRef}`,
          `${right.declarationId}:${right.sourceRef}`,
        ))),
        schemaVersion: SOURCE_MANAGEMENT_SCHEMA_VERSION,
      });
    },

    async list(projectId: string): Promise<SourceListResultV1> {
      const resolved = await binding(projectId);
      const loaded = await readSourceCollectionManifest(resolved.checkout, projectId, {
        sourceAdapterRegistry: manifestRegistry,
      });
      assertProfileAllowsManifest(
        normalizedManifest(loaded.manifest, manifestRegistry),
        resolved.profile,
      );
      const result = listResult(loaded);
      const live = await readSourceCollectionManifest(resolved.checkout, projectId, {
        sourceAdapterRegistry: manifestRegistry,
      });
      if (live.manifestDigest !== loaded.manifestDigest) {
        return managementFailure('SOURCE_MANIFEST_STALE', 'Source manifest changed during list.');
      }
      await assertBindingUnchanged(resolved, projectId);
      return result;
    },
  });
}
