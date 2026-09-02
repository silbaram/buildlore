import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { kill, pid as processId } from 'node:process';

import {
  serializeCanonicalJson,
  syncDirectory,
  writeJsonAtomic,
} from '../../knowledge/atomic-file.js';
import { isNodeError } from '../../knowledge/errors.js';
import { resolveProjectWorkspace } from '../../knowledge/paths.js';
import { decodeUtf8Strict, parseJsonStrict } from '../../knowledge/strict-json.js';
import { parseEmbeddingIdentityV2 } from '../embedding/profile.js';
import {
  chunkApprovedWikiCorpus,
  createRetrievalChunkId,
  SEMANTIC_CHUNKER_IDENTITY,
} from './chunking.js';
import {
  RETRIEVAL_CHUNK_SCHEMA_VERSION,
  SEMANTIC_INDEX_ACTIVE_SCHEMA_VERSION,
  SEMANTIC_INDEX_BUILD_LEDGER_SCHEMA_VERSION,
  SEMANTIC_INDEX_BUNDLE_SCHEMA_VERSION,
  SEMANTIC_INDEX_CHECKSUMS_SCHEMA_VERSION,
  SEMANTIC_INDEX_LIMITS,
  SEMANTIC_INDEX_MANIFEST_SCHEMA_VERSION,
  SemanticIndexError,
  type RetrievalChunkMaterialV1,
  type RetrievalChunkV1,
  type SemanticIndexActiveV1,
  type SemanticIndexActivationGuardV1,
  type SemanticIndexBuildInputV1,
  type SemanticIndexBuildLedgerV1,
  type SemanticIndexBuildMode,
  type SemanticIndexBuildResultV1,
  type SemanticIndexBundleResultV1,
  type SemanticIndexChecksumsV1,
  type SemanticIndexComponentChecksumV1,
  type SemanticIndexExportInputV1,
  type SemanticIndexImportInputV1,
  type SemanticIndexManifestV1,
  type SemanticIndexSearchResultV1,
  type SemanticIndexSha256Digest,
  type SemanticIndexStatusV1,
  type SemanticIndexTestHooks,
  type SemanticIndexViewV1,
  type VectorIndexPort,
} from './types.js';

