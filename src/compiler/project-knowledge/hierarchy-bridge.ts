import { createProjectSecurityService } from '../../sanitizer/index.js';
import { compare, invalid, sha256 } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeEvidenceV1, KnowledgeGenerationV1, KnowledgePageV1,
  KnowledgePageRole } from '../../knowledge/project-knowledge/types.js';
import {
  HIERARCHICAL_COMPILATION_POLICY, advanceCompileContinuation, approveChildSummaryForSynthesis,
  digestHierarchyValue as digest,
  buildSparseRelationGraph, createCompilationPurpose, createCompileCandidateReview,
  createCompileIntegrityReport, createCompileRelationReview, createCorpusSnapshot,
  createCurrentSessionGenerationService, createEvidencePack, createIntegratedWikiCandidateReview,
  createIntegratedWikiReviewSurface, createTextUnit, evaluateSemanticQuality,
  finalizePlanningDispositionInventory, reconcileWikiProposalLinks, startCompileContinuation,
  type ApprovedChildSummaryV1, type CompileCandidateReviewV1, type CompilePartitionV2,
  type CorpusSnapshotV1, type CurrentSessionGenerationHandoffV1, type EvidencePackV1,
  type FinalizeCompileRunInputV1, type HierarchicalWikiProposalV1, type PageBlueprintV1,
  type SanitizedEvidenceSourceV1, type TextUnitV1, type WikiOutlineV1,
} from '../hierarchy/index.js';
import { isSanitizedKnowledgeGeneration } from './session.js';

const ROLES = ['architecture', 'decisions', 'overview'] as const;
const BRIDGE_CONTRACT = digest({ schemaVersion: 'buildlore.knowledge-hierarchy-bridge.v1',
  sourceUnit: 'exact-sanitized-evidence-excerpt', parent: 'overview', roles: ROLES });

export class KnowledgeHierarchyQualityError extends Error {
  readonly code = 'KNOWLEDGE_HIERARCHY_QUALITY_REQUIRED';
  readonly reasonCodes: readonly string[];

  constructor(reasonCodes: readonly string[]) {
    const codes = [...new Set(reasonCodes)].sort();
    super(`Project knowledge hierarchy quality checks failed: ${codes.join(', ')}.` +
      (codes.includes('claim-evidence-unsupported') ? ' Inspect claim overlap with inspectKnowledgeProposalGrounding; lexical overlap is not a semantic review.' : ''));
    this.name = 'KnowledgeHierarchyQualityError';
    this.reasonCodes = Object.freeze(codes);
  }
}

export interface KnowledgeHierarchyMappingV1 {
  readonly role: KnowledgePageRole;
  readonly pageId: string;
  readonly claims: readonly Readonly<{ claimId: string; hierarchyClaimId: string; factIds: readonly KnowledgeDigest[] }>[];
}

export interface KnowledgeHierarchyBridgeV1 {
  readonly finalization: FinalizeCompileRunInputV1;
  readonly snapshot: CorpusSnapshotV1;
  readonly pageMappings: readonly KnowledgeHierarchyMappingV1[];
  readonly evidenceMappings: readonly Readonly<{ evidenceId: KnowledgeDigest; unitId: string; citationId: string }>[];
}

export function knowledgeHierarchySummary(page: KnowledgePageV1): string {
  const claim = page.sections[0]?.claims[0];
  if (!claim) invalid();
  return `${claim.presentation === 'current' ? '' : `[${claim.presentation}] `}${claim.text}`;
}

/** Pure prose mapping is replayed at the authority read boundary as well as authoring. */
export function knowledgeHierarchySections(page: KnowledgePageV1,
  claims: readonly Readonly<{ citationIds: readonly string[] }>[],
  children: readonly ApprovedChildSummaryV1[], links: readonly string[],
): HierarchicalWikiProposalV1['sections'] {
  let offset = 0;
  const sections = page.sections.map((section, index) => ({ sectionId: `knowledge-${String(index)}`, title: section.title,
    body: section.claims.map((claim) => {
      const linked = claims[offset++];
      if (!linked) invalid();
      return `${claim.presentation === 'current' ? '' : `[${claim.presentation}] `}${claim.text} ` +
        linked.citationIds.map((id) => `[^${id}]`).join(' ');
    }).join('\n\n') }));
  const first = sections[0];
  if (!first || offset !== claims.length) invalid();
  const childBody = children.map((child) => `${child.summary} ${child.citationIds.map((id) => `[^${id}]`).join(' ')}`).join(' ');
  sections[0] = { ...first, body: [first.body, childBody, links.map((id) => `[[${id}]]`).join(' ')].filter(Boolean).join(' ') };
  return sections;
}

