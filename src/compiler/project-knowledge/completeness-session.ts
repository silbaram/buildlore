import { randomBytes } from 'node:crypto';
import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import { choice, digest, hash, invalid, keys, list, record, ProjectKnowledgeError } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1, KnowledgePageClaimV1, KnowledgeProposalV1, KnowledgeSemanticReviewV1 } from '../../knowledge/project-knowledge/types.js';
import { createKnowledgeSessionService, requireKnowledgePreparedSessionCore, type KnowledgeSessionV1 } from './session.js';
import { knowledgeReviewTargets, parseKnowledgeProposal } from './proposal.js';
import { inspectKnowledgeAuthoringSources, KnowledgeAuthoringInspectionBudgetError,
  parseKnowledgeAuthoringInspectionRequest, type KnowledgeAuthoringInspection } from './authoring-inspection.js';
import { knowledgeCompletenessExchangeView, isCompletenessMaterialRequest, parseKnowledgeCompletenessMaterialRequest,
  inspectKnowledgeCompletenessMaterial, completenessMaterialScreeningValue,
  type KnowledgeCompletenessMaterialInspection } from './completeness-inspection.js';
import type { KnowledgeAuthoringQuestion } from './authoring-questions.js';
import { createKnowledgeCompletenessProof } from './completeness-proof.js';
import { MAX_INVENTORY_CORRECTIONS, completenessCorrectionCause, completenessInventorySourceGap,
  hasCompletenessRequiredSourceGap, parseKnowledgeCompletenessInventoryCorrection,
  parseKnowledgeCompletenessInventoryCorrectionReview, requiredInventoryCorrectionTargets,
  type KnowledgeCompletenessInventoryCorrectionReviewV1, type KnowledgeCompletenessInventoryCorrectionStepV1,
  type KnowledgeCompletenessInventoryCycleV1 } from './completeness-correction.js';
import { parseCompletenessReviewSubmission, type CompletenessReviewBinding,
  type CompletenessReviewSubmissionV1 } from './completeness-review-binding.js';
import { COMPLETENESS_LIMITS, acceptKnowledgeCompletenessInventory, completenessBinding, completenessJson,
  createKnowledgeCompletenessExchange, parseKnowledgeCompletenessInventory, parseKnowledgeCompletenessInventoryReview,
  parseKnowledgeCompletenessProseMapping, parseKnowledgeCompletenessReconciliation, parseKnowledgeCompletenessReview,
  type CompletenessBinding, type CompletenessProseLocator, type CompletenessRole, type KnowledgeCompletenessAcceptedInventoryV1,
  type KnowledgeCompletenessExchange, type KnowledgeCompletenessInventoryReconciliationV1,
  type KnowledgeCompletenessInventoryReviewV1, type KnowledgeCompletenessInventoryV1,
  type KnowledgeCompletenessProseMappingV1, type KnowledgeCompletenessReviewV1 } from './completeness.js';

export type KnowledgeCompletenessPhase = 'awaiting-shadow-inventory' | 'awaiting-author-inventory' |
  'awaiting-inventory-review' | 'awaiting-inventory-reconciliation' | 'awaiting-proposal' |
  'awaiting-initial-reviews' | 'awaiting-correction' | 'awaiting-correction-reviews' | 'review-ready' |
  'awaiting-inventory-correction' | 'finalized' | 'completeness-failed';
export type KnowledgeCompletenessAction = 'shadow' | 'inventory' | 'inventory-review' | 'reconcile' |
  'submit' | 'review' | 'source-review' | 'correct' | 'correct-inventory';
