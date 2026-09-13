import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeWorkflowFixture, workflowFixtureProposal, type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import type { KnowledgeExchangeV1 } from '../src/compiler/project-knowledge/session.js';
import { fixtureReview } from './helpers/project-knowledge-fixture.js';
import { digest, record } from '../src/knowledge/project-knowledge/guards.js';
import { parseKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });

describe('question-bound public authoring workflow', () => {
  it.each(['generic-md-json', 'optional-p2a'] as const)('binds %s questions before authoring and rechecks them after resume', async sample => {
    const f = await createKnowledgeWorkflowFixture(sample);
    fixtures.push(f);
    const p = f.projectId;
    expect(await f.cli(['sync', '--project', p])).toMatchObject({ exitCode: 0 });
    const roles = ['overview', 'architecture', 'decisions'] as const;
    const questions = roles.map(role => ({ id: role, role, question: `What is the documented ${role}?`,
      requirements: [{ id: 'source', sourceRef: `docs/${role === 'decisions' ? 'decision.md'
        : role === 'architecture' && sample === 'generic-md-json' ? 'architecture.md' : 'README.md'}`,
      jsonPointer: null, contentKind: 'text' }] }));
    const purposeValue = { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v3', projectId: p,
      generationModel: 'project-knowledge-v1', outputLanguage: 'en', authoringQuestions: questions };
    const purpose = await f.json('purpose.json', purposeValue);
    const started = await f.cli(['compile', 'hierarchy', 'start', '--project', p, '--purpose', purpose]);
    expect(started).toMatchObject({ exitCode: 0, data: { authoringQuestions: questions,
      exchange: { schemaVersion: 'buildlore.knowledge-exchange.v2', authoringQuestions: questions } } });
    const exchange = started.data.exchange as KnowledgeExchangeV1;
    expect(exchange.instructions.join('\n')).not.toContain('compiler/project-knowledge/session.ts');
    expect(exchange.instructions.join('\n')).not.toContain('source-only masking');
    expect(exchange.instructions.join('\n')).toContain('component responsibilities');
    const run = String(started.data.runId);
    const args = ['compile', 'hierarchy', 'submit', '--project', p, '--run', run, '--expect-exchange', exchange.exchangeDigest];
    const proposal = workflowFixtureProposal(exchange);
    const answers = roles.map(role => ({ id: role, claimIds: [`protocol-${role}`] }));
    const submission = { schemaVersion: 'buildlore.knowledge-question-submission.v1', projectId: p, proposal, questionAnswers: answers };
    // A caller cannot bypass the declared requirement by sending the old raw proposal.
    for (const invalid of [proposal, { ...submission, questionAnswers: answers.slice(1) },
      { ...submission, questionAnswers: answers.map(a => ({ ...a, claimIds: ['protocol-overview'] })) }]) {
      const path = await f.json('invalid.json', invalid);
      expect((await f.cli([...args, '--input', path])).exitCode).not.toBe(0);
      expect(await f.cli(['compile', 'hierarchy', 'status', '--project', p, '--run', run])).toEqual(started);
    }
    // Editing the input file after start does not change the frozen run requirements.
    await f.json('purpose.json', { ...purposeValue, authoringQuestions: [] });
    const submitted = await f.cli([...args, '--input', await f.json('proposal.json', submission)]);
    expect(submitted).toMatchObject({ exitCode: 0, data: { questionCoverage: { complete: true, semanticReviewRequired: true } } });
    const resumed = await f.cli(['compile', 'hierarchy', 'review', '--project', p, '--run', run]);
    expect(resumed).toMatchObject({ exitCode: 0, data: { authoringQuestions: questions,
      questionCoverage: submitted.data.questionCoverage, reviewViewDigest: submitted.data.reviewViewDigest } });
    const finalized = await f.cli(['compile', 'hierarchy', 'finalize', '--project', p, '--run', run,
      '--input', await f.json('review.json', fixtureReview(proposal)), '--expect-review', String(resumed.data.reviewViewDigest)]);
    expect(finalized).toMatchObject({ exitCode: 0, data: { phase: 'finalized' } });
    const approved = await f.cli(['compile', 'hierarchy', 'approve', '--project', p, '--run', run,
      '--expect-ledger', String(finalized.data.ledgerDigest), '--confirm-approval']);
    expect(approved).toMatchObject({ exitCode: 0 });
    expect(await f.cli(approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
  }, 60_000);

  it('shows available-but-uncited source details instead of accepting a general answer', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json'); fixtures.push(f);
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const purpose = await f.json('purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v3',
      projectId: f.projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en', authoringQuestions: [{
        id: 'storage', role: 'architecture', question: 'Which storage setting is declared?',
        requirements: [{ id: 'value', sourceRef: 'settings.json', jsonPointer: '/storage', contentKind: 'json-value' }],
      }] });
    const started = await f.cli(['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', purpose]);
    expect(started).toMatchObject({ exitCode: 0, data: { sourceCoverage: [{ id: 'storage', coverage: { complete: true } }] } });
    const exchange = started.data.exchange as KnowledgeExchangeV1;
    const input = await f.json('submission.json', { schemaVersion: 'buildlore.knowledge-question-submission.v1',
      projectId: f.projectId, proposal: workflowFixtureProposal(exchange),
      questionAnswers: [{ id: 'storage', claimIds: ['protocol-architecture'] }] });
    expect((await f.cli(['compile', 'hierarchy', 'submit', '--project', f.projectId, '--run', String(started.data.runId),
      '--input', input, '--expect-exchange', exchange.exchangeDigest])).exitCode).not.toBe(0);
    expect(await f.cli(['compile', 'hierarchy', 'status', '--project', f.projectId, '--run', String(started.data.runId)])).toEqual(started);
  });

  it('returns support only from the matched section and attaches child summaries only to the parent first section', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json'); fixtures.push(f);
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const purpose = await f.json('purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
      projectId: f.projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
    const started = await f.cli(['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', purpose]);
    const exchange = started.data.exchange as KnowledgeExchangeV1;
    const original = workflowFixtureProposal(exchange);
    const { proposalDigest: old, ...basis } = original; void old;
    const architecture = original.pages.find(p => p.role === 'architecture')?.sections[0]?.claims[0];
    if (!architecture) throw new Error('Missing fixture claim.');
    const nextBasis = { ...basis, pages: original.pages.map(p => p.role !== 'overview' ? p : { ...p,
      sections: [...p.sections, { title: 'Processing responsibilities', claims: [{ ...architecture, claimId: 'overview-flow' }] }] }) };
    const proposal = parseKnowledgeProposal({ ...nextBasis, proposalDigest: digest(nextBasis) }, exchange.snapshot);
    const run = String(started.data.runId);
    const submitted = await f.cli(['compile', 'hierarchy', 'submit', '--project', f.projectId, '--run', run,
      '--input', await f.json('proposal.json', proposal), '--expect-exchange', exchange.exchangeDigest]);
    expect(submitted).toMatchObject({ exitCode: 0 });
    const finalized = await f.cli(['compile', 'hierarchy', 'finalize', '--project', f.projectId, '--run', run,
      '--input', await f.json('review.json', fixtureReview(proposal)), '--expect-review', String(submitted.data.reviewViewDigest)]);
    expect(finalized).toMatchObject({ exitCode: 0 });
    const approved = await f.cli(['compile', 'hierarchy', 'approve', '--project', f.projectId, '--run', run,
      '--expect-ledger', String(finalized.data.ledgerDigest), '--confirm-approval']);
    expect(approved).toMatchObject({ exitCode: 0 });
    expect(await f.cli(approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
    const reader = createKnowledgeWikiReader(f.knowledgeRoot);
    const result = await reader.search(f.projectId, 'processing responsibilities', 'lexical');
    expect(result).toMatchObject({ schemaVersion: 'buildlore.project-knowledge-search.v2', supportScope: 'matched-section' });
    if (!Array.isArray(result?.hits)) throw new Error('Missing search hits.');
    const hit = result.hits.map(record).find(h => h.role === 'overview' && record(h.locator).sectionId === 'knowledge-1');
    expect(hit).toMatchObject({ claims: [{ claimId: 'overview-flow' }], inheritedClaims: [] });
    expect(hit?.claims).toHaveLength(1);
    const firstResult = await reader.search(f.projectId, 'local', 'lexical');
    if (!Array.isArray(firstResult?.hits)) throw new Error('Missing first-section hits.');
    const first = firstResult.hits.map(record).find(h => h.role === 'overview' && record(h.locator).sectionId === 'knowledge-0');
    expect(first?.inheritedClaims).toHaveLength(2);
    expect(first?.claims).toHaveLength(1);
    expect((await reader.read(f.projectId, 'overview'))?.claims).toHaveLength(2);
  }, 60_000);
});
