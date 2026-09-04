import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { serializeCanonicalJson, syncDirectory, writeJsonAtomic } from '../../knowledge/atomic-file.js';
import { parseJsonStrict } from '../../knowledge/strict-json.js';
import {
  generatedSourceFilenameKind,
  isGeneratedIdentifier,
  type GeneratedIdentifierPrefix,
} from '../../sanitizer/index.js';
import { compareSessionText, digestSessionValue, sessionSha256 } from './canonical.js';
import { SESSION_COMPILE_LIMITS } from './contracts.js';
import { SessionCompileError } from './errors.js';
import {
  SESSION_PROMOTION_PROOF_SCHEMA_VERSION,
  SESSION_REVIEW_CANDIDATE_SCHEMA_VERSION,
  type SessionCitationBinding,
  type SessionCompilerSourceBinding,
  type SessionPromotionProofV1,
  type SessionRequestedPageKind,
  type SessionReviewCandidateV1,
  type SessionSha256Digest,
} from './types.js';
import type { ValidatedSessionBatch, ValidatedSessionProposal } from './validator.js';

const STORE_DIRECTORY = 'buildlore-session';
const UPSTREAM_CANDIDATE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,255}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PAGE_ID_PATTERN = /^(?:concepts|queries|decisions|failures|verifications)\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_STORE_FILES = SESSION_COMPILE_LIMITS.maxApplyProposals * 2;
const MAX_CANDIDATE_BYTES = SESSION_COMPILE_LIMITS.maxPageBytes * 2;

type UnknownRecord = Readonly<Record<string, unknown>>;
type CandidateLifecycle = 'approving' | 'pending';

export interface SessionReviewStoredCandidate {
  readonly candidate: SessionReviewCandidateV1;
  readonly lifecycle: CandidateLifecycle;
}

export interface SessionReviewStore {
  stage(candidates: readonly SessionReviewCandidateV1[]): Promise<void>;
  list(): Promise<readonly SessionReviewStoredCandidate[]>;
  listProofs(): Promise<readonly SessionPromotionProofV1[]>;
  claim(candidateId: string): Promise<SessionReviewCandidateV1>;
  restore(candidate: SessionReviewCandidateV1): Promise<void>;
  complete(candidate: SessionReviewCandidateV1): Promise<void>;
  readProof(candidateId: string): Promise<SessionPromotionProofV1 | null>;
  writeProof(proof: SessionPromotionProofV1): Promise<void>;
}

function fail(
  code: ConstructorParameters<typeof SessionCompileError>[0],
  projectId: string,
  candidateId?: string,
): never {
  throw new SessionCompileError(code, projectId, {
    ...(candidateId === undefined ? {} : { candidateRefs: [candidateId] }),
    recoveryAction: code === 'SESSION_CANDIDATE_BUSY' ? 'retry' : 'status',
  });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  projectId: string,
): void {
  const keys = Object.keys(value).sort(compareSessionText);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) ||
      keys.some((key) => !allowed.has(key)) ||
      keys.length < required.length || keys.length > required.length + optional.length) {
    fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  }
}

function text(
  value: unknown,
  projectId: string,
  maximum: number,
  pattern?: RegExp,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum ||
      value !== value.normalize('NFC') || value.includes('\r') || value.includes('\0') ||
      (pattern !== undefined && !pattern.test(value))) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  }
  return value;
}

function digest(value: unknown, projectId: string): SessionSha256Digest {
  return text(value, projectId, 71, DIGEST_PATTERN) as SessionSha256Digest;
}

function generatedIdentifier(
  value: unknown,
  projectId: string,
  prefix: GeneratedIdentifierPrefix,
): string {
  const result = text(value, projectId, 128);
  return isGeneratedIdentifier(result, prefix)
    ? result
    : fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
}

function compilerSourceIdentifier(value: unknown, projectId: string): string {
  const result = text(value, projectId, 96);
  const kind = generatedSourceFilenameKind(result);
  return kind === 'code' || kind === 'json' || kind === 'markdown' ||
    kind === 'planning' || kind === 'text'
    ? result
    : fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
}