const SEMANTIC_DIRECTORY = '.buildlore/indexes/semantic';
const ACTIVE_FILENAME = 'active.json';
const LOCK_FILENAME = 'build.lock';
const PENDING_FILENAME = 'pending.json';
const STAGING_DIRECTORY = 'staging';
const GENERATIONS_DIRECTORY = 'generations';
const LEDGERS_DIRECTORY = 'ledgers';
const QUARANTINE_DIRECTORY = 'quarantine';
const GENERATION_FILES = Object.freeze([
  'checksums.json',
  'chunks.jsonl',
  'manifest.json',
  'vectors.f32',
] as const);
const MAXIMUM_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAXIMUM_STATE_BYTES = 8 * 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const BUILD_PATTERN = /^build-[a-f0-9]{64}$/u;
const GENERATION_PATTERN = /^generation-[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u;
const LOCK_SCHEMA_VERSION = 'buildlore.semantic-index-lock.v1' as const;
const MALFORMED_LOCK_STALE_MILLISECONDS = 5 * 60 * 1000;
const UNVERIFIABLE_LOCK_STALE_MILLISECONDS = 24 * 60 * 60 * 1000;

interface SemanticPaths {
  readonly active: string;
  readonly generations: string;
  readonly ledgers: string;
  readonly lock: string;
  readonly pending: string;
  readonly quarantine: string;
  readonly root: string;
  readonly staging: string;
  readonly workspace: string;
}

interface LoadedGeneration {
  readonly chunks: readonly RetrievalChunkV1[];
  readonly manifest: SemanticIndexManifestV1;
  readonly vectors: readonly Float32Array[];
}

interface BuildStateV1 {
  readonly schemaVersion: 'buildlore.semantic-index-build-state.v1';
  readonly projectId: string;
  readonly buildId: string;
  readonly requestedMode: SemanticIndexBuildMode;
  readonly effectiveMode: SemanticIndexBuildMode;
  readonly inputCorpusDigest: SemanticIndexSha256Digest;
  readonly sanitizerPolicyDigest: SemanticIndexSha256Digest;
  readonly embeddingIdentityDigest: SemanticIndexSha256Digest;
  readonly chunkerDigest: SemanticIndexSha256Digest;
  readonly chunkPlanDigest: SemanticIndexSha256Digest;
  readonly previousGenerationId: string | null;
  readonly rowCount: number;
  readonly completedRows: number;
  readonly reusedRows: number;
  readonly createdRows: number;
  readonly deletedRows: number;
  readonly skippedRows: number;
}

interface PendingActivationV1 {
  readonly schemaVersion: 'buildlore.semantic-index-pending.v1';
  readonly projectId: string;
  readonly buildId: string;
  readonly generationId: string;
  readonly manifestDigest: SemanticIndexSha256Digest;
  readonly requestedMode: SemanticIndexBuildMode;
  readonly effectiveMode: SemanticIndexBuildMode;
  readonly inputCorpusDigest: SemanticIndexSha256Digest;
  readonly sanitizerPolicyDigest: SemanticIndexSha256Digest;
  readonly previousGenerationId: string | null;
  readonly embeddingIdentityDigest: SemanticIndexSha256Digest;
  readonly reusedRows: number;
  readonly createdRows: number;
  readonly deletedRows: number;
  readonly skippedRows: number;
  readonly durationMilliseconds: number;
}

interface SemanticIndexLockV1 {
  readonly schemaVersion: typeof LOCK_SCHEMA_VERSION;
  readonly ownerProcessId: number;
  readonly ownerProcessStartTime: string | null;
  readonly createdAtMilliseconds: number;
  readonly nonce: string;
}

interface SemanticIndexLockLease {
  readonly device: number;
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly inode: number;
}

interface PreparedBuild {
  readonly buildId: string;
  readonly chunkPlanDigest: SemanticIndexSha256Digest;
  readonly chunks: readonly RetrievalChunkMaterialV1[];
  readonly chunksBytes: Uint8Array;
  readonly deletedRows: number;
  readonly effectiveMode: SemanticIndexBuildMode;
  readonly previous: LoadedGeneration | null;
  readonly requestedMode: SemanticIndexBuildMode;
  readonly reuseVectors: ReadonlyMap<SemanticIndexSha256Digest, Float32Array>;
  readonly sanitizerPolicyDigest: SemanticIndexSha256Digest;
  readonly skippedRows: number;
}

function fail(
  code: ConstructorParameters<typeof SemanticIndexError>[0],
  reasonCode: ConstructorParameters<typeof SemanticIndexError>[1],
): never {
  throw new SemanticIndexError(code, reasonCode);
}

async function runBuildHook(action: (() => Promise<void> | void) | undefined): Promise<void> {
  if (action === undefined) return;
  try {
    await action();
  } catch {
    return fail('SEMANTIC_INDEX_BUILD_INCOMPLETE', 'build-interrupted');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digestBytes(value: Uint8Array | string): SemanticIndexSha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function digestValue(value: unknown): SemanticIndexSha256Digest {
  return digestBytes(serializeCanonicalJson(value));
}

function safeDigest(value: unknown): value is SemanticIndexSha256Digest {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value === value.normalize('NFC') && SAFE_ID.test(value);
}

function safeCount(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function safeDirectory(path: string, confinementRoot?: string): Promise<string> {
  try {
    const [status, canonical] = await Promise.all([lstat(path), realpath(path)]);
    const resolved = resolve(path);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== resolved ||
        (confinementRoot !== undefined && !isContained(confinementRoot, canonical))) {
      return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
    }
    return canonical;
  } catch (error) {
    if (error instanceof SemanticIndexError) throw error;
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
}

async function ensureDirectory(path: string, confinementRoot: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(resolve(path, '..'));
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
    }
  }
  await safeDirectory(path, confinementRoot);
}

async function projectWorkspace(knowledgeRoot: string, projectId: string): Promise<string> {
  try {
    return await resolveProjectWorkspace(knowledgeRoot, projectId, { mustExist: true });
  } catch {
    return fail('SEMANTIC_INDEX_CONFIG_INVALID', 'project-mismatch');
  }
}

function pathsFor(workspace: string): SemanticPaths {
  const root = join(workspace, ...SEMANTIC_DIRECTORY.split('/'));
  return Object.freeze({
    active: join(root, ACTIVE_FILENAME),
    generations: join(root, GENERATIONS_DIRECTORY),
    ledgers: join(root, LEDGERS_DIRECTORY),
    lock: join(root, LOCK_FILENAME),
    pending: join(root, PENDING_FILENAME),
    quarantine: join(root, QUARANTINE_DIRECTORY),
    root,
    staging: join(root, STAGING_DIRECTORY),
    workspace,
  });
}

async function preparePaths(workspace: string): Promise<SemanticPaths> {
  const paths = pathsFor(workspace);
  const directories = [
    join(workspace, '.buildlore'),
    join(workspace, '.buildlore', 'indexes'),
    paths.root,
    paths.staging,
    paths.generations,
    paths.ledgers,
    paths.quarantine,
  ];
  for (const directory of directories) await ensureDirectory(directory, workspace);
  return paths;
}

async function quarantineDirectory(
  paths: SemanticPaths,
  source: string,
  label: string,
  confinementRoot: string,
): Promise<boolean> {
  try {
    await safeDirectory(source, confinementRoot);
  } catch (error) {
    try {
      await lstat(source);
    } catch (inspectionError) {
      if (isNodeError(inspectionError) && inspectionError.code === 'ENOENT') return false;
    }
    throw error;
  }
  const destination = join(paths.quarantine, `${label}-${randomBytes(8).toString('hex')}`);
  try {
    await rename(source, destination);
    await Promise.all([syncDirectory(resolve(source, '..')), syncDirectory(paths.quarantine)]);
    return true;
  } catch {
    return fail('SEMANTIC_INDEX_BUILD_INCOMPLETE', 'build-interrupted');
  }
}

async function quarantineRegularFile(
  paths: SemanticPaths,
  source: string,
  label: string,
): Promise<boolean> {
  let status;
  try {
    status = await lstat(source);
    if (!status.isFile() || status.isSymbolicLink() || await realpath(source) !== resolve(source) ||
        !isContained(paths.root, resolve(source))) {
      return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    if (error instanceof SemanticIndexError) throw error;
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const destination = join(paths.quarantine, `${label}-${randomBytes(8).toString('hex')}.json`);
  try {
    await rename(source, destination);
    await Promise.all([syncDirectory(paths.root), syncDirectory(paths.quarantine)]);
    return true;
  } catch {
    return fail('SEMANTIC_INDEX_BUILD_INCOMPLETE', 'build-interrupted');
  }
}

async function quarantinePendingBuild(
  paths: SemanticPaths,
  pending: PendingActivationV1 | null,
): Promise<void> {
  if (pending !== null) {
    await quarantineDirectory(
      paths,
      join(paths.staging, pending.buildId),
      `stage-${pending.buildId}`,
      paths.staging,
    );
  }
  await quarantineRegularFile(
    paths,
    paths.pending,
    pending === null ? 'pending-invalid' : `pending-${pending.buildId}`,
  );
}

async function readRegularFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  let handle;
  try {
    const expected = await lstat(path);
    if (!expected.isFile() || expected.isSymbolicLink() || expected.size < 1 ||
        expected.size > maximumBytes || await realpath(path) !== resolve(path)) {
      return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino ||
        before.size !== expected.size || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
    }
    return bytes;
  } catch (error) {
    if (error instanceof SemanticIndexError) throw error;
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readCanonicalJson(path: string, maximumBytes: number): Promise<unknown> {
  const source = decodeUtf8Strict(await readRegularFile(path, maximumBytes));
  const parsed = parseJsonStrict(source);
  if (source !== serializeCanonicalJson(parsed)) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  return parsed;
}

async function writeBytesExclusive(path: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(resolve(path, '..'));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    if (error instanceof SemanticIndexError) throw error;
    return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
  }
}

async function appendVectorBytes(
  path: string,
  bytes: Uint8Array,
  expectedBytes: number,
): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_APPEND | constants.O_NOFOLLOW | constants.O_RDWR);
    const status = await handle.stat();
    if (!status.isFile() || status.size !== expectedBytes) {
      return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error instanceof SemanticIndexError) throw error;
    return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function encodeVectors(vectors: readonly Float32Array[]): Uint8Array {
  const bytes = new Uint8Array(vectors.length * SEMANTIC_INDEX_LIMITS.dimensions * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  for (const vector of vectors) {
    validateVector(vector);
    for (const component of vector) {
      view.setFloat32(offset, component, true);
      offset += 4;
    }
  }
  return bytes;
}

function validateVector(vector: Float32Array): void {
  if (!(vector instanceof Float32Array) || vector.length !== SEMANTIC_INDEX_LIMITS.dimensions) {
    fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  let squaredNorm = 0;
  for (const component of vector) {
    if (!Number.isFinite(component)) fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
    squaredNorm += component * component;
  }
  const norm = Math.sqrt(squaredNorm);
  if (norm === 0 || !Number.isFinite(norm) || Math.abs(norm - 1) > 1e-5) {
    fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
}

function decodeVectors(bytes: Uint8Array, count: number): readonly Float32Array[] {
  const expectedBytes = count * SEMANTIC_INDEX_LIMITS.dimensions * 4;
  if (bytes.byteLength !== expectedBytes || expectedBytes > SEMANTIC_INDEX_LIMITS.maximumVectorBytes) {
    fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vectors: Float32Array[] = [];
  let offset = 0;
  for (let row = 0; row < count; row += 1) {
    const vector = new Float32Array(SEMANTIC_INDEX_LIMITS.dimensions);
    for (let component = 0; component < vector.length; component += 1) {
      vector[component] = view.getFloat32(offset, true);
      offset += 4;
    }
    validateVector(vector);
    vectors.push(vector);
  }
  return Object.freeze(vectors);
}

function parseComponent(value: unknown): SemanticIndexComponentChecksumV1 {
  if (!isRecord(value) || !exactKeys(value, ['basename', 'bytes', 'sha256']) ||
      (value.basename !== 'chunks.jsonl' && value.basename !== 'vectors.f32') ||
      !safeCount(value.bytes, SEMANTIC_INDEX_LIMITS.maximumGenerationBytes) ||
      value.bytes < 1 || !safeDigest(value.sha256)) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  return Object.freeze({
    basename: value.basename,
    bytes: value.bytes,
    sha256: value.sha256,
  });
}

function parseChecksums(value: unknown): SemanticIndexChecksumsV1 {
  if (!isRecord(value) || !exactKeys(value, ['checksumsDigest', 'components', 'schemaVersion']) ||
      value.schemaVersion !== SEMANTIC_INDEX_CHECKSUMS_SCHEMA_VERSION ||
      !Array.isArray(value.components) || value.components.length !== 2 ||
      !safeDigest(value.checksumsDigest)) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const components = value.components.map(parseComponent).sort((left, right) =>
    compareText(left.basename, right.basename));
  if (components[0]?.basename !== 'chunks.jsonl' || components[1]?.basename !== 'vectors.f32') {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const basis = Object.freeze({
    schemaVersion: SEMANTIC_INDEX_CHECKSUMS_SCHEMA_VERSION,
    components: Object.freeze(components),
  });
  if (value.checksumsDigest !== digestValue(basis)) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  return Object.freeze({ ...basis, checksumsDigest: value.checksumsDigest });
}

function parseChunk(value: unknown, expectedProjectId: string, rowOrdinal: number): RetrievalChunkV1 {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'projectId', 'pageId', 'pageRevision', 'sectionId', 'chunkId',
    'rowOrdinal', 'segmentOrdinal', 'structureOrdinal', 'structureKind', 'contentDigest',
    'utf8Bytes', 'maximumTokens', 'tokenCount', 'tokenTruncated', 'chunkerDigest',
    'citationLocators', 'eligibility', 'skipReason',
  ]) || value.schemaVersion !== RETRIEVAL_CHUNK_SCHEMA_VERSION ||
      value.projectId !== expectedProjectId || !safeId(value.pageId) ||
      !safeDigest(value.pageRevision) || !safeId(value.sectionId) ||
      typeof value.chunkId !== 'string' || !/^chunk-[a-f0-9]{64}$/u.test(value.chunkId) ||
      value.rowOrdinal !== rowOrdinal ||
      !safeCount(value.segmentOrdinal, SEMANTIC_INDEX_LIMITS.maximumChunks) ||
      !safeCount(value.structureOrdinal, SEMANTIC_INDEX_LIMITS.maximumChunks) ||
      !['fenced-code', 'heading', 'list', 'paragraph', 'table'].includes(
        typeof value.structureKind === 'string' ? value.structureKind : '',
      ) || !safeDigest(value.contentDigest) ||
      !safeCount(value.utf8Bytes, SEMANTIC_INDEX_LIMITS.maximumChunkUtf8Bytes) ||
      value.utf8Bytes < 1 || value.maximumTokens !== 512 ||
      !safeCount(value.tokenCount, 512) || value.tokenCount < 1 ||
      value.tokenTruncated !== false ||
      value.chunkerDigest !== SEMANTIC_CHUNKER_IDENTITY.identityDigest ||
      !Array.isArray(value.citationLocators) ||
      value.citationLocators.length > 100 || value.eligibility !== 'eligible' ||
      value.skipReason !== null) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const citations = value.citationLocators.map((item) => {
    if (!isRecord(item) || !exactKeys(item, ['citationId', 'sourceId']) ||
        !safeId(item.citationId) || !safeId(item.sourceId)) {
      return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
    }
    return Object.freeze({ citationId: item.citationId, sourceId: item.sourceId });
  });
  if (new Set(citations.map((item) => `${item.citationId}\u0000${item.sourceId}`)).size !==
      citations.length) fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  const expectedChunkId = createRetrievalChunkId({
    contentDigest: value.contentDigest,
    pageId: value.pageId,
    pageRevision: value.pageRevision,
    projectId: expectedProjectId,
    sectionId: value.sectionId,
    segmentOrdinal: value.segmentOrdinal,
    structureKind: value.structureKind as RetrievalChunkV1['structureKind'],
    structureOrdinal: value.structureOrdinal,
  });
  if (value.chunkId !== expectedChunkId) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  return Object.freeze({
    schemaVersion: RETRIEVAL_CHUNK_SCHEMA_VERSION,
    projectId: expectedProjectId,
    pageId: value.pageId,
    pageRevision: value.pageRevision,
    sectionId: value.sectionId,
    chunkId: value.chunkId,
    rowOrdinal,
    segmentOrdinal: value.segmentOrdinal,
    structureOrdinal: value.structureOrdinal,
    structureKind: value.structureKind as RetrievalChunkV1['structureKind'],
    contentDigest: value.contentDigest,
    utf8Bytes: value.utf8Bytes,
    maximumTokens: 512,
    tokenCount: value.tokenCount,
    tokenTruncated: false,
    chunkerDigest: value.chunkerDigest,
    citationLocators: Object.freeze(citations),
    eligibility: 'eligible',
    skipReason: null,
  });
}

function parseManifest(value: unknown, expectedProjectId: string): SemanticIndexManifestV1 {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'projectId', 'generationId', 'corpusDigest', 'wikiGenerationDigest',
    'sanitizerPolicyDigest', 'chunker', 'embeddingIdentity', 'metric', 'dimensions',
    'scalarEncoding', 'byteOrder', 'rowCount', 'vectorBytes', 'metadataBytes',
    'componentChecksums', 'checksumsDigest', 'manifestDigest',
  ]) || value.schemaVersion !== SEMANTIC_INDEX_MANIFEST_SCHEMA_VERSION ||
      value.projectId !== expectedProjectId || typeof value.generationId !== 'string' ||
      !GENERATION_PATTERN.test(value.generationId) || !safeDigest(value.corpusDigest) ||
      !safeDigest(value.wikiGenerationDigest) || !safeDigest(value.sanitizerPolicyDigest) ||
      !isRecord(value.chunker) ||
      JSON.stringify(value.chunker) !== JSON.stringify(SEMANTIC_CHUNKER_IDENTITY) ||
      value.metric !== 'cosine' || value.dimensions !== 384 ||
      value.scalarEncoding !== 'float32-little-endian' || value.byteOrder !== 'little-endian' ||
      !safeCount(value.rowCount, SEMANTIC_INDEX_LIMITS.maximumChunks) || value.rowCount < 1 ||
      value.vectorBytes !== value.rowCount * 384 * 4 ||
      !safeCount(value.vectorBytes, SEMANTIC_INDEX_LIMITS.maximumVectorBytes) ||
      !safeCount(value.metadataBytes, SEMANTIC_INDEX_LIMITS.maximumMetadataBytes) ||
      value.metadataBytes < 1 || !Array.isArray(value.componentChecksums) ||
      value.componentChecksums.length !== 2 || !safeDigest(value.checksumsDigest) ||
      !safeDigest(value.manifestDigest)) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const embeddingIdentity = parseEmbeddingIdentityV2(value.embeddingIdentity);
  if (embeddingIdentity === null) return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  const componentChecksums = value.componentChecksums.map(parseComponent).sort((left, right) =>
    compareText(left.basename, right.basename));
  const basis = Object.freeze({
    schemaVersion: SEMANTIC_INDEX_MANIFEST_SCHEMA_VERSION,
    projectId: expectedProjectId,
    generationId: value.generationId,
    corpusDigest: value.corpusDigest,
    wikiGenerationDigest: value.wikiGenerationDigest,
    sanitizerPolicyDigest: value.sanitizerPolicyDigest,
    chunker: SEMANTIC_CHUNKER_IDENTITY,
    embeddingIdentity,
    metric: 'cosine' as const,
    dimensions: 384 as const,
    scalarEncoding: 'float32-little-endian' as const,
    byteOrder: 'little-endian' as const,
    rowCount: value.rowCount,
    vectorBytes: value.vectorBytes,
    metadataBytes: value.metadataBytes,
    componentChecksums: Object.freeze(componentChecksums),
    checksumsDigest: value.checksumsDigest,
  });
  if (componentChecksums[0]?.basename !== 'chunks.jsonl' ||
      componentChecksums[1]?.basename !== 'vectors.f32' ||
      value.manifestDigest !== digestValue(basis)) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  return Object.freeze({ ...basis, manifestDigest: value.manifestDigest });
}

function parseActive(value: unknown, projectId: string): SemanticIndexActiveV1 {
  if (!isRecord(value) || !exactKeys(value, [
    'generationId', 'manifestDigest', 'projectId', 'schemaVersion',
  ]) || value.schemaVersion !== SEMANTIC_INDEX_ACTIVE_SCHEMA_VERSION ||
      value.projectId !== projectId || typeof value.generationId !== 'string' ||
      !GENERATION_PATTERN.test(value.generationId) || !safeDigest(value.manifestDigest)) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  return Object.freeze({
    schemaVersion: SEMANTIC_INDEX_ACTIVE_SCHEMA_VERSION,
    projectId,
    generationId: value.generationId,
    manifestDigest: value.manifestDigest,
  });
}

function encodeChunks(chunks: readonly RetrievalChunkMaterialV1[]): Uint8Array {
  return Buffer.from(`${chunks.map(({ chunk }) => JSON.stringify(chunk)).join('\n')}\n`, 'utf8');
}

function parseChunks(bytes: Uint8Array, projectId: string): readonly RetrievalChunkV1[] {
  const source = decodeUtf8Strict(bytes);
  if (!source.endsWith('\n') || source.endsWith('\n\n')) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const lines = source.slice(0, -1).split('\n');
  if (lines.length < 1 || lines.length > SEMANTIC_INDEX_LIMITS.maximumChunks) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  return Object.freeze(lines.map((line, rowOrdinal) => {
    const parsed = parseChunk(parseJsonStrict(line), projectId, rowOrdinal);
    if (line !== JSON.stringify(parsed)) {
      return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
    }
    return parsed;
  }));
}

async function loadGenerationDirectory(
  directory: string,
  expectedProjectId: string,
  allowedAuxiliaryFiles: readonly string[] = [],
): Promise<LoadedGeneration> {
  await safeDirectory(directory);
  let names: readonly string[];
  try {
    names = (await readdir(directory)).sort(compareText);
  } catch {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const expectedNames = [...GENERATION_FILES, ...allowedAuxiliaryFiles].sort(compareText);
  if (names.length !== expectedNames.length ||
      names.some((name, index) => name !== expectedNames[index])) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const [manifestValue, checksumsValue, chunksBytes, vectorBytes] = await Promise.all([
    readCanonicalJson(join(directory, 'manifest.json'), MAXIMUM_MANIFEST_BYTES),
    readCanonicalJson(join(directory, 'checksums.json'), MAXIMUM_MANIFEST_BYTES),
    readRegularFile(join(directory, 'chunks.jsonl'), SEMANTIC_INDEX_LIMITS.maximumMetadataBytes),
    readRegularFile(join(directory, 'vectors.f32'), SEMANTIC_INDEX_LIMITS.maximumVectorBytes),
  ]);
  const manifest = parseManifest(manifestValue, expectedProjectId);
  const checksums = parseChecksums(checksumsValue);
  if (manifest.checksumsDigest !== checksums.checksumsDigest ||
      JSON.stringify(manifest.componentChecksums) !== JSON.stringify(checksums.components)) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const actualComponents = Object.freeze([
    Object.freeze({
      basename: 'chunks.jsonl' as const,
      bytes: chunksBytes.byteLength,
      sha256: digestBytes(chunksBytes),
    }),
    Object.freeze({
      basename: 'vectors.f32' as const,
      bytes: vectorBytes.byteLength,
      sha256: digestBytes(vectorBytes),
    }),
  ]);
  if (JSON.stringify(actualComponents) !== JSON.stringify(checksums.components) ||
      manifest.metadataBytes !== chunksBytes.byteLength ||
      manifest.vectorBytes !== vectorBytes.byteLength ||
      chunksBytes.byteLength + vectorBytes.byteLength >
        SEMANTIC_INDEX_LIMITS.maximumGenerationBytes) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const chunks = parseChunks(chunksBytes, expectedProjectId);
  if (chunks.length !== manifest.rowCount || chunks.some((chunk) =>
    chunk.chunkerDigest !== manifest.chunker.identityDigest)) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const vectors = decodeVectors(vectorBytes, chunks.length);
  return Object.freeze({ chunks, manifest, vectors });
}

async function loadActive(paths: SemanticPaths, projectId: string): Promise<LoadedGeneration> {
  let activeValue: unknown;
  try {
    activeValue = await readCanonicalJson(paths.active, MAXIMUM_MANIFEST_BYTES);
  } catch (error) {
    if (error instanceof SemanticIndexError && isNodeError(error.cause) && error.cause.code ===
        'ENOENT') {
      return fail('SEMANTIC_INDEX_UNAVAILABLE', 'active-missing');
    }
    try {
      await lstat(paths.active);
    } catch (inspectionError) {
      if (isNodeError(inspectionError) && inspectionError.code === 'ENOENT') {
        return fail('SEMANTIC_INDEX_UNAVAILABLE', 'active-missing');
      }
    }
    throw error;
  }
  const active = parseActive(activeValue, projectId);
  const generation = await loadGenerationDirectory(
    join(paths.generations, active.generationId),
    projectId,
  );
  if (generation.manifest.generationId !== active.generationId ||
      generation.manifest.manifestDigest !== active.manifestDigest) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  return generation;
}

async function loadActiveOrNull(
  paths: SemanticPaths,
  projectId: string,
): Promise<LoadedGeneration | null> {
  try {
    return await loadActive(paths, projectId);
  } catch (error) {
    if (error instanceof SemanticIndexError && error.code === 'SEMANTIC_INDEX_UNAVAILABLE') {
      return null;
    }
    throw error;
  }
}

async function loadActiveForBuild(
  paths: SemanticPaths,
  projectId: string,
  requestedMode: SemanticIndexBuildMode,
): Promise<LoadedGeneration | null> {
  try {
    return await loadActiveOrNull(paths, projectId);
  } catch (error) {
    if (requestedMode === 'full') return null;
    throw error;
  }
}

function compatibleForReuse(
  active: LoadedGeneration,
  input: SemanticIndexBuildInputV1,
): boolean {
  return active.manifest.projectId === input.projectId &&
    active.manifest.sanitizerPolicyDigest === input.sanitizerPolicyDigest &&
    active.manifest.chunker.identityDigest === SEMANTIC_CHUNKER_IDENTITY.identityDigest &&
    active.manifest.embeddingIdentity.identityDigest === input.embeddingIdentity.identityDigest &&
    active.manifest.dimensions === SEMANTIC_INDEX_LIMITS.dimensions &&
    active.manifest.metric === 'cosine';
}

function validateBuildInput(input: SemanticIndexBuildInputV1): void {
  if (input.corpus.projectId !== input.projectId || !safeDigest(input.sanitizerPolicyDigest)) {
    fail('SEMANTIC_INDEX_PROJECT_MISMATCH', 'project-mismatch');
  }
  const identity = parseEmbeddingIdentityV2(input.embeddingIdentity);
  if (identity === null || identity.identityDigest !== input.embeddingIdentity.identityDigest) {
    fail('SEMANTIC_INDEX_CONFIG_INVALID', 'identity-mismatch');
  }
  const capabilities = input.provider.inspectCapabilities();
  if (capabilities.providerUsed !== 'local-in-process' || capabilities.egress !== 'none' ||
      capabilities.networkAllowed || capabilities.maximumBatchSize !== 32) {
    fail('SEMANTIC_INDEX_CONFIG_INVALID', 'identity-mismatch');
  }
}

function vectorReuseMap(active: LoadedGeneration | null):
ReadonlyMap<SemanticIndexSha256Digest, Float32Array> {
  if (active === null) return new Map();
  const result = new Map<SemanticIndexSha256Digest, Float32Array>();
  active.chunks.forEach((chunk, index) => {
    const vector = active.vectors[index];
    if (vector !== undefined && !result.has(chunk.contentDigest)) {
      result.set(chunk.contentDigest, vector);
    }
  });
  return result;
}

function preflightBudget(chunks: readonly RetrievalChunkMaterialV1[], chunksBytes: Uint8Array): void {
  const vectorBytes = chunks.length * SEMANTIC_INDEX_LIMITS.dimensions * 4;
  if (chunks.length < 1 || chunks.length > SEMANTIC_INDEX_LIMITS.maximumChunks ||
      chunksBytes.byteLength > SEMANTIC_INDEX_LIMITS.maximumMetadataBytes ||
      vectorBytes > SEMANTIC_INDEX_LIMITS.maximumVectorBytes ||
      chunksBytes.byteLength + vectorBytes > SEMANTIC_INDEX_LIMITS.maximumGenerationBytes) {
    fail('SEMANTIC_INDEX_LIMIT_EXCEEDED', 'limit-exceeded');
  }
}

async function prepareBuild(
  paths: SemanticPaths,
  input: SemanticIndexBuildInputV1,
  requestedMode: SemanticIndexBuildMode,
): Promise<PreparedBuild> {
  validateBuildInput(input);
  const chunking = await chunkApprovedWikiCorpus(
    input.corpus,
    input.projectId,
    async (texts) => {
      const result = await input.provider.countDocumentTokens(texts);
      if (result.providerUsed !== 'local-in-process' || result.egress !== 'none' ||
          result.maximumTokens !== 512 ||
          result.identity.identityDigest !== input.embeddingIdentity.identityDigest ||
          result.tokenCounts.length !== texts.length) {
        return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'identity-mismatch');
      }
      return result.tokenCounts;
    },
  );
  const chunksBytes = encodeChunks(chunking.chunks);
  preflightBudget(chunking.chunks, chunksBytes);
  const previous = await loadActiveForBuild(paths, input.projectId, requestedMode);
  const effectiveMode = requestedMode === 'incremental' && previous !== null &&
    compatibleForReuse(previous, input) ? 'incremental' : 'full';
  const reuseVectors = vectorReuseMap(effectiveMode === 'incremental' ? previous : null);
  const targetIds = new Set(chunking.chunks.map(({ chunk }) => chunk.chunkId));
  const deletedRows = previous?.chunks.filter((chunk) => !targetIds.has(chunk.chunkId)).length ?? 0;
  const chunkPlanDigest = digestValue(chunking.chunks.map(({ chunk }) => chunk));
  const buildId = `build-${digestValue({
    chunkPlanDigest,
    chunkerDigest: chunking.chunker.identityDigest,
    corpusDigest: input.corpus.corpusDigest,
    effectiveMode,
    embeddingIdentityDigest: input.embeddingIdentity.identityDigest,
    previousGenerationId: previous?.manifest.generationId ?? null,
    projectId: input.projectId,
    requestedMode,
    sanitizerPolicyDigest: input.sanitizerPolicyDigest,
  }).slice('sha256:'.length)}`;
  return Object.freeze({
    buildId,
    chunkPlanDigest,
    chunks: chunking.chunks,
    chunksBytes,
    deletedRows,
    effectiveMode,
    previous,
    requestedMode,
    reuseVectors,
    sanitizerPolicyDigest: input.sanitizerPolicyDigest,
    skippedRows: chunking.skipped.length,
  });
}

function buildState(prepared: PreparedBuild, input: SemanticIndexBuildInputV1): BuildStateV1 {
  return Object.freeze({
    schemaVersion: 'buildlore.semantic-index-build-state.v1',
    projectId: input.projectId,
    buildId: prepared.buildId,
    requestedMode: prepared.requestedMode,
    effectiveMode: prepared.effectiveMode,
    inputCorpusDigest: input.corpus.corpusDigest,
    sanitizerPolicyDigest: input.sanitizerPolicyDigest,
    embeddingIdentityDigest: input.embeddingIdentity.identityDigest,
    chunkerDigest: SEMANTIC_CHUNKER_IDENTITY.identityDigest,
    chunkPlanDigest: prepared.chunkPlanDigest,
    previousGenerationId: prepared.previous?.manifest.generationId ?? null,
    rowCount: prepared.chunks.length,
    completedRows: 0,
    reusedRows: 0,
    createdRows: 0,
    deletedRows: prepared.deletedRows,
    skippedRows: prepared.skippedRows,
  });
}

function parseBuildState(value: unknown, expected: BuildStateV1): BuildStateV1 {
  if (!isRecord(value) || !exactKeys(value, Object.keys(expected)) ||
      value.schemaVersion !== expected.schemaVersion || value.projectId !== expected.projectId ||
      value.buildId !== expected.buildId || value.requestedMode !== expected.requestedMode ||
      value.effectiveMode !== expected.effectiveMode ||
      value.inputCorpusDigest !== expected.inputCorpusDigest ||
      value.sanitizerPolicyDigest !== expected.sanitizerPolicyDigest ||
      value.embeddingIdentityDigest !== expected.embeddingIdentityDigest ||
      value.chunkerDigest !== expected.chunkerDigest ||
      value.chunkPlanDigest !== expected.chunkPlanDigest ||
      value.previousGenerationId !== expected.previousGenerationId ||
      value.rowCount !== expected.rowCount || value.deletedRows !== expected.deletedRows ||
      value.skippedRows !== expected.skippedRows ||
      !safeCount(value.completedRows, expected.rowCount) ||
      !safeCount(value.reusedRows, expected.rowCount) ||
      !safeCount(value.createdRows, expected.rowCount) ||
      value.reusedRows + value.createdRows !== value.completedRows) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  return Object.freeze({
    ...expected,
    completedRows: value.completedRows,
    reusedRows: value.reusedRows,
    createdRows: value.createdRows,
  });
}

function pendingBasis(value: Omit<PendingActivationV1, 'schemaVersion'>): PendingActivationV1 {
  return Object.freeze({ schemaVersion: 'buildlore.semantic-index-pending.v1', ...value });
}

function parsePending(value: unknown, projectId: string): PendingActivationV1 {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'projectId', 'buildId', 'generationId', 'manifestDigest',
    'requestedMode', 'effectiveMode', 'inputCorpusDigest', 'previousGenerationId',
    'embeddingIdentityDigest', 'sanitizerPolicyDigest', 'reusedRows', 'createdRows',
    'deletedRows', 'skippedRows', 'durationMilliseconds',
  ]) || value.schemaVersion !== 'buildlore.semantic-index-pending.v1' ||
      value.projectId !== projectId || typeof value.buildId !== 'string' ||
      !BUILD_PATTERN.test(value.buildId) ||
      typeof value.generationId !== 'string' || !GENERATION_PATTERN.test(value.generationId) ||
      !safeDigest(value.manifestDigest) ||
      (value.requestedMode !== 'full' && value.requestedMode !== 'incremental') ||
      (value.effectiveMode !== 'full' && value.effectiveMode !== 'incremental') ||
      !safeDigest(value.inputCorpusDigest) ||
      (value.previousGenerationId !== null &&
        (typeof value.previousGenerationId !== 'string' ||
          !GENERATION_PATTERN.test(value.previousGenerationId))) ||
      !safeDigest(value.embeddingIdentityDigest) ||
      !safeDigest(value.sanitizerPolicyDigest) ||
      !safeCount(value.reusedRows, SEMANTIC_INDEX_LIMITS.maximumChunks) ||
      !safeCount(value.createdRows, SEMANTIC_INDEX_LIMITS.maximumChunks) ||
      !safeCount(value.deletedRows, SEMANTIC_INDEX_LIMITS.maximumChunks) ||
      !safeCount(value.skippedRows, SEMANTIC_INDEX_LIMITS.maximumChunks) ||
      typeof value.durationMilliseconds !== 'number' ||
      !Number.isFinite(value.durationMilliseconds) || value.durationMilliseconds < 0) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  return pendingBasis({
    projectId,
    buildId: value.buildId,
    generationId: value.generationId,
    manifestDigest: value.manifestDigest,
    requestedMode: value.requestedMode,
    effectiveMode: value.effectiveMode,
    inputCorpusDigest: value.inputCorpusDigest,
    sanitizerPolicyDigest: value.sanitizerPolicyDigest,
    previousGenerationId: value.previousGenerationId,
    embeddingIdentityDigest: value.embeddingIdentityDigest,
    reusedRows: value.reusedRows,
    createdRows: value.createdRows,
    deletedRows: value.deletedRows,
    skippedRows: value.skippedRows,
    durationMilliseconds: value.durationMilliseconds,
  });
}

