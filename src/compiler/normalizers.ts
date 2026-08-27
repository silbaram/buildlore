import { basename, isAbsolute, posix } from 'node:path';

import { KnowledgeError } from '../knowledge/errors.js';
import type { CompilerChangeStatus, CompilerPendingChange } from '../knowledge/types.js';
import { isGeneratedIdentifier } from '../sanitizer/index.js';
import { CompilerOperationError } from './errors.js';
import type {
  CompileSummary,
  CompileReviewCandidate,
  CompileReviewDisposition,
  CompileReviewReason,
  CompilerCapabilityName,
  CompilerOperationResult,
  CompilerRequest,
  CompilerWarning,
  ContextRequest,
  ContextSummary,
  EvalSummary,
  LintFinding,
  NormalizedLintSummary,
  QuerySummary,
  SearchPageSummary,
  SearchSummary,
  StatusSummary,
} from './types.js';

const MAX_COLLECTION_ITEMS = 100;
const MAX_ANSWER_CHARS = 16_384;
const MAX_CONTEXT_CHARS = 65_536;
const MAX_SUMMARY_CHARS = 2_048;
const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const ALLOWED_PENDING_STATUS = new Set(['changed', 'deleted', 'new']);
const ALLOWED_STATE_STATUS = new Set(['corrupt', 'missing', 'ok', 'too-new']);
const ALLOWED_SEVERITY = new Set(['error', 'info', 'warning']);
const ALLOWED_REVIEW_REASONS = new Set<CompileReviewReason>([
  'all',
  'connector-fetched',
  'contradicted',
  'imported-okf',
  'low-confidence',
  'manual-review-requested',
  'provenance-violating',
  'schema-violating',
]);
const CAPABILITIES = new Set<CompilerCapabilityName>([
  'approve',
  'candidates',
  'compile',
  'context',
  'eval-fast',
  'eval-full',
  'lint',
  'query',
  'search',
  'status',
]);
const REQUEST_FIELDS: Readonly<Record<CompilerCapabilityName, ReadonlySet<string>>> = {
  approve: new Set(['candidateId', 'capability', 'projectId']),
  candidates: new Set(['capability', 'projectId']),
  compile: new Set(['capability', 'projectId', 'review']),
  context: new Set(['budget', 'capability', 'depth', 'projectId', 'prompt', 'topChunks', 'topPages']),
  'eval-fast': new Set(['capability', 'projectId']),
  'eval-full': new Set(['capability', 'projectId']),
  lint: new Set(['capability', 'projectId']),
  query: new Set(['capability', 'projectId', 'question']),
  search: new Set(['capability', 'projectId', 'question']),
  status: new Set(['capability', 'projectId']),
};

type UnknownRecord = Readonly<Record<string, unknown>>;

class UnsafeStatusItemError extends Error {}

function mayWriteWorkspace(capability: CompilerCapabilityName): boolean {
  return capability === 'approve' || capability === 'compile' || capability === 'eval-full' || capability === 'query';
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isCapability(value: unknown): value is CompilerCapabilityName {
  return typeof value === 'string' && CAPABILITIES.has(value as CompilerCapabilityName);
}

function contractError(projectId: string, capability: CompilerCapabilityName): CompilerOperationError {
  return new CompilerOperationError(
    'COMPILER_CONTRACT_VIOLATION',
    'Compiler returned an unsafe result.',
    {
      capability,
      projectId,
      recoveryAction: 'status',
      retryable: false,
      sideEffectsPossible: mayWriteWorkspace(capability),
    },
  );
}

function requireRecord(
  value: unknown,
  projectId: string,
  capability: CompilerCapabilityName,
): UnknownRecord {
  if (!isRecord(value)) {
    throw contractError(projectId, capability);
  }
  return value;
}

function requireArray(
  value: unknown,
  projectId: string,
  capability: CompilerCapabilityName,
  max = MAX_COLLECTION_ITEMS,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw contractError(projectId, capability);
  }
  return value;
}

function requireFiniteNumber(
  value: unknown,
  projectId: string,
  capability: CompilerCapabilityName,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw contractError(projectId, capability);
  }
  return value;
}

function requireCount(
  value: unknown,
  projectId: string,
  capability: CompilerCapabilityName,
): number {
  const count = requireFiniteNumber(value, projectId, capability);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw contractError(projectId, capability);
  }
  return count;
}

