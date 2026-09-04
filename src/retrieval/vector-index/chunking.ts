import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import {
  SEMANTIC_CONTENT_POLICY_DIGEST,
  createApprovedWikiRetrieval,
  projectApprovedWikiSemanticText,
} from '../hierarchical.js';
import type {
  ApprovedWikiCitationLocatorV1,
  ApprovedWikiRetrievalCorpusV1,
} from '../hierarchical.js';
import {
  RETRIEVAL_CHUNK_SCHEMA_VERSION,
  SEMANTIC_INDEX_LIMITS,
  SemanticIndexError,
  type RetrievalChunkMaterialV1,
  type RetrievalChunkingResultV1,
  type RetrievalStructureKind,
  type SemanticChunkerIdentityV1,
  type SemanticIndexSha256Digest,
  type SkippedRetrievalChunkV1,
} from './types.js';

interface MarkdownBlock {
  readonly kind: RetrievalStructureKind;
  readonly text: string;
}

export type DocumentTokenCounter = (
  texts: readonly string[],
) => Promise<readonly number[]>;

const CHUNKER_BASIS = Object.freeze({
  contractVersion: 2 as const,
  kind: 'markdown-semantic-text-token-aware' as const,
  maximumPlanningUtf8Bytes: SEMANTIC_INDEX_LIMITS.maximumChunkUtf8Bytes,
  maximumTokens: 512 as const,
  preserves: Object.freeze([
    'heading',
    'paragraph',
    'list',
    'table',
    'fenced-code',
  ] as const),
  semanticContentPolicyDigest: SEMANTIC_CONTENT_POLICY_DIGEST,
  unicodeBoundary: 'unicode-cluster-safe-v1' as const,
});

function digest(value: string): SemanticIndexSha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function digestValue(value: unknown): SemanticIndexSha256Digest {
  return digest(serializeCanonicalJson(value));
}

export const SEMANTIC_CHUNKER_IDENTITY: SemanticChunkerIdentityV1 = Object.freeze({
  ...CHUNKER_BASIS,
  identityDigest: digestValue(CHUNKER_BASIS),
});

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lineKind(line: string): RetrievalStructureKind {
  if (/^ {0,3}#{1,6}(?:\s+|$)/u.test(line)) return 'heading';
  if (/^\s*(?:[-+*]|\d+[.)])\s+/u.test(line)) return 'list';
  if (/^\s*\|.*\|\s*$/u.test(line)) return 'table';
  return 'paragraph';
}

function fenceStart(line: string): Readonly<{
  readonly character: '`' | '~';
  readonly length: number;
}> | null {
  const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
  if (marker === undefined) return null;
  return Object.freeze({
    character: marker[0] as '`' | '~',
    length: marker.length,
  });
}

function closesFence(
  line: string,
  fence: Readonly<{ readonly character: '`' | '~'; readonly length: number }>,
): boolean {
  const marker = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line)?.[1];
  return marker !== undefined && marker[0] === fence.character && marker.length >= fence.length;
}

function* iterateMarkdownStructures(body: string): Generator<MarkdownBlock> {
  const lines = body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const current = lines[index];
    if (current === undefined) break;
    if (current.trim() === '') {
      index += 1;
      continue;
    }
    const openedFence = fenceStart(current);
    if (openedFence !== null) {
      const collected = [current];
      index += 1;
      while (index < lines.length) {
        const line = lines[index];
        if (line === undefined) break;
        collected.push(line);
        index += 1;
        if (closesFence(line, openedFence)) break;
      }
      yield Object.freeze({ kind: 'fenced-code', text: collected.join('\n').trimEnd() });
      continue;
    }
    const kind = lineKind(current);
    if (kind === 'heading') {
      yield Object.freeze({ kind, text: current.trimEnd() });
      index += 1;
      continue;
    }
    const collected = [current];
    index += 1;
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined || line.trim() === '' || fenceStart(line) !== null) break;
      const nextKind = lineKind(line);
      if (nextKind === 'heading' || nextKind !== kind) break;
      collected.push(line);
      index += 1;
    }
    yield Object.freeze({ kind, text: collected.join('\n').trim() });
  }
}

export function splitMarkdownStructures(body: string): readonly MarkdownBlock[] {
  return Object.freeze([...iterateMarkdownStructures(body)]);
}

