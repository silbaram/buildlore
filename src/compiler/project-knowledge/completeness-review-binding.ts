import { digest, hash, invalid, keys, record } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeSemanticReviewV1 } from '../../knowledge/project-knowledge/types.js';
import { completenessBinding, completenessJson, type CompletenessBinding, type KnowledgeCompletenessExchange,
  type KnowledgeCompletenessReviewV1 } from './completeness.js';

export interface CompletenessReviewSubmissionV1 extends CompletenessBinding {
  readonly schemaVersion: 'buildlore.knowledge-completeness-review-submission.v1';
  readonly kind: 'source' | 'completeness';
  readonly inventoryCorrectionDigest: KnowledgeDigest | null;
  readonly acceptedInventoryDigest: KnowledgeDigest;
  readonly proposalDigest: KnowledgeDigest;
  readonly mappingDigest: KnowledgeDigest;
  readonly review: KnowledgeSemanticReviewV1 | KnowledgeCompletenessReviewV1;
  readonly submissionDigest: KnowledgeDigest;
}
export interface CompletenessReviewBinding {
  readonly kind: 'source' | 'completeness';
  readonly inventoryCorrectionDigest: KnowledgeDigest | null;
  readonly acceptedInventoryDigest: KnowledgeDigest;
  readonly proposalDigest: KnowledgeDigest;
  readonly mappingDigest: KnowledgeDigest;
}
/** The inner review is validated by its existing semantic/omission codec. */
export function parseCompletenessReviewSubmission(value: unknown, exchange: KnowledgeCompletenessExchange,
  expected: CompletenessReviewBinding, review: CompletenessReviewSubmissionV1['review']): CompletenessReviewSubmissionV1 {
  const input = completenessJson(value, 2_097_152), binding = completenessBinding(exchange);
  keys(input, ['schemaVersion', ...Object.keys(binding), ...Object.keys(expected), 'review', 'submissionDigest']);
  if (input.schemaVersion !== 'buildlore.knowledge-completeness-review-submission.v1') invalid();
  for (const [key, value] of Object.entries({ ...binding, ...expected })) if (input[key] !== value) invalid();
  if (digest(record(input.review)) !== digest(review)) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-completeness-review-submission.v1' as const,
    ...binding, ...expected, review };
  const result = Object.freeze({ ...basis, submissionDigest: digest(basis) });
  if (hash(input.submissionDigest) !== result.submissionDigest || digest(input) !== digest(result)) invalid();
  return result;
}
