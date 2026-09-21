import { createHash } from 'node:crypto';

import { ProjectionError, SourceDocumentError } from './errors.js';
import type { ProjectSourceInput } from './project-source-writer.js';
import { sourceChunkPayload } from './source-chunk-contract.js';
import { normalizeSourceBody } from './source-document.js';
import { sourceChunkIdentity } from './source-identity.js';
import type { SourceRangeMappingV1 } from './source-contracts.js';
import { unicodeScalarLength } from './text-units.js';
import { MAX_SOURCE_BODY_CHARS, type SourceDocument } from './types.js';

// Reserve space for a continued fence, its closing fence, and terminal newline.
const PAYLOAD_UNITS = 80_000;
type Position = Readonly<{ line: number; column: number }>;
type Fence = Readonly<{ marker: string; opener: string }> | null;

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function advance(start: Position, text: string): Position {
  const lines = text.split('\n');
  return lines.length === 1
    ? { line: start.line, column: start.column + unicodeScalarLength(text) }
    : { line: start.line + lines.length - 1, column: unicodeScalarLength(lines.at(-1) ?? '') + 1 };
}

function compare(left: Position, right: Position): number {
  return left.line - right.line || left.column - right.column;
}

function clippedMappings(
  mappings: readonly SourceRangeMappingV1[], start: Position, end: Position, prefixLines: number,
): readonly SourceRangeMappingV1[] {
  const result: SourceRangeMappingV1[] = [];
  for (const mapping of mappings) {
    const a = { line: mapping.canonical.startLine, column: mapping.canonical.startColumn };
    const b = { line: mapping.canonical.endLine, column: mapping.canonical.endColumn };
    const from = compare(start, a) > 0 ? start : a;
    const to = compare(end, b) < 0 ? end : b;
    if (compare(from, to) >= 0) continue;
    const local = (point: Position): Position => ({
      line: point.line - start.line + prefixLines + 1,
      column: point.line === start.line ? point.column - start.column + 1 : point.column,
    });
    const original = (point: Position): Position => ({
      line: point.line + mapping.origin.startLine - mapping.canonical.startLine,
      column: point.line === a.line ? point.column + mapping.origin.startColumn - a.column
        : point.line === b.line ? point.column + mapping.origin.endColumn - b.column : point.column,
    });
    const range = (first: Position, last: Position): SourceRangeMappingV1['canonical'] => ({
      startLine: first.line, startColumn: first.column, endLine: last.line, endColumn: last.column,
    });
    result.push({ canonical: range(local(from), local(to)), origin: range(original(from), original(to)) });
  }
  return result;
}

function nextFence(line: string, current: Fence): Fence {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (match?.[1] === undefined || match[2] === undefined) return current;
  const marker = match[1];
  if (current !== null) {
    return marker[0] === current.marker[0] && marker.length >= current.marker.length && match[2].trim() === ''
      ? null : current;
  }
  // An arbitrarily long fence/info line remains literal payload. Never copy it
  // into a wrapper large enough to violate the upstream resource limit.
  if (marker.length > 1024 || line.length > 2048 ||
      (marker[0] === '`' && match[2].includes('`'))) return null;
  return { marker, opener: line };
}

