import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { createKnowledgeWorkflowFixture } from './project-knowledge-workflow.js';
import { completenessFixture, completenessMappingFixture, completenessReviewFixture } from './project-knowledge-completeness.js';
import { fixtureReview } from './project-knowledge-fixture.js';
import { preparePlannedKnowledgeCompletenessSession } from '../../src/compiler/project-knowledge/planned-sources.js';
import { captureKnowledgeCompletenessSession, type KnowledgeCompletenessSessionV1 } from '../../src/compiler/project-knowledge/completeness-session.js';
import { completenessBinding, completenessInventoryItems, parseKnowledgeCompletenessInventory,
  type KnowledgeCompletenessInventoryV1, type KnowledgeCompletenessInventoryReviewV1 } from '../../src/compiler/project-knowledge/completeness.js';
import { completenessCorrectionCause, requiredInventoryCorrectionTargets,
  type KnowledgeCompletenessInventoryCorrectionV1, type KnowledgeCompletenessInventoryCycleV1 } from '../../src/compiler/project-knowledge/completeness-correction.js';
import { digest, record } from '../../src/knowledge/project-knowledge/guards.js';
export function seal<T extends object, K extends string>(value: T, key: K): T & Record<K, ReturnType<typeof digest>> {
  const basis = { ...value }; delete (basis as Record<string, unknown>)[key];
  return { ...basis, [key]: digest(basis) } as T & Record<K, ReturnType<typeof digest>>;
}
export const questions = (['overview', 'architecture', 'decisions'] as const).map(role => ({ id: role, role,
  question: `Explain ${role}.`, requirements: [{ id: 'source', sourceRef: `docs/${role === 'overview' ? 'README.md' : role === 'architecture' ? 'architecture.md' : 'decision.md'}`, jsonPointer: null, contentKind: 'text' as const }] }));
