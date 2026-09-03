import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import {
  digestHierarchyValue,
  hierarchySha256,
} from './contracts.js';
import {
  citationIdsForProposalSummary,
  reconcileWikiProposalLinks,
} from './evidence.js';
import {
  verifyCurrentSessionGenerationResult,
  type CurrentSessionGenerationExchangeV1,
  type CurrentSessionGenerationResultV1,
} from './current-session.js';
import { HierarchyContractError } from './errors.js';
import {
  parsePlanningDispositionInventory,
  parseSparseRelationGraph,
} from './planning.js';
import { hierarchySurfaceTokens, hierarchyTokens } from './tokens.js';
import {
  CORPUS_QUALITY_REPORT_SCHEMA_VERSION,
  INTEGRATED_WIKI_CANDIDATE_REVIEW_SCHEMA_VERSION,
  INTEGRATED_WIKI_REVIEW_SURFACE_SCHEMA_VERSION,
  PAGE_BLUEPRINT_SCHEMA_VERSION,
  PAGE_QUALITY_REPORT_SCHEMA_VERSION,
  SEMANTIC_QUALITY_POLICY_SCHEMA_VERSION,
  HIERARCHICAL_WIKI_PROPOSAL_SCHEMA_VERSION,
  WIKI_OUTLINE_SCHEMA_VERSION,
  WIKI_CONTENT_DIFF_SCHEMA_VERSION,
  type CorpusQualityReportV1,
  type EvidenceCitationAnchorV1,
  type EvidencePackV1,
  type HierarchicalWikiProposalV1,
  type HierarchySha256Digest,
  type IntegratedWikiCandidateReviewDecision,
  type IntegratedWikiCandidateReviewV1,
  type IntegratedWikiReviewCandidateV1,
  type IntegratedWikiReviewCoverageV1,
  type IntegratedWikiReviewSurfaceV1,
  type PageBlueprintV1,
  type PageQualityReportV1,
  type PlanningDispositionInventoryV1,
  type RemovedBaselineWikiPageV1,
  type SemanticQualityEvaluationV1,
  type SemanticQualityPolicyV1,
  type SparseRelationGraphV1,
  type WikiContentDiffV1,
  type WikiLinkReconciliationV1,
  type WikiOutlineV1,
} from './types.js';

const PAGE_ID_PATTERN = /^page-[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CLAIM_ID_PATTERN = /^claim-[a-f0-9]{64}$/u;
const UNIT_ID_PATTERN = /^unit-[a-f0-9]{64}$/u;
const CITATION_ID_PATTERN = /^citation-[a-f0-9]{64}$/u;
const PORTABLE_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const REASON_CODE_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const LEGACY_HIERARCHICAL_WIKI_PROPOSAL_SCHEMA_VERSION =
  'buildlore.hierarchical-wiki-proposal.v1';
const BASELINE_PAGE_REMOVAL_REQUIRES_REVIEW_REASON_CODE =
  'baseline-page-removal-requires-review';
export const BASELINE_PAGE_REMOVAL_REVIEW_REASON_CODE =
  'baseline-page-removal-reviewed';
const ISSUED_INTEGRATED_REVIEW_SURFACES = new WeakSet<object>();
const MAX_INTEGRATED_REVIEW_SURFACE_BYTES = 33_554_432;
const ALL_TEXT_UNIT_KINDS = Object.freeze([
  'document', 'fenced-code', 'heading', 'list', 'paragraph', 'table',
] as const);
const CITATION_PATTERN = /citation-[a-f0-9]{64}/gu;
const PAGE_PATTERN = /page-[a-f0-9]{64}/gu;
const FILE_LINE_PATTERN = /^(?:[-*]\s*)?(?:(?:[A-Za-z0-9._ -]+\/)+[A-Za-z0-9._ -]+|[A-Za-z0-9_.-]+)\.[A-Za-z0-9]{1,16}$/u;
const QUESTION_STOP_WORDS = new Set([
  'a', 'an', 'are', 'does', 'how', 'is', 'the', 'this', 'what', 'when', 'where', 'which',
  'who', 'why', '어떻게', '무엇', '무엇인가', '어디', '언제', '왜', '어떤', '하는가',
]);

const thresholds = Object.freeze({
  minimumSectionCoverageBasisPoints: 10_000,
  minimumClaimGroundingBasisPoints: 10_000,
  minimumClaimEvidenceSupportBasisPoints: 10_000,
  minimumClaimTokenOverlapBasisPoints: 2_500,
  minimumSummaryTokenOverlapBasisPoints: 5_000,
  minimumTitleTokenOverlapBasisPoints: 6_000,
  minimumQuestionCoverageBasisPoints: 10_000,
  maximumRepeatedLineBasisPoints: 5_000,
  maximumNearDuplicateBasisPoints: 8_500,
  maximumOrphanBasisPoints: 500,
  maximumUncategorizedPages: 0,
  maximumUnresolvedConflicts: 0,
  maximumOptionalSections: 8,
  minimumSubstantiveUtf8Bytes: 80,
  minimumUniqueTokens: 8,
} as const);

export const SEMANTIC_QUALITY_POLICY: SemanticQualityPolicyV1 = Object.freeze({
  schemaVersion: SEMANTIC_QUALITY_POLICY_SCHEMA_VERSION,
  thresholds,
  policyDigest: digestHierarchyValue({
    schemaVersion: SEMANTIC_QUALITY_POLICY_SCHEMA_VERSION,
    thresholds,
  }),
});

function invalid(projectId: string): never {
  throw new HierarchyContractError(projectId);
}

function basisPoints(numerator: number, denominator: number): number {
  if (denominator === 0) return 10_000;
  return Math.floor(numerator * 10_000 / denominator);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function normalizedText(value: string): string {
  return hierarchyTokens(value
    .replace(CITATION_PATTERN, ' citation ')
    .replace(PAGE_PATTERN, ' page ')).join(' ');
}

function tokens(value: string): readonly string[] {
  return hierarchyTokens(value
    .replace(CITATION_PATTERN, ' citation ')
    .replace(PAGE_PATTERN, ' page '));
}

function tokenWeight(token: string): number {
  return /\p{N}/u.test(token) || [...token].length >= 8 ? 2 : 1;
}

function weightedCoverageBasisPoints(
  expectedTokens: readonly string[],
  observedTokens: ReadonlySet<string>,
): number {
  const uniqueExpected = [...new Set(expectedTokens)];
  const denominator = uniqueExpected.reduce((sum, token) => sum + tokenWeight(token), 0);
  const numerator = uniqueExpected.filter((token) => observedTokens.has(token))
    .reduce((sum, token) => sum + tokenWeight(token), 0);
  return basisPoints(numerator, denominator);
}

function answersQuestion(question: string, bodyTokenSet: ReadonlySet<string>): boolean {
  const significant = [...new Set(tokens(question).filter((token) =>
    !QUESTION_STOP_WORDS.has(token)))];
  if (significant.length === 0) return false;
  const requiredMatches = Math.min(2, significant.length);
  return significant.filter((token) => bodyTokenSet.has(token)).length >= requiredMatches;
}

function normalizedLines(proposal: HierarchicalWikiProposalV1): readonly string[] {
  return proposal.sections.flatMap((section) => section.body.split('\n'))
    .map(normalizedText)
    .filter((line) => line.length > 0);
}

function jaccardBasisPoints(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 10_000;
  let intersection = 0;
  for (const token of leftSet) if (rightSet.has(token)) intersection += 1;
  return basisPoints(intersection, union.size);
}

function evidenceSupportBasisPoints(
  claimText: string,
  evidenceContents: readonly string[],
): number {
  const claimTokens = [...new Set(tokens(claimText).filter((token) =>
    !QUESTION_STOP_WORDS.has(token)))];
  if (claimTokens.length === 0) return 0;
  const evidenceTokens = new Set(evidenceContents.flatMap((content) => [...tokens(content)]));
  return weightedCoverageBasisPoints(claimTokens, evidenceTokens);
}

function genericBlueprintTitle(blueprint: PageBlueprintV1): boolean {
  const genericTokens = new Set([
    'additional', 'evidence', 'group', 'overview', 'reference', 'role', 'root', 'topic',
  ]);
  const titleTokens = [...new Set(tokens(blueprint.title))];
  return titleTokens.length === 0 ||
    normalizedText(blueprint.title) === normalizedText(blueprint.role) ||
    titleTokens.every((token) => genericTokens.has(token));
}

function markdownParagraphs(body: string): readonly string[] {
  return Object.freeze(body.split(/\n[\t ]*\n/gu)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0));
}

function requiredLinks(blueprint: PageBlueprintV1): readonly string[] {
  return Object.freeze([...new Set([
    ...(blueprint.parentPageId === null ? [] : [blueprint.parentPageId]),
    ...blueprint.childPageIds,
    ...blueprint.relatedPageIds,
  ])].sort());
}

function renderedBodyMarkers(body: string): Readonly<{
  readonly citationIds: readonly string[];
  readonly linkPageIds: readonly string[];
}> {
  const citationIds = new Set<string>();
  const linkPageIds = new Set<string>();
  let fence: Readonly<{ readonly character: '`' | '~'; readonly length: number }> | null = null;
  for (const line of body.split('\n')) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fenceMatch !== undefined) {
      const character = fenceMatch[0] as '`' | '~';
      if (fence === null) fence = Object.freeze({ character, length: fenceMatch.length });
      else if (fence.character === character && fenceMatch.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    for (const match of line.matchAll(/(?<!\\)\[\^(citation-[a-f0-9]{64})\]/gu)) {
      if (match[1] !== undefined) citationIds.add(match[1]);
    }
    for (const match of line.matchAll(/(?<!\\)\[\[(page-[a-f0-9]{64})\]\]/gu)) {
      if (match[1] !== undefined) linkPageIds.add(match[1]);
    }
  }
  return Object.freeze({
    citationIds: Object.freeze([...citationIds].sort()),
    linkPageIds: Object.freeze([...linkPageIds].sort()),
  });
}

function exactKeys(value: object, expected: readonly string[], projectId: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (!sameStrings(actual, canonical)) invalid(projectId);
}

function blueprintBasis(blueprint: PageBlueprintV1): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: blueprint.schemaVersion,
    projectId: blueprint.projectId,
    pageId: blueprint.pageId,
    stableKey: blueprint.stableKey,
    role: blueprint.role,
    title: blueprint.title,
    parentPageId: blueprint.parentPageId,
    childPageIds: blueprint.childPageIds,
    relatedPageIds: blueprint.relatedPageIds,
    keyQuestions: blueprint.keyQuestions,
    requiredSections: blueprint.requiredSections,
    evidenceScope: blueprint.evidenceScope,
    minimumDistinctSources: blueprint.minimumDistinctSources,
    generationOrder: blueprint.generationOrder,
  };
}

