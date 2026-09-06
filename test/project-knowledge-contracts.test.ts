import { describe, expect, it } from 'vitest';
import { createKnowledgeSnapshot, knowledgeObservationStatement, parseKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { createProposedKnowledgeRecord } from '../src/knowledge/project-knowledge/records.js';
import { boundedJson, digest, ProjectKnowledgeError } from '../src/knowledge/project-knowledge/guards.js';
import { createKnowledgeGeneration, parseKnowledgeGenerationChain } from '../src/compiler/project-knowledge/generation.js';
import { createKnowledgeProposal, parseKnowledgeProposal, parseKnowledgeSemanticReview } from '../src/compiler/project-knowledge/proposal.js';
import { fixtureFact, fixtureProposal, fixtureReview, knowledgeFixtureSnapshot,
  TEST_KNOWLEDGE_ACTOR } from './helpers/project-knowledge-fixture.js';

describe('project knowledge contracts', () => {
  it('rejects reserved claim namespaces and duplicate review targets even with recomputed digests', async () => {
    const snapshot = await knowledgeFixtureSnapshot();
    const proposal = fixtureProposal(snapshot);
    const first = proposal.facts[0];
    if (!first) throw new Error('Missing fixture fact.');
    for (const claimId of ['title:overview', 'section:overview:0', first.id,
      `conflict:${digest('conflict')}`, `supersession:${first.id}:${first.id}`]) {
      const { proposalDigest: old, ...basis } = proposal;
      void old;
      const changed = { ...basis, pages: proposal.pages.map((p) => p.role !== 'overview' ? p : {
        ...p, sections: p.sections.map((s) => ({ ...s, claims: s.claims.map((c) => ({ ...c, claimId })) })),
      }) };
      expect(() => parseKnowledgeProposal({ ...changed, proposalDigest: digest(changed) }, snapshot)).toThrow(ProjectKnowledgeError);
      expect(() => createKnowledgeProposal({ projectId: snapshot.projectId, snapshotDigest: snapshot.snapshotDigest,
        baselineGenerationDigest: null, actor: TEST_KNOWLEDGE_ACTOR, facts: [fixtureFact(snapshot)],
        pages: changed.pages, supersessions: [], conflicts: [] }, snapshot)).toThrow(ProjectKnowledgeError);
    }
    const { reviewDigest: old, ...basis } = fixtureReview(proposal);
    void old;
    const judgment = basis.judgments[0];
    if (!judgment) throw new Error('Missing fixture judgment.');
    const duplicate = { ...basis, judgments: [{ ...judgment, verdict: 'unsupported' }, ...basis.judgments] };
    expect(() => parseKnowledgeSemanticReview({ ...duplicate, reviewDigest: digest(duplicate) }, proposal, snapshot)).toThrow(ProjectKnowledgeError);
  });

  it('canonicalizes object keys without changing array order and refuses lossy non-JSON input', () => {
    expect(digest({ b: 2, a: { d: 4, c: 3 } })).toBe(digest({ a: { c: 3, d: 4 }, b: 2 }));
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
    for (const invalidInput of [{ optional: undefined }, { value: Number.NaN }, new Date(),
      [undefined], { toJSON: () => ({ hidden: true }) }, new Array<unknown>(3)]) {
      expect(() => boundedJson(invalidInput)).toThrow(ProjectKnowledgeError);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => boundedJson(cyclic)).toThrow(ProjectKnowledgeError);
    const shared = { allowed: true };
    expect(boundedJson([shared, shared])).toEqual([shared, shared]);
  });
  it('binds generic Markdown and JSON evidence without any P2A fields', async () => {
    const snapshot = await knowledgeFixtureSnapshot();
    expect(snapshot.evidence.some((e) => e.locator.kind === 'json-pointer' && e.locator.pointer === '/storage')).toBe(true);
    expect(snapshot.evidence.some((e) => e.locator.kind === 'lines')).toBe(true);
    expect(parseKnowledgeSnapshot(snapshot, 'parcel')).toEqual(snapshot);
    expect(() => parseKnowledgeSnapshot(snapshot, 'lantern')).toThrow(ProjectKnowledgeError);
  });

  it('rebuilds locators and excerpt content instead of trusting a rehashed manifest', async () => {
    const snapshot = await knowledgeFixtureSnapshot();
    const { snapshotDigest: _old, ...basis } = snapshot;
    void _old;
    const changed = { ...basis, evidence: snapshot.evidence.map((e) => ({ ...e, excerpt: 'Unsupported replacement' })) };
    expect(() => parseKnowledgeSnapshot({ ...changed, snapshotDigest: digest(changed) }, 'parcel')).toThrow(ProjectKnowledgeError);
  });

  it('does not turn a parsed passed value into observed current-code verification', async () => {
    const snapshot = await knowledgeFixtureSnapshot();
    const evidence = snapshot.evidence.find((e) => e.locator.kind === 'json-pointer' && e.locator.pointer === '/verification/status');
    if (!evidence) throw new Error('Missing fixture status.');
    const literal = { ...fixtureFact(snapshot), evidenceIds: [evidence.evidenceId], classification: 'observed',
      observation: { kind: 'source-literal', evidenceId: evidence.evidenceId }, scope: 'source-literal-only',
      statement: knowledgeObservationStatement(evidence) };
    expect(createProposedKnowledgeRecord(literal, snapshot, TEST_KNOWLEDGE_ACTOR).classification).toBe('observed');
    expect(() => createProposedKnowledgeRecord({ ...literal, statement: 'The current code passed all tests.' }, snapshot, TEST_KNOWLEDGE_ACTOR)).toThrow(ProjectKnowledgeError);
    expect(() => createProposedKnowledgeRecord({ ...literal, scope: 'current production implementation' }, snapshot, TEST_KNOWLEDGE_ACTOR)).toThrow(ProjectKnowledgeError);
  });

  it('keeps semantic identity stable when only evidence revision changes', async () => {
    const r1 = await knowledgeFixtureSnapshot('R1');
    const r2 = await knowledgeFixtureSnapshot('R2');
    const first = createProposedKnowledgeRecord(fixtureFact(r1), r1, TEST_KNOWLEDGE_ACTOR);
    const second = createProposedKnowledgeRecord(fixtureFact(r2), r2, TEST_KNOWLEDGE_ACTOR);
    expect(first.id).toBe(second.id);
    expect(first.recordDigest).not.toBe(second.recordDigest);
  });

  it('rejects unsafe paths, duplicate input identity and unknown fields', async () => {
    const snapshot = await knowledgeFixtureSnapshot();
    const input = { projectId: snapshot.projectId, selectionDigest: snapshot.selectionDigest,
      sanitizerPolicyDigest: snapshot.sanitizerPolicyDigest, sanitizerRulesVersion: snapshot.sanitizerRulesVersion,
      sources: snapshot.sources };
    expect(() => createKnowledgeSnapshot({ ...input, sources: [...snapshot.sources, snapshot.sources[0]] }, 'parcel')).toThrow(ProjectKnowledgeError);
    expect(() => createKnowledgeSnapshot({ ...input, sources: snapshot.sources.map((s) => ({ ...s, sourceRef: '../other/README.md' })) }, 'parcel')).toThrow(ProjectKnowledgeError);
    expect(() => createKnowledgeSnapshot({ ...input, trustRawInput: true }, 'parcel')).toThrow(ProjectKnowledgeError);
  });

  it('retains a deleted support claim as stale, not feature removal', async () => {
    const r1 = await knowledgeFixtureSnapshot('R1');
    const support = r1.evidence.find((e) => e.sourceRef === 'support.md' && e.excerpt.includes('CSV'));
    if (!support) throw new Error('Missing support fixture.');
    const note = { ...fixtureFact(r1), subject: 'feature:csv', predicate: 'availability',
      statement: 'A draft note declares CSV export available.', evidenceIds: [support.evidenceId] };
    const proposal = fixtureProposal(r1, [fixtureFact(r1), note]);
    const first = createKnowledgeGeneration(r1, proposal, fixtureReview(proposal), null);
    const r2 = await knowledgeFixtureSnapshot('R2');
    const next = fixtureProposal(r2);
    const { schemaVersion: _version, proposalDigest: _digest, ...input } = next;
    void _version;
    void _digest;
    const secondProposal = createKnowledgeProposal({ ...input, baselineGenerationDigest: first.generationDigest,
      facts: [fixtureFact(r2)] }, r2);
    const second = createKnowledgeGeneration(r2, secondProposal, fixtureReview(secondProposal), first);
    expect(second.records.find((f) => f.subject === 'feature:csv')?.lifecycle).toBe('stale');
    expect(second.records.some((f) => /feature (?:was )?removed/u.test(f.statement))).toBe(false);
    expect(parseKnowledgeGenerationChain([first, second], 'parcel')).toEqual([first, second]);
    expect(() => parseKnowledgeGenerationChain([second], 'parcel')).toThrow(ProjectKnowledgeError);
  });
});