export async function correctionFixture() {
  const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true, legacyAuthoring: false });
  expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
  const runId = `run-${randomBytes(32).toString('hex')}`;
  const prepare = async (policy: 'completeness-v1' | 'completeness-v2' = 'completeness-v2') => (await preparePlannedKnowledgeCompletenessSession({
    hubRoot: f.hubRoot, knowledgeRoot: f.knowledgeRoot, projectId: f.projectId, runId, authoringQuestions: questions, inventoryPolicy: policy })).session;
  return { f, prepare, session: await prepare() };
}
export function inventoryCycle(sessionState: Awaited<ReturnType<typeof captureKnowledgeCompletenessSession>>['state']): KnowledgeCompletenessInventoryCycleV1 {
  return { authorInventory: sessionState.authorInventory!, inventoryReview: sessionState.inventoryReview!, reconciliation: sessionState.reconciliation,
    inventoryReReview: sessionState.schemaVersion === 'buildlore.knowledge-completeness-state.v2' ? sessionState.inventoryReReview : null,
    acceptedInventory: sessionState.acceptedInventory, attempts: sessionState.attempts };
}
export function badInventory(session: KnowledgeCompletenessSessionV1) {
  const data = completenessFixture(session.exchange);
  const author = parseKnowledgeCompletenessInventory(seal({ ...data.author,
    questions: data.author.questions.map((q, i) => i !== 0 ? q : { ...q, categories: q.categories.map((c, j) => j !== 0 ? c : {
      ...c, items: c.items.map(item => ({ ...item, statement: `${item.statement} This run is currently awaiting shadow inventory.` })) }) }) }, 'inventoryDigest'), session.exchange, 'author');
  const badId = completenessInventoryItems(author)[0]!.itemId;
  const review = seal({ ...data.review, authorInventoryDigest: author.inventoryDigest, decision: 'unresolved' as const,
    judgments: data.review.judgments.map(j => j.itemId !== badId ? j : { ...j, disposition: j.role === 'author' ? 'unsupported' as const : 'required' as const,
      duplicateOf: null, rationale: 'The source documents behavior, not the current run state.' }) }, 'reviewDigest');
  return { ...data, author, review };
}
export async function submitInventories(session: KnowledgeCompletenessSessionV1, bad = true) {
  const data = bad ? badInventory(session) : completenessFixture(session.exchange);
  await session.submitShadowInventory(data.shadow, (await session.status('completeness-reviewer')).stageViewDigest);
  await session.submitAuthorInventory(data.author, (await session.status('author')).stageViewDigest);
  await session.submitInventoryReview(data.review, (await session.status('completeness-reviewer')).stageViewDigest);
  return data;
}
export async function correctionInput(session: KnowledgeCompletenessSessionV1, author?: KnowledgeCompletenessInventoryV1) {
  const previous = inventoryCycle((await captureKnowledgeCompletenessSession(session)).state);
  const authorInventory = author ?? completenessFixture(session.exchange).author;
  return seal({ schemaVersion: 'buildlore.knowledge-completeness-inventory-correction.v1' as const, ...completenessBinding(session.exchange),
    causeReviewDigest: completenessCorrectionCause(previous)!, authorInventory,
    resolutions: requiredInventoryCorrectionTargets(previous, authorInventory).map((target, i) => ({ resolutionId: `resolution-${String(i)}`,
      target, replacementItemIds: [completenessInventoryItems(authorInventory)[0]!.itemId],
      rationale: 'Remove the unsupported transient state and retain the supported documented behavior.' })) }, 'correctionDigest');
}
export function correctionReview(session: KnowledgeCompletenessSessionV1, correction: KnowledgeCompletenessInventoryCorrectionV1,
  review?: KnowledgeCompletenessInventoryReviewV1, resolved = true) {
  return seal({ schemaVersion: 'buildlore.knowledge-completeness-inventory-correction-review.v1', ...completenessBinding(session.exchange),
    correctionDigest: correction.correctionDigest, review: review ?? completenessFixture(session.exchange).review,
    resolutions: correction.resolutions.map(r => ({ resolutionId: r.resolutionId, verdict: resolved ? 'resolved' : 'unresolved',
      rationale: 'Fixed protocol disposition; actual AI quality is evaluated separately.' })) }, 'reviewDigest');
}
export async function reviewSubmission(session: KnowledgeCompletenessSessionV1, kind: 'source' | 'completeness', review: unknown) {
  const view = await session.status(kind === 'source' ? 'source-reviewer' : 'completeness-reviewer');
  return seal({ schemaVersion: 'buildlore.knowledge-completeness-review-submission.v1', ...completenessBinding(session.exchange),
    ...record(view.material.reviewSubmissionBinding), review }, 'submissionDigest');
}
export async function submitProse(session: KnowledgeCompletenessSessionV1) {
  const accepted = (await captureKnowledgeCompletenessSession(session)).state.acceptedInventory!;
  const { proposal } = completenessFixture(session.exchange), mapping = completenessMappingFixture(session.exchange, accepted, proposal);
  await session.submitProse({ schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1', projectId: session.exchange.projectId,
    runId: session.exchange.runId, proposal, mapping, attempt: 1, correctionOfReviewRoundDigest: null }, (await session.status('author')).stageViewDigest);
  return { proposal, mapping, review: completenessReviewFixture(session.exchange, accepted, mapping) };
}
export async function finishProse(session: KnowledgeCompletenessSessionV1) {
  const { proposal, review } = await submitProse(session);
  await session.submitCompletenessReview(await reviewSubmission(session, 'completeness', review), (await session.status('completeness-reviewer')).stageViewDigest);
  await session.submitSourceReview(await reviewSubmission(session, 'source', fixtureReview(proposal)), (await session.status('source-reviewer')).stageViewDigest);
  const view = await session.status('author'), round = (await captureKnowledgeCompletenessSession(session)).state.attempts.at(-1)!.reviewRound!;
  return session.finalize({ schemaVersion: 'buildlore.knowledge-completeness-finalize-input.v1', projectId: session.exchange.projectId,
    runId: session.exchange.runId, proposalDigest: round.proposalDigest, mappingDigest: round.mappingDigest,
    completenessReviewDigest: round.completenessReviewDigest, semanticReviewDigest: round.semanticReviewDigest,
    reviewViewDigest: view.stageViewDigest }, view.stageViewDigest);
}