function requireRange(
  value: unknown,
  min: number,
  max: number,
  projectId: string,
  capability: CompilerCapabilityName,
): number {
  const number = requireFiniteNumber(value, projectId, capability);
  if (number < min || number > max) {
    throw contractError(projectId, capability);
  }
  return number;
}

function requireBoolean(
  value: unknown,
  projectId: string,
  capability: CompilerCapabilityName,
): boolean {
  if (typeof value !== 'boolean') {
    throw contractError(projectId, capability);
  }
  return value;
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function requireText(
  value: unknown,
  max: number,
  projectId: string,
  capability: CompilerCapabilityName,
): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    value.includes('\u0000') ||
    value.includes('\u001b')
  ) {
    throw contractError(projectId, capability);
  }
  return value;
}

function requireCode(
  value: unknown,
  projectId: string,
  capability: CompilerCapabilityName,
): string {
  const code = requireText(value, 128, projectId, capability);
  if (!SAFE_CODE.test(code)) {
    throw contractError(projectId, capability);
  }
  return code;
}

function requireSafeRelativePath(
  value: unknown,
  projectId: string,
  capability: CompilerCapabilityName,
): string {
  const path = requireText(value, 512, projectId, capability);
  if (
    isAbsolute(path) ||
    containsControlCharacter(path) ||
    path.includes('\\') ||
    path.includes(':') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    posix.normalize(path) !== path
  ) {
    throw contractError(projectId, capability);
  }
  return path;
}

function requirePagePart(
  value: unknown,
  projectId: string,
  capability: CompilerCapabilityName,
): string {
  const part = requireText(value, 255, projectId, capability);
  if (
    part === '' ||
    part === '.' ||
    part === '..' ||
    part.includes('/') ||
    part.includes('\\') ||
    part.includes(':') ||
    containsControlCharacter(part)
  ) {
    throw contractError(projectId, capability);
  }
  return part;
}

function requirePageId(
  value: unknown,
  projectId: string,
  capability: CompilerCapabilityName,
): string {
  const pageId = requireText(value, 320, projectId, capability);
  const slash = pageId.indexOf('/');
  if (slash < 1 || slash !== pageId.lastIndexOf('/')) {
    throw contractError(projectId, capability);
  }
  const namespace = pageId.slice(0, slash);
  const part = pageId.slice(slash + 1);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(namespace)) {
    throw contractError(projectId, capability);
  }
  requirePagePart(part, projectId, capability);
  return pageId;
}

function compilePageId(
  value: unknown,
  projectId: string,
  capability: CompilerCapabilityName,
): string {
  const raw = requireText(value, 320, projectId, capability);
  return raw.includes('/')
    ? requirePageId(raw, projectId, capability)
    : `concepts/${requirePagePart(raw, projectId, capability)}`;
}

function warningsFrom(
  value: unknown,
  projectId: string,
  capability: CompilerCapabilityName,
): readonly CompilerWarning[] {
  if (value === undefined) {
    return [];
  }
  const warnings = requireArray(value, projectId, capability);
  return warnings.map((item) => {
    const warning = requireRecord(item, projectId, capability);
    return { code: requireCode(warning.code, projectId, capability) };
  });
}

function normalizeCompile(raw: unknown, projectId: string): {
  readonly data: CompileSummary;
  readonly outcome: CompilerOperationResult['outcome'];
  readonly warnings: readonly CompilerWarning[];
} {
  const capability = 'compile';
  const value = requireRecord(raw, projectId, capability);
  const errors = requireArray(value.errors, projectId, capability);
  if (errors.length > 0) {
    throw new CompilerOperationError('COMPILER_FAILED', 'Compiler did not complete successfully.', {
      capability,
      projectId,
      recoveryAction: 'status',
      retryable: false,
      sideEffectsPossible: true,
    });
  }
  const compiled = requireCount(value.compiled, projectId, capability);
  const deleted = requireCount(value.deleted, projectId, capability);
  const skipped = requireCount(value.skipped, projectId, capability);
  requireArray(value.concepts, projectId, capability);
  const pageIds = requireArray(value.pages, projectId, capability)
    .map((page) => compilePageId(page, projectId, capability))
    .sort();
  if (new Set(pageIds).size !== pageIds.length) {
    throw contractError(projectId, capability);
  }
  const candidateIds = value.candidates === undefined
    ? []
    : requireArray(value.candidates, projectId, capability).map((candidate) =>
      requireCandidateId(candidate, undefined, projectId),
    );
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw contractError(projectId, capability);
  }
  const candidates = normalizeCompileReview(value.review, candidateIds, projectId);
  return {
    data: {
      candidateCount: candidates.length,
      candidates,
      compiled,
      deleted,
      pageIds,
      skipped,
    },
    outcome: compiled === 0 && deleted === 0 ? 'unchanged' : 'succeeded',
    warnings: [],
  };
}

