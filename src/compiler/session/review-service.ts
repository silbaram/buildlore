import { createWiki, LockUnavailableError } from 'llm-wiki-compiler';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

import { normalizeLlmWikiCompilerExport } from '../export-normalizer.js';
import { compareSessionText, digestSessionValue, sessionSha256 } from './canonical.js';
import {
  SessionCompileError,
  type SessionExportInspectionDiagnostic,
  type SessionExportMismatchField,
  type SessionExportMismatchKind,
} from './errors.js';
import {
  inspectSessionExportCitations,
  type SessionExportCitation,
  type SessionExportCitationInspection,
} from './export-citations.js';
import {
  countLegacyUpstreamCandidates,
  createSessionReviewStore,
  finalizeSessionPromotionProof,
  type SessionReviewStore,
} from './review-store.js';
import type { SessionCompilePlanSnapshot } from './source-planner.js';
import {
  SESSION_CANDIDATE_APPROVAL_SCHEMA_VERSION,
  SESSION_CANDIDATE_LIST_SCHEMA_VERSION,
  type SessionCompileApproveResultV1,
  type SessionCompileCandidatesResultV1,
  type SessionPromotionProofV1,
  type SessionReviewCandidateV1,
} from './types.js';

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface SessionReviewServicePort {
  exportJson(workspace: string, projectId: string): Promise<unknown>;
  importOkf(
    workspace: string,
    bundle: string,
    options: { readonly trusted: true },
  ): Promise<unknown>;
  promoteStagedPage(workspace: string, candidateId: string): Promise<void>;
}

export interface SessionReviewService {
  list(workspace: string, projectId: string): Promise<SessionCompileCandidatesResultV1>;
  approve(
    workspace: string,
    projectId: string,
    candidateId: string,
    refreshSnapshot: () => Promise<SessionCompilePlanSnapshot>,
  ): Promise<SessionCompileApproveResultV1>;
}

export interface CreateSessionReviewServiceOptions {
  readonly port?: SessionReviewServicePort;
  readonly storeFactory?: (workspace: string, projectId: string) => SessionReviewStore;
  /** @internal Fault seam for temporary cleanup verification. */
  readonly removeTemporary?: (path: string) => Promise<void>;
}

interface VerifiedExportPage {
  readonly body: string;
  readonly citations: readonly SessionExportCitation[];
  readonly contentHash: string;
  readonly sourceHashes: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly summary: string;
  readonly title: string;
}

type ExportInspection =
  | Readonly<{ readonly kind: 'absent' }>
  | Readonly<{ readonly kind: 'match'; readonly page: VerifiedExportPage }>
  | Readonly<{
    readonly diagnostic: SessionExportInspectionDiagnostic;
    readonly kind: 'mismatch';
  }>;

function defaultPort(): SessionReviewServicePort {
  const port: SessionReviewServicePort = {
    async exportJson(workspace, projectId): Promise<unknown> {
      return normalizeLlmWikiCompilerExport(
        await createWiki({ root: workspace }).exportJson({ projectId }),
      );
    },
    async importOkf(workspace, bundle, options): Promise<unknown> {
      return createWiki({ root: workspace }).importOkf(bundle, options);
    },
    async promoteStagedPage(workspace, candidateId): Promise<void> {
      return createWiki({ root: workspace }).promoteStagedPage(candidateId);
    },
  };
  return Object.freeze(port);
}

function fail(
  code: ConstructorParameters<typeof SessionCompileError>[0],
  projectId: string,
  candidateId: string,
  options: ConstructorParameters<typeof SessionCompileError>[2] = {},
): never {
  throw new SessionCompileError(code, projectId, {
    candidateRefs: [candidateId],
    ...options,
  });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return Object.freeze([...(value as readonly string[])]);
}

function pageBody(renderedPage: string): string | null {
  const marker = '\n---\n';
  const end = renderedPage.indexOf(marker, 4);
  return renderedPage.startsWith('---\n') && end >= 0
    ? renderedPage.slice(end + marker.length)
    : null;
}

