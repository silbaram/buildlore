import { lstat, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeWorkflowFixture, submitWorkflowFixture, workflowFixtureProposal,
  type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { fixtureReview } from './helpers/project-knowledge-fixture.js';
import { createApprovedWikiProjectionStore } from '../src/retrieval/approved-corpus-store.js';
import { knowledgeAuthorityHistory, latestKnowledgeGeneration } from '../src/retrieval/project-knowledge-authority.js';
import { preparePlannedKnowledgeSession } from '../src/compiler/project-knowledge/planned-sources.js';
import { createHierarchyPayloadStore } from '../src/cli/hierarchical-run-store.js';
import { createDevelopmentMemoryQuestions } from '../src/compiler/project-knowledge/development-handoff.js';
import { parseKnowledgeAuthoringQuestions } from '../src/compiler/project-knowledge/authoring-questions.js';
import { KNOWLEDGE_CHANGE_IMPACT_REQUEST_VERSION } from '../src/compiler/project-knowledge/change-impact.js';
import { digest, hash, invalid, record, sha256 } from '../src/knowledge/project-knowledge/guards.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import type { KnowledgeExchangeV1 } from '../src/compiler/project-knowledge/session.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });
async function tree(root: string): Promise<readonly unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    result.push([name, (await lstat(path)).isDirectory() ? await tree(path) : sha256(await readFile(path, 'utf8'))]);
  }
  return result;
}

