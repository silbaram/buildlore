import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { correctionFixture, questions, badInventory, correctionInput, correctionReview, seal } from './helpers/project-knowledge-inventory-correction.js';
import { preparePlannedKnowledgeCompletenessSession } from '../src/compiler/project-knowledge/planned-sources.js';
import { type captureKnowledgeCompletenessSession, replayKnowledgeCompletenessSession } from '../src/compiler/project-knowledge/completeness-session.js';
import { completenessFixture, completenessMappingFixture, completenessReviewFixture } from './helpers/project-knowledge-completeness.js';
import { completenessBinding, type CompletenessRole } from '../src/compiler/project-knowledge/completeness.js';
import { fixtureReview } from './helpers/project-knowledge-fixture.js';
import { record } from '../src/knowledge/project-knowledge/guards.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
describe('inventory correction CLI delivery', () => {
  it('persists correction, restores every command, finalizes and independently approves/reads through the existing boundary', async () => {
    const { f } = await correctionFixture(); cleanups.push(() => f.cleanup());
    const purpose = await f.json('purpose-v2.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v5', projectId: f.projectId,
      generationModel: 'project-knowledge-v1', authoringMode: 'completeness-v2', outputLanguage: 'en', authoringQuestions: questions });
    const start = await f.cli(['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', purpose]);
    expect(start, start.stderr).toMatchObject({ exitCode: 0, data: { schemaVersion: 'buildlore.project-knowledge-workflow-status.v3', authoringMode: 'completeness-v2' } });
    const runId = String(start.data.runId), args = ['--project', f.projectId, '--run', runId];
    const path = join(f.hubRoot, '.buildlore/hierarchy-runs', f.projectId, runId, 'run.json');
    const status = async (role: CompletenessRole = 'author') => {
      const result = await f.cli(['compile', 'hierarchy', 'status', ...args, '--role', role]);
      expect(result, result.stderr).toMatchObject({ exitCode: 0 }); return record(result.data.stage);
    };
    const write = async (action: string, input: unknown, role: CompletenessRole = 'author') => {
      const stage = await status(role), result = await f.cli(['compile', 'hierarchy', 'completeness', action, ...args,
        '--input', await f.json(`${action}-v2.json`, input), '--expect-stage', String(stage.stageViewDigest)]);
      expect(result, result.stderr).toMatchObject({ exitCode: 0 }); return result;
    };
    const { session } = await preparePlannedKnowledgeCompletenessSession({ hubRoot: f.hubRoot, knowledgeRoot: f.knowledgeRoot,
      projectId: f.projectId, runId, outputLanguage: 'en', authoringQuestions: questions, inventoryPolicy: 'completeness-v2' });
    const data = badInventory(session);
    await write('shadow', data.shadow, 'completeness-reviewer'); await write('inventory', data.author);
    await write('inventory-review', data.review, 'completeness-reviewer');
    expect(await status()).toMatchObject({ phase: 'awaiting-inventory-correction' });
    const failedReviewRun = record(JSON.parse(await readFile(path, 'utf8')) as unknown);
    await replayKnowledgeCompletenessSession(session, failedReviewRun.state);
    const correction = await correctionInput(session);
    await write('correct-inventory', correction);
    await write('inventory-review', correctionReview(session, correction), 'completeness-reviewer');
    const accepted = record((await status()).material).acceptedInventory as NonNullable<Awaited<ReturnType<typeof captureKnowledgeCompletenessSession>>['state']['acceptedInventory']>;
    const { proposal } = completenessFixture(session.exchange), mapping = completenessMappingFixture(session.exchange, accepted, proposal);
    await write('submit', { schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1', projectId: f.projectId, runId,
      proposal, mapping, attempt: 1, correctionOfReviewRoundDigest: null });
    for (const kind of ['source', 'completeness'] as const) {
      const role = kind === 'source' ? 'source-reviewer' : 'completeness-reviewer', stage = await status(role);
      const review = kind === 'source' ? fixtureReview(proposal) : completenessReviewFixture(session.exchange, accepted, mapping);
      await write(kind === 'source' ? 'source-review' : 'review', seal({ schemaVersion: 'buildlore.knowledge-completeness-review-submission.v1',
        ...completenessBinding(session.exchange), ...record(record(stage.material).reviewSubmissionBinding), review }, 'submissionDigest'), role);
    }
    const stage = await status(), round = record(record(stage.material).reviewRound);
    const finalized = await f.cli(['compile', 'hierarchy', 'finalize', ...args, '--expect-stage', String(stage.stageViewDigest),
      '--input', await f.json('final-v2.json', { schemaVersion: 'buildlore.knowledge-completeness-finalize-input.v1', projectId: f.projectId, runId,
        proposalDigest: round.proposalDigest, mappingDigest: round.mappingDigest, completenessReviewDigest: round.completenessReviewDigest,
        semanticReviewDigest: round.semanticReviewDigest, reviewViewDigest: stage.stageViewDigest })]);
    expect(finalized, finalized.stderr).toMatchObject({ exitCode: 0, data: { phase: 'finalized', active: false, completenessAssessment: 'verified' } });
    expect(await f.cli(['compile', 'hierarchy', 'approve', ...args, '--expect-ledger', String(finalized.data.ledgerDigest)])).toMatchObject({ exitCode: 2 });
    const approved = await f.cli(['compile', 'hierarchy', 'approve', ...args, '--expect-ledger', String(finalized.data.ledgerDigest), '--confirm-approval']);
    expect(approved, approved.stderr).toMatchObject({ exitCode: 0, data: { phase: 'approved' } });
    expect(await f.cli(approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
    const reader = createKnowledgeWikiReader(f.knowledgeRoot), read = await reader.read(f.projectId, 'overview');
    expect(read).not.toBeNull();
    expect(JSON.stringify(read)).not.toContain('awaiting shadow inventory');
    const current = await readFile(path, 'utf8'), saved = record(JSON.parse(current) as unknown);
    expect(saved.schemaVersion).toBe('buildlore.project-knowledge-workflow-run.v6');
    expect(record(saved.state).inventoryCorrections).toHaveLength(1);
    const relabeled = seal({ ...saved, schemaVersion: 'buildlore.project-knowledge-workflow-run.v5' }, 'recordDigest');
    await writeFile(path, JSON.stringify(relabeled));
    expect(await f.cli(['compile', 'hierarchy', 'status', ...args])).toMatchObject({ exitCode: 3 });
    await writeFile(path, current);
  }, 90_000);
});