function citationLocatorsForStructure(
  text: string,
  values: readonly ApprovedWikiCitationLocatorV1[],
  structureKind: RetrievalStructureKind,
): readonly ApprovedWikiCitationLocatorV1[] {
  const byId = new Map(values.map((value) => [value.citationId, value]));
  const selected = new Map<string, ApprovedWikiCitationLocatorV1>();
  if (structureKind !== 'fenced-code') {
    const marker = /(?<!\\)\[\^(citation-[a-z0-9]+(?:-[a-z0-9]+)*)\]/gu;
    for (const match of text.matchAll(marker)) {
      const citationId = match[1];
      const locator = citationId === undefined ? undefined : byId.get(citationId);
      if (locator === undefined) {
        throw new SemanticIndexError('SEMANTIC_INDEX_CONFIG_INVALID', 'artifact-invalid');
      }
      selected.set(`${locator.citationId}\u0000${locator.sourceId}`, locator);
    }
  }
  // Headings, fenced examples, and other uncited structures inherit their approved
  // section locators so every semantic hit remains provenance-expandable.
  if (selected.size === 0) {
    for (const locator of values) {
      selected.set(`${locator.citationId}\u0000${locator.sourceId}`, locator);
    }
  }
  return Object.freeze([...selected.values()].sort((left, right) =>
    compareText(left.citationId, right.citationId) || compareText(left.sourceId, right.sourceId))
    .map((value) => Object.freeze({ ...value })));
}

function semanticCitationQueues(
  body: string,
  values: readonly ApprovedWikiCitationLocatorV1[],
): ReadonlyMap<string, readonly (readonly ApprovedWikiCitationLocatorV1[])[]> {
  const collected = new Map<string, Array<readonly ApprovedWikiCitationLocatorV1[]>>();
  for (const rawBlock of iterateMarkdownStructures(body)) {
    const semantic = projectApprovedWikiSemanticText(rawBlock.text, '').semanticText;
    if (semantic === '') continue;
    const citations = citationLocatorsForStructure(rawBlock.text, values, rawBlock.kind);
    for (const projectedBlock of iterateMarkdownStructures(semantic)) {
      const key = `${projectedBlock.kind}\u0000${projectedBlock.text.normalize('NFC')}`;
      const queue = collected.get(key) ?? [];
      queue.push(citations);
      collected.set(key, queue);
    }
  }
  return new Map([...collected.entries()].map(([key, queue]) => [
    key,
    Object.freeze(queue),
  ]));
}

function scalarWidth(value: number): 1 | 2 {
  return value > 0xffff ? 2 : 1;
}

function hangulClass(value: number): 'l' | 'lv' | 'lvt' | 't' | 'v' | null {
  if ((value >= 0x1100 && value <= 0x115f) || (value >= 0xa960 && value <= 0xa97c)) return 'l';
  if ((value >= 0x1160 && value <= 0x11a7) || (value >= 0xd7b0 && value <= 0xd7c6)) return 'v';
  if ((value >= 0x11a8 && value <= 0x11ff) || (value >= 0xd7cb && value <= 0xd7fb)) return 't';
  if (value >= 0xac00 && value <= 0xd7a3) return (value - 0xac00) % 28 === 0 ? 'lv' : 'lvt';
  return null;
}

function isGraphemeExtension(value: number, scalar: string): boolean {
  return /^\p{M}$/u.test(scalar) || value === 0x200c ||
    (value >= 0xfe00 && value <= 0xfe0f) ||
    (value >= 0xe0100 && value <= 0xe01ef) ||
    (value >= 0x1f3fb && value <= 0x1f3ff) ||
    (value >= 0xe0020 && value <= 0xe007f);
}

/** Deterministic cluster boundary covering combining, emoji-ZWJ, RI, and Hangul sequences. */
function nextGraphemeBoundary(text: string, start: number): number {
  const first = text.codePointAt(start);
  if (first === undefined) return text.length;
  let index = start + scalarWidth(first);
  let previous = first;
  let regionalCount = first >= 0x1f1e6 && first <= 0x1f1ff ? 1 : 0;
  if (first === 0x0d && text.codePointAt(index) === 0x0a) return index + 1;
  while (index < text.length) {
    const next = text.codePointAt(index);
    if (next === undefined) break;
    const scalar = String.fromCodePoint(next);
    const previousHangul = hangulClass(previous);
    const nextHangul = hangulClass(next);
    const joinsHangul = previousHangul === 'l' &&
      (nextHangul === 'l' || nextHangul === 'v' || nextHangul === 'lv' || nextHangul === 'lvt') ||
      (previousHangul === 'lv' || previousHangul === 'v') &&
        (nextHangul === 'v' || nextHangul === 't') ||
      (previousHangul === 'lvt' || previousHangul === 't') && nextHangul === 't';
    const regional = next >= 0x1f1e6 && next <= 0x1f1ff;
    if (isGraphemeExtension(next, scalar) || previous === 0x200d || next === 0x200d ||
        joinsHangul || (regional && regionalCount % 2 === 1)) {
      index += scalarWidth(next);
      previous = next;
      regionalCount = regional ? regionalCount + 1 : 0;
      continue;
    }
    break;
  }
  return index;
}