function inspectWindow(text: string, initial: Fence, startsLine: boolean, completeLastLine = false): {
  fence: Fence; headings: number[]; paragraphs: number[]; lines: number[];
} {
  let fence = initial;
  let offset = 0;
  const headings: number[] = [], paragraphs: number[] = [], lines: number[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (index > 0 || startsLine) {
      if (fence === null && /^ {0,3}#{1,6}\s/u.test(line)) headings.push(offset);
      if (fence === null && line.trim() === '') paragraphs.push(offset);
      // Only complete lines can open/close a fence; a split long line cannot.
      if (offset + line.length < text.length || completeLastLine) fence = nextFence(line, fence);
    }
    offset += line.length + 1;
    if (offset <= text.length) lines.push(offset);
  }
  return { fence, headings, paragraphs, lines };
}

/** Pure partition plan. Persistence must use the whole security-approved candidate. */
export function splitProjectSource(input: ProjectSourceInput): readonly ProjectSourceInput[] {
  if (input.producer !== 'buildlore' || !['markdown', 'text', 'code'].includes(input.sourceKind)) return [input];
  const full = normalizeSourceBody(input.body);
  // Keep legacy identities and serialization for ordinary, bounded documents.
  if (full.length + 1 <= MAX_SOURCE_BODY_CHARS && Buffer.byteLength(full, 'utf8') < 256_000) return [input];
  if (input.descriptor?.schemaVersion !== 'buildlore.source-descriptor.v1' || input.originMappings === undefined) {
    throw new ProjectionError('PROJECTION_ARTIFACT_INVALID', 'Long source provenance is unavailable.');
  }
  const drafts: Array<{ body: string; payload: string; payloadStart: number; start: number;
    end: number; mappings: readonly SourceRangeMappingV1[] }> = [];
  let offset = 0, scalarOffset = 0;
  let position: Position = { line: 1, column: 1 };
  let fence: Fence = null;
  while (offset < full.length) {
    let end = Math.min(full.length, offset + PAYLOAD_UNITS);
    if (end < full.length && /[\uDC00-\uDFFF]/u.test(full[end] ?? '')) end -= 1;
    const window = full.slice(offset, end);
    if (end < full.length) {
      const boundaries = inspectWindow(window, fence, position.column === 1);
      const minimum = Math.floor(window.length / 2);
      const boundary = [boundaries.headings, boundaries.paragraphs, boundaries.lines]
        .map((values) => values.findLast((value) => value >= minimum))
        .find((value) => value !== undefined);
      if (boundary !== undefined) end = offset + boundary;
    }
    const payload = full.slice(offset, end);
    const after: Fence = inspectWindow(payload, fence, position.column === 1, end === full.length).fence;
    let prefix = fence === null ? '' : `${fence.opener}\n`;
    // Retain whitespace-only spans too; the label lies outside the payload.
    if (prefix === '' && payload.trim() === '') prefix = '<!-- source continuation -->\n';
    const suffix = after === null ? '' : `${payload.endsWith('\n') ? '' : '\n'}${after.marker}\n`;
    let body = `${prefix}${payload}${suffix}`;
    if (!body.endsWith('\n')) body += '\n';
    const next = advance(position, payload);
    // Mappings end on the last payload line, not a generated closing fence.
    const payloadEnd = payload.endsWith('\n')
      ? advance(position, payload.slice(0, -1)) : next;
    const length = unicodeScalarLength(payload);
    drafts.push({ body, payload, payloadStart: unicodeScalarLength(prefix), start: scalarOffset,
      end: scalarOffset + length,
      mappings: clippedMappings(input.originMappings, position, payloadEnd, prefix.split('\n').length - 1) });
    offset = end;
    scalarOffset += length;
    position = next;
    fence = after;
  }
  if (drafts.length < 2 || drafts.map((part) => part.payload).join('') !== full ||
      drafts.some((part) => part.body.length > MAX_SOURCE_BODY_CHARS)) {
    throw new ProjectionError('PROJECTION_ARTIFACT_INVALID', 'Source partitioning failed completeness validation.');
  }
  const fullContentHash = digest(full);
  return drafts.map((part, index) => {
    const sourceUri = sourceChunkIdentity(input.sourceUri, index + 1);
    return {
      ...input, body: part.body, descriptor: { ...input.descriptor!, sourceUri },
      originMappings: part.mappings, sourceUri,
      target: `${input.sourceKind}--${digest(sourceUri).slice(7)}.md`,
      chunk: { schemaVersion: 'buildlore.source-chunk.v1', parentSource: input.sourceUri,
        index: index + 1, count: drafts.length, start: part.start, end: part.end,
        totalChars: scalarOffset, fullContentHash, payloadStart: part.payloadStart },
    };
  });
}

/** A retryable partial sync must never masquerade as a complete source set. */
export function assertCompleteSourceChunks(documents: readonly SourceDocument[]): void {
  const groups = new Map<string, SourceDocument[]>();
  for (const document of documents) {
    const chunk = document.buildlore.chunk;
    if (chunk === undefined) continue;
    const group = groups.get(chunk.parentSource) ?? [];
    group.push(document);
    groups.set(chunk.parentSource, group);
  }
  for (const [parent, group] of groups) {
    group.sort((left, right) => left.buildlore.chunk!.index - right.buildlore.chunk!.index);
    const first = group[0]!;
    const metadata = first.buildlore.chunk!;
    let end = 0;
    const payloads: string[] = [];
    const invalid = (): never => {
      throw new SourceDocumentError('SOURCE_DOCUMENT_INVALID', 'Source chunks are incomplete or inconsistent; retry source sync.');
    };
    if (group.length !== metadata.count || documents.some((item) =>
      item.source === parent && item.buildlore.chunk === undefined)) invalid();
    for (const [index, document] of group.entries()) {
      const chunk = document.buildlore.chunk!;
      if (chunk.index !== index + 1 || chunk.count !== metadata.count || chunk.start !== end ||
          chunk.totalChars !== metadata.totalChars || chunk.fullContentHash !== metadata.fullContentHash ||
          document.buildlore.sourceRevision !== first.buildlore.sourceRevision ||
          document.buildlore.projectId !== first.buildlore.projectId ||
          document.buildlore.descriptor?.sourceRef !== first.buildlore.descriptor?.sourceRef ||
          document.ingestedAt !== first.ingestedAt) invalid();
      payloads.push(sourceChunkPayload(document.body, chunk));
      end = chunk.end;
    }
    if (end !== metadata.totalChars || digest(payloads.join('')) !== metadata.fullContentHash) invalid();
  }
}