describe('change-impact workflow dispatch and durable state', () => {
  it.each(['v1', 'v2', 'v3', 'development-memory'] as const)('inspects %s runs before and after submission, preserving approval flow', async mode => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json'); fixtures.push(f);
    const p = f.projectId;
    expect((await f.cli(['sync', '--project', p])).exitCode).toBe(0);
    const originalPurpose = await f.json('initial-purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
      projectId: p, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
    const initial = await f.cli(['compile', 'hierarchy', 'start', '--project', p, '--purpose', originalPurpose]);
    const first = await submitWorkflowFixture(f, initial.data);
    expect((await f.cli(first.approved.data.activationArgs as string[])).exitCode).toBe(0);
    const authority = await createApprovedWikiProjectionStore(f.knowledgeRoot).readAuthority(p);
    const extension = authority.knowledgeGeneration ?? invalid();
    if (extension.schemaVersion !== 'buildlore.knowledge-authority-extension.v2') invalid();
    const previous = latestKnowledgeGeneration(extension);
    const history = knowledgeAuthorityHistory(extension);
    await f.setRevision('R2');
    expect((await f.cli(['sync', '--project', p])).exitCode).toBe(0);
    const questions = mode === 'development-memory' ? createDevelopmentMemoryQuestions({
      purpose: [], architecture: [], decisions: [], 'current-state': [], 'failures-open-work': [],
    }) : mode === 'v3' ? parseKnowledgeAuthoringQuestions([{ id: 'purpose', role: 'overview',
      question: 'What is the documented purpose?', requirements: [{ id: 'purpose-source', sourceRef: 'docs/README.md', jsonPointer: null, contentKind: 'text' }] }]) : undefined;
    const { session } = await preparePlannedKnowledgeSession({ hubRoot: f.hubRoot, knowledgeRoot: f.knowledgeRoot,
      projectId: p, outputLanguage: 'en', rendererVersion: mode === 'v1' ? 'knowledge-markdown-v1' : 'knowledge-markdown-v2',
      previousHistory: history, ...(questions === undefined ? {} : { authoringQuestions: questions }) });
    let run: string;
    if (mode === 'v1') {
      const basis = { schemaVersion: 'buildlore.project-knowledge-workflow-run.v1', projectId: p,
        runId: `run-${'b'.repeat(64)}`, revision: 0, phase: 'awaiting-proposal', outputLanguage: 'en',
        snapshotDigest: session.exchange.snapshot.snapshotDigest, exchangeDigest: session.exchange.exchangeDigest,
        baselineAuthorityDigest: sha256(serializeCanonicalJson(authority)), proposal: null, semanticReview: null,
        ledgerDigest: null, approvedAuthorityDigest: null };
      const store = createHierarchyPayloadStore(f.hubRoot, value => ({ ...basis, recordDigest: hash(record(value).recordDigest) }));
      await store.create({ ...basis, recordDigest: digest(basis) }); run = basis.runId;
    } else {
      const purpose = await f.json('next-purpose.json', { schemaVersion: questions === undefined
        ? 'buildlore.hierarchical-workflow-purpose-input.v2' : 'buildlore.hierarchical-workflow-purpose-input.v3',
        projectId: p, generationModel: 'project-knowledge-v1', outputLanguage: 'en',
        ...(questions === undefined ? {} : { authoringQuestions: questions }) });
      const started = await f.cli(['compile', 'hierarchy', 'start', '--project', p, '--purpose', purpose]);
      expect(started.exitCode).toBe(0); run = String(started.data.runId);
    }
    const status = () => f.cli(['compile', 'hierarchy', 'status', '--project', p, '--run', run]);
    const before = await status();
    const exchange = before.data.exchange as KnowledgeExchangeV1;
    expect(exchange).toEqual(session.exchange);
    const input = { schemaVersion: KNOWLEDGE_CHANGE_IMPACT_REQUEST_VERSION, operation: 'change-impact', projectId: p,
      expectExchangeDigest: exchange.exchangeDigest, expectSnapshotDigest: exchange.snapshot.snapshotDigest,
      expectBaselineGenerationDigest: previous.generationDigest, expectBaselineSnapshotDigest: previous.snapshot.snapshotDigest };
    const args = ['compile', 'hierarchy', 'inspect', '--project', p, '--run', run, '--expect-exchange', exchange.exchangeDigest];
    const inputFile = await f.json('impact.json', input);
    const durable = async () => [await tree(join(f.knowledgeRoot, 'projects', p)), await tree(join(f.hubRoot, '.buildlore/hierarchy-runs', p))];
    const bytes = await durable();
    const inspected = await f.cli([...args, '--input', inputFile]);
    expect(inspected, inspected.stderr).toMatchObject({ exitCode: 0, data: { status: 'ready' } });
    expect(inspected.data).toEqual(await session.inspectChangeImpact(input, exchange.exchangeDigest));
    expect(await status()).toEqual(before); expect(await durable()).toEqual(bytes);
    for (const extra of [{ projectId: 'another' }, { expectBaselineGenerationDigest: digest('wrong') },
      { expectBaselineSnapshotDigest: null }, { expectSnapshotDigest: digest('wrong') }, { expectExchangeDigest: digest('wrong') },
      { cursor: `change-impact-1-${'0'.repeat(64)}` }, { force: true }]) {
      const rejected = await f.cli([...args, '--input', await f.json('bad-impact.json', { ...input, ...extra })]);
      expect(rejected.exitCode).toBe(3); expect(await durable()).toEqual(bytes);
    }
    await symlink(join(f.hubRoot, inputFile), join(f.hubRoot, '.buildlore/knowledge-inputs/link.json'));
    expect((await f.cli([...args, '--input', '.buildlore/knowledge-inputs/link.json'])).exitCode).not.toBe(0);
    expect((await f.cli([...args, '--input', '../outside.json'])).exitCode).not.toBe(0);
    const original = await readFile(join(f.sourceRoot, 'docs/README.md'), 'utf8');
    await writeFile(join(f.sourceRoot, 'docs/README.md'), original+'\nChanged after selection.\n');
    expect((await f.cli([...args, '--input', inputFile])).exitCode).not.toBe(0);
    await writeFile(join(f.sourceRoot, 'docs/README.md'), original);
    expect(await status()).toEqual(before);
    const proposal = workflowFixtureProposal(exchange);
    const submission = questions === undefined ? proposal : { schemaVersion: 'buildlore.knowledge-question-submission.v1',
      projectId: p, proposal, questionAnswers: questions.map(q => ({ id: q.id, claimIds: q.requirements.length ? [`protocol-${q.role}`] : [] })) };
    const submitted = await f.cli(['compile', 'hierarchy', 'submit', '--project', p, '--run', run,
      '--expect-exchange', exchange.exchangeDigest, '--input', await f.json('proposal.json', submission)]);
    expect(submitted, submitted.stderr).toMatchObject({ exitCode: 0, data: { phase: 'review-ready' } });
    const reviewBefore = await status(); const afterSubmitBytes = await durable();
    expect(await f.cli([...args, '--input', inputFile])).toEqual(inspected);
    expect(await status()).toEqual(reviewBefore); expect(await durable()).toEqual(afterSubmitBytes);
    const finalized = await f.cli(['compile', 'hierarchy', 'finalize', '--project', p, '--run', run,
      '--input', await f.json('review.json', fixtureReview(proposal)), '--expect-review', String(submitted.data.reviewViewDigest)]);
    expect(finalized, finalized.stderr).toMatchObject({ exitCode: 0, data: { phase: 'finalized' } });
    expect((await f.cli([...args, '--input', inputFile])).exitCode).toBe(3);
    const approved = await f.cli(['compile', 'hierarchy', 'approve', '--project', p, '--run', run,
      '--expect-ledger', String(finalized.data.ledgerDigest), '--confirm-approval']);
    expect(approved, approved.stderr).toMatchObject({ exitCode: 0 });
  }, 90_000);
});
