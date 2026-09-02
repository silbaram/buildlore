import { createHash } from 'node:crypto';

import { parseDocument } from 'yaml';

import { SourceDocumentError, type SourceDocumentErrorCode } from './errors.js';
import {
  parseSourceDescriptor,
  validateSourceOriginRange,
  type SourceDescriptorV1,
  type SourceRangeMappingV1,
} from './source-contracts.js';
import { normalizeRfc3339Instant } from './timestamp.js';
import { sliceUnicodeScalars, unicodeScalarLength } from './text-units.js';
import {
  MAX_SOURCE_BODY_CHARS,
  SOURCE_DOCUMENT_SCHEMA_VERSION,
  SOURCE_DOCUMENT_V2_SCHEMA_VERSION,
  type BuildLoreSourceMetadata,
  type CreateSourceDocumentInput,
  type SourceDocument,
  type SourceType,
} from './types.js';

const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_FRONTMATTER_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SOURCE_TYPES = new Set<SourceType>(['file', 'image', 'pdf', 'transcript', 'web']);

function invalid(code: SourceDocumentErrorCode, message: string): never {
  throw new SourceDocumentError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    return invalid('SOURCE_DOCUMENT_INVALID', `${label} must be an object.`);
  }
  return value;
}

function containsUnsafeCharacter(value: string, allowBodyLayout = false): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0 ||
      code === 127 ||
      (code >= 128 && code <= 159) ||
      (code < 32 && (!allowBodyLayout || (code !== 9 && code !== 10)))
    ) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireString(
  value: unknown,
  label: string,
  options: { readonly max: number; readonly identifier?: boolean },
): string {
  if (
    typeof value !== 'string' ||
    unicodeScalarLength(value) < 1 ||
    unicodeScalarLength(value) > options.max ||
    containsUnsafeCharacter(value) ||
    (options.identifier === true && !IDENTIFIER_PATTERN.test(value))
  ) {
    return invalid('SOURCE_DOCUMENT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid('SOURCE_DOCUMENT_INVALID', `${label} must be a SHA-256 digest.`);
  }
  return value as `sha256:${string}`;
}

function requireTimestamp(value: unknown): string {
  const normalized = normalizeRfc3339Instant(value);
  if (normalized === null) {
    return invalid('SOURCE_DOCUMENT_INVALID', 'ingestedAt must be an RFC 3339 instant.');
  }
  return normalized;
}

function requireExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid('SOURCE_DOCUMENT_INVALID', 'buildlore metadata contains unsupported fields.');
  }
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function normalizeSourceBody(value: string): string {
  const normalized = value.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
  if (containsUnsafeCharacter(normalized, true)) {
    return invalid('SOURCE_BODY_INVALID', 'Source body contains an unsafe character.');
  }
  if (normalized.trim().length === 0) {
    return invalid('SOURCE_BODY_INVALID', 'Source body must contain readable content.');
  }
  return normalized;
}

function canonicalBody(value: string): {
  readonly body: string;
  readonly originalChars: number;
  readonly truncated: boolean;
} {
  const payload = normalizeSourceBody(value);
  const originalChars = unicodeScalarLength(payload);
  if (originalChars <= MAX_SOURCE_BODY_CHARS) {
    return { body: `${payload}\n`, originalChars, truncated: false };
  }
  const utf8Stable = sliceUnicodeScalars(payload, MAX_SOURCE_BODY_CHARS)
    .replace(/\n+$/u, '');
  return { body: `${utf8Stable}\n`, originalChars, truncated: true };
}

function sourceType(value: unknown): SourceType | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SOURCE_TYPES.has(value as SourceType)) {
    return invalid('SOURCE_DOCUMENT_INVALID', 'sourceType is unsupported.');
  }
  return value as SourceType;
}

function parseRangeMappings(value: unknown): readonly SourceRangeMappingV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    return invalid('SOURCE_DOCUMENT_INVALID', 'Source origin mappings are invalid.');
  }
  let previousEndLine = 0;
  const mappings = value.map((entry) => {
    if (!isRecord(entry)) {
      return invalid('SOURCE_DOCUMENT_INVALID', 'Source origin mapping is invalid.');
    }
    requireExactKeys(entry, ['canonical', 'origin']);
    let canonical;
    let origin;
    try {
      canonical = validateSourceOriginRange(entry.canonical);
      origin = validateSourceOriginRange(entry.origin);
    } catch {
      return invalid('SOURCE_DOCUMENT_INVALID', 'Source origin mapping is invalid.');
    }
    if (canonical.startLine <= previousEndLine ||
        canonical.endLine - canonical.startLine !== origin.endLine - origin.startLine) {
      return invalid('SOURCE_DOCUMENT_INVALID', 'Source origin mappings are inconsistent.');
    }
    previousEndLine = canonical.endLine;
    return Object.freeze({ canonical, origin });
  });
  return Object.freeze(mappings);
}