/** Purpose identity binds the entire reviewed knowledge generation into the existing ledger. */
export function knowledgeHierarchyPurpose(generation: KnowledgeGenerationV1): ReturnType<typeof createCompilationPurpose> {
  return createCompilationPurpose({ projectId: generation.projectId, audience: ['Project development agents'],
    goals: [`Use reviewed project knowledge ${generation.generationDigest}`],
    keyQuestions: generation.pages.map((p) => p.title), scopeHints: ['Evidence-bound project knowledge'],
    excludedTopics: ['Unproven current implementation or verification'], outputLanguage: 'und',
    requestedPageRoles: ['overview', 'topic'] });
}

function evidenceSourceId(projectId: string, evidence: KnowledgeEvidenceV1): string {
  return `source-${digest({ projectId, evidenceId: evidence.evidenceId }).slice(7)}`;
}

function evidenceUnit(generation: KnowledgeGenerationV1, evidence: KnowledgeEvidenceV1): TextUnitV1 {
  const lines = evidence.excerpt.split('\n');
  const range = { startLine: 1, startColumn: 1, endLine: lines.length,
    endColumn: [...(lines.at(-1) ?? '')].length };
  if (range.endColumn === 0) invalid();
  const originRange = evidence.origin?.range ?? (evidence.locator.kind === 'lines'
    ? { ...range, startLine: evidence.locator.start, endLine: evidence.locator.end } : range);
  const pointer = evidence.origin?.jsonPointer ?? (evidence.locator.kind === 'json-pointer' ? evidence.locator.pointer : undefined);
  return createTextUnit({ projectId: generation.projectId, sourceId: evidenceSourceId(generation.projectId, evidence),
    sourceRevision: evidence.sourceContentDigest, sourceRef: evidence.sourceRef, kind: 'paragraph', ordinal: 0,
    range, contentDigest: evidence.excerptDigest,
    origin: { range: originRange, sourceRef: evidence.origin?.sourceRef ?? evidence.sourceRef },
    ...(pointer === undefined ? {} : { jsonPointer: pointer }) });
}

/** Deterministic source/locator projection used again when reading a tracked authority. */
export function knowledgeHierarchySnapshot(generation: KnowledgeGenerationV1): CorpusSnapshotV1 {
  return createCorpusSnapshot({ projectId: generation.projectId,
    purposeDigest: knowledgeHierarchyPurpose(generation).purposeDigest,
    interpretationRulesDigest: BRIDGE_CONTRACT, compilerContractDigest: BRIDGE_CONTRACT,
    profileDigest: BRIDGE_CONTRACT, policyDigest: HIERARCHICAL_COMPILATION_POLICY.policyDigest,
    sanitizerPolicyDigest: generation.snapshot.sanitizerPolicyDigest,
    sourceManifestDigest: generation.snapshot.snapshotDigest,
    sources: generation.evidence.map((e) => ({ sourceId: evidenceSourceId(generation.projectId, e), sourceRef: e.sourceRef,
      sourceRevision: e.sourceContentDigest, sanitizedContentDigest: e.excerptDigest })),
    textUnits: generation.evidence.map((e) => evidenceUnit(generation, e)) });
}

/** Reuses real sanitizer handles, session receipts, structural quality and finalization.
 * This is a projection of reviewed AI text, not a new generation or a semantic reviewer.
 * It does not approve or persist an authority.
 */
