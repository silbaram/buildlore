import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { parseDocument } from 'yaml';

import { createLlmWikiCompilerBackend } from '../compiler/backend.js';
import type { CompilerWikiBackend } from '../compiler/types.js';
import { serializeCanonicalJson, syncDirectory } from '../knowledge/atomic-file.js';
import { decodeUtf8Strict } from '../knowledge/strict-json.js';
import {
  readLocalProjectRegistry,
  resolveLocalProjectBinding,
} from '../knowledge/local-project-registry.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { validateProjectId } from '../knowledge/validation.js';
import { showProject } from '../knowledge/workspace.js';
import { consumePreparedSource } from '../sanitizer/approval.js';
import { createProjectSecurityService } from '../sanitizer/service.js';
import type { ProjectSecurityService } from '../sanitizer/types.js';
import { validatePortableSourceRef } from '../projector/source-contracts.js';
import { WikiOperationError } from './errors.js';
import { createWikiReadService } from './service.js';
import {
  WIKI_EXPORT_SCHEMA_VERSION,
  type CitationRecordV1,
  type WikiExportInput,
  type WikiExportPort,
  type WikiExportResultV1,
  type WikiJsonExportV1,
  type WikiPageRef,
  type WikiSnapshotPort,
  type WikiSnapshotV1,
} from './types.js';

const MAX_EXPORT_FILES = 8_192;
const MAX_EXPORT_FILE_BYTES = 2 * 1_048_576;
const MAX_EXPORT_TOTAL_BYTES = 32 * 1_048_576;
const SAFE_EXPORT_EXTENSIONS = new Set(['.json', '.jsonl', '.md', '.yaml', '.yml']);
const CITATION_ID_PATTERN = /^citation-[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PAGE_REF_PATTERN = /^(?:concepts|decisions|failures|queries|verifications)\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;

type UnknownRecord = Readonly<Record<string, unknown>>;

interface ExportFile {
  readonly body: string;
  readonly digest: `sha256:${string}`;
  readonly path: string;
}

interface ExportFileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
}

interface ReadExportFile {
  readonly body: string;
  readonly bytes: Uint8Array;
  readonly identity: ExportFileIdentity;
}

interface ExportBindingSnapshot {
  readonly bindingDigest: `sha256:${string}`;
  readonly projectId: string;
  readonly sourceRoot: string;
}

interface ExportDestination {
  readonly outputRoot: string;
  readonly parent: string;
  readonly parentDevice: number;
  readonly parentInode: number;
  readonly state: 'absent' | 'empty';
}

export interface CreateWikiExportOptions {
  readonly backend?: CompilerWikiBackend;
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly securityService?: ProjectSecurityService;
  readonly wiki?: WikiSnapshotPort;
}

