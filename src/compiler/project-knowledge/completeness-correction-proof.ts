import { choice, digest, hash, invalid, keys, list, record, text, ProjectKnowledgeError } from '../../knowledge/project-knowledge/guards.js';
import { reconcileKnowledge } from '../../knowledge/project-knowledge/reconcile.js';
import type { KnowledgeGenerationV1, KnowledgeProposalV1, KnowledgeSemanticReviewV1, KnowledgeSnapshotV1 } from '../../knowledge/project-knowledge/types.js';
import { parseKnowledgeProposal, parseKnowledgeSemanticReview } from './proposal.js';
import { acceptKnowledgeCompletenessInventory, completenessBinding, completenessJson, createKnowledgeCompletenessExchange,
  parseKnowledgeCompletenessInventory, parseKnowledgeCompletenessInventoryReview, parseKnowledgeCompletenessReconciliation,
  parseKnowledgeCompletenessProseMapping, parseKnowledgeCompletenessReview,
  type KnowledgeCompletenessExchangeV2, type KnowledgeCompletenessInventoryV1 } from './completeness.js';
import { MAX_INVENTORY_CORRECTIONS, completenessCorrectionCause, completenessInventorySourceGap, hasCompletenessRequiredSourceGap,
  parseKnowledgeCompletenessInventoryCorrection, parseKnowledgeCompletenessInventoryCorrectionReview,
  type KnowledgeCompletenessInventoryCycleV1, type KnowledgeCompletenessInventoryCorrectionStepV1 } from './completeness-correction.js';
import { parseCompletenessReviewSubmission } from './completeness-review-binding.js';
import type { KnowledgeCompletenessAttemptV1, KnowledgeCompletenessStateV2 } from './completeness-session.js';
import type { KnowledgeAuthoringQuestion } from './authoring-questions.js';

export interface KnowledgeCompletenessProofV2 {
  readonly schemaVersion: 'buildlore.knowledge-completeness-proof.v2';
  readonly runId: string;
  readonly baseInstructions: readonly string[];
  readonly authoringQuestions: readonly KnowledgeAuthoringQuestion[];
  readonly state: KnowledgeCompletenessStateV2;
  readonly proposalDigest: KnowledgeProposalV1['proposalDigest'];
  readonly semanticReviewDigest: KnowledgeSemanticReviewV1['reviewDigest'];
  readonly proofDigest: KnowledgeProposalV1['proposalDigest'];
}
export function createKnowledgeCompletenessCorrectionProof(exchange: KnowledgeCompletenessExchangeV2,
  state: KnowledgeCompletenessStateV2): KnowledgeCompletenessProofV2 {
  const current = state.attempts.at(-1) ?? invalid();
  if (state.phase !== 'review-ready' || state.finalized || state.terminal !== null) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-proof.v2' as const, runId: exchange.runId,
    baseInstructions: exchange.baseExchange.instructions, authoringQuestions: exchange.authoringQuestions, state,
    proposalDigest: current.submission.proposal.proposalDigest, semanticReviewDigest: current.semanticReview?.reviewDigest ?? invalid() };
  const result = Object.freeze({ ...basis, proofDigest: digest(basis) });
  completenessJson(result, 8_388_608); return result;
}

