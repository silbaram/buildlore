import { createHash } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, sep, win32 } from 'node:path';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { isNodeError } from '../knowledge/errors.js';
import {
  sourceRepositoryDigestFor,
  type Sha256Digest,
  type SourceCheckoutHandle,
} from '../knowledge/local-project-registry.js';
import { decodeUtf8Strict, parseJsonStrict } from '../knowledge/strict-json.js';
import { validateProjectId, validateRepositoryLocator } from '../knowledge/validation.js';
import {
  SourceSelectionError,
  type SourceSelectionErrorCode,
  type SourceSelectionField,
} from './errors.js';
import {
  createBuiltInSourceAdapterRegistry,
  GENERIC_SOURCE_ADAPTER_ID,
  mediaTypeForGenericKind,
  P2A_SOURCE_ADAPTER_ID,
} from './source-adapter-registry.js';
import {
  parseRegisteredSourceKind,
  parseSourceMetadata,
  type RegisteredMediaType,
  type RegisteredSourceKind,
  type SourceMetadataV1,
} from './source-contracts.js';

export const SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION = 'buildlore.sources.v1' as const;
export const SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION = 'buildlore.sources.v2' as const;
export const MAX_SOURCE_MANIFEST_BYTES = 64 * 1024;
export const MAX_SOURCE_DECLARATIONS = 128;
export const MAX_SOURCE_PATH_LENGTH = 512;
export const MAX_SOURCE_SELECTION_DEPTH = 64;
export const MAX_SELECTED_SOURCE_FILES = 10_000;
export const MAX_SELECTED_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_SELECTED_SOURCE_AGGREGATE_BYTES = 256 * 1024 * 1024;

const SOURCE_MANIFEST_RELATIVE_PATH = '.buildlore/sources.json';
const SOURCE_DECLARATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;
const MARKDOWN_EXTENSION_PATTERN = /\.(?:md|markdown)$/u;
const TEXT_EXTENSION_PATTERN = /\.(?:text|txt)$/u;
const CODE_EXTENSION_PATTERN = /\.(?:bash|c|cc|cjs|cpp|cs|css|cxx|fish|go|h|hpp|htm|html|java|js|jsx|kt|kts|less|mjs|php|py|rb|rs|sass|scala|scss|sh|sql|svelte|swift|ts|tsx|vue|xml|zsh)$/u;
const P2A_PLANNING_EXTENSION_PATTERN = /\.(?:json|jsonl|md|markdown)$/u;
const CREDENTIAL_PATH_PATTERN =
  /(?:^|[/_.-])(?:api[-_]?key|authorization|bearer|credentials?|password|private[-_]?key|refresh[-_]?token|secrets?|tokens?|access[-_]?token)(?:$|[/_.-])/iu;

export type SourceDocumentKind = 'code' | 'markdown' | 'p2a-planning' | 'text';

interface SourceDeclarationBase {
  readonly documentKind: SourceDocumentKind;
  readonly id: string;
  readonly path: string;
}

export interface SourceFileDeclaration extends SourceDeclarationBase {
  readonly pathType: 'file';
}

export interface SourceDirectoryDeclaration extends SourceDeclarationBase {
  readonly pathType: 'directory';
  readonly recursive?: boolean;
}

export type SourceDeclaration = SourceDirectoryDeclaration | SourceFileDeclaration;

interface SourceDeclarationV2Base {
  readonly adapterId: string;
  readonly adapterVersion: number;
  readonly id: string;
  readonly kind: RegisteredSourceKind;
  readonly metadata?: SourceMetadataV1;
  readonly path: string;
}

export interface SourceFileDeclarationV2 extends SourceDeclarationV2Base {
  readonly pathType: 'file';
}

export interface SourceDirectoryDeclarationV2 extends SourceDeclarationV2Base {
  readonly pathType: 'directory';
  readonly recursive?: boolean;
}

export type SourceDeclarationV2 = SourceDirectoryDeclarationV2 | SourceFileDeclarationV2;
export type AnySourceDeclaration = SourceDeclaration | SourceDeclarationV2;

export interface SourceCollectionManifestV1 {
  readonly projectId: string;
  readonly schemaVersion: typeof SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION;
  readonly sourceRepository: string;
  readonly sources: readonly SourceDeclaration[];
}

export interface SourceCollectionManifestV2 {
  readonly projectId: string;
  readonly schemaVersion: typeof SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION;
  readonly sourceRepository: string;
  readonly sources: readonly SourceDeclarationV2[];
}

export type SourceCollectionManifest = SourceCollectionManifestV1 | SourceCollectionManifestV2;

export interface LoadedSourceCollectionManifest {
  readonly manifest: SourceCollectionManifest;
  readonly manifestDigest: Sha256Digest;
}

export interface SourceFileIdentity {
  readonly ctimeNs: string;
  readonly device: string;
  readonly inode: string;
  readonly linkCount: string;
  readonly size: number;
}