function splitAtGraphemeBoundary(text: string): readonly [string, string] | null {
  const midpoint = Math.floor(text.length / 2);
  const earliestWhitespace = Math.floor(text.length / 4);
  for (let index = midpoint; index >= earliestWhitespace; index -= 1) {
    if (/\s/u.test(text[index] ?? '')) {
      const left = text.slice(0, index + 1).trim();
      const right = text.slice(index + 1).trim();
      if (left !== '' && right !== '') return Object.freeze([left, right]);
    }
  }
  let previous = 0;
  let boundary = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const next = nextGraphemeBoundary(text, cursor);
    if (next >= midpoint) {
      boundary = midpoint - cursor <= next - midpoint ? cursor : next;
      break;
    }
    previous = cursor;
    cursor = next;
  }
  if (boundary === 0 && previous > 0) boundary = previous;
  if (boundary <= 0 || boundary >= text.length) return null;
  const left = text.slice(0, boundary).trim();
  const right = text.slice(boundary).trim();
  return left === '' || right === '' ? null : Object.freeze([left, right]);
}

function splitToPlanningBound(text: string): readonly string[] {
  const result: string[] = [];
  const pending = [text];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (Buffer.byteLength(current, 'utf8') <= SEMANTIC_INDEX_LIMITS.maximumChunkUtf8Bytes) {
      result.push(current);
      continue;
    }
    const halves = splitAtGraphemeBoundary(current);
    if (halves === null) return Object.freeze([]);
    pending.push(halves[1], halves[0]);
  }
  return Object.freeze(result);
}

async function splitToTokenBound(
  text: string,
  countTokens: DocumentTokenCounter,
): Promise<readonly Readonly<{ readonly text: string; readonly tokenCount: number }>[]> {
  const result: Array<Readonly<{ readonly text: string; readonly tokenCount: number }>> = [];
  const pending = [text];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const counts = await countTokens(Object.freeze([current]));
    const tokenCount = counts[0];
    if (counts.length !== 1 || tokenCount === undefined ||
        !Number.isSafeInteger(tokenCount) || tokenCount < 1) {
      throw new SemanticIndexError('SEMANTIC_INDEX_INCOMPATIBLE', 'identity-mismatch');
    }
    if (tokenCount <= SEMANTIC_CHUNKER_IDENTITY.maximumTokens) {
      result.push(Object.freeze({ text: current, tokenCount }));
      continue;
    }
    const halves = splitAtGraphemeBoundary(current);
    if (halves === null) return Object.freeze([]);
    pending.push(halves[1], halves[0]);
  }
  return Object.freeze(result);
}

interface RetrievalChunkIdBasis {
  readonly contentDigest: SemanticIndexSha256Digest;
  readonly pageId: string;
  readonly pageRevision: SemanticIndexSha256Digest;
  readonly projectId: string;
  readonly sectionId: string;
  readonly segmentOrdinal: number;
  readonly structureKind: RetrievalStructureKind;
  readonly structureOrdinal: number;
}

export function createRetrievalChunkId(value: RetrievalChunkIdBasis): string {
  return `chunk-${digestValue({
    chunkerDigest: SEMANTIC_CHUNKER_IDENTITY.identityDigest,
    ...value,
  }).slice('sha256:'.length)}`;
}

