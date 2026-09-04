import { posix, win32 } from 'node:path';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { validateProjectId } from '../knowledge/validation.js';
import { ProjectionError } from './errors.js';
import { unicodeScalarLength } from './text-units.js';

export const SOURCE_DESCRIPTOR_SCHEMA_VERSION = 'buildlore.source-descriptor.v1' as const;
export const SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION =
  'buildlore.source-retrieval-meaning.v1' as const;
export const SOURCE_ADAPTER_REGISTRATION_VERSION = 1 as const;
export const MAX_SOURCE_METADATA_BYTES = 16 * 1024;
export const MAX_SOURCE_METADATA_DEPTH = 8;
export const MAX_SOURCE_METADATA_KEYS = 64;

export type GenericSourceKind = 'code' | 'markdown' | 'text';
export type RegisteredSourceKind = GenericSourceKind | 'execution' | 'planning';
export type RegisteredMediaType =
  | 'application/json'
  | 'application/x-ndjson'
  | 'text/markdown'
  | 'text/plain'
  | 'text/x-source-code';

export interface SourceMetadataV1 {
  readonly namespace: string;
  readonly schemaVersion: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export type SourceDocumentAuthority = 'canonical' | 'historical' | 'supporting' | 'unknown';
export type SourceDocumentLifecycle =
  | 'current'
  | 'deprecated'
  | 'draft'
  | 'superseded'
  | 'unknown';
export type SourceEvidenceKind =
  | 'architecture'
  | 'decision'
  | 'execution'
  | 'failure'
  | 'implementation'
  | 'other'
  | 'overview'
  | 'planning'
  | 'verification';
export type SourceRetrievalMeaningOrigin = 'adapter' | 'legacy-default' | 'manifest' | 'profile';

/** Language-neutral, adapter-bound signals used only after relevance produces a candidate. */
export interface SourceRetrievalMeaningV1 {
  readonly schemaVersion: typeof SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION;
  readonly authority: SourceDocumentAuthority;
  readonly evidenceKind: SourceEvidenceKind;
  readonly iterationGroup: string | null;
  readonly lifecycle: SourceDocumentLifecycle;
  readonly revisionOrdinal: number;
  readonly supersededBySourceRefs: readonly string[];
  readonly supersedesSourceRefs: readonly string[];
  readonly topicGroup: string | null;
}

export interface BoundSourceRetrievalMeaningV1 {
  readonly meaning: SourceRetrievalMeaningV1;
  readonly origin: SourceRetrievalMeaningOrigin;
}

export interface SourceRetrievalSupersessionNodeV1 {
  readonly retrievalMeaning?: SourceRetrievalMeaningV1;
  readonly sourceRef: string;
}

export interface SourceDescriptorV1 {
  readonly adapterId: string;
  readonly adapterVersion: number;
  readonly contentHash: `sha256:${string}`;
  readonly declarationId: string;
  readonly kind: RegisteredSourceKind;
  readonly mediaType: RegisteredMediaType;
  readonly metadata?: SourceMetadataV1;
  readonly projectId: string;
  readonly schemaVersion: typeof SOURCE_DESCRIPTOR_SCHEMA_VERSION;
  readonly sourceRef: string;
  readonly sourceRevision: `sha256:${string}`;
  readonly sourceUri: string;
}

export interface SourceOriginRangeV1 {
  readonly endColumn: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly startLine: number;
}

export interface SourceRangeMappingV1 {
  readonly canonical: SourceOriginRangeV1;
  readonly origin: SourceOriginRangeV1;
}

export interface SourceAdapterKindRegistrationV1 {
  readonly kind: RegisteredSourceKind;
  readonly mediaTypes: readonly RegisteredMediaType[];
}

export interface SourceAdapterLimitsV1 {
  readonly maxMetadataBytes: typeof MAX_SOURCE_METADATA_BYTES;
  readonly maxMetadataDepth: typeof MAX_SOURCE_METADATA_DEPTH;
  readonly maxMetadataKeys: typeof MAX_SOURCE_METADATA_KEYS;
}

export interface SourceAdapterRegistrationV1 {
  readonly adapterId: string;
  readonly adapterVersion: typeof SOURCE_ADAPTER_REGISTRATION_VERSION;
  readonly kinds: readonly SourceAdapterKindRegistrationV1[];
  readonly limits: SourceAdapterLimitsV1;
  readonly metadataNamespace: string;
  readonly metadataSchemaVersion: string;
}

const ADAPTER_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const DECLARATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MEDIA_TYPES = new Set<RegisteredMediaType>([
  'application/json',
  'application/x-ndjson',
  'text/markdown',
  'text/plain',
  'text/x-source-code',
]);
const REGISTERED_KINDS = new Set<RegisteredSourceKind>([
  'code',
  'execution',
  'markdown',
  'planning',
  'text',
]);
const DOCUMENT_AUTHORITIES = new Set<SourceDocumentAuthority>([
  'canonical', 'historical', 'supporting', 'unknown',
]);
const DOCUMENT_LIFECYCLES = new Set<SourceDocumentLifecycle>([
  'current', 'deprecated', 'draft', 'superseded', 'unknown',
]);
const EVIDENCE_KINDS = new Set<SourceEvidenceKind>([
  'architecture', 'decision', 'execution', 'failure', 'implementation', 'other',
  'overview', 'planning', 'verification',
]);
const SAFE_SOURCE_URI_PATTERN = /^[\u0020-\u007e]{1,4096}$/u;
const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;
const CREDENTIAL_PATH_PATTERN =
  /(?:^|[/_.-])(?:api[-_]?key|authorization|bearer|credentials?|password|private[-_]?key|refresh[-_]?token|secrets?|tokens?|access[-_]?token)(?:$|[/_.-])/iu;

function fail(message: string): never {
  throw new ProjectionError('PROJECTION_ARTIFACT_INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) fail('Source contract fields are invalid.');
}

function boundedIdentifier(
  value: unknown,
  pattern: RegExp,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.normalize('NFC') ||
    !pattern.test(value)
  ) return fail('Source contract identifier is invalid.');
  return value;
}

function digest(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return fail('Source contract digest is invalid.');
  }
  return value as `sha256:${string}`;
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

export function validatePortableSourceRef(value: unknown): string {
  if (typeof value !== 'string') return fail('Source reference is invalid.');
  const segments = value.split('/');
  const scalarLength = unicodeScalarLength(value);
  if (
    scalarLength < 1 ||
    scalarLength > 512 ||
    value !== value.normalize('NFC') ||
    value.startsWith('/') ||
    win32.isAbsolute(value) ||
    WINDOWS_DRIVE_PREFIX_PATTERN.test(value) ||
    value.includes('\\') ||
    value.includes('%') ||
    value.endsWith('/') ||
    posix.normalize(value) !== value ||
    segments.length > 64 ||
    segments.some((segment) =>
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment === '.git' ||
      segment === '.buildlore' ||
      segment === '.llmwiki') ||
    segments[0] === 'knowledge' ||
    segments[0] === 'projects' ||
    segments[0] === 'sources' ||
    segments[0] === 'wiki' ||
    segments[0] === 'export' ||
    segments[0] === 'exports' ||
    CREDENTIAL_PATH_PATTERN.test(value) ||
    hasUnsafeCharacter(value)
  ) return fail('Source reference is invalid.');
  return value;
}

function nullableGroup(value: unknown): string | null {
  if (value === null) return null;
  return boundedIdentifier(value, ADAPTER_ID_PATTERN, 128);
}

function sourceRefArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) {
    return fail('Source retrieval supersession references are invalid.');
  }
  const result = value.map(validatePortableSourceRef).sort();
  if (new Set(result).size !== result.length) {
    return fail('Source retrieval supersession references are duplicated.');
  }
  return Object.freeze(result);
}