function packBasis(pack: EvidencePackV1): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: pack.schemaVersion,
    projectId: pack.projectId,
    pageId: pack.pageId,
    blueprintDigest: pack.blueprintDigest,
    snapshotDigest: pack.snapshotDigest,
    sanitizerPolicyDigest: pack.sanitizerPolicyDigest,
    units: pack.units,
    conflicts: pack.conflicts,
    gaps: pack.gaps,
    evidenceBytes: pack.evidenceBytes,
  };
}

function proposalBasis(proposal: HierarchicalWikiProposalV1): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: proposal.schemaVersion,
    projectId: proposal.projectId,
    pageId: proposal.pageId,
    blueprintDigest: proposal.blueprintDigest,
    evidencePackDigest: proposal.evidencePackDigest,
    requestDigest: proposal.requestDigest,
    title: proposal.title,
    summary: proposal.summary,
    sections: proposal.sections,
    claims: proposal.claims,
    wikilinks: proposal.wikilinks,
    citationIds: proposal.citationIds,
    lifecycle: proposal.lifecycle,
  };
}

function assertCanonicalBlueprint(blueprint: PageBlueprintV1, projectId: string): void {
  exactKeys(blueprint, [
    'blueprintDigest', 'childPageIds', 'evidenceScope', 'generationOrder', 'keyQuestions',
    'minimumDistinctSources', 'pageId', 'parentPageId', 'projectId', 'relatedPageIds',
    'requiredSections', 'role', 'schemaVersion', 'stableKey', 'title',
  ], projectId);
  if (
    blueprint.schemaVersion !== PAGE_BLUEPRINT_SCHEMA_VERSION ||
    blueprint.projectId !== projectId ||
    blueprint.blueprintDigest !== digestHierarchyValue(blueprintBasis(blueprint))
  ) invalid(projectId);
}

function assertCanonicalPack(pack: EvidencePackV1, projectId: string): void {
  exactKeys(pack, [
    'blueprintDigest', 'conflicts', 'evidenceBytes', 'gaps', 'packDigest', 'pageId',
    'projectId', 'sanitizerPolicyDigest', 'schemaVersion', 'snapshotDigest', 'units',
  ], projectId);
  const unitIds = new Set(pack.units.map((unit) => unit.unitId));
  if (
    pack.schemaVersion !== 'buildlore.evidence-pack.v1' ||
    pack.projectId !== projectId ||
    unitIds.size !== pack.units.length ||
    pack.units.some((unit) => {
      exactKeys(unit, [
        'citation', 'content', 'contentDigest', 'kind', 'range', 'sourceId', 'unitId',
      ], projectId);
      exactKeys(unit.citation, [
        'citationId', 'quoteDigest', 'range', 'sourceId', 'sourceRef', 'sourceRevision',
      ], projectId);
      const citationBasis = {
        sourceId: unit.sourceId,
        sourceRevision: unit.citation.sourceRevision,
        sourceRef: unit.citation.sourceRef,
        range: unit.range,
        quoteDigest: unit.contentDigest,
      };
      return unit.contentDigest !== hierarchySha256(unit.content) ||
        unit.citation.sourceId !== unit.sourceId ||
        unit.citation.quoteDigest !== unit.contentDigest ||
        JSON.stringify(unit.citation.range) !== JSON.stringify(unit.range) ||
        unit.citation.citationId !== `citation-${digestHierarchyValue(citationBasis)
          .slice('sha256:'.length)}`;
    }) ||
    pack.conflicts.some((conflict) => {
      exactKeys(conflict, ['conflictId', 'kind', 'status', 'unitIds'], projectId);
      const basis = { kind: conflict.kind, unitIds: conflict.unitIds, status: conflict.status };
      return conflict.conflictId !== `conflict-${digestHierarchyValue(basis)
        .slice('sha256:'.length)}` || conflict.unitIds.some((unitId) => !unitIds.has(unitId));
    }) ||
    pack.gaps.some((gap) => {
      exactKeys(gap, ['gapId', 'keyQuestion', 'reasonCode'], projectId);
      return gap.gapId !== `gap-${digestHierarchyValue({
        keyQuestion: gap.keyQuestion,
        reasonCode: gap.reasonCode,
      }).slice('sha256:'.length)}`;
    }) ||
    pack.evidenceBytes !== pack.units.reduce((sum, unit) =>
      sum + Buffer.byteLength(unit.content, 'utf8'), 0) ||
    pack.packDigest !== digestHierarchyValue(packBasis(pack))
  ) invalid(projectId);
}

function assertCanonicalProposal(proposal: HierarchicalWikiProposalV1, projectId: string): void {
  exactKeys(proposal, [
    'blueprintDigest', 'citationIds', 'claims', 'evidencePackDigest', 'lifecycle', 'pageId',
    'projectId', 'proposalDigest', 'requestDigest', 'schemaVersion', 'sections', 'summary',
    'title', 'wikilinks',
  ], projectId);
  if (
    proposal.schemaVersion !== HIERARCHICAL_WIKI_PROPOSAL_SCHEMA_VERSION ||
    proposal.projectId !== projectId ||
    proposal.lifecycle !== 'candidate' ||
    proposal.sections.some((section) => {
      exactKeys(section, ['body', 'sectionId', ...(section.title === undefined
        ? [] : ['title'])], projectId);
      return false;
    }) ||
    proposal.claims.some((claim) => {
      exactKeys(claim, ['citationIds', 'claimId', 'evidenceUnitIds', 'text'], projectId);
      return claim.claimId !== `claim-${digestHierarchyValue({
        text: claim.text,
        evidenceUnitIds: claim.evidenceUnitIds,
        citationIds: claim.citationIds,
      }).slice('sha256:'.length)}`;
    }) ||
    proposal.proposalDigest !== digestHierarchyValue(proposalBasis(proposal))
  ) invalid(projectId);
}

function assertCanonicalLegacyBaselineProposal(
  proposal: HierarchicalWikiProposalV1,
  projectId: string,
): void {
  exactKeys(proposal, [
    'blueprintDigest', 'citationIds', 'claims', 'evidencePackDigest', 'lifecycle', 'pageId',
    'projectId', 'proposalDigest', 'requestDigest', 'schemaVersion', 'sections', 'summary',
    'title', 'wikilinks',
  ], projectId);
  if (
    (proposal.schemaVersion as string) !== LEGACY_HIERARCHICAL_WIKI_PROPOSAL_SCHEMA_VERSION ||
    proposal.projectId !== projectId ||
    proposal.lifecycle !== 'candidate' ||
    proposal.sections.some((section) => {
      exactKeys(section, ['body', 'sectionId'], projectId);
      return false;
    }) ||
    proposal.claims.some((claim) => {
      exactKeys(claim, ['citationIds', 'claimId', 'evidenceUnitIds', 'text'], projectId);
      return claim.claimId !== `claim-${digestHierarchyValue({
        text: claim.text,
        evidenceUnitIds: claim.evidenceUnitIds,
        citationIds: claim.citationIds,
      }).slice('sha256:'.length)}`;
    }) ||
    proposal.proposalDigest !== digestHierarchyValue(proposalBasis(proposal))
  ) invalid(projectId);
}

function safeIntegratedReviewText(
  value: unknown,
  maximum: number,
  projectId: string,
  allowNewlines: boolean,
): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.normalize('NFC') ||
    value.includes('\r') ||
    (!allowNewlines && value.includes('\n')) ||
    /\p{Cf}/u.test(value)
  ) invalid(projectId);
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint < 32 && codePoint !== 9 && (codePoint !== 10 || !allowNewlines)) ||
      (codePoint >= 127 && codePoint <= 159) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) invalid(projectId);
  }
}

