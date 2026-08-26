import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import { decodeUtf8Strict, parseJsonStrict } from '../../knowledge/strict-json.js';
import { validateProjectId } from '../../knowledge/validation.js';
import { SessionCompileError } from './errors.js';
import { canonicalSessionJson, compareSessionText, digestSessionValue } from './canonical.js';
import {
  SESSION_COMPILE_ALGORITHM_VERSION,
  SESSION_COMPILE_APPLY_RESULT_SCHEMA_VERSION,
  SESSION_COMPILE_PLAN_SCHEMA_VERSION,
  SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION,
  SESSION_COMPILE_PROVENANCE_SCHEMA_VERSION,
  type SessionCallerHarnessIdentity,
  type SessionCompileLimits,
  type SessionCompilePlanV1,
  type SessionCompileProposalV1,
  type SessionProfileFieldValue,
  type SessionProposalCitation,
  type SessionRequestedPageKind,
  type SessionSha256Digest,
} from './types.js';

export const SESSION_COMPILE_LIMITS: SessionCompileLimits = Object.freeze({
  maxCitationsPerPage: 512,
  maxLinksPerPage: 256,
  maxMergeCandidates: 512,
  maxPageBytes: 524288,
  maxPlanBytes: 33554432,
  maxProposalBytes: 524288,
  maxProposals: 50,
  maxQuoteCodeUnits: 512,
  maxSourceBytes: 524288,
  maxSources: 4096,
  maxTasks: 8192,
});

export const SESSION_COMPILE_CONTRACT_DIGEST = digestSessionValue({
  algorithmVersion: SESSION_COMPILE_ALGORITHM_VERSION,
  applyResultSchemaVersion: SESSION_COMPILE_APPLY_RESULT_SCHEMA_VERSION,
  limits: SESSION_COMPILE_LIMITS,
  planSchemaVersion: SESSION_COMPILE_PLAN_SCHEMA_VERSION,
  proposalSchemaVersion: SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION,
  provenanceSchemaVersion: SESSION_COMPILE_PROVENANCE_SCHEMA_VERSION,
});

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const KIND_VALUES = new Set<SessionRequestedPageKind>([
  'concept',
  'decision',
  'failure',
  'query',
  'verification',
]);
const PROFILE_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

type UnknownRecord = Readonly<Record<string, unknown>>;

function invalid(projectId: string): never {
  throw new SessionCompileError('SESSION_CONTRACT_INVALID', projectId);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, projectId: string): UnknownRecord {
  if (!isRecord(value)) return invalid(projectId);
  return value;
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  projectId: string,
): void {
  const actual = Object.keys(value).sort(compareSessionText);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !allowed.has(key)) ||
    actual.length < required.length ||
    actual.length > required.length + optional.length
  ) return invalid(projectId);
}

function text(
  value: unknown,
  projectId: string,
  options: { readonly max: number; readonly min?: number; readonly pattern?: RegExp },
): string {
  if (typeof value !== 'string') return invalid(projectId);
  const normalized = value.normalize('NFC');
  if (
    normalized !== value ||
    value.length < (options.min ?? 1) ||
    value.length > options.max ||
    value.includes('\r') ||
    containsUnsafeCharacter(value) ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) return invalid(projectId);
  return value;
}

function containsUnsafeCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function digest(value: unknown, projectId: string): SessionSha256Digest {
  return text(value, projectId, { max: 71, pattern: DIGEST_PATTERN }) as SessionSha256Digest;
}

function finiteNumber(
  value: unknown,
  projectId: string,
  options: { readonly integer?: boolean; readonly max: number; readonly min: number },
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (options.integer === true && !Number.isSafeInteger(value)) ||
    value < options.min ||
    value > options.max
  ) return invalid(projectId);
  return value;
}

