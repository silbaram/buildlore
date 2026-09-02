import { createHash } from 'node:crypto';

import type { EvidenceCitationAnchorV1 } from '../compiler/hierarchy/types.js';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import {
  prepareApprovedWikiPublication,
  type ApprovedWikiPublicationSnapshotV1,
} from './approved-corpus-store.js';
import type { ApprovedWikiRetrievalPageV1 } from './hierarchical.js';

export const HIERARCHICAL_MARKDOWN_MANIFEST_SCHEMA_VERSION =
  'buildlore.hierarchical-markdown-materialization-manifest.v1' as const;
export const HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION =
  'buildlore.hierarchical-markdown-materialization-status.v1' as const;
export const HIERARCHICAL_MARKDOWN_PAGE_SCHEMA_VERSION =
  'buildlore.hierarchical-markdown-page.v1' as const;
export const HIERARCHICAL_MARKDOWN_INDEX_SCHEMA_VERSION =
  'buildlore.hierarchical-markdown-index.v1' as const;
export const HIERARCHICAL_MARKDOWN_NAMESPACE = 'buildlore-hierarchy' as const;
export const HIERARCHICAL_MARKDOWN_MANIFEST_FILENAME = 'manifest.json' as const;
export const HIERARCHICAL_MARKDOWN_INDEX_FILENAME = 'index.md' as const;
export const HIERARCHICAL_MARKDOWN_MAXIMUM_MANIFEST_BYTES = 4 * 1024 * 1024;

