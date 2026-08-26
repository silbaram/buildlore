import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { validateProjectId } from '../knowledge/validation.js';
import { showProject } from '../knowledge/workspace.js';
import {
  createProfileBindingPreflight,
  type ProfileBindingPreflight,
} from '../profile/preflight.js';
import {
  createProjectSecurityService,
  type ProjectSecurityService,
} from '../sanitizer/index.js';
import { createLlmWikiCompilerBackend } from './backend.js';
import { CompilerBackendError } from './errors.js';
import { digestSessionValue, sessionSha256 } from './session/canonical.js';
import { SESSION_COMPILE_LIMITS } from './session/contracts.js';
import { SessionCompileError } from './session/errors.js';
import {
  createSessionReviewStore,
  type SessionReviewStore,
} from './session/review-store.js';
import { readConfinedSessionUtf8 } from './session/safe-io.js';
import type { SessionPromotionProofV1 } from './session/types.js';
import type { CompilerCorpusBackend, CompilerWarning } from './types.js';

const MAX_CORPUS_PAGES = 4_096;
const MAX_PAGE_BODY_CHARS = 1_048_576;
const MAX_CORPUS_CHARS = 32 * 1_048_576;
const MAX_SOURCE_REFS = 100;
const SAFE_EXPORT_WARNINGS = new Set(['incomplete-compile', 'journal-unavailable']);
const ENTITY_DIRECTORIES = Object.freeze({
  decisions: 'wiki/decisions',
  failures: 'wiki/failures',
  verifications: 'wiki/verifications',
} as const);

type CorpusExclusion = 'archived' | 'orphaned' | 'stale' | 'unverified';

export type ProjectCorpusErrorCode =
  | 'CORPUS_BACKEND_FAILED'
  | 'CORPUS_CONTRACT_VIOLATION'
  | 'CORPUS_SECURITY_DENIED'
  | 'CORPUS_SNAPSHOT_CHANGED';

export class ProjectCorpusError extends Error {
  readonly code: ProjectCorpusErrorCode;
  readonly projectId: string;
  readonly recoveryAction: 'check' | 'retry';
  readonly retryable: boolean;

  constructor(code: ProjectCorpusErrorCode, projectId: string) {
    super(code === 'CORPUS_BACKEND_FAILED'
      ? 'Project corpus could not be read.'
      : code === 'CORPUS_SNAPSHOT_CHANGED'
        ? 'Project changed while its corpus was read.'
        : 'Project corpus is unsafe.');
    this.name = 'ProjectCorpusError';
    this.code = code;
    this.projectId = projectId;
    this.recoveryAction = code === 'CORPUS_SNAPSHOT_CHANGED' ? 'retry' : 'check';
    this.retryable = code === 'CORPUS_SNAPSHOT_CHANGED';
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      code: this.code,
      message: this.message,
      projectId: this.projectId,
      recoveryAction: this.recoveryAction,
      retryable: this.retryable,
    };
  }
}

/** Internal compiler/retrieval hand-off. This module is intentionally not re-exported publicly. */
export interface SearchCorpusPage {
  readonly body: string;
  readonly freshness: 'fresh';
  readonly pageId: string;
  readonly sourceRefs: readonly string[];
  readonly summary: string;
  readonly title: string;
}

export interface SearchCorpus {
  readonly excluded: Readonly<Record<CorpusExclusion, number>>;
  readonly pages: readonly SearchCorpusPage[];
  readonly projectId: string;
  readonly warnings: readonly CompilerWarning[];
}

export interface ProjectCorpusPort {
  snapshot(projectId: string): Promise<SearchCorpus>;
}

