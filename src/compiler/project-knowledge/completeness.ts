import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import { boundedJson, choice, compare, digest, hash, hashes, identifier, invalid, keys,
  list, project, record, text, ProjectKnowledgeError } from '../../knowledge/project-knowledge/guards.js';
import { parseKnowledgeActor } from '../../knowledge/project-knowledge/records.js';
import type { KnowledgeActorV1 as KnowledgeActor, KnowledgeDigest, KnowledgePageRole, KnowledgeProposalV1 } from '../../knowledge/project-knowledge/types.js';
import { createKnowledgeEvidenceCoverage } from './citation-support.js';
import { parseKnowledgeAuthoringQuestions, type KnowledgeAuthoringQuestion } from './authoring-questions.js';
import type { KnowledgeExchangeV1 } from './session.js';

export const COMPLETENESS_CATEGORIES = Object.freeze(['direct-answer', 'condition', 'exception',
  'decision-reason', 'change-history', 'verification-scope', 'verification-limit'] as const);
export type CompletenessCategory = typeof COMPLETENESS_CATEGORIES[number];
export type CompletenessInventoryRole = 'blind-shadow-reviewer' | 'author';
export type CompletenessRole = 'author' | 'completeness-reviewer' | 'source-reviewer';
export const COMPLETENESS_LIMITS = Object.freeze({ artifact: 262_144, prose: 2_097_152,
  run: 12_582_912, view: 4_194_304, recovery: 4096, items: 512, references: 2048 });

export interface CompletenessBinding {
  readonly projectId: string;
  readonly runId: string;
  readonly exchangeDigest: KnowledgeDigest;
  readonly baseExchangeDigest: KnowledgeDigest;
  readonly snapshotDigest: KnowledgeDigest;
  readonly baselineGenerationDigest: KnowledgeDigest | null;
  readonly questionsDigest: KnowledgeDigest;
}
export interface KnowledgeCompletenessExchangeV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-exchange.v1';
  readonly baseExchange: KnowledgeExchangeV1;
  readonly authoringQuestions: readonly KnowledgeAuthoringQuestion[];
  readonly policyVersion: 'completeness-v1';
  readonly roleBoundary: 'ordered-disclosure-declared-identities';
  readonly instructions: readonly string[];
}
export interface CompletenessItem {
  readonly itemId: string;
  readonly questionId: string;
  readonly category: CompletenessCategory;
  readonly statement: string;
  readonly requirementIds: readonly string[];
  readonly support: 'source-supported' | 'evidence-backed-known-unknown';
  readonly evidenceIds: readonly KnowledgeDigest[];
  readonly relevance: 'current' | 'history' | 'uncertainty';
  readonly rationale: string;
}
export interface CompletenessCategoryEntry {
  readonly category: CompletenessCategory;
  readonly items: readonly CompletenessItem[];
  readonly disposition: Readonly<{ status: 'source-gap-unknown' | 'not-applicable'; rationale: string;
    requirementIds: readonly string[]; sourceStatuses: readonly Readonly<{
      requirementId: string; status: 'available' | 'heading-only' | 'unavailable';
    }>[] }> | null;
}
export interface KnowledgeCompletenessInventoryV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-inventory.v1';
  readonly role: CompletenessInventoryRole;
  readonly actor: KnowledgeActor;
  readonly questions: readonly Readonly<{ questionId: string; categories: readonly CompletenessCategoryEntry[] }>[];
  readonly inventoryDigest: KnowledgeDigest;
}
export interface CompletenessItemRef { readonly role: CompletenessInventoryRole; readonly itemId: string }
export interface CompletenessInventoryJudgment extends CompletenessItemRef {
  readonly disposition: 'required' | 'duplicate' | 'not-required' | 'unsupported' | 'conflicting';
  readonly duplicateOf: CompletenessItemRef | null;
  readonly evidenceIds: readonly KnowledgeDigest[];
  readonly rationale: string;
}
export interface KnowledgeCompletenessInventoryReviewV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-inventory-review.v1';
  readonly shadowInventoryDigest: KnowledgeDigest;
  readonly authorInventoryDigest: KnowledgeDigest;
  readonly reviewer: KnowledgeActor;
  readonly judgments: readonly CompletenessInventoryJudgment[];
  readonly questions: readonly Readonly<{ questionId: string; categories: readonly Readonly<{
    category: CompletenessCategory; status: 'complete' | 'not-applicable' | 'source-gap' | 'inventory-defect'; rationale: string;
  }>[] }>[];
  readonly decision: 'accepted' | 'reconcilable' | 'unresolved';
  readonly reviewDigest: KnowledgeDigest;
}
export interface KnowledgeCompletenessInventoryReconciliationV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-inventory-reconciliation.v1';
  readonly inventoryReviewDigest: KnowledgeDigest;
  readonly author: KnowledgeActor;
  readonly dispositions: readonly Readonly<{ role: CompletenessInventoryRole; itemId: string;
    disposition: CompletenessInventoryJudgment['disposition']; rationale: string }>[];
  readonly reconciliationDigest: KnowledgeDigest;
}
export interface KnowledgeCompletenessAcceptedInventoryV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-accepted-inventory.v1';
  readonly shadowInventoryDigest: KnowledgeDigest;
  readonly authorInventoryDigest: KnowledgeDigest;
  readonly inventoryReviewDigest: KnowledgeDigest;
  readonly reconciliationDigest: KnowledgeDigest | null;
  readonly author: KnowledgeActor;
  readonly reviewer: KnowledgeActor;
  readonly requiredItems: readonly (CompletenessItem & Readonly<{ origin: CompletenessItemRef }>)[];
  readonly optionalDispositions: KnowledgeCompletenessInventoryReviewV1['questions'];
  readonly acceptedInventoryDigest: KnowledgeDigest;
}
export interface CompletenessProseLocator {
  readonly pageRole: KnowledgePageRole; readonly sectionIndex: number; readonly claimIndex: number; readonly claimId: string;
}
export interface KnowledgeCompletenessProseMappingV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-prose-mapping.v1';
  readonly acceptedInventoryDigest: KnowledgeDigest;
  readonly proposalDigest: KnowledgeDigest;
  readonly author: KnowledgeActor;
  readonly items: readonly Readonly<{ itemId: string; status: 'mapped' | 'missing'; locators: readonly CompletenessProseLocator[] }>[];
  readonly mappingDigest: KnowledgeDigest;
}
export interface KnowledgeCompletenessReviewV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-review.v1';
  readonly acceptedInventoryDigest: KnowledgeDigest;
  readonly proposalDigest: KnowledgeDigest;
  readonly mappingDigest: KnowledgeDigest;
  readonly round: 1 | 2;
  readonly reviewer: KnowledgeActor;
  readonly items: readonly Readonly<{ itemId: string; verdict: 'covered' | 'partial' | 'missing'; rationale: string; correction: string | null }>[];
  readonly questions: readonly Readonly<{ questionId: string; verdict: 'complete' | 'prose-defect' | 'inventory-defect'; rationale: string }>[];
  readonly inventoryFindings: readonly Readonly<{ questionId: string; statement: string; evidenceIds: readonly KnowledgeDigest[]; rationale: string }>[];
  readonly disclosures: 'frozen-inputs-and-current-proposal-only';
  readonly reviewDigest: KnowledgeDigest;
}