export interface KnowledgeCompletenessProseSubmissionV1 {
  readonly schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1';
  readonly projectId: string;
  readonly runId: string;
  readonly proposal: KnowledgeProposalV1;
  readonly mapping: KnowledgeCompletenessProseMappingV1;
  readonly attempt: 1 | 2;
  readonly correctionOfReviewRoundDigest: KnowledgeDigest | null;
}
export interface KnowledgeCompletenessReviewRoundV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-review-round.v1';
  readonly round: 1 | 2;
  readonly acceptedInventoryDigest: KnowledgeDigest;
  readonly proposalDigest: KnowledgeDigest;
  readonly mappingDigest: KnowledgeDigest;
  readonly completenessReviewDigest: KnowledgeDigest;
  readonly semanticReviewDigest: KnowledgeDigest;
  readonly completenessPassed: boolean;
  readonly sourcePassed: boolean;
  readonly reviewRoundDigest: KnowledgeDigest;
}
export interface KnowledgeCompletenessAttemptV1 {
  readonly submission: KnowledgeCompletenessProseSubmissionV1;
  readonly completenessReview: KnowledgeCompletenessReviewV1 | null;
  readonly semanticReview: KnowledgeSemanticReviewV1 | null;
  readonly sourcePassed: boolean | null;
  readonly reviewOrder: readonly ('completeness' | 'source')[];
  readonly reviewRound: KnowledgeCompletenessReviewRoundV1 | null;
  readonly reviewSubmissions?: readonly CompletenessReviewSubmissionV1[];
}
export interface KnowledgeCompletenessStateV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-state.v1';
  readonly revision: number;
  readonly phase: KnowledgeCompletenessPhase;
  readonly shadowInventory: KnowledgeCompletenessInventoryV1 | null;
  readonly authorInventory: KnowledgeCompletenessInventoryV1 | null;
  readonly inventoryReview: KnowledgeCompletenessInventoryReviewV1 | null;
  readonly reconciliation: KnowledgeCompletenessInventoryReconciliationV1 | null;
  readonly acceptedInventory: KnowledgeCompletenessAcceptedInventoryV1 | null;
  readonly attempts: readonly KnowledgeCompletenessAttemptV1[];
  readonly finalized: boolean;
  readonly terminal: Readonly<{ code: 'inventory-defect' | 'review-exhausted' | 'inventory-correction-exhausted'; round: 0 | 1 | 2 }> | null;
  readonly stateDigest: KnowledgeDigest;
}
export interface KnowledgeCompletenessStateV2 extends Omit<KnowledgeCompletenessStateV1, 'schemaVersion'> {
  readonly schemaVersion: 'buildlore.knowledge-completeness-state.v2';
  readonly inventoryCorrections: readonly KnowledgeCompletenessInventoryCorrectionStepV1[];
  readonly inventoryReReview: KnowledgeCompletenessInventoryCorrectionReviewV1 | null;
}
export type KnowledgeCompletenessState = KnowledgeCompletenessStateV1 | KnowledgeCompletenessStateV2;
export interface KnowledgeCompletenessStageViewV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-stage-view.v1' | 'buildlore.knowledge-completeness-stage-view.v2';
  readonly phase: KnowledgeCompletenessPhase;
  readonly revision: number;
  readonly role: CompletenessRole | null;
  readonly correctionCount: 0 | 1;
  readonly pendingReviewRoles: readonly CompletenessRole[];
  readonly nextActions: readonly string[];
  readonly stateDigest: KnowledgeDigest;
  readonly terminal: KnowledgeCompletenessStateV1['terminal'];
  readonly disclosureBoundary: 'ordered-disclosure-declared-identities';
  readonly material: Readonly<Record<string, unknown>>;
  readonly stageViewDigest: KnowledgeDigest;
  readonly inventoryCorrectionCount?: number;
  readonly inventoryCorrectionLimit?: number;
}
export interface KnowledgeCompletenessSessionV1 {
  readonly exchange: KnowledgeCompletenessExchange;
  status(role?: CompletenessRole): Promise<KnowledgeCompletenessStageViewV1>;
  inspect(input: unknown, expectExchange: KnowledgeDigest): Promise<KnowledgeAuthoringInspection | KnowledgeCompletenessMaterialInspection>;
  submitShadowInventory(input: unknown, expectStage: KnowledgeDigest): Promise<KnowledgeCompletenessStageViewV1>;
  submitAuthorInventory(input: unknown, expectStage: KnowledgeDigest): Promise<KnowledgeCompletenessStageViewV1>;
  submitInventoryReview(input: unknown, expectStage: KnowledgeDigest): Promise<KnowledgeCompletenessStageViewV1>;
  reconcileInventory(input: unknown, expectStage: KnowledgeDigest): Promise<KnowledgeCompletenessStageViewV1>;
  submitProse(input: unknown, expectStage: KnowledgeDigest): Promise<KnowledgeCompletenessStageViewV1>;
  submitCompletenessReview(input: unknown, expectStage: KnowledgeDigest): Promise<KnowledgeCompletenessStageViewV1>;
  submitSourceReview(input: unknown, expectStage: KnowledgeDigest): Promise<KnowledgeCompletenessStageViewV1>;
  correctProse(input: unknown, expectStage: KnowledgeDigest): Promise<KnowledgeCompletenessStageViewV1>;
  correctInventory(input: unknown, expectStage: KnowledgeDigest): Promise<KnowledgeCompletenessStageViewV1>;
  finalize(input: unknown, expectStage: KnowledgeDigest): Promise<KnowledgeGenerationV1>;
}
type StateBasis = Omit<KnowledgeCompletenessStateV1, 'stateDigest' | 'phase'> | Omit<KnowledgeCompletenessStateV2, 'stateDigest' | 'phase'>;
const captures = new WeakMap<KnowledgeCompletenessSessionV1, () => Promise<Readonly<{
  state: KnowledgeCompletenessState; generation: KnowledgeGenerationV1 | null;
}>>>();

function phase(basis: StateBasis): KnowledgeCompletenessPhase {
  if (basis.terminal !== null) return 'completeness-failed';
  if (basis.finalized) return 'finalized';
  if (basis.shadowInventory === null) return 'awaiting-shadow-inventory';
  if (basis.authorInventory === null) return 'awaiting-author-inventory';
  if (basis.inventoryReview === null) return 'awaiting-inventory-review';
  if (basis.schemaVersion === 'buildlore.knowledge-completeness-state.v2' &&
    completenessCorrectionCause(inventoryCycle(basis)) !== null) return 'awaiting-inventory-correction';
  if (basis.acceptedInventory === null) return 'awaiting-inventory-reconciliation';
  const attempt = basis.attempts.at(-1);
  if (attempt === undefined) return 'awaiting-proposal';
  if (attempt.reviewRound === null) return basis.attempts.length === 1 ? 'awaiting-initial-reviews' : 'awaiting-correction-reviews';
  if (attempt.reviewRound.completenessPassed && attempt.reviewRound.sourcePassed) return 'review-ready';
  if (basis.attempts.length === 1) return 'awaiting-correction';
  return invalid();
}
function freezeState(basis: StateBasis): KnowledgeCompletenessState {
  const value = { ...basis, phase: phase(basis) };
  const result = Object.freeze({ ...value, stateDigest: digest(value) });
  completenessJson(result, COMPLETENESS_LIMITS.run);
  return result;
}
function updated(state: KnowledgeCompletenessState, updates: Partial<Omit<KnowledgeCompletenessStateV2, 'schemaVersion' | 'stateDigest' | 'phase'>>): KnowledgeCompletenessState {
  const { stateDigest, phase: oldPhase, ...basis } = state;
  void stateDigest; void oldPhase;
  return freezeState({ ...basis, ...updates, revision: state.revision + 1 });
}
function inventoryCycle(state: StateBasis): KnowledgeCompletenessInventoryCycleV1 {
  return Object.freeze({ authorInventory: state.authorInventory ?? invalid(), inventoryReview: state.inventoryReview ?? invalid(),
    inventoryReReview: state.schemaVersion === 'buildlore.knowledge-completeness-state.v2' ? state.inventoryReReview : null,
    reconciliation: state.reconciliation, acceptedInventory: state.acceptedInventory, attempts: state.attempts });
}
function reviewRound(exchange: KnowledgeCompletenessExchange, accepted: KnowledgeCompletenessAcceptedInventoryV1,
  attempt: KnowledgeCompletenessAttemptV1): KnowledgeCompletenessReviewRoundV1 | null {
  if (attempt.completenessReview === null || attempt.semanticReview === null || attempt.sourcePassed === null) return null;
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-review-round.v1' as const, ...completenessBinding(exchange),
    round: attempt.submission.attempt, acceptedInventoryDigest: accepted.acceptedInventoryDigest,
    proposalDigest: attempt.submission.proposal.proposalDigest, mappingDigest: attempt.submission.mapping.mappingDigest,
    completenessReviewDigest: attempt.completenessReview.reviewDigest, semanticReviewDigest: attempt.semanticReview.reviewDigest,
    completenessPassed: attempt.completenessReview.items.every(item => item.verdict === 'covered') &&
      attempt.completenessReview.questions.every(q => q.verdict === 'complete'), sourcePassed: attempt.sourcePassed };
  return Object.freeze({ ...basis, reviewRoundDigest: digest(basis) });
}

