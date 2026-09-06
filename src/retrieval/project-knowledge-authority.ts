import { parseKnowledgeGenerationChain } from '../compiler/project-knowledge/generation.js';
import { knowledgeHierarchyPurpose, knowledgeHierarchySnapshot, knowledgeHierarchySections, knowledgeHierarchySummary,
  type KnowledgeHierarchyBridgeV1, type KnowledgeHierarchyMappingV1 } from '../compiler/project-knowledge/hierarchy-bridge.js';
import { boundedJson, compare, digest, invalid, keys, record } from '../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1 } from '../knowledge/project-knowledge/types.js';
import { approveChildSummaryForSynthesis, createCompileCandidateReview,
  checkAuthoritativeWikiState, createHumanActivationApproval, createPageOwnershipGraph,
  digestHierarchyValue,
  finalizeCompileRun, verifyCompileRunApproval,
  type CorpusSnapshotV1, type FinalizeCompileRunInputV1 } from '../compiler/hierarchy/index.js';
import type { ApprovedWikiAuthorityV1 } from './approved-corpus-store.js';

export interface KnowledgeAuthorityExtensionV1 {
  readonly schemaVersion: 'buildlore.knowledge-authority-extension.v1';
  readonly generationDigest: KnowledgeDigest;
  readonly generations: readonly KnowledgeGenerationV1[];
  readonly pageMappings: readonly KnowledgeHierarchyMappingV1[];
  readonly evidenceMappings: KnowledgeHierarchyBridgeV1['evidenceMappings'];
  readonly extensionDigest: KnowledgeDigest;
}

/** Replay knowledge, then prove that the existing approved hierarchy carries the same claims and evidence. */
export function parseKnowledgeAuthorityExtension(value: unknown,
  authority: Readonly<{ projectId: string; liveSnapshot: CorpusSnapshotV1; finalization: FinalizeCompileRunInputV1 }>,
): KnowledgeAuthorityExtensionV1 {
  const input = record(boundedJson(value));
  keys(input, ['schemaVersion', 'generationDigest', 'generations', 'pageMappings', 'evidenceMappings', 'extensionDigest']);
  const generations = parseKnowledgeGenerationChain(input.generations, authority.projectId);
  const generation = generations.at(-1);
  if (!generation || input.schemaVersion !== 'buildlore.knowledge-authority-extension.v1' ||
      input.generationDigest !== generation.generationDigest ||
      authority.finalization.outline.purposeDigest !== knowledgeHierarchyPurpose(generation).purposeDigest ||
      digest(authority.liveSnapshot) !== digest(knowledgeHierarchySnapshot(generation))) invalid();
  const units = authority.liveSnapshot.textUnits;
  const facts = new Map(generation.records.map((f) => [f.id, f]));
  const evidenceMappings = generation.evidence.flatMap((e) => {
    const sourceId = `source-${digestHierarchyValue({ projectId: authority.projectId, evidenceId: e.evidenceId }).slice(7)}`;
    const unit = units.find((u) => u.sourceId === sourceId);
    if (!unit) return invalid();
    const matches = authority.finalization.evidencePacks.flatMap((p) => p.units.filter((u) => u.unitId === unit.unitId));
    if (matches.length === 0) return [];
    if (matches.some((m) => m.content !== e.excerpt || m.contentDigest !== e.excerptDigest ||
        m.citation.sourceRevision !== e.sourceContentDigest || digest(m) !== digest(matches[0]))) invalid();
    return [{ evidenceId: e.evidenceId, unitId: unit.unitId, citationId: matches[0]?.citation.citationId ?? invalid() }];
  }).sort((a, b) => compare(a.evidenceId, b.evidenceId));
  const byEvidence = new Map(evidenceMappings.map((e) => [e.evidenceId, e]));
  const pageMappings = (['architecture', 'decisions', 'overview'] as const).map((role) => {
    const page = generation.pages.find((p) => p.role === role);
    const blueprint = authority.finalization.outline.blueprints.find((b) => b.stableKey === `knowledge.${role}`);
    const proposal = authority.finalization.proposals.find((p) => p.pageId === blueprint?.pageId);
    if (!page || !blueprint || !proposal || page.title !== proposal.title) invalid();
    const claims = page.sections.flatMap((s) => s.claims).map((claim) => {
      const evidenceIds = [...new Set(claim.factIds.flatMap((id) => facts.get(id)?.evidenceIds ?? invalid()))].sort();
      const matches = evidenceIds.map((id) => byEvidence.get(id) ?? invalid());
      const basis = { text: claim.text, evidenceUnitIds: matches.map((e) => e.unitId).sort(),
        citationIds: matches.map((e) => e.citationId).sort() };
      const hierarchyClaimId = `claim-${digestHierarchyValue(basis).slice(7)}`;
      if (!proposal.claims.some((c) => digest(c) === digest({ ...basis, claimId: hierarchyClaimId }))) invalid();
      return { claimId: claim.claimId, hierarchyClaimId, factIds: claim.factIds };
    });
    const linkedClaims = claims.map((mapping) => proposal.claims.find((claim) => claim.claimId === mapping.hierarchyClaimId) ?? invalid());
    const children = role === 'overview' ? (['architecture', 'decisions'] as const).map((childRole) => {
      const childBlueprint = authority.finalization.outline.blueprints.find((b) => b.stableKey === `knowledge.${childRole}`);
      const child = authority.finalization.proposals.find((p) => p.pageId === childBlueprint?.pageId) ?? invalid();
      return approveChildSummaryForSynthesis(child, createCompileCandidateReview(child, 'accepted', authority.projectId), authority.projectId);
    }) : [];
    const links = [...blueprint.childPageIds, ...(blueprint.parentPageId === null ? [] : [blueprint.parentPageId])].sort();
    const sections = knowledgeHierarchySections(page, linkedClaims, children, links);
    if (proposal.summary !== knowledgeHierarchySummary(page) || digest(proposal.wikilinks) !== digest(links) ||
        sections.some((section) => digest(section) !== digest(proposal.sections.find((s) => s.sectionId === section.sectionId) ?? null))) invalid();
    if (claims.length !== proposal.claims.length || page.sections.length !== proposal.sections.length ||
        page.sections.some((section, index) => proposal.sections.find((s) => s.sectionId === `knowledge-${String(index)}`)?.title !== section.title)) invalid();
    return { role, pageId: blueprint.pageId, claims };
  });
  if (authority.finalization.proposals.length !== 3 || authority.finalization.outline.blueprints.length !== 3) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-authority-extension.v1' as const,
    generationDigest: generation.generationDigest, generations, pageMappings, evidenceMappings };
  const result = Object.freeze({ ...basis, extensionDigest: digest(basis) });
  if (digest(input) !== digest(result)) invalid();
  return result;
}