export class KnowledgeCompletenessBudgetError extends ProjectKnowledgeError {
  readonly maximumBytes: number;
  constructor(maximumBytes: number) {
    super('KNOWLEDGE_COMPLETENESS_BUDGET_EXCEEDED');
    this.name = 'KnowledgeCompletenessBudgetError'; this.maximumBytes = maximumBytes;
  }
}
export interface KnowledgeCompletenessInventoryDiagnostic {
  readonly schemaVersion: 'buildlore.knowledge-completeness-inventory-diagnostic.v1';
  readonly rule: 'item-invalid' | 'requirement-not-declared' | 'requirement-needs-current-evidence';
  readonly draftDigest: KnowledgeDigest;
  readonly questionIndex: number;
  readonly categoryIndex: number;
  readonly itemIndex: number;
  readonly requirementIndex: number | null;
}
/** One bounded numeric location; never includes input identifiers, paths or prose. */
export class KnowledgeCompletenessInventoryError extends ProjectKnowledgeError {
  readonly details: KnowledgeCompletenessInventoryDiagnostic;
  constructor(details: KnowledgeCompletenessInventoryDiagnostic) {
    super('KNOWLEDGE_INVALID');
    this.name = 'KnowledgeCompletenessInventoryError';
    this.details = Object.freeze({ ...details });
  }
}