export interface SelectedSourceFile {
  readonly adapterId?: string;
  readonly adapterVersion?: number;
  readonly byteLength: number;
  readonly contentDigest: Sha256Digest;
  readonly declarationId: string;
  readonly documentKind: SourceDocumentKind;
  readonly identity: SourceFileIdentity;
  readonly kind?: RegisteredSourceKind;
  readonly mediaType?: RegisteredMediaType;
  readonly metadata?: SourceMetadataV1;
  readonly sourceRef: string;
}

export interface SelectedSourceDirectory {
  readonly declarationId: string;
  readonly identity: SourceFileIdentity;
  readonly sourceRef: string;
}

export interface SourceSelectionInventory {
  readonly directories: readonly SelectedSourceDirectory[];
  readonly files: readonly SelectedSourceFile[];
  readonly manifestDigest: Sha256Digest;
  readonly projectId: string;
  readonly totalBytes: number;
}

export interface SourceSelectionLimitOverrides {
  readonly maxAggregateBytes?: number;
  readonly maxDepth?: number;
  readonly maxFileBytes?: number;
  readonly maxFileCount?: number;
}

/** Package-internal seams used for deterministic drift and bound tests. */
export interface SourceSelectionHooks {
  readonly afterDirectoryRead?: (sourceRef: string) => Promise<void> | void;
  readonly afterFileStat?: (sourceRef: string) => Promise<void> | void;
  readonly afterManifestStat?: () => Promise<void> | void;
}

export interface SourceSelectionOptions extends SourceSelectionHooks {
  readonly limits?: SourceSelectionLimitOverrides;
}

/** Package-internal options for re-reading a bound selection at the adapter boundary. */
export interface SelectedSourceReadOptions {
  readonly afterFileStat?: (sourceRef: string) => Promise<void> | void;
}

interface SourceSelectionLimits {
  readonly maxAggregateBytes: number;
  readonly maxDepth: number;
  readonly maxFileBytes: number;
  readonly maxFileCount: number;
}

function fail(
  code: SourceSelectionErrorCode,
  field: SourceSelectionField,
  message: string,
): never {
  throw new SourceSelectionError(code, field, message);
}

function sha256(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    fail('SOURCE_MANIFEST_INVALID', 'manifest', 'Source manifest fields are invalid.');
  }
}

function requireString(value: unknown, field: SourceSelectionField): string {
  if (typeof value !== 'string') {
    return fail('SOURCE_MANIFEST_INVALID', field, 'Source manifest field is invalid.');
  }
  return value;
}

function hasUnsafeCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return /\p{Cf}/u.test(value);
}

function validateDeclarationId(value: unknown): string {
  const id = requireString(value, 'id');
  if (
    id.length < 1 ||
    id.length > 64 ||
    !SOURCE_DECLARATION_ID_PATTERN.test(id)
  ) {
    return fail('SOURCE_MANIFEST_INVALID', 'id', 'Source declaration id is invalid.');
  }
  return id;
}

export function validateSourceSelectionPath(value: unknown): string {
  const path = requireString(value, 'path');
  const segments = path.split('/');
  const generatedRoot = segments[0];
  if (
    path.length < 1 ||
    path.length > MAX_SOURCE_PATH_LENGTH ||
    path !== path.normalize('NFC') ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    WINDOWS_DRIVE_PREFIX_PATTERN.test(path) ||
    path.includes('\\') ||
    path.includes('%') ||
    path.endsWith('/') ||
    posix.normalize(path) !== path ||
    segments.length > MAX_SOURCE_SELECTION_DEPTH ||
    segments.some((segment) =>
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment === '.git' ||
      segment === '.buildlore' ||
      segment === '.llmwiki') ||
    generatedRoot === 'knowledge' ||
    generatedRoot === 'projects' ||
    generatedRoot === 'sources' ||
    generatedRoot === 'wiki' ||
    generatedRoot === 'export' ||
    generatedRoot === 'exports' ||
    hasUnsafeCharacter(path) ||
    CREDENTIAL_PATH_PATTERN.test(path)
  ) {
    return fail('SOURCE_MANIFEST_INVALID', 'path', 'Source declaration path is unsafe.');
  }
  return path;
}

function parseDocumentKind(value: unknown): SourceDocumentKind {
  if (value !== 'markdown' && value !== 'p2a-planning') {
    return fail('SOURCE_KIND_UNSUPPORTED', 'documentKind', 'Source document kind is unsupported.');
  }
  return value;
}

function parseDeclaration(value: unknown): SourceDeclaration {
  if (!isRecord(value)) {
    return fail('SOURCE_MANIFEST_INVALID', 'sources', 'Source declaration is invalid.');
  }
  const pathType = value.pathType;
  if (pathType === 'file') {
    requireExactKeys(value, ['documentKind', 'id', 'path', 'pathType']);
    return Object.freeze({
      documentKind: parseDocumentKind(value.documentKind),
      id: validateDeclarationId(value.id),
      path: validateSourceSelectionPath(value.path),
      pathType: 'file',
    });
  }
  if (pathType === 'directory') {
    requireExactKeys(
      value,
      ['documentKind', 'id', 'path', 'pathType'],
      ['recursive'],
    );
    if (value.recursive !== undefined && typeof value.recursive !== 'boolean') {
      return fail('SOURCE_MANIFEST_INVALID', 'recursive', 'recursive must be a boolean.');
    }
    return Object.freeze({
      documentKind: parseDocumentKind(value.documentKind),
      id: validateDeclarationId(value.id),
      path: validateSourceSelectionPath(value.path),
      pathType: 'directory',
      ...(value.recursive === undefined ? {} : { recursive: value.recursive }),
    });
  }
  return fail('SOURCE_MANIFEST_INVALID', 'pathType', 'Source declaration pathType is invalid.');
}

