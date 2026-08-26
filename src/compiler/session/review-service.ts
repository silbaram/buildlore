import { createWiki, LockUnavailableError } from 'llm-wiki-compiler';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

import { compareSessionText, digestSessionValue, sessionSha256 } from './canonical.js';
import { SessionCompileError } from './errors.js';
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
  readonly citations: readonly UnknownRecord[];
  readonly contentHash: string;
  readonly sourceHashes: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly summary: string;
  readonly title: string;
}

type ExportInspection =
  | Readonly<{ readonly kind: 'absent' }>
  | Readonly<{ readonly kind: 'match'; readonly page: VerifiedExportPage }>
  | Readonly<{ readonly kind: 'mismatch' }>;

function defaultPort(): SessionReviewServicePort {
  const port: SessionReviewServicePort = {
    async exportJson(workspace, projectId): Promise<unknown> {
      return createWiki({ root: workspace }).exportJson({ projectId });
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

function expectedCitations(candidate: SessionReviewCandidateV1): readonly UnknownRecord[] {
  return Object.freeze(candidate.citationBindings.map((binding) => Object.freeze({
    file: binding.compilerSourceId,
    start: binding.originalLine,
    end: binding.originalLine,
  })));
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return digestSessionValue(left) === digestSessionValue(right);
}

function inspectDefaultExport(
  document: UnknownRecord,
  candidate: SessionReviewCandidateV1,
): ExportInspection {
  if (!Array.isArray(document.pages)) return Object.freeze({ kind: 'mismatch' });
  const matches = (document.pages as unknown[]).filter((value) =>
    isRecord(value) && value.path === `wiki/${candidate.pageId}.md`);
  if (matches.length === 0) return Object.freeze({ kind: 'absent' });
  if (matches.length !== 1) return Object.freeze({ kind: 'mismatch' });
  const page = matches[0];
  if (!isRecord(page)) return Object.freeze({ kind: 'mismatch' });
  const body = pageBody(candidate.renderedPage);
  const frontmatter = pageFrontmatter(candidate.renderedPage);
  const sources = stringArray(page.sources);
  const sourceHashes = stringArray(page.sourceHashes);
  if (body === null || frontmatter === null || typeof page.body !== 'string' ||
      page.body !== body || typeof page.title !== 'string' ||
      typeof page.summary !== 'string' || typeof page.contentHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(page.contentHash) || sources === null || sourceHashes === null ||
      !Array.isArray(page.citations)) {
    return Object.freeze({ kind: 'mismatch' });
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
  const expectedTitle = frontmatter.title;
  const expectedSummary = frontmatter.description;
  if (page.title !== expectedTitle || page.summary !== expectedSummary ||
      !sameCanonical(actualSources, expectedSources) ||
      !sameCanonical(page.citations, expectedCitations(candidate)) ||
      page.contentHash !== sessionSha256(body).slice('sha256:'.length) ||
      !sameCanonical(effectiveSourceHashes, expectedSourceHashes) ||
      effectiveSourceHashes.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))) {
    return Object.freeze({ kind: 'mismatch' });
  }
  return Object.freeze({
    kind: 'match',
    page: Object.freeze({
      body,
      citations: Object.freeze(page.citations.filter(isRecord)),
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
    return Object.freeze({ kind: 'mismatch' });
  }
  const matches = (document.profile.entityPages as unknown[]).filter((value) =>
    isRecord(value) && value.id === candidate.pageId);
  if (matches.length === 0) return Object.freeze({ kind: 'absent' });
  if (matches.length !== 1) return Object.freeze({ kind: 'mismatch' });
  const page = matches[0];
  if (!isRecord(page) || !isRecord(page.frontmatter) || typeof page.body !== 'string') {
    return Object.freeze({ kind: 'mismatch' });
  }
  const body = pageBody(candidate.renderedPage);
  const frontmatter = pageFrontmatter(candidate.renderedPage);
  if (body === null || frontmatter === null || page.body !== body ||
      !sameCanonical(page.frontmatter, frontmatter) || typeof frontmatter.title !== 'string' ||
      typeof frontmatter.summary !== 'string') {
    return Object.freeze({ kind: 'mismatch' });
  }
  const sourceRefs = stringArray(frontmatter.sourceRefs);
  if (sourceRefs === null) return Object.freeze({ kind: 'mismatch' });
  return Object.freeze({
    kind: 'match',
    page: Object.freeze({
      body,
      citations: expectedCitations(candidate),
      contentHash: sessionSha256(body).slice('sha256:'.length),
      sourceHashes: Object.freeze(candidate.compilerSources.map((source) =>
        source.compilerSourceContentDigest.slice('sha256:'.length)).sort(compareSessionText)),
      sourceRefs: Object.freeze([...sourceRefs].sort(compareSessionText)),
      summary: frontmatter.summary,
      title: frontmatter.title,
    }),
  });
}

function inspectExport(raw: unknown, candidate: SessionReviewCandidateV1): ExportInspection {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.projectId !== candidate.projectId) {
    return Object.freeze({ kind: 'mismatch' });
  }
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
  const root = join(parent, `bundle-${candidate.candidateId.slice('candidate-'.length)}`);
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
  await store.writeProof(proofFor(candidate, page));
  await store.complete(candidate);
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
        validateCurrentSnapshot(
          candidate,
          await refreshSnapshot(),
          workspace,
          projectId,
        );
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
          fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, candidateId, {
            recoveryAction: 'status',
            sideEffectsPossible: true,
          });
        }
      }
      candidate = await store.claim(candidateId);
      let mutationAttempted = false;
      let temporary: Awaited<ReturnType<typeof createSinglePageBundle>> | undefined;
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
          fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, candidateId, {
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
          fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, candidateId, {
            recoveryAction: 'status',
            sideEffectsPossible: true,
          });
        }
      } finally {
        if (temporary !== undefined) {
          try {
            await removeTemporary(temporary.parent);
          } catch {
            fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, candidateId, {
              recoveryAction: 'status',
              sideEffectsPossible: true,
            });
          }
        }
      }
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