/** Tighten the existing JSON admission without evaluating getters or toJSON. */
export function completenessJson(value: unknown, maximum: number = COMPLETENESS_LIMITS.artifact): Readonly<Record<string, unknown>> {
  const parsed = record(boundedJson(value));
  if (Buffer.byteLength(serializeCanonicalJson(parsed)) > maximum) throw new KnowledgeCompletenessBudgetError(maximum);
  return parsed;
}
export function completenessBinding(exchange: KnowledgeCompletenessExchangeV1): CompletenessBinding {
  return Object.freeze({ projectId: exchange.projectId, runId: exchange.runId, exchangeDigest: exchange.exchangeDigest,
    baseExchangeDigest: exchange.baseExchangeDigest, snapshotDigest: exchange.snapshotDigest,
    baselineGenerationDigest: exchange.baselineGenerationDigest, questionsDigest: exchange.questionsDigest });
}
const BINDING_KEYS = ['projectId', 'runId', 'exchangeDigest', 'baseExchangeDigest', 'snapshotDigest', 'baselineGenerationDigest', 'questionsDigest'];
function checkedBinding(value: Readonly<Record<string, unknown>>, exchange: KnowledgeCompletenessExchangeV1): CompletenessBinding {
  const binding = completenessBinding(exchange);
  project(value.projectId, exchange.projectId);
  for (const key of BINDING_KEYS) if (value[key] !== record(binding)[key]) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
  return binding;
}
function verified(input: Readonly<Record<string, unknown>>, basis: object, digestKey: string): KnowledgeDigest {
  const resultDigest = digest(basis);
  const result = Object.freeze({ ...basis, [digestKey]: resultDigest });
  if (digest(input) !== digest(result)) invalid();
  return resultDigest;
}
function ids(value: unknown, maximum = 256): readonly string[] {
  const result = list(value, maximum).map(identifier);
  if (new Set(result).size !== result.length) invalid();
  return Object.freeze(result);
}
function evidence(value: unknown, exchange: KnowledgeCompletenessExchangeV1, minimum = 1): readonly KnowledgeDigest[] {
  const result = hashes(value, 32);
  const available = new Set([...exchange.baseExchange.snapshot.evidence, ...exchange.baseExchange.previousEvidence].map(e => e.evidenceId));
  if (result.length < minimum || result.some(id => !available.has(id))) invalid();
  return result;
}
function sameActor(value: unknown, expected: KnowledgeActor): KnowledgeActor {
  const actor = parseKnowledgeActor(value);
  if (digest(actor) !== digest(expected)) throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
  return actor;
}
export function completenessRefKey(ref: CompletenessItemRef): string { return `${ref.role}:${ref.itemId}`; }
export function completenessInventoryItems(inventory: KnowledgeCompletenessInventoryV1): readonly CompletenessItem[] {
  return inventory.questions.flatMap(q => q.categories.flatMap(c => c.items));
}
function itemRef(value: unknown): CompletenessItemRef {
  const r = record(value); keys(r, ['role', 'itemId']);
  return Object.freeze({ role: choice(r.role, ['blind-shadow-reviewer', 'author']), itemId: identifier(r.itemId) });
}

export function createKnowledgeCompletenessExchange(baseExchange: KnowledgeExchangeV1,
  value: unknown, runId?: string): KnowledgeCompletenessExchangeV1 {
  const authoringQuestions = parseKnowledgeAuthoringQuestions(value);
  const identity = runId ?? `run-${digest({ base: baseExchange.exchangeDigest, questions: authoringQuestions }).slice(7)}`;
  if (!/^run-[0-9a-f]{64}$/u.test(identity)) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-exchange.v1' as const,
    projectId: baseExchange.projectId, runId: identity, baseExchange, baseExchangeDigest: baseExchange.exchangeDigest,
    snapshotDigest: baseExchange.snapshot.snapshotDigest, baselineGenerationDigest: baseExchange.baselineGenerationDigest,
    authoringQuestions, questionsDigest: digest(authoringQuestions), policyVersion: 'completeness-v1' as const,
    roleBoundary: 'ordered-disclosure-declared-identities' as const,
    instructions: Object.freeze([
      'Before prose, independently inventory each frozen question: its direct answer, conditions, exceptions, decision reasons, change history, verification scope and limits.',
      'Use only the selected sanitized sources and verified project history. Generator instructions describe authoring mechanics, not facts about the selected project.',
      'Bind each supported item to actual evidence. Separate evidence-backed uncertainty from unavailable source material. Preserve explicit gaps and justified non-applicability.',
      'The completeness reviewer commits a shadow inventory before author inventory disclosure. The author commits without shadow contents; then review their complete union.',
      'Freeze the accepted inventory before canonical prose. Map every required item to exact page, section and claim locators, including supported uncertainty in uncertainty prose.',
      'Support/currentness and omission reviewers remain separate. One prose correction requires both reviewers to review again; a newly discovered inventory defect is terminal.',
      'Hashes and declared actor identities record bindings and order; they do not prove independence, semantic correctness, approval or activation.',
    ]) };
  const result = Object.freeze({ ...basis, exchangeDigest: digest(basis) });
  boundedJson(result);
  return result;
}

