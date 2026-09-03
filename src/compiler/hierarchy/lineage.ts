import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import { digestHierarchyValue, parseCorpusSnapshot } from './contracts.js';
import { citationIdsForProposalSummary } from './evidence.js';
import {
  verifyCurrentSessionGenerationResult,
  type CurrentSessionGenerationExchangeV1,
  type CurrentSessionGenerationResultV1,
} from './current-session.js';
import { HierarchyContractError } from './errors.js';
import {
  parseCompilePartition,
  parsePlanningDispositionInventory,
  parseSparseRelationGraph,
} from './planning.js';
import {
  BASELINE_PAGE_REMOVAL_REVIEW_REASON_CODE,
  createIntegratedWikiCandidateReview,
  evaluateSemanticQuality,
  verifyIntegratedWikiReviewSurface,
  type CurrentSessionGenerationHandoffV1,
} from './quality.js';
import {
  AUTHORITATIVE_WIKI_CHECK_SCHEMA_VERSION,
  AUTHORITATIVE_WIKI_STATE_SCHEMA_VERSION,
  COMPILE_INTEGRITY_REPORT_SCHEMA_VERSION,
  COMPILE_RUN_LEDGER_SCHEMA_VERSION,
  HUMAN_ACTIVATION_APPROVAL_SCHEMA_VERSION,
  LEGACY_WIKI_MIGRATION_SCHEMA_VERSION,
  LEGACY_WIKI_MIGRATION_REVIEW_SCHEMA_VERSION,
  PAGE_OWNERSHIP_GRAPH_SCHEMA_VERSION,
  type AuthoritativeWikiCheckV1,
  type AuthoritativeWikiStateV1,
  type CompilePartitionV2,
  type CompileIntegrityReportV1,
  type CompileRunLedgerV1,
  type CompileTaskDispositionV1,
  type CorpusQualityReportV1,
  type CorpusSnapshotV1,
  type EvidencePackV1,
  type HierarchicalWikiProposalV1,
  type HierarchySha256Digest,
  type HumanActivationApprovalV1,
  type IntegratedWikiCandidateReviewV1,
  type IntegratedWikiReviewSurfaceV1,
  type LegacyWikiMigrationV1,
  type LegacyWikiMigrationReviewV1,
  type PageOwnershipEntryV1,
  type PageOwnershipGraphV1,
  type PageQualityReportV1,
  type PlanningDispositionInventoryV1,
  type SparseRelationGraphV1,
  type WikiOutlineV1,
  type WikiLinkReconciliationV1,
} from './types.js';