export interface CreateProjectCorpusOptions {
  readonly backend?: CompilerCorpusBackend;
  readonly knowledgeRoot: string;
  readonly profilePreflight?: ProfileBindingPreflight;
  /** @internal Project-confined promotion proof store seam. */
  readonly reviewStoreFactory?: (workspace: string, projectId: string) => SessionReviewStore;
  readonly securityService?: ProjectSecurityService;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

interface CandidatePage extends SearchCorpusPage {
  readonly exclusion?: CorpusExclusion;
}

function corpusError(projectId: string): ProjectCorpusError {
  return new ProjectCorpusError('CORPUS_CONTRACT_VIOLATION', projectId);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, projectId: string): UnknownRecord {
  if (!isRecord(value)) throw corpusError(projectId);
  return value;
}

function requireArray(value: unknown, maximum: number, projectId: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw corpusError(projectId);
  return value;
}

function unsafeCharacter(value: string, allowWhitespace: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 32 && (!allowWhitespace || (code !== 9 && code !== 10))) ||
        (code >= 127 && code <= 159)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function requireText(
  value: unknown,
  maximum: number,
  projectId: string,
  allowWhitespace = false,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum ||
      unsafeCharacter(value, allowWhitespace)) throw corpusError(projectId);
  return value;
}

function requireSlug(value: unknown, projectId: string): string {
  const slug = requireText(value, 255, projectId);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) throw corpusError(projectId);
  return slug;
}

function requireSourceRef(value: unknown, projectId: string): string {
  const reference = requireText(value, 512, projectId);
  if (
    reference.startsWith('/') ||
    reference.startsWith('~') ||
    reference.includes('\\') ||
    /^[a-zA-Z]:/u.test(reference) ||
    /^file:/iu.test(reference) ||
    reference.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw corpusError(projectId);
  }
  return reference;
}

function requireSourceRefs(
  value: unknown,
  projectId: string,
  options: { readonly allowEmpty?: boolean } = {},
): readonly string[] {
  const refs = requireArray(value, MAX_SOURCE_REFS, projectId)
    .map((reference) => requireSourceRef(reference, projectId))
    .sort();
  if ((refs.length === 0 && options.allowEmpty !== true) || new Set(refs).size !== refs.length) {
    throw corpusError(projectId);
  }
  return refs;
}

function normalizeLegacyPage(
  raw: unknown,
  projectId: string,
  verifiedPromotionPages: ReadonlySet<string>,
): CandidatePage {
  const page = requireRecord(raw, projectId);
  const slug = requireSlug(page.slug, projectId);
  const directory = requireText(page.pageDirectory, 32, projectId);
  if (directory !== 'concepts' && directory !== 'queries') throw corpusError(projectId);
  if (page.path !== `wiki/${directory}/${slug}.md`) throw corpusError(projectId);
  const freshness = requireText(page.freshnessStatus, 32, projectId);
  if (freshness !== 'fresh' && freshness !== 'stale' && freshness !== 'unverified') {
    throw corpusError(projectId);
  }
  if (typeof page.archived !== 'boolean' || typeof page.contradicted !== 'boolean') {
    throw corpusError(projectId);
  }
  const pageId = `${directory}/${slug}`;
  const exportedSourceRefs = requireSourceRefs(page.sources, projectId, { allowEmpty: true });
  const sourceRefs = verifiedPromotionPages.has(pageId)
    ? exportedSourceRefs.filter((source) => !source.startsWith('okf:'))
    : exportedSourceRefs;
  return {
    body: requireText(page.body, MAX_PAGE_BODY_CHARS, projectId, true),
    ...(page.archived
      ? { exclusion: 'archived' as const }
      : freshness === 'stale'
        ? { exclusion: 'stale' as const }
        : (freshness === 'unverified' && !verifiedPromotionPages.has(pageId)) ||
            page.contradicted || sourceRefs.length === 0
          ? { exclusion: 'unverified' as const }
          : {}),
    freshness: 'fresh',
    pageId,
    sourceRefs,
    summary: requireText(page.summary, 4_000, projectId, true),
    title: requireText(page.title, 512, projectId, true),
  };
}

function profileExclusion(
  entityType: keyof typeof ENTITY_DIRECTORIES,
  frontmatter: UnknownRecord,
  projectId: string,
): CorpusExclusion | undefined {
  if (frontmatter.archived !== undefined && typeof frontmatter.archived !== 'boolean') {
    throw corpusError(projectId);
  }
  if (frontmatter.orphaned !== undefined && typeof frontmatter.orphaned !== 'boolean') {
    throw corpusError(projectId);
  }
  if (frontmatter.archived === true || frontmatter.status === 'archived') return 'archived';
  if (frontmatter.orphaned === true) return 'orphaned';
  const confidence = frontmatter.confidence;
  const provenance = frontmatter.provenanceState;
  const contradictedBy = frontmatter.contradictedBy;
  if (
    typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0.5 ||
    (provenance !== 'extracted' && provenance !== 'merged' && provenance !== 'inferred') ||
    (contradictedBy !== undefined &&
      (!Array.isArray(contradictedBy) || contradictedBy.length > 0)) ||
    (entityType === 'verifications' && frontmatter.status !== 'passed')
  ) {
    return 'unverified';
  }
  return undefined;
}