function parseV2Declaration(value: unknown): SourceDeclarationV2 {
  if (!isRecord(value)) {
    return fail('SOURCE_MANIFEST_INVALID', 'sources', 'Source declaration is invalid.');
  }
  const pathType = value.pathType;
  const optional = ['metadata'];
  if (pathType === 'directory') optional.push('recursive');
  requireExactKeys(
    value,
    ['adapterId', 'adapterVersion', 'id', 'kind', 'path', 'pathType'],
    optional,
  );
  if (pathType !== 'file' && pathType !== 'directory') {
    return fail('SOURCE_MANIFEST_INVALID', 'pathType', 'Source declaration pathType is invalid.');
  }
  if (pathType === 'directory' && value.recursive !== undefined &&
      typeof value.recursive !== 'boolean') {
    return fail('SOURCE_MANIFEST_INVALID', 'recursive', 'recursive must be a boolean.');
  }
  let kind: RegisteredSourceKind;
  let metadata: SourceMetadataV1 | undefined;
  try {
    kind = parseRegisteredSourceKind(value.kind);
    metadata = value.metadata === undefined ? undefined : parseSourceMetadata(value.metadata);
    createBuiltInSourceAdapterRegistry().resolve({
      adapterId: requireString(value.adapterId, 'manifest'),
      adapterVersion: typeof value.adapterVersion === 'number' ? value.adapterVersion : 0,
      kind,
      ...(metadata === undefined ? {} : { metadata }),
    });
  } catch {
    return fail('SOURCE_KIND_UNSUPPORTED', 'manifest', 'Source adapter binding is unsupported.');
  }
  return Object.freeze({
    adapterId: requireString(value.adapterId, 'manifest'),
    adapterVersion: value.adapterVersion as number,
    id: validateDeclarationId(value.id),
    kind,
    ...(metadata === undefined ? {} : { metadata }),
    path: validateSourceSelectionPath(value.path),
    pathType,
    ...(pathType === 'directory' && value.recursive !== undefined
      ? { recursive: value.recursive }
      : {}),
  }) as SourceDeclarationV2;
}

export function parseSourceCollectionManifest(value: unknown): SourceCollectionManifestV1 {
  if (!isRecord(value)) {
    return fail('SOURCE_MANIFEST_INVALID', 'manifest', 'Source manifest is invalid.');
  }
  requireExactKeys(value, ['projectId', 'schemaVersion', 'sourceRepository', 'sources']);
  if (value.schemaVersion !== SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION) {
    return fail('SOURCE_MANIFEST_INVALID', 'manifest', 'Source manifest schema is unsupported.');
  }
  let projectId: string;
  try {
    projectId = validateProjectId(requireString(value.projectId, 'projectId'));
  } catch {
    return fail('SOURCE_MANIFEST_INVALID', 'projectId', 'Source manifest projectId is invalid.');
  }
  let sourceRepository: string;
  try {
    sourceRepository = validateRepositoryLocator(
      requireString(value.sourceRepository, 'sourceRepository'),
    );
  } catch {
    return fail(
      'SOURCE_MANIFEST_INVALID',
      'sourceRepository',
      'Source manifest repository identity is invalid.',
    );
  }
  if (
    !Array.isArray(value.sources) ||
    value.sources.length < 1 ||
    value.sources.length > MAX_SOURCE_DECLARATIONS
  ) {
    return fail('SOURCE_MANIFEST_INVALID', 'sources', 'Source declarations are out of bounds.');
  }
  const sources = value.sources.map(parseDeclaration);
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      return fail('SOURCE_MANIFEST_INVALID', 'id', 'Source declaration id is duplicated.');
    }
    ids.add(source.id);
  }
  return Object.freeze({
    projectId,
    schemaVersion: SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION,
    sourceRepository,
    sources: Object.freeze(
      [...sources].sort((left, right) => compareText(left.id, right.id)),
    ),
  });
}