function parseLock(value: unknown): SemanticIndexLockV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'createdAtMilliseconds', 'nonce', 'ownerProcessId', 'ownerProcessStartTime',
    'schemaVersion',
  ]) || value.schemaVersion !== LOCK_SCHEMA_VERSION ||
      !Number.isSafeInteger(value.ownerProcessId) ||
      (value.ownerProcessId as number) < 1 || (value.ownerProcessId as number) > 2_147_483_647 ||
      !Number.isSafeInteger(value.createdAtMilliseconds) ||
      (value.createdAtMilliseconds as number) < 0 ||
      (value.ownerProcessStartTime !== null &&
        (typeof value.ownerProcessStartTime !== 'string' ||
          !/^\d{1,32}$/u.test(value.ownerProcessStartTime))) ||
      typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/u.test(value.nonce)) {
    return null;
  }
  return Object.freeze({
    schemaVersion: LOCK_SCHEMA_VERSION,
    ownerProcessId: value.ownerProcessId as number,
    ownerProcessStartTime: value.ownerProcessStartTime,
    createdAtMilliseconds: value.createdAtMilliseconds as number,
    nonce: value.nonce,
  });
}

async function processStartTime(ownerProcessId: number): Promise<string | null> {
  try {
    const source = await readFile(`/proc/${ownerProcessId}/stat`, 'utf8');
    const close = source.lastIndexOf(') ');
    if (close < 0) return null;
    const fields = source.slice(close + 2).trim().split(/\s+/u);
    const value = fields[19];
    return value !== undefined && /^\d{1,32}$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(ownerProcessId: number): boolean {
  try {
    kill(ownerProcessId, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH');
  }
}

async function processOwnsLock(record: SemanticIndexLockV1): Promise<boolean> {
  if (!processIsAlive(record.ownerProcessId)) return false;
  const currentStartTime = await processStartTime(record.ownerProcessId);
  if (record.ownerProcessStartTime !== null && currentStartTime !== null) {
    return record.ownerProcessStartTime === currentStartTime;
  }
  return Date.now() - record.createdAtMilliseconds <= UNVERIFIABLE_LOCK_STALE_MILLISECONDS;
}

async function recoverStaleLock(paths: SemanticPaths): Promise<boolean> {
  let expected;
  try {
    expected = await lstat(paths.lock);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return true;
    return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
  }
  if (!expected.isFile() || expected.isSymbolicLink()) return false;
  let record: SemanticIndexLockV1 | null;
  try {
    record = parseLock(await readCanonicalJson(paths.lock, MAXIMUM_STATE_BYTES));
  } catch {
    record = null;
  }
  const stale = record === null
    ? Date.now() - expected.mtimeMs > MALFORMED_LOCK_STALE_MILLISECONDS
    : !await processOwnsLock(record);
  if (!stale) return false;
  let current;
  try {
    current = await lstat(paths.lock);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return true;
    return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
  }
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== expected.dev ||
      current.ino !== expected.ino || current.size !== expected.size ||
      current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs) {
    return false;
  }
  try {
    await unlink(paths.lock);
    await syncDirectory(paths.root);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return true;
    return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
  }
}

async function releaseLock(paths: SemanticPaths, lease: SemanticIndexLockLease): Promise<boolean> {
  let closed = true;
  try {
    await lease.handle.close();
  } catch {
    closed = false;
  }
  let current;
  try {
    current = await lstat(paths.lock);
  } catch {
    return false;
  }
  if (!closed || !current.isFile() || current.isSymbolicLink() ||
      current.dev !== lease.device || current.ino !== lease.inode) {
    return false;
  }
  try {
    await unlink(paths.lock);
    await syncDirectory(paths.root);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(paths: SemanticPaths): Promise<SemanticIndexLockLease> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(paths.lock, 'wx', 0o600);
      const record: SemanticIndexLockV1 = Object.freeze({
        schemaVersion: LOCK_SCHEMA_VERSION,
        ownerProcessId: processId,
        ownerProcessStartTime: await processStartTime(processId),
        createdAtMilliseconds: Date.now(),
        nonce: randomBytes(16).toString('hex'),
      });
      await handle.writeFile(serializeCanonicalJson(record), 'utf8');
      await handle.sync();
      const status = await handle.stat();
      if (!status.isFile()) return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
      return Object.freeze({ device: status.dev, handle, inode: status.ino });
    } catch (error) {
      if (handle !== undefined) {
        let status;
        try {
          status = await handle.stat();
        } catch {
          status = undefined;
        }
        if (status !== undefined) {
          await releaseLock(paths, Object.freeze({
            device: status.dev,
            handle,
            inode: status.ino,
          })).catch(() => false);
        } else {
          await handle.close().catch(() => undefined);
        }
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        if (attempt === 0 && await recoverStaleLock(paths)) continue;
        return fail('SEMANTIC_INDEX_BUSY', 'lock-busy');
      }
      if (error instanceof SemanticIndexError) throw error;
      return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
    }
  }
  return fail('SEMANTIC_INDEX_BUSY', 'lock-busy');
}

async function withLock<T>(paths: SemanticPaths, action: () => Promise<T>): Promise<T> {
  const lease = await acquireLock(paths);
  const result = await Promise.resolve().then(action).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  );
  if (!await releaseLock(paths, lease)) {
    return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
  }
  if (!result.ok) throw result.error;
  return result.value;
}