function normalizeEntityPage(raw: unknown, projectId: string): CandidatePage {
  const page = requireRecord(raw, projectId);
  const entityType = requireText(page.entityType, 64, projectId);
  if (!Object.hasOwn(ENTITY_DIRECTORIES, entityType)) throw corpusError(projectId);
  const type = entityType as keyof typeof ENTITY_DIRECTORIES;
  const directory = ENTITY_DIRECTORIES[type];
  const slug = requireSlug(page.slug, projectId);
  if (page.directory !== directory || page.id !== `${type}/${slug}` ||
      page.path !== `${directory}/${slug}.md`) throw corpusError(projectId);
  const frontmatter = requireRecord(page.frontmatter, projectId);
  const sourceRevision = requireText(frontmatter.sourceRevision, 71, projectId);
  if (!/^sha256:[a-f0-9]{64}$/u.test(sourceRevision)) throw corpusError(projectId);
  const exclusion = profileExclusion(type, frontmatter, projectId);
  return {
    body: requireText(page.body, MAX_PAGE_BODY_CHARS, projectId, true),
    ...(exclusion === undefined ? {} : { exclusion }),
    freshness: 'fresh',
    pageId: `${type}/${slug}`,
    sourceRefs: requireSourceRefs(frontmatter.sourceRefs, projectId),
    summary: requireText(frontmatter.summary, 4_000, projectId, true),
    title: requireText(frontmatter.title, 512, projectId, true),
  };
}

function boundedStrings(value: unknown, maximum: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximum ||
      value.some((item) => typeof item !== 'string')) {
    return null;
  }
  return Object.freeze([...(value as readonly string[])]);
}

function exactPromotionPage(
  raw: unknown,
  proof: SessionPromotionProofV1,
): boolean {
  if (!isRecord(raw) || proof.profileMode !== 'default' ||
      raw.path !== `wiki/${proof.pageId}.md` || typeof raw.body !== 'string' ||
      typeof raw.title !== 'string' || typeof raw.summary !== 'string' ||
      typeof raw.contentHash !== 'string' || !Array.isArray(raw.citations)) {
    return false;
  }
  const sourceRefs = boundedStrings(raw.sources, MAX_SOURCE_REFS);
  const sourceHashes = boundedStrings(raw.sourceHashes, MAX_SOURCE_REFS);
  if (sourceRefs === null || sourceHashes === null || proof.citationBindings.length === 0) {
    return false;
  }
  const actualSourceRefs = [...sourceRefs]
    .filter((source) => !source.startsWith('okf:'))
    .sort();
  const expectedSourceRefs = proof.compilerSources
    .map((source) => source.compilerSourceId)
    .sort();
  const actualSourceHashes = [...sourceHashes].sort();
  const expectedSourceHashes = proof.compilerSources
    .map((source) => source.compilerSourceContentDigest.slice('sha256:'.length))
    .sort();
  const expectedCitations = proof.citationBindings.map((binding) => ({
    file: binding.compilerSourceId,
    start: binding.originalLine,
    end: binding.originalLine,
  }));
  return proof.bodyDigest === sessionSha256(raw.body) &&
    proof.titleDigest === sessionSha256(raw.title) &&
    proof.summaryDigest === sessionSha256(raw.summary) &&
    proof.sourceRefsDigest === digestSessionValue(actualSourceRefs) &&
    proof.citationsDigest === digestSessionValue(raw.citations) &&
    proof.contentHash === raw.contentHash &&
    proof.contentHash === sessionSha256(raw.body).slice('sha256:'.length) &&
    digestSessionValue(actualSourceRefs) === digestSessionValue(expectedSourceRefs) &&
    (actualSourceHashes.length === 0 ||
      digestSessionValue(actualSourceHashes) === digestSessionValue(expectedSourceHashes)) &&
    digestSessionValue(expectedSourceHashes) === digestSessionValue(proof.sourceHashes) &&
    digestSessionValue(raw.citations) === digestSessionValue(expectedCitations);
}

