import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import {
  parseCompilationPurpose,
  parseCurrentSessionProposalSubmission,
  type AuthoritativeWikiStateV1,
  type CompilationPurposeV1,
  type CurrentSessionProposalSubmissionV1,
  type HierarchicalWikiProposalV1,
  type HierarchySha256Digest,
} from '../compiler/index.js';
import { serializeCanonicalJson, syncDirectory, writeJsonAtomic } from '../knowledge/atomic-file.js';
import { isNodeError } from '../knowledge/errors.js';
import { decodeUtf8Strict, parseJsonStrict } from '../knowledge/strict-json.js';
import { validateProjectId } from '../knowledge/validation.js';
import {
  verifyApprovedWikiAuthority,
} from '../retrieval/approved-corpus-store.js';
import type { ApprovedWikiAuthorityV1 } from '../retrieval/index.js';

export const HIERARCHICAL_WORKFLOW_RUN_RECORD_SCHEMA_VERSION =
  'buildlore.hierarchical-workflow-run-record.v1' as const;

const RUNS_DIRECTORY = 'hierarchy-runs';
const RUN_FILENAME = 'run.json';
const LOCK_FILENAME = 'run.lock';
const ACTIVATION_FILENAME = 'approved-wiki.json';
const MAXIMUM_RECORD_BYTES = 64 * 1024 * 1024;
const MAXIMUM_LOCK_BYTES = 2_048;
const LOCK_SCHEMA_VERSION = 'buildlore.hierarchical-workflow-run-lock.v1' as const;
const RUN_ID_PATTERN = /^run-[0-9a-f]{64}$/u;
const PAGE_ID_PATTERN = /^page-[0-9a-f]{64}$/u;
const RELATION_ID_PATTERN = /^relation-[0-9a-f]{64}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REASON_CODE_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

export type HierarchicalWorkflowPhaseV1 =
  | 'awaiting-proposal'
  | 'awaiting-child-review'
  | 'review-ready'
  | 'finalized'
  | 'rejected'
  | 'approved';

export interface HierarchicalWorkflowStartDigestsV1 {
  readonly baselineGenerationDigest: HierarchySha256Digest | null;
  readonly graphDigest: HierarchySha256Digest;
  readonly outlineDigest: HierarchySha256Digest;
  readonly planDigest: HierarchySha256Digest;
  readonly planningInventoryDigest: HierarchySha256Digest;
  readonly sanitizerPolicyDigest: HierarchySha256Digest;
  readonly snapshotDigest: HierarchySha256Digest;
}

export interface HierarchicalWorkflowStoredSubmissionV1 {
  readonly expectedExchangeDigest: HierarchySha256Digest;
  readonly generationOrder: number;
  readonly pageId: string;
  readonly proposalDigest: HierarchySha256Digest;
  readonly receiptDigest: HierarchySha256Digest;
  readonly submission: CurrentSessionProposalSubmissionV1;
}

export interface HierarchicalWorkflowStoredChildDecisionV1 {
  readonly decision: 'accepted' | 'rejected';
  readonly generationOrder: number;
  readonly pageId: string;
  readonly reasonCodes: readonly string[];
  readonly reviewDigest: HierarchySha256Digest;
  readonly reviewViewDigest: HierarchySha256Digest;
}

export interface HierarchicalWorkflowStoredIntegratedDecisionV1 {
  readonly decision: 'accepted' | 'rejected';
  readonly pageId: string;
  readonly reasonCodes: readonly string[];
  readonly reviewDigest: HierarchySha256Digest;
}

export interface HierarchicalWorkflowStoredRelationDecisionV1 {
  readonly decision: 'accepted' | 'rejected';
  readonly relationId: string;
  readonly reviewDigest: HierarchySha256Digest;
}

export interface HierarchicalWorkflowRejectionV1 {
  readonly kind: 'child-review-rejected' | 'hard-quality-failed';
  readonly reasonCodes: readonly string[];
  readonly reviewDigest: HierarchySha256Digest;
  readonly surfaceDigest: HierarchySha256Digest | null;
}

export interface HierarchicalWorkflowApprovalDecisionV1 {
  readonly activationBundleDigest: HierarchySha256Digest;
  readonly approvalDigest: HierarchySha256Digest;
  readonly explicitConfirmation: true;
}

export interface HierarchicalWorkflowRunRecordV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WORKFLOW_RUN_RECORD_SCHEMA_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly revision: number;
  readonly phase: HierarchicalWorkflowPhaseV1;
  readonly purpose: CompilationPurposeV1;
  readonly baselineAuthorityDigest: HierarchySha256Digest | null;
  readonly baselineState: AuthoritativeWikiStateV1 | null;
  readonly baselineProposals: readonly HierarchicalWikiProposalV1[];
  readonly startDigests: HierarchicalWorkflowStartDigestsV1;
  readonly submissions: readonly HierarchicalWorkflowStoredSubmissionV1[];
  readonly childDecisions: readonly HierarchicalWorkflowStoredChildDecisionV1[];
  readonly integratedDecisions: readonly HierarchicalWorkflowStoredIntegratedDecisionV1[];
  readonly relationDecisions: readonly HierarchicalWorkflowStoredRelationDecisionV1[];
  readonly rejection: HierarchicalWorkflowRejectionV1 | null;
  readonly approvalDecision: HierarchicalWorkflowApprovalDecisionV1 | null;
  readonly pendingExchangeDigest: HierarchySha256Digest | null;
  readonly pendingChildReviewDigest: HierarchySha256Digest | null;
  readonly pendingReviewDigest: HierarchySha256Digest | null;
  readonly pendingLedgerDigest: HierarchySha256Digest | null;
  readonly recordDigest: HierarchySha256Digest;
}

