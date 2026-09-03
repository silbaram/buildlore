import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import {
  HIERARCHICAL_COMPILATION_POLICY,
  HierarchicalWorkflowEvidenceInsufficientError,
  advanceCompileContinuation,
  approveChildSummaryForSynthesis,
  buildSparseRelationGraph,
  checkAuthoritativeWikiState,
  createCompilationPurpose,
  createCompileCandidateReview,
  createCompileIntegrityReport,
  createCompileRelationReview,
  createCorpusSnapshot,
  createCurrentSessionGenerationService,
  createDocumentInterpretation,
  createEvidencePack,
  createHumanActivationApproval,
  createIntegratedWikiCandidateReview,
  createIntegratedWikiReviewSurface,
  createPageOwnershipGraph,
  createProjectSessionCompiler,
  createWikiOutline,
  digestHierarchyValue,
  evaluatePageSemanticQuality,
  finalizeCompileRun,
  finalizePlanningDispositionInventory,
  hierarchySha256,
  parseCurrentSessionProposalSubmission,
  reconcileWikiProposalLinks,
  createSubstantiveHierarchyTextUnits,
  selectRelevantHierarchyEvidenceUnitIds,
  startCompileContinuation,
  verifyCompileRunApproval,
  type ApprovedChildSummaryV1,
  type CompileCandidateReviewV1,
  type CompilePartitionV2,
  type CompileRunLedgerV1,
  type CompilationPurposeV1,
  type CorpusSnapshotV1,
  type CurrentSessionGenerationExchangeV1,
  type CurrentSessionGenerationHandoffV1,
  type CurrentSessionGenerationResultV1,
  type CurrentSessionGenerationService,
  type CurrentSessionGenerationSessionV1,
  type CurrentSessionProposalSubmissionV1,
  type EvidencePackV1,
  type FinalizeCompileRunInputV1,
  type HierarchySha256Digest,
  type IntegratedWikiReviewSurfaceV1,
  type PageBlueprintV1,
  type PageQualityReportV1,
  type PageOwnershipGraphV1,
  type PlanningDispositionInventoryV1,
  type ProjectSessionCompilerPort,
  type SanitizedEvidenceSourceV1,
  type SessionCompilePlanV1,
  type SparseRelationGraphV1,
  type WikiLinkReconciliationV1,
  type WikiOutlineV1,
} from '../compiler/index.js';
import { readConfinedSessionUtf8 } from '../compiler/session/safe-io.js';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { showProject } from '../knowledge/index.js';
import { parseJsonStrict } from '../knowledge/strict-json.js';
import { validateProjectId } from '../knowledge/validation.js';
import { consumePreparedSource } from '../sanitizer/approval.js';
import {
  SANITIZER_RULES_VERSION,
  createProjectSecurityService,
  readSecurityPolicy,
  sourceIdentitySha256,
} from '../sanitizer/index.js';
import {
  APPROVED_WIKI_AUTHORITY_SCHEMA_VERSION,
  ApprovedWikiProjectionError,
  createApprovedWikiProjectionStore,
  type ApprovedWikiAuthorityV1,
  type ApprovedWikiProjectionStorePort,
} from '../retrieval/index.js';
import {
  HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
} from './hierarchical-activation.js';
import {
  HierarchicalWorkflowRunStoreError,
  createHierarchicalWorkflowRunRecord,
  createHierarchicalWorkflowRunStore,
  type HierarchicalWorkflowApprovalDecisionV1,
  type HierarchicalWorkflowPhaseV1,
  type HierarchicalWorkflowRejectionV1,
  type HierarchicalWorkflowRunRecordV1,
  type HierarchicalWorkflowRunStorePort,
  type HierarchicalWorkflowStoredChildDecisionV1,
  type HierarchicalWorkflowStoredIntegratedDecisionV1,
  type HierarchicalWorkflowStoredRelationDecisionV1,
  type HierarchicalWorkflowStoredSubmissionV1,
  type HierarchicalWorkflowStoredResubmissionV2,
} from './hierarchical-run-store.js';

export const HIERARCHICAL_WORKFLOW_PURPOSE_INPUT_SCHEMA_VERSION =
  'buildlore.hierarchical-workflow-purpose-input.v1' as const;
export const HIERARCHICAL_WORKFLOW_CHILD_REVIEW_INPUT_SCHEMA_VERSION =
  'buildlore.hierarchical-workflow-child-review-input.v1' as const;
export const HIERARCHICAL_WORKFLOW_FINALIZE_INPUT_SCHEMA_VERSION =
  'buildlore.hierarchical-workflow-finalize-input.v1' as const;
export const HIERARCHICAL_WORKFLOW_STATUS_SCHEMA_VERSION =
  'buildlore.hierarchical-workflow-status.v1' as const;
export const HIERARCHICAL_WORKFLOW_START_RESULT_SCHEMA_VERSION =
  'buildlore.hierarchical-workflow-start-result.v1' as const;
export const HIERARCHICAL_WORKFLOW_SUBMIT_RESULT_SCHEMA_VERSION =
  'buildlore.hierarchical-workflow-submit-result.v1' as const;
export const HIERARCHICAL_WORKFLOW_CHILD_REVIEW_RESULT_SCHEMA_VERSION =
  'buildlore.hierarchical-workflow-child-review-result.v1' as const;
export const HIERARCHICAL_WORKFLOW_REVIEW_VIEW_SCHEMA_VERSION =
  'buildlore.hierarchical-workflow-review-view.v1' as const;
export const HIERARCHICAL_WORKFLOW_CHILD_REVIEW_VIEW_SCHEMA_VERSION =
  'buildlore.hierarchical-workflow-child-review-view.v1' as const;
export const HIERARCHICAL_WORKFLOW_FINALIZE_RESULT_SCHEMA_VERSION =
  'buildlore.hierarchical-workflow-finalize-result.v1' as const;
export const HIERARCHICAL_WORKFLOW_APPROVE_RESULT_SCHEMA_VERSION =
  'buildlore.hierarchical-workflow-approve-result.v1' as const;

const RUN_ID_PATTERN = /^run-[0-9a-f]{64}$/u;
const PAGE_ID_PATTERN = /^page-[0-9a-f]{64}$/u;
const RELATION_ID_PATTERN = /^relation-[0-9a-f]{64}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REASON_CODE_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const MAXIMUM_PURPOSE_BYTES = 262_144;
const MAXIMUM_INPUT_BYTES = 524_288;
const INTERPRETATION_RULES_DIGEST = digestHierarchyValue({
  schemaVersion: 'buildlore.hierarchical-workflow-interpretation.v2',
  strategy: 'document-heading-topics-with-shared-korean-token-variants',
});

export interface HierarchicalWorkflowPurposeInputV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WORKFLOW_PURPOSE_INPUT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly audience: readonly string[];
  readonly goals: readonly string[];
  readonly keyQuestions: readonly string[];
  readonly scopeHints: readonly string[];
  readonly excludedTopics: readonly string[];
  readonly outputLanguage: string;
  readonly requestedPageRoles: readonly string[];
  readonly wikiTitle?: string;
}

export interface HierarchicalWorkflowChildReviewInputV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WORKFLOW_CHILD_REVIEW_INPUT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly pageId: string;
  readonly reviewViewDigest: HierarchySha256Digest;
  readonly decision: 'accepted' | 'rejected';
  readonly reasonCodes: readonly string[];
}

export interface HierarchicalWorkflowIntegratedDecisionInputV1 {
  readonly decision: 'accepted' | 'rejected';
  readonly pageId: string;
  readonly reasonCodes: readonly string[];
}

export interface HierarchicalWorkflowRelationDecisionInputV1 {
  readonly decision: 'accepted' | 'rejected';
  readonly relationId: string;
}

export interface HierarchicalWorkflowFinalizeInputV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WORKFLOW_FINALIZE_INPUT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly reviewDigest: HierarchySha256Digest;
  readonly surfaceDigest: HierarchySha256Digest;
  readonly candidateDecisions: readonly HierarchicalWorkflowIntegratedDecisionInputV1[];
  readonly relationDecisions: readonly HierarchicalWorkflowRelationDecisionInputV1[];
}

export interface HierarchicalWorkflowChildReviewViewV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WORKFLOW_CHILD_REVIEW_VIEW_SCHEMA_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly pageId: string;
  readonly exchange: CurrentSessionGenerationExchangeV1;
  readonly result: CurrentSessionGenerationResultV1;
  readonly allowedDecisions: readonly ['accepted', 'rejected'];
  readonly reviewViewDigest: HierarchySha256Digest;
}

export interface HierarchicalWorkflowReviewViewV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WORKFLOW_REVIEW_VIEW_SCHEMA_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly surface: IntegratedWikiReviewSurfaceV1;
  readonly relationCandidates: SparseRelationGraphV1['relations'];
  readonly reviewDigest: HierarchySha256Digest;
}

export type HierarchicalWorkflowNextActionV1 =
  | 'submit-proposal'
  | 'resubmit-proposal'
  | 'review-child'
  | 'review-integrated-wiki'
  | 'approve-activation'
  | 'activate-approved-wiki'
  | 'none';

export interface HierarchicalWorkflowStatusV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WORKFLOW_STATUS_SCHEMA_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly revision: number;
  readonly phase: HierarchicalWorkflowPhaseV1;
  readonly purpose: CompilationPurposeV1;
  readonly nextAction: HierarchicalWorkflowNextActionV1;
  readonly currentExchange: CurrentSessionGenerationExchangeV1 | null;
  readonly childReview: HierarchicalWorkflowChildReviewViewV1 | null;
  readonly review: HierarchicalWorkflowReviewViewV1 | null;
  readonly ledger: CompileRunLedgerV1 | null;
  readonly rejection: HierarchicalWorkflowRejectionV1 | null;
  readonly activationState: 'not-approved' | 'awaiting-activation' | 'active';
  readonly authorityCheckStatus: 'clean' | null;
  readonly authorityCheck: ApprovedWikiAuthorityV1['authorityCheck'] | null;
  readonly egress: 'none';
  readonly providerUsed: null;
  readonly processSpawned: false;
}

export interface HierarchicalWorkflowStartResultV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WORKFLOW_START_RESULT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly purpose: CompilationPurposeV1;
  readonly status: HierarchicalWorkflowStatusV1;
}

export interface HierarchicalWorkflowSubmitResultV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WORKFLOW_SUBMIT_RESULT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly pageId: string;
  readonly proposalDigest: HierarchySha256Digest;
  readonly receiptDigest: HierarchySha256Digest;
  readonly status: HierarchicalWorkflowStatusV1;
}

export interface HierarchicalWorkflowChildReviewResultV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WORKFLOW_CHILD_REVIEW_RESULT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly pageId: string;
  readonly decision: 'accepted' | 'rejected';
  readonly reviewDigest: HierarchySha256Digest;
  readonly status: HierarchicalWorkflowStatusV1;
}

export interface HierarchicalWorkflowFinalizeResultV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WORKFLOW_FINALIZE_RESULT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly phase: 'finalized' | 'rejected';
  readonly surface: IntegratedWikiReviewSurfaceV1;
  readonly ledger: CompileRunLedgerV1 | null;
  readonly rejection: HierarchicalWorkflowRejectionV1 | null;
}

export interface HierarchicalWorkflowApproveResultV1 {
  readonly schemaVersion: typeof HIERARCHICAL_WORKFLOW_APPROVE_RESULT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly approvalDigest: HierarchySha256Digest;
  readonly generationDigest: HierarchySha256Digest;
  readonly activationBundlePath: string;
  readonly activationBundleDigest: HierarchySha256Digest;
  readonly activationArgs: readonly string[];
  readonly egress: 'none';
  readonly providerUsed: null;
  readonly processSpawned: false;
}