function safeOriginalFile(value: unknown, projectId: string): string {
  const result = text(value, projectId, 512);
  if (result.startsWith('/') || result.startsWith('~') || result.includes('\\') ||
      /^[A-Za-z]:/u.test(result) || result.split('/').some((part) =>
        part === '' || part === '.' || part === '..')) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  }
  return result;
}

function compilerSource(value: unknown, projectId: string): SessionCompilerSourceBinding {
  if (!isRecord(value)) return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  exactKeys(value, ['compilerSourceContentDigest', 'compilerSourceId', 'sourceId'], [], projectId);
  return Object.freeze({
    compilerSourceContentDigest: digest(value.compilerSourceContentDigest, projectId),
    compilerSourceId: compilerSourceIdentifier(value.compilerSourceId, projectId),
    sourceId: generatedIdentifier(value.sourceId, projectId, 'source'),
  });
}

function compilerSources(value: unknown, projectId: string): readonly SessionCompilerSourceBinding[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SESSION_COMPILE_LIMITS.maxSources) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  }
  const result = value.map((item) => compilerSource(item, projectId));
  if (new Set(result.map((item) => item.sourceId)).size !== result.length ||
      result.some((item, index) => index > 0 &&
        compareSessionText(result[index - 1]?.sourceId ?? '', item.sourceId) >= 0)) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  }
  return Object.freeze(result);
}

function citationBinding(value: unknown, projectId: string): SessionCitationBinding {
  if (!isRecord(value)) return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  exactKeys(value, [
    'citationId',
    'compilerSourceContentDigest',
    'compilerSourceId',
    'originalFile',
    'originalLine',
    'quoteDigest',
    'sourceId',
  ], ['jsonPointer'], projectId);
  if (!Number.isSafeInteger(value.originalLine) || Number(value.originalLine) < 1) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  }
  return Object.freeze({
    citationId: text(value.citationId, projectId, 128, /^[a-z0-9][a-z0-9._-]{0,127}$/u),
    compilerSourceContentDigest: digest(value.compilerSourceContentDigest, projectId),
    compilerSourceId: compilerSourceIdentifier(value.compilerSourceId, projectId),
    originalFile: safeOriginalFile(value.originalFile, projectId),
    originalLine: Number(value.originalLine),
    ...(value.jsonPointer === undefined
      ? {}
      : { jsonPointer: text(value.jsonPointer, projectId, 1024) }),
    quoteDigest: digest(value.quoteDigest, projectId),
    sourceId: generatedIdentifier(value.sourceId, projectId, 'source'),
  });
}

function citationBindings(
  value: unknown,
  sources: readonly SessionCompilerSourceBinding[],
  projectId: string,
): readonly SessionCitationBinding[] {
  if (!Array.isArray(value) || value.length > SESSION_COMPILE_LIMITS.maxCitationsPerPage) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  }
  const result = value.map((item) => citationBinding(item, projectId));
  const sourceMap = new Map(sources.map((source) => [source.sourceId, source] as const));
  if (new Set(result.map((item) => item.citationId)).size !== result.length ||
      result.some((item, index) => index > 0 &&
        compareSessionText(result[index - 1]?.citationId ?? '', item.citationId) >= 0) ||
      result.some((item) => {
        const source = sourceMap.get(item.sourceId);
        return source === undefined || source.compilerSourceId !== item.compilerSourceId ||
          source.compilerSourceContentDigest !== item.compilerSourceContentDigest;
      })) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  }
  return Object.freeze(result);
}

function kind(value: unknown, pageId: string, projectId: string): SessionRequestedPageKind {
  if (value !== 'concept' && value !== 'query' && value !== 'decision' &&
      value !== 'failure' && value !== 'verification') {
    return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  }
  const directory = value === 'concept' ? 'concepts' : value === 'query' ? 'queries' : `${value}s`;
  if (!pageId.startsWith(`${directory}/`)) return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  return value;
}

function candidateWithoutDigest(
  candidate: SessionReviewCandidateV1,
): Omit<SessionReviewCandidateV1, 'candidateDigest'> {
  const copy: { -readonly [Key in keyof SessionReviewCandidateV1]?: SessionReviewCandidateV1[Key] } = {
    ...candidate,
  };
  delete copy.candidateDigest;
  return copy as Omit<SessionReviewCandidateV1, 'candidateDigest'>;
}

