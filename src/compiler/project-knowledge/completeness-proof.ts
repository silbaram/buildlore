import { createKnowledgeCompletenessCorrectionProof, parseKnowledgeCompletenessCorrectionProof, type KnowledgeCompletenessProofV2 } from './completeness-correction-proof.js';
export type { KnowledgeCompletenessProofV2 } from './completeness-correction-proof.js';
export type KnowledgeCompletenessProof = KnowledgeCompletenessProofV1 | KnowledgeCompletenessProofV2;
import { choice, digest, hash, invalid, keys, list, record, text, ProjectKnowledgeError } from '../../knowledge/project-knowledge/guards.js';
import { reconcileKnowledge } from '../../knowledge/project-knowledge/reconcile.js';
import type { KnowledgeDigest, KnowledgeGenerationV1, KnowledgeProposalV1, KnowledgeSemanticReviewV1,
  KnowledgeSnapshotV1 } from '../../knowledge/project-knowledge/types.js';
import type { KnowledgeExchangeV1 } from './session.js';
import type { KnowledgeCompletenessState } from './completeness-session.js';
import { parseKnowledgeProposal, parseKnowledgeSemanticReview } from './proposal.js';
import { acceptKnowledgeCompletenessInventory, completenessJson, createKnowledgeCompletenessExchange,
  parseKnowledgeCompletenessInventory, parseKnowledgeCompletenessInventoryReview, parseKnowledgeCompletenessReconciliation,
  parseKnowledgeCompletenessProseMapping, parseKnowledgeCompletenessReview,
  type KnowledgeCompletenessExchange, type KnowledgeCompletenessInventoryV1,
  type KnowledgeCompletenessInventoryReviewV1, type KnowledgeCompletenessInventoryReconciliationV1,
  type KnowledgeCompletenessProseMappingV1, type KnowledgeCompletenessReviewV1 } from './completeness.js';
import type { KnowledgeAuthoringQuestion } from './authoring-questions.js';

interface CompletenessProofAttempt {
  /** The final attempt references the enclosing generation instead of duplicating its prose/review. */
  readonly proposal: KnowledgeProposalV1 | null;
  readonly semanticReview: KnowledgeSemanticReviewV1 | null;
  readonly mapping: KnowledgeCompletenessProseMappingV1;
  readonly completenessReview: KnowledgeCompletenessReviewV1;
  readonly reviewOrder: readonly ('completeness' | 'source')[];
}
export interface KnowledgeCompletenessProofV1 {
  readonly schemaVersion: 'buildlore.knowledge-completeness-proof.v1';
  readonly runId: string;
  readonly baseInstructions: readonly string[];
  readonly authoringQuestions: readonly KnowledgeAuthoringQuestion[];
  readonly shadowInventory: KnowledgeCompletenessInventoryV1;
  readonly authorInventory: KnowledgeCompletenessInventoryV1;
  readonly inventoryReview: KnowledgeCompletenessInventoryReviewV1;
  readonly reconciliation: KnowledgeCompletenessInventoryReconciliationV1 | null;
  readonly acceptedInventoryDigest: KnowledgeDigest;
  readonly proposalDigest: KnowledgeDigest;
  readonly semanticReviewDigest: KnowledgeDigest;
  readonly attempts: readonly CompletenessProofAttempt[];
  readonly proofDigest: KnowledgeDigest;
}

/** Persist judgments and their exact inputs, never a trusted "passed" flag or copied snapshot. */
export function createKnowledgeCompletenessProof(exchange: KnowledgeCompletenessExchange,
  state: KnowledgeCompletenessState): KnowledgeCompletenessProof {
  if (exchange.policyVersion === 'completeness-v2') {
    if (state.schemaVersion !== 'buildlore.knowledge-completeness-state.v2') invalid();
    return createKnowledgeCompletenessCorrectionProof(exchange, state);
  }
  if (state.schemaVersion !== 'buildlore.knowledge-completeness-state.v1') invalid();
  const current = state.attempts.at(-1) ?? invalid();
  if (!current.reviewRound?.completenessPassed || !current.reviewRound.sourcePassed || state.terminal !== null) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-proof.v1' as const,
    runId: exchange.runId, baseInstructions: exchange.baseExchange.instructions, authoringQuestions: exchange.authoringQuestions,
    shadowInventory: state.shadowInventory ?? invalid(), authorInventory: state.authorInventory ?? invalid(),
    inventoryReview: state.inventoryReview ?? invalid(), reconciliation: state.reconciliation,
    acceptedInventoryDigest: state.acceptedInventory?.acceptedInventoryDigest ?? invalid(),
    proposalDigest: current.submission.proposal.proposalDigest, semanticReviewDigest: current.semanticReview?.reviewDigest ?? invalid(),
    attempts: Object.freeze(state.attempts.map((attempt, index) => Object.freeze({
      proposal: index === state.attempts.length - 1 ? null : attempt.submission.proposal,
      semanticReview: index === state.attempts.length - 1 ? null : attempt.semanticReview ?? invalid(),
      mapping: attempt.submission.mapping, completenessReview: attempt.completenessReview ?? invalid(), reviewOrder: attempt.reviewOrder }))) };
  const result = Object.freeze({ ...basis, proofDigest: digest(basis) });
  completenessJson(result, 8_388_608);
  return result;
}