export type HierarchicalWorkflowErrorCode =
  | 'HIERARCHICAL_WORKFLOW_BASELINE_DRIFT'
  | 'HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH'
  | 'HIERARCHICAL_WORKFLOW_INELIGIBLE'
  | 'HIERARCHICAL_WORKFLOW_INPUT_INVALID'
  | 'HIERARCHICAL_WORKFLOW_PHASE_MISMATCH'
  | 'HIERARCHICAL_WORKFLOW_PROJECT_MISMATCH'
  | 'HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH'
  | 'HIERARCHICAL_WORKFLOW_RUN_ID_EXHAUSTED'
  | 'HIERARCHICAL_WORKFLOW_SOURCE_DRIFT';

export class HierarchicalWorkflowError extends Error {
  readonly code: HierarchicalWorkflowErrorCode;
  readonly retryable = false;

  constructor(code: HierarchicalWorkflowErrorCode) {
    super(code === 'HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH'
      ? 'Hierarchical Wiki workflow expectation does not match.'
      : code === 'HIERARCHICAL_WORKFLOW_PHASE_MISMATCH'
        ? 'Hierarchical Wiki workflow phase does not permit this operation.'
        : code === 'HIERARCHICAL_WORKFLOW_PROJECT_MISMATCH'
          ? 'Hierarchical Wiki workflow project does not match.'
          : code === 'HIERARCHICAL_WORKFLOW_INELIGIBLE'
            ? 'Hierarchical Wiki workflow is not eligible for approval.'
            : code === 'HIERARCHICAL_WORKFLOW_BASELINE_DRIFT' ||
                code === 'HIERARCHICAL_WORKFLOW_SOURCE_DRIFT'
              ? 'Hierarchical Wiki workflow inputs are no longer current.'
              : code === 'HIERARCHICAL_WORKFLOW_RUN_ID_EXHAUSTED'
                ? 'Hierarchical Wiki workflow run identifier could not be allocated.'
                : code === 'HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH'
                  ? 'Hierarchical Wiki workflow replay did not match stored decisions.'
                  : 'Hierarchical Wiki workflow input is invalid.');
    this.name = 'HierarchicalWorkflowError';
    this.code = code;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({ code: this.code, message: this.message, retryable: false });
  }
}

export interface HierarchicalWorkflowServicePort {
  start(projectId: string, purposeFile: string): Promise<HierarchicalWorkflowStartResultV1>;
  status(projectId: string, runId: string): Promise<HierarchicalWorkflowStatusV1>;
  submit(
    projectId: string,
    runId: string,
    inputFile: string,
    expectExchange: HierarchySha256Digest,
  ): Promise<HierarchicalWorkflowSubmitResultV1>;
  resubmit(
    projectId: string,
    runId: string,
    pageId: string,
    inputFile: string,
    expectExchange: HierarchySha256Digest,
  ): Promise<HierarchicalWorkflowSubmitResultV1>;
  childReview(
    projectId: string,
    runId: string,
    inputFile: string,
    expectReview: HierarchySha256Digest,
  ): Promise<HierarchicalWorkflowChildReviewResultV1>;
  review(projectId: string, runId: string): Promise<HierarchicalWorkflowReviewViewV1>;
  finalize(
    projectId: string,
    runId: string,
    inputFile: string,
    expectReview: HierarchySha256Digest,
  ): Promise<HierarchicalWorkflowFinalizeResultV1>;
  approve(
    projectId: string,
    runId: string,
    expectLedger: HierarchySha256Digest,
    explicitConfirmation: true,
  ): Promise<HierarchicalWorkflowApproveResultV1>;
}

