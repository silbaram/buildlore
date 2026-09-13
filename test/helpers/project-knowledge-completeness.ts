import { compare, digest } from '../../src/knowledge/project-knowledge/guards.js';
import type { KnowledgeProposalV1 } from '../../src/knowledge/project-knowledge/types.js';
import { COMPLETENESS_CATEGORIES, completenessBinding, completenessInventoryItems, parseKnowledgeCompletenessInventory,
  parseKnowledgeCompletenessInventoryReview, parseKnowledgeCompletenessProseMapping, parseKnowledgeCompletenessReview,
  type KnowledgeCompletenessExchangeV1, type KnowledgeCompletenessAcceptedInventoryV1 } from '../../src/compiler/project-knowledge/completeness.js';
import { workflowFixtureProposal } from './project-knowledge-workflow.js';

export const COMPLETENESS_FIXTURE_REVIEWER = Object.freeze({ sessionId: 'completeness-fixture-reviewer', model: 'deterministic-protocol-fixture', kind: 'agent' as const });
export function sealCompletenessFixture(value: object, key: string): object { return { ...value, [key]: digest(value) }; }
/** Mechanical contract fixtures only; never AI authoring or quality evidence. */
export function completenessFixture(exchange: KnowledgeCompletenessExchangeV1, useShadow = false) {
  const proposal = workflowFixtureProposal(exchange.baseExchange);
  const inventory = (role: 'blind-shadow-reviewer' | 'author') => parseKnowledgeCompletenessInventory(sealCompletenessFixture({
    schemaVersion: 'buildlore.knowledge-completeness-inventory.v1', ...completenessBinding(exchange), role,
    actor: role === 'author' ? proposal.actor : COMPLETENESS_FIXTURE_REVIEWER,
    questions: exchange.authoringQuestions.map(question => {
      const fact = proposal.facts.find(f => f.subject === `protocol-fixture:${question.role}`);
      if (!fact) throw new Error('Missing completeness protocol fact.');
      return { questionId: question.id, categories: COMPLETENESS_CATEGORIES.map(category => ({ category,
        items: category === 'direct-answer' ? [{ itemId: `${question.id}-answer`, questionId: question.id, category,
          statement: fact.statement, requirementIds: question.requirements.map(r => r.id), support: 'source-supported',
          evidenceIds: fact.evidenceIds, relevance: 'current', rationale: 'Fixed protocol-only evidence.' }] : [],
        disposition: category === 'direct-answer' ? null : { status: 'not-applicable', rationale: 'No declared requirement in this protocol category.',
          requirementIds: [], sourceStatuses: [] } })) };
    }),
  }, 'inventoryDigest'), exchange, role);
  const shadow = inventory('blind-shadow-reviewer'), author = inventory('author');
  const review = parseKnowledgeCompletenessInventoryReview(sealCompletenessFixture({
    schemaVersion: 'buildlore.knowledge-completeness-inventory-review.v1', ...completenessBinding(exchange),
    shadowInventoryDigest: shadow.inventoryDigest, authorInventoryDigest: author.inventoryDigest, reviewer: COMPLETENESS_FIXTURE_REVIEWER,
    judgments: [author, shadow].flatMap(inventory => completenessInventoryItems(inventory).map(item => {
      const required = (inventory.role === 'author') !== useShadow;
      return { role: inventory.role, itemId: item.itemId, disposition: required ? 'required' : 'duplicate',
        duplicateOf: required ? null : { role: useShadow ? 'blind-shadow-reviewer' : 'author', itemId: item.itemId },
        evidenceIds: item.evidenceIds, rationale: 'Explicit protocol union disposition.' };
    })).sort((a, b) => compare(`${a.role}:${a.itemId}`, `${b.role}:${b.itemId}`)), questions: exchange.authoringQuestions.map(question => ({ questionId: question.id,
      categories: COMPLETENESS_CATEGORIES.map(category => ({ category, status: category === 'direct-answer' ? 'complete' : 'not-applicable',
        rationale: 'Fixed category disposition.' })) })), decision: useShadow ? 'reconcilable' : 'accepted',
  }, 'reviewDigest'), exchange, shadow, author);
  return { proposal, shadow, author, review };
}
export function completenessMappingFixture(exchange: KnowledgeCompletenessExchangeV1, accepted: KnowledgeCompletenessAcceptedInventoryV1,
  proposal: KnowledgeProposalV1, alternate = false) {
  return parseKnowledgeCompletenessProseMapping(sealCompletenessFixture({ schemaVersion: 'buildlore.knowledge-completeness-prose-mapping.v1',
    ...completenessBinding(exchange), acceptedInventoryDigest: accepted.acceptedInventoryDigest, proposalDigest: proposal.proposalDigest,
    author: accepted.author, items: accepted.requiredItems.map(item => {
      const role = exchange.authoringQuestions.find(q => q.id === item.questionId)?.role;
      if (!role) throw new Error('Missing completeness protocol role.');
      return { itemId: item.itemId, status: 'mapped', locators: [{ pageRole: role, sectionIndex: 0,
        claimIndex: 0, claimId: alternate ? `corrected-${role}` : `protocol-${role}` }] };
    }),
  }, 'mappingDigest'), exchange, accepted, proposal);
}
export function completenessReviewFixture(exchange: KnowledgeCompletenessExchangeV1, accepted: KnowledgeCompletenessAcceptedInventoryV1,
  mapping: ReturnType<typeof completenessMappingFixture>, round: 1 | 2 = 1, defect = false) {
  return parseKnowledgeCompletenessReview(sealCompletenessFixture({ schemaVersion: 'buildlore.knowledge-completeness-review.v1',
    ...completenessBinding(exchange), acceptedInventoryDigest: accepted.acceptedInventoryDigest, proposalDigest: mapping.proposalDigest,
    mappingDigest: mapping.mappingDigest, round, reviewer: COMPLETENESS_FIXTURE_REVIEWER,
    items: accepted.requiredItems.map(item => ({ itemId: item.itemId, verdict: defect ? 'partial' : 'covered',
      rationale: 'Fixed protocol verdict, not an independent quality assessment.', correction: defect ? 'Retain the required qualifier.' : null })),
    questions: exchange.authoringQuestions.map(q => ({ questionId: q.id, verdict: defect ? 'prose-defect' : 'complete',
      rationale: 'Fixed protocol question verdict.' })), inventoryFindings: [], disclosures: 'frozen-inputs-and-current-proposal-only',
  }, 'reviewDigest'), exchange, accepted, mapping, round);
}