function assertCanonicalBaselineProposal(
  proposal: HierarchicalWikiProposalV1,
  projectId: string,
): void {
  if ((proposal.schemaVersion as string) === LEGACY_HIERARCHICAL_WIKI_PROPOSAL_SCHEMA_VERSION) {
    assertCanonicalLegacyBaselineProposal(proposal, projectId);
  } else {
    assertCanonicalProposal(proposal, projectId);
  }
  if (
    !PAGE_ID_PATTERN.test(proposal.pageId) ||
    !DIGEST_PATTERN.test(proposal.blueprintDigest) ||
    !DIGEST_PATTERN.test(proposal.evidencePackDigest) ||
    !DIGEST_PATTERN.test(proposal.requestDigest) ||
    proposal.sections.length < 1 ||
    proposal.sections.length > 32 ||
    proposal.claims.length < 1 ||
    proposal.claims.length > 512 ||
    proposal.wikilinks.length > 96 ||
    proposal.citationIds.length < 1 ||
    proposal.citationIds.length > 64 ||
    new Set(proposal.sections.map((section) => section.sectionId)).size !==
      proposal.sections.length ||
    new Set(proposal.claims.map((claim) => claim.claimId)).size !== proposal.claims.length ||
    !sameStrings(proposal.claims.map((claim) => claim.claimId),
      proposal.claims.map((claim) => claim.claimId).sort()) ||
    !sameStrings(proposal.wikilinks, [...proposal.wikilinks].sort()) ||
    !sameStrings(proposal.citationIds, [...proposal.citationIds].sort()) ||
    new Set(proposal.wikilinks).size !== proposal.wikilinks.length ||
    new Set(proposal.citationIds).size !== proposal.citationIds.length ||
    proposal.wikilinks.some((pageId) => !PAGE_ID_PATTERN.test(pageId)) ||
    proposal.citationIds.some((citationId) => !CITATION_ID_PATTERN.test(citationId))
  ) invalid(projectId);
  safeIntegratedReviewText(proposal.title, 1_000, projectId, false);
  safeIntegratedReviewText(proposal.summary, 4_096, projectId, true);
  for (const section of proposal.sections) {
    if (!PORTABLE_IDENTIFIER_PATTERN.test(section.sectionId)) invalid(projectId);
    if (section.title !== undefined) {
      safeIntegratedReviewText(section.title, 1_000, projectId, false);
    }
    safeIntegratedReviewText(section.body, 524_288, projectId, true);
  }
  for (const claim of proposal.claims) {
    safeIntegratedReviewText(claim.text, 4_096, projectId, true);
    if (
      !CLAIM_ID_PATTERN.test(claim.claimId) ||
      claim.evidenceUnitIds.length < 1 ||
      claim.evidenceUnitIds.length > 64 ||
      claim.citationIds.length < 1 ||
      claim.citationIds.length > 64 ||
      !sameStrings(claim.evidenceUnitIds, [...claim.evidenceUnitIds].sort()) ||
      !sameStrings(claim.citationIds, [...claim.citationIds].sort()) ||
      new Set(claim.evidenceUnitIds).size !== claim.evidenceUnitIds.length ||
      new Set(claim.citationIds).size !== claim.citationIds.length ||
      claim.evidenceUnitIds.some((unitId) => !UNIT_ID_PATTERN.test(unitId)) ||
      claim.citationIds.some((citationId) => !CITATION_ID_PATTERN.test(citationId))
    ) invalid(projectId);
  }
  if (Buffer.byteLength(serializeCanonicalJson(proposal), 'utf8') > 524_288) {
    invalid(projectId);
  }
}

function assertIntegratedBlueprintContract(
  blueprint: PageBlueprintV1,
  projectId: string,
): void {
  assertCanonicalBlueprint(blueprint, projectId);
  exactKeys(blueprint.evidenceScope, [
    'allowedUnitKinds', 'relationSetDigest', 'snapshotDigest', 'sourceIds',
    'taskSetDigest', 'preferredUnitIds',
  ], projectId);
  if (
    !Array.isArray(blueprint.childPageIds) ||
    !Array.isArray(blueprint.relatedPageIds) ||
    !Array.isArray(blueprint.keyQuestions) ||
    !Array.isArray(blueprint.requiredSections) ||
    !Array.isArray(blueprint.evidenceScope.allowedUnitKinds) ||
    !Array.isArray(blueprint.evidenceScope.preferredUnitIds) ||
    !Array.isArray(blueprint.evidenceScope.sourceIds) ||
    blueprint.stableKey.length > 128 ||
    blueprint.role.length > 64 ||
    (blueprint.parentPageId !== null && !PAGE_ID_PATTERN.test(blueprint.parentPageId)) ||
    !Number.isSafeInteger(blueprint.minimumDistinctSources) ||
    !Number.isSafeInteger(blueprint.generationOrder) ||
    !DIGEST_PATTERN.test(blueprint.evidenceScope.snapshotDigest) ||
    !DIGEST_PATTERN.test(blueprint.evidenceScope.taskSetDigest) ||
    !DIGEST_PATTERN.test(blueprint.evidenceScope.relationSetDigest)
  ) invalid(projectId);
  safeIntegratedReviewText(blueprint.title, 1_000, projectId, false);
  for (const question of blueprint.keyQuestions) {
    safeIntegratedReviewText(question, 1_000, projectId, true);
  }
}

function assertCanonicalInputs(input: EvaluateSemanticQualityInputV1, projectId: string): void {
  exactKeys(input.outline, [
    'activationState', 'blueprints', 'graphDigest', 'interpretationSetDigest',
    'outlineDigest', 'policyDigest', 'projectId', 'purposeDigest', 'rootPageId',
    'reviewNotes', 'schemaVersion', 'snapshotDigest',
  ], projectId);
  input.outline.blueprints.forEach((blueprint) => assertCanonicalBlueprint(blueprint, projectId));
  const outlineBasis = {
    schemaVersion: input.outline.schemaVersion,
    projectId: input.outline.projectId,
    snapshotDigest: input.outline.snapshotDigest,
    graphDigest: input.outline.graphDigest,
    interpretationSetDigest: input.outline.interpretationSetDigest,
    purposeDigest: input.outline.purposeDigest,
    policyDigest: input.outline.policyDigest,
    activationState: input.outline.activationState,
    rootPageId: input.outline.rootPageId,
    blueprints: input.outline.blueprints,
    reviewNotes: input.outline.reviewNotes,
  };
  if (
    input.outline.schemaVersion !== WIKI_OUTLINE_SCHEMA_VERSION ||
    input.outline.projectId !== projectId ||
    input.outline.outlineDigest !== digestHierarchyValue(outlineBasis)
  ) invalid(projectId);
  input.evidencePacks.forEach((pack) => assertCanonicalPack(pack, projectId));
  input.proposals.forEach((proposal) => assertCanonicalProposal(proposal, projectId));
  if (input.reconciliation !== null) {
    exactKeys(input.reconciliation, [
      'complete', 'entries', 'outlineDigest', 'projectId', 'reconciliationDigest',
      'schemaVersion',
    ], projectId);
    input.reconciliation.entries.forEach((entry) =>
      exactKeys(entry, ['pageId', 'requiredLinkPageIds'], projectId));
    const reconciliationBasis = {
      schemaVersion: input.reconciliation.schemaVersion,
      projectId: input.reconciliation.projectId,
      outlineDigest: input.reconciliation.outlineDigest,
      entries: input.reconciliation.entries,
      complete: input.reconciliation.complete,
    };
    if (
      input.reconciliation.schemaVersion !== 'buildlore.wiki-link-reconciliation.v1' ||
      input.reconciliation.reconciliationDigest !== digestHierarchyValue(reconciliationBasis)
    ) invalid(projectId);
  }
}

function pageReportWithoutDigest(
  report: Omit<PageQualityReportV1, 'reportDigest'>,
): Readonly<Record<string, unknown>> {
  return { ...report };
}

interface PageContext {
  readonly blueprint: PageBlueprintV1;
  readonly proposal: HierarchicalWikiProposalV1;
  readonly pack: EvidencePackV1;
}

export interface EvaluatePageSemanticQualityInputV2 {
  readonly blueprint: PageBlueprintV1;
  readonly proposal: HierarchicalWikiProposalV1;
  readonly evidencePack: EvidencePackV1;
}

