import { link, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeWorkflowFixture, submitWorkflowFixture, workflowFixtureProposal, type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import type { KnowledgeExchangeV1 } from '../src/compiler/project-knowledge/session.js';
import { digest, record } from '../src/knowledge/project-knowledge/guards.js';
import { fixtureReview } from './helpers/project-knowledge-fixture.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())); });

describe('project knowledge public boundary failures', () => {
  it('rejects secret-bearing proposal/review/raw source and stale bindings without mutating the run or active wiki', async () => {
    const fixture = await createKnowledgeWorkflowFixture('generic-md-json');
    fixtures.push(fixture);
    const projectId = fixture.projectId;
    expect(await fixture.cli(['sync', '--project', projectId])).toMatchObject({ exitCode: 0 });
    const purpose = await fixture.json('purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
      projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
    const started = await fixture.cli(['compile', 'hierarchy', 'start', '--project', projectId, '--purpose', purpose]);
    expect(started.exitCode).toBe(0);
    const exchange = started.data.exchange as KnowledgeExchangeV1;
    const run = String(started.data.runId);
    const runPath = join(fixture.hubRoot, '.buildlore/hierarchy-runs', projectId, run, 'run.json');
    const before = await readFile(runPath, 'utf8');
    // A deliberately synthetic sentinel, never a real credential.
    const sentinel = `ghp_${'1234567890'.repeat(3)}123456`;
    const proposal = workflowFixtureProposal(exchange);
    const { proposalDigest: old, ...basis } = proposal;
    void old;
    const malicious = { ...basis, pages: basis.pages.map((page, index) => index === 0 ? { ...page, title: sentinel } : page) };
    const badInput = await fixture.json('unsafe-proposal.json', { ...malicious, proposalDigest: digest(malicious) });
    const submit = (input: string, expected: string) => fixture.cli(['compile', 'hierarchy', 'submit', '--project', projectId,
      '--run', run, '--input', input, '--expect-exchange', expected]);
    const rejected = await submit(badInput, exchange.exchangeDigest);
    expect(rejected.exitCode).not.toBe(0);
    expect(JSON.stringify(rejected)).not.toContain(sentinel);
    expect(await readFile(runPath, 'utf8')).toBe(before);
    const goodInput = await fixture.json('proposal.json', proposal);
    expect((await submit(goodInput, digest('stale exchange'))).exitCode).not.toBe(0);
    expect(await readFile(runPath, 'utf8')).toBe(before);
    const submitted = await submit(goodInput, exchange.exchangeDigest);
    expect(submitted.exitCode).toBe(0);
    const reviewedRun = await readFile(runPath, 'utf8');
    const { reviewDigest: oldReview, ...review } = fixtureReview(proposal);
    void oldReview;
    const reviewBasis = { ...review, judgments: review.judgments.map((judgment) => ({ ...judgment, rationale: sentinel })) };
    const reviewPath = await fixture.json('unsafe-review.json', { ...reviewBasis, reviewDigest: digest(reviewBasis) });
    const deniedReview = await fixture.cli(['compile', 'hierarchy', 'finalize', '--project', projectId, '--run', run,
      '--input', reviewPath, '--expect-review', String(submitted.data.reviewViewDigest)]);
    expect(deniedReview.exitCode).not.toBe(0);
    expect(JSON.stringify(deniedReview)).not.toContain(sentinel);
    expect(await readFile(runPath, 'utf8')).toBe(reviewedRun);
    const { approved } = await submitWorkflowFixture(fixture, started.data);
    expect(await fixture.cli(approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
    const activePath = join(fixture.knowledgeRoot, 'projects', projectId, '.llmwiki/buildlore-hierarchy/approved-authority.json');
    const active = await readFile(activePath, 'utf8');
    await writeFile(join(fixture.sourceRoot, 'docs/unsafe.md'), `# Unsafe fixture\n\n${sentinel}\n`);
    const deniedSync = await fixture.cli(['sync', '--project', projectId]);
    // Legacy sync redacts recognized credentials. The opt-in knowledge planner
    // additionally refuses these raw inputs instead of promoting the redaction.
    expect(deniedSync.data.warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'sanitization-redaction-applied', ruleId: 'credential.provider.github' })]));
    expect(JSON.stringify(deniedSync)).not.toContain(sentinel);
    const deniedStart = await fixture.cli(['compile', 'hierarchy', 'start', '--project', projectId, '--purpose', purpose]);
    expect(deniedStart.exitCode).not.toBe(0);
    expect(JSON.stringify(deniedStart)).not.toContain(sentinel);
    expect(await readFile(activePath, 'utf8')).toBe(active);
    expect((await fixture.cli(['wiki', 'read', '--project', projectId, '--page', 'overview'])).exitCode).toBe(0);
  }, 60_000);

  it('rejects hardlinked run records, symlinked input, unreadable required files and cross-project records', async () => {
    const fixture = await createKnowledgeWorkflowFixture('generic-md-json');
    fixtures.push(fixture);
    const projectId = fixture.projectId;
    expect((await fixture.cli(['sync', '--project', projectId])).exitCode).toBe(0);
    const purpose = await fixture.json('purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
      projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
    const startArgs = ['compile', 'hierarchy', 'start', '--project', projectId, '--purpose', purpose];
    const started = await fixture.cli(startArgs);
    expect(started.exitCode).toBe(0);
    const run = String(started.data.runId);
    const path = join(fixture.hubRoot, '.buildlore/hierarchy-runs', projectId, run, 'run.json');
    const before = await readFile(path, 'utf8');
    const statusArgs = ['compile', 'hierarchy', 'status', '--project', projectId, '--run', run];
    const hardlink = join(fixture.root, 'hardlinked-run.json');
    await link(path, hardlink);
    expect((await fixture.cli(statusArgs)).exitCode).not.toBe(0);
    expect(await readFile(path, 'utf8')).toBe(before);
    await unlink(hardlink);
    const linkedPurpose = '.buildlore/knowledge-inputs/linked-purpose.json';
    await symlink(join(fixture.hubRoot, purpose), join(fixture.hubRoot, linkedPurpose));
    expect((await fixture.cli(['compile', 'hierarchy', 'start', '--project', projectId, '--purpose', linkedPurpose])).exitCode).not.toBe(0);
    const current = record(JSON.parse(before) as unknown);
    const { recordDigest: oldDigest, ...runBasis } = current;
    void oldDigest;
    const swapped = { ...runBasis, projectId: 'lantern' };
    await writeFile(path, JSON.stringify({ ...swapped, recordDigest: digest(swapped) }));
    expect((await fixture.cli(statusArgs)).exitCode).not.toBe(0);
    await writeFile(path, before);
    await unlink(join(fixture.sourceRoot, 'settings.json'));
    expect((await fixture.cli(startArgs)).exitCode).not.toBe(0);
    expect(await readFile(path, 'utf8')).toBe(before);
  }, 30_000);
});