function pageFrontmatter(renderedPage: string): UnknownRecord | null {
  const marker = '\n---\n';
  const end = renderedPage.indexOf(marker, 4);
  if (!renderedPage.startsWith('---\n') || end < 0) return null;
  try {
    const value: unknown = parse(renderedPage.slice(4, end)) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function expectedCitations(candidate: SessionReviewCandidateV1): SessionExportCitationInspection {
  const inspection = inspectSessionExportCitations(candidate.citationBindings.map((binding) => ({
    file: binding.compilerSourceId,
    start: binding.originalLine,
    end: binding.originalLine,
  })));
  if (inspection === null) {
    fail('SESSION_CANDIDATE_STORE_INVALID', candidate.projectId, candidate.candidateId);
  }
  return inspection;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return digestSessionValue(left) === digestSessionValue(right);
}

function mismatch(
  mismatchKind: SessionExportMismatchKind,
  fields: readonly SessionExportMismatchField[],
): ExportInspection {
  return Object.freeze({
    diagnostic: Object.freeze({
      fields: Object.freeze([...new Set(fields)].sort(compareSessionText)),
      mismatchKind,
    }),
    kind: 'mismatch',
  });
}

function diagnosticFor(
  inspection: ExportInspection | null,
): SessionExportInspectionDiagnostic | undefined {
  return inspection?.kind === 'mismatch' ? inspection.diagnostic : undefined;
}

function inspectDefaultExport(
  document: UnknownRecord,
  candidate: SessionReviewCandidateV1,
): ExportInspection {
  if (!Array.isArray(document.pages)) return mismatch('export-shape', ['pageCollection']);
  const matches = (document.pages as unknown[]).filter((value) =>
    isRecord(value) && value.path === `wiki/${candidate.pageId}.md`);
  if (matches.length === 0) return Object.freeze({ kind: 'absent' });
  if (matches.length !== 1) return mismatch('page-cardinality', ['page']);
  const page = matches[0];
  if (!isRecord(page)) return mismatch('page-shape', ['page']);
  const body = pageBody(candidate.renderedPage);
  const frontmatter = pageFrontmatter(candidate.renderedPage);
  const candidateShapeFields: SessionExportMismatchField[] = [];
  if (body === null) candidateShapeFields.push('body');
  if (frontmatter === null) candidateShapeFields.push('frontmatter');
  if (frontmatter !== null && typeof frontmatter.title !== 'string') {
    candidateShapeFields.push('title');
  }
  if (frontmatter !== null && typeof frontmatter.description !== 'string') {
    candidateShapeFields.push('summary');
  }
  if (candidateShapeFields.length !== 0) return mismatch('page-shape', candidateShapeFields);
  if (body === null || frontmatter === null || typeof frontmatter.title !== 'string' ||
      typeof frontmatter.description !== 'string') {
    return mismatch('page-shape', ['page']);
  }
  const sources = stringArray(page.sources);
  const sourceHashes = stringArray(page.sourceHashes);
  const citations = inspectSessionExportCitations(page.citations);
  const pageShapeFields: SessionExportMismatchField[] = [];
  if (typeof page.body !== 'string') pageShapeFields.push('body');
  if (typeof page.title !== 'string') pageShapeFields.push('title');
  if (typeof page.summary !== 'string') pageShapeFields.push('summary');
  if (typeof page.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(page.contentHash)) {
    pageShapeFields.push('contentHash');
  }
  if (sources === null) pageShapeFields.push('sourceRefs');
  if (sourceHashes === null) pageShapeFields.push('sourceHashes');
  if (citations === null) pageShapeFields.push('citations');
  if (pageShapeFields.length !== 0) return mismatch('page-shape', pageShapeFields);
  if (typeof page.body !== 'string' || typeof page.title !== 'string' ||
      typeof page.summary !== 'string' || typeof page.contentHash !== 'string' ||
      sources === null || sourceHashes === null || citations === null) {
    return mismatch('page-shape', ['page']);
  }
  const expectedSources = candidate.compilerSources
    .map((source) => source.compilerSourceId)
    .sort(compareSessionText);
  const expectedSourceHashes = candidate.compilerSources
    .map((source) => source.compilerSourceContentDigest.slice('sha256:'.length))
    .sort(compareSessionText);
  const actualSources = [...sources].filter((source) => !source.startsWith('okf:'))
    .sort(compareSessionText);
  const effectiveSourceHashes = sourceHashes.length === 0
    ? expectedSourceHashes
    : [...sourceHashes].sort(compareSessionText);
  const valueFields: SessionExportMismatchField[] = [];
  if (page.body !== body) valueFields.push('body');
  if (page.title !== frontmatter.title) valueFields.push('title');
  if (page.summary !== frontmatter.description) valueFields.push('summary');
  if (!sameCanonical(actualSources, expectedSources)) valueFields.push('sourceRefs');
  if (!sameCanonical(citations.canonical, expectedCitations(candidate).canonical)) {
    valueFields.push('citations');
  }
  if (page.contentHash !== sessionSha256(body).slice('sha256:'.length)) {
    valueFields.push('contentHash');
  }
  if (!sameCanonical(effectiveSourceHashes, expectedSourceHashes) ||
      effectiveSourceHashes.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))) {
    valueFields.push('sourceHashes');
  }
  if (valueFields.length !== 0) return mismatch('field-value', valueFields);
  return Object.freeze({
    kind: 'match',
    page: Object.freeze({
      body,
      citations: citations.raw,
      contentHash: page.contentHash,
      sourceHashes: Object.freeze(effectiveSourceHashes),
      sourceRefs: Object.freeze(actualSources),
      summary: page.summary,
      title: page.title,
    }),
  });
}