export function createKnowledgeAuthorityExtension(generations: readonly KnowledgeGenerationV1[],
  bridge: KnowledgeHierarchyBridgeV1, projectId: string): KnowledgeAuthorityExtensionV1 {
  const generation = generations.at(-1);
  if (!generation) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-authority-extension.v1' as const,
    generationDigest: generation.generationDigest, generations,
    pageMappings: bridge.pageMappings, evidenceMappings: bridge.evidenceMappings };
  return parseKnowledgeAuthorityExtension({ ...basis, extensionDigest: digest(basis) }, {
    projectId, liveSnapshot: bridge.snapshot, finalization: bridge.finalization });
}

/** Creates the existing approval-bound envelope; publication remains a separate explicit step. */
export function approveKnowledgeWikiAuthority(input: Readonly<{
  generations: readonly KnowledgeGenerationV1[];
  bridge: KnowledgeHierarchyBridgeV1;
  previousAuthority: ApprovedWikiAuthorityV1 | null;
  explicitConfirmation: true;
}>): ApprovedWikiAuthorityV1 {
  if (input.explicitConfirmation !== true) invalid();
  const { bridge, previousAuthority } = input;
  const projectId = bridge.snapshot.projectId;
  if (previousAuthority !== null && previousAuthority.projectId !== projectId) invalid();
  const previousChain = previousAuthority?.knowledgeGeneration?.generations ?? [];
  if (input.generations.length !== previousChain.length + 1 ||
      digest(input.generations.slice(0, -1)) !== digest(previousChain) ||
      bridge.finalization.baselineGenerationDigest !== (previousAuthority?.state.generationDigest ?? null) ||
      digest([...bridge.finalization.baselineProposals].sort((a, b) => compare(a.pageId, b.pageId))) !==
        digest([...(previousAuthority?.finalization.proposals ?? [])].sort((a, b) => compare(a.pageId, b.pageId)))) invalid();
  const extension = createKnowledgeAuthorityExtension(input.generations, bridge, projectId);
  const finalization = bridge.finalization;
  const ledger = finalizeCompileRun(finalization, projectId);
  const ownershipGraph = createPageOwnershipGraph(bridge.snapshot, finalization.outline, ledger,
    finalization.proposals, finalization.evidencePacks, projectId);
  const currentState = previousAuthority?.state ?? null;
  const humanActivationApproval = createHumanActivationApproval({ ledger, ownershipGraph, currentState,
    decision: 'approved', explicitConfirmation: true }, projectId);
  const state = verifyCompileRunApproval({ currentState, finalization, humanActivationApproval,
    ledger, liveSnapshot: bridge.snapshot, ownershipGraph }, projectId);
  return Object.freeze({ schemaVersion: 'buildlore.approved-wiki-authority.v2', projectId,
    knowledgeGeneration: extension, currentState, finalization, humanActivationApproval, ledger,
    liveSnapshot: bridge.snapshot, ownershipGraph, state,
    authorityCheck: checkAuthoritativeWikiState(state, ownershipGraph, bridge.snapshot, humanActivationApproval, projectId) });
}