function createChecksums(
  chunksBytes: Uint8Array,
  vectorBytes: Uint8Array,
): SemanticIndexChecksumsV1 {
  const basis = Object.freeze({
    schemaVersion: SEMANTIC_INDEX_CHECKSUMS_SCHEMA_VERSION,
    components: Object.freeze([
      Object.freeze({
        basename: 'chunks.jsonl' as const,
        bytes: chunksBytes.byteLength,
        sha256: digestBytes(chunksBytes),
      }),
      Object.freeze({
        basename: 'vectors.f32' as const,
        bytes: vectorBytes.byteLength,
        sha256: digestBytes(vectorBytes),
      }),
    ]),
  });
  return Object.freeze({ ...basis, checksumsDigest: digestValue(basis) });
}

function createManifest(
  input: SemanticIndexBuildInputV1,
  checksums: SemanticIndexChecksumsV1,
): SemanticIndexManifestV1 {
  const generationId = `generation-${digestValue({
    checksumsDigest: checksums.checksumsDigest,
    chunkerDigest: SEMANTIC_CHUNKER_IDENTITY.identityDigest,
    corpusDigest: input.corpus.corpusDigest,
    embeddingIdentityDigest: input.embeddingIdentity.identityDigest,
    projectId: input.projectId,
    sanitizerPolicyDigest: input.sanitizerPolicyDigest,
    wikiGenerationDigest: input.corpus.generationDigest,
  }).slice('sha256:'.length)}`;
  const chunks = checksums.components.find((item) => item.basename === 'chunks.jsonl');
  const vectors = checksums.components.find((item) => item.basename === 'vectors.f32');
  if (chunks === undefined || vectors === undefined || vectors.bytes % (384 * 4) !== 0) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  const basis = Object.freeze({
    schemaVersion: SEMANTIC_INDEX_MANIFEST_SCHEMA_VERSION,
    projectId: input.projectId,
    generationId,
    corpusDigest: input.corpus.corpusDigest,
    wikiGenerationDigest: input.corpus.generationDigest,
    sanitizerPolicyDigest: input.sanitizerPolicyDigest,
    chunker: SEMANTIC_CHUNKER_IDENTITY,
    embeddingIdentity: input.embeddingIdentity,
    metric: 'cosine' as const,
    dimensions: 384 as const,
    scalarEncoding: 'float32-little-endian' as const,
    byteOrder: 'little-endian' as const,
    rowCount: vectors.bytes / (384 * 4),
    vectorBytes: vectors.bytes,
    metadataBytes: chunks.bytes,
    componentChecksums: checksums.components,
    checksumsDigest: checksums.checksumsDigest,
  });
  return Object.freeze({ ...basis, manifestDigest: digestValue(basis) });
}