export function parseKnowledgeCompletenessInventory(value: unknown, exchange: KnowledgeCompletenessExchangeV1,
  role: CompletenessInventoryRole): KnowledgeCompletenessInventoryV1 {
  const r = completenessJson(value);
  keys(r, ['schemaVersion', ...BINDING_KEYS, 'role', 'actor', 'questions', 'inventoryDigest']);
  if (r.schemaVersion !== 'buildlore.knowledge-completeness-inventory.v1' || r.role !== role) invalid();
  const binding = checkedBinding(r, exchange), seen = new Set<string>();
  let itemCount = 0, referenceCount = 0;
  const questions = list(r.questions, 64).map((raw, questionIndex) => {
    const q = record(raw); keys(q, ['questionId', 'categories']);
    const question = exchange.authoringQuestions[questionIndex] ?? invalid();
    if (q.questionId !== question.id) invalid();
    const coverage = createKnowledgeEvidenceCoverage(exchange.baseExchange.snapshot, question.requirements, exchange.projectId);
    const requirementIds = new Set(question.requirements.map(item => item.id));
    const categories = list(q.categories, 7).map((raw, categoryIndex) => {
      const c = record(raw); keys(c, ['category', 'items', 'disposition']);
      const category = COMPLETENESS_CATEGORIES[categoryIndex] ?? invalid();
      if (c.category !== category) invalid();
      const items = list(c.items, 16).map((raw, itemIndex) => {
        const reject = (rule: KnowledgeCompletenessInventoryDiagnostic['rule'], requirementIndex: number | null = null): never => {
          throw new KnowledgeCompletenessInventoryError({ schemaVersion: 'buildlore.knowledge-completeness-inventory-diagnostic.v1',
            rule, draftDigest: digest(r), questionIndex, categoryIndex, itemIndex, requirementIndex });
        };
        try {
          const item = record(raw);
          keys(item, ['itemId', 'questionId', 'category', 'statement', 'requirementIds', 'support', 'evidenceIds', 'relevance', 'rationale']);
          const itemId = identifier(item.itemId), requirements = ids(item.requirementIds);
          if (seen.has(itemId) || item.questionId !== question.id || item.category !== category) invalid();
          const undeclared = requirements.findIndex(id => !requirementIds.has(id));
          if (undeclared !== -1) reject('requirement-not-declared', undeclared);
          seen.add(itemId);
          const evidenceIds = evidence(item.evidenceIds, exchange);
          for (const [requirementIndex, id] of requirements.entries()) {
            const requirement = coverage.requirements.find(item => item.id === id) ?? invalid();
            if (requirement.status !== 'available' || !requirement.evidenceIds.some(id => evidenceIds.includes(id))) {
              reject('requirement-needs-current-evidence', requirementIndex);
            }
          }
          itemCount += 1; referenceCount += evidenceIds.length;
          return Object.freeze({ itemId, questionId: question.id, category, statement: text(item.statement, 4096),
            requirementIds: requirements, support: choice(item.support, ['source-supported', 'evidence-backed-known-unknown']),
            evidenceIds, relevance: choice(item.relevance, ['current', 'history', 'uncertainty']), rationale: text(item.rationale, 4096) });
        } catch (error) {
          if (error instanceof KnowledgeCompletenessInventoryError) throw error;
          if (error instanceof ProjectKnowledgeError && error.code === 'KNOWLEDGE_INVALID') reject('item-invalid');
          throw error;
        }
      });
      let disposition: CompletenessCategoryEntry['disposition'] = null;
      if (items.length === 0) {
        const d = record(c.disposition); keys(d, ['status', 'rationale', 'requirementIds', 'sourceStatuses']);
        const required = ids(d.requirementIds);
        if (required.some(id => !requirementIds.has(id))) invalid();
        const sourceStatuses = list(d.sourceStatuses, 256).map(raw => {
          const status = record(raw); keys(status, ['requirementId', 'status']);
          const requirement = coverage.requirements.find(item => item.id === status.requirementId) ?? invalid();
          if (status.status !== requirement.status) invalid();
          return Object.freeze({ requirementId: requirement.id, status: requirement.status });
        });
        if (new Set(sourceStatuses.map(s => s.requirementId)).size !== sourceStatuses.length ||
          required.some(id => !sourceStatuses.some(s => s.requirementId === id && s.status !== 'available'))) invalid();
        const status = choice(d.status, ['source-gap-unknown', 'not-applicable']);
        if (status === 'not-applicable' && required.length !== 0) invalid();
        disposition = Object.freeze({ status, rationale: text(d.rationale, 4096), requirementIds: required,
          sourceStatuses: Object.freeze(sourceStatuses) });
      } else if (c.disposition !== null) invalid();
      return Object.freeze({ category, items: Object.freeze(items), disposition });
    });
    if (categories.length !== COMPLETENESS_CATEGORIES.length) invalid();
    for (const requirement of coverage.requirements) {
      if (requirement.status === 'available'
        ? !categories.some(c => c.items.some(i => i.requirementIds.includes(requirement.id)))
        : !categories.some(c => c.disposition?.status === 'source-gap-unknown' && c.disposition.requirementIds.includes(requirement.id))) invalid();
    }
    return Object.freeze({ questionId: question.id, categories: Object.freeze(categories) });
  });
  if (questions.length !== exchange.authoringQuestions.length || itemCount > COMPLETENESS_LIMITS.items ||
    referenceCount > COMPLETENESS_LIMITS.references) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-inventory.v1' as const, ...binding,
    role, actor: parseKnowledgeActor(r.actor), questions: Object.freeze(questions) };
  return Object.freeze({ ...basis, inventoryDigest: verified(r, basis, 'inventoryDigest') });
}

