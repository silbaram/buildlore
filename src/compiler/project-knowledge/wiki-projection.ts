import { invalid } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeGenerationV1, KnowledgePageV1, KnowledgeProposalV1, KnowledgeSemanticReviewV1 } from '../../knowledge/project-knowledge/types.js';

/** Unsupported assertions stay in the reviewed draft, never in published prose. */
export function knowledgeWikiPublishedPages(proposal: KnowledgeProposalV1, review: KnowledgeSemanticReviewV1): readonly KnowledgePageV1[] {
  if (proposal.schemaVersion !== 'buildlore.knowledge-proposal.v2') invalid();
  const supported = new Set(review.judgments.filter(j => j.verdict === 'supported').map(j => j.targetId));
  const pages = proposal.pages.flatMap(page => {
    const sections = page.sections.flatMap(section => {
      const claims = section.claims.filter(claim => supported.has(claim.claimId));
      return claims.length === 0 ? [] : [{ ...section, claims: Object.freeze(claims),
        title: supported.has(`section:${page.role}:${section.sectionId ?? invalid()}`) ? section.title : section.sectionId ?? invalid() }];
    });
    return sections.length === 0 ? [] : [{ ...page, sections: Object.freeze(sections),
      title: supported.has(`title:${page.role}`) ? page.title : page.role }];
  });
  if (pages.length === 0) invalid();
  return Object.freeze(pages);
}

export function knowledgeWikiRoot(generation: KnowledgeGenerationV1): string {
  return generation.schemaVersion !== 'buildlore.knowledge-generation.v3' ? 'overview'
    : generation.pages.find(page => page.role === generation.proposal.rootPageId)?.role ?? generation.pages[0]?.role ?? invalid();
}

export function knowledgeWikiPageOrder(generation: KnowledgeGenerationV1): readonly string[] {
  if (generation.schemaVersion !== 'buildlore.knowledge-generation.v3') return ['architecture', 'decisions', 'overview'];
  const root = knowledgeWikiRoot(generation);
  return [...generation.pages.map(page => page.role).filter(role => role !== root).sort(), root];
}
