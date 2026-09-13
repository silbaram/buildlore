import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeWorkflowFixture, workflowFixtureProposal, type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { TEST_KNOWLEDGE_ACTOR, fixtureReview } from './helpers/project-knowledge-fixture.js';
import type { KnowledgeExchangeV1 } from '../src/compiler/project-knowledge/session.js';
import { compare, digest, record } from '../src/knowledge/project-knowledge/guards.js';
import { createProposedKnowledgeRecord } from '../src/knowledge/project-knowledge/records.js';
import { parseKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { KNOWLEDGE_INSPECTION_REQUEST_VERSION } from '../src/compiler/project-knowledge/authoring-inspection.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });

describe('public code-assisted Wiki authoring', () => {
  it('returns bounded metadata recovery through the CLI without changing the authoring run', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json'); fixtures.push(f);
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const purpose = await f.json('purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v3',
      projectId: f.projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en', authoringQuestions: [
        { id: 'overview', question: 'Explain the documented purpose.', role: 'overview', requirements: Array.from({ length: 256 },
          (_, i) => ({ id: `${'r'.repeat(192)}-${String(i)}`, sourceRef: 'docs/README.md', jsonPointer: null, contentKind: 'text' })) },
      ] });
    const started = await f.cli(['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', purpose]);
    expect(started, started.stderr).toMatchObject({ exitCode: 0 });
    const input = { schemaVersion: KNOWLEDGE_INSPECTION_REQUEST_VERSION, projectId: f.projectId,
      questionId: 'overview', operation: 'sources', limit: 1 };
    const args = started.data.inspectionArgs as string[];
    const failed = await f.cli([...args, '--input', await f.json('inspection.json', input)]);
    expect(failed.exitCode).toBe(3);
    const envelope = record(JSON.parse(failed.stderr) as unknown);
    expect(envelope.errors).toEqual([{ code: 'KNOWLEDGE_INSPECTION_BUDGET_EXCEEDED',
      message: 'Inspection response metadata exceeds the requested byte budget.' }]);
    const details = record(envelope.data);
    expect(details).toMatchObject({ schemaVersion: 'buildlore.knowledge-authoring-inspection-budget.v1',
      byteBudget: 65_536, maximumBytes: 1_048_576, retryable: true });
    expect(Buffer.byteLength(failed.stderr)).toBeLessThan(8192);
    const recovered = await f.cli([...args, '--input', await f.json('inspection.json', { ...input, maxBytes: details.minimumRequiredBytes })]);
    expect(recovered).toMatchObject({ exitCode: 0, data: { status: 'ready' } });
    expect(await f.cli(['compile', 'hierarchy', 'status', '--project', f.projectId, '--run', String(started.data.runId)]))
      .toEqual(started);
  }, 90_000);

  it.each(['generic-md-json', 'optional-p2a'] as const)('inspects %s code and carries supported additions into the activated Wiki', async sample => {
    const f = await createKnowledgeWorkflowFixture(sample); fixtures.push(f);
    const p = f.projectId;
    const main = 'import { normalizeBatch } from "./normalize.js";\n\nexport function prepareBatch(items) {\n  return normalizeBatch(items);\n}\n';
    await mkdir(join(f.sourceRoot, 'src'));
    await mkdir(join(f.sourceRoot, 'checks'));
    await writeFile(join(f.sourceRoot, 'src/main.js'), main);
    await writeFile(join(f.sourceRoot, 'src/normalize.js'), 'export function normalizeBatch(items) {\n  return items.filter(item => item.enabled).map(item => item.id);\n}\n');
    await writeFile(join(f.sourceRoot, 'checks/flow.py'), 'def test_prepare_batch():\n    assert prepareBatch([{"id": "first", "enabled": True}]) == ["first"]\n');
    await writeFile(join(f.sourceRoot, 'docs/flow.md'), '# Batch processing\n\nThe documented batch plan retains all item ids, including disabled items.\n');
    await writeFile(join(f.sourceRoot, 'not-selected.js'), 'UNSELECTED_PRIVATE_TEXT\n');
    for (const path of ['src', 'checks']) {
      expect(await f.cli(['source', 'add', '--project', p, '--id', path, '--kind', 'code', '--path', path, '--recursive']))
        .toMatchObject({ exitCode: 0 });
    }
    expect(await f.cli(['sync', '--project', p])).toMatchObject({ exitCode: 0 });
    const questions = [{ id: 'batch-flow', role: 'architecture',
      question: 'What does prepareBatch do, how does it differ from the documented plan, and what does the selected test define?',
      requirements: ['docs/flow.md', 'src/main.js', 'src/normalize.js', 'checks/flow.py'].map((sourceRef, index) => ({
        id: `source-${String(index)}`, sourceRef, jsonPointer: null, contentKind: 'text',
      })) }];
    const purpose = await f.json('purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v3',
      projectId: p, generationModel: 'project-knowledge-v1', outputLanguage: 'en', authoringQuestions: questions });
    const started = await f.cli(['compile', 'hierarchy', 'start', '--project', p, '--purpose', purpose]);
    expect(started).toMatchObject({ exitCode: 0 });
    const exchange = started.data.exchange as KnowledgeExchangeV1;
    const run = String(started.data.runId);
    const inspectArgs = started.data.inspectionArgs as string[];
    expect(inspectArgs).toContain('inspect');
    const inspect = async (options: Readonly<Record<string, unknown>>) => f.cli([...inspectArgs, '--input',
      await f.json('inspection.json', { schemaVersion: KNOWLEDGE_INSPECTION_REQUEST_VERSION, projectId: p,
        questionId: 'batch-flow', ...options })]);
    const inventory = await inspect({ operation: 'sources', contains: 'src/' });
    expect(inventory).toMatchObject({ exitCode: 0, data: { total: 2, egress: 'none', processSpawned: false } });
    const firstSource = await inspect({ operation: 'sources', contains: 'src/', limit: 1 });
    expect(firstSource).toMatchObject({ exitCode: 0, data: { total: 2 } });
    expect(typeof firstSource.data.cursor).toBe('string');
    const secondSource = await inspect({ operation: 'sources', contains: 'src/', limit: 1, cursor: firstSource.data.cursor });
    expect(secondSource, secondSource.stderr).toMatchObject({ exitCode: 0, data: { total: 2, cursor: null } });
    expect([...(firstSource.data.entries as unknown[]), ...(secondSource.data.entries as unknown[])])
      .toEqual(inventory.data.entries);
    const calls = await inspect({ operation: 'find', contains: 'normalizeBatch' });
    expect(calls).toMatchObject({ exitCode: 0, data: { status: 'ready' } });
    if (!Array.isArray(calls.data.entries)) throw new Error('Missing inspection evidence.');
    expect(new Set(calls.data.entries.map(e => record(e).sourceRef))).toEqual(new Set(['src/main.js', 'src/normalize.js']));
    const readEvidence = async (sourceRef: string, literal: string) => {
      const result = await inspect({ operation: 'read', sourceRef });
      expect(result).toMatchObject({ exitCode: 0, data: { snapshotDigest: exchange.snapshot.snapshotDigest } });
      if (!Array.isArray(result.data.entries)) throw new Error('Missing source evidence.');
      const item = result.data.entries.map(record).find(e => typeof e.excerpt === 'string' && e.excerpt.includes(literal));
      const evidence = exchange.snapshot.evidence.find(e => e.evidenceId === item?.evidenceId);
      if (!evidence) throw new Error('Missing exact inspected evidence.');
      expect(item).toEqual(evidence);
      return evidence;
    };
    const entry = await readEvidence('src/main.js', 'return normalizeBatch');
    const implementation = await readEvidence('src/normalize.js', 'items.filter');
    const documentation = await readEvidence('docs/flow.md', 'documented batch plan');
    const testDefinition = await readEvidence('checks/flow.py', 'assert prepareBatch');
    const status = () => f.cli(['compile', 'hierarchy', 'status', '--project', p, '--run', run]);
    expect(await status()).toEqual(started); // inspection itself never changes the run.
    const sentinel = `ghp_${'1234567890'.repeat(3)}123456`;
    for (const input of [{ operation: 'read', sourceRef: 'not-selected.js' },
      { operation: 'read', sourceRef: '../outside.js' }, { operation: 'find', contains: sentinel },
      { operation: 'sources', contains: 'src/', cursor: `inspection-1-${'0'.repeat(64)}` },
      { operation: 'sources', contains: 'checks/', cursor: firstSource.data.cursor },
      { operation: 'sources', contains: sentinel, cursor: firstSource.data.cursor },
      { operation: 'sources', projectId: 'other' }, { operation: 'sources', questionId: 'unknown' }]) {
      const rejected = await inspect(input);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).not.toContain(sentinel);
      expect(JSON.stringify(rejected)).not.toContain('UNSELECTED_PRIVATE_TEXT');
      expect(await status()).toEqual(started);
    }
    await writeFile(join(f.sourceRoot, 'src/main.js'), `${main}\n// changed after the authoring snapshot\n`);
    expect((await inspect({ operation: 'read', sourceRef: 'src/main.js' })).exitCode).not.toBe(0);
    await writeFile(join(f.sourceRoot, 'src/main.js'), main);
    expect(await status()).toEqual(started);

    const original = workflowFixtureProposal(exchange);
    const submitArgs = ['compile', 'hierarchy', 'submit', '--project', p, '--run', run, '--expect-exchange', exchange.exchangeDigest];
    const submit = (proposal: unknown, claimIds: string[]) => f.json('proposal.json', {
      schemaVersion: 'buildlore.knowledge-question-submission.v1', projectId: p, proposal,
      questionAnswers: [{ id: 'batch-flow', claimIds }],
    }).then(path => f.cli([...submitArgs, '--input', path]));
    expect((await submit(original, ['protocol-architecture'])).exitCode).not.toBe(0);
    // Mechanical fixture authoring based on the returned code/docs/test evidence, not live AI quality evaluation.
    const additions = [
      { subject: 'batch:implementation', statement: 'prepareBatch delegates to normalizeBatch, which filters enabled items and maps their ids.',
        evidenceIds: [entry.evidenceId, implementation.evidenceId] },
      { subject: 'batch:document-code-difference', statement: 'The documented batch plan retains all item ids, including disabled items, but normalizeBatch filters by item.enabled.',
        evidenceIds: [documentation.evidenceId, implementation.evidenceId] },
      { subject: 'batch:test-definition', statement: 'The selected test_prepare_batch definition asserts prepareBatch returns the enabled item id; this definition does not demonstrate a passing execution.',
        evidenceIds: [testDefinition.evidenceId] },
    ].map(fact => createProposedKnowledgeRecord({ ...fact, predicate: 'inspection', scope: 'selected source snapshot, not executed verification',
      classification: 'inferred', lifecycle: 'current', observation: null }, exchange.snapshot, TEST_KNOWLEDGE_ACTOR));
    const claims = additions.map((fact, index) => ({ claimId: `inspected-${String(index)}`, text: fact.statement,
      factIds: [fact.id], presentation: 'current' as const }));
    const { proposalDigest: old, ...basis } = original; void old;
    const nextBasis = { ...basis, facts: [...original.facts, ...additions].sort((a, b) => compare(a.id, b.id)), pages: original.pages.map(page => page.role !== 'architecture'
      ? page : { ...page, sections: [...page.sections, { title: 'prepareBatch implementation and test definition', claims }] }) };
    const proposal = parseKnowledgeProposal({ ...nextBasis, proposalDigest: digest(nextBasis) }, exchange.snapshot);
    const submitted = await submit(proposal, claims.map(c => c.claimId));
    expect(submitted).toMatchObject({ exitCode: 0, data: { questionCoverage: { complete: true } } });
    const reviewed = await f.cli(['compile', 'hierarchy', 'review', '--project', p, '--run', run]);
    expect(reviewed).toMatchObject({ exitCode: 0, data: { proposal: { proposalDigest: proposal.proposalDigest } } });
    const finalized = await f.cli(['compile', 'hierarchy', 'finalize', '--project', p, '--run', run,
      '--input', await f.json('review.json', fixtureReview(proposal)), '--expect-review', String(reviewed.data.reviewViewDigest)]);
    expect(finalized, finalized.stderr).toMatchObject({ exitCode: 0, data: { phase: 'finalized' } });
    expect(finalized.data.inspectionArgs).toBeUndefined();
    expect((await inspect({ operation: 'sources' })).exitCode).not.toBe(0);
    const approved = await f.cli(['compile', 'hierarchy', 'approve', '--project', p, '--run', run,
      '--expect-ledger', String(finalized.data.ledgerDigest), '--confirm-approval']);
    expect(approved).toMatchObject({ exitCode: 0 });
    expect(await f.cli(approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
    const wiki = await readFile(join(f.knowledgeRoot, 'projects', p, 'wiki/buildlore-hierarchy/architecture.md'), 'utf8');
    for (const claim of claims) expect(wiki).toContain(claim.text);
    expect(await readFile(join(f.sourceRoot, 'src/main.js'), 'utf8')).toBe(main);
  }, 90_000);
});