function createLedger(pending: PendingActivationV1): SemanticIndexBuildLedgerV1 {
  const basis = Object.freeze({
    schemaVersion: SEMANTIC_INDEX_BUILD_LEDGER_SCHEMA_VERSION,
    projectId: pending.projectId,
    buildId: pending.buildId,
    requestedMode: pending.requestedMode,
    effectiveMode: pending.effectiveMode,
    inputCorpusDigest: pending.inputCorpusDigest,
    previousGenerationId: pending.previousGenerationId,
    generationId: pending.generationId,
    embeddingIdentityDigest: pending.embeddingIdentityDigest,
    reusedRows: pending.reusedRows,
    createdRows: pending.createdRows,
    deletedRows: pending.deletedRows,
    skippedRows: pending.skippedRows,
    providerUsed: 'local-in-process' as const,
    egress: 'none' as const,
    durationMilliseconds: pending.durationMilliseconds,
    recoveryState: 'complete' as const,
    resultManifestDigest: pending.manifestDigest,
  });
  return Object.freeze({ ...basis, ledgerDigest: digestValue(basis) });
}

async function persistLedger(paths: SemanticPaths, ledger: SemanticIndexBuildLedgerV1): Promise<void> {
  const path = join(paths.ledgers, `ledger-${ledger.ledgerDigest.slice('sha256:'.length)}.json`);
  try {
    await lstat(path);
    const existing = await readCanonicalJson(path, MAXIMUM_MANIFEST_BYTES);
    if (JSON.stringify(existing) !== JSON.stringify(ledger)) {
      return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
    }
  } catch (error) {
    if (error instanceof SemanticIndexError) throw error;
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    await writeJsonAtomic(path, ledger, { confinementRoot: paths.root });
  }
}

