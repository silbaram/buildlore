import { knowledgeWikiReviewTargets } from '../../src/compiler/project-knowledge/wiki-contracts.js';
import type { KnowledgeDigest, KnowledgeProposalV1, KnowledgeSnapshotV1 } from '../../src/knowledge/project-knowledge/types.js';

export const wikiPurpose = (projectId: string) => ({ schemaVersion: 'buildlore.wiki-purpose.v1', projectId, outputLanguage: 'ko',
  goal: 'Understand the selected material and its limits.', audience: 'People and AI readers', template: 'general' });

/** Mechanical protocol fixture, never evidence of real AI review quality. */
export function wikiDraft(snapshot: KnowledgeSnapshotV1, pageIds = ['delivery'], extraUnsupported = false) {
  const evidence = snapshot.evidence.find(e => e.excerpt.length > 80 && e.sourceRef.endsWith('README.md')) ?? snapshot.evidence[0];
  if (!evidence) throw new Error('Missing regression source.');
  return { schemaVersion: 'buildlore.wiki-draft.v1', projectId: snapshot.projectId,
    actor: { sessionId: 'fixture-wiki-author', model: 'fixed-protocol-fixture', kind: 'agent' }, rootPageId: pageIds[0],
    pages: pageIds.map(id => ({ id, title: 'Delivery operations', sections: [{ id: 'instructions', title: 'Delivery instructions',
      claims: [{ id: `claim-${id}`, text: evidence.excerpt, evidenceIds: [evidence.evidenceId] },
        ...(extraUnsupported ? [{ id: `unsupported-${id}`, text: 'An undocumented automatic delivery schedule is guaranteed.', evidenceIds: [evidence.evidenceId] }] : [])] }] })) };
}

export function wikiReview(proposal: KnowledgeProposalV1, runId: string, previousFindings: readonly unknown[] = [], baseline: KnowledgeDigest | null = null) {
  const attachedEvidence = (targetId: string) => {
    const claim = proposal.pages.flatMap(page => page.sections.flatMap(section =>
      targetId === `title:${page.role}` || targetId === `section:${page.role}:${section.sectionId}`
        ? section.claims : section.claims.filter(claim => claim.claimId === targetId)))[0];
    return proposal.facts.find(fact => fact.id === claim?.factIds[0])?.evidenceIds ?? [];
  };
  return { schemaVersion: 'buildlore.wiki-review.v1', projectId: proposal.projectId, runId,
    proposalDigest: proposal.proposalDigest, snapshotDigest: proposal.snapshotDigest,
    reviewer: { sessionId: 'fixture-wiki-reviewer', model: 'fixed-protocol-fixture', kind: 'agent' },
    judgments: knowledgeWikiReviewTargets(proposal).map(targetId => ({ targetId,
      verdict: targetId.startsWith('unsupported-') ? 'unsupported' : 'supported', evidenceIds: attachedEvidence(targetId),
      rationale: 'Fixed regression judgment, not a real AI evaluation.' })), findings: previousFindings,
    baselineReview: baseline === null ? null : { generationDigest: baseline, decision: 'accepted', rationale: 'Fixture removal review.' },
    usable: true, rationale: 'Useful fixture statements remain available.' };
}