function expectedCandidateId(input: {
  readonly batchDigest: SessionSha256Digest;
  readonly pageId: string;
  readonly projectId: string;
  readonly proposalDigest: SessionSha256Digest;
}): string {
  return `candidate-${digestSessionValue({
    batchDigest: input.batchDigest,
    pageId: input.pageId,
    projectId: input.projectId,
    proposalDigest: input.proposalDigest,
  }).slice('sha256:'.length)}`;
}

export function createSessionReviewCandidate(input: {
  readonly batch: ValidatedSessionBatch;
  readonly page: ValidatedSessionProposal;
  readonly profileMode: 'custom' | 'default';
  readonly renderedPage: string;
  readonly upstreamCandidateId?: string;
}): SessionReviewCandidateV1 {
  const { batch, page, profileMode, renderedPage } = input;
  const proposal = page.proposal;
  const candidateId = expectedCandidateId({
    batchDigest: batch.batchDigest,
    pageId: proposal.pageId,
    projectId: proposal.projectId,
    proposalDigest: proposal.proposalDigest,
  });
  const base = {
    schemaVersion: SESSION_REVIEW_CANDIDATE_SCHEMA_VERSION,
    candidateId,
    projectId: proposal.projectId,
    profileMode,
    pageId: proposal.pageId,
    slug: proposal.slug,
    kind: proposal.kind,
    target: `${proposal.pageId}.md`,
    renderedPage,
    renderedPageDigest: sessionSha256(renderedPage),
    batchDigest: batch.batchDigest,
    planDigest: proposal.planDigest,
    proposalDigest: proposal.proposalDigest,
    sourceManifestDigest: page.provenance.sourceManifestDigest,
    profileDigest: page.provenance.profileDigest,
    policyDigest: page.provenance.policyDigest,
    contractDigest: page.provenance.contractDigest,
    provenanceBindingDigest: page.provenance.bindingDigest,
    citationBindings: page.citationBindings,
    compilerSources: page.compilerSources,
    heldReasons: Object.freeze(['manual-review-requested'] as const),
    ...(input.upstreamCandidateId === undefined
      ? {}
      : { upstreamCandidateId: input.upstreamCandidateId }),
  } as const;
  const { schemaVersion, candidateId: boundCandidateId, ...rest } = base;
  return Object.freeze({
    schemaVersion,
    candidateId: boundCandidateId,
    candidateDigest: digestSessionValue(base),
    ...rest,
  });
}