/** Pure replay used by both generation creation and persisted history admission. */
export function parseKnowledgeCompletenessProof(value: unknown, snapshot: KnowledgeSnapshotV1,
  proposal: KnowledgeProposalV1, review: KnowledgeSemanticReviewV1,
  previous: KnowledgeGenerationV1 | null): KnowledgeCompletenessProof {
  if (record(value).schemaVersion === 'buildlore.knowledge-completeness-proof.v2') return parseKnowledgeCompletenessCorrectionProof(value, snapshot, proposal, review, previous);
  const input = completenessJson(value, 8_388_608);
  keys(input, ['schemaVersion', 'runId', 'baseInstructions', 'authoringQuestions', 'shadowInventory', 'authorInventory',
    'inventoryReview', 'reconciliation', 'acceptedInventoryDigest', 'proposalDigest', 'semanticReviewDigest', 'attempts', 'proofDigest']);
  if (input.schemaVersion !== 'buildlore.knowledge-completeness-proof.v1' || input.proposalDigest !== proposal.proposalDigest ||
      input.semanticReviewDigest !== review.reviewDigest) invalid();
  const baseInstructions = Object.freeze(list(input.baseInstructions, 128).map(v => text(v)));
  const base = { schemaVersion: 'buildlore.knowledge-exchange.v1' as const, projectId: snapshot.projectId, snapshot,
    baselineGenerationDigest: previous?.generationDigest ?? null, previousRecords: previous?.records ?? [], previousEvidence: previous?.evidence ?? [],
    instructions: baseInstructions, boundary: { generationActor: 'current-agent-session' as const, egress: 'none' as const, processSpawned: false as const } };
  const baseExchange: KnowledgeExchangeV1 = Object.freeze({ ...base, exchangeDigest: digest(base) });
  const exchange = createKnowledgeCompletenessExchange(baseExchange, input.authoringQuestions, text(input.runId, 68));
  const shadowInventory = parseKnowledgeCompletenessInventory(input.shadowInventory, exchange, 'blind-shadow-reviewer');
  const authorInventory = parseKnowledgeCompletenessInventory(input.authorInventory, exchange, 'author');
  if (shadowInventory.actor.sessionId === authorInventory.actor.sessionId) throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
  const inventoryReview = parseKnowledgeCompletenessInventoryReview(input.inventoryReview, exchange, shadowInventory, authorInventory);
  const reconciliation = input.reconciliation === null ? null
    : parseKnowledgeCompletenessReconciliation(input.reconciliation, exchange, inventoryReview, authorInventory.actor);
  const accepted = acceptKnowledgeCompletenessInventory(exchange, shadowInventory, authorInventory, inventoryReview, reconciliation);
  if (input.acceptedInventoryDigest !== accepted.acceptedInventoryDigest) invalid();
  const rawAttempts = list(input.attempts, 2);
  if (rawAttempts.length === 0) invalid();
  let firstSourceReviewer: KnowledgeSemanticReviewV1['reviewer'] | null = null;
  const attempts = rawAttempts.map((raw, index): CompletenessProofAttempt => {
    const a = record(raw); keys(a, ['proposal', 'semanticReview', 'mapping', 'completenessReview', 'reviewOrder']);
    const final = index === rawAttempts.length - 1;
    if (final !== (a.proposal === null) || final !== (a.semanticReview === null)) invalid();
    const candidate = final ? proposal : parseKnowledgeProposal(a.proposal, snapshot);
    if (candidate.baselineGenerationDigest !== (previous?.generationDigest ?? null) || digest(candidate.actor) !== digest(accepted.author)) invalid();
    const semantic = final ? review : parseKnowledgeSemanticReview(a.semanticReview, candidate, snapshot, previous);
    if (semantic.reviewer.sessionId === accepted.reviewer.sessionId ||
        firstSourceReviewer !== null && digest(semantic.reviewer) !== digest(firstSourceReviewer)) throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
    firstSourceReviewer ??= semantic.reviewer;
    const mapping = parseKnowledgeCompletenessProseMapping(a.mapping, exchange, accepted, candidate);
    const completenessReview = parseKnowledgeCompletenessReview(a.completenessReview, exchange, accepted, mapping, index === 0 ? 1 : 2);
    if (completenessReview.inventoryFindings.length > 0) invalid();
    const order = list(a.reviewOrder, 2).map(v => choice(v, ['completeness', 'source'] as const));
    if (order.length !== 2 || new Set(order).size !== 2) invalid();
    let sourcePassed = true;
    try { reconcileKnowledge(snapshot, candidate, semantic, previous); }
    catch (error) {
      if (!(error instanceof ProjectKnowledgeError) || !['KNOWLEDGE_INVALID', 'KNOWLEDGE_REVIEW_REQUIRED'].includes(error.code)) throw error;
      sourcePassed = false;
    }
    const complete = completenessReview.items.every(item => item.verdict === 'covered') &&
      completenessReview.questions.every(q => q.verdict === 'complete');
    // A correction is admitted only after a failed round; final success requires both reviews.
    if (final !== (complete && sourcePassed)) invalid();
    return Object.freeze({ proposal: final ? null : candidate, semanticReview: final ? null : semantic,
      mapping, completenessReview, reviewOrder: Object.freeze(order) });
  });
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-proof.v1' as const, runId: exchange.runId, baseInstructions,
    authoringQuestions: exchange.authoringQuestions, shadowInventory, authorInventory, inventoryReview, reconciliation,
    acceptedInventoryDigest: accepted.acceptedInventoryDigest, proposalDigest: proposal.proposalDigest,
    semanticReviewDigest: review.reviewDigest, attempts: Object.freeze(attempts) };
  const result = Object.freeze({ ...basis, proofDigest: digest(basis) });
  if (hash(input.proofDigest) !== result.proofDigest || digest(input) !== digest(result)) invalid();
  return result;
}