export function parseSourceCollectionManifestV2(value: unknown): SourceCollectionManifestV2 {
  if (!isRecord(value)) {
    return fail('SOURCE_MANIFEST_INVALID', 'manifest', 'Source manifest is invalid.');
  }
  requireExactKeys(value, ['projectId', 'schemaVersion', 'sourceRepository', 'sources']);
  if (value.schemaVersion !== SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION) {
    return fail('SOURCE_MANIFEST_INVALID', 'manifest', 'Source manifest schema is unsupported.');
  }
  let projectId: string;
  try {
    projectId = validateProjectId(requireString(value.projectId, 'projectId'));
  } catch {
    return fail('SOURCE_MANIFEST_INVALID', 'projectId', 'Source manifest projectId is invalid.');
  }
  let sourceRepository: string;
  try {
    sourceRepository = validateRepositoryLocator(
      requireString(value.sourceRepository, 'sourceRepository'),
    );
  } catch {
    return fail(
      'SOURCE_MANIFEST_INVALID',
      'sourceRepository',
      'Source manifest repository identity is invalid.',
    );
  }
  if (!Array.isArray(value.sources) || value.sources.length > MAX_SOURCE_DECLARATIONS) {
    return fail('SOURCE_MANIFEST_INVALID', 'sources', 'Source declarations are out of bounds.');
  }
  const sources = value.sources.map(parseV2Declaration);
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      return fail('SOURCE_MANIFEST_INVALID', 'id', 'Source declaration id is duplicated.');
    }
    ids.add(source.id);
  }
  return Object.freeze({
    projectId,
    schemaVersion: SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
    sourceRepository,
    sources: Object.freeze(
      [...sources].sort((left, right) => compareText(left.id, right.id)),
    ),
  });
}

export function parseAnySourceCollectionManifest(value: unknown): SourceCollectionManifest {
  if (isRecord(value) && value.schemaVersion === SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION) {
    return parseSourceCollectionManifestV2(value);
  }
  return parseSourceCollectionManifest(value);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs;
}

function fileIdentity(status: BigIntStats): SourceFileIdentity {
  return Object.freeze({
    ctimeNs: status.ctimeNs.toString(10),
    device: status.dev.toString(10),
    inode: status.ino.toString(10),
    linkCount: status.nlink.toString(10),
    size: Number(status.size),
  });
}

function matchesRecordedIdentity(
  status: BigIntStats,
  identity: SourceFileIdentity,
): boolean {
  return status.ctimeNs.toString(10) === identity.ctimeNs &&
    status.dev.toString(10) === identity.device &&
    status.ino.toString(10) === identity.inode &&
    status.nlink.toString(10) === identity.linkCount &&
    Number(status.size) === identity.size;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (
    difference !== '..' &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

async function canonicalCheckoutRoot(checkout: SourceCheckoutHandle): Promise<string> {
  const root = checkout.resolveRootForInternalUse();
  try {
    const [status, canonical] = await Promise.all([
      lstat(root, { bigint: true }),
      realpath(root),
    ]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== root) {
      return fail(
        'SOURCE_SELECTION_PATH_UNSAFE',
        'path',
        'Source checkout root is unsafe.',
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof SourceSelectionError) throw error;
    return fail(
      'SOURCE_SELECTION_PATH_UNSAFE',
      'path',
      'Source checkout root is unavailable.',
    );
  }
}

async function safeManifestDirectory(root: string, sourceRef: string): Promise<string> {
  const path = join(root, ...sourceRef.split('/'));
  try {
    const [status, canonical] = await Promise.all([
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      canonical !== path ||
      !isContained(root, canonical)
    ) {
      return fail('SOURCE_SELECTION_PATH_UNSAFE', 'path', 'Source directory is unsafe.');
    }
    return canonical;
  } catch (error) {
    if (error instanceof SourceSelectionError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new SourceSelectionError(
        'SOURCE_MANIFEST_REQUIRED',
        'manifest',
        'Source collection manifest is required.',
      );
    }
    return fail('SOURCE_SELECTION_PATH_UNSAFE', 'path', 'Source directory is unavailable.');
  }
}

export async function readSourceCollectionManifest(
  checkout: SourceCheckoutHandle,
  expectedProjectId: string,
  hooks: SourceSelectionHooks = {},
): Promise<LoadedSourceCollectionManifest> {
  let projectId: string;
  try {
    projectId = validateProjectId(expectedProjectId);
  } catch {
    return fail('SOURCE_PROJECT_MISMATCH', 'projectId', 'Selected project identity is invalid.');
  }
  if (checkout.projectId !== projectId) {
    return fail(
      'SOURCE_PROJECT_MISMATCH',
      'projectId',
      'Source checkout does not match the selected project.',
    );
  }
  const root = await canonicalCheckoutRoot(checkout);
  const manifestDirectoryRef = posix.dirname(SOURCE_MANIFEST_RELATIVE_PATH);
  const manifestDirectory = await safeManifestDirectory(root, manifestDirectoryRef);
  const manifestPath = join(manifestDirectory, 'sources.json');
  let expected: BigIntStats;
  try {
    expected = await lstat(manifestPath, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new SourceSelectionError(
        'SOURCE_MANIFEST_REQUIRED',
        'manifest',
        'Source collection manifest is required.',
      );
    }
    return fail('SOURCE_MANIFEST_INVALID', 'manifest', 'Source manifest is unreadable.');
  }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n) {
    return fail('SOURCE_SELECTION_PATH_UNSAFE', 'manifest', 'Source manifest path is unsafe.');
  }
  if (expected.size > BigInt(MAX_SOURCE_MANIFEST_BYTES)) {
    return fail('SOURCE_MANIFEST_TOO_LARGE', 'manifest', 'Source manifest is too large.');
  }

  let handle;
  let bytes: Buffer;
  try {
    handle = await open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(expected, before)) {
      return fail('SOURCE_SELECTION_CHANGED', 'manifest', 'Source manifest changed while opening.');
    }
    await hooks.afterManifestStat?.();
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameIdentity(before, after) ||
      bytes.byteLength !== Number(after.size)
    ) {
      return fail('SOURCE_SELECTION_CHANGED', 'manifest', 'Source manifest changed while reading.');
    }
    if (bytes.byteLength > MAX_SOURCE_MANIFEST_BYTES) {
      return fail('SOURCE_MANIFEST_TOO_LARGE', 'manifest', 'Source manifest is too large.');
    }
  } catch (error) {
    if (error instanceof SourceSelectionError) throw error;
    return fail('SOURCE_MANIFEST_INVALID', 'manifest', 'Source manifest is unreadable.');
  } finally {
    try {
      await handle?.close();
    } catch {
      // Preserve the structured manifest failure.
    }
  }

  let decoded: string;
  let manifest: SourceCollectionManifest;
  try {
    decoded = decodeUtf8Strict(bytes);
    manifest = parseAnySourceCollectionManifest(parseJsonStrict(decoded));
  } catch (error) {
    if (error instanceof SourceSelectionError) throw error;
    return fail('SOURCE_MANIFEST_INVALID', 'manifest', 'Source manifest JSON is invalid.');
  }
  if (serializeCanonicalJson(manifest) !== decoded) {
    return fail('SOURCE_MANIFEST_INVALID', 'manifest', 'Source manifest is not canonical JSON.');
  }
  if (manifest.projectId !== projectId) {
    return fail(
      'SOURCE_PROJECT_MISMATCH',
      'projectId',
      'Source manifest does not match the selected project.',
    );
  }
  if (sourceRepositoryDigestFor(manifest.sourceRepository) !== checkout.sourceRepositoryDigest) {
    return fail(
      'SOURCE_PROJECT_MISMATCH',
      'sourceRepository',
      'Source manifest does not match the bound repository identity.',
    );
  }
  return Object.freeze({ manifest, manifestDigest: sha256(bytes) });
}

function boundedOverride(
  value: number | undefined,
  maximum: number,
): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return fail(
      'SOURCE_MANIFEST_INVALID',
      'manifest',
      'Source selection limit override is invalid.',
    );
  }
  return value;
}

