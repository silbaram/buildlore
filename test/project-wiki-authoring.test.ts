import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeWorkflowFixture, type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { preparePlannedKnowledgeSession } from '../src/compiler/project-knowledge/planned-sources.js';
import { createKnowledgeWikiSession } from '../src/compiler/project-knowledge/wiki-session.js';
import { replayKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { bridgeKnowledgeToHierarchy } from '../src/compiler/project-knowledge/hierarchy-bridge.js';
import { finalizeCompileRun } from '../src/compiler/hierarchy/index.js';
import { renderKnowledgeFiles } from '../src/compiler/project-knowledge/markdown.js';
import { renderKnowledgeReaderPages } from '../src/compiler/project-knowledge/reader-context.js';
import { createKnowledgeWikiDraft } from '../src/compiler/project-knowledge/wiki-contracts.js';
import { digest } from '../src/knowledge/project-knowledge/guards.js';
import { wikiDraft, wikiPurpose, wikiReview } from './helpers/project-wiki.js';
import { matchPublishedShape } from './helpers/published-shape.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });
async function setup() {
  const f = await createKnowledgeWorkflowFixture('generic-md-json'); fixtures.push(f);
  await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { capabilities: ['compile'] });
  expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
  const prepare = () => preparePlannedKnowledgeSession({ ...f, outputLanguage: 'ko', rendererVersion: 'knowledge-markdown-v3', authoringMode: 'wiki-v1' });
  const { session: base } = await prepare(), runId = `run-${'a'.repeat(64)}`;
  const session = await createKnowledgeWikiSession(base, wikiPurpose(f.projectId), runId);
  return { f, base, runId, session, prepare };
}
describe('generic Wiki authoring', () => {
  it.each([1, 4])('saves, independently reviews and finalizes %i free-topic pages', async count => {
    const { f, base, runId, session } = await setup();
    const instructions = base.exchange.instructions.join('\n');
    expect(instructions).not.toContain('exactly overview');
    expect(instructions).not.toContain('compiler/project-knowledge/session');
    const ids = Array.from({ length: count }, (_, i) => `operations-${i}`);
    const draft = wikiDraft(base.exchange.snapshot, ids, true);
    for (const page of draft.pages) {
      const claim = page.sections[0]!.claims[0]!;
      claim.text = `${claim.text}\n\n\`\`\`text\n${claim.text}\n\`\`\``;
    }
    await session.submit(draft, [], session.view().stageDigest);
    expect(session.view().phase).toBe('awaiting-review');
    const proposal = session.state().revisions[0]!.proposal;
    const inspection = await session.inspect({ schemaVersion: 'buildlore.wiki-inspection.v1', projectId: f.projectId,
      mode: 'draft', offset: 0, limit: 1, maxBytes: 8192 }, session.view().stageDigest);
    expect(inspection).toMatchObject({ items: [{ evidenceIds: proposal.facts.find(fact => fact.id === proposal.pages[0]?.sections[0]?.claims[0]?.factIds[0])?.evidenceIds }] });
    await session.review(wikiReview(proposal, runId), session.view().stageDigest);
    const generation = await session.finalize(session.view().stageDigest);
    await matchPublishedShape(generation, { $ref: 'project-knowledge.schema.json#/$defs/generationV3' });
    await matchPublishedShape(session.state(), { $ref: 'project-wiki.schema.json#/$defs/state' });
    expect(generation.pages).toHaveLength(count);
    expect(generation.wikiProof?.revisions[0]?.review?.findings.filter(f => f.status === 'open')).toHaveLength(count);
    expect(renderKnowledgeFiles(generation).filter(f => f.path.endsWith('.md')).every(f =>
      f.body.includes('needs-attention') && !f.body.includes('undocumented automatic'))).toBe(true);
    expect(renderKnowledgeReaderPages(generation).every(file => !file.body.includes('``` [fact:'))).toBe(true);
    expect(replayKnowledgeGeneration(generation, f.projectId, null).generationDigest).toBe(generation.generationDigest);
    const bridge = await bridgeKnowledgeToHierarchy({ knowledgeRoot: f.knowledgeRoot, generation, baselineGenerationDigest: null, baselineProposals: [] });
    expect(finalizeCompileRun(bridge.finalization, f.projectId, bridge.reviewedQuality).ledgerDigest).toMatch(/^sha256:/);
    expect(bridge.finalization.pageQualityReports.some(report => report.advisoryReasonCodes?.includes('unsupported-section-content'))).toBe(true);
    await matchPublishedShape(bridge.finalization.outline, { $ref: 'hierarchical-corpus.schema.json#/$defs/wikiOutlineGeneric' });
    await matchPublishedShape(bridge.finalization.pageQualityReports[0], { $ref: 'hierarchical-corpus.schema.json#/$defs/pageQualityReportGeneric' });
  });
  it('resumes corrections, retains resolved issues and preserves a usable result at the limit', async () => {
    const { base, runId, session, prepare } = await setup();
    const draft = wikiDraft(base.exchange.snapshot, ['policy'], true);
    await session.submit(draft, [], session.view().stageDigest);
    await session.review(wikiReview(session.state().revisions[0]!.proposal, runId), session.view().stageDigest);
    const oldStage = session.view().stageDigest;
    const fresh = await createKnowledgeWikiSession((await prepare()).session, wikiPurpose(base.exchange.projectId), runId, session.state());
    const fixed = wikiDraft(base.exchange.snapshot, ['policy']);
    await fresh.submit(fixed, [], oldStage);
    await expect(fresh.review({}, oldStage)).rejects.toThrow();
    await fresh.review(wikiReview(fresh.state().revisions[1]!.proposal, runId), fresh.view().stageDigest);
    expect(fresh.state().revisions[1]?.review?.findings[0]?.status).toBe('resolved');
    await fresh.submit(draft, [], fresh.view().stageDigest);
    await fresh.review(wikiReview(fresh.state().revisions[2]!.proposal, runId), fresh.view().stageDigest);
    expect(fresh.view().correctionsRemaining).toBe(0);
    expect(fresh.view().phase).toBe('reviewed');
    await expect(fresh.submit(fixed, [], fresh.view().stageDigest)).rejects.toThrow();
    expect((await fresh.finalize(fresh.view().stageDigest)).wikiProof?.revisions).toHaveLength(3);
  });
  it('keeps an all-unsupported draft incomplete and rejects unsafe page paths', async () => {
    const { base, runId, session } = await setup();
    const draft = wikiDraft(base.exchange.snapshot);
    for (const id of ['../escape', 'knowledge', 'evidence', 'manifest', 'bad/name']) {
      expect(() => createKnowledgeWikiDraft({ ...draft, rootPageId: id, pages: [{ ...draft.pages[0], id }] }, base.exchange.snapshot, null)).toThrow();
    }
    await session.submit(draft, [], session.view().stageDigest);
    const review = wikiReview(session.state().revisions[0]!.proposal, runId);
    await session.review({ ...review, judgments: review.judgments.map(j => ({ ...j, verdict: 'unsupported' })) }, session.view().stageDigest);
    expect(session.view().phase).toBe('incomplete');
    await expect(session.finalize(session.view().stageDigest)).rejects.toThrow();
    expect(session.state().revisions).toHaveLength(1);
    const tampered = { ...session.state(), purpose: { ...session.state().purpose, goal: 'different scope' } };
    await expect(createKnowledgeWikiSession(base, wikiPurpose(base.exchange.projectId), runId, { ...tampered, stateDigest: digest(tampered) })).rejects.toThrow();
  });
  it('does not drop or rename prior manual findings, accept self-review, or persist credential-bearing prose', async () => {
    const { base, runId, session } = await setup();
    const draft = wikiDraft(base.exchange.snapshot);
    const bad = structuredClone(draft);
    bad.pages[0]!.sections[0]!.claims[0]!.text = `ghp_${'1234567890'.repeat(3)}123456`;
    await expect(session.submit(bad, [], session.view().stageDigest)).rejects.toThrow();
    expect(session.state().revisions).toHaveLength(0);
    await session.submit(draft, [], session.view().stageDigest);
    const review = wikiReview(session.state().revisions[0]!.proposal, runId);
    await expect(session.review({ ...review, reviewer: draft.actor }, session.view().stageDigest)).rejects.toThrow();
    const finding = { id: 'contact-gap', pageId: null, claimId: null, kind: 'unknown', description: 'The source does not identify a contact.',
      evidenceIds: [], status: 'open', resolution: null };
    await session.review({ ...review, findings: [finding] }, session.view().stageDigest);
    await session.submit(draft, [], session.view().stageDigest);
    expect(session.state().revisions[1]?.resolutions[0]?.action).toBe('deferred');
    const nextReview = wikiReview(session.state().revisions[1]!.proposal, runId);
    await expect(session.review(nextReview, session.view().stageDigest)).rejects.toThrow();
    await expect(session.review({ ...nextReview, findings: [{ ...finding, description: 'Changed identity' }] }, session.view().stageDigest)).rejects.toThrow();
    await session.review({ ...nextReview, findings: [finding] }, session.view().stageDigest);
    expect((await session.finalize(session.view().stageDigest)).wikiProof?.revisions.at(-1)?.review?.findings).toContainEqual(finding);
  });
  it('requires explicit baseline review and marks unrenewed old facts stale when pages change', async () => {
    const { f, base, runId, session } = await setup();
    await session.submit(wikiDraft(base.exchange.snapshot), [], session.view().stageDigest);
    await session.review(wikiReview(session.state().revisions[0]!.proposal, runId), session.view().stageDigest);
    const previous = await session.finalize(session.view().stageDigest);
    const { session: nextBase } = await preparePlannedKnowledgeSession({ ...f, outputLanguage: 'ko', rendererVersion: 'knowledge-markdown-v3',
      authoringMode: 'wiki-v1', previousGenerations: [previous] });
    const next = await createKnowledgeWikiSession(nextBase, wikiPurpose(f.projectId), `run-${'b'.repeat(64)}`);
    await next.submit(wikiDraft(nextBase.exchange.snapshot, ['updated-policy']), [], next.view().stageDigest);
    const proposal = next.state().revisions[0]!.proposal;
    await expect(next.review(wikiReview(proposal, next.state().runId), next.view().stageDigest)).rejects.toThrow();
    await next.review(wikiReview(proposal, next.state().runId, [], previous.generationDigest), next.view().stageDigest);
    const generation = await next.finalize(next.view().stageDigest);
    expect(generation.records.find(fact => fact.id === previous.records[0]?.id)?.lifecycle).toBe('stale');
    expect(generation.pages[0]?.role).toBe('updated-policy');
    expect(replayKnowledgeGeneration(generation, f.projectId, previous).generationDigest).toBe(generation.generationDigest);
  });
});