function validateFinalBuildState(
  value: unknown,
  pending: PendingActivationV1,
  manifest: SemanticIndexManifestV1,
): void {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'projectId', 'buildId', 'requestedMode', 'effectiveMode',
    'inputCorpusDigest', 'sanitizerPolicyDigest', 'embeddingIdentityDigest', 'chunkerDigest',
    'chunkPlanDigest', 'previousGenerationId', 'rowCount', 'completedRows', 'reusedRows',
    'createdRows', 'deletedRows', 'skippedRows',
  ]) || value.schemaVersion !== 'buildlore.semantic-index-build-state.v1' ||
      value.projectId !== pending.projectId || value.buildId !== pending.buildId ||
      value.requestedMode !== pending.requestedMode || value.effectiveMode !== pending.effectiveMode ||
      value.inputCorpusDigest !== pending.inputCorpusDigest ||
      pending.sanitizerPolicyDigest !== manifest.sanitizerPolicyDigest ||
      value.sanitizerPolicyDigest !== pending.sanitizerPolicyDigest ||
      value.embeddingIdentityDigest !== pending.embeddingIdentityDigest ||
      value.chunkerDigest !== manifest.chunker.identityDigest || !safeDigest(value.chunkPlanDigest) ||
      value.previousGenerationId !== pending.previousGenerationId ||
      value.rowCount !== manifest.rowCount || value.completedRows !== manifest.rowCount ||
      value.reusedRows !== pending.reusedRows || value.createdRows !== pending.createdRows ||
      value.deletedRows !== pending.deletedRows || value.skippedRows !== pending.skippedRows ||
      pending.reusedRows + pending.createdRows !== manifest.rowCount) {
    fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
}

async function prepareStagedGeneration(
  paths: SemanticPaths,
  pending: PendingActivationV1,
  stageDirectory: string,
): Promise<LoadedGeneration> {
  await safeDirectory(stageDirectory, paths.staging);
  let names: readonly string[];
  try {
    names = (await readdir(stageDirectory)).sort(compareText);
  } catch {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  if (names.length === GENERATION_FILES.length &&
      names.every((name, index) => name === GENERATION_FILES[index])) {
    return loadGenerationDirectory(stageDirectory, pending.projectId);
  }
  const stateNames = [
    'build-state.json', 'checksums.json', 'chunks.jsonl', 'manifest.json', 'vectors.f32',
  ].sort(compareText);
  const partialNames = [
    'build-state.json', 'checksums.json', 'chunks.jsonl', 'manifest.json',
    'vectors.partial.f32',
  ].sort(compareText);
  const hasFinalVector = names.length === stateNames.length &&
    names.every((name, index) => name === stateNames[index]);
  const hasPartialVector = names.length === partialNames.length &&
    names.every((name, index) => name === partialNames[index]);
  if (!hasFinalVector && !hasPartialVector) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  if (hasPartialVector) {
    try {
      await rename(
        join(stageDirectory, 'vectors.partial.f32'),
        join(stageDirectory, 'vectors.f32'),
      );
      await syncDirectory(stageDirectory);
    } catch {
      return fail('SEMANTIC_INDEX_BUILD_INCOMPLETE', 'build-interrupted');
    }
  }
  const generation = await loadGenerationDirectory(
    stageDirectory,
    pending.projectId,
    ['build-state.json'],
  );
  if (generation.manifest.generationId !== pending.generationId ||
      generation.manifest.manifestDigest !== pending.manifestDigest) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  validateFinalBuildState(
    await readCanonicalJson(join(stageDirectory, 'build-state.json'), MAXIMUM_STATE_BYTES),
    pending,
    generation.manifest,
  );
  try {
    await unlink(join(stageDirectory, 'build-state.json'));
    await syncDirectory(stageDirectory);
  } catch {
    return fail('SEMANTIC_INDEX_BUILD_INCOMPLETE', 'build-interrupted');
  }
  return loadGenerationDirectory(stageDirectory, pending.projectId);
}

async function quarantineInvalidGeneration(
  paths: SemanticPaths,
  pending: PendingActivationV1,
  generationDirectory: string,
): Promise<void> {
  try {
    await lstat(generationDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  if (pending.effectiveMode !== 'full') {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  await safeDirectory(generationDirectory, paths.generations);
  const quarantineDirectory = join(
    paths.generations,
    `quarantine-${pending.generationId.slice('generation-'.length)}-${
      randomBytes(8).toString('hex')}`,
  );
  try {
    await rename(generationDirectory, quarantineDirectory);
    await syncDirectory(paths.generations);
  } catch {
    return fail('SEMANTIC_INDEX_BUILD_INCOMPLETE', 'build-interrupted');
  }
}

async function removeRedundantStage(paths: SemanticPaths, stageDirectory: string): Promise<void> {
  try {
    await lstat(stageDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
  }
  await safeDirectory(stageDirectory, paths.staging);
  try {
    await rm(stageDirectory, { recursive: true });
    await syncDirectory(paths.staging);
  } catch {
    return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
  }
}

async function activatePending(
  paths: SemanticPaths,
  pending: PendingActivationV1,
  stageDirectory: string,
  hooks: SemanticIndexTestHooks,
  activationGuard: SemanticIndexActivationGuardV1 | undefined,
): Promise<SemanticIndexBuildResultV1> {
  const generationDirectory = join(paths.generations, pending.generationId);
  let generation: LoadedGeneration;
  try {
    generation = await loadGenerationDirectory(generationDirectory, pending.projectId);
  } catch {
    await quarantineInvalidGeneration(paths, pending, generationDirectory);
    const staged = await prepareStagedGeneration(paths, pending, stageDirectory);
    if (staged.manifest.generationId !== pending.generationId ||
        staged.manifest.manifestDigest !== pending.manifestDigest) {
      return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
    }
    await runBuildHook(hooks.beforeGenerationRename);
    try {
      await rename(stageDirectory, generationDirectory);
      await syncDirectory(paths.generations);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        return fail('SEMANTIC_INDEX_BUILD_INCOMPLETE', 'build-interrupted');
      }
    }
    generation = await loadGenerationDirectory(generationDirectory, pending.projectId);
  }
  if (generation.manifest.manifestDigest !== pending.manifestDigest) {
    return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
  }
  await removeRedundantStage(paths, stageDirectory);
  await runBuildHook(hooks.beforeActivation);
  const active: SemanticIndexActiveV1 = Object.freeze({
    schemaVersion: SEMANTIC_INDEX_ACTIVE_SCHEMA_VERSION,
    projectId: pending.projectId,
    generationId: pending.generationId,
    manifestDigest: pending.manifestDigest,
  });
  const ledger = createLedger(pending);
  return withActivationGuard(activationGuard, generation.manifest, async () => {
    await runBuildHook(hooks.beforeLedgerPersist);
    await persistLedger(paths, ledger);
    await writeJsonAtomic(paths.active, active, { confinementRoot: paths.root });
    await unlink(paths.pending).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
      }
    });
    await syncDirectory(paths.root);
    return Object.freeze({ ledger, manifest: generation.manifest, outcome: 'activated' });
  });
}

function activationCandidate(
  manifest: SemanticIndexManifestV1,
): Parameters<SemanticIndexActivationGuardV1>[0] {
  return Object.freeze({
    chunkerIdentityDigest: manifest.chunker.identityDigest,
    corpusDigest: manifest.corpusDigest,
    embeddingIdentityDigest: manifest.embeddingIdentity.identityDigest,
    generationId: manifest.generationId,
    manifestDigest: manifest.manifestDigest,
    projectId: manifest.projectId,
    sanitizerPolicyDigest: manifest.sanitizerPolicyDigest,
    wikiGenerationDigest: manifest.wikiGenerationDigest,
  });
}

async function withActivationGuard<T>(
  guard: SemanticIndexActivationGuardV1 | undefined,
  manifest: SemanticIndexManifestV1,
  activate: () => Promise<T>,
): Promise<T> {
  if (guard === undefined) return activate();
  let invoked = false;
  const result = await guard(activationCandidate(manifest), async () => {
    if (invoked) return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'lineage-drift');
    invoked = true;
    return activate();
  });
  if (!invoked) return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'lineage-drift');
  return result;
}

async function readPendingIfPresent(
  paths: SemanticPaths,
  projectId: string,
): Promise<PendingActivationV1 | null> {
  try {
    const pending = parsePending(
      await readCanonicalJson(paths.pending, MAXIMUM_STATE_BYTES),
      projectId,
    );
    return pending;
  } catch (error) {
    try {
      await lstat(paths.pending);
    } catch (inspectionError) {
      if (isNodeError(inspectionError) && inspectionError.code === 'ENOENT') return null;
    }
    throw error;
  }
}

function pendingMatchesRequest(
  pending: PendingActivationV1,
  input: SemanticIndexBuildInputV1,
  requestedMode: SemanticIndexBuildMode,
): boolean {
  return pending.inputCorpusDigest === input.corpus.corpusDigest &&
    pending.embeddingIdentityDigest === input.embeddingIdentity.identityDigest &&
    pending.sanitizerPolicyDigest === input.sanitizerPolicyDigest &&
    (requestedMode === 'incremental' || pending.requestedMode === 'full');
}