/** Repair a caller-owned, uncommitted draft. Does not change any session or saved inventory.
 * The caller supplies the replacement and exact whole-draft digest. Normal submission still
 * checks stage, actor and security; the complete repaired inventory is validated here. */
export function repairKnowledgeCompletenessInventoryDraft(value: unknown, exchange: KnowledgeCompletenessExchangeV1,
  role: CompletenessInventoryRole, repair: unknown): KnowledgeCompletenessInventoryV1 {
  const draft = completenessJson(value), patch = completenessJson(repair);
  keys(draft, ['schemaVersion', ...BINDING_KEYS, 'role', 'actor', 'questions', 'inventoryDigest']);
  if (draft.schemaVersion !== 'buildlore.knowledge-completeness-inventory.v1' || draft.role !== role) invalid();
  checkedBinding(draft, exchange);
  keys(patch, ['draftDigest', 'questionIndex', 'categoryIndex', 'itemIndex', 'replacement']);
  if (hash(patch.draftDigest) !== digest(draft)) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
  const position = (value: unknown, size: number): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= size) invalid();
    return value;
  };
  const questions = [...list(draft.questions, 64)];
  const questionIndex = position(patch.questionIndex, questions.length), question = record(questions[questionIndex]);
  const categories = [...list(question.categories, 7)];
  const categoryIndex = position(patch.categoryIndex, categories.length), category = record(categories[categoryIndex]);
  const items = [...list(category.items, 16)];
  const itemIndex = position(patch.itemIndex, items.length), original = record(items[itemIndex]);
  const replacement = record(patch.replacement);
  for (const key of ['itemId', 'questionId', 'category']) if (replacement[key] !== original[key]) invalid();
  items[itemIndex] = replacement;
  categories[categoryIndex] = { ...category, items };
  questions[questionIndex] = { ...question, categories };
  const { inventoryDigest, ...rest } = draft;
  void inventoryDigest;
  const basis = { ...rest, questions };
  return parseKnowledgeCompletenessInventory({ ...basis, inventoryDigest: digest(basis) }, exchange, role);
}

