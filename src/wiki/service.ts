import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

import { createLlmWikiCompilerBackend } from '../compiler/backend.js';
import {
  createProjectCorpus,
  type ProjectCorpusPort,
  type SearchCorpus,
  type SearchCorpusPage,
} from '../compiler/corpus.js';
import { CompilerBackendError } from '../compiler/errors.js';
import { inspectSessionExportCitations } from '../compiler/session/export-citations.js';
import {
  createSessionReviewStore,
  type SessionReviewStore,
} from '../compiler/session/review-store.js';
import { readConfinedSessionUtf8 } from '../compiler/session/safe-io.js';
import { sessionSha256 } from '../compiler/session/canonical.js';
import { SESSION_COMPILE_LIMITS } from '../compiler/session/contracts.js';
import type { SessionPromotionProofV1 } from '../compiler/session/types.js';
import type { CompilerCorpusBackend, CompilerWikiBackend } from '../compiler/types.js';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { validateProjectId } from '../knowledge/validation.js';
import { showProject } from '../knowledge/workspace.js';
import { resolveRegisteredProfileBinding } from '../profile/preflight.js';
import { generatedSourceFilenameKind } from '../sanitizer/index.js';
import { parseSourceDocument, renderSourceDocument } from '../projector/source-document.js';
import { unicodeScalarLength } from '../projector/text-units.js';
import type {
  SourceAdapterDefinitionV1,
  SourceAdapterRegistry,
} from '../projector/source-adapter-registry.js';
import {
  validatePortableSourceRef,
  type SourceRangeMappingV1,
} from '../projector/source-contracts.js';
import { WikiOperationError } from './errors.js';
import {
  WIKI_CITATIONS_SCHEMA_VERSION,
  WIKI_LIST_SCHEMA_VERSION,
  WIKI_PAGE_SCHEMA_VERSION,
  type CitationRangeV1,
  type CitationRecordV1,
  type WikiCitationsResultV1,
  type WikiListInput,
  type WikiListResultV1,
  type WikiPageInput,
  type WikiPageRef,
  type WikiPageSummaryV1,
  type WikiPageV1,
  type WikiServicePort,
  type WikiSnapshotPageV1,
  type WikiSnapshotV1,
} from './types.js';

const PAGE_REF_PATTERN = /^(concepts|decisions|failures|queries|verifications)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const SAFE_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/u;
const SOURCE_FILE_PATTERN = /^(?:code|json|markdown|planning|text)--[a-f0-9]{64}\.md$/u;
const SOURCE_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_PAGE_COUNT = 4_096;
const MAX_LIST_LIMIT = 100;

type WikiBackend = CompilerCorpusBackend & CompilerWikiBackend;
type UnknownRecord = Readonly<Record<string, unknown>>;

interface SdkPage {
  readonly body?: string;
  readonly pageRef: WikiPageRef;
  readonly summary: string;
  readonly title: string;
}

interface CursorV1 {
  readonly digest: `sha256:${string}`;
  readonly offset: number;
  readonly version: 1;
}

export interface CreateWikiReadOptions {
  readonly backend?: WikiBackend;
  readonly corpus?: ProjectCorpusPort;
  readonly knowledgeRoot: string;
  readonly sourceAdapterRegistrations?: readonly SourceAdapterDefinitionV1[];
  readonly reviewStoreFactory?: (workspace: string, projectId: string) => SessionReviewStore;
}

function fail(code: ConstructorParameters<typeof WikiOperationError>[0], projectId: string): never {
  throw new WikiOperationError(code, projectId);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index]);
}

function safeText(value: unknown, maximum: number, projectId: string, multiline = false): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum ||
      value !== value.normalize('NFC') || value.includes('\r') || value.includes('\0') ||
      (!multiline && value.includes('\n'))) {
    return fail('WIKI_CONTRACT_INVALID', projectId);
  }
  return value;
}