async function currentPromotionSourcesMatch(
  workspace: string,
  projectId: string,
  proof: SessionPromotionProofV1,
): Promise<boolean> {
  try {
    const results = await Promise.all(proof.compilerSources.map(async (source) => {
      const body = await readConfinedSessionUtf8(
        join(workspace, 'sources', source.compilerSourceId),
        workspace,
        SESSION_COMPILE_LIMITS.maxSourceBytes,
        projectId,
      );
      return sessionSha256(body) === source.compilerSourceContentDigest;
    }));
    return results.length > 0 && results.every(Boolean);
  } catch {
    return false;
  }
}

async function verifiedPromotionPageIds(
  raw: unknown,
  proofs: readonly SessionPromotionProofV1[],
  workspace: string,
  projectId: string,
): Promise<ReadonlySet<string>> {
  if (!isRecord(raw) || !Array.isArray(raw.pages)) return new Set();
  const proofByPage = new Map<string, SessionPromotionProofV1>();
  for (const proof of proofs) {
    if (proofByPage.has(proof.pageId)) throw corpusError(projectId);
    proofByPage.set(proof.pageId, proof);
  }
  const verified = new Set<string>();
  for (const rawPage of raw.pages) {
    if (!isRecord(rawPage) || typeof rawPage.pageDirectory !== 'string' ||
        typeof rawPage.slug !== 'string') continue;
    const pageId = `${rawPage.pageDirectory}/${rawPage.slug}`;
    const proof = proofByPage.get(pageId);
    if (proof !== undefined && exactPromotionPage(rawPage, proof) &&
        await currentPromotionSourcesMatch(workspace, projectId, proof)) {
      verified.add(pageId);
    }
  }
  return verified;
}