export function parseKnowledgeCompletenessInventoryReview(value: unknown, exchange: KnowledgeCompletenessExchangeV1,
  shadow: KnowledgeCompletenessInventoryV1, author: KnowledgeCompletenessInventoryV1): KnowledgeCompletenessInventoryReviewV1 {
  const r = completenessJson(value);
  keys(r, ['schemaVersion', ...BINDING_KEYS, 'shadowInventoryDigest', 'authorInventoryDigest',
    'reviewer', 'judgments', 'questions', 'decision', 'reviewDigest']);
  if (r.schemaVersion !== 'buildlore.knowledge-completeness-inventory-review.v1' ||
    r.shadowInventoryDigest !== shadow.inventoryDigest || r.authorInventoryDigest !== author.inventoryDigest) invalid();
  const reviewer = sameActor(r.reviewer, shadow.actor);
  if (reviewer.sessionId === author.actor.sessionId) throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
  const union = new Map([shadow, author].flatMap(inventory => completenessInventoryItems(inventory)
    .map(item => [completenessRefKey({ role: inventory.role, itemId: item.itemId }), item] as const)));
  const judgments = list(r.judgments, 1024).map(raw => {
    const j = record(raw);
    keys(j, ['role', 'itemId', 'disposition', 'duplicateOf', 'evidenceIds', 'rationale']);
    const ref = itemRef({ role: j.role, itemId: j.itemId });
    if (!union.has(completenessRefKey(ref))) invalid();
    const disposition = choice(j.disposition, ['required', 'duplicate', 'not-required', 'unsupported', 'conflicting']);
    const duplicateOf = j.duplicateOf === null ? null : itemRef(j.duplicateOf);
    if ((disposition === 'duplicate') !== (duplicateOf !== null)) invalid();
    return Object.freeze({ ...ref, disposition, duplicateOf, evidenceIds: evidence(j.evidenceIds, exchange),
      rationale: text(j.rationale, 4096) });
  }).sort((a, b) => compare(completenessRefKey(a), completenessRefKey(b)));
  if (judgments.length !== union.size || new Set(judgments.map(completenessRefKey)).size !== union.size) invalid();
  for (const judgment of judgments) {
    if (judgment.duplicateOf === null) continue;
    const target = judgments.find(j => completenessRefKey(j) === completenessRefKey(judgment.duplicateOf ?? invalid()));
    const original = union.get(completenessRefKey(judgment)) ?? invalid();
    const duplicate = union.get(completenessRefKey(judgment.duplicateOf)) ?? invalid();
    if (!target || target.disposition !== 'required' || original.questionId !== duplicate.questionId ||
      original.category !== duplicate.category || completenessRefKey(target) === completenessRefKey(judgment)) invalid();
  }
  const questions = list(r.questions, 64).map((raw, index) => {
    const q = record(raw); keys(q, ['questionId', 'categories']);
    const question = exchange.authoringQuestions[index] ?? invalid();
    if (q.questionId !== question.id) invalid();
    const categories = list(q.categories, 7).map((raw, index) => {
      const c = record(raw); keys(c, ['category', 'status', 'rationale']);
      const category = COMPLETENESS_CATEGORIES[index] ?? invalid();
      if (c.category !== category) invalid();
      const status = choice(c.status, ['complete', 'not-applicable', 'source-gap', 'inventory-defect']);
      const required = judgments.filter(j => j.disposition === 'required').map(j => union.get(completenessRefKey(j)) ?? invalid())
        .filter(item => item.questionId === question.id && item.category === category);
      if ((status === 'complete' && required.length === 0) || (status === 'not-applicable' &&
        (category === 'direct-answer' || required.length !== 0))) invalid();
      return Object.freeze({ category, status, rationale: text(c.rationale, 4096) });
    });
    if (categories.length !== 7) invalid();
    return Object.freeze({ questionId: question.id, categories: Object.freeze(categories) });
  });
  if (questions.length !== exchange.authoringQuestions.length) invalid();
  const decision = choice(r.decision, ['accepted', 'reconcilable', 'unresolved']);
  const hasDefect = judgments.some(j => j.disposition === 'unsupported' || j.disposition === 'conflicting') ||
    questions.some(q => q.categories.some(c => c.status === 'source-gap' || c.status === 'inventory-defect'));
  if (hasDefect && decision !== 'unresolved') invalid();
  if (decision === 'accepted' && (judgments.some(j => j.disposition === 'required' && j.role !== 'author') ||
    judgments.some(j => j.role === 'author' && j.disposition !== 'required'))) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-inventory-review.v1' as const,
    ...checkedBinding(r, exchange), shadowInventoryDigest: shadow.inventoryDigest, authorInventoryDigest: author.inventoryDigest,
    reviewer, judgments: Object.freeze(judgments), questions: Object.freeze(questions), decision };
  return Object.freeze({ ...basis, reviewDigest: verified(r, basis, 'reviewDigest') });
}

export function parseKnowledgeCompletenessReconciliation(value: unknown, exchange: KnowledgeCompletenessExchangeV1,
  review: KnowledgeCompletenessInventoryReviewV1, author: KnowledgeActor): KnowledgeCompletenessInventoryReconciliationV1 {
  const r = completenessJson(value);
  keys(r, ['schemaVersion', ...BINDING_KEYS, 'inventoryReviewDigest', 'author', 'dispositions', 'reconciliationDigest']);
  if (r.schemaVersion !== 'buildlore.knowledge-completeness-inventory-reconciliation.v1' ||
    r.inventoryReviewDigest !== review.reviewDigest || review.decision !== 'reconcilable') invalid();
  const dispositions = list(r.dispositions, 1024).map(raw => {
    const d = record(raw); keys(d, ['role', 'itemId', 'disposition', 'rationale']);
    const ref = itemRef({ role: d.role, itemId: d.itemId });
    const original = review.judgments.find(j => completenessRefKey(j) === completenessRefKey(ref)) ?? invalid();
    if (d.disposition !== original.disposition) invalid();
    return Object.freeze({ ...ref, disposition: original.disposition, rationale: text(d.rationale, 4096) });
  }).sort((a, b) => compare(completenessRefKey(a), completenessRefKey(b)));
  if (dispositions.length !== review.judgments.length || new Set(dispositions.map(completenessRefKey)).size !== dispositions.length) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-inventory-reconciliation.v1' as const,
    ...checkedBinding(r, exchange), inventoryReviewDigest: review.reviewDigest, author: sameActor(r.author, author),
    dispositions: Object.freeze(dispositions) };
  return Object.freeze({ ...basis, reconciliationDigest: verified(r, basis, 'reconciliationDigest') });
}