function selectionLimits(overrides: SourceSelectionLimitOverrides | undefined): SourceSelectionLimits {
  return Object.freeze({
    maxAggregateBytes: boundedOverride(
      overrides?.maxAggregateBytes,
      MAX_SELECTED_SOURCE_AGGREGATE_BYTES,
    ),
    maxDepth: boundedOverride(overrides?.maxDepth, MAX_SOURCE_SELECTION_DEPTH),
    maxFileBytes: boundedOverride(
      overrides?.maxFileBytes,
      MAX_SELECTED_SOURCE_FILE_BYTES,
    ),
    maxFileCount: boundedOverride(overrides?.maxFileCount, MAX_SELECTED_SOURCE_FILES),
  });
}

function isExecutionSelectionPath(sourceRef: string): boolean {
  const segments = sourceRef.split('/');
  return segments.includes('runs') || segments.at(-1) === 'run-index.json';
}

function matchesDocumentKind(documentKind: SourceDocumentKind, sourceRef: string): boolean {
  switch (documentKind) {
    case 'code':
      return CODE_EXTENSION_PATTERN.test(sourceRef);
    case 'markdown':
      return MARKDOWN_EXTENSION_PATTERN.test(sourceRef);
    case 'text':
      return TEXT_EXTENSION_PATTERN.test(sourceRef);
    case 'p2a-planning':
      return !isExecutionSelectionPath(sourceRef) && P2A_PLANNING_EXTENSION_PATTERN.test(sourceRef);
  }
}

export function sourceDeclarationDocumentKind(
  declaration: AnySourceDeclaration,
): SourceDocumentKind {
  if ('documentKind' in declaration) return declaration.documentKind;
  if (
    declaration.adapterId === P2A_SOURCE_ADAPTER_ID &&
    declaration.adapterVersion === 1 &&
    declaration.kind === 'planning'
  ) return 'p2a-planning';
  if (
    declaration.adapterId === GENERIC_SOURCE_ADAPTER_ID &&
    declaration.adapterVersion === 1 &&
    (declaration.kind === 'markdown' || declaration.kind === 'text' || declaration.kind === 'code')
  ) return declaration.kind;
  return fail('SOURCE_KIND_UNSUPPORTED', 'manifest', 'Source adapter binding is unsupported.');
}