export async function chunkApprovedWikiCorpus(
  corpus: ApprovedWikiRetrievalCorpusV1,
  expectedProjectId: string,
  countTokens: DocumentTokenCounter,
): Promise<RetrievalChunkingResultV1> {
  try {
    createApprovedWikiRetrieval(corpus, expectedProjectId);
  } catch {
    throw new SemanticIndexError('SEMANTIC_INDEX_CONFIG_INVALID', 'artifact-invalid');
  }
  const chunks: RetrievalChunkMaterialV1[] = [];
  const skipped: SkippedRetrievalChunkV1[] = [];
  for (const page of [...corpus.pages].sort((left, right) => compareText(left.pageId, right.pageId))) {
    for (const section of [...page.sections].sort((left, right) =>
      compareText(left.sectionId, right.sectionId))) {
      let structureOrdinal = 0;
      const semanticBody = section.semanticText ?? section.body;
      const citationQueues = section.semanticText === undefined
        ? null
        : semanticCitationQueues(section.body, section.citationLocators);
      const consumedCitationQueues = new Map<string, number>();
      for (const block of iterateMarkdownStructures(semanticBody)) {
        if (chunks.length >= SEMANTIC_INDEX_LIMITS.maximumChunks) {
          throw new SemanticIndexError('SEMANTIC_INDEX_LIMIT_EXCEEDED', 'limit-exceeded');
        }
        const structure = block.text.normalize('NFC');
        const citationKey = `${block.kind}\u0000${structure}`;
        const citationQueueIndex = consumedCitationQueues.get(citationKey) ?? 0;
        const citations = citationQueues === null
          ? citationLocatorsForStructure(structure, section.citationLocators, block.kind)
          : citationQueues.get(citationKey)?.[citationQueueIndex] ?? Object.freeze([]);
        consumedCitationQueues.set(citationKey, citationQueueIndex + 1);
        const planningSegments = splitToPlanningBound(structure);
        let segmentOrdinal = 0;
        if (planningSegments.length === 0) {
          skipped.push(Object.freeze({
            contentDigest: digest(structure),
            eligibility: 'ineligible',
            pageId: page.pageId,
            pageRevision: page.proposalDigest,
            projectId: expectedProjectId,
            sectionId: section.sectionId,
            skipReason: 'structure-too-large',
            structureKind: block.kind,
            utf8Bytes: Buffer.byteLength(structure, 'utf8'),
          }));
          structureOrdinal += 1;
          continue;
        }
        for (const planningSegment of planningSegments) {
          const tokenSegments = await splitToTokenBound(planningSegment, countTokens);
          if (tokenSegments.length === 0) {
            skipped.push(Object.freeze({
              contentDigest: digest(planningSegment),
              eligibility: 'ineligible',
              pageId: page.pageId,
              pageRevision: page.proposalDigest,
              projectId: expectedProjectId,
              sectionId: section.sectionId,
              skipReason: 'structure-too-large',
              structureKind: block.kind,
              utf8Bytes: Buffer.byteLength(planningSegment, 'utf8'),
            }));
            continue;
          }
          for (const segment of tokenSegments) {
            if (chunks.length >= SEMANTIC_INDEX_LIMITS.maximumChunks) {
              throw new SemanticIndexError('SEMANTIC_INDEX_LIMIT_EXCEEDED', 'limit-exceeded');
            }
            const contentDigest = digest(segment.text);
            const utf8Bytes = Buffer.byteLength(segment.text, 'utf8');
            const chunkId = createRetrievalChunkId({
              contentDigest,
              pageId: page.pageId,
              pageRevision: page.proposalDigest,
              projectId: expectedProjectId,
              sectionId: section.sectionId,
              segmentOrdinal,
              structureKind: block.kind,
              structureOrdinal,
            });
            const rowOrdinal = chunks.length;
            chunks.push(Object.freeze({
              chunk: Object.freeze({
                schemaVersion: RETRIEVAL_CHUNK_SCHEMA_VERSION,
                projectId: expectedProjectId,
                pageId: page.pageId,
                pageRevision: page.proposalDigest,
                sectionId: section.sectionId,
                chunkId,
                rowOrdinal,
                segmentOrdinal,
                structureOrdinal,
                structureKind: block.kind,
                contentDigest,
                utf8Bytes,
                maximumTokens: 512,
                tokenCount: segment.tokenCount,
                tokenTruncated: false,
                chunkerDigest: SEMANTIC_CHUNKER_IDENTITY.identityDigest,
                citationLocators: citations,
                meaningSignals: Object.freeze((section.meaningSignals ?? []).filter((signal) =>
                  citations.some((citation) => citation.sourceId === signal.sourceId))),
                eligibility: 'eligible',
                skipReason: null,
              }),
              text: segment.text,
            }));
            segmentOrdinal += 1;
          }
        }
        structureOrdinal += 1;
      }
    }
  }
  if (chunks.length < 1) {
    throw new SemanticIndexError('SEMANTIC_INDEX_CONFIG_INVALID', 'artifact-invalid');
  }
  return Object.freeze({
    chunker: SEMANTIC_CHUNKER_IDENTITY,
    chunks: Object.freeze(chunks),
    skipped: Object.freeze(skipped),
  });
}