function stringArray(
  value: unknown,
  projectId: string,
  options: { readonly max: number; readonly pattern: RegExp; readonly requireNonEmpty?: boolean },
): readonly string[] {
  if (!Array.isArray(value) || value.length > options.max ||
      (options.requireNonEmpty === true && value.length === 0)) return invalid(projectId);
  const result = value.map((item) => text(item, projectId, {
    max: 128,
    pattern: options.pattern,
  }));
  const sorted = [...result].sort(compareSessionText);
  if (new Set(result).size !== result.length || result.some((item, index) => item !== sorted[index])) {
    return invalid(projectId);
  }
  return Object.freeze(result);
}

function portableSourceRef(value: unknown, projectId: string): string {
  const result = text(value, projectId, { max: 512 });
  if (
    result.startsWith('/') ||
    result.startsWith('~') ||
    result.includes('\\') ||
    /^[A-Za-z]:/u.test(result) ||
    result.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) return invalid(projectId);
  return result;
}

function parseHarness(value: unknown, projectId: string): SessionCallerHarnessIdentity {
  const harness = record(value, projectId);
  exactKeys(harness, ['compatibilityDigest', 'kind', 'version'], [], projectId);
  return Object.freeze({
    compatibilityDigest: digest(harness.compatibilityDigest, projectId),
    kind: text(harness.kind, projectId, { max: 64, pattern: /^[a-z0-9][a-z0-9._-]*$/u }),
    version: text(harness.version, projectId, {
      max: 128,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u,
    }),
  });
}

function parseCitation(value: unknown, projectId: string): SessionProposalCitation {
  const citation = record(value, projectId);
  exactKeys(citation, ['file', 'id', 'line', 'quote', 'sourceId'], [], projectId);
  const quote = text(citation.quote, projectId, { max: SESSION_COMPILE_LIMITS.maxQuoteCodeUnits });
  if (quote.includes('\n')) return invalid(projectId);
  return Object.freeze({
    file: portableSourceRef(citation.file, projectId),
    id: text(citation.id, projectId, { max: 128, pattern: SAFE_ID_PATTERN }),
    line: finiteNumber(citation.line, projectId, {
      integer: true,
      max: Number.MAX_SAFE_INTEGER,
      min: 1,
    }),
    quote,
    sourceId: text(citation.sourceId, projectId, { max: 128, pattern: /^source-[a-f0-9]{64}$/u }),
  });
}

function profileFieldValue(value: unknown, projectId: string): SessionProfileFieldValue {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return finiteNumber(value, projectId, { max: Number.MAX_SAFE_INTEGER, min: -Number.MAX_SAFE_INTEGER });
  }
  if (typeof value === 'string') return text(value, projectId, { max: 8_000 });
  if (Array.isArray(value) && value.length <= 128) {
    return Object.freeze(value.map((item) => text(item, projectId, { max: 1_000 })));
  }
  return invalid(projectId);
}

function parseProfileFields(value: unknown, projectId: string): Readonly<Record<string, SessionProfileFieldValue>> {
  const fields = record(value, projectId);
  const keys = Object.keys(fields);
  if (
    keys.length > 128 ||
    keys.some((key) => !PROFILE_FIELD_PATTERN.test(key)) ||
    keys.some((key, index) => index > 0 && compareSessionText(keys[index - 1] as string, key) >= 0)
  ) return invalid(projectId);
  const result: Record<string, SessionProfileFieldValue> = {};
  for (const key of keys) result[key] = profileFieldValue(fields[key], projectId);
  return Object.freeze(result);
}

function expectedPageId(kind: SessionRequestedPageKind, slug: string): string {
  const directory = kind === 'concept'
    ? 'concepts'
    : kind === 'query'
      ? 'queries'
      : kind === 'decision'
        ? 'decisions'
        : kind === 'failure'
          ? 'failures'
          : 'verifications';
  return `${directory}/${slug}`;
}