function inspectCustomExport(
  document: UnknownRecord,
  candidate: SessionReviewCandidateV1,
): ExportInspection {
  if (!isRecord(document.profile) || !Array.isArray(document.profile.entityPages)) {
    return mismatch('export-shape', ['pageCollection']);
  }
  const matches = (document.profile.entityPages as unknown[]).filter((value) =>
    isRecord(value) && value.id === candidate.pageId);
  if (matches.length === 0) return Object.freeze({ kind: 'absent' });
  if (matches.length !== 1) return mismatch('page-cardinality', ['page']);
  const page = matches[0];
  if (!isRecord(page)) return mismatch('page-shape', ['page']);
  const liveFrontmatter = page.frontmatter;
  const liveSourceRefs = isRecord(liveFrontmatter)
    ? stringArray(liveFrontmatter.sourceRefs)
    : null;
  const pageShapeFields: SessionExportMismatchField[] = [];
  if (!isRecord(liveFrontmatter)) pageShapeFields.push('frontmatter');
  if (typeof page.body !== 'string') pageShapeFields.push('body');
  if (isRecord(liveFrontmatter) && typeof liveFrontmatter.title !== 'string') {
    pageShapeFields.push('title');
  }
  if (isRecord(liveFrontmatter) && typeof liveFrontmatter.summary !== 'string') {
    pageShapeFields.push('summary');
  }
  if (liveSourceRefs === null) pageShapeFields.push('sourceRefs');
  if (pageShapeFields.length !== 0) return mismatch('page-shape', pageShapeFields);
  if (!isRecord(liveFrontmatter) || typeof page.body !== 'string' ||
      typeof liveFrontmatter.title !== 'string' ||
      typeof liveFrontmatter.summary !== 'string' || liveSourceRefs === null) {
    return mismatch('page-shape', ['page']);
  }
  const body = pageBody(candidate.renderedPage);
  const frontmatter = pageFrontmatter(candidate.renderedPage);
  const expectedSourceRefs = frontmatter === null ? null : stringArray(frontmatter.sourceRefs);
  const candidateShapeFields: SessionExportMismatchField[] = [];
  if (body === null) candidateShapeFields.push('body');
  if (frontmatter === null) candidateShapeFields.push('frontmatter');
  if (frontmatter !== null && typeof frontmatter.title !== 'string') {
    candidateShapeFields.push('title');
  }
  if (frontmatter !== null && typeof frontmatter.summary !== 'string') {
    candidateShapeFields.push('summary');
  }
  if (expectedSourceRefs === null) candidateShapeFields.push('sourceRefs');
  if (candidateShapeFields.length !== 0) return mismatch('page-shape', candidateShapeFields);
  if (body === null || frontmatter === null || typeof frontmatter.title !== 'string' ||
      typeof frontmatter.summary !== 'string' || expectedSourceRefs === null) {
    return mismatch('page-shape', ['page']);
  }
  const valueFields: SessionExportMismatchField[] = [];
  if (page.body !== body) valueFields.push('body');
  if (!sameCanonical(liveFrontmatter, frontmatter)) valueFields.push('frontmatter');
  if (liveFrontmatter.title !== frontmatter.title) valueFields.push('title');
  if (liveFrontmatter.summary !== frontmatter.summary) valueFields.push('summary');
  if (!sameCanonical(liveSourceRefs, expectedSourceRefs)) valueFields.push('sourceRefs');
  if (valueFields.length !== 0) return mismatch('field-value', valueFields);
  return Object.freeze({
    kind: 'match',
    page: Object.freeze({
      body,
      citations: expectedCitations(candidate).raw,
      contentHash: sessionSha256(body).slice('sha256:'.length),
      sourceHashes: Object.freeze(candidate.compilerSources.map((source) =>
        source.compilerSourceContentDigest.slice('sha256:'.length)).sort(compareSessionText)),
      sourceRefs: Object.freeze([...liveSourceRefs].sort(compareSessionText)),
      summary: liveFrontmatter.summary,
      title: liveFrontmatter.title,
    }),
  });
}