const PAGE_ID_PATTERN = /^page-[a-f0-9]{64}$/u;
const TASK_ID_PATTERN = /^task-[a-f0-9]{64}$/u;
const UNIT_ID_PATTERN = /^unit-[a-f0-9]{64}$/u;
const SOURCE_ID_PATTERN = /^source-[a-f0-9]{64}$/u;
const RELATION_ID_PATTERN = /^relation-[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function invalid(projectId: string): never {
  throw new HierarchyContractError(projectId);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sortedUnique(values: readonly string[], projectId: string): readonly string[] {
  void projectId;
  return Object.freeze([...new Set(values)].sort());
}

function exactKeys(value: unknown, expected: readonly string[], projectId: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(projectId);
  const actual = Object.keys(value).sort();
  if (!sameStrings(actual, [...expected].sort())) invalid(projectId);
}

function requireArray(value: unknown, projectId: string): void {
  if (!Array.isArray(value)) invalid(projectId);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

export interface CompileCandidateReviewV1 {
  readonly pageId: string;
  readonly proposalDigest: HierarchySha256Digest;
  readonly reviewDigest: HierarchySha256Digest;
  readonly decision: 'accepted' | 'rejected';
}

export interface CompileRelationReviewV1 {
  readonly relationId: string;
  readonly reviewDigest: HierarchySha256Digest;
  readonly decision: 'accepted' | 'rejected';
}

export function createCompileCandidateReview(
  proposal: HierarchicalWikiProposalV1,
  decision: CompileCandidateReviewV1['decision'],
  expectedProjectId: string,
): CompileCandidateReviewV1 {
  if (proposal.projectId !== expectedProjectId ||
      (decision !== 'accepted' && decision !== 'rejected')) invalid(expectedProjectId);
  const basis = Object.freeze({
    pageId: proposal.pageId,
    proposalDigest: proposal.proposalDigest,
    decision,
  });
  return Object.freeze({ ...basis, reviewDigest: digestHierarchyValue(basis) });
}

export function createCompileRelationReview(
  relationId: string,
  decision: CompileRelationReviewV1['decision'],
  expectedProjectId: string,
): CompileRelationReviewV1 {
  if (!/^relation-[a-f0-9]{64}$/u.test(relationId) ||
      (decision !== 'accepted' && decision !== 'rejected')) invalid(expectedProjectId);
  const basis = Object.freeze({ relationId, decision });
  return Object.freeze({ ...basis, reviewDigest: digestHierarchyValue(basis) });
}

export interface CompileRunIntegrityInputV1 {
  readonly graph: SparseRelationGraphV1;
  readonly outline: WikiOutlineV1;
  readonly planningInventory: PlanningDispositionInventoryV1;
  readonly partitions: readonly CompilePartitionV2[];
  readonly proposals: readonly HierarchicalWikiProposalV1[];
  readonly evidencePacks: readonly EvidencePackV1[];
  readonly pageQualityReports: readonly PageQualityReportV1[];
  readonly corpusQualityReport: CorpusQualityReportV1;
  readonly reconciliation: WikiLinkReconciliationV1;
  readonly generationHandoffs: readonly CurrentSessionGenerationHandoffV1[];
  readonly baselineGenerationDigest: HierarchySha256Digest | null;
  readonly baselineProposals: readonly HierarchicalWikiProposalV1[];
  readonly integratedReviewSurface: IntegratedWikiReviewSurfaceV1;
  readonly integratedReviews: readonly IntegratedWikiCandidateReviewV1[];
  readonly childSynthesisReviews: readonly CompileCandidateReviewV1[];
  readonly relationReviews: readonly CompileRelationReviewV1[];
}

export interface FinalizeCompileRunInputV1 extends CompileRunIntegrityInputV1 {
  readonly integrityReport: CompileIntegrityReportV1;
}

const COMPILE_RUN_INTEGRITY_INPUT_KEYS = Object.freeze([
  'baselineGenerationDigest', 'baselineProposals', 'childSynthesisReviews',
  'corpusQualityReport', 'evidencePacks', 'generationHandoffs', 'graph',
  'integratedReviewSurface', 'integratedReviews', 'outline', 'pageQualityReports',
  'partitions', 'planningInventory', 'proposals', 'reconciliation', 'relationReviews',
] as const);
const FINALIZE_COMPILE_RUN_INPUT_KEYS = Object.freeze([
  ...COMPILE_RUN_INTEGRITY_INPUT_KEYS,
  'integrityReport',
] as const);

function ledgerWithoutDigest(
  ledger: Omit<CompileRunLedgerV1, 'ledgerDigest'>,
): Readonly<Record<string, unknown>> {
  const { ledgerDigest, ...basis } = ledger as CompileRunLedgerV1;
  void ledgerDigest;
  return basis;
}

function integrityReportWithoutDigest(
  report: Omit<CompileIntegrityReportV1, 'reportDigest'>,
): Readonly<Record<string, unknown>> {
  const { reportDigest, ...basis } = report as CompileIntegrityReportV1;
  void reportDigest;
  return basis;
}

interface VerifiedGenerationV1 {
  readonly exchange: CurrentSessionGenerationExchangeV1;
  readonly result: CurrentSessionGenerationResultV1;
}

interface VerifiedReceiptBoundRunV1 {
  readonly graph: SparseRelationGraphV1;
  readonly planningInventory: PlanningDispositionInventoryV1;
  readonly partitions: readonly CompilePartitionV2[];
  readonly quality: ReturnType<typeof evaluateSemanticQuality>;
  readonly sortedReports: readonly PageQualityReportV1[];
  readonly surface: IntegratedWikiReviewSurfaceV1;
  readonly generations: readonly VerifiedGenerationV1[];
  readonly integratedReviewById: ReadonlyMap<string, IntegratedWikiCandidateReviewV1>;
  readonly childSynthesisReviewById: ReadonlyMap<string, CompileCandidateReviewV1>;
  readonly expectedPageIds: readonly string[];
  readonly receiptSetDigest: HierarchySha256Digest;
  readonly integratedReviewSetDigest: HierarchySha256Digest;
  readonly childSynthesisReviewSetDigest: HierarchySha256Digest;
  readonly relationReviewSetDigest: HierarchySha256Digest;
}

function digestSortedPageRecords<T extends Readonly<{ readonly pageId: string }>>(
  values: readonly T[],
): HierarchySha256Digest {
  return digestHierarchyValue([...values].sort((left, right) =>
    left.pageId < right.pageId ? -1 : left.pageId > right.pageId ? 1 : 0));
}

function assertCanonicalChildSynthesisReview(
  review: CompileCandidateReviewV1,
  projectId: string,
): void {
  exactKeys(review, ['decision', 'pageId', 'proposalDigest', 'reviewDigest'], projectId);
  if (
    !PAGE_ID_PATTERN.test(review.pageId) ||
    !DIGEST_PATTERN.test(review.proposalDigest) ||
    review.decision !== 'accepted' ||
    review.reviewDigest !== digestHierarchyValue({
      pageId: review.pageId,
      proposalDigest: review.proposalDigest,
      decision: review.decision,
    })
  ) invalid(projectId);
}

function assertCanonicalIntegratedReview(
  review: IntegratedWikiCandidateReviewV1,
  surface: IntegratedWikiReviewSurfaceV1,
  projectId: string,
): void {
  const expected = createIntegratedWikiCandidateReview(
    surface,
    review.pageId,
    review.decision,
    review.reasonCodes,
    projectId,
  );
  if (!sameCanonical(review, expected)) invalid(projectId);
}

function verifyReceiptBoundRun(
  input: CompileRunIntegrityInputV1,
  projectId: string,
): VerifiedReceiptBoundRunV1 {
  const graph = parseSparseRelationGraph(input.graph, projectId);
  const planningInventory = parsePlanningDispositionInventory(
    input.planningInventory,
    graph,
    projectId,
  );
  const partitions = Object.freeze(input.partitions.map((partition) =>
    parseCompilePartition(partition, graph, projectId)));
  const surfaceInput = {
    graph,
    outline: input.outline,
    planningInventory,
    generations: input.generationHandoffs,
    reconciliation: input.reconciliation,
    baselineGenerationDigest: input.baselineGenerationDigest,
    baselineProposals: input.baselineProposals,
    intentionalOrphanPageIds: input.corpusQualityReport.intentionalOrphanPageIds,
  };
  const surface = verifyIntegratedWikiReviewSurface(
    input.integratedReviewSurface,
    surfaceInput,
    projectId,
  );
  if (
    !surface.runCoverage.complete ||
    !surface.hardQualityPassed ||
    !surface.corpusQualityReport.eligibleForApproval ||
    surface.canonicalMutationAuthorized !== false
  ) invalid(projectId);

  const generations = Object.freeze(input.generationHandoffs.map((handoff) => {
    exactKeys(handoff, ['exchange', 'result'], projectId);
    const result = verifyCurrentSessionGenerationResult(
      handoff.result,
      handoff.exchange,
      projectId,
    );
    return Object.freeze({
      exchange: handoff.exchange as CurrentSessionGenerationExchangeV1,
      result,
    });
  }).sort((left, right) => left.exchange.pageId < right.exchange.pageId ? -1 : 1));
  const generationById = new Map(generations.map((generation) =>
    [generation.exchange.pageId, generation]));
  const proposalById = new Map(input.proposals.map((proposal) => [proposal.pageId, proposal]));
  const packById = new Map(input.evidencePacks.map((pack) => [pack.pageId, pack]));
  const surfaceCandidateById = new Map(surface.candidates.map((candidate) =>
    [candidate.pageId, candidate]));
  const expectedPageIds = Object.freeze(input.outline.blueprints
    .map((blueprint) => blueprint.pageId).sort());
  if (
    generationById.size !== generations.length ||
    proposalById.size !== input.proposals.length ||
    packById.size !== input.evidencePacks.length ||
    surfaceCandidateById.size !== surface.candidates.length ||
    !sameStrings([...generationById.keys()].sort(), expectedPageIds) ||
    !sameStrings([...proposalById.keys()].sort(), expectedPageIds) ||
    !sameStrings([...packById.keys()].sort(), expectedPageIds) ||
    !sameStrings([...surfaceCandidateById.keys()].sort(), expectedPageIds)
  ) invalid(projectId);
  for (const pageId of expectedPageIds) {
    const generation = generationById.get(pageId);
    const proposal = proposalById.get(pageId);
    const pack = packById.get(pageId);
    const candidate = surfaceCandidateById.get(pageId);
    if (
      generation === undefined || proposal === undefined || pack === undefined ||
      candidate === undefined ||
      !sameCanonical(proposal, generation.result.proposal) ||
      !sameCanonical(pack, generation.exchange.evidencePack) ||
      !sameCanonical(candidate.proposal, generation.result.proposal) ||
      !sameCanonical(candidate.generationReceipt, generation.result.receipt)
    ) invalid(projectId);
  }

  const quality = evaluateSemanticQuality({
    outline: input.outline,
    proposals: input.proposals,
    evidencePacks: input.evidencePacks,
    reconciliation: input.reconciliation,
    intentionalOrphanPageIds: input.corpusQualityReport.intentionalOrphanPageIds,
  }, projectId);
  const sortedReports = Object.freeze([...input.pageQualityReports].sort((left, right) =>
    left.pageId < right.pageId ? -1 : left.pageId > right.pageId ? 1 : 0));
  if (
    !sameCanonical(sortedReports, quality.pages) ||
    !sameCanonical(input.corpusQualityReport, quality.corpus) ||
    !sameCanonical(input.corpusQualityReport, surface.corpusQualityReport) ||
    surface.candidates.some((candidate) => {
      const report = sortedReports.find((item) => item.pageId === candidate.pageId);
      return report === undefined || !sameCanonical(candidate.pageQualityReport, report);
    })
  ) invalid(projectId);

  const integratedReviewById = new Map(input.integratedReviews.map((review) => {
    assertCanonicalIntegratedReview(review, surface, projectId);
    return [review.pageId, review] as const;
  }));
  if (
    integratedReviewById.size !== input.integratedReviews.length ||
    !sameStrings([...integratedReviewById.keys()].sort(), expectedPageIds)
  ) invalid(projectId);
  if (
    surface.removedBaselinePages.length === 0
      ? !surface.eligibleForHumanAcceptance
      : surface.eligibleForHumanAcceptance || input.integratedReviews.some((review) =>
        review.decision !== 'accepted' ||
        !review.reasonCodes.includes(BASELINE_PAGE_REMOVAL_REVIEW_REASON_CODE))
  ) invalid(projectId);

  const expectedChildPageIds: string[] = [];
  for (const generation of generations) {
    for (const summary of generation.exchange.request.approvedChildSummaries) {
      expectedChildPageIds.push(summary.pageId);
    }
  }
  const canonicalChildPageIds = [...new Set(expectedChildPageIds)].sort();
  if (canonicalChildPageIds.length !== expectedChildPageIds.length) invalid(projectId);
  const childSynthesisReviewById = new Map(input.childSynthesisReviews.map((review) => {
    assertCanonicalChildSynthesisReview(review, projectId);
    return [review.pageId, review] as const;
  }));
  if (
    childSynthesisReviewById.size !== input.childSynthesisReviews.length ||
    !sameStrings([...childSynthesisReviewById.keys()].sort(), canonicalChildPageIds)
  ) invalid(projectId);
  for (const generation of generations) {
    for (const summary of generation.exchange.request.approvedChildSummaries) {
      const child = generationById.get(summary.pageId);
      const review = childSynthesisReviewById.get(summary.pageId);
      if (
        child === undefined || review === undefined ||
        review.proposalDigest !== child.result.proposal.proposalDigest ||
        summary.proposalDigest !== child.result.proposal.proposalDigest ||
        summary.reviewDigest !== review.reviewDigest ||
        summary.summary !== child.result.proposal.summary ||
        (!sameStrings(summary.citationIds, child.result.proposal.citationIds) &&
          !sameStrings(
            summary.citationIds,
            citationIdsForProposalSummary(child.result.proposal, projectId),
          ))
      ) invalid(projectId);
    }
  }

  const relationReviewById = new Map(input.relationReviews.map((review) => {
    exactKeys(review, ['decision', 'relationId', 'reviewDigest'], projectId);
    if (
      !RELATION_ID_PATTERN.test(review.relationId) ||
      (review.decision !== 'accepted' && review.decision !== 'rejected') ||
      review.reviewDigest !== digestHierarchyValue({
        relationId: review.relationId,
        decision: review.decision,
      })
    ) invalid(projectId);
    return [review.relationId, review] as const;
  }));
  const expectedRelationIds = graph.relations.map((relation) => relation.relationId).sort();
  if (
    relationReviewById.size !== input.relationReviews.length ||
    !sameStrings([...relationReviewById.keys()].sort(), expectedRelationIds)
  ) invalid(projectId);

  return Object.freeze({
    graph,
    planningInventory,
    partitions,
    quality,
    sortedReports,
    surface,
    generations,
    integratedReviewById,
    childSynthesisReviewById,
    expectedPageIds,
    receiptSetDigest: digestSortedPageRecords(generations.map((generation) => ({
      pageId: generation.exchange.pageId,
      receiptDigest: generation.result.receipt.receiptDigest,
    }))),
    integratedReviewSetDigest: digestSortedPageRecords(input.integratedReviews.map((review) => ({
      pageId: review.pageId,
      reviewDigest: review.reviewDigest,
    }))),
    childSynthesisReviewSetDigest: digestSortedPageRecords(input.childSynthesisReviews
      .map((review) => ({ pageId: review.pageId, reviewDigest: review.reviewDigest }))),
    relationReviewSetDigest: digestHierarchyValue([...input.relationReviews]
      .sort((left, right) => left.relationId < right.relationId ? -1 : 1)
      .map((review) => ({ relationId: review.relationId, reviewDigest: review.reviewDigest }))),
  });
}

/**
 * Build a content-addressed integrity proof after replaying the canonical
 * graph, partition, inventory and semantic-quality contracts. Finalization
 * recomputes this proof, so an imported bundle cannot replace verification
 * with a self-attested boolean.
 */
export function createCompileIntegrityReport(
  input: CompileRunIntegrityInputV1,
  expectedProjectId: string,
): CompileIntegrityReportV1 {
  exactKeys(input, COMPILE_RUN_INTEGRITY_INPUT_KEYS, expectedProjectId);
  const verified = verifyReceiptBoundRun(input, expectedProjectId);
  const { graph, planningInventory, partitions, quality, sortedReports } = verified;
  if (
    input.outline.projectId !== expectedProjectId ||
    input.outline.snapshotDigest !== graph.snapshotDigest ||
    planningInventory.projectId !== expectedProjectId ||
    planningInventory.snapshotDigest !== graph.snapshotDigest ||
    planningInventory.graphDigest !== graph.graphDigest ||
    !planningInventory.complete ||
    partitions.length < 1 ||
    partitions.some((partition, index) =>
      partition.projectId !== expectedProjectId ||
      partition.snapshotDigest !== graph.snapshotDigest ||
      partition.graphDigest !== graph.graphDigest ||
      partition.complete !== (index === partitions.length - 1)) ||
    !sameCanonical(sortedReports, quality.pages) ||
    !sameCanonical(input.corpusQualityReport, quality.corpus) ||
    !quality.corpus.hardQualityPassed ||
    !quality.corpus.eligibleForApproval
  ) invalid(expectedProjectId);
  const candidate = Object.freeze({
    schemaVersion: COMPILE_INTEGRITY_REPORT_SCHEMA_VERSION,
    projectId: expectedProjectId,
    snapshotDigest: graph.snapshotDigest,
    graphDigest: graph.graphDigest,
    outlineDigest: input.outline.outlineDigest,
    planningInventoryDigest: planningInventory.inventoryDigest,
    partitionSetDigest: digestHierarchyValue(partitions.map((partition) =>
      partition.partitionDigest).sort()),
    proposalSetDigest: digestSortedPageRecords(input.proposals.map((proposal) => ({
      pageId: proposal.pageId,
      proposalDigest: proposal.proposalDigest,
    }))),
    evidencePackSetDigest: digestSortedPageRecords(input.evidencePacks.map((pack) => ({
      pageId: pack.pageId,
      packDigest: pack.packDigest,
    }))),
    pageQualityReportSetDigest: digestSortedPageRecords(sortedReports.map((report) => ({
      pageId: report.pageId,
      reportDigest: report.reportDigest,
    }))),
    corpusQualityReportDigest: input.corpusQualityReport.reportDigest,
    reconciliationDigest: input.reconciliation.reconciliationDigest,
    receiptSetDigest: verified.receiptSetDigest,
    reviewSurfaceDigest: verified.surface.surfaceDigest,
    integratedReviewSetDigest: verified.integratedReviewSetDigest,
    childSynthesisReviewSetDigest: verified.childSynthesisReviewSetDigest,
    relationReviewSetDigest: verified.relationReviewSetDigest,
    passed: true as const,
  });
  return Object.freeze({
    ...candidate,
    reportDigest: digestHierarchyValue(integrityReportWithoutDigest(candidate)),
  });
}

export function finalizeCompileRun(
  input: FinalizeCompileRunInputV1,
  expectedProjectId: string,
): CompileRunLedgerV1 {
  exactKeys(input, FINALIZE_COMPILE_RUN_INPUT_KEYS, expectedProjectId);
  const { integrityReport: _integrityReport, ...integrityInput } = input;
  void _integrityReport;
  const verified = verifyReceiptBoundRun(integrityInput, expectedProjectId);
  const {
    graph,
    planningInventory,
    partitions,
    quality,
    sortedReports,
    surface,
    generations,
    integratedReviewById,
    childSynthesisReviewById,
    expectedPageIds,
  } = verified;
  const outline = input.outline;
  const expectedIntegrityReport = createCompileIntegrityReport(
    integrityInput,
    expectedProjectId,
  );
  if (
    graph.projectId !== expectedProjectId ||
    outline.projectId !== expectedProjectId ||
    planningInventory.projectId !== expectedProjectId ||
    graph.snapshotDigest !== outline.snapshotDigest ||
    graph.graphDigest !== planningInventory.graphDigest ||
    planningInventory.snapshotDigest !== graph.snapshotDigest ||
    !planningInventory.complete ||
    planningInventory.taskCount !== graph.tasks.length ||
    planningInventory.relationCount !== graph.relations.length ||
    !sameCanonical(input.integrityReport, expectedIntegrityReport) ||
    !sameCanonical(sortedReports, quality.pages) ||
    !sameCanonical(input.corpusQualityReport, quality.corpus) ||
    !quality.corpus.hardQualityPassed ||
    !input.corpusQualityReport.eligibleForApproval ||
    input.corpusQualityReport.projectId !== expectedProjectId ||
    input.corpusQualityReport.outlineDigest !== outline.outlineDigest ||
    input.corpusQualityReport.candidateCount !== outline.blueprints.length ||
    input.corpusQualityReport.expectedCandidateCount !== outline.blueprints.length
  ) invalid(expectedProjectId);
  const planningTaskDispositions = Object.freeze(partitions.flatMap((partition) =>
    [...partition.taskDispositions]));
  const taskIds = planningTaskDispositions.map((item) => item.taskId);
  const relationIds = partitions.flatMap((partition) =>
    partition.relationDispositions.map((item) => item.relationId));
  if (
    partitions.length < 1 ||
    partitions.some((partition, index) =>
      partition.projectId !== expectedProjectId ||
      partition.snapshotDigest !== graph.snapshotDigest ||
      partition.graphDigest !== graph.graphDigest ||
      partition.complete !== (index === input.partitions.length - 1)) ||
    !sameStrings(taskIds, graph.tasks.map((task) => task.taskId)) ||
    !sameStrings(relationIds, graph.relations.map((relation) => relation.relationId)) ||
    new Set(taskIds).size !== graph.tasks.length ||
    new Set(relationIds).size !== graph.relations.length ||
    planningInventory.taskDispositionDigest !== digestHierarchyValue(planningTaskDispositions) ||
    planningInventory.relationDispositionDigest !== digestHierarchyValue(partitions.flatMap(
      (partition) => [...partition.relationDispositions],
    ))
  ) invalid(expectedProjectId);
  const relationReviewById = new Map(input.relationReviews.map((review) =>
    [review.relationId, review]));
  if (relationReviewById.size !== input.relationReviews.length ||
      !sameStrings([...relationReviewById.keys()].sort(), [...relationIds].sort())) {
    invalid(expectedProjectId);
  }
  const relationDispositions = Object.freeze([...relationIds].sort().map((relationId) => {
    const review = relationReviewById.get(relationId);
    if (review === undefined || review.reviewDigest !== digestHierarchyValue({
      relationId: review.relationId,
      decision: review.decision,
    })) invalid(expectedProjectId);
    return Object.freeze({
      relationId,
      reviewDigest: review.reviewDigest,
      decision: review.decision,
    });
  }));
  const proposalById = new Map(input.proposals.map((proposal) => [proposal.pageId, proposal]));
  const packById = new Map(input.evidencePacks.map((pack) => [pack.pageId, pack]));
  const reportById = new Map(input.pageQualityReports.map((report) => [report.pageId, report]));
  const generationById = new Map(generations.map((generation) =>
    [generation.exchange.pageId, generation]));
  if (
    proposalById.size !== input.proposals.length ||
    packById.size !== input.evidencePacks.length ||
    reportById.size !== input.pageQualityReports.length ||
    generationById.size !== generations.length ||
    !sameStrings([...proposalById.keys()].sort(), expectedPageIds) ||
    !sameStrings([...packById.keys()].sort(), expectedPageIds) ||
    !sameStrings([...reportById.keys()].sort(), expectedPageIds) ||
    !sameStrings([...generationById.keys()].sort(), expectedPageIds)
  ) invalid(expectedProjectId);
  if (!sameStrings(
    [...input.corpusQualityReport.pageReportDigests].sort(),
    input.pageQualityReports.map((report) => report.reportDigest).sort(),
  )) invalid(expectedProjectId);
  const candidateDispositions = Object.freeze(expectedPageIds.map((pageId) => {
    const proposal = proposalById.get(pageId);
    const pack = packById.get(pageId);
    const report = reportById.get(pageId);
    const generation = generationById.get(pageId);
    const integratedReview = integratedReviewById.get(pageId);
    const childSynthesisReview = childSynthesisReviewById.get(pageId) ?? null;
    if (
      proposal === undefined || pack === undefined || report === undefined ||
      generation === undefined || integratedReview === undefined ||
      proposal.projectId !== expectedProjectId ||
      proposal.evidencePackDigest !== pack.packDigest ||
      report.proposalDigest !== proposal.proposalDigest ||
      report.evidencePackDigest !== pack.packDigest ||
      !report.hardQualityPassed ||
      !report.eligibleForApproval ||
      integratedReview.proposalDigest !== proposal.proposalDigest ||
      integratedReview.generationReceiptDigest !==
        generation.result.receipt.receiptDigest ||
      (childSynthesisReview !== null &&
        childSynthesisReview.proposalDigest !== proposal.proposalDigest)
    ) invalid(expectedProjectId);
    return Object.freeze({
      pageId,
      proposalDigest: proposal.proposalDigest,
      evidencePackDigest: pack.packDigest,
      pageQualityReportDigest: report.reportDigest,
      generationReceiptDigest: generation.result.receipt.receiptDigest,
      integratedReviewDigest: integratedReview.reviewDigest,
      childSynthesisReviewDigest: childSynthesisReview?.reviewDigest ?? null,
      receiptSetDigest: verified.receiptSetDigest,
      reviewSurfaceDigest: surface.surfaceDigest,
      integratedReviewSetDigest: verified.integratedReviewSetDigest,
      childSynthesisReviewSetDigest: verified.childSynthesisReviewSetDigest,
      decision: integratedReview.decision,
    });
  }));
  const graphTaskByUnitId = new Map(graph.tasks.map((task) => [task.unitId, task]));
  if (graphTaskByUnitId.size !== graph.tasks.length) invalid(expectedProjectId);
  for (const proposal of input.proposals) {
    const pack = packById.get(proposal.pageId);
    if (pack === undefined) invalid(expectedProjectId);
    const packUnitById = new Map(pack.units.map((unit) => [unit.unitId, unit]));
    for (const unitId of new Set(proposal.claims.flatMap((claim) => claim.evidenceUnitIds))) {
      const task = graphTaskByUnitId.get(unitId);
      const unit = packUnitById.get(unitId);
      if (
        task === undefined || unit === undefined ||
        task.sourceId !== unit.sourceId ||
        task.contentDigest !== unit.contentDigest
      ) invalid(expectedProjectId);
    }
  }
  const taskDispositions = Object.freeze(graph.tasks.map((task): CompileTaskDispositionV1 => {
    const targetPageIds = Object.freeze(expectedPageIds.filter((pageId) => {
      const proposal = proposalById.get(pageId);
      return proposal?.claims.some((claim) => claim.evidenceUnitIds.includes(task.unitId)) ?? false;
    }));
    const proposalDigests = Object.freeze(targetPageIds.map((pageId) => {
      const proposal = proposalById.get(pageId);
      if (proposal === undefined) invalid(expectedProjectId);
      return proposal.proposalDigest;
    }));
    const outcome = targetPageIds.length === 0
      ? 'skipped' as const
      : targetPageIds.length === 1
        ? 'emitted' as const
        : 'merged' as const;
    const basis = Object.freeze({
      taskId: task.taskId,
      unitId: task.unitId,
      sourceId: task.sourceId,
      outcome,
      targetPageIds,
      proposalDigests,
      evidenceUnitIds: Object.freeze([task.unitId]),
      reasonCode: outcome === 'skipped' ? 'not-selected-for-synthesis' as const : null,
    });
    return Object.freeze({
      ...basis,
      dispositionDigest: digestHierarchyValue(basis),
    });
  }).sort((left, right) => left.taskId < right.taskId ? -1 : 1));
  const eligibleForApproval = candidateDispositions.every((item) =>
    item.decision === 'accepted');
  const candidate = Object.freeze({
    schemaVersion: COMPILE_RUN_LEDGER_SCHEMA_VERSION,
    projectId: expectedProjectId,
    snapshotDigest: graph.snapshotDigest,
    graphDigest: graph.graphDigest,
    outlineDigest: outline.outlineDigest,
    planningInventoryDigest: planningInventory.inventoryDigest,
    taskCount: graph.tasks.length,
    relationCount: graph.relations.length,
    partitionDigests: Object.freeze(partitions.map((partition) =>
      partition.partitionDigest)),
    taskDispositions,
    relationDispositions,
    candidateDispositions,
    corpusQualityReportDigest: input.corpusQualityReport.reportDigest,
    integrityReportDigest: input.integrityReport.reportDigest,
    receiptSetDigest: verified.receiptSetDigest,
    reviewSurfaceDigest: surface.surfaceDigest,
    integratedReviewSetDigest: verified.integratedReviewSetDigest,
    childSynthesisReviewSetDigest: verified.childSynthesisReviewSetDigest,
    integrityPassed: true as const,
    semanticQualityPassed: true as const,
    taskDispositionCoverageBasisPoints: 10_000 as const,
    relationDispositionCoverageBasisPoints: 10_000 as const,
    candidateDispositionCoverageBasisPoints: 10_000 as const,
    status: 'finalized' as const,
    eligibleForApproval,
  });
  return Object.freeze({
    ...candidate,
    ledgerDigest: digestHierarchyValue(ledgerWithoutDigest(candidate)),
  });
}

function ownershipWithoutDigest(
  ownership: Omit<PageOwnershipEntryV1, 'ownershipDigest'>,
): Readonly<Record<string, unknown>> {
  const { ownershipDigest, ...basis } = ownership as PageOwnershipEntryV1;
  void ownershipDigest;
  return basis;
}

function ownershipGraphWithoutDigest(
  graph: Omit<PageOwnershipGraphV1, 'graphDigest'>,
): Readonly<Record<string, unknown>> {
  const { graphDigest, ...basis } = graph as PageOwnershipGraphV1;
  void graphDigest;
  return basis;
}

function taskDispositionWithoutDigest(
  disposition: Omit<CompileTaskDispositionV1, 'dispositionDigest'>,
): Readonly<Record<string, unknown>> {
  const { dispositionDigest, ...basis } = disposition as CompileTaskDispositionV1;
  void dispositionDigest;
  return basis;
}

function assertCanonicalLedger(ledger: CompileRunLedgerV1, projectId: string): void {
  exactKeys(ledger, [
    'candidateDispositionCoverageBasisPoints', 'candidateDispositions',
    'childSynthesisReviewSetDigest', 'corpusQualityReportDigest', 'eligibleForApproval',
    'graphDigest', 'integratedReviewSetDigest', 'integrityPassed',
    'integrityReportDigest', 'ledgerDigest', 'outlineDigest', 'partitionDigests',
    'planningInventoryDigest', 'projectId', 'receiptSetDigest', 'relationCount',
    'relationDispositionCoverageBasisPoints', 'relationDispositions',
    'reviewSurfaceDigest', 'schemaVersion', 'semanticQualityPassed', 'snapshotDigest',
    'status', 'taskCount', 'taskDispositionCoverageBasisPoints', 'taskDispositions',
  ], projectId);
  requireArray(ledger.partitionDigests, projectId);
  requireArray(ledger.taskDispositions, projectId);
  requireArray(ledger.relationDispositions, projectId);
  requireArray(ledger.candidateDispositions, projectId);
  ledger.taskDispositions.forEach((item) => exactKeys(item, [
    'dispositionDigest', 'evidenceUnitIds', 'outcome', 'proposalDigests', 'reasonCode',
    'sourceId', 'targetPageIds', 'taskId', 'unitId',
  ], projectId));
  ledger.relationDispositions.forEach((item) => exactKeys(item, [
    'decision', 'relationId', 'reviewDigest',
  ], projectId));
  ledger.candidateDispositions.forEach((item) => exactKeys(item, [
    'childSynthesisReviewDigest', 'childSynthesisReviewSetDigest', 'decision',
    'evidencePackDigest', 'generationReceiptDigest', 'integratedReviewDigest',
    'integratedReviewSetDigest', 'pageId', 'pageQualityReportDigest', 'proposalDigest',
    'receiptSetDigest', 'reviewSurfaceDigest',
  ], projectId));
  const taskIds = ledger.taskDispositions.map((item) => item.taskId);
  const relationIds = ledger.relationDispositions.map((item) => item.relationId);
  const candidatePageIds = ledger.candidateDispositions.map((item) => item.pageId);
  if (
    ledger.projectId !== projectId ||
    ledger.schemaVersion !== COMPILE_RUN_LEDGER_SCHEMA_VERSION ||
    ledger.ledgerDigest !== digestHierarchyValue(ledgerWithoutDigest(ledger)) ||
    ledger.integrityPassed !== true ||
    ledger.semanticQualityPassed !== true ||
    ledger.status !== 'finalized' ||
    ledger.taskDispositionCoverageBasisPoints !== 10_000 ||
    ledger.relationDispositionCoverageBasisPoints !== 10_000 ||
    ledger.candidateDispositionCoverageBasisPoints !== 10_000 ||
    ledger.partitionDigests.length < 1 ||
    ledger.partitionDigests.some((digest) => !DIGEST_PATTERN.test(digest)) ||
    ledger.taskDispositions.length !== ledger.taskCount ||
    ledger.relationDispositions.length !== ledger.relationCount ||
    ledger.candidateDispositions.length < 1 ||
    !DIGEST_PATTERN.test(ledger.integrityReportDigest) ||
    !DIGEST_PATTERN.test(ledger.receiptSetDigest) ||
    !DIGEST_PATTERN.test(ledger.reviewSurfaceDigest) ||
    !DIGEST_PATTERN.test(ledger.integratedReviewSetDigest) ||
    !DIGEST_PATTERN.test(ledger.childSynthesisReviewSetDigest) ||
    !sameStrings(taskIds, [...taskIds].sort()) ||
    !sameStrings(relationIds, [...relationIds].sort()) ||
    !sameStrings(candidatePageIds, [...candidatePageIds].sort()) ||
    new Set(taskIds).size !== ledger.taskCount ||
    new Set(relationIds).size !== ledger.relationCount ||
    new Set(candidatePageIds).size !== candidatePageIds.length ||
    ledger.eligibleForApproval !== ledger.candidateDispositions.every((item) =>
      item.decision === 'accepted') ||
    ledger.taskDispositions.some((item) => {
      const targetsCanonical = sameStrings(item.targetPageIds, [...item.targetPageIds].sort()) &&
        new Set(item.targetPageIds).size === item.targetPageIds.length;
      const emitted = item.outcome === 'emitted' && item.targetPageIds.length === 1 &&
        item.reasonCode === null;
      const merged = item.outcome === 'merged' && item.targetPageIds.length > 1 &&
        item.reasonCode === null;
      const skipped = item.outcome === 'skipped' && item.targetPageIds.length === 0 &&
        item.proposalDigests.length === 0 &&
        item.reasonCode === 'not-selected-for-synthesis';
      return !TASK_ID_PATTERN.test(item.taskId) || !UNIT_ID_PATTERN.test(item.unitId) ||
        !SOURCE_ID_PATTERN.test(item.sourceId) || !targetsCanonical ||
        item.targetPageIds.some((pageId) => !PAGE_ID_PATTERN.test(pageId)) ||
        item.proposalDigests.length !== item.targetPageIds.length ||
        item.proposalDigests.some((digest) => !DIGEST_PATTERN.test(digest)) ||
        !sameStrings(item.evidenceUnitIds, [item.unitId]) ||
        (!emitted && !merged && !skipped) ||
        item.dispositionDigest !== digestHierarchyValue(taskDispositionWithoutDigest(item));
    }) ||
    ledger.relationDispositions.some((item) =>
      !RELATION_ID_PATTERN.test(item.relationId) ||
      (item.decision !== 'accepted' && item.decision !== 'rejected') ||
      item.reviewDigest !== digestHierarchyValue({
        relationId: item.relationId,
        decision: item.decision,
      })) ||
    ledger.candidateDispositions.some((item) =>
      !PAGE_ID_PATTERN.test(item.pageId) ||
      !DIGEST_PATTERN.test(item.proposalDigest) ||
      !DIGEST_PATTERN.test(item.evidencePackDigest) ||
      !DIGEST_PATTERN.test(item.pageQualityReportDigest) ||
      !DIGEST_PATTERN.test(item.generationReceiptDigest) ||
      !DIGEST_PATTERN.test(item.integratedReviewDigest) ||
      (item.childSynthesisReviewDigest !== null &&
        !DIGEST_PATTERN.test(item.childSynthesisReviewDigest)) ||
      item.receiptSetDigest !== ledger.receiptSetDigest ||
      item.reviewSurfaceDigest !== ledger.reviewSurfaceDigest ||
      item.integratedReviewSetDigest !== ledger.integratedReviewSetDigest ||
      item.childSynthesisReviewSetDigest !== ledger.childSynthesisReviewSetDigest ||
      (item.decision !== 'accepted' && item.decision !== 'rejected'))
  ) invalid(projectId);
}

function assertCanonicalOwnershipGraph(
  graph: PageOwnershipGraphV1,
  projectId: string,
): void {
  exactKeys(graph, [
    'childSynthesisReviewSetDigest', 'compilerContractDigest', 'corpusSourceSetDigest',
    'graphDigest', 'integratedReviewSetDigest', 'interpretationRulesDigest',
    'ledgerDigest', 'outlineDigest', 'pages', 'policyDigest', 'profileDigest',
    'projectId', 'purposeDigest', 'receiptSetDigest', 'reviewSurfaceDigest',
    'sanitizerPolicyDigest', 'schemaVersion', 'snapshotDigest', 'sourceManifestDigest',
  ], projectId);
  requireArray(graph.pages, projectId);
  graph.pages.forEach((page) => {
    exactKeys(page, [
      'ancestorPageIds', 'childPageIds', 'ownershipDigest', 'pageId', 'parentPageId',
      'proposalDigest', 'sectionIds', 'sourceRevisions', 'taskIds', 'textUnitIds',
    ], projectId);
    requireArray(page.sourceRevisions, projectId);
    page.sourceRevisions.forEach((source) => exactKeys(
      source,
      ['sourceId', 'sourceRevision'],
      projectId,
    ));
  });
  const pageIds = graph.pages.map((page) => page.pageId);
  const pageById = new Map(graph.pages.map((page) => [page.pageId, page]));
  if (
    graph.projectId !== projectId ||
    graph.schemaVersion !== PAGE_OWNERSHIP_GRAPH_SCHEMA_VERSION ||
    !DIGEST_PATTERN.test(graph.ledgerDigest) ||
    !DIGEST_PATTERN.test(graph.receiptSetDigest) ||
    !DIGEST_PATTERN.test(graph.reviewSurfaceDigest) ||
    !DIGEST_PATTERN.test(graph.integratedReviewSetDigest) ||
    !DIGEST_PATTERN.test(graph.childSynthesisReviewSetDigest) ||
    graph.pages.length < 1 ||
    pageById.size !== graph.pages.length ||
    !sameStrings(pageIds, [...pageIds].sort()) ||
    graph.pages.some((page) =>
      !PAGE_ID_PATTERN.test(page.pageId) ||
      !DIGEST_PATTERN.test(page.proposalDigest) ||
      (page.parentPageId !== null && !PAGE_ID_PATTERN.test(page.parentPageId)) ||
      !sameStrings(page.childPageIds, [...page.childPageIds].sort()) ||
      !sameStrings(page.ancestorPageIds, [...page.ancestorPageIds].sort()) ||
      !sameStrings(page.taskIds, [...page.taskIds].sort()) ||
      !sameStrings(page.textUnitIds, [...page.textUnitIds].sort()) ||
      !sameStrings(page.sectionIds, [...page.sectionIds].sort()) ||
      page.taskIds.length < 1 || page.taskIds.length !== page.textUnitIds.length ||
      page.sectionIds.length < 1 || page.sourceRevisions.length < 1 ||
      new Set(page.childPageIds).size !== page.childPageIds.length ||
      new Set(page.ancestorPageIds).size !== page.ancestorPageIds.length ||
      new Set(page.taskIds).size !== page.taskIds.length ||
      new Set(page.textUnitIds).size !== page.textUnitIds.length ||
      new Set(page.sectionIds).size !== page.sectionIds.length ||
      page.taskIds.some((taskId) => !TASK_ID_PATTERN.test(taskId)) ||
      page.textUnitIds.some((unitId) => !UNIT_ID_PATTERN.test(unitId)) ||
      page.childPageIds.some((pageId) => !pageById.has(pageId) || pageId === page.pageId) ||
      page.ancestorPageIds.some((pageId) => !pageById.has(pageId) || pageId === page.pageId) ||
      page.sourceRevisions.some((source, index) =>
        !SOURCE_ID_PATTERN.test(source.sourceId) ||
        !DIGEST_PATTERN.test(source.sourceRevision) ||
        (index > 0 && (page.sourceRevisions[index - 1]?.sourceId ?? '') >= source.sourceId)) ||
      page.ownershipDigest !== digestHierarchyValue(ownershipWithoutDigest(page))) ||
    graph.pages.some((page) =>
      page.parentPageId !== null &&
      !pageById.get(page.parentPageId)?.childPageIds.includes(page.pageId)) ||
    graph.graphDigest !== digestHierarchyValue(ownershipGraphWithoutDigest(graph))
  ) invalid(projectId);
}

export function createPageOwnershipGraph(
  snapshotValue: CorpusSnapshotV1,
  outline: WikiOutlineV1,
  ledger: CompileRunLedgerV1,
  proposals: readonly HierarchicalWikiProposalV1[],
  evidencePacks: readonly EvidencePackV1[],
  expectedProjectId: string,
): PageOwnershipGraphV1 {
  const snapshot = parseCorpusSnapshot(snapshotValue, expectedProjectId);
  assertCanonicalLedger(ledger, expectedProjectId);
  if (
    snapshot.projectId !== expectedProjectId ||
    outline.projectId !== expectedProjectId ||
    outline.snapshotDigest !== snapshot.snapshotDigest ||
    ledger.snapshotDigest !== snapshot.snapshotDigest ||
    ledger.outlineDigest !== outline.outlineDigest ||
    !ledger.eligibleForApproval
  ) invalid(expectedProjectId);
  const proposalById = new Map(proposals.map((proposal) => [proposal.pageId, proposal]));
  const packById = new Map(evidencePacks.map((pack) => [pack.pageId, pack]));
  const dispositionById = new Map(ledger.candidateDispositions.map((item) =>
    [item.pageId, item]));
  const blueprintById = new Map(outline.blueprints.map((blueprint) =>
    [blueprint.pageId, blueprint]));
  const snapshotSourceById = new Map(snapshot.sources.map((source) =>
    [source.sourceId, source]));
  const pages = Object.freeze(outline.blueprints.map((blueprint) => {
    const proposal = proposalById.get(blueprint.pageId);
    const pack = packById.get(blueprint.pageId);
    const disposition = dispositionById.get(blueprint.pageId);
    if (
      proposal === undefined || pack === undefined || disposition === undefined ||
      disposition.decision !== 'accepted' ||
      disposition.proposalDigest !== proposal.proposalDigest ||
      disposition.evidencePackDigest !== pack.packDigest ||
      disposition.receiptSetDigest !== ledger.receiptSetDigest ||
      disposition.reviewSurfaceDigest !== ledger.reviewSurfaceDigest ||
      disposition.integratedReviewSetDigest !== ledger.integratedReviewSetDigest ||
      disposition.childSynthesisReviewSetDigest !== ledger.childSynthesisReviewSetDigest ||
      proposal.blueprintDigest !== blueprint.blueprintDigest ||
      proposal.evidencePackDigest !== pack.packDigest
    ) invalid(expectedProjectId);
    const claimedUnitIds = new Set(proposal.claims.flatMap((claim) =>
      claim.evidenceUnitIds));
    const ownedTaskDispositions = ledger.taskDispositions.filter((item) =>
      item.targetPageIds.includes(blueprint.pageId));
    const taskIds = Object.freeze(ownedTaskDispositions.map((item) => item.taskId).sort());
    const textUnitIds = Object.freeze(ownedTaskDispositions.map((item) => item.unitId).sort());
    if (
      taskIds.length < 1 ||
      new Set(taskIds).size !== taskIds.length ||
      new Set(textUnitIds).size !== textUnitIds.length ||
      textUnitIds.some((unitId) => !claimedUnitIds.has(unitId))
    ) invalid(expectedProjectId);
    const ownedCitationIds = pack.units
      .filter((unit) => textUnitIds.includes(unit.unitId))
      .map((unit) => unit.citation.citationId);
    const sectionIds = sortedUnique(proposal.sections
      .filter((section) => ownedCitationIds.some((citationId) =>
        section.body.includes(`[^${citationId}]`)))
      .map((section) => section.sectionId), expectedProjectId);
    if (sectionIds.length < 1) invalid(expectedProjectId);
    const ancestors: string[] = [];
    let ancestorPageId = blueprint.parentPageId;
    while (ancestorPageId !== null) {
      if (ancestors.includes(ancestorPageId)) invalid(expectedProjectId);
      ancestors.push(ancestorPageId);
      ancestorPageId = blueprintById.get(ancestorPageId)?.parentPageId ?? null;
    }
    const ancestorPageIds = sortedUnique(ancestors, expectedProjectId);
    const sourceIds = sortedUnique(pack.units
      .filter((unit) => textUnitIds.includes(unit.unitId))
      .map((unit) => unit.sourceId), expectedProjectId);
    if (sourceIds.length < 1) invalid(expectedProjectId);
    const sourceRevisions = Object.freeze(sourceIds.map((sourceId) => {
      const source = snapshotSourceById.get(sourceId);
      if (source === undefined) invalid(expectedProjectId);
      return Object.freeze({ sourceId, sourceRevision: source.sourceRevision });
    }));
    const candidate = Object.freeze({
      pageId: blueprint.pageId,
      proposalDigest: proposal.proposalDigest,
      parentPageId: blueprint.parentPageId,
      childPageIds: blueprint.childPageIds,
      ancestorPageIds,
      taskIds,
      textUnitIds,
      sectionIds,
      sourceRevisions,
    });
    return Object.freeze({
      ...candidate,
      ownershipDigest: digestHierarchyValue(ownershipWithoutDigest(candidate)),
    });
  }).sort((left, right) => left.pageId < right.pageId ? -1 : 1));
  if (
    proposalById.size !== proposals.length ||
    packById.size !== evidencePacks.length ||
    dispositionById.size !== ledger.candidateDispositions.length ||
    proposalById.size !== outline.blueprints.length ||
    packById.size !== outline.blueprints.length
  ) invalid(expectedProjectId);
  const candidate = Object.freeze({
    schemaVersion: PAGE_OWNERSHIP_GRAPH_SCHEMA_VERSION,
    projectId: expectedProjectId,
    snapshotDigest: snapshot.snapshotDigest,
    outlineDigest: outline.outlineDigest,
    ledgerDigest: ledger.ledgerDigest,
    receiptSetDigest: ledger.receiptSetDigest,
    reviewSurfaceDigest: ledger.reviewSurfaceDigest,
    integratedReviewSetDigest: ledger.integratedReviewSetDigest,
    childSynthesisReviewSetDigest: ledger.childSynthesisReviewSetDigest,
    purposeDigest: snapshot.purposeDigest,
    interpretationRulesDigest: snapshot.interpretationRulesDigest,
    profileDigest: snapshot.profileDigest,
    compilerContractDigest: snapshot.compilerContractDigest,
    sanitizerPolicyDigest: snapshot.sanitizerPolicyDigest,
    sourceManifestDigest: snapshot.sourceManifestDigest,
    policyDigest: snapshot.policyDigest,
    corpusSourceSetDigest: digestHierarchyValue(snapshot.sources.map((source) => source.sourceId)),
    pages,
  });
  return Object.freeze({
    ...candidate,
    graphDigest: digestHierarchyValue(ownershipGraphWithoutDigest(candidate)),
  });
}

function humanActivationApprovalWithoutDigest(
  approval: Omit<HumanActivationApprovalV1, 'approvalDigest'>,
): Readonly<Record<string, unknown>> {
  const { approvalDigest, ...basis } = approval as HumanActivationApprovalV1;
  void approvalDigest;
  return basis;
}

function assertCanonicalHumanActivationApproval(
  approval: HumanActivationApprovalV1,
  projectId: string,
): void {
  exactKeys(approval, [
    'approvalDigest', 'childSynthesisReviewSetDigest', 'decision',
    'explicitConfirmation', 'integratedReviewSetDigest', 'ledgerDigest',
    'ownershipGraphDigest', 'previousActivePageIds', 'previousGenerationDigest',
    'projectId', 'receiptSetDigest', 'reviewSurfaceDigest', 'schemaVersion',
    'snapshotDigest',
  ], projectId);
  requireArray(approval.previousActivePageIds, projectId);
  if (
    approval.schemaVersion !== HUMAN_ACTIVATION_APPROVAL_SCHEMA_VERSION ||
    approval.projectId !== projectId ||
    !DIGEST_PATTERN.test(approval.snapshotDigest) ||
    !DIGEST_PATTERN.test(approval.ledgerDigest) ||
    !DIGEST_PATTERN.test(approval.ownershipGraphDigest) ||
    !DIGEST_PATTERN.test(approval.receiptSetDigest) ||
    !DIGEST_PATTERN.test(approval.reviewSurfaceDigest) ||
    !DIGEST_PATTERN.test(approval.integratedReviewSetDigest) ||
    !DIGEST_PATTERN.test(approval.childSynthesisReviewSetDigest) ||
    (approval.previousGenerationDigest !== null &&
      !DIGEST_PATTERN.test(approval.previousGenerationDigest)) ||
    (approval.previousGenerationDigest === null) !==
      (approval.previousActivePageIds.length === 0) ||
    approval.previousActivePageIds.length > 97 ||
    !sameStrings(approval.previousActivePageIds,
      [...approval.previousActivePageIds].sort()) ||
    new Set(approval.previousActivePageIds).size !== approval.previousActivePageIds.length ||
    approval.previousActivePageIds.some((pageId) => !PAGE_ID_PATTERN.test(pageId)) ||
    approval.decision !== 'approved' ||
    approval.explicitConfirmation !== true ||
    approval.approvalDigest !== digestHierarchyValue(
      humanActivationApprovalWithoutDigest(approval),
    )
  ) invalid(projectId);
}

export interface HumanActivationApprovalContextV1 {
  readonly ledger: CompileRunLedgerV1;
  readonly ownershipGraph: PageOwnershipGraphV1;
  readonly currentState: AuthoritativeWikiStateV1 | null;
}

export interface CreateHumanActivationApprovalInputV1 extends
  HumanActivationApprovalContextV1 {
  readonly decision: 'approved';
  readonly explicitConfirmation: true;
}

export function createHumanActivationApproval(
  input: CreateHumanActivationApprovalInputV1,
  expectedProjectId: string,
): HumanActivationApprovalV1 {
  assertCanonicalLedger(input.ledger, expectedProjectId);
  assertCanonicalOwnershipGraph(input.ownershipGraph, expectedProjectId);
  if (input.currentState !== null) assertCanonicalState(input.currentState, expectedProjectId);
  if (
    input.decision !== 'approved' ||
    input.explicitConfirmation !== true ||
    !input.ledger.eligibleForApproval ||
    input.ledger.status !== 'finalized' ||
    input.ledger.integrityPassed !== true ||
    input.ledger.semanticQualityPassed !== true ||
    input.ledger.projectId !== expectedProjectId ||
    input.ownershipGraph.projectId !== expectedProjectId ||
    input.ownershipGraph.snapshotDigest !== input.ledger.snapshotDigest ||
    input.ownershipGraph.ledgerDigest !== input.ledger.ledgerDigest ||
    input.ownershipGraph.receiptSetDigest !== input.ledger.receiptSetDigest ||
    input.ownershipGraph.reviewSurfaceDigest !== input.ledger.reviewSurfaceDigest ||
    input.ownershipGraph.integratedReviewSetDigest !== input.ledger.integratedReviewSetDigest ||
    input.ownershipGraph.childSynthesisReviewSetDigest !==
      input.ledger.childSynthesisReviewSetDigest ||
    (input.currentState !== null && input.currentState.projectId !== expectedProjectId)
  ) invalid(expectedProjectId);
  const candidate = Object.freeze({
    schemaVersion: HUMAN_ACTIVATION_APPROVAL_SCHEMA_VERSION,
    projectId: expectedProjectId,
    snapshotDigest: input.ledger.snapshotDigest,
    ledgerDigest: input.ledger.ledgerDigest,
    ownershipGraphDigest: input.ownershipGraph.graphDigest,
    receiptSetDigest: input.ledger.receiptSetDigest,
    reviewSurfaceDigest: input.ledger.reviewSurfaceDigest,
    integratedReviewSetDigest: input.ledger.integratedReviewSetDigest,
    childSynthesisReviewSetDigest: input.ledger.childSynthesisReviewSetDigest,
    previousGenerationDigest: input.currentState?.generationDigest ?? null,
    previousActivePageIds: Object.freeze(input.currentState?.activePages
      .map((page) => page.pageId).sort() ?? []),
    decision: input.decision,
    explicitConfirmation: input.explicitConfirmation,
  });
  return Object.freeze({
    ...candidate,
    approvalDigest: digestHierarchyValue(humanActivationApprovalWithoutDigest(candidate)),
  });
}

export function verifyHumanActivationApproval(
  value: unknown,
  context: HumanActivationApprovalContextV1,
  expectedProjectId: string,
): HumanActivationApprovalV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(expectedProjectId);
  }
  const approval = value as HumanActivationApprovalV1;
  assertCanonicalHumanActivationApproval(approval, expectedProjectId);
  const expected = createHumanActivationApproval({
    ...context,
    decision: 'approved',
    explicitConfirmation: true,
  }, expectedProjectId);
  if (!sameCanonical(approval, expected)) invalid(expectedProjectId);
  return expected;
}

function stateWithoutDigest(
  state: Omit<AuthoritativeWikiStateV1, 'generationDigest'>,
): Readonly<Record<string, unknown>> {
  const { generationDigest, ...basis } = state as AuthoritativeWikiStateV1;
  void generationDigest;
  return basis;
}

function assertCanonicalState(state: AuthoritativeWikiStateV1, projectId: string): void {
  exactKeys(state, [
    'activePages', 'childSynthesisReviewSetDigest', 'generationDigest',
    'humanActivationApprovalDigest', 'integratedReviewSetDigest', 'ledgerDigest',
    'ownershipGraphDigest', 'previousGenerationDigest', 'projectId', 'receiptSetDigest',
    'reviewSurfaceDigest', 'schemaVersion', 'snapshotDigest', 'status',
  ], projectId);
  requireArray(state.activePages, projectId);
  state.activePages.forEach((page) => exactKeys(
    page,
    ['ownershipDigest', 'pageId', 'proposalDigest', 'status'],
    projectId,
  ));
  const activePageIds = state.activePages.map((page) => page.pageId);
  if (
    state.projectId !== projectId ||
    state.schemaVersion !== AUTHORITATIVE_WIKI_STATE_SCHEMA_VERSION ||
    state.generationDigest !== digestHierarchyValue(stateWithoutDigest(state)) ||
    !DIGEST_PATTERN.test(state.snapshotDigest) ||
    !DIGEST_PATTERN.test(state.ledgerDigest) ||
    !DIGEST_PATTERN.test(state.ownershipGraphDigest) ||
    !DIGEST_PATTERN.test(state.receiptSetDigest) ||
    !DIGEST_PATTERN.test(state.reviewSurfaceDigest) ||
    !DIGEST_PATTERN.test(state.integratedReviewSetDigest) ||
    !DIGEST_PATTERN.test(state.childSynthesisReviewSetDigest) ||
    !DIGEST_PATTERN.test(state.humanActivationApprovalDigest) ||
    (state.previousGenerationDigest !== null &&
      !DIGEST_PATTERN.test(state.previousGenerationDigest)) ||
    state.activePages.length < 1 ||
    state.activePages.length > 97 ||
    !sameStrings(activePageIds, [...activePageIds].sort()) ||
    new Set(activePageIds).size !== state.activePages.length ||
    state.activePages.some((page) =>
      !PAGE_ID_PATTERN.test(page.pageId) ||
        !DIGEST_PATTERN.test(page.proposalDigest) ||
        !DIGEST_PATTERN.test(page.ownershipDigest) ||
        page.status !== 'active') ||
    state.status !== 'active'
  ) invalid(projectId);
}

function assertBaselineMatchesCurrentState(
  finalization: FinalizeCompileRunInputV1,
  currentState: AuthoritativeWikiStateV1 | null,
  projectId: string,
): void {
  if (currentState === null) {
    if (
      finalization.baselineGenerationDigest !== null ||
      finalization.baselineProposals.length !== 0
    ) invalid(projectId);
    return;
  }
  const baselineById = new Map(finalization.baselineProposals.map((proposal) =>
    [proposal.pageId, proposal]));
  if (
    finalization.baselineGenerationDigest !== currentState.generationDigest ||
    baselineById.size !== finalization.baselineProposals.length ||
    baselineById.size !== currentState.activePages.length ||
    currentState.activePages.some((page) =>
      baselineById.get(page.pageId)?.proposalDigest !== page.proposalDigest)
  ) invalid(projectId);
}

export interface AtomicAuthorityReplacePortV1 {
  replace(
    expectedGenerationDigest: HierarchySha256Digest | null,
    next: AuthoritativeWikiStateV1,
  ): Promise<void>;
}

export interface ApproveCompileRunInputV1 {
  readonly ledger: CompileRunLedgerV1;
  readonly ownershipGraph: PageOwnershipGraphV1;
  /** Full immutable inputs are replayed so a caller-provided self-hash is never authority. */
  readonly finalization: FinalizeCompileRunInputV1;
  readonly liveSnapshot: CorpusSnapshotV1;
  readonly currentState: AuthoritativeWikiStateV1 | null;
  readonly humanActivationApproval: HumanActivationApprovalV1;
  readonly store: AtomicAuthorityReplacePortV1;
}

export function verifyCompileRunApproval(
  input: Omit<ApproveCompileRunInputV1, 'store'>,
  expectedProjectId: string,
): AuthoritativeWikiStateV1 {
  const { ledger, ownershipGraph, currentState } = input;
  const liveSnapshot = parseCorpusSnapshot(input.liveSnapshot, expectedProjectId);
  const replayedLedger = finalizeCompileRun(input.finalization, expectedProjectId);
  if (!sameCanonical(replayedLedger, ledger)) invalid(expectedProjectId);
  assertCanonicalLedger(ledger, expectedProjectId);
  assertCanonicalOwnershipGraph(ownershipGraph, expectedProjectId);
  if (currentState !== null) assertCanonicalState(currentState, expectedProjectId);
  assertBaselineMatchesCurrentState(input.finalization, currentState, expectedProjectId);
  const humanActivationApproval = verifyHumanActivationApproval(
    input.humanActivationApproval,
    { ledger, ownershipGraph, currentState },
    expectedProjectId,
  );
  if (
    ledger.projectId !== expectedProjectId ||
    ownershipGraph.projectId !== expectedProjectId ||
    liveSnapshot.projectId !== expectedProjectId ||
    !ledger.eligibleForApproval ||
    ledger.status !== 'finalized' ||
    ledger.snapshotDigest !== liveSnapshot.snapshotDigest ||
    ownershipGraph.snapshotDigest !== ledger.snapshotDigest ||
    ownershipGraph.outlineDigest !== ledger.outlineDigest ||
    ownershipGraph.ledgerDigest !== ledger.ledgerDigest ||
    ownershipGraph.receiptSetDigest !== ledger.receiptSetDigest ||
    ownershipGraph.reviewSurfaceDigest !== ledger.reviewSurfaceDigest ||
    ownershipGraph.integratedReviewSetDigest !== ledger.integratedReviewSetDigest ||
    ownershipGraph.childSynthesisReviewSetDigest !== ledger.childSynthesisReviewSetDigest ||
    ownershipGraph.purposeDigest !== liveSnapshot.purposeDigest ||
    ownershipGraph.interpretationRulesDigest !== liveSnapshot.interpretationRulesDigest ||
    ownershipGraph.profileDigest !== liveSnapshot.profileDigest ||
    ownershipGraph.compilerContractDigest !== liveSnapshot.compilerContractDigest ||
    ownershipGraph.sanitizerPolicyDigest !== liveSnapshot.sanitizerPolicyDigest ||
    ownershipGraph.sourceManifestDigest !== liveSnapshot.sourceManifestDigest ||
    ownershipGraph.policyDigest !== liveSnapshot.policyDigest ||
    ownershipGraph.corpusSourceSetDigest !== digestHierarchyValue(liveSnapshot.sources.map(
      (source) => source.sourceId,
    )) ||
    (currentState !== null && currentState.projectId !== expectedProjectId)
  ) invalid(expectedProjectId);
  const replayedOwnershipGraph = createPageOwnershipGraph(
    liveSnapshot,
    input.finalization.outline,
    replayedLedger,
    input.finalization.proposals,
    input.finalization.evidencePacks,
    expectedProjectId,
  );
  if (!sameCanonical(replayedOwnershipGraph, ownershipGraph)) {
    invalid(expectedProjectId);
  }
  const acceptedById = new Map(ledger.candidateDispositions
    .filter((item) => item.decision === 'accepted')
    .map((item) => [item.pageId, item]));
  if (acceptedById.size !== ownershipGraph.pages.length) invalid(expectedProjectId);
  const activePages = Object.freeze(ownershipGraph.pages.map((ownership) => {
    const disposition = acceptedById.get(ownership.pageId);
    if (disposition === undefined || disposition.proposalDigest !== ownership.proposalDigest) {
      invalid(expectedProjectId);
    }
    return Object.freeze({
      pageId: ownership.pageId,
      proposalDigest: ownership.proposalDigest,
      ownershipDigest: ownership.ownershipDigest,
      status: 'active' as const,
    });
  }).sort((left, right) => left.pageId < right.pageId ? -1 : 1));
  const candidate = Object.freeze({
    schemaVersion: AUTHORITATIVE_WIKI_STATE_SCHEMA_VERSION,
    projectId: expectedProjectId,
    snapshotDigest: liveSnapshot.snapshotDigest,
    ledgerDigest: ledger.ledgerDigest,
    ownershipGraphDigest: ownershipGraph.graphDigest,
    receiptSetDigest: ledger.receiptSetDigest,
    reviewSurfaceDigest: ledger.reviewSurfaceDigest,
    integratedReviewSetDigest: ledger.integratedReviewSetDigest,
    childSynthesisReviewSetDigest: ledger.childSynthesisReviewSetDigest,
    humanActivationApprovalDigest: humanActivationApproval.approvalDigest,
    previousGenerationDigest: currentState?.generationDigest ?? null,
    activePages,
    status: 'active' as const,
  });
  const next = Object.freeze({
    ...candidate,
    generationDigest: digestHierarchyValue(stateWithoutDigest(candidate)),
  });
  return next;
}

export async function approveCompileRun(
  input: ApproveCompileRunInputV1,
  expectedProjectId: string,
): Promise<AuthoritativeWikiStateV1> {
  const next = verifyCompileRunApproval(input, expectedProjectId);
  await input.store.replace(input.currentState?.generationDigest ?? null, next);
  return next;
}

export function checkAuthoritativeWikiState(
  state: AuthoritativeWikiStateV1,
  ownershipGraph: PageOwnershipGraphV1,
  liveSnapshotValue: CorpusSnapshotV1,
  humanActivationApproval: HumanActivationApprovalV1,
  expectedProjectId: string,
): AuthoritativeWikiCheckV1 {
  const liveSnapshot = parseCorpusSnapshot(liveSnapshotValue, expectedProjectId);
  assertCanonicalState(state, expectedProjectId);
  assertCanonicalOwnershipGraph(ownershipGraph, expectedProjectId);
  assertCanonicalHumanActivationApproval(humanActivationApproval, expectedProjectId);
  if (
    state.projectId !== expectedProjectId ||
    ownershipGraph.projectId !== expectedProjectId ||
    liveSnapshot.projectId !== expectedProjectId ||
    state.ownershipGraphDigest !== ownershipGraph.graphDigest ||
    state.ledgerDigest !== ownershipGraph.ledgerDigest ||
    state.receiptSetDigest !== ownershipGraph.receiptSetDigest ||
    state.reviewSurfaceDigest !== ownershipGraph.reviewSurfaceDigest ||
    state.integratedReviewSetDigest !== ownershipGraph.integratedReviewSetDigest ||
    state.childSynthesisReviewSetDigest !== ownershipGraph.childSynthesisReviewSetDigest ||
    state.humanActivationApprovalDigest !== humanActivationApproval.approvalDigest ||
    humanActivationApproval.snapshotDigest !== state.snapshotDigest ||
    humanActivationApproval.ledgerDigest !== state.ledgerDigest ||
    humanActivationApproval.ownershipGraphDigest !== state.ownershipGraphDigest ||
    humanActivationApproval.receiptSetDigest !== state.receiptSetDigest ||
    humanActivationApproval.reviewSurfaceDigest !== state.reviewSurfaceDigest ||
    humanActivationApproval.integratedReviewSetDigest !== state.integratedReviewSetDigest ||
    humanActivationApproval.childSynthesisReviewSetDigest !==
      state.childSynthesisReviewSetDigest ||
    humanActivationApproval.previousGenerationDigest !== state.previousGenerationDigest
  ) invalid(expectedProjectId);
  const ownershipById = new Map(ownershipGraph.pages.map((page) => [page.pageId, page]));
  if (
    state.activePages.length !== ownershipGraph.pages.length ||
    state.activePages.some((page) =>
      ownershipById.get(page.pageId)?.ownershipDigest !== page.ownershipDigest)
  ) invalid(expectedProjectId);
  const liveRevisionBySource = new Map(liveSnapshot.sources.map((source) =>
    [source.sourceId, source.sourceRevision]));
  const changedSourceIds = sortedUnique(ownershipGraph.pages.flatMap((page) =>
    page.sourceRevisions
      .filter((source) => liveRevisionBySource.get(source.sourceId) !== source.sourceRevision)
      .map((source) => source.sourceId)), expectedProjectId);
  const changedSources = new Set(changedSourceIds);
  const liveSourceSetDigest = digestHierarchyValue(liveSnapshot.sources.map((source) =>
    source.sourceId));
  const configurationDriftReasonCodes = sortedUnique([
    ...(ownershipGraph.purposeDigest === liveSnapshot.purposeDigest
      ? [] : ['purpose-drift']),
    ...(ownershipGraph.interpretationRulesDigest === liveSnapshot.interpretationRulesDigest
      ? [] : ['interpretation-rules-drift']),
    ...(ownershipGraph.profileDigest === liveSnapshot.profileDigest ? [] : ['profile-drift']),
    ...(ownershipGraph.compilerContractDigest === liveSnapshot.compilerContractDigest
      ? [] : ['compiler-contract-drift']),
    ...(ownershipGraph.sanitizerPolicyDigest === liveSnapshot.sanitizerPolicyDigest
      ? [] : ['sanitizer-policy-drift']),
    ...(ownershipGraph.policyDigest === liveSnapshot.policyDigest ? [] : ['policy-drift']),
    ...(ownershipGraph.corpusSourceSetDigest === liveSourceSetDigest ? [] : ['source-set-drift']),
    ...(ownershipGraph.sourceManifestDigest === liveSnapshot.sourceManifestDigest ||
        changedSourceIds.length > 0 || ownershipGraph.corpusSourceSetDigest !== liveSourceSetDigest
      ? [] : ['source-manifest-drift']),
  ], expectedProjectId);
  const directlyStalePageIds = sortedUnique(ownershipGraph.pages
    .filter((page) => page.sourceRevisions.some((source) =>
      changedSources.has(source.sourceId)))
    .map((page) => page.pageId), expectedProjectId);
  const stale = new Set(directlyStalePageIds);
  if (configurationDriftReasonCodes.length > 0) {
    for (const page of ownershipGraph.pages) stale.add(page.pageId);
  }
  for (const directlyStalePageId of directlyStalePageIds) {
    let parentPageId = ownershipById.get(directlyStalePageId)?.parentPageId ?? null;
    while (parentPageId !== null) {
      if (stale.has(parentPageId)) break;
      stale.add(parentPageId);
      parentPageId = ownershipById.get(parentPageId)?.parentPageId ?? null;
    }
  }
  const stalePageIds = Object.freeze([...stale].sort());
  const unaffectedPageIds = Object.freeze(state.activePages
    .map((page) => page.pageId)
    .filter((pageId) => !stale.has(pageId)).sort());
  const status = stalePageIds.length === 0 ? 'clean' as const : 'stale' as const;
  const candidate = Object.freeze({
    schemaVersion: AUTHORITATIVE_WIKI_CHECK_SCHEMA_VERSION,
    projectId: expectedProjectId,
    generationDigest: state.generationDigest,
    humanActivationApprovalDigest: humanActivationApproval.approvalDigest,
    receiptSetDigest: state.receiptSetDigest,
    reviewSurfaceDigest: state.reviewSurfaceDigest,
    integratedReviewSetDigest: state.integratedReviewSetDigest,
    childSynthesisReviewSetDigest: state.childSynthesisReviewSetDigest,
    liveSnapshotDigest: liveSnapshot.snapshotDigest,
    status,
    changedSourceIds,
    configurationDriftReasonCodes,
    directlyStalePageIds,
    stalePageIds,
    retrievalStalePageIds: stalePageIds,
    unaffectedPageIds,
  });
  return Object.freeze({
    ...candidate,
    checkDigest: digestHierarchyValue(candidate),
  });
}

export interface LegacyWikiPageInputV1 {
  readonly legacyPageId: string;
  readonly legacyPageDigest: HierarchySha256Digest;
  readonly replacementPageId: string | null;
}

export function createLegacyWikiMigration(
  projectId: string,
  legacyPages: readonly LegacyWikiPageInputV1[],
  legacyEmbeddingMarkerPresent: boolean,
  rollbackGenerationDigest: HierarchySha256Digest | null,
): LegacyWikiMigrationV1 {
  if (
    legacyPages.length < 1 ||
    (rollbackGenerationDigest !== null && !DIGEST_PATTERN.test(rollbackGenerationDigest))
  ) invalid(projectId);
  const entries = Object.freeze([...legacyPages]
    .sort((left, right) => left.legacyPageId < right.legacyPageId ? -1 : 1)
    .map((page) => {
      if (
        !PAGE_ID_PATTERN.test(page.legacyPageId) ||
        !DIGEST_PATTERN.test(page.legacyPageDigest) ||
        (page.replacementPageId !== null && !PAGE_ID_PATTERN.test(page.replacementPageId))
      ) invalid(projectId);
      return Object.freeze({
        ...page,
        status: 'quarantined-needs-regeneration' as const,
        replacementReviewRequired: true as const,
        automaticDeletionAllowed: false as const,
        automaticOverwriteAllowed: false as const,
        automaticActivationAllowed: false as const,
      });
    }));
  if (new Set(entries.map((entry) => entry.legacyPageId)).size !== entries.length) {
    invalid(projectId);
  }
  const candidate = Object.freeze({
    schemaVersion: LEGACY_WIKI_MIGRATION_SCHEMA_VERSION,
    projectId,
    entries,
    legacyEmbeddingMarkerAction: legacyEmbeddingMarkerPresent
      ? 'retain-quarantined' as const
      : 'absent' as const,
    rollbackGenerationDigest,
    explicitActivationRequired: true as const,
  });
  return Object.freeze({
    ...candidate,
    migrationDigest: digestHierarchyValue(candidate),
  });
}

function migrationWithoutDigest(
  migration: Omit<LegacyWikiMigrationV1, 'migrationDigest'>,
): Readonly<Record<string, unknown>> {
  const { migrationDigest, ...basis } = migration as LegacyWikiMigrationV1;
  void migrationDigest;
  return basis;
}

function assertCanonicalMigration(
  migration: LegacyWikiMigrationV1,
  projectId: string,
): void {
  const pageIds = migration.entries.map((entry) => entry.legacyPageId);
  if (
    migration.schemaVersion !== LEGACY_WIKI_MIGRATION_SCHEMA_VERSION ||
    migration.projectId !== projectId ||
    migration.entries.length < 1 ||
    !sameStrings(pageIds, [...pageIds].sort()) ||
    new Set(pageIds).size !== pageIds.length ||
    migration.entries.some((entry) =>
      !PAGE_ID_PATTERN.test(entry.legacyPageId) ||
      !DIGEST_PATTERN.test(entry.legacyPageDigest) ||
      (entry.replacementPageId !== null && !PAGE_ID_PATTERN.test(entry.replacementPageId)) ||
      entry.status !== 'quarantined-needs-regeneration' ||
      entry.replacementReviewRequired !== true ||
      entry.automaticDeletionAllowed !== false ||
      entry.automaticOverwriteAllowed !== false ||
      entry.automaticActivationAllowed !== false) ||
    (migration.legacyEmbeddingMarkerAction !== 'absent' &&
      migration.legacyEmbeddingMarkerAction !== 'retain-quarantined') ||
    (migration.rollbackGenerationDigest !== null &&
      !DIGEST_PATTERN.test(migration.rollbackGenerationDigest)) ||
    migration.explicitActivationRequired !== true ||
    migration.migrationDigest !== digestHierarchyValue(migrationWithoutDigest(migration))
  ) invalid(projectId);
}

export interface LegacyWikiMigrationReviewDecisionInputV1 {
  readonly legacyPageId: string;
  readonly decision: 'accepted' | 'deferred';
}

export function createLegacyWikiMigrationReview(
  migration: LegacyWikiMigrationV1,
  ledger: CompileRunLedgerV1,
  decisions: readonly LegacyWikiMigrationReviewDecisionInputV1[],
  expectedProjectId: string,
): LegacyWikiMigrationReviewV1 {
  assertCanonicalMigration(migration, expectedProjectId);
  assertCanonicalLedger(ledger, expectedProjectId);
  const decisionByPageId = new Map(decisions.map((decision) =>
    [decision.legacyPageId, decision.decision]));
  if (
    !ledger.eligibleForApproval ||
    decisionByPageId.size !== decisions.length ||
    decisionByPageId.size !== migration.entries.length
  ) invalid(expectedProjectId);
  const entries = Object.freeze(migration.entries.map((entry) => {
    const decision = decisionByPageId.get(entry.legacyPageId);
    if (
      decision === undefined ||
      (entry.replacementPageId === null && decision !== 'deferred') ||
      (entry.replacementPageId !== null && decision !== 'accepted')
    ) invalid(expectedProjectId);
    return Object.freeze({
      legacyPageId: entry.legacyPageId,
      legacyPageDigest: entry.legacyPageDigest,
      replacementPageId: entry.replacementPageId,
      decision,
    });
  }));
  const candidate = Object.freeze({
    schemaVersion: LEGACY_WIKI_MIGRATION_REVIEW_SCHEMA_VERSION,
    projectId: expectedProjectId,
    migrationDigest: migration.migrationDigest,
    replacementLedgerDigest: ledger.ledgerDigest,
    entries,
    decision: 'approved' as const,
  });
  return Object.freeze({ ...candidate, reviewDigest: digestHierarchyValue(candidate) });
}

function reviewWithoutDigest(
  review: Omit<LegacyWikiMigrationReviewV1, 'reviewDigest'>,
): Readonly<Record<string, unknown>> {
  const { reviewDigest, ...basis } = review as LegacyWikiMigrationReviewV1;
  void reviewDigest;
  return basis;
}

function assertCanonicalMigrationReview(
  review: LegacyWikiMigrationReviewV1,
  migration: LegacyWikiMigrationV1,
  ledger: CompileRunLedgerV1,
  projectId: string,
): void {
  if (
    review.schemaVersion !== LEGACY_WIKI_MIGRATION_REVIEW_SCHEMA_VERSION ||
    review.projectId !== projectId ||
    review.migrationDigest !== migration.migrationDigest ||
    review.replacementLedgerDigest !== ledger.ledgerDigest ||
    review.decision !== 'approved' ||
    review.entries.length !== migration.entries.length ||
    review.reviewDigest !== digestHierarchyValue(reviewWithoutDigest(review)) ||
    review.entries.some((entry, index) => {
      const migrationEntry = migration.entries[index];
      return migrationEntry === undefined ||
        entry.legacyPageId !== migrationEntry.legacyPageId ||
        entry.legacyPageDigest !== migrationEntry.legacyPageDigest ||
        entry.replacementPageId !== migrationEntry.replacementPageId ||
        (entry.replacementPageId === null
          ? entry.decision !== 'deferred'
          : entry.decision !== 'accepted');
    })
  ) invalid(projectId);
}

export interface AtomicLegacyMigrationActivationPortV1 {
  activate(
    expectedGenerationDigest: HierarchySha256Digest | null,
    migration: LegacyWikiMigrationV1,
    review: LegacyWikiMigrationReviewV1,
    next: AuthoritativeWikiStateV1,
  ): Promise<void>;
}

export interface ActivateLegacyWikiMigrationInputV1 extends
  Omit<ApproveCompileRunInputV1, 'store'> {
  readonly migration: LegacyWikiMigrationV1;
  readonly review: LegacyWikiMigrationReviewV1;
  readonly store: AtomicLegacyMigrationActivationPortV1;
}

export async function activateLegacyWikiMigration(
  input: ActivateLegacyWikiMigrationInputV1,
  expectedProjectId: string,
): Promise<AuthoritativeWikiStateV1> {
  const next = verifyCompileRunApproval(input, expectedProjectId);
  assertCanonicalMigration(input.migration, expectedProjectId);
  assertCanonicalMigrationReview(
    input.review,
    input.migration,
    input.ledger,
    expectedProjectId,
  );
  const previousGenerationDigest = input.currentState?.generationDigest ?? null;
  const activePageIds = new Set(next.activePages.map((page) => page.pageId));
  if (
    input.migration.rollbackGenerationDigest !== previousGenerationDigest ||
    next.previousGenerationDigest !== previousGenerationDigest ||
    input.review.entries.some((entry) =>
      entry.decision === 'accepted' &&
      (entry.replacementPageId === null || !activePageIds.has(entry.replacementPageId)))
  ) invalid(expectedProjectId);
  await input.store.activate(
    previousGenerationDigest,
    input.migration,
    input.review,
    next,
  );
  return next;
}