function pageRef(value: string, projectId: string): WikiPageRef {
  if (value.length > 320 || PAGE_REF_PATTERN.exec(value) === null) {
    return fail('WIKI_PAGE_REF_INVALID', projectId);
  }
  return value as WikiPageRef;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function snapshotDigest(snapshot: SearchCorpus): `sha256:${string}` {
  return sha256(serializeCanonicalJson({
    excluded: snapshot.excluded,
    pages: snapshot.pages,
    projectId: snapshot.projectId,
    warnings: snapshot.warnings,
  }));
}

function snapshotsMatch(left: SearchCorpus, right: SearchCorpus): boolean {
  return snapshotDigest(left) === snapshotDigest(right);
}

function requireCleanSnapshot(snapshot: SearchCorpus, projectId: string): void {
  if (snapshot.projectId !== projectId || !Array.isArray(snapshot.pages) ||
      snapshot.pages.length > MAX_PAGE_COUNT || !Array.isArray(snapshot.warnings) ||
      snapshot.warnings.length > 0 || !isRecord(snapshot.excluded) ||
      !exactKeys(snapshot.excluded, ['archived', 'orphaned', 'stale', 'unverified']) ||
      Object.values(snapshot.excluded).some((count) =>
        !Number.isSafeInteger(count) || Number(count) < 0)) {
    fail('WIKI_CONTRACT_INVALID', projectId);
  }
  let previousPageRef: string | undefined;
  for (const value of snapshot.pages as readonly unknown[]) {
    if (!isRecord(value) || !exactKeys(value, [
      'body', 'freshness', 'pageId', 'sourceRefs', 'summary', 'title',
    ]) || value.freshness !== 'fresh' || !Array.isArray(value.sourceRefs) ||
        value.sourceRefs.length > 100) {
      fail('WIKI_CONTRACT_INVALID', projectId);
    }
    const pageId = safeText(value.pageId, 320, projectId);
    safeText(value.body, 1_048_576, projectId, true);
    safeText(value.summary, 4_000, projectId, true);
    safeText(value.title, 512, projectId, true);
    if (PAGE_REF_PATTERN.exec(pageId) === null ||
        (previousPageRef !== undefined && pageId <= previousPageRef) ||
        new Set(value.sourceRefs).size !== value.sourceRefs.length) {
      fail('WIKI_CONTRACT_INVALID', projectId);
    }
    previousPageRef = pageId;
    for (const rawSourceRef of value.sourceRefs) {
      const sourceRef = safeText(rawSourceRef, 512, projectId);
      try {
        validatePortableSourceRef(sourceRef);
      } catch {
        fail('WIKI_CONTRACT_INVALID', projectId);
      }
    }
  }
}

function summary(page: SearchCorpusPage, projectId: string): WikiPageSummaryV1 {
  return Object.freeze({
    pageRef: pageRef(page.pageId, projectId),
    projectId,
    schemaVersion: WIKI_PAGE_SCHEMA_VERSION,
    sourceCount: page.sourceRefs.length,
    summary: page.summary,
    title: page.title,
    verified: true,
  });
}

function encodeCursor(cursor: CursorV1): string {
  return Buffer.from(serializeCanonicalJson(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string, digest: `sha256:${string}`, projectId: string): CursorV1 {
  if (!SAFE_CURSOR_PATTERN.test(value)) return fail('WIKI_CURSOR_INVALID', projectId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return fail('WIKI_CURSOR_INVALID', projectId);
  }
  if (!isRecord(parsed) || Object.keys(parsed).sort().join(',') !== 'digest,offset,version' ||
      parsed.version !== 1 || parsed.digest !== digest ||
      !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 ||
      Number(parsed.offset) > MAX_PAGE_COUNT) {
    return fail('WIKI_CURSOR_INVALID', projectId);
  }
  return Object.freeze({ digest, offset: Number(parsed.offset), version: 1 });
}

function legacySdkPage(value: unknown, projectId: string, includeBody: boolean): SdkPage {
  if (!isRecord(value)) return fail('WIKI_CONTRACT_INVALID', projectId);
  const directory = value.pageDirectory;
  if (directory !== 'concepts' && directory !== 'queries') {
    return fail('WIKI_CONTRACT_INVALID', projectId);
  }
  const slug = safeText(value.slug, 255, projectId);
  const result: SdkPage = {
    ...(includeBody
      ? { body: safeText(value.body, 1_048_576, projectId, true) }
      : {}),
    pageRef: pageRef(`${directory}/${slug}`, projectId),
    summary: safeText(value.summary, 4_000, projectId, true),
    title: safeText(value.title, 512, projectId, true),
  };
  return Object.freeze(result);
}

function profileSdkPage(value: unknown, projectId: string, includeBody: boolean): SdkPage {
  if (!isRecord(value)) return fail('WIKI_CONTRACT_INVALID', projectId);
  const entityType = safeText(value.entityType, 64, projectId);
  const slug = safeText(value.slug, 255, projectId);
  if (!new Set(['decisions', 'failures', 'verifications']).has(entityType) ||
      value.id !== `${entityType}/${slug}` ||
      value.directory !== `wiki/${entityType}` ||
      value.path !== `wiki/${entityType}/${slug}.md`) {
    return fail('WIKI_CONTRACT_INVALID', projectId);
  }
  const frontmatter = isRecord(value.frontmatter)
    ? value.frontmatter
    : fail('WIKI_CONTRACT_INVALID', projectId);
  const title = value.title ?? frontmatter.title;
  const result: SdkPage = {
    ...(includeBody
      ? { body: safeText(value.body, 1_048_576, projectId, true) }
      : {}),
    pageRef: pageRef(`${entityType}/${slug}`, projectId),
    summary: safeText(frontmatter.summary, 4_000, projectId, true),
    title: safeText(title, 512, projectId, true),
  };
  return Object.freeze(result);
}

async function collectSdkPages(
  backend: WikiBackend,
  workspace: string,
  projectId: string,
  includeBody: boolean,
): Promise<readonly SdkPage[]> {
  const pages = new Map<string, SdkPage>();
  let cursor: string | undefined;
  let profileCursor: string | undefined;
  let legacyDone = false;
  let profileDone = false;
  for (let requestCount = 0; requestCount < 128 && (!legacyDone || !profileDone); requestCount += 1) {
    let raw: unknown;
    try {
      raw = await backend.listProjectPages(workspace, {
        ...(legacyDone || cursor === undefined ? {} : { cursor }),
        includeBody,
        limit: MAX_LIST_LIMIT,
        ...(profileDone || profileCursor === undefined ? {} : { profileCursor }),
      });
    } catch (error) {
      if (error instanceof CompilerBackendError) return fail('WIKI_BACKEND_UNAVAILABLE', projectId);
      return fail('WIKI_BACKEND_UNAVAILABLE', projectId);
    }
    if (!isRecord(raw) || !Array.isArray(raw.pages) ||
        (raw.warnings !== undefined && (!Array.isArray(raw.warnings) || raw.warnings.length > 0))) {
      return fail('WIKI_CONTRACT_INVALID', projectId);
    }
    if (!legacyDone) {
      for (const page of raw.pages) {
        const normalized = legacySdkPage(page, projectId, includeBody);
        if (pages.has(normalized.pageRef)) return fail('WIKI_CONTRACT_INVALID', projectId);
        pages.set(normalized.pageRef, normalized);
      }
      if (raw.cursor === undefined) legacyDone = true;
      else cursor = safeText(raw.cursor, 1_024, projectId);
    }
    if (raw.profile === undefined) {
      profileDone = true;
    } else if (!profileDone) {
      const profile = isRecord(raw.profile)
        ? raw.profile
        : fail('WIKI_CONTRACT_INVALID', projectId);
      if (!Array.isArray(profile.entityPages) ||
          (profile.problems !== undefined &&
            (!Array.isArray(profile.problems) || profile.problems.length > 0)) ||
          (profile.problemTotal !== undefined && profile.problemTotal !== 0)) {
        return fail('WIKI_CONTRACT_INVALID', projectId);
      }
      for (const page of profile.entityPages) {
        const normalized = profileSdkPage(page, projectId, includeBody);
        if (pages.has(normalized.pageRef)) return fail('WIKI_CONTRACT_INVALID', projectId);
        pages.set(normalized.pageRef, normalized);
      }
      if (profile.cursor === undefined) profileDone = true;
      else profileCursor = safeText(profile.cursor, 1_024, projectId);
    }
    if (pages.size > MAX_PAGE_COUNT) return fail('WIKI_CONTRACT_INVALID', projectId);
  }
  if (!legacyDone || !profileDone) return fail('WIKI_CONTRACT_INVALID', projectId);
  return Object.freeze([...pages.values()].sort((left, right) =>
    left.pageRef < right.pageRef ? -1 : left.pageRef > right.pageRef ? 1 : 0));
}

function verifySdkPages(
  sdkPages: readonly SdkPage[],
  snapshot: SearchCorpus,
  includeBody: boolean,
  projectId: string,
): void {
  if (sdkPages.length !== snapshot.pages.length) return fail('WIKI_CONTRACT_INVALID', projectId);
  const expected = new Map(snapshot.pages.map((page) => [page.pageId, page] as const));
  for (const sdkPage of sdkPages) {
    const page = expected.get(sdkPage.pageRef);
    if (page === undefined || sdkPage.title !== page.title || sdkPage.summary !== page.summary ||
        (includeBody && sdkPage.body !== page.body)) {
      return fail('WIKI_CONTRACT_INVALID', projectId);
    }
  }
}

async function verifiedSnapshot(
  corpus: ProjectCorpusPort,
  projectId: string,
): Promise<SearchCorpus> {
  try {
    const snapshot = await corpus.snapshot(projectId);
    requireCleanSnapshot(snapshot, projectId);
    return snapshot;
  } catch (error) {
    if (error instanceof WikiOperationError) throw error;
    return fail('WIKI_SECURITY_DENIED', projectId);
  }
}

function findPage(snapshot: SearchCorpus, requested: WikiPageRef, projectId: string): SearchCorpusPage {
  return snapshot.pages.find((page) => page.pageId === requested) ??
    fail('WIKI_PAGE_NOT_FOUND', projectId);
}

async function verifyDefaultPage(
  backend: WikiBackend,
  workspace: string,
  page: SearchCorpusPage,
  projectId: string,
): Promise<void> {
  const match = PAGE_REF_PATTERN.exec(page.pageId);
  const directory = match?.[1];
  const slug = match?.[2];
  if ((directory !== 'concepts' && directory !== 'queries') || slug === undefined) {
    return fail('WIKI_PAGE_REF_INVALID', projectId);
  }
  let raw: unknown;
  try {
    raw = await backend.getProjectPage(workspace, { pageDirectory: directory, slug });
  } catch {
    return fail('WIKI_BACKEND_UNAVAILABLE', projectId);
  }
  if (raw === null) return fail('WIKI_PAGE_NOT_FOUND', projectId);
  const sdk = legacySdkPage(raw, projectId, true);
  if (sdk.pageRef !== page.pageId || sdk.title !== page.title ||
      sdk.summary !== page.summary || sdk.body !== page.body) {
    return fail('WIKI_CONTRACT_INVALID', projectId);
  }
}

function sourceFilename(value: string, projectId: string): string {
  const name = value.startsWith('sources/') ? value.slice('sources/'.length) : value;
  if (basename(name) !== name || !SOURCE_FILE_PATTERN.test(name) ||
      generatedSourceFilenameKind(name) === null) {
    return fail('WIKI_CITATION_INVALID', projectId);
  }
  return name;
}

function recordedSourceHashes(
  rawPage: UnknownRecord,
  projectId: string,
): ReadonlySet<string> {
  if (!Array.isArray(rawPage.sourceHashes) || rawPage.sourceHashes.length > 100 ||
      rawPage.sourceHashes.some((value) =>
        typeof value !== 'string' || !SOURCE_HASH_PATTERN.test(value)) ||
      new Set(rawPage.sourceHashes).size !== rawPage.sourceHashes.length) {
    return fail('WIKI_CITATION_INVALID', projectId);
  }
  return new Set(rawPage.sourceHashes as readonly string[]);
}

function mappedRange(
  startLine: number,
  endLine: number,
  mappings: readonly SourceRangeMappingV1[] | undefined,
  adapter: SourceAdapterDefinitionV1 | undefined,
  body: string,
  projectId: string,
): CitationRangeV1 {
  const lines = body.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
      startLine < 1 || endLine < startLine || endLine > lines.length) {
    return fail('WIKI_CITATION_INVALID', projectId);
  }
  const canonicalRange = Object.freeze({
    endColumn: unicodeScalarLength(lines[endLine - 1] ?? '') + 1,
    endLine,
    startColumn: 1,
    startLine,
  });
  if (mappings === undefined) {
    return canonicalRange;
  }
  if (adapter === undefined) return fail('WIKI_CITATION_INVALID', projectId);
  try {
    return Object.freeze(adapter.mapRange(mappings, canonicalRange));
  } catch {
    return fail('WIKI_CITATION_INVALID', projectId);
  }
}

async function citationFromStoredSource(input: {
  readonly citationLineEnd: number;
  readonly citationLineStart: number;
  readonly compilerSourceId: string;
  readonly expectedCompilerSourceHashes?: ReadonlySet<string>;
  readonly expectedOriginalFile?: string;
  readonly expectedJsonPointer?: string;
  readonly expectedQuoteDigest?: string;
  readonly pageRef: WikiPageRef;
  readonly projectId: string;
  readonly sourceAdapters: SourceAdapterRegistry;
  readonly workspace: string;
}): Promise<CitationRecordV1> {
  const name = sourceFilename(input.compilerSourceId, input.projectId);
  let raw: string;
  try {
    raw = await readConfinedSessionUtf8(
      join(input.workspace, 'sources', name),
      input.workspace,
      SESSION_COMPILE_LIMITS.maxSourceBytes,
      input.projectId,
    );
  } catch {
    return fail('WIKI_CITATION_INVALID', input.projectId);
  }
  if (input.expectedCompilerSourceHashes !== undefined &&
      !input.expectedCompilerSourceHashes.has(sessionSha256(raw).slice('sha256:'.length))) {
    return fail('WIKI_CITATION_INVALID', input.projectId);
  }
  let document;
  try {
    document = parseSourceDocument(raw);
  } catch {
    return fail('WIKI_CITATION_INVALID', input.projectId);
  }
  if (renderSourceDocument(document) !== raw || document.buildlore.projectId !== input.projectId ||
      document.buildlore.sourceRevision.length !== 71 ||
      !/^sha256:[a-f0-9]{64}$/u.test(document.buildlore.sourceRevision)) {
    return fail('WIKI_CITATION_INVALID', input.projectId);
  }
  const sourceRefInput = input.expectedOriginalFile ?? document.buildlore.descriptor?.sourceRef;
  let sourceRef: string;
  try {
    sourceRef = validatePortableSourceRef(sourceRefInput);
  } catch {
    return fail('WIKI_CITATION_INVALID', input.projectId);
  }
  if (input.expectedOriginalFile !== undefined && document.buildlore.descriptor !== undefined) {
    const descriptor = document.buildlore.descriptor;
    const bound = descriptor.sourceRef === input.expectedOriginalFile ||
      (descriptor.schemaVersion === 'buildlore.source-descriptor.v2' &&
        descriptor.inputBindings.some((entry) => entry.sourceRef === input.expectedOriginalFile));
    if (!bound) return fail('WIKI_CITATION_INVALID', input.projectId);
  }
  let rangeAdapter: SourceAdapterDefinitionV1 | undefined;
  if (document.buildlore.descriptor !== undefined) {
    const descriptor = document.buildlore.descriptor;
    try {
      rangeAdapter = input.sourceAdapters.resolve({
        adapterId: descriptor.adapterId,
        adapterVersion: descriptor.adapterVersion,
        kind: descriptor.kind,
        mediaType: descriptor.mediaType,
        ...(descriptor.metadata === undefined ? {} : { metadata: descriptor.metadata }),
      }).adapter;
    } catch {
      return fail('WIKI_CITATION_INVALID', input.projectId);
    }
  }
  let canonicalStart = input.citationLineStart;
  let canonicalEnd = input.citationLineEnd;
  if (input.expectedOriginalFile !== undefined && document.buildlore.originMappings !== undefined) {
    const mapping = document.buildlore.originMappings.find((candidate) =>
      input.citationLineStart >= candidate.origin.startLine &&
      input.citationLineEnd <= candidate.origin.endLine);
    if (mapping === undefined) return fail('WIKI_CITATION_INVALID', input.projectId);
    canonicalStart = mapping.canonical.startLine +
      input.citationLineStart - mapping.origin.startLine;
    canonicalEnd = mapping.canonical.startLine + input.citationLineEnd - mapping.origin.startLine;
  }
  const bodyLines = document.body.split('\n');
  const jsonOrigin = document.buildlore.jsonOrigins?.find((mapping) => {
    if (input.expectedOriginalFile !== undefined &&
        mapping.origin.sourceRef !== input.expectedOriginalFile) return false;
    if (input.expectedJsonPointer !== undefined &&
        mapping.origin.jsonPointer !== input.expectedJsonPointer) return false;
    if (input.expectedOriginalFile !== undefined &&
        (input.citationLineStart < mapping.origin.range.startLine ||
          input.citationLineEnd > mapping.origin.range.endLine)) return false;
    const quote = bodyLines[mapping.canonical.startLine - 1];
    return input.expectedQuoteDigest === undefined ||
      (quote !== undefined && sessionSha256(quote) === input.expectedQuoteDigest);
  });
  if (jsonOrigin !== undefined) {
    canonicalStart = jsonOrigin.canonical.startLine;
    canonicalEnd = jsonOrigin.canonical.endLine;
    sourceRef = jsonOrigin.origin.sourceRef;
  }
  if (document.buildlore.jsonOrigins !== undefined && jsonOrigin === undefined) {
    return fail('WIKI_CITATION_INVALID', input.projectId);
  }
  const quote = bodyLines[canonicalStart - 1];
  if (quote === undefined || (input.expectedQuoteDigest !== undefined &&
      sessionSha256(quote) !== input.expectedQuoteDigest)) {
    return fail('WIKI_CITATION_INVALID', input.projectId);
  }
  const range = jsonOrigin?.origin.range ?? mappedRange(
      canonicalStart,
      canonicalEnd,
      document.buildlore.originMappings,
      rangeAdapter,
      document.body,
      input.projectId,
    );
  const sourceRevision = document.buildlore.sourceRevision;
  return Object.freeze({
    citationId: 'citation-' + sha256(serializeCanonicalJson({
      pageRef: input.pageRef,
      projectId: input.projectId,
      ...(jsonOrigin === undefined ? {} : { jsonPointer: jsonOrigin.origin.jsonPointer }),
      range,
      sourceRef,
      sourceRevision,
    })).slice('sha256:'.length),
    pageRef: input.pageRef,
    projectId: input.projectId,
    ...(jsonOrigin === undefined ? {} : { jsonPointer: jsonOrigin.origin.jsonPointer }),
    range,
    sourceRef,
    sourceRevision,
  });
}

function rawExportPage(raw: unknown, requested: WikiPageRef, projectId: string): UnknownRecord | null {
  if (!isRecord(raw) || raw.projectId !== projectId || raw.schemaVersion !== 1 ||
      !Array.isArray(raw.pages)) return fail('WIKI_CONTRACT_INVALID', projectId);
  const matches: UnknownRecord[] = [];
  for (const value of raw.pages) {
    if (!isRecord(value)) return fail('WIKI_CONTRACT_INVALID', projectId);
    if (`${String(value.pageDirectory)}/${String(value.slug)}` === requested) matches.push(value);
  }
  if (raw.profile !== undefined) {
    const profile = isRecord(raw.profile) ? raw.profile : fail('WIKI_CONTRACT_INVALID', projectId);
    if (!Array.isArray(profile.entityPages)) return fail('WIKI_CONTRACT_INVALID', projectId);
    for (const value of profile.entityPages) {
      if (!isRecord(value)) return fail('WIKI_CONTRACT_INVALID', projectId);
      if (value.id === requested) matches.push(value);
    }
  }
  if (matches.length > 1) return fail('WIKI_CONTRACT_INVALID', projectId);
  return matches[0] ?? null;
}

function assertRawExportInventory(
  raw: unknown,
  snapshot: SearchCorpus,
  projectId: string,
): void {
  if (!isRecord(raw) || raw.projectId !== projectId || raw.schemaVersion !== 1 ||
      !Array.isArray(raw.pages)) return fail('WIKI_CONTRACT_INVALID', projectId);
  const actual: WikiPageRef[] = [];
  for (const value of raw.pages) {
    if (!isRecord(value) || typeof value.pageDirectory !== 'string' ||
        typeof value.slug !== 'string') return fail('WIKI_CONTRACT_INVALID', projectId);
    actual.push(pageRef(`${value.pageDirectory}/${value.slug}`, projectId));
  }
  if (raw.profile !== undefined) {
    const profile = isRecord(raw.profile) ? raw.profile : fail('WIKI_CONTRACT_INVALID', projectId);
    if (!Array.isArray(profile.entityPages)) return fail('WIKI_CONTRACT_INVALID', projectId);
    for (const value of profile.entityPages) {
      if (!isRecord(value) || typeof value.id !== 'string') {
        return fail('WIKI_CONTRACT_INVALID', projectId);
      }
      actual.push(pageRef(value.id, projectId));
    }
  }
  const canonicalActual = [...actual].sort();
  const expected = snapshot.pages.map((page) => pageRef(page.pageId, projectId)).sort();
  if (new Set(canonicalActual).size !== canonicalActual.length ||
      serializeCanonicalJson(canonicalActual) !== serializeCanonicalJson(expected)) {
    return fail('WIKI_CONTRACT_INVALID', projectId);
  }
}

function verifyRawExportPage(
  raw: unknown,
  page: SearchCorpusPage,
  projectId: string,
  verifiedPromotion: boolean,
): void {
  const requested = pageRef(page.pageId, projectId);
  const exported = rawExportPage(raw, requested, projectId);
  if (exported === null) return fail('WIKI_CONTRACT_INVALID', projectId);
  const frontmatter = isRecord(exported.frontmatter) ? exported.frontmatter : undefined;
  const title = exported.title ?? frontmatter?.title;
  const summaryText = exported.summary ?? frontmatter?.summary;
  if (safeText(exported.body, 1_048_576, projectId, true) !== page.body ||
      safeText(title, 512, projectId, true) !== page.title ||
      safeText(summaryText, 4_000, projectId, true) !== page.summary) {
    return fail('WIKI_CONTRACT_INVALID', projectId);
  }
  const sourceInventory = exported.sources ?? exported.sourceRefs ?? frontmatter?.sourceRefs;
  if (!Array.isArray(sourceInventory) || sourceInventory.length > 100) {
    return fail('WIKI_CONTRACT_INVALID', projectId);
  }
  const rawSourceRefs = sourceInventory.map((sourceRef) => {
    const value = safeText(sourceRef, 512, projectId);
    try {
      return validatePortableSourceRef(value);
    } catch {
      return fail('WIKI_CONTRACT_INVALID', projectId);
    }
  });
  if (new Set(rawSourceRefs).size !== rawSourceRefs.length) {
    return fail('WIKI_CONTRACT_INVALID', projectId);
  }
  const exportedSourceRefs = verifiedPromotion
    ? rawSourceRefs.filter((sourceRef) => !sourceRef.startsWith('okf:'))
    : rawSourceRefs;
  const expectedSourceRefs = [...page.sourceRefs].sort();
  const canonicalSourceRefs = [...new Set(exportedSourceRefs)].sort();
  if (exportedSourceRefs.length !== canonicalSourceRefs.length ||
      serializeCanonicalJson(canonicalSourceRefs) !== serializeCanonicalJson(expectedSourceRefs)) {
    return fail('WIKI_CONTRACT_INVALID', projectId);
  }
  if (exported.citations !== undefined) {
    const citations = inspectSessionExportCitations(exported.citations);
    if (citations === null || citations.canonical.some((citation) =>
      !canonicalSourceRefs.includes(citation.file))) {
      return fail('WIKI_CITATION_INVALID', projectId);
    }
  }
}

function proofsForSnapshot(
  proofs: readonly SessionPromotionProofV1[],
  snapshot: SearchCorpus,
  projectId: string,
): ReadonlyMap<string, SessionPromotionProofV1> {
  const pages = new Set(snapshot.pages.map((page) => page.pageId));
  const result = new Map<string, SessionPromotionProofV1>();
  for (const proof of proofs) {
    if (proof.projectId !== projectId || !pages.has(proof.pageId) || result.has(proof.pageId)) {
      return fail('WIKI_CITATION_INVALID', projectId);
    }
    result.set(proof.pageId, proof);
  }
  return result;
}

async function proofCitations(
  proof: SessionPromotionProofV1,
  page: SearchCorpusPage,
  sourceAdapters: SourceAdapterRegistry,
  workspace: string,
  projectId: string,
): Promise<readonly CitationRecordV1[]> {
  if (proof.projectId !== projectId || proof.pageId !== page.pageId ||
      proof.bodyDigest !== sessionSha256(page.body) ||
      proof.titleDigest !== sessionSha256(page.title) ||
      proof.summaryDigest !== sessionSha256(page.summary)) {
    return fail('WIKI_CITATION_INVALID', projectId);
  }
  const sourceDigests = new Map(proof.compilerSources.map((source) =>
    [source.compilerSourceId, source.compilerSourceContentDigest] as const));
  const pageSourceRefs = new Set(page.sourceRefs);
  const result: CitationRecordV1[] = [];
  for (const binding of proof.citationBindings) {
    const expectedDigest = sourceDigests.get(binding.compilerSourceId);
    if (expectedDigest === undefined || expectedDigest !== binding.compilerSourceContentDigest ||
        !pageSourceRefs.has(binding.compilerSourceId)) {
      return fail('WIKI_CITATION_INVALID', projectId);
    }
    const raw = await readConfinedSessionUtf8(
      join(workspace, 'sources', sourceFilename(binding.compilerSourceId, projectId)),
      workspace,
      SESSION_COMPILE_LIMITS.maxSourceBytes,
      projectId,
    ).catch(() => fail('WIKI_CITATION_INVALID', projectId));
    if (sessionSha256(raw) !== expectedDigest) return fail('WIKI_CITATION_INVALID', projectId);
    result.push(await citationFromStoredSource({
      citationLineEnd: binding.originalLine,
      citationLineStart: binding.originalLine,
      compilerSourceId: binding.compilerSourceId,
      expectedOriginalFile: binding.originalFile,
      ...(binding.jsonPointer === undefined ? {} : { expectedJsonPointer: binding.jsonPointer }),
      expectedQuoteDigest: binding.quoteDigest,
      pageRef: pageRef(page.pageId, projectId),
      projectId,
      sourceAdapters,
      workspace,
    }));
  }
  return Object.freeze(result.sort((left, right) =>
    left.citationId < right.citationId ? -1 : left.citationId > right.citationId ? 1 : 0));
}

async function exportedCitations(
  raw: unknown,
  page: SearchCorpusPage,
  sourceAdapters: SourceAdapterRegistry,
  workspace: string,
  projectId: string,
): Promise<readonly CitationRecordV1[]> {
  const requested = pageRef(page.pageId, projectId);
  const rawPage = rawExportPage(raw, requested, projectId);
  if (rawPage === null) return fail('WIKI_CONTRACT_INVALID', projectId);
  if (rawPage.citations === undefined) return Object.freeze([]);
  const inspected = inspectSessionExportCitations(rawPage.citations);
  if (inspected === null) return fail('WIKI_CITATION_INVALID', projectId);
  if (inspected.canonical.length === 0) return Object.freeze([]);
  const expectedCompilerSourceHashes = recordedSourceHashes(rawPage, projectId);
  if (expectedCompilerSourceHashes.size === 0) return fail('WIKI_CITATION_INVALID', projectId);
  const pageSourceRefs = new Set(page.sourceRefs);
  const result: CitationRecordV1[] = [];
  for (const citation of inspected.canonical) {
    if (citation.start === undefined || citation.end === undefined ||
        !pageSourceRefs.has(citation.file)) {
      return fail('WIKI_CITATION_INVALID', projectId);
    }
    result.push(await citationFromStoredSource({
      citationLineEnd: citation.end,
      citationLineStart: citation.start,
      compilerSourceId: citation.file,
      expectedCompilerSourceHashes,
      pageRef: requested,
      projectId,
      sourceAdapters,
      workspace,
    }));
  }
  return Object.freeze(result.sort((left, right) =>
    left.citationId < right.citationId ? -1 : left.citationId > right.citationId ? 1 : 0));
}

export function createWikiReadService(options: CreateWikiReadOptions): WikiServicePort {
  const backend = options.backend ?? createLlmWikiCompilerBackend();
  const corpus = options.corpus ?? createProjectCorpus({
    backend,
    knowledgeRoot: options.knowledgeRoot,
  });
  const reviewStoreFactory = options.reviewStoreFactory ?? createSessionReviewStore;

  interface WikiReadContext {
    readonly profileBindingDigest: `sha256:${string}`;
    readonly projectId: string;
    readonly projectDigest: `sha256:${string}`;
    readonly sourceAdapters: SourceAdapterRegistry;
    readonly workspace: string;
  }

  interface WikiCitationSnapshot {
    readonly pages: readonly WikiSnapshotPageV1[];
    readonly proofDigest: `sha256:${string}`;
  }

  async function context(projectIdInput: string): Promise<Readonly<WikiReadContext>> {
    const projectId = validateProjectId(projectIdInput);
    const record = await showProject(options.knowledgeRoot, projectId);
    const workspace = await resolveProjectWorkspace(options.knowledgeRoot, projectId, {
      mustExist: true,
    });
    const profile = await resolveRegisteredProfileBinding(options.knowledgeRoot, projectId, {
      registrations: options.sourceAdapterRegistrations ?? [],
    });
    if (record.entry.projectId !== projectId || profile.workspace !== workspace) {
      return fail('WIKI_SNAPSHOT_CHANGED', projectId);
    }
    return Object.freeze({
      profileBindingDigest: profile.bindingDigest,
      projectDigest: sha256(serializeCanonicalJson({
        descriptor: record.descriptor,
        entry: record.entry,
      })),
      projectId,
      sourceAdapters: profile.sourceAdapters,
      workspace,
    });
  }

  async function assertContextUnchanged(initial: WikiReadContext): Promise<void> {
    let current: Readonly<WikiReadContext>;
    try {
      current = await context(initial.projectId);
    } catch {
      return fail('WIKI_SNAPSHOT_CHANGED', initial.projectId);
    }
    if (current.workspace !== initial.workspace ||
        current.profileBindingDigest !== initial.profileBindingDigest ||
        current.projectDigest !== initial.projectDigest) {
      return fail('WIKI_SNAPSHOT_CHANGED', initial.projectId);
    }
  }

  async function citationSnapshot(
    current: WikiReadContext,
    corpusSnapshot: SearchCorpus,
  ): Promise<WikiCitationSnapshot> {
    const proofs = await reviewStoreFactory(current.workspace, current.projectId).listProofs()
      .catch(() => fail('WIKI_CITATION_INVALID', current.projectId));
    const canonicalProofs = Object.freeze([...proofs].sort((left, right) =>
      left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0));
    const proofsByPage = proofsForSnapshot(canonicalProofs, corpusSnapshot, current.projectId);
    let exported: unknown;
    try {
      exported = await backend.exportProject(current.workspace, current.projectId);
    } catch {
      return fail('WIKI_BACKEND_UNAVAILABLE', current.projectId);
    }
    if (!isRecord(exported) || exported.projectId !== current.projectId ||
        exported.schemaVersion !== 1 || !Array.isArray(exported.pages)) {
      return fail('WIKI_CONTRACT_INVALID', current.projectId);
    }
    assertRawExportInventory(exported, corpusSnapshot, current.projectId);
    for (const page of corpusSnapshot.pages) {
      verifyRawExportPage(
        exported,
        page,
        current.projectId,
        proofsByPage.has(page.pageId),
      );
    }
    const pages: WikiSnapshotPageV1[] = [];
    for (const page of corpusSnapshot.pages) {
      const requested = pageRef(page.pageId, current.projectId);
      const proof = proofsByPage.get(page.pageId);
      const citations = proof === undefined
        ? await exportedCitations(
            exported,
            page,
            current.sourceAdapters,
            current.workspace,
            current.projectId,
          )
        : await proofCitations(
            proof,
            page,
            current.sourceAdapters,
            current.workspace,
            current.projectId,
          );
      pages.push(Object.freeze({
        body: page.body,
        citations,
        pageRef: requested,
        sourceRefs: Object.freeze([...page.sourceRefs]),
        summary: page.summary,
        title: page.title,
      }));
    }
    return Object.freeze({
      pages: Object.freeze(pages),
      proofDigest: sha256(serializeCanonicalJson(canonicalProofs)),
    });
  }

  async function refreshedCitationSnapshot(
    current: WikiReadContext,
    corpusSnapshot: SearchCorpus,
  ): Promise<WikiCitationSnapshot> {
    try {
      return await citationSnapshot(current, corpusSnapshot);
    } catch {
      return fail('WIKI_SNAPSHOT_CHANGED', current.projectId);
    }
  }

  async function snapshot(projectIdInput: string): Promise<WikiSnapshotV1> {
    const current = await context(projectIdInput);
    const before = await verifiedSnapshot(corpus, current.projectId);
    const sdkPages = await collectSdkPages(
      backend,
      current.workspace,
      current.projectId,
      true,
    );
    verifySdkPages(sdkPages, before, true, current.projectId);
    const initialCitations = await citationSnapshot(current, before);
    const after = await verifiedSnapshot(corpus, current.projectId);
    if (!snapshotsMatch(before, after)) return fail('WIKI_SNAPSHOT_CHANGED', current.projectId);
    const finalCitations = await refreshedCitationSnapshot(current, after);
    if (serializeCanonicalJson(finalCitations) !== serializeCanonicalJson(initialCitations)) {
      return fail('WIKI_SNAPSHOT_CHANGED', current.projectId);
    }
    await assertContextUnchanged(current);
    return Object.freeze({
      digest: sha256(serializeCanonicalJson({
        corpusDigest: snapshotDigest(before),
        pages: initialCitations.pages,
        projectId: current.projectId,
      })),
      pages: initialCitations.pages,
      projectId: current.projectId,
    });
  }

  return Object.freeze({
    async citations(input: WikiPageInput): Promise<WikiCitationsResultV1> {
      const current = await context(input.projectId);
      const requested = pageRef(input.pageRef, current.projectId);
      const before = await verifiedSnapshot(corpus, current.projectId);
      findPage(before, requested, current.projectId);
      const initialCitations = await citationSnapshot(current, before);
      const after = await verifiedSnapshot(corpus, current.projectId);
      if (!snapshotsMatch(before, after)) return fail('WIKI_SNAPSHOT_CHANGED', current.projectId);
      const finalCitations = await refreshedCitationSnapshot(current, after);
      if (serializeCanonicalJson(finalCitations) !== serializeCanonicalJson(initialCitations)) {
        return fail('WIKI_SNAPSHOT_CHANGED', current.projectId);
      }
      await assertContextUnchanged(current);
      const citations = initialCitations.pages.find((page) => page.pageRef === requested)?.citations ??
        fail('WIKI_PAGE_NOT_FOUND', current.projectId);
      return Object.freeze({
        citations,
        pageRef: requested,
        projectId: current.projectId,
        schemaVersion: WIKI_CITATIONS_SCHEMA_VERSION,
      });
    },

    async list(input: WikiListInput): Promise<WikiListResultV1> {
      const current = await context(input.projectId);
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        return fail('WIKI_CURSOR_INVALID', current.projectId);
      }
      const before = await verifiedSnapshot(corpus, current.projectId);
      const initialCitations = await citationSnapshot(current, before);
      const sdkPages = await collectSdkPages(
        backend,
        current.workspace,
        current.projectId,
        true,
      );
      verifySdkPages(sdkPages, before, true, current.projectId);
      const digest = snapshotDigest(before);
      const offset = input.cursor === undefined
        ? 0
        : decodeCursor(input.cursor, digest, current.projectId).offset;
      if (offset > before.pages.length) return fail('WIKI_CURSOR_INVALID', current.projectId);
      const selected = before.pages.slice(offset, offset + limit);
      const nextOffset = offset + selected.length;
      const after = await verifiedSnapshot(corpus, current.projectId);
      if (!snapshotsMatch(before, after)) return fail('WIKI_SNAPSHOT_CHANGED', current.projectId);
      const finalCitations = await refreshedCitationSnapshot(current, after);
      if (serializeCanonicalJson(finalCitations) !== serializeCanonicalJson(initialCitations)) {
        return fail('WIKI_SNAPSHOT_CHANGED', current.projectId);
      }
      await assertContextUnchanged(current);
      return Object.freeze({
        ...(nextOffset < before.pages.length
          ? { cursor: encodeCursor({ digest, offset: nextOffset, version: 1 }) }
          : {}),
        pages: Object.freeze(selected.map((page) => summary(page, current.projectId))),
        projectId: current.projectId,
        schemaVersion: WIKI_LIST_SCHEMA_VERSION,
        total: before.pages.length,
      });
    },

    async read(input: WikiPageInput): Promise<WikiPageV1> {
      const current = await context(input.projectId);
      const requested = pageRef(input.pageRef, current.projectId);
      const before = await verifiedSnapshot(corpus, current.projectId);
      const page = findPage(before, requested, current.projectId);
      const initialCitations = await citationSnapshot(current, before);
      if (requested.startsWith('concepts/') || requested.startsWith('queries/')) {
        await verifyDefaultPage(backend, current.workspace, page, current.projectId);
      } else {
        const sdkPages = await collectSdkPages(
          backend,
          current.workspace,
          current.projectId,
          true,
        );
        verifySdkPages(sdkPages, before, true, current.projectId);
      }
      const after = await verifiedSnapshot(corpus, current.projectId);
      if (!snapshotsMatch(before, after)) return fail('WIKI_SNAPSHOT_CHANGED', current.projectId);
      const finalCitations = await refreshedCitationSnapshot(current, after);
      if (serializeCanonicalJson(finalCitations) !== serializeCanonicalJson(initialCitations)) {
        return fail('WIKI_SNAPSHOT_CHANGED', current.projectId);
      }
      await assertContextUnchanged(current);
      return Object.freeze({
        ...summary(page, current.projectId),
        body: page.body,
        sourceRefs: Object.freeze([...page.sourceRefs]),
      });
    },

    snapshot,
  });
}