function inspectExport(raw: unknown, candidate: SessionReviewCandidateV1): ExportInspection {
  if (!isRecord(raw)) return mismatch('export-shape', ['document']);
  if (raw.schemaVersion !== 1) return mismatch('schema-version', ['schemaVersion']);
  if (raw.projectId !== candidate.projectId) return mismatch('project-binding', ['projectId']);
  return candidate.profileMode === 'default'
    ? inspectDefaultExport(raw, candidate)
    : inspectCustomExport(raw, candidate);
}

function proofFor(
  candidate: SessionReviewCandidateV1,
  page: VerifiedExportPage,
): SessionPromotionProofV1 {
  return finalizeSessionPromotionProof({
    projectId: candidate.projectId,
    candidateId: candidate.candidateId,
    candidateDigest: candidate.candidateDigest,
    pageId: candidate.pageId,
    profileMode: candidate.profileMode,
    bodyDigest: sessionSha256(page.body),
    titleDigest: sessionSha256(page.title),
    summaryDigest: sessionSha256(page.summary),
    sourceRefsDigest: digestSessionValue(page.sourceRefs),
    citationsDigest: digestSessionValue(page.citations),
    contentHash: page.contentHash,
    sourceHashes: page.sourceHashes,
    citationBindings: candidate.citationBindings,
    compilerSources: candidate.compilerSources,
  });
}

