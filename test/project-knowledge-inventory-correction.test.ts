import { matchPublishedShape } from './helpers/published-shape.js';
import { afterEach, describe, expect, it } from 'vitest';
import { captureKnowledgeCompletenessSession, replayKnowledgeCompletenessSession } from '../src/compiler/project-knowledge/completeness-session.js';
import { replayKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { completenessFixture } from './helpers/project-knowledge-completeness.js';
import { fixtureReview } from './helpers/project-knowledge-fixture.js';
import { correctionFixture, submitInventories, correctionInput, correctionReview, finishProse, inventoryCycle,
  reviewSubmission, submitProse, seal } from './helpers/project-knowledge-inventory-correction.js';
import { parseKnowledgeCompletenessInventoryCorrectionReview } from '../src/compiler/project-knowledge/completeness-correction.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
async function setup() { const result = await correctionFixture(); cleanups.push(() => result.f.cleanup()); return result; }

describe('bounded inventory correction without losing source or review history', () => {
  it('repairs the unsupported transient run statement, retains the blind inventory, and finalizes replayable Wiki evidence', async () => {
    const { session, prepare } = await setup(), data = await submitInventories(session);
    expect(await session.status()).toMatchObject({ phase: 'awaiting-inventory-correction', nextActions: ['correct-inventory'], inventoryCorrectionCount: 0 });
    const rejected = (await captureKnowledgeCompletenessSession(session)).state;
    const correction = await correctionInput(session);
    await expect(session.correctInventory(seal({ ...correction, resolutions: [] }, 'correctionDigest'), (await session.status('author')).stageViewDigest)).rejects.toThrow();
    await expect(session.correctInventory(seal({ ...correction, causeReviewDigest: correction.exchangeDigest }, 'correctionDigest'), (await session.status('author')).stageViewDigest)).rejects.toThrow();
    await expect(session.correctInventory({ ...correction, oversized: Array.from({ length: 1100 }, () => 'x'.repeat(1024)) }, (await session.status('author')).stageViewDigest)).rejects.toMatchObject({ code: 'KNOWLEDGE_COMPLETENESS_BUDGET_EXCEEDED' });
    expect((await captureKnowledgeCompletenessSession(session)).state).toEqual(rejected);
    await session.correctInventory(correction, (await session.status('author')).stageViewDigest);
    await expect(session.submitInventoryReview(completenessFixture(session.exchange).review, (await session.status('completeness-reviewer')).stageViewDigest)).rejects.toThrow();
    await session.submitInventoryReview(correctionReview(session, correction), (await session.status('completeness-reviewer')).stageViewDigest);
    const generation = await finishProse(session), state = (await captureKnowledgeCompletenessSession(session)).state;
    expect(state.schemaVersion).toBe('buildlore.knowledge-completeness-state.v2');
    if (state.schemaVersion !== 'buildlore.knowledge-completeness-state.v2') throw new Error('Expected v2.');
    await matchPublishedShape(state, { $ref: '#/$defs/stateV2' });
    await matchPublishedShape(session.exchange, { $ref: '#/$defs/exchangeV2' });
    await matchPublishedShape(await session.status('author'), { $ref: '#/$defs/stageV2' });
    await matchPublishedShape(generation.completenessProof, { $ref: '#/$defs/proofV2' });
    expect(state.shadowInventory).toEqual(data.shadow);
    expect(state.inventoryCorrections[0]?.previous.inventoryReview).toEqual(data.review);
    expect(generation.completenessProof?.schemaVersion).toBe('buildlore.knowledge-completeness-proof.v2');
    expect(JSON.stringify(generation.pages)).not.toContain('awaiting shadow inventory');
    expect(replayKnowledgeGeneration(JSON.parse(JSON.stringify(generation)), 'parcel', null)).toEqual(generation);
    const restored = await prepare(); await replayKnowledgeCompletenessSession(restored, state);
    expect((await captureKnowledgeCompletenessSession(restored)).generation).toEqual(generation);
    const proof = generation.completenessProof!;
    if (proof.schemaVersion !== 'buildlore.knowledge-completeness-proof.v2') throw new Error('Expected v2.');
    const stripped = seal({ ...proof.state, inventoryCorrections: [] }, 'stateDigest');
    const altered = seal({ ...proof, state: stripped }, 'proofDigest');
    expect(() => replayKnowledgeGeneration(seal({ ...generation, completenessProof: altered }, 'generationDigest'), 'parcel', null)).toThrow();
  }, 30_000);
  it('corrects an unsupported original shadow item through explicit disposition without replacing the shadow', async () => {
    const { session } = await setup(), data = completenessFixture(session.exchange);
    const shadow = seal({ ...data.shadow, questions: data.shadow.questions.map((q, i) => i ? q : { ...q,
      categories: q.categories.map((c, i) => i ? c : { ...c, items: c.items.map(item => ({ ...item, statement: 'This run is awaiting shadow inventory.' })) }) }) }, 'inventoryDigest');
    const badId = shadow.questions[0]!.categories[0]!.items[0]!.itemId;
    const review = seal({ ...data.review, shadowInventoryDigest: shadow.inventoryDigest, decision: 'unresolved',
      judgments: data.review.judgments.map(j => j.role !== 'blind-shadow-reviewer' || j.itemId !== badId ? j : { ...j, disposition: 'unsupported', duplicateOf: null }) }, 'reviewDigest');
    await session.submitShadowInventory(shadow, (await session.status('completeness-reviewer')).stageViewDigest);
    await session.submitAuthorInventory(data.author, (await session.status('author')).stageViewDigest);
    await session.submitInventoryReview(review, (await session.status('completeness-reviewer')).stageViewDigest);
    const correction = await correctionInput(session);
    expect(correction.resolutions[0]!.target).toMatchObject({ kind: 'item', role: 'blind-shadow-reviewer' });
    await session.correctInventory(correction, (await session.status('author')).stageViewDigest);
    const reviewed = seal({ ...data.review, shadowInventoryDigest: shadow.inventoryDigest, decision: 'reconcilable' as const,
      judgments: data.review.judgments.map(j => j.role !== 'blind-shadow-reviewer' || j.itemId !== badId ? j : { ...j, disposition: 'not-required' as const, duplicateOf: null }) }, 'reviewDigest');
    await session.submitInventoryReview(correctionReview(session, correction, reviewed), (await session.status('completeness-reviewer')).stageViewDigest);
    expect((await captureKnowledgeCompletenessSession(session)).state.shadowInventory).toEqual(shadow);
    expect((await session.status()).phase).toBe('awaiting-inventory-reconciliation');
  }, 30_000);
  it('preserves explicit v1 terminal behavior and refuses version relabeling', async () => {
    const { prepare } = await setup(), legacy = await prepare('completeness-v1');
    await submitInventories(legacy);
    const state = (await captureKnowledgeCompletenessSession(legacy)).state;
    expect(state).toMatchObject({ phase: 'completeness-failed', terminal: { code: 'inventory-defect', round: 0 } });
    await expect(replayKnowledgeCompletenessSession(await prepare(), state)).rejects.toThrow();
    await expect(legacy.correctInventory({}, (await legacy.status('author')).stageViewDigest)).rejects.toThrow();
  }, 30_000);
  it('keeps genuine missing selected sources blocking', async () => {
    const { session } = await setup(), data = completenessFixture(session.exchange);
    await session.submitShadowInventory(data.shadow, (await session.status('completeness-reviewer')).stageViewDigest);
    await session.submitAuthorInventory(data.author, (await session.status('author')).stageViewDigest);
    const review = seal({ ...data.review, decision: 'unresolved', questions: data.review.questions.map((q, i) => i !== 0 ? q : {
      ...q, categories: q.categories.map((c, j) => j !== 0 ? c : { ...c, status: 'source-gap' }) }) }, 'reviewDigest');
    await session.submitInventoryReview(review, (await session.status('completeness-reviewer')).stageViewDigest);
    expect(await session.status()).toMatchObject({ phase: 'completeness-failed', terminal: { code: 'inventory-defect' } });
  }, 30_000);
  it('exhausts exactly two corrections and preserves unresolved resolution findings', async () => {
    const { session, prepare } = await setup(); await submitInventories(session);
    for (let i = 0; i < 2; i += 1) {
      const correction = await correctionInput(session);
      await session.correctInventory(correction, (await session.status('author')).stageViewDigest);
      await session.submitInventoryReview(correctionReview(session, correction, undefined, false), (await session.status('completeness-reviewer')).stageViewDigest);
      expect((await session.status()).phase).toBe(i === 0 ? 'awaiting-inventory-correction' : 'completeness-failed');
    }
    expect(await session.status()).toMatchObject({ inventoryCorrectionCount: 2, terminal: { code: 'inventory-correction-exhausted' } });
    const restored = await prepare(); await replayKnowledgeCompletenessSession(restored, (await captureKnowledgeCompletenessSession(session)).state);
    await expect(restored.correctInventory({}, (await restored.status('author')).stageViewDigest)).rejects.toThrow();
  }, 30_000);
  it('waits for both prose reviews, binds the combined cause, resets live prose, and rejects stale review envelopes', async () => {
    const { session, prepare } = await setup(); await submitInventories(session, false);
    const { proposal, review } = await submitProse(session);
    const defective = seal({ ...review, questions: review.questions.map((q, i) => i ? q : { ...q, verdict: 'inventory-defect' }),
      inventoryFindings: [{ questionId: 'overview', statement: 'A required condition was omitted.', evidenceIds: proposal.facts[0]!.evidenceIds,
        rationale: 'Deterministic post-prose correction case.' }] }, 'reviewDigest');
    const oldOmission = await reviewSubmission(session, 'completeness', defective), oldSource = await reviewSubmission(session, 'source', fixtureReview(proposal));
    await session.submitCompletenessReview(oldOmission, (await session.status('completeness-reviewer')).stageViewDigest);
    expect(await session.status()).toMatchObject({ phase: 'awaiting-initial-reviews', nextActions: ['source-review'] });
    await session.submitSourceReview(oldSource, (await session.status('source-reviewer')).stageViewDigest);
    const before = (await captureKnowledgeCompletenessSession(session)).state, correction = await correctionInput(session);
    expect(correction.causeReviewDigest).toBe(before.attempts[0]!.reviewRound!.reviewRoundDigest);
    await session.correctInventory(correction, (await session.status('author')).stageViewDigest);
    expect((await captureKnowledgeCompletenessSession(session)).state).toMatchObject({ attempts: [], acceptedInventory: null });
    await session.submitInventoryReview(correctionReview(session, correction), (await session.status('completeness-reviewer')).stageViewDigest);
    const current = await submitProse(session);
    await expect(session.submitSourceReview(oldSource, (await session.status('source-reviewer')).stageViewDigest)).rejects.toThrow();
    await expect(session.submitCompletenessReview(oldOmission, (await session.status('completeness-reviewer')).stageViewDigest)).rejects.toThrow();
    await session.submitSourceReview(await reviewSubmission(session, 'source', fixtureReview(current.proposal)), (await session.status('source-reviewer')).stageViewDigest);
    await session.submitCompletenessReview(await reviewSubmission(session, 'completeness', current.review), (await session.status('completeness-reviewer')).stageViewDigest);
    expect((await session.status()).phase).toBe('review-ready');
    const restored = await prepare(); await replayKnowledgeCompletenessSession(restored, (await captureKnowledgeCompletenessSession(session)).state);
    expect((await restored.status()).phase).toBe('review-ready');
    const round = (await captureKnowledgeCompletenessSession(restored)).state.attempts[0]!.reviewRound!, expected = (await restored.status('author')).stageViewDigest;
    const generation = await restored.finalize({ schemaVersion: 'buildlore.knowledge-completeness-finalize-input.v1', projectId: restored.exchange.projectId,
      runId: restored.exchange.runId, proposalDigest: round.proposalDigest, mappingDigest: round.mappingDigest,
      completenessReviewDigest: round.completenessReviewDigest, semanticReviewDigest: round.semanticReviewDigest, reviewViewDigest: expected }, expected);
    expect(replayKnowledgeGeneration(generation, 'parcel', null)).toEqual(generation);
  }, 30_000);
  it('does not let a previously required item disappear behind a different duplicate target', async () => {
    const { session } = await setup(); await submitInventories(session);
    const previous = inventoryCycle((await captureKnowledgeCompletenessSession(session)).state), correction = await correctionInput(session);
    const input = correctionReview(session, correction), altered = structuredClone(input.review);
    const required = previous.inventoryReview.judgments.find(j => j.disposition === 'required' && j.role === 'blind-shadow-reviewer')!;
    const data = completenessFixture(session.exchange), author = seal({ ...data.author, questions: data.author.questions.map((q, i) => i ? q : {
      ...q, categories: q.categories.map((c, i) => i ? c : { ...c, items: c.items.map(item => ({ ...item, statement: 'A different substantive proposition.' })) }) }) }, 'inventoryDigest');
    const changedCorrection = seal({ ...correction, authorInventory: author }, 'correctionDigest');
    const changedReview = seal({ ...altered, authorInventoryDigest: author.inventoryDigest }, 'reviewDigest');
    expect(required).toBeDefined();
    expect(() => parseKnowledgeCompletenessInventoryCorrectionReview(seal({ ...input, correctionDigest: changedCorrection.correctionDigest, review: changedReview }, 'reviewDigest'),
      session.exchange, data.shadow, { previous, correction: changedCorrection })).toThrow();
  }, 30_000);
});