function requireCandidateSlug(value: unknown, projectId: string): string {
  const slug = requirePagePart(value, projectId, 'compile');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    throw contractError(projectId, 'compile');
  }
  return slug;
}

function requireCandidateId(value: unknown, slug: string | undefined, projectId: string): string {
  const id = requireText(value, 320, projectId, 'compile');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}$/u.test(id)) {
    throw contractError(projectId, 'compile');
  }
  if (slug !== undefined && id !== `${slug}-${id.slice(-8)}`) {
    throw contractError(projectId, 'compile');
  }
  return id;
}

function normalizeReviewCandidate(
  value: unknown,
  disposition: CompileReviewDisposition,
  projectId: string,
): CompileReviewCandidate {
  const candidate = requireRecord(value, projectId, 'compile');
  const slug = requireCandidateSlug(candidate.slug, projectId);
  const id = requireCandidateId(candidate.id, slug, projectId);
  const reasons = requireArray(candidate.reasons, projectId, 'compile').map((reason) => {
    const normalized = requireCode(reason, projectId, 'compile') as CompileReviewReason;
    if (!ALLOWED_REVIEW_REASONS.has(normalized)) {
      throw contractError(projectId, 'compile');
    }
    return normalized;
  }).sort();
  if (reasons.length === 0 || new Set(reasons).size !== reasons.length) {
    throw contractError(projectId, 'compile');
  }
  return { disposition, id, reasons, slug };
}