export type CreateHierarchicalWorkflowRunRecordInputV1 = Omit<
  HierarchicalWorkflowRunRecordV1,
  'recordDigest' | 'schemaVersion'
>;

export type HierarchicalWorkflowRunStoreErrorCode =
  | 'HIERARCHICAL_WORKFLOW_RUN_BUSY'
  | 'HIERARCHICAL_WORKFLOW_RUN_CONFLICT'
  | 'HIERARCHICAL_WORKFLOW_RUN_INVALID'
  | 'HIERARCHICAL_WORKFLOW_RUN_NOT_FOUND'
  | 'HIERARCHICAL_WORKFLOW_RUN_PROJECT_MISMATCH'
  | 'HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED';

export class HierarchicalWorkflowRunStoreError extends Error {
  readonly code: HierarchicalWorkflowRunStoreErrorCode;
  readonly retryable: boolean;

  constructor(code: HierarchicalWorkflowRunStoreErrorCode) {
    super(code === 'HIERARCHICAL_WORKFLOW_RUN_BUSY'
      ? 'Hierarchical Wiki workflow run is busy.'
      : code === 'HIERARCHICAL_WORKFLOW_RUN_NOT_FOUND'
        ? 'Hierarchical Wiki workflow run is unavailable.'
        : code === 'HIERARCHICAL_WORKFLOW_RUN_CONFLICT'
          ? 'Hierarchical Wiki workflow run changed concurrently.'
          : code === 'HIERARCHICAL_WORKFLOW_RUN_PROJECT_MISMATCH'
            ? 'Hierarchical Wiki workflow run project does not match.'
            : code === 'HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED'
              ? 'Hierarchical Wiki workflow run could not be stored safely.'
              : 'Hierarchical Wiki workflow run is invalid.');
    this.name = 'HierarchicalWorkflowRunStoreError';
    this.code = code;
    this.retryable = code === 'HIERARCHICAL_WORKFLOW_RUN_BUSY' ||
      code === 'HIERARCHICAL_WORKFLOW_RUN_CONFLICT';
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({ code: this.code, message: this.message, retryable: this.retryable });
  }
}

export interface HierarchicalWorkflowRunStoreTestHooks {
  readonly beforeActivationBundleCommit?: () => Promise<void> | void;
  readonly beforeCommit?: () => Promise<void> | void;
  readonly beforeLockOpen?: () => Promise<void> | void;
  readonly beforeLockRelease?: () => Promise<void> | void;
}

