import { SourceDocumentError } from './errors.js';
import { sourceChunkIdentity } from './source-identity.js';
import { unicodeScalarLength } from './text-units.js';
import type { SourceChunk } from './types.js';

export function parseSourceChunk(value: unknown, body: string, source: string): SourceChunk {
  const fail = (): never => {
    throw new SourceDocumentError('SOURCE_DOCUMENT_INVALID', 'Source chunk metadata is invalid.');
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'parentSource', 'index', 'count', 'start', 'end',
    'totalChars', 'fullContentHash', 'payloadStart'];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)) ||
      record.schemaVersion !== 'buildlore.source-chunk.v1' ||
      typeof record.parentSource !== 'string' || record.parentSource.length > 4096 ||
      typeof record.fullContentHash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(record.fullContentHash)) return fail();
  for (const key of ['index', 'count', 'start', 'end', 'totalChars', 'payloadStart']) {
    if (typeof record[key] !== 'number' || !Number.isSafeInteger(record[key]) || record[key] < 0) return fail();
  }
  const chunk = record as unknown as SourceChunk;
  const scalars = Array.from(body);
  if (chunk.index < 1 || chunk.count < 2 || chunk.count > 4096 || chunk.index > chunk.count ||
      chunk.end <= chunk.start || chunk.end > chunk.totalChars || chunk.totalChars > 16 * 1024 * 1024 ||
      chunk.payloadStart + chunk.end - chunk.start > unicodeScalarLength(body) ||
      (chunk.payloadStart > 0 && scalars[chunk.payloadStart - 1] !== '\n') ||
      (scalars[chunk.payloadStart + chunk.end - chunk.start - 1] !== '\n' &&
        scalars[chunk.payloadStart + chunk.end - chunk.start] !== '\n') ||
      (chunk.index === 1 && chunk.start !== 0) ||
      (chunk.index === chunk.count && chunk.end !== chunk.totalChars)) return fail();
  try {
    if (sourceChunkIdentity(chunk.parentSource, chunk.index) !== source) return fail();
  } catch { return fail(); }
  return Object.freeze({ ...chunk });
}

export function sourceChunkPayload(body: string, chunk: SourceChunk): string {
  return Array.from(body).slice(chunk.payloadStart, chunk.payloadStart + chunk.end - chunk.start).join('');
}