function normalizeCompileReview(
  raw: unknown,
  candidateIds: readonly string[],
  projectId: string,
): readonly CompileReviewCandidate[] {
  if (raw === undefined) {
    if (candidateIds.length !== 0) throw contractError(projectId, 'compile');
    return [];
  }
  const review = requireRecord(raw, projectId, 'compile');
  const candidates = [
    ...requireArray(review.held, projectId, 'compile').map((candidate) =>
      normalizeReviewCandidate(candidate, 'held', projectId),
    ),
    ...requireArray(review.forced, projectId, 'compile').map((candidate) =>
      normalizeReviewCandidate(candidate, 'forced', projectId),
    ),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const normalizedIds = candidates.map((candidate) => candidate.id);
  if (
    new Set(normalizedIds).size !== normalizedIds.length ||
    normalizedIds.length !== candidateIds.length ||
    [...candidateIds].sort().some((id, index) => id !== normalizedIds[index])
  ) {
    throw contractError(projectId, 'compile');
  }
  return candidates;
}

function normalizePendingChange(
  change: unknown,
  projectId: string,
  capability: CompilerCapabilityName,
): CompilerPendingChange {
  const value = requireRecord(change, projectId, capability);
  const file = requireText(value.file, 255, projectId, capability);
  const status = requireText(value.status, 32, projectId, capability);
  if (
    basename(file) !== file ||
    file.includes('\\') ||
    containsControlCharacter(file) ||
    !file.endsWith('.md') ||
    !ALLOWED_PENDING_STATUS.has(status)
  ) {
    throw new UnsafeStatusItemError();
  }
  return { file, status: status as CompilerPendingChange['status'] };
}

function normalizeCompilerChangeStatus(
  raw: unknown,
  projectId: string,
): CompilerChangeStatus {
  const capability = 'status';
  const value = requireRecord(raw, projectId, capability);
  const pendingItems = requireArray(value.pendingChanges, projectId, capability);
  const pendingChanges = pendingItems
    .map((change) => normalizePendingChange(change, projectId, capability))
    .sort((left, right) => left.file.localeCompare(right.file));
  const pendingChangesCount = requireCount(value.pendingChangesCount, projectId, capability);
  const stateStatus = requireText(value.stateStatus, 32, projectId, capability);
  if (
    pendingChangesCount < pendingChanges.length ||
    new Set(pendingChanges.map((change) => change.file)).size !== pendingChanges.length ||
    !ALLOWED_STATE_STATUS.has(stateStatus) ||
    ((stateStatus === 'corrupt' || stateStatus === 'too-new') &&
      (pendingChanges.length !== 0 || pendingChangesCount !== 0))
  ) {
    throw contractError(projectId, capability);
  }
  return {
    pendingChanges,
    pendingChangesCount,
    stateStatus: stateStatus as CompilerChangeStatus['stateStatus'],
  };
}

export function normalizeCompilerStatus(raw: unknown): CompilerChangeStatus {
  try {
    return normalizeCompilerChangeStatus(raw, 'status');
  } catch (error) {
    throw new KnowledgeError(
      'COMPILER_STATUS_UNSAFE',
      error instanceof UnsafeStatusItemError
        ? 'Compiler returned an unsafe status item.'
        : 'Compiler returned an unsafe status result.',
    );
  }
}

function normalizeStatus(raw: unknown, projectId: string): {
  readonly data: StatusSummary;
  readonly outcome: 'succeeded';
  readonly warnings: readonly CompilerWarning[];
} {
  const capability = 'status';
  const value = requireRecord(raw, projectId, capability);
  const changes = normalizeCompilerChangeStatus(raw, projectId);
  const pages = requireRecord(value.pages, projectId, capability);
  const stalePages = requireArray(value.stalePages, projectId, capability)
    .map((page) => requirePagePart(page, projectId, capability))
    .sort();
  const orphanedPages = requireArray(value.orphanedPages, projectId, capability)
    .map((page) => requirePagePart(page, projectId, capability))
    .sort();
  const staleCount = requireCount(value.staleCount, projectId, capability);
  const orphanedCount = requireCount(value.orphanedCount, projectId, capability);
  const lastCompiledAt =
    value.lastCompiledAt === null
      ? null
      : requireText(value.lastCompiledAt, 64, projectId, capability);
  if (lastCompiledAt !== null && !isCanonicalIsoTimestamp(lastCompiledAt)) {
    throw contractError(projectId, capability);
  }
  if (
    staleCount < stalePages.length ||
    orphanedCount < orphanedPages.length ||
    new Set(stalePages).size !== stalePages.length ||
    new Set(orphanedPages).size !== orphanedPages.length
  ) {
    throw contractError(projectId, capability);
  }
  return {
    data: {
      ...changes,
      lastCompiledAt,
      orphanedCount,
      orphanedPages,
      pageCount: requireCount(pages.total, projectId, capability),
      pendingCandidates: requireCount(value.pendingCandidates, projectId, capability),
      sourceCount: requireCount(value.sources, projectId, capability),
      staleCount,
      stalePages,
    },
    outcome: 'succeeded',
    warnings: warningsFrom(value.warnings, projectId, capability),
  };
}

function normalizeLint(raw: unknown, projectId: string): {
  readonly data: NormalizedLintSummary;
  readonly outcome: 'succeeded';
  readonly warnings: readonly CompilerWarning[];
} {
  const capability = 'lint';
  const value = requireRecord(raw, projectId, capability);
  const findings: LintFinding[] = requireArray(value.results, projectId, capability).map((item) => {
    const finding = requireRecord(item, projectId, capability);
    const severity = requireText(finding.severity, 16, projectId, capability);
    if (!ALLOWED_SEVERITY.has(severity)) {
      throw contractError(projectId, capability);
    }
    const line =
      finding.line === undefined ? undefined : requireCount(finding.line, projectId, capability);
    return {
      file: requireSafeRelativePath(finding.file, projectId, capability),
      ...(line === undefined ? {} : { line }),
      rule: requireCode(finding.rule, projectId, capability),
      severity: severity as LintFinding['severity'],
    };
  });
  const errors = requireCount(value.errors, projectId, capability);
  const info = requireCount(value.info, projectId, capability);
  const warnings = requireCount(value.warnings, projectId, capability);
  if (
    errors !== findings.filter((finding) => finding.severity === 'error').length ||
    info !== findings.filter((finding) => finding.severity === 'info').length ||
    warnings !== findings.filter((finding) => finding.severity === 'warning').length
  ) {
    throw contractError(projectId, capability);
  }
  return {
    data: {
      errors,
      findings,
      info,
      warnings,
    },
    outcome: 'succeeded',
    warnings: [],
  };
}

function normalizeEval(
  raw: unknown,
  projectId: string,
  capability: 'eval-fast' | 'eval-full',
): {
  readonly data: EvalSummary;
  readonly outcome: 'succeeded';
  readonly warnings: readonly CompilerWarning[];
} {
  const value = requireRecord(raw, projectId, capability);
  const suite = requireText(value.suite, 16, projectId, capability);
  if ((capability === 'eval-fast' && suite !== 'fast') || (capability === 'eval-full' && suite !== 'full')) {
    throw contractError(projectId, capability);
  }
  const health = requireRecord(value.health, projectId, capability);
  const coverage = requireRecord(value.citationCoverage, projectId, capability);
  const stats = requireRecord(value.stats, projectId, capability);
  const support =
    value.citationSupport === undefined
      ? undefined
      : requireRecord(value.citationSupport, projectId, capability);
  if (
    (capability === 'eval-full' && support === undefined) ||
    (capability === 'eval-fast' && support !== undefined)
  ) {
    throw contractError(projectId, capability);
  }
  if (
    support !== undefined &&
    requireCount(support.judgeErrors, projectId, capability) > 0
  ) {
    throw new CompilerOperationError('COMPILER_FAILED', 'Compiler did not complete successfully.', {
      capability,
      projectId,
      recoveryAction: 'status',
      retryable: false,
      sideEffectsPossible: true,
    });
  }
  const citationSupportMean =
    support === undefined
      ? undefined
      : requireRange(support.meanScore, 0, 2, projectId, capability);
  return {
    data: {
      citationCoveragePercent: requireRange(
        coverage.coveragePercent,
        0,
        100,
        projectId,
        capability,
      ),
      citationPrecisionPercent: requireRange(
        coverage.precisionPercent,
        0,
        100,
        projectId,
        capability,
      ),
      ...(citationSupportMean === undefined ? {} : { citationSupportMean }),
      embeddingsAvailable: stats.embeddingsAvailable === undefined
        ? true
        : requireBoolean(stats.embeddingsAvailable, projectId, capability),
      healthScore: requireRange(health.score, 0, 100, projectId, capability),
      pageCount: requireCount(stats.pageCount, projectId, capability),
      pendingReviews: requireCount(health.pendingReviews, projectId, capability),
      sourceCount: requireCount(stats.sourceCount, projectId, capability),
      suite: suite as EvalSummary['suite'],
      thresholdViolationCount: requireArray(
        value.thresholdViolations,
        projectId,
        capability,
      ).length,
    },
    outcome: 'succeeded',
    warnings: [],
  };
}

function normalizeSearch(raw: unknown, projectId: string): {
  readonly data: SearchSummary;
  readonly outcome: 'succeeded';
  readonly warnings: readonly CompilerWarning[];
} {
  const capability = 'search';
  const value = requireRecord(raw, projectId, capability);
  const pages = requireArray(value.pages, projectId, capability);
  const refs = requireArray(value.refs, projectId, capability);
  if (pages.length !== refs.length) {
    throw contractError(projectId, capability);
  }
  const normalized: SearchPageSummary[] = pages.map((item, index) => {
    const page = requireRecord(item, projectId, capability);
    const ref = requireRecord(refs[index], projectId, capability);
    const kind = requireText(ref.kind, 16, projectId, capability);
    if (kind !== 'chunk' && kind !== 'index' && kind !== 'page') {
      throw contractError(projectId, capability);
    }
    const slug = requirePagePart(page.slug, projectId, capability);
    const pageId = requirePageId(ref.pageId, projectId, capability);
    const refSlug = requirePagePart(ref.slug, projectId, capability);
    const title = requireText(page.title, 512, projectId, capability);
    requireText(ref.title, 512, projectId, capability);
    if (slug !== refSlug || pageId.slice(pageId.indexOf('/') + 1) !== slug) {
      throw contractError(projectId, capability);
    }
    return {
      kind,
      pageId,
      slug,
      summary: requireText(page.summary, MAX_SUMMARY_CHARS, projectId, capability),
      title,
    };
  });
  if (new Set(normalized.map((page) => page.pageId)).size !== normalized.length) {
    throw contractError(projectId, capability);
  }
  return {
    data: { pages: normalized },
    outcome: 'succeeded',
    warnings: warningsFrom(value.warnings, projectId, capability),
  };
}

function normalizeQuery(raw: unknown, projectId: string): {
  readonly data: QuerySummary;
  readonly outcome: 'succeeded';
  readonly warnings: readonly CompilerWarning[];
} {
  const capability = 'query';
  const value = requireRecord(raw, projectId, capability);
  if (value.saved !== undefined || value.debug !== undefined) {
    throw contractError(projectId, capability);
  }
  const pageIds = requireArray(value.pageIds, projectId, capability).map((pageId) =>
    requirePageId(pageId, projectId, capability),
  );
  const refs = requireArray(value.refs, projectId, capability);
  const selectedPages = requireArray(value.selectedPages, projectId, capability);
  if (refs.length !== pageIds.length || selectedPages.length !== pageIds.length) {
    throw contractError(projectId, capability);
  }
  refs.forEach((item, index) => {
    const ref = requireRecord(item, projectId, capability);
    const pageId = requirePageId(ref.pageId, projectId, capability);
    const slug = requirePagePart(ref.slug, projectId, capability);
    const selectedPage = requirePagePart(selectedPages[index], projectId, capability);
    if (
      pageId !== pageIds[index] ||
      slug !== selectedPage ||
      pageId.slice(pageId.indexOf('/') + 1) !== slug
    ) {
      throw contractError(projectId, capability);
    }
  });
  if (new Set(pageIds).size !== pageIds.length) {
    throw contractError(projectId, capability);
  }
  return {
    data: {
      answer: requireNonEmptyText(value.answer, MAX_ANSWER_CHARS, projectId, capability),
      pageIds,
    },
    outcome: 'succeeded',
    warnings: warningsFrom(value.warnings, projectId, capability),
  };
}

function requireNonEmptyText(
  value: unknown,
  max: number,
  projectId: string,
  capability: CompilerCapabilityName,
): string {
  const text = requireText(value, max, projectId, capability);
  if (text.trim() === '') {
    throw contractError(projectId, capability);
  }
  return text;
}

function normalizeContext(raw: unknown, projectId: string): {
  readonly data: ContextSummary;
  readonly outcome: 'succeeded';
  readonly warnings: readonly CompilerWarning[];
} {
  const capability = 'context';
  const value = requireRecord(raw, projectId, capability);
  if (value.version !== 1) {
    throw contractError(projectId, capability);
  }
  const warnings = warningsFrom(value.warnings, projectId, capability);
  if (warnings.some((warning) => warning.code === 'query-embedding-unavailable')) {
    throw new CompilerOperationError(
      'COMPILER_PROVIDER_UNAVAILABLE',
      'Compiler provider is unavailable.',
      {
        capability,
        projectId,
        recoveryAction: 'check-config',
        retryable: false,
        sideEffectsPossible: false,
      },
    );
  }
  if (warnings.some((warning) => warning.code === 'semantic-retrieval-error')) {
    throw new CompilerOperationError('COMPILER_FAILED', 'Compiler operation failed.', {
      capability,
      projectId,
      recoveryAction: 'status',
      retryable: false,
      sideEffectsPossible: false,
    });
  }
  const budget = requireRecord(value.budget, projectId, capability);
  const primary = requireArray(value.primary, projectId, capability, 50).map((item) => {
    const page = requireRecord(item, projectId, capability);
    const chunks = requireArray(page.chunks, projectId, capability).map((chunk) => {
      const record = requireRecord(chunk, projectId, capability);
      return requireText(record.text, MAX_CONTEXT_CHARS, projectId, capability);
    });
    const reasons = requireArray(page.reasons, projectId, capability).map((reason) =>
      requireCode(reason, projectId, capability),
    );
    return {
      chunks,
      id: requirePageId(page.id, projectId, capability),
      reasons,
      score: requireFiniteNumber(page.score, projectId, capability),
      summary: requireText(page.summary, MAX_SUMMARY_CHARS, projectId, capability),
      title: requireText(page.title, 512, projectId, capability),
    };
  });
  const totalContextChars = primary.reduce(
    (total, page) => total + page.summary.length + page.chunks.join('').length,
    0,
  );
  if (totalContextChars > MAX_CONTEXT_CHARS) {
    throw contractError(projectId, capability);
  }
  const gaps = requireArray(value.gaps, projectId, capability).map((item) => {
    const gap = requireRecord(item, projectId, capability);
    return {
      code: requireCode(gap.code, projectId, capability),
      pageId: requirePageId(gap.pageId, projectId, capability),
    };
  });
  return {
    data: {
      budget: {
        estimatedTokens: requireCount(budget.estimatedTokens, projectId, capability),
        requestedTokens: requireCount(budget.requestedTokens, projectId, capability),
        truncated: requireBoolean(budget.truncated, projectId, capability),
      },
      gaps,
      primary,
      version: 1,
    },
    outcome: 'succeeded',
    warnings,
  };
}

export function validateCompilerRequest(request: unknown): asserts request is CompilerRequest {
  if (!isRecord(request)) {
    throw configInputError(request);
  }
  const capability = request.capability;
  if (!isCapability(capability) || typeof request.projectId !== 'string') {
    throw configInputError(request);
  }
  const requiredFields =
    capability === 'context'
      ? ['capability', 'projectId', 'prompt']
      : capability === 'query' || capability === 'search'
        ? ['capability', 'projectId', 'question']
        : ['capability', 'projectId'];
  if (
    Object.keys(request).some((field) => !REQUEST_FIELDS[capability].has(field)) ||
    requiredFields.some((field) => !Object.hasOwn(request, field))
  ) {
    throw configInputError(request);
  }
  const text = capability === 'context' ? request.prompt : 'question' in request ? request.question : undefined;
  if (
    (capability === 'context' || capability === 'query' || capability === 'search') &&
    (typeof text !== 'string' ||
      text.trim() === '' ||
      text.length > 8_192 ||
      containsControlCharacter(text))
  ) {
    throw configInputError(request);
  }
  if (capability === 'context') {
    validateContextOptions(request as unknown as ContextRequest);
  }
  if (capability === 'compile' && request.review !== undefined && typeof request.review !== 'boolean') {
    throw configInputError(request);
  }
  if (
    capability === 'approve' &&
    (typeof request.candidateId !== 'string' ||
      !isGeneratedIdentifier(request.candidateId, 'candidate'))
  ) {
    throw configInputError(request);
  }
}

function configInputError(request: unknown): CompilerOperationError {
  const capability = isRecord(request) && isCapability(request.capability)
    ? request.capability
    : 'unknown';
  const projectId =
    isRecord(request) &&
    typeof request.projectId === 'string' &&
    request.projectId.length <= 64 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request.projectId)
      ? request.projectId
      : 'unknown';
  return new CompilerOperationError('COMPILER_CONFIG_INVALID', 'Compiler input is invalid.', {
    capability,
    projectId,
    recoveryAction: 'check-config',
    retryable: false,
    sideEffectsPossible: false,
  });
}