/** Project the reviewed union; this is not a new author-editable inventory. */
export function acceptKnowledgeCompletenessInventory(exchange: KnowledgeCompletenessExchangeV1,
  shadow: KnowledgeCompletenessInventoryV1, author: KnowledgeCompletenessInventoryV1,
  review: KnowledgeCompletenessInventoryReviewV1,
  reconciliation: KnowledgeCompletenessInventoryReconciliationV1 | null): KnowledgeCompletenessAcceptedInventoryV1 {
  if (review.decision === 'unresolved' || (review.decision === 'accepted') !== (reconciliation === null)) invalid();
  const union = new Map([shadow, author].flatMap(inventory => completenessInventoryItems(inventory)
    .map(item => [completenessRefKey({ role: inventory.role, itemId: item.itemId }), item] as const)));
  const requiredItems = review.judgments.filter(j => j.disposition === 'required').map(j => {
    const original = union.get(completenessRefKey(j)) ?? invalid();
    const origin = Object.freeze({ role: j.role, itemId: j.itemId });
    return Object.freeze({ ...original, itemId: `item-${digest({ inventory: j.role === 'author'
      ? author.inventoryDigest : shadow.inventoryDigest, origin }).slice(7)}`, origin });
  });
  if (requiredItems.length === 0 || requiredItems.length > COMPLETENESS_LIMITS.items) invalid();
  for (const question of exchange.authoringQuestions) {
    const items = requiredItems.filter(i => i.questionId === question.id);
    if (!items.some(i => i.category === 'direct-answer')) invalid();
    const requirements = createKnowledgeEvidenceCoverage(exchange.baseExchange.snapshot, question.requirements, exchange.projectId);
    if (requirements.requirements.some(r => r.status !== 'available' ||
      !items.some(i => i.requirementIds.includes(r.id) && r.evidenceIds.some(id => i.evidenceIds.includes(id))))) invalid();
  }
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-accepted-inventory.v1' as const,
    ...completenessBinding(exchange), shadowInventoryDigest: shadow.inventoryDigest, authorInventoryDigest: author.inventoryDigest,
    inventoryReviewDigest: review.reviewDigest, reconciliationDigest: reconciliation?.reconciliationDigest ?? null,
    author: author.actor, reviewer: shadow.actor, requiredItems: Object.freeze(requiredItems), optionalDispositions: review.questions };
  const result = Object.freeze({ ...basis, acceptedInventoryDigest: digest(basis) });
  completenessJson(result);
  return result;
}

function index(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= maximum) invalid();
  return value;
}
export function parseKnowledgeCompletenessProseMapping(value: unknown, exchange: KnowledgeCompletenessExchangeV1,
  accepted: KnowledgeCompletenessAcceptedInventoryV1, proposal: KnowledgeProposalV1): KnowledgeCompletenessProseMappingV1 {
  const r = completenessJson(value);
  keys(r, ['schemaVersion', ...BINDING_KEYS, 'acceptedInventoryDigest', 'proposalDigest', 'author', 'items', 'mappingDigest']);
  if (r.schemaVersion !== 'buildlore.knowledge-completeness-prose-mapping.v1' ||
    r.acceptedInventoryDigest !== accepted.acceptedInventoryDigest || r.proposalDigest !== proposal.proposalDigest ||
    digest(proposal.actor) !== digest(accepted.author)) invalid();
  const items = list(r.items, COMPLETENESS_LIMITS.items).map((raw, i) => {
    const item = record(raw); keys(item, ['itemId', 'status', 'locators']);
    const required = accepted.requiredItems[i] ?? invalid();
    if (item.itemId !== required.itemId) invalid();
    const status = choice(item.status, ['mapped', 'missing']);
    const locators = list(item.locators, 16).map(raw => {
      const l = record(raw); keys(l, ['pageRole', 'sectionIndex', 'claimIndex', 'claimId']);
      const pageRole = choice(l.pageRole, ['overview', 'architecture', 'decisions']);
      const sectionIndex = index(l.sectionIndex, 32), claimIndex = index(l.claimIndex, 256);
      const claim = proposal.pages.find(p => p.role === pageRole)?.sections[sectionIndex]?.claims[claimIndex] ?? invalid();
      // The item describes what the prose must explain; presentation describes
      // the referenced facts' lifecycle. A currently supported knowledge limit
      // is still a current fact. The two independent reviews check its meaning.
      if (l.claimId !== claim.claimId) invalid();
      return Object.freeze({ pageRole, sectionIndex, claimIndex, claimId: claim.claimId });
    });
    if ((status === 'mapped') !== (locators.length > 0) || new Set(locators.map(digest)).size !== locators.length) invalid();
    return Object.freeze({ itemId: required.itemId, status, locators: Object.freeze(locators) });
  });
  if (items.length !== accepted.requiredItems.length) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-prose-mapping.v1' as const,
    ...checkedBinding(r, exchange), acceptedInventoryDigest: accepted.acceptedInventoryDigest,
    proposalDigest: proposal.proposalDigest, author: sameActor(r.author, accepted.author), items: Object.freeze(items) };
  return Object.freeze({ ...basis, mappingDigest: verified(r, basis, 'mappingDigest') });
}