export interface HierarchicalWorkflowRunStorePort {
  create(record: HierarchicalWorkflowRunRecordV1): Promise<void>;
  read(projectId: string, runId: string): Promise<HierarchicalWorkflowRunRecordV1>;
  replace(input: Readonly<{
    readonly expectedRecordDigest: HierarchySha256Digest;
    readonly expectedRevision: number;
    readonly next: HierarchicalWorkflowRunRecordV1;
    readonly projectId: string;
    readonly runId: string;
  }>): Promise<void>;
  approve(input: Readonly<{
    readonly activationBundle: Readonly<{
      readonly authority: ApprovedWikiAuthorityV1;
      readonly projectId: string;
      readonly schemaVersion: 'buildlore.hierarchical-wiki-activation-input.v1';
    }>;
    readonly expectedRecordDigest: HierarchySha256Digest;
    readonly expectedRevision: number;
    readonly next: HierarchicalWorkflowRunRecordV1;
    readonly projectId: string;
    readonly runId: string;
  }>): Promise<void>;
  activationBundleState(
    record: HierarchicalWorkflowRunRecordV1,
  ): Promise<'missing' | 'verified'>;
  activationBundlePath(projectId: string, runId: string): string;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function fail(code: HierarchicalWorkflowRunStoreErrorCode): never {
  throw new HierarchicalWorkflowRunStoreError(code);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): asserts value is UnknownRecord {
  if (!isRecord(value)) fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
}

function digest(value: unknown): HierarchySha256Digest {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(value)).digest('hex')}`;
}

function digestValue(value: unknown): HierarchySha256Digest {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
  return value as HierarchySha256Digest;
}

function sameValue(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function parseRunId(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
  return value;
}

function parseProjectId(value: unknown): string {
  if (typeof value !== 'string') fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  try {
    return validateProjectId(value);
  } catch {
    return fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
}

function parseReasonCodes(value: unknown, requireNonempty: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 32 || (requireNonempty && value.length === 0)) {
    fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
  const parsed = value.map((item) => {
    if (typeof item !== 'string' || item.length > 64 || !REASON_CODE_PATTERN.test(item)) {
      fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    }
    return item;
  });
  if (new Set(parsed).size !== parsed.length ||
      parsed.some((item, index) => index > 0 && (parsed[index - 1] as string) >= item)) {
    fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
  return Object.freeze(parsed);
}

function parseBaselineProposals(
  value: unknown,
  baselineState: AuthoritativeWikiStateV1 | null,
  projectId: string,
): readonly HierarchicalWikiProposalV1[] {
  if (!Array.isArray(value) || value.length > 97) fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  const proposals = value as readonly HierarchicalWikiProposalV1[];
  if (new Set(proposals.map((item) => item.pageId)).size !== proposals.length ||
      proposals.some((item, index) =>
        !isRecord(item) || item.projectId !== projectId || !PAGE_ID_PATTERN.test(item.pageId) ||
        (index > 0 && (proposals[index - 1]?.pageId ?? '') >= item.pageId))) {
    fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
  if ((baselineState === null) !== (proposals.length === 0)) {
    fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
  if (baselineState !== null) {
    const identities = new Map(proposals.map((proposal) =>
      [proposal.pageId, proposal.proposalDigest]));
    if (identities.size !== baselineState.activePages.length ||
        baselineState.activePages.some((page) =>
          identities.get(page.pageId) !== page.proposalDigest)) {
      fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    }
  }
  return Object.freeze(proposals);
}

function parseSubmissions(value: unknown, projectId: string):
readonly HierarchicalWorkflowStoredSubmissionV1[] {
  if (!Array.isArray(value) || value.length > 97) fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  const pageIds = new Set<string>();
  return Object.freeze(value.map((item, index) => {
    exactKeys(item, [
      'expectedExchangeDigest', 'generationOrder', 'pageId', 'proposalDigest',
      'receiptDigest', 'submission',
    ]);
    if (!Number.isSafeInteger(item.generationOrder) || item.generationOrder !== index ||
        typeof item.pageId !== 'string' || !PAGE_ID_PATTERN.test(item.pageId) ||
        pageIds.has(item.pageId)) fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    pageIds.add(item.pageId);
    const expectedExchangeDigest = digestValue(item.expectedExchangeDigest);
    const submission = parseCurrentSessionProposalSubmission(item.submission, {
      projectId,
      pageId: item.pageId,
      exchangeDigest: expectedExchangeDigest,
      requestDigest: isRecord(item.submission)
        ? digestValue(item.submission.requestDigest)
        : fail('HIERARCHICAL_WORKFLOW_RUN_INVALID'),
    });
    return Object.freeze({
      expectedExchangeDigest,
      generationOrder: index,
      pageId: item.pageId,
      proposalDigest: digestValue(item.proposalDigest),
      receiptDigest: digestValue(item.receiptDigest),
      submission,
    });
  }));
}

function parseChildDecisions(value: unknown):
readonly HierarchicalWorkflowStoredChildDecisionV1[] {
  if (!Array.isArray(value) || value.length > 96) fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  const pages = new Set<string>();
  let previousOrder = -1;
  return Object.freeze(value.map((item) => {
    exactKeys(item, [
      'decision', 'generationOrder', 'pageId', 'reasonCodes', 'reviewDigest',
      'reviewViewDigest',
    ]);
    if ((item.decision !== 'accepted' && item.decision !== 'rejected') ||
        !Number.isSafeInteger(item.generationOrder) || (item.generationOrder as number) <= previousOrder ||
        typeof item.pageId !== 'string' || !PAGE_ID_PATTERN.test(item.pageId) ||
        pages.has(item.pageId)) fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    previousOrder = item.generationOrder as number;
    pages.add(item.pageId);
    return Object.freeze({
      decision: item.decision,
      generationOrder: item.generationOrder as number,
      pageId: item.pageId,
      reasonCodes: parseReasonCodes(item.reasonCodes, item.decision === 'rejected'),
      reviewDigest: digestValue(item.reviewDigest),
      reviewViewDigest: digestValue(item.reviewViewDigest),
    });
  }));
}

function parseIntegratedDecisions(value: unknown):
readonly HierarchicalWorkflowStoredIntegratedDecisionV1[] {
  if (!Array.isArray(value) || value.length > 97) fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  return Object.freeze(value.map((item, index) => {
    exactKeys(item, ['decision', 'pageId', 'reasonCodes', 'reviewDigest']);
    const previousPageId = index === 0
      ? null
      : (value[index - 1] as UnknownRecord).pageId;
    if ((item.decision !== 'accepted' && item.decision !== 'rejected') ||
        typeof item.pageId !== 'string' || !PAGE_ID_PATTERN.test(item.pageId) ||
        (typeof previousPageId === 'string' && previousPageId >= item.pageId)) {
      fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    }
    return Object.freeze({
      decision: item.decision,
      pageId: item.pageId,
      reasonCodes: parseReasonCodes(item.reasonCodes, item.decision === 'rejected'),
      reviewDigest: digestValue(item.reviewDigest),
    });
  }));
}

function parseRelationDecisions(value: unknown):
readonly HierarchicalWorkflowStoredRelationDecisionV1[] {
  if (!Array.isArray(value) || value.length > 131_072) {
    fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
  return Object.freeze(value.map((item, index) => {
    exactKeys(item, ['decision', 'relationId', 'reviewDigest']);
    const previousRelationId = index === 0
      ? null
      : (value[index - 1] as UnknownRecord).relationId;
    if ((item.decision !== 'accepted' && item.decision !== 'rejected') ||
        typeof item.relationId !== 'string' || !RELATION_ID_PATTERN.test(item.relationId) ||
        (typeof previousRelationId === 'string' && previousRelationId >= item.relationId)) {
      fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    }
    return Object.freeze({
      decision: item.decision,
      relationId: item.relationId,
      reviewDigest: digestValue(item.reviewDigest),
    });
  }));
}

function parseNullableDigest(value: unknown): HierarchySha256Digest | null {
  return value === null ? null : digestValue(value);
}

function parseRecord(value: unknown, expectedProjectId: string, expectedRunId: string):
HierarchicalWorkflowRunRecordV1 {
  exactKeys(value, [
    'approvalDecision', 'baselineAuthorityDigest', 'baselineProposals', 'baselineState',
    'childDecisions', 'integratedDecisions', 'pendingChildReviewDigest',
    'pendingExchangeDigest', 'pendingLedgerDigest', 'pendingReviewDigest', 'phase',
    'projectId', 'purpose', 'recordDigest', 'rejection', 'relationDecisions', 'revision',
    'runId', 'schemaVersion', 'startDigests', 'submissions',
  ]);
  if (value.schemaVersion !== HIERARCHICAL_WORKFLOW_RUN_RECORD_SCHEMA_VERSION) {
    fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
  const projectId = parseProjectId(value.projectId);
  const runId = parseRunId(value.runId);
  if (projectId !== expectedProjectId || runId !== expectedRunId) {
    fail(projectId === expectedProjectId
      ? 'HIERARCHICAL_WORKFLOW_RUN_INVALID'
      : 'HIERARCHICAL_WORKFLOW_RUN_PROJECT_MISMATCH');
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
      !['awaiting-proposal', 'awaiting-child-review', 'review-ready', 'finalized',
        'rejected', 'approved'].includes(value.phase as string)) {
    fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
  const purpose = parseCompilationPurpose(value.purpose, projectId);
  const baselineAuthorityDigest = parseNullableDigest(value.baselineAuthorityDigest);
  const baselineState = value.baselineState as AuthoritativeWikiStateV1 | null;
  if ((baselineAuthorityDigest === null) !== (baselineState === null)) {
    fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
  const baselineProposals = parseBaselineProposals(
    value.baselineProposals,
    baselineState,
    projectId,
  );
  exactKeys(value.startDigests, [
    'baselineGenerationDigest', 'graphDigest', 'outlineDigest', 'planDigest',
    'planningInventoryDigest', 'sanitizerPolicyDigest', 'snapshotDigest',
  ]);
  const startDigests = Object.freeze({
    baselineGenerationDigest: parseNullableDigest(value.startDigests.baselineGenerationDigest),
    graphDigest: digestValue(value.startDigests.graphDigest),
    outlineDigest: digestValue(value.startDigests.outlineDigest),
    planDigest: digestValue(value.startDigests.planDigest),
    planningInventoryDigest: digestValue(value.startDigests.planningInventoryDigest),
    sanitizerPolicyDigest: digestValue(value.startDigests.sanitizerPolicyDigest),
    snapshotDigest: digestValue(value.startDigests.snapshotDigest),
  });
  if (startDigests.baselineGenerationDigest !== baselineState?.generationDigest &&
      !(startDigests.baselineGenerationDigest === null && baselineState === null)) {
    fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
  let rejection: HierarchicalWorkflowRejectionV1 | null = null;
  if (value.rejection !== null) {
    exactKeys(value.rejection, ['kind', 'reasonCodes', 'reviewDigest', 'surfaceDigest']);
    if (value.rejection.kind !== 'child-review-rejected' &&
        value.rejection.kind !== 'hard-quality-failed') {
      fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    }
    rejection = Object.freeze({
      kind: value.rejection.kind,
      reasonCodes: parseReasonCodes(value.rejection.reasonCodes, true),
      reviewDigest: digestValue(value.rejection.reviewDigest),
      surfaceDigest: parseNullableDigest(value.rejection.surfaceDigest),
    });
  }
  let approvalDecision: HierarchicalWorkflowApprovalDecisionV1 | null = null;
  if (value.approvalDecision !== null) {
    exactKeys(value.approvalDecision, [
      'activationBundleDigest', 'approvalDigest', 'explicitConfirmation',
    ]);
    if (value.approvalDecision.explicitConfirmation !== true) {
      fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    }
    approvalDecision = Object.freeze({
      activationBundleDigest: digestValue(value.approvalDecision.activationBundleDigest),
      approvalDigest: digestValue(value.approvalDecision.approvalDigest),
      explicitConfirmation: true,
    });
  }
  const basis = Object.freeze({
    schemaVersion: HIERARCHICAL_WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
    projectId,
    runId,
    revision: value.revision as number,
    phase: value.phase as HierarchicalWorkflowPhaseV1,
    purpose,
    baselineAuthorityDigest,
    baselineState,
    baselineProposals,
    startDigests,
    submissions: parseSubmissions(value.submissions, projectId),
    childDecisions: parseChildDecisions(value.childDecisions),
    integratedDecisions: parseIntegratedDecisions(value.integratedDecisions),
    relationDecisions: parseRelationDecisions(value.relationDecisions),
    rejection,
    approvalDecision,
    pendingExchangeDigest: parseNullableDigest(value.pendingExchangeDigest),
    pendingChildReviewDigest: parseNullableDigest(value.pendingChildReviewDigest),
    pendingReviewDigest: parseNullableDigest(value.pendingReviewDigest),
    pendingLedgerDigest: parseNullableDigest(value.pendingLedgerDigest),
  });
  const recordDigest = digestValue(value.recordDigest);
  if (recordDigest !== digest(basis)) fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  return Object.freeze({ ...basis, recordDigest });
}

export function createHierarchicalWorkflowRunRecord(
  input: CreateHierarchicalWorkflowRunRecordInputV1,
): HierarchicalWorkflowRunRecordV1 {
  const basis = Object.freeze({
    schemaVersion: HIERARCHICAL_WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
    ...input,
  });
  const value = parseJsonStrict(serializeCanonicalJson(
    Object.freeze({ ...basis, recordDigest: digest(basis) }),
  ));
  return parseRecord(
    value,
    input.projectId,
    input.runId,
  );
}

function snapshotRecord(
  value: HierarchicalWorkflowRunRecordV1,
  projectId: string,
  runId: string,
): HierarchicalWorkflowRunRecordV1 {
  try {
    return parseRecord(parseJsonStrict(serializeCanonicalJson(value)), projectId, runId);
  } catch (error) {
    if (error instanceof HierarchicalWorkflowRunStoreError) throw error;
    return fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
}

function snapshotActivationBundle(
  value: Readonly<{
    readonly authority: ApprovedWikiAuthorityV1;
    readonly projectId: string;
    readonly schemaVersion: 'buildlore.hierarchical-wiki-activation-input.v1';
  }>,
  next: HierarchicalWorkflowRunRecordV1,
): typeof value {
  try {
    const parsed = parseJsonStrict(serializeCanonicalJson(value));
    exactKeys(parsed, ['authority', 'projectId', 'schemaVersion']);
    if (parsed.schemaVersion !== 'buildlore.hierarchical-wiki-activation-input.v1' ||
        parsed.projectId !== next.projectId || !isRecord(parsed.authority) ||
        parsed.authority.projectId !== next.projectId || next.approvalDecision === null) {
      fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    }
    verifyApprovedWikiAuthority(parsed.authority as unknown as ApprovedWikiAuthorityV1,
      next.projectId);
    const bundle = parsed as unknown as typeof value;
    if (digest(bundle) !== next.approvalDecision.activationBundleDigest ||
        bundle.authority.humanActivationApproval.approvalDigest !==
          next.approvalDecision.approvalDigest) {
      fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    }
    return bundle;
  } catch (error) {
    if (error instanceof HierarchicalWorkflowRunStoreError) throw error;
    return fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
}

interface DirectoryIdentity {
  readonly device: number;
  readonly inode: number;
  readonly path: string;
}

interface RunIdentity {
  readonly hub: DirectoryIdentity;
  readonly buildlore: DirectoryIdentity;
  readonly runs: DirectoryIdentity;
  readonly project: DirectoryIdentity;
  readonly run: DirectoryIdentity;
}

interface LockOwnerV1 {
  readonly schemaVersion: typeof LOCK_SCHEMA_VERSION;
  readonly hostname: string;
  readonly pid: number;
  readonly token: string;
}

interface LockIdentity {
  readonly device: number;
  readonly inode: number;
  readonly owner: LockOwnerV1;
}

function contained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function ensureDirectory(path: string, parent: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(parent);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
    }
  }
  try {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(path) !== resolve(path)) {
      fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
    }
    if ((status.mode & 0o777) !== 0o700) await chmod(path, 0o700);
  } catch (error) {
    if (error instanceof HierarchicalWorkflowRunStoreError) throw error;
    fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
  }
}

async function directoryIdentity(path: string, requirePrivate: boolean): Promise<DirectoryIdentity> {
  try {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(path) !== resolve(path) ||
        (requirePrivate && (status.mode & 0o777) !== 0o700)) {
      fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
    }
    return Object.freeze({ device: status.dev, inode: status.ino, path: resolve(path) });
  } catch (error) {
    if (error instanceof HierarchicalWorkflowRunStoreError) throw error;
    fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
  }
}

async function identitiesMatch(identity: RunIdentity): Promise<boolean> {
  try {
    for (const entry of [
      identity.hub,
      identity.buildlore,
      identity.runs,
      identity.project,
      identity.run,
    ]) {
      const status = await lstat(entry.path);
      if (!status.isDirectory() || status.isSymbolicLink() || status.dev !== entry.device ||
          status.ino !== entry.inode || await realpath(entry.path) !== entry.path ||
          (entry !== identity.hub && (status.mode & 0o777) !== 0o700)) return false;
    }
    return identity.buildlore.path === join(identity.hub.path, '.buildlore') &&
      identity.runs.path === join(identity.buildlore.path, RUNS_DIRECTORY) &&
      identity.project.path === join(identity.runs.path, basename(identity.project.path)) &&
      contained(identity.hub.path, identity.run.path) &&
      identity.run.path === join(identity.project.path, basename(identity.run.path));
  } catch {
    return false;
  }
}

async function captureIdentity(
  hubRoot: string,
  projectId: string,
  runId: string,
): Promise<RunIdentity> {
  const hub = await directoryIdentity(hubRoot, false);
  const buildlorePath = join(hub.path, '.buildlore');
  const runsPath = join(buildlorePath, RUNS_DIRECTORY);
  const projectPath = join(runsPath, projectId);
  const runPath = join(projectPath, runId);
  const identity = Object.freeze({
    hub,
    buildlore: await directoryIdentity(buildlorePath, true),
    runs: await directoryIdentity(runsPath, true),
    project: await directoryIdentity(projectPath, true),
    run: await directoryIdentity(runPath, true),
  });
  if (!await identitiesMatch(identity)) fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
  return identity;
}

interface RegularFileSnapshot {
  readonly bytes: Buffer;
  readonly device: number;
  readonly inode: number;
}

async function readRegularFileSnapshot(
  path: string,
  maximumBytes: number,
): Promise<RegularFileSnapshot | null> {
  let handle: FileHandle | undefined;
  try {
    const pathBefore = await lstat(path);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() ||
        (pathBefore.mode & 0o777) !== 0o600 || pathBefore.size < 2 ||
        pathBefore.size > maximumBytes || await realpath(path) !== resolve(path)) {
      fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || (before.mode & 0o777) !== 0o600 ||
        before.dev !== pathBefore.dev || before.ino !== pathBefore.ino ||
        before.size !== pathBefore.size) {
      fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    }
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (!after.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink() ||
        after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        pathAfter.dev !== before.dev || pathAfter.ino !== before.ino ||
        pathAfter.size !== before.size || bytes.byteLength !== before.size ||
        (pathAfter.mode & 0o777) !== 0o600) {
      fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    }
    await handle.close();
    handle = undefined;
    return Object.freeze({ bytes, device: before.dev, inode: before.ino });
  } catch (error) {
    if (error instanceof HierarchicalWorkflowRunStoreError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    return fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
      }
    }
  }
}

async function readAt(
  identity: RunIdentity,
  path: string,
  projectId: string,
  runId: string,
): Promise<HierarchicalWorkflowRunRecordV1 | null> {
  if (path !== join(identity.run.path, RUN_FILENAME) || !await identitiesMatch(identity)) {
    fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
  }
  const snapshot = await readRegularFileSnapshot(path, MAXIMUM_RECORD_BYTES);
  if (!await identitiesMatch(identity)) fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
  if (snapshot === null) return null;
  return parseRecord(parseJsonStrict(decodeUtf8Strict(snapshot.bytes)), projectId, runId);
}

function parseLockOwner(value: unknown): LockOwnerV1 {
  exactKeys(value, ['hostname', 'pid', 'schemaVersion', 'token']);
  if (value.schemaVersion !== LOCK_SCHEMA_VERSION || typeof value.hostname !== 'string' ||
      value.hostname.length < 1 || value.hostname.length > 255 ||
      Array.from(value.hostname).some((character) => {
        const codePoint = character.charCodeAt(0);
        return codePoint < 0x20 || codePoint === 0x7f;
      }) ||
      !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 ||
      typeof value.token !== 'string' || !/^[0-9a-f]{64}$/u.test(value.token)) {
    fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
  }
  return Object.freeze({
    schemaVersion: LOCK_SCHEMA_VERSION,
    hostname: value.hostname,
    pid: value.pid as number,
    token: value.token,
  });
}

async function readLockIdentity(path: string): Promise<LockIdentity | null> {
  try {
    const snapshot = await readRegularFileSnapshot(path, MAXIMUM_LOCK_BYTES);
    if (snapshot === null) return null;
    const text = decodeUtf8Strict(snapshot.bytes);
    const parsed = parseJsonStrict(text);
    const owner = parseLockOwner(parsed);
    if (serializeCanonicalJson(owner) !== text) return null;
    return Object.freeze({ device: snapshot.device, inode: snapshot.inode, owner });
  } catch {
    return null;
  }
}

function ownerProcessIsDefinitelyDead(owner: LockOwnerV1): boolean {
  if (owner.hostname !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === 'ESRCH';
  }
}

async function recoverAbandonedLock(
  identity: RunIdentity,
  path: string,
): Promise<boolean> {
  if (!await identitiesMatch(identity)) return false;
  const existing = await readLockIdentity(path);
  if (existing === null || !ownerProcessIsDefinitelyDead(existing.owner)) return false;
  try {
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== existing.device ||
        current.ino !== existing.inode || (current.mode & 0o777) !== 0o600 ||
        !await identitiesMatch(identity)) return false;
    await unlink(path);
    await syncDirectory(identity.run.path);
    return await identitiesMatch(identity);
  } catch {
    return false;
  }
}

async function lockMatches(
  identity: RunIdentity,
  lockPath: string,
  lock: LockIdentity,
): Promise<boolean> {
  if (!await identitiesMatch(identity) || lockPath !== join(identity.run.path, LOCK_FILENAME)) {
    return false;
  }
  try {
    const status = await lstat(lockPath);
    return status.isFile() && !status.isSymbolicLink() && status.dev === lock.device &&
      status.ino === lock.inode && (status.mode & 0o777) === 0o600 &&
      await realpath(lockPath) === lockPath;
  } catch {
    return false;
  }
}

async function releaseLock(
  identity: RunIdentity,
  path: string,
  handle: FileHandle,
  lock: LockIdentity,
): Promise<boolean> {
  try {
    if (!await lockMatches(identity, path, lock)) {
      await handle.close();
      return false;
    }
    await unlink(path);
    await syncDirectory(identity.run.path);
    await handle.close();
    return true;
  } catch {
    await handle.close().catch(() => undefined);
    return false;
  }
}

async function acquireLock(
  identity: RunIdentity,
  path: string,
): Promise<Readonly<{ handle: FileHandle; lock: LockIdentity }>> {
  const owner = parseLockOwner(Object.freeze({
    schemaVersion: LOCK_SCHEMA_VERSION,
    hostname: hostname(),
    pid: process.pid,
    token: randomBytes(32).toString('hex'),
  }));
  const ownerPath = join(identity.run.path, `.run-lock-owner-${owner.token}`);
  let handle: FileHandle | undefined;
  let published = false;
  try {
    handle = await open(ownerPath, 'wx', 0o600);
    await handle.writeFile(serializeCanonicalJson(owner), 'utf8');
    await handle.sync();
    const ownerStatus = await handle.stat();
    if (!ownerStatus.isFile() || (ownerStatus.mode & 0o777) !== 0o600 ||
        !await identitiesMatch(identity)) {
      fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
    }
    try {
      await link(ownerPath, path);
      published = true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST' ||
          !await recoverAbandonedLock(identity, path)) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          fail('HIERARCHICAL_WORKFLOW_RUN_BUSY');
        }
        throw error;
      }
      try {
        await link(ownerPath, path);
        published = true;
      } catch (retryError) {
        if (isNodeError(retryError) && retryError.code === 'EEXIST') {
          fail('HIERARCHICAL_WORKFLOW_RUN_BUSY');
        }
        throw retryError;
      }
    }
    await syncDirectory(identity.run.path);
    const lockStatus = await lstat(path);
    if (!lockStatus.isFile() || lockStatus.isSymbolicLink() ||
        lockStatus.dev !== ownerStatus.dev || lockStatus.ino !== ownerStatus.ino ||
        (lockStatus.mode & 0o777) !== 0o600 || !await identitiesMatch(identity)) {
      fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
    }
    await unlink(ownerPath);
    await syncDirectory(identity.run.path);
    const lock = Object.freeze({
      device: ownerStatus.dev,
      inode: ownerStatus.ino,
      owner,
    });
    return Object.freeze({ handle, lock });
  } catch (error) {
    if (published) {
      const status = await lstat(path).catch(() => null);
      if (status !== null && handle !== undefined) {
        const ownerStatus = await handle.stat().catch(() => null);
        if (ownerStatus !== null && status.dev === ownerStatus.dev &&
            status.ino === ownerStatus.ino) {
          await unlink(path).catch(() => undefined);
        }
      }
    }
    await unlink(ownerPath).catch(() => undefined);
    await handle?.close().catch(() => undefined);
    if (error instanceof HierarchicalWorkflowRunStoreError) throw error;
    fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
  }
}

async function withLock<T>(
  identity: RunIdentity,
  hooks: HierarchicalWorkflowRunStoreTestHooks,
  action: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const path = join(identity.run.path, LOCK_FILENAME);
  let handle: FileHandle | undefined;
  let lock: LockIdentity | undefined;
  try {
    await hooks.beforeLockOpen?.();
    if (!await identitiesMatch(identity)) fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
    const acquired = await acquireLock(identity, path);
    handle = acquired.handle;
    lock = acquired.lock;
    if (!await lockMatches(identity, path, lock)) fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
  } catch (error) {
    if (handle !== undefined && lock !== undefined) {
      await releaseLock(identity, path, handle, lock).catch(() => false);
    } else {
      await handle?.close().catch(() => undefined);
    }
    if (error instanceof HierarchicalWorkflowRunStoreError) throw error;
    fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
  }
  const assertOwned = async () => {
    if (lock === undefined) fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
    if (!await lockMatches(identity, path, lock)) {
      fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
    }
  };
  const outcome = await Promise.resolve().then(assertOwned).then(() => action(assertOwned)).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  );
  try { await hooks.beforeLockRelease?.(); } catch { /* cleanup-only test hook */ }
  if (handle === undefined || lock === undefined) fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
  const released = await releaseLock(identity, path, handle, lock);
  if (!outcome.ok) {
    if (!released) fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
    throw outcome.error;
  }
  if (!released) fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
  return outcome.value;
}

async function assertExpected(
  identity: RunIdentity,
  path: string,
  input: Readonly<{
    readonly expectedRecordDigest: HierarchySha256Digest;
    readonly expectedRevision: number;
    readonly projectId: string;
    readonly runId: string;
  }>,
): Promise<void> {
  const current = await readAt(identity, path, input.projectId, input.runId);
  if (current === null) fail('HIERARCHICAL_WORKFLOW_RUN_NOT_FOUND');
  if (current.revision !== input.expectedRevision ||
      current.recordDigest !== input.expectedRecordDigest) {
    fail('HIERARCHICAL_WORKFLOW_RUN_CONFLICT');
  }
}

export function createHierarchicalWorkflowRunStore(
  hubRootValue: string,
  hooks: HierarchicalWorkflowRunStoreTestHooks = {},
): HierarchicalWorkflowRunStorePort {
  const hubRoot = resolve(hubRootValue);
  const paths = (projectIdValue: string, runIdValue: string) => {
    const projectId = parseProjectId(projectIdValue);
    const runId = parseRunId(runIdValue);
    const runs = join(hubRoot, '.buildlore', RUNS_DIRECTORY);
    const project = join(runs, projectId);
    const run = join(project, runId);
    if (!contained(hubRoot, run)) fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
    return Object.freeze({ projectId, runId, runs, project, run });
  };
  const store: HierarchicalWorkflowRunStorePort = {
    async create(record) {
      const parsed = snapshotRecord(record, record.projectId, record.runId);
      const target = paths(parsed.projectId, parsed.runId);
      try {
        const hubStatus = await lstat(hubRoot);
        if (!hubStatus.isDirectory() || hubStatus.isSymbolicLink() ||
            await realpath(hubRoot) !== hubRoot) fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
        const buildlore = join(hubRoot, '.buildlore');
        await ensureDirectory(buildlore, hubRoot);
        await ensureDirectory(target.runs, buildlore);
        await ensureDirectory(target.project, target.runs);
        try {
          await mkdir(target.run, { mode: 0o700 });
          await syncDirectory(target.project);
        } catch (error) {
          if (isNodeError(error) && error.code === 'EEXIST') {
            fail('HIERARCHICAL_WORKFLOW_RUN_CONFLICT');
          }
          throw error;
        }
        const identity = await captureIdentity(hubRoot, target.projectId, target.runId);
        await withLock(identity, hooks, async (assertOwned) => {
          await assertOwned();
          await hooks.beforeCommit?.();
          await assertOwned();
          await writeJsonAtomic(join(identity.run.path, RUN_FILENAME), parsed, {
            confinementRoot: hubRoot,
          });
        });
      } catch (error) {
        if (error instanceof HierarchicalWorkflowRunStoreError) throw error;
        fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
      }
    },
    async read(projectIdValue, runIdValue) {
      const target = paths(projectIdValue, runIdValue);
      try {
        await lstat(target.run);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          fail('HIERARCHICAL_WORKFLOW_RUN_NOT_FOUND');
        }
        fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
      }
      const identity = await captureIdentity(hubRoot, target.projectId, target.runId);
      const record = await readAt(
        identity,
        join(identity.run.path, RUN_FILENAME),
        target.projectId,
        target.runId,
      );
      if (record === null) fail('HIERARCHICAL_WORKFLOW_RUN_NOT_FOUND');
      return record;
    },
    async replace(input) {
      const target = paths(input.projectId, input.runId);
      const expectedRecordDigest = digestValue(input.expectedRecordDigest);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
      }
      const expectedRevision = input.expectedRevision;
      const next = snapshotRecord(input.next, target.projectId, target.runId);
      const expected = Object.freeze({
        expectedRecordDigest,
        expectedRevision,
        projectId: target.projectId,
        runId: target.runId,
      });
      if (next.revision !== expectedRevision + 1) {
        fail('HIERARCHICAL_WORKFLOW_RUN_CONFLICT');
      }
      const identity = await captureIdentity(hubRoot, target.projectId, target.runId);
      await withLock(identity, hooks, async (assertOwned) => {
        const path = join(identity.run.path, RUN_FILENAME);
        await assertExpected(identity, path, expected);
        await assertOwned();
        await hooks.beforeCommit?.();
        await assertOwned();
        await writeJsonAtomic(path, next, { confinementRoot: hubRoot });
      });
    },
    async approve(input) {
      const target = paths(input.projectId, input.runId);
      const expectedRecordDigest = digestValue(input.expectedRecordDigest);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
      }
      const expectedRevision = input.expectedRevision;
      const next = snapshotRecord(input.next, target.projectId, target.runId);
      const activationBundle = snapshotActivationBundle(input.activationBundle, next);
      if ((next.revision !== expectedRevision + 1 &&
           next.revision !== expectedRevision) || next.phase !== 'approved') {
        fail('HIERARCHICAL_WORKFLOW_RUN_CONFLICT');
      }
      const identity = await captureIdentity(hubRoot, target.projectId, target.runId);
      await withLock(identity, hooks, async (assertOwned) => {
        const path = join(identity.run.path, RUN_FILENAME);
        const current = await readAt(identity, path, target.projectId, target.runId);
        if (current === null || current.recordDigest !== expectedRecordDigest ||
            current.revision !== expectedRevision) {
          fail('HIERARCHICAL_WORKFLOW_RUN_CONFLICT');
        }
        await assertOwned();
        await hooks.beforeCommit?.();
        await assertOwned();
        // The approved record is the commit point. If bundle materialization fails afterward,
        // retrying approve with the same record is idempotent and cannot expose an unbound path.
        if (next.revision === expectedRevision + 1) {
          await writeJsonAtomic(path, next, { confinementRoot: hubRoot });
          await assertOwned();
        } else if (!sameValue(current, next)) {
          fail('HIERARCHICAL_WORKFLOW_RUN_CONFLICT');
        }
        await hooks.beforeActivationBundleCommit?.();
        await assertOwned();
        await writeJsonAtomic(join(identity.run.path, ACTIVATION_FILENAME), activationBundle, {
          confinementRoot: hubRoot,
        });
      });
    },
    async activationBundleState(record) {
      const target = paths(record.projectId, record.runId);
      const expected = snapshotRecord(record, target.projectId, target.runId);
      if (expected.phase !== 'approved' || expected.approvalDecision === null) {
        fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
      }
      const identity = await captureIdentity(hubRoot, target.projectId, target.runId);
      const current = await readAt(
        identity,
        join(identity.run.path, RUN_FILENAME),
        target.projectId,
        target.runId,
      );
      if (current === null || !sameValue(current, expected)) {
        fail('HIERARCHICAL_WORKFLOW_RUN_CONFLICT');
      }
      const bundleSnapshot = await readRegularFileSnapshot(
        join(identity.run.path, ACTIVATION_FILENAME),
        MAXIMUM_RECORD_BYTES,
      );
      if (!await identitiesMatch(identity)) fail('HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED');
      if (bundleSnapshot === null) return 'missing';
      try {
        snapshotActivationBundle(
          parseJsonStrict(decodeUtf8Strict(bundleSnapshot.bytes)) as Readonly<{
            readonly authority: ApprovedWikiAuthorityV1;
            readonly projectId: string;
            readonly schemaVersion: 'buildlore.hierarchical-wiki-activation-input.v1';
          }>,
          expected,
        );
      } catch (error) {
        if (error instanceof HierarchicalWorkflowRunStoreError) throw error;
        fail('HIERARCHICAL_WORKFLOW_RUN_INVALID');
      }
      return 'verified';
    },
    activationBundlePath(projectIdValue, runIdValue) {
      const target = paths(projectIdValue, runIdValue);
      return `.buildlore/${RUNS_DIRECTORY}/${target.projectId}/${target.runId}/${ACTIVATION_FILENAME}`;
    },
  };
  return Object.freeze(store);
}
