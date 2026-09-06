import { invalid } from '../knowledge/project-knowledge/guards.js';
import type { KnowledgeRecordV1 } from '../knowledge/project-knowledge/types.js';
import type { KnowledgeAuthorityExtensionV1 } from './project-knowledge-authority.js';
import type { ApprovedWikiMeaningSignalV1, ApprovedWikiRetrievalCorpusV1,
  HierarchicalRetrievalLocatorV1 } from './hierarchical.js';

function stateSignal(facts: readonly KnowledgeRecordV1[], sourceId: string): ApprovedWikiMeaningSignalV1 {
  if (facts.length === 0) invalid();
  const unconfirmed = facts.some((fact) => fact.reviewStatus !== 'accepted' || fact.lifecycle === 'stale');
  const current = !unconfirmed && facts.every((fact) => fact.lifecycle === 'current');
  const historical = !unconfirmed && facts.every((fact) => ['historical', 'superseded'].includes(fact.lifecycle));
  return Object.freeze({ sourceId, origin: 'adapter',
    authority: current ? 'supporting' : historical ? 'historical' : 'unknown',
    lifecycle: unconfirmed ? 'draft' : current ? 'current'
      : historical && facts.every((fact) => fact.lifecycle === 'superseded') ? 'superseded' : 'unknown',
    // These are ranking hints, not a relabeling of canonical facts or their evidence.
    evidenceKind: 'other', revisionOrdinal: 0, iterationGroup: null, topicGroup: null });
}

/** @internal Both inputs come from one verified publication. Do not rewrite its stored projection. */
export function createKnowledgeRankingSignals(extension: KnowledgeAuthorityExtensionV1,
  corpus: ApprovedWikiRetrievalCorpusV1,
): (locator: HierarchicalRetrievalLocatorV1) => readonly ApprovedWikiMeaningSignalV1[] {
  const generation = extension.generations.at(-1);
  if (!generation || generation.projectId !== corpus.projectId || generation.generationDigest !== extension.generationDigest) invalid();
  const records = new Map(generation.records.map((fact) => [fact.id, fact]));
  const evidenceByCitation = new Map(extension.evidenceMappings.map((mapping) => [mapping.citationId, mapping.evidenceId]));
  const signals = new Map<string, readonly ApprovedWikiMeaningSignalV1[]>();
  for (const projectedPage of corpus.pages) {
    const mapping = extension.pageMappings.find((item) => item.pageId === projectedPage.pageId) ?? invalid();
    const page = generation.pages.find((item) => item.role === mapping.role) ?? invalid();
    for (const section of projectedPage.sections) {
      const index = page.sections.findIndex((_, i) => section.sectionId === `knowledge-${String(i)}`);
      const sourceSection = page.sections[index] ?? invalid();
      const inherited = page.role === 'overview' && index === 0
        ? generation.pages.filter((child) => child.role !== 'overview').map((child) => child.sections[0]?.claims[0] ?? invalid()) : [];
      const facts = [...new Set([...sourceSection.claims, ...inherited].flatMap((claim) => claim.factIds))]
        .map((id) => records.get(id) ?? invalid());
      const sourceIds = [...new Set(section.citationLocators.map((locator) => locator.sourceId))].sort();
      signals.set(`${projectedPage.pageId}\0${section.sectionId}`, Object.freeze(sourceIds.map((sourceId) => {
        const evidenceIds = new Set(section.citationLocators.filter((locator) => locator.sourceId === sourceId)
          .map((locator) => evidenceByCitation.get(locator.citationId) ?? invalid()));
        // The same excerpt may support current and historical claims in different sections.
        return stateSignal(facts.filter((fact) => fact.evidenceIds.some((id) => evidenceIds.has(id))), sourceId);
      })));
    }
  }
  return (locator) => {
    if (locator.projectId !== corpus.projectId) invalid();
    return signals.get(`${locator.pageId}\0${locator.sectionId}`) ?? invalid();
  };
}