export function parseKnowledgeCompletenessReview(value: unknown, exchange: KnowledgeCompletenessExchangeV1,
  accepted: KnowledgeCompletenessAcceptedInventoryV1, mapping: KnowledgeCompletenessProseMappingV1,
  round: 1 | 2): KnowledgeCompletenessReviewV1 {
  const r = completenessJson(value);
  keys(r, ['schemaVersion', ...BINDING_KEYS, 'acceptedInventoryDigest', 'proposalDigest', 'mappingDigest', 'round',
    'reviewer', 'items', 'questions', 'inventoryFindings', 'disclosures', 'reviewDigest']);
  if (r.schemaVersion !== 'buildlore.knowledge-completeness-review.v1' || r.acceptedInventoryDigest !== accepted.acceptedInventoryDigest ||
    r.proposalDigest !== mapping.proposalDigest || r.mappingDigest !== mapping.mappingDigest || r.round !== round ||
    r.disclosures !== 'frozen-inputs-and-current-proposal-only') invalid();
  const items = list(r.items, COMPLETENESS_LIMITS.items).map((raw, i) => {
    const item = record(raw); keys(item, ['itemId', 'verdict', 'rationale', 'correction']);
    const required = accepted.requiredItems[i] ?? invalid();
    if (item.itemId !== required.itemId) invalid();
    const verdict = choice(item.verdict, ['covered', 'partial', 'missing']);
    if (verdict === 'covered' && mapping.items[i]?.status !== 'mapped') invalid();
    const correction = item.correction === null ? null : text(item.correction, 4096);
    if ((verdict === 'covered') !== (correction === null)) invalid();
    return Object.freeze({ itemId: required.itemId, verdict, rationale: text(item.rationale, 4096), correction });
  });
  if (items.length !== accepted.requiredItems.length) invalid();
  const inventoryFindings = list(r.inventoryFindings, 512).map(raw => {
    const f = record(raw); keys(f, ['questionId', 'statement', 'evidenceIds', 'rationale']);
    const question = exchange.authoringQuestions.find(q => q.id === f.questionId) ?? invalid();
    return Object.freeze({ questionId: question.id, statement: text(f.statement, 4096),
      evidenceIds: evidence(f.evidenceIds, exchange), rationale: text(f.rationale, 4096) });
  });
  const questions = list(r.questions, 64).map((raw, i) => {
    const q = record(raw); keys(q, ['questionId', 'verdict', 'rationale']);
    const question = exchange.authoringQuestions[i] ?? invalid();
    if (q.questionId !== question.id) invalid();
    const verdict = choice(q.verdict, ['complete', 'prose-defect', 'inventory-defect']);
    const inventoryDefect = inventoryFindings.some(f => f.questionId === question.id);
    const proseDefect = accepted.requiredItems.some((item, i) => item.questionId === question.id && items[i]?.verdict !== 'covered');
    if ((verdict === 'inventory-defect') !== inventoryDefect || (verdict === 'complete' && proseDefect) ||
      (verdict === 'prose-defect' && !proseDefect)) invalid();
    return Object.freeze({ questionId: question.id, verdict, rationale: text(q.rationale, 4096) });
  });
  if (questions.length !== exchange.authoringQuestions.length) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-review.v1' as const, ...checkedBinding(r, exchange),
    acceptedInventoryDigest: accepted.acceptedInventoryDigest, proposalDigest: mapping.proposalDigest, mappingDigest: mapping.mappingDigest,
    round, reviewer: sameActor(r.reviewer, accepted.reviewer), items: Object.freeze(items), questions: Object.freeze(questions),
    inventoryFindings: Object.freeze(inventoryFindings), disclosures: 'frozen-inputs-and-current-proposal-only' as const };
  return Object.freeze({ ...basis, reviewDigest: verified(r, basis, 'reviewDigest') });
}
