import { readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeWorkflowFixture, type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { completenessFixture, completenessMappingFixture, completenessReviewFixture, sealCompletenessFixture } from './helpers/project-knowledge-completeness.js';
import { fixtureReview } from './helpers/project-knowledge-fixture.js';
import { record, digest } from '../src/knowledge/project-knowledge/guards.js';
import { parseJsonStrict } from '../src/knowledge/strict-json.js';
import { parseKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { createKnowledgeCompletenessExchange } from '../src/compiler/project-knowledge/completeness.js';
import type { KnowledgeExchangeV1 } from '../src/compiler/project-knowledge/session.js';
import { completenessBinding, repairKnowledgeCompletenessInventoryDraft, type CompletenessRole, type KnowledgeCompletenessExchangeV1,
  type KnowledgeCompletenessAcceptedInventoryV1 } from '../src/compiler/project-knowledge/completeness.js';
import { createProjectKnowledgeCompletenessWorkflow, type KnowledgeCompletenessWorkflowStatusV2 } from '../src/cli/project-knowledge-workflow.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { createDevelopmentMemoryQuestions } from '../src/compiler/project-knowledge/development-handoff.js';
import type { KnowledgeAuthoringQuestion } from '../src/compiler/project-knowledge/authoring-questions.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });
async function setup(directWorkspace = false, profile: 'none' | 'empty' | 'mixed' = 'none') {
  const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace, legacyAuthoring: false }); fixtures.push(f);
  await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { capabilities: ['compile'] });
  expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
  const ordinaryQuestions: readonly KnowledgeAuthoringQuestion[] = (['overview', 'architecture', 'decisions'] as const).map(role => ({ id: role, role,
      question: `Explain the documented ${role}.`, requirements: [{ id: 'source',
        sourceRef: `docs/${role === 'overview' ? 'README.md' : role === 'architecture' ? 'architecture.md' : 'decision.md'}`,
        jsonPointer: null, contentKind: 'text' }] }));
  const purpose = { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v4', projectId: f.projectId,
    generationModel: 'project-knowledge-v1', authoringMode: 'completeness-v1', outputLanguage: 'en',
    authoringQuestions: profile === 'none' ? ordinaryQuestions : createDevelopmentMemoryQuestions({
      purpose: profile === 'mixed' ? ordinaryQuestions[0]!.requirements : [],
      architecture: [], decisions: [], 'current-state': [], 'failures-open-work': [],
    }) };
  const started = await f.cli(['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', await f.json('purpose.json', purpose)]);
  expect(started, started.stderr).toMatchObject({ exitCode: 0, data: { schemaVersion: 'buildlore.project-knowledge-workflow-status.v2', stage: { material: {} } } });
  const run = String(started.data.runId), args = ['--project', f.projectId, '--run', run];
  const status = async (role?: CompletenessRole) => {
    const result = await f.cli(['compile', 'hierarchy', 'status', ...args, ...(role ? ['--role', role] : [])]);
    expect(result, result.stderr).toMatchObject({ exitCode: 0 }); return result.data as unknown as KnowledgeCompletenessWorkflowStatusV2;
  };
  const initial = await status('author'), view = record(initial.stage?.material.exchange);
  const readMaterial = async (collection: string): Promise<readonly unknown[]> => {
    let cursor: string | null = null;
    const entries: unknown[] = [];
    do {
      const response = await f.cli(['compile', 'hierarchy', 'inspect', ...args, '--expect-exchange', String(view.exchangeDigest),
        '--input', await f.json('inspect-material.json', { schemaVersion: 'buildlore.knowledge-completeness-material-request.v1',
          projectId: f.projectId, collection, cursor, maxBytes: 1_048_576 })]);
      expect(response, response.stderr).toMatchObject({ exitCode: 0 });
      entries.push(...response.data.entries as readonly unknown[]);
      cursor = response.data.cursor as string | null;
    } while (cursor !== null);
    return entries;
  };
  const base = record(view.baseExchange), { materialCounts, ...metadata } = base;
  void materialCounts;
  const restored = { ...metadata, snapshot: { ...record(base.snapshot), sources: await readMaterial('sources'), evidence: await readMaterial('evidence') },
    previousRecords: await readMaterial('baseline-records'), previousEvidence: await readMaterial('baseline-evidence') } as unknown as KnowledgeExchangeV1;
  const exchange: KnowledgeCompletenessExchangeV1 = createKnowledgeCompletenessExchange(restored, purpose.authoringQuestions, run);
  expect(exchange.exchangeDigest).toBe(view.exchangeDigest);
  const write = async (action: string, input: unknown, role: CompletenessRole) => {
    const view = (await status(role)).stage;
    return f.cli(['compile', 'hierarchy', 'completeness', action, ...args, '--input', await f.json(`${action}.json`, input),
      '--expect-stage', String(view?.stageViewDigest)]);
  };
  const stored = join(f.hubRoot, '.buildlore/hierarchy-runs', f.projectId, run, 'run.json');
  return { f, purpose, run, args, status, write, stored, exchange };
}