function pageQualityReport(
  context: PageContext,
  allContexts: readonly PageContext[],
  lineFrequency: ReadonlyMap<string, number>,
  projectId: string,
): PageQualityReportV1 {
  const { blueprint, proposal, pack } = context;
  const sectionIds = new Set(proposal.sections.map((section) => section.sectionId));
  const coveredSections = blueprint.requiredSections.filter((section) => sectionIds.has(section));
  const sectionCoverageBasisPoints = basisPoints(
    coveredSections.length,
    blueprint.requiredSections.length,
  );
  const unitById = new Map(pack.units.map((unit) => [unit.unitId, unit]));
  const citationUnitById = new Map(pack.units.map((unit) =>
    [unit.citation.citationId, unit.unitId]));
  const fullBody = proposal.sections.map((section) => section.body).join('\n');
  const markersBySection = new Map(proposal.sections.map((section) =>
    [section.sectionId, renderedBodyMarkers(section.body)]));
  const renderedMarkers = renderedBodyMarkers(fullBody);
  const evidenceSupportedClaimIds = new Set(proposal.claims.filter((claim) =>
    evidenceSupportBasisPoints(
      claim.text,
      claim.evidenceUnitIds.flatMap((unitId) => {
        const unit = unitById.get(unitId);
        return unit === undefined ? [] : [unit.content];
      }),
    ) >= thresholds.minimumClaimTokenOverlapBasisPoints).map((claim) => claim.claimId));
  const claimEvidenceSupportBasisPoints = basisPoints(
    evidenceSupportedClaimIds.size,
    proposal.claims.length,
  );
  const groundedClaims = proposal.claims.filter((claim) =>
    claim.evidenceUnitIds.length > 0 &&
    claim.citationIds.length > 0 &&
    claim.evidenceUnitIds.every((unitId) => unitById.has(unitId)) &&
    claim.citationIds.every((citationId) => {
      const unitId = citationUnitById.get(citationId);
      return unitId !== undefined && claim.evidenceUnitIds.includes(unitId);
    }) &&
    proposal.sections.some((section) => section.body.includes(claim.text) &&
      claim.citationIds.every((citationId) =>
        markersBySection.get(section.sectionId)?.citationIds.includes(citationId) === true)) &&
    evidenceSupportedClaimIds.has(claim.claimId));
  const claimGroundingBasisPoints = basisPoints(groundedClaims.length, proposal.claims.length);
  const titleGroundingBasisPoints = genericBlueprintTitle(blueprint)
    ? 10_000
    : weightedCoverageBasisPoints(tokens(blueprint.title), new Set(tokens(proposal.title)));
  const titleGrounded = titleGroundingBasisPoints >=
    thresholds.minimumTitleTokenOverlapBasisPoints;
  const groundedClaimTokens = new Set(groundedClaims.flatMap((claim) =>
    [...tokens(claim.text)]));
  const summaryTokens = tokens(proposal.summary);
  const summaryGroundingBasisPoints = weightedCoverageBasisPoints(
    summaryTokens,
    groundedClaimTokens,
  );
  const summaryGrounded = summaryTokens.length > 0 &&
    summaryGroundingBasisPoints >= thresholds.minimumSummaryTokenOverlapBasisPoints;
  const lines = normalizedLines(proposal);
  const repeatedLines = lines.filter((line) => (lineFrequency.get(line) ?? 0) > 1);
  const repeatedLineBasisPoints = basisPoints(repeatedLines.length, lines.length);
  const ownTokens = tokens(fullBody);
  const duplicateScores = allContexts
    .filter((candidate) => candidate.proposal.pageId !== proposal.pageId)
    .map((candidate) => ({
      pageId: candidate.proposal.pageId,
      score: jaccardBasisPoints(ownTokens, tokens(candidate.proposal.sections
        .map((section) => section.body).join('\n'))),
    }));
  const maximumNearDuplicateBasisPoints = duplicateScores.reduce(
    (maximum, candidate) => Math.max(maximum, candidate.score),
    0,
  );
  const nearDuplicatePageIds = Object.freeze(duplicateScores
    .filter((candidate) =>
      candidate.score >= thresholds.maximumNearDuplicateBasisPoints)
    .map((candidate) => candidate.pageId)
    .sort());
  const claimedUnitIds = new Set(proposal.claims.flatMap((claim) => claim.evidenceUnitIds));
  const observedDistinctSources = new Set([...claimedUnitIds]
    .map((unitId) => unitById.get(unitId)?.sourceId)
    .filter((sourceId): sourceId is string => sourceId !== undefined)).size;
  const expectedLinks = requiredLinks(blueprint);
  const missingRequiredLinkCount = expectedLinks
    .filter((pageId) => !proposal.wikilinks.includes(pageId)).length +
    proposal.wikilinks.filter((pageId) => !expectedLinks.includes(pageId)).length +
    expectedLinks.filter((pageId) => !renderedMarkers.linkPageIds.includes(pageId)).length +
    renderedMarkers.linkPageIds.filter((pageId) => !expectedLinks.includes(pageId)).length;
  const citationRenderingMismatch = !sameStrings(
    renderedMarkers.citationIds,
    [...proposal.citationIds].sort(),
  );
  const substantiveUtf8Bytes = Buffer.byteLength(fullBody.trim(), 'utf8');
  const uniqueTokenCount = new Set(hierarchySurfaceTokens(fullBody
    .replace(CITATION_PATTERN, ' ')
    .replace(PAGE_PATTERN, ' '))).size;
  const substantiveSectionIds = new Set(proposal.sections.filter((section) => {
    const sectionTokens = new Set(tokens(section.body));
    return Buffer.byteLength(section.body.trim(), 'utf8') >= 40 && sectionTokens.size >= 5;
  }).map((section) => section.sectionId));
  const optionalSectionCount = proposal.sections.filter((section) =>
    !blueprint.requiredSections.includes(section.sectionId)).length;
  const unsupportedParagraphCount = proposal.sections.flatMap((section) =>
    markdownParagraphs(section.body)).filter((paragraph) => {
    const paragraphTokens = new Set(tokens(paragraph));
    if (Buffer.byteLength(paragraph, 'utf8') < 40 || paragraphTokens.size < 5) return false;
    const markers = renderedBodyMarkers(paragraph);
    return markers.citationIds.length === 0 &&
      !proposal.claims.some((claim) => paragraph.includes(claim.text));
  }).length;
  const bodyTokenSet = new Set(ownTokens);
  const answeredKeyQuestionCount = blueprint.keyQuestions.filter((question) =>
    answersQuestion(question, bodyTokenSet)).length;
  const unansweredKeyQuestionCount = blueprint.keyQuestions.length - answeredKeyQuestionCount;
  const questionCoverageBasisPoints = basisPoints(
    answeredKeyQuestionCount,
    blueprint.keyQuestions.length,
  );
  const nonemptyRawLines = proposal.sections.flatMap((section) => section.body.split('\n'))
    .map((line) => line.trim()).filter((line) => line.length > 0);
  const filenameLineCount = nonemptyRawLines.filter((line) => FILE_LINE_PATTERN.test(line)).length;
  const filenameListing = nonemptyRawLines.length >= 2 &&
    basisPoints(filenameLineCount, nonemptyRawLines.length) >= 8_000;
  const reasonCodes = new Set<string>();
  if (sectionCoverageBasisPoints < thresholds.minimumSectionCoverageBasisPoints ||
      blueprint.requiredSections.some((sectionId) => !substantiveSectionIds.has(sectionId))) {
    reasonCodes.add('blueprint-coverage-insufficient');
  }
  if (optionalSectionCount > thresholds.maximumOptionalSections) {
    reasonCodes.add('optional-section-limit-exceeded');
  }
  if (claimGroundingBasisPoints < thresholds.minimumClaimGroundingBasisPoints ||
      proposal.claims.length === 0) reasonCodes.add('claim-grounding-insufficient');
  if (claimEvidenceSupportBasisPoints < thresholds.minimumClaimEvidenceSupportBasisPoints) {
    reasonCodes.add('claim-evidence-unsupported');
  }
  if (!titleGrounded) reasonCodes.add('title-grounding-insufficient');
  if (!summaryGrounded) reasonCodes.add('summary-grounding-insufficient');
  if (questionCoverageBasisPoints < thresholds.minimumQuestionCoverageBasisPoints) {
    reasonCodes.add('key-question-unanswered');
  }
  if (unsupportedParagraphCount > 0) {
    reasonCodes.add('unsupported-section-content');
  }
  if (repeatedLineBasisPoints > thresholds.maximumRepeatedLineBasisPoints) {
    reasonCodes.add('boilerplate-repetition');
  }
  if (nearDuplicatePageIds.length > 0) reasonCodes.add('near-duplicate');
  if (observedDistinctSources < blueprint.minimumDistinctSources) {
    reasonCodes.add('source-diversity-insufficient');
  }
  if (pack.conflicts.length > thresholds.maximumUnresolvedConflicts) {
    reasonCodes.add('unresolved-conflict');
  }
  if (pack.gaps.length > 0) reasonCodes.add('evidence-gap-unresolved');
  if (missingRequiredLinkCount > 0) reasonCodes.add('required-link-missing');
  if (citationRenderingMismatch) reasonCodes.add('citation-rendering-mismatch');
  if (
    substantiveUtf8Bytes < thresholds.minimumSubstantiveUtf8Bytes ||
    uniqueTokenCount < thresholds.minimumUniqueTokens
  ) reasonCodes.add('content-shallow');
  if (filenameListing) reasonCodes.add('filename-listing');
  const hardQualityPassed = reasonCodes.size === 0;
  const candidate = Object.freeze({
    schemaVersion: PAGE_QUALITY_REPORT_SCHEMA_VERSION,
    projectId,
    pageId: proposal.pageId,
    blueprintDigest: blueprint.blueprintDigest,
    proposalDigest: proposal.proposalDigest,
    evidencePackDigest: pack.packDigest,
    policyDigest: SEMANTIC_QUALITY_POLICY.policyDigest,
    sectionCoverageBasisPoints,
    claimGroundingBasisPoints,
    claimEvidenceSupportBasisPoints,
    titleGroundingBasisPoints,
    summaryGroundingBasisPoints,
    titleGrounded,
    summaryGrounded,
    optionalSectionCount,
    unsupportedParagraphCount,
    questionCoverageBasisPoints,
    unansweredKeyQuestionCount,
    repeatedLineBasisPoints,
    maximumNearDuplicateBasisPoints,
    requiredDistinctSources: blueprint.minimumDistinctSources,
    observedDistinctSources,
    unresolvedConflictCount: pack.conflicts.length,
    unresolvedGapCount: pack.gaps.length,
    missingRequiredLinkCount,
    substantiveUtf8Bytes,
    uniqueTokenCount,
    nearDuplicatePageIds,
    reasonCodes: Object.freeze([...reasonCodes].sort()),
    hardQualityPassed,
    eligibleForApproval: hardQualityPassed,
    llmJudgeUsed: false as const,
    embeddingSimilarityUsed: false as const,
    canonicalMutationAuthorized: false as const,
  });
  return Object.freeze({
    ...candidate,
    reportDigest: digestHierarchyValue(pageReportWithoutDigest(candidate)),
  });
}

export function evaluatePageSemanticQuality(
  input: EvaluatePageSemanticQualityInputV2,
  expectedProjectId: string,
): PageQualityReportV1 {
  assertCanonicalBlueprint(input.blueprint, expectedProjectId);
  assertCanonicalPack(input.evidencePack, expectedProjectId);
  assertCanonicalProposal(input.proposal, expectedProjectId);
  if (
    input.blueprint.projectId !== expectedProjectId ||
    input.proposal.projectId !== expectedProjectId ||
    input.evidencePack.projectId !== expectedProjectId ||
    input.proposal.pageId !== input.blueprint.pageId ||
    input.evidencePack.pageId !== input.blueprint.pageId ||
    input.proposal.blueprintDigest !== input.blueprint.blueprintDigest ||
    input.proposal.evidencePackDigest !== input.evidencePack.packDigest ||
    input.evidencePack.blueprintDigest !== input.blueprint.blueprintDigest
  ) invalid(expectedProjectId);
  const context = Object.freeze({
    blueprint: input.blueprint,
    proposal: input.proposal,
    pack: input.evidencePack,
  });
  const lineFrequency = new Map<string, number>();
  for (const line of normalizedLines(input.proposal)) {
    lineFrequency.set(line, (lineFrequency.get(line) ?? 0) + 1);
  }
  return pageQualityReport(context, Object.freeze([context]), lineFrequency, expectedProjectId);
}

