import { describe, expect, it } from 'vitest';
import { createDevelopmentMemoryQuestions } from '../src/compiler/project-knowledge/development-handoff.js';
import { DEVELOPMENT_MEMORY_AXES, parseKnowledgeAuthoringQuestions, parseKnowledgeQuestionAnswers,
  type DevelopmentMemoryAxis, type KnowledgeAuthoringQuestion, type KnowledgeAuthoringRequirement } from '../src/compiler/project-knowledge/authoring-questions.js';
import { inspectDevelopmentMemoryContent, inspectDevelopmentMemoryContentWithHistory } from '../src/compiler/project-knowledge/development-memory-inspection.js';
import { createKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { parseKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { createKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { digest, sha256, ProjectKnowledgeError, record } from '../src/knowledge/project-knowledge/guards.js';
import { fixtureFact, fixtureProposal, fixtureReview, knowledgeFixtureSnapshot } from './helpers/project-knowledge-fixture.js';
import { createKnowledgeWorkflowFixture, workflowFixtureProposal } from './helpers/project-knowledge-workflow.js';
import type { KnowledgeExchangeV1 } from '../src/compiler/project-knowledge/session.js';

const requirement: KnowledgeAuthoringRequirement = { id: 'detail', sourceRef: 'README.md', jsonPointer: null, contentKind: 'text' };
function selection(selected: readonly DevelopmentMemoryAxis[] = DEVELOPMENT_MEMORY_AXES): Readonly<Record<DevelopmentMemoryAxis, readonly KnowledgeAuthoringRequirement[]>> {
  return { purpose: selected.includes('purpose') ? [requirement] : [], architecture: selected.includes('architecture') ? [requirement] : [],
    decisions: selected.includes('decisions') ? [requirement] : [], 'current-state': selected.includes('current-state') ? [requirement] : [],
    'failures-open-work': selected.includes('failures-open-work') ? [requirement] : [] };
}
function answers(questions: readonly KnowledgeAuthoringQuestion[], prefix = 'claim') {
  return questions.map(q => ({ id: q.id, claimIds: q.requirements.length === 0 ? [] : [`${prefix}-${q.role}`] }));
}

describe('explicit development memory content profile', () => {
  it('requires the complete, role-bound profile while keeping generic empty inputs invalid', () => {
    const questions = createDevelopmentMemoryQuestions(selection());
    expect(questions.map(q => q.contentProfile?.axis)).toEqual(DEVELOPMENT_MEMORY_AXES);
    const before = JSON.stringify(questions);
    expect(parseKnowledgeAuthoringQuestions(questions)).toEqual(questions);
    expect(JSON.stringify(questions)).toBe(before);
    const ordinary = [{ id: 'old', question: 'What is the documented purpose?', role: 'overview', requirements: [requirement] }];
    expect(JSON.stringify(parseKnowledgeAuthoringQuestions(ordinary))).toBe(JSON.stringify(ordinary));
    for (const value of [questions.slice(1), questions.map((q, index) => index === 0 ? { ...q, role: 'decisions' } : q),
      questions.map((q, index) => index === 1 ? { ...q, contentProfile: questions[0]?.contentProfile } : q),
      questions.map((q, index) => index === 0 ? { ...q, contentProfile: { ...q.contentProfile, extra: true } } : q),
      [ordinary[0], ...questions.slice(1)], [{ ...ordinary[0], requirements: [] }]]) {
      expect(() => parseKnowledgeAuthoringQuestions(value)).toThrow(ProjectKnowledgeError);
    }
    expect(() => parseKnowledgeQuestionAnswers([{ id: 'old', claimIds: [] }], parseKnowledgeAuthoringQuestions(ordinary))).toThrow(ProjectKnowledgeError);
  });

  it('distinguishes all-unassessed and partial selection from structurally covered prose', async () => {
    const snapshot = await knowledgeFixtureSnapshot();
    const proposal = fixtureProposal(snapshot);
    for (const selected of [[], ['purpose'], [...DEVELOPMENT_MEMORY_AXES]] as const) {
      const questions = createDevelopmentMemoryQuestions(selection(selected));
      const report = inspectDevelopmentMemoryContent(snapshot, proposal, questions, answers(questions));
      expect(report.axes).toHaveLength(5);
      expect(report.structuralStatus).toBe(selected.length === 5 ? 'covered' : 'unassessed');
      expect(report.semanticReviewRequired).toBe(true);
      for (const axis of report.axes) {
        if (selected.some(item => item === axis.axis)) {
          const claim = proposal.pages.find(page => page.role === axis.role)?.sections[0]?.claims[0];
          expect(axis).toMatchObject({ requirementSelection: 'selected', structuralStatus: 'covered',
            links: [{ claimId: claim?.claimId, pageRole: axis.role, sectionIndex: 0, claimIndex: 0,
              facts: [{ factId: claim?.factIds[0], evidence: [{ evidenceId: proposal.facts[0]?.evidenceIds[0], sourceRef: 'README.md' }] }] }] });
        } else expect(axis).toMatchObject({ requirementSelection: 'unassessed', structuralStatus: 'unassessed', links: [], requirements: [] });
      }
      expect(await inspectDevelopmentMemoryContentWithHistory(snapshot, proposal, questions, answers(questions), null)).toEqual(report);
      const { inspectionDigest, ...basis } = report;
      expect(inspectionDigest).toBe(digest(basis));
    }
  });

  it('locates uncited, heading-only, unselected and missing-detail gaps without calling them semantic failures', async () => {
    const original = await knowledgeFixtureSnapshot();
    const content = '# Outline\n';
    const snapshot = createKnowledgeSnapshot({ projectId: original.projectId, selectionDigest: original.selectionDigest,
      sanitizerPolicyDigest: original.sanitizerPolicyDigest, sanitizerRulesVersion: original.sanitizerRulesVersion,
      sources: [...original.sources, {
      sourceId: 'outline', sourceRef: 'outline.md', format: 'markdown', content, sourceContentDigest: sha256(content),
      sourceRevision: 'R1', codeRevision: null, tracked: true,
    }] }, original.projectId);
    const proposal = fixtureProposal(snapshot);
    const questions = createDevelopmentMemoryQuestions({ ...selection([]), purpose: [
      requirement, { ...requirement, id: 'uncited', sourceRef: 'architecture.md' },
      { ...requirement, id: 'heading', sourceRef: 'outline.md' },
      { ...requirement, id: 'unselected', sourceRef: 'not-selected.md' },
      { ...requirement, id: 'missing-detail', sourceRef: 'settings.json', jsonPointer: '/missing', contentKind: 'json-value' },
    ] });
    const report = inspectDevelopmentMemoryContent(snapshot, proposal, questions, answers(questions));
    expect(report).toMatchObject({ structuralStatus: 'incomplete', semanticReviewRequired: true });
    expect(report.axes[0]?.requirements.map(r => [r.id, r.status, r.sourceStatus])).toEqual([
      ['detail', 'covered', 'available'], ['uncited', 'uncited', 'available'], ['heading', 'heading-only', 'heading-only'],
      ['unselected', 'unavailable', 'source-not-selected'], ['missing-detail', 'unavailable', 'detail-unavailable'],
    ]);
    const mapped = answers(questions);
    for (const input of [mapped.map(a => a.id === 'purpose' ? { ...a, claimIds: [] } : a),
      mapped.map(a => a.id === 'purpose' ? { ...a, claimIds: ['claim-decisions'] } : a),
      mapped.map(a => a.id === 'architecture' ? { ...a, claimIds: ['claim-architecture'] } : a)]) {
      expect(() => inspectDevelopmentMemoryContent(snapshot, proposal, questions, input)).toThrow(ProjectKnowledgeError);
    }
    expect(() => inspectDevelopmentMemoryContent(snapshot, { ...proposal, projectId: 'other' }, questions, mapped)).toThrow(ProjectKnowledgeError);
  });

  it('keeps historical evidence membership visible in an answer that also cites current requirements', async () => {
    const first = await knowledgeFixtureSnapshot('R1');
    const retained = first.evidence.find(item => item.sourceRef === 'support.md' && item.excerpt.length > 40);
    if (!retained) throw new Error('Missing removed-source fixture evidence.');
    const firstProposal = fixtureProposal(first, [{ ...fixtureFact(first), subject: 'support:historical',
      statement: retained.excerpt, evidenceIds: [retained.evidenceId] }]);
    const previous = createKnowledgeGeneration(first, firstProposal, fixtureReview(firstProposal), null, 'knowledge-markdown-v2');
    const snapshot = await knowledgeFixtureSnapshot('R2');
    const initial = fixtureProposal(snapshot);
    const old = previous.records[0];
    if (!old) throw new Error('Missing historical fixture fact.');
    const { proposalDigest, ...original } = initial;
    void proposalDigest;
    const basis = { ...original, baselineGenerationDigest: previous.generationDigest,
      pages: initial.pages.map(page => page.role !== 'overview' ? page : { ...page,
        sections: page.sections.map(section => ({ ...section, claims: [...section.claims,
          { claimId: 'prior-purpose', text: old.statement, factIds: [old.id], presentation: 'history' as const }] })) }) };
    const proposal = parseKnowledgeProposal({ ...basis, proposalDigest: digest(basis) }, snapshot);
    const questions = createDevelopmentMemoryQuestions(selection(['purpose']));
    const mapped = answers(questions).map(a => a.id === 'purpose' ? { ...a, claimIds: [...a.claimIds, 'prior-purpose'] } : a);
    const report = inspectDevelopmentMemoryContent(snapshot, proposal, questions, mapped, [previous]);
    expect(report.axes[0]?.links.find(link => link.claimId === 'prior-purpose')?.facts[0]).toMatchObject({ factId: old.id,
      evidence: [{ presentInCurrentSnapshot: false, sourceRevision: 'R1' }] });
    expect(() => inspectDevelopmentMemoryContent(snapshot, proposal, questions, mapped)).toThrow(ProjectKnowledgeError);
  });

  it('exposes unassessed source inspection and binds the full report through resume, independent review and approval', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json');
    try {
      const p = f.projectId;
      expect(await f.cli(['sync', '--project', p])).toMatchObject({ exitCode: 0 });
      const questions = createDevelopmentMemoryQuestions({ ...selection([]), purpose: [{ ...requirement, sourceRef: 'docs/README.md' }] });
      const purpose = await f.json('memory-profile.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v3',
        projectId: p, generationModel: 'project-knowledge-v1', outputLanguage: 'en', authoringQuestions: questions });
      const started = await f.cli(['compile', 'hierarchy', 'start', '--project', p, '--purpose', purpose]);
      expect(started).toMatchObject({ exitCode: 0, data: { sourceCoverage: [
        { id: 'purpose', requirementSelection: 'selected' }, { id: 'architecture', coverage: null, requirementSelection: 'unassessed' },
        { id: 'decisions', coverage: null, requirementSelection: 'unassessed' },
        { id: 'current-state', coverage: null, requirementSelection: 'unassessed' },
        { id: 'failures-open-work', coverage: null, requirementSelection: 'unassessed' },
      ] } });
      const exchange = started.data.exchange as KnowledgeExchangeV1;
      const run = String(started.data.runId);
      const request = await f.json('inspect-memory.json', { schemaVersion: 'buildlore.knowledge-authoring-inspection-request.v1',
        projectId: p, questionId: 'architecture', operation: 'coverage' });
      const inspectArgs = ['compile', 'hierarchy', 'inspect', '--project', p, '--run', run,
        '--input', request, '--expect-exchange', exchange.exchangeDigest];
      expect(await f.cli(inspectArgs)).toMatchObject({ exitCode: 0, data: { entries: [], requirementSelection: 'unassessed' } });
      const proposal = workflowFixtureProposal(exchange);
      const mappings = answers(questions, 'protocol');
      const submitArgs = ['compile', 'hierarchy', 'submit', '--project', p, '--run', run, '--expect-exchange', exchange.exchangeDigest];
      const submission = { schemaVersion: 'buildlore.knowledge-question-submission.v1', projectId: p, proposal, questionAnswers: mappings };
      const bad = await f.json('invalid-memory.json', { ...submission, questionAnswers: mappings.map(a => ({ ...a, claimIds: [] })) });
      expect((await f.cli([...submitArgs, '--input', bad])).exitCode).not.toBe(0);
      const submitted = await f.cli([...submitArgs, '--input', await f.json('memory-submission.json', submission)]);
      expect(submitted).toMatchObject({ exitCode: 0, data: { developmentMemoryInspection: {
        structuralStatus: 'unassessed', semanticReviewRequired: true,
      } } });
      expect(record(submitted.data.developmentMemoryInspection).axes).toHaveLength(5);
      expect(submitted.data.questionCoverage).toBeUndefined();
      const resumed = await f.cli(['compile', 'hierarchy', 'review', '--project', p, '--run', run]);
      expect(resumed.data.developmentMemoryInspection).toEqual(submitted.data.developmentMemoryInspection);
      expect(resumed.data.reviewViewDigest).toBe(submitted.data.reviewViewDigest);
      expect(await f.cli(inspectArgs)).toMatchObject({ exitCode: 0, data: { developmentMemoryInspection: submitted.data.developmentMemoryInspection } });
      const review = await f.json('memory-review.json', fixtureReview(proposal));
      const finalize = ['compile', 'hierarchy', 'finalize', '--project', p, '--run', run, '--input', review, '--expect-review'];
      const oldDigest = digest({ projectId: p, runId: run, exchangeDigest: exchange.exchangeDigest,
        proposalDigest: proposal.proposalDigest, questionAnswers: mappings });
      expect((await f.cli([...finalize, oldDigest])).exitCode).not.toBe(0);
      const finalized = await f.cli([...finalize, String(submitted.data.reviewViewDigest)]);
      expect(finalized).toMatchObject({ exitCode: 0, data: { phase: 'finalized' } });
      const approved = await f.cli(['compile', 'hierarchy', 'approve', '--project', p, '--run', run,
        '--expect-ledger', String(finalized.data.ledgerDigest), '--confirm-approval']);
      expect(approved).toMatchObject({ exitCode: 0 });
      expect(await f.cli(approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
      expect(await f.cli(['wiki', 'memory', '--project', p])).toMatchObject({ exitCode: 0, data: { purpose: 'development' } });
    } finally { await f.cleanup(); }
  }, 60000);
});