function normalizeExport(
  raw: unknown,
  projectId: string,
  expectsProfile: boolean,
  verifiedPromotionPages: ReadonlySet<string>,
): {
  readonly pages: readonly CandidatePage[];
  readonly warnings: readonly CompilerWarning[];
} {
  const document = requireRecord(raw, projectId);
  if (document.schemaVersion !== 1 || document.projectId !== projectId) throw corpusError(projectId);
  const legacy = requireArray(document.pages, MAX_CORPUS_PAGES, projectId);
  if (!Number.isSafeInteger(document.pageCount) || document.pageCount !== legacy.length) {
    throw corpusError(projectId);
  }
  const pages: CandidatePage[] = legacy.map((page) =>
    normalizeLegacyPage(page, projectId, verifiedPromotionPages));
  if ((document.profile !== undefined) !== expectsProfile) throw corpusError(projectId);
  if (document.profile !== undefined) {
    const profile = requireRecord(document.profile, projectId);
    if (profile.version !== 1 || profile.profileId !== 'buildlore-lifecycle') {
      throw corpusError(projectId);
    }
    const problems = profile.problems === undefined
      ? []
      : requireArray(profile.problems, MAX_CORPUS_PAGES, projectId);
    if (problems.length > 0 || (profile.problemTotal !== undefined && profile.problemTotal !== 0)) {
      throw corpusError(projectId);
    }
    pages.push(...requireArray(
      profile.entityPages,
      MAX_CORPUS_PAGES - pages.length,
      projectId,
    ).map((page) => normalizeEntityPage(page, projectId)));
  }
  const ids = pages.map((page) => page.pageId);
  if (new Set(ids).size !== ids.length) throw corpusError(projectId);
  const totalChars = pages.reduce(
    (total, page) => total + page.title.length + page.summary.length + page.body.length,
    0,
  );
  if (totalChars > MAX_CORPUS_CHARS) throw corpusError(projectId);
  const warnings = document.warnings === undefined
    ? []
    : requireArray(document.warnings, 20, projectId).map((rawWarning) => {
        const warning = requireRecord(rawWarning, projectId);
        const code = requireText(warning.code, 128, projectId);
        if (!SAFE_EXPORT_WARNINGS.has(code)) throw corpusError(projectId);
        return { code };
      });
  if (new Set(warnings.map((warning) => warning.code)).size !== warnings.length) {
    throw corpusError(projectId);
  }
  return { pages: pages.sort((left, right) => left.pageId.localeCompare(right.pageId)), warnings };
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function assertSafePage(
  security: ProjectSecurityService,
  page: CandidatePage,
  projectId: string,
): Promise<void> {
  const body = `${page.title}\n${page.summary}\n${page.sourceRefs.join('\n')}\n${page.body}`;
  const digest = sha256(body);
  let result;
  try {
    result = await security.prepareSource({
      body,
      bodyDigest: digest,
      projectId,
      source: `corpus:${page.pageId}`,
      sourceKind: 'wiki',
      sourceRevisionOrContentSha256: digest,
    });
  } catch {
    throw new ProjectCorpusError('CORPUS_SECURITY_DENIED', projectId);
  }
  if (!result.ok || result.report.decision !== 'include' ||
      result.report.outputDigest !== digest || result.report.summaries.length > 0) {
    throw new ProjectCorpusError('CORPUS_SECURITY_DENIED', projectId);
  }
}

export function createProjectCorpus(options: CreateProjectCorpusOptions): ProjectCorpusPort {
  const backend = options.backend ?? createLlmWikiCompilerBackend();
  const preflight = options.profilePreflight ?? createProfileBindingPreflight(options.knowledgeRoot);
  const reviewStoreFactory = options.reviewStoreFactory ?? createSessionReviewStore;
  const security = options.securityService ?? createProjectSecurityService({
    knowledgeRoot: options.knowledgeRoot,
  });
  return {
    async snapshot(projectId) {
      validateProjectId(projectId);
      const record = await showProject(options.knowledgeRoot, projectId);
      const workspace = await resolveProjectWorkspace(options.knowledgeRoot, projectId, {
        mustExist: true,
      });
      const binding = await preflight.resolve(projectId);
      if (record.entry.projectId !== projectId || binding.workspace !== workspace) {
        throw new ProjectCorpusError('CORPUS_SNAPSHOT_CHANGED', projectId);
      }
      let raw: unknown;
      let proofs: readonly SessionPromotionProofV1[];
      try {
        [raw, proofs] = await Promise.all([
          backend.exportProject(workspace, projectId),
          reviewStoreFactory(workspace, projectId).listProofs(),
        ]);
      } catch (error) {
        if (error instanceof ProjectCorpusError) throw error;
        if (error instanceof SessionCompileError) throw corpusError(projectId);
        if (error instanceof CompilerBackendError) {
          throw new ProjectCorpusError('CORPUS_BACKEND_FAILED', projectId);
        }
        throw new ProjectCorpusError('CORPUS_BACKEND_FAILED', projectId);
      }
      const freshRecord = await showProject(options.knowledgeRoot, projectId);
      const freshBinding = await preflight.resolve(projectId);
      if (freshRecord.entry.projectId !== record.entry.projectId ||
          freshRecord.descriptor.sourceRepository !== record.descriptor.sourceRepository ||
          freshBinding.workspace !== binding.workspace || freshBinding.mode !== binding.mode ||
          freshBinding.outputLanguage !== binding.outputLanguage) {
        throw new ProjectCorpusError('CORPUS_SNAPSHOT_CHANGED', projectId);
      }
      const promotedPages = await verifiedPromotionPageIds(raw, proofs, workspace, projectId);
      const normalized = normalizeExport(
        raw,
        projectId,
        binding.mode === 'custom',
        promotedPages,
      );
      for (const page of normalized.pages) await assertSafePage(security, page, projectId);
      const excluded: Record<CorpusExclusion, number> = {
        archived: 0,
        orphaned: 0,
        stale: 0,
        unverified: 0,
      };
      const pages = normalized.pages.filter((page) => {
        if (page.exclusion === undefined) return true;
        excluded[page.exclusion] += 1;
        return false;
      }).map((page) => ({
        body: page.body,
        freshness: page.freshness,
        pageId: page.pageId,
        sourceRefs: page.sourceRefs,
        summary: page.summary,
        title: page.title,
      }));
      return {
        excluded: Object.freeze(excluded),
        pages: Object.freeze(pages),
        projectId,
        warnings: Object.freeze(normalized.warnings),
      };
    },
  };
}