export function parseSessionReviewCandidate(
  value: unknown,
  expectedProjectId: string,
): SessionReviewCandidateV1 {
  if (!isRecord(value)) return fail('SESSION_CANDIDATE_STORE_INVALID', expectedProjectId);
  exactKeys(value, [
    'batchDigest',
    'candidateDigest',
    'candidateId',
    'citationBindings',
    'compilerSources',
    'contractDigest',
    'heldReasons',
    'kind',
    'pageId',
    'planDigest',
    'policyDigest',
    'profileDigest',
    'profileMode',
    'projectId',
    'proposalDigest',
    'provenanceBindingDigest',
    'renderedPage',
    'renderedPageDigest',
    'schemaVersion',
    'slug',
    'sourceManifestDigest',
    'target',
  ], ['upstreamCandidateId'], expectedProjectId);
  if (value.schemaVersion !== SESSION_REVIEW_CANDIDATE_SCHEMA_VERSION ||
      value.projectId !== expectedProjectId ||
      (value.profileMode !== 'custom' && value.profileMode !== 'default') ||
      !Array.isArray(value.heldReasons) || value.heldReasons.length !== 1 ||
      value.heldReasons[0] !== 'manual-review-requested') {
    return fail('SESSION_CANDIDATE_STORE_INVALID', expectedProjectId);
  }
  const pageId = text(value.pageId, expectedProjectId, 260, PAGE_ID_PATTERN);
  const slug = text(value.slug, expectedProjectId, 128, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  if (!pageId.endsWith(`/${slug}`) || value.target !== `${pageId}.md`) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', expectedProjectId);
  }
  const sources = compilerSources(value.compilerSources, expectedProjectId);
  const renderedPage = text(value.renderedPage, expectedProjectId, MAX_CANDIDATE_BYTES);
  if (Buffer.byteLength(renderedPage, 'utf8') > MAX_CANDIDATE_BYTES) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', expectedProjectId);
  }
  const profileMode = value.profileMode;
  const upstreamCandidateId = value.upstreamCandidateId === undefined
    ? undefined
    : text(value.upstreamCandidateId, expectedProjectId, 256, UPSTREAM_CANDIDATE_ID_PATTERN);
  if ((profileMode === 'custom') !== (upstreamCandidateId !== undefined)) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', expectedProjectId);
  }
  const candidate: SessionReviewCandidateV1 = Object.freeze({
    schemaVersion: SESSION_REVIEW_CANDIDATE_SCHEMA_VERSION,
    candidateId: generatedIdentifier(value.candidateId, expectedProjectId, 'candidate'),
    candidateDigest: digest(value.candidateDigest, expectedProjectId),
    projectId: expectedProjectId,
    profileMode,
    pageId,
    slug,
    kind: kind(value.kind, pageId, expectedProjectId),
    target: `${pageId}.md`,
    renderedPage,
    renderedPageDigest: digest(value.renderedPageDigest, expectedProjectId),
    batchDigest: digest(value.batchDigest, expectedProjectId),
    planDigest: digest(value.planDigest, expectedProjectId),
    proposalDigest: digest(value.proposalDigest, expectedProjectId),
    sourceManifestDigest: digest(value.sourceManifestDigest, expectedProjectId),
    profileDigest: digest(value.profileDigest, expectedProjectId),
    policyDigest: digest(value.policyDigest, expectedProjectId),
    contractDigest: digest(value.contractDigest, expectedProjectId),
    provenanceBindingDigest: digest(value.provenanceBindingDigest, expectedProjectId),
    citationBindings: citationBindings(value.citationBindings, sources, expectedProjectId),
    compilerSources: sources,
    heldReasons: Object.freeze(['manual-review-requested'] as const),
    ...(upstreamCandidateId === undefined ? {} : { upstreamCandidateId }),
  });
  if (candidate.renderedPageDigest !== sessionSha256(candidate.renderedPage) ||
      candidate.candidateId !== expectedCandidateId(candidate) ||
      candidate.candidateDigest !== digestSessionValue(candidateWithoutDigest(candidate))) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', expectedProjectId);
  }
  return candidate;
}

function proofWithoutDigest(
  proof: SessionPromotionProofV1,
): Omit<SessionPromotionProofV1, 'proofDigest'> {
  const copy: { -readonly [Key in keyof SessionPromotionProofV1]?: SessionPromotionProofV1[Key] } = {
    ...proof,
  };
  delete copy.proofDigest;
  return copy as Omit<SessionPromotionProofV1, 'proofDigest'>;
}

export function finalizeSessionPromotionProof(
  proof: Omit<SessionPromotionProofV1, 'proofDigest' | 'schemaVersion'>,
): SessionPromotionProofV1 {
  const base = Object.freeze({
    schemaVersion: SESSION_PROMOTION_PROOF_SCHEMA_VERSION,
    ...proof,
  });
  const { schemaVersion, ...rest } = base;
  return Object.freeze({
    schemaVersion,
    proofDigest: digestSessionValue(base),
    ...rest,
  });
}