function declarationAdapterId(declaration: AnySourceDeclaration): string {
  if ('adapterId' in declaration) return declaration.adapterId;
  return declaration.documentKind === 'p2a-planning'
    ? P2A_SOURCE_ADAPTER_ID
    : GENERIC_SOURCE_ADAPTER_ID;
}

function declarationKind(declaration: AnySourceDeclaration): RegisteredSourceKind {
  if ('kind' in declaration) return declaration.kind;
  return declaration.documentKind === 'p2a-planning' ? 'planning' : declaration.documentKind;
}

export function sourceDeclarationMediaType(
  declaration: AnySourceDeclaration,
  sourceRef: string,
): RegisteredMediaType {
  const kind = declarationKind(declaration);
  if (kind === 'planning') {
    if (sourceRef.endsWith('.jsonl')) return 'application/x-ndjson';
    if (sourceRef.endsWith('.md') || sourceRef.endsWith('.markdown')) {
      return 'text/markdown';
    }
    return 'application/json';
  }
  if (kind === 'execution') {
    return fail('SOURCE_KIND_UNSUPPORTED', 'manifest', 'Execution sources use P2A root discovery.');
  }
  return mediaTypeForGenericKind(kind);
}

function assertSelectionPath(sourceRef: string, maximumDepth: number): void {
  if (
    sourceRef.length > MAX_SOURCE_PATH_LENGTH ||
    sourceRef.split('/').length > maximumDepth
  ) {
    fail('SOURCE_SELECTION_LIMIT_EXCEEDED', 'path', 'Source selection path limit exceeded.');
  }
  try {
    validateSourceSelectionPath(sourceRef);
  } catch (error) {
    if (error instanceof SourceSelectionError) {
      fail('SOURCE_SELECTION_PATH_UNSAFE', 'path', 'Source selection path is unsafe.');
    }
    throw error;
  }
}

function assertManifestBinding(
  checkout: SourceCheckoutHandle,
  loaded: LoadedSourceCollectionManifest,
): SourceCollectionManifest {
  const manifest = parseAnySourceCollectionManifest(loaded.manifest);
  if (
    sha256(serializeCanonicalJson(manifest)) !== loaded.manifestDigest
  ) {
    return fail('SOURCE_SELECTION_CHANGED', 'manifest', 'Source manifest digest changed.');
  }
  if (
    manifest.projectId !== checkout.projectId ||
    sourceRepositoryDigestFor(manifest.sourceRepository) !== checkout.sourceRepositoryDigest
  ) {
    return fail(
      'SOURCE_PROJECT_MISMATCH',
      'projectId',
      'Source manifest binding does not match the selected checkout.',
    );
  }
  return manifest;
}

async function readSelectedFile(
  root: string,
  declaration: AnySourceDeclaration,
  sourceRef: string,
  limits: SourceSelectionLimits,
  remainingAggregateBytes: number,
  hooks: SourceSelectionHooks,
): Promise<SelectedSourceFile> {
  assertSelectionPath(sourceRef, limits.maxDepth);
  const path = join(root, ...sourceRef.split('/'));
  let expected: BigIntStats;
  let canonical: string;
  try {
    [expected, canonical] = await Promise.all([
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
  } catch {
    return fail('SOURCE_SELECTION_PATH_UNSAFE', 'path', 'Selected source file is unavailable.');
  }
  if (
    !expected.isFile() ||
    expected.isSymbolicLink() ||
    expected.nlink !== 1n ||
    canonical !== path ||
    !isContained(root, canonical)
  ) {
    return fail('SOURCE_SELECTION_PATH_UNSAFE', 'path', 'Selected source file is unsafe.');
  }
  if (expected.size > BigInt(limits.maxFileBytes)) {
    return fail(
      'SOURCE_SELECTION_LIMIT_EXCEEDED',
      'sources',
      'Selected source file exceeds its byte limit.',
    );
  }
  if (Number(expected.size) > remainingAggregateBytes) {
    return fail(
      'SOURCE_SELECTION_LIMIT_EXCEEDED',
      'sources',
      'Selected source files exceed the aggregate byte limit.',
    );
  }

  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(expected, before)) {
      return fail('SOURCE_SELECTION_CHANGED', 'path', 'Selected source changed while opening.');
    }
    await hooks.afterFileStat?.(sourceRef);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameIdentity(before, after) ||
      bytes.byteLength !== Number(after.size)
    ) {
      return fail('SOURCE_SELECTION_CHANGED', 'path', 'Selected source changed while reading.');
    }
    if (bytes.byteLength > limits.maxFileBytes || bytes.byteLength > remainingAggregateBytes) {
      return fail(
        'SOURCE_SELECTION_LIMIT_EXCEEDED',
        'sources',
        'Selected source bytes exceed configured limits.',
      );
    }
    return Object.freeze({
      adapterId: declarationAdapterId(declaration),
      adapterVersion: 'adapterVersion' in declaration ? declaration.adapterVersion : 1,
      byteLength: bytes.byteLength,
      contentDigest: sha256(bytes),
      declarationId: declaration.id,
      documentKind: sourceDeclarationDocumentKind(declaration),
      identity: fileIdentity(after),
      kind: declarationKind(declaration),
      mediaType: sourceDeclarationMediaType(declaration, sourceRef),
      ...('metadata' in declaration && declaration.metadata !== undefined
        ? { metadata: declaration.metadata }
        : {}),
      sourceRef,
    });
  } catch (error) {
    if (error instanceof SourceSelectionError) throw error;
    return fail('SOURCE_SELECTION_PATH_UNSAFE', 'path', 'Selected source file is unreadable.');
  } finally {
    try {
      await handle?.close();
    } catch {
      // Preserve the structured selection failure.
    }
  }
}

