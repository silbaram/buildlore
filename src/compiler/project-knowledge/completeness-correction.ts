import { choice, compare, digest, hash, identifier, invalid, keys, list, record, text,
  ProjectKnowledgeError } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest } from '../../knowledge/project-knowledge/types.js';
import { createKnowledgeEvidenceCoverage } from './citation-support.js';
import { completenessBinding, completenessInventoryItems, completenessJson, completenessRefKey,
  parseKnowledgeCompletenessInventory, parseKnowledgeCompletenessInventoryReview,
  type CompletenessBinding, type CompletenessItemRef, type KnowledgeCompletenessAcceptedInventoryV1,
  type KnowledgeCompletenessExchange, type KnowledgeCompletenessInventoryReconciliationV1,
  type KnowledgeCompletenessInventoryReviewV1, type KnowledgeCompletenessInventoryV1 } from './completeness.js';
import type { KnowledgeCompletenessAttemptV1 } from './completeness-session.js';

export const MAX_INVENTORY_CORRECTIONS = 2;
export type InventoryCorrectionTarget =
  | Readonly<{ kind: 'item'; role: CompletenessItemRef['role']; itemId: string }>
  | Readonly<{ kind: 'finding'; index: number }>
  | Readonly<{ kind: 'category'; questionId: string; category: string }>
  | Readonly<{ kind: 'prior-resolution'; resolutionId: string }>;
export interface KnowledgeCompletenessInventoryCorrectionV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-inventory-correction.v1';
  readonly causeReviewDigest: KnowledgeDigest;
  readonly authorInventory: KnowledgeCompletenessInventoryV1;
  readonly resolutions: readonly Readonly<{ resolutionId: string; target: InventoryCorrectionTarget;
    replacementItemIds: readonly string[]; rationale: string }>[];
  readonly correctionDigest: KnowledgeDigest;
}
export interface KnowledgeCompletenessInventoryCorrectionReviewV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-inventory-correction-review.v1';
  readonly correctionDigest: KnowledgeDigest;
  readonly review: KnowledgeCompletenessInventoryReviewV1;
  readonly resolutions: readonly Readonly<{ resolutionId: string; verdict: 'resolved' | 'unresolved'; rationale: string }>[];
  readonly reviewDigest: KnowledgeDigest;
}
export interface KnowledgeCompletenessInventoryCycleV1 {
  readonly authorInventory: KnowledgeCompletenessInventoryV1;
  readonly inventoryReview: KnowledgeCompletenessInventoryReviewV1;
  readonly inventoryReReview: KnowledgeCompletenessInventoryCorrectionReviewV1 | null;
  readonly reconciliation: KnowledgeCompletenessInventoryReconciliationV1 | null;
  readonly acceptedInventory: KnowledgeCompletenessAcceptedInventoryV1 | null;
  readonly attempts: readonly KnowledgeCompletenessAttemptV1[];
}
export interface KnowledgeCompletenessInventoryCorrectionStepV1 {
  readonly previous: KnowledgeCompletenessInventoryCycleV1;
  readonly correction: KnowledgeCompletenessInventoryCorrectionV1;
}

export function completenessCorrectionTargetKey(target: InventoryCorrectionTarget): string {
  switch (target.kind) {
    case 'item': return `item:${completenessRefKey(target)}`;
    case 'finding': return `finding:${String(target.index)}`;
    case 'category': return `category:${target.questionId}:${target.category}`;
    case 'prior-resolution': return `prior-resolution:${target.resolutionId}`;
  }
}
export function completenessCorrectionCause(cycle: KnowledgeCompletenessInventoryCycleV1): KnowledgeDigest | null {
  if (cycle.inventoryReview.decision === 'unresolved' ||
      cycle.inventoryReReview?.resolutions.some(r => r.verdict === 'unresolved')) {
    return cycle.inventoryReReview?.reviewDigest ?? cycle.inventoryReview.reviewDigest;
  }
  const attempt = cycle.attempts.at(-1);
  return attempt?.reviewRound !== null && attempt?.completenessReview?.inventoryFindings.length
    ? attempt.reviewRound?.reviewRoundDigest ?? null : null;
}
export function hasCompletenessRequiredSourceGap(exchange: KnowledgeCompletenessExchange): boolean {
  return exchange.authoringQuestions.some(q => q.requirements.length > 0 &&
    !createKnowledgeEvidenceCoverage(exchange.baseExchange.snapshot, q.requirements, exchange.projectId).complete);
}
export function completenessInventorySourceGap(cycle: KnowledgeCompletenessInventoryCycleV1): boolean {
  return cycle.inventoryReview.questions.some(q => q.categories.some(c => c.status === 'source-gap'));
}
function union(shadow: KnowledgeCompletenessInventoryV1, author: KnowledgeCompletenessInventoryV1) {
  return new Map([shadow, author].flatMap(inventory => completenessInventoryItems(inventory)
    .map(item => [completenessRefKey({ role: inventory.role, itemId: item.itemId }), item] as const)));
}