function bodyEnd(body: string): SourceRangeMappingV1['canonical'] {
  const payload = body.endsWith('\n') ? body.slice(0, -1) : body;
  const lines = payload.split('\n');
  return Object.freeze({
    endColumn: unicodeScalarLength(lines.at(-1) ?? '') + 1,
    endLine: lines.length,
    startColumn: 1,
    startLine: 1,
  });
}

function positionAfter(
  line: number,
  column: number,
  boundaryLine: number,
  boundaryColumn: number,
): boolean {
  return line > boundaryLine || (line === boundaryLine && column > boundaryColumn);
}

function assertRangeMappingsWithinBody(
  mappings: readonly SourceRangeMappingV1[],
  body: string,
): readonly SourceRangeMappingV1[] {
  const boundary = bodyEnd(body);
  if (mappings.some((mapping) =>
    positionAfter(
      mapping.canonical.startLine,
      mapping.canonical.startColumn,
      boundary.endLine,
      boundary.endColumn,
    ) || positionAfter(
      mapping.canonical.endLine,
      mapping.canonical.endColumn,
      boundary.endLine,
      boundary.endColumn,
    ))) {
    return invalid('SOURCE_DOCUMENT_INVALID', 'Source origin mappings exceed the canonical body.');
  }
  return mappings;
}

function fitRangeMappings(
  value: readonly SourceRangeMappingV1[],
  body: string,
  truncated: boolean,
): readonly SourceRangeMappingV1[] {
  const mappings = parseRangeMappings(value);
  const boundary = bodyEnd(body);
  const result: SourceRangeMappingV1[] = [];
  for (const mapping of mappings) {
    if (positionAfter(
      mapping.canonical.startLine,
      mapping.canonical.startColumn,
      boundary.endLine,
      boundary.endColumn,
    )) {
      if (!truncated) {
        return invalid('SOURCE_DOCUMENT_INVALID', 'Source origin mappings exceed the canonical body.');
      }
      break;
    }
    if (!positionAfter(
      mapping.canonical.endLine,
      mapping.canonical.endColumn,
      boundary.endLine,
      boundary.endColumn,
    )) {
      result.push(mapping);
      continue;
    }
    if (!truncated && mapping.canonical.endLine > boundary.endLine) {
      return invalid('SOURCE_DOCUMENT_INVALID', 'Source origin mappings exceed the canonical body.');
    }
    const endLineDelta = boundary.endLine - mapping.canonical.startLine;
    const originEndColumn = truncated
      ? boundary.endLine === mapping.canonical.endLine
        ? mapping.origin.endColumn + boundary.endColumn - mapping.canonical.endColumn
        : boundary.endColumn
      : mapping.origin.endColumn;
    result.push(Object.freeze({
      canonical: Object.freeze({
        ...mapping.canonical,
        endColumn: boundary.endColumn,
        endLine: boundary.endLine,
      }),
      origin: Object.freeze({
        ...mapping.origin,
        endColumn: originEndColumn,
        endLine: mapping.origin.startLine + endLineDelta,
      }),
    }));
    break;
  }
  if (result.length < 1) {
    return invalid('SOURCE_DOCUMENT_INVALID', 'Source origin mappings do not cover the canonical body.');
  }
  return Object.freeze(result);
}

function parseBuildLore(
  value: unknown,
  body: string,
  schemaVersion: SourceDocument['schemaVersion'],
): BuildLoreSourceMetadata {
  const record = requireRecord(value, 'buildlore');
  const commonKeys = [
    'contentHash', 'producer', 'projectId', 'schemaVersion', 'sourceKind', 'sourceRevision',
  ];
  requireExactKeys(record, schemaVersion === SOURCE_DOCUMENT_V2_SCHEMA_VERSION
    ? [...commonKeys, 'descriptor', 'originMappings']
    : commonKeys);
  if (record.schemaVersion !== schemaVersion) {
    return invalid('SOURCE_SCHEMA_UNSUPPORTED', 'SourceDocument schema is unsupported.');
  }
  const contentHash = requireDigest(record.contentHash, 'contentHash');
  if (contentHash !== sha256(body)) {
    return invalid('SOURCE_DOCUMENT_INVALID', 'Source body hash does not match metadata.');
  }
  let descriptor: SourceDescriptorV1 | undefined;
  let originMappings: readonly SourceRangeMappingV1[] | undefined;
  if (schemaVersion === SOURCE_DOCUMENT_V2_SCHEMA_VERSION) {
    try {
      descriptor = parseSourceDescriptor(record.descriptor);
    } catch {
      return invalid('SOURCE_DOCUMENT_INVALID', 'Source descriptor is invalid.');
    }
    originMappings = assertRangeMappingsWithinBody(
      parseRangeMappings(record.originMappings),
      body,
    );
  }
  return {
    contentHash,
    ...(descriptor === undefined ? {} : { descriptor }),
    ...(originMappings === undefined ? {} : { originMappings }),
    producer: requireString(record.producer, 'producer', { identifier: true, max: 64 }),
    projectId: requireString(record.projectId, 'projectId', { identifier: true, max: 64 }),
    schemaVersion,
    sourceKind: requireString(record.sourceKind, 'sourceKind', { identifier: true, max: 64 }),
    sourceRevision: requireDigest(record.sourceRevision, 'sourceRevision'),
  };
}