function proposalWithoutDigest(proposal: SessionCompileProposalV1): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: proposal.schemaVersion,
    projectId: proposal.projectId,
    planDigest: proposal.planDigest,
    proposalId: proposal.proposalId,
    taskId: proposal.taskId,
    mergeCandidateIds: proposal.mergeCandidateIds,
    pageId: proposal.pageId,
    slug: proposal.slug,
    title: proposal.title,
    kind: proposal.kind,
    summary: proposal.summary,
    body: proposal.body,
    sources: proposal.sources,
    wikilinks: proposal.wikilinks,
    citations: proposal.citations,
    confidence: proposal.confidence,
    callerHarness: proposal.callerHarness,
    ...(proposal.profileFields === undefined ? {} : { profileFields: proposal.profileFields }),
  };
}

export function callerHarnessCompatibilityDigest(
  kind: string,
  version: string,
): SessionSha256Digest {
  return digestSessionValue({
    contractDigest: SESSION_COMPILE_CONTRACT_DIGEST,
    kind,
    proposalSchemaVersion: SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION,
    version,
  });
}

export function proposalDigest(proposal: SessionCompileProposalV1): SessionSha256Digest {
  return digestSessionValue(proposalWithoutDigest(proposal));
}

export function parseSessionCompileProposal(
  value: unknown,
  expectedProjectId: string,
): SessionCompileProposalV1 {
  let projectId: string;
  try {
    projectId = validateProjectId(expectedProjectId);
  } catch {
    return invalid('unknown');
  }
  const proposal = record(value, projectId);
  exactKeys(proposal, [
    'body',
    'callerHarness',
    'citations',
    'confidence',
    'kind',
    'mergeCandidateIds',
    'pageId',
    'planDigest',
    'projectId',
    'proposalDigest',
    'proposalId',
    'schemaVersion',
    'slug',
    'sources',
    'summary',
    'taskId',
    'title',
    'wikilinks',
  ], ['profileFields'], projectId);
  if (proposal.schemaVersion !== SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION ||
      proposal.projectId !== projectId || !KIND_VALUES.has(proposal.kind as SessionRequestedPageKind)) {
    return invalid(projectId);
  }
  const kind = proposal.kind as SessionRequestedPageKind;
  const slug = text(proposal.slug, projectId, { max: 128, pattern: SLUG_PATTERN });
  const citationsRaw = Array.isArray(proposal.citations) ? proposal.citations : invalid(projectId);
  if (citationsRaw.length > SESSION_COMPILE_LIMITS.maxCitationsPerPage) return invalid(projectId);
  const citations = citationsRaw.map((item) => parseCitation(item, projectId));
  if (
    new Set(citations.map((citation) => citation.id)).size !== citations.length ||
    citations.some((citation, index) =>
      index > 0 && compareSessionText(citations[index - 1]?.id ?? '', citation.id) >= 0)
  ) return invalid(projectId);
  const parsed: SessionCompileProposalV1 = Object.freeze({
    schemaVersion: SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION,
    projectId,
    planDigest: digest(proposal.planDigest, projectId),
    proposalId: text(proposal.proposalId, projectId, { max: 128, pattern: SAFE_ID_PATTERN }),
    proposalDigest: digest(proposal.proposalDigest, projectId),
    taskId: text(proposal.taskId, projectId, { max: 128, pattern: /^task-[a-f0-9]{64}$/u }),
    mergeCandidateIds: stringArray(proposal.mergeCandidateIds, projectId, {
      max: SESSION_COMPILE_LIMITS.maxMergeCandidates,
      pattern: /^merge-[a-f0-9]{64}$/u,
    }),
    pageId: text(proposal.pageId, projectId, { max: 260 }),
    slug,
    title: text(proposal.title, projectId, { max: 200 }),
    kind,
    summary: text(proposal.summary, projectId, { max: 4_000 }),
    body: text(proposal.body, projectId, { max: 100_000 }),
    sources: stringArray(proposal.sources, projectId, {
      max: SESSION_COMPILE_LIMITS.maxSources,
      pattern: /^source-[a-f0-9]{64}$/u,
      requireNonEmpty: true,
    }),
    wikilinks: stringArray(proposal.wikilinks, projectId, {
      max: SESSION_COMPILE_LIMITS.maxLinksPerPage,
      pattern: SLUG_PATTERN,
    }),
    citations: Object.freeze(citations),
    confidence: finiteNumber(proposal.confidence, projectId, { max: 1, min: 0 }),
    callerHarness: parseHarness(proposal.callerHarness, projectId),
    ...(proposal.profileFields === undefined
      ? {}
      : { profileFields: parseProfileFields(proposal.profileFields, projectId) }),
  });
  if (
    parsed.pageId !== expectedPageId(kind, slug) ||
    Buffer.byteLength(parsed.body, 'utf8') > SESSION_COMPILE_LIMITS.maxPageBytes ||
    parsed.callerHarness.compatibilityDigest !== callerHarnessCompatibilityDigest(
      parsed.callerHarness.kind,
      parsed.callerHarness.version,
    ) ||
    parsed.proposalDigest !== proposalDigest(parsed)
  ) return invalid(projectId);
  return parsed;
}