describe('standard completeness CLI persistence and recovery', () => {
  it('requires completeness for new starts and labels explicitly selected legacy authoring unassessed', async () => {
    const w = await setup(true), { f } = w;
    const purpose = await f.json('legacy.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
      projectId: f.projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
    const args = ['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', purpose];
    const rejected = await f.cli(args);
    expect(rejected.exitCode).toBe(3);
    expect(rejected.stderr).toContain('KNOWLEDGE_COMPLETENESS_REQUIRED');
    expect(await f.cli([...args, '--allow-legacy-authoring'])).toMatchObject({ exitCode: 0, data: { completenessAssessment: 'unassessed' } });
    expect(await w.status()).toMatchObject({ completenessAssessment: 'pending' });
  }, 60_000);
  it('returns actionable item diagnostics, preserves rejected state and admits a separately repaired draft once', async () => {
    const w = await setup(), data = completenessFixture(w.exchange), draft = structuredClone(data.shadow);
    const original = structuredClone(draft.questions[0]!.categories[0]!.items[0]!);
    const bad = { ...draft, questions: draft.questions.map((q, index) => index !== 0 ? q : { ...q,
      categories: q.categories.map((c, index) => index !== 0 ? c : { ...c,
        items: [{ ...original, evidenceIds: data.shadow.questions[1]!.categories[0]!.items[0]!.evidenceIds }] }) }) };
    const stored = await readFile(w.stored, 'utf8');
    const failed = await w.write('shadow', bad, 'completeness-reviewer');
    expect(failed.exitCode).toBe(3);
    expect(JSON.parse(failed.stderr)).toMatchObject({ data: { rule: 'requirement-needs-current-evidence',
      questionIndex: 0, categoryIndex: 0, itemIndex: 0, requirementIndex: 0, draftDigest: digest(bad) } });
    expect(failed.stderr).toContain('questions[0].categories[0].items[0]');
    expect(await readFile(w.stored, 'utf8')).toBe(stored);
    const repaired = repairKnowledgeCompletenessInventoryDraft(bad, w.exchange, 'blind-shadow-reviewer', {
      draftDigest: digest(bad), questionIndex: 0, categoryIndex: 0, itemIndex: 0, replacement: original });
    expect(await w.write('shadow', repaired, 'completeness-reviewer')).toMatchObject({ exitCode: 0 });
    const committed = await readFile(w.stored, 'utf8');
    expect((await w.write('shadow', repaired, 'completeness-reviewer')).exitCode).toBe(3);
    expect(await readFile(w.stored, 'utf8')).toBe(committed);
  }, 60_000);

  it.each([
    ...[{ correction: false, directWorkspace: false, legacy: false }, { correction: true, directWorkspace: false, legacy: false }, { correction: false, directWorkspace: true, legacy: false }, { correction: true, directWorkspace: true, legacy: false }, { correction: false, directWorkspace: true, legacy: true }].map(value => ({ ...value, profile: 'none' as const })),
    { correction: false, directWorkspace: true, legacy: false, profile: 'empty' as const },
    { correction: true, directWorkspace: true, legacy: false, profile: 'mixed' as const },
  ])('resumes every role stage, reviews and separate approval/activation ($correction, direct=$directWorkspace, legacy=$legacy, profile=$profile)', async ({ correction, directWorkspace, legacy, profile }) => {
    const w = await setup(directWorkspace, profile), { f, args, exchange } = w, data = completenessFixture(exchange, correction);
    if (legacy) {
      const { recordDigest, ...basis } = record(JSON.parse(await readFile(w.stored, 'utf8'))); void recordDigest;
      const previousRun = { ...basis, schemaVersion: 'buildlore.project-knowledge-workflow-run.v4' };
      await writeFile(w.stored, JSON.stringify({ ...previousRun, recordDigest: digest(previousRun) }));
    }
    const readOriginal = await readFile(w.stored, 'utf8'), stamp = (await stat(w.stored)).mtimeMs;
    const before = await w.status('author');
    expect(await f.cli(['compile', 'hierarchy', 'review', ...args, '--role', 'author'])).toMatchObject({ exitCode: 0, data: before });
    const inspection = await f.json('inspect.json', { schemaVersion: 'buildlore.knowledge-authoring-inspection-request.v1',
      projectId: f.projectId, questionId: exchange.authoringQuestions[0]!.id, operation: 'sources' });
    expect(await f.cli(['compile', 'hierarchy', 'inspect', ...args, '--input', inspection, '--expect-exchange', exchange.exchangeDigest])).toMatchObject({ exitCode: 0 });
    expect(await readFile(w.stored, 'utf8')).toBe(readOriginal); expect((await stat(w.stored)).mtimeMs).toBe(stamp);
    expect((await w.write('inventory', data.author, 'author')).exitCode).not.toBe(0);
    expect(await w.write('shadow', data.shadow, 'completeness-reviewer')).toMatchObject({ exitCode: 0 });
    expect((await w.status('author')).stage?.material.shadowInventory).toBeUndefined();
    const oldStage = before.stage?.stageViewDigest;
    expect((await f.cli(['compile', 'hierarchy', 'completeness', 'inventory', ...args, '--input', await f.json('author.json', data.author),
      '--expect-stage', String(oldStage)])).exitCode).not.toBe(0);
    expect(await w.write('inventory', data.author, 'author')).toMatchObject({ exitCode: 0 });
    expect(await w.write('inventory-review', data.review, 'completeness-reviewer')).toMatchObject({ exitCode: 0 });
    if (correction) {
      expect(await w.write('reconcile', sealCompletenessFixture({ schemaVersion: 'buildlore.knowledge-completeness-inventory-reconciliation.v1',
        ...completenessBinding(exchange), inventoryReviewDigest: data.review.reviewDigest, author: data.author.actor,
        dispositions: data.review.judgments.map(j => ({ role: j.role, itemId: j.itemId, disposition: j.disposition,
          rationale: 'Author accepts the source-grounded union disposition.' })) }, 'reconciliationDigest'), 'author')).toMatchObject({ exitCode: 0 });
    }
    const accepted = (await w.status('author')).stage?.material.acceptedInventory as KnowledgeCompletenessAcceptedInventoryV1;
    let proposal = data.proposal, mapping = completenessMappingFixture(exchange, accepted, proposal);
    expect((await f.cli(['compile', 'hierarchy', 'submit', ...args, '--input', await f.json('legacy.json', proposal),
      '--expect-exchange', exchange.exchangeDigest])).exitCode).not.toBe(0);
    const envelope = { schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1', projectId: f.projectId, runId: w.run,
      proposal, mapping, attempt: 1, correctionOfReviewRoundDigest: null };
    const submitted = await w.write('submit', envelope, 'author');
    expect(submitted, submitted.stderr).toMatchObject({ exitCode: 0 });
    expect(await w.write('source-review', fixtureReview(proposal), 'source-reviewer')).toMatchObject({ exitCode: 0 });
    expect((await w.status('completeness-reviewer')).stage?.material.semanticReview).toBeUndefined();
    expect(await w.write('review', completenessReviewFixture(exchange, accepted, mapping, 1, correction), 'completeness-reviewer')).toMatchObject({ exitCode: 0 });
    if (correction) {
      const first = record((await w.status('author')).stage?.material.reviewRound);
      const { proposalDigest, ...basis } = proposal; void proposalDigest;
      proposal = parseKnowledgeProposal(sealCompletenessFixture({ ...basis, pages: proposal.pages.map(page => ({ ...page,
        sections: [{ title: 'Required qualification', claims: page.sections[0]?.claims.map(c => ({ ...c, claimId: `corrected-${page.role}` })) ?? [] }] })) }, 'proposalDigest'), exchange.baseExchange.snapshot);
      mapping = completenessMappingFixture(exchange, accepted, proposal, true);
      expect(await w.write('correct', { ...envelope, proposal, mapping, attempt: 2,
        correctionOfReviewRoundDigest: first.reviewRoundDigest }, 'author')).toMatchObject({ exitCode: 0 });
      expect((await w.status('author')).stage?.material.acceptedInventory).toEqual(accepted);
      expect(await w.write('review', completenessReviewFixture(exchange, accepted, mapping, 2), 'completeness-reviewer')).toMatchObject({ exitCode: 0 });
      expect((await w.status()).phase).toBe('awaiting-correction-reviews');
      expect(await w.write('source-review', fixtureReview(proposal), 'source-reviewer')).toMatchObject({ exitCode: 0 });
    }
    const ready = await w.status('author'), round = record(ready.stage?.material.reviewRound), view = String(ready.stage?.stageViewDigest);
    const input = await f.json('finalize.json', { schemaVersion: 'buildlore.knowledge-completeness-finalize-input.v1', projectId: f.projectId, runId: w.run,
      proposalDigest: round.proposalDigest, mappingDigest: round.mappingDigest, completenessReviewDigest: round.completenessReviewDigest,
      semanticReviewDigest: round.semanticReviewDigest, reviewViewDigest: view });
    expect((await f.cli(['compile', 'hierarchy', 'finalize', ...args, '--input', input, '--expect-review', view])).exitCode).not.toBe(0);
    const finalized = await f.cli(['compile', 'hierarchy', 'finalize', ...args, '--input', input, '--expect-stage', view]);
    expect(finalized, finalized.stderr).toMatchObject({ exitCode: 0, data: { phase: 'finalized', active: false } });
    const service = createProjectKnowledgeCompletenessWorkflow({ hubRoot: f.hubRoot, knowledgeRoot: f.knowledgeRoot });
    expect(await service.status(f.projectId, w.run)).toEqual(finalized.data);
    const approved = await f.cli(['compile', 'hierarchy', 'approve', ...args, '--expect-ledger', String(finalized.data.ledgerDigest), '--confirm-approval']);
    expect(approved).toMatchObject({ exitCode: 0, data: { phase: 'approved', active: false } });
    const activation = await f.cli(approved.data.activationArgs as string[]);
    expect(activation, activation.stderr).toMatchObject({ exitCode: 0 });
    expect(await w.status()).toMatchObject({ phase: 'approved', active: true, stage: null,
      completenessAssessment: legacy ? 'legacy-local-review' : 'verified' });
    expect((await createKnowledgeWikiReader(f.knowledgeRoot).read(f.projectId, 'overview'))?.claims.length).toBeGreaterThan(0);
  }, 60_000);

  it('keeps empty-profile inventories evidence-bound and refuses finalization without independent reviews', async () => {
    const w = await setup(true, 'empty'), { f, exchange } = w, data = completenessFixture(exchange);
    const initial = await readFile(w.stored, 'utf8');
    for (const patch of [{ evidenceIds: [] }, { evidenceIds: [digest({ absentEvidence: true })] }, { requirementIds: ['undeclared'] }]) {
      const { inventoryDigest, ...basis } = data.shadow; void inventoryDigest;
      const invalid = sealCompletenessFixture({ ...basis, questions: basis.questions.map((q, qi) => qi !== 0 ? q : {
        ...q, categories: q.categories.map((c, ci) => ci !== 0 ? c : { ...c, items: c.items.map(item => ({ ...item, ...patch })) }),
      }) }, 'inventoryDigest');
      const rejected = await w.write('shadow', invalid, 'completeness-reviewer');
      expect(rejected.exitCode).toBe(3);
      expect(rejected.stderr).toContain('KNOWLEDGE_INVALID');
      expect(await readFile(w.stored, 'utf8')).toBe(initial);
    }
    expect(await w.write('shadow', data.shadow, 'completeness-reviewer')).toMatchObject({ exitCode: 0 });
    expect(await w.write('inventory', data.author, 'author')).toMatchObject({ exitCode: 0 });
    expect(await w.write('inventory-review', data.review, 'completeness-reviewer')).toMatchObject({ exitCode: 0 });
    const accepted = (await w.status('author')).stage?.material.acceptedInventory as KnowledgeCompletenessAcceptedInventoryV1;
    const mapping = completenessMappingFixture(exchange, accepted, data.proposal);
    const submitted = await w.write('submit', { schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1', projectId: f.projectId,
      runId: w.run, proposal: data.proposal, mapping, attempt: 1, correctionOfReviewRoundDigest: null }, 'author');
    expect(submitted, submitted.stderr).toMatchObject({ exitCode: 0 });
    const view = (await w.status('author')).stage!, stored = await readFile(w.stored, 'utf8');
    const rejected = await f.cli(['compile', 'hierarchy', 'finalize', ...w.args, '--expect-stage', view.stageViewDigest,
      '--input', await f.json('unreviewed-finalize.json', { schemaVersion: 'buildlore.knowledge-completeness-finalize-input.v1',
        projectId: f.projectId, runId: w.run, proposalDigest: data.proposal.proposalDigest, mappingDigest: mapping.mappingDigest,
        completenessReviewDigest: digest({ absentReview: true }), semanticReviewDigest: digest({ absentReview: true }), reviewViewDigest: view.stageViewDigest })]);
    expect(rejected.exitCode).not.toBe(0);
    expect(await readFile(w.stored, 'utf8')).toBe(stored);
    expect(await w.status()).toMatchObject({ phase: 'awaiting-initial-reviews', completenessAssessment: 'pending', generationDigest: null });
  }, 60_000);

  it('rejects recomputed state contradictions, source/policy drift, escapes and unsafe input without mutating the run', async () => {
    const w = await setup(), f = w.f, initial = await readFile(w.stored, 'utf8');
    const stored = record(parseJsonStrict(initial)), state = record(stored.state);
    const { stateDigest, ...basis } = state; void stateDigest;
    const { recordDigest, ...runBasis } = stored; void recordDigest;
    const changedState = sealCompletenessFixture({ ...basis, revision: 1 }, 'stateDigest');
    await writeFile(w.stored, JSON.stringify(sealCompletenessFixture({ ...runBasis, revision: 1, state: changedState }, 'recordDigest')));
    expect((await f.cli(['compile', 'hierarchy', 'status', ...w.args])).exitCode).not.toBe(0);
    await writeFile(w.stored, initial);
    const data = completenessFixture(w.exchange), { inventoryDigest, ...shadowBasis } = data.shadow; void inventoryDigest;
    const sentinel = `ghp_${'T3sT'.repeat(9)}`;
    const unsafe = sealCompletenessFixture({ ...shadowBasis, questions: data.shadow.questions.map(q => ({ ...q,
      categories: q.categories.map(c => ({ ...c, items: c.items.map(item => ({ ...item, rationale: sentinel })) })) })) }, 'inventoryDigest');
    const rejected = await w.write('shadow', unsafe, 'completeness-reviewer');
    expect(rejected.exitCode).not.toBe(0); expect(JSON.stringify(rejected).includes(sentinel)).toBe(false);
    expect(await readFile(w.stored, 'utf8')).toBe(initial);
    const outside = join(f.root, 'outside.json'); await writeFile(outside, JSON.stringify(data.shadow));
    await symlink(outside, join(f.hubRoot, '.buildlore/knowledge-inputs/linked.json'));
    expect((await f.cli(['compile', 'hierarchy', 'completeness', 'shadow', ...w.args, '--input', '.buildlore/knowledge-inputs/linked.json',
      '--expect-stage', String((await w.status('completeness-reviewer')).stage?.stageViewDigest)])).exitCode).not.toBe(0);
    expect(await readFile(w.stored, 'utf8')).toBe(initial);
    await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { capabilities: ['compile'], classification: 'internal' });
    expect((await f.cli(['compile', 'hierarchy', 'status', ...w.args])).exitCode).not.toBe(0);
    await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { capabilities: ['compile'] });
    const path = join(f.sourceRoot, 'docs/README.md'); await writeFile(path, (await readFile(path, 'utf8')) + '\nChanged after the frozen session.\n');
    expect((await f.cli(['compile', 'hierarchy', 'status', ...w.args])).exitCode).not.toBe(0);
    expect(digest(await readFile(w.stored, 'utf8'))).toBe(digest(initial));
  }, 60_000);
});