function validateTruncation(
  record: Readonly<Record<string, unknown>>,
  payloadLength: number,
): { readonly originalChars?: number; readonly truncated?: true } {
  const hasTruncated = Object.hasOwn(record, 'truncated');
  const hasOriginalChars = Object.hasOwn(record, 'originalChars');
  if (hasTruncated !== hasOriginalChars) {
    return invalid('SOURCE_DOCUMENT_INVALID', 'truncated and originalChars must appear together.');
  }
  if (!hasTruncated) {
    if (payloadLength > MAX_SOURCE_BODY_CHARS) {
      return invalid('SOURCE_DOCUMENT_INVALID', 'Source body exceeds the character limit.');
    }
    return {};
  }
  if (
    record.truncated !== true ||
    typeof record.originalChars !== 'number' ||
    !Number.isSafeInteger(record.originalChars) ||
    record.originalChars <= MAX_SOURCE_BODY_CHARS ||
    payloadLength !== MAX_SOURCE_BODY_CHARS
  ) {
    return invalid('SOURCE_DOCUMENT_INVALID', 'Source truncation metadata is invalid.');
  }
  return { originalChars: record.originalChars, truncated: true };
}

export function validateSourceDocument(value: unknown): SourceDocument {
  const record = requireRecord(value, 'SourceDocument');
  if (
    record.schemaVersion !== SOURCE_DOCUMENT_SCHEMA_VERSION &&
    record.schemaVersion !== SOURCE_DOCUMENT_V2_SCHEMA_VERSION
  ) {
    return invalid('SOURCE_SCHEMA_UNSUPPORTED', 'SourceDocument schema is unsupported.');
  }
  const schemaVersion = record.schemaVersion;
  const body = typeof record.body === 'string' ? record.body : '';
  if (
    unicodeScalarLength(body) < 2 ||
    body.includes('\r') ||
    !body.endsWith('\n') ||
    body.endsWith('\n\n') ||
    containsUnsafeCharacter(body, true) ||
    body.trim().length === 0
  ) {
    return invalid('SOURCE_BODY_INVALID', 'Source body is not canonical.');
  }
  const truncation = validateTruncation(record, unicodeScalarLength(body.slice(0, -1)));
  const parsedSourceType = sourceType(record.sourceType);
  const source = requireString(record.source, 'source', { max: 4096 });
  const buildlore = parseBuildLore(record.buildlore, body, schemaVersion);
  if (schemaVersion === SOURCE_DOCUMENT_V2_SCHEMA_VERSION) {
    const descriptor = buildlore.descriptor;
    if (
      descriptor === undefined ||
      descriptor.projectId !== buildlore.projectId ||
      descriptor.sourceUri !== source ||
      descriptor.sourceRevision !== buildlore.sourceRevision ||
      descriptor.kind !== buildlore.sourceKind
    ) return invalid('SOURCE_DOCUMENT_INVALID', 'Source descriptor binding is invalid.');
  }
  return {
    body,
    buildlore,
    ingestedAt: requireTimestamp(record.ingestedAt),
    ...(truncation.originalChars === undefined ? {} : { originalChars: truncation.originalChars }),
    schemaVersion,
    source,
    ...(parsedSourceType === undefined ? {} : { sourceType: parsedSourceType }),
    title: requireString(record.title, 'title', { max: 500 }),
    ...(truncation.truncated === undefined ? {} : { truncated: truncation.truncated }),
  };
}