function validateCurrentSnapshot(
  candidate: SessionReviewCandidateV1,
  snapshot: SessionCompilePlanSnapshot,
  workspace: string,
  projectId: string,
): void {
  if (candidate.projectId !== projectId || snapshot.plan.projectId !== projectId ||
      snapshot.workspace !== workspace) {
    fail('SESSION_CANDIDATE_PROJECT_MISMATCH', projectId, candidate.candidateId);
  }
  if (candidate.profileMode !== snapshot.profileMode ||
      candidate.profileDigest !== snapshot.plan.profileDigest) {
    fail('SESSION_CANDIDATE_PROFILE_MISMATCH', projectId, candidate.candidateId);
  }
  if (candidate.policyDigest !== snapshot.plan.policyDigest ||
      candidate.sourceManifestDigest !== snapshot.plan.sourceManifestDigest ||
      candidate.contractDigest !== snapshot.plan.contractDigest) {
    fail('SESSION_CANDIDATE_STALE', projectId, candidate.candidateId);
  }
  const sources = new Map(snapshot.plan.sources.map((source) => [source.sourceId, source] as const));
  if (candidate.compilerSources.some((binding) => {
    const source = sources.get(binding.sourceId);
    return source === undefined || source.compilerSourceId !== binding.compilerSourceId ||
      source.compilerSourceContentDigest !== binding.compilerSourceContentDigest;
  })) {
    fail('SESSION_CANDIDATE_STALE', projectId, candidate.candidateId);
  }
  if (snapshot.plan.allowedLinkTargets.some((target) => target.slug === candidate.slug)) {
    fail('SESSION_CANDIDATE_STALE', projectId, candidate.candidateId);
  }
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

async function createSinglePageBundle(
  candidate: SessionReviewCandidateV1,
): Promise<Readonly<{ readonly parent: string; readonly root: string }>> {
  const parent = await mkdtemp(join(tmpdir(), 'buildlore-approve-'));
  const root = join(parent, candidate.candidateId.slice('candidate-'.length));
  try {
    await mkdir(root, { mode: 0o700 });
    await exclusiveWrite(
      join(root, 'index.md'),
      '---\nokf_version: "0.1"\n---\n\n# BuildLore Session Compile Approval\n',
    );
    const target = join(root, candidate.target);
    await mkdir(dirname(target), { mode: 0o700, recursive: true });
    await exclusiveWrite(target, candidate.renderedPage);
    return Object.freeze({ parent, root });
  } catch (error) {
    await rm(parent, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

async function finishExactPromotion(
  store: SessionReviewStore,
  candidate: SessionReviewCandidateV1,
  page: VerifiedExportPage,
): Promise<void> {
  try {
    await store.writeProof(proofFor(candidate, page));
    await store.complete(candidate);
  } catch {
    fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', candidate.projectId, candidate.candidateId, {
      recoveryAction: 'status',
      sideEffectsPossible: true,
    });
  }
}

async function inspectLive(
  port: SessionReviewServicePort,
  workspace: string,
  projectId: string,
  candidate: SessionReviewCandidateV1,
): Promise<ExportInspection | null> {
  try {
    return inspectExport(await port.exportJson(workspace, projectId), candidate);
  } catch {
    return null;
  }
}

export function createSessionReviewService(
  options: CreateSessionReviewServiceOptions = {},
): SessionReviewService {
  const port = options.port ?? defaultPort();
  const storeFactory = options.storeFactory ?? createSessionReviewStore;
  const removeTemporary = options.removeTemporary ?? (async (path: string) =>
    rm(path, { force: true, recursive: true }));
  const service: SessionReviewService = {
    async list(workspace, projectId) {
      const store = storeFactory(workspace, projectId);
      const managed = await store.list();
      const boundUpstreamIds = new Set(managed.flatMap(({ candidate }) =>
        candidate.upstreamCandidateId === undefined ? [] : [candidate.upstreamCandidateId]));
      const legacyPendingCount = await countLegacyUpstreamCandidates(
        workspace,
        projectId,
        boundUpstreamIds,
      );
      const warnings = [
        ...(legacyPendingCount === 0 ? [] : [{ code: 'legacy-candidates-require-manual-recovery' }]),
        ...(managed.some((item) => item.lifecycle === 'approving')
          ? [{ code: 'candidate-recovery-required' }]
          : []),
      ];
      return Object.freeze({
        schemaVersion: SESSION_CANDIDATE_LIST_SCHEMA_VERSION,
        projectId,
        candidates: Object.freeze(managed.map(({ candidate, lifecycle }) => Object.freeze({
          candidateId: candidate.candidateId,
          heldReasons: candidate.heldReasons,
          lifecycle,
          targetPath: candidate.target,
          pageId: candidate.pageId,
          slug: candidate.slug,
        }))),
        managedPendingCount: managed.length,
        legacyPendingCount,
        warnings: Object.freeze(warnings),
      });
    },
    async approve(workspace, projectId, candidateId, refreshSnapshot) {
      const store = storeFactory(workspace, projectId);
      const available = await store.list();
      const stored = available.find((item) => item.candidate.candidateId === candidateId);
      if (stored === undefined) {
        if (await store.readProof(candidateId) !== null) {
          fail('SESSION_CANDIDATE_ALREADY_APPROVED', projectId, candidateId);
        }
        fail('SESSION_CANDIDATE_NOT_FOUND', projectId, candidateId);
      }
      let candidate = stored.candidate;
      if (stored.lifecycle === 'approving') {
        const inspection = await inspectLive(port, workspace, projectId, candidate);
        if (inspection?.kind === 'match') {
          await finishExactPromotion(store, candidate, inspection.page);
          return Object.freeze({
            schemaVersion: SESSION_CANDIDATE_APPROVAL_SCHEMA_VERSION,
            projectId,
            candidateId,
            pageId: candidate.pageId,
            outcome: 'approved',
            providerUsed: false,
            sideEffectsPossible: false,
            warnings: Object.freeze([{ code: 'recovered-approving-candidate' }]),
          });
        }
        if (inspection?.kind === 'absent') {
          await store.restore(candidate);
        } else {
          const exportInspection = diagnosticFor(inspection);
          fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, candidateId, {
            ...(exportInspection === undefined ? {} : { exportInspection }),
            recoveryAction: 'status',
            sideEffectsPossible: true,
          });
        }
      }
      candidate = await store.claim(candidateId);
      let mutationAttempted = false;
      let temporary: Awaited<ReturnType<typeof createSinglePageBundle>> | undefined;
      let approvalFailure: Readonly<{ readonly error: unknown }> | undefined;
      try {
        try {
          validateCurrentSnapshot(candidate, await refreshSnapshot(), workspace, projectId);
          mutationAttempted = true;
          if (candidate.profileMode === 'default') {
            temporary = await createSinglePageBundle(candidate);
            await port.importOkf(workspace, temporary.root, { trusted: true });
          } else {
            const upstreamCandidateId = candidate.upstreamCandidateId;
            if (upstreamCandidateId === undefined) {
              fail('SESSION_CANDIDATE_STORE_INVALID', projectId, candidateId);
            }
            await port.promoteStagedPage(workspace, upstreamCandidateId);
          }
          const inspection = await inspectLive(port, workspace, projectId, candidate);
          if (inspection?.kind !== 'match') {
            const exportInspection = diagnosticFor(inspection);
            fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, candidateId, {
              ...(exportInspection === undefined ? {} : { exportInspection }),
              recoveryAction: 'status',
              sideEffectsPossible: true,
            });
          }
          await finishExactPromotion(store, candidate, inspection.page);
        } catch (error) {
          if (!mutationAttempted) {
            await store.restore(candidate);
            throw error;
          }
          const inspection = await inspectLive(port, workspace, projectId, candidate);
          if (inspection?.kind === 'match') {
            await finishExactPromotion(store, candidate, inspection.page);
          } else if (inspection?.kind === 'absent') {
            await store.restore(candidate);
            if (error instanceof LockUnavailableError) {
              fail('SESSION_CANDIDATE_BUSY', projectId, candidateId, { retryable: true });
            }
            if (error instanceof SessionCompileError) throw error;
            fail('SESSION_CANDIDATE_APPROVAL_FAILED', projectId, candidateId, {
              recoveryAction: 'retry',
              retryable: true,
            });
          } else {
            const previousExportInspection = error instanceof SessionCompileError
              ? error.exportInspection
              : undefined;
            const exportInspection = previousExportInspection ?? diagnosticFor(inspection);
            fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, candidateId, {
              ...(exportInspection === undefined ? {} : { exportInspection }),
              recoveryAction: 'status',
              sideEffectsPossible: true,
            });
          }
        }
      } catch (error) {
        approvalFailure = Object.freeze({ error });
      }
      try {
        if (temporary !== undefined) {
          await removeTemporary(temporary.parent);
        }
      } catch {
        const exportInspection = approvalFailure?.error instanceof SessionCompileError
          ? approvalFailure.error.exportInspection
          : undefined;
        fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, candidateId, {
          ...(exportInspection === undefined ? {} : { exportInspection }),
          recoveryAction: 'status',
          sideEffectsPossible: true,
        });
      }
      if (approvalFailure !== undefined) throw approvalFailure.error;
      return Object.freeze({
        schemaVersion: SESSION_CANDIDATE_APPROVAL_SCHEMA_VERSION,
        projectId,
        candidateId,
        pageId: candidate.pageId,
        outcome: 'approved',
        providerUsed: false,
        sideEffectsPossible: false,
        warnings: Object.freeze([]),
      });
    },
  };
  return Object.freeze(service);
}