export function parseSessionPromotionProof(
  value: unknown,
  expectedProjectId: string,
): SessionPromotionProofV1 {
  if (!isRecord(value)) return fail('SESSION_CANDIDATE_STORE_INVALID', expectedProjectId);
  exactKeys(value, [
    'bodyDigest',
    'candidateDigest',
    'candidateId',
    'citationBindings',
    'citationsDigest',
    'compilerSources',
    'contentHash',
    'pageId',
    'profileMode',
    'projectId',
    'proofDigest',
    'schemaVersion',
    'sourceHashes',
    'sourceRefsDigest',
    'summaryDigest',
    'titleDigest',
  ], [], expectedProjectId);
  if (value.schemaVersion !== SESSION_PROMOTION_PROOF_SCHEMA_VERSION ||
      value.projectId !== expectedProjectId ||
      (value.profileMode !== 'custom' && value.profileMode !== 'default') ||
      !Array.isArray(value.sourceHashes) || value.sourceHashes.length > SESSION_COMPILE_LIMITS.maxSources) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', expectedProjectId);
  }
  const sourceHashes = value.sourceHashes.map((item) =>
    text(item, expectedProjectId, 64, /^[a-f0-9]{64}$/u));
  if (new Set(sourceHashes).size !== sourceHashes.length ||
      sourceHashes.some((item, index) => index > 0 &&
        compareSessionText(sourceHashes[index - 1] ?? '', item) >= 0)) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', expectedProjectId);
  }
  const sources = compilerSources(value.compilerSources, expectedProjectId);
  const proof: SessionPromotionProofV1 = Object.freeze({
    schemaVersion: SESSION_PROMOTION_PROOF_SCHEMA_VERSION,
    proofDigest: digest(value.proofDigest, expectedProjectId),
    projectId: expectedProjectId,
    candidateId: generatedIdentifier(value.candidateId, expectedProjectId, 'candidate'),
    candidateDigest: digest(value.candidateDigest, expectedProjectId),
    pageId: text(value.pageId, expectedProjectId, 260, PAGE_ID_PATTERN),
    profileMode: value.profileMode,
    bodyDigest: digest(value.bodyDigest, expectedProjectId),
    titleDigest: digest(value.titleDigest, expectedProjectId),
    summaryDigest: digest(value.summaryDigest, expectedProjectId),
    sourceRefsDigest: digest(value.sourceRefsDigest, expectedProjectId),
    citationsDigest: digest(value.citationsDigest, expectedProjectId),
    contentHash: text(value.contentHash, expectedProjectId, 64, /^[a-f0-9]{64}$/u),
    sourceHashes: Object.freeze(sourceHashes),
    citationBindings: citationBindings(value.citationBindings, sources, expectedProjectId),
    compilerSources: sources,
  });
  if (proof.proofDigest !== digestSessionValue(proofWithoutDigest(proof))) {
    return fail('SESSION_CANDIDATE_STORE_INVALID', expectedProjectId);
  }
  return proof;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function assertDirectory(path: string, workspace: string, projectId: string): Promise<void> {
  try {
    const [status, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== resolve(path) ||
        !isContained(resolve(workspace), canonical)) {
      fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
    }
  } catch (error) {
    if (error instanceof SessionCompileError) throw error;
    fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  }
}

function paths(workspace: string): Readonly<{
  readonly approving: string;
  readonly pending: string;
  readonly proofs: string;
  readonly root: string;
}> {
  const root = join(workspace, '.llmwiki', STORE_DIRECTORY);
  return Object.freeze({
    approving: join(root, 'approving'),
    pending: join(root, 'pending'),
    proofs: join(root, 'proofs'),
    root,
  });
}

async function ensureStore(workspace: string, projectId: string): Promise<ReturnType<typeof paths>> {
  const result = paths(workspace);
  const directories = [join(workspace, '.llmwiki'), result.root, result.pending, result.approving, result.proofs];
  for (const directory of directories) {
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') {
        fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
      }
    });
    await assertDirectory(directory, workspace, projectId);
  }
  return result;
}

async function existingStore(
  workspace: string,
  projectId: string,
): Promise<ReturnType<typeof paths> | null> {
  const result = paths(workspace);
  try {
    await lstat(result.root);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  }
  await assertDirectory(result.root, workspace, projectId);
  return result;
}

async function existingDirectory(
  path: string,
  workspace: string,
  projectId: string,
): Promise<boolean> {
  try {
    await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  }
  await assertDirectory(path, workspace, projectId);
  return true;
}