export function parseSourceRetrievalMeaning(value: unknown): SourceRetrievalMeaningV1 {
  if (!isRecord(value)) return fail('Source retrieval meaning is invalid.');
  exactKeys(value, [
    'authority',
    'evidenceKind',
    'iterationGroup',
    'lifecycle',
    'revisionOrdinal',
    'schemaVersion',
    'supersededBySourceRefs',
    'supersedesSourceRefs',
    'topicGroup',
  ]);
  if (
    value.schemaVersion !== SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION ||
    typeof value.authority !== 'string' ||
    !DOCUMENT_AUTHORITIES.has(value.authority as SourceDocumentAuthority) ||
    typeof value.lifecycle !== 'string' ||
    !DOCUMENT_LIFECYCLES.has(value.lifecycle as SourceDocumentLifecycle) ||
    typeof value.evidenceKind !== 'string' ||
    !EVIDENCE_KINDS.has(value.evidenceKind as SourceEvidenceKind) ||
    typeof value.revisionOrdinal !== 'number' ||
    !Number.isSafeInteger(value.revisionOrdinal) ||
    value.revisionOrdinal < 0
  ) return fail('Source retrieval meaning is invalid.');
  const supersededBySourceRefs = sourceRefArray(value.supersededBySourceRefs);
  const supersedesSourceRefs = sourceRefArray(value.supersedesSourceRefs);
  if (supersededBySourceRefs.some((sourceRef) => supersedesSourceRefs.includes(sourceRef))) {
    return fail('Source retrieval supersession references conflict.');
  }
  return Object.freeze({
    authority: value.authority as SourceDocumentAuthority,
    evidenceKind: value.evidenceKind as SourceEvidenceKind,
    iterationGroup: nullableGroup(value.iterationGroup),
    lifecycle: value.lifecycle as SourceDocumentLifecycle,
    revisionOrdinal: value.revisionOrdinal,
    schemaVersion: SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
    supersededBySourceRefs,
    supersedesSourceRefs,
    topicGroup: nullableGroup(value.topicGroup),
  });
}