const AUTHORING_GUIDANCE = Object.freeze([
  "Freeze the accepted inventory before canonical prose. Map every required item to exact page, section and claim locators. Each question's mapped prose must state its answer and necessary qualifiers together; a citation, inventory label or answer to a different question does not supply an omitted qualifier.",
  "Choose canonical claim presentation from the referenced facts: current for accepted current facts, history for historical facts, and uncertainty for uncertain facts. A supported current statement about an unmeasured result or a documented knowledge limit can use current presentation, but must explicitly state what is unknown. Never invent stale or disputed facts to force uncertainty presentation.",
  "A missing declared required source is a blocking source gap. A source-supported statement that the selected material leaves a question unresolved is an evidence-backed known unknown. Describe the visible supported behavior even when another part is unavailable; qualify only the unavailable part. Do not hide a supported answer behind unknown or not-applicable, or invent history beyond the frozen questions.",
  "For design and change questions, connect the documented problem, choice, reasons, alternatives and consequences where supported. State which revision introduced, corrected or retained each relevant behavior, distinguishing completed changes from pending work. If a reason, alternative, revision or measurement is not recorded, identify that specific limit instead of supplying a plausible explanation.",
  "For behavioral questions, carry the applicable conditions, defaults, fallback branches, empty or invalid inputs, exceptions, recovery and partial-result behavior into the answer. Explain compatibility obligations and preserved behavior where documented; a high-level summary must not replace these operative details.",
  "Separate a component's responsibility and output from the domain operation it represents, and recorded implementation from actually executed verification. Tie test results to their recorded revision and scope; generated output, a success label or a test definition alone does not prove execution or domain success. Next-work prose should identify what remains, what completed behavior must be preserved and what evidence must be rechecked.",
  "Before committing either source-first inventory, challenge absolute or unqualified guarantees against the selected sources' detailed limits, failure branches and recovery paths. An overview sentence is not sufficient evidence that a guarantee is unconditional. Put applicable qualifiers and their supporting evidence in the inventory item itself, not only in later prose. Before accepting the inventory union, independently re-open that evidence and check whether a documented condition defeats any proposed guarantee. If the frozen inventory omits a necessary condition, preserve an inventory-defect finding even when corrected prose already explains it; do not repair the frozen list or silently restart. " +
  "Keep each inventory item focused on a distinct substantive proposition together with its necessary qualifiers and evidence. Avoid near-duplicate items within a question and category. Review all seven categories, but use justified not-applicable for irrelevant categories; category presence does not require inventing an item. Every linked requirement must be declared for that question and have at least one matching evidence ID from its current selected source. Prior evidence may supplement an item but cannot alone satisfy a current source requirement. Use inspect coverage to find eligible evidence; choose links based on the actual statement. For coverage inspection, use {\"schemaVersion\":\"buildlore.knowledge-authoring-inspection-request.v1\",\"projectId\":\"<exchange.projectId>\",\"questionId\":\"<question.id>\",\"operation\":\"coverage\",\"limit\":50,\"maxBytes\":65536} with the completeness exchange digest. Inventory validation diagnostics use zero-based question, category, item and requirement indices. Repair only a caller-owned draft using its exact draftDigest and an explicit replacement item, then resubmit against the unchanged stage digest. Accepted inventories remain frozen.",
  "During omission review, compare each required proposition and its qualifiers with the actual mapped claim text, then check the whole question against the selected sources. If a necessary qualifier is absent, judge the item partial or missing even when its identifiers and citations are valid. A review packet, when present, is a read-only join of the frozen items, current prose and evidence, not a coverage verdict; it cannot replace checking for inventory defects."
]);

// Internal, derived convenience view only. Never persisted or used to decide a
// verdict. Stop assembling it at the cap and retain the ordinary role material.
const REVIEW_PACKET_BYTES = 262_144;
function reviewPacket(exchange: KnowledgeCompletenessExchange, accepted: KnowledgeCompletenessAcceptedInventoryV1,
  proposal: KnowledgeProposalV1, mapping: KnowledgeCompletenessProseMappingV1) {
  const mappings = new Map(mapping.items.map(item => [item.itemId, item]));
  const records = new Map([...exchange.baseExchange.previousRecords, ...proposal.facts].map(fact => [fact.id, fact]));
  const evidence = new Map([...exchange.baseExchange.previousEvidence, ...exchange.baseExchange.snapshot.evidence]
    .map(item => [item.evidenceId, item]));
  const factIds = new Set<KnowledgeDigest>(), evidenceIds = new Set<KnowledgeDigest>();
  let bytes = 0;
  const admit = (value: unknown): boolean => {
    bytes += Buffer.byteLength(JSON.stringify(value));
    return bytes <= REVIEW_PACKET_BYTES;
  };
  const prose = new Map<string, Readonly<{ locator: CompletenessProseLocator; pageTitle: string;
    sectionTitle: string; claim: KnowledgePageClaimV1 }>>();
  const questions = [];
  for (const question of exchange.authoringQuestions) {
    if (!admit(question)) return null;
    const items = [];
    for (const item of accepted.requiredItems.filter(item => item.questionId === question.id)) {
      const mapped = mappings.get(item.itemId) ?? invalid();
      for (const locator of mapped.locators) {
        if (prose.has(locator.claimId)) continue;
        const page = proposal.pages.find(page => page.role === locator.pageRole) ?? invalid();
        const section = page.sections[locator.sectionIndex] ?? invalid();
        const claim = section.claims[locator.claimIndex] ?? invalid();
        const entry = Object.freeze({ locator, pageTitle: page.title, sectionTitle: section.title, claim });
        if (!admit(entry)) return null;
        for (const id of claim.factIds) factIds.add(id);
        prose.set(locator.claimId, entry);
      }
      for (const id of item.evidenceIds) evidenceIds.add(id);
      const joined = Object.freeze({ requiredItem: item, status: mapped.status, locators: mapped.locators });
      if (!admit(joined)) return null;
      items.push(joined);
    }
    questions.push(Object.freeze({ question, items: Object.freeze(items) }));
  }
  const facts = [];
  for (const id of factIds) {
    const fact = records.get(id) ?? invalid();
    if (!admit(fact)) return null;
    for (const id of fact.evidenceIds) evidenceIds.add(id);
    facts.push(fact);
  }
  const excerpts = [];
  for (const id of evidenceIds) {
    const item = evidence.get(id) ?? invalid();
    if (!admit(item)) return null;
    excerpts.push(item);
  }
  const packet = Object.freeze({ schemaVersion: 'buildlore.knowledge-completeness-review-packet.v1' as const,
    ...completenessBinding(exchange), acceptedInventoryDigest: accepted.acceptedInventoryDigest,
    proposalDigest: proposal.proposalDigest, mappingDigest: mapping.mappingDigest,
    questions: Object.freeze(questions), prose: Object.freeze([...prose.values()]),
    facts: Object.freeze(facts), evidence: Object.freeze(excerpts) });
  return Buffer.byteLength(JSON.stringify(packet)) <= REVIEW_PACKET_BYTES ? packet : null;
}