export async function bridgeKnowledgeToHierarchy(input: Readonly<{
  knowledgeRoot: string;
  generation: KnowledgeGenerationV1;
  baselineGenerationDigest: KnowledgeDigest | null;
  baselineProposals: readonly HierarchicalWikiProposalV1[];
}>): Promise<KnowledgeHierarchyBridgeV1> {
  const { generation } = input;
  if (!isSanitizedKnowledgeGeneration(generation)) invalid();
  const projectId = generation.projectId;
  const purpose = knowledgeHierarchyPurpose(generation);
  const textUnits = generation.evidence.map((e) => evidenceUnit(generation, e));
  const snapshot = knowledgeHierarchySnapshot(generation);
  const graph = buildSparseRelationGraph(snapshot, projectId);
  const pageId = (role: KnowledgePageRole): string => `page-${digest({ projectId, purposeDigest: purpose.purposeDigest,
    stableKey: `knowledge.${role}` }).slice(7)}`;
  const facts = new Map(generation.records.map((f) => [f.id, f]));
  const evidenceIdsFor = (factIds: readonly KnowledgeDigest[]): readonly KnowledgeDigest[] =>
    [...new Set(factIds.flatMap((id) => facts.get(id)?.evidenceIds ?? invalid()))].sort();
  const unitByEvidence = new Map(generation.evidence.map((e, index) => [e.evidenceId, textUnits[index]]));
  const blueprints: readonly PageBlueprintV1[] = ROLES.map((role, order) => {
    const page = generation.pages.find((p) => p.role === role);
    if (!page) return invalid();
    // The existing hierarchy declares a complete source coverage scope at leaves;
    // the actual pack below still contains only evidence used by this page's claims.
    const sourceIds = snapshot.sources.map((s) => s.sourceId).sort();
    const basis = { schemaVersion: 'buildlore.page-blueprint.v2' as const, projectId,
      pageId: pageId(role), stableKey: `knowledge.${role}`, role: role === 'overview' ? 'overview' as const : 'topic' as const,
      title: page.title, parentPageId: role === 'overview' ? null : pageId('overview'),
      childPageIds: role === 'overview' ? [pageId('architecture'), pageId('decisions')].sort() : [],
      relatedPageIds: [], keyQuestions: [page.title], requiredSections: page.sections.map((_, i) => `knowledge-${String(i)}`),
      evidenceScope: { snapshotDigest: snapshot.snapshotDigest, taskSetDigest: graph.taskSetDigest,
        relationSetDigest: graph.relationSetDigest,
        allowedUnitKinds: ['document', 'fenced-code', 'heading', 'list', 'paragraph', 'table'] as const,
        sourceIds, preferredUnitIds: [] }, minimumDistinctSources: 1, generationOrder: order };
    return Object.freeze({ ...basis, blueprintDigest: digest(basis) });
  });
  const outlineBasis = { schemaVersion: 'buildlore.wiki-outline.v2' as const, projectId,
    snapshotDigest: snapshot.snapshotDigest, graphDigest: graph.graphDigest,
    interpretationSetDigest: digest({ generationDigest: generation.generationDigest }),
    purposeDigest: purpose.purposeDigest, policyDigest: snapshot.policyDigest,
    activationState: 'candidate' as const, rootPageId: pageId('overview'), blueprints, reviewNotes: [] };
  const outline: WikiOutlineV1 = { ...outlineBasis, outlineDigest: digest(outlineBasis) };
  let continuation = startCompileContinuation(graph, 256, projectId);
  const partitions: CompilePartitionV2[] = [];
  while (!continuation.complete) {
    if (continuation.nextCursor === null) invalid();
    const step = advanceCompileContinuation(graph, continuation, continuation.nextCursor, projectId);
    partitions.push(step.partition);
    continuation = step.continuation;
  }
  const planningInventory = finalizePlanningDispositionInventory(graph, continuation, partitions, projectId);
  const security = createProjectSecurityService({ knowledgeRoot: input.knowledgeRoot });
  const sources: SanitizedEvidenceSourceV1[] = [];
  for (const e of generation.evidence) {
    const result = await security.prepareSource({ projectId, body: e.excerpt, bodyDigest: sha256(e.excerpt),
      source: e.sourceRef, sourceKind: 'markdown', sourceRevisionOrContentSha256: e.sourceContentDigest });
    if (!result.ok || result.report.outputDigest !== e.excerptDigest || result.report.policyDigest !== snapshot.sanitizerPolicyDigest) invalid();
    sources.push({ sourceId: evidenceSourceId(projectId, e), sourceRef: e.sourceRef,
      sourceRevision: e.sourceContentDigest, preparedSource: result.prepared });
  }
  const packs: EvidencePackV1[] = [];
  const handoffs: CurrentSessionGenerationHandoffV1[] = [];
  const proposals: HierarchicalWikiProposalV1[] = [];
  const childSummaries: ApprovedChildSummaryV1[] = [];
  const childReviews: CompileCandidateReviewV1[] = [];
  const pageMappings: KnowledgeHierarchyMappingV1[] = [];
  const evidenceMappings = new Map<KnowledgeDigest, Readonly<{ evidenceId: KnowledgeDigest; unitId: string; citationId: string }>>();
  const service = createCurrentSessionGenerationService({ knowledgeRoot: input.knowledgeRoot });
  for (const blueprint of blueprints) {
    const role = ROLES[blueprint.generationOrder];
    const page = generation.pages.find((p) => p.role === role);
    if (!role || !page) invalid();
    const selectedIds = new Set(evidenceIdsFor(page.sections.flatMap((s) => s.claims.flatMap((c) => c.factIds)))
      .map((id) => unitByEvidence.get(id)?.unitId ?? invalid()));
    const selectedSourceIds = new Set(snapshot.textUnits.filter((u) => selectedIds.has(u.unitId)).map((u) => u.sourceId));
    const pack = createEvidencePack({ blueprint, snapshot,
      sources: sources.filter((s) => selectedSourceIds.has(s.sourceId)),
      selectedUnitIds: [...selectedIds],
      conflicts: [], gaps: [] }, projectId);
    packs.push(pack);
    for (const e of generation.evidence) {
      const unit = pack.units.find((u) => u.unitId === unitByEvidence.get(e.evidenceId)?.unitId);
      if (unit) evidenceMappings.set(e.evidenceId, { evidenceId: e.evidenceId, unitId: unit.unitId, citationId: unit.citation.citationId });
    }
    const session = await service.prepare({ purpose, blueprint, evidencePack: pack,
      approvedChildSummaries: role === 'overview' ? childSummaries : [] }, projectId);
    const claims = page.sections.flatMap((s) => s.claims).map((claim) => {
      const ids = evidenceIdsFor(claim.factIds);
      const units = ids.map((id) => pack.units.find((u) => u.unitId === unitByEvidence.get(id)?.unitId) ?? invalid());
      return { text: claim.text, evidenceUnitIds: units.map((u) => u.unitId).sort(),
        citationIds: units.map((u) => u.citation.citationId).sort() };
    });
    // Existing hierarchy requires reviewed child summaries in the parent. These
    // summaries are exact accepted child claims, never newly authored boilerplate.
    const requiredLinks = session.exchange.request.requiredLinkPageIds;
    const sections = knowledgeHierarchySections(page, claims, role === 'overview' ? childSummaries : [], requiredLinks);
    const result = await session.submit({ schemaVersion: 'buildlore.current-session-proposal-submission.v2',
      projectId, pageId: blueprint.pageId, exchangeDigest: session.exchange.exchangeDigest,
      requestDigest: session.exchange.requestDigest, title: page.title, summary: knowledgeHierarchySummary(page),
      sections, claims, wikilinks: requiredLinks });
    handoffs.push({ exchange: session.exchange, result });
    proposals.push(result.proposal);
    pageMappings.push({ role, pageId: blueprint.pageId,
      claims: page.sections.flatMap((s) => s.claims).map((claim, index) => ({ claimId: claim.claimId,
        hierarchyClaimId: result.proposal.claims.find((c) => c.claimId === `claim-${digest(claims[index]).slice(7)}`)?.claimId ?? invalid(),
        factIds: claim.factIds })) });
    if (role !== 'overview') {
      const review = createCompileCandidateReview(result.proposal, 'accepted', projectId);
      childReviews.push(review);
      childSummaries.push(approveChildSummaryForSynthesis(result.proposal, review, projectId));
    }
  }
  const reconciliation = reconcileWikiProposalLinks(outline, proposals, projectId);
  const quality = evaluateSemanticQuality({ outline, proposals, evidencePacks: packs, reconciliation }, projectId);
  if (!quality.corpus.hardQualityPassed || quality.pages.some((p) => !p.hardQualityPassed)) {
    throw new KnowledgeHierarchyQualityError([...quality.corpus.reasonCodes, ...quality.pages.flatMap((p) => p.reasonCodes)]);
  }
  const integratedReviewSurface = createIntegratedWikiReviewSurface({ graph, outline, planningInventory,
    generations: handoffs, reconciliation, baselineGenerationDigest: input.baselineGenerationDigest,
    baselineProposals: input.baselineProposals }, projectId);
  const integrityInput = { graph, outline, planningInventory, partitions, proposals, evidencePacks: packs,
    pageQualityReports: quality.pages, corpusQualityReport: quality.corpus, reconciliation,
    generationHandoffs: handoffs, baselineGenerationDigest: input.baselineGenerationDigest,
    baselineProposals: input.baselineProposals, integratedReviewSurface,
    integratedReviews: integratedReviewSurface.candidates.map((c) => createIntegratedWikiCandidateReview(
      integratedReviewSurface, c.pageId, 'accepted', input.baselineProposals.length > 0 ? ['baseline-page-removal-reviewed'] : [], projectId)),
    childSynthesisReviews: childReviews,
    relationReviews: graph.relations.map((r) => createCompileRelationReview(r.relationId, 'accepted', projectId)) };
  return Object.freeze({ snapshot, finalization: { ...integrityInput,
    integrityReport: createCompileIntegrityReport(integrityInput, projectId) },
    pageMappings, evidenceMappings: [...evidenceMappings.values()].sort((a, b) => compare(a.evidenceId, b.evidenceId)) });
}