export function validateSourceRetrievalSupersessionGraph(
  sources: readonly SourceRetrievalSupersessionNodeV1[],
): void {
  const normalized = sources.map((source) => Object.freeze({
    ...(source.retrievalMeaning === undefined
      ? {}
      : { retrievalMeaning: source.retrievalMeaning }),
    sourceRef: validatePortableSourceRef(source.sourceRef),
  }));
  const byRef = new Map<string, SourceRetrievalSupersessionNodeV1[]>();
  for (const source of normalized) {
    const grouped = byRef.get(source.sourceRef) ?? [];
    grouped.push(source);
    byRef.set(source.sourceRef, grouped);
  }
  const edges = new Map<string, readonly string[]>();
  for (const source of normalized) {
    const supersedes = source.retrievalMeaning?.supersedesSourceRefs ?? [];
    const supersededBy = source.retrievalMeaning?.supersededBySourceRefs ?? [];
    if ([...supersedes, ...supersededBy].some((sourceRef) =>
      sourceRef === source.sourceRef || byRef.get(sourceRef)?.length !== 1) ||
        ((supersedes.length > 0 || supersededBy.length > 0) &&
          byRef.get(source.sourceRef)?.length !== 1)) {
      return fail('Source retrieval supersession graph is invalid.');
    }
    for (const targetRef of supersedes) {
      const targetMeaning = byRef.get(targetRef)?.[0]?.retrievalMeaning;
      if (targetMeaning === undefined ||
          !targetMeaning.supersededBySourceRefs.includes(source.sourceRef) ||
          source.retrievalMeaning === undefined ||
          source.retrievalMeaning.revisionOrdinal <= targetMeaning.revisionOrdinal) {
        return fail('Source retrieval supersession graph is invalid.');
      }
    }
    for (const replacementRef of supersededBy) {
      if (!byRef.get(replacementRef)?.[0]?.retrievalMeaning?.supersedesSourceRefs
        .includes(source.sourceRef)) {
        return fail('Source retrieval supersession graph is invalid.');
      }
    }
    if (supersededBy.length > 0 && source.retrievalMeaning !== undefined &&
        source.retrievalMeaning.lifecycle !== 'deprecated' &&
        source.retrievalMeaning.lifecycle !== 'superseded') {
      return fail('Source retrieval supersession graph is invalid.');
    }
    edges.set(source.sourceRef, supersedes);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (sourceRef: string): void => {
    if (visiting.has(sourceRef)) return fail('Source retrieval supersession graph is invalid.');
    if (visited.has(sourceRef)) return;
    visiting.add(sourceRef);
    for (const targetRef of edges.get(sourceRef) ?? []) visit(targetRef);
    visiting.delete(sourceRef);
    visited.add(sourceRef);
  };
  for (const sourceRef of [...edges.keys()].sort()) visit(sourceRef);
}

export function neutralSourceRetrievalMeaning(): SourceRetrievalMeaningV1 {
  return Object.freeze({
    authority: 'unknown',
    evidenceKind: 'other',
    iterationGroup: null,
    lifecycle: 'unknown',
    revisionOrdinal: 0,
    schemaVersion: SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
    supersededBySourceRefs: Object.freeze([]),
    supersedesSourceRefs: Object.freeze([]),
    topicGroup: null,
  });
}

export function sourceRetrievalMeaningFromDescriptor(
  descriptor: SourceDescriptorV1 | undefined,
): BoundSourceRetrievalMeaningV1 {
  const raw = descriptor?.metadata?.values.retrievalMeaning;
  if (raw === undefined) {
    return Object.freeze({
      meaning: neutralSourceRetrievalMeaning(),
      origin: 'legacy-default' as const,
    });
  }
  return Object.freeze({
    meaning: parseSourceRetrievalMeaning(raw),
    origin: descriptor?.adapterId === 'buildlore.p2a' ? 'adapter' : 'manifest',
  });
}

function validateMetadataValue(
  value: unknown,
  depth: number,
  state: { keys: number },
): unknown {
  if (depth > MAX_SOURCE_METADATA_DEPTH) {
    return fail('Source metadata exceeds its depth limit.');
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => validateMetadataValue(item, depth + 1, state)));
  }
  if (!isRecord(value)) return fail('Source metadata contains an unsupported value.');
  const result: Record<string, unknown> = {};
  const keys = Object.keys(value).sort();
  state.keys += keys.length;
  if (state.keys > MAX_SOURCE_METADATA_KEYS) {
    return fail('Source metadata exceeds its key limit.');
  }
  for (const key of keys) {
    if (
      key.length < 1 ||
      key.length > 128 ||
      key !== key.normalize('NFC') ||
      hasUnsafeCharacter(key)
    ) return fail('Source metadata key is invalid.');
    result[key] = validateMetadataValue(value[key], depth + 1, state);
  }
  return Object.freeze(result);
}