export type KnowledgeCompletenessPrepareInput = Omit<Parameters<ReturnType<typeof createKnowledgeSessionService>['prepare']>[0],
  'authoringQuestions' | 'rendererVersion'> & Readonly<{ authoringQuestions: readonly KnowledgeAuthoringQuestion[]; runId?: string;
    proofPolicy?: 'persisted-v1' | 'legacy-v1'; inventoryPolicy?: 'completeness-v1' | 'completeness-v2' }>;
export function createKnowledgeCompletenessSessionService(options: Readonly<{ knowledgeRoot: string }>): Readonly<{
  prepare(input: KnowledgeCompletenessPrepareInput): Promise<KnowledgeCompletenessSessionV1>;
}> {
  const service = createKnowledgeSessionService(options);
  return Object.freeze({ async prepare(input: KnowledgeCompletenessPrepareInput): Promise<KnowledgeCompletenessSessionV1> {
    const { authoringQuestions, runId, proofPolicy, inventoryPolicy, ...baseInput } = input;
    return await wrapKnowledgeCompletenessSession(await service.prepare({ ...baseInput, rendererVersion: 'knowledge-markdown-v2' }),
      authoringQuestions, runId ?? `run-${randomBytes(32).toString('hex')}`, proofPolicy, inventoryPolicy);
  } });
}