/** Pure replay of each inventory cycle; stored flags and nested hashes are never trusted. */
function parseCycle(value: unknown, exchange: KnowledgeCompletenessExchangeV2, shadow: KnowledgeCompletenessInventoryV1,
  step: KnowledgeCompletenessInventoryCorrectionStepV1 | undefined, previous: KnowledgeGenerationV1 | null): KnowledgeCompletenessInventoryCycleV1 {
  const input = record(value);
  keys(input, ['authorInventory', 'inventoryReview', 'inventoryReReview', 'reconciliation', 'acceptedInventory', 'attempts']);
  const authorInventory = parseKnowledgeCompletenessInventory(input.authorInventory, exchange, 'author');
  if (shadow.actor.sessionId === authorInventory.actor.sessionId || step !== undefined &&
    authorInventory.inventoryDigest !== step.correction.authorInventory.inventoryDigest) throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
  const inventoryReReview = step === undefined ? null : parseKnowledgeCompletenessInventoryCorrectionReview(input.inventoryReReview, exchange, shadow, step);
  if (step === undefined && input.inventoryReReview !== null) invalid();
  const inventoryReview = inventoryReReview?.review ?? parseKnowledgeCompletenessInventoryReview(input.inventoryReview, exchange, shadow, authorInventory);
  const unresolved = inventoryReview.decision === 'unresolved' || inventoryReReview?.resolutions.some(r => r.verdict === 'unresolved');
  if (unresolved && input.reconciliation !== null) invalid();
  const reconciliation = input.reconciliation === null ? null
    : parseKnowledgeCompletenessReconciliation(input.reconciliation, exchange, inventoryReview, authorInventory.actor);
  const acceptedInventory = unresolved ? null : acceptKnowledgeCompletenessInventory(exchange, shadow, authorInventory, inventoryReview, reconciliation);
  const rawAttempts = list(input.attempts, 2), attempts: KnowledgeCompletenessAttemptV1[] = [];
  if (acceptedInventory === null && rawAttempts.length > 0) invalid();
  for (const [index, raw] of rawAttempts.entries()) {
    const a = record(raw), accepted = acceptedInventory ?? invalid();
    keys(a, ['submission', 'completenessReview', 'semanticReview', 'sourcePassed', 'reviewOrder', 'reviewRound', 'reviewSubmissions']);
    const s = record(a.submission);
    keys(s, ['schemaVersion', 'projectId', 'runId', 'proposal', 'mapping', 'attempt', 'correctionOfReviewRoundDigest']);
    const attempt = index === 0 ? 1 as const : 2 as const, preceding = attempts.at(-1);
    if (s.schemaVersion !== 'buildlore.knowledge-completeness-prose-submission.v1' || s.projectId !== exchange.projectId || s.runId !== exchange.runId ||
      s.attempt !== attempt || s.correctionOfReviewRoundDigest !== (preceding?.reviewRound?.reviewRoundDigest ?? null)) invalid();
    if (preceding !== undefined && (preceding.completenessReview?.inventoryFindings.length ||
      preceding.reviewRound?.completenessPassed && preceding.reviewRound.sourcePassed)) invalid();
    const proposal = parseKnowledgeProposal(s.proposal, exchange.baseExchange.snapshot);
    if (proposal.baselineGenerationDigest !== (previous?.generationDigest ?? null) || digest(proposal.actor) !== digest(accepted.author)) invalid();
    const mapping = parseKnowledgeCompletenessProseMapping(s.mapping, exchange, accepted, proposal);
    if (preceding?.submission.proposal.proposalDigest === proposal.proposalDigest && preceding.submission.mapping.mappingDigest === mapping.mappingDigest) invalid();
    const semanticReview = parseKnowledgeSemanticReview(a.semanticReview, proposal, exchange.baseExchange.snapshot, previous);
    if (semanticReview.reviewer.sessionId === accepted.reviewer.sessionId || preceding !== undefined &&
      digest(semanticReview.reviewer) !== digest(preceding.semanticReview?.reviewer)) throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
    const completenessReview = parseKnowledgeCompletenessReview(a.completenessReview, exchange, accepted, mapping, attempt);
    const reviewOrder = list(a.reviewOrder, 2).map(v => choice(v, ['completeness', 'source'] as const));
    if (reviewOrder.length !== 2 || new Set(reviewOrder).size !== 2) invalid();
    const rawSubmissions = list(a.reviewSubmissions, 2);
    if (rawSubmissions.length !== 2) invalid();
    const reviewSubmissions = reviewOrder.map((kind, i) => parseCompletenessReviewSubmission(rawSubmissions[i], exchange,
      { kind, inventoryCorrectionDigest: step?.correction.correctionDigest ?? null, acceptedInventoryDigest: accepted.acceptedInventoryDigest,
        proposalDigest: proposal.proposalDigest, mappingDigest: mapping.mappingDigest }, kind === 'source' ? semanticReview : completenessReview));
    let sourcePassed = true;
    try { reconcileKnowledge(exchange.baseExchange.snapshot, proposal, semanticReview, previous); }
    catch (error) {
      if (!(error instanceof ProjectKnowledgeError) || !['KNOWLEDGE_INVALID', 'KNOWLEDGE_REVIEW_REQUIRED'].includes(error.code)) throw error;
      sourcePassed = false;
    }
    const round = { schemaVersion: 'buildlore.knowledge-completeness-review-round.v1' as const, ...completenessBinding(exchange), round: attempt,
      acceptedInventoryDigest: accepted.acceptedInventoryDigest, proposalDigest: proposal.proposalDigest, mappingDigest: mapping.mappingDigest,
      completenessReviewDigest: completenessReview.reviewDigest, semanticReviewDigest: semanticReview.reviewDigest,
      completenessPassed: completenessReview.items.every(i => i.verdict === 'covered') && completenessReview.questions.every(q => q.verdict === 'complete'), sourcePassed };
    attempts.push(Object.freeze({ submission: Object.freeze({ schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1', projectId: exchange.projectId,
      runId: exchange.runId, proposal, mapping, attempt, correctionOfReviewRoundDigest: preceding?.reviewRound?.reviewRoundDigest ?? null }),
    completenessReview, semanticReview, sourcePassed, reviewOrder: Object.freeze(reviewOrder), reviewSubmissions: Object.freeze(reviewSubmissions),
    reviewRound: Object.freeze({ ...round, reviewRoundDigest: digest(round) }) }));
  }
  const result = Object.freeze({ authorInventory, inventoryReview, inventoryReReview, reconciliation, acceptedInventory, attempts: Object.freeze(attempts) });
  if (digest(input) !== digest(result)) invalid();
  return result;
}

