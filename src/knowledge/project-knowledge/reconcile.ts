import { compare, digest, invalid, ProjectKnowledgeError } from './guards.js';
import { withRecordState } from './records.js';
import type { KnowledgeGenerationV1, KnowledgeProposalV1, KnowledgeRecordV1,
  KnowledgeSemanticReviewV1, KnowledgeSnapshotV1 } from './types.js';

function update(fact: KnowledgeRecordV1,
  state: Partial<Pick<KnowledgeRecordV1, 'lifecycle' | 'reviewStatus' | 'supersededBy'>>): KnowledgeRecordV1 {
  const { recordDigest: _digest, ...basis } = fact;
  void _digest;
  return withRecordState({ ...basis, ...state });
}

/** Internal pure reconciliation; callers validate the approved baseline and semantic receipt. */
export function reconcileKnowledge(snapshot: KnowledgeSnapshotV1, proposal: KnowledgeProposalV1,
  review: KnowledgeSemanticReviewV1, previous: KnowledgeGenerationV1 | null): readonly KnowledgeRecordV1[] {
  if (proposal.snapshotDigest !== snapshot.snapshotDigest || review.proposalDigest !== proposal.proposalDigest ||
      proposal.baselineGenerationDigest !== (previous?.generationDigest ?? null) ||
      (previous !== null && previous.projectId !== snapshot.projectId)) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
  const judgmentById = new Map(review.judgments.map((j) => [j.targetId, j]));
  const currentEvidence = new Set(snapshot.evidence.map((e) => e.evidenceId));
  const records = new Map<string, KnowledgeRecordV1>();
  for (const fact of previous?.records ?? []) {
    // A scope reduction is not a deletion. Either way, unconfirmed current claims become stale.
    // Partial loss also needs a fresh review: the remaining excerpt may support only
    // part of a compound statement. Re-proposing with sufficient support restores it.
    const supported = fact.evidenceIds.every((id) => currentEvidence.has(id));
    records.set(fact.id, update(fact, fact.lifecycle === 'current' && !supported ? { lifecycle: 'stale' } : {}));
  }
  for (const fact of proposal.facts) {
    const prior = records.get(fact.id);
    // A new receipt for the same statement does not undo a reviewed replacement.
    // Historical support may be refreshed, but the existing transition survives.
    if (prior?.lifecycle === 'superseded' && fact.lifecycle === 'current') invalid();
    const judgment = judgmentById.get(fact.id);
    if (!judgment) throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
    if (judgment.verdict === 'supported' &&
        !judgment.evidenceIds.some((id) => fact.evidenceIds.includes(id))) invalid();
    records.set(fact.id, update(fact, {
      ...(prior?.lifecycle === 'superseded' ? { lifecycle: 'superseded', supersededBy: prior.supersededBy } : {}),
      reviewStatus: judgment.verdict === 'supported' ? 'accepted'
        : judgment.verdict === 'conflicting' ? 'disputed' : 'proposed',
    }));
  }
  for (const link of proposal.supersessions) {
    const prior = records.get(link.previousFactId);
    const replacement = records.get(link.replacementFactId);
    const judgment = judgmentById.get(`supersession:${link.previousFactId}:${link.replacementFactId}`);
    if (!prior || !replacement || replacement.reviewStatus !== 'accepted' || replacement.lifecycle !== 'current' ||
        (prior.lifecycle === 'superseded' && !prior.supersededBy.includes(replacement.id)) ||
        judgment?.verdict !== 'supported' || !judgment.evidenceIds.some((id) => link.evidenceIds.includes(id)) ||
        prior.subject !== replacement.subject || prior.predicate !== replacement.predicate || prior.scope !== replacement.scope) invalid();
    records.set(prior.id, update(prior, { lifecycle: 'superseded', supersededBy: [replacement.id] }));
  }
  for (const conflict of proposal.conflicts) {
    const judgment = judgmentById.get(`conflict:${digest(conflict)}`);
    if (judgment?.verdict !== 'supported' && judgment?.verdict !== 'conflicting') invalid();
    for (const id of conflict.factIds) {
      const fact = records.get(id);
      if (!fact || fact.lifecycle === 'superseded') invalid();
      records.set(id, update(fact, { reviewStatus: 'disputed' }));
    }
  }
  for (const page of proposal.pages) {
    const titles = [`title:${page.role}`, ...page.sections.map((_, i) => `section:${page.role}:${String(i)}`)];
    if (titles.some((id) => judgmentById.get(id)?.verdict !== 'supported')) throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
    for (const claim of page.sections.flatMap((s) => s.claims)) {
      const judgment = judgmentById.get(claim.claimId);
      if (judgment?.verdict !== 'supported') throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
      const facts = claim.factIds.map((id) => {
        const fact = records.get(id);
        if (!fact) return invalid();
        return fact;
      });
      if (!facts.some((fact) => fact.evidenceIds.some((id) => judgment.evidenceIds.includes(id)))) invalid();
      if (claim.presentation === 'current' && facts.some((f) => f.lifecycle !== 'current' || f.reviewStatus !== 'accepted')) invalid();
      if (claim.presentation === 'history' && facts.some((f) => !['historical', 'superseded'].includes(f.lifecycle))) invalid();
      if (claim.presentation === 'uncertainty' && facts.every((f) => f.lifecycle === 'current' && f.reviewStatus === 'accepted')) invalid();
    }
  }
  // A supersession cannot introduce a cycle, including one spanning earlier generations.
  for (const fact of records.values()) {
    const visited = new Set<string>([fact.id]);
    const pending: string[] = [...fact.supersededBy];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || visited.has(id)) invalid();
      visited.add(id);
      const target = records.get(id);
      if (!target) invalid();
      pending.push(...target.supersededBy);
    }
  }
  if (records.size > 2048) invalid();
  return Object.freeze([...records.values()].sort((a, b) => compare(a.id, b.id)));
}
