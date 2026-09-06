import { describe, expect, it } from 'vitest';
import { createKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { createKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { createProposedKnowledgeRecord } from '../src/knowledge/project-knowledge/records.js';
import { digest, ProjectKnowledgeError } from '../src/knowledge/project-knowledge/guards.js';
import type { KnowledgeFactInputV1, KnowledgePageClaimV1 } from '../src/knowledge/project-knowledge/types.js';
import { digestHierarchyValue } from '../src/compiler/hierarchy/index.js';
import { projectApprovedWikiSemanticText, type ApprovedWikiRetrievalCorpusV1 } from '../src/retrieval/hierarchical.js';
import { createKnowledgeRankingSignals } from '../src/retrieval/project-knowledge-ranking.js';
import { searchApprovedWikiLexicalV3 } from '../src/retrieval/hybrid.js';
import type { KnowledgeAuthorityExtensionV1 } from '../src/retrieval/project-knowledge-authority.js';
import { fixtureFact, fixtureReview, knowledgeFixtureSnapshot, TEST_KNOWLEDGE_ACTOR } from './helpers/project-knowledge-fixture.js';

async function rankingFixture() {
  const snapshot = await knowledgeFixtureSnapshot();
  const base = fixtureFact(snapshot);
  const kinds = ['current', 'historical', 'stale', 'disputed', 'proposed'] as const;
  const facts: readonly KnowledgeFactInputV1[] = kinds.map((kind) => ({ ...base, subject: kind,
    lifecycle: kind === 'historical' || kind === 'stale' ? kind : 'current' }));
  const records = facts.map((fact) => createProposedKnowledgeRecord(fact, snapshot, TEST_KNOWLEDGE_ACTOR));
  const claims: readonly KnowledgePageClaimV1[] = records.map((fact, index) => ({ claimId: `claim-${kinds[index] ?? ''}`,
    text: base.statement, factIds: [fact.id], presentation: index === 0 ? 'current' : index === 1 ? 'history' : 'uncertainty' }));
  const current = records[0];
  const historical = records[1];
  if (!current || !historical) throw new Error('Missing fixture records.');
  const mixed: KnowledgePageClaimV1 = { claimId: 'claim-mixed', text: base.statement,
    factIds: [current.id, historical.id].sort(), presentation: 'uncertainty' };
  const proposal = createKnowledgeProposal({ projectId: snapshot.projectId, snapshotDigest: snapshot.snapshotDigest,
    baselineGenerationDigest: null, actor: TEST_KNOWLEDGE_ACTOR, facts, supersessions: [], conflicts: [],
    pages: (['overview', 'architecture', 'decisions'] as const).map((role) => ({ role, title: 'Local configuration',
      sections: (role === 'architecture' ? [...claims, mixed] : [{ ...claims[0], claimId: `claim-${role}` }])
        .map((claim) => ({ title: 'Documented configuration', claims: [claim] })),
    })) }, snapshot);
  const { reviewDigest: old, ...basis } = fixtureReview(proposal);
  void old;
  const review = { ...basis, judgments: basis.judgments.map((j) => j.targetId === records[3]?.id
    ? { ...j, verdict: 'conflicting' as const } : j.targetId === records[4]?.id ? { ...j, verdict: 'insufficient' as const } : j) };
  const generation = createKnowledgeGeneration(snapshot, proposal, { ...review, reviewDigest: digest(review) }, null);
  const pageId = 'page-ranking';
  const sourceId = 'source-ranking';
  const citationId = 'citation-ranking';
  const body = 'Local configuration documented support. [^citation-ranking]';
  const semantic = projectApprovedWikiSemanticText(body, 'Local configuration');
  const page = generation.pages.find((p) => p.role === 'architecture');
  if (!page || !base.evidenceIds[0]) throw new Error('Missing fixture page.');
  // Pure mapper fixture: the public reader integration separately verifies real authority receipts.
  const corpusBasis = { schemaVersion: 'buildlore.approved-wiki-retrieval-corpus.v2' as const,
    projectId: snapshot.projectId, generationDigest: digest('hierarchy-generation'), pages: [{
      pageId, title: 'Local configuration', summary: 'Documented local configuration.', status: 'active' as const,
      parentPageId: null, childPageIds: [], relationPageIds: [], proposalDigest: digest('proposal'), meaningSignals: [],
      sections: page.sections.map((_, index) => ({ sectionId: `knowledge-${String(index)}`, body,
        citationLocators: [{ sourceId, citationId }], meaningSignals: [],
        exclusionSummary: semantic.exclusionSummary, semanticContentDigest: semantic.semanticContentDigest,
        semanticText: semantic.semanticText })),
    }] };
  const corpus: ApprovedWikiRetrievalCorpusV1 = { ...corpusBasis, corpusDigest: digestHierarchyValue({
    generationDigest: corpusBasis.generationDigest, pages: corpusBasis.pages,
    projectId: corpusBasis.projectId, schemaVersion: corpusBasis.schemaVersion,
  }) };
  const extensionBasis = { schemaVersion: 'buildlore.knowledge-authority-extension.v1' as const,
    generationDigest: generation.generationDigest, generations: [generation],
    pageMappings: [{ role: 'architecture' as const, pageId, claims: [] }],
    evidenceMappings: [{ evidenceId: base.evidenceIds[0], unitId: 'unit-ranking', citationId }] };
  const extension: KnowledgeAuthorityExtensionV1 = { ...extensionBasis, extensionDigest: digest(extensionBasis) };
  const locator = (index: number) => ({ pageId, projectId: snapshot.projectId, sectionId: `knowledge-${String(index)}`,
    sourceIds: [sourceId], citationIds: [citationId] });
  return { corpus, extension, locator };
}

describe('knowledge state adapter for existing ranking', () => {
  it('ranks current and historical sections differently without changing stored corpus bytes', async () => {
    const { corpus, extension } = await rankingFixture();
    const before = JSON.stringify(corpus);
    const signals = createKnowledgeRankingSignals(extension, corpus);
    const search = (intent: 'current' | 'historical' | 'neutral') => searchApprovedWikiLexicalV3(corpus,
      { projectId: corpus.projectId, query: 'local configuration', mode: 'lexical', intent, topK: 10 }, signals);
    const current = search('current');
    const historical = search('historical');
    expect(current.hits[0]?.locator.sectionId).toBe('knowledge-0');
    expect(historical.hits[0]?.locator.sectionId).toBe('knowledge-1');
    expect(current.hits.find((h) => h.locator.sectionId === 'knowledge-3')?.meaningAdjustment.lifecycle).toBe(-0.003);
    expect(search('neutral').hits.every((h) => h.meaningAdjustment.total === 0)).toBe(true);
    expect(searchApprovedWikiLexicalV3(corpus, { projectId: corpus.projectId, query: 'local configuration',
      mode: 'lexical' }).hits.every((h) => h.meaningAdjustment.total === 0)).toBe(true);
    expect(JSON.stringify(corpus)).toBe(before);
  });

  it('scopes shared evidence to each section and keeps stale, disputed and mixed claims conservative', async () => {
    const { corpus, extension, locator } = await rankingFixture();
    const signals = createKnowledgeRankingSignals(extension, corpus);
    expect(signals(locator(0))[0]).toMatchObject({ lifecycle: 'current', authority: 'supporting' });
    expect(signals(locator(1))[0]).toMatchObject({ lifecycle: 'unknown', authority: 'historical' });
    for (const index of [2, 3, 4]) expect(signals(locator(index))[0]).toMatchObject({ lifecycle: 'draft', authority: 'unknown' });
    expect(signals(locator(5))[0]).toMatchObject({ lifecycle: 'unknown', authority: 'unknown' });
    expect(() => signals({ ...locator(0), projectId: 'different' })).toThrow(ProjectKnowledgeError);
    expect(() => signals(locator(99))).toThrow(ProjectKnowledgeError);
  });
});