export function parseSessionCompileProposalBytes(
  bytes: Uint8Array,
  expectedProjectId: string,
): SessionCompileProposalV1 {
  if (bytes.byteLength > SESSION_COMPILE_LIMITS.maxProposalBytes) return invalid(expectedProjectId);
  let source: string;
  let value: unknown;
  try {
    source = decodeUtf8Strict(bytes);
    if (!source.endsWith('\n') || source.includes('\r')) return invalid(expectedProjectId);
    value = parseJsonStrict(source);
  } catch {
    return invalid(expectedProjectId);
  }
  const proposal = parseSessionCompileProposal(value, expectedProjectId);
  if (serializeCanonicalJson(proposal) !== source) return invalid(expectedProjectId);
  return proposal;
}

export async function readSessionCompileProposalFile(
  path: string,
  expectedProjectId: string,
): Promise<SessionCompileProposalV1> {
  let handle;
  try {
    const expected = await lstat(path, { bigint: true });
    if (!expected.isFile() || expected.isSymbolicLink() ||
        expected.size > BigInt(SESSION_COMPILE_LIMITS.maxProposalBytes)) return invalid(expectedProjectId);
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino ||
        before.size !== expected.size) return invalid(expectedProjectId);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        bytes.byteLength !== Number(after.size)) return invalid(expectedProjectId);
    return parseSessionCompileProposalBytes(bytes, expectedProjectId);
  } catch (error) {
    if (error instanceof SessionCompileError) throw error;
    return invalid(expectedProjectId);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type PlanWithoutDigest = Omit<SessionCompilePlanV1, 'planDigest'>;

export function finalizeSessionCompilePlan(plan: PlanWithoutDigest): SessionCompilePlanV1 {
  const result: SessionCompilePlanV1 = Object.freeze({
    schemaVersion: plan.schemaVersion,
    projectId: plan.projectId,
    contractDigest: plan.contractDigest,
    planDigest: digestSessionValue(plan),
    profileDigest: plan.profileDigest,
    policyDigest: plan.policyDigest,
    selectionDigest: plan.selectionDigest,
    sourceManifestDigest: plan.sourceManifestDigest,
    existingKnowledgeDigest: plan.existingKnowledgeDigest,
    algorithmVersion: plan.algorithmVersion,
    limits: plan.limits,
    sources: plan.sources,
    tasks: plan.tasks,
    mergeCandidates: plan.mergeCandidates,
    allowedLinkTargets: plan.allowedLinkTargets,
  });
  if (Buffer.byteLength(canonicalSessionJson(result), 'utf8') > SESSION_COMPILE_LIMITS.maxPlanBytes) {
    throw new SessionCompileError('SESSION_PLAN_DENIED', plan.projectId);
  }
  return result;
}