/** Every detected defect and changed/removed author item needs an explicit disposition. */
export function requiredInventoryCorrectionTargets(previous: KnowledgeCompletenessInventoryCycleV1,
  author: KnowledgeCompletenessInventoryV1): readonly InventoryCorrectionTarget[] {
  const result = new Map<string, InventoryCorrectionTarget>();
  const add = (target: InventoryCorrectionTarget): void => { result.set(completenessCorrectionTargetKey(target), target); };
  for (const judgment of previous.inventoryReview.judgments) {
    if (judgment.disposition === 'unsupported' || judgment.disposition === 'conflicting') {
      add({ kind: 'item', role: judgment.role, itemId: judgment.itemId });
    }
  }
  const latest = new Map(completenessInventoryItems(author).map(item => [item.itemId, item]));
  for (const item of completenessInventoryItems(previous.authorInventory)) {
    const next = latest.get(item.itemId);
    if (next === undefined || digest(next) !== digest(item)) add({ kind: 'item', role: 'author', itemId: item.itemId });
  }
  for (const question of previous.inventoryReview.questions) {
    for (const category of question.categories) {
      if (category.status === 'inventory-defect') {
        add({ kind: 'category', questionId: question.questionId, category: category.category });
      }
    }
  }
  previous.attempts.at(-1)?.completenessReview?.inventoryFindings.forEach((_, index) => add({ kind: 'finding', index }));
  for (const resolution of previous.inventoryReReview?.resolutions ?? []) {
    if (resolution.verdict === 'unresolved') add({ kind: 'prior-resolution', resolutionId: resolution.resolutionId });
  }
  return Object.freeze([...result.values()].sort((a, b) => compare(completenessCorrectionTargetKey(a), completenessCorrectionTargetKey(b))));
}

function binding(input: Readonly<Record<string, unknown>>, exchange: KnowledgeCompletenessExchange): CompletenessBinding {
  const result = completenessBinding(exchange);
  for (const [key, value] of Object.entries(result)) if (input[key] !== value) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
  return result;
}
const BINDING_KEYS = ['projectId', 'runId', 'exchangeDigest', 'baseExchangeDigest', 'snapshotDigest', 'baselineGenerationDigest', 'questionsDigest'];
function checkedDigest(input: Readonly<Record<string, unknown>>, basis: object, key: string): KnowledgeDigest {
  const value = digest(basis);
  if (hash(input[key]) !== value || digest(input) !== digest({ ...basis, [key]: value })) invalid();
  return value;
}
function parseTarget(value: unknown, exchange: KnowledgeCompletenessExchange,
  shadow: KnowledgeCompletenessInventoryV1, previous: KnowledgeCompletenessInventoryCycleV1): InventoryCorrectionTarget {
  const r = record(value);
  switch (r.kind) {
    case 'item': {
      keys(r, ['kind', 'role', 'itemId']);
      const target = { kind: 'item' as const, role: choice(r.role, ['author', 'blind-shadow-reviewer']), itemId: identifier(r.itemId) };
      if (!union(shadow, previous.authorInventory).has(completenessRefKey(target))) invalid();
      return Object.freeze(target);
    }
    case 'finding': {
      keys(r, ['kind', 'index']);
      if (typeof r.index !== 'number' || !Number.isSafeInteger(r.index) || r.index < 0 ||
        previous.attempts.at(-1)?.completenessReview?.inventoryFindings[r.index] === undefined) invalid();
      return Object.freeze({ kind: 'finding', index: r.index });
    }
    case 'category': {
      keys(r, ['kind', 'questionId', 'category']);
      const questionId = identifier(r.questionId), category = identifier(r.category);
      if (!exchange.authoringQuestions.some(q => q.id === questionId) ||
        !previous.inventoryReview.questions.some(q => q.questionId === questionId && q.categories.some(c => c.category === category))) invalid();
      return Object.freeze({ kind: 'category', questionId, category });
    }
    case 'prior-resolution': {
      keys(r, ['kind', 'resolutionId']);
      const resolutionId = identifier(r.resolutionId);
      if (!previous.inventoryReReview?.resolutions.some(r => r.resolutionId === resolutionId && r.verdict === 'unresolved')) invalid();
      return Object.freeze({ kind: 'prior-resolution', resolutionId });
    }
    default: return invalid();
  }
}
export function parseKnowledgeCompletenessInventoryCorrection(value: unknown, exchange: KnowledgeCompletenessExchange,
  shadow: KnowledgeCompletenessInventoryV1, previous: KnowledgeCompletenessInventoryCycleV1): KnowledgeCompletenessInventoryCorrectionV1 {
  const r = completenessJson(value, 1_048_576);
  keys(r, ['schemaVersion', ...BINDING_KEYS, 'causeReviewDigest', 'authorInventory', 'resolutions', 'correctionDigest']);
  if (exchange.policyVersion !== 'completeness-v2' || r.schemaVersion !== 'buildlore.knowledge-completeness-inventory-correction.v1' ||
    r.causeReviewDigest !== completenessCorrectionCause(previous) || r.causeReviewDigest === null ||
    hasCompletenessRequiredSourceGap(exchange) || completenessInventorySourceGap(previous)) invalid();
  const authorInventory = parseKnowledgeCompletenessInventory(r.authorInventory, exchange, 'author');
  if (digest(authorInventory.actor) !== digest(previous.authorInventory.actor)) throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
  const available = new Set(completenessInventoryItems(authorInventory).map(i => i.itemId));
  const resolutions = list(r.resolutions, 1024).map(raw => {
    const item = record(raw); keys(item, ['resolutionId', 'target', 'replacementItemIds', 'rationale']);
    const replacementItemIds = list(item.replacementItemIds, 32).map(identifier);
    if (new Set(replacementItemIds).size !== replacementItemIds.length || replacementItemIds.some(id => !available.has(id))) invalid();
    return Object.freeze({ resolutionId: identifier(item.resolutionId), target: parseTarget(item.target, exchange, shadow, previous),
      replacementItemIds: Object.freeze(replacementItemIds), rationale: text(item.rationale, 4096) });
  });
  const targets = new Set(resolutions.map(r => completenessCorrectionTargetKey(r.target)));
  if (resolutions.length === 0 || new Set(resolutions.map(r => r.resolutionId)).size !== resolutions.length ||
    targets.size !== resolutions.length || requiredInventoryCorrectionTargets(previous, authorInventory)
      .some(target => !targets.has(completenessCorrectionTargetKey(target)))) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-inventory-correction.v1' as const, ...binding(r, exchange),
    causeReviewDigest: hash(r.causeReviewDigest), authorInventory, resolutions: Object.freeze(resolutions) };
  return Object.freeze({ ...basis, correctionDigest: checkedDigest(r, basis, 'correctionDigest') });
}