export function parseSourceMetadata(value: unknown): SourceMetadataV1 {
  if (!isRecord(value)) return fail('Source metadata is invalid.');
  exactKeys(value, ['namespace', 'schemaVersion', 'values']);
  const namespace = boundedIdentifier(value.namespace, ADAPTER_ID_PATTERN, 128);
  const schemaVersion = boundedIdentifier(value.schemaVersion, ADAPTER_ID_PATTERN, 128);
  if (!isRecord(value.values)) return fail('Source metadata values are invalid.');
  const state = { keys: 0 };
  const values = validateMetadataValue(value.values, 1, state);
  if (!isRecord(values)) return fail('Source metadata values are invalid.');
  if (values.retrievalMeaning !== undefined) {
    parseSourceRetrievalMeaning(values.retrievalMeaning);
  }
  const metadata = Object.freeze({ namespace, schemaVersion, values });
  if (Buffer.byteLength(serializeCanonicalJson(metadata), 'utf8') > MAX_SOURCE_METADATA_BYTES) {
    return fail('Source metadata exceeds its byte limit.');
  }
  return metadata;
}

export function parseRegisteredSourceKind(value: unknown): RegisteredSourceKind {
  if (typeof value !== 'string' || !REGISTERED_KINDS.has(value as RegisteredSourceKind)) {
    return fail('Source kind is unsupported.');
  }
  return value as RegisteredSourceKind;
}

export function parseRegisteredMediaType(value: unknown): RegisteredMediaType {
  if (typeof value !== 'string' || !MEDIA_TYPES.has(value as RegisteredMediaType)) {
    return fail('Source media type is unsupported.');
  }
  return value as RegisteredMediaType;
}

export function parseSourceDescriptor(value: unknown): SourceDescriptorV1 {
  if (!isRecord(value)) return fail('Source descriptor is invalid.');
  exactKeys(value, [
    'adapterId',
    'adapterVersion',
    'contentHash',
    'declarationId',
    'kind',
    'mediaType',
    'projectId',
    'schemaVersion',
    'sourceRef',
    'sourceRevision',
    'sourceUri',
  ], ['metadata']);
  if (value.schemaVersion !== SOURCE_DESCRIPTOR_SCHEMA_VERSION) {
    return fail('Source descriptor schema is unsupported.');
  }
  let projectId: string;
  try {
    projectId = validateProjectId(
      typeof value.projectId === 'string' ? value.projectId : '',
    );
  } catch {
    return fail('Source descriptor project is invalid.');
  }
  if (typeof value.sourceUri !== 'string' || !SAFE_SOURCE_URI_PATTERN.test(value.sourceUri)) {
    return fail('Source descriptor URI is invalid.');
  }
  return Object.freeze({
    adapterId: boundedIdentifier(value.adapterId, ADAPTER_ID_PATTERN, 128),
    adapterVersion: value.adapterVersion === SOURCE_ADAPTER_REGISTRATION_VERSION
      ? SOURCE_ADAPTER_REGISTRATION_VERSION
      : fail('Source adapter version is unsupported.'),
    contentHash: digest(value.contentHash),
    declarationId: boundedIdentifier(value.declarationId, DECLARATION_ID_PATTERN, 64),
    kind: parseRegisteredSourceKind(value.kind),
    mediaType: parseRegisteredMediaType(value.mediaType),
    ...(value.metadata === undefined ? {} : { metadata: parseSourceMetadata(value.metadata) }),
    projectId,
    schemaVersion: SOURCE_DESCRIPTOR_SCHEMA_VERSION,
    sourceRef: validatePortableSourceRef(value.sourceRef),
    sourceRevision: digest(value.sourceRevision),
    sourceUri: value.sourceUri,
  });
}