async function runBuild(
  knowledgeRoot: string,
  input: SemanticIndexBuildInputV1,
  requestedMode: SemanticIndexBuildMode,
  hooks: SemanticIndexTestHooks,
): Promise<SemanticIndexBuildResultV1> {
  const workspace = await projectWorkspace(knowledgeRoot, input.projectId);
  validateBuildInput(input);
  const paths = await preparePaths(workspace);
  return withLock(paths, async () => {
    let pending: PendingActivationV1 | null;
    try {
      pending = await readPendingIfPresent(paths, input.projectId);
    } catch (error) {
      if (requestedMode !== 'full') throw error;
      await quarantinePendingBuild(paths, null);
      pending = null;
    }
    if (pending !== null) {
      if (pendingMatchesRequest(pending, input, requestedMode)) {
        return activatePending(
          paths,
          pending,
          join(paths.staging, pending.buildId),
          hooks,
          input.activationGuard,
        );
      }
      await quarantinePendingBuild(paths, pending);
    }
    const prepared = await prepareBuild(paths, input, requestedMode);
    const stageDirectory = join(paths.staging, prepared.buildId);
    const active = await loadActiveForBuild(paths, input.projectId, requestedMode);
    if (requestedMode === 'incremental' && active !== null &&
        active.manifest.corpusDigest === input.corpus.corpusDigest &&
        compatibleForReuse(active, input) &&
        active.manifest.componentChecksums[0]?.sha256 === digestBytes(prepared.chunksBytes)) {
      const pendingUnchanged = pendingBasis({
        projectId: input.projectId,
        buildId: prepared.buildId,
        generationId: active.manifest.generationId,
        manifestDigest: active.manifest.manifestDigest,
        requestedMode,
        effectiveMode: 'incremental',
        inputCorpusDigest: input.corpus.corpusDigest,
        sanitizerPolicyDigest: input.sanitizerPolicyDigest,
        previousGenerationId: active.manifest.generationId,
        embeddingIdentityDigest: input.embeddingIdentity.identityDigest,
        reusedRows: active.manifest.rowCount,
        createdRows: 0,
        deletedRows: 0,
        skippedRows: prepared.skippedRows,
        durationMilliseconds: 0,
      });
      const ledger = createLedger(pendingUnchanged);
      return withActivationGuard(input.activationGuard, active.manifest, async () => {
        await persistLedger(paths, ledger);
        return Object.freeze({ ledger, manifest: active.manifest, outcome: 'unchanged' });
      });
    }
    const expectedState = buildState(prepared, input);
    const statePath = join(stageDirectory, 'build-state.json');
    const chunksPath = join(stageDirectory, 'chunks.jsonl');
    const partialVectorsPath = join(stageDirectory, 'vectors.partial.f32');
    let state!: BuildStateV1;
    let createStage = false;
    try {
      await safeDirectory(stageDirectory, paths.staging);
      const names = (await readdir(stageDirectory)).sort(compareText);
      const allowedNames = new Set([
        'build-state.json', 'checksums.json', 'chunks.jsonl', 'manifest.json',
        'vectors.partial.f32',
      ]);
      if (!['build-state.json', 'chunks.jsonl', 'vectors.partial.f32'].every((name) =>
        names.includes(name)) || names.some((name) => !allowedNames.has(name))) {
        return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
      }
      const existingChunks = await readRegularFile(
        chunksPath,
        SEMANTIC_INDEX_LIMITS.maximumMetadataBytes,
      );
      if (digestBytes(existingChunks) !== digestBytes(prepared.chunksBytes)) {
        return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
      }
      state = parseBuildState(
        await readCanonicalJson(statePath, MAXIMUM_STATE_BYTES),
        expectedState,
      );
    } catch (error) {
      try {
        await lstat(stageDirectory);
        if (!(error instanceof SemanticIndexError) ||
            error.code !== 'SEMANTIC_INDEX_INCOMPATIBLE') throw error;
        await quarantineDirectory(
          paths,
          stageDirectory,
          `stage-${prepared.buildId}`,
          paths.staging,
        );
        createStage = true;
      } catch (inspectionError) {
        if (!isNodeError(inspectionError) || inspectionError.code !== 'ENOENT') {
          throw inspectionError;
        }
        createStage = true;
      }
    }
    if (createStage) {
      try {
        await mkdir(stageDirectory, { mode: 0o700 });
        await syncDirectory(paths.staging);
        await runBuildHook(hooks.afterStageDirectoryCreate);
        await writeBytesExclusive(chunksPath, prepared.chunksBytes);
        await writeBytesExclusive(partialVectorsPath, new Uint8Array());
        await writeJsonAtomic(statePath, expectedState, { confinementRoot: paths.root });
        state = expectedState;
      } catch (creationError) {
        if (creationError instanceof SemanticIndexError) throw creationError;
        return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
      }
    }
    let partialHandle;
    try {
      partialHandle = await open(partialVectorsPath, 'r+');
      const partialStatus = await partialHandle.stat();
      const expectedPartialBytes = state.completedRows * 384 * 4;
      if (!partialStatus.isFile() || partialStatus.size < expectedPartialBytes ||
          partialStatus.size > state.rowCount * 384 * 4) {
        return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
      }
      if (partialStatus.size > expectedPartialBytes) {
        await partialHandle.truncate(expectedPartialBytes);
        await partialHandle.sync();
      }
    } finally {
      await partialHandle?.close().catch(() => undefined);
    }
    const started = performance.now();
    for (let offset = state.completedRows; offset < prepared.chunks.length;
      offset += SEMANTIC_INDEX_LIMITS.maximumBatchSize) {
      const batch = prepared.chunks.slice(offset, offset + SEMANTIC_INDEX_LIMITS.maximumBatchSize);
      const vectors: Array<Float32Array | undefined> = batch.map(({ chunk }) =>
        prepared.reuseVectors.get(chunk.contentDigest));
      const missingIndexes = vectors.flatMap((vector, index) => vector === undefined ? [index] : []);
      if (missingIndexes.length > 0) {
        let result;
        try {
          result = await input.provider.embedDocuments(missingIndexes.map((index) => {
            const material = batch[index];
            if (material === undefined) {
              return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
            }
            return material.text;
          }));
        } catch (error) {
          if (error instanceof SemanticIndexError) throw error;
          return fail('SEMANTIC_INDEX_BUILD_INCOMPLETE', 'build-interrupted');
        }
        if (result.providerUsed !== 'local-in-process' || result.egress !== 'none' ||
            result.identity.identityDigest !== input.embeddingIdentity.identityDigest ||
            result.vectors.length !== missingIndexes.length ||
            result.truncated.length !== missingIndexes.length) {
          return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'identity-mismatch');
        }
        if (result.truncated.some(Boolean)) {
          return fail('SEMANTIC_INDEX_DOCUMENT_TRUNCATED', 'truncated-document');
        }
        missingIndexes.forEach((batchIndex, resultIndex) => {
          const vector = result.vectors[resultIndex];
          if (vector === undefined) fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
          vectors[batchIndex] = vector;
        });
      }
      const completeVectors = vectors.map((vector) => {
        if (vector === undefined) return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
        validateVector(vector);
        return vector;
      });
      const bytes = encodeVectors(completeVectors);
      await appendVectorBytes(partialVectorsPath, bytes, state.completedRows * 384 * 4);
      const reusedInBatch = vectors.length - missingIndexes.length;
      state = Object.freeze({
        ...state,
        completedRows: state.completedRows + batch.length,
        reusedRows: state.reusedRows + reusedInBatch,
        createdRows: state.createdRows + missingIndexes.length,
      });
      await writeJsonAtomic(statePath, state, { confinementRoot: paths.root });
      await runBuildHook(hooks.afterBatch === undefined
        ? undefined
        : () => hooks.afterBatch?.(state.completedRows));
    }
    const finalVectorBytes = await readRegularFile(
      partialVectorsPath,
      SEMANTIC_INDEX_LIMITS.maximumVectorBytes,
    );
    if (finalVectorBytes.byteLength !== prepared.chunks.length * 384 * 4) {
      return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
    }
    decodeVectors(finalVectorBytes, prepared.chunks.length);
    const checksums = createChecksums(prepared.chunksBytes, finalVectorBytes);
    const manifest = createManifest(input, checksums);
    try {
      await writeJsonAtomic(join(stageDirectory, 'checksums.json'), checksums, {
        confinementRoot: paths.root,
      });
      await writeJsonAtomic(join(stageDirectory, 'manifest.json'), manifest, {
        confinementRoot: paths.root,
      });
      await syncDirectory(stageDirectory);
    } catch {
      return fail('SEMANTIC_INDEX_BUILD_INCOMPLETE', 'build-interrupted');
    }
    const pendingValue = pendingBasis({
      projectId: input.projectId,
      buildId: prepared.buildId,
      generationId: manifest.generationId,
      manifestDigest: manifest.manifestDigest,
      requestedMode,
      effectiveMode: prepared.effectiveMode,
      inputCorpusDigest: input.corpus.corpusDigest,
      sanitizerPolicyDigest: input.sanitizerPolicyDigest,
      previousGenerationId: prepared.previous?.manifest.generationId ?? null,
      embeddingIdentityDigest: input.embeddingIdentity.identityDigest,
      reusedRows: state.reusedRows,
      createdRows: state.createdRows,
      deletedRows: prepared.deletedRows,
      skippedRows: prepared.skippedRows,
      durationMilliseconds: Math.max(0, performance.now() - started),
    });
    try {
      await writeJsonAtomic(paths.pending, pendingValue, { confinementRoot: paths.root });
    } catch {
      return fail('SEMANTIC_INDEX_BUILD_INCOMPLETE', 'build-interrupted');
    }
    await runBuildHook(hooks.afterPendingWrite);
    return activatePending(paths, pendingValue, stageDirectory, hooks, input.activationGuard);
  });
}

function cosine(left: Float32Array, right: Float32Array): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return score;
}

export interface ExactCosineCandidate {
  readonly chunk: RetrievalChunkV1;
  readonly vector: Float32Array;
}

function exactCosineTopK(
  queryVector: Float32Array,
  candidates: readonly ExactCosineCandidate[],
  topK: number,
): readonly SemanticIndexSearchResultV1['hits'][number][] {
  return Object.freeze(candidates.map(({ chunk, vector }) => Object.freeze({
    chunkId: chunk.chunkId,
    rowOrdinal: chunk.rowOrdinal,
    pageId: chunk.pageId,
    sectionId: chunk.sectionId,
    citationLocators: chunk.citationLocators,
    score: cosine(queryVector, vector),
  })).sort((left, right) => right.score - left.score ||
    compareText(left.pageId, right.pageId) || compareText(left.sectionId, right.sectionId) ||
    compareText(left.chunkId, right.chunkId)).slice(0, topK));
}