function fail(
  code: ConstructorParameters<typeof WikiOperationError>[0],
  projectId: string,
  options: { readonly sideEffectsPossible?: boolean } = {},
): never {
  throw new WikiOperationError(code, projectId, options);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function canonicalDirectory(
  path: string,
  projectId: string,
): Promise<Readonly<{ readonly device: number; readonly inode: number; readonly path: string }>> {
  try {
    const [status, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== resolve(path)) {
      return fail('WIKI_EXPORT_DESTINATION_INVALID', projectId);
    }
    return Object.freeze({ device: status.dev, inode: status.ino, path: canonical });
  } catch (error) {
    if (error instanceof WikiOperationError) throw error;
    return fail('WIKI_EXPORT_DESTINATION_INVALID', projectId);
  }
}

async function destinationState(
  outputRoot: string,
  projectId: string,
): Promise<'absent' | 'empty'> {
  try {
    const [status, canonical, entries] = await Promise.all([
      lstat(outputRoot),
      realpath(outputRoot),
      readdir(outputRoot),
    ]);
    if (!status.isDirectory() || status.isSymbolicLink() ||
        canonical !== outputRoot || entries.length > 0) {
      return fail('WIKI_EXPORT_DESTINATION_INVALID', projectId);
    }
    return 'empty';
  } catch (error) {
    if (error instanceof WikiOperationError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return 'absent';
    }
    return fail('WIKI_EXPORT_DESTINATION_INVALID', projectId);
  }
}

async function resolveDestination(input: {
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly outputRoot: string;
  readonly projectId: string;
  readonly sourceRoots: readonly string[];
}): Promise<ExportDestination> {
  const outputRoot = resolve(input.hubRoot, input.outputRoot);
  const knowledgeRoot = resolve(input.knowledgeRoot);
  const protectedRoots = [
    knowledgeRoot,
    ...input.sourceRoots.map((sourceRoot) => resolve(sourceRoot)),
    resolve(input.hubRoot, '.buildlore'),
    resolve(input.hubRoot, '.git'),
  ];
  if (outputRoot === resolve(outputRoot, '..') ||
      protectedRoots.some((root) =>
        isContained(root, outputRoot) || isContained(outputRoot, root))) {
    return fail('WIKI_EXPORT_DESTINATION_INVALID', input.projectId);
  }
  const parent = await canonicalDirectory(dirname(outputRoot), input.projectId);
  if (join(parent.path, basename(outputRoot)) !== outputRoot) {
    return fail('WIKI_EXPORT_DESTINATION_INVALID', input.projectId);
  }
  return Object.freeze({
    outputRoot,
    parent: parent.path,
    parentDevice: parent.device,
    parentInode: parent.inode,
    state: await destinationState(outputRoot, input.projectId),
  });
}

async function bindingSnapshot(
  hubRoot: string,
  projectId: string,
): Promise<readonly ExportBindingSnapshot[]> {
  const registry = await readLocalProjectRegistry(hubRoot);
  const snapshots = await Promise.all(registry.bindings.map(async (binding) => {
    const resolvedBinding = await resolveLocalProjectBinding(hubRoot, binding.projectId);
    const sourceRoot = resolvedBinding.checkout.resolveRootForInternalUse();
    if (sourceRoot !== binding.sourceRoot) {
      return fail('WIKI_EXPORT_DESTINATION_INVALID', projectId);
    }
    return Object.freeze({
      bindingDigest: resolvedBinding.bindingDigest,
      projectId: binding.projectId,
      sourceRoot,
    });
  }));
  return Object.freeze(snapshots.sort((left, right) =>
    left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : 0));
}

async function assertExportBoundaryUnchanged(input: {
  readonly bindings: readonly ExportBindingSnapshot[];
  readonly destination: ExportDestination;
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly projectId: string;
}): Promise<void> {
  const currentBindings = await bindingSnapshot(input.hubRoot, input.projectId);
  if (serializeCanonicalJson(currentBindings) !== serializeCanonicalJson(input.bindings)) {
    return fail('WIKI_SNAPSHOT_CHANGED', input.projectId);
  }
  const protectedRoots = [
    resolve(input.knowledgeRoot),
    ...currentBindings.map((binding) => resolve(binding.sourceRoot)),
    resolve(input.hubRoot, '.buildlore'),
    resolve(input.hubRoot, '.git'),
  ];
  if (protectedRoots.some((root) =>
    isContained(root, input.destination.outputRoot) ||
    isContained(input.destination.outputRoot, root))) {
    return fail('WIKI_EXPORT_DESTINATION_INVALID', input.projectId);
  }
  const parent = await canonicalDirectory(input.destination.parent, input.projectId);
  if (parent.path !== input.destination.parent ||
      parent.device !== input.destination.parentDevice ||
      parent.inode !== input.destination.parentInode ||
      await destinationState(input.destination.outputRoot, input.projectId) !==
        input.destination.state) {
    return fail('WIKI_EXPORT_DESTINATION_INVALID', input.projectId);
  }
}

function exactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function safeText(value: unknown, maximum: number, allowEmpty: boolean = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maximum &&
    value === value.normalize('NFC') && !value.includes('\r') && !value.includes('\0');
}

function safeSourceRef(value: unknown): value is string {
  if (!safeText(value, 512) || isAbsolute(value)) return false;
  try {
    return validatePortableSourceRef(value) === value;
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function collectJsonBundle(
  snapshot: WikiSnapshotV1,
  projectId: string,
): WikiJsonExportV1 {
  if (snapshot.projectId !== projectId || !DIGEST_PATTERN.test(snapshot.digest) ||
      !Array.isArray(snapshot.pages) || snapshot.pages.length > MAX_EXPORT_FILES) {
    return fail('WIKI_CONTRACT_INVALID', projectId);
  }
  const pages = snapshot.pages.map((page) => {
    if (!isRecord(page) || !exactKeys(page, [
      'body', 'citations', 'pageRef', 'sourceRefs', 'summary', 'title',
    ]) || typeof page.pageRef !== 'string' || !PAGE_REF_PATTERN.test(page.pageRef) ||
        !safeText(page.body, 1_048_576, true) || !safeText(page.summary, 4_000) ||
        !safeText(page.title, 512) || !Array.isArray(page.sourceRefs) ||
        page.sourceRefs.length > 100 || page.sourceRefs.some((ref) => !safeSourceRef(ref)) ||
        new Set(page.sourceRefs).size !== page.sourceRefs.length || !Array.isArray(page.citations) ||
        page.citations.length > 512) {
      return fail('WIKI_CONTRACT_INVALID', projectId);
    }
    const sourceRefs = Object.freeze(page.sourceRefs.map((ref) => ref as string).sort());
    const citations = page.citations.map((citation): CitationRecordV1 => {
      if (!isRecord(citation) || !exactKeys(citation, [
        'citationId', 'pageRef', 'projectId', 'range', 'sourceRef', 'sourceRevision',
      ]) || typeof citation.citationId !== 'string' || !CITATION_ID_PATTERN.test(citation.citationId) ||
          citation.pageRef !== page.pageRef || citation.projectId !== projectId ||
          !safeSourceRef(citation.sourceRef) || typeof citation.sourceRevision !== 'string' ||
          !DIGEST_PATTERN.test(citation.sourceRevision) || !isRecord(citation.range) ||
          !exactKeys(citation.range, ['endColumn', 'endLine', 'startColumn', 'startLine']) ||
          !positiveInteger(citation.range.endColumn) || !positiveInteger(citation.range.endLine) ||
          !positiveInteger(citation.range.startColumn) || !positiveInteger(citation.range.startLine) ||
          (Number(citation.range.endLine) < Number(citation.range.startLine)) ||
          (citation.range.endLine === citation.range.startLine &&
            Number(citation.range.endColumn) < Number(citation.range.startColumn))) {
        return fail('WIKI_CONTRACT_INVALID', projectId);
      }
      const range = Object.freeze({
        endColumn: Number(citation.range.endColumn),
        endLine: Number(citation.range.endLine),
        startColumn: Number(citation.range.startColumn),
        startLine: Number(citation.range.startLine),
      });
      const expectedCitationId = 'citation-' + sha256(serializeCanonicalJson({
        pageRef: page.pageRef,
        projectId,
        range,
        sourceRef: citation.sourceRef,
        sourceRevision: citation.sourceRevision,
      })).slice('sha256:'.length);
      if (citation.citationId !== expectedCitationId) {
        return fail('WIKI_CONTRACT_INVALID', projectId);
      }
      return Object.freeze({
        citationId: citation.citationId,
        pageRef: citation.pageRef as WikiPageRef,
        projectId,
        range,
        sourceRef: citation.sourceRef,
        sourceRevision: citation.sourceRevision as `sha256:${string}`,
      });
    }).sort((left, right) => left.citationId < right.citationId ? -1 : 1);
    if (new Set(citations.map((citation) => citation.citationId)).size !== citations.length) {
      return fail('WIKI_CONTRACT_INVALID', projectId);
    }
    return Object.freeze({
      body: page.body,
      citations: Object.freeze(citations),
      pageRef: page.pageRef as WikiPageRef,
      sourceRefs,
      summary: page.summary,
      title: page.title,
    });
  }).sort((left, right) => left.pageRef < right.pageRef ? -1 : 1);
  if (new Set(pages.map((page) => page.pageRef)).size !== pages.length) {
    return fail('WIKI_CONTRACT_INVALID', projectId);
  }
  return Object.freeze({
    format: 'json',
    pages: Object.freeze(pages),
    projectId,
    schemaVersion: WIKI_EXPORT_SCHEMA_VERSION,
  });
}

function validatedStructuralValues(bundle: WikiJsonExportV1): Set<string> {
  return new Set(bundle.pages.flatMap((page) =>
    page.citations.map((citation) => citation.citationId)));
}

async function removeSourceReferences(root: string, projectId: string): Promise<void> {
  const referenceRoot = join(root, 'references');
  try {
    const status = await lstat(referenceRoot);
    if (!status.isDirectory() || status.isSymbolicLink() ||
        await realpath(referenceRoot) !== referenceRoot || !isContained(root, referenceRoot)) {
      return fail('WIKI_CONTRACT_INVALID', projectId);
    }
    await rm(referenceRoot, { force: true, recursive: true });
  } catch (error) {
    if (error instanceof WikiOperationError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    return fail('WIKI_EXPORT_FAILED', projectId);
  }
}

function sameExportFile(
  status: Awaited<ReturnType<typeof lstat>>,
  identity: ExportFileIdentity,
): boolean {
  return status.isFile() && !status.isSymbolicLink() && status.nlink === 1 &&
    status.dev === identity.device && status.ino === identity.inode &&
    status.size === identity.size;
}

async function readExportFile(
  path: string,
  root: string,
  projectId: string,
): Promise<ReadExportFile> {
  let handle;
  try {
    const [expected, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 ||
        expected.size > MAX_EXPORT_FILE_BYTES || canonical !== path ||
        !isContained(root, canonical)) {
      return fail('WIKI_CONTRACT_INVALID', projectId);
    }
    const identity = Object.freeze({
      device: expected.dev,
      inode: expected.ino,
      size: expected.size,
    });
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!sameExportFile(opened, identity)) return fail('WIKI_CONTRACT_INVALID', projectId);
    const bytes = await handle.readFile();
    const completed = await handle.stat();
    if (!sameExportFile(completed, identity) || bytes.byteLength !== identity.size) {
      return fail('WIKI_CONTRACT_INVALID', projectId);
    }
    return Object.freeze({
      body: decodeUtf8Strict(bytes),
      bytes,
      identity,
    });
  } catch (error) {
    if (error instanceof WikiOperationError) throw error;
    return fail('WIKI_EXPORT_FAILED', projectId);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inventoryExport(root: string, projectId: string): Promise<readonly ExportFile[]> {
  const files: ExportFile[] = [];
  const pending = [root];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const canonical = await canonicalDirectory(directory, projectId);
    if (!isContained(root, canonical.path)) return fail('WIKI_CONTRACT_INVALID', projectId);
    let handle;
    try {
      handle = await opendir(directory);
      for await (const entry of handle) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) return fail('WIKI_CONTRACT_INVALID', projectId);
        if (entry.isDirectory()) {
          pending.push(path);
          continue;
        }
        if (!entry.isFile() || !SAFE_EXPORT_EXTENSIONS.has(extname(entry.name))) {
          return fail('WIKI_CONTRACT_INVALID', projectId);
        }
        const file = await readExportFile(path, root, projectId);
        totalBytes += file.bytes.byteLength;
        if (files.length >= MAX_EXPORT_FILES || totalBytes > MAX_EXPORT_TOTAL_BYTES) {
          return fail('WIKI_CONTRACT_INVALID', projectId);
        }
        const relativePath = relative(root, path).replaceAll('\\', '/');
        if (relativePath.startsWith('../') || relativePath.split('/').some((part) =>
          part === '' || part === '.' || part === '..')) {
          return fail('WIKI_CONTRACT_INVALID', projectId);
        }
        files.push(Object.freeze({
          body: file.body,
          digest: sha256(file.bytes),
          path: relativePath,
        }));
      }
    } catch (error) {
      if (error instanceof WikiOperationError) throw error;
      return fail('WIKI_EXPORT_FAILED', projectId);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return Object.freeze(files.sort((left, right) => left.path < right.path ? -1 : 1));
}

async function assertSanitizedFiles(
  files: readonly ExportFile[],
  security: ProjectSecurityService,
  projectId: string,
  structuralValues: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const file of files) {
    let inspectedBody = file.body;
    for (const value of structuralValues) {
      inspectedBody = inspectedBody.replaceAll(value, 'buildlore-validated-structural-digest');
    }
    const inspectedDigest = sha256(inspectedBody);
    let result;
    try {
      result = await security.prepareSource({
        body: inspectedBody,
        bodyDigest: inspectedDigest,
        projectId,
        source: `buildlore://wiki-export/${sha256(file.path).slice('sha256:'.length)}`,
        sourceKind: 'wiki',
        sourceRevisionOrContentSha256: file.digest,
      });
    } catch {
      return fail('WIKI_SECURITY_DENIED', projectId);
    }
    const prepared = result.ok ? consumePreparedSource(result.prepared) : null;
    if (!result.ok || result.report.decision !== 'include' ||
        result.report.outputDigest !== inspectedDigest || result.report.summaries.length > 0 ||
        prepared === null || prepared.approvedBody !== inspectedBody ||
        prepared.approvedBodyDigest !== inspectedDigest) {
      return fail('WIKI_SECURITY_DENIED', projectId);
    }
  }
}

function assertOkfSnapshot(
  files: readonly ExportFile[],
  snapshot: WikiSnapshotV1,
  projectId: string,
): ReadonlySet<string> {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const expectedPages = new Set(snapshot.pages.map((page) => `${page.pageRef}.md`));
  const structuralValues = new Set<string>();
  const index = byPath.get('index.md');
  if (index === undefined) return fail('WIKI_CONTRACT_INVALID', projectId);
  const frontmatterEnd = index.body.indexOf('\n---\n', 4);
  if (!index.body.startsWith('---\n') || frontmatterEnd < 0 ||
      !/^okf_version:\s*["']?0\.1["']?\s*$/mu.test(index.body.slice(4, frontmatterEnd))) {
    return fail('WIKI_CONTRACT_INVALID', projectId);
  }
  for (const path of expectedPages) {
    if (!byPath.has(path)) return fail('WIKI_CONTRACT_INVALID', projectId);
  }
  for (const page of snapshot.pages) {
    const file = byPath.get(`${page.pageRef}.md`);
    if (file === undefined) return fail('WIKI_CONTRACT_INVALID', projectId);
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(file.body);
    if (match?.[1] === undefined || match[2] === undefined) {
      return fail('WIKI_CONTRACT_INVALID', projectId);
    }
    const document = parseDocument(match[1], {
      logLevel: 'silent',
      schema: 'core',
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    });
    let metadata: unknown;
    try {
      metadata = document.errors.length === 0 && document.warnings.length === 0
        ? document.toJS({ maxAliasCount: 0 })
        : null;
    } catch {
      metadata = null;
    }
    const expectedBody = canonicalOkfBody(page.body);
    const contentHash = sha256(expectedBody).slice('sha256:'.length);
    if (!isRecord(metadata) || !isRecord(metadata['x-llmwiki']) ||
        metadata.title !== page.title || metadata.description !== page.summary ||
        metadata['x-llmwiki'].contentHash !== contentHash ||
        !sdkOkfBodyMatches(match[2], expectedBody)) {
      return fail('WIKI_CONTRACT_INVALID', projectId);
    }
    structuralValues.add(contentHash);
  }
  for (const file of files) {
    if (file.path !== 'index.md' && file.path !== 'log.md' && !expectedPages.has(file.path)) {
      return fail('WIKI_CONTRACT_INVALID', projectId);
    }
  }
  return structuralValues;
}

function canonicalOkfBody(body: string): string {
  return body.replace(/\s*$/u, '') + '\n';
}

function sdkOkfBodyMatches(exportedBody: string, expectedBody: string): boolean {
  const canonicalExported = canonicalOkfBody(exportedBody);
  if (canonicalExported === expectedBody) return true;
  if (!canonicalExported.startsWith(expectedBody)) return false;
  return /^(?:\n)?# Citations\n/u.test(canonicalExported.slice(expectedBody.length));
}

function normalizedOkfType(pageRef: WikiPageRef): string {
  const directory = pageRef.slice(0, pageRef.indexOf('/'));
  switch (directory) {
    case 'concepts': return 'concept';
    case 'decisions': return 'decision';
    case 'failures': return 'failure';
    case 'queries': return 'query';
    case 'verifications': return 'verification';
    default: return 'document';
  }
}

function renderNormalizedOkfPage(
  page: WikiJsonExportV1['pages'][number],
  projectId: string,
): string {
  const directory = page.pageRef.slice(0, page.pageRef.indexOf('/'));
  const canonicalBody = canonicalOkfBody(page.body);
  const xLlmWiki = {
    contentHash: sha256(canonicalBody).slice('sha256:'.length),
    ...(directory === 'concepts' || directory === 'queries'
      ? { pageDirectory: directory }
      : { entityType: directory }),
    schemaVersion: '0.1',
    sources: page.sourceRefs,
  };
  const xBuildLore = {
    citations: page.citations,
    pageRef: page.pageRef,
    projectId,
    schemaVersion: WIKI_EXPORT_SCHEMA_VERSION,
    sourceRefs: page.sourceRefs,
  };
  return [
    '---',
    `description: ${JSON.stringify(page.summary)}`,
    `title: ${JSON.stringify(page.title)}`,
    `type: ${JSON.stringify(normalizedOkfType(page.pageRef))}`,
    `x-buildlore: ${JSON.stringify(xBuildLore)}`,
    `x-llmwiki: ${JSON.stringify(xLlmWiki)}`,
    '---',
    canonicalBody,
  ].join('\n');
}

function renderNormalizedOkfIndex(bundle: WikiJsonExportV1): string {
  const pages = bundle.pages.map((page) => `* [${page.pageRef}](/${page.pageRef}.md)`);
  return [
    '---',
    'okf_version: "0.1"',
    `x-buildlore: ${JSON.stringify({
      pageCount: bundle.pages.length,
      projectId: bundle.projectId,
      schemaVersion: WIKI_EXPORT_SCHEMA_VERSION,
    })}`,
    '---',
    '',
    '# BuildLore Knowledge Bundle',
    '',
    ...pages,
    '',
  ].join('\n');
}

async function writeNormalizedOkf(
  root: string,
  bundle: WikiJsonExportV1,
  projectId: string,
): Promise<void> {
  try {
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, 'index.md'), renderNormalizedOkfIndex(bundle), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    for (const page of bundle.pages) {
      const path = join(root, ...`${page.pageRef}.md`.split('/'));
      await mkdir(dirname(path), { mode: 0o700, recursive: true });
      await writeFile(path, renderNormalizedOkfPage(page, projectId), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    }
  } catch {
    return fail('WIKI_EXPORT_FAILED', projectId);
  }
}

function validateOkfReport(
  report: unknown,
  stagingRoot: string,
  projectId: string,
): void {
  if (!isRecord(report) || resolve(String(report.outDir)) !== stagingRoot ||
      !Array.isArray(report.writtenPaths) || report.writtenPaths.length > MAX_EXPORT_FILES ||
      report.writtenPaths.some((path) => typeof path !== 'string' ||
        !isContained(stagingRoot, resolve(path))) ||
      !Array.isArray(report.warnings) || report.warnings.length > 0) {
    fail('WIKI_CONTRACT_INVALID', projectId);
  }
}

async function publishStaging(input: {
  readonly outputRoot: string;
  readonly parent: string;
  readonly payloadRoot: string;
  readonly projectId: string;
  readonly state: 'absent' | 'empty';
}): Promise<void> {
  let removedEmptyDestination = false;
  let published = false;
  try {
    if (input.state === 'empty') {
      await rmdir(input.outputRoot);
      removedEmptyDestination = true;
    }
    await rename(input.payloadRoot, input.outputRoot);
    published = true;
    await syncDirectory(input.parent);
  } catch {
    let rollbackFailed = false;
    if (published) {
      try {
        await rename(input.outputRoot, input.payloadRoot);
      } catch {
        rollbackFailed = true;
      }
    }
    let restoreFailed = false;
    if (removedEmptyDestination) {
      try {
        await mkdir(input.outputRoot, { mode: 0o700 });
      } catch {
        restoreFailed = true;
      }
    }
    return fail('WIKI_EXPORT_FAILED', input.projectId, {
      sideEffectsPossible: rollbackFailed || restoreFailed,
    });
  }
}

export function createWikiExportService(options: CreateWikiExportOptions): WikiExportPort {
  const backend = options.backend ?? createLlmWikiCompilerBackend();
  const wiki = options.wiki ?? createWikiReadService({
    backend: backend as ReturnType<typeof createLlmWikiCompilerBackend>,
    knowledgeRoot: options.knowledgeRoot,
  });
  const security = options.securityService ?? createProjectSecurityService({
    knowledgeRoot: options.knowledgeRoot,
  });

  return Object.freeze({
    async export(input: WikiExportInput): Promise<WikiExportResultV1> {
      const projectId = validateProjectId(input.projectId);
      if (input.format !== 'json' && input.format !== 'okf') {
        return fail('WIKI_CONTRACT_INVALID', projectId);
      }
      const record = await showProject(options.knowledgeRoot, projectId);
      const workspace = await resolveProjectWorkspace(options.knowledgeRoot, projectId, {
        mustExist: true,
      });
      const sourceBinding = await resolveLocalProjectBinding(
        options.hubRoot,
        projectId,
        record.entry.sourceRepository,
      );
      const bindings = await bindingSnapshot(options.hubRoot, projectId);
      if (!bindings.some((binding) =>
        binding.projectId === projectId &&
        binding.bindingDigest === sourceBinding.bindingDigest &&
        binding.sourceRoot === sourceBinding.checkout.resolveRootForInternalUse())) {
        return fail('WIKI_SNAPSHOT_CHANGED', projectId);
      }
      const destination = await resolveDestination({
        hubRoot: options.hubRoot,
        knowledgeRoot: options.knowledgeRoot,
        outputRoot: input.outputRoot,
        projectId,
        sourceRoots: bindings.map((binding) => binding.sourceRoot),
      });
      const initialSnapshot = await wiki.snapshot(projectId);
      const bundle = collectJsonBundle(initialSnapshot, projectId);
      await assertExportBoundaryUnchanged({
        bindings,
        destination,
        hubRoot: options.hubRoot,
        knowledgeRoot: options.knowledgeRoot,
        projectId,
      });
      const temporaryRoot = await mkdtemp(join(destination.parent, '.buildlore-export-'))
        .catch(() => fail('WIKI_EXPORT_FAILED', projectId));
      const payloadRoot = join(temporaryRoot, 'payload');
      const sdkRoot = join(temporaryRoot, 'sdk');
      try {
        if (input.format === 'json') {
          await mkdir(payloadRoot, { mode: 0o700 });
          await writeFile(
            join(payloadRoot, 'buildlore.wiki.json'),
            serializeCanonicalJson(bundle),
            { encoding: 'utf8', mode: 0o600 },
          );
        } else {
          let report: unknown;
          try {
            report = await backend.exportProjectOkf(workspace, sdkRoot);
          } catch {
            return fail('WIKI_BACKEND_UNAVAILABLE', projectId);
          }
          validateOkfReport(report, sdkRoot, projectId);
          await removeSourceReferences(sdkRoot, projectId);
          const sdkFiles = await inventoryExport(sdkRoot, projectId);
          if (sdkFiles.length === 0) return fail('WIKI_CONTRACT_INVALID', projectId);
          assertOkfSnapshot(sdkFiles, initialSnapshot, projectId);
          await writeNormalizedOkf(payloadRoot, bundle, projectId);
        }
        const files = await inventoryExport(payloadRoot, projectId);
        if (files.length === 0 || (input.format === 'json' && files.length !== 1)) {
          return fail('WIKI_CONTRACT_INVALID', projectId);
        }
        const structuralValues = validatedStructuralValues(bundle);
        if (input.format === 'okf') {
          for (const value of assertOkfSnapshot(files, initialSnapshot, projectId)) {
            structuralValues.add(value);
          }
        }
        await assertSanitizedFiles(files, security, projectId, structuralValues);
        const liveSnapshot = await wiki.snapshot(projectId);
        const liveBundle = collectJsonBundle(liveSnapshot, projectId);
        if (liveSnapshot.digest !== initialSnapshot.digest ||
            serializeCanonicalJson(liveBundle) !== serializeCanonicalJson(bundle)) {
          return fail('WIKI_SNAPSHOT_CHANGED', projectId);
        }
        const finalFiles = await inventoryExport(payloadRoot, projectId);
        if (serializeCanonicalJson(finalFiles.map((file) => ({
          digest: file.digest,
          path: file.path,
        }))) !== serializeCanonicalJson(files.map((file) => ({
          digest: file.digest,
          path: file.path,
        })))) {
          return fail('WIKI_SNAPSHOT_CHANGED', projectId);
        }
        await assertExportBoundaryUnchanged({
          bindings,
          destination,
          hubRoot: options.hubRoot,
          knowledgeRoot: options.knowledgeRoot,
          projectId,
        });
        const digest = sha256(serializeCanonicalJson(finalFiles.map((file) => ({
          digest: file.digest,
          path: file.path,
        }))));
        await publishStaging({
          ...destination,
          payloadRoot,
          projectId,
        });
        return Object.freeze({
          digest,
          fileCount: files.length,
          format: input.format,
          pageCount: bundle.pages.length,
          projectId,
          schemaVersion: WIKI_EXPORT_SCHEMA_VERSION,
        });
      } finally {
        try {
          await rm(temporaryRoot, { force: true, recursive: true });
        } catch {
          fail('WIKI_EXPORT_FAILED', projectId, { sideEffectsPossible: true });
        }
      }
    },
  });
}