export function createSourceDocument(input: CreateSourceDocumentInput): SourceDocument {
  const canonical = canonicalBody(input.body);
  let descriptor: SourceDescriptorV1 | undefined;
  if (input.descriptor !== undefined) {
    try {
      descriptor = parseSourceDescriptor(input.descriptor);
    } catch {
      return invalid('SOURCE_DOCUMENT_INVALID', 'Source descriptor is invalid.');
    }
  }
  const schemaVersion = descriptor === undefined
    ? SOURCE_DOCUMENT_SCHEMA_VERSION
    : SOURCE_DOCUMENT_V2_SCHEMA_VERSION;
  const originMappings = input.originMappings === undefined
    ? undefined
    : fitRangeMappings(input.originMappings, canonical.body, canonical.truncated);
  if (
    descriptor !== undefined && (
      descriptor.projectId !== input.projectId ||
      descriptor.sourceUri !== input.source ||
      descriptor.sourceRevision !== input.sourceRevision ||
      descriptor.kind !== input.sourceKind ||
      originMappings === undefined
    )
  ) return invalid('SOURCE_DOCUMENT_INVALID', 'Source descriptor binding is invalid.');
  return validateSourceDocument({
    body: canonical.body,
    buildlore: {
      contentHash: sha256(canonical.body),
      producer: input.producer,
      projectId: input.projectId,
      ...(descriptor === undefined ? {} : { descriptor }),
      ...(originMappings === undefined ? {} : { originMappings }),
      schemaVersion,
      sourceKind: input.sourceKind,
      sourceRevision: input.sourceRevision,
    },
    ingestedAt: input.ingestedAt,
    ...(canonical.truncated ? { originalChars: canonical.originalChars } : {}),
    schemaVersion,
    source: input.source,
    ...(input.sourceType === undefined ? {} : { sourceType: input.sourceType }),
    title: input.title,
    ...(canonical.truncated ? { truncated: true } : {}),
  });
}

function quoted(value: string): string {
  return JSON.stringify(value)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function renderSourceDocument(value: SourceDocument): string {
  const document = validateSourceDocument(value);
  const lines = [
    '---',
    `title: ${quoted(document.title)}`,
    `source: ${quoted(document.source)}`,
    `ingestedAt: ${quoted(document.ingestedAt)}`,
  ];
  if (document.sourceType !== undefined) lines.push(`sourceType: ${quoted(document.sourceType)}`);
  if (document.truncated === true) {
    lines.push('truncated: true', `originalChars: ${String(document.originalChars)}`);
  }
  lines.push(
    'buildlore:',
    `  schemaVersion: ${quoted(document.buildlore.schemaVersion)}`,
    `  sourceKind: ${quoted(document.buildlore.sourceKind)}`,
    `  producer: ${quoted(document.buildlore.producer)}`,
    `  projectId: ${quoted(document.buildlore.projectId)}`,
    `  sourceRevision: ${quoted(document.buildlore.sourceRevision)}`,
    `  contentHash: ${quoted(document.buildlore.contentHash)}`,
  );
  if (document.schemaVersion === SOURCE_DOCUMENT_V2_SCHEMA_VERSION) {
    lines.push(
      `  descriptor: ${JSON.stringify(document.buildlore.descriptor)}`,
      `  originMappings: ${JSON.stringify(document.buildlore.originMappings)}`,
    );
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${document.body}`;
}

export function parseSourceDocument(markdown: string): SourceDocument {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_DOCUMENT_BYTES) {
    return invalid('SOURCE_DOCUMENT_TOO_LARGE', 'SourceDocument exceeds the byte limit.');
  }
  const normalized = markdown.replace(/\r\n?/gu, '\n');
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]+)$/u.exec(normalized);
  if (match?.[1] === undefined || match[2] === undefined) {
    return invalid('SOURCE_FRONTMATTER_INVALID', 'SourceDocument frontmatter is missing or malformed.');
  }
  if (Buffer.byteLength(match[1], 'utf8') > MAX_FRONTMATTER_BYTES) {
    return invalid('SOURCE_DOCUMENT_TOO_LARGE', 'SourceDocument frontmatter exceeds the byte limit.');
  }
  const parsed = parseDocument(match[1], {
    logLevel: 'silent',
    schema: 'json',
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  });
  if (parsed.errors.length > 0 || parsed.warnings.length > 0) {
    return invalid('SOURCE_FRONTMATTER_INVALID', 'SourceDocument frontmatter is invalid.');
  }
  let metadata: unknown;
  try {
    metadata = parsed.toJS({ maxAliasCount: 0 });
  } catch {
    return invalid('SOURCE_FRONTMATTER_INVALID', 'SourceDocument frontmatter is invalid.');
  }
  const record = requireRecord(metadata, 'SourceDocument frontmatter');
  const schemaVersion = record.buildlore !== undefined && isRecord(record.buildlore)
    ? record.buildlore.schemaVersion
    : undefined;
  return validateSourceDocument({
    body: match[2],
    buildlore: record.buildlore,
    ingestedAt: record.ingestedAt,
    ...(Object.hasOwn(record, 'originalChars') ? { originalChars: record.originalChars } : {}),
    schemaVersion,
    source: record.source,
    ...(Object.hasOwn(record, 'sourceType') ? { sourceType: record.sourceType } : {}),
    title: record.title,
    ...(Object.hasOwn(record, 'truncated') ? { truncated: record.truncated } : {}),
  });
}