const PAGE_ID_PATTERN = /^page-[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PAGE_FILENAME_PATTERN = /^page-[a-f0-9]{64}\.md$/u;
const MAXIMUM_PAGE_COUNT = 4_096;
const MAXIMUM_FILE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_TOTAL_BYTES = 64 * 1024 * 1024;
const MANIFEST_PROPERTIES = Object.freeze([
  'authorityDigest',
  'corpusDigest',
  'files',
  'generationDigest',
  'materializationDigest',
  'pageCount',
  'projectId',
  'projectionDigest',
  'recordDigest',
  'rendererDigest',
  'sanitizerPolicyDigest',
  'schemaVersion',
] as const);
const INDEX_FILE_PROPERTIES = Object.freeze([
  'byteLength',
  'kind',
  'path',
  'sha256',
] as const);
const PAGE_FILE_PROPERTIES = Object.freeze([
  ...INDEX_FILE_PROPERTIES,
  'pageId',
  'proposalDigest',
] as const);
const RENDERER_CONTRACT = Object.freeze({
  citationOrder: 'citation-id',
  encoding: 'utf-8',
  frontmatter: 'json-scalars',
  lineEndings: 'lf',
  linkMode: 'relative-page-id-outside-code',
  normalization: 'nfc',
  pageOrder: 'page-id',
  schemaVersion: 'buildlore.hierarchical-markdown-renderer.v1',
  timestamp: 'none',
});

export const HIERARCHICAL_MARKDOWN_RENDERER_DIGEST = digestValue(RENDERER_CONTRACT);

export type HierarchicalMarkdownMaterializationErrorCode =
  | 'HIERARCHICAL_MARKDOWN_BUSY'
  | 'HIERARCHICAL_MARKDOWN_CONTRACT_INVALID'
  | 'HIERARCHICAL_MARKDOWN_DRIFT'
  | 'HIERARCHICAL_MARKDOWN_SECURITY_DENIED'
  | 'HIERARCHICAL_MARKDOWN_WRITE_FAILED';

export class HierarchicalMarkdownMaterializationError extends Error {
  readonly code: HierarchicalMarkdownMaterializationErrorCode;
  readonly retryable: boolean;

  constructor(code: HierarchicalMarkdownMaterializationErrorCode) {
    super(code === 'HIERARCHICAL_MARKDOWN_BUSY'
      ? 'Hierarchical Markdown publication is already in progress.'
      : code === 'HIERARCHICAL_MARKDOWN_DRIFT'
        ? 'Hierarchical Markdown publication lineage changed.'
        : code === 'HIERARCHICAL_MARKDOWN_SECURITY_DENIED'
          ? 'Hierarchical Markdown output was rejected by security policy.'
          : code === 'HIERARCHICAL_MARKDOWN_WRITE_FAILED'
            ? 'Hierarchical Markdown could not be stored safely.'
            : 'Hierarchical Markdown contract is invalid.');
    this.name = 'HierarchicalMarkdownMaterializationError';
    this.code = code;
    this.retryable = code === 'HIERARCHICAL_MARKDOWN_BUSY' ||
      code === 'HIERARCHICAL_MARKDOWN_WRITE_FAILED';
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({ code: this.code, message: this.message, retryable: this.retryable });
  }
}

export interface HierarchicalMarkdownFileRecordV1 {
  readonly byteLength: number;
  readonly kind: 'index' | 'page';
  readonly pageId?: string;
  readonly path: string;
  readonly proposalDigest?: `sha256:${string}`;
  readonly sha256: `sha256:${string}`;
}

export interface HierarchicalMarkdownMaterializationManifestV1 {
  readonly authorityDigest: `sha256:${string}`;
  readonly corpusDigest: `sha256:${string}`;
  readonly files: readonly HierarchicalMarkdownFileRecordV1[];
  readonly generationDigest: `sha256:${string}`;
  readonly materializationDigest: `sha256:${string}`;
  readonly pageCount: number;
  readonly projectId: string;
  readonly projectionDigest: `sha256:${string}`;
  readonly recordDigest: `sha256:${string}`;
  readonly rendererDigest: `sha256:${string}`;
  readonly sanitizerPolicyDigest: `sha256:${string}`;
  readonly schemaVersion: typeof HIERARCHICAL_MARKDOWN_MANIFEST_SCHEMA_VERSION;
}

export interface HierarchicalMarkdownRenderedFileV1 extends
  HierarchicalMarkdownFileRecordV1 {
  readonly body: string;
}

export interface HierarchicalMarkdownRenderPlanV1 {
  readonly files: readonly HierarchicalMarkdownRenderedFileV1[];
  readonly manifest: HierarchicalMarkdownMaterializationManifestV1;
  readonly manifestBody: string;
  readonly publication: ApprovedWikiPublicationSnapshotV1;
}

export type HierarchicalMarkdownMaterializationStatusV1 =
  | Readonly<{
      readonly projectId: string;
      readonly schemaVersion: typeof HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION;
      readonly state: 'none';
    }>
  | Readonly<{
      readonly projectId: string;
      readonly reasonCode: 'materialization-missing';
      readonly recoveryAction: readonly ['compile', 'activate', '--project', string];
      readonly schemaVersion: typeof HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION;
      readonly state: 'missing';
    }>
  | Readonly<{
      readonly projectId: string;
      readonly reasonCode: 'materialization-drifted';
      readonly recoveryAction: readonly ['compile', 'activate', '--project', string];
      readonly schemaVersion: typeof HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION;
      readonly state: 'drifted';
    }>
  | Readonly<{
      readonly projectId: string;
      readonly reasonCode: 'materialization-invalid';
      readonly recoveryAction: readonly ['compile', 'activate', '--project', string];
      readonly schemaVersion: typeof HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION;
      readonly state: 'invalid';
    }>
  | Readonly<{
      readonly fileCount: number;
      readonly generationDigest: `sha256:${string}`;
      readonly materializationDigest: `sha256:${string}`;
      readonly pageCount: number;
      readonly projectId: string;
      readonly schemaVersion: typeof HIERARCHICAL_MARKDOWN_STATUS_SCHEMA_VERSION;
      readonly state: 'ready';
    }>;

function fail(code: HierarchicalMarkdownMaterializationErrorCode): never {
  throw new HierarchicalMarkdownMaterializationError(code);
}

function digestText(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function digestValue(value: unknown): `sha256:${string}` {
  return digestText(serializeCanonicalJson(value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function jsonScalar(value: string): string {
  return JSON.stringify(value.normalize('NFC'));
}

function escapeMarkdownLabel(value: string): string {
  return value.normalize('NFC').replace(/[\\[\]*_`<>#]/gu, '\\$&');
}

function sectionTitle(sectionId: string): string {
  const value = sectionId.replaceAll('-', ' ').replaceAll('_', ' ').trim();
  return escapeMarkdownLabel(value.length > 0 ? value : sectionId);
}

function linkFor(page: ApprovedWikiRetrievalPageV1): string {
  return `[${escapeMarkdownLabel(page.title)}](./${page.pageId}.md)`;
}

function replaceWikiLinksInText(
  value: string,
  pages: ReadonlyMap<string, ApprovedWikiRetrievalPageV1>,
): string {
  return value.replace(/(?<!\\)\[\[([^\]\r\n]{1,256})\]\]/gu, (_match, target: string) => {
    if (!PAGE_ID_PATTERN.test(target)) fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
    const page = pages.get(target);
    if (page === undefined) fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
    return linkFor(page);
  });
}

function replaceWikiLinksOutsideInlineCode(
  line: string,
  pages: ReadonlyMap<string, ApprovedWikiRetrievalPageV1>,
): string {
  let result = '';
  let plainStart = 0;
  let cursor = 0;
  while (cursor < line.length) {
    if (line[cursor] !== '`' || line[cursor - 1] === '\\') {
      cursor += 1;
      continue;
    }
    let delimiterEnd = cursor + 1;
    while (line[delimiterEnd] === '`') delimiterEnd += 1;
    const delimiter = line.slice(cursor, delimiterEnd);
    const close = line.indexOf(delimiter, delimiterEnd);
    if (close < 0) break;
    result += replaceWikiLinksInText(line.slice(plainStart, cursor), pages);
    result += line.slice(cursor, close + delimiter.length);
    cursor = close + delimiter.length;
    plainStart = cursor;
  }
  return result + replaceWikiLinksInText(line.slice(plainStart), pages);
}

function transformWikiLinks(
  body: string,
  pages: ReadonlyMap<string, ApprovedWikiRetrievalPageV1>,
): string {
  const lines = body.replace(/\r\n?/gu, '\n').normalize('NFC').split('\n');
  let fence: Readonly<{ readonly character: '`' | '~'; readonly length: number }> | null = null;
  return lines.map((line) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fence !== null) {
      if (fenceMatch !== null && fenceMatch[1]?.[0] === fence.character &&
          fenceMatch[1].length >= fence.length &&
          /^ {0,3}(?:`{3,}|~{3,})\s*$/u.test(line)) {
        fence = null;
      }
      return line;
    }
    if (fenceMatch !== null) {
      const token = fenceMatch[1];
      const character = token?.[0];
      if (token !== undefined && (character === '`' || character === '~')) {
        fence = Object.freeze({ character, length: token.length });
      }
      return line;
    }
    return replaceWikiLinksOutsideInlineCode(line, pages);
  }).join('\n');
}

function citationAnchors(
  publication: ApprovedWikiPublicationSnapshotV1,
): ReadonlyMap<string, EvidenceCitationAnchorV1> {
  const anchors = new Map<string, EvidenceCitationAnchorV1>();
  for (const pack of publication.authority.finalization.evidencePacks) {
    for (const unit of pack.units) {
      const existing = anchors.get(unit.citation.citationId);
      if (existing !== undefined && !sameValue(existing, unit.citation)) {
        fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
      }
      anchors.set(unit.citation.citationId, unit.citation);
    }
  }
  return anchors;
}

function citationLine(anchor: EvidenceCitationAnchorV1): string {
  const range = `${anchor.range.startLine}:${anchor.range.startColumn}-` +
    `${anchor.range.endLine}:${anchor.range.endColumn}`;
  return `[^${anchor.citationId}]: source ${jsonScalar(anchor.sourceId)}; ` +
    `ref ${jsonScalar(anchor.sourceRef)}; range ${range}; ` +
    `revision ${jsonScalar(anchor.sourceRevision)}; quote ${jsonScalar(anchor.quoteDigest)}`;
}

function renderNavigation(
  page: ApprovedWikiRetrievalPageV1,
  pages: ReadonlyMap<string, ApprovedWikiRetrievalPageV1>,
): readonly string[] {
  const parent = page.parentPageId === null ? null : pages.get(page.parentPageId);
  if (parent === undefined) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  const children = page.childPageIds.map((pageId) =>
    pages.get(pageId) ?? fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID'));
  const related = page.relationPageIds.map((pageId) =>
    pages.get(pageId) ?? fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID'));
  return Object.freeze([
    `- Index: [BuildLore Hierarchical Wiki](./${HIERARCHICAL_MARKDOWN_INDEX_FILENAME})`,
    `- Parent: ${parent === null ? 'None' : linkFor(parent)}`,
    `- Children: ${children.length === 0 ? 'None' : children.map(linkFor).join(', ')}`,
    `- Related: ${related.length === 0 ? 'None' : related.map(linkFor).join(', ')}`,
  ]);
}

function renderPage(
  page: ApprovedWikiRetrievalPageV1,
  publication: ApprovedWikiPublicationSnapshotV1,
  pages: ReadonlyMap<string, ApprovedWikiRetrievalPageV1>,
  anchors: ReadonlyMap<string, EvidenceCitationAnchorV1>,
): string {
  const citationIds = [...new Set(page.sections.flatMap((section) =>
    section.citationLocators.map((locator) => {
      const anchor = anchors.get(locator.citationId);
      if (anchor === undefined || anchor.sourceId !== locator.sourceId) {
        fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
      }
      return locator.citationId;
    })))]
    .sort(compareText);
  const sections = page.sections.flatMap((section) => [
    `## ${sectionTitle(section.sectionId)}`,
    '',
    transformWikiLinks(section.body, pages),
    '',
  ]);
  const citations = citationIds.length === 0
    ? []
    : ['## Citations', '', ...citationIds.map((citationId) => {
        const anchor = anchors.get(citationId);
        return anchor === undefined
          ? fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID')
          : citationLine(anchor);
      }), ''];
  return [
    '---',
    `schema_version: ${jsonScalar(HIERARCHICAL_MARKDOWN_PAGE_SCHEMA_VERSION)}`,
    `project_id: ${jsonScalar(publication.projection.projectId)}`,
    `page_id: ${jsonScalar(page.pageId)}`,
    `generation_digest: ${jsonScalar(publication.projection.corpus.generationDigest)}`,
    `proposal_digest: ${jsonScalar(page.proposalDigest)}`,
    `authority_digest: ${jsonScalar(publication.authorityDigest)}`,
    `renderer_digest: ${jsonScalar(HIERARCHICAL_MARKDOWN_RENDERER_DIGEST)}`,
    'generated: true',
    '---',
    '',
    `# ${escapeMarkdownLabel(page.title)}`,
    '',
    '<!-- Generated from approved BuildLore authority. Direct edits are not authoritative. -->',
    '',
    transformWikiLinks(page.summary, pages),
    '',
    '## Navigation',
    '',
    ...renderNavigation(page, pages),
    '',
    ...sections,
    ...citations,
  ].join('\n').normalize('NFC');
}

function renderTree(
  pages: ReadonlyMap<string, ApprovedWikiRetrievalPageV1>,
): readonly string[] {
  const visited = new Set<string>();
  const lines: string[] = [];
  const visit = (page: ApprovedWikiRetrievalPageV1, depth: number): void => {
    if (visited.has(page.pageId)) fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
    visited.add(page.pageId);
    lines.push(`${'  '.repeat(depth)}- ${linkFor(page)}`);
    for (const childId of [...page.childPageIds].sort(compareText)) {
      const child = pages.get(childId);
      if (child === undefined || child.parentPageId !== page.pageId) {
        fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
      }
      visit(child, depth + 1);
    }
  };
  const roots = [...pages.values()].filter((page) => page.parentPageId === null)
    .sort((left, right) => compareText(left.pageId, right.pageId));
  if (pages.size > 0 && roots.length === 0) fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  for (const root of roots) visit(root, 0);
  if (visited.size !== pages.size) fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  return Object.freeze(lines);
}

function renderIndex(
  publication: ApprovedWikiPublicationSnapshotV1,
  pages: ReadonlyMap<string, ApprovedWikiRetrievalPageV1>,
): string {
  const related = [...pages.values()].filter((page) => page.relationPageIds.length > 0)
    .sort((left, right) => compareText(left.pageId, right.pageId))
    .map((page) => `- ${linkFor(page)}: ${[...page.relationPageIds].sort(compareText)
      .map((pageId) => linkFor(pages.get(pageId) ??
        fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID'))).join(', ')}`);
  return [
    '---',
    `schema_version: ${jsonScalar(HIERARCHICAL_MARKDOWN_INDEX_SCHEMA_VERSION)}`,
    `project_id: ${jsonScalar(publication.projection.projectId)}`,
    `generation_digest: ${jsonScalar(publication.projection.corpus.generationDigest)}`,
    `authority_digest: ${jsonScalar(publication.authorityDigest)}`,
    `renderer_digest: ${jsonScalar(HIERARCHICAL_MARKDOWN_RENDERER_DIGEST)}`,
    'generated: true',
    '---',
    '',
    '# BuildLore Hierarchical Wiki',
    '',
    '<!-- Generated from approved BuildLore authority. Direct edits are not authoritative. -->',
    '',
    '## Pages',
    '',
    ...renderTree(pages),
    '',
    ...(related.length === 0 ? [] : ['## Related pages', '', ...related, '']),
  ].join('\n').normalize('NFC');
}

function renderedFile(input: Readonly<{
  readonly body: string;
  readonly kind: 'index' | 'page';
  readonly pageId?: string;
  readonly path: string;
  readonly proposalDigest?: `sha256:${string}`;
}>): HierarchicalMarkdownRenderedFileV1 {
  const body = input.body.endsWith('\n') ? input.body : `${input.body}\n`;
  const byteLength = Buffer.byteLength(body, 'utf8');
  if (byteLength < 1 || byteLength > MAXIMUM_FILE_BYTES) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  return Object.freeze({
    body,
    byteLength,
    kind: input.kind,
    ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
    path: input.path,
    ...(input.proposalDigest === undefined ? {} : {
      proposalDigest: input.proposalDigest,
    }),
    sha256: digestText(body),
  });
}

function fileRecord(
  file: HierarchicalMarkdownRenderedFileV1,
): HierarchicalMarkdownFileRecordV1 {
  return Object.freeze({
    byteLength: file.byteLength,
    kind: file.kind,
    ...(file.pageId === undefined ? {} : { pageId: file.pageId }),
    path: file.path,
    ...(file.proposalDigest === undefined ? {} : {
      proposalDigest: file.proposalDigest,
    }),
    sha256: file.sha256,
  });
}

function manifestBasis(
  manifest: Omit<HierarchicalMarkdownMaterializationManifestV1, 'materializationDigest'>,
): Omit<HierarchicalMarkdownMaterializationManifestV1, 'materializationDigest'> {
  return manifest;
}

export function renderHierarchicalMarkdown(
  input: Readonly<{ readonly publication: ApprovedWikiPublicationSnapshotV1 }>,
): HierarchicalMarkdownRenderPlanV1 {
  const expected = prepareApprovedWikiPublication(
    input.publication.authority,
    input.publication.projection.projectId,
  );
  if (!sameValue(expected, input.publication)) fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  const orderedPages = [...input.publication.projection.corpus.pages]
    .sort((left, right) => compareText(left.pageId, right.pageId));
  if (orderedPages.length > MAXIMUM_PAGE_COUNT || orderedPages.some((page) =>
    !PAGE_ID_PATTERN.test(page.pageId))) fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  const pages = new Map<string, ApprovedWikiRetrievalPageV1>();
  for (const page of orderedPages) {
    if (pages.has(page.pageId)) fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
    pages.set(page.pageId, page);
  }
  const anchors = citationAnchors(input.publication);
  const files: HierarchicalMarkdownRenderedFileV1[] = [renderedFile({
    body: renderIndex(input.publication, pages),
    kind: 'index',
    path: HIERARCHICAL_MARKDOWN_INDEX_FILENAME,
  })];
  for (const page of orderedPages) {
    files.push(renderedFile({
      body: renderPage(page, input.publication, pages, anchors),
      kind: 'page',
      pageId: page.pageId,
      path: `${page.pageId}.md`,
      proposalDigest: page.proposalDigest,
    }));
  }
  const totalBytes = files.reduce((sum, file) => sum + file.byteLength, 0);
  if (totalBytes > MAXIMUM_TOTAL_BYTES) fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  const records = Object.freeze(files.map(fileRecord)
    .sort((left, right) => compareText(left.path, right.path)));
  const basis = manifestBasis(Object.freeze({
    authorityDigest: input.publication.authorityDigest,
    corpusDigest: input.publication.projection.corpus.corpusDigest,
    files: records,
    generationDigest: input.publication.projection.corpus.generationDigest,
    pageCount: orderedPages.length,
    projectId: input.publication.projection.projectId,
    projectionDigest: input.publication.projection.projectionDigest,
    recordDigest: input.publication.recordDigest,
    rendererDigest: HIERARCHICAL_MARKDOWN_RENDERER_DIGEST,
    sanitizerPolicyDigest: input.publication.projection.sanitizerPolicyDigest,
    schemaVersion: HIERARCHICAL_MARKDOWN_MANIFEST_SCHEMA_VERSION,
  }));
  const manifest = Object.freeze({
    ...basis,
    materializationDigest: digestValue(basis),
  });
  const manifestBody = serializeCanonicalJson(manifest);
  const manifestBytes = Buffer.byteLength(manifestBody, 'utf8');
  if (manifestBytes > HIERARCHICAL_MARKDOWN_MAXIMUM_MANIFEST_BYTES ||
      totalBytes + manifestBytes > MAXIMUM_TOTAL_BYTES) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  return Object.freeze({
    files: Object.freeze(files),
    manifest,
    manifestBody,
    publication: input.publication,
  });
}

function parseFileRecord(value: unknown): HierarchicalMarkdownFileRecordV1 {
  if (!isRecord(value) || (value.kind !== 'index' && value.kind !== 'page') ||
      typeof value.path !== 'string' || typeof value.byteLength !== 'number' ||
      !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 ||
      value.byteLength > MAXIMUM_FILE_BYTES || !isDigest(value.sha256)) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  if (value.kind === 'index') {
    if (!exactKeys(value, INDEX_FILE_PROPERTIES) ||
        value.path !== HIERARCHICAL_MARKDOWN_INDEX_FILENAME) {
      fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
    }
    return Object.freeze({
      byteLength: value.byteLength,
      kind: value.kind,
      path: value.path,
      sha256: value.sha256,
    });
  }
  if (!exactKeys(value, PAGE_FILE_PROPERTIES) ||
      typeof value.pageId !== 'string' || !PAGE_ID_PATTERN.test(value.pageId) ||
      value.path !== `${value.pageId}.md` || !PAGE_FILENAME_PATTERN.test(value.path) ||
      !isDigest(value.proposalDigest)) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  return Object.freeze({
    byteLength: value.byteLength,
    kind: value.kind,
    pageId: value.pageId,
    path: value.path,
    proposalDigest: value.proposalDigest,
    sha256: value.sha256,
  });
}

export function parseHierarchicalMarkdownManifest(
  value: unknown,
  projectId: string,
): HierarchicalMarkdownMaterializationManifestV1 {
  if (!isRecord(value) || !exactKeys(value, MANIFEST_PROPERTIES) ||
      value.schemaVersion !== HIERARCHICAL_MARKDOWN_MANIFEST_SCHEMA_VERSION ||
      value.projectId !== projectId || typeof value.pageCount !== 'number' ||
      !Number.isSafeInteger(value.pageCount) || value.pageCount < 0 ||
      value.pageCount > MAXIMUM_PAGE_COUNT || !Array.isArray(value.files)) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  if (!isDigest(value.authorityDigest) || !isDigest(value.corpusDigest) ||
      !isDigest(value.generationDigest) || !isDigest(value.materializationDigest) ||
      !isDigest(value.projectionDigest) || !isDigest(value.recordDigest) ||
      !isDigest(value.rendererDigest) || !isDigest(value.sanitizerPolicyDigest)) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  const files = Object.freeze(value.files.map(parseFileRecord));
  if (files.length !== value.pageCount + 1 || files[0]?.path !== 'index.md' ||
      files.filter((file) => file.kind === 'page').length !== value.pageCount ||
      files.some((file, index) => index > 0 &&
        compareText(files[index - 1]?.path ?? '', file.path) >= 0)) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  const basis = Object.freeze({
    authorityDigest: value.authorityDigest,
    corpusDigest: value.corpusDigest,
    files,
    generationDigest: value.generationDigest,
    pageCount: value.pageCount,
    projectId: value.projectId,
    projectionDigest: value.projectionDigest,
    recordDigest: value.recordDigest,
    rendererDigest: value.rendererDigest,
    sanitizerPolicyDigest: value.sanitizerPolicyDigest,
    schemaVersion: value.schemaVersion,
  });
  if (value.materializationDigest !== digestValue(basis)) {
    fail('HIERARCHICAL_MARKDOWN_CONTRACT_INVALID');
  }
  return Object.freeze({ ...basis, materializationDigest: value.materializationDigest });
}