function reachablePageIds(
  rootPageId: string,
  proposalById: ReadonlyMap<string, HierarchicalWikiProposalV1>,
): ReadonlySet<string> {
  const reached = new Set<string>();
  const queue = [rootPageId];
  while (queue.length > 0) {
    const pageId = queue.shift();
    if (pageId === undefined || reached.has(pageId) || !proposalById.has(pageId)) continue;
    reached.add(pageId);
    for (const linkedPageId of proposalById.get(pageId)?.wikilinks ?? []) {
      if (proposalById.has(linkedPageId) && !reached.has(linkedPageId)) queue.push(linkedPageId);
    }
  }
  return reached;
}

function corpusReportWithoutDigest(
  report: Omit<CorpusQualityReportV1, 'reportDigest'>,
): Readonly<Record<string, unknown>> {
  return { ...report };
}

export interface EvaluateSemanticQualityInputV1 {
  readonly outline: WikiOutlineV1;
  readonly proposals: readonly HierarchicalWikiProposalV1[];
  readonly evidencePacks: readonly EvidencePackV1[];
  readonly reconciliation: WikiLinkReconciliationV1 | null;
  readonly intentionalOrphanPageIds?: readonly string[];
}

export function evaluateSemanticQuality(
  input: EvaluateSemanticQualityInputV1,
  expectedProjectId: string,
): SemanticQualityEvaluationV1 {
  assertCanonicalInputs(input, expectedProjectId);
  if (input.outline.projectId !== expectedProjectId) invalid(expectedProjectId);
  const blueprintById = new Map(input.outline.blueprints.map((item) => [item.pageId, item]));
  const proposalById = new Map(input.proposals.map((item) => [item.pageId, item]));
  const packByPageId = new Map(input.evidencePacks.map((item) => [item.pageId, item]));
  if (
    proposalById.size !== input.proposals.length ||
    packByPageId.size !== input.evidencePacks.length ||
    input.proposals.some((proposal) =>
      proposal.projectId !== expectedProjectId ||
      proposal.lifecycle !== 'candidate' ||
      !blueprintById.has(proposal.pageId)) ||
    input.evidencePacks.some((pack) =>
      pack.projectId !== expectedProjectId || !blueprintById.has(pack.pageId))
  ) invalid(expectedProjectId);
  const contexts = input.proposals.flatMap((proposal): readonly PageContext[] => {
    const blueprint = blueprintById.get(proposal.pageId);
    const pack = packByPageId.get(proposal.pageId);
    if (
      blueprint === undefined ||
      pack === undefined ||
      proposal.blueprintDigest !== blueprint.blueprintDigest ||
      proposal.evidencePackDigest !== pack.packDigest ||
      pack.blueprintDigest !== blueprint.blueprintDigest
    ) invalid(expectedProjectId);
    return [{ blueprint, proposal, pack }];
  });
  const lineFrequency = new Map<string, number>();
  for (const context of contexts) {
    for (const line of normalizedLines(context.proposal)) {
      lineFrequency.set(line, (lineFrequency.get(line) ?? 0) + 1);
    }
  }
  const pages = Object.freeze(contexts.map((context) =>
    pageQualityReport(context, contexts, lineFrequency, expectedProjectId))
    .sort((left, right) => left.pageId < right.pageId ? -1 : 1));
  const reconciliationDigest = input.reconciliation?.reconciliationDigest ??
    hierarchySha256('missing-link-reconciliation');
  const completeCandidateSet = proposalById.size === blueprintById.size &&
    packByPageId.size === blueprintById.size &&
    input.outline.blueprints.every((blueprint) =>
      proposalById.has(blueprint.pageId) && packByPageId.has(blueprint.pageId));
  const reconciliationEntryById = new Map(input.reconciliation?.entries.map((entry) =>
    [entry.pageId, entry]) ?? []);
  const reconciliationComplete = input.reconciliation !== null &&
    input.reconciliation.projectId === expectedProjectId &&
    input.reconciliation.outlineDigest === input.outline.outlineDigest &&
    input.reconciliation.complete &&
    reconciliationEntryById.size === input.reconciliation.entries.length &&
    input.reconciliation.entries.length === input.outline.blueprints.length &&
    input.outline.blueprints.every((blueprint) => {
      const entry = reconciliationEntryById.get(blueprint.pageId);
      return entry !== undefined && sameStrings(
        entry.requiredLinkPageIds,
        requiredLinks(blueprint),
      );
    });
  const reached = reachablePageIds(input.outline.rootPageId, proposalById);
  const orphanPageIds = Object.freeze([...proposalById.keys()]
    .filter((pageId) => !reached.has(pageId)).sort());
  const intentionalOrphanPageIds = Object.freeze([
    ...(input.intentionalOrphanPageIds ?? []),
  ].sort());
  if (
    new Set(intentionalOrphanPageIds).size !== intentionalOrphanPageIds.length ||
    intentionalOrphanPageIds.some((pageId) =>
      !PAGE_ID_PATTERN.test(pageId) || !proposalById.has(pageId) ||
      !orphanPageIds.includes(pageId))
  ) invalid(expectedProjectId);
  const orphanBasisPoints = basisPoints(orphanPageIds.length, proposalById.size);
  const uncategorizedPageCount = input.outline.blueprints.filter((blueprint) =>
    blueprint.role.toLocaleLowerCase('und') === 'uncategorized').length;
  const reasonCodes = new Set<string>();
  if (!completeCandidateSet) reasonCodes.add('candidate-set-incomplete');
  if (!reconciliationComplete) reasonCodes.add('link-reconciliation-incomplete');
  if (orphanBasisPoints > thresholds.maximumOrphanBasisPoints) {
    reasonCodes.add('orphan-threshold-exceeded');
  }
  if (uncategorizedPageCount > thresholds.maximumUncategorizedPages) {
    reasonCodes.add('uncategorized-page-present');
  }
  if (pages.some((page) => !page.hardQualityPassed)) {
    reasonCodes.add('page-quality-failed');
  }
  const hardQualityPassed = reasonCodes.size === 0;
  const candidate = Object.freeze({
    schemaVersion: CORPUS_QUALITY_REPORT_SCHEMA_VERSION,
    projectId: expectedProjectId,
    outlineDigest: input.outline.outlineDigest,
    reconciliationDigest,
    policyDigest: SEMANTIC_QUALITY_POLICY.policyDigest,
    candidateCount: proposalById.size,
    expectedCandidateCount: blueprintById.size,
    pageReportDigests: Object.freeze(pages.map((page) => page.reportDigest)),
    reachablePageCount: reached.size,
    orphanPageIds,
    intentionalOrphanPageIds,
    orphanBasisPoints,
    uncategorizedPageCount,
    reasonCodes: Object.freeze([...reasonCodes].sort()),
    hardQualityPassed,
    eligibleForApproval: hardQualityPassed,
    deterministicChecksOnly: true as const,
    llmJudgeCanOverride: false as const,
    embeddingSimilarityCanOverride: false as const,
    canonicalMutationAuthorized: false as const,
  });
  return Object.freeze({
    pages,
    corpus: Object.freeze({
      ...candidate,
      reportDigest: digestHierarchyValue(corpusReportWithoutDigest(candidate)),
    }),
  });
}

export interface CurrentSessionGenerationHandoffV1 {
  readonly exchange: unknown;
  readonly result: unknown;
}

export interface CreateIntegratedWikiReviewSurfaceInputV1 {
  readonly graph: SparseRelationGraphV1;
  readonly outline: WikiOutlineV1;
  readonly planningInventory: PlanningDispositionInventoryV1;
  readonly generations: readonly CurrentSessionGenerationHandoffV1[];
  readonly reconciliation: WikiLinkReconciliationV1 | null;
  readonly baselineGenerationDigest: HierarchySha256Digest | null;
  readonly baselineProposals: readonly HierarchicalWikiProposalV1[];
  readonly intentionalOrphanPageIds?: readonly string[];
}

interface VerifiedCurrentSessionGeneration {
  readonly exchange: CurrentSessionGenerationExchangeV1;
  readonly result: CurrentSessionGenerationResultV1;
}

function unknownRecord(value: unknown, projectId: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(projectId);
  return value as Readonly<Record<string, unknown>>;
}

function coverageBasisPoints(observed: number, expected: number): number {
  if (expected === 0) return observed === 0 ? 10_000 : 0;
  return Math.min(10_000, basisPoints(observed, expected));
}

function sortedDifference(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return Object.freeze([...new Set(left)].filter((item) => !rightSet.has(item)).sort());
}

function contentDiffWithoutDigest(
  value: Omit<WikiContentDiffV1, 'diffDigest'>,
): Readonly<Record<string, unknown>> {
  return { ...value };
}