export function parseKnowledgeCompletenessCorrectionProof(value: unknown, snapshot: KnowledgeSnapshotV1,
  proposal: KnowledgeProposalV1, review: KnowledgeSemanticReviewV1, previous: KnowledgeGenerationV1 | null): KnowledgeCompletenessProofV2 {
  const input = completenessJson(value, 8_388_608);
  keys(input, ['schemaVersion', 'runId', 'baseInstructions', 'authoringQuestions', 'state', 'proposalDigest', 'semanticReviewDigest', 'proofDigest']);
  if (input.schemaVersion !== 'buildlore.knowledge-completeness-proof.v2' || input.proposalDigest !== proposal.proposalDigest || input.semanticReviewDigest !== review.reviewDigest) invalid();
  const baseInstructions = Object.freeze(list(input.baseInstructions, 128).map(v => text(v)));
  const base = { schemaVersion: 'buildlore.knowledge-exchange.v1' as const, projectId: snapshot.projectId, snapshot,
    baselineGenerationDigest: previous?.generationDigest ?? null, previousRecords: previous?.records ?? [], previousEvidence: previous?.evidence ?? [], instructions: baseInstructions,
    boundary: { generationActor: 'current-agent-session' as const, egress: 'none' as const, processSpawned: false as const } };
  const exchange = createKnowledgeCompletenessExchange({ ...base, exchangeDigest: digest(base) }, input.authoringQuestions, text(input.runId, 68), 'completeness-v2');
  const rawState = completenessJson(input.state, 12_582_912);
  keys(rawState, ['schemaVersion', ...Object.keys(completenessBinding(exchange)), 'revision', 'phase', 'shadowInventory', 'authorInventory',
    'inventoryReview', 'inventoryReReview', 'reconciliation', 'acceptedInventory', 'attempts', 'inventoryCorrections', 'finalized', 'terminal', 'stateDigest']);
  const shadowInventory = parseKnowledgeCompletenessInventory(rawState.shadowInventory, exchange, 'blind-shadow-reviewer');
  const inventoryCorrections: KnowledgeCompletenessInventoryCorrectionStepV1[] = [];
  let revision = 2;
  const countCycle = (cycle: KnowledgeCompletenessInventoryCycleV1): void => {
    revision += 1 + (cycle.reconciliation === null ? 0 : 1) + cycle.attempts.reduce((sum, a) => sum + 1 + a.reviewOrder.length, 0);
  };
  for (const raw of list(rawState.inventoryCorrections, MAX_INVENTORY_CORRECTIONS)) {
    const step = record(raw); keys(step, ['previous', 'correction']);
    const cycle = parseCycle(step.previous, exchange, shadowInventory, inventoryCorrections.at(-1), previous);
    if (completenessCorrectionCause(cycle) === null || completenessInventorySourceGap(cycle) || hasCompletenessRequiredSourceGap(exchange)) invalid();
    const correction = parseKnowledgeCompletenessInventoryCorrection(step.correction, exchange, shadowInventory, cycle);
    inventoryCorrections.push(Object.freeze({ previous: cycle, correction })); countCycle(cycle); revision += 1;
  }
  const cycle = parseCycle({ authorInventory: rawState.authorInventory, inventoryReview: rawState.inventoryReview, inventoryReReview: rawState.inventoryReReview,
    reconciliation: rawState.reconciliation, acceptedInventory: rawState.acceptedInventory, attempts: rawState.attempts }, exchange, shadowInventory, inventoryCorrections.at(-1), previous);
  countCycle(cycle);
  const last = cycle.attempts.at(-1) ?? invalid();
  if (completenessCorrectionCause(cycle) !== null || !last.reviewRound?.completenessPassed || !last.reviewRound.sourcePassed ||
    last.submission.proposal.proposalDigest !== proposal.proposalDigest || last.semanticReview?.reviewDigest !== review.reviewDigest) invalid();
  const stateBasis = { schemaVersion: 'buildlore.knowledge-completeness-state.v2' as const, ...completenessBinding(exchange),
    revision, phase: 'review-ready' as const, shadowInventory, ...cycle, inventoryCorrections: Object.freeze(inventoryCorrections), finalized: false, terminal: null };
  const state = Object.freeze({ ...stateBasis, stateDigest: digest(stateBasis) });
  if (digest(rawState) !== digest(state)) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-proof.v2' as const, runId: exchange.runId, baseInstructions,
    authoringQuestions: exchange.authoringQuestions, state, proposalDigest: proposal.proposalDigest, semanticReviewDigest: review.reviewDigest };
  const result = Object.freeze({ ...basis, proofDigest: digest(basis) });
  if (hash(input.proofDigest) !== result.proofDigest || digest(input) !== digest(result)) invalid(); return result;
}
