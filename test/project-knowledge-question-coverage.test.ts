import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { inspectKnowledgeQuestionCoverage } from '../src/compiler/project-knowledge/question-coverage.js';
import { createKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { createProposedKnowledgeRecord } from '../src/knowledge/project-knowledge/records.js';
import { digest, ProjectKnowledgeError, record } from '../src/knowledge/project-knowledge/guards.js';
import { fixtureFact, fixtureProposal, knowledgeFixtureSnapshot, TEST_KNOWLEDGE_ACTOR } from './helpers/project-knowledge-fixture.js';

async function fixture() {
  const snapshot = await knowledgeFixtureSnapshot('R2');
  const storage = snapshot.evidence.find(e => e.sourceRef === 'settings.json' && e.locator.kind === 'json-pointer' && e.locator.pointer === '/storage');
  if (!storage) throw new Error('Missing storage evidence.');
  const facts = [fixtureFact(snapshot), { ...fixtureFact(snapshot), subject: 'storage',
    statement: 'The storage setting declares json-file.', evidenceIds: [storage.evidenceId] }];
  const template = fixtureProposal(snapshot, facts);
  const ids = facts.map(fact => createProposedKnowledgeRecord(fact, snapshot, TEST_KNOWLEDGE_ACTOR).id);
  const proposal = createKnowledgeProposal({ projectId: 'parcel', snapshotDigest: snapshot.snapshotDigest,
    baselineGenerationDigest: null, actor: TEST_KNOWLEDGE_ACTOR, supersessions: [], conflicts: [],
    facts, pages: template.pages.map(page => ({ ...page,
    sections: page.sections.map(section => ({ ...section, claims: section.claims.map(claim => ({ ...claim,
      text: facts[page.role === 'decisions' ? 1 : 0]?.statement,
      factIds: [ids[page.role === 'decisions' ? 1 : 0]] })) })) })) }, snapshot);
  const requirement = { id: 'current-storage', sourceRef: 'settings.json', jsonPointer: '/storage', contentKind: 'json-value' };
  return { snapshot, proposal, requirement, storage };
}

describe('generic question coverage', () => {
  it('does not let a citation in another question hide a missing question-specific source', async () => {
    const f = await fixture();
    const questions = [
      { id: 'commands', claimIds: ['claim-architecture'], requirements: [f.requirement] },
      { id: 'decisions', claimIds: ['claim-decisions'], requirements: [f.requirement] },
    ];
    const report = inspectKnowledgeQuestionCoverage(f.snapshot, f.proposal, questions, 'parcel');
    expect(report.complete).toBe(false);
    expect(report.semanticReviewRequired).toBe(true);
    expect(report.questions[0]?.requirements[0]).toEqual({ id: 'current-storage', status: 'uncited',
      evidenceIds: [f.storage.evidenceId], citedEvidenceIds: [] });
    expect(report.questions[1]?.complete).toBe(true);
    const corrected = [{ ...questions[0], claimIds: ['claim-architecture', 'claim-decisions'] }, questions[1]];
    expect(inspectKnowledgeQuestionCoverage(f.snapshot, f.proposal, corrected, 'parcel').complete).toBe(true);
    expect(report.requirementsDigest).toBe(digest(questions));
    expect(report.proposalDigest).toBe(f.proposal.proposalDigest);
    expect(report.snapshotDigest).toBe(f.snapshot.snapshotDigest);
  });

  it('reports unselected details separately and rejects stale or forged mappings without reflecting paths', async () => {
    const f = await fixture();
    const question = { id: 'commands', claimIds: ['claim-architecture'], requirements: [{ ...f.requirement, sourceRef: 'unselected.json' }] };
    const report = inspectKnowledgeQuestionCoverage(f.snapshot, f.proposal, [question], 'parcel');
    expect(report.questions[0]?.requirements[0]?.status).toBe('unavailable');
    expect(JSON.stringify(report)).not.toContain('unselected.json');
    for (const input of [[], [question, question], [{ ...question, claimIds: ['unknown'] }],
      [{ ...question, claimIds: ['claim-architecture', 'claim-architecture'] }],
      [{ ...question, unknown: true }], [{ ...question, requirements: [] }],
      [{ ...question, requirements: [{ ...f.requirement, sourceRef: '../private.json' }] }]]) {
      expect(() => inspectKnowledgeQuestionCoverage(f.snapshot, f.proposal, input, 'parcel')).toThrow(ProjectKnowledgeError);
    }
    expect(() => inspectKnowledgeQuestionCoverage(f.snapshot, f.proposal, [question], 'lantern')).toThrow(ProjectKnowledgeError);
    expect(() => inspectKnowledgeQuestionCoverage(f.snapshot, { ...f.proposal, baselineGenerationDigest: digest('missing') }, [question], 'parcel')).toThrow(ProjectKnowledgeError);
  });

  it('publishes a closed language-neutral report schema', async () => {
    const f = await fixture();
    const report = inspectKnowledgeQuestionCoverage(f.snapshot, f.proposal,
      [{ id: 'commands', claimIds: [], requirements: [f.requirement] }], 'parcel');
    const defs = record(record(JSON.parse(await readFile('schemas/project-knowledge.schema.json', 'utf8')) as unknown).$defs);
    const schema = record(defs.questionCoverage);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(record(schema.properties)).sort()).toEqual(Object.keys(report).sort());
    expect(schema.required).toEqual(Object.keys(report));
  });

  it('bounds both individual questions and the total requirement workload', async () => {
    const f = await fixture();
    const question = { id: 'commands', claimIds: ['claim-decisions'], requirements: [f.requirement] };
    expect(() => inspectKnowledgeQuestionCoverage(f.snapshot, f.proposal,
      Array.from({ length: 65 }, (_, index) => ({ ...question, id: `question-${String(index)}` })), 'parcel')).toThrow(ProjectKnowledgeError);
    const requirements = Array.from({ length: 128 }, (_, index) => ({ ...f.requirement, id: `requirement-${String(index)}` }));
    const bounded = [{ ...question, requirements }, { ...question, id: 'changes', requirements }];
    expect(inspectKnowledgeQuestionCoverage(f.snapshot, f.proposal, bounded, 'parcel').complete).toBe(true);
    expect(() => inspectKnowledgeQuestionCoverage(f.snapshot, f.proposal,
      [...bounded, { ...question, id: 'overflow' }], 'parcel')).toThrow(ProjectKnowledgeError);
  });
});