function createContentDiff(
  proposal: HierarchicalWikiProposalV1,
  baseline: HierarchicalWikiProposalV1 | null,
  projectId: string,
): WikiContentDiffV1 {
  const beforeSectionById = new Map(
    baseline?.sections.map((section) => [section.sectionId, section]) ?? [],
  );
  const afterSectionById = new Map(proposal.sections.map((section) => [section.sectionId, section]));
  const sectionIds = [...new Set([
    ...beforeSectionById.keys(),
    ...afterSectionById.keys(),
  ])].sort();
  const sections = Object.freeze(sectionIds.map((sectionId) => {
    const before = beforeSectionById.get(sectionId);
    const after = afterSectionById.get(sectionId);
    const beforeBodyDigest = before === undefined ? null : hierarchySha256(before.body);
    const afterBodyDigest = after === undefined ? null : hierarchySha256(after.body);
    const changeKind = before === undefined
      ? 'added' as const
      : after === undefined
        ? 'removed' as const
        : beforeBodyDigest === afterBodyDigest
          ? 'unchanged' as const
          : 'modified' as const;
    return Object.freeze({ sectionId, changeKind, beforeBodyDigest, afterBodyDigest });
  }));
  const addedCitationIds = sortedDifference(
    proposal.citationIds,
    baseline?.citationIds ?? [],
  );
  const removedCitationIds = sortedDifference(
    baseline?.citationIds ?? [],
    proposal.citationIds,
  );
  const addedWikilinkPageIds = sortedDifference(
    proposal.wikilinks,
    baseline?.wikilinks ?? [],
  );
  const removedWikilinkPageIds = sortedDifference(
    baseline?.wikilinks ?? [],
    proposal.wikilinks,
  );
  const titleChanged = baseline === null || baseline.title !== proposal.title;
  const summaryChanged = baseline === null || baseline.summary !== proposal.summary;
  const modified = baseline === null || baseline.proposalDigest !== proposal.proposalDigest ||
    titleChanged || summaryChanged ||
    sections.some((section) => section.changeKind !== 'unchanged') ||
    addedCitationIds.length > 0 || removedCitationIds.length > 0 ||
    addedWikilinkPageIds.length > 0 || removedWikilinkPageIds.length > 0;
  const candidate = Object.freeze({
    schemaVersion: WIKI_CONTENT_DIFF_SCHEMA_VERSION,
    projectId,
    pageId: proposal.pageId,
    baseProposalDigest: baseline?.proposalDigest ?? null,
    candidateProposalDigest: proposal.proposalDigest,
    changeKind: baseline === null ? 'added' as const : modified ? 'modified' as const :
      'unchanged' as const,
    titleChanged,
    summaryChanged,
    sections,
    addedCitationIds,
    removedCitationIds,
    addedWikilinkPageIds,
    removedWikilinkPageIds,
  });
  return Object.freeze({
    ...candidate,
    diffDigest: digestHierarchyValue(contentDiffWithoutDigest(candidate)),
  });
}

function removedBaselinePage(
  proposal: HierarchicalWikiProposalV1,
): RemovedBaselineWikiPageV1 {
  const candidate = Object.freeze({
    pageId: proposal.pageId,
    baselineProposalDigest: proposal.proposalDigest,
    baselineProposal: proposal,
  });
  return Object.freeze({
    ...candidate,
    removalDigest: digestHierarchyValue(candidate),
  });
}

function coverageWithoutDigest(
  value: Omit<IntegratedWikiReviewCoverageV1, 'coverageDigest'>,
): Readonly<Record<string, unknown>> {
  return { ...value };
}

function candidateWithoutDigest(
  value: Omit<IntegratedWikiReviewCandidateV1, 'candidateDigest'>,
): Readonly<Record<string, unknown>> {
  return { ...value };
}

function surfaceWithoutDigest(
  value: Omit<IntegratedWikiReviewSurfaceV1, 'surfaceDigest'>,
): Readonly<Record<string, unknown>> {
  return { ...value };
}

function canonicalReasonCodes(
  value: readonly string[],
  projectId: string,
  requireNonEmpty: boolean,
): readonly string[] {
  if (
    value.length > 32 ||
    (requireNonEmpty && value.length === 0) ||
    value.some((item) => item.length < 1 || item.length > 64 || !REASON_CODE_PATTERN.test(item))
  ) invalid(projectId);
  const result = Object.freeze([...value].sort());
  if (new Set(result).size !== result.length) invalid(projectId);
  return result;
}

function explicitlyReviewsBaselinePageRemoval(
  surface: IntegratedWikiReviewSurfaceV1,
  reasonCodes: readonly string[],
): boolean {
  return !surface.eligibleForHumanAcceptance &&
    surface.runCoverage.complete &&
    surface.hardQualityPassed &&
    surface.corpusQualityReport.eligibleForApproval &&
    surface.canonicalMutationAuthorized === false &&
    surface.removedBaselinePages.length > 0 &&
    sameStrings(surface.reasonCodes, [BASELINE_PAGE_REMOVAL_REQUIRES_REVIEW_REASON_CODE]) &&
    reasonCodes.includes(BASELINE_PAGE_REMOVAL_REVIEW_REASON_CODE);
}

