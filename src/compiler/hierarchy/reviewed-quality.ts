import { knowledgeWikiPageOrder, knowledgeWikiRoot, knowledgeWikiPublishedPages } from '../project-knowledge/wiki-projection.js';
import { digest, invalid } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeGenerationV1 } from '../../knowledge/project-knowledge/types.js';
import { requireReplayedKnowledgeGeneration } from '../project-knowledge/generation.js';
import { knowledgeHierarchySections, knowledgeHierarchySummary } from '../project-knowledge/hierarchy-prose.js';
import { digestHierarchyValue } from './contracts.js';
import { approveChildSummaryForSynthesis } from './evidence.js';
import type { EvidencePackV1, HierarchicalWikiProposalV1, HierarchySha256Digest, WikiOutlineV1 } from './types.js';

/** Versioned independently reviewed path; the legacy lexical policy remains unchanged. */
export const REVIEWED_KNOWLEDGE_QUALITY_POLICY_DIGEST = digestHierarchyValue({
  schemaVersion: 'buildlore.reviewed-knowledge-quality-policy.v1',
  support: 'replayed-independent-source-support-and-currentness',
  questions: 'reviewed-section-claims',
  structure: 'buildlore.semantic-quality-policy.v2',
});

export const GENERIC_WIKI_QUALITY_POLICY_DIGEST = digestHierarchyValue({ schemaVersion: 'buildlore.reviewed-wiki-quality-policy.v1',
  support: 'independent-source-judgments-and-usefulness', publication: 'supported-prose-only',
  hard: 'structural-and-citation-integrity', heuristics: 'recorded-advisory' });

export interface ReviewedKnowledgeQuality {
  readonly genericWiki?: true;
  readonly generationDigest: HierarchySha256Digest;
  readonly reviewDigest: HierarchySha256Digest;
}

interface QualityInputs {
  readonly outline: WikiOutlineV1;
  readonly proposals: readonly HierarchicalWikiProposalV1[];
  readonly evidencePacks: readonly EvidencePackV1[];
}

const issued = new WeakMap<ReviewedKnowledgeQuality, string>();

function binding(input: QualityInputs): string {
  const sorted = <T extends { readonly pageId: string }>(items: readonly T[]): readonly T[] =>
    [...items].sort((a, b) => a.pageId.localeCompare(b.pageId));
  return digest({ outline: input.outline, proposals: sorted(input.proposals), packs: sorted(input.evidencePacks) });
}

/** Reconstruct exact prose and citations from a genuinely replayed knowledge generation.
 * The returned in-process capability is never accepted from serialized input.
 */