/** @internal A caller-created base session cannot supply the required capability. */
export async function wrapKnowledgeCompletenessSession(base: KnowledgeSessionV1, questions: unknown,
  runId: string, proofPolicy: 'persisted-v1' | 'legacy-v1' = 'persisted-v1',
  inventoryPolicy: 'completeness-v1' | 'completeness-v2' = 'completeness-v1'): Promise<KnowledgeCompletenessSessionV1> {
  choice(proofPolicy, ['persisted-v1', 'legacy-v1']);
  if (inventoryPolicy === 'completeness-v2' && proofPolicy !== 'persisted-v1') invalid();
  const core = requireKnowledgePreparedSessionCore(base);
  if (base.exchange.authoringQuestions !== undefined) invalid();
  const exchange = createKnowledgeCompletenessExchange(base.exchange, questions, runId, inventoryPolicy);
  // Only exact, parsed generated identity fields are projected as their hash
  // components for screening. Original bytes remain in the bound artifact;
  // prose, arbitrary identifiers and all other metadata receive the full scan.
  function screeningValue(value: unknown, key = ''): unknown {
    if (key === 'runId' && value === runId) return { digest: `sha256:${runId.slice(4)}` };
    if (key === 'itemId' && typeof value === 'string' && /^item-[0-9a-f]{64}$/u.test(value)) {
      return { digest: `sha256:${value.slice(5)}` };
    }
    if (Array.isArray(value)) return value.map((item: unknown) => screeningValue(item, key));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, screeningValue(item, name)]));
    }
    return value;
  }
  const screen = (value: unknown): Promise<void> => core.screen(screeningValue(value));
  await screen(exchange);
  const stateVersion = inventoryPolicy === 'completeness-v2'
    ? { schemaVersion: 'buildlore.knowledge-completeness-state.v2' as const, inventoryCorrections: Object.freeze([]), inventoryReReview: null }
    : { schemaVersion: 'buildlore.knowledge-completeness-state.v1' as const };
  let state = freezeState({ ...stateVersion, ...completenessBinding(exchange), revision: 0,
    shadowInventory: null, authorInventory: null, inventoryReview: null, reconciliation: null, acceptedInventory: null,
    attempts: Object.freeze([]), finalized: false, terminal: null });
  let generation: KnowledgeGenerationV1 | null = null;
  let busy = false;
  function view(role: CompletenessRole | null, currentState = state): KnowledgeCompletenessStageViewV1 {
    const state = currentState;
    const current = state.attempts.at(-1);
    const pendingReviewRoles: CompletenessRole[] = [];
    if (current && state.terminal === null && !state.finalized && current.reviewRound === null) {
      if (current.completenessReview === null) pendingReviewRoles.push('completeness-reviewer');
      if (current.semanticReview === null) pendingReviewRoles.push('source-reviewer');
    }
    const material: Record<string, unknown> = {};
    if (role !== null) {
      material.exchange = knowledgeCompletenessExchangeView(exchange);
      if (role !== 'source-reviewer') material.authoringGuidance = exchange.policyVersion === 'completeness-v1' ? AUTHORING_GUIDANCE :
        [...AUTHORING_GUIDANCE.map(text => text.replace('do not repair the frozen list or silently restart.',
          'use the explicit inventory correction stage after both reviews; do not silently restart.')), 'For completeness-v2, accepted inventories stay frozen within a cycle. A recorded inventory defect opens correct-inventory, at most twice per run. Preserve all earlier reviews and the original blind shadow. Correct or remove unsupported prose explicitly, retain supported required content, and independently review the entire corrected union plus every resolution before writing new prose.'];
      if (state.schemaVersion === 'buildlore.knowledge-completeness-state.v2' && role !== 'source-reviewer') {
        material.inventoryCorrection = state.inventoryCorrections.at(-1)?.correction ?? null;
        material.inventoryReReview = state.inventoryReReview;
        if (state.phase === 'awaiting-inventory-correction') {
          const cycle = inventoryCycle(state);
          material.inventoryCorrectionCause = completenessCorrectionCause(cycle);
          material.requiredCorrectionTargets = requiredInventoryCorrectionTargets(cycle, cycle.authorInventory);
        }
      }
      if (role === 'completeness-reviewer') {
        material.shadowInventory = state.shadowInventory;
        if (state.authorInventory !== null) material.authorInventory = state.authorInventory;
        material.inventoryReview = state.inventoryReview;
      }
      if (role === 'author') {
        material.authorInventory = state.authorInventory;
        if (state.inventoryReview !== null) {
          material.shadowInventory = state.shadowInventory; material.inventoryReview = state.inventoryReview;
        }
      }
      if (role !== 'source-reviewer') material.acceptedInventory = state.acceptedInventory;
      if (current !== undefined) {
        material.proposal = current.submission.proposal;
        if (role !== 'source-reviewer') material.mapping = current.submission.mapping;
        if (state.schemaVersion === 'buildlore.knowledge-completeness-state.v2' && role !== 'author') {
          material.reviewSubmissionBinding = reviewBinding(role === 'source-reviewer' ? 'source' : 'completeness', state, current);
        }
        if (role === 'source-reviewer') material.reviewTargets = knowledgeReviewTargets(current.submission.proposal);
        if (role === 'completeness-reviewer') material.completenessReview = current.completenessReview;
        if (role === 'source-reviewer') material.semanticReview = current.semanticReview;
        if (current.reviewRound !== null) {
          material.completenessReview = current.completenessReview;
          material.semanticReview = current.semanticReview; material.reviewRound = current.reviewRound;
        }
      }
    }
    const nextActions: string[] = [];
    switch (state.phase) {
      case 'awaiting-shadow-inventory': nextActions.push('shadow'); break;
      case 'awaiting-author-inventory': nextActions.push('inventory'); break;
      case 'awaiting-inventory-review': nextActions.push('inventory-review'); break;
      case 'awaiting-inventory-reconciliation': nextActions.push('reconcile'); break;
      case 'awaiting-proposal': nextActions.push('submit'); break;
      case 'awaiting-initial-reviews': case 'awaiting-correction-reviews':
        if (pendingReviewRoles.includes('completeness-reviewer')) nextActions.push('review');
        if (pendingReviewRoles.includes('source-reviewer')) nextActions.push('source-review');
        break;
      case 'awaiting-correction': nextActions.push('correct'); break;
      case 'awaiting-inventory-correction': nextActions.push('correct-inventory'); break;
      case 'review-ready': nextActions.push('finalize'); break;
      case 'finalized': case 'completeness-failed': break;
    }
    const version = state.schemaVersion === 'buildlore.knowledge-completeness-state.v2'
      ? { schemaVersion: 'buildlore.knowledge-completeness-stage-view.v2' as const,
        inventoryCorrectionCount: state.inventoryCorrections.length, inventoryCorrectionLimit: MAX_INVENTORY_CORRECTIONS }
      : { schemaVersion: 'buildlore.knowledge-completeness-stage-view.v1' as const };
    const basis = { ...version, ...completenessBinding(exchange),
      phase: state.phase, revision: state.revision, role, correctionCount: state.attempts.length > 1 ? 1 as const : 0 as const,
      pendingReviewRoles: Object.freeze(pendingReviewRoles), nextActions: Object.freeze(nextActions), stateDigest: state.stateDigest,
      terminal: state.terminal, disclosureBoundary: 'ordered-disclosure-declared-identities' as const, material: Object.freeze(material) };
    const result = Object.freeze({ ...basis, stageViewDigest: digest(basis) });
    completenessJson(result, COMPLETENESS_LIMITS.view);
    if (role !== null && role !== 'source-reviewer' && current !== undefined && state.acceptedInventory !== null) {
      const packet = reviewPacket(exchange, state.acceptedInventory, current.submission.proposal, current.submission.mapping);
      if (packet !== null) {
        const projected = { ...basis, material: Object.freeze({ ...material, reviewPacket: packet }) };
        const candidate = Object.freeze({ ...projected, stageViewDigest: digest(projected) });
        // An optional projection must not make an otherwise valid view fail.
        if (Buffer.byteLength(serializeCanonicalJson(candidate)) <= COMPLETENESS_LIMITS.view) return candidate;
      }
    }
    return result;
  }
  function reviewBinding(kind: 'source' | 'completeness', state: KnowledgeCompletenessState,
    attempt: KnowledgeCompletenessAttemptV1): CompletenessReviewBinding {
    return { kind, inventoryCorrectionDigest: state.schemaVersion === 'buildlore.knowledge-completeness-state.v2'
      ? state.inventoryCorrections.at(-1)?.correction.correctionDigest ?? null : null,
    acceptedInventoryDigest: state.acceptedInventory?.acceptedInventoryDigest ?? invalid(),
    proposalDigest: attempt.submission.proposal.proposalDigest, mappingDigest: attempt.submission.mapping.mappingDigest };
  }
  function correctionTerminal(cycle: KnowledgeCompletenessInventoryCycleV1, round: 0 | 1 | 2): KnowledgeCompletenessStateV1['terminal'] {
    if (state.schemaVersion !== 'buildlore.knowledge-completeness-state.v2' ||
      hasCompletenessRequiredSourceGap(exchange) || completenessInventorySourceGap(cycle)) return { code: 'inventory-defect', round };
    return state.inventoryCorrections.length >= MAX_INVENTORY_CORRECTIONS ? { code: 'inventory-correction-exhausted', round } : null;
  }
  async function status(role?: CompletenessRole): Promise<KnowledgeCompletenessStageViewV1> {
    const selected = role === undefined ? null : choice(role, ['author', 'completeness-reviewer', 'source-reviewer']);
    const result = view(selected); await screen(result); return result;
  }
  async function commit(next: KnowledgeCompletenessState, action?: () => Promise<void>): Promise<void> {
    // A transition must not commit before discovering that its resulting role
    // projection exceeds the closed view budget.
    for (const role of [null, 'author', 'completeness-reviewer', 'source-reviewer'] as const) view(role, next);
    await screen(next);
    if (action !== undefined) await action();
    state = next;
  }
  function requirePhase(...phases: readonly KnowledgeCompletenessPhase[]): void {
    if (!phases.includes(state.phase)) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
  }
  async function mutate(action: KnowledgeCompletenessAction, input: unknown, expectStage: KnowledgeDigest): Promise<KnowledgeCompletenessStageViewV1> {
    const role: CompletenessRole = action === 'shadow' || action === 'inventory-review' || action === 'review'
      ? 'completeness-reviewer' : action === 'source-review' ? 'source-reviewer' : 'author';
    if (busy || hash(expectStage) !== view(role).stageViewDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
    busy = true;
    try {
      switch (action) {
        case 'shadow': {
          requirePhase('awaiting-shadow-inventory');
          const shadowInventory = parseKnowledgeCompletenessInventory(input, exchange, 'blind-shadow-reviewer');
          await commit(updated(state, { shadowInventory })); break;
        }
        case 'inventory': {
          requirePhase('awaiting-author-inventory');
          const authorInventory = parseKnowledgeCompletenessInventory(input, exchange, 'author');
          if (authorInventory.actor.sessionId === state.shadowInventory?.actor.sessionId) throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
          await commit(updated(state, { authorInventory })); break;
        }
        case 'inventory-review': {
          requirePhase('awaiting-inventory-review');
          const shadow = state.shadowInventory ?? invalid(), author = state.authorInventory ?? invalid();
          const step = state.schemaVersion === 'buildlore.knowledge-completeness-state.v2' ? state.inventoryCorrections.at(-1) : undefined;
          const inventoryReReview = step === undefined ? null : parseKnowledgeCompletenessInventoryCorrectionReview(input, exchange, shadow, step);
          const inventoryReview = inventoryReReview?.review ?? parseKnowledgeCompletenessInventoryReview(input, exchange, shadow, author);
          const cycle: KnowledgeCompletenessInventoryCycleV1 = { authorInventory: author, inventoryReview, inventoryReReview,
            reconciliation: null, acceptedInventory: null, attempts: [] };
          let acceptedInventory: KnowledgeCompletenessAcceptedInventoryV1 | null = null;
          let terminal = completenessCorrectionCause(cycle) !== null ? correctionTerminal(cycle, 0) : null;
          if (inventoryReview.decision === 'accepted' && completenessCorrectionCause(cycle) === null) {
            try { acceptedInventory = acceptKnowledgeCompletenessInventory(exchange, shadow, author, inventoryReview, null); }
            catch (error) {
              if (!(error instanceof ProjectKnowledgeError) || error.code !== 'KNOWLEDGE_INVALID') throw error;
              terminal = { code: 'inventory-defect', round: 0 };
            }
          }
          await commit(updated(state, { inventoryReview, acceptedInventory, terminal,
            ...(state.schemaVersion === 'buildlore.knowledge-completeness-state.v2' ? { inventoryReReview } : {}) })); break;
        }
        case 'correct-inventory': {
          requirePhase('awaiting-inventory-correction');
          if (state.schemaVersion !== 'buildlore.knowledge-completeness-state.v2' || state.inventoryCorrections.length >= MAX_INVENTORY_CORRECTIONS) invalid();
          const previous = inventoryCycle(state);
          const correction = parseKnowledgeCompletenessInventoryCorrection(input, exchange, state.shadowInventory ?? invalid(), previous);
          await commit(updated(state, { inventoryCorrections: Object.freeze([...state.inventoryCorrections, Object.freeze({ previous, correction })]),
            authorInventory: correction.authorInventory, inventoryReview: null, inventoryReReview: null,
            reconciliation: null, acceptedInventory: null, attempts: Object.freeze([]), terminal: null })); break;
        }
        case 'reconcile': {
          requirePhase('awaiting-inventory-reconciliation');
          const shadow = state.shadowInventory ?? invalid(), author = state.authorInventory ?? invalid(), review = state.inventoryReview ?? invalid();
          const reconciliation = parseKnowledgeCompletenessReconciliation(input, exchange, review, author.actor);
          let acceptedInventory: KnowledgeCompletenessAcceptedInventoryV1 | null = null, terminal: KnowledgeCompletenessStateV1['terminal'] = null;
          try { acceptedInventory = acceptKnowledgeCompletenessInventory(exchange, shadow, author, review, reconciliation); }
          catch (error) {
            if (!(error instanceof ProjectKnowledgeError) || error.code !== 'KNOWLEDGE_INVALID') throw error;
            terminal = { code: 'inventory-defect', round: 0 };
          }
          await commit(updated(state, { reconciliation, acceptedInventory, terminal })); break;
        }
        case 'submit': case 'correct': {
          requirePhase(action === 'submit' ? 'awaiting-proposal' : 'awaiting-correction');
          const accepted = state.acceptedInventory ?? invalid(), r = completenessJson(input, COMPLETENESS_LIMITS.prose);
          keys(r, ['schemaVersion', 'projectId', 'runId', 'proposal', 'mapping', 'attempt', 'correctionOfReviewRoundDigest']);
          const attempt = action === 'submit' ? 1 as const : 2 as const;
          const previousRound = action === 'correct' ? state.attempts[0]?.reviewRound ?? invalid() : null;
          if (r.schemaVersion !== 'buildlore.knowledge-completeness-prose-submission.v1' || r.projectId !== exchange.projectId ||
            r.runId !== runId || r.attempt !== attempt || r.correctionOfReviewRoundDigest !== (previousRound?.reviewRoundDigest ?? null)) invalid();
          const proposal = parseKnowledgeProposal(r.proposal, base.exchange.snapshot);
          const mapping = parseKnowledgeCompletenessProseMapping(r.mapping, exchange, accepted, proposal);
          const original = state.attempts[0]?.submission;
          if (attempt === 2 && original?.proposal.proposalDigest === proposal.proposalDigest && original.mapping.mappingDigest === mapping.mappingDigest) invalid();
          const submission: KnowledgeCompletenessProseSubmissionV1 = Object.freeze({ schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1',
            projectId: exchange.projectId, runId, proposal, mapping, attempt, correctionOfReviewRoundDigest: previousRound?.reviewRoundDigest ?? null });
          const nextAttempt: KnowledgeCompletenessAttemptV1 = Object.freeze({ submission, completenessReview: null, semanticReview: null,
            sourcePassed: null, reviewOrder: Object.freeze([]), reviewRound: null,
            ...(state.schemaVersion === 'buildlore.knowledge-completeness-state.v2' ? { reviewSubmissions: Object.freeze([]) } : {}) });
          // The legacy coverage check needs declared source requirements. Profile
          // questions without them remain bound by the inventory, mapping and reviews.
          const coverage = exchange.authoringQuestions.filter(q => q.requirements.length > 0).map(q => ({ id: q.id, requirements: q.requirements,
            claimIds: [...new Set(accepted.requiredItems.flatMap((item, i) => item.questionId === q.id
              ? mapping.items[i]?.locators.map(l => l.claimId) ?? [] : []))].sort() }));
          await commit(updated(state, { attempts: Object.freeze([...state.attempts, nextAttempt]) }), async () => {
            await base.submit(proposal, base.exchange.exchangeDigest, coverage.length > 0 ? coverage : undefined);
          }); break;
        }
        case 'review': case 'source-review': {
          requirePhase('awaiting-initial-reviews', 'awaiting-correction-reviews');
          const accepted = state.acceptedInventory ?? invalid(), current = state.attempts.at(-1) ?? invalid();
          const v2 = state.schemaVersion === 'buildlore.knowledge-completeness-state.v2';
          const reviewInput = v2 ? completenessJson(input, 2_097_152).review : input;
          let next: KnowledgeCompletenessAttemptV1;
          if (action === 'review') {
            if (current.completenessReview !== null) invalid();
            const completenessReview = parseKnowledgeCompletenessReview(reviewInput, exchange, accepted, current.submission.mapping, current.submission.attempt);
            next = { ...current, completenessReview, reviewOrder: Object.freeze([...current.reviewOrder, 'completeness']) };
          } else {
            if (current.semanticReview !== null) invalid();
            completenessJson(input, COMPLETENESS_LIMITS.prose);
            const assessment = await core.assessReview(reviewInput, current.submission.proposal);
            if (assessment.review.reviewer.sessionId === accepted.reviewer.sessionId ||
              (current.submission.attempt === 2 && digest(assessment.review.reviewer) !== digest(state.attempts[0]?.semanticReview?.reviewer))) {
              throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
            }
            next = { ...current, semanticReview: assessment.review, sourcePassed: assessment.passed,
              reviewOrder: Object.freeze([...current.reviewOrder, 'source']) };
          }
          if (v2) {
            const submitted = parseCompletenessReviewSubmission(input, exchange,
              reviewBinding(action === 'review' ? 'completeness' : 'source', state, current),
              (action === 'review' ? next.completenessReview : next.semanticReview) ?? invalid());
            next = { ...next, reviewSubmissions: Object.freeze([...(current.reviewSubmissions ?? []), submitted]) };
          }
          next = Object.freeze({ ...next, reviewRound: reviewRound(exchange, accepted, next) });
          const inventoryDefect = Boolean(next.completenessReview?.inventoryFindings.length) && (!v2 || next.reviewRound !== null);
          const terminal: KnowledgeCompletenessStateV1['terminal'] = inventoryDefect
            ? correctionTerminal({ ...inventoryCycle(state), attempts: [...state.attempts.slice(0, -1), next] }, current.submission.attempt)
            : next.reviewRound !== null && current.submission.attempt === 2 &&
              (!next.reviewRound.completenessPassed || !next.reviewRound.sourcePassed)
              ? { code: 'review-exhausted', round: 2 } : null;
          await commit(updated(state, { attempts: Object.freeze([...state.attempts.slice(0, -1), next]), terminal })); break;
        }
      }
      return await status(role);
    } finally { busy = false; }
  }
  const session: KnowledgeCompletenessSessionV1 = Object.freeze({ exchange, status,
    async inspect(input: unknown, expectExchange: KnowledgeDigest): Promise<KnowledgeAuthoringInspection | KnowledgeCompletenessMaterialInspection> {
      if (expectExchange !== exchange.exchangeDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
      if (isCompletenessMaterialRequest(input)) {
        const request = parseKnowledgeCompletenessMaterialRequest(input, exchange.projectId);
        const result = inspectKnowledgeCompletenessMaterial(exchange, request);
        await screen(completenessMaterialScreeningValue(request));
        await screen(result);
        return result;
      }
      const request = parseKnowledgeAuthoringInspectionRequest(input, exchange.projectId);
      const cursor = request.cursor?.split('-');
      const screenRequest = (): Promise<void> => screen({ ...request, cursor: cursor === undefined ? null : {
        offset: Number(cursor[1]), digest: `sha256:${cursor[2] ?? invalid()}`,
      } });
      try {
        // As in v3, validate the bound cursor before screening decoded metadata.
        const result = inspectKnowledgeAuthoringSources(base.exchange.snapshot, exchange.exchangeDigest, exchange.authoringQuestions, request);
        await screenRequest(); return result;
      } catch (error) {
        if (error instanceof KnowledgeAuthoringInspectionBudgetError) await screenRequest();
        throw error;
      }
    },
    submitShadowInventory: (input: unknown, expect: KnowledgeDigest) => mutate('shadow', input, expect),
    submitAuthorInventory: (input: unknown, expect: KnowledgeDigest) => mutate('inventory', input, expect),
    submitInventoryReview: (input: unknown, expect: KnowledgeDigest) => mutate('inventory-review', input, expect),
    reconcileInventory: (input: unknown, expect: KnowledgeDigest) => mutate('reconcile', input, expect),
    submitProse: (input: unknown, expect: KnowledgeDigest) => mutate('submit', input, expect),
    submitCompletenessReview: (input: unknown, expect: KnowledgeDigest) => mutate('review', input, expect),
    submitSourceReview: (input: unknown, expect: KnowledgeDigest) => mutate('source-review', input, expect),
    correctProse: (input: unknown, expect: KnowledgeDigest) => mutate('correct', input, expect),
    correctInventory: (input: unknown, expect: KnowledgeDigest) => mutate('correct-inventory', input, expect),
    async finalize(input: unknown, expectStage: KnowledgeDigest): Promise<KnowledgeGenerationV1> {
      if (busy || hash(expectStage) !== view('author').stageViewDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
      busy = true;
      try {
        requirePhase('review-ready');
        const current = state.attempts.at(-1) ?? invalid(), round = current.reviewRound ?? invalid();
        const r = completenessJson(input, COMPLETENESS_LIMITS.recovery);
        keys(r, ['schemaVersion', 'projectId', 'runId', 'proposalDigest', 'mappingDigest', 'completenessReviewDigest', 'semanticReviewDigest', 'reviewViewDigest']);
        if (r.schemaVersion !== 'buildlore.knowledge-completeness-finalize-input.v1' || r.projectId !== exchange.projectId || r.runId !== runId ||
          r.proposalDigest !== round.proposalDigest || r.mappingDigest !== round.mappingDigest ||
          r.completenessReviewDigest !== round.completenessReviewDigest || r.semanticReviewDigest !== round.semanticReviewDigest ||
          r.reviewViewDigest !== expectStage) invalid();
        await screen(r);
        await commit(updated(state, { finalized: true }), async () => {
          generation = await base.finalize(current.semanticReview, current.submission.proposal.proposalDigest,
            proofPolicy === 'legacy-v1' ? undefined : createKnowledgeCompletenessProof(exchange, state));
        });
        return generation ?? invalid();
      } finally { busy = false; }
    },
  });
  captures.set(session, async () => { await screen(state); return Object.freeze({ state, generation }); });
  return session;
}

/** @internal The confined persistence owner can archive full state; role views remain separate. */
export async function captureKnowledgeCompletenessSession(session: KnowledgeCompletenessSessionV1): Promise<Readonly<{
  state: KnowledgeCompletenessState; generation: KnowledgeGenerationV1 | null;
}>> { return await (captures.get(session) ?? invalid())(); }

/** @internal Reconstruct every stage using an actually prepared session, never just saved hashes. */
export async function replayKnowledgeCompletenessSession(session: KnowledgeCompletenessSessionV1, value: unknown): Promise<void> {
  const input = completenessJson(value, COMPLETENESS_LIMITS.run);
  const v2 = session.exchange.policyVersion === 'completeness-v2';
  keys(input, ['schemaVersion', 'projectId', 'runId', 'exchangeDigest', 'baseExchangeDigest', 'snapshotDigest', 'baselineGenerationDigest',
    'questionsDigest', 'revision', 'phase', 'shadowInventory', 'authorInventory', 'inventoryReview', 'reconciliation', 'acceptedInventory',
    'attempts', 'finalized', 'terminal', 'stateDigest', ...(v2 ? ['inventoryCorrections', 'inventoryReReview'] : [])]);
  if (input.schemaVersion !== (v2 ? 'buildlore.knowledge-completeness-state.v2' : 'buildlore.knowledge-completeness-state.v1') ||
    input.exchangeDigest !== session.exchange.exchangeDigest || input.runId !== session.exchange.runId) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
  const stage = async (role: CompletenessRole): Promise<KnowledgeDigest> => (await session.status(role)).stageViewDigest;
  if (input.shadowInventory !== null) await session.submitShadowInventory(input.shadowInventory, await stage('completeness-reviewer'));
  async function replayCycle(cycle: Readonly<Record<string, unknown>>, first: boolean): Promise<void> {
    if (first && cycle.authorInventory !== null) await session.submitAuthorInventory(cycle.authorInventory, await stage('author'));
    if (cycle.inventoryReview !== null) await session.submitInventoryReview(v2 && cycle.inventoryReReview !== null
      ? cycle.inventoryReReview : cycle.inventoryReview, await stage('completeness-reviewer'));
    if (cycle.reconciliation !== null) await session.reconcileInventory(cycle.reconciliation, await stage('author'));
    for (const [index, raw] of list(cycle.attempts, 2).entries()) {
      const a = record(raw);
      keys(a, ['submission', 'completenessReview', 'semanticReview', 'sourcePassed', 'reviewOrder', 'reviewRound', ...(v2 ? ['reviewSubmissions'] : [])]);
      if (index === 0) await session.submitProse(a.submission, await stage('author'));
      else await session.correctProse(a.submission, await stage('author'));
      const order = list(a.reviewOrder, 2).map(v => choice(v, ['completeness', 'source']));
      if (new Set(order).size !== order.length || order.includes('completeness') !== (a.completenessReview !== null) ||
        order.includes('source') !== (a.semanticReview !== null)) invalid();
      const submissions = v2 ? list(a.reviewSubmissions, 2) : [];
      if (v2 && submissions.length !== order.length) invalid();
      for (const [index, role] of order.entries()) {
        if (role === 'completeness') await session.submitCompletenessReview(v2 ? submissions[index] : a.completenessReview, await stage('completeness-reviewer'));
        else await session.submitSourceReview(v2 ? submissions[index] : a.semanticReview, await stage('source-reviewer'));
      }
    }
  }
  const corrections = v2 ? list(input.inventoryCorrections, MAX_INVENTORY_CORRECTIONS) : [];
  for (const [index, raw] of corrections.entries()) {
    const step = record(raw); keys(step, ['previous', 'correction']);
    const previous = record(step.previous);
    keys(previous, ['authorInventory', 'inventoryReview', 'inventoryReReview', 'reconciliation', 'acceptedInventory', 'attempts']);
    await replayCycle(previous, index === 0);
    await session.correctInventory(step.correction, await stage('author'));
  }
  await replayCycle(input, corrections.length === 0);
  if (input.finalized === true) {
    const captured = await captureKnowledgeCompletenessSession(session);
    const round = captured.state.attempts.at(-1)?.reviewRound ?? invalid(), expected = await stage('author');
    await session.finalize({ schemaVersion: 'buildlore.knowledge-completeness-finalize-input.v1', projectId: session.exchange.projectId,
      runId: session.exchange.runId, proposalDigest: round.proposalDigest, mappingDigest: round.mappingDigest,
      completenessReviewDigest: round.completenessReviewDigest, semanticReviewDigest: round.semanticReviewDigest, reviewViewDigest: expected }, expected);
  }
  const actual = await captureKnowledgeCompletenessSession(session);
  if (digest(input) !== digest(actual.state)) invalid();
}