/** @internal Source-only benchmark seam for the bounded 50k exact-scan acceptance gate. */
export function exactCosineTopKForTest(
  queryVector: Float32Array,
  candidates: readonly ExactCosineCandidate[],
  topK: number,
): readonly SemanticIndexSearchResultV1['hits'][number][] {
  validateVector(queryVector);
  if (!Number.isSafeInteger(topK) || topK < 1 ||
      topK > SEMANTIC_INDEX_LIMITS.maximumQueryResults ||
      candidates.length > SEMANTIC_INDEX_LIMITS.maximumChunks) {
    return fail('SEMANTIC_INDEX_CONFIG_INVALID', 'artifact-invalid');
  }
  return exactCosineTopK(queryVector, candidates, topK);
}

async function exportBundle(
  knowledgeRoot: string,
  input: SemanticIndexExportInputV1,
): Promise<SemanticIndexBundleResultV1> {
  const workspace = await projectWorkspace(knowledgeRoot, input.projectId);
  const paths = pathsFor(workspace);
  const active = await loadActive(paths, input.projectId);
  if (!isAbsolute(input.destinationDirectory) || normalize(input.destinationDirectory) !==
      input.destinationDirectory) {
    return fail('SEMANTIC_INDEX_CONFIG_INVALID', 'artifact-invalid');
  }
  const destination = input.destinationDirectory;
  const parent = resolve(destination, '..');
  await safeDirectory(parent);
  try {
    await mkdir(destination, { mode: 0o700 });
    for (const filename of GENERATION_FILES) {
      await copyFile(
        join(paths.generations, active.manifest.generationId, filename),
        join(destination, filename),
        constants.COPYFILE_EXCL,
      );
    }
    const copied = await loadGenerationDirectory(destination, input.projectId);
    if (copied.manifest.manifestDigest !== active.manifest.manifestDigest) {
      return fail('SEMANTIC_INDEX_BUNDLE_INVALID', 'bundle-incompatible');
    }
    await syncDirectory(destination);
    return Object.freeze({
      schemaVersion: SEMANTIC_INDEX_BUNDLE_SCHEMA_VERSION,
      projectId: input.projectId,
      generationId: copied.manifest.generationId,
      manifestDigest: copied.manifest.manifestDigest,
      fileCount: 4,
    });
  } catch (error) {
    await rm(destination, { force: true, recursive: true }).catch(() => undefined);
    if (error instanceof SemanticIndexError) throw error;
    return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
  }
}

async function importBundle(
  knowledgeRoot: string,
  input: SemanticIndexImportInputV1,
): Promise<SemanticIndexBundleResultV1> {
  if (!isAbsolute(input.bundleDirectory) || normalize(input.bundleDirectory) !==
      input.bundleDirectory || !safeDigest(input.corpusDigest) ||
      !safeDigest(input.sanitizerPolicyDigest) ||
      parseEmbeddingIdentityV2(input.embeddingIdentity) === null) {
    return fail('SEMANTIC_INDEX_CONFIG_INVALID', 'artifact-invalid');
  }
  const bundle = await loadGenerationDirectory(input.bundleDirectory, input.projectId);
  if (bundle.manifest.corpusDigest !== input.corpusDigest ||
      bundle.manifest.sanitizerPolicyDigest !== input.sanitizerPolicyDigest ||
      bundle.manifest.embeddingIdentity.identityDigest !== input.embeddingIdentity.identityDigest ||
      bundle.manifest.chunker.identityDigest !== SEMANTIC_CHUNKER_IDENTITY.identityDigest) {
    return fail('SEMANTIC_INDEX_BUNDLE_INVALID', 'bundle-incompatible');
  }
  const workspace = await projectWorkspace(knowledgeRoot, input.projectId);
  const paths = await preparePaths(workspace);
  return withLock(paths, async () => {
    const generationDirectory = join(paths.generations, bundle.manifest.generationId);
    try {
      const existing = await loadGenerationDirectory(generationDirectory, input.projectId);
      if (existing.manifest.manifestDigest !== bundle.manifest.manifestDigest) {
        return fail('SEMANTIC_INDEX_BUNDLE_INVALID', 'bundle-incompatible');
      }
    } catch (error) {
      try {
        await lstat(generationDirectory);
        throw error;
      } catch (inspectionError) {
        if (!isNodeError(inspectionError) || inspectionError.code !== 'ENOENT') throw error;
      }
      const stage = join(paths.staging, `import-${bundle.manifest.generationId}`);
      try {
        await mkdir(stage, { mode: 0o700 });
        for (const filename of GENERATION_FILES) {
          await copyFile(join(input.bundleDirectory, filename), join(stage, filename),
            constants.COPYFILE_EXCL);
        }
        const staged = await loadGenerationDirectory(stage, input.projectId);
        if (staged.manifest.manifestDigest !== bundle.manifest.manifestDigest) {
          return fail('SEMANTIC_INDEX_BUNDLE_INVALID', 'bundle-incompatible');
        }
        await rename(stage, generationDirectory);
        await syncDirectory(paths.generations);
      } catch (copyError) {
        await rm(stage, { force: true, recursive: true }).catch(() => undefined);
        if (copyError instanceof SemanticIndexError) throw copyError;
        return fail('SEMANTIC_INDEX_WRITE_FAILED', 'write-failed');
      }
    }
    return withActivationGuard(input.activationGuard, bundle.manifest, async () => {
      await writeJsonAtomic(paths.active, Object.freeze({
        schemaVersion: SEMANTIC_INDEX_ACTIVE_SCHEMA_VERSION,
        projectId: input.projectId,
        generationId: bundle.manifest.generationId,
        manifestDigest: bundle.manifest.manifestDigest,
      }), { confinementRoot: paths.root });
      return Object.freeze({
        schemaVersion: SEMANTIC_INDEX_BUNDLE_SCHEMA_VERSION,
        projectId: input.projectId,
        generationId: bundle.manifest.generationId,
        manifestDigest: bundle.manifest.manifestDigest,
        fileCount: 4,
      });
    });
  });
}

function createService(
  knowledgeRoot: string,
  hooks: SemanticIndexTestHooks,
): VectorIndexPort {
  return Object.freeze({
    async status(projectId: string): Promise<SemanticIndexStatusV1> {
      const workspace = await projectWorkspace(knowledgeRoot, projectId);
      try {
        const active = await loadActive(pathsFor(workspace), projectId);
        return Object.freeze({ manifest: active.manifest, projectId, state: 'ready' });
      } catch (error) {
        if (error instanceof SemanticIndexError && error.code === 'SEMANTIC_INDEX_UNAVAILABLE') {
          return Object.freeze({ projectId, state: 'none' });
        }
        return Object.freeze({
          projectId,
          reasonCode: 'artifact-invalid',
          recoveryAction: Object.freeze([
            'index', 'rebuild', '--full', '--project', projectId,
          ] as const),
          state: 'incompatible',
        });
      }
    },
    buildFull(input: SemanticIndexBuildInputV1): Promise<SemanticIndexBuildResultV1> {
      return runBuild(knowledgeRoot, input, 'full', hooks);
    },
    buildIncremental(input: SemanticIndexBuildInputV1): Promise<SemanticIndexBuildResultV1> {
      return runBuild(knowledgeRoot, input, 'incremental', hooks);
    },
    resume(input: SemanticIndexBuildInputV1): Promise<SemanticIndexBuildResultV1> {
      return runBuild(knowledgeRoot, input, 'incremental', hooks);
    },
    async openActive(projectId: string): Promise<SemanticIndexViewV1> {
      const workspace = await projectWorkspace(knowledgeRoot, projectId);
      const active = await loadActive(pathsFor(workspace), projectId);
      return Object.freeze({ manifest: active.manifest });
    },
    async searchExact(
      projectId: string,
      queryVector: Float32Array,
      topK: number = 10,
    ): Promise<SemanticIndexSearchResultV1> {
      validateVector(queryVector);
      if (!Number.isSafeInteger(topK) || topK < 1 ||
          topK > SEMANTIC_INDEX_LIMITS.maximumQueryResults) {
        return fail('SEMANTIC_INDEX_CONFIG_INVALID', 'artifact-invalid');
      }
      const workspace = await projectWorkspace(knowledgeRoot, projectId);
      const active = await loadActive(pathsFor(workspace), projectId);
      const candidates = active.chunks.map((chunk, index) => {
        const vector = active.vectors[index];
        if (vector === undefined) return fail('SEMANTIC_INDEX_INCOMPATIBLE', 'artifact-invalid');
        return Object.freeze({ chunk, vector });
      });
      const hits = exactCosineTopK(queryVector, candidates, topK);
      return Object.freeze({
        projectId,
        manifestDigest: active.manifest.manifestDigest,
        hits: Object.freeze(hits),
      });
    },
    exportBundle(input: SemanticIndexExportInputV1): Promise<SemanticIndexBundleResultV1> {
      return exportBundle(knowledgeRoot, input);
    },
    importBundle(input: SemanticIndexImportInputV1): Promise<SemanticIndexBundleResultV1> {
      return importBundle(knowledgeRoot, input);
    },
  });
}

export function createFlatFileVectorIndex(knowledgeRoot: string): VectorIndexPort {
  return createService(knowledgeRoot, {});
}

/** @internal Source-only deterministic seam for crash and atomic activation tests. */
export function createFlatFileVectorIndexForTest(
  knowledgeRoot: string,
  hooks: SemanticIndexTestHooks,
): VectorIndexPort {
  return createService(knowledgeRoot, hooks);
}