export function createReviewedKnowledgeQuality(generation: KnowledgeGenerationV1,
  input: QualityInputs): ReviewedKnowledgeQuality {
  requireReplayedKnowledgeGeneration(generation);
  const projectId = generation.projectId;
  const generic = generation.schemaVersion === 'buildlore.knowledge-generation.v3';
  const count = generic ? generation.pages.length : 3;
  if (generic && (input.outline.schemaVersion !== 'buildlore.wiki-outline.v3' ||
    digest(generation.pages) !== digest(knowledgeWikiPublishedPages(generation.proposal, generation.review)))) invalid();
  if (input.outline.projectId !== projectId || input.proposals.length !== count ||
      input.outline.blueprints.length !== count || input.evidencePacks.length !== count) invalid();
  const facts = new Map(generation.records.map(f => [f.id, f]));
  for (const page of generation.pages) {
    const blueprint = input.outline.blueprints.find(b => b.stableKey === `knowledge.${page.role}`);
    const proposal = input.proposals.find(p => p.pageId === blueprint?.pageId);
    const pack = input.evidencePacks.find(p => p.pageId === blueprint?.pageId);
    if (!blueprint || !proposal || !pack || proposal.projectId !== projectId || pack.projectId !== projectId ||
        blueprint.title !== page.title || proposal.title !== page.title ||
        digest(blueprint.keyQuestions) !== digest(page.sections.map(s => s.title))) invalid();
    const supportsHeading = (targetId: string, factIds: readonly HierarchySha256Digest[]): boolean => {
      const review = generation.review.judgments.find(j => j.targetId === targetId);
      const evidenceIds = new Set(factIds.flatMap(id => facts.get(id)?.evidenceIds ?? invalid()));
      return review?.verdict === 'supported' && review.evidenceIds.some(id => evidenceIds.has(id));
    };
    if (!generic && (!supportsHeading(`title:${page.role}`, page.sections.flatMap(s => s.claims.flatMap(c => c.factIds))) ||
        page.sections.some((section, i) => !supportsHeading(`section:${page.role}:${String(i)}`,
          section.claims.flatMap(c => c.factIds))))) invalid();
    const claims = page.sections.flatMap(s => s.claims).map(claim => {
      const evidenceIds = [...new Set(claim.factIds.flatMap(id => facts.get(id)?.evidenceIds ?? invalid()))].sort();
      const units = evidenceIds.map(id => {
        const evidence = generation.evidence.find(e => e.evidenceId === id) ?? invalid();
        const sourceId = `source-${digestHierarchyValue({ projectId, evidenceId: id }).slice(7)}`;
        const unit = pack.units.find(u => u.sourceId === sourceId) ?? invalid();
        if (unit.content !== evidence.excerpt || unit.contentDigest !== evidence.excerptDigest ||
            unit.citation.sourceRevision !== evidence.sourceContentDigest || unit.citation.sourceRef !== (evidence.origin?.sourceRef ?? evidence.sourceRef)) invalid();
        return unit;
      });
      const basis = { text: claim.text, evidenceUnitIds: units.map(u => u.unitId).sort(),
        citationIds: units.map(u => u.citation.citationId).sort() };
      return { ...basis, claimId: `claim-${digestHierarchyValue(basis).slice(7)}` };
    });
    // Claims are sorted by the hierarchy parser, whereas prose retains section order.
    const sortedClaims = <T extends { readonly claimId: string }>(items: readonly T[]): readonly T[] => [...items].sort((a, b) => a.claimId.localeCompare(b.claimId));
    if (digest(sortedClaims(claims)) !== digest(sortedClaims([...proposal.claims]))) invalid();
    const children = page.role === knowledgeWikiRoot(generation) ? knowledgeWikiPageOrder(generation).filter(role => role !== page.role).map(role => {
      const childBlueprint = input.outline.blueprints.find(b => b.stableKey === `knowledge.${role}`);
      const child = input.proposals.find(p => p.pageId === childBlueprint?.pageId) ?? invalid();
      const review = { pageId: child.pageId, proposalDigest: child.proposalDigest, decision: 'accepted' as const };
      return approveChildSummaryForSynthesis(child, { ...review, reviewDigest: digestHierarchyValue(review) }, projectId);
    }) : [];
    const links = [...blueprint.childPageIds, ...(blueprint.parentPageId === null ? [] : [blueprint.parentPageId])].sort();
    const sections = knowledgeHierarchySections(page, claims, children, links);
    if (proposal.summary !== knowledgeHierarchySummary(page) || digest(proposal.wikilinks) !== digest(links) ||
        sections.length !== proposal.sections.length || sections.some(section =>
          digest(section) !== digest(proposal.sections.find(s => s.sectionId === section.sectionId) ?? null))) invalid();
  }
  const context = Object.freeze({ ...(generic ? { genericWiki: true as const } : {}), generationDigest: generation.generationDigest, reviewDigest: generation.review.reviewDigest });
  issued.set(context, binding(input));
  return context;
}

export function verifyReviewedKnowledgeQuality(context: ReviewedKnowledgeQuality,
  input: QualityInputs): void {
  if (issued.get(context) !== binding(input)) invalid();
}