function createIntegratedWikiReviewSurfaceUnsafe(
  input: CreateIntegratedWikiReviewSurfaceInputV1,
  projectId: string,
): IntegratedWikiReviewSurfaceV1 {
  const graph = parseSparseRelationGraph(input.graph, projectId);
  const planningInventory = parsePlanningDispositionInventory(
    input.planningInventory,
    graph,
    projectId,
  );
  exactKeys(input.outline, [
    'activationState', 'blueprints', 'graphDigest', 'interpretationSetDigest',
    'outlineDigest', 'policyDigest', 'projectId', 'purposeDigest', 'rootPageId',
    'reviewNotes', 'schemaVersion', 'snapshotDigest',
  ], projectId);
  input.outline.blueprints.forEach((blueprint) =>
    assertIntegratedBlueprintContract(blueprint, projectId));
  if (
    input.outline.schemaVersion !== WIKI_OUTLINE_SCHEMA_VERSION ||
    input.outline.projectId !== projectId ||
    input.outline.activationState !== 'candidate' ||
    !DIGEST_PATTERN.test(input.outline.snapshotDigest) ||
    !DIGEST_PATTERN.test(input.outline.graphDigest) ||
    !DIGEST_PATTERN.test(input.outline.interpretationSetDigest) ||
    !DIGEST_PATTERN.test(input.outline.purposeDigest) ||
    !DIGEST_PATTERN.test(input.outline.policyDigest) ||
    !DIGEST_PATTERN.test(input.outline.outlineDigest) ||
    !PAGE_ID_PATTERN.test(input.outline.rootPageId) ||
    input.outline.snapshotDigest !== graph.snapshotDigest ||
    input.outline.graphDigest !== graph.graphDigest ||
    input.outline.policyDigest !== graph.policyDigest ||
    input.outline.blueprints.length < 2 ||
    input.outline.blueprints.length > 97 ||
    input.outline.blueprints.some((blueprint, index) =>
      blueprint.generationOrder !== index) ||
    input.generations.length > input.outline.blueprints.length ||
    input.baselineProposals.length > 97
  ) invalid(projectId);

  const blueprintById = new Map(input.outline.blueprints.map((blueprint) =>
    [blueprint.pageId, blueprint]));
  const rootBlueprint = blueprintById.get(input.outline.rootPageId);
  const graphSourceIds = new Set(graph.tasks.map((task) => task.sourceId));
  const stableKeys = new Set(input.outline.blueprints.map((blueprint) =>
    blueprint.stableKey));
  const leafSourceIds = Object.freeze([...new Set(input.outline.blueprints
    .filter((blueprint) => blueprint.childPageIds.length === 0)
    .flatMap((blueprint) => [...blueprint.evidenceScope.sourceIds]))].sort());
  if (
    blueprintById.size !== input.outline.blueprints.length ||
    stableKeys.size !== input.outline.blueprints.length ||
    rootBlueprint === undefined ||
    rootBlueprint.role !== 'overview' ||
    rootBlueprint.parentPageId !== null ||
    rootBlueprint.generationOrder !== input.outline.blueprints.length - 1 ||
    !sameStrings(rootBlueprint.evidenceScope.sourceIds, leafSourceIds) ||
    input.outline.blueprints.some((blueprint) => blueprint.pageId !==
      `page-${digestHierarchyValue({
        projectId,
        purposeDigest: input.outline.purposeDigest,
        stableKey: blueprint.stableKey,
      }).slice('sha256:'.length)}`) ||
    input.outline.blueprints.some((blueprint) =>
      blueprint.pageId !== input.outline.rootPageId &&
      (blueprint.parentPageId === null || !blueprintById.has(blueprint.parentPageId))) ||
    input.outline.blueprints.some((blueprint) => blueprint.childPageIds.some((childPageId) => {
      const child = blueprintById.get(childPageId);
      return child === undefined || child.generationOrder >= blueprint.generationOrder;
    })) ||
    input.outline.blueprints.some((blueprint) => blueprint.relatedPageIds.some((relatedPageId) =>
      relatedPageId === blueprint.pageId || !blueprintById.has(relatedPageId))) ||
    input.outline.blueprints.filter((blueprint) => blueprint.childPageIds.length === 0)
      .some((blueprint) => blueprint.relatedPageIds.some((relatedPageId) =>
        !blueprintById.get(relatedPageId)?.relatedPageIds.includes(blueprint.pageId))) ||
    input.outline.blueprints.some((blueprint) =>
      blueprint.evidenceScope.sourceIds.length < 1 ||
      blueprint.evidenceScope.sourceIds.length > 4_096 ||
      !sameStrings(blueprint.evidenceScope.sourceIds,
        [...blueprint.evidenceScope.sourceIds].sort()) ||
      new Set(blueprint.evidenceScope.sourceIds).size !==
        blueprint.evidenceScope.sourceIds.length ||
      blueprint.evidenceScope.sourceIds.some((sourceId) => !graphSourceIds.has(sourceId)) ||
      !sameStrings(blueprint.evidenceScope.allowedUnitKinds, ALL_TEXT_UNIT_KINDS) ||
      !PAGE_ID_PATTERN.test(blueprint.pageId) ||
      !PORTABLE_IDENTIFIER_PATTERN.test(blueprint.stableKey) ||
      !PORTABLE_IDENTIFIER_PATTERN.test(blueprint.role) ||
      blueprint.keyQuestions.length < 1 ||
      blueprint.keyQuestions.length > 64 ||
      new Set(blueprint.keyQuestions).size !== blueprint.keyQuestions.length ||
      blueprint.requiredSections.length < 1 ||
      blueprint.requiredSections.length > 32 ||
      new Set(blueprint.requiredSections).size !== blueprint.requiredSections.length ||
      blueprint.requiredSections.some((section) => !PORTABLE_IDENTIFIER_PATTERN.test(section)) ||
      blueprint.childPageIds.length > 96 ||
      blueprint.relatedPageIds.length > 96 ||
      !sameStrings(blueprint.childPageIds, [...blueprint.childPageIds].sort()) ||
      !sameStrings(blueprint.relatedPageIds, [...blueprint.relatedPageIds].sort()) ||
      new Set(blueprint.childPageIds).size !== blueprint.childPageIds.length ||
      new Set(blueprint.relatedPageIds).size !== blueprint.relatedPageIds.length ||
      blueprint.minimumDistinctSources < 1 ||
      blueprint.minimumDistinctSources > blueprint.evidenceScope.sourceIds.length) ||
    input.outline.blueprints.some((blueprint) => !sameStrings(
      blueprint.childPageIds,
      input.outline.blueprints.filter((candidate) => candidate.parentPageId === blueprint.pageId)
        .map((candidate) => candidate.pageId).sort(),
    ))
  ) invalid(projectId);
  const taskByUnitId = new Map(graph.tasks.map((task) => [task.unitId, task]));
  const verifiedGenerations: VerifiedCurrentSessionGeneration[] = input.generations
    .map((handoff): VerifiedCurrentSessionGeneration => {
      const handoffRecord = unknownRecord(handoff, projectId);
      exactKeys(handoffRecord, ['exchange', 'result'], projectId);
      const result: CurrentSessionGenerationResultV1 = verifyCurrentSessionGenerationResult(
        handoffRecord.result,
        handoffRecord.exchange,
        projectId,
      );
      return Object.freeze({
        exchange: handoffRecord.exchange as CurrentSessionGenerationExchangeV1,
        result,
      });
    }).sort((left, right) => left.exchange.pageId < right.exchange.pageId ? -1 : 1);
  const generationByPageId = new Map(verifiedGenerations.map((generation) =>
    [generation.exchange.pageId, generation]));
  if (
    generationByPageId.size !== verifiedGenerations.length ||
    new Set(verifiedGenerations.map((generation) =>
      generation.result.receipt.receiptDigest)).size !== verifiedGenerations.length
  ) invalid(projectId);
  const observedGenerationOrders = verifiedGenerations
    .map((generation) => generation.exchange.request.generationOrder)
    .sort((left, right) => left - right);
  if (observedGenerationOrders.some((order, index) => order !== index)) invalid(projectId);

  const sanitizerPolicyDigests = new Set<HierarchySha256Digest>();
  for (const generation of verifiedGenerations) {
    const { exchange, result } = generation;
    const blueprint = blueprintById.get(exchange.pageId);
    if (
      blueprint === undefined ||
      result.proposal.pageId !== blueprint.pageId ||
      result.proposal.blueprintDigest !== blueprint.blueprintDigest ||
      exchange.request.blueprintDigest !== blueprint.blueprintDigest ||
      exchange.evidencePack.blueprintDigest !== blueprint.blueprintDigest ||
      exchange.evidencePack.snapshotDigest !== input.outline.snapshotDigest ||
      exchange.purposeDigest !== input.outline.purposeDigest ||
      exchange.request.generationOrder !== blueprint.generationOrder ||
      exchange.writingBrief.title !== blueprint.title ||
      exchange.writingBrief.role !== blueprint.role ||
      !sameStrings(exchange.writingBrief.keyQuestions, blueprint.keyQuestions) ||
      exchange.writingBrief.minimumDistinctSources !== blueprint.minimumDistinctSources ||
      !sameStrings(exchange.request.requiredSections, blueprint.requiredSections) ||
      !sameStrings(exchange.request.requiredLinkPageIds, requiredLinks(blueprint)) ||
      blueprint.evidenceScope.snapshotDigest !== graph.snapshotDigest ||
      blueprint.evidenceScope.taskSetDigest !== graph.taskSetDigest ||
      blueprint.evidenceScope.relationSetDigest !== graph.relationSetDigest
    ) invalid(projectId);
    sanitizerPolicyDigests.add(exchange.evidencePack.sanitizerPolicyDigest);
    for (const unit of exchange.evidencePack.units) {
      const task = taskByUnitId.get(unit.unitId);
      if (
        task === undefined ||
        task.sourceId !== unit.sourceId ||
        task.kind !== unit.kind ||
        task.contentDigest !== unit.contentDigest ||
        !blueprint.evidenceScope.sourceIds.includes(unit.sourceId) ||
        !blueprint.evidenceScope.allowedUnitKinds.includes(unit.kind)
      ) invalid(projectId);
    }
    const childSummaryById = new Map(exchange.request.approvedChildSummaries.map((summary) =>
      [summary.pageId, summary]));
    if (
      childSummaryById.size !== exchange.request.approvedChildSummaries.length ||
      !sameStrings([...childSummaryById.keys()].sort(), [...blueprint.childPageIds].sort())
    ) invalid(projectId);
    for (const childPageId of blueprint.childPageIds) {
      const child = generationByPageId.get(childPageId);
      const summary = childSummaryById.get(childPageId);
      if (
        child === undefined ||
        summary === undefined ||
        child.exchange.request.generationOrder >= exchange.request.generationOrder ||
        summary.proposalDigest !== child.result.proposal.proposalDigest ||
        summary.summary !== child.result.proposal.summary ||
        (!sameStrings(summary.citationIds, child.result.proposal.citationIds) &&
          !sameStrings(
            summary.citationIds,
            citationIdsForProposalSummary(child.result.proposal, projectId),
          ))
      ) invalid(projectId);
    }
  }
  if (sanitizerPolicyDigests.size > 1) invalid(projectId);

  const baselines: HierarchicalWikiProposalV1[] = Array.from(
    input.baselineProposals,
  ).sort((left, right) =>
    left.pageId < right.pageId ? -1 : 1);
  baselines.forEach((proposal) => assertCanonicalBaselineProposal(proposal, projectId));
  const baselineByPageId = new Map<string, HierarchicalWikiProposalV1>(baselines
    .map((proposal) => [proposal.pageId, proposal]));
  if (baselineByPageId.size !== baselines.length) invalid(projectId);
  if (
    (baselines.length === 0 && input.baselineGenerationDigest !== null) ||
    (baselines.length > 0 &&
      (input.baselineGenerationDigest === null ||
       !DIGEST_PATTERN.test(input.baselineGenerationDigest)))
  ) invalid(projectId);

  const proposals = Object.freeze(verifiedGenerations.map((generation) =>
    generation.result.proposal));
  const evidencePacks = Object.freeze(verifiedGenerations.map((generation) =>
    generation.exchange.evidencePack));
  if (
    verifiedGenerations.length === input.outline.blueprints.length &&
    input.reconciliation !== null
  ) {
    const replayedReconciliation = reconcileWikiProposalLinks(
      input.outline,
      proposals,
      projectId,
    );
    if (serializeCanonicalJson(replayedReconciliation) !==
        serializeCanonicalJson(input.reconciliation)) invalid(projectId);
  }
  const quality = evaluateSemanticQuality({
    outline: input.outline,
    proposals,
    evidencePacks,
    reconciliation: input.reconciliation,
    ...(input.intentionalOrphanPageIds === undefined
      ? {}
      : { intentionalOrphanPageIds: input.intentionalOrphanPageIds }),
  }, projectId);
  const pageQualityById = new Map(quality.pages.map((report) => [report.pageId, report]));

  const citationAnchorById = new Map<string, EvidenceCitationAnchorV1>();
  for (const pack of evidencePacks) {
    for (const unit of pack.units) {
      const existing = citationAnchorById.get(unit.citation.citationId);
      if (
        existing !== undefined &&
        serializeCanonicalJson(existing) !== serializeCanonicalJson(unit.citation)
      ) invalid(projectId);
      citationAnchorById.set(unit.citation.citationId, unit.citation);
    }
  }

  const candidates = Object.freeze(verifiedGenerations.map((generation):
  IntegratedWikiReviewCandidateV1 => {
    const blueprint = blueprintById.get(generation.exchange.pageId);
    const pageQualityReport = pageQualityById.get(generation.exchange.pageId);
    if (blueprint === undefined || pageQualityReport === undefined) invalid(projectId);
    const proposal = generation.result.proposal;
    const baselineProposal = baselineByPageId.get(proposal.pageId) ?? null;
    const citationAnchors = Object.freeze(proposal.citationIds.map((citationId) => {
      const anchor = citationAnchorById.get(citationId);
      if (anchor === undefined) invalid(projectId);
      return anchor;
    }).sort((left, right) => left.citationId < right.citationId ? -1 : 1));
    const candidate = Object.freeze({
      pageId: proposal.pageId,
      blueprint,
      proposal,
      baselineProposal,
      generationReceipt: generation.result.receipt,
      contentDiff: createContentDiff(proposal, baselineProposal, projectId),
      citationAnchors,
      observedSourceIds: Object.freeze([...new Set(citationAnchors.map((anchor) =>
        anchor.sourceId))].sort()),
      unresolvedConflictIds: Object.freeze(generation.exchange.evidencePack.conflicts
        .map((conflict) => conflict.conflictId).sort()),
      unresolvedGapIds: Object.freeze(generation.exchange.evidencePack.gaps
        .map((gap) => gap.gapId).sort()),
      pageQualityReport,
    });
    return Object.freeze({
      ...candidate,
      candidateDigest: digestHierarchyValue(candidateWithoutDigest(candidate)),
    });
  }).sort((left, right) => left.pageId < right.pageId ? -1 : 1));

  const removedBaselinePages = Object.freeze(baselines
    .filter((proposal) => !blueprintById.has(proposal.pageId))
    .map(removedBaselinePage)
    .sort((left, right) => left.pageId < right.pageId ? -1 : 1));
  const expectedCandidateCount = input.outline.blueprints.length;
  const coverageCandidate = Object.freeze({
    expectedTaskCount: graph.tasks.length,
    observedTaskDispositionCount: planningInventory.taskCount,
    taskDispositionCoverageBasisPoints: coverageBasisPoints(
      planningInventory.taskCount,
      graph.tasks.length,
    ),
    expectedRelationCount: graph.relations.length,
    observedRelationDispositionCount: planningInventory.relationCount,
    relationDispositionCoverageBasisPoints: coverageBasisPoints(
      planningInventory.relationCount,
      graph.relations.length,
    ),
    expectedCandidateCount,
    observedCandidateCount: candidates.length,
    candidateCoverageBasisPoints: coverageBasisPoints(candidates.length, expectedCandidateCount),
    expectedGenerationReceiptCount: expectedCandidateCount,
    observedGenerationReceiptCount: candidates.length,
    generationReceiptCoverageBasisPoints: coverageBasisPoints(
      candidates.length,
      expectedCandidateCount,
    ),
    expectedPageQualityReportCount: expectedCandidateCount,
    observedPageQualityReportCount: quality.pages.length,
    pageQualityReportCoverageBasisPoints: coverageBasisPoints(
      quality.pages.length,
      expectedCandidateCount,
    ),
    reconciliationComplete: input.reconciliation !== null &&
      input.reconciliation.complete &&
      input.reconciliation.outlineDigest === input.outline.outlineDigest,
    reachablePageCount: quality.corpus.reachablePageCount,
    orphanPageCount: quality.corpus.orphanPageIds.length,
    intentionalOrphanPageCount: quality.corpus.intentionalOrphanPageIds.length,
    uncategorizedPageCount: quality.corpus.uncategorizedPageCount,
    complete: candidates.length === expectedCandidateCount &&
      planningInventory.taskCount === graph.tasks.length &&
      planningInventory.relationCount === graph.relations.length &&
      quality.pages.length === expectedCandidateCount &&
      input.reconciliation !== null &&
      input.reconciliation.complete &&
      input.reconciliation.outlineDigest === input.outline.outlineDigest,
  });
  const runCoverage = Object.freeze({
    ...coverageCandidate,
    coverageDigest: digestHierarchyValue(coverageWithoutDigest(coverageCandidate)),
  });
  const hardQualityPassed = quality.corpus.hardQualityPassed &&
    quality.pages.every((page) => page.hardQualityPassed);
  const eligibleForHumanAcceptance = runCoverage.complete && hardQualityPassed &&
    removedBaselinePages.length === 0;
  const reasonCodes = new Set(quality.corpus.reasonCodes);
  if (!runCoverage.complete) reasonCodes.add('run-coverage-incomplete');
  if (removedBaselinePages.length > 0) {
    reasonCodes.add(BASELINE_PAGE_REMOVAL_REQUIRES_REVIEW_REASON_CODE);
  }
  const candidate = Object.freeze({
    schemaVersion: INTEGRATED_WIKI_REVIEW_SURFACE_SCHEMA_VERSION,
    projectId,
    snapshotDigest: input.outline.snapshotDigest,
    graphDigest: graph.graphDigest,
    outlineDigest: input.outline.outlineDigest,
    purposeDigest: input.outline.purposeDigest,
    compilationPolicyDigest: input.outline.policyDigest,
    planningInventoryDigest: planningInventory.inventoryDigest,
    reconciliationDigest: input.reconciliation?.reconciliationDigest ?? null,
    semanticQualityPolicyDigest: SEMANTIC_QUALITY_POLICY.policyDigest,
    baselineGenerationDigest: input.baselineGenerationDigest,
    runCoverage,
    candidates,
    removedBaselinePages,
    corpusQualityReport: quality.corpus,
    hardQualityPassed,
    eligibleForHumanAcceptance,
    canonicalMutationAuthorized: false as const,
    reasonCodes: Object.freeze([...reasonCodes].sort()),
  });
  const surface = Object.freeze({
    ...candidate,
    surfaceDigest: digestHierarchyValue(surfaceWithoutDigest(candidate)),
  });
  if (Buffer.byteLength(serializeCanonicalJson(surface), 'utf8') >
      MAX_INTEGRATED_REVIEW_SURFACE_BYTES) invalid(projectId);
  return surface;
}