async function readCanonicalFile<T>(
  path: string,
  workspace: string,
  projectId: string,
  parser: (value: unknown, expectedProjectId: string) => T,
): Promise<T> {
  let handle;
  try {
    const expected = await lstat(path, { bigint: true });
    const canonical = await realpath(path);
    if (!expected.isFile() || expected.isSymbolicLink() || expected.size > BigInt(MAX_CANDIDATE_BYTES) ||
        canonical !== resolve(path) || !isContained(resolve(workspace), canonical)) {
      return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const source = await handle.readFile('utf8');
    const parsed = parser(parseJsonStrict(source), projectId);
    if (source !== serializeCanonicalJson(parsed)) fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
    return parsed;
  } catch (error) {
    if (error instanceof SessionCompileError) throw error;
    return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function listJsonFiles(directory: string, projectId: string): Promise<readonly string[]> {
  let handle;
  try {
    handle = await opendir(directory);
    const names: string[] = [];
    for await (const entry of handle) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
        fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
      }
      names.push(entry.name);
      if (names.length > MAX_STORE_FILES) fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
    }
    return Object.freeze(names.sort(compareSessionText));
  } catch (error) {
    if (error instanceof SessionCompileError) throw error;
    return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    return status.isFile() && !status.isSymbolicLink();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function writeCandidateExclusive(
  path: string,
  candidate: SessionReviewCandidateV1,
  workspace: string,
  projectId: string,
): Promise<void> {
  let handle;
  let created = false;
  try {
    handle = await open(
      path,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_WRONLY,
      0o600,
    );
    created = true;
    const [status, canonical] = await Promise.all([handle.stat(), realpath(path)]);
    if (!status.isFile() || canonical !== resolve(path) ||
        !isContained(resolve(workspace), canonical)) {
      fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
    }
    await handle.writeFile(serializeCanonicalJson(candidate), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(dirname(path));
  } catch (error) {
    if (created) await unlink(path).catch(() => undefined);
    if (error instanceof SessionCompileError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error &&
        error.code === 'EEXIST') {
      fail('SESSION_CANDIDATE_DUPLICATE', projectId, candidate.candidateId);
    }
    fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function createSessionReviewStore(
  workspace: string,
  projectId: string,
): SessionReviewStore {
  const candidateName = (candidateId: string): string => `${candidateId}.json`;
  const store: SessionReviewStore = {
    async stage(candidates) {
      const store = await ensureStore(workspace, projectId);
      const created: string[] = [];
      try {
        for (const candidate of candidates) {
          const parsed = parseSessionReviewCandidate(candidate, projectId);
          const pendingPath = join(store.pending, candidateName(parsed.candidateId));
          const approvingPath = join(store.approving, candidateName(parsed.candidateId));
          const proofPath = join(store.proofs, candidateName(parsed.candidateId));
          if (await pathExists(pendingPath) || await pathExists(approvingPath) ||
              await pathExists(proofPath)) {
            fail('SESSION_CANDIDATE_DUPLICATE', projectId, parsed.candidateId);
          }
          await writeCandidateExclusive(pendingPath, parsed, workspace, projectId);
          created.push(pendingPath);
        }
      } catch (error) {
        for (const path of created.reverse()) await unlink(path).catch(() => undefined);
        throw error;
      }
    },
    async list() {
      const store = await existingStore(workspace, projectId);
      if (store === null) return Object.freeze([]);
      const result: SessionReviewStoredCandidate[] = [];
      for (const [lifecycle, directory] of [
        ['pending', store.pending],
        ['approving', store.approving],
      ] as const) {
        if (!await existingDirectory(directory, workspace, projectId)) continue;
        for (const name of await listJsonFiles(directory, projectId)) {
          const candidate = await readCanonicalFile(
            join(directory, name),
            workspace,
            projectId,
            parseSessionReviewCandidate,
          );
          if (name !== candidateName(candidate.candidateId)) {
            fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
          }
          result.push(Object.freeze({ candidate, lifecycle }));
        }
      }
      return Object.freeze(result.sort((left, right) =>
        compareSessionText(left.candidate.candidateId, right.candidate.candidateId)));
    },
    async listProofs() {
      const store = await existingStore(workspace, projectId);
      if (store === null) return Object.freeze([]);
      if (!await existingDirectory(store.proofs, workspace, projectId)) {
        return Object.freeze([]);
      }
      const result: SessionPromotionProofV1[] = [];
      for (const name of await listJsonFiles(store.proofs, projectId)) {
        const proof = await readCanonicalFile(
          join(store.proofs, name),
          workspace,
          projectId,
          parseSessionPromotionProof,
        );
        if (name !== candidateName(proof.candidateId)) {
          fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
        }
        result.push(proof);
      }
      return Object.freeze(result.sort((left, right) =>
        compareSessionText(left.candidateId, right.candidateId)));
    },
    async claim(candidateId) {
      if (!isGeneratedIdentifier(candidateId, 'candidate')) {
        fail('SESSION_CANDIDATE_NOT_FOUND', projectId);
      }
      const store = await existingStore(workspace, projectId);
      if (store === null) fail('SESSION_CANDIDATE_NOT_FOUND', projectId, candidateId);
      const pendingPath = join(store.pending, candidateName(candidateId));
      const approvingPath = join(store.approving, candidateName(candidateId));
      if (await pathExists(approvingPath)) fail('SESSION_CANDIDATE_BUSY', projectId, candidateId);
      if (!await pathExists(pendingPath)) {
        if (await pathExists(join(store.proofs, candidateName(candidateId)))) {
          fail('SESSION_CANDIDATE_ALREADY_APPROVED', projectId, candidateId);
        }
        fail('SESSION_CANDIDATE_NOT_FOUND', projectId, candidateId);
      }
      const candidate = await readCanonicalFile(
        pendingPath,
        workspace,
        projectId,
        parseSessionReviewCandidate,
      );
      await ensureStore(workspace, projectId);
      try {
        await rename(pendingPath, approvingPath);
        await syncDirectory(store.pending);
        await syncDirectory(store.approving);
      } catch {
        fail('SESSION_CANDIDATE_BUSY', projectId, candidateId);
      }
      return candidate;
    },
    async restore(candidate) {
      const store = await existingStore(workspace, projectId);
      if (store === null) fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, candidate.candidateId);
      await ensureStore(workspace, projectId);
      try {
        await rename(
          join(store.approving, candidateName(candidate.candidateId)),
          join(store.pending, candidateName(candidate.candidateId)),
        );
        await syncDirectory(store.approving);
        await syncDirectory(store.pending);
      } catch {
        fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, candidate.candidateId);
      }
    },
    async complete(candidate) {
      const store = await existingStore(workspace, projectId);
      if (store === null) fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, candidate.candidateId);
      try {
        await unlink(join(store.approving, candidateName(candidate.candidateId)));
        await syncDirectory(store.approving);
      } catch {
        fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, candidate.candidateId);
      }
    },
    async readProof(candidateId) {
      if (!isGeneratedIdentifier(candidateId, 'candidate')) return null;
      const store = await existingStore(workspace, projectId);
      if (store === null) return null;
      const path = join(store.proofs, candidateName(candidateId));
      if (!await pathExists(path)) return null;
      return readCanonicalFile(path, workspace, projectId, parseSessionPromotionProof);
    },
    async writeProof(proof) {
      const store = await ensureStore(workspace, projectId);
      const parsed = parseSessionPromotionProof(proof, projectId);
      const path = join(store.proofs, candidateName(parsed.candidateId));
      if (await pathExists(path)) {
        const existing = await readCanonicalFile(
          path,
          workspace,
          projectId,
          parseSessionPromotionProof,
        );
        if (existing.proofDigest !== parsed.proofDigest) {
          fail('SESSION_CANDIDATE_RECOVERY_REQUIRED', projectId, parsed.candidateId);
        }
        return;
      }
      await writeJsonAtomic(path, parsed, { confinementRoot: workspace });
    },
  };
  return Object.freeze(store);
}

export async function countLegacyUpstreamCandidates(
  workspace: string,
  projectId: string,
  boundCandidateIds: ReadonlySet<string> = new Set(),
): Promise<number> {
  const directory = join(workspace, '.llmwiki', 'candidates');
  let handle;
  try {
    const [status, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== resolve(directory) ||
        !isContained(resolve(workspace), canonical)) {
      fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
    }
    handle = await opendir(directory);
    let count = 0;
    for await (const entry of handle) {
      if (entry.name === 'archive' && entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
        fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
      }
      if (boundCandidateIds.has(entry.name.slice(0, -'.json'.length))) continue;
      count += 1;
      if (count > MAX_STORE_FILES) fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
    }
    return count;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return 0;
    }
    if (error instanceof SessionCompileError) throw error;
    return fail('SESSION_CANDIDATE_STORE_INVALID', projectId);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