export async function selectDeclaredSourceFiles(
  checkout: SourceCheckoutHandle,
  loaded: LoadedSourceCollectionManifest,
  options: SourceSelectionOptions = {},
): Promise<SourceSelectionInventory> {
  const manifest = assertManifestBinding(checkout, loaded);
  const root = await canonicalCheckoutRoot(checkout);
  const limits = selectionLimits(options.limits);
  const files: SelectedSourceFile[] = [];
  const directories: SelectedSourceDirectory[] = [];
  let totalBytes = 0;

  const selectFile = async (
    declaration: AnySourceDeclaration,
    sourceRef: string,
  ): Promise<void> => {
    if (files.length >= limits.maxFileCount) {
      return fail(
        'SOURCE_SELECTION_LIMIT_EXCEEDED',
        'sources',
        'Selected source file count limit exceeded.',
      );
    }
    const selected = await readSelectedFile(
      root,
      declaration,
      sourceRef,
      limits,
      limits.maxAggregateBytes - totalBytes,
      options,
    );
    files.push(selected);
    totalBytes += selected.byteLength;
  };

  const visitDirectory = async (
    declaration: SourceDirectoryDeclaration | SourceDirectoryDeclarationV2,
    sourceRef: string,
  ): Promise<void> => {
    assertSelectionPath(sourceRef, limits.maxDepth);
    const path = join(root, ...sourceRef.split('/'));
    let before: BigIntStats;
    let canonical: string;
    try {
      [before, canonical] = await Promise.all([
        lstat(path, { bigint: true }),
        realpath(path),
      ]);
    } catch {
      return fail('SOURCE_SELECTION_PATH_UNSAFE', 'path', 'Selected source directory is unavailable.');
    }
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      canonical !== path ||
      !isContained(root, canonical)
    ) {
      return fail('SOURCE_SELECTION_PATH_UNSAFE', 'path', 'Selected source directory is unsafe.');
    }
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
      await options.afterDirectoryRead?.(sourceRef);
      const after = await lstat(path, { bigint: true });
      if (!after.isDirectory() || !sameIdentity(before, after)) {
        return fail('SOURCE_SELECTION_CHANGED', 'path', 'Selected source directory changed.');
      }
      directories.push(Object.freeze({
        declarationId: declaration.id,
        identity: fileIdentity(after),
        sourceRef,
      }));
    } catch (error) {
      if (error instanceof SourceSelectionError) throw error;
      return fail('SOURCE_SELECTION_PATH_UNSAFE', 'path', 'Selected source directory is unreadable.');
    }
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const childRef = `${sourceRef}/${entry.name}`;
      assertSelectionPath(childRef, limits.maxDepth);
      if (entry.isSymbolicLink()) {
        return fail('SOURCE_SELECTION_PATH_UNSAFE', 'path', 'Selected source tree contains a symlink.');
      }
      if (entry.isDirectory()) {
        if (sourceDeclarationDocumentKind(declaration) === 'p2a-planning' &&
            entry.name === 'runs') continue;
        if (declaration.recursive === true) await visitDirectory(declaration, childRef);
        continue;
      }
      if (!entry.isFile()) {
        return fail(
          'SOURCE_SELECTION_PATH_UNSAFE',
          'path',
          'Selected source tree contains an unsafe file type.',
        );
      }
      if (matchesDocumentKind(sourceDeclarationDocumentKind(declaration), childRef)) {
        await selectFile(declaration, childRef);
      }
    }
  };

  for (const declaration of manifest.sources) {
    assertSelectionPath(declaration.path, limits.maxDepth);
    if (
      sourceDeclarationDocumentKind(declaration) === 'p2a-planning' &&
      isExecutionSelectionPath(declaration.path)
    ) {
      return fail(
        'SOURCE_SELECTION_KIND_MISMATCH',
        'path',
        'Execution artifacts cannot be selected as P2A planning sources.',
      );
    }
    if (declaration.pathType === 'file') {
      if (!matchesDocumentKind(sourceDeclarationDocumentKind(declaration), declaration.path)) {
        return fail(
          'SOURCE_SELECTION_KIND_MISMATCH',
          'path',
          'Declared file does not match its source document kind.',
        );
      }
      await selectFile(declaration, declaration.path);
    } else {
      await visitDirectory(declaration, declaration.path);
    }
  }

  for (const directory of directories) {
    const path = join(root, ...directory.sourceRef.split('/'));
    let current: BigIntStats;
    let canonical: string;
    try {
      [current, canonical] = await Promise.all([
        lstat(path, { bigint: true }),
        realpath(path),
      ]);
    } catch {
      return fail('SOURCE_SELECTION_CHANGED', 'path', 'Selected source directory changed.');
    }
    if (!current.isDirectory() || current.isSymbolicLink() || canonical !== path ||
        !isContained(root, canonical) || !matchesRecordedIdentity(current, directory.identity)) {
      return fail('SOURCE_SELECTION_CHANGED', 'path', 'Selected source directory changed.');
    }
  }
  for (const file of files) {
    const path = join(root, ...file.sourceRef.split('/'));
    let current: BigIntStats;
    let canonical: string;
    try {
      [current, canonical] = await Promise.all([
        lstat(path, { bigint: true }),
        realpath(path),
      ]);
    } catch {
      return fail('SOURCE_SELECTION_CHANGED', 'path', 'Selected source file changed.');
    }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
        canonical !== path || !isContained(root, canonical) ||
        !matchesRecordedIdentity(current, file.identity)) {
      return fail('SOURCE_SELECTION_CHANGED', 'path', 'Selected source file changed.');
    }
  }

  return Object.freeze({
    directories: Object.freeze(
      [...directories].sort((left, right) =>
        compareText(`${left.declarationId}:${left.sourceRef}`, `${right.declarationId}:${right.sourceRef}`),
      ),
    ),
    files: Object.freeze(
      [...files].sort((left, right) =>
        compareText(`${left.declarationId}:${left.sourceRef}`, `${right.declarationId}:${right.sourceRef}`),
      ),
    ),
    manifestDigest: loaded.manifestDigest,
    projectId: manifest.projectId,
    totalBytes,
  });
}

