import { describe, expect, it } from 'vitest';
import { createKnowledgeGeneration, parseKnowledgeGenerationChain } from '../src/compiler/project-knowledge/generation.js';
import { createKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { createKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { createProposedKnowledgeRecord } from '../src/knowledge/project-knowledge/records.js';
import { digest, sha256, ProjectKnowledgeError } from '../src/knowledge/project-knowledge/guards.js';
import type { KnowledgeFactInputV1, KnowledgeGenerationV1, KnowledgeProposalV1,
  KnowledgeSemanticReviewV1, KnowledgeSnapshotV1 } from '../src/knowledge/project-knowledge/types.js';
import { fixtureFact, fixtureProposal, fixtureReview, knowledgeFixtureSnapshot,
  TEST_KNOWLEDGE_ACTOR } from './helpers/project-knowledge-fixture.js';

function snapshotWithSources(snapshot: KnowledgeSnapshotV1, sources: KnowledgeSnapshotV1['sources'],
  selectionDigest = snapshot.selectionDigest): KnowledgeSnapshotV1 {
  return createKnowledgeSnapshot({ projectId: snapshot.projectId, selectionDigest,
    sanitizerPolicyDigest: snapshot.sanitizerPolicyDigest,
    sanitizerRulesVersion: snapshot.sanitizerRulesVersion, sources }, snapshot.projectId);
}

function proposalFor(snapshot: KnowledgeSnapshotV1, previous: KnowledgeGenerationV1 | null,
  facts: readonly KnowledgeFactInputV1[], changes: Partial<Pick<KnowledgeProposalV1,
    'pages' | 'supersessions' | 'conflicts'>> = {}): KnowledgeProposalV1 {
  const template = fixtureProposal(snapshot, facts);
  return createKnowledgeProposal({ projectId: snapshot.projectId, snapshotDigest: snapshot.snapshotDigest,
    baselineGenerationDigest: previous?.generationDigest ?? null, actor: TEST_KNOWLEDGE_ACTOR, facts,
    pages: changes.pages ?? template.pages, supersessions: changes.supersessions ?? [], conflicts: changes.conflicts ?? [] }, snapshot);
}

function reviewWith(proposal: KnowledgeProposalV1,
  customize: (judgment: KnowledgeSemanticReviewV1['judgments'][number]) => KnowledgeSemanticReviewV1['judgments'][number]): KnowledgeSemanticReviewV1 {
  const { reviewDigest: old, ...basis } = fixtureReview(proposal);
  void old;
  const changed = { ...basis, judgments: basis.judgments.map(customize) };
  return { ...changed, reviewDigest: digest(changed) };
}

describe('project knowledge currentness and history', () => {
  it('preserves supersession on historical re-proposal and rejects resurrection or redirected history', async () => {
    const snapshot = await knowledgeFixtureSnapshot();
    const a = fixtureFact(snapshot);
    const b = { ...a, statement: 'Replacement documented purpose.' };
    const c = { ...a, statement: 'Third documented purpose.' };
    const id = (fact: KnowledgeFactInputV1) => createProposedKnowledgeRecord(fact, snapshot, TEST_KNOWLEDGE_ACTOR).id;
    const firstProposal = proposalFor(snapshot, null, [a]);
    const first = createKnowledgeGeneration(snapshot, firstProposal, fixtureReview(firstProposal), null);
    const secondProposal = proposalFor(snapshot, first, [b], {
      supersessions: [{ previousFactId: id(a), replacementFactId: id(b), evidenceIds: b.evidenceIds }],
    });
    const second = createKnowledgeGeneration(snapshot, secondProposal, fixtureReview(secondProposal), first);
    const resurrect = proposalFor(snapshot, second, [a]);
    expect(() => createKnowledgeGeneration(snapshot, resurrect, fixtureReview(resurrect), second)).toThrow(ProjectKnowledgeError);
    const template = fixtureProposal(snapshot, [a]);
    const historical = proposalFor(snapshot, second, [{ ...a, lifecycle: 'historical' }], {
      pages: template.pages.map((p) => ({ ...p, sections: p.sections.map((s) => ({ ...s,
        claims: s.claims.map((claim) => ({ ...claim, presentation: 'history' as const })),
      })) })),
    });
    const refreshed = createKnowledgeGeneration(snapshot, historical, fixtureReview(historical), second);
    expect(refreshed.records.find((f) => f.id === id(a))).toMatchObject({ lifecycle: 'superseded', supersededBy: [id(b)] });
    expect(refreshed.records.find((f) => f.id === id(b))).toMatchObject({ lifecycle: 'current', reviewStatus: 'accepted' });
    const redirect = proposalFor(snapshot, refreshed, [c], {
      supersessions: [{ previousFactId: id(a), replacementFactId: id(c), evidenceIds: c.evidenceIds }],
    });
    expect(() => createKnowledgeGeneration(snapshot, redirect, fixtureReview(redirect), refreshed)).toThrow(ProjectKnowledgeError);
    const thirdProposal = proposalFor(snapshot, refreshed, [c], {
      supersessions: [{ previousFactId: id(b), replacementFactId: id(c), evidenceIds: c.evidenceIds }],
    });
    const third = createKnowledgeGeneration(snapshot, thirdProposal, fixtureReview(thirdProposal), refreshed);
    expect(third.records.find((f) => f.id === id(a))?.supersededBy).toEqual([id(b)]);
    expect(third.records.find((f) => f.id === id(b))?.supersededBy).toEqual([id(c)]);
    expect(parseKnowledgeGenerationChain([first, second, refreshed, third], snapshot.projectId)).toHaveLength(4);
  });

  it('requires re-review after partial evidence loss; valid remaining support can restore the same fact', async () => {
    const r1 = await knowledgeFixtureSnapshot();
    const purpose = fixtureFact(r1);
    const extra = r1.evidence.find((e) => e.sourceRef === 'architecture.md');
    if (!extra) throw new Error('Missing fixture evidence.');
    const compound = { ...purpose, evidenceIds: [...purpose.evidenceIds, extra.evidenceId] };
    const firstProposal = proposalFor(r1, null, [compound]);
    const first = createKnowledgeGeneration(r1, firstProposal, fixtureReview(firstProposal), null);
    const r2 = snapshotWithSources(r1, r1.sources.filter((s) => s.sourceRef !== 'architecture.md'));
    const unrelated = { ...fixtureFact(r2), subject: 'project:parcel-note' };
    const secondProposal = proposalFor(r2, first, [unrelated]);
    const second = createKnowledgeGeneration(r2, secondProposal, fixtureReview(secondProposal), first);
    expect(second.records.find((f) => f.id === first.records[0]?.id)?.lifecycle).toBe('stale');
    const restoreProposal = proposalFor(r2, second, [purpose]);
    const restored = createKnowledgeGeneration(r2, restoreProposal, fixtureReview(restoreProposal), second);
    expect(restored.records.find((f) => f.id === first.records[0]?.id)).toMatchObject({ lifecycle: 'current', reviewStatus: 'accepted' });
  });

  it('does not convert selection shrink, rename or unreadable-source omission into feature removal', async () => {
    const r1 = await knowledgeFixtureSnapshot();
    const firstProposal = fixtureProposal(r1);
    const first = createKnowledgeGeneration(r1, firstProposal, fixtureReview(firstProposal), null);
    const renamed = snapshotWithSources(r1, r1.sources.map((s) => s.sourceRef === 'README.md'
      ? { ...s, sourceId: 'source-renamed', sourceRef: 'moved.md' } : s), sha256('reduced-selection'));
    const reference = renamed.evidence.find((e) => e.sourceRef === 'moved.md' && e.excerpt.includes('Parcel'));
    if (!reference) throw new Error('Missing moved evidence.');
    const newFact = { ...fixtureFact(r1), subject: 'renamed-document', evidenceIds: [reference.evidenceId] };
    const proposal = proposalFor(renamed, first, [newFact]);
    const next = createKnowledgeGeneration(renamed, proposal, fixtureReview(proposal), first);
    expect(next.records.find((f) => f.id === first.records[0]?.id)?.lifecycle).toBe('stale');
    expect(next.records.some((f) => f.lifecycle === 'superseded')).toBe(false);
    // An incomplete/unreadable source is not representable as a valid source payload.
    expect(() => snapshotWithSources(r1, r1.sources.map((s) => ({ ...s, content: '' })))).toThrow(ProjectKnowledgeError);
  });

  it('supports reviewed, scoped supersession and historical citations from its bound baseline', async () => {
    const r1 = await knowledgeFixtureSnapshot();
    const r2 = await knowledgeFixtureSnapshot('R2');
    const oldEvidence = r1.evidence.find((e) => e.sourceRef === 'settings.json' && e.locator.kind === 'json-pointer' && e.locator.pointer === '/storage');
    const newEvidence = r2.evidence.find((e) => e.sourceRef === 'settings.json' && e.locator.kind === 'json-pointer' && e.locator.pointer === '/storage');
    if (!oldEvidence || !newEvidence) throw new Error('Missing storage evidence.');
    const oldFact = { ...fixtureFact(r1), subject: 'storage', predicate: 'backend', scope: 'documented configuration',
      statement: 'The R1 settings declare SQLite storage.', evidenceIds: [oldEvidence.evidenceId] };
    const oldProposal = fixtureProposal(r1, [oldFact]);
    const previous = createKnowledgeGeneration(r1, oldProposal, fixtureReview(oldProposal), null);
    const newFact = { ...oldFact, statement: 'The R2 settings declare JSON file storage.', evidenceIds: [newEvidence.evidenceId] };
    const replacement = createProposedKnowledgeRecord(newFact, r2, TEST_KNOWLEDGE_ACTOR);
    const prior = previous.records[0];
    if (!prior) throw new Error('Missing prior record.');
    const template = fixtureProposal(r2, [newFact]);
    const pages = template.pages.map((p) => ({ ...p, sections: [...p.sections, { title: 'Historical configuration',
      claims: [{ claimId: `history-${p.role}`, text: oldFact.statement, factIds: [prior.id], presentation: 'history' as const }] }] }));
    const proposal = proposalFor(r2, previous, [newFact], { pages,
      supersessions: [{ previousFactId: prior.id, replacementFactId: replacement.id, evidenceIds: newFact.evidenceIds }] });
    const review = reviewWith(proposal, (j) => j.targetId.startsWith('history-')
      ? { ...j, evidenceIds: oldFact.evidenceIds } : j);
    const generation = createKnowledgeGeneration(r2, proposal, review, previous);
    expect(generation.records.find((f) => f.id === prior.id)).toMatchObject({ lifecycle: 'superseded', supersededBy: [replacement.id] });
    expect(generation.evidence.some((e) => e.evidenceId === oldEvidence.evidenceId)).toBe(true);
    expect(parseKnowledgeGenerationChain([previous, generation], 'parcel')).toEqual([previous, generation]);
    const wrongScope = { ...newFact, scope: 'another environment' };
    const wrongId = createProposedKnowledgeRecord(wrongScope, r2, TEST_KNOWLEDGE_ACTOR).id;
    const wrong = proposalFor(r2, previous, [wrongScope], {
      supersessions: [{ previousFactId: prior.id, replacementFactId: wrongId, evidenceIds: newFact.evidenceIds }] });
    expect(() => createKnowledgeGeneration(r2, wrong, fixtureReview(wrong), previous)).toThrow(ProjectKnowledgeError);
  });

  it('keeps unresolved conflicting facts disputed and out of current prose', async () => {
    const snapshot = await knowledgeFixtureSnapshot('R2');
    const first = fixtureFact(snapshot);
    const second = { ...first, statement: 'An incompatible fixture statement.', subject: first.subject };
    const ids = [first, second].map((f) => createProposedKnowledgeRecord(f, snapshot, TEST_KNOWLEDGE_ACTOR).id).sort();
    const current = proposalFor(snapshot, null, [first, second], { conflicts: [{ factIds: ids }] });
    expect(() => createKnowledgeGeneration(snapshot, current, fixtureReview(current), null)).toThrow(ProjectKnowledgeError);
    const proposal = proposalFor(snapshot, null, [first, second], { conflicts: [{ factIds: ids }],
      pages: current.pages.map((p) => ({ ...p, sections: p.sections.map((s) => ({ ...s,
        claims: s.claims.map((c) => ({ ...c, text: 'Fixture sources disagree; current behavior is unverified.',
          factIds: ids, presentation: 'uncertainty' as const })) })) })) });
    const generation = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null);
    expect(generation.records.every((f) => f.reviewStatus === 'disputed')).toBe(true);
  });

  it('rejects forged baselines, dangling links, rehashed accepted-state tampering and wrong revision review', async () => {
    const snapshot = await knowledgeFixtureSnapshot();
    const proposal = fixtureProposal(snapshot);
    const first = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null);
    const next = proposalFor(snapshot, first, [fixtureFact(snapshot)]);
    expect(() => createKnowledgeGeneration(snapshot, next, fixtureReview(next), JSON.parse(JSON.stringify(first)) as KnowledgeGenerationV1)).toThrow(ProjectKnowledgeError);
    const tampered = { ...first, records: first.records.map((f) => ({ ...f, statement: 'Invented accepted state' })) };
    expect(() => parseKnowledgeGenerationChain([tampered], 'parcel')).toThrow(ProjectKnowledgeError);
    const dangling = proposalFor(snapshot, first, [fixtureFact(snapshot)], { supersessions: [{
      previousFactId: sha256('missing'), replacementFactId: first.records[0]?.id ?? sha256('none'),
      evidenceIds: fixtureFact(snapshot).evidenceIds }] });
    expect(() => createKnowledgeGeneration(snapshot, dangling, fixtureReview(dangling), first)).toThrow(ProjectKnowledgeError);
    expect(() => createKnowledgeGeneration(snapshot, next, fixtureReview(proposal), first)).toThrow(ProjectKnowledgeError);
  });
});