export function createIntegratedWikiReviewSurface(
  input: CreateIntegratedWikiReviewSurfaceInputV1,
  expectedProjectId: string,
): IntegratedWikiReviewSurfaceV1 {
  try {
    const surface = createIntegratedWikiReviewSurfaceUnsafe(input, expectedProjectId);
    ISSUED_INTEGRATED_REVIEW_SURFACES.add(surface);
    return surface;
  } catch {
    return invalid(expectedProjectId);
  }
}

export function verifyIntegratedWikiReviewSurface(
  value: unknown,
  input: CreateIntegratedWikiReviewSurfaceInputV1,
  expectedProjectId: string,
): IntegratedWikiReviewSurfaceV1 {
  try {
    const rebuilt = createIntegratedWikiReviewSurfaceUnsafe(input, expectedProjectId);
    if (serializeCanonicalJson(value) !== serializeCanonicalJson(rebuilt)) {
      invalid(expectedProjectId);
    }
    ISSUED_INTEGRATED_REVIEW_SURFACES.add(rebuilt);
    return rebuilt;
  } catch {
    return invalid(expectedProjectId);
  }
}

function reviewWithoutDigest(
  value: Omit<IntegratedWikiCandidateReviewV1, 'reviewDigest'>,
): Readonly<Record<string, unknown>> {
  return { ...value };
}

function assertSurfaceDigest(
  value: IntegratedWikiReviewSurfaceV1,
  projectId: string,
): void {
  const surface = unknownRecord(value, projectId);
  exactKeys(surface, [
    'baselineGenerationDigest', 'candidates', 'canonicalMutationAuthorized',
    'compilationPolicyDigest', 'corpusQualityReport', 'eligibleForHumanAcceptance',
    'graphDigest', 'hardQualityPassed', 'outlineDigest', 'planningInventoryDigest',
    'projectId', 'purposeDigest', 'reasonCodes', 'reconciliationDigest',
    'removedBaselinePages', 'runCoverage', 'schemaVersion',
    'semanticQualityPolicyDigest', 'snapshotDigest', 'surfaceDigest',
  ], projectId);
  if (
    value.schemaVersion !== INTEGRATED_WIKI_REVIEW_SURFACE_SCHEMA_VERSION ||
    value.projectId !== projectId ||
    value.canonicalMutationAuthorized !== false ||
    value.surfaceDigest !== digestHierarchyValue((() => {
      const candidate: Record<string, unknown> = { ...surface };
      delete candidate.surfaceDigest;
      return candidate;
    })())
  ) invalid(projectId);
}

/**
 * Issues a page decision only for a surface created or independently rebuilt by this
 * module in the current process. A JSON-round-tripped surface must first pass
 * verifyIntegratedWikiReviewSurface; task-006 still replays that verifier before any
 * canonical mutation and binds the prior-generation identity to authoritative state.
 */
export function createIntegratedWikiCandidateReview(
  surface: IntegratedWikiReviewSurfaceV1,
  pageId: string,
  decision: IntegratedWikiCandidateReviewDecision,
  reasonCodesValue: readonly string[],
  expectedProjectId: string,
): IntegratedWikiCandidateReviewV1 {
  try {
    assertSurfaceDigest(surface, expectedProjectId);
    if (!ISSUED_INTEGRATED_REVIEW_SURFACES.has(surface)) invalid(expectedProjectId);
    if (!PAGE_ID_PATTERN.test(pageId) || !['accepted', 'rejected'].includes(decision)) {
      invalid(expectedProjectId);
    }
    const reviewCandidate = surface.candidates.find((candidate) => candidate.pageId === pageId);
    if (reviewCandidate === undefined) invalid(expectedProjectId);
    const reasonCodes = canonicalReasonCodes(
      reasonCodesValue,
      expectedProjectId,
      decision === 'rejected',
    );
    const explicitlyReviewedRemoval = explicitlyReviewsBaselinePageRemoval(
      surface,
      reasonCodes,
    );
    if (
      reasonCodes.includes(BASELINE_PAGE_REMOVAL_REVIEW_REASON_CODE) &&
      (decision !== 'accepted' || !explicitlyReviewedRemoval)
    ) invalid(expectedProjectId);
    if (
      decision === 'accepted' &&
      ((!surface.eligibleForHumanAcceptance && !explicitlyReviewedRemoval) ||
       !surface.hardQualityPassed ||
       !surface.corpusQualityReport.eligibleForApproval ||
       !reviewCandidate.pageQualityReport.eligibleForApproval)
    ) invalid(expectedProjectId);
    const candidate = Object.freeze({
      schemaVersion: INTEGRATED_WIKI_CANDIDATE_REVIEW_SCHEMA_VERSION,
      projectId: expectedProjectId,
      reviewSurfaceDigest: surface.surfaceDigest,
      pageId,
      proposalDigest: reviewCandidate.proposal.proposalDigest,
      generationReceiptDigest: reviewCandidate.generationReceipt.receiptDigest,
      contentDiffDigest: reviewCandidate.contentDiff.diffDigest,
      pageQualityReportDigest: reviewCandidate.pageQualityReport.reportDigest,
      corpusQualityReportDigest: surface.corpusQualityReport.reportDigest,
      planningInventoryDigest: surface.planningInventoryDigest,
      decision,
      reasonCodes,
      canonicalMutationAuthorized: false as const,
    });
    return Object.freeze({
      ...candidate,
      reviewDigest: digestHierarchyValue(reviewWithoutDigest(candidate)),
    });
  } catch {
    return invalid(expectedProjectId);
  }
}