/**
 * Re-read one selected file without trusting a caller-supplied path or stale bytes.
 *
 * The returned bytes are still untrusted source input. Collection adapters must
 * decode and normalize them before handing a candidate to the sanitizer.
 */
export async function readSelectedSourceBytes(
  checkout: SourceCheckoutHandle,
  selected: SelectedSourceFile,
  options: SelectedSourceReadOptions = {},
): Promise<Buffer> {
  const root = await canonicalCheckoutRoot(checkout);
  assertSelectionPath(selected.sourceRef, MAX_SOURCE_SELECTION_DEPTH);
  if (
    !Number.isSafeInteger(selected.byteLength) ||
    selected.byteLength < 0 ||
    selected.byteLength > MAX_SELECTED_SOURCE_FILE_BYTES ||
    selected.identity.linkCount !== '1' ||
    selected.identity.size !== selected.byteLength ||
    !/^sha256:[a-f0-9]{64}$/u.test(selected.contentDigest)
  ) {
    return fail(
      'SOURCE_SELECTION_CHANGED',
      'path',
      'Selected source identity is invalid.',
    );
  }
  if (
    !matchesDocumentKind(selected.documentKind, selected.sourceRef) ||
    (selected.documentKind === 'p2a-planning' && isExecutionSelectionPath(selected.sourceRef))
  ) {
    return fail(
      'SOURCE_SELECTION_KIND_MISMATCH',
      'path',
      'Selected source does not match its document kind.',
    );
  }
  const path = join(root, ...selected.sourceRef.split('/'));
  let expected: BigIntStats;
  let canonical: string;
  try {
    [expected, canonical] = await Promise.all([
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
  } catch {
    return fail('SOURCE_SELECTION_PATH_UNSAFE', 'path', 'Selected source file is unavailable.');
  }
  const expectedIdentity = fileIdentity(expected);
  if (
    !expected.isFile() ||
    expected.isSymbolicLink() ||
    expected.nlink !== 1n ||
    expected.size > BigInt(MAX_SELECTED_SOURCE_FILE_BYTES) ||
    canonical !== path ||
    !isContained(root, canonical) ||
    expectedIdentity.ctimeNs !== selected.identity.ctimeNs ||
    expectedIdentity.device !== selected.identity.device ||
    expectedIdentity.inode !== selected.identity.inode ||
    expectedIdentity.linkCount !== selected.identity.linkCount ||
    expectedIdentity.size !== selected.identity.size ||
    Number(expected.size) !== selected.byteLength
  ) {
    return fail('SOURCE_SELECTION_CHANGED', 'path', 'Selected source changed after selection.');
  }

  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(expected, before)) {
      return fail('SOURCE_SELECTION_CHANGED', 'path', 'Selected source changed while opening.');
    }
    await options.afterFileStat?.(selected.sourceRef);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameIdentity(before, after) ||
      bytes.byteLength !== selected.byteLength ||
      sha256(bytes) !== selected.contentDigest
    ) {
      return fail('SOURCE_SELECTION_CHANGED', 'path', 'Selected source changed while reading.');
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (error instanceof SourceSelectionError) throw error;
    return fail('SOURCE_SELECTION_PATH_UNSAFE', 'path', 'Selected source file is unreadable.');
  } finally {
    try {
      await handle?.close();
    } catch {
      // Preserve the structured selection failure.
    }
  }
}