function validateContextOptions(request: ContextRequest): void {
  const ranges: ReadonlyArray<readonly [number | undefined, number, number]> = [
    [request.budget, 1, 100_000],
    [request.depth, 0, 2],
    [request.topPages, 1, 20],
    [request.topChunks, 0, 50],
  ];
  if (
    ranges.some(
      ([value, min, max]) =>
        value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max),
    )
  ) {
    throw new CompilerOperationError('COMPILER_CONFIG_INVALID', 'Compiler input is invalid.', {
      capability: request.capability,
      projectId: request.projectId,
      recoveryAction: 'check-config',
      retryable: false,
      sideEffectsPossible: false,
    });
  }
}

export function normalizeCompilerResult(
  request: CompilerRequest,
  raw: unknown,
): CompilerOperationResult {
  let normalized:
    | ReturnType<typeof normalizeCompile>
    | ReturnType<typeof normalizeContext>
    | ReturnType<typeof normalizeEval>
    | ReturnType<typeof normalizeLint>
    | ReturnType<typeof normalizeQuery>
    | ReturnType<typeof normalizeSearch>
    | ReturnType<typeof normalizeStatus>;
  switch (request.capability) {
    case 'approve':
    case 'candidates':
      throw contractError(request.projectId, request.capability);
    case 'compile':
      normalized = normalizeCompile(raw, request.projectId);
      break;
    case 'context':
      normalized = normalizeContext(raw, request.projectId);
      break;
    case 'eval-fast':
    case 'eval-full':
      normalized = normalizeEval(raw, request.projectId, request.capability);
      break;
    case 'lint':
      normalized = normalizeLint(raw, request.projectId);
      break;
    case 'query':
      normalized = normalizeQuery(raw, request.projectId);
      break;
    case 'search':
      normalized = normalizeSearch(raw, request.projectId);
      break;
    case 'status':
      normalized = normalizeStatus(raw, request.projectId);
      break;
  }
  return {
    capability: request.capability,
    data: normalized.data,
    ok: true,
    outcome: normalized.outcome,
    projectId: request.projectId,
    warnings: normalized.warnings,
  };
}
