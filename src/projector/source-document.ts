import { createHash } from 'node:crypto';

import { parseDocument } from 'yaml';

import { SourceDocumentError, type SourceDocumentErrorCode } from './errors.js';
import { normalizeRfc3339Instant } from './timestamp.js';
import {
  MAX_SOURCE_BODY_CHARS,
  SOURCE_DOCUMENT_SCHEMA_VERSION,
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
      if (next < 0xdc00 || next > 0xdfff) return true;
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
    value.length < 1 ||
    value.length > options.max ||
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
  const originalChars = payload.length;
  if (originalChars <= MAX_SOURCE_BODY_CHARS) {
    return { body: `${payload}\n`, originalChars, truncated: false };
  }
  const sliced = payload.slice(0, MAX_SOURCE_BODY_CHARS);
  const utf8Stable = Buffer.from(sliced, 'utf8').toString('utf8').replace(/\n+$/u, '');
  return { body: `${utf8Stable}\n`, originalChars, truncated: true };
}

function sourceType(value: unknown): SourceType | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SOURCE_TYPES.has(value as SourceType)) {
    return invalid('SOURCE_DOCUMENT_INVALID', 'sourceType is unsupported.');
  }
  return value as SourceType;
}

function parseBuildLore(value: unknown, body: string): BuildLoreSourceMetadata {
  const record = requireRecord(value, 'buildlore');
  requireExactKeys(record, [
    'contentHash',
    'producer',
    'projectId',
    'schemaVersion',
    'sourceKind',
    'sourceRevision',
  ]);
  if (record.schemaVersion !== SOURCE_DOCUMENT_SCHEMA_VERSION) {
    return invalid('SOURCE_SCHEMA_UNSUPPORTED', 'SourceDocument schema is unsupported.');
  }
  const contentHash = requireDigest(record.contentHash, 'contentHash');
  if (contentHash !== sha256(body)) {
    return invalid('SOURCE_DOCUMENT_INVALID', 'Source body hash does not match metadata.');
  }
  return {
    contentHash,
    producer: requireString(record.producer, 'producer', { identifier: true, max: 64 }),
    projectId: requireString(record.projectId, 'projectId', { identifier: true, max: 64 }),
    schemaVersion: SOURCE_DOCUMENT_SCHEMA_VERSION,
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
  if (record.schemaVersion !== SOURCE_DOCUMENT_SCHEMA_VERSION) {
    return invalid('SOURCE_SCHEMA_UNSUPPORTED', 'SourceDocument schema is unsupported.');
  }
  const body = typeof record.body === 'string' ? record.body : '';
  if (
    body.length < 2 ||
    body.includes('\r') ||
    !body.endsWith('\n') ||
    body.endsWith('\n\n') ||
    containsUnsafeCharacter(body, true) ||
    body.trim().length === 0
  ) {
    return invalid('SOURCE_BODY_INVALID', 'Source body is not canonical.');
  }
  const truncation = validateTruncation(record, body.slice(0, -1).length);
  const parsedSourceType = sourceType(record.sourceType);
  return {
    body,
    buildlore: parseBuildLore(record.buildlore, body),
    ingestedAt: requireTimestamp(record.ingestedAt),
    ...(truncation.originalChars === undefined ? {} : { originalChars: truncation.originalChars }),
    schemaVersion: SOURCE_DOCUMENT_SCHEMA_VERSION,
    source: requireString(record.source, 'source', { max: 4096 }),
    ...(parsedSourceType === undefined ? {} : { sourceType: parsedSourceType }),
    title: requireString(record.title, 'title', { max: 500 }),
    ...(truncation.truncated === undefined ? {} : { truncated: truncation.truncated }),
  };
}

export function createSourceDocument(input: CreateSourceDocumentInput): SourceDocument {
  const canonical = canonicalBody(input.body);
  return validateSourceDocument({
    body: canonical.body,
    buildlore: {
      contentHash: sha256(canonical.body),
      producer: input.producer,
      projectId: input.projectId,
      schemaVersion: SOURCE_DOCUMENT_SCHEMA_VERSION,
      sourceKind: input.sourceKind,
      sourceRevision: input.sourceRevision,
    },
    ingestedAt: input.ingestedAt,
    ...(canonical.truncated ? { originalChars: canonical.originalChars } : {}),
    schemaVersion: SOURCE_DOCUMENT_SCHEMA_VERSION,
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
    '---',
    '',
  );
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
  return validateSourceDocument({
    body: match[2],
    buildlore: record.buildlore,
    ingestedAt: record.ingestedAt,
    ...(Object.hasOwn(record, 'originalChars') ? { originalChars: record.originalChars } : {}),
    schemaVersion: SOURCE_DOCUMENT_SCHEMA_VERSION,
    source: record.source,
    ...(Object.hasOwn(record, 'sourceType') ? { sourceType: record.sourceType } : {}),
    title: record.title,
    ...(Object.hasOwn(record, 'truncated') ? { truncated: record.truncated } : {}),
  });
}
