import { createWiki } from 'llm-wiki-compiler';
import { lstat, open, mkdir, mkdtemp, opendir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { parse, stringify } from 'yaml';

import { compareSessionText, sessionSha256 } from './canonical.js';
import { SESSION_COMPILE_LIMITS } from './contracts.js';
import { SessionCompileError } from './errors.js';
import {
  listConfinedSessionFiles,
  readConfinedSessionUtf8,
} from './safe-io.js';
import type { ValidatedSessionBatch, ValidatedSessionProposal } from './validator.js';
import type {
  SessionCompileApplyResultV1,
  SessionRequestedPageKind,
} from './types.js';
import { SESSION_COMPILE_APPLY_RESULT_SCHEMA_VERSION } from './types.js';

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface SessionCompileAdmissionPort {
  importOkf(
    workspace: string,
    bundle: string,
    options: { readonly dryRun?: boolean; readonly trusted: false },
  ): Promise<unknown>;
}

export interface SessionCompileAdmission {
  stage(
    workspace: string,
    projectId: string,
    profileMode: 'custom' | 'default',
    batch: ValidatedSessionBatch,
    beforeActual?: () => Promise<void>,
  ): Promise<SessionCompileApplyResultV1>;
}

export interface CreateSessionCompileAdmissionOptions {
  readonly port?: SessionCompileAdmissionPort;
  /** @internal Fault seam for temporary cleanup verification. */
  readonly removeTemporary?: (path: string) => Promise<void>;
}

function defaultAdmissionPort(): SessionCompileAdmissionPort {
  return {
    async importOkf(workspace, bundle, options): Promise<unknown> {
      return createWiki({ root: workspace }).importOkf(bundle, options);
    },
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function directoryFor(kind: SessionRequestedPageKind): string {
  switch (kind) {
    case 'concept':
      return 'concepts';
    case 'query':
      return 'queries';
    case 'decision':
      return 'decisions';
    case 'failure':
      return 'failures';
    case 'verification':
      return 'verifications';
  }
}

function entityTypeFor(kind: SessionRequestedPageKind): string | undefined {
  return kind === 'concept' || kind === 'query' ? undefined : directoryFor(kind);
}

function markdownLiteral(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function citationBody(page: ValidatedSessionProposal): string {
  const definitions = page.proposal.citations.map((citation) =>
    '[^' + citation.id + ']: ' + markdownLiteral(citation.file) + ':' +
      String(citation.line) + ' — ' + markdownLiteral(citation.quote));
  const body = page.proposal.body;
  return definitions.length === 0
    ? body + (body.endsWith('\n') ? '' : '\n')
    : body + (body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n') +
      definitions.join('\n') + '\n';
}

function okfFrontmatter(page: ValidatedSessionProposal): Readonly<Record<string, unknown>> {
  const proposal = page.proposal;
  const entityType = entityTypeFor(proposal.kind);
  const fields: Record<string, unknown> = {
    confidence: proposal.confidence,
    provenanceState: proposal.sources.length > 1 ? 'merged' : 'extracted',
    sourceRefs: proposal.citations.length === 0
      ? proposal.sources
      : [...new Set(proposal.citations.map((citation) => citation.file))].sort(),
    sourceRevision: proposal.planDigest,
    ...(proposal.profileFields ?? {}),
  };
  const xLlmwiki: Record<string, unknown> = {
    buildlore: page.provenance,
    confidence: proposal.confidence,
    fields,
    sources: proposal.sources,
    ...(entityType === undefined
      ? { pageDirectory: directoryFor(proposal.kind) }
      : { entityType }),
  };
  return Object.freeze({
    type: proposal.kind,
    title: proposal.title,
    description: proposal.summary,
    'x-llmwiki': xLlmwiki,
  });
}

function okfPage(page: ValidatedSessionProposal): string {
  const frontmatter = okfFrontmatter(page);
  const yaml = stringify(frontmatter, { lineWidth: 0, sortMapEntries: true }).trimEnd();
  return '---\n' + yaml + '\n---\n' + citationBody(page);
}

function renderedPageMatches(page: ValidatedSessionProposal, rendered: string): boolean {
  const marker = '\n---\n';
  const end = rendered.indexOf(marker, 4);
  if (!rendered.startsWith('---\n') || end < 0) return false;
  try {
    const parsed: unknown = parse(rendered.slice(4, end));
    const reparsedYaml = stringify(parsed, { lineWidth: 0, sortMapEntries: true }).trimEnd();
    const expectedYaml = stringify(okfFrontmatter(page), {
      lineWidth: 0,
      sortMapEntries: true,
    }).trimEnd();
    return reparsedYaml === expectedYaml &&
      rendered.slice(end + marker.length) === citationBody(page);
  } catch {
    return false;
  }
}

function okfIndex(): string {
  return '---\nokf_version: "0.1"\n---\n\n# BuildLore Session Compile Bundle\n';
}

async function exclusiveWrite(path: string, bytes: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function createBundle(
  batch: ValidatedSessionBatch,
  projectId: string,
  removeTemporary: (path: string) => Promise<void>,
): Promise<Readonly<{ readonly parent: string; readonly root: string }>> {
  const parent = await mkdtemp(join(tmpdir(), 'buildlore-session-'));
  try {
    const canonicalParent = await realpath(parent);
    const root = join(canonicalParent, 'bundle-' + batch.batchDigest.slice('sha256:'.length));
    await mkdir(root, { mode: 0o700 });
    await exclusiveWrite(join(root, 'index.md'), okfIndex());
    for (const page of batch.pages) {
      const path = join(root, page.proposal.pageId + '.md');
      if (!isContained(root, path)) {
        throw new SessionCompileError('SESSION_ADMISSION_FAILED', page.proposal.projectId);
      }
      await mkdir(dirname(path), { mode: 0o700, recursive: true });
      const rendered = okfPage(page);
      await exclusiveWrite(path, rendered);
      const persisted = await readFile(path, 'utf8');
      if (sessionSha256(persisted) !== sessionSha256(rendered) ||
          !renderedPageMatches(page, persisted)) {
        throw new SessionCompileError('SESSION_ADMISSION_FAILED', page.proposal.projectId);
      }
    }
    return Object.freeze({ parent: canonicalParent, root });
  } catch (error) {
    try {
      await removeTemporary(parent);
    } catch {
      throw new SessionCompileError('SESSION_ADMISSION_FAILED', projectId, {
        recoveryAction: 'status',
        sideEffectsPossible: true,
      });
    }
    throw error;
  }
}

async function bundleStillMatches(
  batch: ValidatedSessionBatch,
  root: string,
  projectId: string,
): Promise<boolean> {
  let rootHandle;
  try {
    const [status, canonicalRoot] = await Promise.all([lstat(root), realpath(root)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonicalRoot !== root) return false;
    const expectedDirectories = new Map<string, string[]>();
    for (const page of batch.pages) {
      const [directory, name, extra] = page.proposal.pageId.split('/');
      if (directory === undefined || name === undefined || extra !== undefined) return false;
      const names = expectedDirectories.get(directory) ?? [];
      names.push(name + '.md');
      expectedDirectories.set(directory, names);
    }
    const expectedRootNames = ['index.md', ...expectedDirectories.keys()]
      .sort(compareSessionText);
    rootHandle = await opendir(root);
    const rootNames: string[] = [];
    for await (const entry of rootHandle) {
      if (entry.isSymbolicLink() ||
          (entry.name === 'index.md' ? !entry.isFile() : !entry.isDirectory())) return false;
      rootNames.push(entry.name);
      if (rootNames.length > expectedRootNames.length) return false;
    }
    rootNames.sort(compareSessionText);
    if (JSON.stringify(rootNames) !== JSON.stringify(expectedRootNames)) return false;
    if (await readConfinedSessionUtf8(
      join(root, 'index.md'),
      root,
      SESSION_COMPILE_LIMITS.maxSourceBytes,
      projectId,
    ) !== okfIndex()) return false;
    for (const [directory, expectedNames] of expectedDirectories) {
      const directoryPath = join(root, directory);
      const actualNames = await listConfinedSessionFiles(
        directoryPath,
        root,
        projectId,
        SESSION_COMPILE_LIMITS.maxProposals,
      );
      expectedNames.sort(compareSessionText);
      if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) return false;
    }
    for (const page of batch.pages) {
      const rendered = await readConfinedSessionUtf8(
        join(root, page.proposal.pageId + '.md'),
        root,
        SESSION_COMPILE_LIMITS.maxPlanBytes,
        projectId,
      );
      if (rendered !== okfPage(page) || !renderedPageMatches(page, rendered)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    await rootHandle?.close().catch(() => undefined);
  }
}

function safeReportArray(report: UnknownRecord, key: string): readonly unknown[] | null {
  const value = report[key];
  return Array.isArray(value) ? value : null;
}

function noUnexpectedSections(report: UnknownRecord): boolean {
  const allowedKeys = new Set([
    'mode',
    'nextAction',
    'pages',
    'relationOutcomes',
    'skipped',
    'typed',
    'warnings',
  ]);
  const warnings = safeReportArray(report, 'warnings');
  const skipped = safeReportArray(report, 'skipped');
  const relations = report.relationOutcomes;
  return Object.keys(report).every((key) => allowedKeys.has(key)) &&
    (report.nextAction === undefined || typeof report.nextAction === 'string') &&
    warnings !== null && warnings.length === 0 &&
    skipped !== null && skipped.length === 0 &&
    (relations === undefined || (Array.isArray(relations) && relations.length === 0));
}

function defaultReportMatches(
  report: UnknownRecord,
  mode: 'dry-run' | 'staged',
  batch: ValidatedSessionBatch,
): boolean {
  const pages = safeReportArray(report, 'pages');
  if (report.mode !== mode || pages === null || pages.length !== batch.pages.length ||
      report.typed !== undefined || !noUnexpectedSections(report)) return false;
  const expected = batch.pages.map((page) => ({
    okfPath: page.proposal.pageId + '.md',
    slug: page.proposal.slug,
    targetDirectory: directoryFor(page.proposal.kind),
  })).sort((left, right) => left.okfPath < right.okfPath ? -1 : left.okfPath > right.okfPath ? 1 : 0);
  const actual = pages.map((value) => {
    if (!isRecord(value) || typeof value.okfPath !== 'string' ||
        typeof value.slug !== 'string' || typeof value.targetDirectory !== 'string') return null;
    return {
      okfPath: value.okfPath,
      slug: value.slug,
      targetDirectory: value.targetDirectory,
    };
  }).sort((left, right) => compareSessionText(
    String(left?.okfPath),
    String(right?.okfPath),
  ));
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function customReportMatches(
  report: UnknownRecord,
  mode: 'dry-run' | 'staged',
  batch: ValidatedSessionBatch,
): boolean {
  const pages = safeReportArray(report, 'pages');
  const typed = safeReportArray(report, 'typed');
  if (report.mode !== mode || pages === null || pages.length !== 0 || typed === null ||
      typed.length !== batch.pages.length || !noUnexpectedSections(report)) return false;
  const expected = batch.pages.map((page) => ({
    entityType: directoryFor(page.proposal.kind),
    okfPath: page.proposal.pageId + '.md',
    outcome: 'staged-typed',
    slug: page.proposal.slug,
  })).sort((left, right) => left.okfPath < right.okfPath ? -1 : left.okfPath > right.okfPath ? 1 : 0);
  const actual = typed.map((value) => {
    if (!isRecord(value) || typeof value.entityType !== 'string' ||
        typeof value.okfPath !== 'string' || value.outcome !== 'staged-typed' ||
        typeof value.slug !== 'string' || value.reason !== undefined) return null;
    return {
      entityType: value.entityType,
      okfPath: value.okfPath,
      outcome: value.outcome,
      slug: value.slug,
    };
  }).sort((left, right) => compareSessionText(
    String(left?.okfPath),
    String(right?.okfPath),
  ));
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function reportMatches(
  report: unknown,
  mode: 'dry-run' | 'staged',
  profileMode: 'custom' | 'default',
  batch: ValidatedSessionBatch,
): boolean {
  if (!isRecord(report)) return false;
  return profileMode === 'default'
    ? defaultReportMatches(report, mode, batch)
    : customReportMatches(report, mode, batch);
}

function candidateRefsFromReport(
  report: unknown,
  batch: ValidatedSessionBatch,
): readonly string[] {
  if (!isRecord(report)) return Object.freeze([]);
  const expected = new Map(batch.pages.map((page) => [
    page.proposal.pageId + '.md',
    page.proposal,
  ] as const));
  const refs = [...(safeReportArray(report, 'pages') ?? []),
    ...(safeReportArray(report, 'typed') ?? [])].flatMap((value) => {
    if (!isRecord(value) || typeof value.okfPath !== 'string' ||
        typeof value.slug !== 'string') return [];
    const proposal = expected.get(value.okfPath);
    return proposal?.slug === value.slug ? [proposal.pageId] : [];
  });
  return Object.freeze([...new Set(refs)].sort());
}

export function createSessionCompileAdmission(
  options: CreateSessionCompileAdmissionOptions = {},
): SessionCompileAdmission {
  const port = options.port ?? defaultAdmissionPort();
  const removeTemporary = options.removeTemporary ?? (async (path: string) =>
    rm(path, { recursive: true }));
  return {
    async stage(
      workspace,
      projectId,
      profileMode,
      batch,
      beforeActual,
    ): Promise<SessionCompileApplyResultV1> {
      const firstPage = batch.pages[0];
      if (firstPage === undefined) {
        throw new SessionCompileError('SESSION_ADMISSION_FAILED', projectId);
      }
      let temporary: Awaited<ReturnType<typeof createBundle>> | undefined;
      let result: SessionCompileApplyResultV1 | undefined;
      let failure: SessionCompileError | undefined;
      try {
        temporary = await createBundle(batch, projectId, removeTemporary);
        const dryRun = await port.importOkf(workspace, temporary.root, {
          dryRun: true,
          trusted: false,
        });
        if (!reportMatches(dryRun, 'dry-run', profileMode, batch)) {
          throw new SessionCompileError('SESSION_ADMISSION_FAILED', projectId, {
            recoveryAction: 'review',
          });
        }
        if (!await bundleStillMatches(batch, temporary.root, projectId)) {
          throw new SessionCompileError('SESSION_ADMISSION_FAILED', projectId, {
            recoveryAction: 'review',
          });
        }
        await beforeActual?.();
        if (!await bundleStillMatches(batch, temporary.root, projectId)) {
          throw new SessionCompileError('SESSION_ADMISSION_FAILED', projectId, {
            recoveryAction: 'review',
          });
        }
        let actual: unknown;
        try {
          actual = await port.importOkf(workspace, temporary.root, { trusted: false });
        } catch {
          throw new SessionCompileError('SESSION_ADMISSION_FAILED', projectId, {
            recoveryAction: 'status',
            sideEffectsPossible: true,
          });
        }
        if (!reportMatches(actual, 'staged', profileMode, batch)) {
          throw new SessionCompileError('SESSION_ADMISSION_FAILED', projectId, {
            candidateRefs: candidateRefsFromReport(actual, batch),
            recoveryAction: 'status',
            sideEffectsPossible: true,
          });
        }
        result = Object.freeze({
          schemaVersion: SESSION_COMPILE_APPLY_RESULT_SCHEMA_VERSION,
          projectId,
          planDigest: firstPage.proposal.planDigest,
          batchDigest: batch.batchDigest,
          outcome: 'staged',
          reviewRequired: true,
          admissionKind: 'untrusted-okf',
          admittedCount: batch.pages.length,
          heldCount: batch.pages.length,
          skippedCount: 0,
          candidateRefs: Object.freeze(
            batch.pages.map((page) => page.proposal.pageId).sort(),
          ),
          sideEffectsPossible: false,
          recoveryAction: 'review',
          warnings: Object.freeze([]),
        });
      } catch (error) {
        failure = error instanceof SessionCompileError
          ? error
          : new SessionCompileError('SESSION_ADMISSION_FAILED', projectId);
      }
      if (temporary !== undefined) {
        try {
          await removeTemporary(temporary.parent);
        } catch {
          const candidateRefs = failure !== undefined && failure.candidateRefs.length > 0
            ? failure.candidateRefs
            : result?.candidateRefs ?? [];
          failure = new SessionCompileError('SESSION_ADMISSION_FAILED', projectId, {
            candidateRefs,
            recoveryAction: 'status',
            sideEffectsPossible: true,
          });
        }
      }
      if (failure !== undefined) throw failure;
      if (result === undefined) {
        throw new SessionCompileError('SESSION_ADMISSION_FAILED', projectId);
      }
      return result;
    },
  };
}