export interface CreateHierarchicalWorkflowServiceOptions {
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly compiler?: Pick<ProjectSessionCompilerPort, 'plan'>;
  readonly corpusStore?: ApprovedWikiProjectionStorePort;
  readonly runStore?: HierarchicalWorkflowRunStorePort;
  readonly createGenerationService?: () => CurrentSessionGenerationService;
  readonly createRunIdBytes?: () => Uint8Array;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function fail(code: HierarchicalWorkflowErrorCode): never {
  throw new HierarchicalWorkflowError(code);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, expected: readonly string[]): asserts value is UnknownRecord {
  if (!isRecord(value)) fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length ||
      actual.some((key, index) => key !== canonical[index])) {
    fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
}

function project(value: unknown): string {
  if (typeof value !== 'string') fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  try { return validateProjectId(value); } catch {
    return fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
}

function runId(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
  return value;
}

function digest(value: unknown): HierarchySha256Digest {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
  return value as HierarchySha256Digest;
}

function sameValue(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function reasonCodes(value: unknown, requireNonempty: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 32 || (requireNonempty && value.length === 0)) {
    fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
  const result = value.map((item) => {
    if (typeof item !== 'string' || item.length < 1 || item.length > 64 ||
        !REASON_CODE_PATTERN.test(item)) fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
    return item;
  });
  const sorted = [...result].sort();
  if (new Set(result).size !== result.length ||
      result.some((item, index) => item !== sorted[index])) {
    fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
  return Object.freeze(result);
}

function canonicalDigest(value: unknown): HierarchySha256Digest {
  return digestHierarchyValue(value);
}

function stableSourceId(projectId: string, sourceRef: string): string {
  return `source-${hierarchySha256(`${projectId}:${sourceRef}`).slice('sha256:'.length)}`;
}

function createPurpose(value: unknown, expectedProjectId: string): CompilationPurposeV1 {
  const hasWikiTitle = isRecord(value) && Object.hasOwn(value, 'wikiTitle');
  exactKeys(value, [
    'audience', 'excludedTopics', 'goals', 'keyQuestions', 'outputLanguage', 'projectId',
    'requestedPageRoles', 'schemaVersion', 'scopeHints', ...(hasWikiTitle ? ['wikiTitle'] : []),
  ]);
  if (value.schemaVersion !== HIERARCHICAL_WORKFLOW_PURPOSE_INPUT_SCHEMA_VERSION ||
      value.projectId !== expectedProjectId) {
    fail(value.projectId === expectedProjectId
      ? 'HIERARCHICAL_WORKFLOW_INPUT_INVALID'
      : 'HIERARCHICAL_WORKFLOW_PROJECT_MISMATCH');
  }
  try {
    return createCompilationPurpose({
      audience: value.audience as readonly string[],
      excludedTopics: value.excludedTopics as readonly string[],
      goals: value.goals as readonly string[],
      keyQuestions: value.keyQuestions as readonly string[],
      outputLanguage: value.outputLanguage as string,
      projectId: expectedProjectId,
      requestedPageRoles: value.requestedPageRoles as readonly string[],
      scopeHints: value.scopeHints as readonly string[],
      ...(hasWikiTitle ? { wikiTitle: value.wikiTitle as string } : {}),
    });
  } catch {
    return fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
}

async function assertSafePurpose(
  purpose: CompilationPurposeV1,
  knowledgeRoot: string,
  projectId: string,
): Promise<void> {
  const body = serializeCanonicalJson(purpose);
  const bodyDigest = hierarchySha256(body);
  const source = 'hierarchical-workflow-purpose.json';
  try {
    const policy = await readSecurityPolicy(knowledgeRoot, projectId);
    const result = await createProjectSecurityService({ knowledgeRoot }).prepareSource({
      body,
      bodyDigest,
      projectId,
      source,
      sourceKind: 'planning',
      sourceRevisionOrContentSha256: purpose.purposeDigest,
    });
    const prepared = result.ok ? consumePreparedSource(result.prepared) : null;
    if (!result.ok || prepared === null || result.report.inputDigest !== bodyDigest ||
        result.report.outputDigest !== bodyDigest || result.report.policyDigest !== policy.digest ||
        result.report.projectId !== projectId ||
        result.report.rulesVersion !== SANITIZER_RULES_VERSION ||
        result.report.sourceIdentitySha256 !== sourceIdentitySha256(source) ||
        result.report.summaries.some((summary) => summary.count > 0) ||
        prepared.approvedBody !== body || prepared.approvedBodyDigest !== bodyDigest ||
        prepared.inputBodyDigest !== bodyDigest || prepared.policyDigest !== policy.digest ||
        prepared.projectId !== projectId || prepared.rulesVersion !== SANITIZER_RULES_VERSION ||
        prepared.source !== source || prepared.sourceKind !== 'planning' ||
        prepared.sourceRevisionOrContentSha256 !== purpose.purposeDigest ||
        prepared.untrustedData) {
      fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
    }
  } catch (error) {
    if (error instanceof HierarchicalWorkflowError) throw error;
    fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
}

function parseChildReviewInput(
  value: unknown,
  expectedProjectId: string,
  expectedRunId: string,
): HierarchicalWorkflowChildReviewInputV1 {
  exactKeys(value, [
    'decision', 'pageId', 'projectId', 'reasonCodes', 'reviewViewDigest', 'runId',
    'schemaVersion',
  ]);
  if (value.schemaVersion !== HIERARCHICAL_WORKFLOW_CHILD_REVIEW_INPUT_SCHEMA_VERSION ||
      value.projectId !== expectedProjectId || value.runId !== expectedRunId ||
      typeof value.pageId !== 'string' || !PAGE_ID_PATTERN.test(value.pageId) ||
      (value.decision !== 'accepted' && value.decision !== 'rejected')) {
    fail(value.projectId === expectedProjectId
      ? 'HIERARCHICAL_WORKFLOW_INPUT_INVALID'
      : 'HIERARCHICAL_WORKFLOW_PROJECT_MISMATCH');
  }
  return Object.freeze({
    schemaVersion: HIERARCHICAL_WORKFLOW_CHILD_REVIEW_INPUT_SCHEMA_VERSION,
    projectId: expectedProjectId,
    runId: expectedRunId,
    pageId: value.pageId,
    reviewViewDigest: digest(value.reviewViewDigest),
    decision: value.decision,
    reasonCodes: reasonCodes(value.reasonCodes, value.decision === 'rejected'),
  });
}

function parseFinalizeInput(
  value: unknown,
  expectedProjectId: string,
  expectedRunId: string,
): HierarchicalWorkflowFinalizeInputV1 {
  exactKeys(value, [
    'candidateDecisions', 'projectId', 'relationDecisions', 'reviewDigest', 'runId',
    'schemaVersion', 'surfaceDigest',
  ]);
  if (value.schemaVersion !== HIERARCHICAL_WORKFLOW_FINALIZE_INPUT_SCHEMA_VERSION ||
      value.projectId !== expectedProjectId || value.runId !== expectedRunId ||
      !Array.isArray(value.candidateDecisions) || value.candidateDecisions.length > 97 ||
      !Array.isArray(value.relationDecisions) || value.relationDecisions.length > 131_072) {
    fail(value.projectId === expectedProjectId
      ? 'HIERARCHICAL_WORKFLOW_INPUT_INVALID'
      : 'HIERARCHICAL_WORKFLOW_PROJECT_MISMATCH');
  }
  const candidateInputs = value.candidateDecisions as unknown[];
  const candidateDecisions = Object.freeze(candidateInputs.map((item, index) => {
    exactKeys(item, ['decision', 'pageId', 'reasonCodes']);
    const previous = candidateInputs[index - 1] as UnknownRecord | undefined;
    if ((item.decision !== 'accepted' && item.decision !== 'rejected') ||
        typeof item.pageId !== 'string' || !PAGE_ID_PATTERN.test(item.pageId) ||
        (typeof previous?.pageId === 'string' && previous.pageId >= item.pageId)) {
      fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
    }
    return Object.freeze({
      decision: item.decision,
      pageId: item.pageId,
      reasonCodes: reasonCodes(item.reasonCodes, item.decision === 'rejected'),
    });
  }));
  const relationInputs = value.relationDecisions as unknown[];
  const relationDecisions = Object.freeze(relationInputs.map((item, index) => {
    exactKeys(item, ['decision', 'relationId']);
    const previous = relationInputs[index - 1] as UnknownRecord | undefined;
    if ((item.decision !== 'accepted' && item.decision !== 'rejected') ||
        typeof item.relationId !== 'string' || !RELATION_ID_PATTERN.test(item.relationId) ||
        (typeof previous?.relationId === 'string' && previous.relationId >= item.relationId)) {
      fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
    }
    return Object.freeze({ decision: item.decision, relationId: item.relationId });
  }));
  return Object.freeze({
    schemaVersion: HIERARCHICAL_WORKFLOW_FINALIZE_INPUT_SCHEMA_VERSION,
    projectId: expectedProjectId,
    runId: expectedRunId,
    reviewDigest: digest(value.reviewDigest),
    surfaceDigest: digest(value.surfaceDigest),
    candidateDecisions,
    relationDecisions,
  });
}

interface LiveHierarchyV1 {
  readonly plan: SessionCompilePlanV1;
  readonly snapshot: CorpusSnapshotV1;
  readonly graph: SparseRelationGraphV1;
  readonly outline: WikiOutlineV1;
  readonly partitions: readonly CompilePartitionV2[];
  readonly planningInventory: PlanningDispositionInventoryV1;
  readonly evidencePacks: readonly EvidencePackV1[];
}

interface ReplayGenerationV1 {
  readonly blueprint: PageBlueprintV1;
  readonly exchange: CurrentSessionGenerationExchangeV1;
  readonly result: CurrentSessionGenerationResultV1;
}

interface ReplayBaseV1 extends LiveHierarchyV1 {
  readonly generations: readonly ReplayGenerationV1[];
  readonly childReviews: readonly CompileCandidateReviewV1[];
  readonly generationService: CurrentSessionGenerationService;
}

type ReplayStateV1 =
  | Readonly<{
      readonly kind: 'awaiting-proposal';
      readonly base: ReplayBaseV1;
      readonly exchange: CurrentSessionGenerationExchangeV1;
      readonly session: CurrentSessionGenerationSessionV1;
    }>
  | Readonly<{
      readonly kind: 'hard-quality-failed';
      readonly base: ReplayBaseV1;
      readonly exchange: CurrentSessionGenerationExchangeV1 | null;
      readonly session: CurrentSessionGenerationSessionV1 | null;
      readonly pageQualityReport: PageQualityReportV1;
      readonly rejection: HierarchicalWorkflowRejectionV1;
    }>
  | Readonly<{
      readonly kind: 'awaiting-child-review';
      readonly base: ReplayBaseV1;
      readonly childReview: HierarchicalWorkflowChildReviewViewV1;
    }>
  | Readonly<{
      readonly kind: 'review-ready';
      readonly base: ReplayBaseV1;
      readonly review: HierarchicalWorkflowReviewViewV1;
    }>
  | Readonly<{
      readonly kind: 'rejected';
      readonly base: ReplayBaseV1;
      readonly review: HierarchicalWorkflowReviewViewV1 | null;
      readonly rejection: HierarchicalWorkflowRejectionV1;
    }>
  | Readonly<{
      readonly kind: 'finalized';
      readonly base: ReplayBaseV1;
      readonly review: HierarchicalWorkflowReviewViewV1;
      readonly surface: IntegratedWikiReviewSurfaceV1;
      readonly finalization: FinalizeCompileRunInputV1;
      readonly ledger: CompileRunLedgerV1;
    }>
  | Readonly<{
      readonly kind: 'approved';
      readonly base: ReplayBaseV1;
      readonly review: HierarchicalWorkflowReviewViewV1;
      readonly surface: IntegratedWikiReviewSurfaceV1;
      readonly finalization: FinalizeCompileRunInputV1;
      readonly ledger: CompileRunLedgerV1;
      readonly ownershipGraph: PageOwnershipGraphV1;
      readonly authority: ApprovedWikiAuthorityV1;
    }>;

async function buildLiveHierarchy(
  compiler: Pick<ProjectSessionCompilerPort, 'plan'>,
  knowledgeRoot: string,
  purpose: CompilationPurposeV1,
  projectId: string,
): Promise<LiveHierarchyV1> {
  try {
    const [plan, policy] = await Promise.all([
      compiler.plan({ projectId }),
      readSecurityPolicy(knowledgeRoot, projectId),
    ]);
    if (plan.projectId !== projectId || plan.sources.length < 1 ||
        plan.sources.length > HIERARCHICAL_COMPILATION_POLICY.limits.maxSources) {
      fail('HIERARCHICAL_WORKFLOW_SOURCE_DRIFT');
    }
    const planned = [...plan.sources].sort((left, right) =>
      left.sourceRef < right.sourceRef ? -1 : left.sourceRef > right.sourceRef ? 1 : 0);
    if (new Set(planned.map((source) => source.sourceRef)).size !== planned.length) {
      fail('HIERARCHICAL_WORKFLOW_SOURCE_DRIFT');
    }
    const sourceIds = new Map(planned.map((source) =>
      [source.sourceRef, stableSourceId(projectId, source.sourceRef)]));
    if (new Set(sourceIds.values()).size !== planned.length) {
      fail('HIERARCHICAL_WORKFLOW_SOURCE_DRIFT');
    }
    const sources = Object.freeze(planned.map((source) => Object.freeze({
      sourceId: sourceIds.get(source.sourceRef) as string,
      sourceRevision: source.revision,
      sourceRef: source.sourceRef,
      sanitizedContentDigest: source.sanitizedContentDigest,
    })));
    const hierarchySources = Object.freeze(planned.map((source) => Object.freeze({
      body: source.sanitizedBody,
      sourceId: sourceIds.get(source.sourceRef) as string,
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      sourceRevision: source.revision,
    })));
    const textUnits = createSubstantiveHierarchyTextUnits(hierarchySources, projectId);
    const snapshot = createCorpusSnapshot({
      compilerContractDigest: plan.contractDigest,
      interpretationRulesDigest: INTERPRETATION_RULES_DIGEST,
      policyDigest: HIERARCHICAL_COMPILATION_POLICY.policyDigest,
      profileDigest: plan.profileDigest,
      projectId,
      purposeDigest: purpose.purposeDigest,
      sanitizerPolicyDigest: policy.digest,
      sourceManifestDigest: plan.sourceManifestDigest,
      sources,
      textUnits,
    });
    const graph = buildSparseRelationGraph(snapshot, projectId);
    const interpretations = Object.freeze(snapshot.sources.map((source) =>
      createDocumentInterpretation({
        authority: 'supporting',
        basis: Object.freeze(['workflow-default']),
        confidenceBasisPoints: 10_000,
        lifecycle: 'current',
        projectId,
        reasonCodes: Object.freeze(['workflow-default']),
        relations: Object.freeze([]),
        role: 'topic',
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        synthesisEligibility: 'eligible',
      })));
    const outline = createWikiOutline(purpose, snapshot, graph, interpretations, projectId);
    let continuation = startCompileContinuation(
      graph,
      HIERARCHICAL_COMPILATION_POLICY.limits.maxPartitionTasks,
      projectId,
    );
    const partitions: CompilePartitionV2[] = [];
    while (!continuation.complete) {
      if (continuation.nextCursor === null) fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      const advanced = advanceCompileContinuation(
        graph,
        continuation,
        continuation.nextCursor,
        projectId,
      );
      partitions.push(advanced.partition);
      continuation = advanced.continuation;
    }
    const planningInventory = finalizePlanningDispositionInventory(
      graph,
      continuation,
      partitions,
      projectId,
    );
    const security = createProjectSecurityService({ knowledgeRoot });
    const evidenceSources: SanitizedEvidenceSourceV1[] = [];
    for (const source of planned) {
      const prepared = await security.prepareSource({
        body: source.sanitizedBody,
        bodyDigest: hierarchySha256(source.sanitizedBody),
        projectId,
        source: source.sourceRef,
        sourceKind: source.sourceKind,
        sourceRevisionOrContentSha256: source.revision,
      });
      if (!prepared.ok || prepared.report.outputDigest !== source.sanitizedContentDigest ||
          prepared.report.policyDigest !== policy.digest) {
        fail('HIERARCHICAL_WORKFLOW_SOURCE_DRIFT');
      }
      evidenceSources.push(Object.freeze({
        sourceId: sourceIds.get(source.sourceRef) as string,
        sourceRevision: source.revision,
        sourceRef: source.sourceRef,
        preparedSource: prepared.prepared,
      }));
    }
    const evidencePacks = Object.freeze(outline.blueprints.map((blueprint) => {
      const selectedUnitIds = selectRelevantHierarchyEvidenceUnitIds(
        blueprint,
        snapshot,
        hierarchySources,
        projectId,
      );
      return createEvidencePack({
        blueprint,
        conflicts: Object.freeze([]),
        gaps: Object.freeze([]),
        selectedUnitIds: Object.freeze(selectedUnitIds),
        snapshot,
        sources: Object.freeze(evidenceSources),
      }, projectId);
    }));
    return Object.freeze({
      plan,
      snapshot,
      graph,
      outline,
      partitions: Object.freeze(partitions),
      planningInventory,
      evidencePacks,
    });
  } catch (error) {
    if (error instanceof HierarchicalWorkflowError ||
        error instanceof HierarchicalWorkflowEvidenceInsufficientError) throw error;
    return fail('HIERARCHICAL_WORKFLOW_SOURCE_DRIFT');
  }
}

function childReviewView(
  generation: ReplayGenerationV1,
  projectId: string,
  currentRunId: string,
): HierarchicalWorkflowChildReviewViewV1 {
  const basis = Object.freeze({
    schemaVersion: HIERARCHICAL_WORKFLOW_CHILD_REVIEW_VIEW_SCHEMA_VERSION,
    projectId,
    runId: currentRunId,
    pageId: generation.blueprint.pageId,
    exchange: generation.exchange,
    result: generation.result,
    allowedDecisions: Object.freeze(['accepted', 'rejected'] as const),
  });
  return Object.freeze({ ...basis, reviewViewDigest: canonicalDigest(basis) });
}

function reviewView(
  surface: IntegratedWikiReviewSurfaceV1,
  graph: SparseRelationGraphV1,
  projectId: string,
  currentRunId: string,
): HierarchicalWorkflowReviewViewV1 {
  const basis = Object.freeze({
    schemaVersion: HIERARCHICAL_WORKFLOW_REVIEW_VIEW_SCHEMA_VERSION,
    projectId,
    runId: currentRunId,
    surface,
    relationCandidates: graph.relations,
  });
  return Object.freeze({ ...basis, reviewDigest: canonicalDigest(basis) });
}

function replayBase(
  live: LiveHierarchyV1,
  generations: readonly ReplayGenerationV1[],
  childReviews: readonly CompileCandidateReviewV1[],
  generationService: CurrentSessionGenerationService,
): ReplayBaseV1 {
  return Object.freeze({
    ...live,
    generations: Object.freeze([...generations]),
    childReviews: Object.freeze([...childReviews]),
    generationService,
  });
}

const MAXIMUM_PAGE_RESUBMISSIONS = 3;

function pageQualityEvaluation(
  generation: ReplayGenerationV1,
  projectId: string,
): Readonly<{
  readonly outcome: HierarchicalWorkflowStoredResubmissionV2['outcome'];
  readonly failure: Readonly<{
    readonly report: PageQualityReportV1;
    readonly rejection: HierarchicalWorkflowRejectionV1;
  }> | null;
}> {
  const report = evaluatePageSemanticQuality({
    blueprint: generation.blueprint,
    proposal: generation.result.proposal,
    evidencePack: generation.exchange.evidencePack,
  }, projectId);
  return Object.freeze({
    outcome: Object.freeze({
      kind: report.hardQualityPassed ? 'accepted' as const : 'hard-quality-failed' as const,
      pageQualityReportDigest: report.reportDigest,
      reasonCodes: report.reasonCodes,
    }),
    failure: report.hardQualityPassed
      ? null
      : Object.freeze({
          report,
          rejection: Object.freeze({
            kind: 'hard-quality-failed' as const,
            reasonCodes: Object.freeze([...new Set([
              'hard-quality-failed',
              ...report.reasonCodes,
            ])].sort()),
            reviewDigest: report.reportDigest,
            surfaceDigest: null,
          }),
        }),
  });
}

function assertStartDigests(record: HierarchicalWorkflowRunRecordV1, live: LiveHierarchyV1): void {
  if (record.startDigests.planDigest !== live.plan.planDigest ||
      record.startDigests.snapshotDigest !== live.snapshot.snapshotDigest ||
      record.startDigests.graphDigest !== live.graph.graphDigest ||
      record.startDigests.outlineDigest !== live.outline.outlineDigest ||
      record.startDigests.planningInventoryDigest !== live.planningInventory.inventoryDigest ||
      record.startDigests.sanitizerPolicyDigest !== live.snapshot.sanitizerPolicyDigest ||
      record.startDigests.baselineGenerationDigest !== record.baselineState?.generationDigest &&
        !(record.startDigests.baselineGenerationDigest === null && record.baselineState === null)) {
    fail('HIERARCHICAL_WORKFLOW_SOURCE_DRIFT');
  }
}

function assertPendingState(
  record: HierarchicalWorkflowRunRecordV1,
  expected: Readonly<{
    readonly phase: HierarchicalWorkflowPhaseV1;
    readonly exchange: HierarchySha256Digest | null;
    readonly child: HierarchySha256Digest | null;
    readonly review: HierarchySha256Digest | null;
    readonly ledger: HierarchySha256Digest | null;
  }>,
): void {
  if (record.phase !== expected.phase || record.pendingExchangeDigest !== expected.exchange ||
      record.pendingChildReviewDigest !== expected.child ||
      record.pendingReviewDigest !== expected.review ||
      record.pendingLedgerDigest !== expected.ledger) {
    fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
  }
}

async function readCurrentAuthority(
  corpusStore: ApprovedWikiProjectionStorePort,
  projectId: string,
): Promise<ApprovedWikiAuthorityV1 | null> {
  const status = await corpusStore.status(projectId);
  if (status.state === 'none') return null;
  if (status.state !== 'ready') fail('HIERARCHICAL_WORKFLOW_BASELINE_DRIFT');
  try {
    return await corpusStore.readAuthority(projectId);
  } catch (error) {
    if (error instanceof ApprovedWikiProjectionError) {
      return fail('HIERARCHICAL_WORKFLOW_BASELINE_DRIFT');
    }
    return fail('HIERARCHICAL_WORKFLOW_BASELINE_DRIFT');
  }
}

function assertBaseline(
  actual: ApprovedWikiAuthorityV1 | null,
  record: HierarchicalWorkflowRunRecordV1,
): void {
  const actualDigest = actual === null ? null : canonicalDigest(actual);
  const actualProposals = actual === null
    ? Object.freeze([])
    : Object.freeze([...actual.finalization.proposals].sort((left, right) =>
      left.pageId < right.pageId ? -1 : left.pageId > right.pageId ? 1 : 0));
  if (actualDigest !== record.baselineAuthorityDigest ||
      !sameValue(actual?.state ?? null, record.baselineState) ||
      !sameValue(actualProposals, record.baselineProposals)) {
    fail('HIERARCHICAL_WORKFLOW_BASELINE_DRIFT');
  }
}

function buildIntegratedReview(
  record: HierarchicalWorkflowRunRecordV1,
  base: ReplayBaseV1,
): Readonly<{
  readonly reconciliation: WikiLinkReconciliationV1;
  readonly surface: IntegratedWikiReviewSurfaceV1;
  readonly view: HierarchicalWorkflowReviewViewV1;
}> {
  const proposals = Object.freeze(base.generations.map((generation) => generation.result.proposal));
  const reconciliation = reconcileWikiProposalLinks(
    base.outline,
    proposals,
    record.projectId,
  );
  const handoffs: readonly CurrentSessionGenerationHandoffV1[] = Object.freeze(
    base.generations.map((generation) => Object.freeze({
      exchange: generation.exchange,
      result: generation.result,
    })),
  );
  const surface = createIntegratedWikiReviewSurface({
    baselineGenerationDigest: record.startDigests.baselineGenerationDigest,
    baselineProposals: record.baselineProposals,
    generations: handoffs,
    graph: base.graph,
    outline: base.outline,
    planningInventory: base.planningInventory,
    reconciliation,
  }, record.projectId);
  return Object.freeze({
    reconciliation,
    surface,
    view: reviewView(surface, base.graph, record.projectId, record.runId),
  });
}

function buildFinalization(
  record: HierarchicalWorkflowRunRecordV1,
  base: ReplayBaseV1,
  integrated: ReturnType<typeof buildIntegratedReview>,
): Readonly<{
  readonly finalization: FinalizeCompileRunInputV1;
  readonly ledger: CompileRunLedgerV1;
}> {
  const candidateIds = integrated.surface.candidates.map((candidate) => candidate.pageId).sort();
  const storedCandidateIds = record.integratedDecisions.map((decision) => decision.pageId);
  const relationIds = base.graph.relations.map((relation) => relation.relationId).sort();
  const storedRelationIds = record.relationDecisions.map((decision) => decision.relationId);
  if (!sameValue(candidateIds, storedCandidateIds) || !sameValue(relationIds, storedRelationIds)) {
    fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
  }
  const integratedReviews = Object.freeze(record.integratedDecisions.map((decision) => {
    const review = createIntegratedWikiCandidateReview(
      integrated.surface,
      decision.pageId,
      decision.decision,
      decision.reasonCodes,
      record.projectId,
    );
    if (review.reviewDigest !== decision.reviewDigest) {
      fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
    }
    return review;
  }));
  const relationReviews = Object.freeze(record.relationDecisions.map((decision) => {
    const review = createCompileRelationReview(
      decision.relationId,
      decision.decision,
      record.projectId,
    );
    if (review.reviewDigest !== decision.reviewDigest) {
      fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
    }
    return review;
  }));
  const proposals = Object.freeze(base.generations.map((generation) => generation.result.proposal));
  const evidencePacks = Object.freeze(base.generations.map((generation) =>
    generation.exchange.evidencePack));
  const generationHandoffs = Object.freeze(base.generations.map((generation) => Object.freeze({
    exchange: generation.exchange,
    result: generation.result,
  })));
  const qualityPages = Object.freeze(integrated.surface.candidates.map((candidate) =>
    candidate.pageQualityReport));
  const integrityInput = Object.freeze({
    baselineGenerationDigest: record.startDigests.baselineGenerationDigest,
    baselineProposals: record.baselineProposals,
    childSynthesisReviews: base.childReviews,
    corpusQualityReport: integrated.surface.corpusQualityReport,
    evidencePacks,
    generationHandoffs,
    graph: base.graph,
    integratedReviews,
    integratedReviewSurface: integrated.surface,
    outline: base.outline,
    pageQualityReports: qualityPages,
    partitions: base.partitions,
    planningInventory: base.planningInventory,
    proposals,
    reconciliation: integrated.reconciliation,
    relationReviews,
  });
  const finalization = Object.freeze({
    ...integrityInput,
    integrityReport: createCompileIntegrityReport(integrityInput, record.projectId),
  });
  return Object.freeze({
    finalization,
    ledger: finalizeCompileRun(finalization, record.projectId),
  });
}

async function replayRun(
  record: HierarchicalWorkflowRunRecordV1,
  dependencies: Readonly<{
    readonly compiler: Pick<ProjectSessionCompilerPort, 'plan'>;
    readonly corpusStore: ApprovedWikiProjectionStorePort;
    readonly createGenerationService: () => CurrentSessionGenerationService;
    readonly knowledgeRoot: string;
  }>,
): Promise<ReplayStateV1> {
  await assertSafePurpose(record.purpose, dependencies.knowledgeRoot, record.projectId);
  const actualAuthority = await readCurrentAuthority(dependencies.corpusStore, record.projectId);
  if (record.phase !== 'approved') assertBaseline(actualAuthority, record);
  const live = await buildLiveHierarchy(
    dependencies.compiler,
    dependencies.knowledgeRoot,
    record.purpose,
    record.projectId,
  );
  assertStartDigests(record, live);
  const generationService = dependencies.createGenerationService();
  const submissions = new Map(record.submissions.map((submission) =>
    [submission.generationOrder, submission]));
  const resubmissionsByOrder = new Map<number, HierarchicalWorkflowStoredResubmissionV2[]>();
  for (const resubmission of record.resubmissions) {
    const entries = resubmissionsByOrder.get(resubmission.generationOrder) ?? [];
    entries.push(resubmission);
    resubmissionsByOrder.set(resubmission.generationOrder, entries);
  }
  const childDecisionByPage = new Map(record.childDecisions.map((decision) =>
    [decision.pageId, decision]));
  const generations: ReplayGenerationV1[] = [];
  const childReviews: CompileCandidateReviewV1[] = [];
  const approvedChildSummaryByPage = new Map<string, ApprovedChildSummaryV1>();
  let consumedResubmissions = 0;
  for (const blueprint of live.outline.blueprints) {
    const stored = submissions.get(blueprint.generationOrder);
    const storedResubmissions = resubmissionsByOrder.get(blueprint.generationOrder) ?? [];
    const approvedChildSummaries = Object.freeze(blueprint.childPageIds.map((childPageId) => {
      const summary = approvedChildSummaryByPage.get(childPageId);
      if (summary === undefined) fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      return summary;
    }));
    const pack = live.evidencePacks[blueprint.generationOrder];
    if (pack === undefined || pack.pageId !== blueprint.pageId) {
      fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
    }
    let session = await generationService.prepare({
      approvedChildSummaries,
      blueprint,
      evidencePack: pack,
      generationAttempt: 0,
      purpose: record.purpose,
    }, record.projectId);
    if (stored === undefined) {
      if (record.submissions.length !== blueprint.generationOrder ||
          storedResubmissions.length !== 0 || record.resubmissions.length !== consumedResubmissions ||
          record.childDecisions.length !== childReviews.length ||
          record.integratedDecisions.length !== 0 || record.relationDecisions.length !== 0 ||
          record.rejection !== null || record.approvalDecision !== null) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      assertPendingState(record, {
        phase: 'awaiting-proposal',
        exchange: session.exchange.exchangeDigest,
        child: null,
        review: null,
        ledger: null,
      });
      return Object.freeze({
        kind: 'awaiting-proposal',
        base: replayBase(live, generations, childReviews, generationService),
        exchange: session.exchange,
        session,
      });
    }
    if (stored.pageId !== blueprint.pageId ||
        stored.expectedExchangeDigest !== session.exchange.exchangeDigest) {
      fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
    }
    const parsedSubmission = parseCurrentSessionProposalSubmission(stored.submission, {
      projectId: record.projectId,
      pageId: blueprint.pageId,
      exchangeDigest: session.exchange.exchangeDigest,
      requestDigest: session.exchange.requestDigest,
    });
    let result = await session.submit(parsedSubmission);
    if (result.proposal.proposalDigest !== stored.proposalDigest ||
        result.receipt.receiptDigest !== stored.receiptDigest) {
      fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
    }
    let generation = Object.freeze({ blueprint, exchange: session.exchange, result });
    let quality = pageQualityEvaluation(generation, record.projectId);
    let failure = quality.failure;
    let latestAttempt = 0;
    for (const storedResubmission of storedResubmissions) {
      if (failure === null || storedResubmission.attempt !== latestAttempt + 1 ||
          storedResubmission.pageId !== blueprint.pageId) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      latestAttempt = storedResubmission.attempt;
      consumedResubmissions += 1;
      session = await generationService.prepare({
        approvedChildSummaries,
        blueprint,
        evidencePack: pack,
        generationAttempt: latestAttempt,
        purpose: record.purpose,
      }, record.projectId);
      if (storedResubmission.expectedExchangeDigest !== session.exchange.exchangeDigest) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      const parsedResubmission = parseCurrentSessionProposalSubmission(
        storedResubmission.submission,
        {
          projectId: record.projectId,
          pageId: blueprint.pageId,
          exchangeDigest: session.exchange.exchangeDigest,
          requestDigest: session.exchange.requestDigest,
        },
      );
      result = await session.submit(parsedResubmission);
      if (result.proposal.proposalDigest !== storedResubmission.proposalDigest ||
          result.receipt.receiptDigest !== storedResubmission.receiptDigest) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      generation = Object.freeze({ blueprint, exchange: session.exchange, result });
      quality = pageQualityEvaluation(generation, record.projectId);
      if (!sameValue(storedResubmission.outcome, quality.outcome)) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      failure = quality.failure;
    }
    if (failure !== null) {
      if (record.submissions.length !== blueprint.generationOrder + 1 ||
          record.resubmissions.length !== consumedResubmissions ||
          record.childDecisions.length !== childReviews.length ||
          childDecisionByPage.has(blueprint.pageId) || record.integratedDecisions.length !== 0 ||
          record.relationDecisions.length !== 0 || record.approvalDecision !== null ||
          !sameValue(record.rejection, failure.rejection)) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      const retrySession = latestAttempt < MAXIMUM_PAGE_RESUBMISSIONS
        ? await generationService.prepare({
            approvedChildSummaries,
            blueprint,
            evidencePack: pack,
            generationAttempt: latestAttempt + 1,
            purpose: record.purpose,
          }, record.projectId)
        : null;
      assertPendingState(record, {
        phase: retrySession === null ? 'rejected' : 'hard-quality-failed',
        exchange: retrySession?.exchange.exchangeDigest ?? null,
        child: null,
        review: null,
        ledger: null,
      });
      const base = replayBase(
        live,
        [...generations, generation],
        childReviews,
        generationService,
      );
      if (retrySession === null) {
        return Object.freeze({
          kind: 'rejected', base, review: null, rejection: failure.rejection,
        });
      }
      return Object.freeze({
        kind: 'hard-quality-failed',
        base,
        exchange: retrySession.exchange,
        session: retrySession,
        pageQualityReport: failure.report,
        rejection: failure.rejection,
      });
    }
    generations.push(generation);
    if (blueprint.parentPageId !== null) {
      const view = childReviewView(generation, record.projectId, record.runId);
      const decision = childDecisionByPage.get(blueprint.pageId);
      if (decision === undefined) {
        if (record.submissions.length !== blueprint.generationOrder + 1 ||
            record.resubmissions.length !== consumedResubmissions ||
            record.childDecisions.length !== childReviews.length ||
            record.integratedDecisions.length !== 0 || record.relationDecisions.length !== 0 ||
            record.rejection !== null || record.approvalDecision !== null) {
          fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
        }
        assertPendingState(record, {
          phase: 'awaiting-child-review',
          exchange: null,
          child: view.reviewViewDigest,
          review: null,
          ledger: null,
        });
        return Object.freeze({
          kind: 'awaiting-child-review',
          base: replayBase(live, generations, childReviews, generationService),
          childReview: view,
        });
      }
      const review = createCompileCandidateReview(
        result.proposal,
        decision.decision,
        record.projectId,
      );
      if (decision.generationOrder !== blueprint.generationOrder ||
          decision.reviewViewDigest !== view.reviewViewDigest ||
          decision.reviewDigest !== review.reviewDigest) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      if (decision.decision === 'rejected') {
        const rejection = Object.freeze({
          kind: 'child-review-rejected' as const,
          reasonCodes: decision.reasonCodes,
          reviewDigest: review.reviewDigest,
          surfaceDigest: null,
        });
        if (!sameValue(record.rejection, rejection) || record.approvalDecision !== null ||
            record.integratedDecisions.length !== 0 || record.relationDecisions.length !== 0) {
          fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
        }
        assertPendingState(record, {
          phase: 'rejected', exchange: null, child: null, review: null, ledger: null,
        });
        return Object.freeze({
          kind: 'rejected',
          base: replayBase(live, generations, childReviews, generationService),
          review: null,
          rejection,
        });
      }
      childReviews.push(review);
      approvedChildSummaryByPage.set(
        blueprint.pageId,
        approveChildSummaryForSynthesis(result.proposal, review, record.projectId),
      );
    }
  }
  if (record.submissions.length !== live.outline.blueprints.length ||
      record.resubmissions.length !== consumedResubmissions ||
      record.childDecisions.length !== childReviews.length) {
    fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
  }
  const base = replayBase(live, generations, childReviews, generationService);
  const integrated = buildIntegratedReview(record, base);
  if (record.integratedDecisions.length === 0 && record.relationDecisions.length === 0) {
    if (record.rejection !== null || record.approvalDecision !== null) {
      fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
    }
    assertPendingState(record, {
      phase: 'review-ready',
      exchange: null,
      child: null,
      review: integrated.view.reviewDigest,
      ledger: null,
    });
    return Object.freeze({ kind: 'review-ready', base, review: integrated.view });
  }
  if (!integrated.surface.hardQualityPassed) {
    const rejection = Object.freeze({
      kind: 'hard-quality-failed' as const,
      reasonCodes: Object.freeze([...new Set([
        'hard-quality-failed',
        ...integrated.surface.reasonCodes,
      ])].sort()),
      reviewDigest: integrated.view.reviewDigest,
      surfaceDigest: integrated.surface.surfaceDigest,
    });
    if (!sameValue(record.rejection, rejection) || record.approvalDecision !== null) {
      fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
    }
    assertPendingState(record, {
      phase: 'rejected', exchange: null, child: null, review: null, ledger: null,
    });
    return Object.freeze({
      kind: 'rejected', base, review: integrated.view, rejection,
    });
  }
  if (record.rejection !== null) fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
  const finalized = buildFinalization(record, base, integrated);
  if (record.phase === 'finalized') {
    if (record.approvalDecision !== null) fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
    assertPendingState(record, {
      phase: 'finalized', exchange: null, child: null, review: null,
      ledger: finalized.ledger.ledgerDigest,
    });
    return Object.freeze({
      kind: 'finalized', base, review: integrated.view, surface: integrated.surface,
      finalization: finalized.finalization, ledger: finalized.ledger,
    });
  }
  if (record.phase !== 'approved' || record.approvalDecision === null ||
      !finalized.ledger.eligibleForApproval) {
    fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
  }
  const ownershipGraph = createPageOwnershipGraph(
    base.snapshot,
    base.outline,
    finalized.ledger,
    finalized.finalization.proposals,
    finalized.finalization.evidencePacks,
    record.projectId,
  );
  const humanActivationApproval = createHumanActivationApproval({
    currentState: record.baselineState,
    decision: 'approved',
    explicitConfirmation: true,
    ledger: finalized.ledger,
    ownershipGraph,
  }, record.projectId);
  const state = verifyCompileRunApproval({
    currentState: record.baselineState,
    finalization: finalized.finalization,
    humanActivationApproval,
    ledger: finalized.ledger,
    liveSnapshot: base.snapshot,
    ownershipGraph,
  }, record.projectId);
  const authorityCheck = checkAuthoritativeWikiState(
    state,
    ownershipGraph,
    base.snapshot,
    humanActivationApproval,
    record.projectId,
  );
  const authority: ApprovedWikiAuthorityV1 = Object.freeze({
    authorityCheck,
    currentState: record.baselineState,
    finalization: finalized.finalization,
    humanActivationApproval,
    ledger: finalized.ledger,
    liveSnapshot: base.snapshot,
    ownershipGraph,
    projectId: record.projectId,
    schemaVersion: APPROVED_WIKI_AUTHORITY_SCHEMA_VERSION,
    state,
  });
  const activationBundle = Object.freeze({
    authority,
    projectId: record.projectId,
    schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
  });
  if (record.approvalDecision.approvalDigest !== humanActivationApproval.approvalDigest ||
      record.approvalDecision.activationBundleDigest !== canonicalDigest(activationBundle)) {
    fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
  }
  assertPendingState(record, {
    phase: 'approved', exchange: null, child: null, review: null,
    ledger: finalized.ledger.ledgerDigest,
  });
  if (actualAuthority !== null && sameValue(actualAuthority, authority)) {
    // Activated state is permitted only after the approved local bundle was issued.
  } else {
    assertBaseline(actualAuthority, record);
  }
  return Object.freeze({
    kind: 'approved', base, review: integrated.view, surface: integrated.surface,
    finalization: finalized.finalization, ledger: finalized.ledger, ownershipGraph, authority,
  });
}

function recordWith(
  record: HierarchicalWorkflowRunRecordV1,
  patch: Partial<Omit<HierarchicalWorkflowRunRecordV1,
    'projectId' | 'recordDigest' | 'revision' | 'runId' | 'schemaVersion'>>,
): HierarchicalWorkflowRunRecordV1 {
  const { recordDigest: _recordDigest, schemaVersion: _schemaVersion, ...basis } = record;
  void _recordDigest;
  void _schemaVersion;
  return createHierarchicalWorkflowRunRecord({
    ...basis,
    ...patch,
    revision: record.revision + 1,
  });
}

function summariesForBlueprint(
  blueprint: PageBlueprintV1,
  generations: readonly ReplayGenerationV1[],
  childReviews: readonly CompileCandidateReviewV1[],
  projectId: string,
): readonly ApprovedChildSummaryV1[] {
  const generationByPage = new Map(generations.map((generation) =>
    [generation.blueprint.pageId, generation]));
  const reviewByPage = new Map(childReviews.map((review) => [review.pageId, review]));
  return Object.freeze(blueprint.childPageIds.map((pageId) => {
    const generation = generationByPage.get(pageId);
    const review = reviewByPage.get(pageId);
    if (generation === undefined || review === undefined) {
      fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
    }
    return approveChildSummaryForSynthesis(generation.result.proposal, review, projectId);
  }));
}

async function statusFromReplay(
  record: HierarchicalWorkflowRunRecordV1,
  replay: ReplayStateV1,
  corpusStore: ApprovedWikiProjectionStorePort,
  runStore: HierarchicalWorkflowRunStorePort,
): Promise<HierarchicalWorkflowStatusV1> {
  let activationState: HierarchicalWorkflowStatusV1['activationState'] = 'not-approved';
  let authorityCheck: ApprovedWikiAuthorityV1['authorityCheck'] | null = null;
  if (replay.kind === 'approved') {
    const current = await readCurrentAuthority(corpusStore, record.projectId);
    if (current !== null && sameValue(current, replay.authority)) {
      if (current.authorityCheck.status !== 'clean') {
        fail('HIERARCHICAL_WORKFLOW_BASELINE_DRIFT');
      }
      activationState = 'active';
      authorityCheck = current.authorityCheck;
    } else {
      assertBaseline(current, record);
      activationState = await runStore.activationBundleState(record) === 'verified'
        ? 'awaiting-activation'
        : 'not-approved';
    }
  }
  const currentExchange = replay.kind === 'awaiting-proposal'
    ? replay.exchange
    : replay.kind === 'hard-quality-failed'
      ? replay.exchange
      : null;
  const childReview = replay.kind === 'awaiting-child-review' ? replay.childReview : null;
  const review = replay.kind === 'review-ready' || replay.kind === 'finalized' ||
      replay.kind === 'approved'
    ? replay.review
    : replay.kind === 'rejected'
      ? replay.review
      : null;
  const ledger = replay.kind === 'finalized' || replay.kind === 'approved'
    ? replay.ledger
    : null;
  const rejection = replay.kind === 'rejected' || replay.kind === 'hard-quality-failed'
    ? replay.rejection
    : null;
  const nextAction: HierarchicalWorkflowNextActionV1 = replay.kind === 'awaiting-proposal'
    ? 'submit-proposal'
    : replay.kind === 'hard-quality-failed' && replay.exchange !== null
      ? 'resubmit-proposal'
    : replay.kind === 'awaiting-child-review'
      ? 'review-child'
      : replay.kind === 'review-ready'
        ? 'review-integrated-wiki'
        : (replay.kind === 'finalized' && replay.ledger.eligibleForApproval) ||
            (replay.kind === 'approved' && activationState === 'not-approved')
          ? 'approve-activation'
          : replay.kind === 'approved' && activationState === 'awaiting-activation'
            ? 'activate-approved-wiki'
            : 'none';
  return Object.freeze({
    schemaVersion: HIERARCHICAL_WORKFLOW_STATUS_SCHEMA_VERSION,
    projectId: record.projectId,
    runId: record.runId,
    revision: record.revision,
    phase: record.phase,
    purpose: record.purpose,
    nextAction,
    currentExchange,
    childReview,
    review,
    ledger,
    rejection,
    activationState,
    authorityCheckStatus: authorityCheck === null ? null : 'clean',
    authorityCheck,
    egress: 'none',
    providerUsed: null,
    processSpawned: false,
  });
}

async function readJsonInput(
  hubRoot: string,
  inputFile: string,
  maximumBytes: number,
  projectId: string,
): Promise<unknown> {
  if (typeof inputFile !== 'string' || inputFile.length < 1 || inputFile.length > 4_096) {
    fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
  if (isAbsolute(inputFile) || inputFile.includes('\\') ||
      inputFile.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
  try {
    return parseJsonStrict(await readConfinedSessionUtf8(
      resolve(hubRoot, inputFile),
      hubRoot,
      maximumBytes,
      projectId,
    ));
  } catch {
    return fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
}

function parseSubmissionPreflight(
  value: unknown,
  expectedProjectId: string,
): CurrentSessionProposalSubmissionV1 {
  if (!isRecord(value) || typeof value.pageId !== 'string' ||
      typeof value.exchangeDigest !== 'string' || typeof value.requestDigest !== 'string') {
    fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
  try {
    return parseCurrentSessionProposalSubmission(value, {
      projectId: expectedProjectId,
      pageId: value.pageId,
      exchangeDigest: digest(value.exchangeDigest),
      requestDigest: digest(value.requestDigest),
    });
  } catch {
    return fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
  }
}

function currentRunId(bytesFactory: () => Uint8Array): string {
  const bytes = bytesFactory();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    fail('HIERARCHICAL_WORKFLOW_RUN_ID_EXHAUSTED');
  }
  return `run-${Buffer.from(bytes).toString('hex')}`;
}

function authorityFromFinalized(
  record: HierarchicalWorkflowRunRecordV1,
  replay: Extract<ReplayStateV1, { readonly kind: 'finalized' }>,
): Readonly<{
  readonly activationBundle: Readonly<{
    readonly authority: ApprovedWikiAuthorityV1;
    readonly projectId: string;
    readonly schemaVersion: typeof HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION;
  }>;
  readonly authority: ApprovedWikiAuthorityV1;
  readonly approvalDecision: HierarchicalWorkflowApprovalDecisionV1;
}> {
  const ownershipGraph = createPageOwnershipGraph(
    replay.base.snapshot,
    replay.base.outline,
    replay.ledger,
    replay.finalization.proposals,
    replay.finalization.evidencePacks,
    record.projectId,
  );
  const humanActivationApproval = createHumanActivationApproval({
    currentState: record.baselineState,
    decision: 'approved',
    explicitConfirmation: true,
    ledger: replay.ledger,
    ownershipGraph,
  }, record.projectId);
  const state = verifyCompileRunApproval({
    currentState: record.baselineState,
    finalization: replay.finalization,
    humanActivationApproval,
    ledger: replay.ledger,
    liveSnapshot: replay.base.snapshot,
    ownershipGraph,
  }, record.projectId);
  const authorityCheck = checkAuthoritativeWikiState(
    state,
    ownershipGraph,
    replay.base.snapshot,
    humanActivationApproval,
    record.projectId,
  );
  if (authorityCheck.status !== 'clean') fail('HIERARCHICAL_WORKFLOW_INELIGIBLE');
  const authority: ApprovedWikiAuthorityV1 = Object.freeze({
    authorityCheck,
    currentState: record.baselineState,
    finalization: replay.finalization,
    humanActivationApproval,
    ledger: replay.ledger,
    liveSnapshot: replay.base.snapshot,
    ownershipGraph,
    projectId: record.projectId,
    schemaVersion: APPROVED_WIKI_AUTHORITY_SCHEMA_VERSION,
    state,
  });
  const activationBundle = Object.freeze({
    authority,
    projectId: record.projectId,
    schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
  });
  return Object.freeze({
    activationBundle,
    authority,
    approvalDecision: Object.freeze({
      activationBundleDigest: canonicalDigest(activationBundle),
      approvalDigest: humanActivationApproval.approvalDigest,
      explicitConfirmation: true,
    }),
  });
}

export function createHierarchicalWorkflowService(
  options: CreateHierarchicalWorkflowServiceOptions,
): HierarchicalWorkflowServicePort {
  const hubRoot = resolve(options.hubRoot);
  const knowledgeRoot = resolve(options.knowledgeRoot);
  const compiler = options.compiler ?? createProjectSessionCompiler({ hubRoot, knowledgeRoot });
  const corpusStore = options.corpusStore ?? createApprovedWikiProjectionStore(knowledgeRoot);
  const runStore = options.runStore ?? createHierarchicalWorkflowRunStore(hubRoot);
  const createGenerationService = options.createGenerationService ?? (() =>
    createCurrentSessionGenerationService({ knowledgeRoot }));
  const createRunIdBytes = options.createRunIdBytes ?? (() => randomBytes(32));
  const dependencies = Object.freeze({
    compiler,
    corpusStore,
    createGenerationService,
    knowledgeRoot,
  });

  const service: HierarchicalWorkflowServicePort = {
    async start(projectIdValue, purposeFile) {
      const projectId = project(projectIdValue);
      const inputPurpose = createPurpose(
        await readJsonInput(hubRoot, purposeFile, MAXIMUM_PURPOSE_BYTES, projectId),
        projectId,
      );
      const purpose = inputPurpose.wikiTitle === undefined
        ? createCompilationPurpose({
            audience: inputPurpose.audience,
            excludedTopics: inputPurpose.excludedTopics,
            goals: inputPurpose.goals,
            keyQuestions: inputPurpose.keyQuestions,
            outputLanguage: inputPurpose.outputLanguage,
            projectId,
            requestedPageRoles: inputPurpose.requestedPageRoles,
            scopeHints: inputPurpose.scopeHints,
            wikiTitle: (await showProject(knowledgeRoot, projectId)).entry.displayName,
          })
        : inputPurpose;
      await assertSafePurpose(purpose, knowledgeRoot, projectId);
      const baselineAuthority = await readCurrentAuthority(corpusStore, projectId);
      const baselineState = baselineAuthority?.state ?? null;
      const baselineProposals = Object.freeze(baselineAuthority === null
        ? []
        : [...baselineAuthority.finalization.proposals].sort((left, right) =>
          left.pageId < right.pageId ? -1 : left.pageId > right.pageId ? 1 : 0));
      const live = await buildLiveHierarchy(compiler, knowledgeRoot, purpose, projectId);
      const firstBlueprint = live.outline.blueprints[0];
      const firstPack = live.evidencePacks[0];
      if (firstBlueprint === undefined || firstPack === undefined) {
        fail('HIERARCHICAL_WORKFLOW_SOURCE_DRIFT');
      }
      const generationService = createGenerationService();
      const session = await generationService.prepare({
        approvedChildSummaries: Object.freeze([]),
        blueprint: firstBlueprint,
        evidencePack: firstPack,
        generationAttempt: 0,
        purpose,
      }, projectId);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const allocatedRunId = currentRunId(createRunIdBytes);
        const record = createHierarchicalWorkflowRunRecord({
          projectId,
          runId: allocatedRunId,
          revision: 0,
          phase: 'awaiting-proposal',
          purpose,
          baselineAuthorityDigest: baselineAuthority === null
            ? null
            : canonicalDigest(baselineAuthority),
          baselineState,
          baselineProposals,
          startDigests: Object.freeze({
            baselineGenerationDigest: baselineState?.generationDigest ?? null,
            graphDigest: live.graph.graphDigest,
            outlineDigest: live.outline.outlineDigest,
            planDigest: live.plan.planDigest,
            planningInventoryDigest: live.planningInventory.inventoryDigest,
            sanitizerPolicyDigest: live.snapshot.sanitizerPolicyDigest,
            snapshotDigest: live.snapshot.snapshotDigest,
          }),
          submissions: Object.freeze([]),
          resubmissions: Object.freeze([]),
          childDecisions: Object.freeze([]),
          integratedDecisions: Object.freeze([]),
          relationDecisions: Object.freeze([]),
          rejection: null,
          approvalDecision: null,
          pendingExchangeDigest: session.exchange.exchangeDigest,
          pendingChildReviewDigest: null,
          pendingReviewDigest: null,
          pendingLedgerDigest: null,
        });
        try {
          await runStore.create(record);
          const replay: ReplayStateV1 = Object.freeze({
            kind: 'awaiting-proposal',
            base: replayBase(live, [], [], generationService),
            exchange: session.exchange,
            session,
          });
          const status = await statusFromReplay(record, replay, corpusStore, runStore);
          return Object.freeze({
            schemaVersion: HIERARCHICAL_WORKFLOW_START_RESULT_SCHEMA_VERSION,
            projectId,
            runId: allocatedRunId,
            purpose,
            status,
          });
        } catch (error) {
          if (error instanceof HierarchicalWorkflowRunStoreError &&
              error.code === 'HIERARCHICAL_WORKFLOW_RUN_CONFLICT') continue;
          throw error;
        }
      }
      return fail('HIERARCHICAL_WORKFLOW_RUN_ID_EXHAUSTED');
    },

    async status(projectIdValue, runIdValue) {
      const projectId = project(projectIdValue);
      const currentRunIdValue = runId(runIdValue);
      const record = await runStore.read(projectId, currentRunIdValue);
      const replay = await replayRun(record, dependencies);
      return statusFromReplay(record, replay, corpusStore, runStore);
    },

    async submit(projectIdValue, runIdValue, inputFile, expectExchangeValue) {
      const projectId = project(projectIdValue);
      const currentRunIdValue = runId(runIdValue);
      const expectExchange = digest(expectExchangeValue);
      const record = await runStore.read(projectId, currentRunIdValue);
      if (record.phase !== 'awaiting-proposal') fail('HIERARCHICAL_WORKFLOW_PHASE_MISMATCH');
      if (record.pendingExchangeDigest !== expectExchange) {
        fail('HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH');
      }
      const input = parseSubmissionPreflight(
        await readJsonInput(hubRoot, inputFile, MAXIMUM_INPUT_BYTES, projectId),
        projectId,
      );
      if (input.exchangeDigest !== expectExchange) {
        fail('HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH');
      }
      const replay = await replayRun(record, dependencies);
      if (replay.kind !== 'awaiting-proposal' ||
          replay.exchange.exchangeDigest !== expectExchange) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      const parsed = parseCurrentSessionProposalSubmission(input, {
        projectId,
        pageId: replay.exchange.pageId,
        exchangeDigest: replay.exchange.exchangeDigest,
        requestDigest: replay.exchange.requestDigest,
      });
      const result = await replay.session.submit(parsed);
      const blueprint = replay.base.outline.blueprints[record.submissions.length];
      if (blueprint === undefined || blueprint.pageId !== result.proposal.pageId) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      const storedSubmission: HierarchicalWorkflowStoredSubmissionV1 = Object.freeze({
        expectedExchangeDigest: expectExchange,
        generationOrder: blueprint.generationOrder,
        pageId: blueprint.pageId,
        proposalDigest: result.proposal.proposalDigest,
        receiptDigest: result.receipt.receiptDigest,
        submission: parsed,
      });
      const generation: ReplayGenerationV1 = Object.freeze({
        blueprint,
        exchange: replay.exchange,
        result,
      });
      const generations = Object.freeze([...replay.base.generations, generation]);
      let nextRecord: HierarchicalWorkflowRunRecordV1;
      let nextReplay: ReplayStateV1;
      const failure = pageQualityEvaluation(generation, projectId).failure;
      if (failure !== null) {
        const retrySession = await replay.base.generationService.prepare({
          approvedChildSummaries: summariesForBlueprint(
            blueprint,
            replay.base.generations,
            replay.base.childReviews,
            projectId,
          ),
          blueprint,
          evidencePack: replay.exchange.evidencePack,
          generationAttempt: 1,
          purpose: record.purpose,
        }, projectId);
        const base = replayBase(
          replay.base,
          generations,
          replay.base.childReviews,
          replay.base.generationService,
        );
        nextRecord = recordWith(record, {
          submissions: Object.freeze([...record.submissions, storedSubmission]),
          phase: 'hard-quality-failed',
          rejection: failure.rejection,
          pendingExchangeDigest: retrySession.exchange.exchangeDigest,
          pendingChildReviewDigest: null,
          pendingReviewDigest: null,
          pendingLedgerDigest: null,
        });
        nextReplay = Object.freeze({
          kind: 'hard-quality-failed',
          base,
          exchange: retrySession.exchange,
          session: retrySession,
          pageQualityReport: failure.report,
          rejection: failure.rejection,
        });
      } else if (blueprint.parentPageId !== null) {
        const view = childReviewView(generation, projectId, currentRunIdValue);
        nextRecord = recordWith(record, {
          submissions: Object.freeze([...record.submissions, storedSubmission]),
          phase: 'awaiting-child-review',
          pendingExchangeDigest: null,
          pendingChildReviewDigest: view.reviewViewDigest,
          pendingReviewDigest: null,
          pendingLedgerDigest: null,
        });
        nextReplay = Object.freeze({
          kind: 'awaiting-child-review',
          base: replayBase(
            replay.base,
            generations,
            replay.base.childReviews,
            replay.base.generationService,
          ),
          childReview: view,
        });
      } else {
        const base = replayBase(
          replay.base,
          generations,
          replay.base.childReviews,
          replay.base.generationService,
        );
        const integrated = buildIntegratedReview(record, base);
        nextRecord = recordWith(record, {
          submissions: Object.freeze([...record.submissions, storedSubmission]),
          phase: 'review-ready',
          pendingExchangeDigest: null,
          pendingChildReviewDigest: null,
          pendingReviewDigest: integrated.view.reviewDigest,
          pendingLedgerDigest: null,
        });
        nextReplay = Object.freeze({ kind: 'review-ready', base, review: integrated.view });
      }
      await runStore.replace({
        expectedRecordDigest: record.recordDigest,
        expectedRevision: record.revision,
        next: nextRecord,
        projectId,
        runId: currentRunIdValue,
      });
      const status = await statusFromReplay(nextRecord, nextReplay, corpusStore, runStore);
      return Object.freeze({
        schemaVersion: HIERARCHICAL_WORKFLOW_SUBMIT_RESULT_SCHEMA_VERSION,
        projectId,
        runId: currentRunIdValue,
        pageId: blueprint.pageId,
        proposalDigest: result.proposal.proposalDigest,
        receiptDigest: result.receipt.receiptDigest,
        status,
      });
    },

    async resubmit(
      projectIdValue,
      runIdValue,
      pageIdValue,
      inputFile,
      expectExchangeValue,
    ) {
      const projectId = project(projectIdValue);
      const currentRunIdValue = runId(runIdValue);
      const expectExchange = digest(expectExchangeValue);
      if (!PAGE_ID_PATTERN.test(pageIdValue)) fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
      const record = await runStore.read(projectId, currentRunIdValue);
      if (record.phase !== 'hard-quality-failed') {
        fail('HIERARCHICAL_WORKFLOW_PHASE_MISMATCH');
      }
      if (record.pendingExchangeDigest !== expectExchange) {
        fail('HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH');
      }
      const input = parseSubmissionPreflight(
        await readJsonInput(hubRoot, inputFile, MAXIMUM_INPUT_BYTES, projectId),
        projectId,
      );
      if (input.pageId !== pageIdValue || input.exchangeDigest !== expectExchange) {
        fail('HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH');
      }
      const replay = await replayRun(record, dependencies);
      if (replay.kind !== 'hard-quality-failed' || replay.exchange === null ||
          replay.session === null || replay.exchange.pageId !== pageIdValue ||
          replay.exchange.exchangeDigest !== expectExchange) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      const attempt = replay.exchange.request.generationAttempt;
      if (attempt < 1 || attempt > MAXIMUM_PAGE_RESUBMISSIONS) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      const parsed = parseCurrentSessionProposalSubmission(input, {
        projectId,
        pageId: pageIdValue,
        exchangeDigest: replay.exchange.exchangeDigest,
        requestDigest: replay.exchange.requestDigest,
      });
      const result = await replay.session.submit(parsed);
      const failedGeneration = replay.base.generations.at(-1);
      if (failedGeneration === undefined || failedGeneration.blueprint.pageId !== pageIdValue ||
          failedGeneration.blueprint.generationOrder !== record.submissions.length - 1 ||
          result.proposal.pageId !== pageIdValue) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      const generation: ReplayGenerationV1 = Object.freeze({
        blueprint: failedGeneration.blueprint,
        exchange: replay.exchange,
        result,
      });
      const generations = Object.freeze([
        ...replay.base.generations.slice(0, -1),
        generation,
      ]);
      const base = replayBase(
        replay.base,
        generations,
        replay.base.childReviews,
        replay.base.generationService,
      );
      const quality = pageQualityEvaluation(generation, projectId);
      const failure = quality.failure;
      const storedResubmission: HierarchicalWorkflowStoredResubmissionV2 = Object.freeze({
        attempt,
        expectedExchangeDigest: expectExchange,
        generationOrder: failedGeneration.blueprint.generationOrder,
        outcome: quality.outcome,
        pageId: pageIdValue,
        proposalDigest: result.proposal.proposalDigest,
        receiptDigest: result.receipt.receiptDigest,
        submission: parsed,
      });
      let nextRecord: HierarchicalWorkflowRunRecordV1;
      let nextReplay: ReplayStateV1;
      if (failure !== null && attempt < MAXIMUM_PAGE_RESUBMISSIONS) {
        const retrySession = await replay.base.generationService.prepare({
          approvedChildSummaries: summariesForBlueprint(
            failedGeneration.blueprint,
            generations,
            replay.base.childReviews,
            projectId,
          ),
          blueprint: failedGeneration.blueprint,
          evidencePack: failedGeneration.exchange.evidencePack,
          generationAttempt: attempt + 1,
          purpose: record.purpose,
        }, projectId);
        nextRecord = recordWith(record, {
          resubmissions: Object.freeze([...record.resubmissions, storedResubmission]),
          phase: 'hard-quality-failed',
          rejection: failure.rejection,
          pendingExchangeDigest: retrySession.exchange.exchangeDigest,
          pendingChildReviewDigest: null,
          pendingReviewDigest: null,
          pendingLedgerDigest: null,
        });
        nextReplay = Object.freeze({
          kind: 'hard-quality-failed',
          base,
          exchange: retrySession.exchange,
          session: retrySession,
          pageQualityReport: failure.report,
          rejection: failure.rejection,
        });
      } else if (failure !== null) {
        nextRecord = recordWith(record, {
          resubmissions: Object.freeze([...record.resubmissions, storedResubmission]),
          phase: 'rejected',
          rejection: failure.rejection,
          pendingExchangeDigest: null,
          pendingChildReviewDigest: null,
          pendingReviewDigest: null,
          pendingLedgerDigest: null,
        });
        nextReplay = Object.freeze({
          kind: 'rejected', base, review: null, rejection: failure.rejection,
        });
      } else if (failedGeneration.blueprint.parentPageId !== null) {
        const view = childReviewView(generation, projectId, currentRunIdValue);
        nextRecord = recordWith(record, {
          resubmissions: Object.freeze([...record.resubmissions, storedResubmission]),
          phase: 'awaiting-child-review',
          rejection: null,
          pendingExchangeDigest: null,
          pendingChildReviewDigest: view.reviewViewDigest,
          pendingReviewDigest: null,
          pendingLedgerDigest: null,
        });
        nextReplay = Object.freeze({
          kind: 'awaiting-child-review', base, childReview: view,
        });
      } else {
        const integrated = buildIntegratedReview(record, base);
        nextRecord = recordWith(record, {
          resubmissions: Object.freeze([...record.resubmissions, storedResubmission]),
          phase: 'review-ready',
          rejection: null,
          pendingExchangeDigest: null,
          pendingChildReviewDigest: null,
          pendingReviewDigest: integrated.view.reviewDigest,
          pendingLedgerDigest: null,
        });
        nextReplay = Object.freeze({ kind: 'review-ready', base, review: integrated.view });
      }
      await runStore.replace({
        expectedRecordDigest: record.recordDigest,
        expectedRevision: record.revision,
        next: nextRecord,
        projectId,
        runId: currentRunIdValue,
      });
      const status = await statusFromReplay(nextRecord, nextReplay, corpusStore, runStore);
      return Object.freeze({
        schemaVersion: HIERARCHICAL_WORKFLOW_SUBMIT_RESULT_SCHEMA_VERSION,
        projectId,
        runId: currentRunIdValue,
        pageId: pageIdValue,
        proposalDigest: result.proposal.proposalDigest,
        receiptDigest: result.receipt.receiptDigest,
        status,
      });
    },

    async childReview(projectIdValue, runIdValue, inputFile, expectReviewValue) {
      const projectId = project(projectIdValue);
      const currentRunIdValue = runId(runIdValue);
      const expectReview = digest(expectReviewValue);
      const record = await runStore.read(projectId, currentRunIdValue);
      if (record.phase !== 'awaiting-child-review') {
        fail('HIERARCHICAL_WORKFLOW_PHASE_MISMATCH');
      }
      if (record.pendingChildReviewDigest !== expectReview) {
        fail('HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH');
      }
      const input = parseChildReviewInput(
        await readJsonInput(hubRoot, inputFile, MAXIMUM_INPUT_BYTES, projectId),
        projectId,
        currentRunIdValue,
      );
      if (input.reviewViewDigest !== expectReview) {
        fail('HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH');
      }
      const replay = await replayRun(record, dependencies);
      if (replay.kind !== 'awaiting-child-review' ||
          replay.childReview.reviewViewDigest !== expectReview ||
          replay.childReview.pageId !== input.pageId) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      const generation = replay.base.generations.at(-1);
      if (generation === undefined || generation.blueprint.pageId !== input.pageId) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      const review = createCompileCandidateReview(
        generation.result.proposal,
        input.decision,
        projectId,
      );
      const storedDecision: HierarchicalWorkflowStoredChildDecisionV1 = Object.freeze({
        decision: input.decision,
        generationOrder: generation.blueprint.generationOrder,
        pageId: input.pageId,
        reasonCodes: input.reasonCodes,
        reviewDigest: review.reviewDigest,
        reviewViewDigest: expectReview,
      });
      let nextRecord: HierarchicalWorkflowRunRecordV1;
      let nextReplay: ReplayStateV1;
      if (input.decision === 'rejected') {
        const rejection: HierarchicalWorkflowRejectionV1 = Object.freeze({
          kind: 'child-review-rejected',
          reasonCodes: input.reasonCodes,
          reviewDigest: review.reviewDigest,
          surfaceDigest: null,
        });
        nextRecord = recordWith(record, {
          childDecisions: Object.freeze([...record.childDecisions, storedDecision]),
          phase: 'rejected',
          rejection,
          pendingExchangeDigest: null,
          pendingChildReviewDigest: null,
          pendingReviewDigest: null,
          pendingLedgerDigest: null,
        });
        nextReplay = Object.freeze({
          kind: 'rejected', base: replay.base, review: null, rejection,
        });
      } else {
        const childReviews = Object.freeze([...replay.base.childReviews, review]);
        const nextBlueprint = replay.base.outline.blueprints[
          generation.blueprint.generationOrder + 1
        ];
        const nextPack = replay.base.evidencePacks[
          generation.blueprint.generationOrder + 1
        ];
        if (nextBlueprint === undefined || nextPack === undefined) {
          fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
        }
        const nextSession = await replay.base.generationService.prepare({
          approvedChildSummaries: summariesForBlueprint(
            nextBlueprint,
            replay.base.generations,
            childReviews,
            projectId,
          ),
          blueprint: nextBlueprint,
          evidencePack: nextPack,
          purpose: record.purpose,
        }, projectId);
        nextRecord = recordWith(record, {
          childDecisions: Object.freeze([...record.childDecisions, storedDecision]),
          phase: 'awaiting-proposal',
          pendingExchangeDigest: nextSession.exchange.exchangeDigest,
          pendingChildReviewDigest: null,
          pendingReviewDigest: null,
          pendingLedgerDigest: null,
        });
        nextReplay = Object.freeze({
          kind: 'awaiting-proposal',
          base: replayBase(
            replay.base,
            replay.base.generations,
            childReviews,
            replay.base.generationService,
          ),
          exchange: nextSession.exchange,
          session: nextSession,
        });
      }
      await runStore.replace({
        expectedRecordDigest: record.recordDigest,
        expectedRevision: record.revision,
        next: nextRecord,
        projectId,
        runId: currentRunIdValue,
      });
      const status = await statusFromReplay(nextRecord, nextReplay, corpusStore, runStore);
      return Object.freeze({
        schemaVersion: HIERARCHICAL_WORKFLOW_CHILD_REVIEW_RESULT_SCHEMA_VERSION,
        projectId,
        runId: currentRunIdValue,
        pageId: input.pageId,
        decision: input.decision,
        reviewDigest: review.reviewDigest,
        status,
      });
    },

    async review(projectIdValue, runIdValue) {
      const projectId = project(projectIdValue);
      const currentRunIdValue = runId(runIdValue);
      const record = await runStore.read(projectId, currentRunIdValue);
      if (record.phase !== 'review-ready') fail('HIERARCHICAL_WORKFLOW_PHASE_MISMATCH');
      const replay = await replayRun(record, dependencies);
      if (replay.kind !== 'review-ready') fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      return replay.review;
    },

    async finalize(projectIdValue, runIdValue, inputFile, expectReviewValue) {
      const projectId = project(projectIdValue);
      const currentRunIdValue = runId(runIdValue);
      const expectReview = digest(expectReviewValue);
      const record = await runStore.read(projectId, currentRunIdValue);
      if (record.phase !== 'review-ready') fail('HIERARCHICAL_WORKFLOW_PHASE_MISMATCH');
      if (record.pendingReviewDigest !== expectReview) {
        fail('HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH');
      }
      const input = parseFinalizeInput(
        await readJsonInput(hubRoot, inputFile, MAXIMUM_INPUT_BYTES, projectId),
        projectId,
        currentRunIdValue,
      );
      if (input.reviewDigest !== expectReview) {
        fail('HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH');
      }
      const replay = await replayRun(record, dependencies);
      if (replay.kind !== 'review-ready' || replay.review.reviewDigest !== expectReview ||
          input.surfaceDigest !== replay.review.surface.surfaceDigest) {
        fail('HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH');
      }
      const expectedCandidateIds = replay.review.surface.candidates
        .map((candidate) => candidate.pageId).sort();
      const expectedRelationIds = replay.review.relationCandidates
        .map((relation) => relation.relationId).sort();
      if (!sameValue(expectedCandidateIds, input.candidateDecisions.map((item) => item.pageId)) ||
          !sameValue(expectedRelationIds, input.relationDecisions.map((item) => item.relationId))) {
        fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
      }
      const integratedDecisions: readonly HierarchicalWorkflowStoredIntegratedDecisionV1[] =
        Object.freeze(input.candidateDecisions.map((decision) => {
          const review = createIntegratedWikiCandidateReview(
            replay.review.surface,
            decision.pageId,
            decision.decision,
            decision.reasonCodes,
            projectId,
          );
          return Object.freeze({ ...decision, reviewDigest: review.reviewDigest });
        }));
      const relationDecisions: readonly HierarchicalWorkflowStoredRelationDecisionV1[] =
        Object.freeze(input.relationDecisions.map((decision) => {
          const review = createCompileRelationReview(
            decision.relationId,
            decision.decision,
            projectId,
          );
          return Object.freeze({ ...decision, reviewDigest: review.reviewDigest });
        }));
      if (!replay.review.surface.hardQualityPassed) {
        if (integratedDecisions.some((decision) => decision.decision !== 'rejected')) {
          fail('HIERARCHICAL_WORKFLOW_INELIGIBLE');
        }
        const rejection: HierarchicalWorkflowRejectionV1 = Object.freeze({
          kind: 'hard-quality-failed',
          reasonCodes: Object.freeze([...new Set([
            'hard-quality-failed',
            ...replay.review.surface.reasonCodes,
          ])].sort()),
          reviewDigest: replay.review.reviewDigest,
          surfaceDigest: replay.review.surface.surfaceDigest,
        });
        const nextRecord = recordWith(record, {
          integratedDecisions,
          relationDecisions,
          phase: 'rejected',
          rejection,
          pendingExchangeDigest: null,
          pendingChildReviewDigest: null,
          pendingReviewDigest: null,
          pendingLedgerDigest: null,
        });
        await runStore.replace({
          expectedRecordDigest: record.recordDigest,
          expectedRevision: record.revision,
          next: nextRecord,
          projectId,
          runId: currentRunIdValue,
        });
        return Object.freeze({
          schemaVersion: HIERARCHICAL_WORKFLOW_FINALIZE_RESULT_SCHEMA_VERSION,
          projectId,
          runId: currentRunIdValue,
          phase: 'rejected',
          surface: replay.review.surface,
          ledger: null,
          rejection,
        });
      }
      const decisionRecord = Object.freeze({
        ...record,
        integratedDecisions,
        relationDecisions,
      }) as HierarchicalWorkflowRunRecordV1;
      const integrated = buildIntegratedReview(decisionRecord, replay.base);
      const finalized = buildFinalization(decisionRecord, replay.base, integrated);
      const nextRecord = recordWith(record, {
        integratedDecisions,
        relationDecisions,
        phase: 'finalized',
        rejection: null,
        pendingExchangeDigest: null,
        pendingChildReviewDigest: null,
        pendingReviewDigest: null,
        pendingLedgerDigest: finalized.ledger.ledgerDigest,
      });
      await runStore.replace({
        expectedRecordDigest: record.recordDigest,
        expectedRevision: record.revision,
        next: nextRecord,
        projectId,
        runId: currentRunIdValue,
      });
      return Object.freeze({
        schemaVersion: HIERARCHICAL_WORKFLOW_FINALIZE_RESULT_SCHEMA_VERSION,
        projectId,
        runId: currentRunIdValue,
        phase: 'finalized',
        surface: integrated.surface,
        ledger: finalized.ledger,
        rejection: null,
      });
    },

    async approve(
      projectIdValue,
      runIdValue,
      expectLedgerValue,
      explicitConfirmation,
    ) {
      const projectId = project(projectIdValue);
      const currentRunIdValue = runId(runIdValue);
      const expectLedger = digest(expectLedgerValue);
      if (explicitConfirmation !== true) fail('HIERARCHICAL_WORKFLOW_INPUT_INVALID');
      const record = await runStore.read(projectId, currentRunIdValue);
      if (record.phase !== 'finalized' && record.phase !== 'approved') {
        fail('HIERARCHICAL_WORKFLOW_PHASE_MISMATCH');
      }
      if (record.pendingLedgerDigest !== expectLedger) {
        fail('HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH');
      }
      const replay = await replayRun(record, dependencies);
      let nextRecord: HierarchicalWorkflowRunRecordV1;
      let activationBundle: Readonly<{
        readonly authority: ApprovedWikiAuthorityV1;
        readonly projectId: string;
        readonly schemaVersion: typeof HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION;
      }>;
      if (replay.kind === 'approved') {
        activationBundle = Object.freeze({
          authority: replay.authority,
          projectId,
          schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
        });
        nextRecord = record;
      } else {
        if (replay.kind !== 'finalized' || replay.ledger.ledgerDigest !== expectLedger ||
            !replay.ledger.eligibleForApproval) {
          fail('HIERARCHICAL_WORKFLOW_INELIGIBLE');
        }
        const approved = authorityFromFinalized(record, replay);
        activationBundle = approved.activationBundle;
        nextRecord = recordWith(record, {
          approvalDecision: approved.approvalDecision,
          phase: 'approved',
          pendingLedgerDigest: replay.ledger.ledgerDigest,
        });
      }
      await runStore.approve({
        activationBundle,
        expectedRecordDigest: record.recordDigest,
        expectedRevision: record.revision,
        next: nextRecord,
        projectId,
        runId: currentRunIdValue,
      });
      const approval = activationBundle.authority.humanActivationApproval;
      const activationBundlePath = runStore.activationBundlePath(projectId, currentRunIdValue);
      return Object.freeze({
        schemaVersion: HIERARCHICAL_WORKFLOW_APPROVE_RESULT_SCHEMA_VERSION,
        projectId,
        runId: currentRunIdValue,
        approvalDigest: approval.approvalDigest,
        generationDigest: activationBundle.authority.state.generationDigest,
        activationBundlePath,
        activationBundleDigest: canonicalDigest(activationBundle),
        activationArgs: Object.freeze([
          'compile', 'activate', '--project', projectId, '--input', activationBundlePath,
          '--confirm-approval', approval.approvalDigest,
        ]),
        egress: 'none',
        providerUsed: null,
        processSpawned: false,
      });
    },
  };
  return Object.freeze(service);
}