function parseKindRegistration(value: unknown): SourceAdapterKindRegistrationV1 {
  if (!isRecord(value)) return fail('Source adapter kind registration is invalid.');
  exactKeys(value, ['kind', 'mediaTypes']);
  if (!Array.isArray(value.mediaTypes) || value.mediaTypes.length < 1 || value.mediaTypes.length > 8) {
    return fail('Source adapter media types are invalid.');
  }
  const mediaTypes = value.mediaTypes.map(parseRegisteredMediaType).sort();
  if (new Set(mediaTypes).size !== mediaTypes.length) {
    return fail('Source adapter media types are duplicated.');
  }
  return Object.freeze({
    kind: parseRegisteredSourceKind(value.kind),
    mediaTypes: Object.freeze(mediaTypes),
  });
}

function parseAdapterLimits(value: unknown): SourceAdapterLimitsV1 {
  if (!isRecord(value)) return fail('Source adapter limits are invalid.');
  exactKeys(value, ['maxMetadataBytes', 'maxMetadataDepth', 'maxMetadataKeys']);
  if (
    value.maxMetadataBytes !== MAX_SOURCE_METADATA_BYTES ||
    value.maxMetadataDepth !== MAX_SOURCE_METADATA_DEPTH ||
    value.maxMetadataKeys !== MAX_SOURCE_METADATA_KEYS
  ) return fail('Source adapter limits are unsupported.');
  return Object.freeze({
    maxMetadataBytes: MAX_SOURCE_METADATA_BYTES,
    maxMetadataDepth: MAX_SOURCE_METADATA_DEPTH,
    maxMetadataKeys: MAX_SOURCE_METADATA_KEYS,
  });
}

export function parseSourceAdapterRegistration(value: unknown): SourceAdapterRegistrationV1 {
  if (!isRecord(value)) return fail('Source adapter registration is invalid.');
  exactKeys(value, [
    'adapterId',
    'adapterVersion',
    'kinds',
    'limits',
    'metadataNamespace',
    'metadataSchemaVersion',
  ]);
  if (value.adapterVersion !== SOURCE_ADAPTER_REGISTRATION_VERSION) {
    return fail('Source adapter version is unsupported.');
  }
  if (!Array.isArray(value.kinds) || value.kinds.length < 1 || value.kinds.length > 16) {
    return fail('Source adapter kinds are invalid.');
  }
  const kinds = value.kinds.map(parseKindRegistration)
    .sort((left, right) => left.kind.localeCompare(right.kind, 'en'));
  if (new Set(kinds.map((entry) => entry.kind)).size !== kinds.length) {
    return fail('Source adapter kinds are duplicated.');
  }
  return Object.freeze({
    adapterId: boundedIdentifier(value.adapterId, ADAPTER_ID_PATTERN, 128),
    adapterVersion: SOURCE_ADAPTER_REGISTRATION_VERSION,
    kinds: Object.freeze(kinds),
    limits: parseAdapterLimits(value.limits),
    metadataNamespace: boundedIdentifier(value.metadataNamespace, ADAPTER_ID_PATTERN, 128),
    metadataSchemaVersion: boundedIdentifier(
      value.metadataSchemaVersion,
      ADAPTER_ID_PATTERN,
      128,
    ),
  });
}

export function validateSourceOriginRange(value: unknown): SourceOriginRangeV1 {
  if (!isRecord(value)) return fail('Source range is invalid.');
  exactKeys(value, ['endColumn', 'endLine', 'startColumn', 'startLine']);
  for (const field of ['endColumn', 'endLine', 'startColumn', 'startLine'] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 1) {
      return fail('Source range is invalid.');
    }
  }
  const range = value as unknown as SourceOriginRangeV1;
  if (
    range.endLine < range.startLine ||
    (range.endLine === range.startLine && range.endColumn < range.startColumn)
  ) return fail('Source range is reversed.');
  return Object.freeze({ ...range });
}