export function parseKnowledgeCompletenessInventoryCorrectionReview(value: unknown, exchange: KnowledgeCompletenessExchange,
  shadow: KnowledgeCompletenessInventoryV1, step: KnowledgeCompletenessInventoryCorrectionStepV1): KnowledgeCompletenessInventoryCorrectionReviewV1 {
  const r = completenessJson(value, 1_048_576), { correction, previous } = step;
  keys(r, ['schemaVersion', ...BINDING_KEYS, 'correctionDigest', 'review', 'resolutions', 'reviewDigest']);
  if (r.schemaVersion !== 'buildlore.knowledge-completeness-inventory-correction-review.v1' || r.correctionDigest !== correction.correctionDigest) invalid();
  const review = parseKnowledgeCompletenessInventoryReview(r.review, exchange, shadow, correction.authorInventory);
  const resolutions = list(r.resolutions, 1024).map((raw, index) => {
    const item = record(raw); keys(item, ['resolutionId', 'verdict', 'rationale']);
    const resolution = correction.resolutions[index] ?? invalid();
    if (item.resolutionId !== resolution.resolutionId) invalid();
    const verdict = choice(item.verdict, ['resolved', 'unresolved']);
    if (verdict === 'resolved' && resolution.replacementItemIds.some(id => !review.judgments.some(j => j.role === 'author' &&
      j.itemId === id && (j.disposition === 'required' || j.disposition === 'duplicate')))) invalid();
    return Object.freeze({ resolutionId: resolution.resolutionId, verdict, rationale: text(item.rationale, 4096) });
  });
  if (resolutions.length !== correction.resolutions.length) invalid();
  const explicit = new Set(correction.resolutions.filter(r => r.target.kind === 'item').map(r => completenessCorrectionTargetKey(r.target)));
  const before = union(shadow, previous.authorInventory), after = union(shadow, correction.authorInventory);
  const substantive = (item: ReturnType<typeof completenessInventoryItems>[number]): KnowledgeDigest => digest({
    questionId: item.questionId, category: item.category, statement: item.statement, support: item.support,
    relevance: item.relevance, requirementIds: [...item.requirementIds].sort(compare), evidenceIds: item.evidenceIds,
  });
  for (const judgment of previous.inventoryReview.judgments.filter(j => j.disposition === 'required')) {
    const key = completenessRefKey(judgment);
    const retained = review.judgments.find(j => completenessRefKey(j) === key);
    if (explicit.has(`item:${key}`) || retained?.disposition === 'required') continue;
    const target = retained?.duplicateOf === null || retained?.duplicateOf === undefined
      ? undefined : after.get(completenessRefKey(retained.duplicateOf));
    if (retained?.disposition !== 'duplicate' || target === undefined ||
      substantive(before.get(key) ?? invalid()) !== substantive(target)) invalid();
  }
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-inventory-correction-review.v1' as const, ...binding(r, exchange),
    correctionDigest: correction.correctionDigest, review, resolutions: Object.freeze(resolutions) };
  return Object.freeze({ ...basis, reviewDigest: checkedDigest(r, basis, 'reviewDigest') });
}
